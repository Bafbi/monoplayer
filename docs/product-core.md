# Product core — pure, fake-integrated

Status: **live-verified** for attach, render, move, break, place, and
detach/reattach against Paper G0 (see [testdata/gate-b-live.md](../testdata/gate-b-live.md)).
The socket-free unit suite runs 402 tests (`mise run test`), and `mise run check` also runs the
26-assertion offline loopback. The protocol spike (`src/spike/proxy.js`) is frozen
and untouched.

Live note: the first live attach failed with `add_entity ... 114 bytes
extra` because backend login-phase frames (`encryption_begin`, `compress`,
`success`) entered the play join prefix. The core now ignores every frame
state except `configuration` and `play` (`metrics.nonPlayFramesIgnored`).
Bundle delimiters are dropped while their enclosed frames are relayed
individually, so chunks and entities replay without the bundle wrapper.

Live note (2026-11-08, Skyblock): the backend sent a clientbound `transfer`
to `sky-2.excalia.fr:25565`. The proxy relayed it, so the attaching client
reconnected to that address as Bafbi, outside the puppet. The frame had also
entered the generic cache, so it was replayed onto the next attach and killed
that client in 1.65 s. Clientbound connection control is now blocked and
uncacheable at one decision point; see "Clientbound policy" below.

B1 is the product-shaped core with **no real tokens, no sockets, no Microsoft
auth**: adapters and the clock are injected. The CLI never opens a network
connection; `--start` explicitly refuses (`exit 2`) until G1/M1 land live legs.

## Module map (`src/core/`, `src/legs/`, `src/observability/`, `src/service/`)

| Module | Role | Purity |
|---|---|---|
| `src/core/state-cache.js` | Bounded state cache: join prefix + configuration replay prefix + per-domain warm state | pure |
| `src/core/join-synth.js` | Ordered attach stream from a snapshot: config replay, join prefix, ONE synthesized position per attach, warm domains | pure |
| `src/core/identity.js` | Front-leg identity gates: Login Start whitelist review (deny **before Login Success** by construction) + optional online-mode `hasJoined` via injected verifier | pure, verifier injected |
| `src/core/relay.js` | Serverbound drop rules (per-leg mechanics + chat, which stays read-only), pose capture (backend teleport authoritative over client movement) | pure |
| `src/core/clientbound-policy.js` | One decision table for every clientbound frame: state, cache-only, live-only, per-leg, or blocked. Drives the router, cache, join-synth, and the front's replay filter | pure |
| `src/core/session.js` | `boot → warm → attached ⇄ detached`, `reconnecting` with **exactly one** scheduled reconnect, `failed` fallback; `backendLogins` counts only real backend logins | pure, injected clock |
| `src/observability/redact.js` | Log redaction with fixed sentinel `[REDACTED]`; every core log line passes through it | pure |
| `src/legs/fake-legs.js` | Test fakes for both legs (no sockets) | test-only |
| `src/service/monoplayer.js` | Composition root: config (`loadConfig`, `DEFAULT_CONFIG`), leg wiring, metrics, logs; CLI skeleton | adapters injected |

### Cache domains and bounds (`state-cache`)

- `prefix` (join, verbatim through `chunk_batch_finished`, max 8192) — names
  capped; overflow evicts oldest and is **counted** (`metrics.overflows`), never silent.
- `config` (configuration-phase replay prefix, max 1024). Per-leg config
  keep-alives/pings are dropped at capture.
- Warm domains: `chunk` (latest per `cx,cz`, `unload_chunk` deletes the key,
  max 1024), `block` (FIFO ring, max 2048), `entity` (FIFO ring, max 2048),
  `inventory` (newest per windowId, max 32 windows), `latest` (health/food/
  abilities/experience/held_item_slot/game_state_change/entity_event/
  advancements — newest wins), `generic` (anything else state-bearing, FIFO,
  max 512).
- Not cacheable (from `clientbound-policy.js`): per-leg mechanics
  (`keep_alive`, `position`, `ping`, bundle delimiters), live-only chat and
  per-request answers (`system_chat`, `profileless_chat`, `ping_response`,
  `nbt_query_response`), and every blocked connection-control frame. Chat is
  relayed live read-only, never replayed.

### Attach stream order (`join-synth.synthAttach`)

1. configuration replay prefix (ordered; leg-owned frames stripped — again, defensively)
2. join prefix verbatim (`login`, `game_state_change`, chunks; the backend
   `position` is never replayed)
3. **one** synthesized position at the current pose, injected just before the
   first chunk-bearing frame (`chunk_batch_start`/`map_chunk`), else at the
   tail — with a fresh, proxy-owned teleportId (IDs are consumed only when a
   position is actually sent)
4. warm domains in snapshot order (chunks → blocks → entities → inventories →
   latest → generic)

Replayed keep-alives, positions, chat frames, pings, and blocked
connection-control frames are structurally impossible; the synth double-checks
and counts rejections (`counts.skipped`).

### Clientbound policy (containment)

The front client is a separate connection authenticated as Bafbi. A frame that
tells the puppet's connection to reconnect elsewhere must not be relayed: the
client would follow it as Bafbi, outside the puppet and its custody. The
2026-11-08 incident did exactly that, and the frame was cached too, so it also
replayed onto the next attach.

`src/core/clientbound-policy.js` is the one decision table for every
clientbound frame in play and configuration.

| Decision | Cache | Relay live | Replay | Use |
|---|---|---|---|---|
| `state` | yes | yes | yes | ordinary game state |
| `cache_only` | yes | no | yes | `login` |
| `live_only` | no | yes | no | chat, `ping_response`, `nbt_query_response` |
| `per_leg` | no | no | no | keep-alive, position, ping, bundle delimiter |
| `block` | no | no | no | connection control |

Blocked frames: `transfer`, `start_configuration`, `kick_disconnect`,
`cookie_request`, `store_cookie`, `show_dialog`, `clear_dialog`,
`player_chat`, `hide_message`, plus the configuration-state `transfer`,
`disconnect`, cookies, dialogs, and `code_of_conduct`. Unknown names and
unknown states fail closed (`block`, `unknown: true`) and log once.

The router, `state-cache` (`classifyPlay`/`classifyConfig`), `join-synth`
(`LEG_OWNED`), and the front leg's configuration replay read the same policy.
The front leg's `writeRaw` keeps a counted last-write gate, so a router
regression cannot leak a blocked frame. A coverage test walks the vendored
26.2 protocol and fails when a name is not classified.

A **refused** transfer while attached (follow disabled, invalid target, a
loop, or the chain limit) sends one local `system_chat` notice per attach. The
notice is proxy speech, not server speech, and never includes the target
address.

`start_configuration` cannot be served to the front client on its connection.
The core blocks it, ends the puppet leg on purpose, and lets the normal
backend-down path reset the cache, detach the client with
`The server reconfigured this session. Reconnect in a few seconds.`, and
reconnect.

### Transfer follow (`config.transfer`)

`transfer.follow` (default `true`) follows a play-state transfer on the puppet
leg. The frame still never reaches the front. The sequence:

1. Validate the target (`host` string, port 1-65535). Refuse with a local
   notice on an invalid target, a repeated target, or a chain deeper than
   `chainLimit` (default 8).
2. Tear down synchronously: reset the cache, detach the front client with
   `This session is moving. Reconnect in a few seconds to continue.`, schedule
   one reconnect with the target, then end the old backend leg. The teardown
   does not depend on the socket's end event; a missed event would strand the
   front on a dead cache.
3. The orchestrator dials the target with the same Microsoft account. The
   handshake uses **intent 3 (TRANSFER)**, not 2 (LOGIN). minecraft-protocol
   hardcodes 2, so the backend leg wraps the handshake writer. A
   transfer-only target rejects intent 2: sky-2 answered "Vous ne pouvez pas
   vous connecter sur le serveur par cette méthode!" on 2026-11-08, and a
   headless client with intent 3 reached play on sky-2. Cookies continue
   across the chain: `store_cookie` is kept on the puppet leg and answered on
   `cookie_request`; the jar clears only on a return to the configured base.
   The cache resets, the new configuration and join prefix arrive, and the
   warm fallback pins it after 5 s if the backend never sends the batch
   marker.
4. The user rejoins the proxy after warm. The replay is the new server's
   state: position, inventory, and chat are the new server's, and chat history
   is never replayed.

A followed target that cannot connect is retried 3 times. Then the controller
reverts to the configured base backend and the puppet is never left offline.
A plain backend fault reconnects to the server the puppet is on now, not
always to the base.

A configuration-state transfer happens before the play login, when there is no
warm session to move. It stays blocked and counted.

The live backend leg has a 60 s connect timeout: a target that accepts TCP and
stalls must not hold the custody lock forever. It logs the target's
`disconnect`/`kick_disconnect` text (`backendDisconnect`, `backendKick`); the
socket close alone hides the rejection reason.

The loopback proves the intent on the wire with
`src/ladder/handshake-proxy.js`: the fake backend's nmp server predates intent
3, so the proxy records the real intent and rewrites it to 2 for the fake
target.

**Seamless switch (next slice).** The attached client is still detached on a
follow and must rejoin. The hub and sky-2 differ in `dimension_type` (4 vs 9
entries) and `timeline` (4 vs 5), so a `respawn` alone would leave the client
without the target's dimensions. The client needs a mid-play reconfiguration
on the same connection: `start_configuration`, replay the target's
configuration frames, `finish_configuration`, then the target's play login and
join state, with the pre-transfer snapshot as the fallback if the target
fails. That keeps the connection alive through the loading screen.

### Read-only chat (`config.chat`)

`chat: 'read-only'` (the default) relays clientbound `system_chat` and
`profileless_chat` to the attached client while it is attached. Neither frame
is cached, so an attach shows only chat that arrives after it; history from
the puppet's connection is never replayed.

- `system_chat` carries no signature state. It is what Excalia sends: 220
  frames and zero `player_chat` in a 50-minute live session (backend
  forwarder counters in the heartbeat).
- `player_chat` stays blocked even in read-only mode: its global index and
  previous-messages window belong to the puppet's connection, and a relayed
  signed message would be validated against state the attaching client never
  saw. `profileless_chat` is the unsigned player variant and is relayed.
- Serverbound chat (`chat_message`, `chat_command`, `chat_command_signed`,
  `chat_session_update`, `chat_ack`) and `message_acknowledgement` are still
  dropped: the client cannot speak, and its acknowledgements describe its own
  stream, not the puppet's.
- `chat: 'off'` restores the old behavior (both directions blocked) without a
  rebuild. `MONOPLAYER_CHAT` overrides the config.

### Session invariants (`session.js`)

- `backendLogins` increments **only** on real backend `login` frames. An
  attach/detach cycle alone leaves it untouched (tested: stays 1 across
  warm → attach → detach → reattach).
- A backend fault while alive schedules **exactly one** reconnect (injected
  clock). A second fault during `reconnecting` is recorded, not re-armed.
  Attach attempts during `connecting`/`reconnecting` are rejected with
  `not_ready` / `backend_down` (the F4 "clear failure"). The single reconnect
  firing before recovery leads to fail-closed (`failed`) — no loop. Total
  backend logins after one fault: 2 (`1` + the deliberate reconnect).
- Scope caveat (P1#1 review finding): F4-shape proves the reconnect
  **policy** (one reconnect, no loop, `backendLogins === 2`) — before the
  fix it did **not** prove the replay **content** after the fresh login.
  Content is now covered separately: a backend end resets the state cache,
  and the `P1#1` integration test asserts that a reconnect → fresh login →
  reattach replays exactly one login and the *new* join prefix, never the
  dead session's pinned frames.

## Interface for the live legs (G1 / M4 will implement these)

`createMonoplayer({ config, backendLeg, frontLeg, clock, logStream })` — the
real legs plug in here; the fake legs (`src/legs/fake-legs.js`) are the
executable spec.

```js
backendLeg = {                    // = the GlowSquidye puppet session
  connect()                       // prismarine-auth + minecraft-protocol client (G1 kid)
  setFrameHandler(({ state, name, buffer, data }) => {})   // configuration + play frames
  setEndHandler(({ reason }) => {}), setErrorHandler(({ error }) => {})
  write(name, packet)             // teleport_confirm / keep_alive / pong / chunk_batch_received (every backend batch finish, warm or not)
  writeRaw(buffer, meta)          // forwarded serverbound play frames
  end(reason)                     // deliberate close (stop backendDown reinvention)
}

frontLeg = {                      // one attaching client (Bafbi)
  setLoginStartHandler(payload => decision)   // -> createMonoplayer().processLoginStart
                                              //    denied => end(uuid-deny) BEFORE Login Success
  setServerboundHandler(({ state, name, buffer, data }) => {})
  setDetachHandler(({ reason }) => {})
  write(name, packet, { synth }), writeRaw(buffer, meta)
  end(reason)                     // deny/kick/close
}
```

The front leg calls, in order: `core.processLoginStart` (the whitelist review),
`core.processVerifySession` (session verification, only with a real verifier),
then after sending the forged puppet Login Success: `core.attachPlayer({ name, uuid })`
(forged profile comes from `config.puppet`; profile capture is leg work).

Core call-ins the legs must drive, and everything else (`backendFrame`
routing, chat blocking, pose, keep-alive answering, warm marker) is inside
`createMonoplayer` already.

## AC1–AC5 direct-Paper sequence (what B1 proves vs what needs M2)

Acceptance codes per the delivery-gate-owner council memo
(a local council memo under `.scratch/`).

| AC | Real sequence (M2 direct Paper) | B1 proof standing in |
|---|---|---|
| AC1 join & render ≤10 s/120 s | official client joins front leg, renders | fake integration: attach replay order is exactly `registry_data… → login → game_state_change → position(synth) → chunk_batch_start → map_chunk → chunk_batch_finished` (`test/service/monoplayer.test.js` AC1-shape) |
| AC2 movement delta client==server | driver/xxbot moves, RCON `data get entity` | serverbound `position` forwarded once, pose updated, no duplicate stream (relay + integration) |
| AC3 break+place, exactly one action | driver breaks/places, RCON `execute if block` | serverbound dig/place forward (drop rules are the only gate); backend mutation frames cached while detached and replayed on reattach |
| AC4 5-minute detach, `backendLogins` unchanged | detach ≥300 s, backend keep-alives answered | session `detached` state + `backendLogins===1` across the cycle; per-leg keep-alive answering is in the frame router (fake legs assert it) |
| AC5 reattach at current pose ≤120 s, block edit persists | reattach, pose within 0.5 blk, edit visible | integration: client-moved pose (2.5/3.5) and backend-teleported pose (8.5) both land as correct reattach anchors; detached `block_update` replays |
| F4-shape (B3 subset) | backend SIGKILL | one reconnect scheduled; attach-in-gap rejected; `backendLogins===2` total; no loop (integration F4-shape). Replay content after recovery is the P1#1 test's job, not F4's |

What B1 does **not** prove: real config replay acceptance by an official
client (the plan's product kill rule), chunk pacing/batch acks against real
backend semantics, encryption/`hasJoined` live, transparent chat-read-only,
Timing against real Paper. Each is the G1/M1/M4 row's job.

## Before the real client

`mise run loopback` now exercises the product offline path without auth:
attach through the offline front leg, cached configuration replay, join order,
serverbound position/dig/place relay, detach, and reattach at the retained pose
with a block edit cached while detached. The runner and its O1-O14 contract are
documented in [testing-ladder.md](testing-ladder.md).

That rung is a protocol-bot check, not a vanilla oracle. The live evidence
above (real Paper, online-mode, official client) stays the acceptance record.

## What needs G1 / M4 (explicitly not done in B1)

- **G1**: real puppet Microsoft auth (device-code bootstrap, rolling refresh
  token in `.secrets/accounts/<uuid>/`, `prismarine-auth`), real `hasJoined` verifier
  injected into `createFrontIdentity({ verifyProfile })`, real secret custody.
- **M4**: real backend leg against Velocity (modern forwarding), real front
  leg (encryption, Login Success forging, per-leg keep-alive timers),
  Toxiproxy on the puppet leg.
- Real configuration-phase acceptance: config replay prefix exists and is
  ordered, but 26.1/775 config content (registry_data completeness,
  select_known_packs, server_links) must be verified against a live client —
  no acceptance claim without it.
- Resource packs: B1 has no pack state machine (MVP targets no required pack);
  `resource_pack_receive` is dropped serverbound.

## Limits / open questions

- Cross-domain replay interleaving is flattened (all chunks before all blocks,
  etc.). For the join-time state this is correct-ish for block-vs-chunk (blocks
  apply only where chunks are loaded), but a client that rejects a flattened
  order with a real backend would falsify the synthesis — test with the 26.1
  client, not the fakes.
- `entity` domain is an ordered ring, not per-entity latest-wins: stale high
  volume evicts real state under entity pressure. If re-attach tests show
  stale mobs, promote to per-entityId latest with a ring of entityIds.
- Chunk unload during the join prefix is replayed as captured (no-op then
  reload); an unload of a post-warm chunk removes the cached chunk.
- `identity.js` session verification passes through when no verifier is injected — safe for
  B1 fakes but the live front leg MUST inject a real verifier (online-mode
  front leg) or B4 cannot pass.
- Session "one reconnect" is per fault episode; B3's F1–F6 fidelity (e.g. F6
  60s-window semantics) is the session wiring's responsibility later.
- Redaction is pattern-based (fields, Bearer, JWT shapes). Real-token logs
  must also grep audit before shipping evidence (B6).
- CLI: `--print-config`, `--help`, refuse `--start`. No mise/package changes
  per slice rules.

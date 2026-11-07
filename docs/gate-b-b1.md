# Gate B B1 — Monoplayer product core (pure, fake-integrated)

Status: **code complete** for the B1 slice. 44/44 targeted tests pass
(`node --test test/monoplayer-*.test.js`); every module passes
`node --check`. The Gate A spike (`src/proxy.js`) is frozen and untouched.

B1 is the product-shaped core with **no real tokens, no sockets, no Microsoft
auth**: adapters and the clock are injected. The CLI never opens a network
connection; `--start` explicitly refuses (`exit 2`) until G1/M1 land live legs.

## Module map (`src/monoplayer/`)

| Module | Role | Purity |
|---|---|---|
| `state-cache.js` | Bounded state cache: join prefix + configuration replay prefix + per-domain warm state | pure |
| `join-synth.js` | Ordered attach stream from a snapshot: config replay, join prefix, ONE synthesized position per attach, warm domains | pure |
| `identity.js` | Front-leg identity gates: Login Start whitelist review (deny **before Login Success** by construction) + optional online-mode `hasJoined` via injected verifier | pure, verifier injected |
| `relay.js` | Serverbound drop rules (per-leg mechanics + chat block), pose capture (backend teleport authoritative over client movement) | pure |
| `session.js` | `boot → warm → attached ⇄ detached`, `reconnecting` with **exactly one** scheduled reconnect, `failed` fallback; `backendLogins` counts only real backend logins | pure, injected clock |
| `redact.js` | Log redaction with fixed sentinel `[REDACTED]`; every core log line passes through it | pure |
| `fake-legs.js` | Test fakes for both legs (no sockets) | test-only |
| `../monoplayer.js` | Composition root: config (`loadConfig`, `DEFAULT_CONFIG`), leg wiring, metrics, logs; CLI skeleton | adapters injected |

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
- Never cached: `keep_alive`, `position` (synthesized per attach),
  `player_chat`, `profileless_chat`, `hide_message`, `system_chat` (chat is
  blocked in B1), `ping`/`pong`.

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

Replayed keep-alives, positions, chat frames, and pings are structurally
impossible; the synth double-checks and counts rejections (`counts.skipped`).

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
real legs plug in here; the fake legs (`src/monoplayer/fake-legs.js`) are the
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

The front leg calls, in order: `core.processLoginStart` (gate 1),
`core.processVerifySession` (gate 2, only with a real verifier),
then after sending the forged puppet Login Success: `core.attachPlayer({ name, uuid })`
(forged profile comes from `config.puppet`; profile capture is leg work).

Core call-ins the legs must drive, and everything else (`backendFrame`
routing, chat blocking, pose, keep-alive answering, warm marker) is inside
`createMonoplayer` already.

## AC1–AC5 direct-Paper sequence (what B1 proves vs what needs M2)

Acceptance codes per the delivery-gate-owner council memo
(`.scratch/minecraft-gate-b/council/delivery-gate-owner.md`).

| AC | Real sequence (M2 direct Paper) | B1 proof standing in |
|---|---|---|
| AC1 join & render ≤10 s/120 s | official client joins front leg, renders | fake integration: attach replay order is exactly `registry_data… → login → game_state_change → position(synth) → chunk_batch_start → map_chunk → chunk_batch_finished` (`test/monoplayer-integration.test.js` AC1-shape) |
| AC2 movement delta client==server | driver/xxbot moves, RCON `data get entity` | serverbound `position` forwarded once, pose updated, no duplicate stream (relay + integration) |
| AC3 break+place, exactly one action | driver breaks/places, RCON `execute if block` | serverbound dig/place forward (drop rules are the only gate); backend mutation frames cached while detached and replayed on reattach |
| AC4 5-minute detach, `backendLogins` unchanged | detach ≥300 s, backend keep-alives answered | session `detached` state + `backendLogins===1` across the cycle; per-leg keep-alive answering is in the frame router (fake legs assert it) |
| AC5 reattach at current pose ≤120 s, block edit persists | reattach, pose within 0.5 blk, edit visible | integration: client-moved pose (2.5/3.5) and backend-teleported pose (8.5) both land as correct reattach anchors; detached `block_update` replays |
| F4-shape (B3 subset) | backend SIGKILL | one reconnect scheduled; attach-in-gap rejected; `backendLogins===2` total; no loop (integration F4-shape). Replay content after recovery is the P1#1 test's job, not F4's |

What B1 does **not** prove: real config replay acceptance by an official
client (the plan's product kill rule), chunk pacing/batch acks against real
backend semantics, encryption/`hasJoined` live, transparent chat-read-only,
Timing against real Paper. Each is the G1/M1/M4 row's job.

## What needs G1 / M4 (explicitly not done in B1)

- **G1**: real puppet Microsoft auth (device-code bootstrap, rolling refresh
  token in `.secrets/puppet/`, `prismarine-auth`), real `hasJoined` verifier
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
- `identity.js` gate 2 passes through when no verifier is injected — safe for
  B1 fakes but the live front leg MUST inject a real verifier (online-mode
  front leg) or B4 cannot pass.
- Session "one reconnect" is per fault episode; B3's F1–F6 fidelity (e.g. F6
  60s-window semantics) is the session wiring's responsibility later.
- Redaction is pattern-based (fields, Bearer, JWT shapes). Real-token logs
  must also grep audit before shipping evidence (B6).
- CLI: `--print-config`, `--help`, refuse `--start`. No mise/package changes
  per slice rules.

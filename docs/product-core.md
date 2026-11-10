# Product core — pure, fake-integrated

Status: **live-verified** for attach, render, move, break, place, and
detach/reattach against Paper G0 (see [testdata/live-attach-verdict.md](../testdata/live-attach-verdict.md)).
The socket-free unit suite runs 843 tests (`mise run test`), and `mise run check` also runs the
49-assertion offline loopback. The protocol spike (`src/spike/proxy.js`) is frozen
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
| `src/core/relay.js` | Serverbound drop rules (per-leg mechanics + the chat frames whose text is spoken as the puppet), pose capture (backend teleport authoritative over client movement) | pure |
| `src/core/clientbound-policy.js` | One decision table for every clientbound frame: state, cache-only, live-only, per-leg, or blocked. Drives the router, cache, join-synth, and the front's replay filter | pure |
| `src/core/session.js` | `boot → warm → attached ⇄ detached`, `transferring` for a client that follows a move, `reconnecting` with **exactly one** scheduled reconnect, `failed` fallback; `backendLogins` counts only real backend logins | pure, injected clock |
| `src/core/transfer.js` | The pre-transfer snapshot and the move's commit/rollback, on top of the session's `transferring` state and the cache's `restore` | pure |
| `src/observability/redact.js` | Log redaction with fixed sentinel `[REDACTED]`; every core log line passes through it | pure |
| `src/observability/secrets.js` | Secret scanner for reports: findings with index and kind, spans rewritten to `[REDACTED]<kind>`. Custody and the driver lane both import it here | pure |
| `src/legs/fake-legs.js` | Test fakes for both legs (no sockets) | test-only |
| `src/service/monoplayer.js` | Composition root: config (`loadConfig`, `DEFAULT_CONFIG`), leg wiring, metrics, logs; CLI skeleton | adapters injected |

### Cache domains and bounds (`state-cache`)

- `prefix` (join, verbatim through `chunk_batch_finished`, max 8192) — names
  capped; overflow evicts oldest and is **counted** (`metrics.overflows`), never silent.
- `config` (configuration-phase replay prefix, max 1024). Per-leg config
  keep-alives/pings are dropped at capture.
- Warm domains: `chunk` (latest per `cx,cz`, `unload_chunk` deletes the key,
  max 1024), `block` (FIFO ring, max 2048), `entity` (FIFO ring, max 2048; every
  entity frame the policy accepts, except the relative-move frames, so their
  capture order survives the replay),
  `inventory` (newest per windowId, max 32 windows), `latest` (health/food/
  abilities/experience/held_item_slot/game_state_change/entity_event/
  advancements — newest wins), `generic` (anything else state-bearing, FIFO,
  max 512).
- `snapshot()` carries the warm flag and the capture sequence, and `restore(snapshot)`
  puts a snapshot back entry-for-entry (#22). A restore that lost the warm flag
  would file every new frame into the join prefix, and one that renumbered the
  entries would reorder the entity/generic merge join-synth builds.
- Not cacheable (from `clientbound-policy.js`): per-leg mechanics
  (`keep_alive`, `position`, `ping`, bundle delimiters), live-only chat and
  per-request answers (`system_chat`, `profileless_chat`, `player_chat`,
  `ping_response`, `nbt_query_response`), and every blocked connection-control
  frame. Chat is relayed live, never replayed; the chat mode decides which of
  the three frames crosses.

### Attach stream order (`join-synth.synthAttach`)

1. configuration replay prefix (ordered; leg-owned frames stripped — again, defensively)
2. join prefix verbatim (`login`, `game_state_change`, chunks; the backend
   `position` is never replayed)
3. **one** synthesized position at the current pose, injected just before the
   first chunk-bearing frame (`chunk_batch_start`/`map_chunk`), else at the
   tail — with a fresh, proxy-owned teleportId (IDs are consumed only when a
   position is actually sent)
4. warm domains in snapshot order (chunks → blocks → entities → inventories →
   latest → generic), except that the relative-move frames replay with
   `entities` in capture order

The merge is the one exception to the fixed order. The cache routes an entity's
absolute position frames to `entity` and its relative-move deltas to `generic`,
and a delta only means something after the frame that preceded it, so those
frames replay as one stream ordered by the capture sequence every entry carries
(`join-synth.replayFrames`). The rest of `generic` keeps its place, so a
`close_window` still replays after the `window_items` it closes.
`state-parity.snapshotFrames` calls the same function, so the expectation cannot
drift from the replay.

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
`cookie_request`, `store_cookie`, `player_chat`, `hide_message`, plus the
configuration-state `transfer`, `disconnect`, and cookies. Unknown names and
unknown states fail closed (`block`, `unknown: true`) and log once.

`control` is the sixth decision (#16): `show_dialog` and `clear_dialog` in
both states, and `code_of_conduct` in configuration. A control frame relays to
the player who answers it, and never caches or replays, because the pending
holder keeps the one copy.

The router, `state-cache` (`classifyPlay`/`classifyConfig`), `join-synth`
(`LEG_OWNED`), and the front leg's configuration replay read the same policy.
The front leg's `writeRaw` keeps a counted last-write gate, so a router
regression cannot leak a blocked frame. A coverage test walks the vendored
26.2 protocol and fails when a name is not classified.

A **refused** transfer while a client is in play (follow disabled, invalid
target, a loop, or the chain limit) sends one proxy notice per attach. The
notice is proxy speech, not server speech, and never includes the target
address. It rides a synthetic advancement with a visible toast
(`src/core/notice.js`): the add completes one named criterion and asks for the
toast, and the removal that follows leaves the client's advancement map as the
server left it. The frames set `showAdvancements: true`, the flag the 26.x
client reads to decide whether to raise a toast, so a backend that just muted
its own toasts cannot silence the proxy's notice. A toast frame the front leg
cannot write falls back to a local `system_chat` line. A removal that fails
twice leaves that one advancement on the client until its state is rebuilt: it
is counted in `noticeGhosts` and logged as `proxyNoticeGhost`, and the id is
never reused.

`notice(text)` on the core is the entry point. It runs with no client
attached: the front leg would drop the writes, so the call logs
`proxyNoticeUndelivered` and returns `sent: false` rather than claiming a
delivery nobody saw. A refusal that arrives while the client is still finishing
its configuration is dropped and logged as `transferNoticeSkipped`, because a
play frame cannot reach that client.

The failed-target notice (#22) waits for the client instead: when the client
followed a move into configuration, the notice goes out after the restored
snapshot puts it back in play, so the toast lands on a client that can read it.

`start_configuration` from the backend never crosses: relaying it would hand the
client a connection-control frame it must not act on by itself. The default
answer is the one that shipped: end the puppet leg and let the normal
backend-down path kick the client with
`The server reconfigured this session. Reconnect in a few seconds.`. With
`transfer.keepConnection` on, the core serves the phase on the client's own
connection instead (#22): the front leg writes its own `start_configuration`,
relays the restarted configuration frames, relays the `finish_configuration`,
and the client's answer returns it to play. The same path serves a followed
transfer's target.

### Control dialogs (#16)

A control dialog is the server asking the player a question. Monoplayer relays
it to the attached player, forwards that player's answer (`custom_click_action`,
`accept_code_of_conduct`) to the backend as the puppet's own frame, and holds
the last unanswered dialog in `src/core/pending-dialog.js`.

- No timeout and no auto-click of a play dialog. A dialog with no player
  attached waits: the
  holder keeps it and re-sends it when a player attaches in the dialog's own
  phase. A play dialog waits for a client in play; a configuration gate waits
  for a client that is still following the puppet's configuration. A frame
  delivered into the wrong phase is withheld and logged
  (`controlDialogWithheld`), because the client would parse it as a frame of
  its own state.
- `clear_dialog` withdraws the held dialog and reaches the attached client, so
  its screen closes. A backend teardown drops the held dialog: it belongs to the
  session that asked it.
- On a fresh connection the answer must arrive in its own state, so the front
  leg reports the client's configuration phase (`setConfiguringHandler`,
  `core.configuringReady`). The attach call-in runs during login, before the
  protocol library writes Login Success, and a configuration frame written there
  would be read as a login packet.
- A play dialog is never the puppet's (#20). `decideDialogAutoAnswer` returns
  `play_dialog_waits` for every play dialog, attached or not, so the human
  answers it or it waits in the holder. `MONOPLAYER_DIALOG_ACTION` therefore
  covers a configuration-phase gate only, and stands down while a player is
  attached (`human_attached`). When the leg does click, it reports the answer
  (`onDialogAnswered` → `core.notePuppetDialogAnswer`) before the core sees the
  frame, so the holder never offers an already-answered question to the next
  client. Which configuration gate the player answers, including the protocol
  library's own code-of-conduct accept, is #21.
- The code of conduct arrives already answered unless the leg stops the library:
  the library's own configuration handler writes `accept_code_of_conduct`
  before the router sees the gate. `withCodeOfConductGate` in
  `src/legs/live-backend.js` wraps the backend connection's writer, so that
  write is the leg's decision. A player is attached: the frame is dropped and the
  player answers the gate by the path above, in configuration state. No player:
  the accept goes out, the leg logs `codeOfConductAccepted`, and it reports the
  answer to the core, so nothing waits for a client that is not there. Neither
  branch has a timeout.
- The last client detaching is the second way into that no-player branch (#73).
  The core holds a configuration gate the client left unanswered, and
  `backendLeg.answerHeldGate` answers it as the puppet: the code of conduct with
  the accept the wrapper swallowed, a gate with buttons with the configured
  action. A play dialog is the player's and stays held, and a gate the puppet has
  already left configuration for is not answered at all: the packet id is
  state-scoped. No timeout anywhere.

Serverbound frames carry their state (#16). The packet id is state-scoped, so
the frame must be written into the state the puppet is in: a configuration
answer after the play login, or a play frame while the puppet is still
configuring, drops with `puppet_state_mismatch` instead of ending the backend
session. The frames the front client's own connection answers stay per-leg: `CONFIG_SERVERBOUND_DROPS` in `src/core/relay.js` holds
`finish_configuration`, `select_known_packs`, and `settings`, and the core's
name-based drops cover keep-alive, pong, cookies, and resource-pack replies.

### Transfer follow (`config.transfer`)

`transfer.follow` (default `true`) follows a play-state transfer on the puppet
leg. The frame still never reaches the front. The sequence:

1. Validate the target (`host` string, port 1-65535). Refuse with a local
   notice on an invalid target, a repeated target, or a chain deeper than
   `chainLimit` (default 8).
2. Tear down synchronously: reset the cache, schedule one reconnect with the
   target, then end the old backend leg. The teardown does not depend on the
   socket's end event; a missed event would strand the front on a dead cache.
   With a client attached, a kept connection (`transfer.keepConnection`,
   on by default) moves the session to `transferring` and never kicks the
   front. With it off, the client is detached with
   `This session is moving. Reconnect in a few seconds to continue.` and
   rejoins once the puppet is warm on the target.
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
4. With a kept connection, the client follows on the connection it holds. The
   transfer intent starts a same-connection reconfiguration at once, before the
   target is dialled: the front leg writes `start_configuration`, and the
   client's own configuration phase begins while the puppet connects. The
   relayed frames are the target's configuration and its
   `finish_configuration`, and the client's `finish_configuration` answer
   returns it to play. The target's play login and join state follow on the same
   socket, so the client sees a loading screen instead of a frozen world, and
   its serverbound frames are not dropped into a play session that no longer
   exists. Position, inventory, and chat are the new server's; chat history is
   never replayed. The move completes only once the target's cache holds chunk
   data, because a client released earlier lands in an empty world.
5. If the target fails, a kept client is restored from the pre-transfer
   snapshot instead of being detached. A dial the target closes before its
   first frame is not a failure: the snapshot stays held and the follow budget
   retries. When the budget runs out, the client is restored onto the snapshot
   the move kept: the previous configuration frames, the finish, then the
   previous join state, on the socket it never left. The proxy notice
   `The new server could not be reached. You are still on the previous server.`
   explains it, and one reconnect returns the puppet to the configured backend.
   Without a kept connection the client is detached with the moving reason and
   rejoins the puppet on the base backend.

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

**Seamless switch (#22), built and off.** The hub and sky-2 differ in
`dimension_type` (4 vs 9 entries) and `timeline` (4 vs 5), so a `respawn`
alone would leave the client without the target's dimensions. The
same-connection reconfiguration above replaces the registries, which is why it
is a full configuration phase and not a synthetic respawn.

It is on by default (`transfer.keepConnection`). The transfer testbed measured
it with a real client on 2026-11-09: one socket through the move, no kick,
`transfersSeamless 1`, `frontKicks 0`, and the target's play login on the same
connection. `MONOPLAYER_TRANSFER_KEEP_CONNECTION=0` turns it off for a lane,
which is the detach-and-rejoin path loopback `O21`-`O24` pin. The evidence run:

```bash
mise run testbed:run      # takes the live front offline; the operator's run
mise run driver:scenario  # the real client's loading screen, against the gate Paper
mise run observer:run     # the server's view of the transfer intent and login
```

The reconfiguration is composed of four pieces:

- `session.transferStart` / `transferComplete` / `transferFailed`: the
  `transferring` state keeps the client attached, arms one reconnect with
  `backendDown({ retainFront: true })`, and lands back in `attached` at the
  target's play login or on the restored snapshot. A retained client never
  trips the follow budget: the transfer-follow controller owns the give-up.
- `state-cache.restore(snapshot)`: the pre-transfer state, entry order and
  capture sequence intact.
- `src/core/transfer.js`: the snapshot's owner. It is taken before the cache
  reset that starts the move, committed when the target's play login lands, and
  restored when the target fails.
- The front leg's `startReconfiguration()`: writes the proxy's own
  `start_configuration`, holds the core's configuration frames until the
  client's play-state `configuration_acknowledged` arrives (the ack exists in
  the play packet table only), flips the leg's client to the configuration
  state, and reports the client's `finish_configuration` back as
  `reconfigured`. The end frame a restore synthesizes when the snapshot holds
  no cached `finish_configuration` is built by the leg
  (`finishConfigurationFrame()`), so it is written as a configuration frame like
  every other one rather than as a packet against the client's current state.

Limits of this path: the loading screen starts on the transfer intent, so a
target that never answers does cost one. A front leg without
`startReconfiguration` (only a hand-built harness) degrades to a state replay at
the target's login, which rebuilds the world without a configuration phase. The puppet's own connection keeps one
keep-alive interval per connection: the front leg drops the library's state
listener after the first play transition so a reconfiguration cannot start a
second one. A kept client's configuration round has a deadline
(`transfer.reconfigureTimeoutMs`, default 30 s); a restore round that never
completes detaches the client with a reason.

The loopback runs both paths: O21-O24 assert the default detach-and-rejoin, and
O33-O35 assert the kept connection with the key on. O43 follows a second transfer
from there to a gated target, where the kept client leaves its configuration gate
to the puppet (#73), and O44 leaves a play dialog behind.

### Chat and commands (`config.chat`)

Four modes. `read-only` is the default. `commands` adds the speaking path for
commands alone (#97). `full` adds the speaking path from #19 and stays opt-in
until a live run proves the signed path on the deployed backend. `off` blocks
both directions.

| mode | the human's commands | the human's chat text | clientbound |
|---|---|---|---|
| `off` | dropped | dropped | no chat |
| `read-only` (default) | dropped | dropped | `system_chat`, `profileless_chat` |
| `commands` | spoken as the puppet | dropped | `system_chat`, `profileless_chat` |
| `full` | spoken as the puppet | spoken as the puppet | all three |

`chat: 'commands'` is for a human who needs `/profil`, `/msg`, `/tp`, and the
rest of the server's commands to work against their own account, and who does
not want the account speaking in open chat. The speak rule is per frame family
(`CHAT_SPEAK_COMMANDS` beside `CHAT_SPEAK_MESSAGES` in `core/relay.js`), and
one function, `speaks(name, mode)`, turns a mode into an answer.

Command feedback is `system_chat`, and `system_chat` is relayed, so the human
sees a command's result in `commands` mode. Two pieces of evidence, neither of
them a run of this mode. Paper answers a command through `sendSuccess` on the
command source, which calls `sendSystemMessage` and writes
`ClientboundSystemChatPacket` (`CraftPlayer.sendMessage` in
`PaperMC/Paper`, `paper-server`, at the 26.1 protocol). And the 50-minute
Excalia session below carried 220 `system_chat` and zero `player_chat`, though
nothing in that session recorded which command produced a frame.

That is not true of every reply. A server that answers a command with signed
player chat reaches the human as `player_chat`, which `commands` does not relay,
so they will not see it. A whisper to another player is the case to check, and
no run here has settled which frame it takes: the packet journal skips chat
frames, and the observer does not watch them. A real client on a repo-deployed
lane would answer it. This is the cost of the mode, and it is why `full` exists.

`chat: 'full'` speaks the attached client's chat and commands on the backend
leg as the puppet. The core takes the text out of the frame and calls the
backend leg's `chat(text)`; the leg signs it with the puppet's profile keys,
fills the acknowledgement bitset and checksum from the puppet connection's own
last-seen window, and picks `chat_command_signed` or `chat_command`. The
human's signature, session key, offset, and acknowledgements never reach the
backend: a `chat_message` signed with the human's key is rejected there, and
its offset means nothing on the puppet's window.

A leg without profile keys sends the message unsigned instead of failing, and a
server that enforces secure profiles answers an unsigned message by closing the
connection. The backend leg logs `chatCapability` once per backend connection,
before any chat, so a live run answers that question before anyone flips the
default.

In every mode, clientbound `system_chat` and `profileless_chat` are relayed to
the attached client while it is attached. Neither frame is cached, so an attach
shows only chat that arrives after it; history from the puppet's connection is
never replayed.

- `system_chat` carries no signature state. It is what Excalia sends: 220
  frames and zero `player_chat` in a 50-minute live session (backend
  forwarder counters in the heartbeat).
- `player_chat` is relayed live in `full` mode and blocked in the other three.
  Its global index and previous-messages window belong to the puppet's
  connection, not the human's, so the human's client will see a per-sender
  signature chain that is out of order. The expectation is that the message
  still displays and the client marks that sender's chain as broken, which only
  changes the acknowledgements the human's client would have sent. Those are
  dropped, because they describe the human's stream. No run has confirmed the
  display behaviour yet, and the protocol bot cannot: it decodes frames, never
  renders them.
  `profileless_chat` is the unsigned player variant and is relayed in every
  mode.
- Serverbound `chat_session_update`, `chat_ack`, and
  `message_acknowledgement` are dropped in every mode: the first two carry the
  human's session state, and the last describes the human's stream, not the
  puppet's.
- `chat: 'read-only'` drops the human's text and keeps the relay.
  `chat: 'commands'` speaks the human's commands and drops their chat text.
  `chat: 'off'` blocks both directions. `MONOPLAYER_CHAT` overrides the config.

### Session invariants (`session.js`)

- A retained transfer (`transferring`) keeps `detachCount` unchanged: the
  client is not detached for a move it can follow. `retainFront` on
  `backendDown` arms the reconnect without leaving the state, and a failed dial
  under a retained client retries instead of failing closed.
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
  setFrameHandler(({ state, name, buffer, data }) => {})   // configuration + play frames:
                                  // `buffer` is the frame exactly as the backend sent it,
                                  // and stays re-frameable with writeRaw: the core relays and
                                  // caches those bytes, so no decoder may rewrite them (#82)
  setEndHandler(({ reason }) => {}), setErrorHandler(({ error }) => {})
  write(name, packet)             // teleport_confirm / keep_alive / pong / chunk_batch_received (every backend batch finish, warm or not)
                                  // custom_payload (minecraft:brand) and settings (client information, view distance cap) are written by the core
  writeRaw(buffer, meta)          // forwarded serverbound frames, play or configuration
  chat(text)                      // speak as the puppet: sign with this connection's keys (#19)
  answerHeldGate({ state, name, data })   // optional: answer a configuration gate the last client
                                  // detached from (#73)
                                  // -> { answered, reason, name, responses }
  end(reason)                     // deliberate close (stop backendDown reinvention)
}

frontLeg = {                      // one attaching client (Bafbi)
  setLoginStartHandler(payload => decision)   // -> createMonoplayer().processLoginStart
                                              //    denied => end(uuid-deny) BEFORE Login Success
  setServerboundHandler(({ state, name, buffer, data }) => {})
  setDetachHandler(({ reason }) => {})
  setClientSettingsHandler(settings => {})    // -> createMonoplayer().noteClientSettings
                                              //    the human's Client Information, read-only
  setConfiguringHandler(({ name }) => {})     // -> createMonoplayer().configuringReady
                                              //    the client entered its own configuration
                                              //    phase (#16)
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
- Only the relative-move frames leave `generic`'s place in the replay. Chunks
  and blocks still replay before it, and `latest` and `inventories` keep their
  latest-wins and base-then-slots rules, so their `seq` is a recency stamp rather
  than a place in the stream. Merging those by sequence would put a chunk after
  the `block_change` frames that need it.
- `vehicle_move` carries an absolute pose but is neither decoded by the parity
  model nor merged into entity state, so a replayed vehicle can sit one frame
  stale. It is absolute, so the error does not accumulate.
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

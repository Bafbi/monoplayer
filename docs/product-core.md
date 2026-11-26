# Product core — pure, fake-integrated

Status: **live-verified** for attach, render, move, break, place, and
detach/reattach against Paper G0 (see [testdata/live-attach-verdict.md](../testdata/live-attach-verdict.md)).
The socket-free unit suite is `mise run test`, and `mise run check` adds the offline
loopback; each reports its own count, so this page repeats none of them. The protocol
spike (`src/spike/proxy.js`) is frozen and untouched.

**The model is one account and many bodies**
([one account, many bodies](adr/one-account-many-bodies.md)). An account's session on
one server is a *body*. The client that claims a body is its *driver* and drives it.
A client watching that body without control is a *spectator*, and nothing it sends
reaches a server. On a lane that serves the picker, a client with no body lands in
it, and the dialog offers the allowed servers. Two sections below carry the shipped
form: [One driver, and the lanes that can refuse a second
client](#one-driver-and-the-lanes-that-can-refuse-a-second-client-269-312) for who may
drive a body, and [The configuration baseline and the
picker](#the-configuration-baseline-and-the-picker-257) for the picker and the claim.
Delivery belongs to a channel (#269, #259). The transparency the proxy claims is the
driver's, on the body they claim ([transparency.md](transparency.md)).

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
auth**: adapters and the clock are injected, and the core opens no socket.
`--start` runs the Service, and the image's `CMD` is `--start` (`Dockerfile`).
Any other invocation starts the front leg and the backend leg. A default
invocation is refused: with no `MONOPLAYER_BACKEND_HOST` and no `--config`,
`--start` exits 2 with `refusing the default config`.

## Module map (`src/core/`, `src/legs/`, `src/observability/`, `src/service/`)

| Module | Role | Purity |
|---|---|---|
| `src/core/state-cache.js` | Bounded state cache: join prefix + configuration replay prefix + per-domain warm state | pure |
| `src/core/body-caches.js` | The cache each body owns: one state cache per body, created on its first dial and shared by that body's readers | pure |
| `src/core/join-synth.js` | Ordered attach stream from a snapshot: config replay, join prefix, ONE synthesized position per attach, warm domains | pure |
| `src/core/preauth-window.js` | The count of sockets inside the pre-auth window, and the total cap on it (#201) | pure |
| `src/core/identity.js` | Front-leg identity gates: Login Start whitelist review (deny **before Login Success** by construction) + optional online-mode `hasJoined` via injected verifier | pure, verifier injected |
| `src/core/relay.js` | Serverbound drop rules (per-leg mechanics + the chat frames whose text is spoken as the puppet), pose capture (backend teleport authoritative over client movement) | pure |
| `src/core/clientbound-policy.js` | One decision table for every clientbound frame: state, cache-only, live-only, per-leg, or blocked. Drives the router, cache, join-synth, and the front's replay filter | pure |
| `src/core/session.js` | `boot → warm → attached ⇄ detached`, `transferring` for a client that follows a move, `reconnecting` with **exactly one** scheduled reconnect, `down` for a body nobody claims or one a player ended, `failed` fallback; `backendLogins` counts only real backend logins | pure, injected clock |
| `src/core/transfer.js` | The pre-transfer snapshot and the move's commit/rollback, on top of the session's `transferring` state and the cache's `restore` | pure |
| `src/observability/redact.js` | Log redaction with fixed sentinel `[REDACTED]`; every core log line passes through it | pure |
| `src/observability/secrets.js` | Secret scanner for reports: findings with index and kind, spans rewritten to `[REDACTED]<kind>`. Custody and the driver lane both import it here | pure |
| `src/legs/fake-legs.js` | Test fakes for both legs (no sockets) | test-only |
| `src/service/monoplayer.js` | Composition root: config (`loadConfig`, `DEFAULT_CONFIG`), leg wiring, metrics, logs; CLI skeleton | adapters injected |
| `src/service/cli.js` | CLI plumbing every entry point shares: `flag`, `detail`, `candidateLines`, `withTimeout`, `waitFor` | pure; at most one pending timer per call, no sockets |

### Cache domains and bounds (`state-cache`)

- `prefix` (join, verbatim through `chunk_batch_finished`, max 8192) — names
  capped; overflow evicts oldest and is **counted** (`metrics.overflows`), never silent.
- `config` (configuration-phase replay prefix, max 1024). Per-leg config
  keep-alives/pings are dropped at capture.
- Warm domains: `chunk` (latest per `cx,cz`, `unload_chunk` deletes the key,
  max 1024), `block` (FIFO ring, max 2048), `entity` (keyed by entity and by
  entity slot — one per metadata index, one per effect id, one `destroy`, one
  per other entity frame; max 2048 entities, 128 slots per entity before the
  whole entity is dropped, and 32768 slots in the domain. Every entity frame the
  policy accepts, except the relative-move frames),
  `inventory` (newest per windowId, max 32 windows), `latest` (health/food/
  abilities/experience/held_item_slot/game_state_change/entity_event/
  advancements — newest wins), `generic` (anything else state-bearing, FIFO,
  max 512).
- The entity domain holds the raw frame per slot, so an attach replays bytes: it
  locates a metadata index, it never rebuilds a frame. One `entity_metadata`
  frame writes one slot per index it carries and is still one entry in
  `snapshot().entities`. Three bounds: `maxEntitySlots` (a record past its
  depth drops the whole entity, counted in `metrics.overflows.entityDepth` — a
  truncated record would replay a dropped index at the client's default),
  `maxEntities` (least recently updated entity evicted,
  `metrics.overflows.entity`), and `maxEntityFrames` (the slots the whole
  domain holds, `metrics.overflows.entityFrames`, so the worst case is a number
  rather than `maxEntities` times `maxEntitySlots`).
- Two entity states live outside a record. A removal for an id the domain never
  held — every body the join prefix spawned is one — waits in a bounded list
  (`stats().entityRemovals`), because a record per such id would let a busy
  world's removals evict the bodies that are still alive. And an id a bound
  dropped is remembered (`snapshot().entityDropped`,
  `stats().entitiesDropped`): later frames for it are suppressed and counted in
  `metrics.entitySuppressed` until a spawn, `spawn_entity` or `add_entity`,
  starts the body again. Replaying those frames is the "present in the tab list,
  absent from the world" shape #218 measures.
- A play `login` and a `respawn` flush the entity domain (`metrics.entityFlushes`).
  26.x has no separate dimension-change frame: `respawn` carries the new
  dimension. The flush is the cache's own hook, because a respawn is ordinary
  play state and no other module sees it.
- `snapshot()` carries the warm flag and the capture sequence, and `restore(snapshot)`
  puts a snapshot back entry-for-entry (#22). A restore that lost the warm flag
  would file every new frame into the join prefix, and one that renumbered the
  entries would reorder the entity/generic merge join-synth builds. The entity
  section of a snapshot is flat and in capture order even though the domain is a
  keyed map: `restore` rebuilds the map from that array through the same keying
  the capture path uses.
- Not cacheable (from `clientbound-policy.js`): per-leg mechanics
  (`keep_alive`, `position`, `ping`, bundle delimiters), live-only chat and
  per-request answers (`system_chat`, `profileless_chat`, `player_chat`,
  `ping_response`, `nbt_query_response`), and every blocked connection-control
  frame. Chat is relayed live, never replayed; the chat mode decides which of
  the three frames crosses.

### One cache per body (`body-caches`)

The cache belongs to a body, not to the process. `src/core/body-caches.js`
creates one state cache per body. Every read of that body answers with the same
instance, so a body's driver and its spectators share one replay. Two bodies
share nothing: no frame, no bound, and no capture counter. That counter orders
the entity and generic merge, so two bodies must not interleave into it.

There is no body cap. A lane offers one body per allowed server, so the allowed
server list is the bound. Caps wait for the per-body numbers, and they are
configuration when they land (`docs/adr/one-account-many-bodies.md`).

A body's fault resets that body's cache and no other. The composition root's
teardown resets the cache of the body whose session ended. A sibling body's
snapshot, warm flag and sequence numbers are untouched.

A dial names the body it serves. A move dials another server, so it dials that
server's body. A failed move puts the snapshot back in the body the move started
on, and releases the target body's cache with the target's session.

What still serves one body at a time is the session, not the cache: a session
holds one backend connection. A leg per body is #261, and a channel that
delivers a body to a client is #269.

### Attach stream order (`join-synth.synthAttach`)

1. configuration replay prefix (ordered; leg-owned frames stripped — again, defensively)
2. join prefix verbatim (`login`, `game_state_change`, chunks; the backend
   `position` is never replayed)
3. **one** synthesized position at the current pose, injected just before the
   first chunk-bearing frame (`chunk_batch_start`/`map_chunk`), else at the
   tail — with a fresh, proxy-owned teleportId (IDs are consumed only when a
   position is actually sent)
4. warm domains in snapshot order (chunks → blocks → entities → inventories →
   latest → generic), except that a generic frame carrying a body's state
   replays with `entities` in capture order (`ENTITY_GENERIC_FRAMES`). The
   entity domain is keyed by entity, so its section is rebuilt in capture order
   before it leaves the cache

The merge is the one exception to the fixed order. The cache routes an entity's
absolute position frames to `entity` and its relative-move deltas to `generic`,
and a delta only means something after the frame that preceded it. It routes a
body's attributes, equipment, and passengers to `generic` as well, and those are
state the body's own frames must neither outlive nor be outlived by. So those
frames replay as one stream ordered by the capture sequence every entry carries
(`join-synth.replayFrames`). An effect is the other way round: its add and its
removal share one slot in the entity domain, because that slot outlives the
bounded generic ring, and splitting the pair would let the bound replay an effect
the backend removed (#222). The rest of `generic` keeps its place, so a
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
both states, `code_of_conduct` in configuration, and `add_resource_pack` and
`remove_resource_pack` in both (#98). A control frame relays to the player who
answers it, and never caches or replays, because a pending holder keeps the one
copy.

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
client a connection-control frame it must not act on by itself. The kept
connection, which is the default, serves the phase on the client's own
connection (#22): the front leg writes its own `start_configuration`,
relays the restarted configuration frames, relays the `finish_configuration`,
and the client's answer returns it to play. The same path serves a followed
transfer's target. With `transfer.keepConnection` off, the core ends the puppet
leg instead, and the normal backend-down path kicks the client with
`The server reconfigured this session. Reconnect in a few seconds.`.

### Pre-auth window (#201)

The front leg counts the sockets inside its pre-auth window: from accepting a
connection to the moment the client's UUID is resolved and the attach whitelist
has accepted it. Past that point the connection is a session, and the count never
looks at it again. The window is bounded by `preAuth.maxConnections` (16 by
default), and the leg closes a connection over it before any of its own state
exists for that connection: no login review, no configuration interceptor, no
channel.

The limit is a connection total rather than a rate or a per-source figure. A
TCP tunnel may present its own address instead of the client's, and a count does
not care whose address a socket carries (#199). The per-source limits and the
measurement that decides whether they mean anything arrive with #204.

A refused socket is destroyed rather than ended. The library's `end` waits on a
30 s close timeout, and a flood would sit in that wait. The client therefore sees
a closed connection, not a reason.

A connection denied before the whitelist accepts it stays counted until its
socket ends, which the library's close timeout bounds at 30 s. A denial flood can
therefore hold the window closed for that long. The deadline is disarmed at the
denial: the denial is that connection's decision, the close timeout bounds its
socket, and a deadline left armed would report a refused stranger as a stuck
socket. A denial after the accept, such as a backend that is not ready, lands on
a connection that has already left the window.

The reason is the operator's: the `preAuthRefused` log line, once per saturated
window rather than once per attempt, `front.preAuthRefused` in the heartbeat,
and `monoplayer.preauth.refused` in the telemetry.

### The pre-auth deadline (#205)

The cap bounds how many connections sit in the window. Nothing bounded how long
one stayed. `minecraft-protocol` sets no idle timeout on its client,
`closeTimeout` starts only after `end()`, and keep-alive runs in the play state
only, so a socket that is accepted and never speaks held its slot until its peer
closed or the process restarted. A stranger who opened `preAuth.maxConnections`
silent sockets closed the window by doing nothing, and the cap then refused every
real join. The library's own login timeout does not cover this case: it arms when
the login state starts, which needs a handshake the silent socket never sends.

`preAuth.deadlineMs` (30 s by default) is the bound. A connection still in the
window when its timer fires is destroyed, counted, and logged. Destroyed rather
than ended, for the reason the cap destroys: ending waits on the library's 30 s
close timeout, which would hand a silent peer another deadline's worth of slot.
The timer is disarmed when the connection leaves the window, so a slow but real
login that reached the whitelist is never cut by a bound it already met.

The close has its own reason, `preauth_deadline`, so an operator can tell a full
window from a stuck one. It is counted in `front.preAuthExpired`, sampled into
`monoplayer.preauth.expired`, and logged once per expiry.

Every expiry is logged, which the cap's refusal is not. The cap suppresses
because a flood writes thousands of refusals a second. An expiry cannot: the
window admits at most `preAuth.maxConnections` connections at once, so one
deadline period produces at most that many lines. Suppressing them would cost an
operator the only signal a sustained attack gives, because an attacker who keeps
staggered silent sockets in the window never lets it empty.

A sustained flood is not ended by this. An attacker who reconnects every 30 s
still closes the window for the moments it is full. The deadline bounds one
socket's occupancy; the per-source limits that answer a flood arrive with #204.

### One driver, and the lanes that can refuse a second client (#269, #312)

A body carries one driver. Which mechanism refuses the second client depends on the
lane's shape, and the two shapes refuse at different points.

A lane that offers a picker refuses by claim. Every admitted join reads the picker,
and the claim is what refuses a second client on a driven body. The refusal is one
sentence naming the holder. The client stays connected, in the picker, free to
spectate or pick something else (#259).

A lane that offers no picker has no claim to refuse at, and #269 deleted the front
leg's attach slot, which is what used to refuse the second client at `beforeLogin`.
Refusing at the attach is one phase too late. The client's configuration has already
been replayed to it from the body's cache, and the `already_attached` answer only
arrives at `playerJoin`. That is a kick read after a phase the client should never
have been shown (#312).

So the core's login decision refuses it, before Login Success and before every
configuration frame. The decision carries reason `already_driven`, the field
`lane: no_picker`, and one sentence the front writes into the login-state
`disconnect`: `Monoplayer: another player is already driving this server. Try again
when they leave.` The login decision is the last place this lane shape can refuse,
and the only one it needs.

The session keeps `already_attached` for a client the login admitted earlier. A
connection can fail between its login and its `playerJoin`, and that leaves a login
decision that is no longer true. The session is still the authority at the attach.

What a loopback proves: O67 refuses a second client on a pickerless lane with no
configuration frame and no login success. O60b sends one to the picker on a lane that
offers it. What a loopback cannot prove: what a vanilla client draws for either
sentence.

### The configuration baseline and the picker (#257)

A lane with no backend session has no configuration phase to replay, and a client
that joins it is refused. `MONOPLAYER_PICKER=1` changes that one case and nothing
else. A whitelisted client is held in the configuration phase and shown a dialog
listing the lane's allowed servers.

Two deployed lanes serve a picker since #579: the live lane, where a real player meets
it, and the dev lane, which runs the same front against a disposable Paper. The switch
is off by default, so a lane that names no `MONOPLAYER_PICKER` still refuses a
backendless join.

On a lane with a picker nothing is dialled before a claim, and a claim is what keeps a
body's retry armed. A driver that leaves releases the claim, and the body stands
unclaimed, which is a body a client may watch.
[The session invariants](#session-invariants-sessionjs) carry the rest.

- **The phase is a recording, never a construction.** `minecraft-protocol` writes
  registry frames only from `options.registryCodec`, and the codec it can write is
  the one vendored in minecraft-data: no registry tags, and for 26.2 one registry
  short of what a server sends (`minecraft:sulfur_cube_archetype`). A vanilla
  26.2 client that receives it finishes configuration and then fails on the first
  holder it cannot resolve. `src/legs/configuration-baseline/26.2.json` is the
  gate lane's Paper 26.2 build 135 configuration phase, recorded byte for byte by
  `src/ladder/capture-config.js`. Two captures of the same server are identical.
  `src/legs/configuration-baseline.js` validates it and hands the frames to the
  front leg, which serves them in recorded order and never edits one.
- **The phase stays open.** The recording carries a `finish_configuration` and the
  front does not send it: the picker dialog is the phase. A client that answered
  with `finish_configuration` would enter a world that does not exist.
- **The picker's phase carries no registry data (#598).** A client loads registries
  once, at the frame that ends the configuration phase, and a second copy of a
  registry id does not merge into the first: the client reports a duplicate key and
  drops the connection at `ClientboundFinishConfigurationPacket`. The recording's
  29 `registry_data` frames are therefore not served. The one reader a join is
  served through withholds them (`baselineFramesFor`), so no writer is handed a
  frame it has to remember not to send. The rest of the recording goes out in
  recorded order: `custom_payload`, `feature_flags`, `select_known_packs` and
  `tags`. The dialog needs a phase the client parses; the registry set belongs to
  the body a claim lands.
- **The pick rides in the action id.** `src/core/picker.js` builds a
  `minecraft:multi_action` dialog with one `minecraft:dynamic/custom` action per
  server, and reads the answer out of the frame's first field. The vanilla answer
  is `Identifier id, lengthPrefixed(optional anonymous NBT)`, while minecraft-data
  omits the length prefix: the library's writer and reader both disagree with the
  wire. The id survives in both, and `additions` does not, which is why the pick is
  never carried there.
- **The dialog is Minecraft's own shape.** The front authors a
  `minecraft:multi_action` dialog. It carries a string `title`, one column, and
  `can_close_with_escape` false. Each server is one action button, with its label
  and width written inline beside an action of type `minecraft:dynamic/custom`.
  Paper 26.2 loads the same dialog as a datapack registry entry, and its
  `RegistryDataLoader` refuses a copy with no `title`. Loading this one unchanged
  is how the shape was checked without a client.
- **That phase carries a dialog inline.** The 26.2 client reads the configuration
  `show_dialog` with `CONTEXT_FREE_STREAM_CODEC`, so no `minecraft:dialog` entry is
  needed. Its `ClientConfigurationPacketListenerImpl$2` extends
  `CommonDialogAccess`, so a custom action is clickable there and only command
  actions are inert.
- **Nothing is attached.** A picker join holds no channel and never reaches the
  core's session, so several clients may read the picker at once. The core
  counts the join as `attach_picker`, not as a denial. A pick is recorded and the
  client is shown that server's own dialog. The answer to it is recorded too.
- **The claim is recorded at the pick, not at login (#267).** The client that
  clicks `Claim` claims the body the frame names, and `src/core/claims.js` records
  it. Two rules hold. A body carries one claim. A connection carries one claim. A
  second claim on a claimed body is refused with one sentence naming the player who
  holds it, so two people never share a body's controls. The holder is the
  connection, so the claim ends when that connection ends. A client that never
  clicks `Claim` therefore holds nothing. Delivery is a channel's (#269): a grant
  opens the driver's channel on that body, and a body's frames go to every channel
  on it. The attach slot is gone, so a second claim on a driven body is refused by
  the claim rather than by an earlier admission check. A spectator's delivery exists
  beside it (#269, #259): the body's play state, on that connection, with nothing
  dialled, landed by the picker's own Spectate verb.
- **A claim is a landing (#258).** The click that grants a claim is the one thing
  that dials a body. The front asks the core for the body the frame named. The core
  points the puppet leg at that address, connects, and waits. The wait is bounded,
  and it ends when the body is attach-ready: its play login has landed, and its
  configuration and join prefix are cached. Nothing is dialled before a claim, which
  is why a lane nobody claims never opens a backend connection. The client's own
  configuration phase is still open from the baseline, so it continues with that
  body's configuration frames and ends with one `finish_configuration`. The phase
  carried no registry set before it, so the body's is the one set the client loads.
  The core then replays the body's play state on the connection the client
  already held.
  Each body owns its state cache (#260), so the frames the dial brings land in that
  body's cache and no other's. One body is still served at a time, because the
  session holds one backend connection: a claim on a different body is refused
  until a body gets a leg of its own (#261) and a channel to be delivered through
  (#269). The same body may be dialled again after its session faults, because that
  is one body and one cache.
- **A body that does not answer gives the picker back (#258).** A refused dial, a
  body that never warms, and a row whose name is not an address all end the same
  way: the client reads the list again, titled with the body that did not answer.
  Its claim still stands, because a claim belongs to the connection (#267), so the
  client may click `Claim` again. A second claim on a body that is connected and not
  yet warm waits on that body again. It does not dial a second body, and it does not
  refuse a client the picker just invited. A body that accepted every frame and then
  refused the finish is the one case the client is ended in words instead.
- **What the landing does not prove (#268).** One phase carries one registry set,
  and it is the body's (#598). The phase still carries the recording's `tags`,
  `feature_flags`, `select_known_packs` and `custom_payload` before the body's own
  copies of those four frames, and no rung measures whether a vanilla client accepts
  that. The disconnect a real client reported was a duplicate registry key, and
  nothing here measured what it does with a repeated tag, feature flag, known pack
  or custom payload. #603 is where that is measured. The only client on the offline
  rung is a protocol bot, and the body it lands on is a `minecraft-protocol` fake without
  terrain (`prismarine-chunk` has no 26.2 implementation). Rung 4 is where a real
  client answers. If a client refuses the remaining doubled frames, the fallback is
  to finish the client into an empty world and hand it over through the
  same-connection reconfiguration machine.
- **The second level is the server's own dialog (#266).** A pick sends a second
  `show_dialog` in the same open phase. The title is the server's name and state.
  The buttons are claim, spectate and disconnect, three `minecraft:dynamic/custom`
  actions. The phase still never finishes. It is a second frame, not a
  `minecraft:dialog` registry entry. The configuration `show_dialog` carries the
  dialog inline with no registry branch, and the recorded baseline is never edited.
- **The verb, and the server, ride in the id (#266).** The ids are
  `monoplayer:claim/<slug>`, `monoplayer:spectate/<slug>` and
  `monoplayer:disconnect/<slug>`: one namespace per verb, not a segment inside
  `monoplayer:pick/`. With the verb inside the pick namespace
  (`monoplayer:pick/<slug>/claim`), the picker's reader returns a pick of a server
  called `<slug>/claim`. Telling the two levels apart would then mean splitting a
  slug. The server is in the id too, so the front keeps no per-connection record of
  which dialog a client is looking at. The frame alone says which level it answers
  and which server it names. Two clients in the phase at once therefore cannot read
  each other's dialog.
- **A verb is honoured whether or not the client saw that dialog (#266).** The id is
  the request. A claim the client sends without a pick is read as a claim, not
  refused for the order it arrived in. A claim is authorised against the body the
  frame names, never against a dialog having been shown (#267).
- **A verb is read, reported, then answered (#266).** Claim, spectate and
  disconnect all act on a body. `claim` records the claim (#267).
  `disconnect` ends a body nobody claims (#261): the session goes `down` with no
  retry, the body's channels end with it, and the client that asked stays in the
  picker and is shown the list again, where that row now says `down`. A claimed
  body refuses it in one sentence naming the driver, and the client is
  disconnected with it. `spectate` is the third landing (#259): the
  click opens that client's spectator channel, continues its configuration phase
  with the body's own frames, and hands it the body's play state, with nothing
  dialled. A lane that serves no body yet, a row naming another body, a body still
  connecting and a body that is down are four refusals with four sentences, each
  asking the player for something different.
- **Who may watch a body, and what a spectator is (#259).** Any client the lane's
  identity gate admitted may watch any body the lane serves and has up, whether a
  driver holds it or not. No driver is asked for consent. The whitelist is the one
  authority a lane has, and a spectator cannot change the body. A request the driver
  must answer would put a dialog in front of a player who is mid-game. It would also
  need a default for the driver who never answers. A body with no driver is the
  ordinary case rather than an error: a claim is released when its connection ends,
  and the body keeps its backend session. So the ordinary case is watchable.
- **A spectator's client is told what it is (#259).** The replay carries the body's own
  game mode and abilities, because those are `latest` frames in the body's cache. So
  two frames go to that channel after the replay: `game_state_change` with reason 3
  and game mode 3, then `abilities` with the flags vanilla sends a spectator
  (invulnerable, flying, flying allowed) at the protocol's two speeds. They are the
  last word on that socket. A later frame from the body reaches the driver and never
  a spectator's channel, so the body's next mode change cannot put a spectator back in
  the driver's world.
- **The picker is the door on a lane that has one (#259).** Every admitted join is
  served the picker, whatever the session is doing, because a claim is the only thing
  that puts a client into a body. Before this, a join while a warm body stood with
  nobody driving it was attached as that body's driver down the pre-picker path with
  no claim recorded: the body was driven by a player the claim registry had never
  heard of, and nobody could watch it. A lane without the picker is unchanged, and no
  deployed lane is that since #579: the live lane serves one too.
- **A row says what a chooser needs (#259).** The row carries the body's state
  (claimed, unclaimed, or down), the driver's name from the claim, and how many
  channels on that body are spectators. A row is read at every dialog, so a claim
  made a moment ago is on the next one. A body the lane serves and has up with nobody
  holding it is `unclaimed`, which is the state a spectator can join. Everything else
  is `down`, including a body whose claim is still held: the state says whether the
  body can be entered, and the driver's name is a fact about a body that is up.
- **An unreadable answer is refused, never guessed at (#266).** `readServerAction`
  returns a reason rather than a null: `not_a_click`, `unknown_id`, `malformed` or
  `unknown_verb`. `serverActionProblemText` turns that reason into one sentence
  naming the id and the part that did not read. A frame that is not a configuration
  click at all keeps the dialog on screen, so the client can still choose. Anything
  else is logged and answered with a `disconnect`. It is never left in a dialog
  nobody will read.
- **The dialog's size is not the limit.** A server is about 172 bytes of dialog: a
  label, a width and one custom action. About 12 000 servers fit under the 2 MiB
  ceiling `show_dialog` reads. Measured while #255 was written, so do not
  re-measure.
- **The list is the allowed-server key, and two variables name it (#265, #356).** The
  picker offers the servers in `allowed-servers.json`, read at each offer through
  `control.allowedServers()`. `allowedServerSources` in `src/service/control.js` holds
  the order the two are asked in. A panel edit is therefore what the next join sees,
  with no restart. When the live key offers no list, the copy Git commits answers, if
  the lane names one and it reads. That covers a live file the lane never named,
  cannot read or cannot parse, because a broken list must not leave a client in a
  dialog with no buttons. A lane that names neither variable offers nothing, because
  the list is what a picker lane offers and not the backend it dials.

  A client that joins a lane with nothing to offer hears that in one sentence about
  the lane (#315). It never picked a server, so no sentence names one. The sentence is
  the same in every empty state, because the fix is never the client's.

  Why the list is empty is the offer's to say, and so is where to fix it.
  `pickerOffered` carries the answer's `reason`, the `file` it came from, and the `at`
  entry when the refusal names one, beside the source and the count. Each answer is a
  different edit. `no_key` is a variable to set, either
  `MONOPLAYER_ALLOWED_SERVERS` or `MONOPLAYER_ALLOWED_SERVERS_SEED`. `live_missing` is
  a file to write, `empty_list` a server to add, `seed_missing` a mount to fix, and
  `unreadable` a file to repair. A file that does not parse answers with the code
  `parseAllowedServers` refused with, so the entry to fix is named rather than nine
  repairs sharing one word. The refusal's own line repeats the reason.

  Each row's name is the canonical `host:port` its claim
  dials. A claim labels a body with the row's slug, while the body's state cache is
  keyed by the address the dial names. `pickerRows` normalises a row where it is
  read, so one server is one body id.
- **One switch, off by default.** `MONOPLAYER_PICKER` is read once at startup and
  validated. With it off, or with no baseline on disk, a join with no backend is
  refused with `backend_not_ready`, exactly as before.

#269 built the seam for a spectator and #259 finished it: a body's frames go to every
channel on it, a channel is not a driver by default, and the picker's Spectate verb
lands a client through `landSpectator` without a claim, a dial or a second login.
`O62` proves the click, and `O63` proves a body nobody drives is still watchable.

The gate for the whole epic is answered at rung 2 by `O55`, `O56` and `O56b`. A
26.2 client reads the recording, gets the dialog, and clicks one action. It then
receives that server's own dialog and clicks a verb, and the service records both
ids with the server they named. `O56b` refuses an unknown verb in a sentence that
names it. What no rung proves is that a vanilla 26.2 client accepts the registry
set. That is rung 4's question.

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
- A play dialog is never the puppet's (#20). `decideDialogAutoAnswer` in
  `src/core/dialog-codec.js` returns
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
name-based drops cover keep-alive, pong, and cookies. A resource pack's
`resource_pack_receive` forwards instead: the human's client is the one that
accepted, downloaded, and loaded the pack, so its status is the answer the
server hears, written as the puppet's own frame (#98).

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

**Seamless switch (#22), built and on by default.** The hub and sky-2 differ in
`dimension_type` (4 vs 9 entries) and `timeline` (4 vs 5), so a `respawn`
alone would leave the client without the target's dimensions. The
same-connection reconfiguration above replaces the registries, which is why it
is a full configuration phase and not a synthetic respawn.

The transfer testbed measured it with a real client on 2026-11-09: one socket
through the move, no kick, `transfersSeamless 1`, `frontKicks 0`, and the
target's play login on the same connection.
`MONOPLAYER_TRANSFER_KEEP_CONNECTION=0` turns it off for a lane, which is the
detach-and-rejoin path loopback `O21`-`O24` pin. The evidence run:

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

The loopback runs each path: O21-O24 assert the detach-and-rejoin with the key
off, O33-O35 the kept connection, which is the default. O43 follows a second
transfer from there to a gated target, where the
kept client leaves its configuration gate to the puppet (#73), and O44 leaves a
play dialog behind.

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

### The runtime control document (`config.control`, #229)

Two files an operator changes without a deploy:

| Path | Shape | Read |
| --- | --- | --- |
| `config.attachWhitelistFile` (`MONOPLAYER_ATTACH_WHITELIST`, `attach-whitelist.json`) | `{version, players:[{uuid,name,addedAt}]}` | at each login |
| `config.control.allowedServers` (`MONOPLAYER_ALLOWED_SERVERS`, `allowed-servers.json`) | `{version:1, servers:[{host,port,addedAt}]}` | at each offer the picker makes |
| `config.control.allowedServersSeed` (`MONOPLAYER_ALLOWED_SERVERS_SEED`, the committed `allowed-servers.json`) | the same shape | whenever the key above names no list |

**Each key is its own switch.** Naming the whitelist's path turns the attach
whitelist into a file; with it `null`, the compiled default is a lane that names
no file and the whitelist is the startup snapshot it has always been. Naming the
server list's path does the same for that list, and the list has a fallback the
whitelist does not: when the named file offers no list, the committed seed
answers.

#264 retired the third key, the desired backend that moved a running lane, with
the routing that superseded it.

The whitelist is read through `createWhitelistStore` (`src/custody/store.js`), in
the shape it already has, with `reloadEachUse` on. The core's login review takes
a provider (`createFrontIdentity`), and the front leg's own check reads the same
store instance, so a UUID added to the file is allowed at the next login and no
gate decides from a stale list.

An empty whitelist is a warning (`whitelistEmpty`) and the service starts. An
exit would crash-loop the pod on the same file, and the file is the one thing the
operator can fix.

Neither file reaches `loadConfig`: the path is config, the contents are runtime
state. A file that is there but cannot be read or parsed is named once, per file
(`controlUnreadable` with its error code, or `controlRejected` with its reason),
and ignored, and the lane keeps the value it had. A named whitelist file also
replaces a `config.attachWhitelist` array, so the file is the only authority
rather than one of two.

The allowed-server list is its own key with its own fallback: see
[The list is the allowed-server key](#the-configuration-baseline-and-the-picker-257).

### Session invariants (`session.js`)

- A retained transfer (`transferring`) keeps `detachCount` unchanged: the
  client is not detached for a move it can follow. `retainFront` on
  `backendDown` arms the reconnect without leaving the state, and a failed dial
  under a retained client retries instead of failing closed.
- (#261) A claim is the reason a body is kept alive. A fault that would arm a
  retry asks the session's `claimHeld` oracle first, and a body nobody claims
  lands in `down` instead: no session, no retry, and the picker's row says
  `down`. The oracle is the front leg's claim board, read where the session asks
  (`frontLeg.claimOn(body)`), so nothing keeps a second copy of a claim. A lane
  with no picker wires no oracle, and its bodies reconnect exactly as they did
  before this rule. The same rule ends the retries a claim no longer pays for: a
  claim released while an attempt is pending spends no further attempt.
- (#261) `end({ reason })` is a requested end, and `down` is where it lands: a
  player asked from the picker, the body arms no retry, and a claim is what dials
  it back. The session refuses it while a client is attached
  (`client_attached`) whatever the caller asked, because ending a driven body
  takes a world away from a client that still holds the claim. An armed retry is
  cleared on the way down, and `connectClaimedBody` dials out of `down` the way
  it dials out of `boot` and `failed`.
- (#261) What a loopback can prove: O65 takes a body nobody claims through a
  fault, and the body lands in `down` with no retry armed, the row says `down`,
  and a claim dials it back. What it cannot prove: a fault under a *driver* still
  ends that driver's connection, whatever the claim says. The claim buys the body a
  retry, and the driver rejoins to find it; the seam proves that retry and the fresh
  login (`test/service/body-lifecycle.test.js`). Keeping the connection needs a
  same-connection reconfiguration round that a fault starts, with somewhere to put
  the driver when the body cannot come back (#334).
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

frontLeg = {                      // a body's channels: its driver and its spectators (#269)
  setLoginStartHandler(payload => decision)   // -> createMonoplayer().processLoginStart
                                              //    denied => end(uuid-deny) BEFORE Login Success
  setServerboundHandler(({ state, name, buffer, data }) => {})
  setDetachHandler(({ reason }) => {})        // the driver's channel ended; the body survives
  setClientSettingsHandler(settings => {})    // -> createMonoplayer().noteClientSettings
                                              //    the driver's Client Information, read-only
  setConfiguringHandler(({ name }) => {})     // -> createMonoplayer().configuringReady
                                              //    the client entered its own configuration
                                              //    phase (#16)
  setSpectateBody(fn)                         // optional (#269): registers
                                              //    fn({ body, server, name }) ->
                                              //    createMonoplayer().spectateBody, which
                                              //    answers whether the body may be watched
  setSpectatorAttach(fn)                      // optional (#269): registers
                                              //    fn({ name, uuid, channel }) ->
                                              //    createMonoplayer().spectateView, the
                                              //    body's play state on that one channel,
                                              //    and the entry that names it (#516)
  setDisconnectBody(fn)                       // optional (#261): registers
                                              //    fn({ body, server, name }) ->
                                              //    createMonoplayer().disconnectBody, which
                                              //    ends an unclaimed body on request
  claimOn(body)                               // (#261) the claim on one body, or null:
                                              //    the session's claimHeld oracle reads it
  write(name, packet, { synth, channel }), writeRaw(buffer, meta, { channel })
  end(reason)                     // deny/kick/close, to every channel
}

A write without `channel` goes to every channel on the body: its driver, and the
spectators watching it. A write with one goes to that connection alone, which is
how a spectator is handed its body's replay without the driver receiving it twice.
The leg keeps one channel per connection: its role, what it has been sent, and its
own client information (`src/core/channels.js`). The claim decides who drives
(`src/core/claims.js`); a channel is what each connection is handed, and a
spectator's frames never reach the core's pipeline.
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
- Resource packs: the pack is a control frame the human answers (#98). The
  held copy lives in `src/core/pending-resource-pack.js`, outside the state
  cache, so a play-state pack is not evicted from the generic ring before a
  client attaches. With no client attached, the puppet accepts and loads; with
  one attached, it says nothing and the human's status is the answer. An absent
  UUID on `remove_resource_pack` withdraws every pack.

## Limits / open questions

- Cross-domain replay interleaving is flattened (all chunks before all blocks,
  etc.). For the join-time state this is correct-ish for block-vs-chunk (blocks
  apply only where chunks are loaded), but a client that rejects a flattened
  order with a real backend would falsify the synthesis — test with the 26.1
  client, not the fakes.
- `entity` domain bounds are defaults, not measurements: 2048 entities, 128
  slots per entity, and 32768 slots in the domain, so the memory ceiling is about
  3 MB of small entity frames instead of the old 2048-frame ring. Nothing
  measures how many entities a real backend tracks, and the peak on Excalia is its
  own ticket. Until it lands, `sizes` rides the warm and login log lines;
  `entitySlots`, `entityRemovals`, and the three overflow counters are on
  `stats()`, and the attach record #218 adds is where they reach an operator.
- Only the frames `join-synth.ENTITY_GENERIC_FRAMES` lists leave `generic`'s
  place in the replay. Every other generic frame keeps it. Chunks and
  blocks still replay before it, and `latest` and `inventories` keep their
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
- CLI: `--print-config`, `--help`, and `--start` behind its default-invocation
  guard. No mise/package changes per slice rules.

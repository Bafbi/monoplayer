# Monoplayer

Monoplayer holds one Minecraft account's session open on a server and lets whitelisted players attach to that session and play through it.

## Accounts and identity

**Puppet**:
The Minecraft account whose session Monoplayer holds on a server. Nobody plays it directly while Monoplayer holds it.
_Avoid_: bot, alt, proxy account, puppet client

**Attaching player**:
The person who connects to Monoplayer to play through the puppet's session, and the Minecraft account they use for it.
_Avoid_: client, user, guest, second player

**Custody**:
The on-disk store of one puppet account's refresh-token chain, profile, and writer lock. Custody is the security boundary: whoever can read it can act as the puppet.
_Avoid_: token store, secrets, credentials directory

**Account directory**:
One puppet account's custody: a profile, one token cache per step of the auth chain, and the writer lock.
_Avoid_: cache directory, secrets folder

**Token cache**:
The file in an account directory that holds the tokens for one step of the Microsoft auth chain. Microsoft rotates the chain on every refresh, so a copy goes stale at once.
_Avoid_: token file, credentials file

**Writer lock**:
The lock that lets exactly one process rotate a puppet account's tokens. A second writer invalidates the chain the first one holds.
_Avoid_: mutex, pid file

**Profile**:
The puppet account's Minecraft identity facts: UUID, name, alias, and which Microsoft title issued its tokens. It never holds a token value.
_Avoid_: identity file, metadata

**Attach whitelist**:
The set of player UUIDs allowed to attach. It holds UUIDs, never names.
_Avoid_: allowlist, player list, guest list

**Backend whitelist**:
The game server's own whitelist, which names the puppet and does not name the attaching player.
_Avoid_: server whitelist, whitelist

**Attach check**:
The two steps an attaching player passes before play: the whitelist review, then session verification.
_Avoid_: attach gate, auth gate, login gate

**Whitelist review**:
The first step of the attach check: the claimed UUID must be on the attach whitelist. A denial here lands before any login success.
_Avoid_: gate one, precheck

**Session verification**:
The second step of the attach check: the Mojang sessionserver confirms that the connecting account's session matches the name and UUID it claims.
_Avoid_: hasJoined check, auth check

## The proxy

**Service**:
The running Monoplayer process: config, core, both legs, custody, and the CLI. It holds one puppet session open and serves one attach at a time.
_Avoid_: app, daemon, the proxy, the bot

**Front leg**:
Monoplayer's server-side connection: the socket an attaching player joins, authenticated as that player.
_Avoid_: front, client leg, ingress

**Backend leg**:
Monoplayer's client-side connection: the socket that holds the puppet's session on the game server, authenticated as the puppet.
_Avoid_: backend, puppet leg, egress

**Offline leg**:
A front leg or backend leg that runs on loopback without Microsoft auth, using vanilla offline UUIDs. It exists for the cheaper rungs.
_Avoid_: test leg, fake leg, dev mode

**Core**:
The pure engine between the two legs: session state, the state cache, the clientbound policy, attach synthesis, identity, and relay decisions. It owns no socket and no clock.
_Avoid_: engine, proxy core, relay

**Backend session**:
The puppet's authenticated connection to one game server. One backend session means one backend login, and it outlives every attach.
_Avoid_: puppet session, connection, login

**Session state**:
The stage a backend session is in. The stages are boot (no connection), warm (a complete join is cached), attached (a player is playing through it), detached (no player, session alive), reconnecting (one retry pending), and failed (the retry budget is spent).
_Avoid_: status, phase

**Warm**:
The state in which the state cache holds a complete join for the current backend session, so an attach can be served from it.
_Avoid_: ready, primed, loaded

**Warm fallback**:
Declaring the join prefix settled at its current edge when the backend never marks the end of a chunk batch.
_Avoid_: forced warm, grace window

**Attach-ready**:
Warm with no attaching player in the way, so the attach check can pass.
_Avoid_: ready, healthy

**Attach**:
One attaching player taking over the puppet's session through the front leg and receiving the attach stream.
_Avoid_: join, connect, takeover

**Attach slot**:
The single place for one attaching player. A second connection is denied while the slot is held.
_Avoid_: client slot, seat

**Detach**:
The attaching player's connection ending while the backend session survives.
_Avoid_: disconnect, logout

**Backend fault**:
The backend session ending without a deliberate teardown: a socket end, a kick, a timeout, or a server restart.
_Avoid_: crash, outage, disconnect

**Reconnect**:
Re-establishing the backend session after a fault, with at most one attempt pending at a time and a capped backoff.
_Avoid_: retry, reconnect loop

**Reconfiguration**:
A server restarting the configuration phase on the live backend session. The front leg cannot serve that phase, so Monoplayer detaches the player and reconnects.
_Avoid_: config reload, rejoin

**Transfer**:
A server instruction, sent on the puppet's connection, to move the session to another address.
_Avoid_: redirect, handoff, switch

**Transfer follow**:
Monoplayer's decision to move the puppet to a transfer's target rather than pass the transfer to the attaching player.
_Avoid_: redirect follow, migration

**Transfer chain**:
The targets a session has been moved to in a row. A repeated target, or a chain past the limit, is refused.
_Avoid_: redirect chain, hop history

**Protocol pin**:
The single Minecraft version Monoplayer speaks. Moving it is a migration, not a configuration change.
_Avoid_: supported versions, version matrix

## What crosses the wire

**Clientbound policy**:
The one table that decides, for each clientbound frame, whether Monoplayer caches it, relays it live, replays it on attach, or blocks it.
_Avoid_: rules, filters, packet list

**Clientbound decision**:
One of six outcomes the clientbound policy returns for a frame. State caches, relays, and replays it; cache only caches and replays; live only relays while attached; control relays it to the answering player and never caches or replays it; per leg leaves it to the connection that received it; block never crosses.
_Avoid_: action, verdict

**Control dialog**:
A server question that a player answers: `show_dialog` and `clear_dialog` in play or in configuration, and `code_of_conduct` in configuration. It crosses to the player who answers it, and their answer goes back to the server as the puppet's own frame.
_Avoid_: prompt, popup, form, UI

**Pending dialog**:
The last control dialog no player has answered. Monoplayer holds it, replaces it when a newer one arrives, drops it on `clear_dialog` or on the player's answer, and re-sends it when a player attaches in its phase.
_Avoid_: dialog queue, dialog cache

**Per-leg frame**:
A frame that belongs to the connection that received it, such as a keep-alive, a position, a ping, or a bundle delimiter. Each leg answers or ignores its own.
_Avoid_: connection frame, local frame

**State cache**:
The bounded store of clientbound frames from the backend session, split by the kind of state it holds so that an attach is rebuilt from state rather than from a frame history.
_Avoid_: frame cache, buffer, ring

**Join prefix**:
The ordered frames of a join, captured verbatim until warm, that every later attach replays in the same order.
_Avoid_: login prefix, join sequence

**Configuration replay**:
The cached configuration-phase frames replayed to a new attaching player in place of the server's own configuration phase.
_Avoid_: config replay, registry replay

**Attach stream**:
The ordered clientbound frames Monoplayer sends for one attach: configuration replay, join prefix, one synthesized position, then the rest of the cached state.
_Avoid_: replay, join packet, attach payload

**Synthesized position**:
The one position frame per attach that Monoplayer writes itself, at the puppet's pose, with a teleport id that Monoplayer owns.
_Avoid_: fake position, snap

**Pose**:
The puppet's last known position and rotation, taken from backend teleports and from the attaching player's movement.
_Avoid_: location, coordinates

**Serverbound drop**:
A frame from the attaching player that Monoplayer answers or discards instead of forwarding, because it belongs to a connection rather than to the session.
_Avoid_: filter, blocked packet

**Speak**:
To send the attaching player's message or command text on the backend leg as the puppet, signing it with the puppet's profile keys and its own last-seen window. The proxy never forwards the player's chat frame: its signature and window belong to the player's connection.
_Avoid_: forward chat, proxy chat, relay chat

**Chat mode**:
The `config.chat` setting. `read-only` (the default) relays the server's chat and drops the player's text; `full` also speaks the player's text and relays the server's signed player chat; `off` blocks both directions.
_Avoid_: mute, disable chat

**Read-only chat**:
The `read-only` chat mode: the attaching player sees the server's chat and cannot speak. `system_chat` and `profileless_chat` are relayed; the player's own chat text and the server's signed `player_chat` stay off.
_Avoid_: muted chat, one-way chat

**Proxy notice**:
A message Monoplayer writes to the attaching player in its own voice, such as a refused transfer. It rides a synthetic advancement with a visible toast, added and removed in the same call so the client's advancement state is unchanged afterwards, and falls back to local system chat when the toast frame cannot be written.
_Avoid_: local chat, toast

**Wire check**:
A strict parse of one clientbound frame that fails on leftover bytes or on a frame name that does not match its state.
_Avoid_: validator, frame linter

## Watching it run

**Journal**:
The exact per-frame record of a session, written as NDJSON. It is off unless a directory is configured.
_Avoid_: packet log, trace

**Telemetry**:
The OTLP logs and metrics Monoplayer exports. Lifecycle events become log records; frame counts become metrics.
_Avoid_: metrics, tracing

**Observability**:
What the service says about itself: the journal, the telemetry, and the redaction every line passes through. It owns no game state.
_Avoid_: monitoring, instrumentation

**Redaction**:
The rewrite of secret-shaped strings to the sentinel before anything leaves the process. Logs, journal lines, reports, and telemetry all pass through it.
_Avoid_: scrubbing, masking, sanitizing

**Sentinel**:
The fixed string `[REDACTED]` that replaces a secret.
_Avoid_: mask

## Proving it works

**Testing ladder**:
The ordered set of checks from cheapest and least realistic to most expensive and most realistic. A cheaper rung cannot catch what a more expensive one catches.
_Avoid_: test pyramid, CI stages, suite

**Rung**:
One level of the testing ladder, with its command, cost, prerequisites, and the class of defect it cannot catch.
_Avoid_: level, stage, layer

**Assertion**:
One named claim that a check makes and that fails the run when false.
_Avoid_: test case, expectation

**State parity**:
The check that the state an attaching player decoded equals the state the attach stream claimed to replay.
_Avoid_: equivalence check, replay diff

**Validation row**:
One named check in a validation plan, such as one backend in a matrix or one fault case. Its label is local to that plan and never names a directory or a symbol.
_Avoid_: gate, milestone, stage

**Verdict**:
The pass or fail result of one scenario, with the evidence that produced it.
_Avoid_: result, status, report

**Evidence**:
The recorded artifacts a verdict rests on: reports, logs, screenshots, and captured verdict files.
_Avoid_: proof, artifacts

**Fake backend**:
An in-process game server that speaks the real protocol and follows a script, used where a real server would be slow, remote, or uncooperative.
_Avoid_: mock, stub, fake server

**Protocol bot**:
A scripted client built on the protocol library, used as an attaching player. It proves wire shape and relay behavior, never rendering or vanilla acceptance.
_Avoid_: headless client, test client, fake player

**Client driver**:
The Fabric-modded real Minecraft client that a test harness drives, so a real-client check becomes deterministic.
_Avoid_: bot, test client, automation client

**Unmodded witness**:
A manual run of the unmodded real client, kept so that a client driver bug cannot hide a product bug.
_Avoid_: control run, manual test

**Driver lane**:
The automated real-client scenario: launch the client driver, drive it, assert against the server, and record a verdict.
_Avoid_: real-client gate, automation lane

**Testbed**:
An isolated cluster environment where a scenario runs against real servers instead of a fake or a public one.
_Avoid_: staging, sandbox, lab

**Transfer testbed**:
The two-server testbed that can trigger a transfer on demand, so the transfer path runs without a menu click.
_Avoid_: twin servers, migration lab

**Protocol spike**:
The frozen two-leg relay that came before the core. It stays green as a regression check on the wire, and it grows no features.
_Avoid_: legacy proxy, proof of concept

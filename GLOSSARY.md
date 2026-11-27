# Monoplayer

Monoplayer holds one Minecraft account's sessions open on many servers at once, and lets whitelisted players claim one of them to play through it, or watch it.

## The model

**Account**:
One Minecraft identity: one profile and one refresh-token chain, held in custody. It owns every body it has logged in on, and the one Monoplayer holds is the puppet.
_Avoid_: user, player, login, alt

**Body**:
One session of the account on one game server: the connection that server sees, and the player it sees standing in its world. A body outlives every claim, and there is at most one per allowed server. A claim is the reason a body is kept alive: a fault while nobody claims it takes the body down, and a claim is what dials it back.
_Avoid_: backend session, puppet session, character, alt

**Claim**:
One attaching player's exclusive control of a body, held by the connection that made it and released when that connection ends. The player who holds it is the body's driver, and any other player watching the body is a spectator. A body carries one claim, and a second claim on it is refused with the name of the player who holds it. A connection carries one claim, so a client that already holds one cannot claim a second. The picker records the claim where the player answers a body's dialog, so a client that never answers one holds nothing. It is not the account lease, which a run holds rather than a player.
_Avoid_: lock, slot, seat, take

**Driver**:
The attaching player who holds a body's claim, and so drives it. Their movement moves the body, their commands are spoken as the puppet, and their chat text is dropped.
_Avoid_: controller, owner, player in control, operator

**Spectator**:
An attaching player who watches a body without control. They receive the body's world and the body itself, and nothing they send reaches the server. Any player the lane admits may watch any body it serves and has up, whether or not a driver holds it. The whitelist is who may watch, and no driver is asked. A spectator's client is told what it is: spectator game mode, and the abilities that go with it. A frame from the body never puts it back in the driver's mode.
_Avoid_: viewer, watcher, observer, audience

**Channel**:
One attaching player's delivery of one body: whether they are its driver or a spectator, what they have been sent, and their own client settings. A body's frames go to every channel on that body, and the channel is what keeps two clients on one body apart. A spectator's channel receives the body's stream and sends nothing to the server: its frames are dropped at the front, before the backend leg.
_Avoid_: connection, socket, session, slot, seat

**Picker**:
The configuration-phase dialog an attaching player lands in before they have a body: one entry per allowed server, labelled with that server's body, who is driving it, and how many are watching it. Picking a server opens its own dialog, which claims that body, watches it, or disconnects it. A disconnect ends the body, and only while nobody claims it: a claimed body refuses the request in a sentence naming the driver. On a lane with the picker, every admitted join is served the picker: a claim is the only way into a body.
_Avoid_: lobby, menu, server list, hub, browser

**Allowed server**:
One game server an attaching player may pick in the picker. The list of them is its own file in the control ConfigMap, `allowed-servers.json`, named by `MONOPLAYER_ALLOWED_SERVERS`. An operator edits it through the panel, so adding a server is not a deploy. A row is named for the `host:port` its claim dials.
_Avoid_: whitelisted server, approved server, server whitelist, target

## Accounts and identity

**Puppet**:
The Minecraft account whose bodies Monoplayer holds. Nobody plays it directly while Monoplayer holds it.
_Avoid_: bot, alt, proxy account, puppet client

**Attaching player**:
The person who connects to the front leg, and the Minecraft account they use for it, who drives a body by claiming it or watches it as a spectator.
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

**Account lease**:
The Kubernetes `Lease` named `monoplayer-online-account` in `monoplayer`, the namespace that holds the custody. One identity is one refresh chain with one writer lock, so a run that uses the real account takes it and holds it while it runs. The holder it records is the run's gate lane, its branch, and its pid, so a refusal reads as a person's run. It is no workload, so holding one scales, patches, and restarts nothing. It is not the writer lock, which keeps two processes in one account directory apart. It is not a claim, which is one player's hold on one body. `docs/testing-ladder.md` holds the runbook.
_Avoid_: account lock, refresh lock, account slot

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
The two steps an attaching player passes before they drive a body. An online lane runs session verification first and the whitelist review second, because the front leg's library answers the sessionserver before the leg reviews the login. A test-double lane has no session to verify, so it runs the whitelist review alone.
_Avoid_: attach gate, auth gate, login gate

**Whitelist review**:
The attach check's whitelist step: the claimed UUID must be on the attach whitelist, and a denial lands before Login Success. `reviewLoginStart` in `src/core/identity.js` is the decision, reached through `setLoginStartHandler`. `checkVerified` in `src/custody/attach.js` is the leg's own review, and it answers only a lane whose core wired no `setLoginStartHandler`.
_Avoid_: gate one, precheck

**Session verification**:
The attach check's session step: the Mojang sessionserver confirms that the connecting account's session matches the name and UUID it claims. In a live lane `minecraft-protocol`'s login handler answers `hasJoined` before the leg's `beforeLogin`, and `src/legs/live-front.js` counts that refusal as `sessionVerificationRefused` and records it as `libraryLoginRefused` (#722, #742). `src/core/identity.js` keeps no copy of the step.
_Avoid_: hasJoined check, auth check

**UUID decision**:
The answer the shape rule gives one attach-whitelist entry's uuid: nothing when a Mojang session can ever authenticate it, and the reason when none can. `uuidRefusalReason` in `src/custody/util.js` is the rule, and it owns which uuid shapes it refuses. `scripts/dev-lane.sh` reports one per entry and `src/panel/` prints one beside each row. It is not the whitelist review, which compares the uuid a login claims against this list, and this decision asks nothing about a login. It is not a verdict, which is one scenario's pass or fail with the evidence that produced it (#747).
_Avoid_: result, status, report, verdict, admission

## The proxy

**Service**:
The running Monoplayer process: config, core, both legs, custody, and the CLI. It holds the account's bodies open and serves one claim per body, with any number of spectators.
_Avoid_: app, daemon, the proxy, the bot

**Control document**:
The files an operator edits between deploys: `config.attachWhitelistFile` (`MONOPLAYER_ATTACH_WHITELIST`, `attach-whitelist.json`) and `config.control.allowedServers` (`MONOPLAYER_ALLOWED_SERVERS`, `allowed-servers.json`). Each key is its own file, its own variable, and its own reader. Each read goes back to the file: the whitelist at every login, the server list at every offer. Nothing watches either file, so an edit lands on the next read, without a restart. A path left unset means no lane reads that key. Naming the whitelist's path is also what makes the attach whitelist a file rather than the startup snapshot. The server list is the one key with a fallback: `config.control.allowedServersSeed` (`MONOPLAYER_ALLOWED_SERVERS_SEED`), the copy Git commits, which answers whenever the live file offers no list. Monoplayer names a file it cannot read or parse once, and ignores it: a broken file never stops the lane.
_Avoid_: control file, runtime config, feature flag, control dialog

**Testbed front**:
The testbed's published endpoint: its front Service, the Tailscale proxy pod the operator runs for it, and their tailnet name, `monoplayer-testbed.tail41e568.ts.net`. `down` deletes the front Service, and the Tailscale operator then removes the pod and the tailnet name.
_Avoid_: testbed Service, the front unqualified

**Front Service**:
The Kubernetes Service `monoplayer-testbed`: the part of the testbed front that publishes it. Scaling the testbed deployment to zero leaves it published with no endpoints, which is why `down` deletes it.
_Avoid_: testbed service, the front

**Front leg**:
Monoplayer's server-side connection: the socket an attaching player joins, authenticated as that player.
_Avoid_: front, client leg, ingress

**Public route**:
The playit.gg tunnel's address, the one way to the front from outside the tailnet: one agent Deployment that forwards a raw TCP port to the front's in-namespace DNS name, and the name playit assigns to it. It is a route, not a gate: authentication and the attach whitelist decide who stays, on either route.
_Avoid_: public door, public address, ingress, port forward

**Backend leg**:
Monoplayer's client-side connection: the socket that holds one body's session on its game server, authenticated as the puppet.
_Avoid_: backend, puppet leg, egress

**Offline leg**:
A front leg or backend leg that runs without Microsoft auth, using vanilla offline UUIDs. A rung runs the pair on loopback. A lane whose job is a test double composes them for a cluster. That is why each leg takes `allowNonLoopback`, and why the composition root is the only caller that sets it (`docs/adr/the-product-may-be-a-test-double.md`).
_Avoid_: test leg, fake leg, dev mode

**Core**:
The pure engine between the two legs: the picker, the claim, each body's session state and state cache, the clientbound policy, what each client has been sent, identity, and relay decisions. It owns no socket and no clock.
_Avoid_: engine, proxy core, relay

**Backend session**:
_Superseded by_ body, one per server. The code's word for a body today: the puppet's authenticated connection to one game server, which outlives every attach.
_Avoid_: puppet session, connection, login

**Session state**:
The stage a body is in. The stages are boot (no connection), warm (a complete join is cached), configuring (a player connected before the join is cached), attached (a driver holds the claim), detached (nobody is driving it, and the body is alive), transferring (the driver is following the body to another server), reconnecting (one retry pending), down (no connection and no retry: nobody claims the body, or a player ended it, and a claim is what dials it again), and failed (the retry budget is spent).
_Avoid_: status, phase

**Warm**:
The state in which the state cache holds a complete join for the current body, so a claim can be served from it.
_Avoid_: ready, primed, loaded

**Warm fallback**:
Declaring the join prefix settled at its current edge when the backend never marks the end of a chunk batch.
_Avoid_: forced warm, grace window

**Attach-ready**:
Warm with no claim on the body, so the attach check can pass.
_Avoid_: ready, healthy

**Attach**:
An attaching player's connection to the front leg, authenticated as that player. Driving a body or watching one is a role the claim decides, not a property of the attach.
_Avoid_: join, connect, takeover

**Pre-auth window**:
The stretch of a front-leg connection from the accepted socket to the moment the attach whitelist accepts the resolved UUID. A connection past that point is an attach, and no pre-auth limit looks at it again. `preAuth.maxConnections` bounds how many connections sit in the window at once, and `preAuth.deadlineMs` bounds how long one may stay. A connection denied before the whitelist accepts it stays counted until its socket ends, because a denial is not the accept the window is defined by.
_Avoid_: auth window, login window, flood window, connection queue

**Detach**:
An attaching player's connection to the front leg ending while the body survives. It is the normal case: the body stays, and another player may claim it or watch it.
_Avoid_: disconnect, logout

**Backend fault**:
A body's connection ending without a deliberate teardown: a socket end, a kick, a timeout, or a server restart.
_Avoid_: crash, outage, disconnect

**Reconnect**:
Re-establishing a body's connection after a fault, with at most one attempt pending at a time and a capped backoff.
_Avoid_: retry, reconnect loop

**Reconfiguration**:
The client's own configuration phase restarting on the connection it holds, served by Monoplayer with the target's or the same server's configuration frames. The player sees a loading screen and keeps the connection. On by default through `transfer.keepConnection`.
_Avoid_: config reload, rejoin, reconnect

**Seamless transfer**:
A followed transfer that keeps the driver's connection and lands it in the target's play state through a reconfiguration. On by default (`transfer.keepConnection: true`).
_Avoid_: hot swap, live migration

**Transfer**:
A server instruction, sent on the puppet's connection, to move the session to another address.
_Avoid_: redirect, handoff, switch

**Transfer follow**:
Monoplayer's decision to move the puppet to a transfer's target rather than pass the transfer to the driver. With a driver on the body, the driver follows on their own connection (see seamless transfer); with no driver, the puppet moves alone.
_Avoid_: redirect follow, migration

**Follow budget**:
How many failed dials a followed transfer survives before the controller gives up and sends the puppet back to the server the restored client holds state for. Three by default.
_Avoid_: retry budget, failure budget

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
A server question that a player answers: `show_dialog` and `clear_dialog` in play or in configuration, and `code_of_conduct` in configuration. It crosses to the driver who answers it, and their answer goes back to the server as the puppet's own frame. It shares nothing with the control document but the adjective.
_Avoid_: prompt, popup, form, UI, control

**Dialog codec**:
The two halves of a control dialog's wire form, and the rule that decides whether the puppet may answer one: the reader that lists a `show_dialog`'s actions and chooses one, the encoder that builds the `custom_click_action` body, and the per-dialog decision that refuses a play dialog and stands down while a body has a driver. The leg asks that question once per dialog, counts the answers against its cap, and writes the frame.
_Avoid_: dialog helper, dialog utils

**Resource pack**:
A control frame the server pushes once per connection with `add_resource_pack` and withdraws with `remove_resource_pack` — one pack by UUID, or every pack when the UUID is absent. It is the driver's to accept or decline, and their `resource_pack_receive` reaches the server as the puppet's own frame, in each stage the client sends, while the puppet is in the state that frame was sent in. With no driver on the body, the puppet accepts and loads.
_Avoid_: texture pack, pack request, pack push

**Pending resource pack**:
A pack the backend sent that a client can still be shown. Monoplayer holds one copy per pack UUID outside the state cache, because the server sends a pack once and a later player would otherwise get nothing. `remove_resource_pack` drops it, a backend teardown or a failed transfer drops it, and a driver's answer never does.
_Avoid_: pack cache, pack queue

**Pending dialog**:
The last control dialog on a body that no player has answered. Monoplayer holds it, replaces it when a newer one arrives, drops it on `clear_dialog`, on the driver's answer, or when the puppet answers a configuration gate the last driver left, and re-sends it when the body is claimed in that phase.
_Avoid_: dialog queue, dialog cache

**Play dialog**:
A control dialog the backend asks in the play phase. It belongs to the driver, who answers it or leaves it waiting, and the puppet never clicks one, driven or not. `MONOPLAYER_DIALOG_ACTION` does not cover it.
_Avoid_: play gate, in-game dialog

**Configuration gate**:
A control dialog the backend asks in the configuration phase, including the code of conduct. A headless puppet may answer one with `MONOPLAYER_DIALOG_ACTION`; a driver always gets it instead.
_Avoid_: config dialog, join gate

**Gate fallback**:
The puppet's own answer to a configuration gate while nobody drives the body: it accepts the gate and logs `codeOfConductAccepted`. A gate the protocol library answers itself, the code of conduct, always takes this path when no player drives the body; a gate with buttons is `MONOPLAYER_DIALOG_ACTION`'s. While a driver holds the claim the gate is theirs and there is no timeout. The fallback also applies when the last driver detaches with the gate still open and the puppet still in configuration, because that is the same condition becoming true.
_Avoid_: auto-accept, gate timeout

**Per-leg frame**:
A frame that belongs to the connection that received it, such as a keep-alive, a position, a ping, or a bundle delimiter. Each leg answers or ignores its own.
_Avoid_: connection frame, local frame

**State cache**:
The bounded store of clientbound frames from one body, split by the kind of state it holds so that a joining player is served from state rather than from a frame history. A body has one, shared by its driver and its spectators, so a replay is computed once per body.
_Avoid_: frame cache, buffer, ring

**Entity slot**:
One addressable piece of one entity's cached state: a metadata index, one effect, the removal, or one other entity frame that carries a whole value. A slot holds the newest raw frame for its key, so an attach replays each piece once, at its last value, and an entity always replays beside the spawn that gave it a model. An effect's slot takes the newest frame about that effect, so it holds either the add or a removal (#222).
_Avoid_: entry, cell, field

**Join prefix**:
The ordered frames of a join, captured verbatim until warm, that every later attach replays in the same order.
_Avoid_: login prefix, join sequence

**Configuration replay**:
A body's cached configuration-phase frames, replayed to a joining player in place of the server's own configuration phase. The picker's frames are not a replay: the front writes them, with no backend behind them.
_Avoid_: config replay, registry replay

**Play state**:
The protocol phase after configuration, where a body's world and its players exist. A client's `player_info` entries belong to one play state. A new play state starts with none, and a fresh connection, a reconfiguration, and a pick each create one.
_Avoid_: world state, in-game

**Attach stream**:
The ordered clientbound frames Monoplayer sends to one player: configuration replay, join prefix, one synthesized position, then the rest of the body's cached state. A driver and the body's spectators receive the same stream, except for the frames that say what their own client is. A spectator is told its game mode and abilities last, and the body's own mode frames never reach it. It survives a body's reconnect.
_Avoid_: replay, join packet, attach payload

**Synthesized position**:
The one position frame per attach that Monoplayer writes itself, at the puppet's pose, with a teleport id that Monoplayer owns.
_Avoid_: fake position, snap

**Pose**:
The puppet's last known position and rotation, taken from backend teleports and from the driver's movement.
_Avoid_: location, coordinates

**Serverbound drop**:
A frame from the driver that Monoplayer answers or discards instead of forwarding, because it belongs to a connection rather than to the session.
_Avoid_: filter, blocked packet

**Speak**:
To send the driver's message or command text on the backend leg as the puppet, signing it with the puppet's profile keys and its own last-seen window. The proxy never forwards the player's chat frame: its signature and window belong to the player's connection.
_Avoid_: forward chat, proxy chat, relay chat

**Chat mode**:
The `config.chat` setting. `read-only` (the default) relays the server's chat and drops the driver's text; `commands` speaks the driver's commands and still drops their chat text; `full` also speaks the driver's chat text and relays the server's signed player chat; `off` blocks both directions.
_Avoid_: mute, disable chat

**Read-only chat**:
The `read-only` chat mode: the driver sees the server's chat and cannot speak. `system_chat` and `profileless_chat` are relayed; the player's own chat text and the server's signed `player_chat` stay off.
_Avoid_: muted chat, one-way chat

**Commands chat**:
The `commands` chat mode: the driver's commands are spoken as the puppet, so `/profil`, `/msg`, and `/tp` reach the server, and their open chat text is dropped. Its clientbound side is read-only chat, so a reply the server sends as `player_chat` does not reach them.
_Avoid_: command-only chat, slash mode

**Proxy notice**:
A message Monoplayer writes to the driver in its own voice, such as a refused transfer. It rides a synthetic advancement built to show a toast, added and removed in the same call so the client's advancement state is unchanged afterwards, and falls back to local system chat when the toast frame cannot be written.
_Avoid_: local chat, notice toast

**Wire check**:
A strict parse of one clientbound frame that fails on leftover bytes or on a frame name that does not match its state.
_Avoid_: validator, frame linter

## The panel

**Panel**:
The page an operator reads on the tailnet, one card per puppet, served as a second entrypoint of the proxy's image in `monoplayer`. A card says what that puppet is doing now, read from the records the puppet already writes. What the panel may write for it is its control ConfigMap. Each card's live region is `GET /api/puppets/<name>/stream`, which rewrites it without a reload. The card's own facts are also `GET /api/puppets/<name>`, and `GET /api/puppets` is the registry. It holds no session, and `docs/panel.md` holds the route table.
_Avoid_: dashboard, admin, control plane

**Registry**:
The list of puppets the panel may act on, one row per puppet, holding the name, namespace, Deployment, control ConfigMap, the seed ConfigMap it may only read, front hostname, and backend. It is a ConfigMap in Git, and it is the panel's whole permission model: a control ConfigMap it does not name is out of reach.
_Avoid_: puppet list, inventory, fleet. Not _configuration replay_, which this file records as `registry replay`.

**Control ConfigMap**:
The one object the panel may write for a puppet. An operator creates it once and never in Git: RBAC cannot scope `create` by name, and Argo's `selfHeal` would revert a tracked object to its committed content.
_Avoid_: config object, settings map, state store

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
The fixed string `[REDACTED]` that replaces a secret. A report carries the shape beside it as `[REDACTED]<kind>`, such as `[REDACTED]<assignment>` or `[REDACTED]<jwt>`.
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
The check that the state a driver decoded equals the state the attach stream claimed to replay.
_Avoid_: equivalence check, replay diff

**Validation row**:
One named check in a validation plan, such as one backend in a matrix or one fault case. Its label is local to that plan and never names a directory or a symbol.
_Avoid_: gate, milestone, stage

**Verdict**:
The pass or fail result of one scenario, with the evidence that produced it. It is not a UUID decision, which is one attach-whitelist entry's answer to whether a Mojang session can ever authenticate it, and which no scenario produced.
_Avoid_: result, status, report

**Evidence**:
The recorded artifacts a verdict rests on: reports, logs, screenshots, and captured verdict files.
_Avoid_: proof, artifacts

**Fake backend**:
An in-process game server that speaks the real protocol and follows a script, used where a real server would be slow, remote, or uncooperative.
_Avoid_: mock, stub, fake server

**Fake-integration rig**:
The shared test helper (`test/support/harness.js`) that builds a started core on both fake legs, with a clock the test drives and the events the core emits, so a test states only the one thing it changes.
_Avoid_: test harness (that is the driver's), mock core, test bed

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

**Live lane**:
The deployment Argo CD syncs from the `deploy` branch: namespace `monoplayer`, one replica, the puppet account, backend `play2.excalia.fr`.
_Avoid_: production, prod, main lane

**Dev lane**:
The validation lane in namespace `monoplayer-dev`: its own Paper, its own proxy, its own account, and not in Argo CD.
_Avoid_: staging, sandbox, dev environment

**Gate lane**:
The five gate workloads — `paper`, `paper-conduct`, `paper-m4`, `velocity`, `toxiproxy` — and their lifecycle. It rests at 0 replicas between runs: `mise run gate:up` wakes the rows a rung drives, and `mise run gate:down` stops all five. Each worktree has its own lane. Its namespace is the worktree's short commit and a short hash of its path, so two checkouts at one commit are two lanes (#279). The transfer testbed's `paper-hub` and `paper-sky` share a lane's namespace and are not part of it.
_Avoid_: gate cluster, gate-b environment

**Gate Paper**:
The disposable Papers in a gate lane's namespace that the observer, the online rung, the driver lane, and the transfer testbed run against.
_Avoid_: test server, gate-b backend

**Test lane**:
A lane whose job is a test double rather than a product: it may serve clients the product does not authenticate, by composing the offline legs. The live lane is never one.
_Avoid_: offline lane, unauthenticated lane

**Protocol spike**:
The frozen two-leg relay that came before the core. It stays green as a regression check on the wire, and it grows no features.
_Avoid_: legacy proxy, proof of concept

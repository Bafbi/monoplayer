# Testing ladder

The ladder orders checks from cheapest and least realistic to most expensive
and most realistic. Each rung catches a class the cheaper rungs cannot. Add the
cheapest rung that can fail for the defect you are chasing.

## Rungs

| Rung | Command | Cost | Prerequisites | Asserts | Cannot catch |
|---|---|---|---|---|---|
| 0 static | `mise run lint` | under a second | `pnpm install` | every `src/` and `test/` file parses under `node --check` | runtime behavior, protocol shape |
| 1 unit | `mise run test` | a few seconds | `pnpm install` | pure core: cache bounds, session state machine, identity gates, relay decisions, join synthesis, wire-check fixtures, offline identity, auth helpers, and the front leg's status answer over a loopback socket (#200); no auth | socket framing beyond the status handshake, leg wiring, real timers, backend behavior |
| 2 loopback | `mise run loopback` | about 17 seconds | `pnpm install` | real front and backend legs over loopback, the node fake backend, and a real 26.1 protocol bot: attach, cached configuration replay, join order, serverbound relay, detach, reattach, deny, transfer follow (two fake backends, handshake intent 3, cookie round trip), the detach-and-rejoin move with the kept connection off (#22), and the kept connection, which is on by default; no auth | vanilla client acceptance, encryption and `hasJoined`, real Paper semantics, real network timing |
| 2a client parity | `mise run parity:run` | about 5 seconds | `pnpm install` | two protocol bots, one joining the fake backend directly and one through a real Monoplayer, one churn round of block, window, slot, entity, and chat frames, and a report that splits frame and decoded-state differences into same, expected, absent, and unexplained | vanilla client acceptance, a real backend's own frame mix, the Fabric client |
| 2b transfer testbed | `mise run testbed:run` | about 3 minutes | cluster access, Argo app, custody PVC, Bafbi token | handshake intent 3, puppet follow to a second Paper server, the same-connection reconfiguration, and a registry difference (hub 4 vs target 5 `dimension_type` entries) | real client rendering and vanilla acceptance of the reconfiguration; the run takes the live front offline, so the operator starts it |
| 3 online bot | `mise run online` | minutes | a backend this repo deploys, named by `MONOPLAYER_BACKEND_HOST`, and both account custodians | the same shape as rung 2 through the online front leg and a real backend | still not a vanilla client (the bot uses `minecraft-protocol`) |
| 4 real client | `mise run driver:parity`, `mise run driver:scenario`, then `mise run driver:g0` | tens of minutes | Fabric driver build, SSH tunnel, the gate Paper, the dev lane for parity, real client, two accounts | vanilla acceptance, render, movement deltas, break/place against a real server, a real detach/reattach window, and what the client shows joined directly against joined through the proxy. Passed on Velocity + Paper on 2026-11-07; the fault rows are pending. | it is expensive and flaky, so it stays the last rung |

`mise run check` runs rungs 0, 1, and 2: lint, unit tests, and the offline
loopback. It is the default gate.

A live rung needs custody that holds a live token, and it needs no exclusive
session: several clients may play one account at once, and only a refresh from a
second copy, or a login to the same server, disturbs anything
([custody](custody.md#sessions-copies-and-refresh)). `mise run online:cluster`
therefore runs the online rung from a throwaway pod that copies the puppet's
custody into its own directory, so the deployment keeps serving.

The frozen protocol spike (`mise run spike`) and the spike scenario
(`mise run spike:report`) sit beside the ladder. They prove the two-leg relay on
loopback with the older harness. Keep them green; do not extend them.

## Which lane a run uses

Every run has a lane, a cost, and a blast radius. The lane decides what a run
may change. The rung decides what it proves.

| Run | Command | Lane | Cost | What it may change |
|---|---|---|---|---|
| rungs 0-2 | `mise run check` | none: this machine | seconds | nothing outside the working copy |
| client-parity rung, 2a | `mise run parity:run` | none: this machine, two bots and a fake backend | about 5 seconds | nothing outside the working copy |
| observer, the server's view | `mise run observer:run` | `paper-conduct` in `monoplayer-gate-b`, the gate-serving sibling of the gate Paper, plus throwaway pods in `monoplayer` that mount the live claim read-only | minutes, and up to 10 minutes when the gate Paper's restart is slow: the container took 240 s to 310 s to come back on the gate Paper, 26.2 build 135, and 40 s from a freshly created pod; paper-conduct has not been timed on its own | installs the plugin into `paper-conduct` and restarts it, and runs two joins from pods in the live namespace. It refuses to measure the live lane itself. A restart that outlasts the start budget is reported as a start that did not finish, and the joins never run. The budget is `MONOPLAYER_OBSERVER_START_TIMEOUT`; `scripts/observer-report.sh` holds its default |
| online rung, from a pod | `mise run online:cluster` (the gate lane must be awake: `mise run gate:up`) | namespace `monoplayer`, in a throwaway pod that mounts the live claim read-only, against the gate Paper | minutes | nothing on the deployment: it refuses an expired token instead of rotating. `--rotate` is the exception and a human decision: it writes the refreshed chain into the live custody and asks for a live restart |
| online rung, bare | `mise run online` | this machine's copy of the account chain, and whatever `MONOPLAYER_BACKEND_HOST` names | minutes | the token chain: a refresh here invalidates the copy the deployment holds, and a join to the live server kicks the live session. `mise run online:cluster` is the form that leaves the deployment serving |
| the gate lane itself | `mise run gate:up`, `mise run gate:down` | `monoplayer-gate-b`, which is not in Argo CD | `up` waits up to 900 s and says so first; a cold start is 90 s | every gate workload's replica count. It applies the tree and scales; it deletes nothing, so the Secrets and the objects stay. The `emptyDir` worlds go with their pods |
| driver lane, rung 4 | `mise run driver:scenario` | the gate Paper, on its Tailscale host, and the display host | tens of minutes | the gate Paper's world and a real client. The deployment keeps serving |
| driver parity, rung 4 | `mise run driver:parity` | the dev lane, through the operator's port-forwards and reverse tunnel, and the display host | minutes | a join and a client launch as the attach account: it moves that account's player in the dev world, and nothing in `monoplayer`. It refuses the live fleet, the live front in front of it, and a `playit.gg` tunnel to that front |
| transfer testbed, rung 2b | `mise run testbed:run` | the live custody claim and the gate Paper | about 3 minutes | **the live front goes offline for the run**: it scales `monoplayer/monoplayer` to 0 and disables Argo auto-sync. `mise run testbed:down` restores the deployment, and the sync policy while the run's restore record at `/tmp/opencode/monoplayer-testbed.json` survives. It also deletes the testbed's front Service, which is what unpublishes `monoplayer-testbed.tail41e568.ts.net` |
| dev lane | `mise run dev:up`, then `mise run dev:image`, then `mise run dev:join` | `monoplayer-dev` | minutes | its own Paper, proxy, and account; nothing in `monoplayer` |

Two rows above can change what the live lane serves without a flag: the transfer
testbed takes the live front offline, and a bare `mise run online` can refresh the
chain the deployment holds. A third, `mise run online:cluster --rotate`, writes
that chain and needs a restart. An agent never runs `testbed:up` or `testbed:run`,
and never passes `--rotate`. `mise run online:cluster` is the form to prefer, and
the bare rung stays available because `verify:custody` composes it. `AGENTS.md`
states the rule. `deploy/dev/README.md` is the dev lane runbook.

The gate lane sleeps: its five Deployments commit `replicas: 0`, so an apply wakes
nothing — and stops whatever was awake, since it reconciles every row to the tree.
A run that needs `paper` or `paper-conduct` finds an empty namespace until
`mise run gate:up` runs. `gate:up` wakes the two rows a rung drives and names
the M4 rows only when told to; `gate:down` puts the lane back and waits for the pods
to go, because a lane left up costs 6,214 MiB until someone notices. That is what
`mise run gate:status` is for.

The table covers the runs that leave this machine. `driver:g0` composes rung 4's
two commands, the `testbed:*` tasks run inside the testbed's lane, and
`dev:prove-live` wraps whichever command you give it. `image:build` publishes to
the Zot registry that the manifests do not reference. `image:build:no-push`
builds the same image and publishes nothing.

The lane is a second table on purpose. `src/ladder/next-rung.js` reads the rungs
table above as exactly six cells, so a seventh column would leave every failing
rung without a hint.

## Pick the task for the area you touched

Four tasks compose the gate and the check that covers their area through
`depends`, so a rung command has one definition. Three of them add a task the
table above does not list: `spike` sits beside the ladder, `driver:build`
builds rung 4's driver, and `image:build:no-push` builds the deployment. Run
the task that covers the area you changed.

| Task | Composes | Run it after touching |
|---|---|---|
| `mise run verify:relay` | `check`, `spike`, `parity:run` | the relay, the legs, the join, the state cache, `src/core/clientbound-policy.js` |
| `mise run verify:custody` | `check`, `online` (a repo-deployed backend, both custodians, this machine's copy of the chain) | `src/custody/`, the custody store, `hasJoined`, offline identity |
| `mise run verify:driver` | `check`, `driver:build`, `driver:scenario` (SSH tunnel, the gate Paper) | `tools/driver/`, `src/driver/` |
| `mise run verify:deploy` | `check`, `image:build:no-push` (publishes nothing; `mise run image:build` is the publish path) | `Dockerfile`, `deploy/` |

`verify:driver` does not compose `driver:parity`. The parity lane needs a target
the operator stands up first, the dev lane through two port-forwards and a
reverse SSH tunnel, and two more client launches. Run it by name; the driver
parity section below covers what it answers.

mise runs sibling `depends` concurrently, so the area task does not order them.
The expensive rung carries `wait_for = ["check"]` instead: a red gate stops it
before it starts, and a bare `mise run online` still runs alone, because
`wait_for` schedules nothing. `driver:scenario` also waits for
`driver:build`.

Run one verify task at a time. The online rung holds the puppet's writer lock
for its whole run, and two runs contend for the same two accounts. Run
`mise run image:build` from a clean checkout: it tags the working tree with
HEAD's `sha-<7>`, so uncommitted bytes would carry a commit's name.

`mise run check` stays the offline gate, unchanged: it runs rungs 0, 1, and 2,
and CI runs it.

## A failed rung names the next one

Each rung task prints, on failure, the next rung to run, the class that rung
catches, and what it needs. Rung 4 has nothing above it, so `mise run driver:g0`
says that instead. `mise run test` failing prints:

```
mise run test failed (rung 1, unit).
Next rung: mise run loopback (rung 2, loopback) — about 17 seconds
  catches: real front and backend legs over loopback, the node fake backend, and a real 26.1 protocol bot: attach, cached configuration replay, join order, serverbound relay, detach, reattach, deny, transfer follow (two fake backends, handshake intent 3, cookie round trip), the detach-and-rejoin move with the kept connection off (#22), and the kept connection, which is on by default; no auth
  needs: pnpm install
```

`src/ladder/next-rung.js` reads those sentences from the rungs table above, so
editing the table edits the failure output. `test/tooling/mise-tasks.test.js` fails when
a rung task stops printing the hint.

A rung that exits 2 (its setup failed before the run) or that is interrupted
prints no hint. A rung above cannot catch a missing prerequisite.

## Production topology rule

Only two checks run on the production topology, Velocity + Paper (ultimately
`play.excalia.fr`). The gate namespace reproduces that topology, and the live
deployment is `monoplayer`. The two checks are:

- the Fabric driver lane, in its M4 row, which goes through the Velocity in front
  of the gate Paper, and
- the unmodded vanilla client.

G0 is the exception below it: `mise run driver:g0` joins the gate Paper directly,
because the scenario pins its backend as "direct Paper 26.2 (M2 row);
Monoplayer and Velocity are not involved in G0" (`src/driver/scenario.js`).

Everything else — reconnect, the F1-F6 faults, identity separation, denial,
and replay — is validated first offline (loopback, fake backend, Toxiproxy) and
then with online bots through the real front. There is no separate Vanilla
backend-parity row: Paper behind Velocity is the only backend target.

## The loopback rung

```bash
mise run loopback
# or directly, with a custom report path
node src/ladder/loopback.js --report /tmp/opencode/loopback-report.json
node src/ladder/loopback.js --verbose
```

Exit codes: `0` all assertions pass, `1` an assertion or timeout failed, `2`
the setup before the run failed (fake backend, config, or leg construction). The runner writes `.reports/loopback-report.json`
(gitignored) in `finally`, including on failure. The report holds assertion
results and metadata only. It never holds frame bytes, `.secrets` paths, or
token fields.

The runner builds:

- the node fake backend on an ephemeral port;
- `createOfflineBackendLeg` (offline auth, no token custody) connected to it;
- `createOfflineFrontLeg` with the offline UUIDs of `Attach` and `Second`
  whitelisted and the puppet `GlowSquidye` deliberately not whitelisted;
- the product core, with the front leg replaying the cached configuration;
- real protocol bots for the attaching players.

### Loopback assertion contract

`R0` is the readiness precondition. The numbered checks fail the run.

- `R0` readiness is warm from `chunk_batch_finished` (never `forceWarm`).
- `O1` the first attach is allowed once, no denials, and the front leg is
  `offline-front-leg` with no `.secrets` whitelist store.
- `O2` the fake backend saw one login and `core.session.backendLogins` is 1.
- `O3` no `encryption_begin`, `compress`, or `success` frame was replayed into
  play, and the core counted at least two ignored non-play frames.
- `O4` `front.lastConfigMode` is `cached_replay`.
- `O5` the first six play frames are `login`, `game_state_change`, `position`,
  `chunk_batch_start`, `map_chunk`, `chunk_batch_finished`. A second
  `game_state_change` is allowed only after `map_chunk`.
- `O6` login `entityId` is 42, the first position is `0.5/1.62/0.5`, and the
  first chunk is `0,0`.
- `O7` no `spawn_entity` appears in the replay.
- `O8` the wire checker inspected at least five frames, including both
  configuration and play frames, and rejected none.
- `O9` the first bot recorded no leftover bytes and no client errors.
- `O10` exactly one position, one dig, and one place reached the fake backend,
  and the core forwarded at least three serverbound frames.
- `O11` sentinel `teleport_confirm`, `chunk_batch_received`, and `keep_alive`
  frames reach the core and are dropped there (`serverboundDropped` rises by
  three) and never reach the backend: the legs and the core own them.
- `O12` after detach the core is detached, keeps one backend login, records no
  fault, and retains the last pose (`2.5/1.62/2.5`).
- `O11b` a non-whitelisted bot is denied before play: no login success, no play
  frames, no client error, one front denial, and an `attachDenied` log with
  reason `not_whitelisted`. The check runs with the attach slot free; while a client
  is attached, the earlier second-attach guard answers `already_attached`.
- `O13` the second attach makes `core.metrics.attaches` 2, keeps
  `backendLogins` at 1, lands the first synthesized position at the last pose
  (`2.5/2.5`), and replays the block edit at `3,0,3` cached while detached.
- `O14` the second bot recorded no leftover bytes and the front wire checker
  still rejected nothing.
- `O36` a bundle of two `entity_equipment` frames — two and three entries —
  reaches an attached client with every entry decoded and no leftover bytes. The
  frame's array type carries its terminator flag in the high bit of each slot
  byte, so this is where a relay that writes bytes a decoder has rewritten shows
  up (#82).
- `O37` a bundle cached while nobody is attached replays the same way: both
  frames decode with every entry, no leftover bytes, and the front wire checker
  rejected nothing.
- `O15` one backend fault produces one reconnect: two backend logins and no
  loop.
- `O16` the attach after the reconnect replays the join prefix and a chunk.
- `O17` the replay sends the window 0 base before every later `set_slot`.
- `O18` the first bot applied both slot updates and no stale slot from the
  join frame.
- `O19` the detached block edit is replayed and the last pose is the
  post-mutation pose.
- `O20` a reattach replays the mutated inventory, not the join snapshot.
- `O21` with `transfer.keepConnection` off, a transfer never reaches the
  client and detaches it with the moving reason.
- `O22` the puppet follows the target and re-warms there (kept connection
  off).
- `O23` a fresh attach after a move with the kept connection off replays the
  target server state.
- `O24` the puppet leg answers a stored cookie request.
- `O33` with `transfer.keepConnection` on, which is the default, a followed
  transfer never reaches the client and the client keeps its connection: no kick, the proxy's own
  `start_configuration` first, one acknowledged configuration round, the
  target's configuration after that round started, and no front client error.
- `O34` the kept connection goes through the target's configuration (including
  its `finish_configuration`) and its play login, and the session is `attached`.
- `O35` the client that followed the move is in the target server state: it
  receives the target's block change, keeps the one attach (no rejoin), and
  records no leftover bytes or errors.
- `O38` the transfer intent starts the client's configuration round before the
  target is reached: one round counted, the client in configuration, the
  session `transferring`, and the cold target has accepted no login yet (#87).
- `O39` a dial the target refuses before its first frame leaves the move in
  flight: the move is still a transfer, the client is still in its round, and
  nothing was restored (#87).
- `O40` the follow budget's give-up restores the previous server's state on the
  connection the client kept: the snapshot's configuration and finish stream
  into the open round, the previous play login replays, no kick, and no front
  client error (#87).
- `O41` a target that sends no chunk frame never releases the client: the move
  stays open with the client in play (#87).
- `O41b` the held release is the chunk gate, not a stalled client: the wait is
  recorded as `reconfigurationWaitingWorld` on a cache holding zero chunk frames
  (#87).
- `O42` an error on the attaching client's connection ends it with a reason and
  not with a serialization failure: the client reads `front_error: <message>`
  from its kick, and no `Serialization error` line is logged (#87).

The kept-connection rig runs `O38`-`O41b` before its happy path because
`mise run testbed:run` cannot produce any of them: its transfer succeeds on the
first dial and its target warms in five seconds.

- `O24b` a proxy notice reaches the client complete as a toast and leaves no
  advancement behind: an invalid-target refusal sends two `advancements`
  frames, the bot decodes both, the first carries a `monoplayer:notice/` id with
  `show_toast` set, `showAdvancements` true, and every requirement group met by
  its completed criterion, the second removes that id with `reset` false, and
  the bot's advancement state is empty afterwards (#15). Emptying the frame's
  `requirements` fails the check.
- `O25` the puppet announced `minecraft:brand` = `fabric` once per backend
  connection: the count of brand frames equals the fake backend's login count,
  on the hub and on the transfer target.
- `O26` the fake backend recorded the human's Client Information with the
  backend's view distance: `locale fr_fr`, `skinParts 96`, `mainHand 0`, and
  `viewDistance` equal to the login's advertised cap, even though that bot
  asked for `2`. Every Client Information frame on that backend carries the
  cap.

- `O27` the N13 frame cut is aligned on a real client: the first-attach replay's
  parity frame names equal the first K parity frames the bot decoded, in order.
  N13 on the online rung compares one side of that cut, so a misaligned cut would
  fail a correct cache.
- `O28` the replay lands a moved entity where the backend put it. The fake
  spawns entity 99 at x=0, moves it three blocks with delta frames, then corrects
  it to x=10. The bot must decode x=10; a replay that puts every absolute before
  every delta lands at 13.

- `O29` the human's chat is spoken by the puppet leg, not forwarded. The bot
  sends a chat message and a command the way a client does, with its own
  signature state. The fake backend must record both texts from the puppet's
  connection while the core's forwarded-frame count does not move (#19).
- `O45` in `commands` mode the human's command is spoken by the puppet leg
  and their chat message is dropped (#97). The main rig runs `full` for `O29`
  and its client is ended by O29's own acknowledgement, so this check has a rig
  of its own: its own fake backend, its own puppet leg, its own core in
  `commands`, and a bot that sends no acknowledgement. That backend records the
  command's text from the puppet's connection and no chat message, `chatSent`
  is 1, `chatBlocked` is 1, and the core's forwarded-frame count does not move.
- `O30` a dialog sent while nobody is attached is held (`controlDialogsHeld`
  1) and re-sent to the reattaching client (`controlDialogsResent` 1, one
  `show_dialog` decoded by the second bot, a `controlDialogResent` log line).
  The backend leg runs `MONOPLAYER_DIALOG_ACTION=last`, and it must log
  `dialogUnhandled` with `play_dialog_waits`: the wait, not a click attempt.
  The fake backend also records no `custom_click_action` before the bot
  answers (#20).
- `O31` the client's answer reaches the backend as the puppet's dialog click:
  one `custom_click_action` with the dialog's id on the fake backend,
  `controlDialogsAnswered` 1, and nothing left pending.
- `O32` a configuration gate is answered by the puppet while nobody is attached,
  and never becomes the next client's question (#21). The first fake backend runs
  with the code of conduct enabled, so it sends `code_of_conduct` in the
  configuration phase and withholds `finish_configuration` until the accept
  arrives. It counts one gate and one accept, the leg logs
  `codeOfConductAccepted` and not `codeOfConductHeld`, nothing is held, the
  router counts one puppet answer, and the one resend `O30` sees is the play
  dialog.
- `O46` a pack sent while a client is attached is the human's answer
  (#98). The fake backend sends one play-state `add_resource_pack` with
  `forced` set. The first bot decodes it, the backend records no status before
  the bot answers, and the three statuses the bot sends (accepted 3, downloaded
  4, successfully loaded 0) are the ones the backend records, with the pack's
  UUID, `resourcePackAcks` 0, and `resourcePacksAnswered` 3.
- `O47` a pack sent while nobody is attached is accepted by the puppet, held,
  and delivered to the next client (#98). The backend records accepted then
  loaded from the puppet's connection while the lane is headless. The
  reattaching client receives the held `add_resource_pack` from the holder, not
  from the state cache, and the three statuses it sends reach the backend after
  the puppet's two. It receives O46's pack as well, in send order, because a
  pack stays installed on the puppet's connection until the server withdraws it:
  `resourcePacksResent` 2, `resourcePackAcks` 1.
- `O43` a configuration gate the last client left is answered as the puppet
  (#73). A third fake backend runs with the code of conduct enabled and is the
  target of a second followed transfer on the kept connection, so the gate
  arrives while the client is attached: the leg logs `codeOfConductHeld`, the
  core holds the gate, and the client then closes without answering. The leg
  logs `codeOfConductAccepted` and the core `controlDialogAnsweredOnDetach`
  (`controlDialogsAnsweredOnDetach` 1), nothing is left pending, and the puppet
  warms on that backend: it withholds `finish_configuration` until the accept
  arrives, so its own accept is the only way it reaches play. One bot option
  makes this observable: the protocol library accepts the code of conduct on its
  own, so the bot is told not to answer, the way a player who left the screen
  would.
- `O44` a play dialog the last client left stays held (#20). A play dialog is
  sent while a client is attached, the client closes with it unanswered, and the
  next client receives it again: nothing pending is dropped, the backend records
  no `custom_click_action`, `controlDialogsAnsweredOnDetach` does not move, the
  leg logs `dialogUnhandled` with `play_dialog_waits`, the play dialog stays
  pending, and one resend lands. This
  is the behaviour that must not change, so the assertion is a guard: it holds
  without #73 too, and it fails if the detach rule ever widens to play dialogs.

- `O48` the pre-auth window's total cap holds on a real socket (#201). A
  rig of its own, because the assertion needs a window of one. A socket that
  says nothing holds the only slot, so a real bot connecting over the cap
  receives no frame at all: no login success, no configuration, no play. The
  front leg counts one refusal (`preAuthRefused` 1), records no whitelist
  denial (`denied` 0), logs exactly one `preAuthRefused` line with reason
  `preauth_connection_cap`, and never reviews the refused login
  (`frontLoginReview`). The idle socket then leaves, and the next client is
  admitted and allowed: the window is 0 once the whitelist accepts it, so a
  connection past the window holds no slot, and one more socket fits beside it.
  The main rig's own front leg runs on the default cap, so the check also
  states that the default refused nothing on this rung (`defaultCapRefused`
  0).
- `O49` the pre-auth window's deadline takes a silent socket's slot back
  (#205). The cap bounds how many sockets sit in the window and nothing bounded
  how long one stayed, so a stranger could hold the window closed by doing
  nothing. The rig is O48's with a deadline of 1000 ms instead of a cap of one.
  A socket that says nothing is destroyed by the leg, the slot returns to 0, the
  leg counts one expiry (`preAuthExpired` 1), and it logs exactly one
  `preAuthExpired` line with reason `preauth_deadline` and the deadline in it.
  A stranger whose UUID is not on the list is then refused, and counts as a
  refusal rather than an expiry: the denial is that connection's decision, so its
  deadline is disarmed and the expiry line stays the silent socket's alone
  (`refused` 1, `expiryLinesTotal` 1). A peer that ignored the disconnect and
  held its socket open is not in this rung. A whitelisted client attaches on the same rig and stays connected past the
  deadline: the window ended at the whitelist's accept, so the timer was disarmed
  there and a slow but real login is never cut by a bound it already met
  (`survivedPastDeadline` true, `expiredAfterAccept` 1). The main rig's front
  leg runs on the default deadline and expires nothing (`defaultExpired` 0).
- `O50` an attach says what its attach stream contained, and a metadata frame
  with no spawn to send is visible in it (#218). A report said a player could not
  see another player after attaching. The state cache's entity domain keeps a
  bounded window, so a body that spawned earlier has no `spawn_entity` left to
  send, while `player_info` is a keyed domain and behaves. Until this record,
  nothing said what an attach stream carried, so that prediction could not be
  checked against production. The rig is its own, and the smallest one that
  attaches twice: a fake backend, a front leg, a core, and two clients behind one
  body. The core writes one `attach` record per attach, and the check reads the
  record the product wrote rather than one rebuilt from the same snapshot. The
  ordinary attach reports `entities.withoutSpawn` 0 with its body counted in
  `entities.replayed`. One `entity_metadata` for an id nothing spawned then
  enters the state cache, written through the fake's own server because the cache
  cannot tell it apart from a window that evicted the spawn. The next attach
  reports `entities.withoutSpawn` 1, the same body count, and one more entity
  frame in `domains.entities`. Every field the record calls a count is an
  integer, and `domains` adds up to `replayed`, the number the attach stream
  wrote on that snapshot.


## The client parity rung

`mise run parity:run` answers one question: what does a client that joined a
server directly see, that a client behind the proxy does not.

It runs two protocol bots, records every clientbound `{state, name}` on each,
decodes both play streams through `src/ladder/client-state.js`, and writes
`.reports/client-parity-report.json`. The six decoded domains are compared by
`compareSnapshots` in `src/ladder/state-parity.js`, the same comparator the
attach replay check uses.

Every frame kind either side saw becomes one row, with four verdicts. The
policy table is the code under test, so it never decides a verdict on its own.
It says which clients should see a frame, and the two clients say which ones did.
A row that contradicts its prediction is a finding, in either direction.

| Decision | Predicted sides | A row that contradicts it |
|---|---|---|
| `state` | both, and the proxied side is a superset because the cache can hold earlier state | the direct client saw it and the proxied one did not: the relay lost it |
| `cache_only` | both, one live and one replayed | either client without a login |
| `per_leg` | both, each from its own leg | either client without one |
| `live_only` | both, when the traffic happened in both runs | either client without it, on a deterministic lane |
| `control` | both, the frame relayed to whoever answers it | either client without it, on a deterministic lane |
| `block` | the direct client only | the proxied client saw it, which is a frame that crossed when it must not |
| `kick_disconnect` | both | the proxied client never received the kick as a frame |

The four verdicts:

- `same`: the observation matches the prediction on both sides, and the counts
  agree where they have to. On a lane that is not deterministic a count
  difference is timing, and the row says so without changing the verdict.
- `expected`: an observation the prediction allows. A `block` frame only the
  direct client saw, state the attach replay inserted, live-only traffic one run
  missed. The row names what was predicted and what was seen.
- `absent`: a capability that #19, #21, or #22 owns has not landed yet. The
  row names the issue and never fails the run. Today `play:player_chat` records
  the #19 gap with evidence: the direct client gets the signed chat and the
  proxied client does not, because the shipping chat mode is `read-only`.
- `unexplained`: the observation contradicts the prediction. This is the only
  verdict that fails the run, and it exits 1.

Two decoded domains are predicted to differ between two connections: `pose`,
which the attach replay takes from the puppeted session, and `entities`, whose
ids belong to a connection. The other four must match, and they fail the run
when they do not.

A count is a finding only where it can be. The offline lane is deterministic, so
a count difference there is a frame lost or repeated. A real server's counts
drift with time, so a count there stays evidence. The report's first line names
the lane and which rule applied.

### The two lanes

Without arguments the task runs the offline lane: the repo's own fake backend
(`src/legs/fake-backend.js`) plus an in-process Monoplayer with the offline legs.
Both clients attach at once, then one churn round sends a block change, a full
window, one slot, an entity spawn and a move, server chat, and signed player
chat. Every churn frame reaches each client by its own path, so the report
measures the relay rather than the cache. No auth, no cluster, no `.secrets`.

With `--backend HOST:PORT` and `--front HOST:PORT` it runs the endpoint lane: the
two joins and nothing else, against a server and a proxy an operator stood up.
Both endpoints are required. The harness never builds a proxy with live legs, so
it never holds the puppet's custody and cannot disturb the live deployment. The
two joins run one after the other, because a server kicks the first session when
one account opens two.

The harness never joins the live Excalia fleet. Any `*.excalia.fr` host exits 2
before a socket opens, so a mistyped endpoint cannot measure a server this repo
does not own.

The version is the target's, not the rung's. The fake lane serves 26.1 and
refuses anything else. The dev lane, the testbed, and the gate Paper serve 26.2,
which is the rung's default, so the usual run needs no flag. Point it at a 26.1
target with `--version 26.1`, or `MONOPLAYER_VERSION=26.1`, which
`scripts/online-cluster.sh` forwards into the pod. `mise run observer:run`
needs no flag either: it reads the gate Paper's version from
`deploy/driver/paper.yaml` and passes it to both of its joins.

Three pairs this repo deploys, and where each stands:

| Target | `--backend` | `--front` | Version | Stands? |
|---|---|---|---|---|
| the offline lane | the fake backend | the rung's own Monoplayer | 26.1 | yes, `mise run parity:run` |
| the dev lane | `paper.monoplayer-dev.svc.cluster.local:25565` | `monoplayer.monoplayer-dev.svc.cluster.local:25565` | 26.2 | wired, needs `dev:up`, its whitelist, and #44's account |
| the transfer testbed | `paper-hub.monoplayer-gate-b.svc.cluster.local:25565` | `monoplayer-testbed.monoplayer.svc.cluster.local:25565` | 26.2 | wired, needs `testbed:up` |
| the gate Paper | `paper.monoplayer-gate-b.svc.cluster.local:25565` | nothing is deployed | 26.2 | **unmet**: no proxy serves in front of it |

The dev lane is the pair to run first. `mise run dev:join` is not the command
that runs this rung: it reports the dev proxy's own account on the dev Paper and
takes no arguments. Running the harness against the dev lane needs the attach
account's custody and a route to both services, and that recipe is still open in
[#13](https://github.com/Bafbi/monoplayer/issues/13).

The front leg is the dev lane's own Monoplayer, so the proxy under test is the
branch image. Two things must already be true: the dev lane is up (`mise run
dev:up`), and its attach whitelist names the attach account. The lane's own
account is `devpuppet`, bootstrapped by `mise run dev:custody`
([the runbook](../deploy/dev/README.md#the-first-run)).

The gate Paper has no row it can meet. A proxy in front of it needs the puppet's
custody, and the harness will not build one, because that is the live custody the
deployment owns. The dev lane is the deployed proxy that exists, and the endpoint
lane's refusal tests cover the rest.

The report is metadata only: no frame bytes, no `.secrets` paths, no tokens.

### Online rung assertion contract

`mise run online` returns N1-N13. `evaluateOnlineAssertions` in
`src/ladder/online.js` is the source; the id list and the claim behind each id
live there.
- `N13` the state the attaching client decoded matches the state the attach
  replay claimed. The expectation is the cache snapshot taken when the replay was
  built, compared with the first K frames the client decoded, where K is the
  number of parity frames that replay sent. Live frames after them are ignored on
  both sides. N13 fails when those K frames never arrive (30 s bound), when the
  decoded names differ from the replay's names in order, or when any compared
  domain differs. The loopback's O27 checks the same cut on a real protocol bot.

## The driver parity lane

`mise run driver:parity` answers the client half of rung 2a's question: not which
frames reached a bot, but what the real client ended up showing. It joins the
backend directly with the Fabric driver client, quits, relaunches joined through
the proxy, and compares the two clients' state field by field.

The two runs are sequential because a server kicks the first session when one
account opens two, and the driver has no reconnect op. Every lane is a quit plus
a host-side relaunch, the same rule the G0 scenario follows.

The report is `.reports/driver-parity-report.json`. Every field is `same`,
`expected`, or `unexplained`, and only `unexplained` fails the run. The field
policy lives in `src/driver/parity.js` and a unit test pins it to the observed
fields, so a new status field cannot pass unclassified.

| Field | Verdict when the two clients differ | Why |
|---|---|---|
| `connected`, `level`, `player`, `name`, `health`, `dimension`, `screen` | `unexplained` | the proxy does not reshape them |
| `pos` | `expected` | the attach replay lands the client at the puppeted session's pose |
| `held`, `selectedSlot` | `expected` | the replay serves the puppeted session's inventory |
| `loadedChunks`, `renderedSections` | `expected` | the attach replay serves the puppeted session's chunk set; a direct join streams its own |

A dialog or transfer screen has no `expected` row. A screen that is up when the
lane looks means the client never settled, so the lane exits 2 with the screen's
own title and reason in the report; a screen that appears between the last settle
poll and the read is an `unexplained` `screen` row and exits 1. Either way the
lane is red, because for the human's client that screen is the symptom #20 and #22
describe.

The lane compares two fresh joins and applies no churn, so state a backend sends
only on change can only agree by default. Agreement here is evidence that the
join landed, not that the relay carries later state: rung 2a sends the churn.

Exit codes match rung 2a: 0 every difference explained, 1 an unexplained
difference, 2 a setup that never joined. The report is written on 0 and 1,
because a red report is the finding.

No packet observer is used. `tools/driver/README.md` bans mixins into
`Connection`, login and play handlers, codecs, and Netty, and #62 allows an
observer only if a run with it off produces the same verdict. Frame rows stay
rung 2a's job, and the report records `observer: "none"` so the choice is a fact
in the artifact.

[The driver-lane runbook](driver-lane.md) has the reachability recipe for the dev
lane and the transfer testbed.

## Why the rungs exist: the B1 lesson

The first live B1 attach failed because login-phase frames
(`encryption_begin`, `compress`, `success`) had been captured into the play
join prefix. The official client rejected the replay with `add_entity ... 114
bytes extra`. That is the failure class the wire checker now covers: it parses
one clientbound frame in its declared state and fails on leftover bytes or a
packet name that does not match the state. Rung 2 keeps that check on every
raw replayed or relayed frame. The live path (`--start`) runs the same check
in warn mode: it logs and counts `front.wireStats` without kicking a player.

The checker is not a vanilla oracle. `minecraft-protocol` accepts frames a
vanilla client rejects, and it is lenient about some state transitions. Only
rung 4, the official client, proves that vanilla accepts the replay. Do not
promote a loopback pass to a product claim without that rung.

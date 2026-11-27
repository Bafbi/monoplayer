# Testing ladder

The ladder orders checks from cheapest and least realistic to most expensive
and most realistic. Each rung catches a class the cheaper rungs cannot. Add the
cheapest rung that can fail for the defect you are chasing.

## Rungs

| Rung | Command | Cost | Prerequisites | Asserts | Cannot catch |
|---|---|---|---|---|---|
| 0 static | `mise run lint` | under a minute | `pnpm install` | every `src/`, `test/` and `tools/` file parses under `node --check` and resolves: a read of a name no scope declares fails `eslint`'s `no-undef` (#540) | runtime behavior, protocol shape |
| 1 unit | `mise run test` | a few seconds | `pnpm install` | pure core: cache bounds, session state machine, identity gates, relay decisions, join synthesis, wire-check fixtures, offline identity, auth helpers, and the front leg's status answer over a loopback socket (#200); no auth | socket framing beyond the status handshake, leg wiring, real timers, backend behavior |
| 2 loopback | `mise run loopback` | about 55 seconds | `pnpm install` | real front and backend legs over loopback, the node fake backend, and a real 26.1 protocol bot: attach, cached configuration replay, join order, serverbound relay, detach, reattach, deny, transfer follow (two fake backends, handshake intent 3, cookie round trip), the detach-and-rejoin move with the kept connection off (#22), the kept connection, which is on by default (#22), and a 26.2 rig with no backend at all that reads the recorded configuration baseline, answers the picker, opens the chosen server's own dialog, answers it, and lands a claiming client in the body it named (#257, #266, #258); no auth | vanilla client acceptance, encryption and `hasJoined`, real Paper semantics, real network timing |
| 2a client parity | `mise run parity:run` | about 5 seconds | `pnpm install` | two protocol bots, one joining the fake backend directly and one through a real Monoplayer, one churn round of block, window, slot, entity, and chat frames, and a report that splits frame and decoded-state differences into same, expected, absent, and unexplained | vanilla client acceptance, a real backend's own frame mix, the Fabric client |
| 2b transfer testbed | `mise run testbed:run` | about 3 minutes | cluster access, Argo app, custody PVC, Bafbi token | handshake intent 3, puppet follow to a second Paper server, the same-connection reconfiguration, and a registry difference (hub 4 vs target 5 `dimension_type` entries) | real client rendering and vanilla acceptance of the reconfiguration; the run takes the live front offline, so the operator starts it |
| 3 online bot | `mise run online` | minutes | a backend this repo deploys, named by `MONOPLAYER_BACKEND_HOST`, both account custodians, and cluster access for the account lease | the same shape as rung 2 through the online front leg and a real backend | still not a vanilla client (the bot uses `minecraft-protocol`) |
| 4 real client | `mise run driver:parity`, `mise run driver:scenario`, then `mise run driver:g0` | tens of minutes | Fabric driver build, SSH tunnel, the gate Paper, the dev lane for parity, real client, two accounts | vanilla acceptance, render, movement deltas, break/place against a real server, a real detach/reattach window, and what the client shows joined directly against joined through the proxy. Passed on Velocity + Paper on 2026-11-07; the fault rows are pending. | it is expensive and flaky, so it stays the last rung |

`mise run check` runs rungs 0, 1, and 2: lint, unit tests, and the offline
loopback. It is the default gate. It runs all three to their end, so a red gate
names every rung that failed (#215).

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

| Run | Command | Lane | Cost | What it may change | Beside another agent? |
|---|---|---|---|---|---|
| rungs 0, 1, 2 | `mise run check` | none: this machine | seconds | nothing outside the working copy | yes, except while another row adds a loopback assertion |
| client-parity rung, 2a | `mise run parity:run` | none: this machine, two bots and a fake backend | about 5 seconds | nothing outside the working copy | yes, in the offline form |
| observer, the server's view | `mise run observer:run` | `paper-conduct`, the gate-serving sibling of the gate Paper, in this worktree's lane (`scripts/gate-lane.sh name`; `MONOPLAYER_GATE_NAMESPACE` or `--namespace` names another), plus throwaway pods in `monoplayer` that mount the live claim read-only | minutes, and up to 10 minutes when the gate Paper's restart is slow: the container took 240 s to 310 s to come back on the gate Paper, 26.2 build 135, and 40 s from a freshly created pod; paper-conduct has not been timed on its own | installs the plugin into `paper-conduct` and restarts it, and runs two joins from pods in the live namespace. It refuses to measure the live lane itself. A restart that outlasts the start budget is reported as a start that did not finish, and the joins never run. The budget is `MONOPLAYER_OBSERVER_START_TIMEOUT`; `scripts/observer-report.sh` holds its default | no, each of its two joins takes the account lease |
| online rung, 3, from a pod | `mise run online:cluster` (the gate lane must be awake: `mise run gate:up`, and the run names this worktree's lane in its lease and in the Paper it dials) | namespace `monoplayer`, in a throwaway pod that mounts the live claim read-only, against the gate Paper | minutes | nothing on the deployment: it refuses an expired token instead of rotating. `--rotate` is the exception and a human decision: it writes the refreshed chain into the live custody and asks for a live restart. It takes the account lease first, which is one `Lease` object named `monoplayer-online-account` in `monoplayer`: a Lease is not a workload, so no scale, patch or restart is involved | no, it takes the account lease |
| online rung, 3, bare | `mise run online` | this machine's copy of the account chain, and whatever `MONOPLAYER_BACKEND_HOST` names | minutes | the token chain: a refresh here invalidates the copy the deployment holds, and a join to the live server kicks the live session. `mise run online:cluster` is the form that leaves the deployment serving. It holds the same account lease, so it needs `kubectl` and cluster access even though the rung itself runs here | no, it takes the account lease |
| the gate lane itself | `mise run gate:up`, `mise run gate:down` | `monoplayer-gate-<instance>`, this worktree's lane, which is not in Argo CD | `up` waits up to 900 s and says so first; a cold start is 90 s | every gate workload's replica count. It applies the tree and scales; it deletes nothing, so the Secrets and the objects stay. The `emptyDir` worlds go with their pods | one lane per worktree, and no two runs inside one |
| driver lane, rung 4 | `mise run driver:scenario` | the gate Paper of this worktree's lane, on its Tailscale host, and the display host | tens of minutes | the gate Paper's world and a real client. The deployment keeps serving | no, the display host carries one client, and both rungs use one account |
| driver parity, rung 4 | `mise run driver:parity` | the dev lane, through the operator's port-forwards and reverse tunnel, and the display host | minutes | a join and a client launch as the attach account: it moves that account's player in the dev world, and nothing in `monoplayer`. It refuses the live fleet, the live front in front of it, and a `playit.gg` tunnel to that front | no, the display host and the dev lane |
| transfer testbed, rung 2b | `mise run testbed:run` | the live custody claim and the gate Paper | about 3 minutes | **the live front goes offline for the run**: it scales `monoplayer/monoplayer` to 0 and disables Argo auto-sync. `mise run testbed:down` restores the deployment, and the sync policy while the run's restore record at `/tmp/opencode/monoplayer-testbed.json` survives. It also deletes the testbed's front Service, which is what unpublishes `monoplayer-testbed.tail41e568.ts.net` | no, it takes the live front offline, and its Papers are one fixed namespace |
| dev lane | `mise run dev:up`, then `mise run dev:image`, then `mise run dev:join` | `monoplayer-dev` | minutes | its own Paper, proxy, and account; nothing in `monoplayer` | no, one proxy replica, one account, one image pin |

Two rows above can change what the live lane serves without a flag: the transfer
testbed takes the live front offline, and a bare `mise run online` can refresh the
chain the deployment holds. A third, `mise run online:cluster --rotate`, writes
that chain and needs a restart. An agent never runs `testbed:up` or `testbed:run`,
and never passes `--rotate`. `mise run online:cluster` is the form to prefer, and
the bare rung stays available because `verify:custody` composes it. `AGENTS.md`
states the rule. `deploy/dev/README.md` is the dev lane runbook.

The online rung copies the attach account into its pod, and it refuses to log in as either
account while that account's cached token has expired (#389). `docs/custody.md` says what
refreshes each one. Without `--rotate` the directory the pod hands
back must be the one it was given: the run compares the two and fails with exit 1 on a
difference, keeping the pod, because the pod holds the only live copy. With `--rotate` the
returned directory is written back over the local copy, so one live copy of that account
stays here. A copy-back that brings nothing back fails the run with exit 2. The copy-back
reads the returned directory with a glob rather than `find -printf`, which BSD `find` does
not have (#370).

A capture is the one run here that writes a fixture instead of a report.
`src/ladder/capture-config.js` records the lane it ran in, the Paper build and the image
(#322, #367). It takes that lane from `scripts/gate-lane.sh name`, this worktree's lane,
with no literal fallback. A capture with no lane to name and no `--lane` stops with exit
2 before it joins. A fixture naming a server, a build or an image nobody measured is
worse than a capture that failed. `--lane` names the lane for a capture whose endpoint is
not this worktree's: a port-forward to another lane, another cluster, or a Paper started
by hand. A port-forward cannot say which lane it forwards to, so the flag is where the
lane comes from. `MONOPLAYER_GATE_NAMESPACE` names the lane for a rung and for a capture
at once: the script answers it, and the capture records it. The build and the image are
named by the operator, because no frame a client receives carries either. A status ping
answers with the server's name and version and no build. An image is packaging the server
never sends. A capture with no `--paper-build` stops with exit 2 before it joins. The
build is in `PAPER_BUILD` in the manifest that deployed the server,
`deploy/driver/paper.yaml` for the gate Paper. A capture with no `--image` records
`image: null`, which says nobody named one rather than naming the gate lane's image. The
committed `src/legs/configuration-baseline/26.2.json` still reads `monoplayer-gate-b`,
because that is where it was captured. A fixture is dated evidence, and it keeps its own
lane, build and image.

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
rung without a hint. The concurrency answer is a column here for the same reason.

## May this run beside another agent?

The lane table answers what a run may change. This answers whether it may happen
while another agent's run does. Seven things decide it, and a lane of your own
settles one.

**The account lease.** A run that uses the real account takes
`monoplayer-online-account` in `monoplayer` first, and one run holds it
([the account lease](#the-account-lease)). So rung 3 runs alone in both forms.

The same holds inside `mise run observer:run`: its two joins both go through
`scripts/online-cluster.sh`, so each takes the lease, and no other run holds the
account while it does. The install and the restart before them take nothing, which
is why its row says two joins and not one run.

The lease is one object for every worktree on the cluster, so no lane buys a second
run. The scarce resource is the refresh chain, not the namespace.

**The lane is the worktree's.** `scripts/gate-lane.sh name` prints this worktree's
lane, and `gate:up`, `gate:down` and `gate:status` act on that lane and no other,
so two worktrees never stop each other's rows. Two runs in one worktree do:
`gate:up` re-applies the tree, and `gate:down` scales all five rows.

Every rung that reaches a lane reads this one. The online rung's lease and the Paper
it dials are one name (#301). The observer rung decides its lane after its arguments,
so `--namespace` and the variable are the same decision, and naming both differently
stops the run (#282). The driver resolves its join address and its RCON target from
this script too, so a renamed lane's run cannot administer the lane that shipped
(#282). None of them needs a variable:

    mise run online:cluster
    mise run observer:run
    mise run driver:scenario

`MONOPLAYER_GATE_NAMESPACE` names a lane by hand for all of them at once.

**The testbed's namespace is listed, and no lane command changes it.** `monoplayer-gate-b`
is the one namespace the listing names that no worktree derives, and it is not a gate
lane: every worktree shares it, and it holds the transfer testbed's two Papers. `deploy/testbed/namespace.yaml` carries the lane
selector, so `mise run lanes` lists it, with `?` for the age no `up` here wrote and
`transfer testbed` in the owner column. The reaper keeps it for the `paper-hub` and
`paper-sky` Deployments the gate tree does not declare, and refuses that name at the
delete as well, so the shared namespace survives a testbed whose own rows are gone
(#318). The listing names it and changes nothing, and `gate:status` reads its rows for a
reader debugging the testbed. `gate:up` and `gate:down` refuse the name, in a sentence
that names `mise run testbed:up` as the command that owns the namespace (#360). A `down`
there would scale five rows to 0 and delete the lane's generated Secrets, which are the
names its Papers read. An `up` would apply the gate tree over it.

**The loopback assertion numbers are one sequence.** An id is an entry in
`LOOPBACK_ASSERTION_IDS` in `src/ladder/loopback.js`, the `check(…)` call that
names it at that position in the run, and a bullet in
[the assertion contract](#loopback-assertion-contract).
`test/ladder/loopback-contract.test.js` requires the declaration and the bullets to
agree in both directions. The run requires the order: the nth check must name the
nth id, so a finished run fails when a position disagrees (#623). It fails too when
the list declares an id no check made, or a check names an id the list does not
declare. That guard reads the declaration rather than the call, so a `check` call
outside this file is not drift (#593). Two rows that each add an assertion take
the same next number, the one above `LOOPBACK_ASSERTION_HIGH_WATER` in
`src/ladder/loopback.js`, and edit the same bullet list. The mark is the highest
number any id has ever used, so a row that adds an assertion takes the number above
it and raises the mark in the same commit (#681).

It is a number rather than a reading of the array. The array is the run order:
`O11b` follows `O12`, and `O36`, `O46`, `O27` and `O28` sit before `O10`. A number
a retirement took is in neither the array nor the bullets: `O54` is off both, so
nothing beside the ids says 54 is burned.

Retiring an assertion is allowed, and the number is burned. The id lands in
`RETIRED` in `test/ladder/loopback-contract.test.js`, beside `EVER`, a record of
every id the repository has ever declared. Each failure names its edit:

- an id is numbered above the mark: take it and raise the mark in the same commit;
- the mark is not the highest number `EVER` holds: it moves with an id, never on its
  own;
- a number under the mark has no id in `EVER`: the id that used it comes back with
  its row, or the new assertion takes it if no retirement burned it, because a
  retirement keeps its row;
- an id at a burned number is declared again, the retired id or a new lettered
  sibling of it: the number stays burned, and the new assertion takes the number
  above the mark;
- an id leaves the list with no retirement: `EVER` keeps it, so restore the check or
  retire the id, because the number is burned either way;
- an id `EVER` never held is declared, or retired: add its row in the same commit as
  the check, the bullet and the mark, because a retirement names a row `EVER`
  already holds;
- an id the guard cannot read: an id is one capital letter, one number, and a
  lowercase suffix at most.

An id sits under the mark only as a lettered sibling of a live id, which is how
`O11b`, `O24b` and five more arrived. The guard reads numbers, so the family letter
is the convention and not a rule.

The guard reads the tree, not its history. It cannot see the highest id deleted with
its `EVER` row and the mark lowered to match. It cannot see a retirement deleted with
its `EVER` row either, which is the same deletion twice. So the mark never moves down
and a retirement is never removed, and the diff is what says so.

No lane helps here: the sequence belongs to the repository, not to a worktree. Add
assertions one row at a time. A row that adds no assertion runs beside any other.
Four consecutive rows on the board that wrote this section serialised for this
reason alone, with no code in common.

**The display host carries one client.** Rung 4 relaunches one Prism instance over
SSH, `gate-b-player-262-fabric` unless `--instance` names another, and drives its
keyboard. Two runs would drive one client. Both forms of rung 4 also join as one
attach account, and a server kicks the first session when one account opens two
([the driver runbook](driver-lane.md)).

**The dev lane is one lane for every worktree.** It has no instance. The namespace
is `monoplayer-dev`, one proxy replica holds one `ReadWriteOnce` claim, and
`mise run dev:image` repoints the Deployment. Two rows would overwrite each other's
build and race the one account
([the dev runbook](../deploy/dev/README.md#one-run-at-a-time-on-this-lane)).

The transfer testbed never runs beside anything. It takes the live front offline,
and its two Papers live in the fixed namespace `monoplayer-gate-b`, which every
worktree shares (`src/testbed/switch.js`). That namespace is the testbed's, not a
worktree's lane: `mise run lanes` lists it and `mise run lanes -- --reap` never deletes
it (#318), and `gate:up` and `gate:down` refuse it (#360).

This machine's ports are not lanes either. `mise run image:build` port-forwards
buildkitd on 1234, `mise run panel:run` binds 127.0.0.1:8080, and a bare
`mise run online` dials 127.0.0.1:25565 unless `MONOPLAYER_BACKEND_HOST` names
another host.

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

`src/panel/` needs no extra rung: `mise run check` covers it, and its page is
served from a checkout by `mise run panel:run` (loopback only, no cluster).

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

## The account lease

One Minecraft identity is one refresh chain, so a run that uses the real account
takes a Kubernetes `Lease` first (#280). The lease is `monoplayer-online-account`
in `monoplayer`, the namespace that holds the custody.

The holder identity is the run's gate lane (the namespace `scripts/gate-lane.sh
name` prints), its branch, and its pid. So a refusal reads as a person's run:

    online-cluster: the account lease monoplayer/monoplayer-online-account is held by
    "monoplayer-gate-3e64f1b-43b036 on t3/online-rung-account-lease (pid 355694)"
    until 2026-11-24T19:25:38.830Z (15m left). One run uses the refresh chain at a
    time, so this one does not start: wait for that lease to expire, or pass
    --lease-wait SECONDS to queue behind it

Both forms of the rung take it: `mise run online` through `scripts/online-cluster.sh
hold`, and `mise run online:cluster` around the pod. A second run refuses at once,
or queues with `--lease-wait`. The lease is released on a clean exit and on a
failure.

The lease lasts `MONOPLAYER_LEASE_DURATION` seconds, 900 by default, and is renewed
every third of that while the run goes. A lease that has expired is taken without
asking. `scripts/online-cluster.sh` holds the defaults and the rest of the
`MONOPLAYER_LEASE_*` variables.

A release is the last lease write a run makes (#355). The renewal loop outlives the run,
and a renewal already inside its write is a `kubectl` child of that loop. Killing the loop
therefore leaves that write running. So the release marks its state directory, drops the
marker the loop's guard reads, waits for the tick already writing, stops the loop, and then
writes. A tick that finds the mark writes nothing. Without that order the last write is the
run's own holder identity. The next run then reads a lease held by a run that has exited,
and it refuses or waits out the duration with nothing on the cluster to point at.

Two ways a run can end without releasing the lease, and what happens:

- **A run killed with `SIGKILL` runs no exit handler.** The renewal loop outlives it,
  notices its parent is gone, and releases the lease. It checks `/proc/<pid>/stat`,
  because a zombie still answers `kill -0`.
- **Another run takes the lease, either after it expired or by a wrong clock.** This
  run stops with `SIGTERM` and says so, rather than carry on as a second writer on
  one refresh chain. The expiry is judged by the reader's own clock compared with the
  `renewTime` the holder wrote, so two machines more than a few minutes apart can
  disagree about a live lease. The renewal interval is a third of the duration for
  that reason.

The lease needs `get`, `create` and `update` on `coordination.k8s.io/leases` in the
namespace. `update`, not `replace`: `replace` is a `kubectl` subcommand and not an RBAC
verb, and a `kubectl replace` is an HTTP PUT, which the API server scores as `update`. The
refusal the script prints says `replace`, which is the bug filed as #493: the verb to grant
is `update`.

`deploy/manifests/account-lease-role.yaml` grants them, and its header says why that takes
two rules. Its RoleBinding hands them to a group, and an operator whose credential is a
cluster admin needs none of it: `system:masters` is answered before RBAC is consulted.
[deployment.md](deployment.md#the-operator-credential) is how any other credential gets the
group.

`test/tooling/live-manifests.test.js` fails when a verb, the lease name, the namespace or
the subject moves, because no offline rung can run as a narrower credential to find out.

Three things the lease does not cover. The deployment's own proxy keeps refreshing
the puppet while it serves, which is what one-account-one-writer-one-replica is
for. A worktree's copy of the account is not the axis: a lease is one object for
every worktree on the cluster. And the writer lock inside the custody is a
different thing, per account directory, which is why `mise run online` still holds
it too.

`mise run check` is the offline gate: it runs rungs 0, 1, and 2, and CI runs it.

## A failed rung names the next one

Each rung task prints, on failure, the next rung to run, the class that rung
catches, and what it needs. Rung 4 has nothing above it, so `mise run driver:g0`
says that instead. `mise run test` failing prints:

```
mise run test failed (rung 1, unit).
Next rung: mise run loopback (rung 2, loopback) — about 55 seconds
  catches: real front and backend legs over loopback, the node fake backend, and a real 26.1 protocol bot: attach, cached configuration replay, join order, serverbound relay, detach, reattach, deny, transfer follow (two fake backends, handshake intent 3, cookie round trip), the detach-and-rejoin move with the kept connection off (#22), and the kept connection, which is on by default; no auth
  needs: pnpm install
```

`src/ladder/next-rung.js` reads those sentences from the rungs table above, so
editing the table edits the failure output. `test/tooling/mise-tasks.test.js` fails when
a rung task stops printing the hint.

The gate is the one place where the hint alone was not enough. mise sends
SIGTERM to every still-running sibling when a rung fails, and a killed rung
prints the reason it was killed as if it were the reason it failed: a unit file
terminated mid-run reported `Promise resolution is still pending` for a test
file that holds no promise. So `mise run check` has no dependency edge. Its rungs
are the `depends` of `check:rungs`, which it runs through
`mise run --continue-on-error`: every rung finishes, and mise names each one that
failed (`ERROR 1 task(s) failed: [lint] exited with status 1`).
`test/tooling/mise-tasks.test.js` holds that shape.

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

Exit codes: `0` all assertions pass, `1` an assertion or timeout failed, or the
checks are not the order the list declares, `2`
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

The ids are one sequence for the whole repository, so a change that adds one runs
beside no other: [May this run beside another agent?](#may-this-run-beside-another-agent)
says why, and it is the reason to add assertions one row at a time.

- `R0` readiness is warm from `chunk_batch_finished` (never `forceWarm`).
- `O1` the first attach is allowed once, no denials, and the front leg is
  `offline-front-leg` with no `.secrets` whitelist store. O53's leg is the one
  offline leg that holds a store, and it holds one built on its own temporary
  control directory, never on `.secrets`.
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
  reason `not_whitelisted`. The check runs after the first client has detached, so
  the whitelist is what refuses this bot and not a second attach. A lane with no
  picker refuses a second client at its own login (#312), and O67 proves that refusal
  while a driver holds the body.
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
  records no leftover bytes, no frame whose id the table it was read in does not
  define, and no errors (#969).
- `O38` the transfer intent starts the client's configuration round before the
  target is reached: one round counted, the client in configuration, the
  session `transferring`, and the cold target has accepted no login yet (#87).
- `O39` a dial the target refuses before its first frame leaves the move in
  flight: the move is still a transfer, the client is still in its round, and
  nothing was restored (#87).
- `O40` a target the rung gives up on restores the previous server's state on
  the connection the client kept: the snapshot's configuration and finish stream
  into the open round, the previous play login replays, no kick, and no front
  client error (#87). The give-up is one refused dial, not a budget: the rung sets
  `giveUpOnFailedDial` before it sends the transfer, so the reconnect handler
  answers that refusal with `abortTransfer('target_unreachable')` instead of
  `session.fail()`, and the abort restores the session.

  What it cannot prove: the counted give-up against a real leg.
  `DEFAULT_MAX_TARGET_FAILURES` in `src/core/transfer-follow.js` is spent in the
  handler `createReconnectHandler` returns, and `test/service/start-live.test.js`
  drives it with a fake leg (#540): one hop's revert to a settled server that is
  not the base, and the target memory across a retry that carries none. The count
  that ends in `abortTransfer`, and a chain of two followed hops, stay unproved
  on a leg (#548).
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
  fail a correct cache. The cut is the core's `attach` event (#683), so both sides
  of it are the replay's own values.
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
  wrote on that snapshot. The cut beside this record is the core's `attach` event,
  not this record (#683, see N13).
- `O51` the entity domain is bounded by entity, not by frame arrival (#213). A
  rig of its own, because the assertion needs a small bound, and the main rig's
  default is 2048 entities. The bound is four entities and the churn is five
  frames: entity 9's spawn, its correction, then three more entities. An
  arrival-ordered ring of four frames would evict entity 9's spawn and replay the
  correction for a body no client spawned, which is the reported "present in the
  tab list, absent from the world". The replay carries all five frames in capture
  order, the attaching bot decodes exactly those, the cache counts four entities
  and five slots, and no bound overflowed (`overflows.entity` 0,
  `overflows.entityDepth` 0, `overflows.entityFrames` 0). The metadata-index half of the keying is not on
  this rung: `test/core/cache-equivalence.test.js` compares the replay with the
  stream on the client-state model, where a superseded index is visible.
- `O52` the post-filter journal still records the frames a diagnosis reads, and
  describes every shard it sealed (#217). The journal drops the entity stream and
  keeps terrain length-only, so "the filter leaves what you need" was a claim
  nobody had tested. The rig is the main one, because it is the only rig that
  writes the names a diagnosis reads: a join with terrain, two dialogs, three
  resource packs, two transfers, and traffic in both directions. One
  `player_info` is written through the fake's own server, because the fake has no
  sender for it and the journal never sees the front leg's own skin frame, which
  is a write the core does not relay. The check reads the directory back through
  the reader the tools use. `login`, `position`, `map_chunk`, `player_info`,
  `show_dialog`, `add_resource_pack`, and `transfer` are all present, five of them
  with a body that decodes; a client frame carries its body too; `map_chunk`
  carries 51493 bytes with `lengthOnly` and no body; and none of the seven dropped
  entity names appears, while `journal.dropped` counted four of them. The writer
  then seals: one gzipped shard per kind, each with a manifest whose line count
  and name histogram are what the shard holds and whose `bytesByName` is not
  empty. The events shard holds the `liveReady` record the rig wrote, because the
  core writes no lifecycle event and this rung does not run `start-live`, which
  does.
- `O53` a login the control document's whitelist refuses is allowed on the next
  attempt once the file gains that UUID, with no restart (#229). The reload is
  the whole point of the ticket: an operator adds a player through the panel and
  the next login sees it. The core's login review reads that file at each login, so a
  unit test of the read proves the read and not that a login reaches it. The rig is
  its own, with a temporary control directory, a fake backend, the product core, and
  an `offline-front-leg` holding the control document's store. `Second` logs in
  while the file lists only `Attach`: the core writes one `attachDenied` with
  reason `not_whitelisted`, the front counts one denial, the socket ends, and no
  login success frame ever arrives. The bot's own end reason is `socketClosed`,
  so the reason a reader checks is the core's line and the front's counter. The rig
  then rewrites `attach-whitelist.json` with both UUIDs and changes nothing else.
  The same player logs in again on the same process and reaches play: one allow,
  `core.attached` true, a login success frame, and `backendLogins` unchanged
  across the edit, so the reload neither restarted the lane nor re-dialled the
  backend.
- `O55` a join with no backend receives the recorded configuration baseline
  without its registry set, and the picker, and its pick is recorded (#257, #598).
  The rung's only 26.2 rig: its own `createOfflineFrontLeg`, its own
  `createWireChecker({ version: '26.2' })`, and five 26.2 protocol bots. Nothing is
  dialled while the picker is read, so the front's cached replay path finds
  nothing: the frames the client reads are
  `src/legs/configuration-baseline/26.2.json`, the committed recording of the gate
  lane's Paper 26.2 build 135, in its recorded order, less the 29 `registry_data`
  frames a picker phase never carries (#598). A client loads a Minecraft registry
  once, at the frame that ends the phase, and the body a claim lands the client in
  continues that phase with its own set, so the recording's would be the first of
  two. The client reads `feature_flags`, `select_known_packs` and `tags` with no
  leftover bytes and no wire rejection, and no `finish_configuration`. The phase
  stays open, which is the point of the picker.
  The dialog that lands on it is authored by `src/core/picker.js` and carries one
  action per allowed server. The assertion reads the action id out of the frame the
  client received, has the bot
  answer it in the configuration state, and requires the service to report that
  same id with the server it named. The pick rides in the action `id`, never in
  `additions`. `front.lastConfigMode` is `baseline`, and the core attaches nothing.
  A pick no longer ends the connection: it opens the server's own dialog, which is
  O56. The assertion also reads the lane before any claim exists: the backend leg
  has no connection, never opened one, and both claim counters are zero. That is the
  no-dial rule (Q6) at the only moment it is about, rather than a count of logins at
  a body nobody reached yet.

  The rig lists two rows. The first names a port nothing listens on, so a claim on
  it is a dial the kernel refuses. The second names a real 26.2 fake body, which is
  the one O58 lands a client in.

  What it cannot prove: that a vanilla 26.2 client accepts known packs and tags
  with no registry set behind them, which is the phase a picker now serves (#603).
  The protocol bot is not a vanilla oracle, and rung 4 is the only place one runs.
  What it does establish is that the bytes are a real server's, that they parse in
  the configuration state under the strict wire checker, and that the front
  invented no frame in the phase.
- `O55b` a second client reads the picker at the same time, because a picker
  join holds no channel and enters no body (#257). Two 26.2 bots hold the picker at once, each with a
  dialog and no leftover bytes, and the front counts two picker joins and no
  attach. The single-attach rule is unchanged for a real attach: this is the
  property that makes a picker reachable while one client is reading it.
- `O56` a pick opens that server's own dialog, its answer is read back from the
  frame the client sent, and a body that refuses the dial gives the picker back
  (#266, #258). The same 26.2 bot that picked reads a second `show_dialog`. Its
  title is the row's name and state, it has one column, no escape, and three custom
  actions: `Claim`, `Spectate` and `Disconnect`. Their ids come from `verbIdFor`
  for the row the lane offered, and the assertion reads them out of the frame the
  client received rather than choosing them. The bot clicks `Claim` in the
  configuration state, and the assertion requires the service to report verb
  `claim` with the id the frame carried and the server it named, and the front to
  count one server dialog, one verb and one claim (#267). The verb and the server
  both ride in the id, so the leg keeps no per-connection state about which dialog a
  client is looking at.

  #258: the claim is also the one thing that dials a body, and this row's port
  answers nothing, so the dial is refused. The client is not left in a dialog nobody
  will read: it reads a third `show_dialog`, the list it started at, titled
  `Choose a server - <row> did not answer`. Its claim still stands, because a claim
  belongs to the connection and the click did not spend it (#267), and its
  connection is still open. The reachable body in the other row counts no logins, so
  a refused landing dialled nothing else.
- `O56b` an unknown verb is refused, named, and answered (#266). The second 26.2 bot
  sends `monoplayer:teleport/<the offered row's slug>` in the configuration state. The front
  refuses it and logs one sentence that names the verb and the verbs it does offer.
  It reports no verb to the caller and ends the client with a configuration
  `disconnect`, so the client is not left in a dialog. A malformed id
  (`monoplayer:claim` with no server), an id in another namespace and a server the
  lane does not offer take the same route through the leg. Their sentences are
  proven in `test/core/picker.test.js` rather than here.
- `O56c` disconnect is refused while a claim holds the body, in one sentence
  naming the driver (#261). A third 26.2 bot picks, then clicks `Disconnect` on the
  row the first client's claim stands on: a claim whose landing failed, which is a
  claim all the same (#295). The front reports verb `disconnect` with that id and the
  server it named, and the click reaches the claim. The answer is one refusal that
  names `Attach`, and the client that asked is disconnected with that sentence rather
  than left in a dialog nobody will read. Nothing else moves: the count of granted
  disconnects is zero, and the claim is still the one on that body. O64 is the half
  where a body is unclaimed and does end.
- `O57` the pick records an exclusive claim, and a second claim on that body is
  refused by name (#267). The first 26.2 bot claimed the row whose port answers
  nothing in O56 and is still connected, so it holds that body, and it is back at
  the picker holding it. A fourth bot reads the picker while that claim stands,
  which it may, because a picker join is not a claim and holds no channel. It
  picks the same server and clicks `Claim`. The claims the front holds are then
  exactly one, on that body, and they name `Attach`. The refusal is one
  sentence naming `Attach`, and the rival gets a configuration `disconnect` rather
  than a silent nothing. The claimant is still connected when the refusal is read,
  which is what "held by the connection" means: the click does not spend the claim.
  A client that has read the picker and not claimed holds nothing, and the claims
  are read again after the rival's pick, which takes nothing either. Four picker
  joins, one claim and no attach, so the core's session is untouched.

  What it cannot prove: that the claiming client is delivered the body, because the
  body claimed here never came up. The landing is O58's, and the body that is
  actually driven is where O60b refuses a rival.
- `O58` a claim lands the client in the body it named: the body is dialled only
  for that claim, and its play state arrives on the connection the client already
  held (#258). A fifth 26.2 bot reads the same picker, picks the row that names a
  real 26.2 fake body, and clicks `Claim`. The fake counts zero logins before that
  click, and one afterwards. The backend leg's target is that body's port rather
  than the configured backend the lane started with, so the claim chose the body
  instead of inheriting a warm one. The client's play login
  then arrives on the socket it already held. The body's own configuration frames
  continue the phase the baseline opened, one `finish_configuration` ends it, and
  the core's replay follows. The position it holds is that body's own spawn, which
  no other body in the run sends. The assertion requires one login at the body, the
  body's spawn at the client, `session.state === 'attached'`, one front attach, and
  the body recorded as claimed.

  What it cannot prove: that a vanilla 26.2 client accepts one phase carrying the
  recording's `tags`, `feature_flags`, `select_known_packs` and `custom_payload`
  before the body's own copies of those four frames. The registry set is the one
  set of the phase since #598, and that is what the client loaded at
  `finish_configuration`; nothing here measures what a client does with the other
  four frames repeated, and #603 is where that is measured.
  The body is a `minecraft-protocol` fake whose configuration is the library's
  own, `prismarine-chunk` has no 26.2 implementation, and the body therefore sends
  a chunk batch with nothing in it (`chunks: 'empty'`). This proves the selected
  body's play join and its spawn, never its terrain. That is rung 4's question, and
  #268's: if a real client refuses the repeated frames, the fallback is a one-frame
  limbo through the same-connection reconfiguration machine.

  The report says which path ran, out of the client's own frames: this one is
  `same_phase`, with one finish and no `start_configuration`. The fallback would
  show that frame, so a later run cannot report the same path by accident.
- `O59` a body owns its state cache: two bodies of one account hold their own
  state at once, and one body's fault leaves the other body's cache and session
  intact (#260). Two 26.1 fake backends and two offline backend legs hold one
  account (`GlowSquidye`) at once, and no client is delivered to either. Each
  body's frames go into its own cache through the product's body-cache registry,
  which is the ownership this assertion is about. Each body sends its own spawn
  entity and its own block change, and each cache holds only its own. So the two
  are not one cache by accident. The capture counters are the cache's own: a
  block frame at the first body does not advance the second body's sequence. One
  replay per body follows. `replayFrames` over each snapshot carries that body's
  entity and not the other's. Then the first body's session ends and its cache is
  reset, which is the composition root's own rule for the body that ended. The
  second body's snapshot is byte for byte the one it had, and its warm flag is
  still set. Its fake's next block change still lands in its block domain. The
  picker core this run already landed a claim on is read too. The cache the client
  is served from is the claimed body's. The two bodies it dialled and never reached
  each kept an empty cache. They are the lane's configured backend, which a picker
  lane never dials, and the row whose dial O56's claim had refused.

  What it cannot prove: that two clients are delivered at once, one per body,
  each reading its own body's cache. That is a session per body, #261: the two
  bodies here are held at the leg, not delivered. O60 delivers a driver and a
  spectator of one body, which is the delivery half. It also cannot prove two
  sessions of one account on one server. A server kicks the session it already has,
  and these are two fakes, so two servers.
- `O60` a body serves a driver and a spectator: two channels on one body, each
  with its own delivery state and its own client information (#269). O58's driver
  is still connected and still holds the body. A sixth 26.2 bot reads the same
  picker, picks the row the driver is on, and the rig then lands it as that body's
  spectator through `frontLeg.spectate({ username, body })` — the call #259 wires
  the picker's Spectate verb to. This rung stands in for that row; it does not
  decide it. Nothing is dialled: the fake body counts the same one login it had,
  because a spectator watches a body that already has a session. The client
  continues the configuration phase the baseline opened with that body's own
  frames, ends it with one `finish_configuration`, and its play login arrives on
  the connection it already held, at the body's own spawn.

  Then the body sends one block change and one live-only `system_chat`. Both
  clients receive them, and a second `system_chat` sent before the spectator
  existed is in the driver's record only: no replay carries a live-only frame. The
  front's channels are read as records, not counters. There are two, and the
  driver comes first. Both are on the claimed body's slug, both have been handed
  their body's replay once, and they are two records and not one: the chat above is
  what separates them, because `#259` gives a spectator's record two frames of its
  own. Which frame is `last` is not pinned to a name, because `#636` gives the driver
  the body's other channels as players and a spectator's own position as a move, so the
  last frame is whichever of those two sources arrived later.

  Each client's own client information stays on its own channel. Both are sent in
  play, which is the state where the front's settings hook reports nothing and the
  driver's change travels the serverbound rewrite. The driver's reaches the puppet
  as one Client Information frame with the driver's locale. The spectator's reaches
  the fake as nothing, and the front counts it as a spectator's. A position the
  spectator sends moves nothing on the server's side: the front drops it before the
  core's pipeline, the core forwards nothing, and the session pose is byte for byte the
  one it had. `#636` reads that dropped frame for where that client is, which is a fact
  about the body's other channels and not about the body. `O71` is the row that reads it.

  The surface is not decided here: an eighth bot reaches the driven body's own
  dialog and reads its `Spectate` button, and this assertion stops there. `O62`
  clicks that button and proves what the click does, so the seam above and the verb
  below stay two facts with two numbers.
- `O60b` a second claim on a body a driver already holds is refused by the claim,
  not by an attach slot (#269). O57 refused a rival on a body nothing was delivered
  to. Here the body is driven: O58's driver holds it and O60's spectator watches
  it. A seventh bot reaches the picker while the body is driven, which is the login
  route #269 changes: the core serves the picker rather than passing the login to an
  attach it would refuse. The bot picks the driven body and clicks `Claim`. The
  refusal is one sentence naming the player who holds it, the rival gets a
  configuration `disconnect`, and no `attachDenied` line with reason
  `already_attached` exists in the whole run: nothing refused the rival before the
  claim did. The session's attach count stays one, the driver and the spectator are
  still connected, and the front still holds exactly two channels, one of them a
  driver.

- `O61` the picker offers the allowed-server list, falls back to the seed it names,
  and a row is one body id (#265). The rig writes the two files the key has: the
  live list the panel edits, and the seed Git commits behind it. It offers them
  through the product's own reader (`createPickerServerReader` in
  `src/service/start-live.js`), so what this rung reads is the offer the service
  makes. Every join from O55 on is therefore a live-file list. The lane said which
  file answered once: one `pickerOffered` line with `source: control` and two
  servers. A join reads the list more than once, and the operator reads one line.

  The live file is then made unparseable. The reader names it and ignores it, in one
  `controlRejected` line carrying that file and `reason: not_json`. The seed answers
  rather than an empty dialog. A ninth client reads exactly the seed's one row,
  labelled with its address, and nothing is dialled for it. Then the live file is
  edited the way the panel writes it. The row removed is the body a driver holds and
  a spectator watches. A tenth client reads a list of exactly the remaining row. The driven body is the one the edit found: the same claim, the same cache
  instance, the same one dial, the same two channels on that body. Neither client
  ended and neither was kicked.

  The identity this proves is the one #260 and #267 have to agree on. The body id
  the claim records is the key the dial's cache is made under, read back through the
  address the row names (`pickSlug(pickTarget(row).host + ':' + port)`). So one
  server is one body id.

  What it cannot prove: a row whose name spells its address another way. No
  allowed-server file can spell a port that way, because a leading zero is not JSON.
  `pickerRows` normalises whatever name a lane hands it, and
  `test/core/picker.test.js` is where that is proven. A live file that is absent
  rather than broken, and a seed that is missing, are
  `test/service/control.test.js`'s.
- `O62` the picker's Spectate verb lands a client in a body it does not drive, tells
  its client so, and sends nothing on to the backend (#259). O60 landed a spectator
  through `frontLeg.spectate`, the seam #269 built and left to this row. This is the
  click that call was waiting for: the eighth bot has been in the picker with the
  driven body's dialog on screen since O60 and has never answered it. O61 removed the
  driven row from the live list, so the operator adds it back first, which is the edit
  the panel makes.

  Clicking that button is enough. Nothing is dialled: the fake body counts the one
  login it had. The client's configuration phase continues with that body's frames,
  ends with one `finish_configuration`, and its play login arrives on the connection
  it already held, on the body's own entity and at the body's own spawn, with no
  leftover bytes. The front's channels are three: one driver and two spectators. A
  block change the body sends afterwards reaches both spectators.

  The client is told what it is, and the assertion reads it off the wire rather than
  from a log. One `game_state_change` arrives with reason 3 (`change_game_mode`) and
  game mode 3, and one `abilities` with the flags vanilla sends a spectator:
  invulnerable, flying, and flying allowed, at the protocol's own two speeds. The
  body then switches mode itself. That frame reaches the driver and not the spectator,
  and the front counts the two it withheld: a spectator's mode is what the core wrote
  when it landed, not what the body does next.

  A spectator changes nothing, and the proof is the far end of the socket. It sends a
  position, a chat line, a command and a dig. The front drops all four, the core
  forwards nothing, the session pose is unchanged, and the fake backend's own
  counters are the numbers it had before the click: logins, positions, chats,
  commands, digs, places and settings. A counter in the front would only say the
  front believes it dropped them.

  The row is read as a client reads it. A fresh join lists the driven body as
  `<address> - claimed (Pilot), 2 watching`: the driver from the claim, the spectators
  from the channels on that body. The row for the body this lane does not serve reads
  `down`, because a row is what the lane can offer and not what it has dialled. The
  claim on that row is still held by a connection whose dial failed (#295), so the
  state is the body's and not the claim's.

  The same client then picks that row and clicks `Spectate`. That is refused in one
  sentence naming the server and saying this lane is not serving it, and the client is
  disconnected rather than left in a dialog.

  Nothing here became a claim: the front's claims are byte for byte the ones it held
  before the click, and none of them names the spectator. A spectator leaving takes its
  own channel and nothing else: the driver and the other spectator stay, and the body
  is still attached to the same claim.
- `O70` a spectator is put in spectator game mode on its own channel, and the
  driver's socket carries none of it (#633).

  O62 reads what a spectator's socket is told. This is the other half of the same write,
  and the half a mistake breaks the product with. A driver is a player in the world: a
  lane that wrote the pair on every channel would hide the driver's own body, take its
  controls, and put it in the air. The front withholds a body's own mode frames from a
  spectator (`bodyFrameWithheld`, src/legs/live-front.js), so a broadcast pair would
  reach the driver alone and not the spectator at all. The positive and the negative
  cannot stand for each other, which is why O62 and this assertion both exist.

  The driver is O62's, still in play on the body. A fresh client lands beside it through
  the front's own `spectate` seam, which is the call the Spectate verb makes. Both
  sockets register their own listeners before that landing, because the bot records frame
  names and not these packets.

  The spectator's socket carries a `game_state_change` with reason `change_game_mode` and
  game mode 3, and an `abilities`. Its one mode-3 frame is the one this write made: the
  body's own copy arrives from the replay carrying the body's mode, which is not 3. The
  driver's socket carries no mode-3 frame and no `abilities` at all in that window, and
  both clients keep their connections.

  What each frame makes a client do, and which fields it needs, is
  `src/core/spectator-mode.js`'s header, read from the client's own code. It is not what
  the ticket assumed: flight is the mode frame's, and the abilities frame pins the speeds
  and is the only one that can revoke flight. `test/core/spectator-mode.test.js` holds the
  reason and the field names to the protocol data of 26.1 and 26.2.

  What it cannot prove: that a client in spectator mode draws no body of its own, and it
  does not. The bot speaks the wire and records no pixels, and the client decides that
  from the player-list entry for its own UUID, which #614 does not send (#647). The witness
  is #634, still open: two real clients on the dev lane.
- `O63` a body nobody drives stays up and stays watchable, and a join reads the
  picker instead of taking the empty driver seat (#259). A claim is held by the
  connection that made it, so O62's driver leaving releases the body and nothing
  else: its backend session, its warm state and its spectator all stay. The fake body
  counts the same one login. The session is `detached`, `claimedBody` still names the
  body, and no client is attached.

  A twelfth client joins. It reads the picker, and the core attaches nobody: before
  #259 this join was attached as that body's driver down the pre-picker path, with no
  claim recorded, which is also why the picker only ever offered anything while no
  body stood. Its row says `<address> - unclaimed, 1 watching`, which is a body a
  client may watch and not a body that is down.

  It picks that row and clicks `Spectate`. Nothing is dialled, and the client lands in
  the body nobody drives: the body's entity, the body's last pose, and a block change
  the body sends afterwards reaches both spectators, so a driverless body is followed
  rather than frozen. The front holds two channels, both spectators, both on the body's
  slug, and neither holding a claim. The session stays `detached`: watching is not
  driving.

  What neither assertion can prove: that a vanilla client draws a body it does not
  drive. Both clients here are protocol bots, so no real client has made a claim for
  another to watch (#325). Both deployed lanes serve a picker since #579: the live
  lane, whose rows are the control document's allowed-server list, and the dev lane,
  whose `monoplayer-dev` front publishes on the tailnet under that name, seeds one row
  for its own Paper, and runs that Paper offline, so a claim is reachable from another
  machine without the live servers. Neither lane takes two bots yet: the service builds
  live legs only, so a joining client is verified against Mojang before it sees the
  picker, and a row on two clients needs two accounts, because a channel is never told
  about the player it speaks for and two clients of one account are never drawn for each
  other (#391). The dev lane's
  [two-client proof](../deploy/dev/README.md#the-two-client-proof) is where two real
  clients hold that half (#634). A row that witnesses the vanilla half needs that ticket, and
  [the driver runbook](../deploy/driver/README.md#no-spectator-row-no-client-can-draw-a-body-yet)
  says what else it would have to hold;
  [the dev runbook](../deploy/dev/README.md#offline-and-why-that-is-allowed-here) says
  what the lane holds now. The registry set a real client loads at the phase's finish
  is the body's, once (#598); whether it accepts the recording's other repeated frames
  is #268's. The body's own entity stream is what such a row has to witness.
- `O64` a claim lands on a body that is already standing, and a disconnect ends an
  unclaimed one (#261).
  O63 left the body standing with nobody driving it and two spectators on it. A
  thirteenth client reads the picker, picks that row and clicks `Claim`. Nothing is
  dialled: the body's session outlived its driver, so the claim lands on the state the
  body already has, the fake counts the one login it has had since O58, the client's
  play login arrives on the socket it already held, and the session is `attached`. The
  row the client read said `<address> - unclaimed, 2 watching`.

  That driver then leaves, which releases the claim with its connection, and the body
  is standing and unclaimed again: the session is `detached` and the front holds no
  claim on it. A fifteenth client reads the picker, picks that row, reads
  `<address> - unclaimed, 2 watching`, and clicks `Disconnect`. The body ends: the
  session goes `down` with no retry armed behind it, the backend leg closes, and the
  request is one `bodyDisconnected` line naming the client that asked. The run then
  waits past the session's own one-second delay and finds the fake's login count
  unchanged, so the body that ended was not dialled again.

  The two spectators are ended with the body, because a body that ends takes every
  channel on it. The client that asked stays: it is shown the list again, and the row it
  ended reads `<address> - down`. A sixteenth client joins once those channels are gone
  and reads the same row, unchanged, so the row is the body's state and not a count
  taken mid-teardown. The lane still serves that body, and `claimedBody` still names it,
  so the row is a body that is down rather than a server the lane forgot.

  A body that ended is a body a claim dials back, and that is the last thing the
  assertion proves. A seventeenth client reads the `down` row, clicks `Claim`, and the
  body's server takes its second login. The session leaves `down` through the same dial
  a cold lane uses, the client lands in the body, and the claim names that client.
  Without this a body a player ended would be gone until the lane restarted, and no rung
  would say so.

  What it cannot prove: a drop while a claim is held. O65 proves the other way into
  `down`, a fault while nobody claims the body. The claimed one needs the front to keep
  a client that is standing in a world whose backend has died, through a same-connection
  reconfiguration round that a fault starts rather than a server's transfer. O33 to O35
  and O38 to O41b prove such a round on a client's own socket, and they all start it with
  a server's transfer. None of them proves one a fault starts, and the machine has no
  give-up that puts a driver somewhere when the body cannot come back (#334). Today such
  a fault still ends the driver's connection: the claim buys the body a retry, and the
  driver rejoins to find it. What the claim buys is proven at the seam instead, in
  `test/service/body-lifecycle.test.js`: a claimed body faults, the retry fires, the body
  logs in again, and the claim is still the one on it.
- `O65` a body dropped while nobody claims it stays down (#261). O64 left the body
  attached to the client that claimed it back. That client leaves, which releases the
  claim, and the body is standing and unclaimed. A client reads the picker, picks that
  row and reads `<address> - unclaimed`. Then the body's own server drops its socket:
  the same path a dropped Paper connection takes.

  The session lands in `down` in one transition with no retry armed behind it, and the
  core's own record says why (`unclaimed: true`). The run then waits past the session's
  one-second delay and finds the fake's login count unchanged, so nothing dialled a body
  nobody claims. The same client asks for the same row again and reads
  `<address> - down`, which is the row's own word after the fault rather than a label
  cached from before it.

  A claim is what pays for a dial: the client clicks `Claim` on that row, the body's
  server takes its third login, and the client lands in the body it read as down.

  What it cannot prove: the claimed half of the pair. A claim is held by a client
  standing in the body, and keeping that client through the fault is #334.

- `O73` a spectator's own player is named by an entry carrying its own account's
  skin, and the entry naming the puppet carries the puppet's (#618). O65 leaves the body
  attached to the client that claimed it back, so there is a driven body to watch. The
  puppet's skin arrives the way `O52`'s frame does, through the body's own server, because
  the fake has no sender for `player_info`. The spectator's arrives the way a deployed
  lane's does: the front's `profiles` option, which is an offline lane's stand-in for the
  sessionserver's answer (`src/legs/live-front.js`).

  A client joins, lands on that body as its spectator, and both entries are read off its own
  socket: every entry naming the puppet carries the puppet's value, and the one naming the
  spectator carries its own account's value. The two values differ in value and signature,
  and each entry is held to its own value alone, so a frame carrying the wrong skin fails.
  That cross is what [#516](https://github.com/Bafbi/monoplayer/issues/516) introduced — a
  spectator's own body wearing the puppet's skin,
  [#614](https://github.com/Bafbi/monoplayer/issues/614)'s third item — and this is the row
  that fails if it comes back.

  What it cannot prove: that a real client draws either skin. A bot records no pixels, and
  the two real clients that could are the dev lane's run (#634). Nor is this the row that
  proves the addressing: a frame written to every channel of the body would land in the same
  array, so what is read here is what that socket received. The one-channel write is
  `deliverEach`'s in `src/legs/live-front.js`, and `test/service/spectate.test.js` pins the
  channel the entry is written on against the fake leg.

- `O76` a channel told about a spectator is told that spectator's own skin, and the entry
  naming the puppet keeps the puppet's (#685). `O73` read one socket for the body's entry and
  the spectator's own. This reads the half a second client needs: the entry that tells one
  channel about **another** client's body, which carried no property before this row and left
  a driver drawing every spectator in a vanilla default.

  `O65` leaves the body driven and `O73` leaves it unwatched, so two accounts land on it in
  turn. Each is supplied the properties its sessionserver answer would have carried, through
  the front's `profiles` option: the same stand-in `O73` uses.

  Two sockets are read: the driver's, which already holds the body, and the one that landed
  first. The driver's socket then carries three bodies and three skins. They are the puppet's,
  the first spectator's, and the second's, and every entry is held to its own player's value.
  An entry carrying another player's skin fails. The first spectator's socket carries the
  second one's entry with the second one's skin, and its own entry carries the value the
  driver's copy of that player carries.

  What it cannot prove: that a client draws it. Both halves are frames on a socket, and the
  rendering is the dev lane's witnessed row (#634, #685). Nor does it prove a *signed*
  property is required here: a client asks for one only for a player it does not control, and
  this rig's signatures are the fixtures' own, so the signature half is
  [skin-verdict.md](../testdata/skin-verdict.md)'s and a real client's.

- `O66` a lane with no list refuses a join in a sentence about the lane, and its offer
  says why the list is empty (#315). O61 proved the offer falls back to the seed when
  the live file cannot be parsed. This is the case with nothing behind it: both files
  the lane names are unparseable, so `control.allowedServers()` answers with no servers,
  the parser's own code (`not_json`), and the live file, because the live file is the
  first one an operator must repair (#372).

  A client joins and gets no dialog at all, because a dialog with no buttons is a phase
  with nothing on screen. It gets one sentence and a configuration `disconnect`:
  `Monoplayer: this lane is not offering any server to join.` The sentence is about the
  lane, because the client clicked nothing. The sentence it used to get named "that
  server", which is a choice the client never made and cannot make again.

  The operator's half is the offer's line. `pickerOffered` carries `reason`, `file` and
  `at` beside `source` and the count. All three are part of the answer the reader
  deduplicates on, so a cause, or a second entry to fix, is a second line. The refusal's
  own line carries the word the refusal map is keyed by (`empty_offer`), the offer's cause
  beside it in `offerReason`, and the sentence, so an operator reading the end of a log
  does not have to scroll back to the join.

  What it cannot prove: the words an absent or empty file answers with — `no_key`,
  `live_missing`, `empty_list`, `seed_missing` and `unreadable` — because this rig names
  both files and can only break them, and neither break leaves an entry to name.
  `test/service/control.test.js` proves each word and each entry, and
  `test/core/picker.test.js` proves both sentences.

- `O67` a second client on a lane with no picker is refused at its login, in words a
  player reads, before any configuration frame reaches it (#312). #269 deleted the
  front leg's attach slot, and that slot was also what refused a second connection at
  `beforeLogin`. Left to the attach, the only answer is the session's
  `already_attached` at `playerJoin`. By then the body's cached configuration frames
  have been replayed to a client that is about to be kicked. The rig runs the check on
  the main lane, which offers no picker, while O13's driver holds the body.

  A third whitelisted client joins, so nothing but the lane's shape can refuse it. It
  reads no login success and no configuration frame of any kind, and one `disconnect`
  in the login state, which is the only place a refusal this early can be told:
  `Monoplayer: another player is already driving this server. Try again when they leave.`
  The session is never asked, so the attach record stays where it was and no
  `already_attached` line exists for it. The core's `attachDenied` line carries
  `lane: no_picker` beside the reason and the sentence, because which lane shape said no
  is the fact an operator needs. The driver keeps the body: a refusal for the rival is
  nothing for them.

  The other half is `O60b`. A lane that offers a picker still lets a second client
  through its login, and the claim is what refuses it. That assertion also checks the
  rival's login success now. A refusal in the login decision that fired on a picker lane
  would fail there as an early `disconnect` rather than at the claim.

  What it cannot prove: the sentence a vanilla client draws. The client here is a
  protocol bot, and the words are read off the `disconnect` frame it decoded.

- `O68` a lane built by `createLoopbackLane` serves a client with the parts it was
  handed, then on one close ends its client, its sockets and the reconnect it armed, and leaves no
  timer armed (#594, #663).
  `createRig` (#223) ended the three sockets it opened and left every client and every
  timer to the assertion, which is why one rig's teardown is four lines in the rung's
  `finally` block and the file's teardown is one line per object. The factory is that
  owner, and it registers no call-in by hand, because the core applies its own table in
  `start()` (#592, `src/service/wire-leg-to-core.js`).

  This is a claim about the rung's own machinery rather than about the product, and it lives
  here because it needs two real sockets and a real client: `test/tooling/` owns the repo's
  claims about itself only where no socket is involved.

  This lane is built with a fake backend, a two-name whitelist, a wire check and a journal of
  its own in a temporary directory. One real protocol client joins it, reads its login, a
  position and the chunk batch, and the core attaches it. Then `close()` is called twice.

  The claim is read from the outside wherever the outside can answer. The kernel refuses a
  dial at both ports the lane held, so nothing of it is still listening. The client the lane
  opened reports its own end, so no teardown line names it. The front's own wire counters
  saw at least five frames and rejected none, and the journal holds `login` and `map_chunk`,
  so the wire check and the journal are wired and observed rather than wired and assumed.
  And the lane's clock holds no armed timer, and the timer it dropped is the reconnect: ending
  the backend leg is a backend fault, and a fault arms a reconnect backoff
  (`src/core/session.js:232`), so a lane that closes its legs and stops leaves a 1 s timer and a
  handle the process keeps until it fires. Any dropped timer is not the same claim (#663). The
  transfer-chain reset can be armed beside it, and the teardown clears that one, so a close that
  drops it alone proves nothing. `droppedReconnect` (`src/ladder/loopback-lane.js`) names the timer
  this assertion wants, and the rung asks for it by the delay the lane's own document gives. The
  evidence prints that delay beside the record's list of ids and delays. A core stopped with a
  transfer, a handover or a landed fault in flight still holds the chain timer, which is #697 and not
  this assertion. The second close returns the same record and
  does nothing, because the rung's `finally` block calls it unconditionally: a throw later
  in the run must not leave the lane to the hand-written list, and a close that already ran
  must not throw on the way out.

  The journal is the check's, never the run's. O52 reads the main rig's stream, and a second
  writer in that stream would be the evidence testifying for the thing under test.

  What it cannot prove: a picker lane, and a whitelist read from a control document. The
  factory wires both, and no assertion here drives either. It also cannot see a timer a leg
  arms outside the lane's clock, because that handle is the leg's; the ledger covers what
  the core arms. The factory names its two colliding parts after the glossary rather than
  after the ticket that proposed it: `fake` for the fake backend's options and `wire` for
  the wire check.

- `O69` a spectator is told the puppet as a body: an entity for its UUID with an id of the
  proxy's own, then a move that follows it, and no frame on the driver's socket names the
  puppet — the body that socket's client already controls (#635, and #636 for the name).

  The owner's report, twice from the live lane: the entry arrives and the world is empty.
  A client draws another player from a `player_info` entry *and* an entity for that UUID,
  and a Minecraft server never sends a client its own player entity, so the body's own
  stream holds no spawn for the puppet and nothing invented one. #614 gave every channel
  the entry; `src/core/virtual-players.js` gives every channel but the player's own the
  entity that goes with it.

  A fresh 26.2 client lands on the driven body through the front's own `spectate` seam,
  which is the call the Spectate verb makes. It registers its own listeners for
  `spawn_entity`, `entity_teleport` and `entity_destroy`, because the bot records frame
  names and not these packets. The driver's client registers one as well, and the
  assertion reads what it never receives about the puppet. #636 gives that socket the other
  channels' players, so the claim is the name and not the count: `O71` reads the rest.

  The spawn carries the puppet's UUID, the player entity type this rung's own protocol
  version states — the assertion reads it from the protocol data rather than from the
  module that wrote the frame, because a comparison against the writer's own constant
  cannot catch a wrong constant — and an entity id of the proxy's own from
  `FIRST_VIRTUAL_ENTITY_ID` upward, never the body's `login` id, which every client of the
  body already holds as itself. Then the body moves once and
  the spectator receives a teleport for that same id. The destroy count is zero, because
  nothing in this run replaces the world.

  The wait before the move is one coalescing window plus a margin, because a virtual
  player's move is coalesced to one frame per `MOVE_INTERVAL_MS` on the core's clock, and
  a rig binds that clock to the wall clock (`src/ladder/rig.js`).

  What it cannot prove: that a client draws the puppet. The bot speaks the wire and
  records no pixels, and a body's equipment, head rotation and metadata are not synthesized
  here at all — a spectator gets position and identity, not a held item. That half is the
  dev lane's [two-client proof](../deploy/dev/README.md#the-two-client-proof), with two real
  clients (#634).

  It also cannot read the entry that names the puppet before the spawn: this rig's fake
  backend never lists the puppet, so the proxy holds no skin and writes no entry, and the
  count is recorded in the evidence rather than asserted. That order is read in
  `test/service/virtual-players.test.js`, where the backend states a skin.

- `O71` the driver sees who is watching: an entry naming the spectator, then a body for it,
  then a move to where that client sent it, and the puppet's own connection is told nothing
  about it (#636).

  The owner's ask: *"making the claim client be able to see the spectator in a transparent
  way would be nice and also spectator between themself"*. `O70` read one socket's mode
  frames; this reads the driver's own socket for a player it never had a body for, and the
  body's other spectator is who the ask names.

  A client refuses a player-typed `spawn_entity` whose UUID it holds no `player_info` entry
  for — it logs "Server attempted to add player prior to adding player info" and adds no
  entity — so the entry is the condition of the body and not decoration on it. The
  assertion reads the pair's **order** on that socket: every clientbound frame is recorded
  in the order it arrived, the entry for the spectator's UUID is found in that list, and the
  frame after it is the spawn for the same UUID. A spawn with no entry, or an entry for one
  player beside a body for another, is an empty world with the right frames in it, which no
  count can see.

  The owner's second half — *spectator between themself* — is read on the other socket. The
  client that lands is drawn the watcher already on the body, entry and body both. Nothing
  on its own socket names the player it is itself: this rig supplies no properties for that
  client, so no entry carrying a skin is owed for its own player. `O73` is the row that
  supplies one, for that client's own channel, and `O76` is the row that supplies one for
  every other channel of the body.

  Then the second position source. The spectator's own client sends a position, the front
  drops the frame (#269) and hands the core the pose out of it, and the driver's copy of that
  player arrives at the coordinates that client sent. The move is read from the frames that
  arrive **after** the send: a client sends its own position unbidden, on the body's
  synchronize frame, so a move for that entity may already exist and the first one is not the
  one this row asked for.

  The backend half is the thing this ticket can break, and it is read at the fake rather than
  in the front's own counter, exactly as `O62` reads it: every counter the fake keeps —
  logins, positions, chats, commands, digs, places, settings — is unchanged across the
  spectator's landing and its movement, nothing was forwarded to the puppet's connection, and
  the client that watched keeps its own connection.

  What it cannot prove: that a client draws the other spectator. That is the dev lane's
  checklist, with two real clients (#634). This rig proves the frames, their order and their
  addressing, and a bot records no pixels.

- `O72` a landing writes a body's configuration through the one clientbound funnel: the frame
  the policy replays reaches the client, and the frame it refuses does not (#602).

  The front leg documents one funnel for a clientbound raw frame: `writeRawTo` in
  `src/legs/live-front.js`, which carries the per-socket checks and names them. #602 found
  three writers beside it, and a landing was one of them, so a body's configuration reached a
  client mid-phase with no policy check at all. The replay reader was the other half. It asked
  `decision !== 'block'`, and that admits the frames a connection owns and the dialog the
  human answers.

  The rig is this check's own because the body it lands is a hand-picked configuration rather
  than a cache, which is the point: the snapshot is one the leg cannot trust. A picker client
  joins, the leg lands it in that body, and the client's own frame list is the evidence: the
  ordinary frame the landing wrote is there, and neither the control dialog nor the blocked
  connection control is, in the whole connection and not only after the landing.

  The two refused frames are real frames of this version, so a client that received one would
  decode it rather than fail on it, and the row reads the frame and not a parse error.

  The funnel's own refusal of a blocked frame is not this row's to read, and it cannot be: the
  reader strips such a frame before the funnel sees it. That gate is
  `test/legs/config-landing-policy.test.js`, at the leg's raw entry, which is the write a landing
  makes. That the landing takes that write is the other half, and it is
  `test/legs/raw-funnel.test.js`: the guard reads `sendBodyConfiguration` on its own and finds the
  funnel there and nothing else. Those two together are #602's second criterion.

  What it cannot prove: that no other writer in the leg has a way past the funnel. That is
  `test/legs/raw-funnel.test.js`, which counts the call sites.

- `O74` a configuration frame offered after the phase finish is refused on the raw path, counted on
  the leg and named, and the client reads the landing's one copy and nothing else (#599).

  The phase's finish is the last configuration frame a client can parse. The client answers it and is
  in play from that moment, while this leg learns the answer only when the client's finish arrives, so
  a configuration frame written in between carries a configuration id into a connection that is
  reading the play table. #541 is that measurement, and the funnel's own comment names it.

  The rule is the interceptor's (`refusesAfterFinish` in `src/legs/live-front.js`), because the flag
  that says the phase's finish is on the wire is the interceptor's. The leg's raw funnel asks it
  instead of restating the condition, which was #599's half once #602 made that funnel the leg's only
  raw writer. A second statement of a condition is a second answer, and the pair agrees only until
  somebody edits one of them.

  The rig is O72's, one row on: the same picker client, landed for O72's count, and the frame offered
  in the window that landing opens, before the client's answer is parsed. The client's own frame list
  is the evidence on the other side, and the landing's `reset_chat` is the only one it ever reads.

  What it cannot prove: that no writer reaches `client.writeRaw` around the funnel. That is
  `test/legs/raw-funnel.test.js`, which counts the call sites.

- `O75` a packet object offered in a state the client cannot parse is refused by the leg, counted and
  named, and the phase-finish rule is not what refused it (#600).

  A packet object has no bytes, so the strict wire check has nothing to compare: it holds a name, a
  state and a buffer, and this write path has the first two. What it does have is the state. The
  library serializes the object with whatever state the client holds, so a frame written in a state
  the client is not in carries an id the client decodes as something else, with the rest of the frame
  left over. `writePacketTo` used to leave that case to the library's own writer, which refuses it
  for a different reason, the phase's finish, and only in the window that finish leaves open.
  `refuseStateMismatch` is the rule both writers ask now, and it counts the refusal and names the
  frame and the two states.

  The one configuration frame this leg authored as a packet object, the picker's server dialog, is
  encoded and written as a raw frame, as the picker's own dialog already was, so the wire check sees
  it. That is #600's other half, and `test/legs/packet-object-path.test.js` reads both halves: the
  dialog in `byState`, and a packet object refused in a state the client cannot parse.

  What it cannot prove: that no configuration frame comes this way. The state this path declares is
  the leg's own constant, so no caller can weaken it, but the leg cannot tell a configuration frame
  whose name it was handed from a play one. That is why the one configuration frame the leg authored
  here left for the funnel, and why `test/legs/raw-funnel.test.js` counts the writers.

- `O77` a lane with no rows to offer counts the refusal it records, so the map a cap is decided from
  moves with the line (#710, #670).

  #670 made the empty offer a counted refusal with a record of its own. O66 proves that record
  reaches a client's join; the count beside it was read by nothing, so a lane that kept writing
  `pickerEmpty` and stopped moving `front.pickerRefusalsByReason` would have stayed green. This is
  O66's empty lane and one more join on it, and both numbers are read as a delta around that join:
  the total (`pickerRefusals`) and the reason (`empty_offer`), each up by exactly one, beside
  exactly one new record carrying the word the map is keyed by.

  What it cannot prove: that the count is right on a lane that offers rows. A refusal is the only
  thing that moves it, and a lane with rows is every other picker assertion in the run and the total
  they leave behind.

  The leg's half of #710 is `test/legs/picker-ends.test.js`: the two dialogs the leg could not write
  and the lane with no rows, each driven at a real front leg with the record and the count read off
  one run.

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
| the gate Paper | `paper.monoplayer-gate-<instance>.svc.cluster.local:25565`, this worktree's lane | nothing is deployed | 26.2 | **unmet**: no proxy serves in front of it |

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

`mise run online` returns N1-N14. `evaluateOnlineAssertions` in
`src/ladder/online.js` is the source; the id list and the claim behind each id
live there.
- `N13` the state the attaching client decoded matches the state the attach
  replay claimed. The expectation is the cache snapshot taken when the replay was
  built, compared with the first K frames the client decoded, where K is the
  number of parity frames that replay sent. Live frames after them are ignored on
  both sides. N13 fails when those K frames never arrive (30 s bound), when the
  decoded names differ from the replay's names in order, or when any compared
  domain differs. The loopback's O27 checks the same cut on a real protocol bot.
  The cut is the core's own, published by `replaySnapshot` as the `attach` event
  (#683, `src/service/monoplayer.js`), so the rung records the values the replay
  used instead of taking a copy around the call. The rung reads that cut before
  N10's reattach, and `recordAttachCut` keeps it to the first event if a second
  ever lands (#934). A replay the core defers until the backend is warm is cut
  against the replay that then happened, which is the stream the client decoded;
  before #683 the rung recorded the state at the call and no frames. Neither rung
  attaches a client before its backend is warm, so neither reaches that case: the
  online rung waits for readiness before it builds its bot, and every loopback rig
  a client can attach a body to waits for readiness in `createRig` before the rung
  builds its client.
- `N14` the client information the bot reported reached the backend leg at the
  cap. The bot sends its own Client Information in the configuration phase. The
  packet the backend leg is handed at attach carries the reported `locale`,
  `skinParts`, and `mainHand`. Its view distance is the one the backend's own
  login advertised, never the bot's render distance. The bot's values differ from
  the protocol library's defaults on purpose: a frame carrying the defaults is the
  rung with the call-in declined, and N14 fails on it. It also fails when the core
  recorded no client information for the join, or when the client's own render
  distance crosses. O26 checks the same merge on a fake backend, and what the
  server then makes of a join is `mise run observer:run`'s question.

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

# Driver lane cluster environment

**Status (2026-11-09):** the G0 backend runs Paper 26.2 build 135, the version
the driver client and the dev lane already serve (#71). M4 stays on Paper 26.1.2
build 74 behind Velocity 4.3.1 build 45 until its own move: no rung drives it.

**Status (2026-11-07):** G0 and G1 pass. Paper 26.1.2 build 74 ran
directly for G0, and Velocity 4.3.1 build 45 is now in front of Paper 26.1.2
build 74 for M4; the authenticated puppet joined through the proxy as
`GlowSquidye`. Toxiproxy is running; fault rows are pending. The Fabric driver
lane passed **2/2** consecutive runs and the unmodded witness is completed.
Evidence: [docs/driver-lane.md](../../docs/driver-lane.md),
[docs/custody.md](../../docs/custody.md), [docs/paper-behind-velocity.md](../../docs/paper-behind-velocity.md),
and [docs/driver-validation.md](../../docs/driver-validation.md).

A lane holds the real-backend matrix: its own namespace, one per worktree, named
after the worktree that asked for it. It is not the product namespace. Do not point
the product at it.

## Lifecycle: the lane rests at 0

Every Deployment here commits `replicas: 0`, so the tree describes a lane that is
off. A bare `kubectl apply -k deploy/driver` wakes nothing, and it stops whatever was
awake, because an apply reconciles every row to the tree (#115). `gate:up` is the only
command that should apply. These tasks own the count:

```bash
mise run gate:up      # apply, wake paper and paper-conduct, wait for ready
mise run gate:down    # scale all five to 0, wait for their pods to go
mise run gate:status  # what the lane runs, and what is ready
```

`gate:up` waits up to 900 s and says so before it waits. A cold start is 90 s, measured
on the 26.2 gate Paper: every gate world is an `emptyDir`, so the world died with its
pod, and Paper downloads its server and writes a flat one again. The 240-310 s in
[docs/testing-ladder.md](../../docs/testing-ladder.md) is the other wait, a Paper that
is already up and restarts with the observer plugin, and `observer:run` owns it.

`gate:down` deletes the Secrets `gate:up` generated, so a stopped lane leaves no value
behind. The Deployments, the Services, the ConfigMaps and every operator's Secret
survive, and the next `up` costs the same cold start and nothing else.

`gate:up` wakes `paper` and `paper-conduct`, the two rows a rung drives. Name the
others to wake them: `mise run gate:up -- velocity paper-m4 toxiproxy`. A row that
was already awake is woken again after the apply, so a second `up` for a different
row does not leave the first stopped. `gate:down` stops all five, and rows wake by name. No rung drives
those three, which is why they stay off.

`scripts/gate-lane.sh` is the script behind the tasks. `MONOPLAYER_GATE_POLL` sets the
interval between checks, and the two waits are `MONOPLAYER_GATE_READY_TIMEOUT` and
`MONOPLAYER_GATE_STOP_TIMEOUT`.

## Lanes: one per worktree, named by derivation

A lane is named after the worktree that asked for it: the worktree's short commit,
then a short hash of its path. Two checkouts at one commit are two lanes, so two
agents can validate at the same time, and nobody types an instance.

```bash
scripts/gate-lane.sh name      # this worktree's lane, and nothing else
mise run lanes                # every lane: its age, its pods, and its worktree
mise run lanes -- --reap      # delete the lanes idle past the window
```

`name` prints one line, and every rung reads it. `mise run online:cluster` names
this lane in its lease and dials its Paper (#301). `mise run observer:run` decides its
lane after its arguments, so `--namespace` and the variable are the same decision
(#282). `mise run driver:scenario` resolves the address it joins and the RCON target
it administers from the same name (#282). So no rung needs the variable:

```bash
mise run online:cluster
mise run observer:run
mise run driver:scenario
```

`src/driver/lane.js` is the driver's reader, and it asks `scripts/gate-lane.sh name`.
`--server` and `--rcon-namespace` remain per-run overrides for a caller that knows a
better address; they are not a second way to choose a lane. A run that names
`GATEB_RCON_NAMESPACE` (or `--rcon-namespace`) and leaves the join address to this
worktree stops instead, because it would join one lane's Paper and administer another
lane's Deployments. `--server` naming another lane's Paper while RCON stays on this
one is the same refusal. Pass the other flag too when that is what you mean: the pair
is the caller's once it names both. A tunnel or a port-forward is an address and not a
lane, so it never disagrees.
`MONOPLAYER_GATE_NAMESPACE` names a lane for every rung at once.

That is the task's own command with the lane named. One run at a time on the
display host: the rung relaunches one Prism instance over SSH and drives its
keyboard, so a second run would drive one client.

`mise run lanes` is what makes a crashed run visible instead of invisible. One
row per lane: the namespace, how long since it last ran `up` or `down`, its pod
count, and the worktree that owns it.

```
LANE                                   AGE     PODS  WORKTREE
monoplayer-gate-6098a9f-3f1c2a         3h12m   0     /home/me/src/monoplayer
monoplayer-gate-0a1b2c3-77d1e0         12m     2     /home/me/worktrees/t3-9f2
monoplayer-gate-b                      ?       0     transfer testbed
```

The last row is the transfer testbed's namespace: the one namespace in that listing that
no worktree derives, and not a gate lane. No `up` or `down` here writes its clock, so its
age is `?`, and it never reaps: see the conditions below (#318).

`up` and `down` write three annotations on the namespace: the worktree, the
commit, and an epoch that `lanes` reads as the age. `up` fails when it cannot write
them, because a lane nobody can find is worse than a lane that did not wake.

A commit moves a worktree to a new lane, and the lane it left keeps its old name.
`mise run lanes` shows it with its worktree, and the reaper is what cleans it up.
Before the first `up` on a new lane, `gate:status` says the lane does not exist,
and `gate:down` says there is nothing to stop.

The reaper deletes a namespace, so it is hard to satisfy on purpose. A lane is
reaped only when all of these hold:

- no pod runs in it, whatever its age
- every Deployment in it is one the gate tree declares, so a lane holding the
  transfer testbed's `paper-hub` or `paper-sky` is kept. This is read first, and the
  reason printed is the first one that keeps the lane: a namespace holding a row this
  tree does not declare is not this script's lane to date, so an undated or young one
  reaches the check too
- it carries the clock `up` wrote, so its age is known
- it has been idle past the window: `MONOPLAYER_GATE_IDLE_WINDOW` seconds, six
  hours by default, or `--window SECONDS` for one run
- it is not the transfer testbed's namespace. `monoplayer-gate-b` is fixed, every
  worktree shares it, and nothing here recreates it or its two hand-made Secrets, so
  the name is refused even once the `paper-hub` and `paper-sky` rows are gone (#318)
- every Secret in it was made by this script, so an operator's Secret is kept

Deletion is asynchronous. `--reap` asks the API to delete the namespace. The next
listing shows that lane as `(deleting)` until its objects are gone.

The live namespace and the dev lane are out of reach at every step. `lanes` reads
a label only a gate lane carries, `app.kubernetes.io/component: gate-lane`, and it
passes every candidate through the same guard `up` and `down` use. The testbed's
`monoplayer-gate-b` carries that label too, because `deploy/testbed/namespace.yaml`
writes it: the listing shows it, and the conditions above are what keep it.

## One tree, one lane, one value

The tree in this directory is a **template**, not a lane. Wherever it names a lane it
spells `gate-__instance__`: the namespace object, every
`app.kubernetes.io/name` label and selector, the Secret and ConfigMap names,
the two tailnet hostnames, and one path inside `velocity.toml`. One substitution
reaches all of them, which is why a lane's names cannot disagree with the label
`status` and `down` look pods up by.

The placeholder is not a valid object name, so this directory cannot be applied as
it is. That is the point: a lane exists only through `scripts/gate-lane.sh`. A tree
that spelled a lane would apply that lane whoever ran it.

To read what a lane would apply, without a cluster:

```bash
scripts/gate-lane.sh render /tmp/my-lane   # an empty directory you own
kubectl kustomize /tmp/my-lane
```

`MONOPLAYER_GATE_NAMESPACE` pins the namespace by hand, and the instance is what
follows `monoplayer-gate-`. `MONOPLAYER_GATE_WORKTREE` derives the lane from
another checkout's commit and path. Neither is needed on an ordinary run.

The instance must be a DNS-1123 label, because it names a namespace and part of a
label value. It is at most 33 characters, which keeps the longest label value this
lane writes, `app.kubernetes.io/name: monoplayer-gate-<instance>-paper-conduct`, inside
63.

The namespace's own `monoplayer.eu/environment: gate-<instance>` label follows the
instance too. Nothing selects on it. It is a label for a human reading
`kubectl get namespace`, and leaving it at an old name in a lane called something
else is the kind of stale name the ADR exists to avoid.

Two boundaries to keep in mind.

The lane makes its own Secrets. `gate:up` creates `gate-<instance>-rcon` (key
`password`) and `gate-<instance>-velocity` (key `forwarding-secret`) with random
values when they are absent. It creates only the ones the rows it wakes read. The
three Papers read the RCON password, and Velocity and the Paper behind it read the
forwarding secret. `gate:down` deletes the Secrets this lane generated, and only
those.

`gate:up` uses an operator's Secret as it is, whatever wrote it. This script never
overwrites one, and `gate:up` says once per run which ones it found. A generated
Secret carries the label `app.kubernetes.io/managed-by: gate-lane`. `gate:down`
deletes by that label, and an operator's Secret carries none, so it survives every
`down`. To make a lane generate new Secrets, delete the old ones and run
`gate:up`.

`paper-hub` and `paper-sky` from `deploy/testbed` are tenants of a gate namespace. They
belong to the transfer testbed: nothing here scales them, and a lane on another
instance does not take them with it. They are also why the reaper keeps
`monoplayer-gate-b`, the one namespace the listing names that no worktree derives (#318).
Both read that namespace's
`gate-<instance>-rcon`, so a `gate:down` that removes a generated one leaves them
without one until the next `gate:up`. The testbed owns its own Secret, not this lane
(#283, #288).

## Names this tree does not rename

Renaming these would recreate live cluster objects or break the display host,
so the tree moved to `deploy/driver/` and left them alone. Each migrates when
the next change touches the area that reads it; the decision and the full list
are in
[external-names-migrate-with-their-owner.md](../../docs/adr/external-names-migrate-with-their-owner.md).
Each needs its own migration step:

| Name | Where it lives | Migration |
|---|---|---|
| server motd `Monoplayer Gate B` | `velocity.yaml` | a config value players see |
| Prism instances `gate-b-player`, `gate-b-player-fabric` | display host | clone into a new instance id |
| `GATEB_*` environment variables, `gateb.*` JVM properties, window title `Monoplayer Gate B` | operator shell, launch flags, Hyprland rule | rename together, in one operator run |

The namespace, the labels, the Secrets and the two tailnet hostnames are derived
now, which is what #277, #278, #279 and #282 did. The tree spells a placeholder, and
one instance names all of them. Every row left in the table still migrates by hand,
when the change that reads it arrives. The examples in `tools/driver/` still print
the lane that shipped; a run that joins its own lane passes `-s`.

## Paper G0 backend

This is the first row: a plain Paper 26.2 server the official client can
join directly. It is deliberately ephemeral (`emptyDir`), online-mode, and
secure-profile. The RCON password is a cluster Secret, never a manifest value.

```bash
# 1. Apply the tree, generate the lane's Secrets and wake the backend. The task says
#    what it waits for, and a cold start is 90 s.
mise run gate:up

# 2. Watch it download Paper 26.2 and boot.
kubectl -n "$(scripts/gate-lane.sh name)" logs deploy/paper --tail=100

# 3. Tailscale endpoint for the display host.
kubectl -n "$(scripts/gate-lane.sh name)" get svc paper-g0 -w
```

The Tailscale service should publish a hostname like
`monoplayer-gate-<instance>-paper.tail41e568.ts.net:25565`, where the instance is
what `scripts/gate-lane.sh name` prints. Join that address from the 26.2 Prism
instance for G0.

## Notes

- `EULA=TRUE` is the operator's acceptance of the Minecraft EULA for this
  throwaway test backend.
- `ENFORCE_WHITELIST=FALSE` is only for the host-readiness row. G0's real
  rows use the puppet-only backend whitelist and the separate attach whitelist.
- The world is `emptyDir`; deleting the pod resets it, and `gate:down` deletes every
  pod. Restart/persistence rows will need a StatefulSet + PVC before they are
  meaningful.
- RCON is exposed only on the ClusterIP Service, never the Tailscale Service.
- This namespace is not in ArgoCD. It is a test lane.

## Observer lane: Paper 26.2 b135 with the code of conduct on

`paper-conduct.yaml` is the backend `mise run observer:run` measures (#78). It
runs the same image, version and build as `paper.yaml`, with
`enable-code-of-conduct=true` and one document in a `codeofconduct` folder, so
the server sends the gate and the observer can see the accept arrive on the
account's own connection. The G0 row cannot carry the gate: a real client that
lands on a code-of-conduct screen never finishes joining, and rung 4 is a
human-witnessed run. Paper refuses to start with the gate on and no document, so
the folder is part of the lane, written by an initContainer.

```bash
mise run gate:up paper-conduct
kubectl -n "$(scripts/gate-lane.sh name)" logs deploy/paper-conduct --tail=100
```

## No spectator row: this lane serves no body

#325 asks for a row in which two real clients reach one body. One claims it, the other
watches it in spectator mode, and the watching client's report records what that client
read. This tree serves no body, so the row cannot run here. Nothing in the driver is what
stops it.

A spectator is the product's, not a server's. The Spectate verb is the picker's
(`src/core/picker.js:37,39`), and the claim is the front's own registry
(`src/core/claims.js:1-17`). The two frames that tell a spectator what it is are written
by the service (`src/service/monoplayer.js:2402,2406`). A client that joins this lane's
Paper reaches Paper and never a picker. The tree declares no product row
(`deploy/driver/kustomization.yaml:8-14`), and the ladder already says no proxy stands in
front of the gate Paper.

The product's half is built and proven against fakes, so no server-side piece is missing
except a lane to serve it. `test/service/spectate.test.js` covers a spectator beside a
pilot. The loopback rung's O60 to O63 drive the same path with protocol bots.

Four things would have to hold. Each one is a change this lane does not have.

1. **A front on the lane, serving a picker.** The picker is off by default
   (`src/service/monoplayer.js:156`), and no manifest under `deploy/` sets
   `MONOPLAYER_PICKER`. So no lane this repo deploys has ever offered a claim.
2. **A puppet token chain for that front.** The service builds live legs only
   (`src/service/start-live.js:452,492`), and the backend leg refuses to start without an
   account directory (`src/legs/live-backend.js:695`). The offline legs belong to the
   loopback rungs, and they refuse any host but loopback
   (`src/legs/live-backend.js:801`, `src/legs/live-front.js:2308`). The cluster holds
   two chains, the live deployment's (`deploy/manifests/pvc.yaml`) and the dev lane's
   (`deploy/dev/custody.yaml`). Each one has one writer, and a third has no bootstrap
   path this lane owns.
3. **Two clients.** A run launches one Prism instance as one account
   (`src/driver/run.js:346-357`), and the mod binds one socket on one port
   (`tools/driver/src/main/java/eu/monoplayer/driver/DriverMod.java:10`). The port is a
   JVM property, so two clients can be made to differ. The launch command passes none, and
   a second client cannot bind it while a first holds it (`src/driver/parity.js:353`).
   One account cannot serve both clients either, because a second login to one server
   disconnects the first (`docs/custody.md:111`). That is why every driver run so far is
   sequential (`src/driver/parity.js:87`). A second client needs a second instance, a
   second drive port, a second window title, and a second premium account, all set on the
   display host.
4. **A way to read the claims list from outside the process.** The loopback rung reads
   `pickerFront.claims` in the process that serves the picker
   (`src/ladder/loopback.js:3027`). A deployed front reads out nowhere a rung can see. No
   metric, no log record, and no panel route carries a claim. This is the weakest of the
   four, because it is about measuring the claim rather than making one.

The driver's own half is unbuilt too. The mod reports no game mode and no abilities, so
"spectator mode, as the client read it" has no reader yet. `status` in
`tools/driver/src/main/java/eu/monoplayer/driver/DriverServer.java:227` is where that
reading and the report field it feeds would go. The picker's own buttons are already
reachable through the driver's `click` op.

Two narrower rows were considered and rejected. A protocol bot driving the body would
measure a bot where the row exists to witness two real clients. Reading the spectator's
frames instead of drawing them is what O62 and O63 already do. Neither is a substitute
for this one.

The row belongs on a lane that serves a picker, and neither lane that could does. The dev
lane sets no `MONOPLAYER_PICKER`, and the live lane is not a target for an automated join.
#336 carries the lane work, and #337 the two-client harness and the spectator reading.

## M4 lane — Paper behind Velocity 4.3.1 (+ toxiproxy)

Second backend row per [docs/paper-behind-velocity.md](../../docs/paper-behind-velocity.md).
It keeps Paper 26.1.2 build 74: moving it needs Velocity to accept protocol 776,
which is its own run.
`velocity.yaml` (Velocity 4.3.1 b45, online-mode, modern forwarding),
`paper-m4.yaml` (Paper 26.1.2 b74, offline, puppet-only whitelist),
`toxiproxy.yaml` (puppet-leg faults). Full bring-up, smoke and teardown
commands (and the `gate-<instance>-velocity` forwarding secret, which `gate:up`
generates when it is absent and no manifest ever holds) are in the M4 runbook:

```bash
# The three M4 rows, awake together. `gate:up` creates the two Secrets the rows read
# when they are absent, and `mise run gate:down` puts the rows back and removes them.
mise run gate:up -- velocity paper-m4 toxiproxy
```

Offline validation of the manifests without touching the cluster. The tree holds
a placeholder, so it is rendered first, and the render is what a lane applies:

```bash
scripts/gate-lane.sh render /tmp/my-lane   # an empty directory you own
kubectl kustomize /tmp/my-lane > /tmp/driver.yaml
kubectl apply -k /tmp/my-lane --dry-run=client
```

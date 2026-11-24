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

The `monoplayer-gate-b` namespace holds the real-backend matrix. It is not the
product namespace; do not point the product at it.

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

`gate:down` deletes nothing, so the Deployments, the Services, the ConfigMaps and the
hand-created Secrets survive. The next `up` costs the same cold start and nothing else.

`gate:up` wakes `paper` and `paper-conduct`, the two rows a rung drives. Name the
others to wake them: `mise run gate:up -- velocity paper-m4 toxiproxy`. A row that
was already awake is woken again after the apply, so a second `up` for a different
row does not leave the first stopped. `gate:down` stops all five, and rows wake by name. No rung drives
those three, which is why they stay off.

`scripts/gate-lane.sh` is the script behind the tasks. `MONOPLAYER_GATE_POLL` sets the
interval between checks, and the two waits are `MONOPLAYER_GATE_READY_TIMEOUT` and
`MONOPLAYER_GATE_STOP_TIMEOUT`.

## One tree, one lane, one value

The tree in this directory is a **template**, not a lane. It spells today's lane,
`monoplayer-gate-b`, everywhere the lane is named. That covers the namespace object,
every `app.kubernetes.io/name` label and selector, the Secret and ConfigMap names,
the two tailnet hostnames, and one path inside `velocity.toml`.

`MONOPLAYER_GATE_NAMESPACE` names the lane. The instance is what follows
`monoplayer-gate-`. `gate:up` copies the tree, substitutes the instance, and applies
that copy.

So one rename reaches every one of those places. The label that `gate:status` and
`gate:down` look pods up by comes from the same value, so it cannot disagree with
the manifests.

Instance `b` is today's lane, and the substitution is then the empty one: an ordinary
`gate:up` applies byte for byte what this directory holds, which
`test/tooling/gate-lane.test.js` pins. To read what another lane would apply:

```bash
scripts/gate-lane.sh render /tmp/gate-x    # with MONOPLAYER_GATE_NAMESPACE=monoplayer-gate-x
kubectl kustomize /tmp/gate-x
```

The instance must be a DNS-1123 label, because it names a namespace and part of a
label value.

Two boundaries to keep in mind.

The lane's Secrets are still made by an operator. A render asks for
`gate-<instance>-rcon` and `gate-<instance>-velocity`, so `gate:up` refuses a lane on
another instance until those exist. #278 generates them, and the names already match.

`paper-hub` and `paper-sky` from `deploy/testbed` live in `monoplayer-gate-b` beside
this lane. They belong to the transfer testbed. A lane on another instance does not
take them with it, and nothing here scales them.

## Names this tree does not rename

Renaming these would recreate live cluster objects or break the display host,
so the tree moved to `deploy/driver/` and left them alone. Each migrates when
the next change touches the area that reads it; the decision and the full list
are in
[external-names-migrate-with-their-owner.md](../../docs/adr/external-names-migrate-with-their-owner.md).
Each needs its own migration step:

| Name | Where it lives | Migration |
|---|---|---|
| namespace `monoplayer-gate-b` | every manifest here | create the new namespace, re-apply, delete the old |
| labels `app.kubernetes.io/name: monoplayer-gate-b-*` | every manifest here | selector change: recreate the workloads |
| Secrets `gate-b-rcon`, `gate-b-velocity` | cluster only | copy the value into the new Secret |
| Tailscale hostnames `monoplayer-gate-b-paper`, `-velocity` | Services with annotations | republish under a new hostname |
| server motd `Monoplayer Gate B` | `velocity.yaml` | a config value players see |
| Prism instances `gate-b-player`, `gate-b-player-fabric` | display host | clone into a new instance id |
| `GATEB_*` environment variables, `gateb.*` JVM properties, window title `Monoplayer Gate B` | operator shell, launch flags, Hyprland rule | rename together, in one operator run |

The first two rows are now derived. Naming another instance in
`MONOPLAYER_GATE_NAMESPACE` moves the namespace and the label prefix together, which
is what #277 added ("One tree, one lane, one value" above). Every other row still
migrates by hand, when the change that reads it arrives.

## Paper G0 backend

This is the first row: a plain Paper 26.2 server the official client can
join directly. It is deliberately ephemeral (`emptyDir`), online-mode, and
secure-profile. The RCON password is a cluster Secret, never a manifest value.

```bash
# 1. Namespace + workload. The Secret must exist first.
kubectl create namespace monoplayer-gate-b --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monoplayer-gate-b create secret generic gate-b-rcon \
  --from-literal=password="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# For the M4 lane, also create gate-b-velocity (see the M4 section) before
# step 2, or the velocity/paper-m4 pods will fail with
# CreateContainerConfigError.

# 2. Apply the tree and wake the backend. The task says what it waits for, and a
#    cold start is 90 s.
mise run gate:up

# 3. Watch it download Paper 26.2 and boot.
kubectl -n monoplayer-gate-b logs deploy/paper --tail=100

# 4. Tailscale endpoint for the display host.
kubectl -n monoplayer-gate-b get svc paper-g0 -w
```

The Tailscale service should publish a hostname like
`monoplayer-gate-b-paper.tail41e568.ts.net:25565`. Join that address from the
26.2 Prism instance for G0.

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
kubectl -n monoplayer-gate-b logs deploy/paper-conduct --tail=100
```

## M4 lane — Paper behind Velocity 4.3.1 (+ toxiproxy)

Second backend row per [docs/paper-behind-velocity.md](../../docs/paper-behind-velocity.md).
It keeps Paper 26.1.2 build 74: moving it needs Velocity to accept protocol 776,
which is its own run.
`velocity.yaml` (Velocity 4.3.1 b45, online-mode, modern forwarding),
`paper-m4.yaml` (Paper 26.1.2 b74, offline, puppet-only whitelist),
`toxiproxy.yaml` (puppet-leg faults). Full bring-up, smoke and teardown
commands (including the `gate-b-velocity` forwarding-secret, which is created
by `kubectl` and never committed) are in the M4 runbook:

```bash
# Secret (operator, once). VALUES NEVER GO INTO GIT OR THE MANIFESTS.
kubectl -n monoplayer-gate-b create secret generic gate-b-velocity \
  --from-literal=forwarding-secret="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# The three M4 rows, awake together. `mise run gate:down` puts them back.
mise run gate:up -- velocity paper-m4 toxiproxy
```

Offline validation of the manifests without touching the cluster:

```bash
kubectl kustomize deploy/driver > /tmp/driver.yaml
kubectl apply -k deploy/driver --dry-run=client
```

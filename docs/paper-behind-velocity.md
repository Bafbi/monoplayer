# Paper behind Velocity runbook — and the puppet-leg fault rig

This is the runbook for the **M4 network-plumbing slice**: Paper 26.1.2 b74
(offline, puppet-only whitelist) behind **Velocity 4.3.1 build 45** (online
mode, modern forwarding, force-key-authentication), plus **Toxiproxy 2.13.0**
for the puppet-leg fault shapes. It is the pass path for row **M4** and
the rig for row **M5** (faults). Monoplayer itself is out of scope here.

Scope split, so nothing is doubled by another workstream:

- This slice ships manifests (`deploy/driver/velocity.yaml`,
  `paper-m4.yaml`, `toxiproxy.yaml`), the pure adapters
  (`src/driver/backends.js`, `toxiproxy.js`, `logins.js`), their unit tests,
  and this runbook. It **never applies** anything to the cluster and **never
  commits a secret** — the apply steps below are operator steps.
- **Still owned elsewhere:** the Monoplayer deployment itself; the M1
  (Vanilla) and M3 (Fabric) backend manifests; the B-lane runner that turns
  `src/driver/backends.js` + `logins.js` into `backendLogins=1` verdicts
  (docs/driver-lane-plan.md, criteria B1–B6).

## Pins

| Thing | Pin | Evidence |
|---|---|---|
| Velocity | 4.3.1 **build 45** (2026-10-27, release channel) | `fill-data.papermc.io` object `velocity-4.3.1-45.jar`, sha-256 `0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75` |
| Velocity image | `itzg/mc-proxy:java25` (`TYPE=VELOCITY`, `VELOCITY_VERSION=4.3.1`, `VELOCITY_BUILD_ID=45`) | Java 25 required; matches the repo's itzg usage |
| Velocity `velocity.toml` | config-version 2.9 (from the PaperMC/Velocity v4.3.1 default) | bind 25566; `player-info-forwarding-mode="modern"`; secret from a file mount |
| Backend Paper | 26.1.2 build 74 (same as G0) | existing `paper.yaml` pin |
| Toxiproxy | `ghcr.io/shopify/toxiproxy:2.13.0` | 2026-10-14 release |
| itzg backend image | `itzg/minecraft-server:2026.10.1-java25` | same pin as the G0 pod |

**Digest pinning note.** Manifests pin tags, not digests (the itzg images get
re-tagged upstream, and velocity's jar is fetched at pod start — its *jar* is
the real pin, and the fill-data object id above is its sha-256). Before any
lane outlives the gate: `docker buildx imagetools inspect itzg/mc-proxy:java25`
and `crane digest ghcr.io/shopify/toxiproxy:2.13.0`, then switch the manifests
to `image@sha256:<digest>`.

## Secrets (never committed)

Two secrets; only `gate-b-velocity` is new. The RCON secret already exists
from G0.

```bash
# forwarding secret shared by Velocity and the Paper backend.
# Created by kubectl; the value lives in the cluster only.
kubectl -n monoplayer-gate-b create secret generic gate-b-velocity \
  --from-literal=forwarding-secret="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# gate-b-rcon: only if it does not exist yet (G0 step, unchanged):
kubectl -n monoplayer-gate-b create secret generic gate-b-rcon \
  --from-literal=password="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

How the secret travels without landing in a ConfigMap:

- Velocity: secret mounted as a file and referenced by an absolute path
  (`velocity.toml` → `forwarding-secret-file=/run/secrets/gate-b-velocity/forwarding-secret`).
- Paper backend: the official `PAPER_VELOCITY_SECRET` environment override
  (docs.papermc.io/paper/reference/system-properties, Paper PR #10127).

## Sequential bring-up: M4 → M1 → M3 → toxiproxy faults

Do these in order. Each stage gates the next; every stage ends in smoke
evidence that lives in the run transcript.

### Stage 1 — M4 (this slice)

Validate offline first (no cluster writes):

```bash
kubectl kustomize deploy/driver > /tmp/driver.yaml
kubectl apply -k deploy/driver --dry-run=client
kubectl apply -k deploy/driver --dry-run=client --validate=false   # schema-free pass
```

Operator wakes the three rows and waits. The task applies the tree, scales these
three to 1, and says how long it waits before it waits (#115):

```bash
mise run gate:up -- velocity paper-m4 toxiproxy

kubectl -n monoplayer-gate-b logs deploy/paper-m4 --tail=100 | grep -E "proxies.velocity|Done"
kubectl -n monoplayer-gate-b logs deploy/velocity --tail=50
```

`mise run gate:down` puts them back to sleep. Every gate world is an `emptyDir`,
so a `down` costs the next `up` a full cold start: 90 s, measured on the 26.2 gate
Paper.

**Forwarding checkpoint (the one Paper-side risk):** the pre-seeded partial
`paper-global.yml` only sets `proxies.velocity.enabled/online-mode`; the
secret comes from the env override. If Paper logs the Velocity-support error
(no secret found → forwarding disabled), the env path is broken on this build:
fall back by patching the ConfigMap in-cluster to add
`proxies.velocity.secret: '<forwarding secret>'` (operator action, recorded in
the transcript, the value still never goes into git) and
`kubectl -n monoplayer-gate-b rollout restart deploy/paper-m4`. Do not
silently ignore this checkpoint.

SLP smoke (server list ping must answer from Velocity; nothing joins yet):

```bash
# From the display host (nath) with the repo's node deps — pure SLP, no login:
node -e '
import("minecraft-protocol").then(mc => {
  mc.ping({ host: process.argv[1], port: 25565, version: "26.1" }, (err, r) => {
    if (err) { console.error("SLP failed:", err.message); process.exit(1) }
    console.log("SLP ok:", r.description ?? r.motd)
  })
})' monoplayer-gate-b-velocity.tail41e568.ts.net
```

`kubectl -n monoplayer-gate-b get svc velocity-m4` publishes the Tailscale
hostname (pre-Monoplayer only). Then the **login smoke**, run manually on
`nath` with the Bafbi/Prism client (this is what G0 already proved bare-metal):
join `monoplayer-gate-b-velocity.tail41e568.ts.net:25565`, render, move,
disconnect. Evidence:

```bash
# exactly ONE backend login for the whole smoke — the future backendLogins=1
kubectl -n monoplayer-gate-b exec deploy/paper-m4 -- rcon-cli list
kubectl -n monoplayer-gate-b logs deploy/paper-m4 | grep -E "logged in with entity id|joined the game"
# Bafbi/Velocity must appear on the backend, the backend must NOT show
# Velocity as a player name, and a *second* join after reconnect must add a
# *second* login line — which on the B-lane becomes part of the invariant.
kubectl -n monoplayer-gate-b logs deploy/velocity | grep -E "joined|connected" 
```

Note Velocity's `login-ratelimit = 3000`: a quit-rejoin inside 3 s is
rate-limited by design; the driver lane is always quit + relaunch, which
exceeds it.

**Whitelist caveat (check it once, record it):** the backend is offline-mode,
so itzg's `WHITELIST=GlowSquidye` may register the offline UUID while modern
forwarding presents the online profile. Verify with
`rcon-cli whitelist list` after the first puppet join; if a join is rejected
as "not whitelisted", re-add via `rcon-cli whitelist add GlowSquidye`
(behind Velocity the backend resolves the forwarded profile) and `whitelist
on`, and record the correction in the report. Backend-only: the player
account (Bafbi) must stay **off** this whitelist.

### Stage 2 — M1 Vanilla (other workstream)

Vanilla 26.1.2 direct row (parity backend). Its manifests and its
`vanilla:25565` Service belong to the M1 workstream; this namespace and the
whitelist/world pins (flat, seed 775, RD/SD 4, offline for the
Monoplayer lane) are already the contract in `src/driver/backends.js`
(`vanilla`, status `planned`). When it deploys, its listener lands with it: add
`puppet-vanilla` on 25571 to `deploy/driver/toxiproxy.yaml`, together with
its containerPort and its Service port (#115), then run the same SLP + login
smoke against `vanilla:25565` through that listener.

### Stage 3 — M3 Fabric (other workstream)

Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 compatibility row. Same pattern:
its manifest owner ships `fabric:25565` and adds the `puppet-fabric` listener
on 25572 with it; smoke, **report-only** (a Fabric failure is a compatibility
finding, not a gate failure).

### Stage 4 — Toxiproxy fault rig (this slice, wire-up)

`puppet-velocity` is the only listener the ConfigMap declares, and it is on
from the pod start. `puppet-paper-m4` ships with it, disabled, for the direct
row. A row with no backend in this tree has no listener (#115). The image has
no enable verb in `toxiproxy-cli`; flip listeners via the HTTP API
(ClusterIP-only, reachable from inside the namespace):

```bash
kubectl -n monoplayer-gate-b run toxiproxy-curl --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  -- -s -X POST -H 'content-type: application/json' \
       -d '{"enabled":true}' http://toxiproxy-api:8474/proxies/puppet-paper-m4

# state (jq-free; the API answers JSON):
kubectl -n monoplayer-gate-b run toxiproxy-curl --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  -- -s http://toxiproxy-api:8474/proxies

# nuke-switch: /reset re-enables everything AND clears all toxics (between
# fault reps the B-lane runner should prefer it over hand-cleanup):
kubectl -n monoplayer-gate-b run toxiproxy-curl --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  -- -s -X POST -d '{}' http://toxiproxy-api:8474/reset
```

`/reset` also **enables every proxy**, including `puppet-paper-m4`. After a
reset, re-disable the listeners that are not part of the current row (the
B-lane runner should call `setProxyEnabled`/`assertProxyEnabled`) before
continuing.

The B-lane runner uses `src/driver/toxiproxy.js` for the same three verbs plus
toxic add/remove with injected fetch; runbook curls are the human fallback.

Fault **shapes** for M5 live in `src/driver/toxiproxy.js`
(`FAULT_SHAPES`), not as pre-applied toxics:

- **F2 attach latency** — `latency` toxic, `stream=both`, latency 100 / jitter 30 ms.
- **F3 five-second freeze** — `timeout` toxic (`timeout=0`), held 5 s, then removed.
- **F6 down 60 s** — the same `timeout` toxic held 60 s, then restored.
- **F1** (five-minute detach), **F4** (backend SIGKILL/restart), **F5**
  (`rcon-cli kick GlowSquidye gate-b`) are **not** network toxics.

Pure shape, no faults — the wiring smoke through the listener (mc-monitor
ships inside the velocity/mc-proxy image, so no extra image is pulled):

```bash
# SLP through the toxiproxy listener, run from the velocity pod:
kubectl -n monoplayer-gate-b exec deploy/velocity -- \
  mc-monitor status --host toxiproxy --port 25570
# expect: a status line answering from Velocity (ping passthrough is off on
# purpose, so the motd comes from velocity.toml, not from paper-m4).
```

Repetitions and thresholds (3/3) are the **B3** lane's to enforce; this
runbook only guarantees the instruments are live and shape-correct.

## Unit tests (no cluster, no network)

```bash
node --check src/driver/backends.js src/driver/toxiproxy.js src/driver/logins.js
node --test test/driver/backends.test.js \
           test/driver/toxiproxy.test.js \
           test/driver/logins.test.js   # 27 tests, pure
```

## What waits for Monoplayer

- **F1/F4/F5 have no meaning without a Monoplayer puppet session** — detach,
  reconnect-after-restart, and kick-in-particles are all Monoplayer-behaviour
  checks. Do not run them against Velocity alone.
- `backendLogins=1` as an **invite/reattach invariant** only becomes
  meaningful with Monoplayer; before that, Velocity proxies every join as a
  fresh backend login, so multiple logins across separate manual joins are
  normal in M4 bring-up. The B1 runner (`backendLogins` counter, fed by
  `src/driver/logins.js` over `kubectl logs`) enforces the real one.
- The **attach whitelist** (player-only, before Login Success) is a
  Monoplayer lane feature; the backend whitelist here is puppet-only.
- Velocity stays **behind** Monoplayer (pun intended): once Monoplayer is in,
  the puppet leg is `Monoplayer → toxiproxy(puppet-velocity) → velocity →
  paper-m4`, and the pre-Monoplayer `velocity-m4` Tailscale Service goes away.

## Result — 2026-11-07

M4 is up and the forwarding smoke passes. Velocity 4.3.1 build 45 is listening
at `monoplayer-gate-b-velocity.tail41e568.ts.net:25565`, Paper 26.1.2 build 74
is behind it with modern forwarding, and both `Paper: Using libdeflate …
from Velocity` and `Paper: Using OpenSSL … cipher from Velocity` appear in the
backend log.

The authenticated puppet protocol client joined through Velocity and Paper
reported the forwarded identity:

```text
UUID of player GlowSquidye is 73e0e19b-d4e4-4cc1-a553-a3952f0c1aed
GlowSquidye joined the game
GlowSquidye logged in with entity id 23 at 0.5, -60.0, -2.5
```

Evidence: [`testdata/m4-verdict.md`](../testdata/m4-verdict.md) quotes the verdict
and the smoke log.
Toxiproxy is deployed but the F1–F6 fault rows are still pending. This smoke is
`twoAccount=false`: it proves the proxy/forwarding path, not the player attach
path.

## Real-client pass (2026-11-07)

The official 26.1.2 Fabric client attached through Monoplayer to `paper-m4`
via Velocity. The front replayed 1374 frames from the cached configuration and
play prefix; the client loaded 81 chunks and rendered 26 sections. Driver
commands moved the player, broke a seeded stone block, and placed stone on a
dirt support; the backend position followed and the backend saw exactly one
login. The live wire check inspected 1952 frames with zero rejects.

Evidence: [`testdata/m4-verdict.md`](../testdata/m4-verdict.md).

The unmodded 26.1.2 client attached through the same front: 1786 replayed
frames, two attaches, one backend login, and the client log reached
`Loaded 20 advancements`. Manual move, disconnect, and reattach are the
operator's visual pass. Evidence: the same page, which lists the three rows
and what each leaves open.

The F1-F6 fault rows remain pending; that is the B3 lane.

## Teardown (operator; never leaves secrets behind casually)

`mise run gate:down` is the resting state: every workload at 0 replicas, and the
objects, the ConfigMaps and the Secrets still there, so the next `mise run gate:up`
is one command. Removing the lane for good is a separate, destructive run:

```bash
kubectl -n monoplayer-gate-b get svc velocity-m4        # capture hostname first
# delete exactly the M4 files' objects; G0's paper.yaml objects stay.
# (kubectl delete -k deploy/driver would ALSO delete the G0 paper pod —
#  do NOT use -k for teardown while paper.yaml is in the same kustomization.)
kubectl delete -f deploy/driver/velocity.yaml \
                -f deploy/driver/paper-m4.yaml \
                -f deploy/driver/toxiproxy.yaml
kubectl -n monoplayer-gate-b delete secret gate-b-velocity
```

Both files group their objects with `---` and carry a namespace, so
`kubectl delete -f` removes configmap + deployment + services per file and
leaves the G0 backend (`deploy/driver/paper.yaml`) untouched.

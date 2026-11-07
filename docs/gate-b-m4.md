# Gate B M4 runbook — Paper 26.1.2 behind Velocity (and the puppet-leg fault rig)

This is the runbook for the **M4 network-plumbing slice**: Paper 26.1.2 b74
(offline, puppet-only whitelist) behind **Velocity 4.3.1 build 45** (online
mode, modern forwarding, force-key-authentication), plus **Toxiproxy 2.13.0**
for the puppet-leg fault shapes. It is the pass path for Gate B row **M4** and
the rig for row **M5** (faults). Monoplayer itself is out of scope here.

Scope split, so nothing is doubled by another workstream:

- This slice ships manifests (`deploy/gate-b/velocity.yaml`,
  `paper-m4.yaml`, `toxiproxy.yaml`), the pure adapters
  (`src/gate-b/backends.js`, `toxiproxy.js`, `logins.js`), their unit tests,
  and this runbook. It **never applies** anything to the cluster and **never
  commits a secret** — the apply steps below are operator steps.
- **Still owned elsewhere:** the Monoplayer deployment itself; the M1
  (Vanilla) and M3 (Fabric) backend manifests; the B-lane runner that turns
  `src/gate-b/backends.js` + `logins.js` into `backendLogins=1` verdicts
  (docs/gate-b-plan.html, criteria B1–B6).

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
kubectl kustomize deploy/gate-b > /tmp/gate-b.yaml
kubectl apply -k deploy/gate-b --dry-run=client
kubectl apply -k deploy/gate-b --dry-run=client --validate=false   # schema-free pass
```

Operator applies and waits:

```bash
kubectl apply -k deploy/gate-b
kubectl -n monoplayer-gate-b rollout status deploy/paper-m4 --timeout=10m
kubectl -n monoplayer-gate-b rollout status deploy/velocity  --timeout=10m
kubectl -n monoplayer-gate-b rollout status deploy/toxiproxy --timeout=5m

kubectl -n monoplayer-gate-b logs deploy/paper-m4 --tail=100 | grep -E "proxies.velocity|Done"
kubectl -n monoplayer-gate-b logs deploy/velocity --tail=50
```

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
Monoplayer lane) are already the contract in `src/gate-b/backends.js`
(`vanilla`, status `planned`). After it deploys, enable the toxiproxy route
(Stage 4) and run the same SLP + login smoke against `vanilla:25565` via the
listener `puppet-vanilla` on `toxiproxy:25571`.

### Stage 3 — M3 Fabric (other workstream)

Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 compatibility row. Same pattern:
its manifest owner ships `fabric:25565`; enable `puppet-fabric` via the API;
smoke, **report-only** (a Fabric failure is a compatibility finding, not a
gate failure).

### Stage 4 — Toxiproxy fault rig (this slice, wire-up)

The listeners exist from the start; only `puppet-velocity` is enabled by
default. The image has no enable verb in `toxiproxy-cli`; flip listeners via
the HTTP API (ClusterIP-only, reachable from inside the namespace):

```bash
kubectl -n monoplayer-gate-b run toxiproxy-curl --rm -i --restart=Never \
  --image=curlimages/curl:8.11.1 \
  -- -s -X POST -H 'content-type: application/json' \
       -d '{"enabled":true}' http://toxiproxy-api:8474/proxies/puppet-vanilla

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

`/reset` also **enables every proxy**, including the placeholder vanilla,
fabric, and paper-m4 listeners. After a reset, re-disable the listeners that
are not part of the current row (the B-lane runner should call
`setProxyEnabled`/`assertProxyEnabled`) before continuing.

The B-lane runner uses `src/gate-b/toxiproxy.js` for the same three verbs plus
toxic add/remove with injected fetch; runbook curls are the human fallback.

Fault **shapes** for M5 live in `src/gate-b/toxiproxy.js`
(`GATE_B_FAULT_SHAPES`), not as pre-applied toxics:

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
node --check src/gate-b/backends.js src/gate-b/toxiproxy.js src/gate-b/logins.js
node --test test/gate-b-m4-backends.test.js \
           test/gate-b-m4-toxiproxy.test.js \
           test/gate-b-m4-logins.test.js   # 27 tests, pure
```

## What waits for Monoplayer

- **F1/F4/F5 have no meaning without a Monoplayer puppet session** — detach,
  reconnect-after-restart, and kick-in-particles are all Monoplayer-behaviour
  checks. Do not run them against Velocity alone.
- `backendLogins=1` as an **invite/reattach invariant** only becomes
  meaningful with Monoplayer; before that, Velocity proxies every join as a
  fresh backend login, so multiple logins across separate manual joins are
  normal in M4 bring-up. The B1 runner (`backendLogins` counter, fed by
  `src/gate-b/logins.js` over `kubectl logs`) enforces the real one.
- The **attach whitelist** (player-only, before Login Success) is a
  Monoplayer lane feature; the backend whitelist here is puppet-only.
- Velocity stays **behind** Monoplayer (pun intended): once Monoplayer is in,
  the puppet leg is `Monoplayer → toxiproxy(puppet-velocity) → velocity →
  paper-m4`, and the pre-Monoplayer `velocity-m4` Tailscale Service goes away.

## Teardown (operator; never leaves secrets behind casually)

```bash
kubectl -n monoplayer-gate-b get svc velocity-m4        # capture hostname first
# delete exactly the M4 files' objects; G0's paper.yaml objects stay.
# (kubectl delete -k deploy/gate-b would ALSO delete the G0 paper pod —
#  do NOT use -k for teardown while paper.yaml is in the same kustomization.)
kubectl delete -f deploy/gate-b/velocity.yaml \
                -f deploy/gate-b/paper-m4.yaml \
                -f deploy/gate-b/toxiproxy.yaml
kubectl -n monoplayer-gate-b delete secret gate-b-velocity
```

Both files group their objects with `---` and carry a namespace, so
`kubectl delete -f` removes configmap + deployment + services per file and
leaves the G0 backend (`deploy/paper.yaml`) untouched.

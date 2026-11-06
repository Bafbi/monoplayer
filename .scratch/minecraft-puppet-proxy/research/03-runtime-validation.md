# Research note: runtime and validation loop

**Ticket:** `issues/03-research-runtime-and-validation.md`
**Status:** research complete
**Date:** 2026-11-05

## TL;DR

**Recommendation: Node/TypeScript with `minecraft-protocol` + `prismarine-auth`**
as the data-plane core, `mineflayer` only if/when bot behavior (movement,
inventory) is ever needed, deployed as a single static-ish Node container
through the proven deepmine loop (mise → in-cluster BuildKit → zot →
single-namespace `monoplayer-dev` → OTLP to the existing OpenObserve stack).

It is the only stack of the three where **both protocol halves (server-facing
client socket and client-facing backend socket) and the Microsoft-account login
are first-party, maintained, and proven together**. The exact Monoplayer shape
("vanilla client watches/controls a bot session through a packet pipe") has
working prior art in this ecosystem since 2015 ([mineflayer #315](https://github.com/PrismarineJS/mineflayer/issues/315)), with the
pitfalls documented ([#2434](https://github.com/PrismarineJS/mineflayer/discussions/2434), [#728](https://github.com/PrismarineJS/mineflayer/issues/728)).
Its known cost is protocol-version lag (currently one release behind Mojang);
the Java option (MCProtocolLib) wins only that axis, and the Go option
(minekube/gate) has two hard gaps (no Microsoft auth, stale core protocol data)
despite being the homelab's existing Minecraft-proxy stack.

## Evidence: the three stacks

Current reality check (proven, 2026-11-05): Mojang ships quarterly now; the
latest Java release is **26.3, protocol 777** ([minecraft.wiki](https://minecraft.wiki/w/Protocol_version)).
The version treadmill is the dominant risk for any library choice.

| Axis | Node/TS | Java | Go |
|---|---|---|---|
| Client half (connect to backend) | `minecraft-protocol` `createClient` — built-in | `MCProtocolLib` `ClientSession` — built-in | `go-mc` `net` client — built-in but data stale |
| Server half (accept official client) | `createServer` — built-in | `MinecraftServer` — built-in | gate frontend — built-in, proven locally |
| **Microsoft account login (puppet)** | **`prismarine-auth` — first-party, device code + token cache + refresh** | `net.raphimc:MinecraftAuth` (RaphiMC, LGPL-3.0) — the lib ViaProxy uses | **none** — DIY 5-call MSA→XBL→XSTS→MC chain; only pre-alpha prior art |
| License | BSD-3 / MIT / MIT | MIT (MCProtocolLib), **LGPL-3.0 (MinecraftAuth)**, **GPL-3.0 (ViaProxy/ViaVersion)** | MIT (go-mc), Apache-2.0 (gate, connect) |
| Version currency (2026-11-05) | ≤ 26.1; 26.3 in flight ([mineflayer #4190](https://github.com/PrismarineJS/mineflayer/discussions/4190)) | best: GeyserMC master pushed same day; ViaProxy ≥ 3.4.13 supports 26.3 | gate v0.76.2 released daily but rides `go-mc` v1.20.2 (last push 2025-10-13) + vialite translation |
| Activity | healthy (mineflayer 4.39.0 Sep 2026) | very active | gate very active; go-mc stalled |
| Iteration loop | fastest: no compile, in-process fixtures | slowest: gradle + JVM | fast |
| Homelab precedent | `node` 26.7 + `pnpm` 11.25 pinned in mise; mineflayer staged as root devDep for the deepmine L4 harness | gradle 9.5 + java 26 pinned (backends/hub) | **strongest**: deepmine go-proxy embeds gate v0.64.0 with OTel/zap/distroless |

### Node/TS specifics (proven)

- `minecraft-protocol` 1.68.0 (npm, BSD-3-Clause, pushed 2026-10-27) provides
  both `createClient` and `createServer` with online-mode auth, compression,
  encryption, and auto version negotiation via `minecraft-data`.
- `prismarine-auth` (MIT, pushed 2026-10-06) implements the full Microsoft
  flow (device code, title auth) with on-disk token cache and refresh — this is
  the puppet-login component, and it is maintained by the same org.
- Prior art for the exact Monoplayer topology in this ecosystem:
  - [#315 (2015)](https://github.com/PrismarineJS/mineflayer/issues/315): proxy + mineflayer so a vanilla client sees the bot; includes a working raw-pipe sketch (`createServer` + `createBot({keepAlive:false, physics:false})` + `writeRaw` relay both directions).
  - [#2434](https://github.com/PrismarineJS/mineflayer/discussions/2434): documents the two hard parts — exactly one position loop must reach the server, and the viewer's world view must be fed.
  - [#728 (2018)](https://github.com/PrismarineJS/mineflayer/issues/728): confirmed working: drive a bot with the vanilla client, disconnect the client, bot keeps running, reattach later — i.e. the persistence-across-client-disconnect requirement.
  - Active modern prior art: [`cortico-world`](https://www.npmjs.com/package/cortico-world) (MIT, published 4 days ago): "Minecraft Java Edition through a Mineflayer player … and an observer client".
- Server-half auth seam (proven by source): `src/server/login.js` builds the
  session check as `yggdrasil.server({ agent: options.agent })` — the
  `hasJoined` client is injectable via `options.agent`, so online-mode login can
  be tested against a local stub.

### Java specifics (proven)

- `MCProtocolLib` (MIT) has the fastest protocol tracking (GeyserMC) and
  first-party `ClientSession`/`MinecraftServer`. It **no longer ships Microsoft
  auth itself**: its own example
  ([MinecraftAuthTest.java](https://github.com/GeyserMC/MCProtocolLib/blob/master/example/src/main/java/org/geysermc/mcprotocollib/auth/example/MinecraftAuthTest.java))
  delegates to `net.raphimc.minecraftauth` (LGPL-3.0, pushed 2026-10-30) — the
  same library ViaProxy uses.
- `ViaProxy` (GPL-3.0) is the proven "stand in front and translate" tool; the
  mineflayer community already uses it as a stopgap to reach 26.3 servers.
- If Monoplayer ever needs cross-version translation, this is where it lives —
  at a GPL-3.0 cost.

### Go specifics (proven)

- `minekube/gate` v0.76.2 (2026-11-04, Apache-2.0, daily releases) is a full
  proxy (both halves), embeds OTel conventions, runs in ~10 MB, and is embedded
  in production in this homelab (deepmine `proxies/go-proxy`, gate v0.64.0).
- **Gap 1**: gate's backend connections are offline-mode with proxy forwarding;
  there is no first-party Microsoft-auth backend login anywhere in the Go
  ecosystem. The only prior art is `go-theft-craft/headless-minecraft`
  (Apache-2.0, pre-alpha, 0 stars, last push 2026-08-19), which documents the
  same 5-call chain we would have to build ourselves.
- **Gap 2**: gate rides `github.com/Tnze/go-mc` for core protocol data; go-mc
  tags end at v1.20.2 and its last push was 2025-10-13. Gate papers over this
  with managed Via translation ("vialite"), which adds a moving part and hides
  which native version is actually spoken.

## Why Node/TS wins this ticket's axis

The ticket optimizes for "fast protocol iteration and self-validation", and the
map's notes demand "validate with a fake backend and a headless test client" and
"a live Microsoft account is only needed for the final auth smoke test". That
is precisely where Node is strongest:

1. **Zero DIY auth.** The puppet's Microsoft login is `prismarine-auth`; the
   whitelisted client's online-mode check is `createServer`'s. Java needs an
   LGPL third library (fine, but an extra contract); Go needs code we own and
   would have to maintain against XSTS error-code changes ourselves.
2. **In-process fixtures.** Fake backend and fake client are two library calls
   in one process. No separate processes, no loopback ceremony, no waiting for
   image builds during protocol iteration.
3. **The shape is proven here, with pitfalls documented** (#315/#728/#2434).
   The persistence requirement (puppet socket outlives viewer socket) is
   exactly what those threads exercised.
4. **The validation loop is language-agnostic and already Node-capable**: mise
   pins `node 26.7.0` + `pnpm 11.25.0`; the deepmine root already stages
   `mineflayer` for its own L4 headless-client harness.

Costs, honestly stated:

- **Version lag (proven):** today the stack supports through 26.1 while the
  current release is 26.3. Mitigation: pin the MVP to a supported version
  (e.g. 26.1) — the map already plans "one Java version" for the first slice —
  and/or front ViaProxy as a stopgap, which the mineflayer community proves
  works. Do not plan to chase every Mojang quarterly release.
- **Event-loop scaling (speculative):** chunk floods could saturate a single
  Node process. Mitigation built into the design: relay raw frame buffers
  without re-serializing packets (the #315 `writeRaw` pattern), measure first,
  move to worker threads/clustering only if measured.
- **Hobby-grade governance (speculative):** PrismarineJS is a small maintainer
  team; bus-factor risk exists on every candidate except maybe GeyserMC. The
  mitigation is the same for all three: our code depends on the wire format,
  not the library's internals, and we own the auth-wrapper interface.

## Fixtures, auth mocking, capture/replay

Data-plane process = **two sockets, one service**:

```
whitelisted client ──TCP──▶ [ server half: createServer ]  (client leg)
                            [ puppet half:  createClient ]  (backend leg)
fake/real backend ◀──TCP──  (MS-authenticated, long-lived)
```

- **Fake backend** (`test/fakes/backend.mjs`): `mc.createServer({ 'online-mode': false })`
  with a scripted world: sends a login-success, a few chunks, a chat broadcast,
  a keepalive; echoes position packets; exposes a state handle for assertions.
  For the encryption variant it runs `'online-mode': true` with a locally
  generated RSA keypair and a local `hasJoined` that accepts any profile — this
  proves the full login + encryption flow with no Mojang call.
- **Fake client** (`test/fakes/client.mjs`): `mc.createClient({ auth: 'offline' })`
  with deterministic offline UUID; sends a canned position packet on demand,
  counts/logs received packets.
- **Auth mocking:** wrap `prismarine-auth` behind an interface the service
  owns (`AuthProvider.getSession(): { accessToken, profile }`). Unit tests
  inject a fake provider; the only code path that touches Microsoft is the
  wrapper, and the only test that exercises the real flow is the final manual
  smoke against a live account (secret).
- **Capture/replay:** the packet-relay layer records every backend-bound and
  client-bound frame into a ring buffer (`protocolVersion`, `direction`, `ts`,
  `frame`) with a cap (e.g. 64 MiB / 5 min). This is both the late-attach
  replay source (ticket 02's subject) and the regression fixture: record a
  fake-backend session, replay it into the relay, diff the output. Store golden
  sessions under `testdata/sessions/` as raw frames + metadata JSON.

## Test layers

Mirroring deepmine's four-layer model
([reliability-invariants-and-test-seams](file:///home/neudeline/code/deepmine/adr/reliability-invariants-and-test-seams.md)):

- **L1 — unit (no network):** frame codec re-framing (compression/encryption
  boundary), whitelist policy, keepalive demux, ring buffer, auth-wrapper
  against a fake provider. `vitest`, milliseconds-to-seconds.
- **L2 — integration (localhost only, no Mojang, no cluster):** one Node
  process, fake backend + service + fake client, **no MS account**.
  Scenarios:
  1. login+encryption: puppet joins fake backend with online-mode-stubbed legs, both sides encrypted;
  2. attach: client's attach token accepted, receives live backend frames;
  3. control: client's position packet reaches the backend as the puppet (and only one position loop, per #2434);
  4. disconnect: client closes, puppet socket stays alive, backend still sees the puppet;
  5. reconnect: a second client attaches and receives current (not stale) state from the replay cache.
- **L3 — in-cluster, one workload (no Mojang):** deploy the real image into
  `monoplayer-dev` + a fake backend (itzg/minecraft-server with
  `ONLINE_MODE=FALSE`, the same base deepmine already builds as
  `deepmine/minecraft-base`) + a one-shot Job running the fake client; assert
  the L2 scenario 2-5 against the real pod. Catches image-contract and
  environment regressions.
- **L4 — in-cluster, full loop (no Mojang):** L3 plus telemetry assertions:
  the smoke run must produce the attach/disconnect counters and traces in
  OpenObserve. **The live Microsoft-account login is a separate, manual,
  secret-supplied smoke only.**

## mise tasks

Single config root (the monorepo machinery is overkill for a one-service repo,
but keep the deepmine task *interface*: `check`, `ci`, `format`, `lint`,
`build`, `test`, plus cluster-facing tasks).

```toml
[tools]
node  = "26.7.0"     # matches deepmine
pnpm  = "11.25.0"
kubectl = "1.37.1"
"github:moby/buildkit" = "0.33.1"   # matches the deepmine-build daemon image
```

- `mise run check` — format → lint → `tsc` build → unit tests (L1)
- `mise run ci` — `check` + `test:l2` (fake client/backend suites) + `audit`
- `mise run test:l2` — the L2 integration suite (`vitest` tag `integration`)
- `mise run images:build` — port-forward `svc/buildkitd` (deepmine-build ns,
  TCP 1234) and run `deploy/images/build.sh`, mirroring deepmine's task exactly
- `mise run deploy` — `kubectl apply -k deploy/env/dev` into `monoplayer-dev`
- `mise run smoke` — run the L3 Job, tail its log until pass/fail
- `mise run logs` — `kubectl -n monoplayer-dev logs -l app=monoplayer -f`
- `mise run metrics` — port-forward OpenObserve and print the monoplayer
  metric families (PromQL against
  `http://openobserve.deepmine-shared.svc.cluster.local:5080/api/default`)

## BuildKit image build/push (proven pattern, reused as-is)

Copy deepmine's `deploy/images/build.sh` shape (I inspected it):

- buildctl against the **existing** `buildkitd-0` StatefulSet in
  `deepmine-build` (moby/buildkit:v0.33.1, rootful+privileged because Talos
  sets `user.max_user_namespaces=0`), via `kubectl port-forward svc/buildkitd 1234:1234`.
- Push target `zot.deepmine-core.svc:5000/monoplayer/monoplayer:sha-<7>` with
  `registry.insecure=true` (zot is plain HTTP in-cluster; buildkitd already
  carries that registry stanza).
- Registry cache per image: `type=registry,ref=.../monoplayer/buildcache-monoplayer,mode=max`
  so the pnpm layer stays warm across commits.
- Tag = `sha-<7>` of the commit; the deploy manifest pins the digest.
- **Pull side:** pods reference `registry.internal/monoplayer/monoplayer:sha-<7>`;
  the Talos mirror maps `registry.internal` → `10.96.255.50:5000` (zot's pinned
  ClusterIP). This is the exact two-name-one-repository contract deepmine uses
  ([fleet-contract](file:///home/neudeline/code/deepmine/docs/fleet-contract.md)).

Dockerfile: multi-stage — `node:26-alpine` + `pnpm fetch` (frozen lockfile) →
build, prune to production deps, final `gcr.io/distroless/nodejs26-debian12:nonroot`
(to match the house distroless/nonroot style; alpine nonroot is the fallback).

## Single-namespace dev deploy

Namespace `monoplayer-dev` (following `deepmine-dev`). One Deployment
(`app=monoplayer`, 1 replica), one Service (25565) + optional cilium
LoadBalancer route for tailnet access (the deepmine core gateway already
exposes a tailnet LB; for the MVP, `kubectl port-forward` is enough to attach a
real client). Secrets in-cluster only (deepmine ADR: secrets outside git):

- `monoplayer-puppet-auth` — prismarine-auth token-cache file, mounted as a
  volume (never in git, never in the image);
- `monoplayer-whitelist` — the whitelist of client identities, mounted as
  ConfigMap/Secret and reloadable.

No ArgoCD for the MVP: `kubectl apply -k` from mise is the loop; ArgoCD wiring
can be adopted later from deepmine's bootstrap pattern if monoplayer graduates.

## Observability

Reuse the existing platform telemetry (proven topology, read-only):

- Export OTLP to `otel-collector.deepmine-shared.svc.cluster.local` (gRPC 4317
  or HTTP 4318) via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` convention the
  deepmine ADRs set; logs via the pino/OTLP bridge, metrics via
  `@opentelemetry/sdk-metrics`, traces via `@opentelemetry/sdk-trace-node`.
- Everything lands in OpenObserve (`openobserve.deepmine-shared:5080`, per
  [openobserve-telemetry-backend](file:///home/neudeline/code/deepmine/adr/openobserve-telemetry-backend.md));
  traces pass the tail-sampling collector so errors are never dropped
  ([otel-collector-pipeline](file:///home/neudeline/code/deepmine/adr/otel-collector-pipeline.md)).

Signals that answer the ticket's four questions:

| Question | Signal |
|---|---|
| Who is attached? | log line + span per attach (client identity, attach token id), counter `monoplayer.attach_total` |
| What is the puppet doing? | `monoplayer.packets{leg,direction,type}`, puppet state gauge (`login/config/play`), last keepalive RTT |
| Where is latency? | spans: `attach → login → config → play`, `frame.relay` hop timings, `auth.refresh` span |
| Why did a session drop? | disconnect-reason attribute on `monoplayer.disconnect_total` (client_quit, backend_kick, timeout, auth_failure), plus the replay ring buffer contents attached to the error trace |

## Recommendation

**Node/TypeScript: `minecraft-protocol` + `prismarine-auth` now; `mineflayer`
only if the MVP grows bot behavior; ViaProxy (Java, GPL-3.0) as a version-lag
stopgap; revisit Go/gate only if Monoplayer ever becomes a network-facing
proxy.** Follow the deepmine loop verbatim (mise interface, buildkitd
port-forward + build.sh, sha-<7> tags, zot push / `registry.internal` pull,
OTLP to the shared collector, single `monoplayer-dev` namespace).

### Risks (proven vs speculative)

- Proven: version lag (≤26.1 vs current 26.3). Mitigate by pinning the MVP
  version and keeping ViaProxy as the escape hatch.
- Speculative: single-process event-loop headroom. Mitigate with raw-frame
  forwarding and measure; scaling is a later problem.
- Proven: Go is the only stack with zero Microsoft-auth library; Java is the
  only stack with the fastest version currency. If the MVP's bottleneck turns
  out to be version currency rather than the auth/validation loop, MCProtocolLib
  is the fallback, not gate.

## Smallest falsifying experiment

One Node process, localhost only, no Microsoft account, ~200 lines of test
fixture:

1. Fake backend: `mc.createServer({ 'online-mode': true })` with locally
   generated RSA keys and a local `hasJoined` stub (no Mojang).
2. Service: server half (`createServer`, online-mode-stubbed the same way) +
   puppet half (`createClient` with an injected fake auth session).
3. Fake client: `mc.createClient({ auth: 'offline' })`.

Assert the four invariants in order:

1. puppet ↔ backend join completes with **encryption active** on both legs;
2. client attaches and **receives live backend frames** (the scripted chat broadcast);
3. client's position packet reaches the backend **as the puppet**, exactly once per position update;
4. client disconnects → **puppet stays connected** → second client attaches and
   receives current state (not a stale replay).

If 1–4 pass, the architecture is viable and everything else is iteration. The
experiment fails (falsifies the recommendation) if modern config-phase,
secure-chat, or keepalive semantics break the raw relay in either direction —
run it against the newest protocol `minecraft-data` ships (26.1) to test the
modern complexity immediately. If it fails, the next cheapest pivot is
MCProtocolLib (proven currency, proven auth via MinecraftAuth), keeping the
same fixtures and mise/BuildKit loop.

## Links

- [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) · [npm](https://www.npmjs.com/package/minecraft-protocol) (BSD-3)
- [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) (MIT)
- [mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT) — prior art: [#315](https://github.com/PrismarineJS/mineflayer/issues/315), [#728](https://github.com/PrismarineJS/mineflayer/issues/728), [#2434](https://github.com/PrismarineJS/mineflayer/discussions/2434), [#4190](https://github.com/PrismarineJS/mineflayer/discussions/4190) (version lag)
- [Protocol versions](https://minecraft.wiki/w/Protocol_version) (26.3 = 777)
- [MCProtocolLib](https://github.com/GeyserMC/MCProtocolLib) (MIT) · [auth example](https://github.com/GeyserMC/MCProtocolLib/blob/master/example/src/main/java/org/geysermc/mcprotocollib/auth/example/MinecraftAuthTest.java) · [RaphiMC/MinecraftAuth](https://github.com/RaphiMC/MinecraftAuth) (LGPL-3.0)
- [ViaProxy](https://github.com/ViaVersion/ViaProxy) (GPL-3.0, supports 26.3 ≥ 3.4.13)
- [minekube/gate](https://github.com/minekube/gate) (Apache-2.0) · [minekube/connect](https://github.com/minekube/connect) · [Tnze/go-mc](https://github.com/Tnze/go-mc) (MIT, stalled)
- [go-theft-craft/headless-minecraft](https://github.com/go-theft-craft/headless-minecraft) (Apache-2.0, pre-alpha; documents the Go MS-auth chain)
- [cortico-world](https://www.npmjs.com/package/cortico-world) (active observer-client prior art, MIT)
- Local patterns (proven by inspection): `deploy/images/build.sh`,
  `deploy/components/buildkit/`, `deploy/components/zot/values.yaml`,
  `proxies/go-proxy/{Dockerfile,go.mod,mise.toml}`,
  `adr/{reliability-invariants-and-test-seams,otel-collector-pipeline,openobserve-telemetry-backend}.md`,
  `docs/fleet-contract.md`, root `mise.toml` in `/home/neudeline/code/deepmine`

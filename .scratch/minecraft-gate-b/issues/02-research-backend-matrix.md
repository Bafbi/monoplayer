# Research: backend matrix and network harness

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

What is the lightest repeatable backend matrix that can expose real Monoplayer
issues, and what network topology should sit in front of it?

Cover:

- Vanilla 26.1 server (Mojang jar), Paper 26.1, and Fabric 26.1 (loader +
  Fabric API, optionally Carpet for deterministic control). What versions and
  Java runtimes are actually available, and what does each backend prove?
- `itzg/docker-minecraft-server` vs direct Java vs Kubernetes manifests:
  startup time, memory, world persistence, RCON, whitelist, online-mode,
  `enforce-secure-profile`, view/simulation distance, compression threshold.
- A server-side proxy lane: Velocity, BungeeCord, or ViaProxy. What does it
  prove about forwarding, online-mode, and player identity? Where can it sit
  without confusing the Monoplayer front leg?
- A network fault layer: TCP proxy/latency/jitter/packet loss, backend restart,
  backend kick, queue simulation. Prefer simple, deterministic tools.
- Local vs `monoplayer-dev` cluster: what must run where, and what is the
  resource budget?
- A concrete matrix: backend × online-mode × secure-profile × proxy × fault,
  with the minimum rows for Gate B and the rows deferred.

Deliverable: a recommended matrix, topology diagram, startup/teardown plan,
resource estimates, and the smallest experiment that would catch a real backend
incompatibility. Do not implement.

## Answer

<!-- filled on resolution -->

## Answer

Minimum core matrix: **Vanilla 26.1.2 direct** and **Paper 26.1.2 build 74
direct**, both online-mode with secure profiles, plus the fault subset on Paper.
Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 is a required compatibility report but
not gate-blocking unless modded servers are an advertised target. Paper behind
Velocity 4.3.1 modern forwarding is a proxy-compatibility lane, only if a real
target uses a proxy. Run Toxiproxy on the **puppet leg**; a server-side proxy
sits **behind** Monoplayer, never in front.

Pins: Java 25 (21 fails class-file 69); Vanilla 26.1.2 SHA-1
`97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51`; Paper 26.1.2 b74 SHA-256
`1d70b1…e5f7` (Paper has no “26.1” release); Fabric loader 0.20.1; Toxiproxy
2.13.0. Direct Java starts in 7–10 s and uses 0.7–0.9 GB; this workspace can run
one backend but not the official client. Use a dedicated `monoplayer-gate-b`
namespace for cluster rows, never `monoplayer-dev`. Full note:
[`research/02-backend-matrix.md`](../research/02-backend-matrix.md).

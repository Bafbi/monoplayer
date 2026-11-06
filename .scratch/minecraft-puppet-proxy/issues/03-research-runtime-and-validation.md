# Research: runtime and validation loop

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

Which runtime, protocol library, and test harness gives the fastest reliable
iteration for Monoplayer, and what is the concrete `mise` + BuildKit + Kubernetes
loop?

Compare:

- Node/TypeScript with `minecraft-protocol`, `prismarine-auth`, and `mineflayer`.
- Java with `MCProtocolLib`, Netty, and/or `ViaProxy`.
- Go with `go-mc` or `minekube/gate` plus a custom backend connector.

For the recommended stack, define:

- Local fake backend and fake client fixtures, protocol capture/replay, and auth
  mocking.
- Unit, integration, and in-cluster smoke layers, including how to prove encryption,
  login, attach, disconnect, and reconnect without a live Microsoft account.
- `mise` tasks for `check`, `test`, `build`, `deploy`, `logs`, `metrics`, and
  `smoke`.
- BuildKit image build/push (in-cluster `buildkitd`) and a single-namespace
  Kubernetes dev deployment.
- Structured logs, metrics, and traces that answer: who is attached, what is the
  puppet doing, where is latency, and why did a session drop?

Deliverable: a recommended stack, a task list, and the smallest end-to-end test
that gives confidence.

## Answer

Use **Node/TypeScript**: `minecraft-protocol` for both legs, `prismarine-auth`
for the puppet's Microsoft login, `minecraft-data` for versioned packets, and
`vitest` for tests. It is the only stack where the client-facing server, the
backend-facing client, and Microsoft auth are first-party and maintained
together. `mineflayer` is deferred until bot behavior is needed. Java
(MCProtocolLib + MinecraftAuth) is the fallback if protocol currency or
config-phase edge cases become the bottleneck. Go/gate is not recommended: no
Microsoft-auth library and a stale native protocol data layer.

Pin the MVP to the newest protocol `minecraft-data` supports. At research time
that is **26.1 / protocol 775**, while the latest release is 26.3 / 777. The
backend must be pinned to the same version. ViaProxy is the version-lag escape
hatch, not part of slice 1.

Validation follows the deepmine four-layer model: L1 unit tests (codec, cache,
whitelist, auth wrapper), L2 in-process fake backend + fake client (login,
attach, control, detach, reattach), L3 real image in `monoplayer-dev` with a fake
backend and a one-shot fake client, L4 telemetry assertions. The live Microsoft
account is a manual, secret-supplied smoke only.

The dev loop reuses the homelab: mise tasks, in-cluster `buildkitd` in
`deepmine-build`, push to `zot.deepmine-core.svc:5000`, pull via
`registry.internal`, deploy with `kubectl apply -k` into `monoplayer-dev`, OTLP to
the shared collector and OpenObserve. Full task list, metrics and fixture design
in [`research/03-runtime-validation.md`](../research/03-runtime-validation.md).

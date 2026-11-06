# Map: Minecraft puppet proxy

## Destination

A decision-ready architecture for **Monoplayer**: a headless service that holds an
official Minecraft Java account (the *puppet*) and lets a whitelisted official
client attach to that live session and control it normally. The output is an HTML
architecture document with the chosen protocol approach, session lifecycle,
auth/security model, fast `mise` + BuildKit + Kubernetes validation loop, and a
first MVP slice.

## Notes

- Domain: Minecraft Java Edition protocol, Microsoft/Mojang account auth, packet
  proxying, session handoff, Kubernetes operations.
- Skills every session should consult: `grilling`, `domain-modeling`.
- The repo is new. Existing homelab patterns live in `/home/neudeline/code/deepmine`
  (mise, BuildKit, k3s, ArgoCD, OpenObserve/OTel, Gate proxy ADRs).
- Prefer a stack that makes protocol iteration and local fake-client/fake-server
  testing fast. Do not put account tokens or Microsoft credentials in git.
- Validate with a fake backend and a headless test client; a live Microsoft
  account is only needed for the final auth smoke test, supplied as a secret.
- Keep the first slice single-account and single-tenant. Multi-account pooling is
  a later concern.
- Audited draft architecture document: [`docs/architecture.html`](../../docs/architecture.html).
  Research notes are in `research/`, council memos in `council/`, and audits in `audit/`.
- Council recommendation (3/3 build, confidence 78-80): stateful semantic MITM in
  Node, pinned protocol, single pod, Tailscale-only. The strongest dissent is
  to deploy ZenithProxy instead; the draft keeps that as the fallback.

## Decisions so far

- [Research: protocol, auth, and prior art](issues/01-research-protocol-auth-and-prior-art.md): the same feature ships as ZenithProxy; use a stateful semantic MITM, not a byte pipe; Node + minecraft-protocol + prismarine-auth is the first slice, MCProtocolLib the fallback.
- [Research: late attach and state reconstruction](issues/02-research-late-attach-state.md): replay cached configuration, synthesize the play join from a bounded state cache, coalesce live deltas, and never drop the backend session for client lifecycle events.
- [Research: runtime and validation loop](issues/03-research-runtime-and-validation.md): Node/TypeScript, pinned protocol version, L1-L4 test pyramid, in-cluster BuildKit/zot, one `monoplayer-dev` namespace, OTLP/OpenObserve.
- [Research: security, legal, and operations](issues/04-research-security-legal-and-ops.md): online-mode `hasJoined` + UUID whitelist, refresh token as the security boundary, single-pod Secret write-back, Tailscale-only exposure, owner-operated scope.

## Not yet specified

- Target backend version and whether it can be pinned to 26.1 / 775; if not,
  ViaProxy versus the Java/MCProtocolLib path.
- Primary use case (keeping an account online, remote play, or queue avoidance)
  and how much persistence complexity it earns.
- Whether writable chat is a must-have, or read-only/blocked chat is acceptable
  for the MVP (the per-leg `last_seen` state machine is the cost).
- Whether losing the live backend session on a pod restart is acceptable, or
  session persistence across restarts is required.
- Production topology: one pod per puppet vs one multi-session data plane.
- Multi-account pooling, quotas, and billing.
- End-user identity provider and dashboard, if this becomes a product.

## Out of scope

- Bedrock Edition and Geyser-style cross-edition translation.
- Modded clients or modded server protocols in the first slice.
- Replacing Deepmine's server-side Gate proxy or its routing model.
- Video/remote-desktop streaming of a headless client.
- Bypassing server anti-cheat, bans, or access controls.
- Account sharing that violates Microsoft, Mojang, or server terms.

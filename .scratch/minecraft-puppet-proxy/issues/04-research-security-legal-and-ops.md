# Research: security, legal, and operations

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

What must be true for Monoplayer to be safe to run as a dev service, and what are
the hard constraints?

Cover:

- Microsoft/Mojang authentication for the puppet: device-code flow, token cache,
  refresh, revocation, 2FA, and where tokens may live (Kubernetes Secret vs
  external secret store).
- Attaching a client: how to prove the client is allowed, and what identity is
  trustworthy (Minecraft UUID from `hasJoined`, Xbox identity, or a service token).
- Account sharing, whitelist semantics, server anti-cheat, EULA/ToS, and the
  acceptable-use boundary.
- Threats: token theft, session hijack, proxy abuse, replay, denial of service,
  resource exhaustion, and cross-tenant leakage.
- Dev-cluster operations: namespace ownership, NetworkPolicy, exposure (Tailscale
  or Gateway), PVCs, BuildKit/registry access, secrets, and cleanup.
- A risk register with severity, mitigation, and what blocks the first deploy.

Deliverable: a risk register and a "must be true before dev deploy" checklist.

## Answer

The attach gate should be **online-mode `hasJoined` + UUID whitelist**, not a
shareable token. The attaching client proves its own Minecraft identity to the
proxy; it never authenticates to the backend as the puppet (a second login for
the same account kicks the first session). The proxy then presents the puppet's
profile to the client. Usernames are resolved to UUIDs and compared only as
UUIDs.

The puppet's Microsoft refresh token is the real security boundary: it bypasses
2FA for up to 90 days of rolling inactivity, and each refresh is single-use and
rolling. Store it only in an untracked namespaced Kubernetes Secret, with
encryption at rest and RBAC scoped to the workload. The pod must write refreshed
tokens back to the Secret, and **exactly one pod may run at a time** (`replicas:
1`, `strategy: Recreate`, no HPA) or the rolling token chain breaks. The public
launcher client ID `00000000402b5328` is the pragmatic MVP choice; a custom Azure
app via `aka.ms/mce-reviewappid` is only needed if this becomes multi-user.

Expose the data plane only through Tailscale, with default-deny ingress and an
egress allowlist to DNS, Microsoft/Mojang auth hosts, the backend, the registry,
the OTel collector and the Kubernetes API. Treat account sharing, automation
features, anti-cheat evasion and public-server use without permission as out of
scope. The risk register, 13-item pre-deploy checklist and falsifying auth
experiments are in
[`research/04-security-legal-ops.md`](../research/04-security-legal-ops.md).

# The product may be a test double, and the price is a guard on the live manifest

A lane that serves a real backend with two protocol bots needs no Minecraft account, so the service can compose the offline legs. That makes the product a test double, on one condition: the live lane must not become one by a manifest edit. So `MONOPLAYER_OFFLINE_LEGS` is a startup decision, taken from the configuration document or the environment and never from the runtime control document, and `test/tooling/live-manifests.test.js` fails if a manifest under `deploy/manifests/` names it.

## Considered options

- **A second entrypoint and a second image.** Rejected: `start-live.js` owns the whole lane. Account resolution, telemetry, journal, readiness, reconnect and the panel's control document all live there, so a second root duplicates them or forces the shared half into a third module. A second image also needs its own digest pin, its own retention row, and a guard that asks which image a lane ran rather than which key it set.
- **Point the pod at a local session server, with host aliases and a stub keypair.** Rejected: it is an authentication bypass standing next to the lane that serves real players. The guard becomes a DNS entry and a keypair no test in this repository can see, and the repository would then hold a key that mints identities.
- **Run the lane outside the cluster, on loopback.** Rejected: the loopback rung already does this. A lane there is not the deployed topology. There is no Deployment, no probe, no Service and no Argo revision, and being deployed is the whole reason the lane exists.
- **Lift the loopback fence in the offline legs, unconditionally.** Rejected: it moves an invariant out of code. Every rung and every later caller could then dial a real server with `auth: 'offline'` and bind an unauthenticated front to a public address. The fence stays the default, and one option, passed only by the composition root with the switch on, lifts it.
- **Read the switch from the control document, so an operator can turn it on in a running lane.** Rejected: a lane's mode is not runtime state. It decides which code the process builds, and an operator action that turns a live lane into an anonymous one is the failure this decision exists to prevent.

## Consequences

The guard is the price, and it is the load-bearing part. Without it, one manifest line would serve anonymous clients from the lane that holds the account chain and the public route. Two files answer a reader who asks why the live lane cannot do that: this one, and the failing test's own message.

The offline legs are a test double, not a second product. The front asks no session server who a client is, and the backend leg joins as a fixed name. Everything else is the same product: the core, the claim path, the picker and the whitelist code. The lane that runs them is the one whose job is validation, and the deploy tree says which lane that is.

An offline client's UUID is derived from the name it claims, so such a lane's attach whitelist holds offline UUIDs rather than Mojang ones. The backend it dials must run with `ONLINE_MODE=FALSE`, because an `auth: 'offline'` join is not a Mojang session.

The live lane's own rule is unchanged: one identity and one refresh chain. Keeping it on the live legs keeps that rule in one place, and leaves no second way into the account.

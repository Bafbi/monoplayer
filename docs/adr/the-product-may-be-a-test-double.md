# The product may be a test double, and the price is a guard on the live manifest

A lane that serves a real backend with two protocol bots needs no Minecraft account, so the service can compose the offline legs: an offline front that asks no session server who a client is, and an offline backend leg that joins as a fixed name. The decision is not "we support offline". It is that the product may be a test double at all, on the condition that the live lane cannot become one by editing a manifest. `MONOPLAYER_OFFLINE_LEGS` is that switch, it is read from the environment and never from the control document, and `test/tooling/live-manifests.test.js` fails if any manifest under `deploy/manifests/` names it.

## Considered options

- **A second entrypoint and a second image.** Rejected: `start-live.js` owns the whole lane — account resolution, telemetry, journal, readiness, reconnect, the panel's control document — so a second root duplicates it or forces the shared half into a third module. The second image also needs its own digest pin in `deploy/manifests/kustomization.yaml` and its own retention row, and the guard then has to ask which image a lane ran instead of reading one manifest key.
- **Point the pod at a local session server, with host aliases and a stub keypair.** Rejected: it is an authentication bypass standing next to the lane that serves real players. The guard becomes a DNS entry and a keypair no test in this repository can see, and the repository would then hold a key that mints identities.
- **Run the lane outside the cluster, on loopback.** Rejected: the loopback rung already does this. It is not the deployed topology — no Deployment, no probe, no Service, no Argo revision — and being deployed is the whole reason to have the lane.
- **Lift the loopback fence in the offline legs, unconditionally.** Rejected: it moves an invariant out of code. Every rung and every future caller would then be able to dial a real server with `auth: 'offline'` and to bind an unauthenticated front to a public address. The fence stays the default; one option, passed only by the composition root with the switch on, lifts it.
- **Read the switch from the control document, so an operator can turn it on in a running lane.** Rejected: a lane's mode is not runtime state. It decides which code the process builds, and an operator action that turns a live lane into an anonymous one is the failure this decision exists to prevent.

## Consequences

The guard is the price, and it is the load-bearing part: the switch alone would make it one manifest line to serve anonymous clients from the lane that holds the account chain. Two files answer a reader who asks "why can this lane not do that": this one, and the failing test's own message.

The offline legs are a test double, not a second product. They run the same core, the same claim path, the same picker, and the same whitelist code; what changes is who a client is and who the backend is. A lane that needs them is a lane whose job is validation, and the deploy tree says which one that is.

An offline client's UUID is derived from the name it claims, so the attach whitelist of such a lane holds offline UUIDs rather than Mojang ones. The backend it dials must run with `ONLINE_MODE=FALSE`, because an `auth: 'offline'` join is not a Mojang session.

The live lane holds no account lease rule of its own here, but the reason to keep it on the live legs is the same reason custody has one writer: one identity, one chain, and no second way in.

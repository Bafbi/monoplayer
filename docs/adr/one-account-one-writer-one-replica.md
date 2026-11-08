# One account, one writer, one replica

The refresh token is the password, and Microsoft rotates the chain on every refresh, so a second process holding a copy kills the first one's chain. Monoplayer runs one puppet account, one writer, and one replica, with custody on a persistent volume, no token in git or in the image, and Tailscale-only ingress.

## Considered options

- **Pool several accounts and serve several tenants.** Rejected for the first slice: it changes the custody model, adds quotas and billing, and answers a question nobody has asked yet.
- **Keep tokens in a cluster Secret.** Rejected: anything with read access to the namespace can read them, there is no atomic writer lock across pods, and rotation would need a second writer.
- **Run replicas behind a load balancer.** Rejected: two writers, one dead chain. The custody model forbids it.
- **Expose the front on a public address.** Rejected: the blast radius grows for an owner-operated service, and the attach check is the only thing standing in front of a real account.
- **Restore custody from a backup when it breaks.** Rejected: a restored refresh token was already rotated by the live writer, so the restore is dead on arrival. Re-bootstrapping the account is the recovery path.

## Consequences

The live deployment and the transfer testbed share one custody volume, so they must never run at the same time.

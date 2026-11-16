# One account, one writer, one replica

The refresh token is the password, and Microsoft rotates the chain on every refresh, so a second process holding a copy kills the first one's chain. Monoplayer runs one puppet account, one writer, and one replica, with custody on a persistent volume, no token in git or in the image, and ingress that is either the tailnet or the one tunnel bounded by a total pre-auth cap ([public-access-goes-through-a-tcp-tunnel.md](public-access-goes-through-a-tcp-tunnel.md)).

## Considered options

- **Pool several accounts and serve several tenants.** Rejected for the first slice: it changes the custody model, adds quotas and billing, and answers a question nobody has asked yet.
- **Keep tokens in a cluster Secret.** Rejected: anything with read access to the namespace can read them, there is no atomic writer lock across pods, and rotation would need a second writer.
- **Run replicas behind a load balancer.** Rejected: two writers, one dead chain. The custody model forbids it.
- **Expose the front on a public address.** Rejected as a bare port: that is exposure with no bound in front of the attach check, no record in the tree, and no rollback that removes one object. Public access goes through one tunnel instead, bounded by the total pre-auth cap #201 added, and recorded in [public-access-goes-through-a-tcp-tunnel.md](public-access-goes-through-a-tcp-tunnel.md).
- **Restore custody from a backup when it breaks.** Rejected: a restored refresh token was already rotated by the live writer, so the restore is dead on arrival. Re-bootstrapping the account is the recovery path.

## Consequences

The live deployment and the transfer testbed share one custody volume, so they must never run at the same time.

One writer means one *refresher*, not one session. Several clients may play the
account at once with one shared token; what may not happen twice is a refresh
from two copies, or two logins to the same server. See
`docs/custody.md#sessions-copies-and-refresh`.

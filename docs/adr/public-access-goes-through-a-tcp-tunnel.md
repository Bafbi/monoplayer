# Public access goes through a TCP tunnel

Public access goes through a TCP tunnel, and through nothing else. A playit.gg
agent runs as its own Deployment in the live namespace
(`deploy/manifests/playit-agent.yaml`) and carries one raw TCP port from
playit's edge to the front's in-namespace DNS name,
`monoplayer.monoplayer.svc.cluster.local:25565`. The Service, the Deployment and
the front leg do not change to accommodate it, and the backend login is
untouched: the puppet holds its one session whether or not anyone attaches. The
tunnel carries traffic once an operator links the agent, which is
`docs/public-access.md` and not this file.

The gate does not move. Authentication plus the attach whitelist decide who
stays, in the proxy's own login path, and the tunnel is not consulted: it
forwards bytes and decides nothing. A refusal through the tunnel is the same
answer as a refusal on the tailnet, because it comes from the same code.

The audience today is the whitelist's one account. A Tailscale node share would
also let one known player in — it carries `tcp:25565`, it is revocable from the
console, and it needs no third party — and it stays the better tool when the
guest will install a client. It is not this decision: a share is invited per
person and per device, and this lane's answer is a name a guest pastes into a
client they already have.

The limiter covers the pre-auth window only: connections opened but not yet past
the attach check. `preAuth.maxConnections` bounds how many of them exist at
once, and it counts in total rather than per source, so it holds when the tunnel
presents its own address instead of the client's (#201, #199). That cap landed
before this tunnel opened, and that order is the reason the tunnel is safe to
open at all.

## Considered options

- **Tailscale Funnel.** Rejected: it is a public ingress, but it terminates TLS
  and proxies HTTP, and the Minecraft protocol is raw TCP whose first bytes are
  a handshake rather than a request. It cannot carry this protocol at all. It
  will be proposed again because the tool is already in the cluster — the front
  Service is a `loadBalancerClass: tailscale` LoadBalancer — so the exclusion has
  its own reason: not hidden, not permitted, but incapable.
- **tailcat.** Rejected for this goal, and kept on the record as the right tool
  for a different one. It carries any TCP, but it is point-to-point: both ends
  run the tool, the far end terminates the tunnel, its token is a credential the
  documentation tells you not to publish, and its relays are rate-limited. There
  is therefore no stable address a stranger joins by name, and a vanilla client
  cannot open the connection at all. The test that separates the two tools: **an
  ingress is something a stranger can reach; a peer-to-peer tunnel is something
  two cooperating machines run.** This lane needs the first. tailcat remains the
  right answer for letting one trusted person in with no public port,
  terminating on their machine and forwarding to the tailnet address.
- **An IP allowlist at the front.** Considered, declined. An address is a
  routing fact rather than an identity: it moves with a network, it is shared
  behind CGNAT, and through a tunnel it may not be the client's at all — #203 is
  the ticket that measures what the front sees there. The tunnel can be
  told to send the PROXY protocol, and the front cannot read a PROXY header even
  then, because its first bytes must be the Minecraft handshake. The attach
  whitelist already names identities — Mojang-verified UUIDs — which is what an
  address is a poor approximation of.
- **A bare public port.** Rejected, and this is the option
  [`one-account-one-writer-one-replica.md`](one-account-one-writer-one-replica.md)
  declined when the front had no bound in front of the attach check. Two things
  changed since. #201 put a total pre-auth cap in front of that check. And a
  tunnel writes no address into the lane, while a forwarded port does, so the
  tunnel is the version whose rollback is one line in the manifest the Argo
  Application prunes.
- **A port forward on the operator's router.** Rejected: it publishes the
  address the tunnel exists to hide, and no other copy of this repo could
  reproduce it.
- **A public VPS running both the relay and the proxy.** Rejected: it moves the
  account custody, and the one-writer rule ([`one-account-one-writer-one-replica.md`](one-account-one-writer-one-replica.md))
  makes custody the constraint, not the network.

## The free tier's caveat, and its limits

Free tunnels route through playit's **Global Anycast**: a client connects to
playit's nearest edge, and playit is free to carry it through a distant
datacenter — [its support page](https://playit.gg/support/playit-premium/) gives
a North American client routed through Singapore. Regional routing is the paid
feature. This is a **latency caveat, not
a defect in this proxy**: the bytes are the same, the protocol holds, and the
extra path is a tier choice that can be measured and bought out of.

The other limits of playit's free tier, as
[its support page](https://playit.gg/support/playit-premium/) states them: four
allocated ports, where premium allows sixteen. Premium also adds regional
tunnels, `.playit.plus` domains, external domains, more firewall rules and more
agents; playit publishes the port count and does not publish an agent count.
This lane spends one port and one agent. The address, the edge and the data path belong
to playit, and the account's own state gates the tunnel: this lane's account
reports `account_status="email_not_verified"` and owns no tunnel, so the route
carries nothing until an operator finishes `docs/public-access.md`. The tunnel
is a dependency of the public route, not of the lane.

## Consequences

- `prune` does not cover this. The Secret is a cluster object outside Git, like
  `ghcr-pull`, so the workload can be deleted and recreated without a credential
  ever entering the repository. `docs/public-access.md` is the runbook.
- The public route is playit's to assign. It is not a fact this repository can
  resolve, and it changes if the tunnel is recreated, so a document that quotes
  it has quoted something that can go stale. Name the dashboard, not the
  address.
- Rollback is removing the agent. The Service and the proxy are unchanged, so
  the lane returns to tailnet-only with no code change. While this manifest is
  in the synced tree, `kubectl delete` is temporary: Argo's selfHeal puts the
  Deployment back. The durable rollback is the one line in
  `deploy/manifests/kustomization.yaml`.
- The public route fails closed. If the agent dies the public name stops
  answering; the tailnet route and the puppet's session are unaffected, so a
  broken tunnel is an outage of the public route and not of the lane.
- The front cannot tell a tunnel client from a tailnet client, and must not try.
  Any per-source limit would see one address for the whole public internet.
- The pre-auth cap is a total, so a stranger can now spend it. Sixteen idle
  sockets through the public route deny every join until they close, on the
  tailnet as well, because one count covers both routes. Before this door that
  cost a tailnet membership. #205 is the ticket that gives a socket a deadline,
  and it lands on the front, not here; until it does, this is the route's
  accepted cost and the operator's first thing to look at when joins stop
  answering.
- The agent's pod reports Ready and means nothing by it. playit's image has no
  health endpoint and ships no CLI to ask one, so a probe would have to grep a
  log line that playit owns. A stale tunnel therefore reads as a healthy pod,
  and the status lives in playit's dashboard and in the agent's
  `playit connected` line, not in `kubectl get pods`.
- The tunnel's target is a dashboard value, not a manifest field. `local_ip` lives
  in playit's panel, so a change to the front's Service name is a change this
  repository cannot see, and the runbook has to say so.
- A change that wants to expose another port has to repeal this file first.

# Publish the puppet outside the tailnet

The front is reachable two ways: over the tailnet at
`glowsquidye.tail41e568.ts.net:25565`, and — once this runbook is done — by a
name playit.gg assigns, from any client that is on no tailnet at all. The public
route is one Deployment, `playit-agent` in the `monoplayer` namespace, which
carries a raw TCP port from playit's edge to
`monoplayer.monoplayer.svc.cluster.local:25565`. The proxy, the Service and the
backend do not change.

The decision behind it is
[`docs/adr/public-access-goes-through-a-tcp-tunnel.md`](adr/public-access-goes-through-a-tcp-tunnel.md).

**Do not create the tunnel until the front carries both pre-auth bounds: the cap
(#201) and the deadline (#205).** They are the only limits that still hold when a
tunnel hides the client's address. Without the deadline, one stranger opens
`preAuth.maxConnections` connections and sends nothing. Those silent sockets
hold the window closed, and every real join is refused, on the tailnet as well as
through the tunnel. The public door is what makes that reachable by anyone.

## Before you start

Five checks, each with a cheap test. The first four are true before you deploy.
The fifth runs once the tunnel pod exists.

1. **The front carries the pre-auth cap (#201).** It is on by default at 16, so
   the check is that nothing has turned it off: `deploy/manifests/deployment.yaml`
   sets no `MONOPLAYER_PREAUTH_MAX_CONNECTIONS`, and the running image has the
   default. To see the default in the image the pod actually runs:

   ```bash
   kubectl -n monoplayer exec deploy/monoplayer -- \
     node -e "import('/app/src/core/preauth-window.js').then(m=>console.log(m.DEFAULT_MAX_CONNECTIONS))"
   # 16
   ```

   Do not open the tunnel while that prints nothing, or before #201 is in the
   image: the cap is the one bound that holds when a tunnel hides the client's
   address.

2. **The front carries the pre-auth deadline (#205).** The cap bounds how many
   connections sit in the pre-auth window. The deadline bounds how long one
   stays, so a silent socket cannot hold a slot. It is on by default at 30 s, so
   the check is that nothing has turned it off:
   `deploy/manifests/deployment.yaml` sets no `MONOPLAYER_PREAUTH_DEADLINE_MS`,
   and the running image has the default. To see the default in the image the pod
   actually runs:

   ```bash
   kubectl -n monoplayer exec deploy/monoplayer -- \
     node -e "import('/app/src/core/preauth-window.js').then(m=>console.log(m.DEFAULT_DEADLINE_MS))"
   # 30000
   ```

   **Do not create the tunnel while that prints nothing, or before #205 is in the
   image.** A front with the cap and no deadline can be taken offline by a
   stranger who opens connections and sends nothing: the silent sockets fill the
   window, and the cap then refuses every real join. Check the log for the close:
   a line with reason `preauth_deadline` means the bound is working.

3. **The playit account may own a tunnel.** The agent reports the account's
   state on its connect line, and this lane's account last reported
   `account_status="email_not_verified"` with `tunnel_count=0`. Verify the
   email in the dashboard before you go looking for a tunnel that is not there.

4. **The cluster Secret exists.** `kubectl -n monoplayer get secret playit-agent`
   lists it with one key, `SECRET_KEY`. Do not print its value.

5. **The tunnel's local target reaches the front.** Once `playit-agent` runs,
   ask it from inside its own pod:

   ```bash
   kubectl -n monoplayer exec deploy/playit-agent -- sh -c \
     'nc -z -w 3 monoplayer.monoplayer.svc.cluster.local 25565 && echo reached'
   ```

## The two credentials, and why the order matters

playit hands out two credentials that read alike in a hurry.

| Credential | Where it comes from | What it is for | Lifetime |
|---|---|---|---|
| **Setup Code** | the dashboard, when you add an agent | entered **into the agent**, once, to link it to the account | one use, short-lived |
| **Agent secret** | the dashboard, after the agent is linked | stored in the Secret `playit-agent` under `SECRET_KEY` | long-lived, until revoked |

The order is **link the agent first, then take the secret**. The first link
attempt on this lane stored a setup code as if it were the agent secret. The
mistake is silent, because both are strings. The agent's only symptom is an
authentication failure that says nothing about which string it was given, so
the order is the check.

## Step 1 — link the agent

Skip this step if `kubectl -n monoplayer get secret playit-agent` already holds a
working secret. The test is the agent's own connect line: a working secret makes
it log `playit connected` with an `agent_id`, which "Step 4 — confirm the
agent loaded the tunnel" shows.

1. In the dashboard, add an agent and copy its **Setup Code**.
2. Run the agent once with the setup code as its secret. It needs no route to
   the cluster for this, so a workstation is enough:

   ```bash
   docker run --rm -e SECRET_KEY='<setup code>' ghcr.io/playit-cloud/playit-agent:1.0
   ```

   Wait for `playit connected` and stop it. The agent now belongs to the
   account.
3. In the dashboard, open that agent and copy its **secret**. That is the value
   `SECRET_KEY` holds.

## Step 2 — store the secret in the cluster

Run this when the Secret does not exist, or when the agent's connect line shows
an authentication failure. A Secret whose value already links needs nothing
here.

Paste the secret into a shell variable, not into a file, and apply it. The
`create … | kubectl apply` form replaces the value when the Secret already
exists.

```bash
read -rs PLAYIT_AGENT_SECRET   # paste, then press Enter. No echo, no file.
kubectl -n monoplayer create secret generic playit-agent \
  --from-literal=SECRET_KEY="$PLAYIT_AGENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
unset PLAYIT_AGENT_SECRET
```

The Secret stays out of Git. It is the same shape as `ghcr-pull`: a cluster
object the operator creates, with no Argo authorship, so Argo does not prune it.

A replaced Secret does not reach a running pod: environment variables are read
at container start. Restart the tunnel workload:

```bash
kubectl -n monoplayer rollout restart deploy/playit-agent
```

That command names `playit-agent`. The rule in `AGENTS.md` is about the
`monoplayer` Deployment: nothing in this runbook scales, patches, restarts, or
deletes the proxy. Every command that changes an object here names
`playit-agent`, and every check that follows confirms the proxy is where it
was.

## Step 3 — create the tunnel

In the dashboard, add a tunnel to that agent. Pick the **Minecraft Java** preset:
it is on the free tier and it sets the ports itself. Set these fields. Change
`local_ip` first, because the preset carries the docker example's default:

| Field | Value |
|---|---|
| `local_ip` ("IP or hostname") | `monoplayer.monoplayer.svc.cluster.local` |
| local port | `25565` |
| proxy protocol | None |

`local_ip` is the field that must change. It defaults to `127.0.0.1`, and the
docker example it comes from runs with `--net=host`, which has no Kubernetes
equivalent: every pod has its own network namespace, so `127.0.0.1` inside the
tunnel pod is the tunnel pod. The service's in-namespace DNS name is the address
that exists on both sides of that boundary. The agent resolves a hostname with
the cluster resolver and dials the first address it gets.

Leave proxy protocol off. The front's first bytes must be the Minecraft
handshake, and nothing in it reads a PROXY header.

The dashboard now shows the public route: a host on `playit.gg` and a port.
That address is playit's to assign, so do not write it into this repository.

## Step 4 — confirm the agent loaded the tunnel

```bash
kubectl -n monoplayer logs deploy/playit-agent --tail=20
```

Read the `playit connected` line:

```text
playitd::daemon: playit connected; tunnels loaded agent_id=<uuid> tunnel_count=1
  pending_tunnel_count=0 disabled_tunnel_count=0 account_status="<state>"
```

`tunnel_count=1` is the check that matters. `tunnel_count=0` means the tunnel is
not on this agent, or the account cannot own it. `account_status` is playit's
own word for the account's state, and `email_not_verified` is the value this lane
last saw.

Two log lines look like trouble and are not:

- `failed to send initial ping … NetworkUnreachable addr=[2602:…]` — the agent
  tries IPv6 first, and this cluster's nodes have no IPv6 route. It falls back to
  IPv4 and connects one line later.
- `control session expired; reconnecting reason=SessionNotSetup` — the control
  session setup, not a rejection.

**The pod reports Ready even when the tunnel is stale.** The image has no health
endpoint and ships no CLI to ask, so there is no probe to add. Read the log line,
or a client's connect attempt, and not `kubectl get pods`.

## Step 5 — prove the door

A stranger with no tailnet joins the address the dashboard shows. The gate is
unchanged, so the two checks are the same two checks as on the tailnet:

1. A whitelisted account joins.
2. A non-whitelisted account is refused, and the refusal is indistinguishable
   from the one on the tailnet: the same reason, in the same bytes.

The refusal check is the one that matters. Run it from a client outside the
tailnet, and compare it with the same attempt against
`glowsquidye.tail41e568.ts.net:25565`.

**Do not point an automated join at `play.excalia.fr` or `play2.excalia.fr` to
prove this.** The tunnel's far end is the live lane, so the join that proves the
door is a human's, on their own client.

## Limits and the latency caveat

Free tunnels route through playit's Global Anycast, so a client can be carried
through a distant datacenter: playit's own documentation gives a North American
client routed through Singapore. That is a tier choice, not a defect in the
proxy, and regional routing is the paid fix. The free tier also allows four
allocated ports where premium allows sixteen; this lane spends one port and one
agent. The address, the edge and the data path belong to playit, so an outage
there is an outage of the public route — the tailnet route does not share it.

## Rollback

Removing the agent returns the lane to tailnet-only. The Service, the proxy and
the image do not change, so there is nothing to revert in code.

**Now (minutes).** Delete the Deployment. Argo's `selfHeal` recreates it on its
next sync, so this is a pause, not a rollback:

```bash
kubectl -n monoplayer delete deployment playit-agent

# the proxy is not the object you just deleted:
kubectl -n monoplayer get deploy,svc
kubectl -n monoplayer get pods -o wide
```

The `monoplayer` Deployment stays at one replica with the same pod and the same
age. Deleting the tunnel touches nothing in it.

**Durable.** Remove the one line from the kustomization and merge it. Argo prunes
the Deployment, and the tunnel is gone until someone puts the line back:

```bash
# deploy/manifests/kustomization.yaml
#   - playit-agent.yaml        <- delete this line, then merge to main
```

Revoke the tunnel in the playit dashboard too. The free tier allocates four ports
and this lane spends one, and a tunnel left behind holds its port against an
agent that no longer runs.

The Secret stays in the cluster through a rollback. It is outside Git and outside
Argo's ownership, so a redeploy picks it up without a new link. Delete it only
when the agent is revoked:

```bash
kubectl -n monoplayer delete secret playit-agent
```

## What this proves, and what it does not

A working tunnel proves that a client outside the tailnet reaches the front, and
that the front answers it exactly as it answers the tailnet: the same gate, the
same refusal, the same bytes. That is the whole claim. The tunnel adds no
identity and no check, so a join through it is exactly as strong as a join on
the tailnet, and no stronger.

It proves nothing about:

- **Latency.** Free tunnels route through Global Anycast, so the path can be
  longer than the tailnet's by a continent. Measure a client's route before
  blaming the proxy.
- **The backend.** The puppet's session on `play2.excalia.fr` is the same one
  either way. A tunnel that works and a puppet with no session are compatible
  states, and a join in that state meets the picker rather than a broken session.
  The attach whitelist is what stops a stranger before either.
- **Availability.** The public route belongs to playit. Their edge, their
  address, and their account state are all outside this repository. The tailnet
  route is the one this repo controls.
- **The account.** A join through the tunnel moves the same puppet account the
  tailnet join does. Nothing here makes a second session safe: one writer, one
  replica, still.

# Gate B cluster lane

**Status (2026-11-07):** G0 and G1 pass. Paper 26.1.2 build 74 is running
directly for G0, and Velocity 4.3.1 build 45 is now in front of Paper 26.1.2
build 74 for M4; the authenticated puppet joined through the proxy as
`GlowSquidye`. Toxiproxy is running; fault rows are pending. The Fabric driver
lane passed **2/2** consecutive runs and the unmodded witness is completed.
Evidence: [docs/gate-b-g0.md](../../docs/gate-b-g0.md),
[docs/gate-b-g1.md](../../docs/gate-b-g1.md), [docs/gate-b-m4.md](../../docs/gate-b-m4.md),
and [docs/gate-b-driver-validation.md](../../docs/gate-b-driver-validation.md).

The `monoplayer-gate-b` namespace holds the real-backend matrix. It is not the
product namespace; do not point the product at it.

## Paper G0 backend

This is the first Gate B row: a plain Paper 26.1.2 server the official client can
join directly. It is deliberately ephemeral (`emptyDir`), online-mode, and
secure-profile. The RCON password is a cluster Secret, never a manifest value.

```bash
# 1. Namespace + workload. The Secret must exist first.
kubectl create namespace monoplayer-gate-b --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monoplayer-gate-b create secret generic gate-b-rcon \
  --from-literal=password="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -

# For the M4 lane, also create gate-b-velocity (see the M4 section) before
# step 2, or the velocity/paper-m4 pods will fail with
# CreateContainerConfigError.

# 2. Apply the backend.
kubectl apply -k deploy/gate-b

# 3. Watch it download Paper 26.1.2 and boot.
kubectl -n monoplayer-gate-b rollout status deploy/paper --timeout=10m
kubectl -n monoplayer-gate-b logs deploy/paper --tail=100

# 4. Tailscale endpoint for the display host.
kubectl -n monoplayer-gate-b get svc paper-g0 -w
```

The Tailscale service should publish a hostname like
`monoplayer-gate-b-paper.tail41e568.ts.net:25565`. Join that address from the
26.1.2 Prism instance for G0.

## Notes

- `EULA=TRUE` is the operator's acceptance of the Minecraft EULA for this
  throwaway test backend.
- `ENFORCE_WHITELIST=FALSE` is only for the host-readiness row. Gate B's real
  rows use the puppet-only backend whitelist and the separate attach whitelist.
- The world is `emptyDir`; deleting the pod resets it. Restart/persistence rows
  will need a StatefulSet + PVC before they are meaningful.
- RCON is exposed only on the ClusterIP Service, never the Tailscale Service.
- This namespace is not in ArgoCD. It is a test lane.

## M4 lane — Paper behind Velocity 4.3.1 (+ toxiproxy)

Second backend row per [docs/gate-b-m4.md](../../docs/gate-b-m4.md):
`velocity.yaml` (Velocity 4.3.1 b45, online-mode, modern forwarding),
`paper-m4.yaml` (Paper 26.1.2 b74, offline, puppet-only whitelist),
`toxiproxy.yaml` (puppet-leg faults). Full bring-up, smoke and teardown
commands (including the `gate-b-velocity` forwarding-secret, which is created
by `kubectl` and never committed) are in the M4 runbook:

```bash
# Secret (operator, once). VALUES NEVER GO INTO GIT OR THE MANIFESTS.
kubectl -n monoplayer-gate-b create secret generic gate-b-velocity \
  --from-literal=forwarding-secret="$(openssl rand -hex 16)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Offline validation of the manifests without touching the cluster:

```bash
kubectl kustomize deploy/gate-b > /tmp/gate-b.yaml
kubectl apply -k deploy/gate-b --dry-run=client
```

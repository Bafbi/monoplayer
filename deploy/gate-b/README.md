# Gate B cluster lane

**Status (2026-11-06):** Paper 26.1.2 build 74 is running in
`monoplayer-gate-b`; an official 26.1.2 client joined through
`monoplayer-gate-b-paper.tail41e568.ts.net:25565`. The Fabric driver lane now
passes **2/2** consecutive runs (38/38 assertions each) with the repeatable
`src/gate-b/` runner, and the manual unmodded Prism witness is completed.
**G0 passes.** Evidence: [docs/gate-b-g0.md](../../docs/gate-b-g0.md) and
[docs/gate-b-driver-validation.md](../../docs/gate-b-driver-validation.md).

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

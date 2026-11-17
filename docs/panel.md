# Run the panel

The panel is one page and one JSON route on the tailnet, listing the puppets it
may touch and the control ConfigMap it may write for each of them. It runs beside
the proxy, not inside it: same image, second entrypoint, its own namespace.

    http://monoplayer.tail41e568.ts.net:8080

That name comes from `tailscale.com/hostname: monoplayer` on the Service in
`deploy/panel/service.yaml`, the way `glowsquidye` names the front. There is no
public route and no bearer token: the tailnet is the transport and the tailnet ACL
is the authorization, so whoever may reach that device may read the page. The
panel is never published through the playit tunnel ([public-access.md](public-access.md)).

## What the panel can and cannot touch

It writes one object per puppet, and the registry names it. Everything else it
holds is a read.

| Object | Verbs | Where |
|---|---|---|
| the control ConfigMaps the registry names | `get`, `patch`, `update` | each puppet's namespace |
| `pods`, `pods/log` | `get`, `list` | each puppet's namespace |
| `deployments` | `get`, `list` | each puppet's namespace, for readiness only |

And, by design:

- **No `create`.** RBAC cannot scope a create by name, so a create grant on
  ConfigMaps would be a grant to invent any ConfigMap in that namespace. The
  control ConfigMap is created once, by you, below.
- **No `delete`.** The panel corrects a document; it never removes an object.
- **No `secrets`.** The custody volume and the GHCR pull secret are not its to
  read.
- **No wildcard resource, and no ClusterRole.** The Role lives in the namespace it
  grants on, and `test/tooling/panel-manifests.test.js` fails the gate when a
  `resourceNames` entry is not a `controlConfigMap` the registry names, when a rule
  grants `create`, `delete`, `secrets` or a wildcard, or when the Service stops
  being the tailscale class.

Today the page and its JSON route read the registry only, so none of those verbs
is exercised yet: the write routes are the next tickets of
[epic #228](https://github.com/Bafbi/monoplayer/issues/228). The Role is declared
now so the scope is reviewable now, and it is inert until then.

## Apply it once

The panel is a second Argo CD Application with its own project. A human runs one
command, exactly as the first bootstrap did:

```bash
kubectl apply -f deploy/argocd/panel-project.yaml -f deploy/argocd/panel.yaml
```

After that the panel syncs itself from the `deploy` branch, with `prune` and
`selfHeal` on. A panel deployed by hand is a panel nobody can reproduce: the
namespace, the Deployment, the Role and the registry would exist only as something
someone typed.

Two prerequisites come before that command, and neither is in Git:

1. **The pull secret, in the panel's namespace.** The GHCR package is private and a
   Secret is namespaced, so the `ghcr-pull` secret the proxy uses does not reach
   this pod. Create a copy:

   ```bash
   kubectl -n monoplayer-panel create secret docker-registry ghcr-pull \
     --docker-server=ghcr.io \
     --docker-username=Bafbi \
     --docker-password="$GHCR_READ_TOKEN"
   ```

   The namespace arrives with the Application, so create the secret after the first
   sync. Until it exists the pod stays in `ImagePullBackOff`, which is the failure
   the manifest means to show.

2. **The control ConfigMap, once per puppet.** Not in Git, and never in Git:
   Argo's `selfHeal` would revert a tracked object to its committed content within
   minutes of the first panel write. Create it yourself, for the single puppet the
   registry names:

   ```bash
   kubectl create configmap monoplayer-control -n monoplayer \
     --from-file=attach-whitelist.json \
     --from-file=desired.json
   ```

   Run it from a directory holding both files. The keys are the control document's
   (issue #229), and the panel patches `data` without caring which keys it holds; a
   key the puppet does not read yet is ignored. The whitelist's current content is
   `deploy/manifests/configmap.yaml`, so copy
   `attach-whitelist.json` out of it rather than retyping it. Creating the object
   once is the whole cost of `create` being out of reach: after that the panel only
   patches it.

## Change the registry

The registry is `deploy/panel/registry.yaml`: a ConfigMap whose `puppets.json` key
names, per puppet, its `name`, `namespace`, `deployment`, `controlConfigMap`,
`frontHostname` and `backend`. Edit it on `main` and merge.

The pod mounts the ConfigMap and reads the file on every request, so an edit
reaches the page within a minute of the kubelet rewriting the projection. No
restart is needed, and none is wanted: a missing restart is invisible, and a
restart on every registry change would make the page's freshness a deployment
detail.

`src/panel/registry.js` refuses a document it cannot act on, and the panel fails
its start with the field that broke it — a misspelled key, a name that is not a DNS
label, a backend with no port, two puppets writing one ConfigMap. A document that
passes is a document the panel will act on.

Adding a puppet in a new namespace means three things, and the gate enforces all
three: a registry row, a `Role` and a `RoleBinding` in that namespace, and a
destination entry for it in `deploy/argocd/panel-project.yaml`.

## Roll it back

The Application carries Argo's resources finalizer, so deleting it deletes what it
owns: the Deployment, the Service, the Role, the RoleBinding and the whole
`monoplayer-panel` namespace.

```bash
kubectl delete -f deploy/argocd/panel.yaml
```

The control ConfigMap survives. It is not Argo's object and Argo never created it,
so nothing prunes it, and the puppet keeps the document it was reading. Delete it
by hand only if you mean to lose the whitelist it holds.

To stop the panel without deleting it, stop the sync first and then scale it down;
otherwise `selfHeal` puts the replica back.

```bash
kubectl -n argocd patch application monoplayer-panel --type merge \
  -p '{"spec":{"syncPolicy":{"automated":null}}}'
kubectl -n monoplayer-panel scale deployment/panel --replicas=0
```

The tailnet name stops answering when the Service's proxy goes, which scaling to
zero does not do: the Service stays, so the name resolves and refuses instead of
disappearing. Delete the Service if you want the name gone.

## Check it

```bash
curl http://monoplayer.tail41e568.ts.net:8080/healthz   # {"ok":true}
curl http://monoplayer.tail41e568.ts.net:8080/api/puppets
```

`/healthz` never reads the registry, so it answers while the document is broken and
the two content routes return 500 with the reason. The first log line of the pod
says what the panel read:

```json
{"event":"panelStart","registry":"/etc/panel/registry/puppets.json","puppets":1,"port":8080,"serviceAccountToken":true}
```

`serviceAccountToken` is whether a token is mounted, never the token. A panel with
`false` serves the page and would fail its first write, which is worth seeing before
the write route exists.

## The image, and one known skew

The panel runs `ghcr.io/bafbi/monoplayer:main` — the same image as the proxy,
started as `node src/panel/start.js`. No second Dockerfile and no second build:
`.dockerignore` ships `src/` except the rungs, so `src/panel/` is in the image.

`.github/workflows/image.yaml` appends its digest pin to
`deploy/manifests/kustomization.yaml` and nowhere else. On the `deploy` branch the
proxy therefore runs a pinned digest and the panel runs the moving `main` tag, so
the two can be a build apart after a merge. Nothing the panel does today depends on
being the same build as the proxy: it reads a ConfigMap the proxy does not write
yet. When the write routes land, pinning `deploy/panel/kustomization.yaml` too is a
one-line change to that workflow.

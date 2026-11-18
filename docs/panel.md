# Run the panel

The panel is one page and two JSON routes on the tailnet, showing what each puppet
it may touch is doing and which control ConfigMap it may write for it. It runs beside
the proxy, not inside it: same image, second entrypoint, its own namespace.

    http://monoplayer.tail41e568.ts.net:8080

That name comes from `tailscale.com/hostname: monoplayer` on the Service in
`deploy/panel/service.yaml`, the way `glowsquidye` names the front. There is no
public route and no bearer token: the tailnet is the transport and the tailnet ACL
is the authorization, so whoever may reach that device may read the page. The
panel is never published through the playit tunnel ([public-access.md](public-access.md)).

## What the page shows

Per puppet, one card: what it is doing, read from the records the puppet already
writes to its JSONL log on stdout. Read-only, and the card adds no state anywhere.

The panel makes three reads to fill a card:

| Read | Request |
| --- | --- |
| the Deployment's pod selector | `GET /apis/apps/v1/namespaces/<ns>/deployments/<deployment>` |
| the pods that selector matches | `GET /api/v1/namespaces/<ns>/pods?labelSelector=…` |
| the log of the pod that serves | `GET /api/v1/namespaces/<ns>/pods/<pod>/log?container=monoplayer&tailLines=400` |

The records are the ones [telemetry.md](telemetry.md) documents: `heartbeat` every
30 s, `startLive` once at start, `attach` once per attach, and the
`preAuthRefused` and `preAuthExpired` lines the pre-auth window writes when it
bites.

**Every number carries the timestamp of the line it came from.** The `Heartbeat`
heading prints the record's own `t`, and every row under it is that record's. The
page's read time is printed once, at the bottom, labelled `read at`; nothing else
is rendered as "now". A heartbeat older than three intervals says so in words. A
stale record shown as live is the failure this page exists to prevent.

**A puppet that is not serving says why**, in one of six sentences:

| State | Sentence |
| --- | --- |
| `read-refused` | `read refused: …`, with the status the API server answered |
| `no-pod` | `no pod: Deployment <namespace>/<name> has no pod …` |
| `not-ready` | `pod not ready: <pod> is not Ready (<reason>) …` |
| `log-refused` | `log fetch refused: …` |
| `no-heartbeat` | `no heartbeat in the last N lines of <pod> …`, with the newest line's timestamp |
| `stale` | `stale: the newest heartbeat was written N s ago …` — older than three intervals |
| `serving` | `serving: the newest heartbeat was written N s ago …` |

Two facts are stated only by the lines that carry them, and the card says so
rather than guessing:

- **The attach whitelist's size and the effective backend** come from the
  `startLive` record. The tail is 400 lines, so a pod older than that has no start
  record in it: the card prints `unknown, and no start record is in the tail`, and
  shows the registry's own backend beside it, labelled `registry` with no
  timestamp. A successful `backendReconnect` line moves the effective backend,
  because a puppet that followed a transfer is not where it started.
- **The whitelist count is the one the lane resolved at startup.** The control
  document re-reads the whitelist at each login (#229), so an edit made after start
  is invisible here; the row is labelled `at start`, carries that record's
  timestamp, and says `re-read at each login` when it is.
- **The effective backend is the last successful dial**, so a puppet that followed a
  transfer shows where it is now rather than where it started. `last dial` shows the
  newest dial of either outcome with `connected` or `failed`, because a reconnect
  that failed in the tail is the difference between "on play2" and "on play2 until
  three minutes ago".
- **`preAuth.maxConnections` and `preAuth.deadlineMs` are not in the heartbeat.** A
  refusal line carries the cap and an expiry line carries the deadline, so each cap
  is shown with the timestamp of the last line that stated it. A healthy lane writes
  neither, so the fallback is the Deployment's own environment
  (`MONOPLAYER_PREAUTH_MAX_CONNECTIONS`, `MONOPLAYER_PREAUTH_DEADLINE_MS`), labelled
  `Deployment env` with no timestamp. When both are silent the row says unknown: the
  compiled default applies and the panel cannot see it.
- **The journal's caps are the same shape.** `journal.stats()` reports what the
  journal did, not its caps, so the card shows the journal's effects and the three
  `MONOPLAYER_JOURNAL_MAX_BYTES`, `..._MAX_TOTAL_BYTES`, and `..._MAX_AGE_MS` values
  from the Deployment's environment, or says they are not set there. A journal a full
  volume stopped before its first write does report `freeBytes` and
  `requiredBytes`, and those rows appear.

`account.expiresAt` is projected from the custody cache at each heartbeat, so the
card's date is at most 30 s old. Inside seven days the card adds a warning
sentence. `null` means the custody cache does not say, which is not "no expiry".

`GET /api/puppets/<name>` serves the same facts as one JSON object, for an agent
that would rather not parse the page. A name the registry does not hold is a 404.

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

The page uses the three read rules today. The write rule is declared and not yet
exercised: the write routes are the next tickets of
[epic #228](https://github.com/Bafbi/monoplayer/issues/228).

## It ships with the proxy

The panel is not a second Argo CD Application. One Application syncs
`deploy/kustomization.yaml`, which includes `deploy/manifests` (the proxy) and
`deploy/panel` (this panel). Merging to `main` deploys both, and the operator
runs no bootstrap command for the panel. A second Application would mean two
deploys, two rollbacks, and two places a tree can drift.

So the panel arrives on the next sync after the merge, in the same `deploy`
revision the proxy runs, with `prune` and `selfHeal` on.

Two prerequisites are not in Git, and each is one command:

1. **The pull secret, in the panel's namespace.** The GHCR package is private and a
   Secret is namespaced, so the `ghcr-pull` secret the proxy uses does not reach
   this pod. Create a copy:

   ```bash
   kubectl -n monoplayer-panel create secret docker-registry ghcr-pull \
     --docker-server=ghcr.io \
     --docker-username=Bafbi \
     --docker-password="$GHCR_READ_TOKEN"
   ```

   The namespace arrives with the first sync, so create the secret after the merge.
   Until it exists the pod stays in `ImagePullBackOff`, which is the failure the
   manifest means to show.

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

Adding a puppet in a new namespace means four things, and the gate enforces the
first three: a registry row in this file, a `Role` and a `RoleBinding` in that
namespace, a destination entry for the namespace in `deploy/argocd/project.yaml`,
and, for a manifest tree the root does not include yet, a line in
`deploy/kustomization.yaml`.

## Roll it back

The panel is not an Argo object of its own, so there is nothing to delete with
`kubectl`. Take it out of the tree and let Argo prune it:

```yaml
# deploy/kustomization.yaml
resources:
  - manifests
  # - panel
```

Merge that, and the next sync prunes the seven panel objects and the
`monoplayer-panel` namespace. The proxy is untouched: same Application, same
revision, one directory fewer.

The control ConfigMap survives. Argo never created it and it carries no tracking
annotation, so nothing prunes it, and the puppet keeps the document it was reading.
Delete it by hand only if you mean to lose the whitelist it holds.

To stop the panel temporarily, the same one-line change is the durable way:
`selfHeal` puts a replica back within about three minutes of a manual scale to
zero. The difference matters. Scaling to zero leaves the Service, so the tailnet
name still resolves and refuses; removing the tree removes the name with it.

## Check it

```bash
curl http://monoplayer.tail41e568.ts.net:8080/healthz             # {"ok":true}
curl http://monoplayer.tail41e568.ts.net:8080/api/puppets         # the registry
curl http://monoplayer.tail41e568.ts.net:8080/api/puppets/glowsquidye
```

The third is one puppet's facts, the same object the card is rendered from.

`/healthz` never reads the registry, so it answers while the document is broken and
all three content routes return 500 with the reason. The first log line of the pod
says what the panel read:

```json
{"t":"2026-11-17T22:41:07.512Z","event":"panelStart","registry":"/etc/panel/registry/puppets.json","puppets":1,"port":8080,"serviceAccountToken":true}
```

`serviceAccountToken` is whether a token is mounted, never the token. A panel with
`false` serves the page and would fail its first write, which is worth seeing before
the write route exists.

To see the page without a cluster, run it from a checkout against the registry this
repository ships:

```bash
mise run panel:run    # http://127.0.0.1:8080
```

It reads `deploy/panel/registry.yaml` through the same parser the pod uses, so a
registry edit is visible here before it is merged.

A panel run from a checkout has no ServiceAccount token, so every card reads
`read refused: no service account token at
/var/run/secrets/kubernetes.io/serviceaccount/token: …` and the registry facts are
still on it. That sentence is the point: a panel that cannot read the cluster
names the read that failed instead of showing a spinner.

## The image, and one known skew

The panel runs `ghcr.io/bafbi/monoplayer:main` — the same image as the proxy,
started as `node src/panel/start.js`. No second Dockerfile and no second build:
`.dockerignore` ships `src/` except the rungs, so `src/panel/` is in the image.

`.github/workflows/image.yaml` appends its digest pin to
`deploy/panel/kustomization.yaml` in the same commit it pins the proxy (#234). On
the `deploy` branch both trees therefore run one pinned build, and the two can
never be a build apart. On `main` neither carries a pin.

That is not cosmetic. Before #234 the panel ran the moving `main` tag with
`imagePullPolicy: IfNotPresent`, so a node that had cached the tag kept running a
build the checkout did not contain: the pod crashlooped on a module its image
never shipped, and the manifest looked correct.

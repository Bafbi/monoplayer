# Run the panel

The panel is one page and two JSON routes on the tailnet, showing what each puppet
it may touch is doing and which control ConfigMap it may write for it. It runs beside
the proxy, not inside it: same image, second entrypoint, its own namespace.

    http://monoplayer.tail41e568.ts.net

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

**A puppet that is not serving says why**, in one of seven sentences:

| State | Sentence |
| --- | --- |
| `read-refused` | `read refused: …`, with the status the API server answered |
| `no-pod` | `no pod: Deployment <namespace>/<name> has no pod …` |
| `not-ready` | `pod not ready: <pod> is not Ready (<reason>) …` |
| `log-refused` | `log fetch refused: …` |
| `no-heartbeat` | `no heartbeat in the last N lines of <pod> …`, with the newest line's timestamp |
| `stale` | `stale: the newest heartbeat was written N s ago …` — older than three intervals |
| `serving` | `serving: the newest heartbeat was written N s ago …` |

Some facts are stated only by the lines that carry them, and the card says so
rather than guessing:

- **The attach whitelist's size and the effective backend** come from the
  `startLive` record. The tail is 400 lines, so a pod older than that has no start
  record in it: the card prints `unknown, and no start record is in the tail`, and
  shows the registry's own backend beside it, labelled `registry` with no
  timestamp.
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
| the control ConfigMaps the registry names | `get`, `patch`, `update` | each puppet's namespace: two keys, `desired.json` and `attach-whitelist.json` |
| `pods`, `pods/log` | `get`, `list` | each puppet's namespace |
| `deployments` | `get`, `list` | each puppet's namespace: the pod selector, the pods' readiness, and the caps its environment sets |

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

The page uses the three read rules and the `get` on the control ConfigMap. Three
routes exercise the write rule, and they patch one object: `desired.json` for
`POST /api/puppets/:name/backend`, and `attach-whitelist.json` for the two
attach whitelist writes. Each patches its own key, and a merge patch of one key
leaves the other where it was.

## Point a puppet at another backend

```bash
curl -X POST http://monoplayer.tail41e568.ts.net:8080/api/puppets/glowsquidye/backend \
  -H 'content-type: application/json' \
  -d '{"host": "play.example.net", "port": 25565}'
```

That writes `desired.json` into the puppet's control ConfigMap, and nothing else:

```json
{
  "version": 1,
  "backend": { "host": "play.example.net", "port": 25565 },
  "changedAt": "2026-11-18T09:41:07.512Z",
  "changedBy": "panel"
}
```

The puppet reads it on its next heartbeat, which is at most 30 seconds away, and
moves its session. **A player who is attached keeps their connection**: they see a
loading screen and land in the new server's world ([product-core.md](product-core.md)).
With nobody attached the puppet moves alone.

Two fences, and they are not the same one:

- **the registry's `allowBackendSwitch`** decides whether the panel writes the
  request. Set false, the route answers 409 and writes nothing.
- **the puppet's `control.allowBackendSwitch`** decides whether it obeys. A
  `desired.json` that reaches a lane with the switch off is named once
  (`controlSwitchRefused`) and ignored.

The two can disagree, and the puppet wins. The registry is a document in Git while
the switch is the Deployment's environment, so a lane that never sets
`MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH=1` refuses every move however the registry
reads. That is deliberate: a panel that could move a lane the lane does not allow
would be a second authorization path, and the puppet's own config is the one
reviewers read beside the workload. The cost is that the panel's refusal is a
courtesy and the puppet's is the truth.

A third condition sits under both: **the lane must name the file.**
`MONOPLAYER_CONTROL_FILE` is what makes a puppet read `desired.json` at all, and no
manifest in this repository sets it yet, so on the deployed lane a write lands in a
document nothing opens and the 200 means "written", not "read". Nothing says so in
the log, because a lane that names no control file reads no file to report on.

For that reason `deploy/panel/registry.yaml` ships `allowBackendSwitch: false`:
the panel should refuse to write a document the only puppet it lists cannot read.
Wiring the lane is one edit to `deploy/manifests/deployment.yaml` (a volume for the
control ConfigMap, and the two variables) and one to the registry, and the two
belong in the same change. Check the lane before you trust the answer:

```bash
kubectl -n monoplayer get deployment monoplayer \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MONOPLAYER_CONTROL_FILE")].value}'
```

`changedBy` is the word `panel`. The panel has no way to name a person: the
tailnet ACL is the authorization (P4), and the Service is not in front of an
identity provider. What the panel does record is the peer it answered, in its own
log line:

```json
{"event":"panelBackendMove","puppet":"glowsquidye","backend":"play.example.net:25565","address":"100.64.0.9"}
```

A move that fails costs the player one configuration round and puts them back. The
puppet logs `backendMoveFailed` and does not retry the same document: point it
somewhere else, or send the same address again, which stamps a new `changedAt` and
is therefore a new request.

## Add or remove an attach whitelist entry

```bash
curl http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist
curl -X POST http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist \
  -H 'content-type: application/json' -d '{"uuid": "6eb73524-ff88-4a62-a8d0-c63905e7afba"}'
curl -X POST http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist \
  -H 'content-type: application/json' -d '{"name": "Bafbi"}'
curl -X DELETE http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist/6eb73524-ff88-4a62-a8d0-c63905e7afba
```

That rewrites one key of the control ConfigMap, `attach-whitelist.json`, and
nothing else. The document is the shape the puppet already reads, so no second
shape exists:

```json
{
  "version": 1,
  "players": [
    { "uuid": "6eb73524-ff88-4a62-a8d0-c63905e7afba", "name": "Bafbi", "addedAt": "2026-11-07T13:04:51.092Z" }
  ]
}
```

The body must be sent as `application/json`, and that requirement is the guard
against a cross-site write: a browser has to preflight it, and the panel answers no
preflight. A form body is refused rather than parsed.

| Answer | Meaning |
|---|---|
| 200 | written, or already the document you asked for |
| 400 | a body that is not JSON, neither a uuid nor a name, both at once, a uuid that is not one, a name the resolver could not answer, or a path segment that is not valid percent-encoding |
| 404 | no such puppet in the registry, or no such uuid in the attach whitelist |
| 405 | a verb this route does not take, with `allow` naming the ones it does |
| 409 | the uuid is the puppet's own account, or the write lost three races |
| 413 | a body over 4 KiB |
| 500 | the registry could not be read, or the attach whitelist document could not be parsed |
| 503 | no cluster client, the cluster refused the read or the patch, or the Deployment names no `MONOPLAYER_PUPPET_UUID` to check the entry against |

**A change takes effect on the next login with no restart and no deploy.** The
puppet re-reads the file at each login (#229), so it is one file read away. A client
already mid-login may be picked up on the following attempt.

Four refusals are deliberate, and each one is a refusal rather than a repair:

- **A document that does not parse is never rewritten.** The answer is a 500 with the
  parse error, and the key is left byte for byte. The same holds for a document of
  the wrong shape, an entry whose uuid is not one, a field that is not the type the
  shape gives it, and a `version` this panel does not write.
- **A lost race is re-read, not clobbered.** The patch carries the
  `resourceVersion` it read, so the API server answers 409 when somebody else wrote
  the document in between. The panel patches at most three times, each attempt over a
  fresh read, so at most two re-reads. Then it reports the conflict by name. The
  other writer's entry survives, because the second attempt applies your change to
  the document they left.
- **The puppet's own uuid is refused** with a 409. The uuid is the one the puppet's
  Deployment sets in `MONOPLAYER_PUPPET_UUID`, and it appears in neither the answer
  nor the log line: it is the puppet's account identifier, not the caller's. A
  Deployment that names no uuid gets a 503 instead, because the check cannot run and
  the panel does not skip a rule it cannot apply.
- **Removal takes a uuid**, so renaming an account cannot remove a different one. A
  uuid that is not in the list is a 404, and nothing is written.

`{"name": "..."}` is resolved through `createNameLookup` from
`src/custody/store.js`: Minecraft services first, then the legacy Mojang API. That
needs egress from the panel namespace. When the endpoints answer nothing, the route
says so and asks for the uuid rather than writing nothing and reporting success. A
name that does not exist is a 400 that names it.

Every write leaves one JSONL line on the panel's own log, because the ConfigMap keeps
no history:

```json
{"t":"2026-11-18T10:00:00.000Z","event":"panelWhitelistAdd","puppet":"glowsquidye","namespace":"monoplayer","controlConfigMap":"monoplayer-control","key":"attach-whitelist.json","uuid":"6eb73524-ff88-4a62-a8d0-c63905e7afba","name":"Bafbi","count":2,"changed":true,"attempts":1,"address":"100.64.0.9"}
```

`panelWhitelistRemove` is its twin. The address is the tailnet peer, which is the
only actor the panel can name.

The control ConfigMap is not in Git, so the 200 also carries the `data:` block of
`deploy/manifests/configmap.yaml` to paste, under `yaml` and `pasteInto`. Replace
that file's `data` block with it when a change should survive the next deploy.
Then delete the ConfigMap the panel patched, because the two copies now disagree.

**The write lands in a document the lane may not read yet.** A puppet reads this key
only when `MONOPLAYER_ATTACH_WHITELIST` names it, and
`deploy/manifests/deployment.yaml` names `/config/attach-whitelist.json`, the
ConfigMap in Git. So on the deployed lane today a write lands in a document nothing
opens, and the 200 means "written", not "read". Pointing the lane at the control
volume is one manifest edit, and it belongs in the same change as the registry row.
Check it before you trust an answer:

```bash
kubectl -n monoplayer get deployment monoplayer \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MONOPLAYER_ATTACH_WHITELIST")].value}'
```

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
   registry names, **before the Deployment that mounts it rolls**:

   ```bash
   kubectl create configmap monoplayer-control -n monoplayer \
     --from-file=attach-whitelist.json
   ```

   The whitelist's current content is `deploy/manifests/configmap.yaml`, so copy
   `attach-whitelist.json` out of it rather than retyping it. **Do not seed
   `desired.json`:** the puppet treats a missing control file as "no override", and
   a document naming the backend it is already on would be an intent with a
   `changedAt` that never meant anything. The panel creates the key on its first
   move.

   **The order matters.** The Deployment mounts this object at `/control` with
   `optional: true`, so a missing object does not keep the pod from starting — it
   starts and denies every login, because its whitelist is the file that is not
   there. Create the object first, then let the rollout read it.

   Creating the object once is the whole cost of `create` being out of reach: after
   that the panel only patches it.

## Change the registry

The registry is `deploy/panel/registry.yaml`: a ConfigMap whose `puppets.json` key
names, per puppet, its `name`, `namespace`, `deployment`, `controlConfigMap`,
`frontHostname`, `backend` and `allowBackendSwitch`. Edit it on `main` and merge.

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
curl http://monoplayer.tail41e568.ts.net/healthz             # {"ok":true}
curl http://monoplayer.tail41e568.ts.net/api/puppets         # the registry
curl http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye
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

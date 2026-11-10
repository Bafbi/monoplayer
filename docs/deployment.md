# Deploy Monoplayer

Monoplayer deploys from this repository. Nothing in the deployment belongs to
another repository's GitOps tree.

```
push to main
   └─ .github/workflows/image.yaml   builds and pushes ghcr.io/bafbi/monoplayer
        └─ rebuilds the `deploy` branch as main + one digest commit
             └─ Argo CD Application "monoplayer" tracks `deploy`
                  └─ namespace monoplayer
```

`main` is human history: one commit per change. Its manifests reference the
moving `ghcr.io/bafbi/monoplayer:main` tag and carry no digest, so nothing on
main goes stale. `deploy` is bot-owned: the workflow force-pushes it as `main`
plus an `images:` digest pin for the image it just built, so the running image
is recorded in Git without adding commits to `main`. Argo tracks `deploy`. One
Application, one project, one namespace. The deployed image is pinned by
digest, never by a moving tag.

## What lives where

| Path | Contents |
|---|---|
| `deploy/manifests/` | Kustomization: namespace, attach whitelist ConfigMap, custody PVC, Deployment, Tailscale Service |
| `deploy/argocd/project.yaml` | AppProject `monoplayer`: one source repo, one destination namespace |
| `deploy/argocd/application.yaml` | Application `monoplayer` |
| `.github/workflows/image.yaml` | Build, push to GHCR, commit the digest |
| `Dockerfile` | The runtime image: Node, the proxy, the 26.2 data patch |

## One-time cluster bootstrap

These objects are not in Git. Create them once, in this order.

1. **Argo repository credential.** The repository is private, so Argo needs a
   token that can clone it. A fine-grained PAT with `Contents: read` and
   `Metadata: read` on this repository is enough.

   ```bash
   kubectl -n argocd create secret generic monoplayer-repo \
     --from-literal=type=git \
     --from-literal=url=https://github.com/Bafbi/monoplayer.git \
     --from-literal=username=Bafbi \
     --from-literal=password="$GITHUB_TOKEN"
   kubectl -n argocd label secret monoplayer-repo \
     argocd.argoproj.io/secret-type=repository
   ```

2. **Project and Application.**

   ```bash
   kubectl apply -f deploy/argocd/project.yaml -f deploy/argocd/application.yaml
   ```

3. **Image pull secret.** The GHCR package is private. A classic PAT with only
   `read:packages` is enough; fine-grained PATs cannot read packages.

   ```bash
   kubectl -n monoplayer create secret docker-registry ghcr-pull \
     --docker-server=ghcr.io \
     --docker-username=Bafbi \
     --docker-password="$GHCR_READ_TOKEN"
   ```

4. **Custody seed.** The image carries no tokens. Copy the account directory
   into the claim after Argo creates it; the Deployment's init container waits
   for `profile.json` before the app starts.

## Custody seed

The image carries no tokens and no whitelist. Seed both at run time.

| Path | Content | Mode |
|---|---|---|
| `/data/accounts/<uuid>/` | `profile.json`, `*-cache.json` per account | `0700` dir, `0600` files |
| `/data/accounts/<uuid>/writer.lock` | transient; the proxy writes it | `0600` |
| `/config/attach-whitelist.json` | `{ "version": 1, "players": [...] }` | ConfigMap, read-only |

The account directory must be writable by the runtime user because the proxy
takes `writer.lock` and refreshes the caches in place. Copy the directory as it
is; do not rebuild or re-encode the files. A refresh invalidates the old
refresh token, so a later seed must come from the live writer, not a stale
backup.

Two accounts exist: `glowsquidye` (the puppet) and `bafbi` (the attaching
player, on the attach whitelist). Set `MONOPLAYER_PUPPET_ACCOUNT` when the
account directories hold more than one.

## The image pipeline

`.github/workflows/image.yaml` runs on every push to `main` that is not a
manifest or docs change:

1. builds `linux/amd64` from the `Dockerfile`;
2. pushes `ghcr.io/bafbi/monoplayer:sha-<7>` and `:main`;
3. checks out a fresh `deploy` branch from `main`, appends an `images:` digest
   pin to `deploy/manifests/kustomization.yaml`, and force-pushes `deploy`. The
   deploy commit carries the main commit's subject with ` (patched)` appended,
   so the branch reads as "that commit, with the image pinned".

Do not edit `deploy` by hand: the next build overwrites it. Change
`deploy/manifests` on `main` instead; the workflow carries the change onto the
new `deploy` branch.

The workflow authenticates to GHCR with its own `GITHUB_TOKEN`
(`packages: write`) and pushes `deploy` with `contents: write`. If the repository's
Actions settings are limited to read-only tokens, the push step fails; set
Settings → Actions → General → Workflow permissions to "Read and write
permissions".

A local build is still possible for debugging, but it publishes to the
cluster's Zot registry, which the manifests do not reference. If you use it,
pin the digest in `deploy/manifests/kustomization.yaml` yourself.

## What the deployment must set

Run the container as uid `1000` (`node`). The image sets `USER node` and
`EXPOSE 25565`.

Required:

- `MONOPLAYER_BACKEND_HOST`: `--start` refuses to run without it. Point it at
  the Season 3 backend, `play2.excalia.fr`, for the live deployment.
- `MONOPLAYER_FRONT_HOST=0.0.0.0`: the default is `127.0.0.1`, which only
  accepts pod-local connections.

Common:

- `MONOPLAYER_VERSION`: the protocol version, default `26.1`. The image also
  carries the 26.2 data, so set `26.2` for Excalia Season 3.
- `MONOPLAYER_PUPPET_ACCOUNT=glowsquidye`
- `MONOPLAYER_CHAT=read-only` (default): relay server chat to the attached
  client and drop the client's own text. `full` also speaks the client's chat
  and commands on the puppet leg as the account, and relays the server's signed
  player chat back. `off` blocks both directions. Set `full` only after a live
  run shows `chatCapability` with `signed: true`: a leg without profile keys
  sends an unsigned frame, and a server that enforces secure profiles answers
  that by closing the connection.
- `MONOPLAYER_PUPPET_ACCOUNTS_DIR=/data/accounts` (the default, relative to the
  `WORKDIR`) or the mount path
- `MONOPLAYER_ATTACH_WHITELIST=/config/attach-whitelist.json`
- `MONOPLAYER_LOG` to write JSONL to a file instead of stdout
- `MONOPLAYER_BACKEND_PORT` and `MONOPLAYER_FRONT_PORT` (both default `25565`)
- `MONOPLAYER_RECONNECT_ATTEMPTS` (0 or unset = unlimited) and
  `MONOPLAYER_RECONNECT_MAX_DELAY_MS` (default `60000`)

Telemetry and journal:

- `OTEL_EXPORTER_OTLP_ENDPOINT`, for example
  `http://otel-collector.deepmine-shared.svc.cluster.local:4318`
- `OTEL_SERVICE_NAME=monoplayer`
- `MONOPLAYER_JOURNAL_DIR=/data/journal`
- `MONOPLAYER_JOURNAL_MAX_BYTES` (default `268435456`)

See `docs/telemetry.md` for the signals and the journal layout.

## Invariants

- **One replica, `Recreate`.** The backend login is a rolling refresh-token
  chain; two writers would race it. The custody claim is `ReadWriteOnce`.
- **The custody PVC is never pruned.** The PVC and the namespace carry
  `argocd.argoproj.io/sync-options: Delete=false,Prune=false`, so removing the
  Application or the manifest does not delete the tokens.
- **The front never attaches without a warm backend.** While the puppet has no
  session, a login is denied with `backend_not_ready` instead of being handed
  an incomplete configuration.
- **The front client is never told to connect elsewhere.** Clientbound
  `transfer`, `start_configuration`, cookies, dialogs, and kicks are blocked by
  `clientbound-policy.js`, and the cache never holds them, so a later attach
  cannot replay one. A play-state transfer is followed on the **puppet** leg,
  and the client is detached with a moving reason and rejoins once the puppet is
  warm on the target. The kept connection (`transfer.keepConnection`, on by
  default) serves the move on the client's own connection instead: the client
  re-enters configuration on the transfer intent, before the target is dialled,
  and lands in the target's play state without a rejoin. A target the proxy
  gives up on restores the previous state on that same connection. See
  `docs/product-core.md`.
- **The journal lives on the custody volume.** 128 MiB per file, one rotation,
  at most 256 MiB of the 1 GiB claim.

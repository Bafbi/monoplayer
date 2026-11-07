# Build and publish the Monoplayer image

This is the image how-to only. The deployment is not part of this document.

The image is built with the cluster BuildKit and pushed to Zot. Each build
prints one line: the image, its tag, and its digest. Pin the deployment to the
digest.

## Build and push

Prerequisites: a `kubectl` context that reaches `deepmine-build` and
`deepmine-core`, and `mise`.

```bash
mise install
mise run image:build
```

The task runs `scripts/build-image.sh`. It:

1. port-forwards `svc/buildkitd` from `deepmine-build` to `127.0.0.2:1234`
2. builds `Dockerfile` from the repo root
3. pushes `zot.deepmine-core.svc:5000/deepmine/monoplayer:sha-<7>`
4. prints `<image> <tag> <digest>`

The forwarder binds the loopback alias `127.0.0.2` because the dev harness
probes `127.0.0.1` and a probe's connection reset kills `kubectl port-forward`
mid-build. Override with `BUILDKIT_LOCAL_ADDR=127.0.0.1` where the alias is
not available.

Sample output:

```text
zot.deepmine-core.svc:5000/deepmine/monoplayer sha-2438f35 sha256:...
```

Set `REGISTRY` to push somewhere else:

```bash
REGISTRY=zot.example.internal:5000 mise run image:build
```

The script exits nonzero when the push produced no digest.

## Custody seed

The image carries no tokens and no whitelist. Seed both at run time.

| Path | Content | Mode |
|---|---|---|
| `.secrets/accounts/<uuid>/` | `profile.json`, `*-cache.json` per account | `0700` dir, `0600` files |
| `.secrets/accounts/<uuid>/writer.lock` | transient; the proxy writes it | `0600` |
| `.secrets/attach-whitelist.json` | `{ "version": 1, "players": [...] }` | `0600` |

The account directory must be writable by the runtime user because the proxy
takes `writer.lock` and refreshes the caches in place. Copy the directory as
it is; do not rebuild or re-encode the files. A refresh invalidates the old
refresh token, so a later seed must come from the live writer, not a stale
backup.

Two accounts exist: `glowsquidye` (the puppet) and `bafbi` (the attaching
player, on the attach whitelist). With more than one account there is no
default puppet: set `MONOPLAYER_PUPPET_ACCOUNT`.

## What the deployment must set

Run the container as uid `1000` (`node`). The image sets `USER node` and
`EXPOSE 25565`.

Required:

- `MONOPLAYER_BACKEND_HOST`: `--start` refuses to run without it. Point it at
  the Paper backend.
- `MONOPLAYER_FRONT_HOST=0.0.0.0`: the default is `127.0.0.1`, which only
  accepts pod-local connections.

Common:

- `MONOPLAYER_PUPPET_ACCOUNT=glowsquidye`
- `MONOPLAYER_PUPPET_ACCOUNTS_DIR=/app/.secrets/accounts` (the default,
  relative to the `WORKDIR`) or the mount path
- `MONOPLAYER_ATTACH_WHITELIST=/app/.secrets/attach-whitelist.json`
- `MONOPLAYER_LOG` to write JSONL to a file instead of stdout
- `MONOPLAYER_BACKEND_PORT` and `MONOPLAYER_FRONT_PORT` (both default `25565`)

Mount the custody directory and the whitelist file from the same source the
proxy writes to. The front leg listens on the container port `25565`. An empty
or missing attach whitelist makes `--start` exit with status 2.

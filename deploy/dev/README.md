# The dev validation lane

A parallel lane for validating a change without taking the live front down.
Issue [#42](https://github.com/Bafbi/monoplayer/issues/42), with its own account
from [#44](https://github.com/Bafbi/monoplayer/issues/44) and branch images from
[#43](https://github.com/Bafbi/monoplayer/issues/43).

## Why it exists

The live lane holds one writer and one replica of the puppet custody: the
account token chain is a rolling file, and two writers race it. So every test
that needs a real backend used to serialize against the live deployment, and
the testbed cycle took the live front down for the length of a run.

This lane has its own Paper, its own Monoplayer, and its own custody volume.
Compute is cheap. The one-writer identity is what shaped the split, so the lane
gets its own account rather than borrowing the live one.

| Piece | Where |
|---|---|
| `paper` | `monoplayer-dev`, Paper 26.2, online mode, secure profile, disposable |
| `monoplayer` | `monoplayer-dev`, the image under test, pointed at that Paper |
| `monoplayer-dev-custody` | the dev account only, `ReadWriteOnce`, one replica |
| `monoplayer-dev-config` | the attach whitelist: who may control the dev proxy |

## The first run

The dev account does not exist until someone signs in as it, so the first run has
an order.

1. **Bootstrap the account.** One device-code approval, then the account is
   headless until its refresh chain is revoked.

   ```bash
   mise run dev:custody:up   # a handle pod on the dev custody volume
   mise run dev:custody      # prints a URL and a code; approve it as the dev account
   mise run dev:custody:down # the proxy needs the volume, so hand it back
   ```

   The account lands in `/data/accounts/<uuid>/` with the alias `devpuppet`,
   which is the alias `deploy/dev/monoplayer.yaml` selects.

2. **Bring the lane up.**

   ```bash
   mise run dev:up      # Paper, and a proxy that waits for that account
   mise run dev:status  # pods, the whitelist, and the live replica count
   ```

`dev:custody` and the dev proxy cannot both hold the volume. The claim is
`ReadWriteOnce` on a two-node cluster and one account has one writer, so the
script refuses while the proxy is running and says how to clear it.

## The dev account

The dev account is a second Microsoft account, not GlowSquidye and not the
attaching player. `docs/custody.md` explains why two directories cannot hold one
account: the refresh token is rolling and single-use, so the copy that refreshed
last is live and the other is dead.

Its custody is on `monoplayer-dev-custody` and nowhere else. The image carries no
tokens, the manifests carry no UUID, and no pod in this namespace mounts the live
claim. `test/tooling/dev-custody.test.js` asserts that.

```bash
mise run dev:custody:status            # uuid, alias, files, lock state
mise run dev:custody:status -- --refresh   # the silent refresh, guarded
```

## Run the branch under test

The manifest carries `ghcr.io/bafbi/monoplayer:main`. Point it at the branch
image ([#43](https://github.com/Bafbi/monoplayer/issues/43)):

```bash
mise run dev:image sha-$(git rev-parse --short=7 HEAD)
```

The image workflow for a branch prints the same command when it finishes.

## Join it

The dev proxy's own account joins the dev Paper when the proxy starts, so the
join is a fact about the lane rather than a second process.

```bash
mise run dev:join
```

The task waits for the dev proxy, reads the account from its volume, and reads
the dev Paper's player list over RCON. It writes `.reports/dev-join.json`.

An earlier version ran a throwaway pod that copied the live account. That pod was
safe, because it could not refresh, but it made the live token part of a dev run.
The dev account exists to stop that.

## Proving the live account is untouched

[#44](https://github.com/Bafbi/monoplayer/issues/44)'s fourth criterion: the live
account's token files are byte-identical after a dev run. Measure it.

```bash
mise run dev:prove-live -- mise run dev:up
```

The task digests the live account's `profile.json` and `*-cache.json` through the
live pod's own mount before and after the command, then compares. It reads, never
scales, and never patches. `.reports/live-custody-digest.json` holds both digests,
the pod, and the command.

A difference is a failure, with one honest exception to check first: the live
proxy refreshes its own token chain on schedule, and a refresh inside the window
moves the files. The report names the pod and the command so that case is
diagnosable rather than mysterious.

## The attach whitelist

`--start` refuses an empty attach whitelist, so a lane with no controller can
never serve. `dev:up` fills the empty dev ConfigMap from the live one, which names
the human who attaches. The whitelist says who may control the proxy, not a token,
and the dev lane serves the same human. An operator's entries are never
overwritten.

## What it proves and what it does not

Proves: a real Paper server and a real Monoplayer run beside the live lane, the
live lane keeps its replicas and its front for the whole run, and the live
account's token files do not move.

Does not prove: anything about Excalia. The dev Paper has none of its plugins,
its menus, or its network path. The live servers remain the final oracle.

## It is not in Argo CD

`deploy/argocd/application.yaml` tracks `deploy/manifests` in the `monoplayer`
namespace and nothing else, so no manifest here can roll out to the live lane.
`test/tooling/dev-lane.test.js` asserts that, along with the namespace and
secret rules.

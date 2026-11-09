# The dev validation lane

A parallel lane for validating a change without taking the live front down.
Issue [#42](https://github.com/Bafbi/monoplayer/issues/42).

## Why it exists

The live lane holds one writer and one replica of the puppet custody: the
account token chain is a rolling file, and two writers race it. So every test
that needs a real backend used to serialize against the live deployment, and
the testbed cycle took the live front down for the length of a run.

This lane has its own Paper, its own Monoplayer, and its own custody volume.
Compute is cheap. The one-writer identity is what shaped the split, so the lane
gets its own account rather than borrowing the live one, and that account lands
with [#44](https://github.com/Bafbi/monoplayer/issues/44).

| Piece | Where |
|---|---|
| `paper` | `monoplayer-dev`, Paper 26.2, online mode, secure profile, disposable |
| `monoplayer` | `monoplayer-dev`, the image under test, pointed at that Paper |
| `monoplayer-dev-custody` | the dev account only, `ReadWriteOnce`, one replica |
| `monoplayer-dev-config` | the attach whitelist, empty until an operator fills it |

## Use it

```bash
mise run dev:up       # apply the lane, wait for Paper, report both lanes
mise run dev:status   # pods, the attach whitelist, and the live replica count
mise run dev:down     # delete the lane
```

`dev:up` creates the `dev-rcon` Secret on first use, with a random password, and
leaves it alone afterwards. A Secret value never goes into a manifest or into
git.

## Run the branch under test

The manifest carries `ghcr.io/bafbi/monoplayer:main`. Point it at the branch
image ([#43](https://github.com/Bafbi/monoplayer/issues/43)):

```bash
mise run dev:image sha-$(git rev-parse --short=7 HEAD)
```

The image workflow for a branch prints the same command when it finishes.

## Join it today

```bash
mise run dev:up    # the dev Paper
mise run dev:join  # a throwaway proxy pod against it
```

`dev:join` does **not** use the standing dev deployment. It runs
`scripts/online-cluster.sh` with the backend pointed at the dev Paper, so the
proxy is a throwaway pod that copies the live account's custody, refuses to
refresh it, and dies with the pod.

That is safe, and the reason is worth knowing. The custody rules are in
[docs/custody.md](../custody.md#sessions-copies-and-refresh), and only one of them
is about servers:

- **Sessions are not exclusive.** A second login to a *different* server is fine
  while the cached access token is fresh. Only a second login to the *same*
  server disconnects the first.
- **Refreshes are exclusive.** The refresh token is rolling and single-use, so two
  directories holding one account cannot both stay usable: the one that refreshed
  last is live and the other is dead.

So the risk is never the backend. It is the copy. A pod that may not refresh
cannot hurt the live chain, and `online-cluster.sh` stops rather than refresh.
**A standing dev deployment would live for weeks and would refresh**, which is why
the lane has no account of its own yet, and why that arrives with
[#44](https://github.com/Bafbi/monoplayer/issues/44).

## The attach whitelist

`monoplayer-dev-config` ships an empty attach whitelist. A join run copies the
live one from the cluster, so the attach account comes with the run. Fill it in
only if the standing deployment is ever used.

## What it proves and what it does not

Proves: a real Paper server and a real Monoplayer run beside the live lane, and
the live lane keeps its replicas and its front for the whole run.

Does not prove: anything about Excalia. The dev Paper has none of its plugins,
its menus, or its network path. The live servers remain the final oracle.

## It is not in Argo CD

`deploy/argocd/application.yaml` tracks `deploy/manifests` in the `monoplayer`
namespace and nothing else, so no manifest here can roll out to the live lane.
`test/tooling/dev-lane.test.js` asserts that, along with the namespace and
secret rules.

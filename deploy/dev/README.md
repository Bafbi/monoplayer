# The dev validation lane

A parallel lane for validating a change without taking the live front down.
Issue [#42](https://github.com/Bafbi/monoplayer/issues/42).

## Why it exists

The live lane holds one writer and one replica of the puppet custody: the
account token chain is a rolling file, and two writers race it. So every test
that needs a real backend used to serialize against the live deployment, and
the testbed cycle took the live front down for the length of a run.

This lane has its own Paper, its own Monoplayer, its own custody volume, and its
own account. Compute is cheap; the one-writer identity is what shaped the split,
so the lane gets its own account rather than borrowing the live one.

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
kubectl -n monoplayer-dev set image deploy/monoplayer \
  monoplayer=$(scripts/dev-lane.sh image sha-$(git rev-parse --short=7 HEAD))
kubectl -n monoplayer-dev rollout status deploy/monoplayer
```

## Before a bot can join

Two things are missing until their tickets land:

1. **The dev account.** The proxy waits for an account directory in
   `monoplayer-dev-custody`. Bootstrapping one headlessly is
   [#44](https://github.com/Bafbi/monoplayer/issues/44). Until then the Paper
   server runs, and the proxy does not join it.
2. **An attach UUID.** `monoplayer-dev-config` ships an empty whitelist. Add the
   attaching account and restart the proxy.

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

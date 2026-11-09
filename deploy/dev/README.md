# The dev validation lane

A parallel lane for validating a change without taking the live front down.
Issue [#42](https://github.com/Bafbi/monoplayer/issues/42), its own account from
[#44](https://github.com/Bafbi/monoplayer/issues/44), and branch images from
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

Nothing here runs in the live namespace, `monoplayer`. Nothing here is in Argo
CD. `AGENTS.md` states the rule that keeps it that way: no agent takes the live
lane down, scales it, or patches it for a test. `docs/testing-ladder.md` says
which lane each run belongs on.

## The first run

The dev account does not exist until someone signs in as it, so the first run has
an order: create the handle pod, approve the account, hand the volume back, bring
the lane up.

1. **Create the handle pod.** The volume starts empty, and the proxy waits for an
   account before it starts.

   ```bash
   mise run dev:custody:up
   ```

2. **Approve the account.** The command prints a URL and a short code to the
   terminal, then waits.

   ```bash
   mise run dev:custody      # approve it as the dev account
   ```

   Open the URL in any browser, sign in as the dev account, and approve. Sign in
   as the dev account and nothing else: the approval is what binds that account
   to this volume, and it is the only time the lane needs a person.

   The code expires in 15 minutes. An expired code is not a failure of the lane:
   run `mise run dev:custody` again for a new one. The command exits when
   Microsoft answers and prints `uuid`, `name`, and `alias`.
   `.reports/dev-custody.json` holds the same three fields. The device code is
   never written to a file, so a closed terminal is a new code, not a lost one.

   The account lands in `/data/accounts/<uuid>/` with the alias `devpuppet`,
   which is the alias `deploy/dev/monoplayer.yaml` selects.

3. **Hand the volume back.** The proxy needs the claim, and one account has one
   writer.

   ```bash
   mise run dev:custody:down
   ```

4. **Bring the lane up.**

   ```bash
   mise run dev:up      # Paper, and a proxy that waits for that account
   mise run dev:status  # pods, the whitelist, and the live replica count
   ```

   A lane with an account and an attach whitelist is up. `mise run dev:join`
   proves the account reached the dev Paper ([Join it](#join-it)).

After this, `mise run dev:down` stops the lane and **keeps the account**: the
claim, the namespace, and the Secrets stay, so coming back is `mise run dev:up`.
`mise run dev:down -- --purge` deletes the namespace and the account with it,
and the next run needs another device-code approval.

`dev:custody` and the dev proxy cannot both hold the volume. The claim is
`ReadWriteOnce`, so `mise run dev:custody:up` refuses while any pod of the
proxy exists, and a pod that is still terminating counts.

## The dev account

The dev account is a second Microsoft account, not GlowSquidye and not the
attaching player. Its alias is `devpuppet`.

**One account, one writer, one replica.** The refresh token is rolling and
single-use, so two writers race it and two copies of one account cannot both stay
usable: the copy that refreshed last is live, and the other is dead
([custody](../../docs/custody.md#sessions-copies-and-refresh)). The lane honors the
limit three ways. The claim is `ReadWriteOnce`. The
Deployment is `replicas: 1` with the `Recreate` strategy, so two proxy pods
never overlap. And the only other pod that mounts the claim is the bootstrap
handle pod, which `mise run dev:custody:up` refuses to create while the proxy
runs.

Its custody is on `monoplayer-dev-custody` and nowhere else. The image carries no
tokens, the manifests carry no UUID, and no pod in this namespace mounts the live
claim. `test/tooling/dev-custody.test.js` asserts that.

Both commands below read the volume through the handle pod, so run them between
`mise run dev:custody:up` and `mise run dev:custody:down`:

```bash
mise run dev:custody:status            # uuid, alias, files, lock state
mise run dev:custody:status -- --refresh   # the silent refresh, guarded
```

## When the volume is empty

The proxy waits for an account before it starts: its `wait-custody` init
container loops on `ls /data/accounts/*/profile.json` and logs
`waiting-for-dev-custody` while the volume holds none. A proxy pod at
`Init:0/2` with that line is this case, not a crash.

The proxy holds the claim, so the handle pod cannot. Stop the lane first, then
bootstrap:

```bash
mise run dev:down          # the proxy releases the claim. The account would survive
mise run dev:custody:up
mise run dev:custody
mise run dev:custody:down
mise run dev:up
mise run dev:join          # the account is on the dev Paper again
```

`mise run dev:down` returns before the old proxy pod is gone, and
`mise run dev:custody:up` refuses while any pod of the proxy exists, a
terminating one included. If it refuses, the old pod is still on its way out:
wait for it to disappear and run it again.

`mise run dev:up` prints "if the dev custody volume is empty, run: mise run
dev:custody" when it applies the proxy. That hint is half the sequence:
`dev:custody` needs the handle pod, and `mise run dev:custody:up` refuses while
the proxy holds the claim. Run `mise run dev:down` first, as above.

A volume that holds an account whose chain is dead is a different case.
`mise run dev:custody:status -- --refresh` reports `needs_bootstrap` when the
volume holds no refresh token, `needs_reauthentication` when Microsoft wants the
account signed in again, and `refresh_failed` when the chain was consumed or
revoked. Recovery is the same sequence, and it ends in a new approval. Never copy
an account directory in from another machine. A stale copy cannot refresh, and a
fresh one is a second writer.

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

The live account's token files are byte-identical after a dev run. Measure it.

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

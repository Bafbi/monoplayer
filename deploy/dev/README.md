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
| `paper` | `monoplayer-dev`, Paper 26.2, offline mode, no secure profile, disposable |
| `monoplayer` | `monoplayer-dev`, the image under test, pointed at that Paper |
| `monoplayer-dev-custody` | the dev account only, `ReadWriteOnce`, one replica |
| `monoplayer-dev-config` | the attach whitelist, and the one row the picker offers |
| `monoplayer-dev` Service | the front's tailnet name: how a client on another machine reaches the picker |

Nothing here runs in the live namespace, `monoplayer`. Nothing here is in Argo
CD. `AGENTS.md` states the rule that keeps it that way: no agent takes the live
lane down, scales it, or patches it for a test. `docs/testing-ladder.md` says
which lane each run belongs on.

## Offline, and why that is allowed here

The dev lane is the repository's offline picker lane
([#392](https://github.com/Bafbi/monoplayer/issues/392)): the one whose Paper is
disposable. Three things make it one, and each is a line in `deploy/dev/`:

- **The front serves the picker.** `MONOPLAYER_PICKER=1` lands a joining client in
  the picker instead of attaching it to a body as the driver, so it can claim a row
  or watch one.
- **The row it offers is a file Git commits.**
  `MONOPLAYER_ALLOWED_SERVERS_SEED` names `/config/allowed-servers.json`, and the
  lane's ConfigMap carries exactly one entry: this lane's own Paper, at
  `paper.monoplayer-dev.svc.cluster.local:25565`. The lane names no live key, so the
  seed is the list an operator reads in git, and `mise run dev:up` converges the
  cluster's copy back to it.
- **The front is on the tailnet as `monoplayer-dev`.** A client on another machine
  joins `monoplayer-dev.tail41e568.ts.net:25565` with no port-forward. The Paper is
  not published: a Paper anyone can join directly is a join that never reached a
  picker.

The live lane serves a picker too since
[#579](https://github.com/Bafbi/monoplayer/issues/579), so this is no longer the only
lane with one. What the dev lane adds is a Paper a claim can reach without the live
servers: the live picker offers Excalia, and a claim there moves the puppet in a world
real players are standing in. Every run below stays on this lane.

The Paper runs `ONLINE_MODE=FALSE` and `ENFORCE_SECURE_PROFILE=FALSE`. That is the
half of [#391](https://github.com/Bafbi/monoplayer/issues/391) this lane can land first:
a lane that exists to be joined by bots cannot run a Paper that refuses a login Mojang
never verified. Nothing needs it yet, and nothing is proved by it yet either. The front
is the Paper's only client, so the Paper's mode decides nothing about who may join the
lane, and the front still verifies that player against Mojang and the attach whitelist.
What it costs is the sign-in path this lane used to exercise, which the testbed's online
Papers still cover.

It is allowed here and nowhere a player reaches. An offline server answers a login under
any name, so a pod that can reach this Service could join as the puppet; the tree carries
no NetworkPolicy. What keeps that a dev lane's problem is scope: the Paper has no tailnet
Service and no published port, so the front is the only client it is meant to have; its
world is an `emptyDir` with one flat map; and the account behind it is the dev puppet,
not GlowSquidye. The live lane is the opposite case: it fronts Excalia for real players
and stays in online mode. The gate lane's M4 Paper is offline for its own reason, behind
a Velocity that authenticates in front of it and a forwarding secret Paper checks.

What the lane still cannot do is admit two bots. The front verifies a joining client
against Mojang before it shows a picker, so a client that reaches this picker has
authenticated as its own account, and the offline legs the loopback rungs use refuse
any host but loopback. #391 builds them into the composition root. Until it lands this
lane serves its picker to an authenticated client: a real client, or a bot that holds an
account. One client can claim. A second client on the same body needs the run that
[The two-client proof](#the-two-client-proof) describes, which wants two accounts and a
person at both.

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
   reports whether the account is on the dev Paper yet. Until a client claims a row
   it says the lane is idle. That is not a failure ([Join it](#join-it)).

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

## One run at a time on this lane

This is not a gate lane. It has no instance, no derived name and no reaper:
`monoplayer-dev` is one namespace for every worktree, and the dev account outlives
every run. Two agents get two gate lanes, and one dev lane unless one of them
names another namespace by hand.

`MONOPLAYER_DEV_NAMESPACE` names another namespace by hand. Nothing derives it and
nothing reaps it, because the claim holds the only copy of one account: a reaper
that deleted an idle dev lane would delete a refresh chain somebody has to approve
again.

So a dev run never goes beside another dev run. Three things make the second one
unsafe rather than slow:

- the proxy is one replica with the `Recreate` strategy, holding one
  `ReadWriteOnce` claim, so the lane has one writer of one account;
- `mise run dev:up` applies `deploy/dev`, whose Deployment carries
  `ghcr.io/bafbi/monoplayer:main`, so a second `up` drops a branch pin from under
  the first run; and `mise run dev:down` deletes the Deployment that run is using;
- one account joins one dev Paper, and a server kicks the first session when the
  same account opens two.

Every run above rungs 0-2 that needs this lane serialises on that.
`docs/testing-ladder.md` says which runs are doorways to it.

The lane's two Secrets are its own, and neither name carries an instance because
the lane has none. `mise run dev:up` generates `dev-rcon` when it is absent, and
`ghcr-pull` is copied once from the live lane. `mise run dev:down` keeps both.
`mise run dev:down -- --purge` deletes the namespace, and the Secrets with it.

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
mise run dev:join          # idle until a claim dials the body
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

That pin lives only in the namespace: no manifest carries it, so the retention job
in `.github/workflows/image-retention.yaml` cannot see it. The last 20 `sha-*` tags
stay, which covers a branch under review for about a day of merges. A pin that must
outlive that goes in `deploy/pins.txt`, one line, with the lane in a comment.
Delete the line once the lane moves back to `:main`.

## Join it

A picker lane dials no backend at boot: the proxy logs `backendBootSkipped` with reason
`picker`, and the first claim is what dials a body (#258, #266). So the command reports the
state it read from the lane's log, and then, once a claim has dialled, whether the Paper
lists the account.

```bash
mise run dev:join
```

With nothing claimed it says the lane is idle and exits 0. That is the lane working: it has a
picker to offer, no body to serve, and it is waiting for a claim. Claim a row in the picker,
then run the command again to prove the account reached the dev Paper.

Once a claim has dialled, the task waits for the dev Paper to list the account, and passes
when it does. When the claim's body did not land, it exits 1 and the sentence names
`claimDialFailed`, the record whose `reason` says why.

The task waits for the dev proxy, reads the account from its volume, and reads
the dev Paper's player list over RCON. It writes `.reports/dev-join.json`, and a script
reads `joined` from it, because exit 0 covers an idle lane as well as a join. Its `state`
says why the answer is what it is: what the script read from the lane's log.

| `state` | what the lane's log said |
|---|---|
| `idle` | a picker lane with no claim record at all |
| `claimed` | a claim dialled a body, and no landing followed it yet |
| `landed` | a claim's body landed, and it is not connected now |
| `claim-failed` | a claim did not land: `claimDialFailed`, or a `claimDialRefused` before any dial |
| `boot` | the lane's own record says the picker is off, so it dials at boot |
| `unknown` | the log said nothing about the boot, or could not be read |

`unknown` is the state where the command could not see the lane, rather than the lane
being wrong. Read the log it names before reading anything into the Paper's player list.

An earlier version ran a throwaway pod that copied the live account. That pod was
safe, because it could not refresh, but it made the live token part of a dev run.
The dev account exists to stop that.

## The two-client proof

A protocol bot does not render and it does not check a registry. #598 was a duplicate key in
one that every bot passed and a real client died on, so the claim that a client *sees* another
player is only proved by two clients and a person looking at them (#634).

This section stages that run and then reads what the lane recorded. The reading is the half a
machine can hold: it says which frames reached which socket. It cannot say what a client drew
with them, and no number here may be reported as if it could.

### What the two clients must be

Two accounts, both in the attach whitelist, and a person at two clients. The front verifies
every login against Mojang before it shows a picker, so a client joins as itself: an entry
whose UUID is not a real account's can never authenticate.

The second account is another person's own Minecraft account, and the list holds the UUID
Mojang answers for its name, which is the only form the list takes. Ask Mojang for it:

```bash
curl -s "https://api.mojang.com/users/profiles/minecraft/<name>"
```

That endpoint is the fallback `src/custody/store.js` resolves a name with. A name the
loopback rig invented, `Pilot` or `Watcher`, is not an account: its UUID is
`md5("OfflinePlayer:<name>")`, the shape the rig's own bots log in with
(`src/legs/offline-identity.js`), and this lane can never verify it.

The list that admits them is the lane's own document. Read it:

```bash
kubectl -n monoplayer-dev get cm monoplayer-dev-config \
  -o jsonpath='{.data.attach-whitelist\.json}'
```

Then add the second account, in the whole array: `{"version":1,"players":[{"uuid","name"}]}`,
where `name` and `addedAt` are optional and the list is exactly the accounts it names.

```bash
kubectl -n monoplayer-dev edit cm monoplayer-dev-config
```

An account that is not in it is refused at login with `not_whitelisted`, before any picker, so
the client sees a disconnect and not a dialog. `mise run dev:up` keeps the list it read before
its own apply, so an edited entry survives one, and `mise run dev:down` deletes the ConfigMap
and the list with it.

Use two accounts, not one twice. The lane does not refuse a second client of one account, and
what breaks then is quieter: a channel is never told about the player it speaks for, so two
clients of one account are never drawn for each other. That empty world looks exactly like the
bug this section exists to catch.

### Stage the lane

Run these three in order. The sections above say what each one does.

```bash
mise run dev:up                          # the Paper, and a proxy that waits for the dev account
mise run dev:image sha-<commit7>         # the branch under test, from its GHCR build
mise run dev:status                      # both pods up, and a verdict per whitelist entry
```

`mise run dev:image` needs the branch workflow's image: `mise run image:build` publishes to
Zot, which this namespace cannot resolve.

Nothing is on the Paper yet, and that is the lane working: a picker lane dials no backend at
boot, so the proxy logs `backendBootSkipped` with reason `picker` and the first claim is
what dials a body (#258). Until somebody claims, `mise run dev:join` says the lane is idle
and exits 0 ([Join it](#join-it)).

### Drive it

Join with a 26.2 client: the lane serves that version and refuses another.

1. Join `monoplayer-dev.tail41e568.ts.net:25565` as the first account. Pick the lane's one row
   and click **Claim**. Your client now drives the puppet: you are the body's driver.
2. Join the same address as the second account. The row now carries the claim and a watcher
   count of one. Pick that row and click **Spectate**.
3. As the first client, walk a few blocks, then break a block.
4. As the second client, look at where the first client stands. Then press F5 twice, and try
   to break a block.

### What you should see

One row per step. Read the last column only when the "You should see" cell for that step is not
what you see. The Step cell names that step, and the last column names the record that goes into
the log when it fails.

Every "You should see" cell is `OPERATOR_STEPS`'s `claim` for its step, word for word
(`src/driver/dev-proof.js`). `test/driver/dev-proof.test.js` reads the cell and the claim against
each other in both directions, so a row here cannot ask for something the witness does not record.
Of the other two cells the guard reads two things: that the last one names the step's record, and,
where `OPERATOR_STEPS` carries a `because` for the step, that the last cell is that sentence word
for word. The `spectator-mode` sentence is built with `spectatorModeFrames().length` in it, so a
third frame in `src/core/spectator-mode.js` fails the guard rather than leaving this page quietly
stale. The rest of their prose is this page's, and nothing compares it.

| Step | Look at | You should see | If you do not |
|---|---|---|---|
| `puppet-renders` | the watching client, the world | the puppet renders where the driving client stands, wearing the puppet's skin | a player with a default skin: `puppetSkinSent` holds the entry and its `signed` flag, and an unsigned texture is one the client cannot verify. That record is written for the driving client's own player too, because a client draws the body it controls from the entry naming itself. The reader takes only a `puppet` true line written after the landing as the body's entry. No player at all: `puppetSkinWithheld` or `puppetSkinRefused`, and no `puppetSkinKnown`: no entry was written, and a client drops the spawn that follows |
| `puppet-walks` | the watching client, while the driver walks | the puppet walks when the driving client walks, a fraction of a step behind | it stands still: the `heartbeat` counted `virtualPlayersMoved` 0, so no move frame reached a spectator |
| `spectator-mode` | the watching client, movement | the spectator flies, takes no damage, and cannot break or place | survival behaviour: `spectateView.modeFrames` was not 2 |
| `spectator-own-body` | the watching client, F5 | the spectator has no body of its own, and no hands in first person | a body is drawn, and the client collides with blocks: nothing tells the spectator its own player-list entry, and a replayed body keeps its own mode frames. #647 and #645 close it, and until then a witness records this step as not-seen |
| `drawn-for-driver` | the driving client, the world beside it | the spectator appears to the driving client, standing in the world and in the tab list, wearing a default skin | nothing beside it: no `virtualPlayerWritten` carried `player_info` or `spawn_entity` to the driver's channel |
| `drawn-once` | the driving client, the player you control | the driving client is drawn once, not twice: one body, and it is yours | a duplicate of yourself: a `virtualPlayerWritten` told the driver's channel about its own player |

A bot can assert the frames behind the last two rows, and `O71` does. What no bot can do is see
them drawn, which is why this table is a person's.

`drawn-for-driver` expects a default skin, and the reason is not on the row: the entry that tells
one channel about another client's body carries no texture, so a third party draws a default. #618
is about the spectator's own body, not this one.

`#645` is the other open half and it is invisible here: a spectator's replay carries the body's
own game mode frames, and the spectator's own pair is written last, so the client ends correct.
It is a frame on the wrong socket, not a screen you can catch.

Two clients cannot show a *third* one: that a spectator is drawn for another spectator is
`O71`'s, and it needs a third account in the same list, on the same body. Two clients cover
every row above.

### Read what the lane recorded

The proxy writes one JSONL record per event to its stdout. One command reads the run and
answers each claim above that a log can answer:

```bash
kubectl -n monoplayer-dev logs deploy/monoplayer | node src/driver/dev-proof.js
```

It exits 0 when every frame-level claim holds, 1 when one does not and names it, and 2 when no
spectator landed at all. Its rows end with the summary, and the witnessed steps are printed
between them, unanswered. Keep the output: `--path` reads a saved stream, so

```bash
kubectl -n monoplayer-dev logs deploy/monoplayer > .reports/dev-log.jsonl
node src/driver/dev-proof.js --path .reports/dev-log.jsonl --json > .reports/dev-proof.json
```

The log is the evidence, and `--json` writes a copy of the reading beside it. The witness records
which log its frames rows came from in `frames.source`, and `--verify` re-reads that file. Run
`node src/driver/dev-proof.js --verify --path FILE` to name a log the witness does not, or to
override the one it does.

The records behind it, and what each one rules out. `RECORDS` in `src/driver/dev-proof.js` is the
list these come from, and `test/driver/dev-proof.test.js` holds every row of this table to it, name
and sentence both ways, so a cell here is the module's sentence word for word. No other line of this
section is compared to anything, so a record's fact written in the prose is the copy that drifts.
The counter names below are the exception, and `test/tooling/dev-lane-proof.test.js` asks rather
than compares: it wants them here, and the service to count each one.

| Record | What it says |
|---|---|
| `pickerServed` | a client reached the picker. A run with none never joined the lane |
| `pickerDialog` | the picker's list was offered to a client: one `actions` entry per row, and the `bytes` it cost when the frame went out. It is written even when the write failed, so a client with `pickerServed` and no `pickerDialog` was never offered a list at all, and `pickerDialogFailed` beside it says why the write did not go |
| `pickerPick` | a client clicked a row on the picker and the click was read. It names that row's `slug` and, when the offer still held the row, its `server`. `known` is false when it did not. A run with `pickerServed` and no `pickerPick` is a client that never clicked one |
| `pickerServerDialog` | the chosen server's own dialog was offered, with the `verbs` a client may answer it with. It is written even when the write failed, so `pickerPick` with no `pickerVerb` is a client that was never shown this dialog, or never answered it, and `pickerServerDialogFailed` beside it says why the write did not go |
| `pickerVerb` | a client answered the chosen server's own dialog, carrying the `verb` (`claim`, `spectate` or `disconnect`) and the `server`. This is the click that dials a body or starts a landing. A verb the lane cannot act on writes `pickerVerbRefused` instead |
| `claimDial` | a client claimed a body, so a body was dialled. This is where the puppet reaches the Paper |
| `spectateView` | a spectator landed on a body. Its `channel` is the socket, `virtualFrames` is what it was told about the puppet's body, and `modeFrames` is the spectator game mode pair |
| `spectateRefused` | the Spectate click was refused, with the core's own reason |
| `spectateViewRefused` | the landing itself was refused, with the reason |
| `spectateModeRefused` | the spectator game mode pair could not be written to that socket |
| `puppetSkinSent` | #614's `player_info` went out: the body's entry, naming the puppet, or the driving client's own entry. `puppet` says which entry it is, `true` for the body's and `false` for the driver's own. `name` is the player it named, `signed` whether the puppet's textures property carried a signature, and `reason` what asked for it. It is one frame for the whole body, with no channel, so this record is the entry for every socket at once |
| `puppetSkinKnown` | the backend's own `player_info` carried a textures property for the puppet. Without it there is no entry to write, and a client drops the spawn that follows |
| `puppetSkinWithheld` | an entry the proxy would not write, because the profile it names has no UUID or no name |
| `puppetSkinRefused` | the entry could not be built, or the leg could not deliver it |
| `virtualPlayerWritten` | one per entry, spawn and despawn, naming the socket and the frame. The only record that says which channel a frame reached, because no counter names a channel |
| `virtualPlayerRefused` | the leg threw on a write, with the frame, the socket and the error |
| `virtualPlayerAnnounceRefused` | a player the proxy could not name, so no socket was told about it |
| `attachDenied` | a login was refused before the picker, with the reason. `not_whitelisted` is the account not being in the lane's list |
| `pickerEmpty` | the picker offered no row, so there was nothing to claim |
| `heartbeat` | the counters, every 30 seconds: `metrics.virtualPlayers*`, `metrics.skinFramesWritten`, and one row per socket with its role |

The reader prints the counters a run needs: `spectatorViews`, `skinFramesWritten`,
`virtualPlayersAnnounced`, `virtualPlayersSpawned`, `virtualPlayersMoved`,
`virtualPlayersDespawned` and `virtualPlayersRefused`. The frame counters count a frame the
leg answered for, so they say a socket took it. `spectatorViews` counts landings, and
`virtualPlayersRefused` counts writes that reached no socket at all. `virtualPlayersMoved`
is the process's, not a socket's: it also counts the spectator moving on the driver's own
socket, so a non-zero does not say whose move it was, and the walking row above is the
operator's to judge. None of them counts a pixel a client drew.

### Record what you saw

Saying "the puppet renders" is a witness, and only you can give it. The reader writes the
document that holds it, alongside the frames it read:

```bash
node src/driver/dev-proof.js --path .reports/dev-log.jsonl
```

That writes `.reports/dev-two-client-witness.json`. Its steps are the table above, in its order,
each `pending`. The check reads a row's `id` before anything else, then its `state` and `evidence`:

- `id`, the step's name and the name `--verify` reads first. Keep it as written.
- `state`, either `seen` or `not-seen`.
- `evidence`, what you saw, in place of the `[MANUAL: …]` placeholder it ships with.

Then set `completed` to `true`, copy the document to `testdata/dev-two-client-witness.json`, and
read the copy back:

```bash
cp .reports/dev-two-client-witness.json testdata/dev-two-client-witness.json
node src/driver/dev-proof.js --verify --path .reports/dev-log.jsonl
```

`--verify` reads `testdata/dev-two-client-witness.json`, which is why the copy comes first. With
`--verify --witness .reports/dev-two-client-witness.json` it reads the document you edited instead.
`testdata/driver-unmodded-witness.json` is the driver lane's record of the same kind. Run evidence
stays out of git, and `.gitignore` is where that rule lives.

It exits 1 and names what stops it. On the rows: a row that lost its `id`, a row whose `id` is no
step of this run, and a row that sits in another step's place. On the steps: a step still `pending`,
a step whose `evidence` is still the placeholder, and a step you recorded as `not-seen` that nothing
declares expected to be absent.

`--path` is what makes the frames half a check. `--verify` re-reads the run's rows from that log and
refuses a row, a field, or a run identity the copy contradicts, naming both values. With no log it
prints `the frames half was not re-read` and verifies on `frames.passed` alone: that is the run's
word, not a re-check. The log stays out of git, so re-read the log in the sitting that took the run,
or the witness carries a claim nobody can repeat.

A wrong `id` fails by name, not by a count. A row that lost one is refused with
`carries no step id`, and the message names the steps the rows must carry: `puppet-renders`,
`puppet-walks`, and the rest of the steps above. A reworded `id` is quoted back with the same list.

The `--path` is what makes the frames half a check. `--verify` re-reads the run's rows from that
log and refuses a row, a field, or a run identity the copy contradicts, naming both values. With no
log it prints `the frames half was not re-read` and verifies on `frames.passed` alone: that is the
run's word, not a re-check. The log stays out of git, so re-read the log in the sitting that took
the run, or the witness carries a claim nobody can repeat.

**A `not-seen` is a finding, unless that step is declared expected to be absent.** The
declarations are `OPERATOR_STEPS`'s, and the row whose last cell names the tickets that close a gap
is where you read one. Record that step `not-seen` with what you saw, and the check accepts that one
gap, printing a `known gap:` line that names the tickets. Any other `not-seen` stops the run, and
the refusal names the step it would have accepted, with its tickets. A proof with a known gap is
worth more than a proof nobody took.

The day those tickets land, record the step `seen`. The check accepts that too, and prints a
`stale declaration:` line: drop that step's declaration in the change that closes the ticket.

A green reader is not that report. It is the frame-level half, and the ticket that started
this one was filed because somebody read a counter as a proof.

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

An empty whitelist denies every login. It does not stop the lane: `--start` logs
`whitelistEmpty` and serves nobody until a controller is added.

The whitelist says who may control the proxy, not a token, and the dev lane
serves the same human.

Every entry has to be a UUID a Mojang session answers for, and no shape proves one does. The
front asks that question of every login (`src/legs/live-front.js`). The core's
`reviewLoginStart` (`src/core/identity.js`) then compares the uuid a login claims against this
list. `uuidRefusalReason` in `src/custody/util.js` answers the shape half, and its docstring
says what that answer settles and what it cannot.

A lane with no authentication mints a UUID from a name instead (`offlineUuid`,
`src/legs/offline-identity.js`), which is the shape the loopback rig's own controller list
carries, for the names its bots use. No account owns one.

`mise run dev:up` judges every list it writes: the document in the manifest, the list
the lane held, and the one it copies from the live lane. It leaves out every entry no
login can use, whatever its version, and prints the name it dropped. So neither a hand
edit nor a committed manifest puts a rig name back.

`mise run dev:status` judges each entry and says which ones a login can use. A
passing line says the UUID is the shape Mojang issues. It cannot say the account
behind it exists: that answer needs Mojang, and this command asks nobody.

`dev:up` builds the list in one order. The document in this manifest is the
default: an edit here reaches the lane on the next `up`, and it stands while it
names anyone. When the document names nobody, `up` writes back the controllers
the lane already had, because its own apply just reset the key. When there were
none either, `up` fills the list from the live ConfigMap, which names the human
who attaches.

The applied document is empty until that decision writes the key back, and a
mounted ConfigMap reaches a running pod on kubelet's schedule. A login that
arrives in that gap is refused.

`dev:down` deletes the ConfigMap, and the list with it. The next `up` applies the
lane again and decides from an empty list. An entry that is in neither this
manifest nor the live list is gone after a stop.

## What it proves and what it does not

Proves: a real Paper server and a real Monoplayer run beside the live lane, the
live lane keeps its replicas and its front for the whole run, and the live
account's token files do not move. It also proves the picker serves: the proxy's
`startLive` line carries `"picker":true` and the seed it read, so a lane that
offers nothing says so in its own log.

Does not prove: anything about Excalia. The dev Paper has none of its plugins,
its menus, or its network path. The live servers remain the final oracle. It does
not prove the two-client row either: [The two-client proof](#the-two-client-proof) is
that run, it needs two real accounts, and the half that says a client *drew* the puppet
is a person's, never this lane's log.

## It is not in Argo CD

`deploy/argocd/application.yaml` tracks `deploy/manifests` in the `monoplayer`
namespace and nothing else, so no manifest here can roll out to the live lane.
`test/tooling/dev-lane.test.js` asserts that, along with the namespace and
secret rules.

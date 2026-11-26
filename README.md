<img src="assets/icon.svg" width="64" height="64" alt="">

# monoplayer

A headless Minecraft account that stays online, and a whitelisted official client
that can attach to it and play normally.

## Architecture

The proposed architecture is in [docs/architecture.md](docs/architecture.md).
It covers the protocol approach, session lifecycle, auth and security, the
`mise` + BuildKit + Kubernetes validation loop, risks, and the first MVP slice.

The research, council, and audit trail lives under `.scratch/`, local only and
never in git.

## Transparency

What the server sees of the puppet's client identity — the Fabric Loader
brand, the human's client information, the view distance the puppet requests,
and the remaining tells — is in [docs/transparency.md](docs/transparency.md).

## The protocol spike

The frozen protocol spike is in `src/spike/` and `test/spike/`. It proves the
two-leg relay, synthesized play join, detach survival, reattach state, and
single backend login on loopback, and it grows no features.

The default gate runs the bottom three rungs of the testing ladder:

```bash
mise run check             # lint + node:test + offline loopback
mise run test              # unit tests only (loopback sockets, no auth)
mise run loopback          # product offline loopback rung (real legs, fake backend)
mise run spike             # frozen protocol spike (real sockets, offline protocol)
mise run spike:report      # full spike scenario, writes testdata/spike-report.json
mise run driver:scenario   # driver-lane G0 scenario against the gate Paper
mise run secrets:link      # symlink the main working copy's .secrets here (worktrees)
mise run online:cluster    # online rung from a throwaway pod, deployment untouched
```

Rungs, cost, prerequisites, what each catches, and which `verify:<area>` task
to run after touching relay, auth, driver, or deploy:
[docs/testing-ladder.md](docs/testing-ladder.md).

What it does and does not prove: [docs/protocol-spike.md](docs/protocol-spike.md).

## The driver lane, custody, and the live stack

The real-client testbed plan — Prism + Fabric driver, Vanilla/Paper backends,
Toxiproxy, two accounts, and the decompiled-source recipe — is in
[docs/driver-lane-plan.md](docs/driver-lane-plan.md).

The client driver is in [tools/driver/](tools/driver/); build it with
`mise run driver:build`. The host `nath` is driven with
`tools/nath.sh` (`env`, `launch`, `kill`, `shot`), which derives the Hyprland
session itself. It was validated on `nath` against Paper 26.1.2 on 2026-11-06:
[docs/driver-validation.md](docs/driver-validation.md).

The G0 scenario controller for the driver lane is in `src/driver/` driven by
`src/driver/run.js`: `node src/driver/run.js --runs 2` runs two consecutive fresh
client runs (quit + host-side relaunch between runs, no reconnect op), pairs
every client-side claim with positive RCON assertions, classifies every RCON
op as setup/assertion/probe, screenshots via `scp`, and writes per-run reports
plus a summary under `testdata/`. `node src/driver/run.js --lane unmodded`
generates the manual anti-masking witness checklist. `mise run driver:g0` runs
the two runs and then verifies them, so it exits 0 only for a fresh 2/2 plus a
completed witness, and it refuses evidence older than 24 hours
(`--max-age-hours`). The runbook with commands, evidence rules,
and failure modes is [docs/driver-lane.md](docs/driver-lane.md).

[The driver verdict](testdata/driver-verdict.md) is the record of that run: two
consecutive runs on 2026-11-06 and the manual unmodded witness's full
join/render/move/break/place/disconnect/rejoin row. Read it as dated evidence,
not as a standing claim. `mise run driver:g0` runs both again and verifies them.

**Custody and the attach check** have live evidence from 2026-11-07: `GlowSquidye` was bootstrapped
headlessly (Switch/Nintendo title), stable across silent refreshes,
Java-owned, multiplayer-allowed, with the player allowed and denied before
play by the real online-mode `hasJoined`/attach whitelist.

Token custody uses one directory per Minecraft UUID:
`.secrets/accounts/<uuid>/` holds `profile.json` and readable
`<family>-cache.json` files, with a per-account `writer.lock`. Two accounts now exist: **GlowSquidye** (the puppet, alias `glowsquidye`)
and **Bafbi** (the attaching player, alias `bafbi`, on the attach whitelist).
The GlowSquidye account was migrated in place on 2026-11-07: every token file is byte-identical,
`profile.json` keeps the alias `glowsquidye`, and the failed `puppet-java-403`
attempt is quarantined under `.secrets/retired/`. The dated evidence above was
recorded against the older `.secrets/puppet/` layout. Check the current tree
with `node src/custody/cli.js accounts` and `node src/custody/cli.js status --account
glowsquidye`; the runbook is [docs/custody.md](docs/custody.md).

**Paper behind Velocity** is up: Velocity 4.3.1 build 45 in front of Paper 26.1.2 b74 with modern
forwarding; the authenticated puppet joined through the proxy. The official
26.1.2 client has since attached through the full Velocity + Paper path,
rendered, moved, and edited blocks; [the live attach verdict](testdata/live-attach-verdict.md)
is that record. `mise run driver:parity`
passed on the dev lane on 2026-11-09 ([docs/driver-lane.md](docs/driver-lane.md)).
The F1-F6 fault rows are still pending
([docs/testing-ladder.md](docs/testing-ladder.md)).

Each verdict is one page in `testdata/`: [the protocol spike](testdata/spike-verdict.md),
[the driver lane](testdata/driver-verdict.md), [custody](testdata/custody-verdict.md),
[M4](testdata/m4-verdict.md), [the live attach](testdata/live-attach-verdict.md),
[the online rung](testdata/online-verdict.md), [the deployed service](testdata/service-verdict.md),
[the server's view of the puppet](testdata/observer-verdict.md), and
[the puppet's skin](testdata/skin-verdict.md).
Each page quotes the verdict, the date where the record carries one, and the fact
the run establishes, plus the command where the record names one. The records themselves stay in git history.

Created in [T3 Code](https://t3.codes).

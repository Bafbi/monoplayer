<img src="assets/icon.svg" width="64" height="64" alt="">

# monoplayer

A headless Minecraft account that stays online, and a whitelisted official client
that can attach to it and play normally.

## Architecture

The proposed architecture is in [docs/architecture.html](docs/architecture.html).
It covers the protocol approach, session lifecycle, auth and security, the
`mise` + BuildKit + Kubernetes validation loop, risks, and the first MVP slice.

The research, council, and audit trail lives under `.scratch/`, local only and
never in git.

## The protocol spike

The frozen protocol spike is in `src/spike/` and `test/spike/`. It proves the
two-leg relay, synthesized play join, detach survival, reattach state, and
single backend login on loopback, and it grows no features.

The default gate runs the bottom three rungs of the testing ladder:

```bash
mise run check             # lint + node:test + offline loopback
mise run test              # unit tests only (no sockets, no auth)
mise run loopback          # product offline loopback rung (real legs, fake backend)
mise run spike             # frozen protocol spike (real sockets, offline protocol)
mise run spike:report      # full spike scenario, writes testdata/spike-report.json
mise run driver:scenario   # driver-lane G0 scenario (live testbed)
```

Rungs, cost, prerequisites, what each catches, and which `verify:<area>` task
to run after touching relay, auth, driver, or deploy:
[docs/testing-ladder.md](docs/testing-ladder.md).

What it does and does not prove: [docs/protocol-spike.md](docs/protocol-spike.md).

## The driver lane, custody, and the live stack

The real-client testbed plan — Prism + Fabric driver, Vanilla/Paper backends,
Toxiproxy, two accounts, and the decompiled-source recipe — is in
[docs/driver-lane-plan.html](docs/driver-lane-plan.html).

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
generates the manual anti-masking witness checklist, and
`node src/driver/run.js --verify-g0` (= `mise run driver:g0`) exits 0 only for a
real 2/2 plus a completed witness. The runbook with commands, evidence rules,
and failure modes is [docs/driver-lane.md](docs/driver-lane.md).

The driver lane passed **2/2** on 2026-11-06 (38/38 assertions per run), and
the manual unmodded witness passed the full join/render/move/break/place/
disconnect/rejoin row. **G0 is green.**

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
rendered, moved, and edited blocks. B1 live is green; next are B2-B6.

Each verdict is one page in `testdata/`: [the protocol spike](testdata/spike-verdict.md),
[the driver lane](testdata/driver-verdict.md), [custody](testdata/custody-verdict.md),
[M4](testdata/m4-verdict.md), [the live attach](testdata/live-attach-verdict.md),
[the online rung](testdata/online-verdict.md), and [the deployed service](testdata/service-verdict.md).
Each page quotes the verdict, the date where the record carries one, and the fact
the run establishes, plus the command where the record names one. The records themselves stay in git history.

Created in [T3 Code](https://t3.codes).

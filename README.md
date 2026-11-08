<img src="assets/icon.svg" width="64" height="64" alt="">

# monoplayer

A headless Minecraft account that stays online, and a whitelisted official client
that can attach to it and play normally.

## Architecture

The proposed architecture is in [docs/architecture.html](docs/architecture.html).
It covers the protocol approach, session lifecycle, auth and security, the
`mise` + BuildKit + Kubernetes validation loop, risks, and the first MVP slice.

The working research, decision council, and audit trail live under
[.scratch/minecraft-puppet-proxy/](.scratch/minecraft-puppet-proxy/).

## Gate A

The protocol-level Gate A harness is in `src/` and `test/`. It proves the
two-leg relay, synthesized play join, detach survival, reattach state, and
single backend login on loopback.

The default gate runs the bottom three rungs of the testing ladder:

```bash
mise run check             # lint + node:test + offline loopback
mise run test              # unit tests only (no sockets, no auth)
mise run loopback          # product offline loopback rung (real legs, fake backend)
mise run spike             # frozen Gate A spike (real sockets, offline protocol)
mise run gate-a            # full Gate A scenario, writes testdata/gate-a-report.json
mise run gate-b:scenario   # driver-lane G0 scenario (live testbed)
```

Rungs, cost, prerequisites, what each catches, and which `verify:<area>` task
to run after touching relay, auth, driver, or deploy:
[docs/testing-ladder.md](docs/testing-ladder.md).

What it does and does not prove: [docs/gate-a.md](docs/gate-a.md).

## Gate B

The real-client testbed plan — Prism + Fabric driver, Vanilla/Paper backends,
Toxiproxy, two accounts, and the decompiled-source recipe — is in
[docs/gate-b-plan.html](docs/gate-b-plan.html).

The research and council trail lives under
[.scratch/minecraft-gate-b/](.scratch/minecraft-gate-b/).

The client driver is in [tools/gate-b-driver/](tools/gate-b-driver/); build it with
`mise run gate-b:driver:build`. It was validated on `nath` against Paper 26.1.2
on 2026-11-06: [docs/gate-b-driver-validation.md](docs/gate-b-driver-validation.md).

The G0 scenario controller for the driver lane is in `src/gate-b/` driven by
`src/gate-b.js`: `node src/gate-b.js --runs 2` runs two consecutive fresh
client runs (quit + host-side relaunch between runs, no reconnect op), pairs
every client-side claim with positive RCON assertions, classifies every RCON
op as setup/assertion/probe, screenshots via `scp`, and writes per-run reports
plus a summary under `testdata/`. `node src/gate-b.js --lane unmodded`
generates the manual anti-masking witness checklist, and
`node src/gate-b.js --verify-g0` (= `mise run gate-b:g0`) exits 0 only for a
real 2/2 plus a completed witness. The runbook with commands, evidence rules,
and failure modes is [docs/gate-b-g0.md](docs/gate-b-g0.md).

The driver lane passed **2/2** on 2026-11-06 (38/38 assertions per run), and
the manual unmodded witness passed the full join/render/move/break/place/
disconnect/rejoin row. **G0 is green.**

**G1 auth** has live evidence from 2026-11-07: `GlowSquidye` was bootstrapped
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
with `node src/auth/cli.js accounts` and `node src/auth/cli.js status --account
glowsquidye`; the runbook is [docs/gate-b-g1.md](docs/gate-b-g1.md).

**M4** is up: Velocity 4.3.1 build 45 in front of Paper 26.1.2 b74 with modern
forwarding; the authenticated puppet joined through the proxy. Evidence:
[testdata/gate-b-g1-verdict.json](testdata/gate-b-g1-verdict.json),
[testdata/gate-b-m4-verdict.json](testdata/gate-b-m4-verdict.json). The official
26.1.2 client has since attached through the full Velocity + Paper path,
rendered, moved, and edited blocks: [testdata/gate-b-m4-driver-verdict.json](testdata/gate-b-m4-driver-verdict.json). B1 live is
green; next are B2-B6.

Created in [T3 Code](https://t3.codes).

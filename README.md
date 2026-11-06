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

```bash
mise run check    # lint + node:test
mise run gate-a   # full scenario, writes testdata/gate-a-report.json
```

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
disconnect/rejoin row. **G0 is green.** Next: G1 auth readiness and the M4
Paper-behind-Velocity lane.

Created in [T3 Code](https://t3.codes).

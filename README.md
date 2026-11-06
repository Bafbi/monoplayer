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

Created in [T3 Code](https://t3.codes).

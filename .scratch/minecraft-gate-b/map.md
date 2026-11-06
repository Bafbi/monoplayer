# Map: Monoplayer Gate B testbed

## Destination

A decision-ready plan for **Gate B**: a repeatable testbed that proves Monoplayer
against a real Minecraft 26.1 client and a matrix of real backends, with an
optional server-side proxy, a safe two-account setup, and a repo-local way to
inspect decompiled Minecraft source when packet behaviour is unclear.

The output is `docs/gate-b-plan.html` (plus research notes and a council memo),
not the testbed itself.

## Notes

- Gate A protocol harness in this repo passes 37/37 assertions. It is a
  protocol-level subset, not a real-client gate.
- Target protocol remains **26.1 / 775**. Do not design a version matrix yet.
- The repo uses `mise` for tools and tasks; the homelab cluster is Talos with
  BuildKit in `deepmine-build` and zot in `deepmine-core`.
- No Microsoft credentials, tokens, or account secrets in git. Test accounts
  are owner-operated.
- The next gate must distinguish what a **protocol bot** can prove from what
  only an **official client** can prove.
- Research notes belong in `research/`; council memos in `council/`; audits in
  `audit/`.
- Gate A evidence: [`docs/gate-a.md`](../../docs/gate-a.md) and
  [`testdata/gate-a-report.json`](../../testdata/gate-a-report.json).
- Architecture context: [`docs/architecture.html`](../../docs/architecture.html).
- Gate B plan: [`docs/gate-b-plan.html`](../../docs/gate-b-plan.html).
- G0 host: `nath` (Omarchy/Arch, Hyprland Wayland, AMD Radeon OpenGL 4.6,
  Prism 11.0.3, Java 25, 26.1.2 instance).
- G0 backend: Paper 26.1.2 b74 in `monoplayer-gate-b`, Tailscale endpoint
  `monoplayer-gate-b-paper.tail41e568.ts.net:25565`, online-mode and
  secure-profile. Official client joined. The Fabric driver lane passed
  **2/2** on 2026-11-06 (38/38 assertions per run) with the repeatable
  `src/gate-b/` runner; the unmodded witness is still pending.
- Account roles (user-confirmed): `Bafbi` = player, `GlowSquidye` = puppet.
- Target topology (user-confirmed): Paper behind a proxy; Velocity is core, not
  a compatibility lane. Read-only/blocked chat is acceptable.
- Driver: `tools/gate-b-driver` builds a 26.1.2 Fabric client driver with a
  loopback JSON socket. Installed and validated on `nath`; the window is named
  `Monoplayer Gate B` and a Hyprland rule keeps it on workspace 9 without
  stealing focus. Evidence:
  [`docs/gate-b-driver-validation.md`](../../docs/gate-b-driver-validation.md).

## Decisions so far

- Gate A (protocol-level): two-leg relay, synthesized join, current-pose
  reattach, 5-second liveness soak, per-leg ownership, one backend login, and
  both-direction chat blocking pass. Official client, encryption, online-mode,
  Microsoft auth, config replay, and the 5-minute window remain unproven.
- [Research: controlling a real 26.1 client](issues/01-research-client-control.md):
  Prism + a thin Fabric driver is the deterministic instrument; one unmodded
  Prism run is the anti-masking witness. The `nath` host is confirmed and the
  official client has joined the Paper backend.
- Driver validation (2026-11-06): the repeatable `src/gate-b/` runner passed
  **2/2** consecutive runs against Paper 26.1.2 b74, 38/38 assertions each,
  with server-side position/block checks. The window is named
  `Monoplayer Gate B` so the Hyprland workspace-9 rule cannot catch normal
  Minecraft. Remaining: the manual unmodded witness.
- [Research: backend matrix and network harness](issues/02-research-backend-matrix.md):
  Vanilla 26.1.2 + Paper 26.1.2 b74 direct are the core; Fabric is a required
  compatibility report; Velocity is a proxy lane only if the target uses one;
  Toxiproxy sits on the puppet leg; cluster rows belong to `monoplayer-gate-b`.
- [Research: two-account setup and auth](issues/03-research-two-accounts.md):
  two distinct owner-operated MSAs; puppet headless only; player in Prism only;
  backend whitelist = puppet, attach whitelist = player; local `.secrets/`
  custody for v1; one writer/one replica.
- [Research: decompiled source](issues/04-research-decompiled-source.md):
  26.1 is unobfuscated; use a Loom/Vineflower recipe with no mappings, output in
  `.cache/minecraft/26.1.2/`, never commit the output; it is not a Gate B
  criterion.
- Council plan (3/3): driver + unmodded witness, Paper pass row + Vanilla parity,
  Fabric/Velocity compatibility lanes, Toxiproxy on the puppet leg, two
  accounts, decompile outside the gate. See
  [`docs/gate-b-plan.html`](../../docs/gate-b-plan.html).

## Not yet specified

- Which Prism account is the player and which is the headless puppet.
- Whether the unmodded witness runs before or after the 2/2 driver repetitions.
- Whether Fabric is an advertised target, which would promote M3 to
  gate-blocking.
- Whether the real target server sits behind Velocity/BungeeCord, which would
  promote the proxy lane.
- Whether read-only/blocked chat is acceptable for Gate B.
- Whether the decompiled-source recipe lands now or after the gate.
- The exact 5-minute soak and fault-repetition thresholds (3/3) are proposed;
  the HITL ticket still owns the final acceptance values.

## Out of scope

- Production deployment, billing, multi-account pooling, and public ingress.
- Bedrock Edition and cross-edition translation.
- Modded-client compatibility as a product feature.
- Replacing Deepmine's server-side Gate proxy.
- Committing decompiled Mojang code or redistributing Minecraft assets.
- Bypassing server anti-cheat, bans, or access controls.

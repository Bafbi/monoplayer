# Gate B driver: G0 passed 2/2 with a server assertion behind every client claim

Verdict: **PASS** on 2026-11-06. Two runs were requested, two ran, two passed, 38 of 38 assertions each. The manual unmodded witness recorded `COMPLETE` the same day.
Commands: `node src/driver/run.js --runs 2 --tunnel` (`mise run driver:scenario`), then `node src/driver/run.js --lane unmodded`, then `node src/driver/run.js --verify-g0` (`mise run driver:g0`).
Fact: every pass claim in those runs pairs the client's own state with an independent RCON assertion against the direct Paper G0 backend.

## The two driver runs

The summary recorded `gate: B`, `row: G0-host-readiness`, `lane: driver`, generated `2026-11-06T14:22:28.157Z`, `runsRequested: 2`, `runsExecuted: 2`, `runsPassed: 2`, `allPassed: true`, `stopReason: null`. It named the two reports:

- `testdata/driver-run1-2026-11-06T14-20-59-578Z.json`, nonce `mw52b8se-1`, 38 assertions, 0 failed, 45159 ms.
- `testdata/driver-run2-2026-11-06T14-20-59-578Z.json`, nonce `mw52c7mw-2`, 38 assertions, 0 failed, 43412 ms.

Both runs moved the player 3.018 blocks server-side (`moveDeltaBlocks: 3.018272344891116`). Each RCON op was classified: 11 setup, 8 assertion, 10 probe. Each driver op was classified: 8 action, 17 probe. Run 2 built its arena around `160.5,-60,160.5`, broke `164,-60,160`, and placed on `156,-60,160`; run 1 used `96.5,-60,96.5`, `100,-60,96`, and `92,-60,96`.

Each run copied one driver-owned render target back with `scp`:

- `testdata/screenshot-mw52bqrgu38etw-1793974882660.png`, 1403989 bytes, from `.../minecraft/screenshots/gate-b-1793974882660.png`.
- `testdata/screenshot-mw52co9wuw3sck-1793974926080.png`, 1395646 bytes, from `.../minecraft/screenshots/gate-b-1793974926080.png`.

## The G0 verdict

`testdata/driver-g0-verdict.json` recorded `PASS` at `2026-11-06T15:46:00.000Z` for row `G0 — host readiness`. It quoted `runsPassed: 2` of `runsExecuted: 2` at 38 assertions per run, the completed witness, and the environment: Paper 26.1.2 build 74 in `monoplayer-gate-b`, an AMD Radeon Graphics renderer on Mesa 26.2.2 and OpenGL 4.6, and a Tailscale direct route from `192.168.1.42:57019` to `100.123.154.16`. It names the command `mise run gate-b:g0`, which is now `mise run driver:g0`.

## The unmodded witness

Recorded at `2026-11-06T15:45:00.000Z` on Prism 11.0.3 with an unmodded 26.1.2 `gate-b-player` instance, account Bafbi, creative, overworld. All eight steps passed, on the operator's confirmation.

- Join: Paper logged `Bafbi joined the game` at 15:38:47 and RCON `list` showed the player.
- Move: the server-side position went from the arena-centre teleport `160.5,-60,160.5` to `154.1571710689975,-60,167.77723794342134`, which is 9.65 blocks.
- Break: `fill 150 -61 150 170 -61 170 minecraft:stone replace minecraft:air` reported `Successfully filled 7 block(s)`.
- Place: `fill 150 -60 150 170 -59 170 minecraft:air replace minecraft:stone` reported `Successfully filled 5 block(s)`, of which one was the driver's known cell at `156,-60,160`.
- Screenshot: `testdata/witness-2026-11-06.png`, 1916x1050, showing the arena, terrain, sky, hotbar, and crosshair.
- Disconnect at 15:43:38 and rejoin at 15:43:44, both read from the Paper log.

## Host tooling rows

Two screenshots from `docs/driver-validation.md` were the evidence for the host wrapper:

- `testdata/driver-ui-pause.png` (2026-11-07): the driver captured the unfocused pause menu, and `click Back to Game` returned the client to play.
- `testdata/nath-wrapper-2026-11-08.png` (2026-11-08, 1916x1050): `tools/nath.sh launch` reported `SILENT=yes` without touching the active workspace, `shot` returned the PNG, and `kill` reported `QUIT=ok` and closed the driver port.

## What this costs now that the files are gone

`mise run driver:g0` reads `testdata/driver-summary.json`, the two run reports, and `testdata/driver-unmodded-witness.json`. The checkout no longer supplies them, so the task reports `NOT 2/2` until a fresh `--runs 2` writes new reports and an operator records a new witness. `mise run check` never read any of them.

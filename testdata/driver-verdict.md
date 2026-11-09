# The driver lane passed 2 of 2 runs and the unmodded witness

Verdict: **PASS** on 2026-11-06. Two runs were requested, two ran, two passed, with 38 of 38 assertions each. The manual unmodded witness recorded `COMPLETE` the same day, then passed again on 2026-11-09 when the operator repeated it.
Date: 2026-11-06, the first run started at `2026-11-06T14:20:59.583Z` and the verdict was recorded at `2026-11-06T15:46:00.000Z`.
Commands: `node src/driver/run.js --runs 2 --tunnel` ran the two runs. `mise run driver:scenario` runs the same scenario without `--tunnel`. `node src/driver/run.js --lane unmodded` wrote the witness checklist, and `node src/driver/run.js --verify-g0` (`mise run driver:g0`) reads the reports and the witness.
Fact: each run recorded 38 assertions with a named evidence source, and 8 of its RCON ops per run were assertions checked on the server.

Sources: `testdata/driver-summary.json`, `testdata/driver-run1-2026-11-06T14-20-59-578Z.json`, `testdata/driver-run2-2026-11-06T14-20-59-578Z.json`, `testdata/driver-g0-verdict.json`, the 2026-11-06 `testdata/driver-unmodded-witness.json`, and five screenshots. The run records are removed from git. The 2026-11-09 witness record and its screenshot sit in the checkout and stay out of git. Every quote below comes from these files.

## The two runs

The summary recorded `gate: B`, `row: G0-host-readiness`, `lane: driver`, generated `2026-11-06T14:22:28.157Z`, `runsRequested: 2`, `runsExecuted: 2`, `runsPassed: 2`, `allPassed: true`, `stopReason: null`. It named the two reports it counted:

- `testdata/driver-run1-2026-11-06T14-20-59-578Z.json`, nonce `mw52b8se-1`, 38 assertions, 0 failed, 45159 ms.
- `testdata/driver-run2-2026-11-06T14-20-59-578Z.json`, nonce `mw52c7mw-2`, 38 assertions, 0 failed, 43412 ms.

Both runs moved the player 3.018 blocks server-side. Run 1 recorded `moveDeltaBlocks: 3.018272344891116` and run 2 recorded `3.0182723448911872`. Each run classified every RCON op: 11 setup, 8 assertion, 10 probe. It classified every driver op too: 8 action, 17 probe. Run 2 built its arena around `160.5,-60,160.5`, broke `164,-60,160`, and placed on `156,-60,160`. Run 1 used `96.5,-60,96.5`, `100,-60,96`, and `92,-60,96`.

Each run copied one driver-owned render target back with `scp`, a 1403989-byte PNG and a 1395646-byte PNG, both 1916x1050:

- `testdata/screenshot-mw52bqrgu38etw-1793974882660.png`, from `.../minecraft/screenshots/gate-b-1793974882660.png`.
- `testdata/screenshot-mw52co9wuw3sck-1793974926080.png`, from `.../minecraft/screenshots/gate-b-1793974926080.png`.

## The verdict file

`testdata/driver-g0-verdict.json` recorded `PASS` at `2026-11-06T15:46:00.000Z` for row `G0 — host readiness`. It quoted `runsPassed: 2` of `runsExecuted: 2` at 38 assertions per run, and it named the completed witness. It also recorded the environment: Paper 26.1.2 build 74 in `monoplayer-gate-b`, an AMD Radeon Graphics renderer on Mesa 26.2.2 with OpenGL 4.6, and a Tailscale direct route from `192.168.1.42:57019` to `100.123.154.16`. The command it names, `mise run gate-b:g0`, is now `mise run driver:g0`.

## The unmodded witness, 2026-11-06

The witness record was generated at `2026-11-06T14:23:48.781Z` and recorded at `2026-11-06T15:45:00.000Z`. It ran on Prism 11.0.3 with an unmodded 26.1.2 `gate-b-player` instance, account Bafbi, creative, overworld. All eight steps passed, on the operator's confirmation of every step.

- Join: Paper logged `Bafbi joined the game` at 15:38:47, and RCON `list` showed the player online.
- Render: the operator confirmed the chunks rendered. The screenshot shows the arena, terrain, sky, hotbar, and crosshair.
- Move: the server-side position went from the arena-centre teleport `160.5,-60,160.5` to `154.1571710689975,-60,167.77723794342134`, which is 9.65 blocks.
- Break: `fill 150 -61 150 170 -61 170 minecraft:stone replace minecraft:air` reported `Successfully filled 7 block(s)`.
- Place: `fill 150 -60 150 170 -59 170 minecraft:air replace minecraft:stone` reported `Successfully filled 5 block(s)`. One of those cells was the driver's own placement at `156,-60,160`, so four were the operator's.
- Disconnect at 15:43:38 and rejoin at 15:43:44, both read from the Paper log.
- Screenshot: `testdata/witness-2026-11-06.png`, 1916x1050 and 922777 bytes.

The record names its own limits. It is a manual lane with no driver, so the operator's confirmation carries the client side. It covers creative gamemode only, so a survival break and place remain unproven. The record names its own limits. It is a manual lane with no driver, so the operator's confirmation carries the client side. It covers creative gamemode only, so a survival break and place remain unproven. The post-run scans repaired the arena after the screenshot.

## The witness re-run, 2026-11-09

Verdict: **PASS**. All eight steps passed, and the server backed every one of them.
Date: 2026-11-09, the client joined at 01:37:37Z and the rejoin landed at 01:45:40Z.
Commands: `node src/driver/run.js --lane unmodded` wrote the checklist, `tools/nath.sh launch gate-b-player -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi` started the stock client, and `kubectl -n monoplayer-gate-b exec deploy/paper -- rcon-cli "<command>"` ran the server checks.
Fact: the same position came back after the rejoin, and the floor and the band around it changed only by what the operator did with a mouse.

Source: `testdata/driver-unmodded-witness.json` and `testdata/witness-2026-11-09.png`, both in the checkout but not in git. Every quote below comes from them.

The operator repeated the row because the 2026-11-06 record left git with the rest of the evidence, and a witness nobody can point at proves nothing. This time the arena was clean before the run: the setup fills reported `No blocks were filled`, and `execute if block 160 -61 160 minecraft:stone` reported `Test passed`.

- Join: Paper logged `Bafbi joined the game` at 01:37:37 as entity id 318. The client log read `Connecting to monoplayer-gate-b-paper.tail41e568.ts.net, 25565`, `[System] [CHAT] Bafbi joined the game`, and `Loaded 20 advancements`.
- Render: the operator confirmed the chunks rendered. The client log shows five `Resizing Chunk Sections UBO` lines during world load, up to `capacity limit of 32`.
- Move: the server-side position went from the arena-centre teleport `160.5,-60,160.5` to `162.4492974103905,-60,163.9253435774501`, which is 4.38 blocks. Rotation read `1.0500771, 5.850038`.
- Break: `fill 150 -61 150 170 -61 170 minecraft:stone replace minecraft:air` reported `Successfully filled 8 block(s)`.
- Place: `fill 150 -60 150 170 -59 170 minecraft:air replace minecraft:stone` reported `Successfully filled 4 block(s)`. The band held no stone before the run, so all four were the operator's.
- Disconnect: Paper logged `Bafbi lost connection: Disconnected` and `Bafbi left the game` at 01:45:20.
- Rejoin: Paper logged `Bafbi joined the game` at 01:45:40 as entity id 320, at `162.4492974103905,-60.0,163.9253435774501`. That is the position the player left from, so the reattach landed where the detach happened.
- Screenshot: `testdata/witness-2026-11-09.png`, 1052x1050 and 465635 bytes, taken before the scans repaired the arena.

The new record states its own limits, and two are new. The screenshot is a compositor capture of a tiled window, not a fullscreen client capture, because `tools/nath.sh shot` needs the driver mod and cannot capture an unmodded instance. That wrapper defect is [issue #54](https://github.com/Bafbi/monoplayer/issues/54). The client log prints no GL renderer this run, so the renderer is not recorded. The other limits match 2026-11-06: a manual lane with no driver, creative gamemode only, the scans repaired the arena after the screenshot, and edits outside `150..170` are not counted.

## Host tooling rows

Two screenshots backed the host wrapper and the driver's UI operations:

- `testdata/driver-ui-pause.png` (2026-11-07, 1916x1050, 1109427 bytes): the driver captured the pause menu of an unfocused window, and `click Back to Game` returned the client to play. `tools/driver/README.md` cites it.
- `testdata/nath-wrapper-2026-11-08.png` (2026-11-08, 1916x1050, 1393103 bytes): `tools/nath.sh launch` reported `SILENT=yes` without touching the active workspace, `shot` returned this PNG, and `kill` reported `QUIT=ok` and closed the driver port. `docs/driver-validation.md` cites it.

## Where the evidence lives now

The two runs are no longer committed. `mise run driver:g0` runs the scenario and then verifies what it wrote, accepts only evidence whose newest run finished within 24 hours, and needs a completed unmodded witness in the checkout. `mise run check` never read any of these files, and `docs/driver-lane.md` gives the commands.

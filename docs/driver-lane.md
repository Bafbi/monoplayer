# Driver lane runbook — G0

This is the runbook for the **G0 driver-lane evidence slice**: an official
Minecraft 26.1.2 client (Prism + the `gate-b-driver` Fabric mod on the
`nath` display host) joins the direct Paper 26.1.2 backend and the scenario
controller proves **join → settle → move → look → break → place → screenshot →
disconnect → quit → relaunch → rejoin**, twice in a row, with every pass claim
backed by client state **and** an independent server-side assertion.

This slice does **not** involve Monoplayer, Velocity, Toxiproxy, or any fault
row. It is the G0 host baseline (row M2 in the plan).

## Prerequisites (one-time)

1. **Backend:** Paper 26.1.2 b74 running in `monoplayer-gate-b` (see
   [deploy/driver/README.md](../deploy/driver/README.md)). RCON lives behind
   `kubectl -n monoplayer-gate-b exec deploy/paper -- rcon-cli`; the browser
   password is a cluster Secret and never leaves the pod.
2. **Display host:** `nath` reachable over SSH
   (`bafbi@nath.tail41e568.ts.net`), Prism 11.0.3 with the
   `gate-b-player-fabric` 26.1.2 instance and the built driver jar installed
   ([tools/driver/README.md](../tools/driver/README.md)).
3. **Cluster access:** `kubectl` context that can `exec` into the Paper pod.

## Driver tunnel (required each session)

The runner talks to the driver socket through an SSH tunnel. Either manage the
tunnel yourself:

```bash
ssh -N -L 25599:127.0.0.1:25599 bafbi@nath.tail41e568.ts.net
```

…or let the runner spawn and clean it up:

```bash
node src/driver/run.js --tunnel
```

Unit tests never touch SSH or the network (`node --test test/driver/checks.test.js`
is pure).

## Running the scenario

```bash
node src/driver/run.js --runs 2          # the G0 slice: two consecutive runs
mise run driver:scenario             # same thing via mise
node src/driver/run.js --runs 1 --force  # smoke / keep going after a failure
node src/driver/run.js --help            # all flags
```

Each run:

1. Verifies RCON reachability, quits any pre-existing driver client, waits for
   the driver port to close, and **relaunches a fresh client via SSH +
   prismlauncher**. There is deliberately **no reconnect op in the driver**
   (council correction #1); rejoin is always quit + host-side relaunch.
2. Builds a run-scoped 21x21 stone arena on the void map (floor `y=-61`, cleared
   `y=-60..-59`) far from the player's spawn platform, teleports to its centre,
   and positively preflights the expected block states (target air, support
   stone, floor under player). Edit targets are always ≥ 3 blocks from the
   player and never the block underfoot.
3. Stops the client settling (screen `none`, level + player, rendered sections
   > 0, `connected`, 120 s budget), gives `minecraft:stone 64` over RCON,
   moves ~700 ms (asserts server-side position delta and agreement with the
   client), looks to yaw 90 / pitch 10 (asserts server-side rotation with a
   2° tolerance), seeds a stone block, breaks it at explicit coordinates
   (asserts server-side air), places on the explicit support block
   (asserts server-side non-air *and* stone), captures a screenshot and copies
   it back with `scp`, disconnects (asserts client `connected:false` **and**
   RCON list without the player), quits (asserts the driver port closes), then
   relaunches and rejoins (asserts the client settles and RCON lists the
   player again). Two fresh backend logins per run are expected on the direct
   Paper lane; the `backendLogins=1` invariant belongs to the Monoplayer /
   Velocity lane, not G0.
4. Writes `testdata/driver-run<N>-<timestamp>.json` (plus the summary
   `testdata/driver-summary.json`). Every RCON op in the report is
   classified `setup | assertion | probe`, every assertion names its evidence
   `source: client | server | artifact`, and RCON output is scanned/redacted
   for token/password-shaped strings before writing.

`Exit 0` only when **all requested runs passed** (2/2 by default). A failing
run stops the loop unless `--force`.

## Result — 2026-11-06

`node src/driver/run.js --runs 2 --tunnel` passed **2/2**, with 38/38 assertions
per run. Both runs used fresh client processes, server-verified movement,
break/place, disconnect, and rejoin.

**G0 passes.** The manual unmodded witness was completed on 2026-11-06
(join, render, move, break, place, screenshot, disconnect, rejoin).
[`testdata/driver-verdict.md`](../testdata/driver-verdict.md) holds the verdict,
the per-run numbers, the witness record, and quotes the reports and screenshots
git no longer carries.

`mise run driver:g0` reads those reports and the witness, and the checkout no longer
carries them. Run `node src/driver/run.js --runs 2` and record a new witness to make
the task pass again.

## The unmodded witness lane

```bash
node src/driver/run.js --lane unmodded   # writes a manual checklist, exits 1
```

The driver is a mod, so it can mask a vanilla bug (anti-masking rule). The
witness run is done once, **by hand, on an unmodded Prism instance**, using the
checklist the command generates. When every step is honestly recorded, save the
completed checklist as `testdata/driver-unmodded-witness.json` with
`completed: true`.

## The G0 verdict

```bash
node src/driver/run.js --verify-g0
mise run driver:g0                  # same thing via mise
```

Exits 0 **only** when there are **two consecutive passed driver-lane reports**
and the **unmodded witness is completed**. "2/2" means exactly that: both
consecutive runs passed every assertion in their reports; nothing is averaged
or carried over between runs.

## What is automated vs manual

| Thing | How |
|---|---|
| Client launch / relaunch | Automated (SSH + prismlauncher via the injected relaunch adapter) |
| Status polling, settle detection | Automated (driver `status`) |
| Movement / look / break / place | Automated (driver ops through the vanilla input path) |
| Server-side assertions | Automated (RCON via `kubectl exec`) |
| Screenshot copy-back | Automated (`scp`) |
| Tunnel | Operator-managed or `--tunnel` |
| Unmodded witness | **Manual** (checklist lane) |
| Final G0 claim | Operator runs `node src/driver/run.js --runs 2` and `--verify-g0` |

## Failure modes seen so far

- **"Could not set the block"** style errors are *not* passes. All block
  assertions are positive `execute [unless] if block` commands whose
  "Test passed" verdict is parsed (`src/driver/checks.js`); anything else is
  `unknown` and fails the run.
- **Driver unreachable:** the tunnel is down or the client is gone. Start the
  tunnel; the runner will relaunch a fresh client itself after preconditions
  (it only quits/relaunches; it never teleports a dead client).
- **Relaunch fails:** the SSH/prismlauncher path requires the Hyprland session
  on `nath` to be alive, with `DISPLAY`, `XDG_RUNTIME_DIR`, and
  `WAYLAND_DISPLAY` set. `DISPLAY` is required: Minecraft's GLFW uses
  XWayland even on this Wayland session, and without it the client crashes
  during init and Prism opens its error console. `tools/nath.sh launch` inherits
  all three from the compositor; `tools/nath.sh env` derives and prints them for
  a manual run. See
  [driver-validation.md](driver-validation.md#driving-the-host-from-the-workspace).
  Under the runner the client lands on workspace 9 silently via the
  window-title rule. Prism's per-instance
  console is disabled (`OverrideConsole=true`, `ShowConsole=false`,
  `ShowConsoleOnError=false`) so a normal relaunch cannot raise a log panel.
- **Place fails with an empty hotbar slot:** the driver places from the
  *selected* slot; `/give` fills the first empty slot, so repeated runs keep
  the item. The report records `held` from the client as evidence.
- **Port-close detection:** the tunnel keeps local port 25599 accepting even
  when the client is gone; "closed" is therefore detected as connect-fail or
  immediate drop *after* a success. If the tunnel dies mid-run the run fails
  honestly at the next probe.

## Current limitations (recorded in every report)

- Creative gamemode only; survival-rate break/place holds are not exercised.
- No driver reconnect op by design; rejoin = quit + host-side relaunch.
- The unmodded witness is a separate, still-pending manual lane.
- The driver does not select hotbar slots (relies on `/give` filling the
  selected slot).
- The backend world is an `emptyDir` void map; pod restarts wipe edits and the
  arenas are rebuildable at run-scoped coordinates.
- Five-minute detach, Monoplayer, Velocity, Toxiproxy, and fault rows are all
  **out of scope for G0** and untouched by this runner.

# Driver lane runbook — G0

This is the runbook for the **G0 driver-lane evidence slice**: an official
Minecraft 26.2 client (Prism + the `gate-b-driver` Fabric mod on the
`nath` display host) joins the direct Paper 26.2 backend and the scenario
controller proves **join → settle → move → look → break → place → screenshot →
disconnect → quit → relaunch → rejoin**, twice in a row, with every pass claim
backed by client state **and** an independent server-side assertion.

This slice does **not** involve Monoplayer, Velocity, Toxiproxy, or any fault
row. It is the G0 host baseline (row M2 in the plan).

## Prerequisites (one-time)

1. **Backend:** Paper 26.2 b135 running in `monoplayer-gate-b` (see
   [deploy/driver/README.md](../deploy/driver/README.md)). RCON lives behind
   `kubectl -n monoplayer-gate-b exec deploy/paper -- rcon-cli`; the browser
   password is a cluster Secret and never leaves the pod.
   The driver client and this backend serve the same version. The scenario still
   refuses a target the driver was not built for, before the first launch
   (`versionRefusal` in `src/driver/checks.js`), so a version skew is named
   rather than debugged as a driver bug.
2. **Display host:** `nath` reachable over SSH
   (`bafbi@nath.tail41e568.ts.net`), Prism 11.0.3 with the
   `gate-b-player-262-fabric` 26.2 instance and the built driver jar installed
   ([tools/driver/README.md](../tools/driver/README.md)). The unmodded
   `gate-b-player-262` 26.2 instance is the one the witness lane uses. The older
   `gate-b-player-fabric` 26.1.2 instance stays on the host as the record of the
   G0 run on that version, and the 26.2 client cannot join with it.
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

This is the record of that day, not a standing claim: `mise run driver:g0` runs
the two runs again and verifies them.

`node src/driver/run.js --runs 2 --tunnel` passed **2/2**, with 38/38 assertions
per run. Both runs used fresh client processes, server-verified movement,
break/place, disconnect, and rejoin.

**G0 passed.** The manual unmodded witness was completed on 2026-11-06
(join, render, move, break, place, screenshot, disconnect, rejoin).
[`testdata/driver-verdict.md`](../testdata/driver-verdict.md) holds the verdict,
the per-run numbers, the witness record, and quotes the reports and screenshots
git no longer carries.

`mise run driver:g0` runs the two runs first and verifies what it wrote, so no
committed report set is needed. It needs a completed unmodded witness in this
checkout, and it refuses evidence whose newest run finished more than 24 hours
ago.

## The unmodded witness lane

```bash
node src/driver/run.js --lane unmodded   # writes a manual checklist, exits 1
```

The driver is a mod, so it can mask a vanilla bug (anti-masking rule). The
witness run is done once, **by hand, on an unmodded Prism instance**, using the
checklist the command generates. When every step is honestly recorded, save the
completed checklist as `testdata/driver-unmodded-witness.json` with
`completed: true`.

Capture the steps with `tools/nath.sh shot <path> gate-b-player-262`. Without a
driver, that path moves the view to the client's workspace for the capture and
back, after a notification that warns `NATH_SHOT_NOTICE` seconds ahead.

## The G0 verdict

```bash
mise run driver:g0                    # run the two runs, then verify them
node src/driver/run.js --verify-g0    # verify only, run nothing
```

`mise run driver:g0` composes the gate, the driver build, and `driver:scenario`,
so a red gate or a stale driver jar stops it before anything runs. Both commands exit 0 **only** when this checkout holds **two consecutive
passed driver-lane reports whose newest run finished within 24 hours**, and the
**unmodded witness is completed**. "2/2" means both consecutive runs passed
every assertion in their reports, and nothing is averaged or carried over.

The age window exists because a report set sitting on disk proves nothing on its
own: before 2026-11-09 the reports were committed, so the check passed without
anything having run. Move the window with `--max-age-hours N`.

## Client parity lane (#62)

Rung 4's other half: does the real client end up in the same state when it joins
a backend directly and when it joins that backend through the proxy.

```bash
node src/driver/run.js --lane parity --tunnel \
  --direct 127.0.0.1:25565 --proxied 127.0.0.1:25566
mise run driver:parity          # the same, with the driver tunnel and the gate
```

One command, two runs. The lane quits whatever client holds the driver socket,
relaunches it joined to `--direct`, waits for it to settle, reads `status` and
`screen`, quits, then does the same for `--proxied`. Two runs of one account
cannot overlap: a server kicks the first session, and the driver has no
reconnect op.

Reads `.reports/driver-parity-report.json`. Exit 0 every difference explained,
1 an unexplained difference, 2 a refused endpoint, a lane that never settled, or a
report that could not be written.
The report is metadata only, scanned for token-shaped strings before it is
written.

Both endpoints are refused when they name the live Excalia fleet, the live
deployment in front of it (`deploy/manifests/service.yaml`), or a `playit.gg`
tunnel to it (`deploy/manifests/playit-agent.yaml`; see
[public-access.md](public-access.md)), so a mistyped flag cannot measure a server
this repo does not own. A paid tunnel's custom domain has no suffix to catch, so
that one stays a rule for the operator.

### Reaching the dev lane

The dev lane's services are ClusterIP, and the client runs on `nath`, not in the
cluster. Two port-forwards and one reverse tunnel put both endpoints on the
display host's loopback, which is what the default flags expect:

```bash
kubectl -n monoplayer-dev port-forward svc/paper 25565:25565 &
kubectl -n monoplayer-dev port-forward svc/monoplayer 25566:25565 &
ssh -N -R 25565:127.0.0.1:25565 -R 25566:127.0.0.1:25566 \
  bafbi@nath.tail41e568.ts.net &
mise run driver:parity
```

The dev proxy's attach whitelist must name the account the client joins with
(`docs/testing-ladder.md`, the client parity rung), and the dev lane must be up
(`mise run dev:up`). Stop the three background processes when the run ends.

### The transfer testbed

The testbed front is a Tailscale load balancer, so only its backend needs a
forward:

```bash
kubectl -n monoplayer-gate-b port-forward svc/paper-hub 25565:25565 &
ssh -N -R 25565:127.0.0.1:25565 bafbi@nath.tail41e568.ts.net &
node src/driver/run.js --lane parity --tunnel \
  --direct 127.0.0.1:25565 \
  --proxied monoplayer-testbed.tail41e568.ts.net:25565
```

`mise run testbed:up` takes the live front down and leaves it down until an
operator runs `mise run testbed:down`. Clear it with the operator first.

## Result — 2026-11-09 (parity lane, dev lane)

`mise run driver:parity` passed on the dev lane with the driver on Minecraft 26.2:
12 fields, 9 same, 3 expected, 0 unexplained, in 46 s.

| Side | Endpoint | Settled | Client reported |
|---|---|---|---|
| direct | `127.0.0.1:25565` → dev Paper 26.2 | 18 s | `127.0.0.1:25565` |
| proxied | `127.0.0.1:25566` → dev Monoplayer 26.2 | 28 s | `127.0.0.1:25566` |

The three expected rows were the pose, and the two counts that follow the chunk
set: pose `5.5/-60/-3.5` direct against `8.5/-60/-4.5` proxied, loaded chunks 40
against 213, rendered sections 18 against 36. The 5x chunk gap is the attach
replay serving the puppeted session's cached chunks against a fresh join that
streams its own, not a stutter. Health, dimension, name, connection, level,
player, screen, held item, and selected slot all matched exactly.

A second run passed the same way (9 same, 3 expected, 0 unexplained; 28 s per
lane), from a cold start with no client on the socket.

The two endpoints were reached through the port-forwards and reverse tunnel in
"Reaching the dev lane", so the client joined the dev lane's own Paper and its own
Monoplayer, never the live deployment.

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
| Final G0 claim | Operator runs `mise run driver:g0` (runs the scenario, then verifies) |

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
  window-title rule. A relaunch through `tools/nath.sh launch` while another
  client is up goes to the running PrismLauncher, and the exec rule cannot reach
  that process. `launch` moves the window to 9 after it appears. Prism's per-instance
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
- The unmodded Prism witness is a separate manual lane, run by hand against the
  gate Paper. Its record is quoted in
  [the driver verdict](../testdata/driver-verdict.md). This report carries no
  anti-masking evidence of its own.
- The driver does not select hotbar slots (relies on `/give` filling the
  selected slot).
- The backend world is an `emptyDir` void map; pod restarts wipe edits and the
  arenas are rebuildable at run-scoped coordinates.
- Five-minute detach, Monoplayer, Velocity, Toxiproxy, and fault rows are all
  **out of scope for G0** and untouched by this runner.

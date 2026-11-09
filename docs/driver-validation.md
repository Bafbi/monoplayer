# Client driver validation — 2026-11-06

Validated the Fabric client driver against the real Paper backend on the `nath`
display host. This is the driver leg of G0, not the unmodded witness.

## Environment

| Piece | Value |
|---|---|
| Host | `nath` (Omarchy/Arch, Hyprland 0.56.2, Prism 11.0.3) |
| Client | Minecraft 26.1.2, Fabric Loader 0.20.1, Java 25.0.1 runtime |
| Driver | `gate-b-driver` 0.1.0, loopback `127.0.0.1:25599` via SSH tunnel |
| Backend | Paper 26.1.2 build 74 in `monoplayer-gate-b` |
| Server | `monoplayer-gate-b-paper.tail41e568.ts.net:25565` (online-mode) |

## Driving the host from the workspace

`tools/nath.sh` wraps the host commands this document used to spell out by
hand. `env`, `launch`, and the `kill` fallback derive the session on the host
with `hyprctl instances -j` and store nothing, so no caller pastes a session
triple. `shot` and the driver `quit` need no session at all.

```bash
tools/nath.sh env
tools/nath.sh launch gate-b-player-fabric \
  -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi
tools/nath.sh kill gate-b-player-fabric
tools/nath.sh shot testdata/gate-b-witness-2026-11-06.png
```

- `env` prints `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, and the
  signature as `KEY=value`. Prefix each line with `export` when a child process
  needs them.
- `launch` hands the client to the compositor with `hl.dsp.exec_cmd` and the
  rules `{ workspace = "9 silent", no_initial_focus = true, focus_on_activate = false }`.
  The child inherits the session environment, and the window lands on workspace 9
  without switching to it. Anything after the instance name goes to
  `prismlauncher`.
- `shot` asks the driver for its render target and copies the PNG back with
  `scp`. It needs the mod and no Hyprland state, and it never moves the desktop.
  This follows [the driver-lane ADR](adr/driver-lane-and-unmodded-witness.md),
  which already rejects screen-reading automation on the official client.
- `kill` sends the driver `quit`, then falls back to the client JVM's
  `-Djava.library.path` anchor for a wedged client.

Verified on `nath` on 2026-11-08 with no session variables exported:
`launch` reported `SILENT=yes` and left the active workspace and the focused
window untouched, `shot` returned
[`testdata/nath-wrapper-2026-11-08.png`](../testdata/nath-wrapper-2026-11-08.png)
(1916x1050), and `kill` reported `QUIT=ok`, stopped the client JVM, and closed
the driver port. The host reported a Hyprland instance signature the earlier
sessions never saw, which is why the wrapper derives it on every call instead of
copying one.

## Host quirks worth remembering

- Hyprland 0.56.2 reads a Lua config. `hyprctl dispatch movetoworkspacesilent`
  no longer parses; the working call is
  `hyprctl eval 'hl.dispatch(hl.dsp.window.move({ ... }))'`.
- `grim` needs `WAYLAND_DISPLAY`, not the signature. Without it grim fails with
  `failed to create display`.
- `grim -g` captures the active workspace only: a window parked on workspace 9 is
  a picture of whatever the user is looking at. That is why `shot` uses the
  driver, and why the manual witness lane needs the workspace on screen.
- `pgrep -f gate-b-player` also matches the `ssh`/tailscaled/bash line that
  carries the pattern. Anchor on `-Djava.library.path=.../instances/<name>/natives`.
- `jq` on the host is fine. `kubectl` is not: RCON lives on the workspace side.

## What passed

- `status`: connected, health 20, overworld, 117 loaded chunks, rendered
  sections > 0.
- `move`: the client moved and the server-side position changed.
- `look`: the client rotation changed and the server-side rotation matched.
- `break`: a seeded stone block at `(14, -60, -4)` was removed; a server-side
  `setblock ... air` then reported "Could not set" (already air), so the break
  persisted rather than only existing as a client prediction.
- `place`: with support at `(14, -61, -4)`, `place 14 -61 -4` placed stone at
  `(14, -60, -4)`; the server-side target was no longer air.
- `screenshot`: PNG written under the instance screenshots directory and copied
  back to the workspace.
- `respawn`: recovered from the death screen (health 0, y −358) to health 20 at
  the world spawn.
- `disconnect`: client reached `JoinMultiplayerScreen`, `connected: false`.
- `quit`: the client process exited and the driver port closed.

## Bugs found and fixed

- `break` called `MultiPlayerGameMode.destroyBlock`, which only mutates the
  client level and never sends a break packet. It now aims at the block and
  holds the attack input for `ms`.
- `place` used a centre-of-block contact point and had no way to name the
  support block. It now accepts explicit `x y z`, aims at the top face, and
  holds the use input.
- The default break target was the block under the player. On the void test map
  that dropped the account into the void and killed it. It now defaults to the
  ground block in front; tests should pass explicit coordinates.
- `install.sh` pinned Fabric intermediary `0.0.0`, which Prism's meta API now
  serves as 404. It pins `26.1.2`.
- Added `respawn` so a death screen can be cleared without touching the GUI.

## Window name and desktop placement

The driver mixin overrides `Minecraft.createTitle()` so the driver window is
named `Monoplayer Gate B` (override with `-Dgateb.window.title=...`). The title
is frozen because the operator's Hyprland rule matches it. On
Wayland that is also the app_id/class, so a Hyprland rule can target only this
client:

```lua
o.window("Monoplayer Gate B", {
  workspace = "9 silent",
  no_initial_focus = true,
  focus_on_activate = false,
})
```

Verified on `nath`: the window landed on workspace 9 without switching the
active workspace (T3 Code stayed focused on workspace 3). That rule covers the
runner's CLI launches. `tools/nath.sh launch` passes the same placement as
exec rules to the compositor, so it keeps the window off your workspace even on
a host without the config entry. Normal Minecraft
windows keep their `Minecraft* 26.1.2` class and are not matched.

Prism's per-instance console window is reused across launches, so the console
rule is best-effort. Set `OverrideConsole=true` and `ShowConsole=false` while
Prism is closed if the console window should be removed entirely.

## Remaining G0 work

- The driver lane is now **2/2**: `node src/driver/run.js --runs 2 --tunnel` passed
  twice on 2026-11-06, 38/38 assertions each, with server-side position and
  block checks. Reports:
  [`testdata/driver-run1-2026-11-06T14-20-59-578Z.json`](../testdata/driver-run1-2026-11-06T14-20-59-578Z.json)
  and
  [`testdata/driver-run2-2026-11-06T14-20-59-578Z.json`](../testdata/driver-run2-2026-11-06T14-20-59-578Z.json).
- The unmodded Prism client witness (no driver) was completed on 2026-11-06
  (join, render, move, break, place, screenshot, disconnect, rejoin). See
  [`testdata/driver-unmodded-witness.json`](../testdata/driver-unmodded-witness.json)
  and
  [`testdata/witness-2026-11-06.png`](../testdata/witness-2026-11-06.png).
  `mise run driver:g0` now exits 0.
- Assert a survival (non-creative) break/place hold, not just the creative row.

The repeatable runner for exactly this row is now in `src/driver/` +
`src/driver/run.js`; see the runbook [docs/driver-lane.md](driver-lane.md). It
automates: fresh-process relaunch per run (quit + SSH/Prism, no reconnect op),
run-scoped arena coordinates with preflight block states, paired client/RCON
assertions (positive `execute if block` only — "Could not set" is never a
pass), classified RCON ops (setup/assertion/probe), screenshot copy-back via
scp, per-run reports, and the `--runs 2` / `--verify-g0` gates
(`mise run driver:scenario`, `mise run driver:g0`). The one-off manual checks
that validated this driver remain recorded above.

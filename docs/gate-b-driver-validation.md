# Gate B driver validation — 2026-11-06

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

The driver mixin overrides `Minecraft.createTitle()` so the Gate B window is
named `Monoplayer Gate B` (override with `-Dgateb.window.title=...`). On
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
active workspace (T3 Code stayed focused on workspace 3). Normal Minecraft
windows keep their `Minecraft* 26.1.2` class and are not matched.

Prism's per-instance console window is reused across launches, so the console
rule is best-effort. Set `OverrideConsole=true` and `ShowConsole=false` while
Prism is closed if the console window should be removed entirely.

## Remaining G0 work

- The driver lane is now **2/2**: `node src/gate-b.js --runs 2 --tunnel` passed
  twice on 2026-11-06, 38/38 assertions each, with server-side position and
  block checks. Reports:
  [`testdata/gate-b-driver-run1-2026-11-06T14-20-59-578Z.json`](../testdata/gate-b-driver-run1-2026-11-06T14-20-59-578Z.json)
  and
  [`testdata/gate-b-driver-run2-2026-11-06T14-20-59-578Z.json`](../testdata/gate-b-driver-run2-2026-11-06T14-20-59-578Z.json).
- The unmodded Prism client witness (no driver) was completed on 2026-11-06
  (join, render, move, break, place, screenshot, disconnect, rejoin). See
  [`testdata/gate-b-unmodded-witness.json`](../testdata/gate-b-unmodded-witness.json)
  and
  [`testdata/gate-b-witness-2026-11-06.png`](../testdata/gate-b-witness-2026-11-06.png).
  `mise run gate-b:g0` now exits 0.
- Assert a survival (non-creative) break/place hold, not just the creative row.

The repeatable runner for exactly this row is now in `src/gate-b/` +
`src/gate-b.js`; see the runbook [docs/gate-b-g0.md](gate-b-g0.md). It
automates: fresh-process relaunch per run (quit + SSH/Prism, no reconnect op),
run-scoped arena coordinates with preflight block states, paired client/RCON
assertions (positive `execute if block` only — "Could not set" is never a
pass), classified RCON ops (setup/assertion/probe), screenshot copy-back via
scp, per-run reports, and the `--runs 2` / `--verify-g0` gates
(`mise run gate-b:scenario`, `mise run gate-b:g0`). The one-off manual checks
that validated this driver remain recorded above.

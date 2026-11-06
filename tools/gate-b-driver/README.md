# Gate B driver

A client-only Fabric mod for the official 26.1.2 client. It exposes a
newline-delimited JSON control socket on `127.0.0.1:25599` so the scenario
controller can read client state and invoke vanilla interaction paths without
touching the compositor or the network stack.

## Build

```bash
mise run gate-b:driver:build
```

The jar is `tools/gate-b-driver/build/libs/gate-b-driver-0.1.0.jar`.

## Install on the display host

```bash
# copy the jar to the host, then:
tools/gate-b-driver/install.sh /path/to/gate-b-driver-0.1.0.jar
```

The installer copies the existing `gate-b-player` 26.1.2 instance to
`gate-b-player-fabric`, adds Fabric Loader 0.20.1, and puts the driver in its
`minecraft/mods/` directory. It refuses to overwrite an existing instance.

Launch:

```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 \
  prismlauncher -l gate-b-player-fabric \
  -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi
```

The driver binds loopback only. From the workspace, forward it:

```bash
ssh -N -L 25599:127.0.0.1:25599 bafbi@nath.tail41e568.ts.net
node tools/gate-b-driver/driver-client.mjs status
```

## Commands

| Command | What it does |
|---|---|
| `status` | screen, level/player, connected, position, dimension, loaded chunks, rendered sections, FPS, held item |
| `move [ms]` | hold vanilla forward for `ms` (default 1000) |
| `look <yaw> <pitch>` | set player rotation |
| `break [x y z] [ms]` | break the block at the position; defaults to the ground block in front (never directly under the player) |
| `place [x y z] [ms]` | use the selected hotbar item on top of the support block; defaults to the block in front |
| `screenshot` | save a PNG under `minecraft/screenshots/` and return its path |
| `respawn` | send the client respawn command (use after a death screen) |
| `disconnect` | invoke the vanilla disconnect path |
| `quit` | stop the client process |

`place` needs an item in the selected hotbar slot. For the G0 scenario, run
`/give Bafbi minecraft:stone 64` through RCON first.

`break` and `place` go through the normal attack/use input path, so the server
sees the action, not just a client-side prediction. On void or thin maps, pass
explicit coordinates for the target/support block; the default break target is
the ground block in front, never the block underfoot.

## Window name and desktop placement

The mod names the window `Monoplayer Gate B` instead of `Minecraft* 26.1.2`
(override with the JVM property `-Dgateb.window.title=...`). On Wayland that
name is also the app_id/class, so Hyprland can target only the Gate B client:

```lua
o.window("Monoplayer Gate B", {
  workspace = "9 silent",
  no_initial_focus = true,
  focus_on_activate = false,
})
```

This keeps normal Minecraft windows untouched. Prism's console window is
separate; disable it per-instance (`OverrideConsole=true`,
`ShowConsole=false`) while Prism is closed if it should not appear at all.

## Validation

Validated on `nath` against Paper 26.1.2 build 74 on 2026-11-06: status, move,
look, break, place, screenshot, respawn, disconnect, and quit all passed, with
server-side block and position checks. See
[docs/gate-b-driver-validation.md](../../docs/gate-b-driver-validation.md).

## Safety

- Binds `127.0.0.1` only.
- One mixin (`Minecraft.createTitle`) only changes the window title.
- No mixins into `Connection`, login/play handlers, packet codecs, or Netty.
- No outbound network from the mod.
- Optional token: set `-Dgateb.driver.token=...` on the client JVM and
  `GATEB_DRIVER_TOKEN` on the client.

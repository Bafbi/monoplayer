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
| `break [x y z]` | break the block at the position; defaults to the block under the player |
| `place` | use the selected hotbar item against the block in front |
| `screenshot` | save a PNG under `minecraft/screenshots/` and return its path |
| `disconnect` | invoke the vanilla disconnect path |
| `quit` | stop the client process |

`place` needs an item in the selected hotbar slot. For the G0 scenario, run
`/give Bafbi minecraft:stone 64` through RCON first.

## Safety

- Binds `127.0.0.1` only.
- No mixins into `Connection`, login/play handlers, packet codecs, or Netty.
- No outbound network from the mod.
- Optional token: set `-Dgateb.driver.token=...` on the client JVM and
  `GATEB_DRIVER_TOKEN` on the client.

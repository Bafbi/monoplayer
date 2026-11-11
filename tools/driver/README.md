# Monoplayer client driver

A client-only Fabric mod for the official 26.2 client, the version the deployed
proxy, the dev lane, and the transfer testbed serve. The pin in
`build.gradle` follows the deployed proxy, and `test/driver/pin.test.js` fails
when the two drift apart. It exposes a
newline-delimited JSON control socket on `127.0.0.1:25599` so the scenario
controller can read client state and invoke vanilla interaction paths without
touching the compositor or the network stack.

## Build

```bash
mise run driver:build
```

The jar is `tools/driver/build/libs/monoplayer-driver-0.1.0.jar`. It declares the
one Minecraft version it is built for in `fabric.mod.json`, and Fabric refuses to
load it on any other version.

## Install on the display host

This is a script, not a mise task. The installer writes into a Prism root on the
machine it runs on, so it belongs to the host that holds that root.

```bash
# copy the jar to the host, then:
BASE=gate-b-player-262 INSTANCE=gate-b-player-262-fabric \
  tools/driver/install.sh /path/to/monoplayer-driver-0.1.0.jar
```

The installer clones a base Prism instance, reads its Minecraft version from
`mmc-pack.json` (so the version is not written down twice), adds Fabric Loader
0.20.1, and puts the driver in `minecraft/mods/`. It refuses to overwrite an
existing instance, so a second install needs a new `INSTANCE` or the old one
deleted.

The instance names are frozen (see
[deploy/driver/README.md](../../deploy/driver/README.md)): `gate-b-player` and
`gate-b-player-fabric` are the 26.1.2 pair, kept as the record of the G0 run on
that version. `gate-b-player-262` and `gate-b-player-262-fabric` are the 26.2
pair, and the only pair the current jar loads. Launch:

```bash
tools/nath.sh launch gate-b-player-262-fabric \
  -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi
```

`tools/nath.sh` derives the Hyprland session on the host, so no caller supplies
`DISPLAY`, `WAYLAND_DISPLAY`, or `XDG_RUNTIME_DIR`.

The driver binds loopback only. From the workspace, forward it:

```bash
ssh -N -L 25599:127.0.0.1:25599 bafbi@nath.tail41e568.ts.net
node tools/driver/driver-client.mjs status
```

## Commands

| Command | What it does |
|---|---|
| `status` | screen (class/title/narration), level/player, connected, the server address the client joined, position, dimension, loaded chunks, rendered sections, FPS, held item |
| `screen` | current screen class, title, narration, and widget list (label/active/visible/x/y/width/height); disconnect screens also report `reason` |
| `click <label>` | press the first visible button whose label contains `<label>` (case-insensitive); `{"label":".."}` or `{"index":n}` in raw JSON also work by exact label or position |
| `pause` | open the vanilla pause menu (Escape screen) |
| `move [ms]` | hold vanilla forward for `ms` (default 1000) |
| `look <yaw> <pitch>` | set player rotation |
| `break [x y z] [ms]` | break the block at the position; defaults to the ground block in front (never directly under the player) |
| `place [x y z] [ms]` | use the selected hotbar item on top of the support block; defaults to the block in front |
| `screenshot` | save a PNG under `minecraft/screenshots/` and return its path |
| `skin` | the body texture the client resolved for the player it controls, the same for every `player_info` entry it holds, those entries' textures properties, and the camera mode |
| `perspective [first\|third_back\|third_front]` | set the camera mode, so a screenshot shows the body rather than a hand |
| `inject_player_info` | deliver one clientbound `player_info` frame the caller encoded as hex: the driver decodes it with the client's own stream codec and hands it to the client's own packet listener, so the client validates it as it validates a frame from a server |
| `respawn` | send the client respawn command (use after a death screen) |
| `disconnect` | invoke the vanilla disconnect path |
| `quit` | stop the client process |

`place` needs an item in the selected hotbar slot. For the G0 scenario, run
`/give Bafbi minecraft:stone 64` through RCON first.

`break` and `place` go through the normal attack/use input path, so the server
sees the action, not just a client-side prediction. On void or thin maps, pass
explicit coordinates for the target/support block; the default break target is
the ground block in front, never the block underfoot.

## Skin and packet injection (#99)

`skin`, `perspective`, and `inject_player_info` exist for one measurement: what
skin a real client resolves for the body it controls. They are not cosmetic
helpers, and the injection is the only op that reaches the client's packet
handling, so it is bounded on purpose:

- it takes a frame someone else built, decodes it with
  `ClientboundPlayerInfoUpdatePacket.STREAM_CODEC`, and refuses a frame with
  trailing bytes;
- the bytes come from `src/core/skin.js` through the same protocol data the
  proxy serializes with, so the frame a run delivers is the frame a server sends;
- it reports what it delivered: the actions, every entry, whether the client
  already held that UUID, and whether the write happened at all.

`node src/driver/run.js --lane skin` drives the three cases (control, signed,
unsigned), one fresh client each, and writes `.reports/skin-report.json` with the
texture each case resolved and a third-person screenshot. `--lane skin --case
signed` runs one of them. The measurement and its answer are in
[testdata/skin-verdict.md](../../testdata/skin-verdict.md).

## Menus and screenshots

The scenario can drive menus without touching the compositor: `screen` reads
the active screen (title, narration, buttons, and the disconnect/connection
reason when one is shown), `click Back to Game` presses a button by label, and
`pause` opens the pause menu. `screenshot` captures the live main render
target, so it works on pause, disconnect, and title screens even when the
window is unfocused — the driver owns screenshots; no Hyprland focus, window
activation, or grim involvement.

## Window name and desktop placement

The mod names the window `Monoplayer Gate B` instead of `Minecraft* 26.1.2`
(override with the JVM property `-Dgateb.window.title=...`). The window title
and the `gateb.*` property names are frozen: the operator's Hyprland rule reads
the title, so renaming either is a host-side change, not a repository rename. On
Wayland the title is also the app_id/class, so Hyprland can target only the
driver client:

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
server-side block and position checks. On 2026-11-07, `screen`, `pause`,
`click`, and the unfocused pause-menu screenshot were validated live; the
client returned to play with `click Back to Game`. The driver-owned pause
screenshot is quoted in [testdata/driver-verdict.md](../../testdata/driver-verdict.md).
See [docs/driver-validation.md](../../docs/driver-validation.md).

## Safety

- Binds `127.0.0.1` only.
- One mixin (`Minecraft.createTitle`) only changes the window title.
- No mixins into `Connection`, login/play handlers, packet codecs, or Netty.
  `inject_player_info` reads no socket and swaps no handler: it decodes one
  caller-built frame with the client's own stream codec and hands the packet to
  the client's own listener, on the client thread. The mod still opens no
  outbound connection and changes nothing the client would otherwise do.
- No outbound network from the mod.
- Optional token: set `-Dgateb.driver.token=...` on the client JVM and
  `GATEB_DRIVER_TOKEN` on the client.

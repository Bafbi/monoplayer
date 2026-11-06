# Research: controlling a real 26.1 client

**Ticket:** `.scratch/minecraft-gate-b/issues/01-research-client-control.md`
**Status:** resolved (research only; nothing implemented)
**Target:** Minecraft Java **26.1.2 / protocol 775**
**Date:** 2026-11-05

This note answers how Gate B can drive an official 26.1 Java client
deterministically, what can run headless, what needs a display, and how to assert
client behaviour rather than process liveness. It does **not** settle Gate B
acceptance thresholds; that is ticket 05.

---

## Verdict

**Primary Gate B client runner:** **Prism Launcher 11.1.1 + a 26.1.2 Fabric
production instance + a tiny local `gate-b-driver` client mod**, launched with
the real player account, on a display/GPU host. The driver exposes a loopback
JSON control socket, injects vanilla client input/interaction, writes JSONL
state and screenshots, and does not modify the network stack. Prism supplies the
real Microsoft session and `-s host:port` auto-join; the mod supplies deterministic
control and evidence.

**Fallback A (unmodded proof):** Prism/vanilla 26.1.2 under **Xvfb + Mesa
llvmpipe + xdotool + screenshots + Quick Play log + RCON**. This is the
fully-unmodded confirmation lane. It is slower and flakier than the driver and
should not carry fine-grained block-edit assertions.

**Fallback B (CI/pre-check):** **Fabric Client Gametest API**
(`runProductionClientGameTest`, `useXVFB = true`) against an in-process dedicated
server, plus **HeadlessMc 3.0.0-RC8 / hmc-specifics** for headless state-machine
smoke tests. This lane is deterministic and display-free but is **offline-mode**
and does not prove Microsoft auth, encryption, or the online-mode front leg.

**Protocol-level bots (`minecraft-protocol`) are a fast pre-check, never a Gate B
pass.** They prove packet legality and proxy/backend state; they cannot prove
rendering, vanilla UI state, or client-side prediction.

**Must stay manual:** first Microsoft device-code/2FA approval; at least one
unmodded vanilla confirmation run; visual review of rendering; account recovery
and ToS checks.

**Important correction to prior research:** 26.1.2 is an **OpenGL** client, not
Vulkan. Its version JSON contains only `lwjgl-opengl`/`lwjgl-glfw`; Vulkan and
`--graphicsBackend` first appear in **26.2**. Mesa llvmpipe's OpenGL 4.6 is
therefore sufficient for software-rendered headless runs. The “Vulkan 1.3”
requirement in `research/02-backend-matrix.md` describes a later 26.x line, not
26.1.2.

Everything under **Proven facts** is sourced or measured. Everything under
**Recommended strategy**, the command sketches, and the experiment are
recommendations. Backend pins and account provisioning are out of scope here
(tickets 02 and 03).

---

## Proven facts

### Version, launch surface, and client identity

| Claim | Status | Evidence |
|---|---|---|
| 26.1.2 was released 2026-04-09, is protocol **775**, and requires **Java 25** | Proven | [26.1.2 version JSON](https://piston-meta.mojang.com/v1/packages/dd6fd47eec3ac2d46b4f805e003f1a421ed8a3f7/26.1.2.json), [wiki](https://minecraft.wiki/w/Java_Edition_26.1.2) |
| Client jar `26.1.2` is 38,113,927 bytes, SHA-1 `4e618f09a0c649dde3fdf829df443ce0b8831e65` | Proven | version JSON above |
| Main class is `net.minecraft.client.main.Main`; assets index is `30` | Proven | version JSON above |
| 26.1.2 is **unobfuscated** | Proven | [Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1) (“first … fully unobfuscated without an accompanying obfuscated variant”) |
| 26.1.2 has **no Vulkan libraries**; only `lwjgl-opengl` and `lwjgl-glfw` | Proven | version JSON `libraries`; no `lwjgl-vulkan`/`vulkan` entry |
| Vulkan is an **experimental 26.2** renderer; `--graphicsBackend` was added in 26.2 snapshots | Proven | [Java Edition 26.2](https://minecraft.wiki/w/Java_Edition_26.2), [client arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments) |
| `--server`/`--port` were removed in 1.20; the current auto-join argument is `--quickPlayMultiplayer <host:port>` | Proven | [client arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments) |
| `--quickPlayPath <path>` writes a JSON join log after a successful Quick Play join, relative to the game directory | Proven | [Quick Play](https://minecraft.wiki/w/Quick_Play) |
| `--gameDir`, `--assetsDir`, `--assetIndex`, `--width`, `--height`, `--uuid`, `--accessToken`, `--clientId`, `--xuid` are the launcher-supplied game arguments | Proven | version JSON `arguments.game`; client arguments wiki |
| The “Loading terrain…” screen is the vanilla downloading-terrain screen (`DownloadingTerrainScreen` in the 1.21 mappings); the literal is the `multiplayer.downloadingTerrain` string | Proven for the screen/string; exact 26.1 package not needed | Yarn/Fabric class index and Minecraft source references; assert `mc.screen == null` rather than a class name |
| Prism CLI: `-d/--dir`, `-l/--launch`, `-s/--server`, `-a/--profile`, `-I/--import`, `--show`, `--alive`; **no `--port`** | Proven | [Prism CLI wiki](https://prismlauncher.org/wiki/getting-started/command-line-interface/) |
| Prism 11.1.1 is the current release at time of writing | Proven | [Prism releases](https://github.com/PrismLauncher/PrismLauncher/releases/tag/11.1.1) |
| Prism expects one process per instance; two *different* instances can run at once | Proven | [Prism #250](https://github.com/PrismLauncher/PrismLauncher/issues/250) (research 03) |
| Prism stores Microsoft tokens in plaintext in `accounts.json` | Proven, open issue | [Prism #4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073) (research 03) |
| MultiMC 0.6.13+ supports Microsoft device flow and `--launch`/`--server` | Proven | [MultiMC 0.6.13](https://multimc.org/posts/0-6-13-update.html) |

### Fabric client testing surface

| Claim | Status | Evidence |
|---|---|---|
| Fabric API **0.155.3+26.1.2** includes the client gametest API | Proven | [26.1.2 automated testing docs](https://docs.fabricmc.net/26.1.2/develop/automatic-testing); [javadocs for 0.155.3+26.1.2](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/package-summary.html) |
| Client gametests are registered through the `fabric-client-gametest` entrypoint and implement `FabricClientGameTest.runTest(ClientGameTestContext)` | Proven | same javadocs |
| The API can simulate keys/mouse, look at a `BlockPos`, type text, resize the window, and take screenshots | Proven | [`TestInput`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/TestInput.html), [`ClientGameTestContext`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/context/ClientGameTestContext.html) |
| `waitForChunksDownload()` and `waitForChunksRender()` are explicit assertions that the client received and rendered chunks | Proven | [`TestClientLevelContext`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/context/TestClientLevelContext.html) |
| `takeScreenshot`, `assertScreenshotContains`, `assertScreenshotEquals` exist; comparisons are fuzzy and template-based | Proven | `ClientGameTestContext` javadocs, `TestScreenshotOptions` |
| The gametest runner pauses the game and advances it tick-by-tick; tests are sequential and return to the title screen between tests | Proven | package summary javadocs |
| The gametest API’s own dedicated server defaults to `online-mode=false`, `max-players=1`, `spawn-protection=0`, flat world, seed 1, no structures/weather/mobs | Proven | package summary javadocs |
| `ClientProductionRunTask.useXVFB = true` runs the client under Xvfb on Linux; Loom docs give a GitHub Actions 26.1.2 recipe | Proven | [Loom production run tasks](https://docs.fabricmc.net/26.1.2/develop/loom/production-run-tasks) |
| The docs warn that client gametests may fail on GitHub Actions due to the network synchronizer and suggest `-Dfabric.client.gametest.disableNetworkSynchronizer=true` | Proven | same Loom/automated-testing docs |
| Fabric Loader for 26.1.2 is **0.20.1**; installer is **1.1.2** | Proven | [Fabric meta](https://meta.fabricmc.net/v2/versions/loader/26.1.2), [installer meta](https://meta.fabricmc.net/v2/versions/installer) |

### Headless and protocol tooling

| Claim | Status | Evidence |
|---|---|---|
| HeadlessMc 3.0.0-RC8 runs the client without a display and can send console commands to it via version-specific mods | Proven | [HeadlessMc](https://github.com/headlesshq/headlessmc), [specifics](https://headlesshq.github.io/headlessmc/specifics/) |
| hmc-specifics supports **26.1–26.1.2** on Fabric, Forge, and NeoForge, with commands `connect`, `disconnect`, `key`, `gui`, `render`, `msg`, `/` | Proven | [supported versions table](https://headlesshq.github.io/headlessmc/specifics/#supported-versions) |
| `minecraft-protocol` 1.68.0 / `minecraft-data` 3.119.0 in this repo map 26.1 to protocol 775 and pass 37/37 Gate A assertions | Proven | `docs/gate-a.md`, `package.json`, local `node_modules` |
| Mineflayer 4.39.0 depends on `minecraft-protocol ^1.67.0`; its 26.1 client behaviour is not verified | Proven dependency, unverified support | npm metadata; research 03 notes open 26.1.2 mapping concern ([mineflayer #3888](https://github.com/PrismarineJS/mineflayer/issues/3888)) |
| MCProtocolLib’s latest release is `1.21.4-1`; it has no 26.1 support | Proven | [MCProtocolLib releases](https://github.com/GeyserMC/MCProtocolLib/releases) |
| Xvfb provides X11 without a GPU; Mesa’s llvmpipe renders OpenGL in software | Proven | [Xvfb manual](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml), [Mesa llvmpipe](https://www.mesa3d.org/llvmpipe.html) |
| llvmpipe supports OpenGL 4.6 on current Mesa, including compatibility contexts | Proven | Mesa/Phoronix reports; `glxinfo` on the host is the authority |
| xdotool can search/activate windows and send XTEST key/mouse events | Proven | [xdotool](https://github.com/jordansissel/xdotool) |

### What only the official client proves

The Gate A runbook is explicit: the protocol client “does not render chunks or
enforce vanilla UI state machines.” A real client is required for:

- leaving `DownloadingTerrainScreen` and reaching a null screen with a live
  level/player;
- chunk download **and render** completion;
- vanilla client-side prediction and reconciliation after movement/block edits;
- the vanilla disconnect/reconnect UX;
- model/texture/atlas loading and a non-blank framebuffer;
- secure-chat client behaviour, if chat is in scope.

A protocol bot can prove packet legality, login/config/play transitions, cache
contents, keep-alive handling, and server-side effects. It cannot prove any item
above.

---

## Local environment audit (measured 2026-11-05)

Commands used: `command -v`, `java -version`, `mise x java@25.0.2 -- java -version`,
`ldconfig -p`, `ls /dev/dri`, `free -h`, `nproc`, `apt-cache policy`, `sudo -n true`,
and `curl -sS -o /dev/null -w '%{http_code}'`.

| Item | Result | Consequence |
|---|---|---|
| OS / kernel | Debian 13 (trixie), Linux 7.0.14-14-pve, x86_64 | Fine for tooling |
| CPU | 4 cores | Client + backend + proxy is tight; llvmpipe is CPU-bound |
| RAM | 7.9 GiB total, ~3.4 GiB available, 6.8 GiB swap already used | **Below the client’s published 8/12 GiB minimum** once a backend runs |
| Disk | 47 GiB free on `/` | Enough for client/assets/logs (~1 GiB) |
| Java | 21.0.2, 25.0.2, 26.0.2 installed under mise; **no global version**, so `java` shim errors | Use `mise x java@25.0.2 -- java ...` or set a pin |
| Gradle | 9.5.0 and 9.7.1 installed; shim unset; works with `JAVA_HOME=.../25.0.2` + `mise x gradle@9.7.1` | Buildable, but pin Java/Gradle in the task |
| Node / pnpm | Node 26.7.0, pnpm 11.25.0 | Gate A harness runs |
| `/dev/dri` | Missing | No hardware GPU |
| `DISPLAY` / `WAYLAND_DISPLAY` | Both unset | No display |
| X11/GL libraries | `libX11`, `libGL`, `libEGL`, `libGLX`, `libXtst`, `libXrandr`, `libXcursor`, `libXi`, `libvulkan` all **missing** | Cannot run any GLFW/OpenGL client as-is |
| Xvfb / xvfb-run | Missing | Cannot create a virtual display without installing |
| xdotool / wmctrl / openbox | Missing | No GUI input/window management |
| ImageMagick (`import`/`convert`) / scrot / ffmpeg / tesseract | Missing | No screenshot capture/OCR |
| Prism / MultiMC / vanilla launcher | Missing | No launcher |
| Docker / podman | Missing | No container escape hatch |
| `sudo` | Password required (`sudo -n` fails) | Cannot `apt install` non-interactively; no root |
| `/dev/input`, `/dev/uinput` | Missing | No kernel-level input injection |
| Mesa DRI / Vulkan ICD | Missing (`/usr/lib/x86_64-linux-gnu/dri`, `/usr/share/vulkan/icd.d`) | No software GL either, until installed |
| Network | Mojang piston-meta, GitHub, Fabric Maven, Modrinth all return HTTP 200 | Downloads are possible |
| `minecraft-protocol` / `minecraft-data` | 1.68.0 / 3.119.0 installed; 26.1 maps to 775 | Protocol pre-checks can run here |
| Prism/Minecraft caches | `~/.minecraft` absent; no launcher roots | Fresh install required |
| `java` shim | `java -version` → “No version is set for shim: java” | Scripts must not assume `java` is on PATH |

**Bottom line:** this workspace **cannot run the official client** now. It has no
display, no X/GL libraries, no GPU, no launcher, and insufficient free RAM for a
client plus backend. It can run the backend and protocol bots. The official
client belongs on a separate display/GPU host, or a CI runner with Xvfb + Mesa
(software rendering). Installing Xvfb/Mesa here would require root; `apt-get`
has candidates but `sudo` needs a password.

A no-root workaround (download `.deb`s with `apt-get download`, extract with
`dpkg-deb -x`, set `LD_LIBRARY_PATH`) is technically possible but **not
recommended**: even with software GL, 3.4 GiB available RAM and 4 shared cores
cannot host a 26.1 client plus a backend reliably. Treat it as a last-resort
experiment, not the Gate B lane.

---

## Options compared

| Option | Real Microsoft session | Vanilla protocol path | Deterministic control | Rendering evidence | Headless/CI | Main weakness |
|---|---:|---:|---:|---:|---:|---|
| **Prism + Fabric driver mod** (primary) | Yes (Prism account) | Yes (Fabric loader only; mod observes/injects locally) | High (in-process state, localhost commands) | In-client screenshots + state | Yes with Xvfb/llvmpipe | Mod code must track 26.1 APIs; not literally unmodded |
| Prism/vanilla + Xvfb + xdotool | Yes (pre-authenticated Prism) | **Yes, unmodded** | Low–medium (focus/timing) | X11 screenshots + OCR | Yes, flaky | GUI focus, mouse look, timing |
| Fabric Client Gametest (Loom) | No (dev/offline account) | Loader + test harness changes tick/network scheduling | **Very high** (tick-stepped, typed input) | Built-in screenshot/template API | **Yes** (`useXVFB`) | Offline in-process server; not the online-mode front leg |
| HeadlessMc + hmc-specifics | Yes (real login possible) | Loader/mod; no rendering | High (console commands) | **No real framebuffer** | **Yes, no display** | Headless LWJGL stubs; cannot prove rendering |
| `minecraft-protocol` bot | Offline, or custom auth | Protocol only | High | None | Yes | Not an official client |
| Mineflayer 4.39.0 | Possible but unverified | Protocol only | High | None | Yes | 26.1 support unverified |
| MCProtocolLib | Possible | Protocol only | High | None | Yes | No 26.1 release |

### Prism vs MultiMC

Use **Prism 11.1.1**. It is actively maintained, supports multiple Microsoft
accounts and per-instance account overrides, and exposes the CLI Gate B needs.
MultiMC 0.6.13+ is a viable older fallback, but Prism is the better-tested path
for current versions and concurrent instances. Do not run both launchers against
the same instance root.

### Why not the vanilla launcher

The official launcher has no documented headless/CLI launch path; it requires a
GUI Microsoft login. A “vanilla launcher plus Xvfb + xdotool” lane therefore
still needs a human to log in once, and then the launcher GUI must be driven.
For automation, use Prism (which launches the same unmodded client) or a
launcher-generated direct `java` command. The direct command needs the full
classpath, assets, natives, UUID, and access token; do not rebuild that by hand.

### Why not `xdotool` as the primary

`xdotool` sends XTEST events to the focused window. Minecraft’s GLFW window can
lose focus, the pointer is grabbed in-game, mouse-look is relative, and the
“Loading terrain…”/disconnect screens change what a click means. Synthetic
`XSendEvent` (`xdotool key --window`) is often ignored by GLFW. The result is a
runner that passes or fails on window-manager timing, not on Monoplayer.

---

## Recommended strategy

### Primary: Prism + `gate-b-driver` Fabric mod

**Shape**

```
scenario controller (Node)
  ├─ starts backend / Toxiproxy / Monoplayer
  ├─ starts Xvfb + openbox (if headless)
  ├─ launches Prism with the real player account
  │    prismlauncher -d .gate-b/prism-player -l gate-b-player \
  │      -a "<player>" -s 127.0.0.1:25565
  ├─ connects to driver on 127.0.0.1:25599
  ├─ drives join → move → break → place → disconnect → reattach
  └─ asserts driver state + RCON + proxy report + screenshots
```

**Why this is the smallest reliable runner**

- Prism already solves Microsoft auth, asset/library download, Java selection,
  per-instance isolation, and `host:port` auto-join.
- The official client jar runs in a **production Fabric instance**, not a Gradle
  dev environment, so classloading and assets match a player install.
- The driver can read `Minecraft.getInstance()` directly: screen class, level,
  player, position, hit result, block state, connection state. That is the
  difference between “process alive” and “left Loading terrain”.
- Loopback JSON control removes window focus and mouse-look from the critical
  path.
- Screenshots come from the client framebuffer at a fixed size, not from the X
  root window.

**Driver contract (sketch, not implemented)**

- Bind `127.0.0.1:25599` with a per-run random token; reject non-loopback.
- Newline-delimited JSON commands: `status`, `look`, `move`, `break`, `place`,
  `disconnect`, `reconnect`, `screenshot`, `quit`.
- JSONL evidence per tick or per event: timestamp, screen class, `level`/`player`
  present, connection state, position/rotation, `hitResult` (type/pos/face),
  block state at target, selected hotbar item, last serverbound packet counters
  if exposed.
- Movement: hold the vanilla forward key for N ticks, or set the player input
  through a small accessor; assert both the client position delta and the
  backend position delta.
- Look: set yaw/pitch to face a known `BlockPos`; log the resulting
  `HitResult` before clicking.
- Break/place: call `MultiPlayerGameMode` (`startDestroyBlock` /
  `continueDestroyBlock` / `useItemOn`) on the client thread after confirming the
  crosshair target. This exercises the vanilla interaction/packet path without
  depending on mouse focus.
- Disconnect: invoke the vanilla disconnect path; wait for
  `DisconnectedScreen`/title.
- Reconnect: invoke the vanilla `ConnectScreen` path or relaunch Prism; wait for
  null screen + chunks rendered.
- Keep the mod **client-only** and free of mixins into `Connection`,
  `ClientLoginNetworkHandler`, `ClientPlayNetworkHandler`, packet codecs, or the
  Netty pipeline. That preserves the “protocol path vanilla” claim.

**Known implementation risk:** exact 26.1 method names for `KeyMapping`,
`MultiPlayerGameMode`, `ScreenshotRecorder`, and `ConnectScreen` must be checked
against the unobfuscated 26.1.2 source. 26.1 being unobfuscated makes this much
easier than 1.21.x. If input injection proves brittle, use the gametest API
(fallback B) or the `xdotool` lane (fallback A) rather than adding network
mixins.

**When to use it:** every Gate B matrix row that needs a real client: M1
(Vanilla), M2 (Paper), M3 (Fabric), M4 (Velocity), M5 (faults), plus the
online-mode front-leg proof.

### Fallback A: unmodded Prism/vanilla + Xvfb + xdotool + screenshots

Use when the result must come from a **completely unmodded** client, or when the
driver cannot be built. This is also the mandatory confirmation lane for at
least one Gate B run.

- Launch a **vanilla 26.1.2** Prism instance with `-s 127.0.0.1:25565`.
- Wait for the window: `xdotool search --sync --name 'Minecraft'`.
- Activate/focus: `xdotool windowactivate --sync <id>; xdotool windowfocus <id>`.
- Send real XTEST input (`xdotool key --clearmodifiers w`), not `--window`.
- Join proof: RCON `list` shows the player, the client log has no fatal error,
  and the screenshot is past the loading screen. If the launch also passed
  `--quickPlayPath`, the JSON join log is an additional filesystem proof.
- Render proof: screenshot is 1280×720, has many unique colors, and OCR does not
  find “Loading terrain” or “Disconnected”.
- Movement proof: hold `w` for ~1 s; RCON `data get entity <player> Pos` changes
  by >1 block in the expected direction.
- Block proof: aim with mouse-look is flaky. Use a fixed target directly in front
  of spawn and a fixed camera; or accept that block edits are better covered by
  the driver/gametest lane. Do not claim precise block edits from this lane
  without a screenshot of the changed block and an RCON query.
- Disconnect proof: `Escape` → “Disconnect” (or close the window); RCON `list`
  changes as expected; proxy log shows the front leg ended.
- Reattach: relaunch Prism with `-s`; assert RCON position/block state persist
  and, if `--quickPlayPath` was enabled, that the log timestamp updated.

This lane is **headless-capable** with Xvfb + llvmpipe, but the click/key timing
and mouse-look are the weak points. Budget retries; do not use it for the fault
matrix's precise assertions.

### Fallback B: Fabric Client Gametest in CI

Use for a fast, deterministic, display-free regression lane and for validating
driver logic. It is not the online-mode Gate B proof.

```bash
CI=1 ./gradlew runProductionClientGameTest \
  -Dfabric.client.gametest \
  -Dfabric.client.gametest.disableNetworkSynchronizer=true
```

- `ClientProductionRunTask` with `useXVFB = true` starts Xvfb automatically on
  Linux. Mesa llvmpipe supplies OpenGL; no GPU is required.
- A test can `context.worldBuilder().createServer(props).connect()`, then
  `getClientLevel().waitForChunksRender()`, `getInput().holdKeyFor(...)`,
  `getInput().lookAt(pos)`, `pressMouse(0/1)`, `takeScreenshot(...)`, and
  `TestServerConnection.close()` to disconnect.
- The in-process server is `online-mode=false` and `max-players=1`. This proves
  client rendering/movement/block interaction under controlled ticks, **not**
  Microsoft auth, encryption, `hasJoined`, or a real backend/proxy.
- The gametest harness changes tick and network synchronization; do not treat its
  timing as vanilla production timing. Use it as a pre-check, not the final
  proof.
- For an external server, the API can run arbitrary client code via
  `runOnClient` (e.g. open the vanilla `ConnectScreen`), but the Gradle-launched
  client uses a dev account. Real online-mode auth belongs in the Prism lane.

**HeadlessMc alternative in this tier:** `headlessmc launch fabric 26.1.2` with
`hmc-specifics` supports `connect`, `key`, `gui`, `render`, `disconnect`. It runs
without a display and is credible for state-machine smoke tests, but its LWJGL
stubs mean **no real framebuffer**. It cannot prove “renders”.

### Pre-check: `minecraft-protocol` bot

Run before every real-client attempt:

- connect to an **offline front-leg fixture** (the M0 protocol row) with
  `version: '26.1'`, `auth: 'offline'`; do **not** point an offline bot at an
  online-mode front leg;
- assert login → configuration → play, chunk batch, keep-alive, position echo;
- send `position`/`position_look`, `block_dig`, `block_place`, `chat_message`;
- assert the proxy/backend saw exactly the expected serverbound frames and that
  `backendLogins === 1`;
- disconnect and reattach; assert current pose.

This catches protocol regressions in seconds. It cannot prove rendering/UI and
must be reported as `clientLane: "protocol-precheck"`, never as a Gate B client
pass. If an authenticated protocol client is needed, use a **separate** account
and a real `auth: 'microsoft'` session; do not run it as the same account as the
GUI player, or the two sessions will kick each other.

---

## How to assert the client actually did something

The core rule: **assert client state + server state + a visual artifact**. Any
one alone is insufficient.

| Claim | Client-side assertion | Independent assertion | Artifact |
|---|---|---|---|
| Left “Loading terrain…” | `mc.screen == null`, `mc.level != null`, `mc.player != null`; not `DownloadingTerrainScreen` | Backend `list` shows the puppet; proxy has a play-state front leg | Screenshot with HUD; no OCR “Loading terrain” |
| Rendered | `getClientLevel().waitForChunksRender()` returns; chunks downloaded **and** rendered | None needed; server can confirm chunks were sent | Screenshot template match (hotbar/crosshair) or color histogram |
| Moved | Position delta from start; `hitResult`/rotation unchanged or expected | RCON `data get entity <puppet> Pos` delta; proxy serverbound `position`/`position_look` count | Two screenshots or a short capture; not required |
| Broke a block | Target block state becomes air; `hitResult` block face matches | RCON `execute if block <x> <y> <z> minecraft:air` succeeds; proxy sees one completed dig action, not a duplicate | Screenshot before/after |
| Placed a block | Target block state becomes the placed block; hotbar count decrements | RCON `execute if block ... minecraft:stone` succeeds; proxy sees one completed place/use-item action, not a duplicate | Screenshot before/after |
| Disconnected | `mc.screen instanceof DisconnectedScreen` or title; connection absent | Proxy front leg ended; backend `list` still shows puppet (or empty on a direct server); `backendLogins` unchanged | Client log tail; proxy report |
| Reattached | `mc.screen == null`, level/player present, chunks rendered; pose matches pre-disconnect | Proxy attach count +1; backend `list` still one puppet; `backendLogins` still 1 | New screenshot; Quick Play log timestamp (vanilla, if enabled) |

### Left “Loading terrain…” precisely

`DownloadingTerrainScreen` (the 1.21 mapping name) is the vanilla screen shown
while the client waits for the initial position/chunks. The reliable assertion
is not a log line or a class name; it is:

```java
mc.screen == null
  && mc.level != null
  && mc.player != null
  && connection != null && !connection.isDisconnected()
```

In the gametest API, `context.waitForScreen(null)` plus
`getClientLevel().waitForChunksRender()` is the same assertion with tick
timeouts. `waitForChunksRender()` is stronger than “chunks downloaded”: it
asserts the chunks are visible in screenshots.

Do **not** use “client log contains `Loaded N recipes`” as the primary signal.
It is a useful secondary marker but not a terrain/rendering proof. The Quick Play
JSON log (when the launch passes `--quickPlayPath`) is a better join proof for the
vanilla lane, because it is written only after a successful Quick Play join.
Prism’s `-s` may not pass `--quickPlayPath`; add it through the launcher’s
game-argument override (or a direct launch), and do not assume the file exists.

### Rendered precisely

- **Best:** in-mod `takeScreenshot` / `ScreenshotRecorder` after
  `waitForChunksRender()`, plus a template assertion for the hotbar/crosshair.
- **Vanilla:** `import -window <minecraft-window>` (or `-window root`) at a fixed
  resolution; assert dimensions, unique-color count, and absence of
  “Loading terrain”/“Disconnected” via OCR.
- Do not use “window exists” or “process alive”. A crashed client can leave a
  window; a loading client has a window and a screenshot.
- Golden-image equality is brittle across GPU/driver/Mesa versions. Use
  `assertScreenshotContains`/fuzzy compare for cross-host runs; reserve exact
  equality for a pinned llvmpipe/Mesa image.

### Moved precisely

- Teleport the puppet to a known flat area with RCON:
  `tp <puppet> 0 -60 0 270 0` (yaw 270 = +X in Minecraft; verify on the chosen
  world).
- Record client `player.position()` and RCON `data get entity <puppet> Pos`.
- Hold forward for 20 ticks (≈1 s); wait for the client to process the movement
  and the server to acknowledge.
- Assert client delta and server delta both > 1.0 block in +X, with a tolerance
  (e.g. 1.0–6.0 blocks). Do not assert an exact distance; sprinting, collision,
  and network latency vary.
- Use survival/peaceful or creative with flying disabled. In creative, a double
  tap of space starts flying; avoid it or explicitly disable flying.

### Broke/placed precisely

- Build a deterministic target with RCON, e.g.
  `setblock 2 -60 0 minecraft:stone`, and teleport/face the player at it.
- In the driver, `lookAt(new BlockPos(2,-60,0))`, then assert
  `mc.hitResult` is a block hit at that position and the expected face.
- Break: `pressMouse(0)` / `MultiPlayerGameMode.startDestroyBlock`; wait until
  `mc.level.getBlockState(pos)` is air **and** RCON `execute if block 2 -60 0
  minecraft:air` passes.
- Place: ensure a stone item is in the hotbar
  (`item replace entity <puppet> hotbar.0 with minecraft:stone 64`); face a
  supporting block face; `pressMouse(1)` / `useItemOn`; wait for the target block
  to become stone **and** RCON to confirm it.
- Assert the serverbound count is a single **completed** dig action (vanilla may
  send a start/stop pair, or a creative start) and a single place/use-item
  action; a duplicated action across the relay is a Monoplayer bug, not a
  client-control success.
- Client-side block state is predicted; always confirm with the server-side
  query after reconciliation.

### Disconnected precisely

- Record pre-disconnect pose, selected hotbar, and block state.
- Call the vanilla disconnect path. Wait for `DisconnectedScreen`/title.
- Assert the proxy’s front leg ended and the backend leg is still in `play`.
- Assert `list` still shows the puppet (front detach must not remove the backend
  session) and `backendLogins === 1`.
- On a direct backend (no Monoplayer), `list` should no longer show the player;
  use that to distinguish “client left” from “proxy failed”.
- A screenshot of “Disconnected” is secondary; the proxy/backend state is the
  authoritative proof.

### Reattached precisely

- Reconnect (new `ConnectScreen` or relaunch Prism with `-s`).
- Assert null screen + chunks rendered within a timeout; a client stuck on
  `DownloadingTerrainScreen` is the exact Gate B failure the architecture warns
  about.
- Assert the pose matches the pre-disconnect pose within tolerance (the proxy
  synthesizes the current pose; it must not be the backend’s old teleport).
- Assert the block edit persists and the hotbar state is sane.
- Assert `attachCount` increased, `backendLogins` is still 1, and the backend
  `list` still shows one puppet.
- For the vanilla lane, assert a new client log was written and, if enabled, that
  the `--quickPlayPath` log timestamp updated.

### Anti-patterns

- `pgrep -f net.minecraft.client.main.Main` / `jps` only proves a JVM exists.
- `xdotool search --name Minecraft` only proves a window exists; it can be the
  crash dialog or the loading screen.
- A single non-black screenshot can be a frozen loading frame.
- “No error in the last 10 lines of the log” can miss a kick or a stuck screen.
- A protocol bot’s successful join says nothing about vanilla rendering/UI.
- Counting serverbound packets without checking the backend block/position state
  can pass while the client is desynced.

---

## Flaky timing and GUI focus

| Problem | Mitigation |
|---|---|
| Fixed `sleep` races the loading screen | Poll `mc.screen`/`level`/`player` with a deadline; use tick-based `waitFor` in gametests |
| Window not focused, keys go nowhere | `openbox` + `xdotool windowactivate --sync` + `windowfocus`; send XTEST keys, not `--window`; verify with a screenshot |
| Mouse-look is relative and the pointer is grabbed | Prefer driver `lookAt(BlockPos)`; in vanilla, use small `mousemove_relative` steps and verify the crosshair/`hitResult` |
| Client pauses when unfocused | Set `pauseOnLostFocus:false` in `options.txt`; keep one client per display |
| Tutorial/accessibility/narrator screens steal input | Pre-seed `options.txt` (`tutorialStep:none`, narrator off, music 0, clouds off); gametest API already does this |
| Variable chunk render time on llvmpipe | `renderDistance:4`, `simulationDistance:4`, 854×480 or 1280×720, generous 120 s timeout; do not assert exact frame time |
| Window title changes with version/mod | Search by class or by the known title; confirm `Minecraft` substring; use the driver when possible |
| Mouse click hits the wrong block | Teleport/face a known block; assert `hitResult` before clicking; restore the target with `/setblock` before each run |
| Server pauses when empty (Paper) | `pause-when-empty-seconds=0` for Vanilla; understand Paper’s default `-1` |
| Reconnect reuses stale state | Fresh client process or explicit `ConnectScreen`; clear `servers.dat`/Quick Play entries only if intentionally testing the UI |
| Parallel runs fight over the display/ports | One client per X display; unique game dir, RCON port, proxy port, and driver port per run |
| Crash looks like a hang | Tail `logs/latest.log` and `crash-reports/`; assert process exit code separately from client state |

**Rule:** wait for an observable condition with a deadline; never use a fixed
sleep as the only synchronization. Retry only idempotent steps (attach, screenshot);
do not retry a block edit blindly, because a duplicate edit is itself a defect.

---

## Headless / CI / display / manual split

| Lane | Headless | GPU | Real Microsoft auth | What it can prove | What it cannot prove |
|---|---:|---:|---:|---|---|
| **Prism + Fabric driver** on a display host | With Xvfb/llvmpipe | Not required, recommended | **Yes** | Join, render, move, break/place, disconnect, reattach, online-mode front leg | Literally unmodded client |
| **Prism/vanilla + Xvfb + xdotool** | Yes | Not required (llvmpipe) | Yes, with a pre-authenticated Prism root | Unmodded join/render/move/disconnect | Reliable fine-grained edits; deterministic timing |
| **Fabric Client Gametest (CI)** | **Yes** (`useXVFB`) | No | No native; injected auth unverified | Tick-deterministic client render/input/interaction; screenshots | Online-mode auth, encryption, real backend/proxy |
| **HeadlessMc + hmc-specifics** | **Yes, no X** | No | Yes (real login possible) | Client state machine, commands, join/disconnect | Rendering; screenshots |
| **`minecraft-protocol` bot** | Yes | No | Offline/custom | Protocol legality, proxy/backend state | Anything visual or vanilla-UI |
| **Physical GPU/display manual run** | No | **Yes** | Yes | Visual quality, GPU/driver parity, final human confirmation | Automation/repeatability |

**CI recommendation:** run the Fabric client gametest lane on every change as a
fast regression gate. Do **not** run the online-mode Gate B proof in CI with a
real account; keep the token cache on a dedicated display host. CI artifacts:
screenshots, client log, gametest report, and a JSON summary.

**Display-host recommendation:** one machine with Java 25, Prism, a real player
account, and either a GPU or Xvfb + Mesa. This host owns the client lane for
M1–M5. The workspace continues to own backends, proxies, and protocol pre-checks.

**Manual steps:** first Microsoft device-code/2FA; one unmodded vanilla
confirmation per Gate B run; visual review of screenshots; account recovery; ToS
review. The 5-minute detach soak can be automated, but a human should inspect the
final evidence at least once.

---

## Dependencies and pins

| Component | Pin | Role | Local status |
|---|---|---|---|
| Minecraft Java client | **26.1.2**, SHA-1 `4e618f09a0c649dde3fdf829df443ce0b8831e65` | Official client | Not cached; download ~38 MB + assets |
| Java | **25.0.2** (Mojang component `java-runtime-epsilon`, major 25) | Runtime | Installed; shim unset |
| Fabric Loader | **0.20.1** | Loader | Not installed |
| Fabric Installer | **1.1.2** | Installer | Not installed |
| Fabric API | **0.155.3+26.1.2** | Client gametest + events | Not installed |
| Fabric Loom | 1.19.3 latest stable in Maven metadata; use the version pinned by the 26.1.2 template (1.20.0-alpha for newer lines) | Build/test tasks | Not installed |
| Gradle | Use the wrapper from the Fabric template; system 9.7.1 is installed but may not match Loom’s supported range | Build | Installed; shim unset |
| Prism Launcher | **11.1.1** | Auth/instance/launch | Missing |
| MultiMC | 0.6.13+ | Fallback launcher | Missing |
| Xvfb | Debian `2:21.1.16-1.3+deb13u4` candidate | Virtual display | Missing |
| Mesa llvmpipe | `libgl1-mesa-dri`, `libglx-mesa0`, `mesa-utils` (Mesa 25.0.7 candidate) | Software OpenGL | Missing |
| xdotool | `1:3.20160805.1-5.1` candidate | XTEST input | Missing |
| openbox / wmctrl | Debian candidates | Focus/window management | Missing |
| ImageMagick | `import`, `identify`, `compare` | Screenshots | Missing |
| ffmpeg | Debian candidate | Optional video capture | Missing |
| tesseract | Debian candidate | Optional OCR | Missing |
| RCON client | `rcon-client` npm or `mcrcon` | Server assertions | Missing; add to tool deps |
| `minecraft-protocol` | **1.68.0** | Protocol pre-check | Installed |
| `minecraft-data` | **3.119.0** | 26.1/775 data | Installed |
| HeadlessMc | **3.0.0-RC8** | Headless state-machine smoke | Missing |
| hmc-specifics | 26.1–26.1.2 build | Headless commands | Missing |
| MCProtocolLib | latest `1.21.4-1` | **Do not use** | No 26.1 |

**Backend pins are out of scope here**; ticket 02 owns the backend matrix. The
client pin is 26.1.2 because it is protocol 775 and a hotfix over 26.1; a 26.1
client is also protocol-compatible. Use the **Gradle wrapper** generated by the
Fabric template for the driver; do not assume the system Gradle 9.7.1 matches
Loom’s supported range.

---

## Runnable command sketch

These are sketches, not implemented repo tasks. Placeholders: `<player>` is the
Prism profile name, `<puppet>` is the backend player name.

### 0. Display host preparation (Debian/Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb x11-utils xdotool wmctrl openbox imagemagick ffmpeg tesseract-ocr \
  mesa-utils libgl1-mesa-dri libglx-mesa0 \
  libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 libxxf86vm1 \
  libopenal1

# Java 25 (mise is already used in this repo)
mise use -g java@25.0.2
java -version   # expect openjdk 25.0.2
```

### 1. Build and install the driver mod (sketch)

```bash
export JAVA_HOME="$HOME/.local/share/mise/installs/java/25.0.2"
export PATH="$JAVA_HOME/bin:$PATH"
export PRISM_INSTANCE_GAME_DIR="$PWD/.gate-b/prism-player/instances/gate-b-player/minecraft"

./gradlew :gate-b-driver:build
cp gate-b-driver/build/libs/gate-b-driver-*.jar \
  "$PRISM_INSTANCE_GAME_DIR/mods/"
# also place fabric-api-0.155.3+26.1.2.jar in the same mods/ directory
```

Prism’s instance game directory is the folder opened by **Instance Folder**;
newer Prism uses `minecraft/`, older MultiMC uses `.minecraft/`. Resolve it
once in the harness rather than hard-coding it.

### 2. Start a virtual display (headless host)

```bash
Xvfb :99 -screen 0 1280x720x24 +extension GLX +render -noreset &
export DISPLAY=:99
openbox &
export LIBGL_ALWAYS_SOFTWARE=1
export ALSOFT_DRIVERS=null
glxinfo -B | grep -E 'OpenGL renderer|OpenGL version'
# expect: llvmpipe ... and OpenGL version >= 4.4
```

### 3. Launch the real client through Prism

```bash
prismlauncher \
  -d "$PWD/.gate-b/prism-player" \
  -l gate-b-player \
  -a "<player>" \
  -s 127.0.0.1:25565 \
  >.gate-b/logs/prism.log 2>&1 &
```

Use a **separate Prism root** (`-d`) for Gate B. Do not add the puppet account to
Prism. The `-s` value is `host:port`; Prism has no `--port`. Prism does not
document a CLI flag for `--quickPlayPath`; add it through the launcher’s
game-argument override (or a direct launch) if you want the filesystem join log,
and otherwise use RCON plus the client log as the join proof.

### 4. Drive and assert (sketch)

```bash
node tools/gate-b/run.mjs \
  --driver 127.0.0.1:25599 \
  --rcon 127.0.0.1:25575 \
  --proxy-report testdata/gate-b-proxy.json \
  --out testdata/gate-b-client-report.json
```

The scenario should do:

```text
wait driver.status.screen == null && level != null && player != null
screenshot join
rcon: list                         -> one puppet
rcon: data get entity <puppet> Pos  -> record p0
driver: look 270 0; move forward 20 ticks
rcon: data get entity <puppet> Pos  -> record p1; assert delta
driver: look at (2,-60,0); status.hitResult -> block
driver: break; wait block air; rcon: execute if block 2 -60 0 minecraft:air
rcon: item replace entity <puppet> hotbar.0 with minecraft:stone 64
driver: look at support face; place; wait block stone
rcon: execute if block 2 -60 0 minecraft:stone
driver: disconnect; wait DisconnectedScreen
rcon: list                         -> puppet still present
proxy report: front ended, backendLogins == 1
wait 5 s (or 5 min for the acceptance soak)
driver: reconnect; wait screen null + chunks rendered
rcon: data get entity <puppet> Pos  -> assert current pose, not stale
proxy report: attachCount == 2, backendLogins == 1
screenshot reattach
```

### 5. Unmodded vanilla confirmation lane

```bash
prismlauncher \
  -d "$PWD/.gate-b/prism-vanilla" \
  -l gate-b-vanilla \
  -a "<player>" \
  -s 127.0.0.1:25565 \
  >.gate-b/logs/prism-vanilla.log 2>&1 &

# Wait for the window, then focus it.
wid=$(xdotool search --sync --name 'Minecraft' | head -1)
xdotool windowactivate --sync "$wid"
xdotool windowfocus "$wid"

# Small, real XTEST input; mouse-look is the flaky part.
xdotool keydown --clearmodifiers w
sleep 1
xdotool keyup --clearmodifiers w
```

Assert the Quick Play log (if `--quickPlayPath` was enabled) and a screenshot:

```bash
import -window "$wid" /tmp/gate-b/join.png
identify -format '%wx%h %k colors\n' /tmp/gate-b/join.png
tesseract /tmp/gate-b/join.png stdout 2>/dev/null \
  | grep -qi 'Loading terrain' && echo 'FAIL: still loading' || echo 'PASS: no loading text'
```

### 6. CI lane (offline, in-process server)

```bash
CI=1 ./gradlew runProductionClientGameTest \
  -Dfabric.client.gametest \
  -Dfabric.client.gametest.disableNetworkSynchronizer=true
# Screenshots: build/run/clientGameTest/screenshots
```

### 7. Protocol pre-check (this workspace can run it)

```bash
node src/gate-b/precheck.js --host 127.0.0.1 --port 25565 --version 26.1
# Sketch: minecraft-protocol client, offline auth, send position/dig/place,
# assert proxy counters and backend login count. Reuse Gate A's fake client.
```

### 8. Direct client launch (only if you already have a launcher-generated command)

```bash
# Do NOT hand-build the classpath. Copy the exact command Prism/Fabric prints
# (or a launcher log), then add Quick Play. Avoid putting a token in shell history.
java -Xmx4G ... net.minecraft.client.main.Main \
  --username "<player>" --uuid "<uuid>" --accessToken "<token>" \
  --version 26.1.2 --gameDir .gate-b/game-player \
  --assetsDir .gate-b/assets --assetIndex 30 \
  --quickPlayMultiplayer 127.0.0.1:25565 \
  --width 1280 --height 720
```

The token is a bearer credential and is visible in `/proc/<pid>/cmdline` on a
multi-user host. Prefer Prism, a single-user display host, and never commit or
log the command.

---

## Smallest falsifying experiment

**Goal:** prove the client runner can join, render, move, edit, disconnect, and
rejoin a *plain* 26.1.2 server, before Monoplayer is in the path. If this fails,
Gate B cannot distinguish a client-control bug from a Monoplayer bug.

**Setup (one display host, ~15 minutes):**

1. Java 25.0.2; Prism 11.1.1; a 26.1.2 Fabric instance named `gate-b-player`
   with the real player account, Fabric Loader 0.20.1, Fabric API
   0.155.3+26.1.2, and the `gate-b-driver` jar in `mods/`.
2. A plain Paper 26.1.2 build 74 server on `127.0.0.1:25565`:
   `online-mode=true`, `white-list=true`, player whitelisted, flat world,
   `view-distance=4`, `simulation-distance=4`, `spawn-protection=0`,
   `difficulty=peaceful`, `gamemode=creative`, `pause-when-empty-seconds=0`,
   RCON on 25575 with a runtime password.
3. `Xvfb :99` + `openbox` (or a real display) and `LIBGL_ALWAYS_SOFTWARE=1`.

**Steps:**

1. Launch:
   `prismlauncher -d .gate-b/prism-player -l gate-b-player -a "<player>" -s 127.0.0.1:25565`.
2. Wait for the driver’s `status` to report `screen == null`, `level != null`,
   `player != null` within 90 s; assert RCON `list` shows the player and the
   screenshot is past the loading screen. If `--quickPlayPath` was enabled, the
   JSON log must exist and name `127.0.0.1:25565`.
3. Teleport to a known flat spot; driver holds forward for 20 ticks; assert
   client and RCON `Pos` both change by >1 block in the expected direction.
4. Break a target block; assert RCON `execute if block ... air` passes. Place a
   stone block; assert RCON `execute if block ... stone` passes.
5. Disconnect; assert RCON `list` no longer shows the player and the client shows
   the disconnect/title screen.
6. Reconnect; assert null screen + chunks rendered, the pose matches, and the
   block edit persists.

**Pass:** all six steps pass twice in a row on the same host.

**Fail / stop:** the client never leaves “Loading terrain…”, the screenshot is
blank, movement does not reach the server, block edits are no-ops, or reconnect
hangs. Fix the client runner before running Gate B.

**Unmodded variant:** repeat steps 1–3 and 5–6 with a vanilla 26.1.2 Prism
instance and `xdotool` (or manual input). Treat block edits as optional/manual in
this variant; the driver is the reliable block-edit lane. If the driver passes
but the unmodded lane fails, the driver is masking a vanilla problem. If the
unmodded lane passes but the driver fails, the driver is broken. If both fail,
the host/display/client install is broken.

Then repeat the same scenario through Monoplayer. A failure that appears only
through Monoplayer is a product defect; a failure that appears on both is a
client/harness defect.

---

## Risks and open questions

| # | Risk / question | Why it matters | Mitigation / next check |
|---|---|---|---|
| C1 | 26.1.2 driver method names for input/interaction differ from 1.21.x | The driver may not compile or may bypass the intended path | Verify against unobfuscated 26.1.2 source; keep the driver small |
| C2 | Prism 11.1.1 under Xvfb/llvmpipe is unproven on the target host | The primary runner may not start | Run the smallest experiment; if Qt/GL fails, use a GPU display or the gametest lane |
| C3 | 26.1.2 client + llvmpipe at 1280×720 may exceed 60 s chunk-render time on 4 cores | CI timeouts/flakes | RD 4, 854×480, 2–4 GB heap, 120 s timeout, sequential runs |
| C4 | Fabric gametest production client may not accept real auth/external server | CI lane cannot prove online-mode | Treat CI as offline-only; keep the online proof on Prism |
| C5 | `-Dfabric.client.gametest` changes tick/network synchronization | Timing may not represent production | Use it for pre-checks; confirm with the unmodded lane |
| C6 | `xdotool` synthetic events may be ignored by GLFW | Vanilla lane keys/click fail | Use `windowactivate` + XTEST, not `--window`; verify with screenshot |
| C7 | Mouse-look/pointer grab makes block targeting flaky | Vanilla lane cannot assert precise edits | Use the driver/gametest for edits; vanilla lane confirms join/render/move |
| C8 | Prism stores tokens plaintext | Credential leak | Dedicated host, 0700 root, disk encryption, no cloud sync, no shared screenshots/logs |
| C9 | Access token appears in `/proc/<pid>/cmdline` | Local credential exposure | Single-user host; prefer Prism; never log the command |
| C10 | A modded client may hide a vanilla bug | Gate B over-claims | Require one unmodded confirmation run |
| C11 | The 5-minute detach soak is long and can mask a crash | Acceptance window unproven | Automate the soak in the driver/gametest, record keep-alives and backend session |
| C12 | 26.1.2 vs 26.1 backend compatibility | Client is 26.1.2, backend matrix may use 26.1.2; both 775 | Record exact versions in the report; do not mix 26.2+ |
| C13 | Secure chat/signatures require real profiles | Chat may be out of scope | Keep chat out of the first client lane; test separately if ticket 05 includes it |

**Open measurements:** Prism+llvmpipe join time and chunk-render time on the
target host; whether 26.1.2's `--quickPlayPath` writes as documented in the Prism
launch path; whether the Fabric production client accepts `--quickPlayMultiplayer`
with a real token; whether the driver's `MultiPlayerGameMode` calls produce one
completed serverbound dig action and one place action.

---

## Corrections to prior research

1. **`research/02-backend-matrix.md` says the 26.1 client requires a Vulkan 1.3
   GPU.** That is the current 26.3 requirements table, not 26.1.2. The 26.1.2
   version JSON contains only OpenGL/GLFW libraries, and Vulkan/`--graphicsBackend`
   arrive in 26.2. For Gate B's 26.1.2 pin, plan for **OpenGL**, not Vulkan.
2. **Software rendering is viable for 26.1.2.** Mesa llvmpipe supports OpenGL
   4.6; the Fabric docs explicitly support `useXVFB` for client gametests. This
   makes a headless CI lane possible, but not a substitute for the online-mode
   proof.
3. **Prism is 11.1.1 now**, not 11.0.3. The CLI contract (`-d/-l/-s/-a`, no
   `--port`) is unchanged.
4. **MCProtocolLib is not a 26.1 option**; its latest release is 1.21.4-1. Use
   `minecraft-protocol` 1.68.0 (already proven by Gate A) or a real client.

---

## Sources

- [Minecraft 26.1.2 version JSON](https://piston-meta.mojang.com/v1/packages/dd6fd47eec3ac2d46b4f805e003f1a421ed8a3f7/26.1.2.json) — client SHA-1, Java 25, arguments, assets, libraries.
- [Minecraft 26.1.2 client jar](https://piston-data.mojang.com/v1/objects/4e618f09a0c649dde3fdf829df443ce0b8831e65/client.jar) — official client.
- [Java Edition 26.1.2](https://minecraft.wiki/w/Java_Edition_26.1.2) — release/protocol/Java.
- [Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1) — unobfuscated release.
- [Java Edition 26.2](https://minecraft.wiki/w/Java_Edition_26.2) — Vulkan experimental renderer, `--graphicsBackend`.
- [Java Edition client command line arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments) — Quick Play, `--server` removal, game args.
- [Quick Play](https://minecraft.wiki/w/Quick_Play) — `--quickPlayPath` log format and semantics.
- [Java Edition hardware requirements](https://minecraft.wiki/w/Java_Edition) — current 8/12 GiB and GPU table (26.3-era; see correction).
- [Fabric automated testing for 26.1.2](https://docs.fabricmc.net/26.1.2/develop/automatic-testing) — client gametest, Xvfb CI recipe.
- [Fabric API 0.155.3+26.1.2 client gametest package](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/package-summary.html) — lifecycle, threading, defaults.
- [`ClientGameTestContext`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/context/ClientGameTestContext.html) — waits, screenshots, input, client access.
- [`TestInput`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/TestInput.html) — key/mouse/look/type.
- [`TestClientLevelContext`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/context/TestClientLevelContext.html) — download/render waits.
- [`TestWorldBuilder`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/world/TestWorldBuilder.html) and [`TestDedicatedServerContext`](https://maven.fabricmc.net/docs/fabric-api-0.155.3%2B26.1.2/net/fabricmc/fabric/api/client/gametest/v1/context/TestDedicatedServerContext.html) — in-process server/connect.
- [Fabric Loom production run tasks](https://docs.fabricmc.net/26.1.2/develop/loom/production-run-tasks) — `useXVFB`, `programArgs`, production client.
- [Fabric Loader meta for 26.1.2](https://meta.fabricmc.net/v2/versions/loader/26.1.2) — 0.20.1.
- [Fabric installer meta](https://meta.fabricmc.net/v2/versions/installer) — 1.1.2.
- [Fabric API versions](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml) — 0.155.3+26.1.2.
- [Fabric Loom versions](https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml) — 1.19.3 stable / 1.20.0-alpha.
- [Prism CLI wiki](https://prismlauncher.org/wiki/getting-started/command-line-interface/) — `-d/-l/-s/-a`, no `--port`.
- [Prism 11.1.1](https://github.com/PrismLauncher/PrismLauncher/releases/tag/11.1.1) — current release.
- [Prism #250](https://github.com/PrismLauncher/PrismLauncher/issues/250) — one process per instance.
- [Prism #4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073) — plaintext account tokens.
- [MultiMC 0.6.13](https://multimc.org/posts/0-6-13-update.html) — Microsoft device flow, `--launch`/`--server`.
- [HeadlessMc](https://github.com/headlesshq/headlessmc) — headless launcher.
- [HeadlessMc specifics](https://headlesshq.github.io/headlessmc/specifics/) — supported 26.1–26.1.2, commands, screenshots/keys.
- [hmc-specifics](https://github.com/headlesshq/hmc-specifics) — version-specific command mods.
- [minecraft-protocol](https://github.com/PrismarineJS/minecraft-protocol) — protocol client used by Gate A.
- [minecraft-data](https://github.com/PrismarineJS/minecraft-data) — 26.1/775 data.
- [MCProtocolLib releases](https://github.com/GeyserMC/MCProtocolLib/releases) — latest 1.21.4-1; no 26.1.
- [Mineflayer #3888](https://github.com/PrismarineJS/mineflayer/issues/3888) — 26.1.2 mapping concern.
- [Xvfb manual](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml) — virtual X server.
- [Mesa llvmpipe](https://www.mesa3d.org/llvmpipe.html) — software OpenGL.
- [xdotool](https://github.com/jordansissel/xdotool) — X11 automation.
- [Minecraft Wiki: RCON](https://minecraft.wiki/w/RCON) — RCON protocol/port.
- [Minecraft Wiki: `/data`](https://minecraft.wiki/w/Commands/data) — entity/block NBT queries.
- [Minecraft Wiki: `/execute`](https://minecraft.wiki/w/Commands/execute) — `if block`/`if items`.
- [Minecraft Wiki: `/item`](https://minecraft.wiki/w/Commands/item) — hotbar replacement.
- [Minecraft Wiki: `/tp`](https://minecraft.wiki/w/Commands/tp) — teleport/rotation.
- [Architecture validation loop](../../../docs/architecture.html#validation) — Gate A falsifier, L2 invariants, client vs protocol split.
- [`docs/gate-a.md`](../../../docs/gate-a.md) — what the protocol harness proves and does not prove.
- [`research/02-backend-matrix.md`](02-backend-matrix.md) — backend matrix, front/back leg distinction, client footprint (Vulkan claim corrected here).
- [`research/03-two-accounts.md`](03-two-accounts.md) — Prism setup, per-instance account override, token custody.

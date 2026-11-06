# Research: controlling a real 26.1 client

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

How can Gate B control a real Minecraft 26.1 Java client deterministically enough
to assert that it leaves “Loading terrain…”, renders, moves, breaks/places a
block, chats (if in scope), disconnects, and reattaches?

Compare:

- Prism Launcher or MultiMC instances launched with `--server`/`--port`,
  separate user-data directories, and two accounts.
- A vanilla launcher plus Xvfb + xdotool + screenshots (or a physical display).
- A Fabric client with a tiny test/automation mod (client commands, packet
  assertions, screenshots), while keeping the protocol path vanilla.
- Protocol-level bots (`minecraft-protocol`, mineflayer, MCProtocolLib) as a
  fast pre-check, clearly separated from the official-client proof.
- Any existing Minecraft client test harness, speedrun/automation setup, or
  headless-client project that is credible for 26.1.

Answer:

- What is the smallest reliable official-client runner on Linux?
- What can run in CI/headless, what needs a GPU/display, and what must stay
  manual?
- How do we assert rendering and movement rather than just “the process is
  alive”? Screenshots, OCR, log lines, packet counters, or a companion bot?
- How do we avoid flaky timing and GUI focus problems?
- What is the recommended Gate B client strategy, with fallbacks?

Deliverable: a recommendation, a dependency/tool list, a runnable command
sketch, and the smallest falsifying experiment. Do not implement.

## Answer

<!-- filled on resolution -->

## Answer

Use **Prism Launcher 11.1.1 + a 26.1.2 Fabric production instance + a thin
client-only `gate-b-driver` mod** as the deterministic instrument, and one
**unmodded Prism/vanilla run** as the anti-masking witness. Prism supplies the
real Microsoft session, assets, and `-s host:port`; the driver exposes a
loopback JSON control socket and reads `Minecraft.getInstance()` so the gate can
assert `screen == null`, level/player alive, chunks rendered, hit result, and
block state. It must not mix into the connection, login/play handlers, codecs,
or Netty. Fallbacks: unmodded Prism + Xvfb + Mesa llvmpipe + xdotool +
screenshots + RCON; Fabric Client Gametest for offline CI; HeadlessMc for
state-machine smoke; protocol bots only as pre-checks.

This workspace cannot run the client: no `DISPLAY`, `/dev/dri`, X/GL libraries,
Xvfb/xdotool, launcher, `sudo`, ~3.4 GiB free RAM. The official-client lane needs
a separate display/GPU host. 26.1.2 is **OpenGL**, not Vulkan; Vulkan and
`--graphicsBackend` arrive in 26.2, so Mesa llvmpipe is viable. First gate is a
plain-server falsifier: official client joins Paper directly, renders, moves,
edits, disconnects, rejoins, 2/2, before Monoplayer is involved. Full note:
[`research/01-client-control.md`](../research/01-client-control.md).

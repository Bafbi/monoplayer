# Gate B M4: Paper sits behind Velocity and a real client played through it

Verdict: **PASS** for the forwarding lane, **PASS** for the real-client row, **PARTIAL** for the unmodded row. The F1–F6 fault rows never ran.
Date: 2026-11-07, three records between `13:28Z` and `19:52Z`.
Commands: the smoke record names its own: a one-off `node --input-type=module` script calling `minecraft-protocol` `createClient` with `auth=microsoft`, `profilesFolder=.secrets/puppet`, `version=26.1`. The real-client and unmodded rows attached the official 26.1.2 client to the Monoplayer front, the shape `node src/driver/run.js` drives. Neither of those two records names the flags it used.
Fact: modern forwarding carries the puppet's identity through the proxy, and one backend login served the whole attach.

## The forwarding smoke

`2026-11-07T13:28:00.000Z`, row `M4 — Paper 26.1.2 behind Velocity 4.3.1`, result `PASS (M4 forwarding/proxy lane; fault rows pending)`.

- Topology: a protocol bot with the puppet's cache, Velocity `velocity-4.3.1-45` at `monoplayer-gate-b-velocity.tail41e568.ts.net:25565` in online mode with modern forwarding, and `paper-m4` with `online-mode=false`, `secure-profile=false`, whitelist GlowSquidye.
- The bot logged in as entity 23, name GlowSquidye, UUID `73e0e19b-d4e4-4cc1-a553-a3952f0c1aed`.
- Paper reported the forwarded identity: `UUID of player GlowSquidye is 73e0e19b-...`, `GlowSquidye joined the game`, `GlowSquidye[/10.244.0.11:43988] logged in with entity id 23 at ([minecraft:overworld]0.5, -60.0, -2.5)`.
- Checks: `modernForwardingActive: true`, `backendSawPuppetOnly: true`, `playerNotUsedInM4Smoke: true`, `twoAccount: false`, `backendLogins: 1`. Paper logged both `Using libdeflate ... compression from Velocity` and `Using OpenSSL ... cipher from Velocity`.
- Provenance: `velocity-4.3.1-45.jar`, sha256 `0844bcab...58dd75`; Paper 26.1.2 build 74; the forwarding secret is a cluster Secret, rotated, never written to git.

`testdata/m4-puppet-smoke.log` held four lines: the fixture's listen line, `LOGIN {"entityId":23,"username":"GlowSquidye","uuid":"73e0e19b-..."}`, `SMOKE_COMPLETE_OK`, and `END "smoke complete"`.

## The real-client pass

`2026-11-07T19:48:00.000Z`, result `PASS (join, render, move, break, place)`. The front was Monoplayer at `127.0.0.1:25565` in online mode with `hasJoined`, pinned to the glowsquidye account, with Velocity 4.3.1 b45 and `paper-m4` behind it.

- 1374 frames replayed on attach: `cached_replay`, 32 configuration frames, 28 `registry_data` frames suppressed.
- 81 chunks loaded, 26 sections rendered, 44 fps.
- Move: `0.5,-60,-2.5` to `0.5,-60,1.7734`, with the backend at `0.5,-60,3.972016653595148`.
- Break: `2,-60,0` went from `minecraft:stone` to `minecraft:air`.
- Place: on the dirt support `2,-61,0`, the target `2,-60,0` became `minecraft:stone`.
- One backend login, and the live wire check inspected 1952 frames and rejected none (configuration 32, play 1920).
- `testdata/m4-driver-join.png` was the driver-owned render target, not a compositor capture.

## The unmodded row

`2026-11-07T19:52:00.000Z`, result `PARTIAL`. The unmodded official 26.1.2 client reached the front with 1786 replayed frames, two front attaches, and one backend login. The live wire check inspected 5519 frames and rejected none, and the client log reached `Loaded 20 advancements`.

Still pending in that record: visual render confirmation on the display host, manual movement, and manual disconnect with reattach.

## What these three records do not prove

- The smoke was direct client to Velocity to Paper, not through Monoplayer, and it used the protocol client only (`twoAccount: false`). The player attach path is the real-client row.
- Toxiproxy was deployed, but no fault row was exercised. That is the B3 lane.
- `paper-m4` emits no chunk batch markers, so the warm fallback pinned the join prefix at 745 frames.
- The attaching client profile is Bafbi while the replayed play stream is the GlowSquidye session. Identity separation is a later row.

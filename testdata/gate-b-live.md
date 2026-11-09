# Gate B live front: a real client attached to a live server through Monoplayer and played

Verdict: **PASS** on 2026-11-07T14:26Z for row `B1 — Monoplayer live attach (direct Paper G0)`. The deployed front then passed 8 of 9 assertions on 2026-11-07T23:51:50Z.
Commands: the B1 record names no command line; it records its topology and the gate result `mise run check` (185 of 185 tests). The deployed record names its own regeneration command: `kubectl -n monoplayer logs deploy/monoplayer | grep '"event":"heartbeat"' | tail -1`.
Fact: one backend login served the join, the detach, and the reattach, and the front rebuilt each attach from the cache.

## B1: direct Paper G0

`2026-11-07T14:26:00.000Z`, result `PASS (join, render, move, break, place, detach/reattach)`. The front was Monoplayer at `127.0.0.1:25565` in online mode with `hasJoined`; the backend `monoplayer-gate-b-paper.tail41e568.ts.net:25565`, Paper 26.1.2 b74; the client the `gate-b-player-fabric` instance on `nath`.

- Join: `attachAllowed`, configuration `cached_replay` with 32 frames and 28 `registry_data` suppressed, 811 replayed frames, one backend login, `warm: true`, and 3 non-play frames ignored. Paper logged `GlowSquidye joined the game` and `logged in with entity id 241`.
- Render: 120 fps, 117 chunks loaded, 38 sections rendered. `testdata/b1-join.png` was the driver's render target.
- Interaction: move from `z 8.5` to `12.77` over a 1500 ms driver move, then to `14.97`. `give GlowSquidye minecraft:stone 64` over RCON, break at `6,-60,12` (stone to air), and place on the dirt support at `6,-61,12`.
- Reattach: the client was killed, the socket closed, the reattach replayed 1536 frames, and the client came back with 117 chunks and 38 rendered sections.
- The fix that made this row pass: the core had cached backend login-phase frames (`encryption_begin`, `compress`, `success`) in the play join prefix, and replayed `encryption_begin` (packet id `0x01`) decoded as `add_entity` with 114 extra bytes. The core now ignores every frame state except `configuration` and `play`, and drops bundle delimiters while relaying their enclosed frames.
- `mise run check` passed 185 of 185 tests, and the targeted `node --test test/monoplayer-*.test.js` run passed 59 of 59.

Three limits the record states: this is direct Paper G0, not the M4 Velocity topology; the client profile is Bafbi while the replayed stream is the GlowSquidye session; and the screenshot comes from the driver mod, not the compositor.

## The deployed front on Excalia Season 3

`2026-11-07T23:51:50Z`, `passed: true`, 8 assertions passed and V9 `not_observed`. Cluster `deepmine`, namespace `monoplayer`, Argo app `deepmine-dev-monoplayer` at `Synced/Healthy`, one replica with the `Recreate` strategy. Image `registry.internal/deepmine/monoplayer@sha256:bf0741b2...`, tag `sha-f26bc38`, front `glowsquidye.tail41e568.ts.net:25565` on a Tailscale Service at `100.66.20.83`, backend `play2.excalia.fr:25565` on 26.2 (protocol 776).

- V1: the puppet logged in to Season 3 as GlowSquidye on 26.2. V2: the front was ready from backend frames before the attach, with the warm fallback and 573 prefix frames. V3: the online-mode Bafbi attach was allowed. V4: configuration replayed from the cache, 33 frames, 28 `registry_data` suppressed.
- V5: 673 frames replayed, 401 `map_chunk` frames cached, and the client log read `chunk section buffers resized to 128 during world load`.
- V6 and V7: one backend login, 572 serverbound frames forwarded, 8 dropped, 1 chat blocked. V8: the wire checker inspected 785 frames and rejected none.
- V9 stayed `not_observed`: in-world movement needs the player's own confirmation, and client frames alone do not prove the backend accepted the actions.
- Metrics: 779 backend frames, 34 configuration frames, 752 cached, 673 replayed, 1 synthesized position, 1 attach, 0 denials, 0 front kicks. Named backend frames: 401 `map_chunk`, 82 `update_time`, 81 `entity_metadata`, 78 `entity_teleport`, 78 `keep_alive`, 25 `system_chat`, 10 `player_info`.

The client there was the vanilla Prism instance `gate-b-player-262` on `nath`, whose only join log line was `Connecting to glowsquidye.tail41e568.ts.net, 25565`.

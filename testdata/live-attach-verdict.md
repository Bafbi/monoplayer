# A real client attached through Monoplayer to a live Paper server and played

> **Record, not documentation.** Taken 2026-11-07 by the `gate-b-player-fabric`
> client on `nath`, with `mise run check` recorded beside it. Every number below
> belongs to that run: read it as evidence of what happened, never as a current
> claim, and do not update it to match today.

Verdict: **PASS** on 2026-11-07T14:26:00.000Z for row `B1 — Monoplayer live attach (direct Paper G0)`.
Date: 2026-11-07.
Command: the record names no command line. It records its topology and the result of `mise run check`, which ran 185 of 185 tests, with 59 of 59 on the targeted `node --test test/monoplayer-*.test.js` run.
Fact: the client detached and reattached onto the same running session, 1536 frames came back from the cache, and the world returned with the same 117 chunks and 38 rendered sections.

Source: `testdata/b1-verdict.json` and `testdata/b1-join.png`, both removed from git. Every quote below comes from them.

## The topology

The front leg was Monoplayer at `127.0.0.1:25565` in online mode with `hasJoined`. The backend leg reached `monoplayer-gate-b-paper.tail41e568.ts.net:25565`, Paper 26.1.2 b74 at G0. The client was the `gate-b-player-fabric` instance on `nath`, on official 26.1.2 with the driver installed.

## What passed

- Join: `attachAllowed`, configuration `cached_replay` with 32 frames and 28 `registry_data` suppressed, 811 replayed frames, `backendLogins: 1`, `warm: true`, and 3 non-play frames ignored. Paper logged `UUID of player GlowSquidye is 73e0e19b-d4e4-4cc1-a553-a3952f0c1aed`, `GlowSquidye joined the game`, and `GlowSquidye[/10.244.1.245:...] logged in with entity id 241`.
- Render: 120 fps, 117 chunks loaded, 38 sections rendered. `testdata/b1-join.png` is the 1916x1050, 1234680-byte driver render target.
- Move: `z 8.5` to `12.77` over a 1500 ms driver move, then to `14.97`.
- Give and edit: `rcon give GlowSquidye minecraft:stone 64` left the stone held. A driver break at `6,-60,12` turned stone into air, and a driver place on the dirt support at `6,-61,12` set `targetBlock` stone with `placed: true`.
- Reattach: the client was killed and the socket closed. The reattach replayed 1536 frames, and the client came back with 117 chunks and 38 rendered sections.

## The defect this row found

The core had cached backend login-phase frames (`encryption_begin`, `compress`, `success`) in the play join prefix. Replayed in play state, `encryption_begin` (packet id `0x01`) decoded as `add_entity` and the client rejected the frame with 114 extra bytes. The core now ignores every frame state except `configuration` and `play`, which is the record's `nonPlayFramesIgnored`. Bundle delimiters are dropped while their enclosed frames are relayed individually, so chunks and entities replay without the bundle wrapper.

## What it does not prove

The record states three limits:

- This is direct Paper G0, not the M4 Velocity topology. [The M4 verdict](m4-verdict.md) covers that path.
- The attaching player's profile is Bafbi, and the replayed play stream is the GlowSquidye session. Identity separation is row B4.
- The screenshot comes from the driver mod, not the compositor.

The deployed image reached a live public server later: [the deployed service](service-verdict.md).

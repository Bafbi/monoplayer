# Gate A: the frozen protocol spike passed 37 of 37 assertions

Verdict: **PASS**, 37 of 37 assertions, none failed.
Date: 2026-11-05, report timestamp `2026-11-05T21:54:37.163Z`.
Command: `mise run spike:report`, which runs `node src/spike/run.js` and writes `testdata/spike-report.json`.
Fact: a second client attached and landed on the first client's pose, while the backend leg kept one login and stayed in play.

## What the report held

`passed: true`, `assertionCount: 37`, `failedAssertions: []`.

The scenario ran a fake backend, the proxy, and two protocol clients in turn. The 37 assertions fall in five groups.

- **Cache and join order.** The cache held the join sequence (`login`, `game_state_change`, `chunk_batch_start`, `map_chunk`, `chunk_batch_finished`). Client 1 received them in that exact order with a synthesized `position` and saw the puppet's profile.
- **Serverbound relay.** The backend received exactly one `block_dig` and one `block_place`, and the attach replayed the cached frames plus the synthesized position.
- **Per-leg frames.** The teleport-confirm, chunk-batch ack, and keep-alive sentinels never reached the backend. The proxy answered them, and the backend saw the proxy-owned teleport confirms and chunk-batch ack.
- **Detach and reattach.** The soak ran 5000 ms and the detach was recorded. The backend leg stayed in play with one login while detached, and client 2 landed on client 1's pose, not the stale backend teleport. The backend logins were still exactly 1 after the reattach.
- **Chat.** Serverbound chat was blocked at the proxy and never reached the backend. Clientbound `player_chat` was neither cached nor replayed, and never reached the client.

Versions in the report: Minecraft 26.1, protocol 775, Node v26.7.0, `minecraft-protocol` 1.68.0, `minecraft-data` 3.119.0, `prismarine-chunk` 1.41.0, `vec3` 0.1.10.

## What it does not prove

The report's own notes say it:

- uses a protocol client, not the official vanilla client;
- runs both legs offline, so neither encryption nor `hasJoined` is exercised;
- lets the front leg auto-configure through the library, so configuration replay is not exercised;
- soaks the attach and detach for 5000 ms, not the five minutes the architecture asks for.

The live rows cover those gaps: [the live front](gate-b-live.md), [M4 behind Velocity](gate-b-m4.md), and [the online rung](online-rung.md).

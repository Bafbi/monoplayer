# Online rung: the Microsoft-authenticated player attached through the live front

Verdict: **PASS**, `passed: true`. Eleven of twelve assertions passed and N11 is `not_observed`, so the record lists it under `notObserved`.
Date: 2026-11-07. The record carries no timestamp of its own; it landed in commit `8b6cf2f` that day.
Command: `mise run online`, which runs `node src/ladder/online.js` and writes `.reports/online-report.json` by default.
Fact: a real Microsoft login attached to the live front as Bafbi while the puppet's session on the live backend kept one login across the detach and the reattach.

## The run

`mode: online`, `auth: microsoft`, `version: 26.1`, duration 34271 ms. The backend leg was `monoplayer-gate-b-velocity.tail41e568.ts.net:25565`, and the front leg listened on `127.0.0.1:36739`.

- N1: the Microsoft-authenticated attach succeeded (`botReady: true`, `frontAttaches: 1`, `coreAttached: true`).
- N2: one online attach allowed, none denied.
- N3: the configuration replay came from the cache (`lastConfigMode: cached_replay`).
- N4: play login, position, and a chunk arrived in that order. The first six play frames were `playerlist_header`, `login`, `clear_titles`, `difficulty`, `abilities`, `held_item_slot`; `loginIndex: 1`, `positionIndex: 39`, `chunkIndex: 40`.
- N5: no login-state frame leaked into play, across 578 play frames.
- N6: one backend login.
- N7: the wire checker inspected 609 frames and rejected none (configuration 32, play 577).
- N8: the bot saw no leftover bytes and no errors.
- N9: three serverbound frames (move, dig, place) reached the backend, observed at the backend leg's `writeRaw`.
- N10: detach and reattach kept one backend login across 2 attaches.
- N12: the attach identity was the Bafbi profile (`6eb73524-...`), and the puppet's writer lock was released.
- N11 stayed `not_observed`: no unwhitelisted Microsoft account was configured, and the online front needs a real login. So the deny path was proven in [the custody row](gate-b-custody.md), not here.

Readiness before the attach: configuration present, prefix present, `warm: false` with the warm fallback taken, 33 configuration frames, 556 prefix frames, 30017 ms elapsed.

This rung is still a `minecraft-protocol` bot, not a vanilla client. The vanilla acceptance lives in [the live front row](gate-b-live.md) and [M4](gate-b-m4.md).

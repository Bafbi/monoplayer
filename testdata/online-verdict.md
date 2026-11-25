# The online rung passed 11 of 12 assertions with a real Microsoft login

> **Record, not documentation.** Taken 2026-11-07 by `mise run online`, on the
> day the record landed: it carries no timestamp of its own. Every number below
> belongs to that run: read it as evidence of what happened, never as a current
> claim, and do not update it to match today.

Verdict: **PASS**, `passed: true`. Eleven assertions passed and N11 is `not_observed`, so the record lists it under `notObserved`.
Date: 2026-11-07. The record carries no timestamp of its own, and it landed in commit `8b6cf2f` that day.
Command: `mise run online`, which runs `node src/ladder/online.js` and writes `.reports/online-report.json` by default.
Fact: a real Microsoft login attached through the front leg as Bafbi while the puppet's session on the live backend kept one login across the detach and the reattach.

Source: `testdata/online-verdict.json`, removed from git. Every quote below comes from it.

## The run

The record set `mode: online`, `auth: microsoft`, and `version: 26.1`, and it took 34271 ms. The backend leg reached `monoplayer-gate-b-velocity.tail41e568.ts.net:25565`, and the front leg listened on `127.0.0.1:36739`. Readiness before the attach held configuration and prefix frames, refused to call itself warm, took the warm fallback at 556 prefix frames and 33 configuration frames, and spent 30017 ms on it.

- N1: the Microsoft-authenticated attach succeeded, with `botReady: true`, `frontAttaches: 1`, and `coreAttached: true`.
- N2: one online attach allowed, none denied.
- N3: the configuration replay came from the cache, `lastConfigMode: cached_replay`.
- N4: play login, position, and a chunk arrived in that order. The first six play frames were `playerlist_header`, `login`, `clear_titles`, `difficulty`, `abilities`, and `held_item_slot`, with `loginIndex: 1`, `positionIndex: 39`, and `chunkIndex: 40`.
- N5: no login-state frame leaked into play, across 578 play frames.
- N6: one backend login.
- N7: the wire checker inspected 609 frames and rejected none, 32 configuration and 577 play.
- N8: the bot saw no leftover bytes and no errors.
- N9: three serverbound frames reached the backend, observed at the backend leg's `writeRaw` as `position`, `block_dig`, and `block_place`.
- N10: detach and reattach kept one backend login across 2 attaches.
- N12: the attach identity was the Bafbi profile `6eb73524-ff88-4a62-a8d0-c63905e7afba`, and the puppet's writer lock was released.
- N11 stayed `not_observed`. The record's reason reads `no unwhitelisted Microsoft account is configured; the online front needs a real login`. [The custody verdict](custody-verdict.md) proved the deny path instead.

## What it does not prove

The rung still uses a protocol bot on `minecraft-protocol`, so it proves wire shape and relay behavior, never rendering or vanilla acceptance. Those belong to [the live attach](live-attach-verdict.md) and [the M4 row](m4-verdict.md).

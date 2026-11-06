# Research: late attach and state reconstruction

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

The puppet may already be connected when a client attaches, and it must survive a
client disconnect. How can an attaching client receive a valid *current* world and
session state without dropping the puppet's backend session?

Evaluate at least:

- Replaying every backend packet recorded since login, with compression/encryption
  re-framed for the client.
- Keeping a bounded state cache (chunks, entities, inventory, player list, time,
  weather, scoreboard) and synthesizing a fresh join sequence.
- Forcing a backend reconnect on attach and letting the client join from scratch.
- Keeping a headless bot authoritative and generating the client's world view.
- Hybrids: cache the join/config phase, reconnect only the play stream, or use a
  "warm" backend reconnect with the same account.

For each: correctness risks, memory bounds, attach latency, what packets must be
captured or rewritten, and how to test it deterministically with a fake backend.

Deliverable: a recommendation with an explicit MVP trade-off and the invariant it
must preserve.

## Answer

Adopt **cached configuration replay + bounded play-state cache + synthesized
join**, with live backend deltas coalesced into the cache during the attach
("semantic buffering"), never byte-queued. The backend session is owned by the
proxy and never dropped for client attach/detach.

- Cache raw chunk frames (bytes, including light) in an LRU, plus entity
  registry/metadata, inventory snapshots, player list, scoreboard, boss bars,
  time/weather, health/xp, commands and join fields.
- Replay the cached config frames, then synthesize the canonical play join
  (Login, abilities, held slot, player list, border, spawn, time, container,
  health, Game Event 13, `Synchronize Player Position`, center chunk, chunks,
  entities, live cutover).
- Entity IDs, including the puppet's, pass through; one controlling client means
  no entity-ID remapping.
- The proxy owns keep-alive and teleport IDs per leg; IDs never bridge legs.
  While detached it answers backend keep-alives and teleport confirms.

Rejected: full replay (unbounded memory and attach latency; chunks are ~79% of
server-to-client bytes, entity deltas ~86% of packet count); backend reconnect on
attach (loses position/inventory; queue servers make it impossible); bot-world
synthesis (speculative, no full-fidelity official-client implementation).

MVP trade-off: chunks whose bytes were mutated by block updates are evicted on
attach rather than patched, so a reattaching client may see those areas
unrendered until the puppet returns. Memory is tens of MB; attach is ~1-3 s and
flat with session age. Full test plan and failure table in
[`research/02-late-attach.md`](../research/02-late-attach.md).

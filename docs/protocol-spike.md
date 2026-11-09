# Protocol spike runbook — relay at the protocol level

Throwaway spike proving that a two-leg Node proxy can terminate a Minecraft
session per leg, synthesize a fresh play join from a bounded frame cache, and
relay control packets without ever reconnecting the backend. Pinned to
**minecraft 26.1 / protocol 775** (minecraft-data 3.119.0's newest supported
version). Plain Node ESM JavaScript, no TypeScript. No external services, no
Mojang calls, no Microsoft accounts; loopback only.

**Result (2026-11-05):** `mise run check` passes, `mise run spike:report` passes
37/37 assertions. Verdict and quotes: [../testdata/spike-verdict.md](../testdata/spike-verdict.md).
The runner writes `testdata/spike-report.json`; git does not carry it.

Files:

| File | Role |
|---|---|
| `src/spike/proxy.js` | Two-leg proxy: backend client leg ("Puppet"), front server leg, bounded frame cache, relay rules, metrics, JSON logs. |
| `src/legs/fake-backend.js` | Scripted backend: minimal flat-world join (login, game_state_change 13, position, one chunk batch), records serverbound packets, `sendBlockChange`/`sendPosition`. |
| `src/spike/fake-client.js` | Attaching protocol client: records clientbound frames and parsed data, sends position/dig/place/chat. |
| `src/spike/scenario.js` | The scenario + assertions, shared by the CLI and the test. |
| `src/spike/run.js` | CLI runner: prints PASS/FAIL, writes `testdata/spike-report.json`, exits non-zero on failure. |
| `test/spike/scenario.test.js` | The same scenario under `node:test`. |

## What this proves

1. **Protocol-level login/config/play relay.** The proxy terminates the login
   and configuration phases per leg (the library auto-completes configuration),
   then relays play frames in both directions as decoded frames, re-framed per
   leg. Compression is per-connection; frames are re-compressed on each leg by
   `writeRaw`. Encryption is **not** exercised (both legs are offline).
2. **Synthesized play join from cache.** An attaching client gets the cached
   join sequence in exact order (`login` entityId 42, `game_state_change` 13,
   `position`, `chunk_batch_start`, `map_chunk` 0,0 with real chunk bytes,
   `chunk_batch_finished`), then live frames. The forged Login Success presents
   the puppet profile (name `Puppet`, UUID `00000000-…-0001`); the play `login`
   reuses the backend's entity ID.
3. **Current pose reconstruction.** The proxy records the attaching client's
   serverbound movement and synthesizes a fresh `position` with a proxy-owned
   teleport ID on attach. A client that walks to `2.5` and detaches reattaches at
   `2.5`, not at the backend's old teleport.
4. **Detach survival under a short soak.** After a 5-second attached soak and a
   5-second detached soak, the front client has not ended or errored, the
   backend leg is still in `play`, both legs have exchanged keep-alives, and the
   cache keeps filling. This is not the architecture's 5-minute window.
5. **No second backend login.** `backendLogins === 1` for the whole run with
   two attaches. There is no backend reconnect on attach or detach.
6. **Per-leg ownership is asserted, not just implemented.** The backend sees the
   proxy's teleport confirms (`1`, `2`) and chunk-batch ack (`32`), never the
   attaching client's sentinels (`777`, `1`, `424242`). The client's
   `teleport_confirm`, `chunk_batch_received`, and `keep_alive` are dropped.
7. **Chat is blocked in both directions.** Serverbound `chat_message` never
   reaches the backend; a backend `player_chat` sent while detached is not
   cached or replayed. Writable/read-only chat is a later slice.
8. **Liveness is observable.** The report includes client errors, client end
   reasons, keep-alive counts, teleport confirms, and chunk-batch acks, so a
   kick immediately after join cannot silently pass.

## What this does not prove

- **Official vanilla client acceptance.** The attaching client is a protocol
  client built on minecraft-protocol; it does not render chunks or enforce
  vanilla UI state machines. The real falsifier (official 26.1 client leaves
  "Loading terrain…", renders, stays 60 s) still needs the manual §7.6 run
  from research 02.
- **Encryption.** Both legs are offline; the wire carries Set Compression but
  no Encryption Request. The architecture's L2 invariant “puppet joins with
  encryption active” is not exercised.
- **Online-mode `hasJoined` / whitelist.** Both legs are `online-mode: false`;
  the front leg forges the puppet profile without any Mojang session check.
- **Microsoft device-code auth.** No token flow is touched; the puppet leg is
  offline.
- **Secure chat / `last_seen`.** Chat is blocked in both directions, not
  re-signed or remapped. The per-leg acknowledgement machinery from the audit
  (P0-1/P0-2) is out of scope for this spike.
- **Product-grade bounded cache.** The cache is a capped join prefix plus a
  512-frame sliding window; it does not coalesce block updates into chunk
  bytes, maintain entity/inventory snapshots, or evict per-domain. Chunks sent
  after the initial batch would not be cached (see limitations). The prefix cap
  is implemented but not flood-tested.
- **Config-phase replay.** The front server's library auto-config
  (registry data, finish configuration) serves the attach; cached config-frame
  replay is not exercised. This is an accepted spike simplification.
- **Vanilla-pacing semantics.** One chunk batch is in flight at a time in
  vanilla; the fake client does not enforce batch pacing, and the proxy acks
  each backend batch itself.
- **Early/concurrent attach and backend drop.** The proxy rejects a second
  simultaneous attach and closes the front client when the backend ends, but
  the harness does not test either path.
- **The architecture's 5-minute detach window.** The harness soaks 5 seconds,
  enough for a keep-alive round-trip, not the full requirement.

## How to run

```bash
mise run check    # install (frozen) + lint (node --check) + node:test suite
mise run spike:report   # full scenario, writes testdata/spike-report.json, PASS/FAIL summary
```

`mise run spike:report` exits non-zero if any scenario assertion fails.
`testdata/spike-report.json` holds the timestamp, assertions with details,
proxy metrics, backend records, client packet logs, and dependency versions.

## Design notes and spike workarounds

- **Relay is frame-level, not byte-level.** The `raw` event yields the decoded
  frame (packet ID + body, after decrypt/decompress); `writeRaw` re-frames it
  for the other leg's compression/encryption. This is the only legal relay:
  per-connection encryption and compression forbid byte passthrough. The spike
  exercises compression, not encryption.
- **Per-leg keep-alive ownership.** Backend keep-alive frames are neither
  cached nor relayed; each leg's library keep-alive plugin answers its own
  leg. This avoids replaying stale keep-alive IDs.
- **Teleport ownership.** The proxy confirms the backend's
  `synchronize_player_position` on the puppet leg itself and drops the
  attaching client's `teleport_confirm`, so exactly one confirm reaches the
  backend. (26.1/775 has only `teleport_confirm`; there is no
  `accept_teleportation` in this protocol.)
- **Chunk batch ownership.** The proxy acks the backend's batches on the
  puppet leg (`chunk_batch_received`); the attaching client's
  `chunk_batch_received` (acking a proxy-synthesized batch) is dropped, not
  forwarded.
- **Chat blocklist.** Serverbound `chat_message`, `chat_command`,
  `chat_command_signed`, `chat_session_update`, and `chat_ack` are dropped;
  the chat ones increment `chatBlocked`. Clientbound `player_chat`,
  `profileless_chat`, `hide_message`, and `system_chat` are dropped before the
  cache, so a late attach cannot replay stale indexes or signatures. This is
  stricter than “read-only chat”; it is a deliberate MVP cut.
- **Pose ownership.** The proxy tracks the latest serverbound pose
  (`position`, `position_look`, `look`) and synthesizes a fresh `position` with
  a proxy-owned teleport ID on every attach. Backend `position` frames update
  the pose but are never cached raw.
- **Liveness assertions.** The fake client records `ended` and `errors`; the
  scenario holds the attach for 5 seconds and asserts no end/error, a front
  keep-alive, a backend keep-alive, and backend state `play`.
- **Chunk payload.** prismarine-chunk 26.1 builds the chunk (`minY: -64`,
  `worldHeight: 384`, grass at y=0, full sky light); `dump()` +
  `dumpLight()` feed `map_chunk` with empty heightmaps and no block entities.
  Verified: the payload round-trips through minecraft-data's 26.1
  `map_chunk` parser on the other leg.
- **Known gap:** a second chunk batch from the backend would be cached as
  ordinary frames but replayed with stale chunk contents after later block
  updates. Out of scope for the spike; the product cache coalesces block changes
  into chunk bytes.

## Post-verification fixes

The independent verifier
(a local audit memo under `.scratch/`) found
that the first version passed while hiding stale client pose, post-join kicks,
and replayed clientbound chat. The current harness addresses those:

- **P0-1 — pose:** tracks serverbound `position`/`position_look`/`look`, never
  caches backend `position` raw, and synthesizes a proxy-owned position on
  attach. Regression: client moves to `2.5`, detaches, reattaches at `2.5`.
- **P0-2 — liveness:** 5-second attach and detach soaks, front/backend
  keep-alive assertions, `ended`/`errors` recorded and asserted, backend state
  `play`.
- **P0-3 — clientbound chat:** `player_chat`, `profileless_chat`,
  `hide_message`, and `system_chat` are dropped before the cache; a
  `player_chat` sent while detached is asserted absent on reattach.
- **P1-4/P1-5 — ownership:** backend counters assert proxy teleport confirms
  (`1`, `2`) and chunk-batch ack (`32`), and client sentinels (`777`, `1`,
  `424242`) never cross. `cookie_response`, `resource_pack_receive`, and `pong`
  are in the drop set but not all are exercised.
- **P1-9 — exactness:** exact join order, chunk coordinates/bytes, and
  exactly-once movement/dig/place.

Still not covered: config replay, encryption, online-mode `hasJoined`,
Microsoft auth, secure-chat re-signing, the 5-minute detach window, concurrent
attach, backend drop, and a real prefix-flood test. The prefix cap is
implemented but not flood-tested.

## A later real-client spike

The proxy (`src/spike/proxy.js`) is already shaped for it:

1. Point the backend leg at a real 26.1 backend and log in as the puppet with
   real credentials (`auth: 'microsoft'` or an injected session) instead of
   `auth: 'offline'`.
2. Turn the front leg online: `'online-mode': true` plus a `hasJoined` stub or
   a whitelist check in `beforeLogin`; the forged puppet profile stays.
3. Replace `src/spike/fake-client.js` with the official 26.1 vanilla client pointed
   at `proxy.frontPort`, and replace `src/legs/fake-backend.js` with the real
   backend. Cache warm, attach replay, pose synthesis, relay rules, and detach
   survival are the same code path. **Config-phase replay is not**: the front
   server still auto-configures from `minecraft-data`, so a real-client gate
   must add cached config replay before it can claim parity with the backend.
4. Manual falsifier per research 02 §7.6: client leaves "Loading terrain…",
   renders the chunk, stays connected 60 s, and a serverbound block break
   reaches the backend. Chat remains blocked unless the per-leg chat state
   machine is implemented.

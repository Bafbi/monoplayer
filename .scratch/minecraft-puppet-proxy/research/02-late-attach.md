# Research note 02: late attach and state reconstruction

Tickets answered: `.scratch/minecraft-puppet-proxy/issues/02-research-late-attach-state.md`
Researched: 2026-11-05. Current protocol: **Java Edition 26.3 "Wilderness Bound", protocol 777** (released 2026-09-15; 26.4 snapshots are current dev).

## TL;DR

**Recommendation: hybrid — replay the cached configuration phase (deterministic, ~tens of KB), then synthesize the play-state join from a bounded state cache, while live backend deltas coalesce into the cache during the attach replay ("semantic buffering", never byte replay). The backend session is never dropped on attach or client disconnect. Entity IDs — including the puppet's own — pass through unmodified, so no serverbound packet rewriting is needed. Cache raw chunk frames (bytes, including light), not parsed blocks.**

This is not speculative: it is the architecture of several working projects — `ZenithProxy` (production, 2b2t, 444★), `azalea-reflection-proxy` / `mineflayer-reflection-proxy`, and `IceTank/mineflayer-proxy-inspector` — all of which attach vanilla clients mid-session by replaying cached config frames + a synthesized join + a raw chunk cache + a world snapshot.

**Invariant to preserve:** *the server-side session (TCP connection, entity, inventory, world state) is owned by the proxy and survives all client attach/detach cycles; every client-visible state transition flows through the proxy's cache; the synthesized join must be indistinguishable from a fresh vanilla join for the pinned protocol version (26.3 / 777).*

**MVP trade-off:** accepting that attach replays only what the cache holds. World state outside the cache radius (see §5) shows as unrendered chunks until the puppet moves there again. In exchange we get bounded memory, ~1–3 s attach latency, and no backend reconnect.

**Smallest falsifying experiment:** single-chunk fake backend + hardcoded cache + official vanilla 26.3 client. If the client fails to leave "Loading terrain…" or kicks within 60 s after a synthesized join (config replay + Login + position + one chunk batch + one entity), the whole approach needs fallback (§3.1 full replay for short sessions, or a bot-viewer). ~1 day of work; detail in §7.6.

---

## 1. Constraints this design must satisfy

1. **The proxy holds the only official session.** A second Mojang-authenticated login for the same account **kicks the first session server-side** with "You logged in from another location" ([PaperMC#5303](https://github.com/PaperMC/Paper/issues/5303), [MC-172541](https://bugs.mojang.com/browse/MC/issues/MC-172541)); the Mojang session service also ends a session when the account logs in elsewhere. Therefore the attaching client must *never* authenticate to the backend with the puppet's account; it authenticates only to the proxy, which forges the login. This also kills "client attaches to the backend directly" as an option.
2. **Encryption and compression are per-connection.** Login encryption is AES/CFB8 negotiated per connection, compression thresholds too. **Byte-level packet forwarding between legs is impossible** (confirmed by azalea-reflection-proxy: "Byte forwarding is impossible: the upstream leg is encrypted with keys the proxy negotiated"). Everything replayed or relayed must be done at the decoded **frame** level (packet id + body after decrypt/decompress) and re-framed per leg.
3. **Packet IDs shift every minor release.** E.g. the play Login packet is 0x2B in 1.21.8 (772), 0x30 in 1.21.9–11 (773–774), 0x31 in 26.1–26.2 (775–776), 0x32 in 26.3 (777) ([rosegold mapping](https://rosegoldmc.github.io/rosegold.cr/Rosegold/Clientbound/Login.html)). The proxy must pin one version for MVP (26.3/777) — this feeds the open "version matrix" decision in `map.md`.
4. **State machine strictness.** A client that receives an out-of-state packet treats it as a fatal protocol error; `Keep Alive` must be answered within **30 s** or the connection is dropped ([VoidMC lifecycle](https://voidminecraft.github.io/VoidMC/reference/protocol-specs/v26.1.2/connection-lifecycle.html)). Synthesized and replayed streams must be perfectly state-framed (login → config → play) and keep-alive-clean.
5. **Single account, single tenant, single attach at a time** (map.md). This simplifies everything: no entity-ID rewriting (IDs are only meaningful per connection), no multi-view broadcast, no concurrency in the cache.

## 2. Protocol state inventory (what "current world state" actually is, 26.x)

Connection lifecycle states: HANDSHAKING → LOGIN → CONFIGURATION → PLAY, with re-entry into CONFIGURATION possible from PLAY (`Start Configuration` / `Configuration Acknowledged`), and transfer packets in both config and play ([VoidMC](https://voidminecraft.github.io/VoidMC/reference/protocol-specs/v26.1.2/connection-lifecycle.html)).

### 2.1 Login phase (proxy terminates both legs differently)

- **Puppet leg** (proxy as client, online mode): `Hello` → encryption request/response → **Mojang `hasJoined`** → `Login Compression` → `Login Success` (resolved profile: UUID, name, **properties incl. skin textures**) → `Login Acknowledged`. Proxy holds the shared secret for this leg.
- **Client leg** (proxy as server): proxy forges `Login Success` with the **puppet's** UUID/name/properties so the client renders the puppet's identity. The client's own credentials are a whitelist/attach-token check (ticket 04), never a Mojang call. Encryption optional on this leg (loopback/TLS-internal); vanilla clients accept offline-style login.
- Secure chat: the puppet's chat keypair (RSA, 256-byte signatures, per `init-chat` / `c-player-chat-message`) belongs to the proxy's login; if the backend sets `enforces_secure_chat` (see Login play packet below), client chat must be **re-signed by the proxy** or blocked (details ticket 01). A broken `Player Chat Message` message-index sequence disconnects the client — so do not replay chat history at all.

### 2.2 Configuration phase (replayable per attach — deterministic and small)

Canonical order: brand plugin message → `Update Enabled Features` → `Select Known Packs` (both ways) → **`Registry Data`** (one per registry — dimension types, biomes, etc.; the attaching client needs these or it stalls) → `Update Tags` → `Finish Configuration` / `Acknowledge Finish Configuration`. Side packets: cookies (request/store), resource-pack push/pop, keep-alive/ping, dialogs, server links, transfer ([VoidMC](https://voidminecraft.github.io/VoidMC/reference/protocol-specs/v26.1.2/configuration.html)). Observed sizes in a real session capture ([TAMUctf SMP writeup](https://ctftime.org/writeup/39089)): Registry Data 4.6 KB, Update Tags 8.5 KB, Commands 7.8 KB, Update Recipes 22.7 KB — the whole config phase is tens of KB, so caching its raw frames and replaying them on every attach is cheap and exactly what azalea-reflection-proxy does ("cached config frames + a synthesized FinishConfiguration").

### 2.3 Play state

The canonical post-join sequence ([VoidMC](https://voidminecraft.github.io/VoidMC/reference/protocol-specs/v26.1.2/connection-lifecycle.html)) is the template the synthesized join must follow: `Login (play)` → `Change Difficulty` → `Player Abilities` → `Set Held Slot` → recipes/tags if needed → `Entity Event`s → `Commands` → `Player Info Update` → `Initialize World Border` → `Set Default Spawn Position` → `Set Time` → `Set Container Content` → `Set Health`/`Set Experience` → `Synchronize Player Position` (forces client confirm) → `Set Center Chunk` → `Chunk Batch Start` → `Level Chunk With Light` ×N → `Chunk Batch Finished` → client `Chunk Batch Received`.

State domains to cache (with the packets that update them):

| Domain | Absolute-state packets (cache & replay) | Delta packets (apply into cache, coalesce) |
|---|---|---|
| Join/spawn | `Login` (entity_id, hardcore, dimension names, max players, view/simulation distance, dimension type index, dimension name, hashed seed, game mode, previous game mode, death info, portal cooldown, sea level, **`online_mode` (new in 26.2+/776)**, `enforces_secure_chat`) | — |
| Chunks | `Level Chunk With Light` (paletted sections bottom-to-top; overworld = 24 sections; heightmaps optional — client fills min values) | `Block Update`, `Section Blocks Update`, `Multi Block Change` — must be applied to cached chunk bytes, or the re-attached client sees stale terrain |
| Entities | `Spawn Entity`/`Spawn Living Entity`/`Spawn Player`/`Spawn Experience Orb` (+ full metadata), `Entity Teleport`, `Set Passengers`, `Set Equipment`, `Update Attributes` | `Set Entity Metadata` (index-based deltas → maintain full metadata map), `Update Entity Position/PosRot/Rot` (**relative** deltas → accumulate absolute pose), `Rotate Head`, `Remove Entities` (delete from cache) |
| Inventory | `Set Container Content` (per window id), `Set Player Inventory` (1.21.2+ per-slot), `Open Screen`, `Container Close` | `Set Container Slot`, `Set Cursor Item`, window data (`Set Container Data`) |
| Player list | `Player Info Update` actions: Add Player (0x01; name + properties), Initialize Chat (0x02), Update Game Mode (0x04), Update Listed (0x08), Update Latency (0x10), Update Display Name (0x20), Update List Priority (0x40, 1.21.2+), Update Show Hat (1.21.4+) | `Player Info Remove` (UUIDs) |
| Time/weather | `Set Time` (absolute), `Update Time` (world age + time-of-day + tick flag), `Game Event` (rain/thunder level change), `Set Default Spawn Position` | — (cache last values) |
| Scoreboard | `Update Objectives` (create/remove/update), `Update Score` (create/remove), `Display Objective`, `Set Player Team` (1.20.3+ team model), `Reset Score` (1.21.2+) | — (cache per-objective/per-team) |
| HUD/health | `Set Health`, `Set Experience`, `Set Held Slot`, `Player Abilities`, `Change Difficulty`, `Update Advancements`, `Update Recipes`, `Boss Bar` (Add/Update/Remove — must be accumulated per UUID and **synthesized as Add before live updates**, else the mid-fight attach client kicks) | `Set Cooldown`, `Entity Event` |

Also: `Commands` tree, world border (`Initialize World Border` + lerp/size/center), `Game Event` 13 (**"start waiting for level chunks"** — must be sent after Login or the client never leaves "Loading terrain…"), `Synchronize Player Position` (proxy issues its own teleport id and swallows the client's `Confirm Teleportation`).

Empirical traffic model (TAMUctf capture, [writeup](https://ctftime.org/writeup/39089)): **chunks = 78.6 % of all server→client bytes** (7.9 MB of 10.3 MB); **entity movement/rotation/motion packets ≈ 86 % of all packet count** (~170 k of 199 k). This single capture justifies the whole design: you cannot replay the byte stream (unbounded chunks), and you cannot replay packet-by-packet (unbounded entity deltas) — you must cache chunks raw and coalesce entity deltas.

## 3. The five approaches

### 3.1 Full replay of every backend packet since login — **rejected (MVP)**

Re-frame every recorded backend frame to the new client connection (decrypt → re-encrypt, re-compress).

- **Correctness risks:** replay order must be byte-exact; live packets arriving during replay must queue behind it (unbounded buffer if backend outruns the drain); replayed keep-alives carry IDs the client then echoes and the proxy must swallow; chat message indices and container state-id sequences must not be replayed (client disconnects on broken chat sequence); sounds/particles/boss-bar animations replay as jank; client UI state machine sees containers open/close mid-replay.
- **Memory bounds: unbounded.** ~10 MB per short session; hours → GBs (chunks dominate at 79 % of bytes).
- **Attach latency: unbounded.** Replay time scales with session length, and chunk-batch pacing caps throughput further (client acks each batch with `Chunk Batch Received`, one batch in flight — [protocol packets page](https://minecraft.wiki/w/Java_Edition_protocol/Packets)).
- Verdict: correct only for minutes-long sessions; fails both memory and latency requirements. Keep as a **fallback mode** for debugging, and as the "ring buffer of the last N seconds" hybrid idea below.

### 3.2 Bounded state cache + synthesized join — **recommended (see §4)**

Proven by prior art; bounded; fast; the only approach that meets all requirements. Details, risks, and numbers in §4–§6.

### 3.3 Forcing a backend reconnect on attach — **rejected**

Disconnect the puppet, client attaches, proxy re-joins as puppet from scratch.

- **Fails the core requirement:** the puppet does not survive client disconnect with its world state (position, inventory, effects, vehicles all reset to spawn).
- Correctness: server treats every attach as a fresh join — lost inventory is the dealbreaker for any real use.
- Failure modes: "logged in from another location" ghost-session races (MC-172541); Spigot/Paper `connection-throttle` on rapid reconnects; **queue servers (2b2t) make this hours-impossible** — the whole reason ZenithProxy exists; Mojang session-server churn per attach (rate limits not well documented — speculative).
- Only role: *failure recovery* (backend TCP drop). Then the proxy reconnects with a **warm** cached login/config (the "warm reconnect" hybrid) and re-syncs the client from cache — accepting that server-side state is lost on genuine backend failure, which is unavoidable.

### 3.4 Headless bot authoritative world synthesis — **not required for MVP; optional later layer**

The proxy embeds a full bot (Mineflayer/azalea-style); the client becomes a controller of the bot, and the client's world view is generated from the bot's simulation rather than raw server packets.

- This is **ZenithProxy's** model (Baritone pathfinding, movement simulation, world cache; `<300 MB` RAM total; ViaVersion-integrated so the bot leg runs a well-supported protocol version).
- **Correctness risks:** the proxy's simulation must stay consistent with the *server-authoritative* state (anti-cheat on handoff: azalea-reflection-proxy warns "position is aligned on handoff, but momentum is not carried over; treat with care on anticheat-guarded servers"); bot world models lack **light data** — if chunks are synthesized from a parsed world model rather than raw chunk frames, the vanilla client renders darkness; Mineflayer lags protocol versions (see [minecraft-web-client](https://github.com/zardoy/minecraft-web-client) caveat).
- Scope: this is a superset of §3.2 — the bot sim is only needed for unattended *behavior* (auto-eat, AFK movement). Monoplayer's puppet is idle when no client is attached, so **MVP needs no simulation**: the proxy just answers keep-alives and teleport confirms on the puppet leg (exactly what azalea-reflection-proxy does when controllerless: "the proxy answers keepalives and confirms teleports itself, so the session stays alive with nobody driving").
- Verdict: adopt §3.2's cache now; bot simulation is a drop-in later feature, not an architecture change.

### 3.5 Hybrids

- **Cache config, synthesize play (§3.2 as stated)** — recommended. Config replay is deterministic and small; play synthesis is where the bounded cache lives.
- **Ring-buffer replay of the last N seconds + cache for older state** — a valid optimization on top of §3.2 (replay exact recent frames, synthesize older state), but adds ordering complexity between the replayed tail and cache state; **defer**.
- **Warm backend reconnect** — keep cached login/config so recovery reconnects skip Mojang/queue overhead where possible; does not avoid state loss; use for failure recovery only (§3.3).

## 4. Recommended design (bounded cache + synthesized join)

### 4.1 Puppet leg (proxy as client to backend)

Full online-mode auth; answer backend `Keep Alive` (30 s deadline) and `Confirm Teleportation` (echo backend ids); ack chunk batches; answer `Cookie Request`/`Known Packs` itself. Apply every clientbound play packet to the cache:

- store **raw chunk frames** (bytes, incl. light) keyed by (x,z), LRU-bounded;
- apply block-change packets into chunk bytes (parse-and-re-encode affected sections — the hairiest component; see §6);
- maintain entity registry: absolute poses (accumulated from relative deltas), full metadata map (applied index deltas), equipment, passengers, attributes, removals;
- maintain inventory snapshots per window id; player list per UUID (all action fields); scoreboard objectives/scores/teams; last time/weather/border values; boss bars per UUID; held slot; health/xp; abilities/difficulty; commands tree; advancements/recipes.

### 4.2 Attach sequence (client leg)

1. Terminate client login (forged Login Success with puppet profile; whitelist check per ticket 04).
2. Replay cached **config frames** (brand, enabled features, registry data, tags, finish configuration) in order.
3. Synthesize play join per §2.3 template: `Login` (entity id = puppet's backend entity id — this is what makes all serverbound packets passthrough-valid; `online_mode=true` for the client's benefit; `enforces_secure_chat` copied from backend), abilities, held slot, commands, full `Player Info Update` adds, border, spawn, time, weather game events, `Set Container Content` per open window, health, xp, **`Game Event` 13**, `Synchronize Player Position` (puppet's exact pose, own teleport id), `Set Center Chunk`.
4. **Chunk batches**: replay cached chunks within radius, framed in fresh `Chunk Batch Start`/`Finished` pairs, paced on the client's `Chunk Batch Received` acks. Include the full radius — the vanilla client generally won't render chunks lacking neighbors ([chunk format page](https://minecraft.wiki/w/Java_Edition_protocol/Chunk_format)); azalea-reflection-proxy confirms: "the vanilla client won't leave 'Loading terrain…' until the chunk under its feet loads."
5. **Entity burst**: spawn cached entities with full metadata + equipment + passengers; then scoreboard, boss bars (synthesized Add per UUID), maps deferred.
6. **Live stream cutover**: during 1–5, live backend frames are *not* dropped and not queued byte-wise — they coalesce into the cache (entity deltas → absolute pose/metadata, block changes → chunks, container slots → snapshots), and non-state packets (chat, sounds) are dropped-until-attached. After replay finishes, flush the final coalesced state (positions, metadata diffs) and go live. This "semantic buffering" keeps the drain bounded regardless of attach duration.
7. **Client leg hygiene**: swallow client keep-alives/teleport confirms/cookie responses/known-packs/resource-pack responses; answer with proxy ids; block or re-sign chat per §2.1.

### 4.3 Client disconnect

Detach tears down the client leg only. Puppet leg continues; the proxy keeps answering keep-alives/teleport confirms so the backend never notices. Cache keeps updating. Next attach re-runs §4.2.

## 5. Memory bounds and attach latency (estimates, with sources)

- **Chunk cache**: cap = max(attach view distance, backend render distance). RD 10 → 441 chunks × ~15–30 KB (paletted sections + light; [chunk format](https://minecraft.wiki/w/Java_Edition_protocol/Chunk_format)) ≈ **9–19 MB**; RD 12 → 625 chunks ≈ 10–20 MB. Paletted BPE 0/4–8/15 keeps chunks compact; the client accepts non-compacted data but wastes its own memory — cache frames as received.
- **Entities**: a few hundred entities × ~1–2 KB metadata ≈ **<1 MB**.
- **Player list**: ~100 players × ~4–8 KB (signed texture properties dominate) ≈ **<1 MB**.
- **Inventories/scoreboard/boss bars/misc**: **<1 MB** total.
- **Total: tens of MB.** Cross-check: ZenithProxy runs bot + world cache + ViaVersion in **<300 MB** ([README](https://github.com/rfresh2/ZenithProxy)).
- **Attach latency**: config replay <50 ms; chunks are the dominant term — RD 8 (289 chunks, ~4 MB) ≈ 0.3 s on a 100 Mbit link plus client meshing; client-side chunk processing dominates and is the same cost as a fresh vanilla join (~1–2 s at RD 8). **Expect ~1–3 s attach-to-playable**, bounded by the cache radius, independent of session age. Justifies the "attaching" screen UX option in map.md.
- **Unattached-period drift**: none for state flowing through the puppet leg (the backend keeps sending to the puppet); the cache is always current, by construction.

## 6. Failure modes and mitigations (synthesized-join approach)

| Failure mode | Consequence | Mitigation |
|---|---|---|
| Out-of-state packet | Client treats as fatal protocol error | Frame strictly per state machine; config frames only in config state |
| Chunk under the feet missing | Client stuck on "Loading terrain…" forever | Always replay full radius incl. neighbor chunks; assert in tests (§7.5) |
| Isolated chunks sent | Chunks don't render (client requires neighbors) | Full-radius batch replay |
| Keep-alive starvation during long replay | 30 s drop, either leg | Proxy answers both legs independently; never gate keep-alives behind replay |
| Backend outruns replay drain | Unbounded buffer | Semantic buffering (§4.2.6): coalesce, never queue bytes |
| Missed `Remove Entities` | Ghost entities on re-attach | Cache removals; only spawn cache-present entities |
| Stale chunk bytes (block changes while detached) | Re-attached client sees old terrain | Apply `Block Update`/`Section Blocks Update`/`Multi Block Change` into cached chunk bytes (§4.1) |
| Live boss-bar update before replay of Add | Client kick on unknown boss bar | Accumulate per UUID; synthesize Add on attach (azalea hardening) |
| Chat message index mismatch | Client disconnect on broken sequence | Never replay chat history; live chat from attach point starts at index 0 |
| Replayed keep-alive ID collision | Timeout/disconnect | Filter clientbound keep-alives during replay; proxy issues its own |
| Teleport-id mismatch on `Synchronize Player Position` | Movement glitches/timeout | Proxy owns ids on the client leg; swallows confirms |
| Secure chat enforced by backend | Chat signatures invalid from the backend's view | Re-sign with puppet keypair or block chat (MVP: prefer `enforce-secure-profile=false` backends; ticket 01 detail) |
| Backend `Transfer` packet | Client would be told to reconnect elsewhere | Proxy absorbs the transfer, follows it as the puppet, re-syncs cache, client stays attached (MVP: block + reconnect, re-run attach) |
| Backend re-enters CONFIGURATION mid-play | State-machine surprise for attached client | Handle `Start Configuration` on the client leg by re-entering config with the client too, or buffer and re-attach |
| Server with modded registries/palettes | Cache must be version+registry-aware | Pin 26.3/777; out of scope for MVP (map.md excludes modded servers) |
| Backend TCP drop (genuine) | Session lost server-side; unavoidable | Warm reconnect (§3.3) + re-sync from cache; alert via metrics (ticket 03) |

## 7. Deterministic fake-backend test plan

Fake backend = scripted server speaking the pinned protocol from a **scenario file** (YAML/JSON): deterministic seeded pseudo-random chunk/entity data, a timed event list ("spawn entity", "change block", "rain", "re-enter config", "transfer"), and the ability to pause and mutate mid-stream. Fake client = scripted official-protocol client that records every received frame into a **normalized log** (parse and dump; strip volatile fields: keep-alive ids, ping values, world-age ticks) and answers keep-alives/acks/teleport confirms on demand. Harness = `mise` task per layer (ticket 03 owns the loop; this note defines what the tests must prove).

### 7.1 Unit (cache model, no sockets)
For a random scripted stream: after applying all deltas to the cache, the cache's synthesized snapshot **equals** the last absolute-state packet of each domain (model-based invariant). Property-test metadata deltas (index patches), relative→absolute entity motion accumulation, chunk byte mutations via block updates.

### 7.2 Integration (proxy between fake backend and fake client)
- **T1 attach-at-t0**: client log from proxy == golden log of a direct backend→client run of the same scenario (normalized). Establishes the proxy is transparent when attached from the start.
- **T2 late attach, mutated world**: attach at scenario tick T after chunk edits, entity spawns/removals, inventory slot changes, player-list churn, scoreboard updates, rain. Assert: client sees *current* chunk bytes, no removed entities, latest inventory snapshot, full tab list, current time/weather; no stale-state packets in the log.
- **T3 mid-batch attach**: attach while a chunk batch is in flight on the puppet leg. Assert well-formed `Chunk Batch Start`/`Finished` framing on the client leg and that the client's `Chunk Batch Received` acks never desync (one batch in flight).
- **T4 disconnect survival**: detach client, run scenario 10 more minutes (world mutations), re-attach. Assert: fake backend observed **exactly one login** for the whole run (proves no backend reconnect) and the second attach log shows the post-detach state.
- **T5 keep-alive continuity**: 60 s attach replay under load; assert zero timeouts on either leg and no keep-alive echo with a backend id reaches the backend.

### 7.3 Bounds and latency
- **T6 memory bound**: "chunk flood" scenario (puppet traverses far beyond cache radius). Assert cache size metric stays under cap, proxy RSS under budget (e.g. 128 MB), and evicted chunks are simply absent from the attach log.
- **T7 attach latency**: measure Login → last cached chunk on loopback; assert <2 s at RD 8 equivalent; assert latency is flat when attach happens at t=1 min vs t=60 min (proves boundedness — the falsifier for full replay).

### 7.4 Failure injection
Backend drops one `Set Container Slot` mid-stream (stale-slot risk logged, no crash); backend stalls 5 s mid-replay (drain stays bounded); backend sends `Transfer` during attach; backend re-enters CONFIGURATION during play; random single-frame corruption (proxy must not panic; session must survive via cache fallback).

### 7.5 Golden baseline with the real client (one-off, manual)
Run the scenario once against a real vanilla 26.3 client connected **directly** to the fake backend; save its normalized log + a screenshot. Proxy runs must reproduce it semantically. This converts "vanilla client accepts synthetic join" from assumption to regression test.

### 7.6 The falsifying experiment (smallest end-to-end)
Hardcode a minimal cache (one chunk + one entity + one inventory slot + one player-list entry), synthesize config + play join to the **official vanilla 26.3 client** against a single-chunk fake backend; assert: client leaves "Loading terrain…", renders chunk and entity (screenshot), stays connected 60 s, and a serverbound block-break relays to the backend. Failure here falsifies §3.2 and forces the §3.1 fallback or a ZenithProxy-style bot-viewer.

## 7b. Proven vs speculative

- **Proven (shipping implementations / documented protocol):** mid-session attach via cached config frames + synthesized join + raw chunk cache + world snapshot (ZenithProxy, azalea-reflection-proxy, mineflayer-proxy-inspector — all tested live with vanilla clients); per-connection AES/CFB8 encryption forbidding byte relay; same-account second login kicking the old session; chunk-batch ack pacing; 30 s keep-alive deadline; out-of-state packet = fatal client error; the state-machine sequences and packet fields cited in §2.
- **Extrapolated but unverified here (medium confidence):** the exact memory/latency budgets in §5 (composed from the TAMUctf traffic model and ZenithProxy's <300 MB — both real, but not measured on *our* workload); semantic buffering (§4.2.6) as the bounded-drain mechanism (the prior art queues frames; coalescing is our refinement); applying block-change packets into cached chunk bytes (required by correctness, not demonstrated by any cited project).
- **Speculative (low confidence, needs testing):** Mojang session-server rate limits as a per-attach reconnect cost (§3.3); client tolerance of our exact synthesized packet order in 26.3 (why §7.6 is the first experiment); secure-chat re-signing specifics (ticket 01).

## 8. Handoffs to other tickets

- 01: exact login-flow termination split, secure-chat re-signing details, library choice for frame parsing (affects "cache raw frames" feasibility per language).
- 03: turn §7 into `mise` tasks (unit/integration/smoke layers), metrics for attach latency, cache size, login count.
- 04: attach-token whitelist on the client leg; security of the forged-Login-Success path.
- 05: "attaching screen" UX vs seamless join; single pinned version 26.3/777 as MVP matrix.

## Recommendation (summary)

Adopt **bounded state cache + synthesized join with cached-config replay** (§4). It is the only approach that keeps the puppet's backend session alive across client attach/detach, has bounded memory (tens of MB) and flat attach latency (~1–3 s), and is already proven by three shipping projects. MVP trade-off: world state outside the cache radius is not rendered on attach until the puppet returns there. Preserve the invariant: *the proxy owns the server-side session and never drops it for client lifecycle events; the synthesized join is indistinguishable from a fresh vanilla join on the pinned protocol (26.3/777).* First falsifying experiment: §7.6 (one chunk, one entity, official client, 60 s).

## Sources

- Protocol: [minecraft.wiki Java Edition protocol](https://minecraft.wiki/w/Java_Edition_protocol) + [Packets](https://minecraft.wiki/w/Java_Edition_protocol/Packets) + [Chunk format](https://minecraft.wiki/w/Java_Edition_protocol/Chunk_format); [VoidMC v26.1.2 connection lifecycle](https://voidminecraft.github.io/VoidMC/reference/protocol-specs/v26.1.2/connection-lifecycle.html) (state machine, canonical sequences, 30 s keep-alive, transfer).
- Versions: [Protocol version table](https://minecraft.wiki/w/Protocol_version) (26.3 = 777; 26.2 = 776; 26.1 = 775; 1.21.11 = 774; 1.21.9/10 = 773; 1.21.8 = 772).
- Prior art (proven implementations of mid-session attach): [ZenithProxy](https://github.com/rfresh2/ZenithProxy) (2b2t production proxy/bot, <300 MB, ViaVersion, world cache); [azalea-reflection-proxy](https://crates.io/crates/azalea-reflection-proxy) (join replay: cached config frames + Login/Respawn + Game Event 13 + raw chunk cache + world snapshot; raw-frame relay rationale; keep-alive/teleport-stand-in while controllerless); [mineflayer-reflection-proxy](https://github.com/0xjimmy/mineflayer-reflection-proxy); [IceTank/mineflayer-proxy-inspector](https://github.com/IceTank/mineflayer-proxy-inspector) (world persistence from bot memory, attach/link); [SniffCraft](https://github.com/adepierre/SniffCraft) (MITM proxy, versions 1.8→26.3, online mode, secure chat, transfer).
- Kick/duplicate-login behavior: [PaperMC#5303](https://github.com/PaperMC/Paper/issues/5303), [MC-172541](https://bugs.mojang.com/browse/MC/issues/MC-172541), [CoalHosting explanation](https://coalhosting.com/fix/minecraft-connection-throttled).
- Traffic model: [TAMUctf 2024 SMP writeup](https://ctftime.org/writeup/39089) (chunks 78.6 % of S→C bytes; entity movement ~86 % of packet count).
- Login (play) fields incl. 26.2+ `online_mode`: [rosegold Clientbound::Login](https://rosegoldmc.github.io/rosegold.cr/Rosegold/Clientbound/Login.html), [mc-protocol Login](https://mc-protocol.vercel.app/packets/play/login).

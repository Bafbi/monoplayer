# Audit memo — protocol-correctness-auditor

**Role lens:** Minecraft protocol and data-plane correctness.
**Audited:** `docs/architecture.html` (draft for decision, 2026-11-05), against the four research notes and three council memos in `.scratch/minecraft-puppet-proxy/`.
**Method:** read every cited working note; verified the load-bearing protocol claims against external sources (minecraft.wiki protocol table, rosegold packet source, kojacoord protocol work cross-checked against minecraft.wiki/ViaVersion/Bungee, Velocity source and issues, minecraftdocs.dev chat-and-signing reference, ZenithProxy source on GitHub, decompiled vanilla client source, npm registry for minecraft-protocol / minecraft-data).
**Date:** 2026-11-05.

---

## Verdict

The architecture is **sound**: the login/auth split, forged-puppet-profile Login Success, config replay, synthesized join, entity-ID passthrough, and per-leg keep-alive/teleport ownership are all real, legal protocol moves, and the 26.1/775 pin is coherent and correctly reasoned. The document is also honest about its main uncertainty (will the official client accept the synthesized join — gated on Gate A).

But the data-plane contract **understates the chat problem by a full layer**, and one stated MVP trade-off (block-update → chunk eviction) can deadlock the attach path the product depends on. Three items below will falsify Gate A exactly as written if not corrected; none of them require new research — they are knowable today and are already handled by the prior art the doc cites.

---

## P0 — must fix (the proposal fails as written)

### P0-1. Chat relay: "strip signatures, relay unsigned" is necessary but not sufficient; the `last_seen` acknowledgement window will get the puppet kicked anyway.

- **Claim audited:** relay table — "Chat: Strip signatures. Client signatures are not valid for the puppet's profile. MVP relays unsigned; target `enforce-secure-profile=false`." Plus risk row "Secure chat … strip signatures; re-sign with puppet certs later."
- **What's wrong:** the serverbound `Chat Message` packet carries a `last_seen` acknowledgement window over *that connection's* message history. The client leg and the puppet leg are two different connections with two different message histories. Relaying the client's window verbatim gives the backend acknowledgements of message slots the backend never sent to the puppet. Vanilla's `LastSeenMessagesValidator` treats that as fatal — offset past the pending window, unknown slot, or checksum mismatch all **disconnect the connection** ("Chat message validation failure"; see [minecraftdocs.dev chat-and-signing](https://minecraftdocs.dev/systems/networking/chat-and-signing) validation table and [MC-309298](https://mojira.dev/MC-309298) for the real-world kick). Critically, **`enforce-secure-profile=false` does not disable this validation** — that flag only relaxes the *signature* requirement; the last-seen machinery applies to every chat packet regardless.
- **Second half of the same problem:** the puppet leg is a client the backend sends signed chat to. If the puppet never acknowledges (and it never chats on its own), the backend's pending-ack queue grows and the server disconnects it past 4,096 tracked messages. The proxy must send `Chat Acknowledgement` / valid last-seen updates on the puppet leg itself.
- **Why this is P0 and not P1:** the demo (Gate A: "send a chat message") will kick the puppet on any real vanilla server with other players chatting. The doc's own falsifier lists "kicked on secure-chat/session verification" as a failure mode, but its mitigation ("strip signatures") does not address the actual kick mechanism, so the 2-day gate would burn time rediscovering a problem that Velocity has an entire `ChatState`/delayed-ack subsystem for (see [Velocity commit 077968089eec](https://git.steamwar.de/SteamWar/Velocity/commit/077968089eecb6ce653518a948a2025aad6fbae4): "we cannot predict an up-to-date 'last seen'… therefore, we need to hold back any acknowledgement packets") and that ZenithProxy's chat handlers solve.
- **Required fix in the doc:** specify per-leg chat-state tracking — (a) puppet leg acknowledges backend messages and maintains its own last-seen window; (b) the client's outgoing chat is re-emitted on the puppet leg with a last-seen window rebuilt from the puppet leg's real state (Velocity-style remapping or dummy-window), not the client's; (c) explicit handling for `Chat Acknowledgement` packets in both directions. Or descope chat from the MVP explicitly and say so in the demo script.

### P0-2. Client leg: dropping or reordering clientbound chat breaks the client's global-index chain → client disconnect.

- **Claim audited:** attach step 9 ("Coalesce, don't queue… they are not byte-queued behind the replay") plus research 02 §4.2.6 ("non-state packets (chat, sounds) are dropped-until-attached") and the packet-details note "Chat history is never replayed; message-index sequences break and disconnect the client."
- **What's wrong:** the doc uses the index-chain fact to justify *not replaying* chat, but misses the symmetric obligation: once the client leg is in play, every clientbound `Player Chat Message` carries a `global_index` the client validates as a contiguous per-connection counter ("`ClientPacketListener.handlePlayerChat`, the global index — a server dropping, duplicating or reordering messages beneath the player … → connection", [minecraftdocs.dev](https://minecraftdocs.dev/systems/networking/chat-and-signing)). The same packets carry `MessageSignature.Packed` entries the client resolves against its own signature cache — drop one message and the cache desyncs ("a server naming a cached signature the client has never held → connection").
- **Consequence:** the "semantic buffering" rule ("coalesce, don't queue") is fine for chunks/entities but must carve out chat: from synthesized Login onward, chat frames must be **queued in order and drained in order, zero drops, zero reorders**, or the client will kick itself mid-replay. "Dropped-until-attached" is only safe before the client leg exists.
- **Required fix:** state the carve-out explicitly in the attach sequence and make Gate A's chat step assert no dropped/reordered `player_chat` frames (the golden-log test T1/T2 in research 02 can catch this, but the HTML doc never wires chat into those assertions).

### P0-3. The MVP chunk-eviction cut can deadlock attach: if the evicted chunk is the one under the puppet, the client never leaves "Loading terrain…".

- **Claim audited:** "The MVP evicts a chunk when a block update touches it… A reattaching client may see that area unrendered until the puppet returns." (architecture section; same cut in both council memos).
- **What's wrong:** the client dismisses the loading screen only when the chunk containing its position loads (research 02 §6: "the vanilla client won't leave 'Loading terrain…' until the chunk under its feet loads"). If the puppet's own chunk was evicted while detached (one block update near the puppet), reattach = loading screen forever: the client cannot send movement while on the loading screen, the puppet is inert while detached (no input, no bot AI), and **there is no client→server packet to re-request a specific chunk**. The backend will never resend it. This is not "area unrendered" — it is a permanent deadlock of the core attach path, and the client must disconnect manually.
- **Why this is P0 and not P1:** it is a direct internal contradiction between two claims the doc states as settled (the eviction trade-off and the "chunk under the feet" requirement), and it fires in a realistic scenario (block edit near the puppet during any detach).
- **Required fix:** carve out the chunk(s) under the puppet's current position from eviction (evict everything else), or on attach nudge the puppet leg (e.g., a tiny server-acknowledged move/teleport round-trip) to force the backend to resend the feet chunk, or accept slice-1 palette surgery for exactly those chunks. State whichever is chosen in the doc before Slice 1.

---

## P1 — should fix (under-specified, known-failure risk)

### P1-4. The synthesized-join packet list omits vanilla-required packets the research itself documents.

The attach sequence lists "Login (puppet entity ID), abilities, held slot, commands, player-list adds, border, spawn, time, weather, container contents, health, XP", but research 02 §2.3's canonical post-join sequence (which the doc claims to follow) also includes **`Change Difficulty`**, **`Set Center Chunk`** (required since 1.20.3 for the client's chunk-loading center — without it the client centers chunks on 0,0), and **`Entity Event`s** (op-level display, respawn semantics on some servers), plus recipes/tags "if needed". A synthesized join that skips Set Center Chunk can produce correct-looking tests on loopback and fail with chunk-center artifacts against a real backend. Mirror the research's list verbatim.

### P1-5. The version-bump story misses two 26.2/776+ wire changes that will break the synthesized join on re-pin.

Verified against [rosegold's Login source](https://github.com/RosegoldMC/rosegold.cr/blob/master/src/rosegold/packets/clientbound/login.cr) and [kojacoord's 26.1/26.2 protocol work](https://github.com/KojaCraft/kojacoord/pull/24) (cross-checked against minecraft.wiki and ViaVersion):
- `Login` (play) gains an **`online_mode` boolean** at 26.2/776, inserted between `sea_level` and `enforces_secure_chat`. Correctly noted in research 02 and council D3 ("775 predates it, so synthesis is simpler") — but the doc's recurring-bump plan ("bump minecraft-data, re-run goldens, fix renames and ID shifts") never names this field.
- `Login Success` gains a **`sessionId` UUID** at 26.2/776+. (Note: research 01's "session ID since 1.21.x" is wrong on the version; the field is 776+ per the cross-checked kojacoord patch.)
- 26.x clients treat **entity ID 0 as an unassigned sentinel that crashes the client** during `handleLogin` (kojacoord, "Use a non-zero player entity id"). The design reuses the puppet's real backend entity ID so it is satisfied by construction — but state it as an invariant, because it is exactly the kind of default a synthesized join would otherwise get wrong.
These belong in the "protocol bump" task definition now, not discovered during a 26.3 re-pin.

### P1-6. Cookie handling is under-specified: the replay half is stated, the interception half is the one that fails.

The relay table says "Cookies: Store + replay — per-connection state". Missing: after attach, the backend may send `Cookie Request` (config **and** play) for cookies that were set before this client existed. The proxy must answer those requests from **its own** cookie store and must swallow the attaching client's `Cookie Response`s (an empty response from a fresh client must never reach the backend, whose state is already past it). Research 01 §3 has this right ("Store + replay … needed for transfer continuity and reattach"); the HTML dropped the interception rule.

### P1-7. Resource-pack replay semantics are under-specified, including the failure cases.

"Resource packs: Replay status — client responses are connection-scoped; cached pushes must be replayed on attach." Missing: (a) what happens when the reattaching client **declines or fails to download** a pack the backend already applied to the puppet leg — the backend never re-asks, so the proxy is the only party that can resolve the divergence (synthesize an accepted status? block pack-requiring servers in MVP?); (b) the client sends its own `Select Known Packs` on attach, and the proxy answers from cache — if the backend's originally selected packs are not in this client's known-packs list, the replay is inconsistent. Pick an MVP policy and state it; research 01 flags this as a known stall/kick surface.

### P1-8. Teleport ownership omits `Accept Teleportation`.

"Teleport/position sync: Own IDs … swallows confirms." Since 1.21.2 (present in 26.1/775), the client sends **two** serverbound acknowledgements per teleport: `Confirm Teleportation` and `Accept Teleportation`. The proxy must swallow **both** on the client leg (and emit both on the puppet leg when the backend teleports the puppet). "Swallows confirms" is incomplete as written.

### P1-9. Mid-play re-entry to CONFIGURATION (`Start Configuration`) is undefined in the relay contract.

Vanilla servers send `Start Configuration` mid-play for exactly the use case the doc half-covers (resource-pack push, server links, transfer to config re-negotiation). Research 02 §6 lists it as a failure mode; the delivery memo declares it out of scope — but the HTML relay table's "Configuration: Cache + replay" says nothing about what the proxy does when the *backend* re-enters config while a client is attached. State the MVP rule explicitly (e.g., "absorb on the puppet leg, keep the client in play, re-run the config cache on next attach" or "disconnect the client with a clear reason"), even if the rule is "undefined for MVP".

### P1-10. Gate A's falsifier and the product's chat target contradict each other, and neither is pinned.

Research 01 §8's falsifying experiment says the test backend must have **`enforce-secure-profile` ON** (the hard case), while the product plan targets `enforce-secure-profile=false` (risk table; question 5; council D6). The HTML's Gate A says only "an online-mode backend". Decide and state: Gate A should run the **hard** case (chat must survive on a server that enforces profiles — that is precisely what P0-1's last-seen machinery determines), while the product's first deployment may still target `=false`. Relatedly, the Node stack's ability to establish and **mid-session rotate** the puppet's chat session keypair (certificates ~48 h per research 04 §1) is unverified anywhere in the notes; name it as a Gate A sub-check.

---

## P2 — nice to have (overclaims, wording, documentation)

### P2-11. "Forged Login Success with the puppet's profile — ZenithProxy's exact pattern" is a mis-attribution (the technique itself checks out).

From ZenithProxy's own source ([ProxyServerLoginHandler.java](https://github.com/rfresh2/ZenithProxy/blob/master/src/main/java/com/zenith/network/server/handler/ProxyServerLoginHandler.java)): the controlling player's Login Success carries **their own** `hasJoined` profile (`session.getProfileCache().getProfile()` — the attaching player's UUID is logged), and only the play `Login` packet reuses the bot's entity ID. ZenithProxy does not present the bot's profile to the player. The Monoplayer plan (forge the puppet's profile) is nonetheless **protocol-legal and workable**: the vanilla client performs no session-vs-Login-Success profile validation — offline-mode servers rely on sending a UUID that differs from the session UUID every day, and the decompiled client passes the received profile straight through to the play-phase listener (e.g., 1.16.4 `ClientHandshakePacketListenerImpl.handleGameProfile` sets `localGameProfile` from the packet and hands it to `ClientPacketListener`; modern versions follow the same pattern). So: keep the design, drop the "ZenithProxy's exact pattern" attribution (or cite it only for the entity-ID reuse), and add the cosmetic caveat that chat signing, reporting, and social-screens still use the client's session identity while the rendered profile is the puppet's.

### P2-12. "Known packs" appears in the replayable-config list, but `Select Known Packs` is serverbound.

The attach step "Replay cached configuration … known packs …" is directionally wrong: the client sends its known-packs list; the proxy must answer it from cache (which packs the backend originally selected). Wording fix, but it is the kind of wording that produces a broken implementation.

### P2-13. The whitelist gate should cross-check Login Start against the `hasJoined` result.

Council D4 already requires this ("cross-check Login Start name/UUID against the hasJoined response; gate on the authoritative hasJoined UUID"). The HTML doc only says "calls hasJoined … if that UUID is not in the whitelist, close". Add the cross-check sentence — a mismatched Login Start name is the classic gap between "gate on UUID" and "gate on identity".

### P2-14. "The puppet is inert when nobody is attached" collides with AFK-kick plugins.

The doc presents the puppet's detach survival as passive (answer keep-alives, confirm teleports) and states the puppet "does not play by itself". On any server with an idle/AFK kicker (common even on "own servers" via plugins), the detached puppet will be kicked — which cascades into the pod's RECONNECTING path and, per the doc's own kill criteria ("puppet median lifetime < 24 h from proxy-caused drops"), can kill the project. Not a protocol bug, but the doc's risks section should name it: either disable AFK kicks on the target server or accept session death as the residual risk.

### P2-15. Minor claim calibrations (verified, worth keeping but phrased loosely):

- "Chunk batches are one in flight at a time" — accurate as vanilla-server behavior (the server waits for `Chunk Batch Received` before the next batch), not a hard protocol limit. Fine as a design rule.
- "Boss bars … or the client can kick on an unknown UUID" — **verified accurate** (Velocity issue #1529: unknown-boss-bar update NPEs the client into "Network Protocol Error" since 1.20.2/1.20.5; fixed in Velocity commit 4cd3b68 "Fix players disconnecting when updating boss bars").
- "Keep-alive is a 30-second deadline" — correct (server drops a client that doesn't answer within 30 s; the client read-times-out the same way).
- "Game Event 13 … without it the client stays on 'Loading terrain…'" — correct.
- "Teleport IDs are per-connection" — correct.
- "Entity IDs pass through; the puppet's entity ID is reused so serverbound packets stay valid" — correct for a single controlling client (serverbound movement carries no entity ID; clientbound packets referencing the player entity stay consistent; `Interact` targets other entities, which also pass through).
- Front-leg design is correct: **encryption is mandatory** on the client leg, not optional — the shared secret from the encrypted handshake is the input to the `hasJoined` serverId hash; without it there is no identity proof. (Council D4's correction of research 02 §2.1's "encryption optional" is right; the HTML follows it.)

### P2-16. Version and library claims verified correct (no action, recorded for the record):

- 26.1 = protocol 775 (2026-03-24; 26.1.1/26.1.2 also 775), 26.2 = 776 (2026-06-16), 26.3 = 777 (2026-09-15, "Wilderness Bound") — matches minecraft.wiki's protocol table.
- `minecraft-data@3.119.0` (latest on npm) ships pc protocol data through **26.1 only** (no 26.2/26.3 entries) — "Node library support ≤ 26.1/775; 26.3 in flight" is accurate as of 2026-11-05, and the 26.1/775 MVP pin is the right call.
- `minecraft-protocol@1.68.0` is current on npm (matches research 03).
- The `online_mode` Login field being 26.2/776+ (not earlier) is verified; council D3's "protocol 775 predates it" simplification is therefore correct.

---

## What this audit could not verify

Field-level details of protocol 775/776/777 beyond the points above (packet ID tables, registry contents of 26.x config phases) rest on the cited sources' accuracy (minecraft.wiki, rosegold, VoidMC, kojacoord) rather than first-hand decoding; the packet-ID *stability across minor releases* claim (research 02's rosegold citation covers 772–776 only, not 777) should be re-checked at the first 26.3 bump. The client's tolerance of the exact synthesized packet *order* on 775 remains unproven — correctly gated on Gate A, and P1-4/P0-2 above are the most likely falsifiers.

## Bottom line

Fix P0-1 through P0-3 in the document before Gate A: specify last-seen window rewriting and puppet-leg chat acks, make clientbound chat order-preserving from Login onward, and carve the feet chunk out of eviction. Everything else the proposal claims about the protocol — the login split, the forged profile, config replay, Game Event 13, chunk batching, teleport/keep-alive ownership, entity IDs, and the 26.1/775 pin — checks out against the cited sources and the wire format.

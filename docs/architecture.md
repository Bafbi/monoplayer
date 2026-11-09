# Monoplayer

*Architecture proposal · draft for decision*

A headless Minecraft account that stays online, and a whitelisted official
client that can attach to it and play normally. This document records what the
research proved, the architecture the council recommends, and the smallest
test that kills the idea if it is wrong.

- Audited draft for decision
- Semantic MITM
- Node + minecraft-protocol
- Pinned 26.1 / 775
- Council confidence 78–80 / 100

Prepared 5 November 2026 · Research: 4 delegates · Decision council: 3
delegates · Audit: 3 delegates · Status: proposed, not built

## Executive summary

**Build the proven architecture, not a raw packet pipe**

The idea is feasible. The core feature already ships in **ZenithProxy**, a
production Minecraft bot proxy that lets whitelisted players log in and
control the bot. The correct shape is a **stateful semantic MITM**: the
service terminates the client login, verifies the client with Mojang, holds
the puppet's backend session, caches the world state, and synthesizes a fresh
join when a client attaches.

| Aspect | Decision | Note |
| --- | --- | --- |
| Approach | Semantic MITM | Two legs, one cache, one live session |
| Stack | Node/TS | minecraft-protocol + prismarine-auth |
| Time to demo | ~3 weeks | 2-day gate, then a two-week slice |
| Kill switch | Gate A | Official client, real attach, 60 s |

> **The one-sentence recommendation**
>
> Run one Node pod that owns a Microsoft-authenticated puppet connection to
> your backend, accepts your official client through an online-mode front leg
> with a UUID whitelist, replays the cached configuration and a synthesized
> join into the live session, and relays play packets with targeted rewrites —
> never dropping the puppet when the client leaves.

> **The honest caveat**
>
> The architecture is proven, but not in Node. The production proof is Java
> (ZenithProxy, AGPL-3.0). The Node implementation is the fast, license-clean
> path, but it is still an implementation bet. That is why the plan starts
> with a two-day falsifying experiment using a real official client, before
> product code.

## The short answer

**What Monoplayer is, precisely**

Monoplayer is a **client-side proxy with a headless account**. It is not a
Minecraft server, and it is not a server-side Velocity/Gate proxy. It sits
between an official client and a real backend:

Official client → Monoplayer front leg → Relay + state cache → Puppet leg →
Real backend

The **puppet** is an official Microsoft account logged in headlessly by the
service. It is the account the backend sees. The **attaching client** is
another official account, whitelisted by UUID, that proves its identity to
Monoplayer and then controls the puppet's body. The client never logs into the
backend as the puppet; that would kick the puppet's session.

The service is **stateful**. The backend TCP session, the world cache, and the
puppet's position live in one pod. That is what lets the puppet stay in the
world when the client disconnects. It is also the main operational constraint:
a pod restart loses the live session and requires a reconnect.

### What it is

- A headless official-account client that stays online.
- A packet-aware relay that lets a whitelisted official client take control.
- A bounded state cache that makes late attach look like a fresh vanilla join.
- A small Kubernetes service with a fast fake-backend test loop.

### What it is not

- A raw byte pipe. Encryption and compression are per-connection.
- A server-side routing proxy like Deepmine Gate.
- A bot that plays by itself. The puppet is inert when nobody is attached.
- A way to share an account with the public or bypass server rules.

## Prior art

**The pattern is proven. The Node implementation is not.**

The research found the same pattern in production, plus adjacent
implementations. That changes the risk profile: the question is not “can this
work?”, but “which implementation and scope do we choose?”

| Project | What it proves | Why it is not the default |
| --- | --- | --- |
| **ZenithProxy**<br>AGPL-3.0 | Production 2b2t bot that players log into and control. Secure whitelist via `hasJoined`, spectator mode, persistence, Microsoft device-code auth, ViaVersion, <300 MB, GraalVM native. | Java + AGPL + 2b2t-specific scope (Baritone, queue handling, Discord). It is the behavioral spec and the fallback deployment, not the build target. It presents the attaching player's own profile; Monoplayer's puppet-profile presentation is a deliberate addition, not a claim about ZenithProxy. |
| **Pork2b2tBot**<br>MIT + attribution | Earlier existence proof of the same “bot that also works as a proxy” pattern. | Frozen development, behind on protocol versions. |
| **azalea-reflection-proxy**<br>Rust / open source | Cached config frames, synthesized FinishConfiguration/Login, Game Event 13, raw chunk cache, world snapshot. Documents why byte forwarding is impossible. | Reference for the attach sequence, not a Node library or a product. |
| **mineflayer-reflection-proxy**<br>JS | World persistence from bot memory and attach/link behavior in the Prismarine ecosystem. | Inspection-oriented; not a full Minecraft proxy with production auth and cache. |

> **What the prior art settles**
>
> - The front leg must terminate encryption with its own RSA key and call
>   Mojang `hasJoined`.
> - The back leg must authenticate as the puppet with Microsoft device-code
>   auth.
> - The configuration phase must be cached and replayed; it cannot be
>   forwarded to a late client.
> - Play packets can be relayed 1:1 only while attached, same version, with
>   targeted rewrites.
> - The backend session must be owned by the proxy, not the client.

> **One deliberate difference from ZenithProxy**
>
> ZenithProxy lets the attaching player keep their own rendered profile.
> Monoplayer's design presents the *puppet's* profile to the attaching client
> so the client sees the puppet's name and skin. This is protocol-legal —
> vanilla does not validate Login Success against the client's session profile
> — but it is not the exact ZenithProxy behavior. The profile is a rendering
> choice: the backend session is always the puppet, while chat signatures are
> made by the attaching client and must be stripped or re-signed. Client-side
> reporting is outside the relay and is not remapped.

## Architecture

**Two legs, one cache, one live session**

The service is a single process with two protocol endpoints and a shared state
cache. The front leg is a Minecraft server to the attaching client. The back
leg is a Minecraft client to the backend. The relay never passes encrypted
bytes between them.

*The front leg is a server to the client; the back leg is a client to the
backend. The relay decodes, re-frames, and rewrites; it never forwards
encrypted bytes.*

### The front leg (client → Monoplayer)

The front leg uses `minecraft-protocol`'s server half with `online-mode: true`
and encryption enabled. The proxy generates its own RSA keypair, completes the
standard Minecraft login, and calls Mojang's `hasJoined` endpoint. The
returned profile is the *attaching player's* identity. If that UUID is not in
the whitelist, the connection is closed during login, before any packet is
relayed.

After the whitelist gate, the proxy sends **Login Success with the puppet's
profile** (UUID, name, skin properties). The client believes it is joining as
the puppet. This is the subtle part: the client's own account is used only to
prove permission to attach; the backend never sees it.

### The back leg (Monoplayer → backend)

The back leg is a long-lived `createClient` connection authenticated with the
puppet's Microsoft account. It is established when the pod starts and is owned
by the pod, not by any client. It answers the backend's keep-alives and
teleport confirms while detached, so the server does not time the session out.

The backend must already whitelist the puppet account, if the server uses a
whitelist. That is separate from Monoplayer's own attach whitelist: the
backend whitelist says “the puppet may join”; the Monoplayer whitelist says
“these clients may control the puppet.”

### The state cache

The cache is the product. A late-attaching client has never seen the backend's
login or configuration phase, so the proxy must reconstruct a valid current
view. The cache is deliberately bounded:

| Domain | What is cached | Bound / approach |
| --- | --- | --- |
| Configuration | Registry data, tags, feature flags, brand, resource-pack push, cookies, finish-configuration frames | Raw frames; deterministic replay; tens of KB |
| Chunks | Raw `Level Chunk With Light` frames, including light | LRU around the puppet's view radius; tens of MB |
| Entities | Full metadata, equipment, passengers, attributes, absolute pose | Entity registry; relative deltas accumulated |
| Inventory | Container contents per window, cursor, open screen | Snapshot per window; slot deltas applied |
| Player list | UUID, name, properties, game mode, latency, display name, list order | Full snapshot; add/remove/update actions |
| Scoreboard / boss bars | Objectives, scores, teams, boss-bar state | Per-objective / per-UUID maps |
| World/HUD | Time, weather, border, health, XP, held slot, abilities, difficulty | Last absolute values |

> **MVP cache trade-off**
>
> Applying block updates into cached chunk bytes is the hairiest component and
> is not demonstrated by the cited projects. The MVP **evicts** a chunk when a
> block update touches it, rather than patching its palette — **except the
> chunk under the puppet and its cardinal neighbours**, which are pinned. If a
> pinned chunk is mutated, the proxy patches it or forces a backend resend
> before attach (a small, server-acknowledged puppet nudge). Without this
> exception, a single block edit near the puppet could leave the client stuck
> on “Loading terrain…” forever. Other mutated chunks may be unrendered until
> the puppet returns; general block-update patching is slice 2.

## Session lifecycle

**The puppet outlives the client**

The service has two independent state machines: the backend session and the
client attachment. Client attach/detach changes only the client leg. A backend
drop is a session event; a pod restart is a service event.

| State | What it means |
| --- | --- |
| `BOOTSTRAPPING` | Load the token and the config. |
| `AUTHENTICATING` | Device code, then token refresh. |
| `CONNECTED_UNATTACHED` | Puppet in the world, cache live. |
| `ATTACHING` | Replay the config, synthesize the join. |
| `ATTACHED` | Play relay, live control. |
| `DETACHING` | Client leg closes only. |
| `RECONNECTING` | Backend drop or pod restart. |

Allowed moves: `BOOTSTRAPPING → AUTHENTICATING → CONNECTED_UNATTACHED →
ATTACHING → ATTACHED`, `ATTACHED → DETACHING → CONNECTED_UNATTACHED`,
`ATTACHING → DETACHING` when the attach fails, and `CONNECTED_UNATTACHED →
RECONNECTING → CONNECTED_UNATTACHED` on a backend drop. DETACHING returns to
CONNECTED_UNATTACHED, never to the backend. RECONNECTING is the only path that
re-establishes the puppet session.

| Event | What happens | What survives |
| --- | --- | --- |
| Client disconnects | Client leg closes. Proxy keeps answering backend keep-alives and teleport confirms. Cache keeps updating. | Puppet session, position, inventory, world state. |
| Client reattaches | Fresh vanilla join into the live session: config replay, synthesized join, chunk/entity burst, live cutover. | Everything the cache holds; ~1–3 s attach. |
| Backend drops the puppet | Transition to RECONNECTING; exponential backoff; re-auth if needed; cache reset. If a client is attached, disconnect it with a clear reason; it may reattach once RECONNECTING completes. | Service and token cache; backend world state depends on the server. |
| Pod restarts | Same as backend drop: re-establish the puppet session. No live TCP session survives. | Token Secret, config, whitelist; not the live session. |
| Second pod starts | Forbidden. Two pods race the rolling refresh token and kick each other's sessions. | Nothing; this is the critical operational invariant. |

> **Reconnect policy**
>
> The service never exits because nobody is attached. If the backend drops the
> puppet, it reconnects immediately with exponential backoff; a player
> connection is not required to trigger it. A lazy “wait for a player” mode is
> possible later, but it risks queue position and is not in the MVP.

> **Hard invariant**
>
> **Exactly one Monoplayer pod may own a puppet at a time.** The Microsoft
> refresh token is rolling and single-use; a second replica can invalidate it
> and trigger “logged in from another location” kicks. Use `replicas: 1`,
> `strategy: Recreate`, no HPA, and an alert if the pod count ever exceeds
> one. This is discipline, not a cluster mechanism: nothing in Kubernetes
> prevents a second Deployment or a manual scale-up. A future admission guard
> or leader lock is the mechanical fix if the service graduates.

## Late attach

**A fresh vanilla join into a session that never ended**

The client cannot resume a session it never had. The honest UX is a normal
“Loading terrain…” join, typically 1–3 seconds, landing exactly where the
puppet is. This is what ZenithProxy ships; it is not a custom attach screen.

### Attach sequence

1. **Terminate login.** Online-mode handshake, `hasJoined`, UUID whitelist.
   Cross-check Login Start against the `hasJoined` result; deny before relay
   if not allowed.
2. **Forge Login Success** with the puppet's profile: UUID, name, skin
   properties. This is protocol-legal, but it is Monoplayer's choice, not
   ZenithProxy's behavior.
3. **Replay cached configuration.** Brand, enabled features, registry data,
   tags, resource-pack state, cookies, finish configuration. Answer the
   client's *Select Known Packs* from cache, not by replaying the client's
   selection. Raw frames, deterministic order.
4. **Synthesize the play join.** Login (puppet entity ID),
   `Change Difficulty`, abilities, held slot, commands, player-list adds,
   border, spawn, time, weather, container contents, health, XP, recipes/tags
   where required, entity events.
5. **Send Game Event 13** (“start waiting for level chunks”). Without it the
   client stays on “Loading terrain…”.
6. **Synchronize position** to the puppet's exact pose with a proxy-owned
   teleport ID; swallow both `Confirm Teleportation` and
   `Accept Teleportation` from the client.
7. **Set the chunk center** and send chunks in fresh
   `Chunk Batch Start`/`Finished` pairs, full radius around the puppet, paced
   on the client's `Chunk Batch Received` acknowledgements.
8. **Spawn entities** with full metadata, equipment, passengers, and boss bars
   synthesized as *Add* first. Then live cutover.
9. **Coalesce state, but queue chat.** During the replay, live backend state
   frames update the cache semantically (absolute poses, metadata patches,
   chunk evictions); they are not byte-queued. Clientbound chat is the
   exception: from synthesized Login onward, chat frames must be delivered in
   order with zero drops or reorders, or the client's global-index chain
   breaks.

> **Chat is a stretch goal, not core control**
>
> “Strip signatures” is necessary but **not sufficient**. Serverbound chat
> also carries a `last_seen` acknowledgement window tied to that connection's
> message history. The client's window is not the puppet's window, and vanilla
> disconnects on a bad window even when `enforce-secure-profile=false`. The
> backend also expects the puppet leg to acknowledge messages it receives. A
> correct implementation needs a per-leg chat state machine: the puppet leg
> acknowledges and maintains its own window; client chat is re-emitted with
> the puppet's window, never the client's; clientbound chat is ordered and
> lossless.
>
> **MVP decision:** movement, blocks, inventory, and interaction are the core
> demo. Chat is **read-only or blocked** unless Gate A proves the per-leg
> state machine. Re-signing with the puppet's certificates is slice 2. This is
> a smaller promise than “normal chat,” and it avoids a known kick.

### Why not full replay?

Chunks are about 79% of server-to-client bytes and entity deltas about 86% of
packet count. A long session would mean gigabytes and minutes of replay. The
bounded cache keeps memory in tens of MB and attach latency flat with session
age.

### Why not reconnect on attach?

Reconnecting as the puppet resets position, inventory, and effects, and on
queue servers it can mean hours. It also races “logged in from another
location.” It is a failure-recovery path, not the normal attach path.

## Relay rules

**What is forwarded, what is rewritten**

“Forward all packets when it can” is the right instinct, but the exceptions
are where the bugs live. This table is the data-plane contract.

| Traffic | Rule | Why |
| --- | --- | --- |
| Handshake / login | Terminate per leg | Per-connection encryption and `hasJoined`; never forwardable. |
| Configuration | Cache + replay | Arrives before any late client exists; registries and tags are required. |
| Play, clientbound | Relay | Same version and phase; re-frame compression/encryption only. |
| Play, serverbound | Relay | Movement, dig, place, interact. Exactly one position loop reaches the backend. |
| Keep-alive | Rewrite / own | Proxy answers backend while detached; owns its own cadence to the client; IDs never bridge. |
| Teleport / position sync | Own IDs | Proxy confirms backend teleports on the puppet leg; issues its own IDs to the client and swallows both `Confirm Teleportation` and `Accept Teleportation`. |
| Chat | Per-leg state machine | Client signatures are invalid for the puppet's profile, and the `last_seen` window is per-connection. Puppet leg acknowledges backend messages and maintains its own window; the human's text is re-signed and sent with the puppet's window; clientbound chat is ordered and lossless. Since #19 the speaking path exists as `chat: 'full'` and speaks as the puppet. The default stays `read-only` until a live run proves the secure-profile path on the deployed backend, which is the Gate A line below. `enforce-secure-profile=false` removes signatures, not last-seen validation. |
| Cookies | Store + replay | Answer backend `Cookie Request` from cache and swallow the attaching client's `Cookie Response`; a fresh client's empty response must never reach the backend. |
| Transfer | Absorb / reconnect | Rewrite target to the proxy or block and reconnect the puppet; never send the client elsewhere. |
| Start Configuration | Not in slice 1 | If the backend re-enters configuration mid-play, disconnect the client with a clear reason and re-attach after the puppet finishes; state this as an explicit non-goal rather than a silent desync. |
| Entity IDs | Pass through | Single controlling client; the puppet's entity ID is reused so serverbound packets stay valid. Never synthesize entity ID 0 on 26.x. |
| Resource packs | Replay status | Client responses are connection-scoped; cached pushes must be replayed on attach. MVP targets servers with no *required* pack: a required pack that the reattaching client declines is a refusal, not a fake acceptance. |
| Tab list / scoreboard / boss bars | Snapshot + replay | State is absolute per client; synthesize before live deltas. |

### Packet-level details worth pinning before implementation

- **Login Success** must carry the puppet's profile, not the attaching
  client's. The client's own identity is only the whitelist proof. Vanilla
  does not validate the profile against the session profile, so this is legal,
  but it is a Monoplayer choice.
- **Game Event 13** (“start waiting for level chunks”) is mandatory after
  Login or the client never leaves the loading screen.
- **Set Center Chunk** is required so the client centers its chunk view on the
  puppet, not on 0,0.
- **Chunk batches** are one in flight at a time in vanilla behavior; the
  client acknowledges each batch. Do not blast all chunks without pacing.
- **Boss bars** must be synthesized as Add before any live Update, or the
  client can kick on an unknown UUID.
- **Chat history** is never replayed. From synthesized Login onward, live
  clientbound chat must be delivered in order with zero drops: the client
  validates a contiguous `global_index` and its signature cache.
- **Chat acknowledgements** are per-connection. The puppet leg must
  acknowledge backend messages; the client's `last_seen` window must never be
  forwarded verbatim.
- **Teleport IDs** are per-connection. Backend IDs must not leak to the
  client, and both client acknowledgements must not reach the backend.
- **Keep-alive** is a 30-second deadline. The proxy must answer both legs
  independently, even during a long attach replay.
- **Cookie requests** can arrive in play, not only configuration. Answer from
  the proxy's cache; never let a fresh client's empty cookie response reach
  the backend.
- **Pinned chunks**: never evict the chunk under the puppet or its cardinal
  neighbours without a patch or a forced backend resend; otherwise attach can
  deadlock on “Loading terrain…”.
- **Protocol bump fields**: 26.2/776 adds `online_mode` to play Login and
  `sessionId` to Login Success. 26.x treats entity ID 0 as an unassigned
  sentinel. The 26.1 pin avoids them; the bump task must handle them.

## Auth & security

**The refresh token is the password**

The puppet's Microsoft login uses the device-code flow. The resulting refresh
token is rolling, single-use, and valid for up to 90 days of inactivity. It
bypasses 2FA for its lifetime. Treat it as the account password.

### Puppet login

| Term | Detail |
| --- | --- |
| Flow | Microsoft device code, `consumers` tenant, `XboxLive.signin offline_access`. |
| Client ID | Public launcher ID `00000000402b5328` for the MVP. A custom Azure app needs Mojang review. |
| Token lifetime | Minecraft access token ~24 h; refresh token rolling, 90-day max inactivity. |
| Storage | Namespaced Kubernetes Secret, untracked by ArgoCD, RBAC-scoped. **Encryption at rest is TBD**: Talos does not encrypt Secrets at rest by default. Verify the setting before storing the token, or use an external secret store. |
| Write-back | The pod must persist each refreshed token; otherwise a restart loses the chain. Mount the Secret read-only, keep the live cache in an `emptyDir`, and patch exactly `monoplayer-puppet-auth` through the Kubernetes API with a scoped ServiceAccount. |

### Client attach

| Term | Detail |
| --- | --- |
| Proof | Online-mode `hasJoined` returns a Mojang-issued UUID. No credentials reach the proxy. |
| Whitelist | UUIDs, never usernames. Reloadable without restarting the pod. |
| Second factor | Optional single-use attach token, bound to UUID and 60 s TTL. Deferred; Tailscale ACL is the outer ring. |
| Deny | Close during login, before Login Success and before any relay. |
| Display | Client sees the puppet's profile after Login Success. This is rendering only: the backend session is the puppet, chat is stripped or re-signed by the proxy, and client-side reporting is not remapped. |

### Three layers of identity

| Layer | Whose identity wins? | What the backend sees |
| --- | --- | --- |
| **Transport / session** | Puppet | The puppet's TCP connection, UUID, entity, inventory, position, block edits, and interactions. |
| **Client rendering** | Puppet | Nothing. Login Success gives the client the puppet's profile so the HUD shows the puppet's name and skin. |
| **Chat signatures** | Attaching client's keys | An invalid signature for the puppet if forwarded verbatim. The proxy must strip or re-sign; it cannot pass it through. |
| **Reporting / social UI** | Attaching client | Nothing. This is client-to-Mojang, outside the packet relay; Monoplayer cannot make it puppet without modifying the client. |

> **Short answer**
>
> **Yes for gameplay:** every action the proxy relays reaches the backend on
> the puppet's connection and is attributed to the puppet. **No for
> client-side cryptography:** chat is signed by the attaching client, so the
> proxy must strip or re-sign it. Reporting stays the client's identity and is
> out of scope.

> **Non-negotiables**
>
> - **One pod.** Two replicas break the rolling refresh token and kick each
>   other.
> - **No tokens in git, logs, traces, or images.** Redact at the logger and
>   OTel exporter.
> - **No public ingress.** Tailscale-only data plane; default-deny ingress and
>   egress.
> - **Owner-operated only.** No selling attach slots, no third-party accounts,
>   no anti-cheat evasion.
> - **Your own backend, or explicit permission.** Public servers and
>   anti-cheat are the immediate risk.
> - **No required resource pack.** A client that declines a pack the backend
>   already applied cannot be silently faked into acceptance.

### Legal / acceptable-use position

The Microsoft Services Agreement forbids transferring account credentials and
makes the owner responsible for all activity. The Minecraft EULA forbids
unfair or unreasonable access distribution but permits tools and plugins. An
owner-operated, single-account, no-automation proxy stays in the gray zone;
enforcement risk is real but unquantified. The clear red lines are handing the
account to others, selling access, running other people's puppets, and evading
server anti-cheat. The MVP must target only your own server or one that
explicitly permits it.

## Version strategy

**Pin one version. Do not chase Mojang quarterly.**

Packet IDs shift every minor release. A proxy that supports “any version” is a
translation project, not an MVP. The first slice pins the client, the proxy,
and the backend to the same protocol.

| Item | Value | Note |
| --- | --- | --- |
| Latest release | 26.3 / 777 | As researched on 2026-11-05 |
| Node library support | ≤ 26.1 / 775 | minecraft-data; 26.3 in flight |
| MVP target | 26.1 / 775 | Both legs and the backend |

This is deliberately one release behind. The library's version support is the
constraint, and a pinned backend makes it an ops decision, not a product risk.
If your backend is fixed at 26.3, the options are: insert ViaProxy as a
translation front (GPL-3.0, extra moving part), or use the Java/MCProtocolLib
path (faster protocol currency). The architecture does not change; the
substrate does.

> **Operational rule**
>
> A protocol bump is a scheduled maintenance task, not a surprise. Budget
> 0.5–2 days per quarter: bump `minecraft-data`, re-run the golden packet
> logs, fix renames and ID shifts, re-pin the backend. If two consecutive
> bumps exceed four days, that is a signal to move to MCProtocolLib or accept
> a ViaProxy front.
>
> Two known bump hazards: 26.2/776 adds `online_mode` to the play Login packet
> and `sessionId` to Login Success; 26.x clients treat entity ID 0 as an
> unassigned sentinel. The 26.1 pin avoids both, but the bump checklist must
> name them.

## Validation loop

**Prove the risky thing first**

The plan starts with a two-day experiment that can kill the Node
implementation, then a two-week vertical slice. Both live inside the same fast
local loop: fake backend, fake client, and no *puppet* Microsoft account until
the final smoke. The attaching client is still a real official client, and the
front-leg `hasJoined` can be stubbed for protocol tests.

### Gate A — the 2-day falsifier

This is the smallest test that proves an official client can attach to and
drive the puppet's live session. It is throwaway code, not product code.

1. **Use a fake backend with a local `hasJoined` stub for the go/no-go.** A
   real online-mode backend is optional if you already have the puppet secret;
   the gate must not depend on it.
2. Run a minimal Node proxy: online-mode front leg, injected puppet login,
   cached config, synthesized join, play relay, keep-alive responder.
3. Attach a real official client. Walk 100 blocks, break and place a block.
   Run chat as a *separate* sub-test: first with
   `enforce-secure-profile=false`, then with `true` if cheap.
4. Disconnect the client. Confirm with an observer bot or server console that
   the puppet stayed in world for at least 5 minutes.
5. Reattach. Confirm the client lands on the current state, not a stale
   snapshot.

**Falsified if:** the client cannot attach, movement desyncs within the first
minute, or reattach is stuck on “Loading terrain…”. If that happens, the pivot
is the Java/ZenithProxy path, not more Node code.

**Chat failure is a descope signal, not a substrate failure.** If the per-leg
chat state machine fails, proceed with read-only/blocked chat; do not kill the
build on `enforce-secure-profile=true` alone.

> **Protocol-level Gate A status**
>
> A loopback harness now passes 37/37 assertions: two-leg relay, synthesized
> play join, current-pose reconstruction, a 5-second attach/detach liveness
> soak, per-leg keep-alive/teleport/chunk-ack ownership, exactly one backend
> login, and chat blocked in both directions. See
> [docs/protocol-spike.md](protocol-spike.md) and
> [`testdata/spike-verdict.md`](../testdata/spike-verdict.md). This is **not** the official-client gate:
> encryption, vanilla rendering, online-mode `hasJoined`, Microsoft auth,
> secure-chat re-signing, config-phase replay, and the full 5-minute detach
> window remain unproven. The research, council, and audit trail lives in
> `.scratch/`, local only and never in git. The driver-lane plan is
> [docs/driver-lane-plan.md](driver-lane-plan.md).

### Auth gate — the half-day lifeline

The refresh-token write-back loop is a Critical risk and cannot wait for a
90-day surprise. Run this before the live demo:

1. Device-code bootstrap with the public launcher client ID; record the
   profile UUID.
2. Confirm Java ownership via `/entitlements/mcstore`.
3. Start the pod, let it refresh, then restart the pod. It must refresh
   silently, without a new device code, and the replacement token must persist
   in the Secret.
4. Run `mise run auth:status`; it should report token age and last refresh
   from the Secret timestamp, even if the pod is down.
5. Verify the backend's `prevent-proxy-connections` path sees the same egress
   IP for `/join` and the TCP connection.

### Test layers

| Layer | What it proves | Cost |
| --- | --- | --- |
| **L1 — unit** | Frame re-framing, cache models, whitelist policy, keep-alive demux, auth wrapper with a fake provider. | Milliseconds–seconds; no network. |
| **L2 — integration** | In-process fake backend + service + fake client: encrypted join, attach, control, detach survival, reattach with current state. | Seconds; localhost only. |
| **L3 — cluster** | Real image in `monoplayer-dev` with a fake backend and a one-shot fake client. Catches image and environment regressions. | Minutes; no Mojang. |
| **L4 — telemetry** | L3 plus assertions that attach/disconnect counters and traces reach OpenObserve. | Minutes; no Mojang. |
| **Live smoke** | Real Microsoft account, real backend, official client, plus the auth gate's restart/refresh check. The only test that needs the puppet secret. | Manual; final gate. |

### The five L2 invariants

1. Puppet joins the backend with encryption active.
2. Client attaches and receives live backend frames.
3. Client movement reaches the backend as the puppet, exactly once.
4. Client disconnect leaves the puppet connected.
5. A second attach receives current state, not a stale replay.

### Deterministic fixtures

- Fake backend: scripted config, chunks, entities, chat, keep-alives, block
  edits.
- Fake client: offline UUID, canned movement, records every frame.
- Auth seam: inject a fake session provider; only the auth gate and live smoke
  touch Microsoft.
- Golden sessions: normalized frames under `testdata/sessions/`.

## Observability

**Make the session explain itself**

The service lives or dies by session state. Logs, metrics, and traces should
answer four questions without attaching a debugger: who is attached, what the
puppet is doing, where the latency is, and why a session dropped.

| Signal | Type | Why it matters |
| --- | --- | --- |
| `monoplayer_attach_total{result,client_uuid}` | counter | Who tried to attach and whether the whitelist admitted them. |
| `monoplayer_attach_duration_seconds` | histogram | Login → last cached chunk. Target <2 s at RD 8; flat with session age. |
| `monoplayer_puppet_state{state}` | gauge | Handshaking / login / config / play / reconnecting. |
| `monoplayer_backend_login_count` | gauge | Must be exactly one for the current puppet session. A second login is a bug; a counter cannot express this. |
| `monoplayer_attached` | gauge | 0 or 1. The single-attach invariant. |
| `monoplayer_attach_rejected_total{reason}` | counter | Whitelist, handshake, rate-limit, sessionserver failure. Makes attach failures diagnosable. |
| `monoplayer_packets_total{leg,direction,packet}` | counter | Traffic shape and unexpected packet classes. |
| `monoplayer_cache_bytes{kind}` | gauge | Chunk/entity/inventory cache bounds; alert on growth. |
| `monoplayer_keepalive_rtt_seconds{leg}` | histogram | Backend and client health; 30 s deadline. |
| `monoplayer_disconnect_total{leg,reason}` | counter | Client quit, backend kick, timeout, auth failure. |
| `monoplayer_out_of_state_packet_total` | counter | Must be zero; an out-of-state frame is fatal by design. |
| `monoplayer_auth_refresh_total{result}` | counter | Refresh success/failure; the account's lifeline. |
| `monoplayer_refresh_token_age_days` | gauge | Emitted by `mise run auth:status` from the Secret timestamp, not by the pod: a dead pod cannot alert on its own token. Alert at 60 days. |
| Deployment replica count | gauge | From kube-state-metrics; alert if available replicas ≠ 1. The single-pod invariant needs an external check. |

Traces: one span per attach with child spans for login, config replay, join
synthesis, chunk burst, and live cutover; one span per auth refresh; one span
per backend reconnect. Logs: structured JSON with session ID, puppet UUID (not
display name), attach UUID, packet class, and disconnect reason. Never log
tokens.

## Deployment

**One namespace, one pod, the proven homelab loop**

The deployment is deliberately boring. It reuses the Deepmine homelab
patterns: mise tasks, in-cluster BuildKit, zot, a single namespace, Tailscale
exposure, and OTLP to the shared OpenObserve stack.

### Cluster topology

| Term | Detail |
| --- | --- |
| Namespace | `monoplayer-dev` |
| Workload | Deployment, `replicas: 1`, `strategy: Recreate`, no HPA |
| Service | TCP 25565, `loadBalancerClass: tailscale` |
| Network | default-deny ingress (own ns + tailscale); egress allowlist to DNS, Microsoft/Mojang hosts, backend, registry, OTel, K8s API. **Egress default-deny is new work**: Cilium FQDN rules plus DNS scoping, not a copy-paste of the ingress-only homelab pattern. |
| Secrets | `monoplayer-puppet-auth`, untracked, RBAC-scoped. Secret volume is read-only: live cache in `emptyDir`, patch the Secret via the K8s API with a ServiceAccount limited to that object. |
| Pod security | `restricted` Pod Security, non-root, read-only root filesystem where possible. |
| Readiness | Puppet leg in PLAY, cache warm, auth healthy. Liveness is process-level; readiness is session-level. |
| Rate limit | Handshake timeout, per-IP attach rate limit, one attach at a time, bounded backlog. |
| Storage | No PVC. Token cache fits in the Secret. Longhorn later if session persistence is ever added. |

### Build & deploy

| Term | Detail |
| --- | --- |
| BuildKit | existing `buildkitd` in `deepmine-build`, port-forward 1234 |
| Registry | push `zot.deepmine-core.svc:5000/monoplayer/...`; pull `registry.internal/monoplayer/...` |
| Tag | `sha-<7>`, digest-pinned in the manifest |
| Deploy | `kubectl apply -k deploy/env/dev` |
| Telemetry | OTLP gRPC to the shared collector; OpenObserve dashboards |
| ArgoCD | Not in the MVP. Add when the service graduates. |

### mise task interface

```
# Local loop
mise run check          # format, lint, typecheck, unit tests
mise run test:l2        # fake backend + fake client integration
mise run ci             # check + L2 + audit

# Images
mise run images:build   # port-forward buildkitd, build, push, print digest
mise run deploy         # kubectl apply -k deploy/env/dev
mise run smoke          # L3 job: real image + fake backend + fake client
mise run logs           # kubectl -n monoplayer-dev logs -f
mise run metrics        # OpenObserve query helper

# Account lifecycle
mise run secret:apply   # device-code bootstrap -> namespaced Secret
mise run secret:rotate  # new device code, replace the Secret
mise run auth:status    # token age + last refresh from the Secret timestamp
mise run whitelist:add  # resolve username -> UUID, reload without restart
mise run down           # rotate/revoke, then delete the namespace
```

> **Why this loop is fast**
>
> L1 and L2 run in-process on the developer machine with no cluster and no
> puppet Microsoft account. The slow path (BuildKit, cluster, OpenObserve)
> only runs after the protocol invariants are green. The live account is the
> auth gate and final smoke, not the inner loop.

### Before the first deploy

- [ ] Puppet account is your own MSA, owns Java Edition, and can join the
  backend.
- [ ] Device-code bootstrap works; a pod restart refreshes silently; the
  replacement token persists.
- [ ] No token, UUID, or Secret value exists in git, logs, traces, or images.
- [ ] Secret encryption at rest is verified on Talos, or an external secret
  store is used.
- [ ] Default-deny ingress and egress are installed; Tailscale is the only
  data-plane path.
- [ ] Attach gate is online-mode `hasJoined` + UUID whitelist; denied clients
  never relay.
- [ ] Replicas are exactly one; pod-count alert exists; attach rate limit and
  readiness probe are set.
- [ ] Backend is your own or explicitly permits the proxy;
  `prevent-proxy-connections` is verified.
- [ ] No required resource pack; chat is read-only/blocked or the per-leg
  state machine is proven.
- [ ] `mise run down` rotates/revokes tokens before deleting the namespace.

## Risks & kill criteria

**What can go wrong, and when to stop**

The architecture is proven; the implementation is not. These are the risks
that matter, in order of whether they can kill the project.

| Risk | Sev. | Mitigation / kill |
| --- | --- | --- |
| **Synthesized join rejected by the official client** — stuck on “Loading terrain”, kick on session verification, movement desync. | Critical | Gate A in 2 days. If it fails, abandon the Node substrate; pivot to MCProtocolLib or deploy ZenithProxy. |
| **Refresh-token chain broken** — two pods, failed write-back, 90-day expiry, token theft. | Critical | One pod, Recreate, no HPA; RBAC write-back; age alert at 60 days; untracked Secret; rotate on incident. |
| **Chunk cache incoherence** — block edits while detached, palette surgery, memory growth. | High | Pin the puppet's chunk and cardinal neighbours; evict other mutated chunks; patch in slice 2; assert cache bytes and attach logs. |
| **Secure chat** — signals invalid for the puppet profile and `last_seen` windows are per-connection. | High | Per-leg chat state machine (acknowledge, rebuild window, ordered clientbound chat). Built in #19 as `chat: 'full'`; default stays read-only until a live run proves it. `enforce-secure-profile=false` removes signatures, not last-seen checks. Re-sign with puppet certs in slice 2. |
| **AFK kick** — the puppet is inert while detached; a server idle kicker drops it anyway. | High | Disable idle kicks on your own backend or accept session death as residual risk. This is outside the proxy's control. |
| **Secret encryption at rest unverified** — Talos does not encrypt Secrets by default. | High | Verify the machine-config setting before storing the token, or use an external secret store. Do not claim encryption until checked. |
| **Version treadmill** — quarterly protocol bumps; library lags. | High | Pin one version; scheduled bump task; ViaProxy stopgap; Java fallback if two bumps exceed 4 days. |
| **Account / server enforcement** — Microsoft lock, server ban, anti-cheat flag. | High | Owner-operated only; own server or explicit permission; no automation; loud ban/privilege signals. |
| **Single-pod state loss** — node reboot, OOM, rollout, scale-down. | High | Accept for MVP; preStop drain; reconnect with backoff; document that live TCP state does not survive a pod restart. |
| **Event-loop saturation** — chunk floods, many entities. | Medium | Raw-frame relay, bounded cache, measure first; worker threads/clustering only if measured. |
| **PrismarineJS bus factor** — small maintainer team. | Medium | Depend on the wire format, own the auth wrapper, keep the Java pivot viable. |

> **Kill criteria**
>
> - **Gate A fails:** official client cannot attach, movement desyncs in the
>   first minute, or reattach is stuck on “Loading terrain…”. A chat-only
>   failure descopes chat; it does not kill the substrate.
> - **Slice 1 misses acceptance by week 3:** the 60-second demo cannot be
>   produced.
> - **Post-demo soak (not part of the three-week demo):** first-try attach
>   success <95%, puppet median lifetime <24 h from proxy-caused drops, or a
>   second refresh-token incident within 90 days.

## Decision log

**The council's calls**

Three independent delegates reviewed the same research. All three recommended
building the Node semantic MITM; the delivery delegate recorded the strongest
dissent (deploy ZenithProxy instead). Confidence is per delegate, not a vote
count.

### D1 — Approach: stateful semantic MITM

Bounded cache + synthesized join + cached config replay. The backend session
is never dropped for client lifecycle events. Rejected: full byte replay
(unbounded), reconnect-on-attach (loses state), bot-world synthesis
(speculative).

**Vote:** unanimous.

### D2 — Stack: build in Node/TypeScript, don't fork ZenithProxy

`minecraft-protocol` + `prismarine-auth`; MCProtocolLib is the fallback.
ZenithProxy is the behavioral spec and the fallback deployment. Forking
inherits AGPL, Java/Gradle, and 2b2t scope. AGPL only binds distribution, so
private deployment remains a legitimate fallback.

**Vote:** 3 / 3 recommend build. Delivery confidence 78.

### D3 — Version: pin 26.1 / protocol 775

The newest version the Node stack supports. Pin the backend too. No
translation layer in slice 1. ViaProxy is the escape hatch; Java is the
substrate pivot if currency becomes the bottleneck.

**Vote:** unanimous.

### D4 — Attach gate: online-mode hasJoined + UUID whitelist

The client proves its own Mojang identity to the proxy; the proxy sends the
puppet's profile to the client. Never authenticate the client to the backend
as the puppet. Attach token is an optional second factor, not the primary
gate.

**Vote:** unanimous.

### D5 — Late attach: fresh join into the live session

No custom attach screen. The vanilla loading screen is the UX. ~1–3 s, flat
with session age. The cache radius is the trade-off.

**Vote:** unanimous.

### D6 — Validation: Gate A first, then a 2-week slice

Gate A is throwaway and can kill the Node implementation. The slice adds the
product surface, L1–L4, and the 60-second demo. The live account is a final
manual smoke.

**Vote:** unanimous.

### D7 — Ops: one pod, one namespace, Tailscale-only, OTLP

Reuse the deepmine loop. Secrets outside git with pod write-back. Default-deny
NetworkPolicy. No ArgoCD, no PVC, no HPA for the MVP.

**Vote:** unanimous.

### D8 — Biggest risk: join synthesis and chat

The synthesized join must be indistinguishable from a fresh vanilla join. If
the official client rejects it, the architecture needs a different substrate.
Kill criterion is Gate A.

**Vote:** unanimous.

### Council dissent, in full

The delivery delegate's strongest counter: *“You can have this product this
weekend.”* ZenithProxy already does everything Monoplayer needs, with more
features, on a current protocol, in production. Deploying it is days of
configuration; building is roughly three weeks plus a permanent quarterly
treadmill. The build is justified only if you value license cleanliness for
distribution, a small owned codebase, a Node-native ops loop, and future
extension (multi-account, custom control plane) enough to pay for it. If the
goal is simply “make it exist for me,” deploy ZenithProxy.

The recommendation is still to build, but Gate A and the three-week cap are
there to make the fallback cheap. The product survives a failed build.

## Plan

**Three weeks to a demo, with an early exit**

| Phase | Effort | Output / gate |
| --- | --- | --- |
| **Gate A — falsifier** | 2 days | Throwaway proxy + official client attach + walk/break/place + detach/reattach + chat sub-test. Go/no-go on Node; chat failure descopes chat. |
| **Auth gate** | 0.5 day | Device code, restart, silent refresh, token persists, `auth:status`, `prevent-proxy-connections` check. |
| **Slice 1 — data plane** | 7 days | Puppet leg, config cache, synthesized join, play relay, whitelist, detach survival, L1/L2 green, golden baseline. |
| **Slice 1 — operations** | 4 days | mise tasks, BuildKit image, `monoplayer-dev`, NetworkPolicy, Secret, OTLP, L3/L4 smoke. |
| **Live smoke** | 1 day | Real Microsoft account + real backend + official client. The 60-second demo. |
| **Total to demo** | **~3 weeks** | Accept, or deploy ZenithProxy as the fallback and re-scope. |
| **Post-demo soak** | 1 week | Daily use; measure attach success and session lifetime against the kill criteria. Not part of the demo. |
| **Recurring** | 0.5–2 days / quarter | Protocol bump, golden re-run, re-pin backend. >4 days twice = pivot. |

| When | Status | Note |
| --- | --- | --- |
| Day 2 | Go / no-go | Official client attaches |
| Week 2 | Local green | L1/L2 invariants |
| Week 3 | Demo | Cluster + live smoke |

## What I need from you

**Six decisions; four block Gate A**

The research answered the mechanism questions. These are values and scope
questions that change the plan, so they should be answered by you, not
guessed. Q1–Q3 and Q5 gate Gate A; Q4 and Q6 gate the first deploy.

1. **Target backend and version.** Is this your own server? Can you pin it to
   26.1 / 775, or is it fixed at 26.3 or another version? If it is fixed, we
   choose ViaProxy or the Java path before writing Node code. Also confirm the
   puppet account owns Java Edition and can join the backend.
2. **Whitelist.** Which Minecraft accounts may attach? Give UUIDs (or
   usernames we resolve to UUIDs). Is this single-user, a few friends, or a
   product?
3. **Build vs deploy, and what it is for.** Do you want the Node
   implementation (ownership, license cleanliness, extension) or the fastest
   path (deploy ZenithProxy as config)? Is the primary use case keeping an
   account online, remote play, or queue avoidance? That decides how much
   persistence complexity is earned. The recommendation is build, with Gate A
   and a three-week cap.
4. **Pod restart semantics.** Is it acceptable that a pod restart drops the
   live backend session and reconnects (position/inventory may reset depending
   on the server)? Persisting a live TCP session across restarts is not in the
   MVP.
5. **Chat.** Is the backend's `enforce-secure-profile` off? Even if it is,
   outgoing chat needs a per-leg `last_seen` state machine. Is
   read-only/blocked chat acceptable for the demo, or is chat a must-have? If
   it is a must-have, Gate A must prove the full state machine, not just
   signature stripping.
6. **Exposure and scope.** Confirm Tailscale-only, owner-operated, own-server
   use. If you need public ingress or third-party users, the security and
   legal design changes materially.

> **Recommended next action**
>
> Answer 1–3 and 5, then run Gate A. Do not build the product slice until an
> official client has attached to a live puppet and reattached after a
> disconnect. Answer 4 and 6 before the first deploy.

## Sources

**Research and decision trail**

The notes behind this document are local only. They live in `.scratch/` and
never enter git, so they cannot be linked. They hold the full evidence, packet
tables, risk register, and test plans. The public sources:

- [ZenithProxy](https://github.com/rfresh2/ZenithProxy) — production reference
  implementation.
- [Pork2b2tBot](https://github.com/PorkStudios/Pork2b2tBot) — earlier
  existence proof.
- [azalea-reflection-proxy](https://crates.io/crates/azalea-reflection-proxy)
  — cached config, synthesized join, raw chunk cache.
- [mineflayer-proxy-inspector](https://github.com/IceTank/mineflayer-proxy-inspector)
  — attach/link world inspection.
- [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)
  — both protocol legs.
- [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) —
  Microsoft device-code auth.
- [minecraft-data](https://github.com/PrismarineJS/minecraft-data) — versioned
  packet data.
- [MCProtocolLib](https://github.com/GeyserMC/MCProtocolLib) — Java fallback
  substrate.
- [MinecraftAuth](https://github.com/RaphiMC/MinecraftAuth) — Java-side auth
  for the fallback.
- [ViaProxy](https://github.com/ViaVersion/ViaProxy) — version translation
  stopgap.
- [Minecraft Java protocol —
  packets](https://minecraft.wiki/w/Java_Edition_protocol/Packets)
- [Protocol encryption and
  hasJoined](https://wikivg.booky.dev/Protocol_Encryption)
- [Protocol version table](https://minecraft.wiki/w/Protocol_version)

> **Provenance**
>
> This document synthesizes four independent research delegates, a
> three-delegate decision council, and three independent audits. Audit fixes
> incorporated: the per-leg chat `last_seen` contract, pinned feet chunks, the
> Gate A secure-profile split, the Secret encryption-at-rest caveat, the token
> write-back gate, the external pod-count alert, and the corrected lifecycle
> diagram. It is a proposal for decision, not a final spec. The open HITL
> ticket is the next step once the six questions above are answered.

---

Monoplayer architecture proposal · 5 November 2026 · Draft for decision. Stage
names inside (Gate A) are kept as the record of when each row was decided.
Built from research notes and council memos that live in `.scratch/`, local
only.

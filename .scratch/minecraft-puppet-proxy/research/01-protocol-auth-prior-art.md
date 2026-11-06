# Research note: protocol, auth, and prior art

**Ticket:** `issues/01-research-protocol-auth-and-prior-art.md`
**Status:** findings ready for decision
**Date:** 2026-11-05

## TL;DR

The pattern Monoplayer wants — a headless service holding an official account, with
whitelisted official clients attaching to the **live** session — already exists in
production form: **ZenithProxy** (Java, AGPL-3.0) is a Minecraft bot that "players
can also log into and control ingame", with a secure whitelist, spectator mode,
and persistence across client disconnects. It has run on 2b2t for years at scale.
The architecture is a **stateful semantic MITM**: the proxy terminates encryption
and does `hasJoined` for the attaching client (its own RSA keypair), logs into the
backend as the puppet via Microsoft device-code auth, caches configuration/play
state, synthesizes the Join Game for attach, and forwards play packets with
targeted rewrites. Raw 1:1 packet forwarding is **partially viable** (play phase,
same version, while attached) but the login/config phases can never be forwarded
verbatim, and persistence forces a state cache. The headless-bot-synthesis
alternative (Mineflayer world → official client) has no proven full-fidelity
implementation and is speculative.

**Recommendation (first slice):** clone the ZenithProxy architecture in
**Node.js on node-minecraft-protocol + prismarine-auth** (MIT/BSD, no AGPL
obligation), single pinned 1.21.x version, single puppet, one controlling client:
own-keypair online-mode front end with `hasJoined` + whitelist, Microsoft-login
client leg as puppet, config-phase cache, synthesized Join Game from cache,
play-packet relay with rewrites for chat signing / keep-alive / cookies / transfer,
keep-alive responder while no client is attached. See "Recommendation" below.

---

## 1. Online-mode login: what the proxy must terminate vs forward

Sequence (verified against [Protocol Encryption](https://wiki.vg/Protocol_Encryption)
and the current [packet spec](https://minecraft.wiki/w/Java_Edition_protocol/Packets)):

```
C→S Handshake (intent=2 login, or 3 transfer since 1.20.5)
C→S Login Start            (name; UUID + signature data since 1.20.5/1.21.x)
S→C Encryption Request     (server ID string (empty since 1.7), DER-encoded RSA pubkey, verify token, "should authenticate")
C→S Encryption Response    (16-byte shared secret + verify token, PKCS#1 v1.5-RSA-encrypted to server pubkey)
both enable AES/CFB8      (whole packet encrypted, cipher updated continuously)
S→C Set Compression        (optional, must come BEFORE Login Success)
S→C Login Success          (profile UUID+name+properties, session ID since 1.21.x)
C→S Login Acknowledged     (added 1.20.2)
S→C … configuration phase … → Finish Configuration
C→S Acknowledge Finish Configuration
S→C Login (play) = Join Game → play phase
```

- Server auth = `GET https://sessionserver.mojang.com/session/minecraft/hasJoined?username=&serverId=&ip=`
  where `serverId` is the nonstandard Minecraft-format SHA-1 hex digest of
  `(serverIdString ‖ sharedSecret ‖ serverPublicKey)`. Client auth = the mirror
  `.../join` POST with `accessToken`, `selectedProfile`, `serverId`. Both sides
  must produce the same hash for Mojang to correlate them.
- **The proxy holds the only RSA private key** on the client leg, so only the
  proxy can decrypt the shared secret and perform `hasJoined` for the attaching
  player. On the backend leg, the backend does its own `hasJoined` for the puppet.
  The login handshake is therefore **unforwardable**: it must be terminated at the
  proxy and executed twice, once per leg. Encryption and compression settings are
  per-connection (proxy can choose different compression thresholds per leg;
  re-encoding is mandatory).
- Mojang's sessionserver is a hard external dependency for the front leg (online
  mode). No library implements `hasJoined` for you as a client-facing API except
  server-side implementations: node-minecraft-protocol `createServer({online-mode:true, encryption:true})`
  ([README](https://github.com/PrismarineJS/node-minecraft-protocol)) and MCProtocolLib's
  `SessionService`/`ServerLoginHandler` (used by ZenithProxy). This is proven in
  both ecosystems.

## 2. Configuration and play phases in 1.21.x

- **Configuration state** exists since **1.20.2 (protocol 764)**. After Login
  Success the server sends brand plugin message, feature flags, registry data,
  update-enabled-features, update tags, resource-pack push, server links, cookies
  (1.20.5+), code of conduct (1.21.x), then Finish Configuration; the client sends
  Client Information, Known Packs, resource-pack status, cookie responses, then
  Acknowledge Finish Configuration. Clientbound `Start Configuration` in play
  exists to push a client back into config (used for transfers).
- **Cookies and Transfer packets** exist since **1.20.5 (protocol 766)**; both
  appear in config **and** play. Cookies are the persistence primitive across
  transfers. `Handshake intent=3 (transfer)` tells the receiving server the client
  arrived via a Transfer packet.
- **Packet identity changes with version**: packet IDs are per-state, per-protocol
  version, per direction. A proxy that parses per-version (both libraries do, via
  versioned protocol JSON / codecs) survives version bumps cheaply; a proxy that
  hardcodes IDs does not. Packet renames happen even without ID changes
  (e.g. `teleport_entity` → `entity_position_sync` in 1.21.2,
  [Packets page](https://minecraft.wiki/w/Java_Edition_protocol/Packets)).
- **Secure chat is alive in 1.21.x** (and in 26.3/protocol 777): Login Start
  carries signature data; Mojang issues **player certificates** (X.509 public key +
  Mojang-signed expiry, plus private key, since 1.19 protocol 759); chat sessions
  (session ID + session key, since 1.19.3 protocol 761) are exchanged in login;
  Chat Message carries salt + signature + previous-message chain
  ([Packets page](https://minecraft.wiki/w/Java_Edition_protocol/Packets),
  sections "Chat Message", "Player Session"). Consequence for proxying: the
  backend only trusts chat signed with keys it learned at the puppet's login, so
  a real client's signatures are **not verifiable by the backend** unless the
  proxy (a) injects the client's session key into the backend leg at login, (b)
  strips signatures and sends unsigned chat, or (c) re-signs as the puppet using
  the puppet's certificates (all three are done by real proxies; ZenithProxy holds
  `PlayerCertificates` in its chat cache).
- **Resource packs** in config phase: client responses are connection-scoped and
  must reach the backend or it stalls; a proxy serving late-attach from cache must
  replay pack push/status itself.

## 3. MITM packet relay vs headless-bot synthesis

**MITM (proxy = server to client, client to backend).**
Proven at production scale by ZenithProxy and (earlier, same pattern)
Pork2b2tBot. What raw 1:1 forwarding can and cannot do:

| Phase | 1:1 forward? | Why |
|---|---|---|
| Handshake/login (encryption) | **No** | `hasJoined` requires the proxy's private key; compression is per-connection. Terminate per leg. |
| Configuration | **No** for late attach | Registry/tags/flags/brands/cookies arrive once, before any late client exists. Proxy must **cache** them and replay (ZenithProxy: `CRegistryDataHandler`, `CUpdateTagsHandler`, `CStoreCookieHandler`, `SLoginFinishedOutgoingHandler`). |
| Play, clientbound (chunks, entities, inventory, boss bars, …) | **Yes**, while attached | Same version + same phase ⇒ same IDs; re-encode framing/compression only. |
| Play, serverbound (position, dig, place, interact) | **Yes**, mostly | Client movement drives the puppet directly (ZenithProxy forwards `ServerboundMovePlayerPosRotPacket` after spawn); pre-spawn positions must be swallowed. |
| Keep-alive | **Rewrites needed** | Backend keep-alive can be relayed while a client is attached; while detached the proxy must answer keep-alives itself (ZenithProxy: `ClientKeepAliveTask`) and run its own keep-alive cadence to attached clients (`KeepAliveOutgoingHandler`). |
| Chat | **Rewrite** | Signing (above); command replies/suggestions may need interception for proxy-local commands (ZenithProxy: `SignedChatCommandHandler`, `ChatCommandHandler`). |
| Cookies | **Store + replay** | Per-connection state; needed for transfer continuity and reattach (ZenithProxy: `CookieRequestPostOutgoingHandler`). |
| Transfer | **Rewrite target** | Rewrite transfer destination to the proxy's own address (ZenithProxy: `TransferPostOutgoingHandler`). |
| Entity IDs | **1:1 works for 1 controlling client**; mapping needed for spectators | ZenithProxy reuses the puppet's entity ID for the controlling player (`ClientboundLoginPacket` with `CACHE.getPlayerCache().getEntityId()`) and allocates separate IDs for spectators. |
| Login (play) / Join Game | **Synthesized from cache**, not forwarded | A late-attaching client never saw the backend's Join Game. ZenithProxy waits for cache readiness (entityId, game mode, dimension, chunks, tablist, whitelist check) then emits `ClientboundLoginPacket` from cache (`ProxyServerLoginHandler.java`). |

Key evidence for the whole pattern (ZenithProxy source, 1.21.4 branch):
- Server leg: `TcpServer` with per-session `MinecraftProtocol`, `ProxyServerLoginHandler`
  (whitelist gate + synthesized join), per-packet `server/handler/player` handlers.
- Bot leg: `ClientSession` + `network/client/handler/incoming/*` handlers,
  `Authenticator` using RaphiMC **MinecraftAuth** device-code login with token
  refresh scheduling and player-certificate acquisition.
- Persistence: bot connection lives independently of attached players;
  `ClientKeepAliveTask` keeps the backend session alive; on backend disconnect the
  cache is fully reset (`CACHE.reset(CacheResetType.FULL)`).
- ViaVersion on both legs lets any client version talk to any backend version;
  not needed for a pinned-version MVP.

**Headless-bot synthesis (Mineflayer holds world; proxy synthesizes an official
client's view).**
Demonstrated only in reduced form: `prismarine-viewer` renders the bot's
prismarine-world state in a **browser viewer**, not to the official client
protocol. Making an official client playable against a synthesized world means
re-implementing server-side chunk streaming, entity protocol, teleports,
keep-alive, spawn sequence, and reconciling bot physics with client physics.
No project found that does full-fidelity official-client playback from bot state.
**Speculative; reject for the MVP.** (It remains useful as a future
"observation only" feature, where ZenithProxy's spectator mode is again the
working reference.)

## 4. Prior art: "attach a real client to a bot's live session"

**Found. The exact feature exists, twice, both in the 2b2t bot ecosystem:**

1. **ZenithProxy** ([repo](https://github.com/rfresh2/ZenithProxy), docs
   [wiki.2b2t.vc](https://wiki.2b2t.vc/Setup/)) — Java, **AGPL-3.0**. "A Minecraft
   bot that players can also log into and control ingame… accounts always online
   and securely shared with friends." Secure whitelist (connecting players use
   their **own** accounts, verified via `hasJoined` on the proxy's server leg,
   gated by whitelist UUID/name lists), spectator mode, Discord relay, coordinate
   obfuscation, queue handling, Baritone, GraalVM native (<250 MB RAM), MC 1.21.4
   default with any-version via ViaVersion. Architecture verified from source
   (see §3). Active forks keep it current (e.g.
   [boze-dev/zenith-proxy-boze](https://github.com/boze-dev/zenith-proxy-boze),
   1.21.11). This is the primary reference implementation of Monoplayer's goal.
2. **Pork2b2tBot** ([repo](https://github.com/PorkStudios/Pork2b2tBot)) — Java,
   MIT-with-attribution. "A minecraft bot thing, also works as a proxy!" Spambot +
   web overview + proxy mode where clients attach. Predecessor of ZenithProxy's
   pattern (credited by ZenithProxy).

`nemes/ProxyLite` does not exist (GitHub 404); it was a false memory and should
not be cited.

## 5. Library comparison (evidence-backed)

| Project | Lang / license | Client leg | Server leg (online-mode, hasJoined) | MS auth | 1.21.x support | Proven role for this design |
|---|---|---|---|---|---|---|
| **ZenithProxy** | Java / AGPL-3.0 | yes (bot) | yes (players attach, whitelist) | yes (MinecraftAuth device code, token refresh) | yes (1.21.4, ViaVersion any) | **Full reference implementation** of client-attach-to-bot with persistence |
| **Pork2b2tBot** | Java / MIT+attr | yes (bot) | yes (proxy attach) | yes (OpenAuth) | behind (frozen dev) | Second existence proof |
| **node-minecraft-protocol** | JS / BSD-3 | yes (createClient: auth, encryption, compression, keep-alive, SRV) | yes (createServer: online/offline mode, encryption, keep-alive, status) | via prismarine-auth | yes (through 1.21.11, 26.1) | Best foundation for a custom Node proxy: both legs in one lib |
| **prismarine-proxy** | JS / MIT | yes | yes (server options incl. online mode) | via prismarine-auth | underlying lib supports; examples target 1.8.9 — 1.21 config/transfer handling not demoed | Thin relay layer to start from; plan to own config-phase logic |
| **prismarine-auth** | JS / MIT | n/a | n/a | yes: MS device-code flow, Xbox chain, token cache | n/a | Puppet login on the Node stack |
| **mineflayer** | JS / MIT | yes (high-level bot: physics, world, inventory, pathfinding plugins) | no | via prismarine-auth | yes | Needed only for the synthesis route (rejected) or bot-side autonomy later |
| **MCProtocolLib** | Java / MIT | yes | yes (SessionService hasJoined) | external (MinecraftAuth/OpenAuth) | yes | The proven Java substrate (ZenithProxy, ViaVersion, Geyser all build on it) |
| **ViaProxy** | Java / GPL-3.0 | yes (version translation, online-mode backend login, accounts tab) | yes (accepts clients, does auth) | yes (MinecraftAuth) | yes; explicitly supports chat-signing servers and transfer/cookies for ≤1.20.4 clients on 1.20.5+ servers | Version-translation option; plugin API; GPL if reused |
| **MinecraftAuth** | Java / LGPL-3.0 | n/a | n/a | yes: device-code / credentials / WebView, token lifecycle, Realms API | n/a | Java-side puppet auth |
| **minekube/gate** | Go / Apache-2.0 | backend routing only | yes (proxy front, lite mode, Bedrock) | n/a (proxies auth upstream) | yes (Via via vialite) | Reference for the Kubernetes data-plane topology; not a bot-attach tool |
| **go-mc** | Go / MIT | yes (bot framework) | yes (server framework) | **no MS auth in-tree** (Yggdrasil marked half-done) | 1.21 badge | Possible Go data plane, but you'd write MS auth + hasJoined glue yourself |

Support-claims above that come from READMEs/issue trackers are marked "yes (…)".
Claims not demonstrated anywhere are marked "no" or noted.

## 6. What is proven vs speculative

**Proven**
- The login/hasJoined crypto flow and per-connection encryption termination
  (wiki.vg Protocol Encryption; implemented in node-minecraft-protocol and
  MCProtocolLib server roles).
- Config/play phase packet set, cookies, transfers, secure chat in current
  protocol (minecraft.wiki Packets page, protocol 777 text).
- Microsoft device-code auth with refresh and player certificates
  (prismarine-auth; RaphiMC MinecraftAuth).
- A real client attaching to and controlling a live bot session, with whitelist,
  spectators, and persistence, at 1.21.4 (ZenithProxy; Pork2b2tBot).
- Play-phase packet relay with per-packet rewrite hooks in JS
  (prismarine-proxy InstantConnectProxy, demonstrated on 1.8.9 traffic).
- Go proxy data planes at scale with Via translation (minekube/gate / Connect).

**Speculative / not demonstrated**
- Pure (stateless) 1:1 byte forwarding across login/config/play for 1.21.x with
  late attach — impossible for login (crypto), impossible for config (state
  needed), viable only for play-while-attached.
- Full-fidelity official-client view synthesized from a Mineflayer bot's world —
  no known implementation; prismarine-viewer is a custom viewer only.
- Any turnkey library that implements "client-attach-to-bot" — none exists; it is
  application logic (~ZenithProxy's handler layer), not a library feature.

## 7. Recommendation

Build the first slice as a **stateful semantic MITM in Node.js**:

1. **Libraries:** `node-minecraft-protocol` (both legs, MIT/BSD) +
   `prismarine-auth` (Microsoft device-code login, token cache in a Kubernetes
   secret) + `minecraft-data` for version-specific packet definitions. Pin one
   1.21.x protocol version on both legs (no ViaVersion in slice 1).
2. **Front leg:** `createServer({ 'online-mode': true, encryption: true })` with
   our own RSA keypair; gate on a whitelist of player UUIDs after the built-in
   `hasJoined`; single controlling client + optional spectators later.
3. **Back leg:** `createClient({ auth: 'microsoft', username: puppetId })`; keep
   tokens in a mounted secret; implement scheduled refresh (ZenithProxy's
   `Authenticator` pattern).
4. **State cache:** mirror ZenithProxy's minimal set — registry data, tags,
   feature flags, brand, resource-pack push/status, cookies, Join Game fields
   (entityId, game mode, dimension, hashed seed), tablist header/footer.
5. **Join synthesis + relay:** on attach, wait for cache readiness, emit
   synthesized config-phase replay + Join Game, then relay play packets with
   rewrites for: chat (strip/re-sign signatures per backend's
   `enforce-secure-profile`), keep-alive (proxy answers backend keep-alives when
   detached; own cadence to attached clients), cookies (store/replay),
   transfer (rewrite to proxy address).
6. **Persistence:** backend connection is owned by the pod, never by the client;
   client disconnect keeps the puppet in world; reattach replays from cache
   (answers map.md "late-attach UX" as "fresh join into the live session").
7. **Validation loop:** local fake backend via node-minecraft-protocol's
   createServer (offline mode) + a headless test client; Microsoft-account smoke
   test only at the end, as a secret (map.md constraints). Java/ZenithProxy is the
   fallback if Node's server-leg gaps (config-phase edge cases) bite — the
   architecture transfers 1:1; AGPL applies only if we actually fork ZenithProxy.

## 8. Smallest falsifying experiment

**Claim to falsify:** an official client can attach to and drive the puppet's
live session through our proxy using synthesized join + play-phase relay with
signature handling, on a real online-mode 1.21.x server.

**Experiment (≤2 days, no product code beyond a throwaway script):**
1. Stand up a vanilla **1.21.4 online-mode** server (local or a dedicated test
   instance of a real network; enforce-secure-profile on).
2. 60-line Node script: puppet leg logs in via prismarine-auth device code;
   front leg `createServer` online mode with a generated keypair; on client join,
   cache config phase, synthesize Join Game from cached fields, relay play
   packets, forward client movement to the puppet leg, strip chat signatures
   (send unsigned), answer backend keep-alives.
3. Researcher joins with an **official whitelisted client**: walk 100 blocks,
   break + place a block, send a chat message, then disconnect; a second observer
   bot (mineflayer) or server console confirms: puppet moved to the client's end
   position, block events happened, chat was delivered, and the puppet stayed in
   world ≥5 min after client disconnect.
4. **Falsified if:** client is kicked for chat/session verification on a
   enforce-secure-profile server despite stripping, entity/teleport desync makes
   movement break within the first minute, or reattach after disconnect fails to
   resync (client stuck on "Loading terrain").

If that experiment passes, the architecture and stack are confirmed for the MVP;
if it fails, escalate to the ZenithProxy-style Java stack or re-scope.

## 9. Links

- Protocol encryption & hasJoined: https://wiki.vg/Protocol_Encryption (mirror: https://c4k3.github.io/wiki.vg/Protocol_Encryption.html)
- Login sequence / phases: https://minecraft.wiki/w/Java_Edition_protocol/FAQ
- Current packet spec (config, play, cookies, transfer, chat session): https://minecraft.wiki/w/Java_Edition_protocol/Packets
- ZenithProxy: https://github.com/rfresh2/ZenithProxy · source: `src/main/java/com/zenith/Proxy.java`, `network/server/handler/ProxyServerLoginHandler.java`, `network/client/Authenticator.java`, `network/server/handler/player/incoming/SPlayerPositionRotHandler.java`
- ZenithProxy docs: https://wiki.2b2t.vc/Setup/ · FAQ: https://wiki.2b2t.vc/FAQ/
- Pork2b2tBot: https://github.com/PorkStudios/Pork2b2tBot
- node-minecraft-protocol: https://github.com/PrismarineJS/node-minecraft-protocol
- prismarine-proxy: https://github.com/PrismarineJS/prismarine-proxy
- prismarine-auth: https://github.com/PrismarineJS/prismarine-auth
- mineflayer: https://github.com/PrismarineJS/mineflayer · prismarine-viewer: https://github.com/PrismarineJS/prismarine-viewer
- MCProtocolLib: https://github.com/GeyserMC/MCProtocolLib
- ViaProxy: https://github.com/ViaVersion/ViaProxy
- MinecraftAuth: https://github.com/RaphiMC/MinecraftAuth
- minekube/gate: https://github.com/minekube/gate · https://gate.minekube.com
- go-mc: https://github.com/Tnze/go-mc

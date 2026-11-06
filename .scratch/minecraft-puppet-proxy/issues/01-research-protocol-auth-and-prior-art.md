# Research: protocol, auth, and prior art

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

What are the viable ways to accept an official Minecraft Java client and drive a
headless session for an official account, and what prior art already proves each
approach?

Cover at least:

- The online-mode login flow: `hello` → encryption request/response → compression
  → login success, the Mojang `hasJoined` check, and what a proxy must terminate
  vs forward.
- The configuration and play phases in current Java versions, including packet
  identity that changes with version, secure chat, resource packs, cookies, and
  transfer packets.
- Packet-level MITM (proxy is a server to the client and a client to the backend)
  versus driving a headless bot (Mineflayer-style) and synthesizing a client view.
- Existing libraries and projects: `node-minecraft-protocol`, `prismarine-auth`,
  `mineflayer`, Java `MCProtocolLib`, `ViaProxy`, `minekube/gate`, Go `go-mc`,
  and any proven "attach a real client to a bot" project.
- What is demonstrably supported today, what is speculative, and the smallest
  experiment that would falsify the preferred approach.

Deliverable: findings with links, a comparison table, and a recommendation for
the first slice. Do not implement.

## Answer

The exact feature exists in production: **ZenithProxy** (Java, AGPL-3.0) and,
earlier, **Pork2b2tBot** (Java, MIT+attribution). Both terminate the attaching
player's login with their own RSA key, verify the player's own account with
Mojang `hasJoined`, connect to the backend as the puppet with Microsoft auth,
cache configuration/play state, synthesize a Join Game on attach, and relay play
packets with targeted rewrites. The architecture is a **stateful semantic MITM**,
not a byte pipe.

Raw 1:1 forwarding is viable only for play-phase packets, same version, while a
client is attached. Login can never be forwarded (per-connection encryption and
`hasJoined`), and configuration cannot be forwarded to a late-attaching client
(registries, tags, cookies and resource packs arrived before the client existed).
Play packets need rewrites for keep-alive, teleport IDs, chat signatures, cookies
and transfer targets. Entity IDs can pass through for one controlling client.
Mineflayer world synthesis is speculative and rejected for the MVP.

Recommended first slice: **Node/TypeScript** with `minecraft-protocol` (both legs)
and `prismarine-auth` (puppet Microsoft login), pinned to one protocol version,
with a single controlling client. Front leg: online-mode `hasJoined` + UUID
whitelist, then a forged Login Success carrying the puppet profile. Back leg:
Microsoft device-code auth, token refresh, keep-alives answered while detached.
Java/MCProtocolLib is the fallback if Node's config-phase edge cases bite.

Smallest falsifying experiment: a throwaway 1.21.x/26.x proxy in front of an
online-mode test server; an official client attaches, walks, breaks/places a
block, chats, disconnects; an observer confirms the puppet stayed in world for
5 minutes and reattach works. Full evidence and links in
[`research/01-protocol-auth-prior-art.md`](../research/01-protocol-auth-prior-art.md).

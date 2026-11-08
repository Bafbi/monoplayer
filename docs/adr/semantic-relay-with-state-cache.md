# Hold the session as a semantic relay with a bounded state cache

One account holds a session on a server while a different, differently authenticated account attaches to it later. A Minecraft connection is single-use, because encryption, compression, teleport ids, keep-alives, cookies, and the chat index all belong to the connection that produced them, so a byte pipe can only serve the client that made it. Monoplayer terminates both legs at the protocol level on one pinned version, rebuilds each attach from a bounded state cache, and routes every clientbound frame through one policy table.

## Considered options

- **A byte-level pipe between the two sides.** Rejected: it cannot serve an attach at all, and per-connection mechanics break as soon as two connections exist.
- **Deploy ZenithProxy, which already ships this feature.** Rejected for ownership. Custody, the attach whitelist, clientbound containment, and the testbed are the product, and none of them come with a third-party proxy. It stays the fallback if the Node protocol layer cannot follow a version bump.
- **Java with MCProtocolLib.** Rejected for now: the same fallback shape, a second toolchain, and no gain today. It is the path if the Node protocol layer stalls.
- **Require the player to be present at login.** Rejected: attaching to a session that is already running is the product.
- **Replay an unbounded frame history.** Rejected: the replay grows with the age of the session, exceeds what a client accepts, and replays per-connection mechanics along with state.
- **Trust the router to contain connection control.** Rejected after the 2026-11-08 Skyblock incident: the backend sent a transfer, the router relayed it, and the attaching player reconnected to another server as themselves, outside the puppet. The frame had also been cached, so it replayed onto the next attach and killed that client. Containment is now one table that the router, the cache, attach synthesis, and the front leg's last write all consult.

# Pin ProtocolLib for the observer

The server transparency observer reads packets through ProtocolLib, pinned by commit and built here, never through a released jar. The server's view of a client includes its skin parts, its chat session, the exact client information frame, and the transfer intent as sent; Bukkit exposes none of those, and Paper's API has no generic packet hook (`PlayerConnection` offers addresses and `isTransferred`, not frame access). ProtocolLib reads every frame without altering it, which is what the observer must do.

A release jar cannot work. ProtocolLib supports Minecraft 26.1 through 26.3 only on master: `MinecraftVersion` declares `v26_1` through `v26_3`, and `ProtocolLibrary.MAXIMUM_MINECRAFT_VERSION` is `"26.3"`. The newest published artifact is 5.3.0 (`latest` 5.4.0-SNAPSHOT) with `MAXIMUM_MINECRAFT_VERSION = "1.21.1"`, and the GitHub `dev-build` predates 26.x. So the observer pins commit `9cb125f` ("Update to Minecraft 26.3", #3681), builds it with `mise run observer:protocollib`, and refuses a build that does not know 26.1.

## Considered options

- **Depend on a Maven release or snapshot.** Rejected: the published artifacts stop at 1.21.1, so the listener would load and never fire.
- **Track ProtocolLib's master branch.** Rejected: a measurement instrument that moves under the lane makes a green run unrepeatable, and a bad upstream commit would look like a proxy regression.
- **Vendor the built Spigot jar (10.6 MB) into the repository.** Rejected: it bloats the tree for a first slice, and a binary blob hides the pin. A cached build keyed by the commit is smaller and auditable.
- **Hand-roll a Netty `ChannelDuplexHandler` with NMS reflection.** Rejected for now: it couples the observer to server internals that change with every protocol bump, and it is the same work ProtocolLib already maintains.
- **Read only what Bukkit exposes.** Rejected: the ticket exists to measure the fields Bukkit cannot see.

## Consequences

The observer lane builds before it runs, about two minutes cold and nothing warm, cached at `.cache/protocollib/ProtocolLib-<sha7>.jar`. A protocol bump moves the pin deliberately, in one line, with a build that fails loudly if 26.x support is missing. The observer plugin compiles against the same Paper build the gate server runs, so the jar it produces is loaded and tested against the exact server it measures. Before [#71](https://github.com/Bafbi/monoplayer/issues/71) the gate Paper ran `paper-api:26.1.2.build.74-stable`. That issue moved the gate Paper to 26.2 build 135, so the pin reads `26.2.build.135-stable`. `test/driver/pin.test.js` fails when the two disagree.

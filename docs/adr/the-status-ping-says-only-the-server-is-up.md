# The status ping says only that the server is up

A status ping needs no session, so it is the one thing a stranger reads before
authenticating. The front leg used to answer it from `minecraft-protocol`'s
defaults: the description "A Minecraft server", a maximum of 20 players, the
build's version name and a player count, on the modern wire and the pre-1.7
legacy wire alike. The leg now writes the answer itself (`statusPingAnswer` in
`src/legs/live-front.js`) and every field of it says nothing: an empty
description text, no players, no sample, an empty version name. The protocol
number stays, because it is the one field a client acts on: from that number it
decides whether it can join.

## Considered options

- **Leave the library's defaults.** Rejected: they are the library's, not a
  decision. An upgrade could change the description, the counts or the version
  name, and nothing in this repo would review that change.
- **Set the library's `motd` and `maxPlayers` and stop there.** Rejected:
  those two cover the description and the counts. The version name is derived
  from the version data, and the modern answer would still be assembled by the
  library.
- **Omit the description object.** Rejected: the description is the field the
  client renders on every server-list entry, and this repo has no proof that a
  client tolerates its absence. An empty text is the minimal form that keeps
  it.
- **Answer nothing: close the socket on a status handshake.** Rejected: the
  operator could no longer tell a reachable front leg from a down one, which is
  the one thing this answer is for.
- **Name the version.** Rejected: `version.name` is display text a client
  shows only when it cannot join. The protocol number alone carries the
  compatibility decision.
- **Blank the legacy version field too.** Rejected: the library builds that
  string from `server.mcversion`, so blanking it means removing the library's
  own listener and writing the frame here. It would hide nothing either: the
  modern answer sends the protocol number, which names the same Minecraft
  version.

## Consequences

- `motd: ''` reaches `mc.createServer`, so the legacy ping and the login
  `server_data` carry the same empty description. `maxPlayers: 0` reaches the
  legacy ping's maximum; `server_data` carries no maximum.
- `beforePing: statusPingAnswer` replaces the modern answer whole, so no field
  of that answer survives from the library.
- The answer never reports a player: the attaching player is a player of the
  backend, not of this server.
- A change that wants a description or a motd has to repeal this file first.

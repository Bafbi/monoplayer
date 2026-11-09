# Transparency: what the server sees

The goal is a puppet the backend cannot tell from a normal client. This page
is the contract: what the proxy sends on the puppet leg, what it does not send
yet, and what proves each claim.

Spec: [#11](https://github.com/Bafbi/monoplayer/issues/11).

## Client identity

The proxy writes the client's own identity on the puppet leg. The human's
client is a different connection; nothing it sends on these two frames is
forwarded raw.

| Field | Value the server sees | Ticket |
|---|---|---|
| Brand (`minecraft:brand`) | `fabric`, in the configuration phase, once per backend connection | [#17](https://github.com/Bafbi/monoplayer/issues/17) |
| Locale, skin parts, main hand, chat settings | The last human's values once a human has attached; vanilla defaults before that | [#18](https://github.com/Bafbi/monoplayer/issues/18) |
| View distance | The view distance the backend advertises in its play login, which is the server's cap | [#18](https://github.com/Bafbi/monoplayer/issues/18) |

The view distance is deliberately not the human's. A server sends chunks for
the view distance the client requests, so a human playing on a short render
distance would shrink the world the proxy caches for the next attach. The
puppet asks for the cap; the human's own render distance stays local.

The state cache is raised to hold that view distance. The chunk ring holds the
square the server sends, plus one ring for the overlap while a moving player's
new chunks arrive before the old ones unload:

| Backend view distance | Chunks held |
|---|---|
| 10 (Paper default) | 529 |
| 16 | 1225 |
| 32 | 4489 |

The ring never lowers its bound, and `reset()` keeps it. `cache.stats()`
reports `chunkBound` and `chunkBytes` (the measured bytes the ring holds), and
the core logs both under `backendViewDistance` on every backend login, so the
number comes from the running proxy rather than from a table. Optimising that
memory is a later task.

## Known limits

- **The proxy's egress address is the one accepted difference.** The backend
  sees the proxy host, which reads as a client behind a VPN. IP forwarding is
  out of scope.
- **Chat and commands are read-only until `MONOPLAYER_CHAT=full`.** In `full`
  mode the puppet speaks the human's text: it re-signs it with the puppet's
  profile key and its own last-seen window, so the server attributes it to
  GlowSquidye ([#19](https://github.com/Bafbi/monoplayer/issues/19)). The
  default stays `read-only` because the signed path has been proven offline
  only. Three consequences once it is on: the human's own signature and session
  key never reach the server; a message the server rejects arrives back as a
  rejection on GlowSquidye; and the human's client receives the server's signed
  `player_chat` from another connection, so its per-sender signature chain is
  out of order. The expectation is that the message still displays with a broken
  chain marker; no run has confirmed that yet, and #13 is where it gets
  confirmed.
- **A service with no profile keys sends unsigned chat.** The pinned
  minecraft-protocol sends an unsigned frame rather than failing, and a server
  with `enforce-secure-profile` answers that by closing the connection. The
  backend leg logs `chatCapability` once per backend connection with
  `signed: true` or `signed: false`, so a live run answers the question before
  the default is flipped.
- **Dialogs and configuration gates are still answered by the puppet.** The
  human does not own a dialog yet
  ([#20](https://github.com/Bafbi/monoplayer/issues/20),
  [#21](https://github.com/Bafbi/monoplayer/issues/21)).
- **A followed transfer still detaches the human.** It becomes a loading-screen
  reconfiguration on the same connection in
  [#22](https://github.com/Bafbi/monoplayer/issues/22).
- **A detach keeps the last human's client information.** A real client's
  options survive a reconnect, so the puppet does not reset to defaults when
  the human leaves. Only a fresh proxy process starts from them.
- **Before the play login there is no cap to request.** The protocol library
  sends Client Information once in the configuration phase with its default
  view distance of 10. The puppet re-sends the packet right after the play
  login with the backend's cap, so the value the server acts on is the cap.
- **The attach replay carries the whole cached view.** The human's client
  stores every chunk the replay sends; its own render distance only changes
  what the client draws. At a backend cap of 32 that is up to 4489 chunk
  frames per attach. `cache.stats().chunkBytes` is the measured size, and
  shrinking the replay is deferred with the rest of the memory work.

## What proves it

Offline, at the core seam and on the loopback rung:

```bash
mise run check
```

- `test/core/client-settings.test.js` pins the brand payload, the
  view-distance cap, the cache raise, and the human's fields reaching the
  backend.
- Loopback `O25` asserts one Fabric brand per backend connection, counted
  against the fake backend's logins.
- Loopback `O26` asserts the fake backend received the human's `fr_fr`
  locale, `96` skin parts, and off-hand main hand, with view distance `10`
  (the fake backend's advertised cap) even though that bot asked for `2`.
- `test/core/relay.test.js` pins `settings` as a rewritten frame: the
  human's client information never crosses the backend raw. It also pins the
  chat split: `chat_message`, `chat_command`, and `chat_command_signed` are
  spoken in `full` mode and dropped in `read-only` and `off`; the session key
  and the chat acknowledgement drop in every mode.
- `test/service/chat-send.test.js` pins the spoken path against the fake legs:
  the human's message and command reach the backend leg as text, the frame
  itself never crosses, and a detached human's chat is not spoken.
- Loopback `O29` asserts it over real sockets: the protocol bot sends a message
  and a command, and the backend records both from the puppet's connection while
  the core's forwarded-frame count does not move.

The server's own view is measured by the observer plugin and the direct vanilla
baseline, which do not exist yet
([#12](https://github.com/Bafbi/monoplayer/issues/12)). Until then, "the server
sees a normal Fabric client" rests on the frames the proxy writes and on the
fake backend's record of them, not on a live Paper server's report.

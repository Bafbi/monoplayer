# Transparency: what the server sees

The goal is a puppet the backend cannot tell from a normal client. This page is
the contract: what the proxy sends, what it does not send yet, what each claim
rests on, and where the limits are.

Spec: [#11](https://github.com/Bafbi/monoplayer/issues/11). The contracts the
proxy keeps are in [product-core.md](product-core.md); the testbed and the
observer run are in [testbed-transfer.md](testbed-transfer.md).

## The contract at a glance

| Behaviour | State | Ticket |
|---|---|---|
| The server sees the account GlowSquidye, never the human | done | [#5](https://github.com/Bafbi/monoplayer/issues/5) |
| The server sees the Fabric Loader brand | done | [#17](https://github.com/Bafbi/monoplayer/issues/17) |
| The server sees the backend's view distance, not the human's | done | [#18](https://github.com/Bafbi/monoplayer/issues/18) |
| The server sees the human's locale, skin parts, main hand, chat settings | done | [#18](https://github.com/Bafbi/monoplayer/issues/18) |
| A client can attach while the puppet is still configuring | done | [#16](https://github.com/Bafbi/monoplayer/issues/16) |
| The human's chat and commands are spoken as the account | built, off by default | [#19](https://github.com/Bafbi/monoplayer/issues/19) |
| A dialog reaches the human, who answers it, and the answer reaches the server | built | [#16](https://github.com/Bafbi/monoplayer/issues/16) |
| The human answers every play dialog | **not built** | [#20](https://github.com/Bafbi/monoplayer/issues/20) |
| The human answers configuration gates, including the code of conduct | **not built** | [#21](https://github.com/Bafbi/monoplayer/issues/21) |
| A followed transfer keeps the client connected | **not built** | [#22](https://github.com/Bafbi/monoplayer/issues/22) |
| Proxy notices reach the human as a toast | **not built** | [#15](https://github.com/Bafbi/monoplayer/issues/15) |
| The proxy's egress address is accepted as different | **accepted limit** | [#11](https://github.com/Bafbi/monoplayer/issues/11) |

## Client identity

The proxy writes the client's identity on the puppet leg. The human's client is
a different connection; nothing it sends on these frames is forwarded raw.

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

## Chat and commands

Clientbound `system_chat` and `profileless_chat` reach the attached client live
and are never cached, so an attach shows only chat that arrives after it.

The human's own chat frames are never forwarded. A signature made with the
human's key is invalid on the puppet's connection, and its offset means nothing
on the puppet's window. `MONOPLAYER_CHAT=full` speaks the text as the account
instead: the puppet re-signs it with its own profile keys and window, and the
server's signed `player_chat` is relayed back
([#19](https://github.com/Bafbi/monoplayer/issues/19)).

The default stays `read-only` because the signed path has been proven offline
only. Three consequences once it is on: the human's own signature and session
key never reach the server; a message the server rejects arrives back as a
rejection on GlowSquidye; and the human's client receives `player_chat` from
another connection, so its per-sender signature chain is out of order. The
expectation is that the message still displays with a broken-chain marker. No
run has confirmed that, and [#13](https://github.com/Bafbi/monoplayer/issues/13)
is where it gets confirmed.

The proxy answers the backend's own acknowledgements and keeps its own
last-seen window. The human's session key and acknowledgements never reach the
backend, in any mode.

## Dialogs and configuration gates

A dialog is a server question the human answers. Monoplayer relays it to the
attached client, forwards the client's click to the server as the puppet's own
frame, and holds the last unanswered dialog: a dialog that arrives while nobody
is attached waits, and is re-sent when someone attaches in its phase. There is
no timeout and no auto-click, so a dialog is never answered by the proxy while a
human is looking at it.

Two answerers could collide, and the proxy keeps them apart. The puppet's
auto-click answers a dialog only while no player is attached, so
`MONOPLAYER_DIALOG_ACTION` now covers a headless session and nothing else. What
that headless session does with a configuration gate is
[#21](https://github.com/Bafbi/monoplayer/issues/21), and the play-dialog policy
is [#20](https://github.com/Bafbi/monoplayer/issues/20).

The code of conduct is accepted by the protocol library itself, on the puppet's
connection, before the core sees the frame. The gate therefore reaches the human
already answered, and making it a human decision needs a write-time interception
on the backend leg. That is [#21](https://github.com/Bafbi/monoplayer/issues/21).
The relay and hold path this section describes is #16.

## A followed transfer

The proxy follows the transfer on the puppet leg with handshake intent 3 and
detaches the human with a moving notice, so the server sees a normal accepting
client and the human rejoins the proxy once the puppet is warm on the target.
Keeping the human's connection and re-entering configuration on it, so the move
reads as a dimension change, is [#22](https://github.com/Bafbi/monoplayer/issues/22).
A failed target restores the previous session on the next reconnect; the local
notice is a `system_chat` from the proxy, and the toast variant is
[#15](https://github.com/Bafbi/monoplayer/issues/15).

## Known limits

- **The proxy's egress address is the one accepted difference.** The backend
  sees the proxy host, which reads as a client behind a VPN. IP forwarding is
  out of scope.
- **A detach keeps the last human's client information.** A real client's
  options survive a reconnect, so the puppet does not reset to defaults when
  the human leaves. Only a fresh proxy process starts from them.
- **Before the play login there is no cap to request.** The protocol library
  sends Client Information once in the configuration phase with its default
  view distance of 10. The puppet re-sends the packet right after the play
  login with the backend's cap, so the value the server acts on is the cap.
- **The attach replay carries the whole cached view.** The human's client stores
  every chunk the replay sends; its own render distance only changes what the
  client draws. At a backend cap of 32 that is up to 4489 chunk frames per
  attach. `cache.stats().chunkBytes` is the measured size, and shrinking the
  replay is deferred with the rest of the memory work.
- **A service with no profile keys sends unsigned chat.** The pinned
  minecraft-protocol sends an unsigned frame rather than failing, and a server
  with `enforce-secure-profile` answers that by closing the connection. The
  backend leg logs `chatCapability` once per backend connection with
  `signed: true` or `signed: false`, so a live run answers the question before
  the default is flipped.
- **The proxy answers some connection mechanics itself.** Keep-alives, teleport
  ids, chunk-batch acknowledgements, cookies, and the resource-pack status are
  per-connection, so the puppet answers its own. The server sees a client that
  behaves normally. It does not see the human's timings.

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
  human's client information never crosses the backend raw.

## What the server sees

The server's own view is measured by a Paper observer plugin that records what
the server knows about a joining client, and one command produces the whole
report:

```bash
mise run observer:run
```

It installs the plugin, runs the direct baseline join and the puppet join,
fetches the log, and compares the two views field by field. The result is
`.reports/observer-report.json`; the exit status is 1 when any field is
unexplained. The field table and the expected differences are in
[testbed-transfer.md](testbed-transfer.md#the-servers-view).

## What the testbed does and does not prove

[testbed-transfer.md](testbed-transfer.md) runs two Paper servers and the proxy
under our control, so a switch can be repeated without a menu click and the
server's view can be measured.

It does not prove:

- **Rendering, UI, or vanilla acceptance.** A protocol bot proves the wire. The
  real client is the last rung, and it is the only witness for a loading
  screen, a toast, or a dialog.
- **The live Excalia servers.** They remain the final oracle; the testbed is a
  controlled stand-in with different plugins and different network paths.
- **The client side against a direct connection.** The observer covers what the
  server knows. Today the clientbound comparison is one assertion: `N13` on the
  online rung compares the attach replay's frame cut against what a real client
  decoded (`src/ladder/state-parity.js`, run with `mise run online`). The wider
  direct-versus-proxy parity run, with the bot and the Fabric driver, is
  [#13](https://github.com/Bafbi/monoplayer/issues/13) and is not built.

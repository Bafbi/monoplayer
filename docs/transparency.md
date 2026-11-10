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
| The human's own player wears the puppet's skin | built, on by default | [#99](https://github.com/Bafbi/monoplayer/issues/99) |
| A dialog reaches the human, who answers it, and the answer reaches the server | built | [#16](https://github.com/Bafbi/monoplayer/issues/16) |
| The human answers every play dialog, and the puppet never clicks one | built | [#20](https://github.com/Bafbi/monoplayer/issues/20) |
| The human answers configuration gates, including the code of conduct | built | [#21](https://github.com/Bafbi/monoplayer/issues/21) |
| A followed transfer keeps the client connected | **not built** | [#22](https://github.com/Bafbi/monoplayer/issues/22) |
| Proxy notices reach the human as a toast | built, real-client display unverified | [#15](https://github.com/Bafbi/monoplayer/issues/15), [#62](https://github.com/Bafbi/monoplayer/issues/62) |
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

## The human's own player

The front leg authenticates the human's client as the human, so the body that
client draws is the human's own. The relayed `player_info` lists the puppet and
never the human, and a client resolves a player's skin from that player's
`player_info` entry. With no entry for its own UUID it falls back to a vanilla
default, so before [#99](https://github.com/Bafbi/monoplayer/issues/99) the human
saw steve, alex, or one of the 26.x defaults on their own body rather than their
own skin.

`skin.showPuppetSkin` (on by default, `MONOPLAYER_SKIN_SHOW_PUPPET=0` to turn
it off) writes one `player_info` `add_player` entry for the human's UUID,
carrying the textures property the backend sent for the puppet:

| Fact | Why |
|---|---|
| The property is the server's own | The proxy holds no skin. A proxy that saw no `player_info` from the backend writes no frame, and a property it cannot read is not a property it has. The property is the one the puppet's own entry carries, chosen by the UUID the config resolved for the account, so a frame that also lists other players never donates their skins |
| The entry carries no `update_listed` action | The client's tab list is its own listed set, which only that action fills, so the human's UUID gains no line beside the puppet's |
| One frame per play state, not per attach | An entry the client already holds wins over a later `add_player` for the same UUID, so a second frame for one play state would be a write nobody sees. A reconfiguration is a new play state: the client builds a new `ClientPacketListener`, whose entry map starts empty, so the frame goes out again after a transfer ([#134](https://github.com/Bafbi/monoplayer/issues/134)) |
| An unsigned property would work too | The client asks for a secure property only for players other than the one it controls. The frame carries the property as it arrived, so the proxy adds no signature and strips none |

The measured answer to the ticket's open question — does a 26.x client accept a
`textures` property signed for a different profile UUID — is yes. Three runs on
a real 26.2 client through the dev lane, with the texture the client resolved in
each case, are in [skin-verdict.md](../testdata/skin-verdict.md).

Two limits follow from the same client code. A skin change the server sends later
in the session does not reach the human, because the client keeps the entry it
holds. And a client that already holds an entry for the human's UUID would keep
that entry's skin: the proxy never lists the human, so this has not been seen.

## Chat and commands

Clientbound `system_chat` and `profileless_chat` reach the attached client live
and are never cached, so an attach shows only chat that arrives after it.

The human's own chat frames are never forwarded. A signature made with the
human's key is invalid on the puppet's connection, and its offset means nothing
on the puppet's window. `MONOPLAYER_CHAT=full` speaks the text as the account
instead: the puppet re-signs it with its own profile keys and window, and the
server's signed `player_chat` is relayed back
([#19](https://github.com/Bafbi/monoplayer/issues/19)).

`MONOPLAYER_CHAT=commands` speaks the human's commands and keeps their chat
text dropped. It exists because a human attaching to their own account needs
`/profil`, `/msg`, and `/tp` to reach the server, and it is the mode for a
human who does not want the account talking in open chat
([#97](https://github.com/Bafbi/monoplayer/issues/97)). Its clientbound side is
`read-only`, so the human reads exactly what that mode shows: command feedback
arrives as `system_chat` and displays, and a reply the server sends as signed
player chat does not. Which frame a whisper takes is not settled here: no run
has shown it, and a real client on a repo-deployed lane is what would.

The default stays `read-only` because `full`'s signed path has been proven
offline only. Three consequences once `full` is on: the human's own signature and session
key never reach the server; a message the server rejects arrives back as a
rejection on GlowSquidye; and the human's client receives `player_chat` from
another connection, so its per-sender signature chain is out of order. The
expectation is that the message still displays with a broken-chain marker. No
run has confirmed that, and [#62](https://github.com/Bafbi/monoplayer/issues/62)
is where a real client confirms it. The protocol bot cannot: it decodes frames,
never renders them.

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

Two answerers could collide, and the proxy keeps them apart. A play dialog is
never the puppet's: `decideDialogAutoAnswer` refuses every play dialog, attached
or not, so the human answers it or it waits
([#20](https://github.com/Bafbi/monoplayer/issues/20)). The auto-click survives
for one case only, a configuration gate with no player attached, and it stands
down as soon as a player can answer. What that headless configuration session
does is [#21](https://github.com/Bafbi/monoplayer/issues/21).

The code of conduct is the one gate the protocol library answers itself. Its
configuration handler writes `accept_code_of_conduct` as soon as the gate
arrives, before the core sees the frame. The backend leg therefore wraps that
connection's writer, and the accept becomes the leg's decision. While a player is
attached the library's frame is dropped, and the player answers the gate over the
relay path above. With nobody attached the leg sends the accept and logs
`codeOfConductAccepted`, so a headless session is not left at a gate. The leg
also reports that answer to the core, which therefore never holds a gate the
server already considers closed. An attached player keeps the gate as long as it
takes. The last player detaching is the second way into that headless branch: the
core asks the leg for the answer it would have given with nobody attached. The
gate is answered as the puppet and logged, so no frame pretends a player clicked
it ([#73](https://github.com/Bafbi/monoplayer/issues/73)). Neither branch has a
timeout. The relay and hold path this section describes is #16.

## A followed transfer

The proxy follows the transfer on the puppet leg with handshake intent 3, so the
server sees a normal accepting client. The default still detaches the human with
a moving notice, and the human rejoins the proxy once the puppet is warm on the
target.

The kept connection is on (`transfer.keepConnection`, default `true`). The
human keeps the socket: on the transfer intent, before the target is dialled,
the proxy writes `start_configuration` on the human's own connection, so the
loading screen replaces a frozen world immediately. The proxy then relays the
target's configuration frames and its `finish_configuration`, and then the
target's play login and join state. The client lands on the new server without
rejoining ([#22](https://github.com/Bafbi/monoplayer/issues/22)). A target the
proxy gives up on restores the pre-transfer state on that same connection.

The notice is the proxy's own: a synthetic advancement with a visible toast,
removed in the same call so the client keeps no ghost advancement, with a local
`system_chat` line as the fallback
([#15](https://github.com/Bafbi/monoplayer/issues/15)).

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

The gate is measured on the observer's own Paper, `paper-conduct`, which serves
it. Paper 26.2 refuses to start with `enable-code-of-conduct=true` unless a
`codeofconduct` folder holds at least one document, so that lane carries one, and
a real client there would sit at the screen. The G0 driver row therefore keeps the
gate off, and the observer measures the sibling lane instead.

The run reports `codeOfConduct` and `codeOfConductAccepted` as observed on both
joins: the server sends the gate, and the accept arrives on the account's own
connection when the puppet leg answers it. That is the server-side witness for the
claim above, not only the loopback rung's.

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
  decoded (`src/ladder/state-parity.js`, run with `mise run online`). The
  direct-versus-proxy comparison with the protocol bot is
  `mise run parity:run`
  ([#13](https://github.com/Bafbi/monoplayer/issues/13)). It lists frame and
  decoded-state differences and separates the expected ones from the
  unexplained. The same comparison with the Fabric driver is
  [#62](https://github.com/Bafbi/monoplayer/issues/62) and is not built.

# Transfer testbed

A deterministic two-server harness for the transfer path. The live Excalia
servers remain the final oracle; this testbed exists so a switch can be
repeated without a menu click and with both servers under our control.

## Topology

| Piece | Where | Role |
|---|---|---|
| `paper-hub` | `monoplayer-gate-b`, Paper 26.2 build 135 | the Monoplayer backend |
| `paper-sky` | `monoplayer-gate-b`, Paper 26.2 build 135 | the transfer target, `accepts-transfers=true` |
| `monoplayer-testbed` | `monoplayer`, same image and custody PVC as live | the proxy under test |
| testbed front | `monoplayer-testbed.tail41e568.ts.net:25565` | the bot or the real client attaches here |

`paper-sky` carries a world datapack (`file/testbed`) with an extra
`testbed:void` dimension type. The hub has 4 `dimension_type` entries; the
target has 5, so the target's registry differs. A plain respawn would leave
the client without that entry; the seamless switch must replace the
registries.

The transfer is triggered from the hub console:

```
rcon-cli transfer paper-sky.monoplayer-gate-b.svc.cluster.local 25565 GlowSquidye
```

No menu, no timing, no server plugin.

## Safety

The live deployment and the testbed share the GlowSquidye custody PVC, and the
token has one writer. The orchestrator therefore:

1. disables Argo automated sync for the live Application;
2. scales the live deployment to zero and waits for its pod to be gone;
3. starts the testbed;
4. on `down`, scales the testbed and Paper to zero, restores the live
   deployment, waits for it to be ready, and restores the Argo sync policy.

If a run is interrupted, run `mise run testbed:down` or restore the policy by
hand. The live front is offline while the testbed is up.

## Commands

```bash
mise run testbed:up        # live off, testbed up (leaves it running)
mise run testbed:client    # Bafbi headless client through the testbed front
mise run testbed:transfer  # RCON transfer the puppet to paper-sky
mise run testbed:registry  # compare hub/target dimension_type registries
mise run testbed:down      # stop testbed, restore the live proxy
mise run testbed:run       # up + transfer + down, always restoring
```

`testbed:up` runs the registry comparison before the client attaches. The
expected result is `hub.entries=4`, `sky.entries=5`, `same=false`.

## What it proves today

- The puppet follows the transfer with handshake intent 3; `paper-sky` accepts
  it, and the hub session ends.
- The attached client keeps its connection: Monoplayer serves the target's
  configuration and play login on the client's own socket, so the client shows
  the reconfiguration loading screen and lands on the target without rejoining
  (#22, `transfer.keepConnection`). Loopback `O33`-`O35` pin it, and this run is
  where it was first measured against a real Paper and a real client.
- With `MONOPLAYER_TRANSFER_KEEP_CONNECTION=0` the client is detached with a
  moving reason and rejoins the proxy; loopback `O21`-`O24` pin that path.
- The target's configuration registries differ from the hub's.

## What it does not prove yet

The two acceptance criteria are wider than the transfer itself:

- **Client side:** playing through the proxy should be indistinguishable from
  a direct connection, except that the identity is GlowSquidye. Today the
  human's chat is spoken as the account only in `MONOPLAYER_CHAT=full` (off by
  default), transfer detaches the client, and a play dialog waits for the human
  to answer it.
- **Server side:** the observer measures it. The proxy writes the Fabric Loader
  brand in configuration and the human's client information with the backend's
  view distance cap (loopback `O25` and `O26`,
  [docs/transparency.md](transparency.md)). The fields the server can still see
  as different are listed under [The server's view](#the-servers-view) below.

## The server's view

`tools/observer` is a Paper plugin plain Paper loads. It records what the
server knows about a joining client, one JSONL record per join, into
`plugins/MonoplayerObserver/views.jsonl`. It only reads: every listener runs at
`MONITOR` priority and never cancels or edits a packet, so the observer cannot
change what the server or the client does.

| Field | Recorded from | Expected difference |
|---|---|---|
| `player`, `uuid` | the login profile | none: the same account joins both ways |
| `address` | the socket | **the one accepted difference**: the proxy's egress address reads as a client behind a VPN |
| `brand` | `minecraft:brand` in configuration | none: the puppet announces `fabric`, and the baseline announces the same brand because it stands in for the human's Fabric client |
| `locale`, `viewDistance`, `mainHand`, `skinParts` | `settings` | none once a human has attached; the view distance is the backend's cap, not the human's render distance |
| `chatSession` | the session key registration | none: both joins register the account's own key, so the field matches. The human's key never crosses |
| `resourcePack` | the resource-pack status | none: the puppet answers its own pack |
| `transferred` | the transfer intent | none |

Anything not in that table is a finding, and the comparison fails the run for
it.

**The packet fields are members of one value object.** On 26.x, ProtocolLib
exposes the settings packet and the custom payload as a single object, not as a
row of fields: `settings fields 1: 0=ClientInformation[language=en_us,
viewDistance=10, ..., modelCustomisation=127, mainHand=RIGHT, ...]` and
`DiscardedPayload[id=minecraft:brand, data=[B@...]`. The plugin reads those
members by name (`language`, `viewDistance`, `modelCustomisation`,
`mainHand`, `id`, `data`), which is what `skinParts` and `brand` come
from. An index read is kept as the fallback for a packet shape that still carries
flat fields, and a member that is not there leaves its field absent rather than
guessed.

**Three fields this gate Paper cannot show.** The reason is the server's
configuration, not the client version. The gate Paper runs with
`enable-code-of-conduct=false` in its `server.properties`, so the server never
sends the gate and no accept can arrive. It also serves no resource pack, so no
status event fires. The report marks those three fields absent.

Turning the gate on is not a one-line change. Paper 26.2 refuses to start when
`enable-code-of-conduct=true` and no `codeofconduct` folder exists:
`Failed to start the minecraft server: java.lang.IllegalArgumentException: Code of
Conduct folder does not exist: codeofconduct`. A lane that serves the gate owes
that folder, and every real client it admits then owes the screen an answer.

The run reads both facts from the server that it measured, with
`--server` on `src/ladder/observer.js`. A reason is attached only when the read
agrees with it (see `ABSENT_FACTS`). So a server that starts serving the gate
stops excusing the field, and the report says the absence is unexplained.

Observing the gate needs a Paper that serves it. The G0 driver lane cannot be
that Paper: a real client sitting at a code-of-conduct screen never finishes
joining, and that lane is a human-witnessed run.

**Not recorded yet:** dialog interactions. The plugin has no dialog field, so a
dialog and its click are invisible to this report. The human-answer path is
[#16](https://github.com/Bafbi/monoplayer/issues/16),
[#20](https://github.com/Bafbi/monoplayer/issues/20), and
[#21](https://github.com/Bafbi/monoplayer/issues/21); recording it here is not
yet ticketed.

A connection is written more than once: the record at join, then another when
the resource-pack status arrives, because that status always comes later. The
report merges the records that share a source address into one view, so a later
field fills in what the join could not see. `node src/ladder/observer.js` is the comparison: it takes two logs, or one
log holding both joins, and prints a verdict per field.

## Running the server-view report

`mise run observer:run` produces the whole thing: it installs the plugin and
the ProtocolLib it needs into the gate Paper, restarts the server so Paper
loads them, runs the direct baseline join, runs the puppet join through
Monoplayer, fetches the log, and compares the two views. Both joins use the
throwaway-pod path in `scripts/online-cluster.sh`, so the custody is copied,
never shared, and an expired token stops the run instead of rotating the live
chain.

It refuses to run against the live namespace: measuring the live lane is not
this command, and neither is installing a plugin into it. The gate Paper is
disposable, which is why a plugin install and a restart are allowed there.

The result is `.reports/observer-report.json`, with one entry per field and the
verdict `same`, `expected`, `absent`, or `unexplained`. The exit status is 1
when any field is unexplained.

The direct baseline is the same account, not a control account. A different
account would put `player` and `uuid` in the report as differences and hide
the ones being measured.

**The baseline client is the protocol bot, not a vanilla client.** The ticket
asks for "a direct vanilla or Fabric baseline client". The bot proves the wire
and nothing about rendering, and it is what runs today. A vanilla client in
either role is not built.

## Not built yet

- A clientbound parity run: the direct bot and the proxy bot, plus the Fabric
  driver, compared frame by frame ([#13](https://github.com/Bafbi/monoplayer/issues/13)).
  `src/ladder/state-parity.js` is the comparison it will use; the orchestration
  is not written.
- A vanilla client in either role. The protocol bot proves the wire, not
  rendering or vanilla acceptance.

The real client remains the last rung: the protocol bot cannot prove rendering,
UI, or vanilla acceptance.

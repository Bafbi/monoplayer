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
- The attached client is detached with
  `This session is moving. Reconnect in a few seconds to continue.` and can
  reattach to the target through the proxy.
- The target's configuration registries differ from the hub's.

## What it does not prove yet

The two acceptance criteria are wider than the transfer itself:

- **Client side:** playing through the proxy should be indistinguishable from
  a direct connection, except that the identity is GlowSquidye. Today the
  client cannot chat or run commands, transfer detaches it, and dialogs are
  answered by the puppet.
- **Server side:** the server must see a normal GlowSquidye client. Today the
  puppet's own client brand, client information, and chat session differ from
  a vanilla client; the proxy also answers some connection mechanics itself.

The next validation layers, on this same testbed:

1. a Paper observer plugin that logs the server's view of a joining client:
   brand, locale, view distance, main hand, skin parts, chat session presence,
   resource-pack status;
2. a direct vanilla baseline on `paper-hub` for the same account or a control
   account, compared field by field with the puppet;
3. a clientbound parity run (direct bot vs proxy bot, plus the Fabric driver)
   for the client-side criterion.

The real client remains the last rung: the protocol bot cannot prove rendering,
UI, or vanilla acceptance.

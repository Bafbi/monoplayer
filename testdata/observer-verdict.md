# The server's view of the puppet: 13 fields, 12 with a value, one absent and explained

> **Record, not documentation.** Taken 2026-11-10 by `mise run observer:run`.
> Every number below belongs to that run: read it as evidence of what happened,
> never as a current claim, and do not update it to match today.

Verdict: **PASS**, `passed: true`, `observer: PASS 13 fields, 1 expected, 3 absent`
became `1 absent` once the run measured a Paper that serves the gate.
Date: 2026-11-10. Command: `mise run observer:run`, which writes
`.reports/observer-report.json`, `.reports/observer-views.jsonl`, and
`.reports/observer-server.json` (`.reports/` is gitignored).
Fact: a real Paper 26.2 build 135 sent the code-of-conduct gate, and the accept
came back on the puppet's own connection. The same server saw the account
GlowSquidye behind the proxy with the brand, settings, chat session, and skin
parts of the client it claims to be.

Lane: `paper-conduct` in `monoplayer-gate-b`, the gate-serving sibling of the G0
Paper (`deploy/driver/paper-conduct.yaml`). The joins run from throwaway pods in
namespace `monoplayer` that mount the live custody claim read-only.

## The run

```
observer-report: server facts: { "source": "server.properties on paper-conduct", "codeOfConduct": true, "resourcePack": false }
SAME         player: baseline="GlowSquidye" puppet="GlowSquidye"
SAME         uuid: baseline="73e0e19b-d4e4-4cc1-a553-a3952f0c1aed" puppet="73e0e19b-d4e4-4cc1-a553-a3952f0c1aed"
EXPECTED     address: baseline="/10.244.0.220:56158" puppet="/10.244.0.241:46344"
SAME         brand: baseline="fabric" puppet="fabric"
SAME         locale: baseline="en_us" puppet="en_us"
SAME         viewDistance: baseline=10 puppet=10
SAME         mainHand: baseline="right" puppet="right"
SAME         skinParts: baseline=127 puppet=127
SAME         chatSession: baseline=true puppet=true
SAME         transferred: baseline=false puppet=false
SAME         codeOfConduct: baseline=true puppet=true
SAME         codeOfConductAccepted: baseline=true puppet=true
ABSENT       resourcePack: baseline=null puppet=null -- the measured server reports no resource pack, so no status event ever fires

observer: PASS 13 fields, 1 expected, 1 absent (1 with a reason)
```

- `address` is the one accepted difference: the proxy's egress address.
- `brand` is `fabric` on both sides. The baseline bot announces the brand the
  proxy announces, because it stands in for the human's Fabric client (#17).
- `skinParts` and the other settings fields come from the members of the single
  value object ProtocolLib exposes for the settings packet on 26.x.
- `chatSession` is `true` on both joins: both clients registered their account's
  own session key. It read `false` before #78 fixed the write.
- `codeOfConduct` and `codeOfConductAccepted` are the point of the lane. Paper
  sends the gate because the lane carries a `codeofconduct` document, and the
  accept arrives on the account's own connection when the puppet leg answers it.
  This is the server-side witness for [#21](https://github.com/Bafbi/monoplayer/issues/21),
  which until now rested on the loopback fake (`O32`).
- `resourcePack` is absent because the lane serves no pack, and the report prints
  that reason only because it read the setting from the server itself.

## What it does not prove

The baseline client is the protocol bot, not a vanilla client, so this proves the
wire and the server's record and nothing about rendering. The kept-connection
transfer path ([#22](https://github.com/Bafbi/monoplayer/issues/22)) is measured by
the transfer testbed, not here. `resourcePack` stays unmeasured until a lane
serves a pack.

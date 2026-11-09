# Gate B custody: the puppet authenticated headlessly, and the attach check allowed and denied before play

Verdict: **PASS** on 2026-11-07T13:06:00.000Z for row `G1 — auth readiness`.
Command: the five lines the record lists. `node src/custody/cli.js device-code --account puppet --dir .secrets/puppet`, `node src/custody/cli.js status --refresh --account puppet --dir .secrets/puppet` twice, `node src/custody/cli.js whitelist attach add Bafbi --file .secrets/attach-whitelist.json`, `node src/custody/cli.js whitelist backend add GlowSquidye`, and `node src/custody/fixture-cli.js --port 25565 --file .secrets/attach-whitelist.json`.
Fact: both the allow and the deny landed at the `login` stage, so the whitelist review refused the player before any login success.

## The puppet

GlowSquidye, UUID `73e0e19b-d4e4-4cc1-a553-a3952f0c1aed`, Java owned, multiplayer allowed, auth title `00000000441cc96b` (MinecraftNintendoSwitch on Nintendo). The record notes that MinecraftJava on Win32 returned the known `prismarine-auth` titleAuth 403 and was abandoned. Cache at `.secrets/puppet/`, mode 0700 with 0600 files, gitignored, path only.

Two silent refreshes produced the same UUID and the identity line `name=GlowSquidye uuid=73e0e19b-... java=owned multiplayer=allowed authTitle=00000000441cc96b`.

## The two accounts stay apart

The player Bafbi, UUID `6eb73524-ff88-4a62-a8d0-c63905e7afba`, came from the attach whitelist name lookup. The attach whitelist names the player only; the backend whitelist names the puppet only; and the two UUIDs are distinct.

## The live attach check

The fixture ran in online mode with a real sessionserver `hasJoined` and a synchronous UUID gate in `beforeLogin`. The route was the official Fabric driver client on `nath`, through a reverse SSH tunnel to `127.0.0.1:25565`, into the fixture.

`testdata/custody-allow.log` held the allow:

```text
attachAllowed user=Bafbi uuid=6eb73524-ff88-4a62-a8d0-c63905e7afba
{"event":"attachAllowed","username":"Bafbi","uuid":"6eb73524-...","name":"Bafbi","stage":"login"}
{"event":"login","username":"Bafbi","uuid":"6eb73524-..."}
{"event":"end","username":"Bafbi","reason":"socketClosed"}
```

`testdata/custody-deny.log` held the deny, for the same Bafbi UUID against a whitelist that did not name it:

```text
attachDenied reason=not_whitelisted user=Bafbi uuid=6eb73524-ff88-4a62-a8d0-c63905e7afba
{"event":"attachDenied","username":"Bafbi","uuid":"6eb73524-...","reason":"not_whitelisted","detail":null,"stage":"login"}
```

The client showed `Failed to connect to the server — attach denied (not_whitelisted)`, captured in `testdata/custody-deny-screen.png`.

## What it does not prove

- The fixture serves login and identity only, so an allowed client disconnects on the fake registry after login. Render and movement evidence belongs to [the live front](gate-b-live.md).
- The official client was the Fabric driver instance. The unmodded witness is [the driver row](gate-b-driver.md).
- The live player and attributes response uses `privileges.multiplayerServer.enabled`, and the auth projection accepts both `enabled` and `enable`.

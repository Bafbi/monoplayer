# The puppet's skin on the human's own player: yes, a 26.2 client accepts it

Verdict: **the client accepts a `textures` property signed for a different
profile UUID**, attached to the human's own UUID. It accepts an unsigned copy
too. And the gap was larger than [#99](https://github.com/Bafbi/monoplayer/issues/99)
described: with no injection the human's own body rendered a **vanilla default**
skin, not their own account's skin.
Date: 2026-11-10.

Two runs answer it. `node src/driver/run.js --lane skin` measured the client
with a frame this repository built (`.reports/skin-report.json`). A dev-lane
image of this branch measured the product path: the proxy's own frame, delivered
by `replaySnapshot` (`.reports/skin-product-control.json`). Both runs are on a
real 26.2 client on the display host; `.reports/` and `testdata/*.png` are
gitignored.

Lane: the dev lane, `monoplayer-dev`, through two port-forwards and a reverse SSH
tunnel to the display host. The client joined `127.0.0.1:25566` on `nath`
(`svc/monoplayer`), and the puppet on that lane is the account `Wiriaw`. No run
touched `play.excalia.fr`.

## The three cases

One fresh client per case, because a `player_info` entry the client already holds
wins over a later `add_player` for the same UUID, so a second injection on one
client would measure the first.

| Case | Injected | Texture the client resolved for its own body | Verdict |
|---|---|---|---|
| control | nothing | `minecraft:textures/entity/player/slim/noor.png` | a vanilla default |
| signed | the puppet's property, signature included | `minecraft:skins/6523b6e2352be77336c291a64a22cdc1f85ac2a8` | accepted |
| unsigned | the same property, signature removed | `minecraft:skins/6523b6e2352be77336c291a64a22cdc1f85ac2a8` | accepted |

The report reads `skin answer: accepted, unsigned accepted`, `passed: true`,
3 cases, 53 s for the run.

What the injection delivered, as the driver decoded it back:

```
actions        ["ADD_PLAYER"]
entries[0]     { uuid: 6eb73524-ff88-4a62-a8d0-c63905e7afba, name: Bafbi,
                 listed: false, entryExistedBefore: false,
                 textures: [{ name: textures, signed: true }] }
frame          player_info (id 0x46), 1132 bytes, 1131 payload bytes
```

`listed: false` is the tab list half of the ticket: the client's tab list is its
own `listedPlayers` set, which only an `update_listed` action fills, so the frame
gives the human's UUID a skin and no line beside the puppet's.

## The screenshots

Each case was set to `THIRD_PERSON_BACK` and captured by the driver's own
render-target screenshot, which needs no window focus.

| Case | Screenshot (from the run) |
|---|---|
| control | `testdata/screenshot-mways5gv2mydsf-driver-1794331726745.png` |
| signed | `testdata/screenshot-mwaysjaswyckvv-driver-1794331744678.png` |
| unsigned | `testdata/screenshot-mwaysx7chyfov3-driver-1794331762690.png` |

The pictures differ where the player stands, and nowhere else: comparing each
against the control, 1.80% of pixels changed (signed) and 1.82% (unsigned), with
the busiest columns at x≈915 of 1916, the middle of the screen. Signed against
unsigned changed 0.20%, which is animation between the two captures. A default
skin against the puppet's skin is the whole difference.

## Why it is accepted

From the 26.2 client itself, decompiled from the same jar the driver builds
against:

- `ClientPacketListener.handlePlayerInfoUpdate` creates a `PlayerInfo` for every
  `add_player` entry with `putIfAbsent`, so a UUID the client does not hold gains
  an entry, and a UUID it holds keeps its own.
- `AbstractClientPlayer.getSkin()` returns `info.getSkin()` when such an entry
  exists, and `DefaultPlayerSkin.get(uuid)` when it does not. That fallback is
  why the control case shows `slim/noor` rather than the account's skin: the
  front leg never sends a `player_info` for the human's UUID.
- `PlayerInfo.createSkinLookup(profile)` passes `requireSecure =
  !Minecraft.isLocalPlayer(profile.id())`, and `SkinManager.createLookup` filters
  by `secure` only when `requireSecure` is set. The body the client controls is
  therefore the one case that does not need a secure property, which is why the
  unsigned copy works, and why the signed one works although its signature names
  `Wiriaw`.
- The signature does not bind the profile UUID: it covers the property value, so
  a Mojang-signed property verifies for any UUID. The client reported
  `secure: true` after the signed injection.

## The product path, through the proxy

```
mise run image:build                            # pushed to the Zot registry
gh workflow run image-branch.yaml --ref t3/show-puppet-skin-own-player
mise run dev:image sha-f648676                  # dev lane runs this commit
node src/driver/run.js --lane skin --case control --report .reports/skin-product-control.json
```

The control case injects nothing, so whatever the client resolves is the proxy's
doing. It resolved the puppet's skin for the human's own body:

```
self   6eb73524-ff88-4a62-a8d0-c63905e7afba Bafbi  minecraft:skins/6523b6e2… model=wide secure=true
entry  ea45ba2e-f47d-43ee-9604-b20af90be1f1 Wiriaw listed=true  minecraft:skins/6523b6e2… signed=true
entry  6eb73524-ff88-4a62-a8d0-c63905e7afba Bafbi  listed=false minecraft:skins/6523b6e2… signed=true
same skin as the puppet: true
```

That is all four acceptance criteria in one reading. The human's own body shows
the puppet's skin. The human's entry is `listed=false`, so the tab list gained no
line. The property is the server's own, signature intact, so the proxy added no
skin of its own. And the switch is what decides whether the entry exists at all:
`test/service/skin.test.js` asserts that with it off the attach writes no frame.

The proxy's own log agrees, without a client involved in the decision:

```
{"event":"puppetSkinKnown","signed":true}
```

`skinFramesWritten` in the deployment's heartbeat is the count to watch on the
live lane once this ships.

## The dev lane afterwards

The run used `ghcr.io/bafbi/monoplayer:sha-f648676`, this branch's image before
it was rebased onto `main`. The lane runs `ghcr.io/bafbi/monoplayer:main` again,
because a stale branch image is the next agent's confusion: `mise run dev:image
main` is the way back, and `mise run dev:down` stops the lane.

One note for the next run: the Zot image `scripts/build-image.sh` publishes is
not reachable from the dev namespace (`zot.deepmine-core.svc` does not resolve
there), so a dev-lane measurement goes through the branch workflow's ghcr tag.
`mise run dev:image` points the deployment at ghcr, and a tag that only Zot holds
leaves the pod in `ImagePullBackOff`.

## Live disagreed: a client's entry map belongs to one play state (#134)

Date: 2026-11-10. Live lane, `monoplayer`: the human attached twice and their
own body drew a vanilla default both times, while the proxy logged
`puppetSkinSent reason:"attach" signed:true` twice, `skinFramesWritten: 2`,
`skinFramesRefused: 0`.

What the artifacts prove, and what they do not:

- **Proved from the proxy's side.** From 20:44:28 the client held no entry the
  proxy could still add to, and the proxy wrote no second frame. Excalia moved the puppet
  37 s into the session, and a followed transfer takes the client through a
  configuration round on its own socket. Coming back to play the client builds a
  **new `ClientPacketListener`** (`ClientConfigurationPacketListenerImpl.handleConfigurationFinished`
  constructs one, and `ClientPacketListener.handleConfigurationStart` calls
  `clearClientLevel`). That listener's `playerInfoMap` starts empty. The entry the
  attach created was gone, and the per-attach `skinSent` latch read the transfer's
  replay as a second frame for the same client.
- **Not proved.** Whether the client applied the 20:43:49 frame during the 37 s
  before that round. No reading of the live client exists for that window, so the
  human's report of a default skin at the first attach is unexplained by itself.
  The second attach is not: at 20:45:11 the proxy held `Tutoriel`'s property, so
  that frame put a lobby player's skin on the human's body.

The two logs, side by side:

```
20:43:49.819  {"event":"puppetSkinSent","name":"Bafbi","reason":"attach","signed":true}
20:43:49.819  {"event":"attach","reason":"attach","replayed":667}
20:44:26.845  {"event":"backendLogin","fromTransfer":true,"backendLogins":2}
20:44:28.034  {"event":"attach","reason":"transfer","replayed":319}   <- no skin frame
20:44:28      [client log] Loaded 388 advancements                    <- a second world load
```

`skinFramesRefused: 0` is not evidence. The latch returned `already_sent`
without counting a refusal, because no frame was attempted. The replay now clears
the latch, so a reconfiguration gets the frame again. A replay that cannot write
the frame at all, because the front gave no UUID, logs `puppetSkinWithheld`. One
that has no property yet says nothing, because the property normally arrives a
moment later and the frame then goes out under `property_arrived`.

### The ticket's questions 1 and 3

Question 2, why the held property kept changing, is answered above: the proxy was
holding whichever entry came first in the frame.

**Does the live client hold an entry for the human's UUID when the frame
arrives?** No, not on the first attach. No `player_info` frame in the journal's
12 minutes carries the human's UUID. The journal lists 207 distinct UUIDs, and
none is `6eb73524-ff88-4a62-a8d0-c63905e7afba`. There is no `player_info` frame
at all in the 5 s before 20:43:49. `handlePlayerInfoUpdate` is the only writer of
that map, with `putIfAbsent`, so the attach's own frame is what created the entry.
That reading is proxy-side evidence plus the client's own code. It is not an
observation of the live client's map.

**What shape is Excalia's textures property?** The dev lane's, field for
field, and its texture loads:

| Field | Live (`GlowSquidye`) | Dev (`Wiriaw`) |
|---|---|---|
| `value` | 488 chars | 408 chars |
| `signature` | 684 chars | 684 chars |
| `signatureRequired` in the payload | `true` | `true` |
| `textures.SKIN.url` | `http://textures.minecraft.net/texture/6a135ebe…` | `http://textures.minecraft.net/texture/6523b6e2…` |
| `textures.SKIN.metadata.model` | `slim` | none |

The live URL fetches a 64x64 PNG with HTTP 200. `YggdrasilMinecraftSessionService.unpackTextures`
(authlib 9.0.75, the client's own) turns a payload into no skin only on a decode
failure, an empty textures map, or a URL outside the allowed domains, and each of
those logs a line the live client's log does not contain. The property is not the
difference between the lanes.

### The property was never the puppet's on a busy server

The live backend's `player_info` traffic carries the whole tab list. The journal
copy covers 12 minutes, and holds 520 such frames. Of those, 81 carry a textures
property, and their entries belong to **18 different players**.
`texturesPropertyOf` took the first one, so what the proxy held changed 80
times, and the puppet's own property came up **twice**. Two consequences, both
visible in the same journal:

- at the second attach (20:45:11) the proxy held `Tutoriel`'s property. The
  frame put a lobby player's skin on the human's body.
- `puppetSkinKnown` logged 83 times, where two distinct properties existed.

The 83 and the 80 are two windows. The pod's log kept running after the copy of
the journal was taken, so it holds 83 lines for 80 changes plus the frames that
arrived afterwards. The ticket's "dozens of times per second for minutes" is not
what the journal holds either: the changes come in bursts, up to four in one
millisecond when a tab list lands, and the rest of the 12 minutes is quiet.

The counts come from decoding every `player_info` frame with the vendored 26.2
data, the decoder `test/core/skin.test.js` uses. The frame count that the 520
stands on is the one the repo's own tool reports:

```bash
kubectl -n monoplayer exec <pod> -- ls /tmp/journal     # the journal to copy out
node tools/journal.mjs names player_info --dir s2c --path <copy>  # 520 frames, the count above
```

The pick is now the entry whose UUID the config resolved for the puppet, so the
log fires once per distinct property and the frame always carries the puppet's
own skin. A config that names no puppet UUID takes no skin, and `start-live`
warns about it once.

### What a lane can and cannot prove

- `mise run check` pins the shipped rule. `test/service/skin.test.js` drives a
  followed transfer and a restarted configuration round, and asserts a second
  frame each time. `test/core/skin.test.js` asserts the pick is by UUID.
- The dev lane has no transfer, which is why the three cases above passed there
  and live failed. A dev-lane run measures the frame's content, not its timing.
- The live lane needs the human: no run in this repo joins Excalia. After this
  lands, the check is one attach that lasts past Excalia's transfer:
  `skinFramesWritten` should reach 2 for one connection, and the body should keep
  the puppet's skin through the teleport.


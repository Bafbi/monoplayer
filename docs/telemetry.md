# Telemetry and packet journal

Monoplayer exports OpenTelemetry logs and metrics over OTLP/HTTP JSON, and writes an exact packet journal to NDJSON. Both are off unless their environment is set. With no endpoint and no journal directory, the process opens no socket and no file.

## Signals

| Signal | Transport | Content |
| --- | --- | --- |
| Logs | OTLP/HTTP JSON, `POST <endpoint>/v1/logs` | Lifecycle events (`start`, `attach`, `detach`, `backendLogin`, denials, shutdown). Never one record per frame. The skin reports through five events: `puppetSkinKnown`, `puppetSkinSent`, `puppetSkinRefused`, `puppetSkinWithheld`, and `puppetSkinUnidentified`. `docs/transparency.md` gives each one's fields. |
| Metrics | OTLP/HTTP JSON, `POST <endpoint>/v1/metrics` | Frame counters, attach and denial counters, replay and wire counters, heartbeat gauges. |
| Journal | Local NDJSON | Every backend and front frame, plus lifecycle events and the heartbeat's `channels` event. |

Logs are batched at 512 records or 5 seconds. Metrics are aggregated per batch and exported every 30 seconds. Both timers are unref'd. A failed export is retried once on a 5xx response or a network error, then dropped. Each attempt times out after 5000 ms. Failures never reach the product; `stats()` counts them.

## Environment

The two OTLP names are read in `src/observability/telemetry.js`. The journal
names are `envOverlay`'s in `src/service/start-live.js`, and that function is
the authority for them. A `MONOPLAYER_*` name it does not read changes nothing,
and `loadConfig` ignores it in silence. The defaults behind the journal names
live in the config document. `node src/service/monoplayer.js --print-config`
prints the values an environment resolves to.

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP base URL, for example `http://otel-collector.deepmine-shared.svc.cluster.local:4318`. Telemetry is off when unset. A trailing slash is ignored. |
| `MONOPLAYER_OTEL_ENDPOINT` | Fallback for `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `OTEL_SERVICE_NAME` | `service.name`. Defaults to `monoplayer`. |
| `OTEL_SERVICE_VERSION` | `service.version` and the OTLP scope version. Defaults to `unknown`; set it to the image tag. |
| `HOSTNAME` | `service.instance.id`. Falls back to the process id. |
| `MONOPLAYER_JOURNAL_DIR` | Journal directory. The journal is off when unset. The directory is created if missing. |
| `MONOPLAYER_JOURNAL_MAX_BYTES` | Seal threshold for one shard. A shard that would pass it seals early, so one hour cannot grow without bound. |
| `MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES` | Byte budget for the journal directory, pruned on start, after every seal, and at close. Must be at least `MONOPLAYER_JOURNAL_MAX_BYTES`. |
| `MONOPLAYER_JOURNAL_MAX_AGE_MS` | Age cap for a shard, pruned the same way. `0` leaves the byte budget as the only rule. |

`MONOPLAYER_ACCOUNT_ALIAS` is set internally from the resolved puppet alias; it becomes the resource attribute `monoplayer.account.alias`.

The collector accepts OTLP gRPC on `:4317` and OTLP HTTP on `:4318`. Monoplayer uses only the HTTP port. No OpenTelemetry package is installed; the payloads are written by `src/observability/telemetry.js` with the global `fetch`.

## Resource attributes

Every log and metric batch carries:

- `service.name`
- `service.version`
- `service.instance.id`
- `monoplayer.account.alias` when a puppet alias was resolved

The OTLP scope is `{ "name": "monoplayer", "version": <OTEL_SERVICE_VERSION> }`.

## Log records

One log record per lifecycle call to the core's `log(event, fields)` funnel:

```json
{
  "timeUnixNano": "1762560000000000000",
  "observedTimeUnixNano": "1762560000000000000",
  "severityNumber": 9,
  "severityText": "INFO",
  "body": { "stringValue": "attach" },
  "attributes": [
    { "key": "name", "value": { "stringValue": "Bafbi" } },
    { "key": "replayed", "value": { "intValue": "7" } },
    { "key": "includeConfig", "value": { "boolValue": false } }
  ]
}
```

Attribute values are strings, booleans, or integers (`intValue` is a decimal string). Nested objects are JSON-stringified into `stringValue`; non-integer numbers are stringified too. Every string is capped at 1024 characters. `undefined` and `null` fields are dropped.

### The identity on a record

The sinks stamp the identity on the records they write, so no call site composes it. `recordIdentity` and `stampIdentity` in `src/core/channels.js` decide the shape.

| Key | Where it is written | What it holds |
| --- | --- | --- |
| `account` | Every log record the service and both legs write, every OTLP log record, and every journal frame and event. | The lane's account, as one identifier: the alias custody resolved, else its UUID, else the name an offline lane joins as. A lane that holds no account writes no `account` key. |
| `body` | Every core record written while the core holds a body, every record a backend leg writes, the front leg's records about a channel that names one, every journal frame record, and the heartbeat's `channels` rows. | The body's server slug, `pickSlug(host:port)` (`src/core/picker.js`). It is the name a claim uses, and the `body` attribute of the `monoplayer.body.*` gauges. |
| `channel` | The front leg's records about a connection, and the heartbeat's `channels` rows. | The channel's id, which is the holder id the front leg gave that connection (`src/core/channels.js`). |

A key is written where the thing it names exists, and left out where it does not (#263 D2). A record written before a body exists therefore carries `account` and no `body` key. A channel the lane opened with no body, which is the lane's own connection before any claim, names no body either. A picker join is served before the client picks a server, and a picker lane dials no body until a claim does. Writing `body: null` on such a record would make "every record with a body" a query that returns records without one.

The backend leg names the body its target derives, `pickSlug(host:port)` (`src/legs/live-backend.js`, `bodySlugFor`). A connection captures the target it dials, so every record about that socket — its session, its join, its dialogs, and the end that closes it — names the body the socket dialled, even when a claim has already moved the leg to another. A record with no connection behind it, such as a constructor's, names the target it was given. A target that names no address writes no `body` key.

The core names the body it holds and never a channel. A channel is the front leg's record (`src/core/channels.js`), and the core holds none. A front-leg record names the channel its connection holds at the moment of the call, read from the registry. The records a closing connection writes name the channel that closed, which `closeChannel` hands back for them. A picker client holds no channel until its claim or its Spectate lands, so its records carry the account and its own facts, and no channel.

A record carries `channel` in the log and the journal, and never as a metric attribute. The allowed-server list bounds how many bodies there are. A channel is one connection, so a channel attribute would be one series per socket (#415, #263 D1). No metric carries a channel.

### The attach record

One `attach` record per attach, on this path and nowhere else: no extra file, no
config key, no switch. It answers one question that inference could not: why a
player could not see another player after attaching. It answers it without
storing a frame.

`name`, `reason`, `tookMs`, `replayed`, `synthesizedPositions`,
`skippedLegOwned`, `includeConfig`, `backendLogins`, and `pose` describe the
attach itself. The rest describe the attach stream, and what the dialog holder
and the pack holder offered beside it. Every field in the table is a count
except `tookMs`, which is a duration, and `reason`, which is a label. No field
is a byte size: sizes belong to `cache.stats()`, which measures what the state
cache holds rather than what one attach sent.

Each nested object arrives as **one** `stringValue` attribute holding its JSON,
so the 1024-character cap applies to that attribute. `attributeValue`
stringifies an object, which means there is no `domains.config` attribute to
query. Parse the `domains`, `entities`, `players`, `dialogs`, or `packs`
attribute instead.

| Field | Kind | Meaning |
| --- | --- | --- |
| `reason` | label | The path that wrote the record: `attach`, `early_attach`, `transfer`, `reconfigure`, or `transfer_restored`. |
| `tookMs` | duration, milliseconds | Time `replaySnapshot` took, measured with the clock the core was built with, or `Date.now` when the core has none. |
| `replayed` | count, frames | Frames the attach stream wrote. The synthesized position is not one of them, and `synthesizedPositions` counts it. |
| `domains.config` | count, frames | Frames from the configuration phase. 0 when the attach leaves that prefix out, as the warm and early attaches do. |
| `domains.prefix` | count, frames | Frames from the join prefix. A state cache that is not warm yet files every play frame here, so this is large before warm and small after. |
| `domains.chunks` | count, frames | Chunk frames (`map_chunk`, `unload_chunk`). |
| `domains.blocks` | count, frames | Block-mutation frames. |
| `domains.entities` | count, frames | Entity-state frames from the entity domain. |
| `domains.inventories` | count, frames | Window base and slot frames. |
| `domains.latest` | count, frames | Frames from the domain that keeps only the newest frame per name (`abilities`, `held_item_slot`, `advancements`, and the rest of that set in `src/core/state-cache.js`). |
| `domains.generic` | count, frames | Frames from the generic domain, which includes `player_info` and the relative-move frames. Each row counts the frames its domain stores. The attach stream sends the relative-move frames right after the entity domain's, in capture order, and they are still counted here. |
| `entities.replayed` | count, bodies | Distinct entity ids the attach stream gives a spawn, by `spawn_entity` or its pre-rename spelling `add_entity`. This counts bodies where `replayed` counts frames, and `players.bodies` is a subset of it. |
| `entities.withoutSpawn` | count, frames | `entity_metadata` frames naming an entity id with no spawn earlier in the same attach stream. **Non-zero is #213's defect, measured**: the client was told about a body it never saw appear. A spawn in the join prefix counts, so a pre-warm attach is not reported as every body missing one. A metadata frame whose decoded `entityId` is absent cannot be attributed and is not counted. |
| `players.info` | count, identities | Distinct player identities the `player_info` frames leave listed: the tab list this client is told about. A frame that unlists one removes it, and an update that carries neither `add_player` nor `update_listed` cannot list one on its own. |
| `players.bodies` | count, bodies | Distinct spawned ids whose spawn carried a UUID that tab list names, so a body for a player the tab list lists. A body the tab list does not name is not counted, which makes `players.info` above `players.bodies` the shape the report in #218 describes. |
| `dialogs.held` | count, dialogs | Control dialogs held for a client when this attach ran. The holder keeps one at a time, so this is 0 or 1. |
| `dialogs.resent` | count, dialogs | Dialogs this attach wrote to the client: 0 or 1. Written after the attach stream, as a dialog always is. |
| `packs.held` | count, packs | Resource packs the holder kept for the play state when this attach ran. |
| `packs.resent` | count, packs | Packs this attach wrote to the client. Written after the attach stream, as a pack always is. |

There is no `dialogs.answered`, `packs.answered`, or `packs.relayed` field. The
record is written before the client can answer anything, so all three would be 0
by construction. Those numbers live in the heartbeat's `metrics` object, which
carries the core's own counters: `controlDialogsAnswered`,
`controlDialogsAnsweredOnDetach`, `resourcePackAcks`, `resourcePacksRelayed`,
and `resourcePacksAnsweredOnDetach`.

## Metrics

Every sum is cumulative (`aggregationTemporality: 2`) and monotonic. A series keeps the start time it was first seen at, and each export re-sends its running total. Values for the same name and attributes are summed before export. Gauges keep the last value in the batch and carry no temporality or monotonicity fields.

| Name | Type | Attributes | Meaning |
| --- | --- | --- | --- |
| `monoplayer.frames` | sum | `direction` (`s2c`/`c2s`), `state`, `name`, `result` | Backend frames received and front frames delivered. `result` is `forwarded` or `dropped` on `c2s`, and `forwarded` or `ignored` on `s2c`. |
| `monoplayer.attaches` | sum | `player` | Successful attach attempts. |
| `monoplayer.denials` | sum | `reason`, `phase` | Login-start denials. `phase` is `login_start` and no other value: the verify-session denial has had no path since #691. |
| `monoplayer.replay.frames` | sum | `player` | Frames written by the join replay per attach. |
| `monoplayer.skin.frames` | sum | `player` | `player_info` skin entries written, and `player` names the player each entry names. Three kinds (#614, #618): the body's entry names the puppet and is written to every channel of the body on every pass, the driver's own entry names the driving player once per play state, and a spectator's own entry names that spectator and is written once, on its own channel, carrying the skin its account's answer carried. |
| `monoplayer.wire.rejected` | sum | none | Increase of `front.wireStats.rejected`, sampled at each heartbeat. |
| `monoplayer.preauth.refused` | sum | `reason` | Increase of `front.preAuthRefused`, sampled at each heartbeat: a front connection refused because the pre-auth window was full (#201). The only reason today is `preauth_connection_cap`, and the front leg's JSONL `preAuthRefused` line is the same refusal with the cap and the count in it. A leg's log does not go through the core, so this sum and that line are the two records of one decision. |
| `monoplayer.preauth.expired` | sum | `reason` | Increase of `front.preAuthExpired`, sampled at each heartbeat: a front connection the pre-auth deadline destroyed because it had not left the window in time (#205). The only reason today is `preauth_deadline`, and the leg's `preAuthExpired` line is the same close, one line per expiry. It is a separate sum from `preauth.refused` because the two answer different questions: a refusal means the window was full, and an expiry means a socket sat in it and never left. |
| `monoplayer.picker_picks` | sum | `server` | One pick a picker recorded, written at the click (#257). `server` is the picked row's `host:port`, which the allowed-server list bounds. The service's `pickerPickRecorded` line is the same pick as product state. |
| `monoplayer.picker_verbs` | sum | `verb`, `server` | One answer to a chosen server's own dialog (#266): `claim`, `spectate` or `disconnect`. `server` is the server the answer named, as `host:port` from the allowed-server list. The front's `pickerVerb` line is the same answer as a frame event. |
| `monoplayer.picker_claims` | sum | `outcome` | One claim click's outcome (#290), written only for a `claim` verb. `outcome` is `granted`, `repeated` or `refused`: a repeat granted a claim the holder already had, so it is its own word and not a second grant. The player, the holder and a refusal's reason go on the `pickerVerbRecorded` record and never on this series (#415); the refusal reasons are summed under `front.pickerRefusalsByReason` in the heartbeat (#417). A release is not here, because no front-leg callback reports one to the service. |
| `monoplayer.attached` | gauge | none | `1` while a client is attached. |
| `monoplayer.warm` | gauge | none | `1` when the state cache is warm. |
| `monoplayer.backend.logins` | gauge | none | Current backend login count. |
| `monoplayer.cache.frames` | gauge | none | The entries the cache domains hold, summed over `stats().sizes`. Every domain contributes frames except `entities`, which contributes the number of entities it tracks, so read this as one number for "how full is the cache", not as a frame count. |
| `monoplayer.body.frames` | gauge | `body` | One body's copy of the sum above. The served body's figure is the same number under both names, because `monoplayer.cache.frames` was charted before a lane held more than one body. |
| `monoplayer.body.chunkBytes` | gauge | `body` | The bytes one body's chunk ring holds now, the same figure its heartbeat row carries. |
| `monoplayer.body.warm` | gauge | `body` | `1` when one body's cache is warm. |

Every gauge in this table is emitted at startup and on the 30-second heartbeat. The three that name a body emit one data point per body the process holds, so a reader that wants the served body alone filters on `active` in the heartbeat row beside it.

## The heartbeat record

Every 30 seconds the service appends one `heartbeat` record to its JSONL log. It is the lane's periodic readout: the record an operator reads to see the lane as it stands, and the one that has been misread.

The `Kind` column is why this table exists, and it holds two words.

- **cumulative**: the field only grows over the life of the process. Subtract the previous heartbeat to get what happened in between. Divide the value itself by 30 s and you have a wrong rate.
- **gauge**: the value at the instant the record was written, whatever its type. It rises and falls, and it says nothing about history.

Every cumulative field counts from the start of the process except the top-level `backendFrames` object, which counts from the current backend connection.

| Field | Kind | Meaning |
| --- | --- | --- |
| `attached` | gauge | A client is attached right now. |
| `warm` | gauge | The cache is warm. A reconnect to a new target resets it, so it falls as well as rises. |
| `backendLogins` | cumulative | Backend logins this process completed. |
| `metrics.backendFrames`, `.configFrames` | cumulative | Backend frames seen, and the configuration-state share of them. |
| `metrics.framesCached`, `.framesReplayed`, `.positionsSynthesized` | cumulative | Frames put in the cache, frames replayed on attach, and positions invented for the join. `framesCached` climbing is not resident growth: the chunk ring is bounded, and `sizes` says what is held now. |
| `metrics.serverboundForwarded`, `.serverboundDropped`, `.serverboundNotAttached`, `.serverboundByName.*`, `.serverboundDroppedByName.*` | cumulative | Client frames relayed to the backend, refused, or dropped because no client was attached, split by frame name. |
| `metrics.clientboundBlocked`, `.clientboundBlockedByName.*`, `.clientboundUnclassified` | cumulative | Backend frames the proxy withheld from the client, split by name, and the ones it could not classify. |
| `metrics.chatBlocked`, `.chatRelayed`, `.chatSent` | cumulative | Chat frames blocked, relayed from a client, and sent by the proxy. |
| `metrics.attaches`, `.attachesConfiguring`, `.denials`, `.frontKicks` | cumulative | Attaches, attaches that landed in configuration, login denials, and clients the proxy kicked. |
| `metrics.configFramesRelayed`, `.configFramesReconfigured` | cumulative | Configuration frames relayed, and replayed after a reconfiguration. |
| `metrics.transfersFollowed`, `.transfersSeamless`, `.transfersBlocked`, `.transfersRefused` | cumulative | Transfers followed, transfers carried on the same connection, frames blocked during one, and transfers refused. |
| `metrics.reconfigurationsStarted`, `.reconfigurationsCompleted`, `.reconfigurationsRestored`, `.reconfigurationRefusals`, `.lateFramesAfterHandover` | cumulative | Reconfiguration attempts, completions, restores to the previous server, refusals, and frames that arrived after the handover. A transfer that keeps the client's connection is the same machine that restarts a client's configuration phase, so both count here (#22). |
| `metrics.noticesSent`, `.noticeFallbacks`, `.noticeGhosts`, `.brandAnnounced` | cumulative | Proxy notices written, fallbacks when the verbatim form failed, ghost states answered, and brand announcements. |
| `metrics.skinFramesWritten`, `.skinFramesRefused` | cumulative | `player_info` skin frames written and refused (#99). |
| `metrics.virtualPlayersAnnounced`, `.virtualPlayersSpawned`, `.virtualPlayersMoved`, `.virtualPlayersDespawned`, `.virtualPlayersRefused` | cumulative | Frames written for a virtual player: a `player_info` that names one so a client will place it, the `spawn_entity` that gives it a body, an `entity_teleport` that follows it, the `entity_destroy` that ends one spawn, and the frames the leg refused (`src/core/virtual-players.js`, #635, #636). Each is counted at the delivery site and only after the leg answered that a socket took it, so a frame no socket took is in the last field and none of the others: one the leg refused, and one the proxy could not build. A frame is per channel, so one puppet watched by two spectators is two spawns: this says what clients were told, not how many players exist. The announcement is written for the players the skin path does not name, which is every channel's own player and not the puppet (#614 writes that entry), and it rides with the spawn because a client refuses a player body whose UUID it holds no entry for. The entity a spectator is told about is not in the body's state cache and not in `players.bodies` (`src/core/replay-summary.js` counts the replay), so a lane's panel row for a body with no spawn is unchanged by these. |
| `metrics.resourcePackAcks`, `.resourcePackAckFailures`, `.resourcePacksHeld`, `.resourcePacksRelayed`, `.resourcePacksResent`, `.resourcePacksAnswered`, `.resourcePacksRemoved`, `.resourcePacksAnsweredOnDetach`, `.resourcePacksWithheld` | cumulative | Pack handling, counted as events: acknowledgements and the acknowledgements that failed, hold events, relays, resends, answers, removals, answers on detach, and packs withheld (#98). `resourcePacksHeld` counts hold events, not the packs held now. `resourcePacksResent` is one held pack written to a client that arrived later: a driver's replay and a spectator's landing, and a configuration-phase pack offered to a spectator in play (#614). |
| `metrics.controlDialogsShown`, `.controlDialogsCleared`, `.controlDialogsRelayed`, `.controlDialogsHeld`, `.controlDialogsResent`, `.controlDialogsAnswered`, `.controlDialogsPuppetAnswered`, `.controlDialogsAnsweredOnDetach` | cumulative | Code-of-conduct dialogs shown, cleared, relayed, held, re-sent, answered, answered by the puppet, and answered on detach (#73). |
| `metrics.clientSettingsSent`, `.clientSettingsRewritten`, `.clientSettingsFailed` | cumulative | Client Information frames sent, rewritten, and failed. |
| `metrics.bundleDelimitersDropped`, `.nonPlayFramesIgnored` | cumulative | Bundle delimiters dropped, and non-play frames ignored. |
| `sizes.{prefix,config,chunks,blocks,entities,inventories,latest,generic}` | gauge | What each cache domain holds now. All but `inventories` count frames; `inventories` counts the window map plus its slot map, so it includes slots that a base frame will overwrite and never replay. The `cacheStats` line readiness writes until the lane is ready carries the same `sizes` object, so the boot numbers and the heartbeat numbers have one shape. |
| `chunkBytes` | gauge | Bytes the chunk ring holds now: the sum of its `buffer.length`. Before the cache is warm, chunk frames sit in the join prefix instead, so `0` here does not mean the target sent no terrain. The `backendViewDistance` line writes the same figure at backend login, before any terrain arrived, so every live record of that line has read 0. |
| `account.alias` | gauge | The puppet's account alias as resolved at startup, or `null` when the lane runs on the raw `cacheDir` override, which resolves no account. It is a string: gauge means the value at this instant, as it does for the numeric fields beside it. |
| `account.expiresAt` | gauge | Epoch milliseconds when the puppet's Minecraft (`mca`) token expires: the cache's `obtainedOn` plus `expires_in`, the same projection `node src/custody/cli.js status` prints. Read at each heartbeat, so a token refresh moves it. `null` when the custody cache does not say, which is not the same as "no expiry". |
| `front.denied`, `front.allowed`, `front.attaches` | cumulative | Login-start denials, allows, and attaches. |
| `front.pickers`, `front.pickerPicks` | cumulative | Joins a picker was served to because the lane had no backend session, and picks the picker recorded (#257). A picker join is not a denial, so `front.denied` does not count it and these two are its only counters. A join the lane then ends because it has no row to offer is counted here and under `front.pickerRefusalsByReason` as `empty_offer`: it was served, and then the picker had nothing to give it (#670). |
| `front.pickerClaims` | cumulative | Claims the picker granted, one per body taken (#267). The holder clicking again is one claim and not a second, so a repeat does not move this number: `monoplayer.picker_claims` carries that case as `outcome: repeated`. A release is not counted here; it is the `pickerClaimReleased` line below. |
| `front.pickerRefusals`, `front.pickerRefusalsByReason.*` | cumulative | Picker refusals: the total, and the same count keyed by the reason that refusal's own record carries (#417). A request the lane turned down and a picker it could not give are both here, which is why `picker_unavailable` and `empty_offer` sit beside `unknown_server` and `disconnect_claimed`. The client is ended by the picker's own verbs; the leg's `spectate()` seam returns the sentence to its caller, which decides whether to show it. One function writes both, so the total is the sum of the map. The keys are a closed set the leg already writes. From a click it could not read: `unknown_id`, `malformed`, `unknown_verb`. From a click naming a server the lane does not offer: `unknown_server`. From a lane with no row to offer: `empty_offer`, and `pickerEmpty` carries it with the offer's own cause in `offerReason`, which is the parser code that names the file to repair (#372). From a dialog it could not write: `picker_unavailable`, and the failing dialog's own record carries that reason and the sentence the client was told, so a reader greps `pickerDialogFailed` or `pickerServerDialogFailed` and needs no second line to learn why (#670). From the claim (`src/core/claims.js`): `body_claimed`, `claim_held`. From the Disconnect verb, when a claim holds the body: `disconnect_claimed`. From the Spectate verb, before the body is handed over: `no_spectator_sink`, `unwatchable`, `picker_off`, `no_body`, `body_not_served`, `body_down`, `body_not_warm`. From the Spectate verb after the answer allowed it, every one of them through the one closure `landSpectator` refuses through (#435): `channel_refused`, `no_cached_configuration` (the body's configuration replay wrote no frame), `finish_failed` (the frame ending the client's phase was not written), so a Spectate that was allowed and then refused counts like one refused at the answer. The leg's `spectate()` seam answers `no_client` when no connection holds the name it was given, and that counts nowhere: the sentence it returns reaches no client. A reason past the cap `MAX_REFUSAL_REASONS` (`src/legs/live-front.js`) lands in `other`, and a refusal that carried no reason counts as `unknown`. This map and the service's packet-name maps count through `bumpBounded` (`src/core/bounded-counter.js`), so an empty key and the overflow bucket behave the same on either side (#438). |
| `front.pickerDisconnects`, `front.pickerDisconnectsRefused` | cumulative | Picker Disconnect verbs asked for a body: the ones that ended it, and the ones refused because a claim held it (#261). A verb that ended no body is neither, and the answer's own reason says why: a lane with no core answers `no_body_sink`. `pickerDisconnectsRefused` is the same refusals as this map's `disconnect_claimed`, counted by the same helper, so no branch moves one without the other (#616). |
| `front.policyRefused`, `front.stateRefused` | cumulative | Clientbound frames the policy refused to pass to the client, and frames refused because the client's protocol state could not parse them. |
| `front.reconfigurations`, `front.reconfigured` | cumulative | Reconfiguration attempts and completions. |
| `front.reconfigurationFramesFlushed`, `front.reconfigurationFramesDropped` | cumulative | Held configuration frames flushed when the client acknowledged, and held frames dropped when the queue overflowed. |
| `front.preAuthRefused` | cumulative | Connections refused because the pre-auth window was full. |
| `front.preAuthExpired` | cumulative | Connections the pre-auth deadline destroyed. |
| `front.preAuthInWindow` | gauge | The one gauge in that group: connections accepted and not yet past the attach whitelist. |
| `wire.checked`, `wire.rejected`, `wire.byState.*` | cumulative | Frames the wire checker inspected, the ones it rejected, and the split by protocol state. |
| `wire.lastFailure` | gauge | The most recent rejection, or `null`. |
| `backendFrames.frames`, `.swallowed`, `.bundledFramesRelayed`, `.bundledDelimiters`, `.names.*` | cumulative | The backend forwarder's frame counts and its per-`state/name` totals, for one connection. It restarts at 0 on each reconnect, so a difference across one is not a rate. It is `null` until the first connection of the process, and it keeps the last connection's figures after that connection closes. |
| `telemetry.requests`, `.retries`, `.failures` | cumulative | OTLP posts attempted, retried, and failed. |
| `telemetry.logs.{accepted,sent,dropped,batches}`, `telemetry.metrics.{accepted,sent,dropped,batches}` | cumulative | Export counts, per signal. |
| `telemetry.logs.queued` | gauge | Log records buffered for the next flush. |
| `telemetry.metrics.queued` | cumulative | **The number of distinct telemetry series**, not a queue depth. It is `pending.size`, one entry per kind, name, and attribute set. Nothing ever removes a series, so it only grows, and the difference between two heartbeats is the series that appeared. |
| `telemetry.lastError` | gauge | The most recent export error, or `null`. |
| `telemetry.enabled` | gauge | Whether telemetry is on. It never changes after startup. |
| `journal.frames`, `.events`, `.bytes` | cumulative | Frame records and event records written, and bytes appended. `bytes` is written, never the volume's footprint. |
| `journal.pruned`, `.prunedBytes`, `.sealed` | cumulative | Files and bytes retention removed, and shards sealed. A seal happens when the hour turns, when the next record would pass `MONOPLAYER_JOURNAL_MAX_BYTES`, and at close. |
| `journal.skipped`, `.dropped`, `.truncated`, `.errors` | cumulative | Frames the skip and secret name lists left out, frames the name policy dropped (the entity stream), frames cut down to a header because they passed 8192 bytes (counted whether or not the write lands), and failures in the journal's own file work: opening a shard, sealing, pruning, or writing. A directory the process could not create reports `disabledReason` and counts nothing here, so `errors: 1` does not mean a record was lost. |
| `journal.dirBytes` | gauge | The footprint of the journal's own files, measured at this heartbeat. It leaves out other names in the directory, and it is `null` when the listing throws. |
| `journal.enabled`, `.disabledReason`, `.dir` | gauge | Whether the journal is on, why it is off, and its directory. A write that hits a full volume turns `enabled` to `false` and sets `disabledReason` mid-run. |
| `journal.file` | gauge | The shard written most recently. The directory can hold one more shard per kind beside it, and a seal moves this to the next one. |
| `journal.freeBytes`, `.requiredBytes` | gauge | Present only on a journal disabled before its first write: the bytes free on the volume and the budget it needed. Both are `null` when the reason was not a full volume. A journal that stops mid-run for a full volume sets `disabledReason` and carries neither field. |

### The per-body and per-channel groups

The `bodies` and `channels` objects are the measurements a cap is decided from
(#415). `bodies` holds one row per body the process has a cache for (#260), and
`channels` one row per channel the front leg holds open (#269). Every field is read at the heartbeat, so every
one of them is a value at one instant; the ones that only grow carry `cumulative`
in the `Kind` column and say so there. These two tables use a third word, `label`,
for the fields that name something rather than count it. The heartbeat table above
keeps the two the section is built on.

The registry holds caches, not stages. A body's row therefore says what its cache
holds and whether it is the body the session serves. A stage per body would need a
session per body, and this process serves one at a time (`src/core/body-caches.js`),
so the top-level `warm` and `attached` describe the served body only.

| Field | Kind | Meaning |
| --- | --- | --- |
| `bodies[].body` | label | The body's server slug, the name a claim uses and the `body` attribute of the three `monoplayer.body.*` gauges. The allowed-server list is what bounds how many rows there are, so this is a bounded attribute and a channel is not. |
| `bodies[].active` | gauge | This body is the one the session serves: the body whose cache `core.cache` returns. Exactly one row carries `true`. |
| `bodies[].warm` | gauge | This body's cache is warm. |
| `bodies[].frames` | gauge | The entries this body's cache holds now, summed over its `stats().sizes` the way `monoplayer.cache.frames` sums the served body's. |
| `bodies[].chunkBytes` | gauge | The bytes this body's chunk ring holds now. Before the cache is warm the chunk frames sit in the join prefix, so `0` here does not mean the body sent no terrain. |
| `bodies[].framesCached` | cumulative | Frames this body's cache kept, from the cache's own counter. It starts at 0 when the cache is created, which is the first time the process serves that body. |
| `bodies[].framesDropped` | cumulative | Frames this body's cache discarded instead of keeping. Every frame the cache was offered falls in one of these two, so their sum is what that body's cache saw. |
| `bodies[].claimMs` | gauge | How long the claim on this body has been held: now minus the moment the picker recorded it. **Absent when no claim stands.** A body nobody claimed has no claim age, and a `null` would make "every body with a claim age" a query that returns the ones without (#263 D2). |

| Field | Kind | Meaning |
| --- | --- | --- |
| `channels[].channel` | label | The channel's id, which is the holder id the front leg gave that connection. |
| `channels[].body` | label | The body this channel was delivered. **Absent** for a connection the lane admitted without a claim, which is the lane's own body, and a claim on that body is recorded against its slug, so the two rows never join on this field. |
| `channels[].role` | label | `driver` or `spectator`. One body carries one driver (src/core/channels.js). |
| `channels[].ageMs` | gauge | How long this channel has been open: now minus the moment the front opened it. A driver's channel opens at its landing, after the claim, so this is not the claim's age: `claimMs` is. Absent when the leg stamped no open. |
| `channels[].frames` | cumulative | Frames written to this channel since it opened. |
| `channels[].play`, `channels[].configuration` | cumulative | The same count split by the protocol state each frame was written in. Their sum is `frames`. |
| `channels[].bytes` | cumulative | The bytes those frames took, counted where the frame is written (`src/core/channels.js`, `noteDelivery`). It is the length of every frame the leg held a buffer for: the body stream, its replay, and the cached configuration. **It leaves out the frames the leg writes as a packet object**, because the library serializes those and the leg holds no buffer to measure. Those are the synthesized position, the skin and a notice, at most one of each per connection; `game_state_change` and `abilities`, which the core writes to a spectator's channel when it lands; and a virtual player's spawn, moves and despawn (`src/core/virtual-players.js`, #635), which arrive at the rate of one move per coalescing window while the body moves. A spectator's row is therefore short by those two plus every virtual-player frame it was sent, and no row is short by anything else. The frame count beside it is not short: a packet-object write is counted where it is written. |
| `channels[].replays` | cumulative | Replays this channel was handed. A channel holds one at most, so this is 0 or 1. |
| `channels[].spectators` | gauge | The spectator channels on this body, this channel included when it is one. |
| `channels[].claimMs` | gauge | How long the claim on this channel's body has been held: now minus the moment the picker recorded it. **Absent** on a spectator's row: a spectator holds no claim, so there is no age to report, and a zero would read as one held for no time. |

The channel rows are also written to the packet journal, as one `channels` event per
heartbeat: `open` is how many channels the record holds, and `channels` is the rows
above at that instant. A frame record names the body it crossed and no channel, so
this event is the journal's only record of which connection was sent what.

A key is written where the thing it names exists, and left out where it does not:
`body`, `ageMs` and `claimMs` are the three that can be absent (#263 D2).
`channel` and `role` are always written, because a row is always a channel with a
role. The rest are counts, and a count of nothing is `0`.

Two measurements #415 names are not carried here. Per-body reconnects with a reason
needs `src/core/session.js`, which drops the reason before the caller that dials
sees it. A per-body frame-out total was refused on purpose (#415): a counter beside
the three write sites could total a body, but the total a cap needs is what a body
*outlived*, and a channel that closed takes its delivered count with it. That sum
would be short by an amount nothing can name, so the channels group is the honest
form of the number instead.

The four the front leg took (#417) are not rows here, and each is written where the
thing it measures exists.

A channel's bytes are on its own row above. The dialog's size and the time from
login to a pick are on the records of the connection they belong to, because a
picker client holds no channel until its claim or its Spectate lands, so it has no
row in this group. The `pickerDialog` line carries `bytes`, the encoded frame the
join was shown, measured from the one encode that also wrote it. The `pickerPick`
line carries `loginToPickMs`: the time from that connection's login to its pick. A
join on a player name could not say that, because two picker connections of one
account read the picker at once. The refusals are the one lane-wide number of the
four: a map by reason under `front` in the heartbeat table above, where every front
counter lives.

The heartbeat also carries the front leg's own counters under `front`, which
the core cannot hold because the core never sees a socket. Abbreviated to the
six an operator watches:

```json
{"event":"heartbeat","front":{"denied":0,"allowed":1,"attaches":1,"preAuthRefused":3,"preAuthExpired":0,"preAuthInWindow":0}}
```

`preAuthInWindow` is the window as it stands at the heartbeat: the connections
accepted and not yet past the attach whitelist. A refused connection closes its
socket before that, so it never shows up in the count.

`preAuthExpired` counts the connections the deadline destroyed (#205). It is a
different number from `preAuthRefused`: a refused connection never entered the
window, and an expired one entered it and did not leave. Every expiry writes its
own `preAuthExpired` line, because the window admits at most
`preAuth.maxConnections` connections at once and so cannot produce more lines
than that in one deadline period.

Neither cap is in the heartbeat. The `preAuthRefused` line carries `reason`,
`maxConnections`, `inWindow`, and `refused`; the `preAuthExpired` line carries
`reason`, `deadlineMs`, and `expired`. Those two lines are the only place the
window's size and deadline are stated, and the panel shows each with the
timestamp of the last line that stated it.

### The start and dial records

Three kinds of record say where the lane is dialled and who it lets in, and none is
a heartbeat.

| Record | Field | Kind | Meaning |
| --- | --- | --- | --- |
| `startLive` | `version`, `front`, `backend` | label | The service version, the address the front bound, and the backend the lane starts on, which is the backend the config document asks for (#331). It is written before the first dial. A `host:port` string. |
| `startLive` | `whitelistCount` | count | Entries in the attach whitelist at startup. |
| `startLive` | `control.whitelistReload` | boolean | Whether the attach whitelist is re-read at each login, because the lane named its file (#229, #264). |
| `start` | `whitelist` | list | The core's copy of the same whitelist, one UUID per entry. Its length is `whitelistCount`. |
| `backendReconnect`, `backendReconnectFailed` | `target` | label | The `host:port` a reconnect dialled. `backendReconnect` is a dial that connected, and `backendReconnectFailed` one that did not, with `error` and no `warm`. |
| `backendReconnect`, `backendReconnectFailed` | `delayMs`, `attempt`, `backendLogins`, `followed`, `warm`, `state` | count, boolean, label | The delay before the dial, its attempt number, the logins the session completed, whether a followed transfer landed, whether the cache came back warm, and the session's state after it. |

The panel reads them to name the effective backend, the configured one, and the
whitelist's size. It shows `startLive.backend` twice: as the configured target
always, and as the effective one until a reconnect moves that. Those are two
questions that one record field answers, because the lane starts on the backend
its config document names (#331). A 400-line log tail usually predates a pod's
start, so a start record is absent from a tail more often than not.

A picker join writes its own four records, and they are the whole story of one
client that never reached a backend (#257): `pickerServed` (the recording's frame
count and the number of servers offered), `pickerDialog` (the action ids the
client was given, and `bytes`, the encoded dialog frame it was shown, absent when
the frame was never built), `pickerPick` (the id the client answered, the server it
maps to, whether that server was on the list, and `loginToPickMs`, that
connection's own time from its login to its pick, absent when the leg stamped no
login), and `pickerPickRecorded` from the service, which is the pick as product
state rather than as a frame. A picker that collapses on the way writes
`pickerEmpty`, `pickerDialogFailed`, `pickerServerDialogFailed`, or
`pickerPickIgnored`. The first three end the client with a configuration
`disconnect` the log names. `pickerPickIgnored` keeps the dialog on screen instead,
because a click the lane could not read costs the client nothing (#257), so it ends
nobody. The first three are refusals the leg counts, so their own lines carry the
reason the map is keyed by and the sentence the client was told: the call that counts
a refusal writes the record, and a site cannot count one without it (#670).
`pickerEmpty`'s `reason` is `empty_offer`, and the offer's own cause, the parser
code an operator repairs the list from, rides beside it as `offerReason` (#315, #372).

A claim is the front leg's record of one click taking one body (#267), and it
writes three lines. `pickerClaim` and `pickerClaimRefused` carry the
connection's identity and the body the click named, plus the claim report:
`granted`, `repeated`, `reason`, and `claimedBy`, the player the claim names: the
driver who stands in the way on a refusal, and the claimant on a grant. A
refusal adds the `text` the client is sent,
and its `reason` is `body_claimed` when another connection holds the body and
`claim_held` when this connection already holds one.
`pickerClaimReleased` is written when the connection that held the claim ends,
and it says who claimed the body and why the connection ended. It carries no
claim report, because a release grants nothing.

The picker's Disconnect verb writes one of two lines. A body a claim holds refuses it:
`pickerDisconnectRefused` carries the reason `disconnect_claimed`, the driver the
sentence names, the claim's holder, and the `text` the client is sent. A body nobody
holds is asked to end instead: `pickerDisconnect` carries whether the body ended, the
reason the answer gave, and the state it ended in, and the client is shown the list again.

The service writes `pickerVerbRecorded` for each answer that names a server the
lane offers. An answer naming any other server is ended as `pickerVerbRefused`
before the service is told, so it has no service record. For a claim the record
carries a `claim` object beside the verb, the server, the slug, the id and the
player: the front's own report, `granted`, `repeated`, `reason` and
`claimedBy`, each written whether or not it has a value, so an absent holder
reads as `null` and never as a missing key. That object is what
`monoplayer.picker_claims` counts, and a verb that is not a claim carries no
`claim` key, because no claim was recorded.

## Packet journal

The journal keeps 48 hours of the frames a diagnosis reads: the frames that answer player visibility, transfers, dialogs, resource packs, wire drops, and chat. It is not a replay log. It drops the entity stream and keeps terrain length-only, because at 441 frames a second a record of everything is 11 GB a day and almost none of it is read (#217).

The directory holds one shard per hour and frame kind:

| Name | Holds |
| --- | --- |
| `journal-<YYYY-MM-DDTHH>-frames-<pid>[-<n>].ndjson` | Frames with a body: the frames a diagnosis reads. |
| `journal-<YYYY-MM-DDTHH>-bulk-<pid>[-<n>].ndjson` | Terrain, length only. |
| `journal-<YYYY-MM-DDTHH>-events-<pid>[-<n>].ndjson` | Lifecycle events, and the heartbeat's periodic ones. |
| `<same>.ndjson.gz` | The same shard, sealed and gzipped. |
| `<same>.manifest.json` | What the sealed shard holds. |

The hour is UTC and comes from each record's own `t`, so a shard never holds two hours however long the process idles. `-n` appears only when one hour and kind needed more than one shard.

A shard is written plain, with `fs.writeSync`, one record at a time. It seals when its hour turns, when the next record would pass `MONOPLAYER_JOURNAL_MAX_BYTES`, or at close. Sealing gzips the shard to `<same>.ndjson.gz`, writes its manifest, and then removes the plain file. A crash mid-seal leaves the plain shard, which the reader reads. A journal stopped by a full volume leaves its last shard plain for the same reason.

Each line is one JSON record.

A frame record:

```json
{"t":1762560000123,"dir":"s2c","state":"play","name":"player_info","len":412,"account":"glowsquidye","body":"paper_25565","b64":"..."}
```

- `t` is epoch milliseconds.
- `dir` is `s2c` (backend to front) or `c2s` (client to backend).
- `state` is the protocol state the frame belongs to.
- `len` is the raw byte length.
- `account` is the lane's account, the same identifier every log record carries.
- `body` is the body this frame crossed. A frame record names no channel: one body's stream reaches every channel on it, so the channel would be a fan-out rather than a fact.
- `b64` is the raw frame bytes, base64-encoded.

Two flags replace `b64`:

| Flag | Meaning |
| --- | --- |
| `"lengthOnly":true` | The name policy never keeps this body, whatever its size. |
| `"truncated":true` | The frame passed 8192 bytes, so only the header was kept. |

A length-only record:

```json
{"t":1762560000123,"dir":"s2c","state":"play","name":"map_chunk","len":51493,"lengthOnly":true}
```

A lifecycle event record:

```json
{"t":1762560000456,"event":"liveReady","front":"0.0.0.0:25565","account":"glowsquidye","accountUuid":"...","warm":true}
```

Every event carries `account`. An event about a body carries `body` too, and the heartbeat's `channels` rows carry `body` and `channel`. The table under "The identity on a record" says which key each record carries.

The service writes `startLive`, `liveReady`, `startLiveFailed`, `shutdown`, and the heartbeat's `channels` event from `src/service/start-live.js`. The core writes none.

A picker lane dials no body before the front listens, because a claim is what dials a body. Its JSONL log carries `{"event":"backendBootSkipped","reason":"picker"}`, and its `liveReady` says `"boot":"skipped"`. That `liveReady` also reads `"backendConnected":null`, and `null` for `warm`, `configFrames` and `prefixFrames`: no body was dialled, so there is no cache to describe. A lane that dialled says `"boot":"dialled"` and the numbers of the body it dialled.

When a claim dials a body whose backend never sends the batch marker, the log carries `{"event":"warmFallback","stage":"claim"}` with `forced`, `chunkFrames`, `deliverableChunks` and `afterMs`. The landing record `claimBodyWarm` then says `"forced":true`.

### The name policy

One table decides what a frame costs. It is data in `src/observability/journal.js`:

| Policy | Names | Why |
| --- | --- | --- |
| `drop` | `entity_head_rotation`, `entity_look`, `entity_metadata`, `entity_move_look`, `entity_teleport`, `rel_entity_move`, `sync_entity_position` | The entity stream: the per-tick position and rotation deltas, plus the metadata a client merges into a body. It is 98% of the frames, and nobody replays a 25-byte delta. |
| `length` | `chunk_biomes`, `map_chunk`, `unload_chunk`, `update_light` | Terrain. About 100 KB a frame, and gigabytes a day. `len` is what a diagnosis reads from one. |
| `full` | Every other name, up to 8192 bytes | The frames a diagnosis reads, body and all. |

`spawn_entity`, `add_entity`, `entity_destroy`, and `remove_entities` stay at `full`, because a diagnosis of "present in the tab list, absent from the world" reads them.

The recorded cost: dropping `entity_metadata` removes the journal's record of exactly the domain #213 changed. Entity behaviour is observable through client parity and the attach record (#218), not through the journal.

### The manifest

One manifest per sealed shard. A reader reads it before it reads the shard:

```json
{"shard":"journal-2026-11-17T14-frames-77.ndjson.gz","kind":"frames","hour":"2026-11-17T14","from":1762560000123,"to":1762563600456,"lines":812,"bytes":74213,"gzBytes":9124,"names":{"player_info":318,"login":2},"bytesByName":{"player_info":61204,"login":290}}
```

| Field | Meaning |
| --- | --- |
| `shard`, `kind`, `hour` | The file, its kind, and the hour it covers. |
| `from`, `to` | The first and last `t` in the shard. |
| `lines` | Records in the shard. |
| `bytes` | The NDJSON the records made, before compression. |
| `gzBytes` | The sealed file's size. |
| `names` | One entry per frame name, or `event:<name>` for a lifecycle record, busiest first. |
| `bytesByName` | What each name costs on disk. This is the number the 48-hour budget rests on: the horizon holds while a kept frame averages under about 120 bytes of body. |

A shard still being written has no manifest. `node tools/journal.mjs manifest` derives one for it and marks it `"live":true`.

### Reconstruction

Records are appended synchronously in the order the frames crossed each leg. A reconstruction reads the shards hour by hour, merges the kind shards of each hour by `t`, and then:

1. Orders records by `t`.
2. Joins `s2c` and `c2s` records on `state` and `name`.
3. Matches lifecycle events to frames by `t`.
4. Matches OTLP log records by `timeUnixNano` (journal `t` × 1,000,000) and the same `event` name.

Because `t` is captured when the frame reaches the core, a client action (`c2s`) and the server response it triggers (`s2c`) are ordered by their own timestamps, not by a shared sequence number. A clock that steps backwards reorders adjacent records; the file and line order inside one shard still holds.

### Sealing and retention

A shard seals on three triggers: its hour turns, the next record would push it past `MONOPLAYER_JOURNAL_MAX_BYTES`, or the journal closes. A single record larger than the threshold is written to an empty shard, which seals on the next record.

The directory also has a budget, enforced on start, after every seal, and at close (#96):

- The oldest shards go first, in the reader's order: hour, then sequence, then kind.
- A shard older than `MONOPLAYER_JOURNAL_MAX_AGE_MS` goes even when the directory is under its byte budget. Its manifest goes with it.
- `MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES` bounds the directory. A shard being written is never pruned, because `MONOPLAYER_JOURNAL_MAX_BYTES` bounds it, so the directory holds at most the budget plus one shard per kind.
- A name that is not a journal name is never deleted.

The journal prunes itself because nothing else can see it: on the deployed lane it lives on the pod's own `emptyDir`, which dies with the pod. No CronJob or node janitor can reach it.

A seal alone deletes nothing. One measured session wrote 393.5 MB in 96.5 minutes, and journal segments filled the 1 GiB custody volume until the front CrashLooped on ENOSPC (#96). The 48-hour horizon is what dropping the entity stream buys: an hour of everything the policy keeps is about two megabytes.

The journal never shares the custody volume. It lives at `MONOPLAYER_JOURNAL_DIR`, `/tmp/journal` on the deployed lane, on its own `emptyDir` with a `sizeLimit` of `512Mi`. The deployment sets a 256 MiB budget and a 64 MiB seal threshold, so the directory holds at most 256 MiB + 3 × 64 MiB, and the limit sits above that.

**The journal does not survive a restart.** The `emptyDir` dies with the pod, so "48 hours" means 48 hours or since the last restart, whichever is shorter. Nothing durable holds frames: the JSONL log and OTLP are the durable record, and they carry events and counters, not bodies.

When its volume has no room for the budget plus one shard per kind, the journal opens no file and the service logs `journalVolumeFull` with the path, then starts the front anyway: a diagnostic artifact does not take the service down with it. A write that hits a full volume stops the journal the same way.

The heartbeat's `journal` object reports `disabledReason` when the journal is off, and `dirBytes`, the directory's own footprint.

### Privacy

The journal and telemetry never record secrets or chat content.

- Frame names `chat_message`, `system_chat`, `player_chat`, `profileless_chat`, `chat_command`, `chat_command_signed`, `cookie_response`, and `store_cookie` are skipped.
- Frame names matching `/token|secret|password/i` are skipped.
- Journal event fields and telemetry attributes whose key matches `/(token|secret|password|authorization|cookie|credential|device_code|user_code)/i` are dropped.
- String values pass through the JSONL log redaction rules, which rewrite a bearer value behind its scheme word (`Authorization: Bearer` becomes `Authorization=[REDACTED]`).
- Account UUIDs, profile names, and aliases are recorded. Tokens, passwords, and message bodies are not.

The name policy drops frames for volume, not for privacy: `stats().dropped` counts those, and `stats().skipped` counts the privacy skips.
## One command per question

Two CLIs answer the questions this file describes. Neither needs a shell
pipeline: a `grep` of a pretty-printed line is not a JSON document.

`tools/journal.mjs` reads a journal directory, one journal file, or the JSONL
log. The path defaults to `MONOPLAYER_JOURNAL_DIR`, and to `MONOPLAYER_LOG` for
`heartbeat`.

```bash
node tools/journal.mjs manifest --path /tmp/journal
node tools/journal.mjs tail 20 --path /tmp/journal
node tools/journal.mjs heartbeat --path monoplayer.jsonl
node tools/journal.mjs names map_chunk --path /tmp/journal
node tools/journal.mjs tail 1 --name map_chunk --path /tmp/journal
node tools/journal.mjs window 60 --dir s2c --path /tmp/journal
```

- `manifest` prints one line per shard: hour, time range, line count, byte
  counts, and the frames it holds. Read this first: it is how a reader skips the
  shards that hold nothing it wants, and it is the only command that checks a
  sealed shard without decompressing it.
- `tail [n]` prints the last n records, one JSON per line. The default is 10.
- `names [pattern]` prints one line per frame name, direction, and state, with
  `count`, `bytes`, `first`, and `last`. The pattern is a substring of the name.
- `window <seconds>` prints the same rows over the seconds before the newest
  frame in the journal.
- `--name`, `--dir`, and `--state` narrow every command. `names <pattern>` is
  `--name` for the summary.
- `--path` takes the directory, or one shard, which is what the manifest gives
  you. A `.ndjson.gz` shard reads the same as a plain one.

Every record the service writes ends with a newline. A terminated line that is
not JSON fails with `path:line`, so a torn record is visible instead of counted.
An unterminated last line is skipped: the service may still be writing it.

`tools/protocol.mjs` answers protocol questions from the installed data: 26.1
from the npm package, 26.2 from `vendor/minecraft-data-26.2`.

```bash
node tools/protocol.mjs packets 26.2 play toClient
node tools/protocol.mjs frame 26.2 play toClient map_chunk
node tools/protocol.mjs diff 26.1 26.2 play toClient
```

`packets` prints one `<hex id> <name>` line per frame. `frame` prints the id,
the param type, and one line per top-level field. `diff` prints the frames
added, removed, and changed, following each named type to its definition. When
the change sits in an unnamed container entry, `diff` names the branch with
`at <path>`.

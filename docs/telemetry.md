# Telemetry and packet journal

Monoplayer exports OpenTelemetry logs and metrics over OTLP/HTTP JSON, and writes an exact packet journal to NDJSON. Both are off unless their environment is set. With no endpoint and no journal directory, the process opens no socket and no file.

## Signals

| Signal | Transport | Content |
| --- | --- | --- |
| Logs | OTLP/HTTP JSON, `POST <endpoint>/v1/logs` | Lifecycle events (`start`, `attach`, `detach`, `backendLogin`, denials, shutdown). Never one record per frame. The skin reports through five events: `puppetSkinKnown`, `puppetSkinSent`, `puppetSkinRefused`, `puppetSkinWithheld`, and `puppetSkinUnidentified`. `docs/transparency.md` gives each one's fields. |
| Metrics | OTLP/HTTP JSON, `POST <endpoint>/v1/metrics` | Frame counters, attach and denial counters, replay and wire counters, heartbeat gauges. |
| Journal | Local NDJSON | Every backend and front frame, plus lifecycle events. |

Logs are batched at 512 records or 5 seconds. Metrics are aggregated per batch and exported every 30 seconds. Both timers are unref'd. A failed export is retried once on a 5xx response or a network error, then dropped. Each attempt times out after 5000 ms. Failures never reach the product; `stats()` counts them.

## Environment

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP base URL, for example `http://otel-collector.deepmine-shared.svc.cluster.local:4318`. Telemetry is off when unset. A trailing slash is ignored. |
| `MONOPLAYER_OTEL_ENDPOINT` | Fallback for `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `OTEL_SERVICE_NAME` | `service.name`. Defaults to `monoplayer`. |
| `OTEL_SERVICE_VERSION` | `service.version` and the OTLP scope version. Defaults to `unknown`; set it to the image tag. |
| `HOSTNAME` | `service.instance.id`. Falls back to the process id. |
| `MONOPLAYER_JOURNAL_DIR` | Journal directory. The journal is off when unset. The directory is created if missing. |
| `MONOPLAYER_JOURNAL_MAX_BYTES` | Rotation threshold for one journal file. Defaults to `268435456` (256 MiB). |
| `MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES` | Byte budget for the journal directory, pruned on start and after every rotation. Defaults to `268435456` (256 MiB), and must be at least `MONOPLAYER_JOURNAL_MAX_BYTES`. |
| `MONOPLAYER_JOURNAL_MAX_AGE_MS` | Age cap for a journal file, pruned the same way. `0` leaves the byte budget as the only rule. Defaults to `604800000` (7 days). |

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
| `monoplayer.denials` | sum | `reason`, `phase` | Login-start and verify-session denials. |
| `monoplayer.backend.logins` | sum | `entityId` | Backend logins counted by the session. |
| `monoplayer.replay.frames` | sum | `player` | Frames written by the join replay per attach. |
| `monoplayer.skin.frames` | sum | `player` | `player_info` skin frames written to the attaching player: one per play state that is owed one, plus one whenever the puppet's property changes while attached. |
| `monoplayer.wire.rejected` | sum | none | Increase of `front.wireStats.rejected`, sampled at each heartbeat. |
| `monoplayer.preauth.refused` | sum | `reason` | Increase of `front.preAuthRefused`, sampled at each heartbeat: a front connection refused because the pre-auth window was full (#201). The only reason today is `preauth_connection_cap`, and the front leg's JSONL `preAuthRefused` line is the same refusal with the cap and the count in it. A leg's log does not go through the core, so this sum and that line are the two records of one decision. |
| `monoplayer.preauth.expired` | sum | `reason` | Increase of `front.preAuthExpired`, sampled at each heartbeat: a front connection the pre-auth deadline destroyed because it had not left the window in time (#205). The only reason today is `preauth_deadline`, and the leg's `preAuthExpired` line is the same close, one line per expiry. It is a separate sum from `preauth.refused` because the two answer different questions: a refusal means the window was full, and an expiry means a socket sat in it and never left. |
| `monoplayer.attached` | gauge | none | `1` while a client is attached. |
| `monoplayer.warm` | gauge | none | `1` when the state cache is warm. |
| `monoplayer.backend.logins` | gauge | none | Current backend login count. |
| `monoplayer.cache.frames` | gauge | none | Total cached frames across all cache domains. |

The four gauges are emitted at startup and on the 30-second heartbeat.

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

## Packet journal

The journal directory holds files named `session-<ISO>-<pid>.ndjson`. The ISO stamp uses `-` instead of `:` and `.`. Each line is one JSON record.

A frame record:

```json
{"t":1762560000123,"dir":"s2c","state":"play","name":"map_chunk","len":412,"b64":"..."}
```

- `t` is epoch milliseconds.
- `dir` is `s2c` (backend to front) or `c2s` (client to backend).
- `state` is the protocol state the frame belongs to.
- `len` is the raw byte length.
- `b64` is the raw frame bytes, base64-encoded.

Frames longer than 8192 bytes keep the same header and replace `b64` with `"truncated":true`, so the journal stays bounded per frame while preserving order and size.

A lifecycle event record:

```json
{"t":1762560000456,"event":"liveReady","front":"0.0.0.0:25565","accountUuid":"...","warm":true}
```

The core writes `startLive`, `liveReady`, `startLiveFailed`, and `shutdown` events from `src/service/start-live.js`.

### Reconstruction

Frame records are appended synchronously in the order the frames crossed each leg. A reconstruction reads the journal files in rotation order and:

1. Orders records by `t`, then by file order for equal timestamps.
2. Joins `s2c` and `c2s` records on `state` and `name`.
3. Matches lifecycle events to frames by `t`.
4. Matches OTLP log records by `timeUnixNano` (journal `t` × 1,000,000) and the same `event` name.

Because `t` is captured when the frame reaches the core, a client action (`c2s`) and the server response it triggers (`s2c`) are ordered by their own timestamps, not by a shared sequence number. Clock changes can reorder adjacent records; the file and line order still holds.

### Rotation and retention

A file rotates when the next record would push it past `MONOPLAYER_JOURNAL_MAX_BYTES`. Rotation closes the current file, renames it to `<same>.1`, replacing an older `<same>.1`, and continues in a new file with a `-2`, `-3`, ... suffix. A single record larger than the threshold is written to an empty file and rotates on the next record.

The directory also has a budget, enforced on start and after every rotation (#96):

- The oldest files go first, in the reader's rotation order.
- A file older than `MONOPLAYER_JOURNAL_MAX_AGE_MS` goes even when the directory is under its byte budget.
- `MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES` bounds the directory. The segment being written is never pruned, because `MONOPLAYER_JOURNAL_MAX_BYTES` bounds it, so the directory holds at most the budget plus one rotating file.
- A name that is not a journal name is never deleted.

The journal prunes itself because nothing else can see it: on the deployed lane it lives on the pod's own `emptyDir`, which dies with the pod. No CronJob or node janitor can reach it.

A rotation size alone deletes nothing. One measured session wrote 393.5 MB in 96.5 minutes, and journal segments filled the 1 GiB custody volume until the front CrashLooped on ENOSPC (#96). At that rate, the 256 MiB budget the deployment sets keeps about an hour of frames.

The journal never shares the custody volume. It lives at `MONOPLAYER_JOURNAL_DIR`, `/tmp/journal` on the deployed lane, on its own `emptyDir` with a `sizeLimit` of `512Mi`. The directory holds at most the budget plus one rotating file, and the limit sits above both.

When its volume has no room for the budget, the journal opens no file and the service logs `journalVolumeFull` with the path, then starts the front anyway: a diagnostic artifact does not take the service down with it. A write that hits a full volume stops the journal the same way.

The heartbeat's `journal` object reports `disabledReason` when the journal is off, and `dirBytes`, the directory's own footprint.

### Privacy

The journal and telemetry never record secrets or chat content.

- Frame names `chat_message`, `system_chat`, `player_chat`, `profileless_chat`, `chat_command`, `chat_command_signed`, and `cookie_response` are skipped.
- Frame names matching `/token|secret|password/i` are skipped.
- Journal event fields and telemetry attributes whose key matches `/token|secret|password|authorization|cookie|credential|device_code|user_code/i` are dropped.
- String values pass through the JSONL log redaction rules, which rewrite a bearer value behind its scheme word (`Authorization: Bearer` becomes `Authorization=[REDACTED]`).
- Account UUIDs, profile names, and aliases are recorded. Tokens, passwords, and message bodies are not.

## One command per question

Two CLIs answer the questions this file describes. Neither needs a shell
pipeline: a `grep` of a pretty-printed line is not a JSON document.

`tools/journal.mjs` reads a journal directory, one journal file, or the JSONL
log. The path defaults to `MONOPLAYER_JOURNAL_DIR`, and to `MONOPLAYER_LOG` for
`heartbeat`.

```bash
node tools/journal.mjs tail 20 --path /tmp/journal
node tools/journal.mjs heartbeat --path monoplayer.jsonl
node tools/journal.mjs names map_chunk --path /tmp/journal
node tools/journal.mjs tail 1 --name map_chunk --path /tmp/journal
node tools/journal.mjs window 60 --dir s2c --path /tmp/journal
```

- `tail [n]` prints the last n records, one JSON per line. The default is 10.
- `heartbeat` prints the last `heartbeat` record of the JSONL log.
- `names [pattern]` prints one line per frame name, direction, and state, with
  `count`, `bytes`, `first`, and `last`. The pattern is a substring of the name.
- `window <seconds>` prints the same rows over the seconds before the newest
  frame in the journal.
- `--name`, `--dir`, and `--state` narrow every command. `names <pattern>` is
  `--name` for the summary.

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

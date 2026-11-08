# Telemetry and packet journal

Monoplayer exports OpenTelemetry logs and metrics over OTLP/HTTP JSON, and writes an exact packet journal to NDJSON. Both are off unless their environment is set. With no endpoint and no journal directory, the process opens no socket and no file.

## Signals

| Signal | Transport | Content |
| --- | --- | --- |
| Logs | OTLP/HTTP JSON, `POST <endpoint>/v1/logs` | Lifecycle events (`start`, `attach`, `detach`, `backendLogin`, denials, shutdown). Never one record per frame. |
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

`MONOPLAYER_ACCOUNT_ALIAS` is set internally from the resolved puppet alias; it becomes the resource attribute `monoplayer.account.alias`.

The collector accepts OTLP gRPC on `:4317` and OTLP HTTP on `:4318`. Monoplayer uses only the HTTP port. No OpenTelemetry package is installed; the payloads are written by `src/monoplayer/telemetry.js` with the global `fetch`.

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

## Metrics

Every metric uses delta temporality (`aggregationTemporality: 2`) within one export batch; values for the same name and attributes are summed before export. Gauges keep the last value in the batch and carry no temporality or monotonicity fields.

| Name | Type | Attributes | Meaning |
| --- | --- | --- | --- |
| `monoplayer.frames` | sum | `direction` (`s2c`/`c2s`), `state`, `name`, `result` | Backend frames received and front frames delivered. `result` is `forwarded` or `dropped` on `c2s`, and `forwarded` or `ignored` on `s2c`. |
| `monoplayer.attaches` | sum | `player` | Successful attach attempts. |
| `monoplayer.denials` | sum | `reason`, `phase` | Login-start and verify-session denials. |
| `monoplayer.backend.logins` | sum | `entityId` | Backend logins counted by the session. |
| `monoplayer.replay.frames` | sum | `player` | Frames written by the join replay per attach. |
| `monoplayer.wire.rejected` | sum | none | Increase of `front.wireStats.rejected`, sampled at each heartbeat. |
| `monoplayer.attached` | gauge | none | `1` while a client is attached. |
| `monoplayer.warm` | gauge | none | `1` when the state cache is warm. |
| `monoplayer.backend.logins` | gauge | none | Current backend login count. |
| `monoplayer.cache.frames` | gauge | none | Total cached frames across all cache domains. |

The four gauges are emitted at startup and on the 30-second heartbeat.

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

The core writes `startLive`, `liveReady`, `startLiveFailed`, and `shutdown` events from `src/monoplayer/start-live.js`.

### Reconstruction

Frame records are appended synchronously in the order the frames crossed each leg. A reconstruction reads the journal files in rotation order and:

1. Orders records by `t`, then by file order for equal timestamps.
2. Joins `s2c` and `c2s` records on `state` and `name`.
3. Matches lifecycle events to frames by `t`.
4. Matches OTLP log records by `timeUnixNano` (journal `t` × 1,000,000) and the same `event` name.

Because `t` is captured when the frame reaches the core, a client action (`c2s`) and the server response it triggers (`s2c`) are ordered by their own timestamps, not by a shared sequence number. Clock changes can reorder adjacent records; the file and line order still holds.

### Rotation and retention

A file rotates when the next record would push it past `MONOPLAYER_JOURNAL_MAX_BYTES`. Rotation closes the current file, renames it to `<same>.1`, replacing an older `<same>.1`, and continues in a new file with a `-2`, `-3`, ... suffix. The journal does not delete old session files; disk retention is the operator's job. A single record larger than the threshold is written to an empty file and rotates on the next record.

### Privacy

The journal and telemetry never record secrets or chat content.

- Frame names `chat_message`, `system_chat`, `player_chat`, `profileless_chat`, `chat_command`, `chat_command_signed`, and `cookie_response` are skipped.
- Frame names matching `/token|secret|password/i` are skipped.
- Journal event fields and telemetry attributes whose key matches `/token|secret|password|authorization|cookie|credential|device_code|user_code/i` are dropped.
- String values pass through the JSONL log redaction rules, with bearer values masked before redaction.
- Account UUIDs, profile names, and aliases are recorded. Tokens, passwords, and message bodies are not.

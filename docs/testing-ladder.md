# Testing ladder

The ladder orders checks from cheapest and least realistic to most expensive
and most realistic. Each rung catches a class the cheaper rungs cannot. Add the
cheapest rung that can fail for the defect you are chasing.

## Rungs

| Rung | Command | Cost | Prerequisites | Asserts | Cannot catch |
|---|---|---|---|---|---|
| 0 static | `mise run lint` | under a second | `pnpm install` | every `src/` and `test/` file parses under `node --check` | runtime behavior, protocol shape |
| 1 unit | `mise run test` | a few seconds | `pnpm install` | pure core: cache bounds, session state machine, identity gates, relay decisions, join synthesis, wire-check fixtures, offline identity, auth helpers; no sockets, no auth | socket framing, leg wiring, real timers, backend behavior |
| 2 loopback | `mise run loopback` | about 3 seconds | `pnpm install` | real front and backend legs over loopback, the node fake backend, and a real 26.1 protocol bot: attach, cached configuration replay, join order, serverbound relay, detach, reattach, deny; no auth | vanilla client acceptance, encryption and `hasJoined`, real Paper semantics, real network timing |
| 3 online bot | not built yet | minutes | live backend, G1 token custody, real account | the same shape as rung 2 through the online front leg and a live backend | still not a vanilla client (the bot uses `minecraft-protocol`) |
| 4 real client | `mise run gate-b:scenario` then `mise run gate-b:g0` | tens of minutes | Fabric driver build, SSH tunnel, live Velocity/Paper, real client, two accounts | vanilla acceptance, render, movement deltas, break/place against a real server, a real detach/reattach window | it is expensive and flaky, so it stays the last rung |

`mise run check` runs rungs 0, 1, and 2: lint, unit tests, and the offline
loopback. It is the default gate.

The frozen Gate A spike (`mise run spike`) and the Gate A scenario
(`mise run gate-a`) sit beside the ladder. They prove the two-leg relay on
loopback with the older harness. Keep them green; do not extend them.

## The loopback rung

```bash
mise run loopback
# or directly, with a custom report path
node src/ladder/loopback.js --report /tmp/opencode/loopback-report.json
node src/ladder/loopback.js --verbose
```

Exit codes: `0` all assertions pass, `1` an assertion or timeout failed, `2`
the setup before the run failed (fake backend, config, or leg construction). The runner writes `.gate-b/loopback-report.json`
(gitignored) in `finally`, including on failure. The report holds assertion
results and metadata only. It never holds frame bytes, `.secrets` paths, or
token fields.

The runner builds:

- the node fake backend on an ephemeral port;
- `createOfflineBackendLeg` (offline auth, no token custody) connected to it;
- `createOfflineFrontLeg` with the offline UUIDs of `Attach` and `Second`
  whitelisted and the puppet `GlowSquidye` deliberately not whitelisted;
- the product core, with the front leg replaying the cached configuration;
- real protocol bots for the attaching players.

### Loopback assertion contract

`R0` is the readiness precondition. The numbered checks fail the run.

- `R0` readiness is warm from `chunk_batch_finished` (never `forceWarm`).
- `O1` the first attach is allowed once, no denials, and the front leg is
  `offline-front-leg` with no `.secrets` whitelist store.
- `O2` the fake backend saw one login and `core.session.backendLogins` is 1.
- `O3` no `encryption_begin`, `compress`, or `success` frame was replayed into
  play, and the core counted at least two ignored non-play frames.
- `O4` `front.lastConfigMode` is `cached_replay`.
- `O5` the first six play frames are `login`, `game_state_change`, `position`,
  `chunk_batch_start`, `map_chunk`, `chunk_batch_finished`. A second
  `game_state_change` is allowed only after `map_chunk`.
- `O6` login `entityId` is 42, the first position is `0.5/1.62/0.5`, and the
  first chunk is `0,0`.
- `O7` no `spawn_entity` appears in the replay.
- `O8` the wire checker inspected at least five frames, including both
  configuration and play frames, and rejected none.
- `O9` the first bot recorded no leftover bytes and no client errors.
- `O10` exactly one position, one dig, and one place reached the fake backend,
  and the core forwarded at least three serverbound frames.
- `O11` sentinel `teleport_confirm`, `chunk_batch_received`, and `keep_alive`
  frames reach the core and are dropped there (`serverboundDropped` rises by
  three) and never reach the backend: the legs and the core own them.
- `O12` after detach the core is detached, keeps one backend login, records no
  fault, and retains the last pose (`2.5/1.62/2.5`).
- `O11b` a non-whitelisted bot is denied before play: no login success, no play
  frames, no client error, one front denial, and an `attachDenied` log with
  reason `not_whitelisted`. The check runs with the attach slot free; while a client
  is attached, the earlier second-attach guard answers `already_attached`.
- `O13` the second attach makes `core.metrics.attaches` 2, keeps
  `backendLogins` at 1, lands the first synthesized position at the last pose
  (`2.5/2.5`), and replays the block edit at `3,0,3` cached while detached.
- `O14` the second bot recorded no leftover bytes and the front wire checker
  still rejected nothing.

## Why the rungs exist: the B1 lesson

The first live B1 attach failed because login-phase frames
(`encryption_begin`, `compress`, `success`) had been captured into the play
join prefix. The official client rejected the replay with `add_entity ... 114
bytes extra`. That is the failure class the wire checker now covers: it parses
one clientbound frame in its declared state and fails on leftover bytes or a
packet name that does not match the state. Rung 2 keeps that check on every
raw replayed or relayed frame. The live path (`--start`) runs the same check
in warn mode: it logs and counts `front.wireStats` without kicking a player.

The checker is not a vanilla oracle. `minecraft-protocol` accepts frames a
vanilla client rejects, and it is lenient about some state transitions. Only
rung 4, the official client, proves that vanilla accepts the replay. Do not
promote a loopback pass to a product claim without that rung.

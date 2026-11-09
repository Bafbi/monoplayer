# Name the tree after the domain, not the validation stage

`gate a` and `gate b` started as validation stages in the order work happened, then became directories, filenames, exported symbols, and path references. They said when work happened, not what the code holds, so a new file had no obvious home. Directories, files, and symbols are now named after the domain concept they hold, taken from `GLOSSARY.md`, and validation stages are expressed as ladder rungs and verdicts instead.

## Considered options

- **Keep the stage names and add a glossary.** Rejected: the names still lie, and every new file still needs a conversation to place it. The glossary would describe a tree it does not govern.
- **Name the tree by architectural layer** (`transport`, `core`, `adapters`). Rejected: a layer says where code sits, not what it does. The interesting parts of the core are the state cache, the clientbound policy, attach synthesis, and the session state, and those are domain names anyway.
- **Name the tree by the protocol library or vendor** (`minecraft-protocol`). Rejected: that library is the piece we would swap if it cannot follow a protocol change, and the fallback path is Java with MCProtocolLib. A name that dies with a dependency is not a name for a home.
- **Rename the stages to numbers** (`stage-1`, `stage-2`). Rejected: the same defect with a new label. A sequence number still says nothing about what lives there.

## Consequences

- `GLOSSARY.md` governs names: a concept lands there before it earns a home.
- The word "gate" leaves file names, directory names, and exported symbols. The identity check is now the attach check, with a whitelist review and a session verification.
- Recorded evidence keeps its content and its dates. Only its name moves.

## Where the names go

The exact directory names are the rename's call. The constraint is that each one names a concept from the glossary.

| Concern | Holds |
|---|---|
| Core | State cache, clientbound policy, attach stream synthesis, session state, identity, relay decisions |
| Legs | Front leg and backend leg adapters, live and offline, plus the fakes |
| Custody | Accounts, token caches, writer lock, attach whitelist, session verification |
| Service | Config, composition root, CLI, live start |
| Ladder | Rungs, protocol bots, loopback, online |
| Testbed | Cluster switch, transfer testbed, registry compare |
| Driver | Client driver lane: scenario, RCON, checks, plan |
| Spike | The frozen protocol spike and its scenario |
| Observability | Journal, telemetry, redaction |

Validation work does not get a top-level home of its own. It lives where it runs: a rung under the ladder, a lane under the driver, a scenario under the testbed.

## The tree as it stands

| Directory | Holds |
|---|---|
| `src/core/` | State cache, clientbound policy, attach stream synthesis, session state, identity, relay decisions, transfer follow, the strict wire check |
| `src/legs/` | Front leg and backend leg, live and offline, the leg fakes, the shared fake backend, offline identity |
| `src/custody/` | Account directories, token caches, the writer lock, the attach whitelist, session verification, the attach check |
| `src/service/` | Config, composition root, CLI, live start, readiness |
| `src/observability/` | Journal, telemetry, redaction |
| `src/ladder/` | Rungs, protocol bot, loopback, online, state parity, the next-rung hint |
| `src/driver/` | Driver lane: one-run scenario, plan, RCON, Toxiproxy, backend matrix, logins, evidence checks, the NDJSON client driver, the run controller |
| `src/spike/` | The frozen protocol spike: proxy, scenario, fake client, the runner |
| `src/testbed/` | Cluster switch, transfer testbed, registry compare |
| `test/` | One directory per `src/` directory, plus `tooling/` for the gate's own checks and `spike/` for the socket test |
| `tools/driver/` | The Fabric client driver |
| `deploy/driver/` | The driver-lane cluster environment |

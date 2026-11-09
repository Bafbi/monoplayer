# Monoplayer agent instructions

## Tools

Two CLIs answer the protocol and journal questions that recur. Use them instead
of a `grep | tail -1 | python3 -c` pipeline.

- `node tools/protocol.mjs packets|frame|diff <version> <state> <dir> ...` lists,
  describes, or diffs protocol frames from the installed data, for 26.1 and the
  vendored 26.2 tree.
- `node tools/journal.mjs tail|heartbeat|names|window ...` reads the packet
  journal and the JSONL log.

[docs/telemetry.md](docs/telemetry.md) holds the commands and the record shapes.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `Bafbi/monoplayer`. Use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Repo map

`README.md` is the tour, `docs/architecture.html` the design, `GLOSSARY.md` the vocabulary. Use the glossary's terms.

Where to look: a decision lives in `src/core/` (pure), the wiring in `src/service/monoplayer.js`, the real I/O in `src/legs/`. `src/service/monoplayer.js` is 933 lines and its header comment lists the adapter interfaces: read the header, then grep.

| Path | Holds |
|---|---|
| `src/service/` | Composition root. `monoplayer.js --start` is the live service (the `Dockerfile` CMD); `start-live.js` reads the config and the env. |
| `src/core/` | Pure relay, session state machine, identity gate, state cache. No sockets, no timers. |
| `src/legs/` | The real front and backend legs on `minecraft-protocol`, plus the fakes the core tests drive. |
| `src/custody/` | Account directories, token rotation, both whitelists. `cli.js` is the user-facing entry point. |
| `src/observability/` | OTLP telemetry and the packet journal. Both are inert until configured: `OTEL_EXPORTER_OTLP_ENDPOINT`, or `MONOPLAYER_OTEL_ENDPOINT`, turns telemetry on. |
| `src/ladder/` | The rungs: `loopback.js`, `online.js`, the protocol bot, `next-rung.js`. |
| `src/spike/` | The frozen protocol spike. It grows no features. |
| `src/driver/`, `tools/driver/` | Fabric client driver, and the scenario runner `src/driver/run.js`. A G0 pass needs two passed reports and the human unmodded witness, so `--verify-g0` is not the whole check. |
| `src/testbed/`, `deploy/testbed/` | The two-Paper transfer testbed. |
| `deploy/` | Manifests and Argo CD. `scripts/build-image.sh` publishes the image. |
| `test/<area>/` | One directory per area, named after `src/<area>/`. `test/tooling/` covers `tools/` and `mise.toml`. |

Facts an agent cannot look up:

- **The gate**: before you report a change done, run `mise run check`. It runs lint, the unit tests, and the offline loopback, and it writes `.reports/loopback-report.json`. Quote that path and its assertion count.
- **The install**: a fresh checkout has no `node_modules`. `mise run check` depends on `install`, so let it install; do not check first.
- **Task list**: run `mise tasks ls --local` to see what this repo defines; `mise.toml` holds the definitions. Run the task, never the command behind it. Each `verify:<area>` task names the extra rung an area needs; `docs/testing-ladder.md` says which area maps to which.
- **Dependency paths**: pnpm keeps packages in `node_modules/.pnpm`. `node_modules/<name>` is a symlink and exists for direct dependencies only, so do not type a `node_modules/...` path. Ask the resolver instead: `node -p "require.resolve('minecraft-data')"`.
- **Throwaway scripts and artifacts**: put them in `.scratch/` and run them from the repo root. It is gitignored and may not exist yet, so create it. A script in `/tmp` cannot import the repo's dependencies.
- **Reports**: a task run writes to `.reports/`, which is gitignored. `testdata/` holds the committed rung reports, such as `testdata/spike-report.json`.
- **The shell starts at the repo root**: run the command bare, never `cd <repo> && <command>`.
- **Exit status**: run the interesting command bare. A trailing `| tail -N` or a follow-on `; ...` replaces the exit status with its own. If you must pipe, use `set -o pipefail`.
- **Further reading**: `docs/testing-ladder.md` (rungs and cost), `docs/deployment.md`, `docs/telemetry.md`, `docs/product-core.md`, `docs/custody.md`.

## Checkouts

More than one checkout of this repo exists on this machine. Cite paths relative to the repo root.

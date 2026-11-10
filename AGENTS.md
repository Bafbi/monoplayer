# Monoplayer agent instructions

## Lanes

Three cluster lanes, and two rules that outrank a test.

| Lane | Namespace | What runs there | Who changes it |
|---|---|---|---|
| live | `monoplayer` | the deployment Argo CD syncs from the `deploy` branch: one replica, the puppet account GlowSquidye, backend `play2.excalia.fr` | a human, by merging to `main` |
| dev | `monoplayer-dev` | the dev lane: its own Paper, its own proxy, its own account, not in Argo CD | anyone, with `mise run dev:up` and the rest of the `dev:` tasks |
| gate Paper | `monoplayer-gate-b` | the Paper that the online rung, the driver lane, and the transfer testbed run against; `paper-conduct` is its gate-serving sibling, which the observer measures. The lane rests at 0 replicas | anyone; it is disposable, and `mise run gate:up` and `mise run gate:down` are how it is woken and stopped |

**Never take the live lane down, scale it, patch it, or restart it for a test.**
That covers `kubectl -n monoplayer scale`, `patch`, `delete a workload`,
`rollout restart`, and `set image`. Three commands break the rule for you:
`mise run testbed:up` and `mise run testbed:run` scale the live deployment to
zero and disable Argo auto-sync, and `scripts/online-cluster.sh --rotate` writes
the refreshed token chain into the live custody and asks you to restart the
deployment. An interrupted testbed run leaves the live front offline, so
`mise run testbed:down` is the way back. It restores the deployment, and it
restores the Argo sync policy only while the run's state file at
`/tmp/opencode/monoplayer-testbed.json` survives. It also deletes the testbed's
front Service, which is what unpublishes the tailnet name. `node
src/testbed/switch.js status` reports all three.

**No automated join runs against Excalia.** `play.excalia.fr` and
`play2.excalia.fr` are the live servers, and no run in this repo joins them on
its own. Point every run at a server this repo deploys: the dev Paper, the gate
Paper, or the transfer testbed. `mise run online` takes its backend from
`MONOPLAYER_BACKEND_HOST`, so name one of those there, never the live host. That
rung reads this machine's copy of the account chain, so a refresh there can
invalidate the copy the deployment holds. `mise run online:cluster` is the form
that leaves the deployment serving.

| The test needs | Run |
|---|---|
| the gate, offline, seconds | `mise run check` |
| a real Paper and a real proxy, for one branch | `mise run dev:up`, then `mise run dev:image sha-<commit7>`, then `mise run dev:join` |
| the online rung, with the deployment still serving | `mise run gate:up`, then `mise run online:cluster` |
| a clientbound comparison, direct against proxied | `mise run parity:run` |
| the server's view of a join | `mise run gate:up`, then `mise run observer:run`, then `mise run gate:down` |
| the real client | `mise run gate:up`, then `mise run driver:scenario`, against the gate Paper |
| the transfer path | nothing: it takes the live front offline, so ask a human |

`docs/testing-ladder.md` gives each run its cost and its blast radius.
`deploy/dev/README.md` is the dev lane runbook, `deploy/driver/README.md` the gate's.

**The gate lane sleeps.** Its five Deployments commit `replicas: 0`, so a bare
`kubectl apply -k deploy/driver` wakes nothing and stops whatever was awake, because
apply reconciles every row to the tree. Only `mise run gate:up` should apply. It
applies the tree, wakes the rows a rung drives (`paper`, `paper-conduct`), and waits
up to 900 s while saying so. A cold start is 90 s, because every gate world is an
`emptyDir` that died with its pod. `mise run gate:down` puts it back to 0 and waits for
the pods to go. No rung drives `velocity`, `paper-m4` or `toxiproxy`, so they stay off
even after `gate:up`. `mise run gate:up -- velocity paper-m4 toxiproxy` wakes all three.

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

Where to look: a decision lives in `src/core/` (pure), the wiring in `src/service/monoplayer.js`, the real I/O in `src/legs/`. The header comment of `src/service/monoplayer.js` lists the adapter interfaces: read the header, then grep.

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

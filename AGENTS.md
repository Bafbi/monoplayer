# Monoplayer agent instructions

## Lanes

Three cluster lanes, and two rules that outrank a test.

| Lane | Namespace | What runs there | Who changes it |
|---|---|---|---|
| live | `monoplayer` | the deployment Argo CD syncs from the `deploy` branch: one replica, the puppet account GlowSquidye, backend `play2.excalia.fr` | a human, by merging to `main` |
| dev | `monoplayer-dev` | the dev lane: its own Paper, its own proxy, its own account, not in Argo CD | anyone, with `mise run dev:up` and the rest of the `dev:` tasks |
| gate lane | `monoplayer-gate-<instance>`, one per worktree | the Papers the online rung, the driver lane and the transfer testbed run against. `paper-conduct` is the gate-serving sibling the observer measures. The instance is the worktree's short commit and a short hash of its path, so two checkouts at one commit are two lanes. `mise run lanes` lists every lane with its age and the worktree that owns it. A lane rests at 0 replicas | anyone. It is disposable, and `mise run gate:up` and `mise run gate:down` wake and stop one |

**Never take the live lane down, scale it, patch it, or restart it for a test.**
That covers `kubectl -n monoplayer scale`, `patch`, `delete a workload`,
`rollout restart`, and `set image`. Three commands break the rule for you:
`mise run testbed:up` and `mise run testbed:run` scale the live deployment to
zero and disable Argo auto-sync, and `scripts/online-cluster.sh --rotate` writes
the refreshed token chain into the live custody and asks you to restart the
deployment. An interrupted testbed run leaves the live front offline, so
`mise run testbed:down` is the way back. It restores the deployment, and it
restores the Argo sync policy only while the run's restore record at
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
| a real Paper and a real proxy, for one branch | `mise run dev:up`, then `mise run dev:image sha-<commit7>`, then `mise run dev:join`. The tag must come from the branch workflow's GHCR build: `mise run image:build` publishes to Zot, whose host the dev namespace cannot resolve. |
| the online rung, with the deployment still serving | `mise run gate:up`, then `mise run online:cluster` |
| a clientbound comparison, direct against proxied | `mise run parity:run` |
| the server's view of a join | `mise run gate:up`, then `mise run observer:run`, then `mise run gate:down` |
| the real client | `mise run gate:up`, then `mise run driver:scenario`, against the gate Paper |
| the transfer path | nothing: it takes the live front offline, so ask a human |

`docs/testing-ladder.md` gives each run its cost and its blast radius.
`deploy/dev/README.md` is the dev lane runbook, `deploy/driver/README.md` the gate's.

**The gate lane sleeps.** Its five Deployments commit `replicas: 0`. The tree spells
its lane as `gate-__instance__`, so a bare `kubectl apply -k deploy/driver` is
refused. Only `mise run gate:up` applies, and it applies the render that names this
worktree's lane. It wakes the rows a rung drives (`paper`, `paper-conduct`) and waits
up to 900 s while saying so. `mise run lanes` lists every lane, and
`mise run lanes -- --reap` deletes the ones idle past six hours. A cold start is
90 s, because every gate world is an `emptyDir` that died with its pod. `mise run gate:down` puts it back to 0 and waits for
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

`README.md` is the tour, `docs/product-core.md` the shipped design, `GLOSSARY.md` the vocabulary. Use the glossary's terms. `docs/architecture.md` is a proposal, not the built design.

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
| `src/panel/`, `deploy/panel/` | The ops panel on the tailnet: `start.js` the entrypoint, `server.js` the dispatch and the read routes, `routes/` one module per write route, `kube.js` the ConfigMap patch, `registry.js` the registry document. It has no Application of its own: the one Argo Application syncs `deploy/kustomization.yaml`, which includes it beside the proxy. Runbook: `docs/panel.md`. Its tests stay in `test/panel/`, one level, because `mise run test` globs that level only. |
| `deploy/` | Manifests and Argo CD. `scripts/build-image.sh` publishes the image. |
| `test/<area>/` | One directory per area, named after `src/<area>/`. `test/tooling/` covers `tools/`, `mise.toml`, and the manifests under `deploy/`; `test/support/` holds the shared fake-integration rig, `harness.js`, and no test of its own. |

Facts an agent cannot look up:

- **The gate**: before you report a change done, run `mise run check`. It runs lint, the unit tests, and the offline loopback, and it writes `.reports/loopback-report.json`. Quote that path and its assertion count.
- **A loopback assertion is numbered above the current highest, and its bullet lands in `docs/testing-ladder.md` in the same commit.** `test/ladder/loopback-contract.test.js` compares the two lists and fails otherwise. An undocumented assertion that reaches `main` breaks the image build, not just the gate.
- **The effective config**: `node src/service/monoplayer.js --print-config` prints the resolved document and exits. Do not reconstruct it from manifests by hand.
- **The config surface is one function.** Every `MONOPLAYER_*` variable is enumerated in `envOverlay` in `src/service/start-live.js`, and nothing else reads `process.env`. A name that appears in a guard message but not in that function looks wired and is not.
- **The switches are config, not flags.** They are read once at startup and validated by `loadConfig`, which throws on a bad value rather than starting misconfigured. A feature-flag system was considered and declined: one service, one language, eight keys, and a compiled default for each. Do not propose one again without saying what changed.
- **The install**: a fresh checkout has no `node_modules`. `mise run check` depends on `install`, so let it install; do not check first.
- **Task list**: run `mise tasks ls --local` to see what this repo defines; `mise.toml` holds the definitions. Run the task, never the command behind it. Each `verify:<area>` task names the extra rung an area needs; `docs/testing-ladder.md` says which area maps to which.
- **Dependency paths**: pnpm keeps packages in `node_modules/.pnpm`. `node_modules/<name>` is a symlink and exists for direct dependencies only, so do not type a `node_modules/...` path. Ask the resolver instead: `node -p "require.resolve('minecraft-data')"`.
- **Throwaway scripts and artifacts**: put them in `.scratch/` and run them from the repo root. It is gitignored and may not exist yet, so create it. A script in `/tmp` cannot import the repo's dependencies.
- **Reports**: a task run writes to `.reports/`, which is gitignored. `testdata/` holds the committed *verdict pages*, such as `testdata/spike-verdict.md`; the run reports they quote are gitignored. A verdict page is dated evidence, so leave its old numbers alone.
- **Contention**: `src/service/monoplayer.js`, `src/ladder/loopback.js`, `docs/testing-ladder.md`, `GLOSSARY.md`, `deploy/manifests/deployment.yaml` and `mise.toml` are the files parallel agents collide in. Keep the diff small there and expect a rebase.
- **A failed review is not a review.** If a review or council delegate fails, say so in the PR. Do not describe the work as reviewed.
- **Merging to `main` is a deploy.** `image.yaml` re-runs `check` on the merged commit, then rewrites the `deploy` branch as `main` plus one digest commit, which Argo syncs. A red `check` there freezes the lane on the last good image. `deploy` is bot-owned: never commit to it, the workflow force-pushes over you.
- **The custody volume is not disposable.** `deploy/manifests/pvc.yaml` carries `Delete=false, Prune=false` because it holds the account chain. Do not strip that, and do not prune it.
- **The shell starts at the repo root**: run the command bare, never `cd <repo> && <command>`.
- **Exit status**: run the interesting command bare. A trailing `| tail -N` or a follow-on `; ...` replaces the exit status with its own. If you must pipe, use `set -o pipefail`.
- **Further reading**: `docs/testing-ladder.md` (rungs and cost), `docs/deployment.md`, `docs/telemetry.md`, `docs/product-core.md`, `docs/custody.md`.

## Checkouts

More than one checkout of this repo exists on this machine. Cite paths relative to the repo root.

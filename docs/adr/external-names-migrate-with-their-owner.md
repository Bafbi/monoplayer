# External names migrate with their owner

The tree now names everything after the domain, but names that live outside the repository kept their old words: the cluster, the display host, and the operator's config read them, so renaming them in the same change would recreate live objects, break a running scenario, and give an operator downtime for a rename. Each one migrates when the next change touches the area that reads it, in the same step as that change, and the old name is deleted only after the new one serves traffic.

## Considered options

- **Rename them together with the tree.** Rejected: the cluster objects are live and Argo CD owns them; the Prism instances and the Hyprland rule are host state that no commit can move. A rename there is a migration with a rollback, not an edit.
- **Leave them unnamed in the tree.** Rejected: an undocumented frozen name reads as a miss, so the next rename repeats this analysis, or a contributor "fixes" it and strands a running environment.
- **Migrate at a fixed date.** Rejected: nothing reads a date, and the two names nobody touches for a year stay wrong for a year. Tying each name to its owner puts the work where the change already is.

## Consequences

- The table below is the one place to look before touching a driver-lane area. `deploy/driver/README.md` carries the operator-facing copy.
- A migration ticket closes only when the old name is gone, not when the new one exists.
- Evidence keeps its content and dates. A renamed evidence field applies to reports written after the change; old verdicts keep the field they recorded.

## The names, and what must move with them

| Frozen name | Read by | Migrates with |
|---|---|---|
| namespace `monoplayer-gate-b`, labels `app.kubernetes.io/name: monoplayer-gate-b-*`, Secrets `gate-b-rcon` and `gate-b-velocity` | Argo CD, kubectl, the operator | the manifests in `deploy/driver/` |
| Tailscale hostnames `monoplayer-gate-b-paper`, `monoplayer-gate-b-velocity` | the driver lane's `--server` default, the display host's launch command | `src/driver/backends.js`, `src/driver/run.js` |
| Prism instances `gate-b-player`, `gate-b-player-fabric` | the display host, `tools/nath.sh`, `tools/driver/install.sh` | the driver-lane runbook |
| `GATEB_*` variables (`GATEB_DRIVER_*`, `GATEB_RCON_*`, `GATEB_DISPLAY`, `GATEB_ACCOUNTS_DIR`, `GATEB_AUTH_*`) | the operator's shell, `tools/nath.sh`, `src/driver/`, `src/custody/cli.js` | the driver-lane runbook and the custody CLI |
| `gateb.driver.port`, `gateb.driver.token`, `gateb.window.title` | the launch command | the client driver |
| window title `Monoplayer Gate B` | the operator's Hyprland rule | the client driver, together with that rule |
| server motd `Monoplayer Gate B` | players on the Velocity lane | `deploy/driver/velocity.yaml` |
| the report field `gate: "B"` | recorded verdicts, and new reports from `src/driver/run.js` | the driver-lane runner, after #7 prunes the old evidence |

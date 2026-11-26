# External names migrate with their owner

The tree now names everything after the domain, but names that live outside the repository kept their old words: the cluster, the display host, and the operator's config read them, so renaming them in the same change would recreate live objects, break a running scenario, and give an operator downtime for a rename. Each one migrates when the next change touches the area that reads it, in the same step as that change, and the old name is deleted only after the new one serves traffic.

## Considered options

- **Rename them together with the tree.** Rejected: the cluster objects are live and Argo CD owns them; the Prism instances and the Hyprland rule are host state that no commit can move. A rename there is a migration with a rollback, not an edit.
- **Leave them unnamed in the tree.** Rejected: an undocumented frozen name reads as a miss, so the next rename repeats this analysis, or a contributor "fixes" it and strands a running environment.
- **Migrate at a fixed date.** Rejected: nothing reads a date, and the two names nobody touches for a year stay wrong for a year. Tying each name to its owner puts the work where the change already is.

## Consequences

- The table below is the one place to look before touching a driver-lane area. `deploy/driver/README.md` carries the operator-facing copy, and `test/tooling/adr-frozen-name-owner.test.js` fails when a row names a tree that does not spell the name.
- A migration ticket closes only when the old name is gone, not when the new one exists.
- Evidence keeps its content and dates. A renamed evidence field applies to reports written after the change; old verdicts keep the field they recorded.

## The names, and what must move with them

| Frozen name | Read by | Migrates with |
|---|---|---|
| the namespace `monoplayer-gate-b`, and the Secrets `gate-b-rcon` and `gate-b-velocity` in it | Argo CD, kubectl, the operator, and the two Papers in `deploy/testbed/`, which read `gate-b-rcon` | `deploy/testbed/`, which declares the namespace and reads the RCON Secret, with `src/testbed/switch.js` and `scripts/gate-lane.sh`, which name the namespace too. Both Secrets are hand-made: no manifest creates them (#283, #288, #318) |
| Prism instances `gate-b-player` and `gate-b-player-fabric` (the 26.1.2 pair, kept as the G0 record) | the display host | the driver-lane runbook |
| Prism instances `gate-b-player-262` and `gate-b-player-262-fabric` (the 26.2 pair) | the display host, `src/driver/run.js`, `tools/nath.sh`, `docs/driver-lane.md` | the driver-lane runbook, in the same display-host step |
| `GATEB_*` variables (`GATEB_DRIVER_*`, `GATEB_RCON_*`, `GATEB_DISPLAY`, `GATEB_ACCOUNTS_DIR`, `GATEB_AUTH_*`) | the operator's shell, `tools/nath.sh`, `src/driver/`, `src/custody/cli.js` | the driver-lane runbook and the custody CLI |
| `gateb.driver.port`, `gateb.driver.token`, `gateb.window.title` | the launch command | the client driver |
| window title `Monoplayer Gate B` | the operator's Hyprland rule | the client driver, together with that rule |
| server motd `Monoplayer Gate B` | players on the Velocity lane | `deploy/driver/velocity.yaml` |
| the report field `gate: "B"` | recorded verdicts, and new reports from `src/driver/run.js` | the driver-lane runner, after #7 prunes the old evidence |

A lane's namespace, labels, Secrets and two tailnet hostnames are not in this table:
`deploy/driver/` spells them from the lane's own instance (#277), `scripts/gate-lane.sh`
generates its Secrets (#278), and `src/driver/lane.js` builds the hostname a run joins
(#282). The namespace this table keeps is the transfer testbed's, which no lane derives
(#318).

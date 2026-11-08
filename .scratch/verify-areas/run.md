# mise: per-area verify tasks and next-rung failure messages (#4)

Source: https://github.com/Bafbi/monoplayer/issues/4

## Queue

One ticket, no blockers.

1. #4 verify:<area> tasks (relay, auth, driver, deploy) and next-rung failure
   messages. Fixed point: 4b07849 (origin/main).

## Decisions

- The rung table in docs/testing-ladder.md is the only source for the failure
  sentence. src/ladder/next-rung.js parses it at call time, so the doc, the
  gate, and the hint cannot drift.
- mise has no per-task failure hook: TaskDecl has no on_failure, pre, or post
  field, and `[hooks]` is config-root only. `depends_post` exists but runs after
  both success and failure and cannot branch on the outcome. A multi-line `run`
  is one script under `sh -o errexit -c`, so the wrapper is
  `<rung command> || node src/ladder/next-rung.js <rung> $?`.
- Each verify:<area> task composes `check` plus the check that covers the area,
  through `depends`. No task copies a rung command, so check stays the one
  definition of the offline gate.
- mise runs sibling `depends` concurrently (jobs defaults to 8), so list order
  in a `depends` array is not an order. Each expensive rung carries
  `wait_for = ["check"]`, which orders without scheduling: a red gate stops the
  rung before it starts, and a bare `mise run online` is unchanged.
- verify:relay adds `spike` (beside the ladder, unrun by CI). verify:auth adds
  `online` (rung 3), because rungs 1 and 2 cannot catch encryption or
  `hasJoined`. verify:driver adds the driver build and the rung 4 scenario.
  verify:deploy adds `image:build`, which publishes to the Zot registry; the
  description and the doc say so.

## Council

Three seats, same brief, read-only, one vote each. Verdict: A, three to zero.

- Pragmatist (opencode-go/deepseek-v4.1-flash, high): A. Keep the composition.
  Measured that sibling depends run concurrently and that a failing sibling
  kills the rest, so ordering had to come from wait_for. A red task that names
  its missing prerequisite is recoverable; a green task that tested nothing is
  not. Suggested the wait_for fix and that verify:deploy keeps saying it
  publishes.
- Architect (opencode-go/deepseek-v4.1-flash, high): A. Only A puts the
  name-to-guarantee mapping in the task graph where a test can hold it. Under B
  the mapping collapses into a description sentence. Also asked for wait_for.
- Adversary (opencode-go/glm-5.3-flash, max): A, with a rider. Confirmed with
  timestamped probes that wait_for gives the ordering, that a red gate skips
  the waiting rung, and that a bare rung is unaffected. The rider: image:build
  pushes the working tree under the HEAD tag to a registry the manifests do not
  read, so verify:deploy should build without pushing. Filed as #33 and recorded
  in the doc as "run verify:deploy from a clean checkout".
- Third seat attempt on claudeAgent/claude-sonnet-5-5 failed: "Provider
  instance is disabled". The adversary seat moved to glm-5.3-flash, a different
  model family from the implementer, to keep an independent read.

Dissents recorded: the Adversary's rider (#33) and its two shared costs, that
three of the four tasks are habitat-bound and fail exit 2 without a hint, and
that nothing serializes two verify runs (documented as "run one at a time").

## Research

- jdx/mise: TaskDecl fields, no failure hook, multiline run is one shell
  script, default `sh -o errexit -c` (crates/mise-util/src/shells.rs:6-10).
- mise 2026.10.11, measured here: siblings start together (jobs=8); a failing
  sibling aborts the run and stops the others; `wait_for` orders a task that is
  already in the graph and schedules nothing on its own; `$?` inside the `||`
  branch is the failed command's status.

## Ticket 1: verify tasks and next-rung hints

Seams under test:

- `parseLadder` / `failureHint` / `main` in src/ladder/next-rung.js
  (test/ladder-next-rung.test.js): the hint reads the doc table and names the
  next rung, including both commands of rung 4. Chosen because the failure
  output is the ticket's observable.
- mise.toml task graph (test/mise-tasks.test.js): check still composes the three
  cheap rungs, every verify task depends on tasks instead of copying a command,
  every expensive rung waits for the gate, and every rung task carries the
  next-rung fallback with its exit status.

## Review

Delegate: opencode-go/glm-5.3-flash at max, fresh context, read-only, fixed point
origin/main, spec = issue #4, standards = AGENTS.md. Nine findings, triaged:

1. Fix, fixed: "then" ordering claims were false, because sibling depends run
   concurrently. The claims are now true: each expensive rung waits for check,
   and the doc states the concurrency rule.
2. Fix, fixed: the rung 4 hint named only gate-b:scenario. failureHint now joins
   every command of the rung.
3. Fix, fixed: this log recorded "sequential depends" and "no post field". Both
   were wrong. Replaced with the measurements above.
4. Fix, fixed: the wrapper test passed without the exit-status argument. It now
   asserts the whole tail, including `$?`.
5. Fix, fixed: the README line read as if verify:relay covered all four areas.
   The README now points at the area table instead of naming one command.
6. Fix, fixed: "compose the rungs" overstated two of the four tasks. The doc now
   says the four compose the gate and their area's check, and names spike and
   image:build as the two additions the table does not list.
7. Note, fixed: the stale test count in this log. It is 375 at this head.
8. Note, fixed: the #28 references said "open". #28 is closed as completed,
   and PR #30 landed .github/CODEOWNERS with /mise.toml @Bafbi while this run
   was in progress. main's branch protection still requires only the check
   status, and GitHub does not request a review from a pull request's own
   author, so this PR merges on the check status alone. The wording now says so.

## Proof

- `mise run check`: green, 375 unit tests, loopback 26/26.
- `mise run verify:relay`: green, check and spike.
- Red gate stops the expensive rung: a temporary failing test made
  `mise run verify:relay` print zero `[spike]` lines and exit 1 with the rung
  hint. Temporary file removed.
- A failing rung names the next one: the same run printed "mise run test failed
  (rung 1, unit)." and the rung 2 hint. A syntax error under src/ did the same
  for lint.
- `node src/ladder/next-rung.js online` prints both rung 4 commands.
  `... loopback 2` exits 2 and prints nothing. `... 130` exits 130.
- `mise tasks validate`: all 25 tasks valid. `mise tasks deps` shows each area
  composed only of rung tasks, with image:build hanging off check.
- Rebased onto origin/main b38d8ea (glossary, ADRs, CODEOWNERS), then re-ran
  everything above: `mise run check` green, 375 unit tests, loopback 26/26.
  None of this change's files moved on main, so the rebase carried no conflict.

## Final review

Delegate: opencode-go/glm-5.3-flash at max, fresh context, fixed point origin/main,
over the run's whole diff. Verdict at first read: not as it stands. Two findings,
both doc claims, both fixed:

9. The doc said two of the four verify tasks add a task the rungs table does not
   list. It is three: spike, gate-b:driver:build, image:build. The sentence now
   names all three.
10. The doc said each rung task prints the next rung. gate-b:g0 cannot: rung 4
   has nothing above it. The sentence now gives that exception.

Everything else the review re-checked held at the head: four depends-only verify
tasks, check untouched, the hint byte-identical to the doc example, 375 unit
tests, loopback 26/26, all 25 tasks valid.

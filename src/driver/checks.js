// Pure evidence helpers for the driver lane: RCON output parsing,
// numeric comparisons with tolerances, client-status predicates, block-test
// parsing, the rule both hand-filled witnesses read for a step a run cannot see,
// and the unmodded witness's steps and the check that reads them (#922, #943).
// No I/O and no env access of any kind, so the unit tests stay fully offline.
//
// The gap rule lives here once, and src/driver/dev-proof.js imports it for the dev
// lane's witness: the two documents are read the same way because they read the
// same functions, not because two copies happen to agree (#943).
//
// The secret scanner that used to live here is src/observability/secrets.js:
// custody needs it to keep secrets out of its reports, and a security boundary
// may not depend on a validation lane (#38).

export const TEST_PASSED = 'Test passed'
export const TEST_FAILED = 'Test failed'

// ---------------------------------------------------------------------------
// RCON output parsing
// ---------------------------------------------------------------------------

// `execute [unless] if block x y z <block>` answers "Test passed" or
// "Test failed". Anything else — quiet errors such as "Could not set the
// block", an empty output, or garbage — is `unknown` and must never be read
// as a pass. Positive assertions only.
export function parseBlockTest (output) {
  const text = String(output ?? '')
  if (text.includes(TEST_PASSED)) return 'passed'
  if (text.includes(TEST_FAILED)) return 'failed'
  return 'unknown'
}

// A recorded RCON result is `{ ok, output, ... }`; `ok` means the kubectl exec
// succeeded, the parsed verdict decides pass/fail.
export function blockTestResult (result, expected = 'passed') {
  return Boolean(result && result.ok) && parseBlockTest(result.output) === expected
}

// `data get entity <name> Pos` -> "Bafbi has the following entity data: [13.5d, -60.0d, -4.5d]"
// `data get entity <name> Rotation` -> "... [45.75f, 10.0f]"
export function parseEntityPath (output) {
  const match = String(output ?? '').match(/\[([^\]]+)\]/)
  if (!match) return null
  const values = []
  for (const part of match[1].split(',')) {
    const m = part.trim().match(/^(-?\d+(?:\.\d+)?)[df]?$/)
    if (!m) return null
    values.push(Number(m[1]))
  }
  return values
}

export function parseEntityPos (output) {
  const values = parseEntityPath(output)
  if (!values || values.length !== 3) return null
  return { x: values[0], y: values[1], z: values[2] }
}

export function parseEntityRotation (output) {
  const values = parseEntityPath(output)
  if (!values || values.length !== 2) return null
  return { yaw: values[0], pitch: values[1] }
}

// "There are 1 of a max of 4 players online: Bafbi"
// "There are 0 of a max of 20 players online:"
// Empty/missing output -> null (never an answer that "contains no Bafbi").
export function parsePlayerList (output) {
  const match = String(output ?? '').match(
    /There are (\d+) of a max of \d+ players online:?(.*)$/is
  )
  if (!match) return null
  const rest = match[2].trim()
  if (rest === '') return []
  return rest.split(',').map(name => name.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Numeric comparisons (tolerances, yaw wrap)
// ---------------------------------------------------------------------------

export function distance3D (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function positionsWithin (a, b, tolBlocks) {
  if (!a || !b) return false
  return distance3D(a, b) <= tolBlocks
}

// Wrap an angle in degrees into [-180, 360 -> (-180, 180]).
export function wrapAngle (deg) {
  const wrapped = (((Number(deg) % 360) + 540) % 360) - 180
  if (Object.is(wrapped, 180)) return -180
  return wrapped
}

// Smallest signed difference between two angles in degrees.
export function angleDelta (a, b) {
  return wrapAngle(Number(a) - Number(b))
}

export function anglesWithin (a, b, tolDeg) {
  return Math.abs(angleDelta(a, b)) <= tolDeg
}

// Compare [yaw, pitch] pairs; yaw wraps, pitch does not.
export function rotationsWithin (a, b, { tolYaw = 2, tolPitch = 2 } = {}) {
  if (!a || !b) return false
  return anglesWithin(a.yaw, b.yaw, tolYaw) && Math.abs(a.pitch - b.pitch) <= tolPitch
}

// ---------------------------------------------------------------------------
// Client-status predicates (driver `status` payload)
// ---------------------------------------------------------------------------

// status fields: screen ('none' or a screen class name), level (bool),
// player (bool), connected (bool), renderedSections (> 0 means terrain is
// actually drawn, not just downloaded).
export function isSettled (status) {
  return Boolean(
    status &&
    status.connected === true &&
    status.level === true &&
    status.player === true &&
    status.screen === 'none' &&
    Number(status.renderedSections) > 0
  )
}

export function isDisconnected (status) {
  return Boolean(status && status.connected === false)
}

export function describeStatus (status) {
  if (!status) return 'no status'
  const pos = status.pos ? `pos=${status.pos.x},${status.pos.y},${status.pos.z}` : 'pos=?'
  const held = status.held !== undefined ? ` held=${status.held}` : ''
  return `connected=${status.connected} screen=${status.screen} level=${status.level} player=${status.player} rendered=${status.renderedSections} ${pos}${held}`
}

// ---------------------------------------------------------------------------
// Version agreement
// ---------------------------------------------------------------------------

// The driver jar declares the one Minecraft version it is built for
// (tools/driver/src/main/resources/fabric.mod.json), and a lane's target declares
// its own. A mismatch cannot join: the client stops at an "Incompatible client"
// screen after a relaunch, so the runner refuses before the first launch instead
// of spending two client cycles on a screen that already said no.
export function versionRefusal ({ driverVersion, targetVersion } = {}) {
  if (!driverVersion || !targetVersion) return null
  if (String(driverVersion) === String(targetVersion)) return null
  return 'the driver is built for Minecraft ' + driverVersion + ' and the target serves ' + targetVersion +
    ': the client would reach an incompatible-client screen. Rebuild the driver for the target, or point ' +
    'the lane at a target that serves the driver version (issue #62).'
}

// ---------------------------------------------------------------------------
// The age rule both halves of a G0 pass are read by (#939)
// ---------------------------------------------------------------------------

// A document on disk passes whether or not anything ran, so every document in a G0 pass has to
// record a time inside the window the caller names. The reports and the witness are read by this one
// function, so the sentence an operator reads names the same window whichever half was too old, and a
// rule that learns a case learns it for both. That is the argument #943 made for the gap rule, one
// level up.
//
// `subject` is the thing being dated, in the caller's words, and `stamped` is how that document
// records it. The two documents date different events, and one sentence for both would have to say
// "the document's time", which names neither.
//
// Two of the three refusals are read without a window. An unreadable time is refused rather than
// skipped, because a value that reaches here and does not parse passes every age test there is. A
// time after this check is refused for the same reason: a year typed into a date moves it past every
// window, and no document here is written by a clock ahead of the checkout that reads it. Neither is
// an age question, so neither waits for the caller to name one; only the stale refusal does, and an
// `Infinity` window is how a caller says it is not asking that question.
const ageRefusal = ({ at, now, maxAgeMs, subject, stamped, field }) => {
  const window = Math.round(maxAgeMs / 60000) + '-minute window'
  if (!Number.isFinite(at)) return subject + ' carries no readable ' + field + ', so its age cannot be read'
  // Only the stale branch reads `maxAgeMs`, so `Infinity` leaves the other two in place and says the
  // window is not the caller's question.
  if (at > now) {
    return subject + ' is dated in the future: it says ' + new Date(at).toISOString() +
      ', and this check is reading it at ' + new Date(now).toISOString()
  }
  if (now - at > maxAgeMs) {
    return subject + ' is stale: ' + stamped + ' ' + new Date(at).toISOString() + ', outside the ' + window
  }
  return null
}

// Pure verifier for the G0 evidence bundle. The summary must describe one
// invocation that requested and executed exactly two runs; the two report
// paths it names must be the chronological run 1 and run 2 and both must have
// passed. This prevents two separate one-run invocations from looking like 2/2.
export function verifyG0Evidence (summary, reports, { now = Date.now(), maxAgeMs = Infinity } = {}) {
  if (!summary || typeof summary !== 'object') return { ok: false, reason: 'missing driver summary' }
  if (summary.runsRequested !== 2 || summary.runsExecuted !== 2 || summary.runsPassed !== 2 ||
      summary.allPassed !== true || !Array.isArray(summary.reports) || summary.reports.length !== 2) {
    return {
      ok: false,
      reason: `latest summary is not a clean 2-run invocation (requested=${summary.runsRequested}, executed=${summary.runsExecuted}, passed=${summary.runsPassed})`,
    }
  }
  // #939: the summary is the report set's own identity, and the lane is the value a G0 pass is bound
  // by. A summary written before the runner recorded one can bound nothing, so it is refused here
  // rather than read as a witness with no counterpart.
  if (typeof summary.gateLane !== 'string' || summary.gateLane === '') {
    return {
      ok: false,
      reason: 'the report set names no lane: the summary was written by a runner that did not record which lane the ' +
        'runs measured, so no witness can be bound to it. Run: mise run driver:scenario',
    }
  }
  if (!Array.isArray(reports) || reports.length !== 2) return { ok: false, reason: 'expected two driver reports' }
  for (const report of reports) {
    if (!report || report.lane !== 'driver' || report.passed !== true) {
      return { ok: false, reason: 'both driver reports must be lane=driver and passed=true' }
    }
  }
  const sorted = [...reports].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  if (!Number.isFinite(Date.parse(sorted[0].startedAt)) || !Number.isFinite(Date.parse(sorted[1].startedAt))) {
    return { ok: false, reason: 'driver reports need valid startedAt timestamps' }
  }
  if (sorted[0].run !== 1 || sorted[1].run !== 2) {
    return { ok: false, reason: `chronological runs must be 1 then 2 (got ${sorted[0].run} then ${sorted[1].run})` }
  }
  const generated = Date.parse(summary.generatedAt)
  if (Number.isFinite(generated) && Date.parse(sorted[1].startedAt) > generated) {
    return { ok: false, reason: 'driver summary is stale: a newer report exists' }
  }
  // A committed or hand-copied report set is not evidence of anything: it passes
  // whether or not anything ran today. Bound the age of the newest run, so the
  // gate can only be green on evidence this checkout produced recently. The rule is
  // `ageRefusal`'s, which the witness's half of the same pass is read by too (#939),
  // called the same way by both so neither half can be read differently.
  const ended = sorted[1].finishedAt === undefined || sorted[1].finishedAt === null
  const aged = ageRefusal({
    at: Date.parse(sorted[1].finishedAt ?? sorted[1].startedAt),
    now,
    maxAgeMs,
    subject: 'driver evidence',
    // What the sentence says is what the report recorded: a report with no `finishedAt` is dated by
    // its start, and a refusal that said it finished would name a time the document never held.
    stamped: ended ? 'the newest run started at' : 'the newest run finished at',
    field: ended ? 'startedAt' : 'finishedAt',
  })
  if (aged !== null) return { ok: false, reason: aged }
  return { ok: true, reason: '2/2 consecutive driver runs' }
}

// ---------------------------------------------------------------------------
// A step a run cannot see, in either hand-filled witness (#943)
// ---------------------------------------------------------------------------

// The state a row records when the person taking the run did not see the step hold.
// Both witnesses spell it the same way. It is a pass on one condition: the module's
// own step list declares that step expected absent today, with the tickets that
// close it (`openUntil`). A row can never carry the declaration — the file is
// hand-edited, and a step that could declare itself absent would pass by writing a
// line (#920).
export const GAP_STATE = 'not-seen'

// A list in a sentence: "`a`, `b` and `c`". One copy for both witnesses, so a
// refusal and a report name the same steps the same way.
export const namedIds = ids => ids.map(id => '`' + id + '`').join(', ')

// A list in a sentence: "row 1, row 2 and row 3".
export const commaAnd = items => (items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1))

// The verb that agrees with a count, so a sentence built on one does not spell the
// choice out twice.
export const agree = (count, one, many) => (count === 1 ? one : many)

// The tickets a declaration names, as the sentences read them: "#647", or
// "#647 and #645".
export const ticketList = tickets => tickets.map(ticket => '#' + ticket).join(' and ')

// What a declaration says it takes to close it: "#647 and #645 close it", or one of
// them.
export const closes = tickets => ticketList(tickets) + ' ' + agree(tickets.length, 'closes', 'close') + ' it'

// A declared step, as either check names it in its result: the step, the sentence the
// operator read, the tickets that close it, and what they recorded. Both passes carry
// these — the dev lane's under `gaps` and `stale`, the G0 command's read by the one
// formatter below — and the name of each field is the list's throughout, so a caller
// never translates between two words.
export const declaredOf = step => ({ id: step.id, claim: step.claim, openUntil: step.openUntil, evidence: step.evidence })

// The states a row is in before anyone records it: the writer's placeholder, and a row with no state
// at all, which a hand-edited file can leave. Both witnesses read that vocabulary from here, so a
// third open state would be one line rather than a second set that happens to agree today.
export const OPEN_STATES = new Set([undefined, 'pending'])

// The rows of a settled document, split four ways by whether the step's own list
// declared it expected absent and what the operator recorded. This is the whole of
// the rule, and it is the one function both witnesses call: a `not-seen` is the
// finding it always was unless a declaration accounts for it, and the declaration is
// the list's entry, never the row's. It reads `openUntil ?? null`, so a row that never
// met a list is undeclared, which is the direction that refuses rather than the one
// that passes.
//
// `declared` is every step the list declares, whatever the operator recorded: a
// refusal names those, because an operator holding a `not-seen` nobody declared needs
// to know which step this run does expect, and that step may well be recorded seen.
// `gaps` is the narrower list a pass carries: the declared steps that witness could not see.
// `stale` is the declaration a witness outlived: the listed steps the operator did record, so the
// gap the declaration names is not there today. Both passes carry it and neither refuses it — a fix
// landing must not turn an honest record red (#920) — so a pass names it instead (#963).
export function gapSplit (settled) {
  const declares = step => (step.openUntil ?? null) !== null
  const declared = settled.filter(declares)
  const notSeen = settled.filter(step => step.state === GAP_STATE)
  return {
    declared,
    gaps: notSeen.filter(declares),
    unexpected: notSeen.filter(step => !declares(step)),
    // Recorded, and not as the gap: an unrecorded row is nobody's declaration outlived. Both callers
    // refuse the open states before they split, so this list is also the one a finished witness makes.
    stale: declared.filter(step => step.state !== GAP_STATE && !OPEN_STATES.has(step.state))
  }
}

// The one line a declared gap is printed on, wherever either lane prints one, so its readers cannot
// word it differently: the dev lane's report and its `--verify` pass, and the G0 command's pass
// (#963). `withEvidence` is for the caller that has not printed the operator's words on the line
// above.
export const gapLine = (step, { withEvidence = false } = {}) =>
  'known gap: ' + step.claim + ' — not seen' +
  (withEvidence ? ' (' + step.evidence + ')' : '') + ', and ' + closes(step.openUntil)

// The line a declaration that outlived its ticket is printed on. #920's answer to a declaration that
// would otherwise rot: a witness that saw the step still verifies, because a fix landing must not turn
// an honest record red, and this line names the declaration to drop in the change that closes it.
//
// It says what the row recorded and what the list still declares, and it claims nothing about the
// ticket's state: no command here can read one, and a line that said "#647 lands" would be wrong the
// day it did. Naming the ticket is enough for a reviewer to check, and the operator is told what to
// edit. `list` and `state` are the caller's because the two lanes keep two lists and two words for
// a step they saw, and one line that said "seen" while the row said `ok` reads as two facts.
export const staleLine = (step, { list, state }) =>
  'stale declaration: ' + step.claim + ' — ' + state + ', though ' + list + ' still declares it ' +
  'expected absent: ' + closes(step.openUntil) + ', so drop the step\'s openUntil in that change'

// ---------------------------------------------------------------------------
// The unmodded witness (#922)
// ---------------------------------------------------------------------------

// The unmodded lane's human half is recorded in a document a person fills in by
// hand. Its file name is here because the writer names it and the check reads it.
export const UNMODDED_WITNESS_FILE = 'driver-unmodded-witness.json'
export const UNMODDED_WITNESS_LANE = 'unmodded'

// The list's name as a stale-declaration line prints it, so a reader is told which constant to edit.
// It lives here, in the module that owns both, because a rename has to reach both. A module cannot
// read its own binding's name, and a line that said "its step list" would send the reader looking.
export const UNMODDED_LIST_NAME = 'UNMODDED_STEPS'

// The steps the unmodded witness records, in the order an operator does them. One
// list, read at both ends: `unmoddedWitness` writes a row per step and
// `verifyUnmoddedWitness` reads those rows back, so the checklist and the check
// cannot drift (#922). `id` is the name a refusal carries and the name a row
// records, by the rule `OPERATOR_STEPS` states one file over for the dev lane's
// witness: a row is named by an id, never by prose a rewrite rewords. `claim` is
// the sentence the checklist prints and the operator answers, and it names the
// reading that settles the step, because that sentence is all an operator has to
// go on when they come back to it.
//
// `openUntil` is the declaration that a step is expected to be `not-seen` today,
// and the tickets that would change it (#920, #943). Optional, the way `because` is
// optional one file over: a step a run taken today shows carries no `openUntil` at
// all rather than a null standing in for one. `verifyUnmoddedWitness` accepts a
// `not-seen` on a step that carries it and on no other, so the declaration is a
// list with a ticket per entry rather than a relaxed check. A row of the witness
// cannot carry one: the file is hand-edited, and a step that could declare itself
// absent would pass by writing a line.
export const UNMODDED_STEPS = Object.freeze([
  { id: 'join', claim: 'join: official unmodded client reaches the world in <= 120 s' },
  { id: 'render', claim: 'render: chunks visible (not stuck on Loading terrain)' },
  { id: 'move', claim: 'move: walk a few blocks; server-side position changed (RCON data get entity Pos)' },
  { id: 'break', claim: 'break: mine a block at an explicit coordinate; server-side air (execute if block)' },
  { id: 'place', claim: 'place: place a block on a support; server-side non-air' },
  { id: 'screenshot', claim: 'screenshot: at least one artifact preserved alongside this checklist' },
  { id: 'disconnect', claim: 'disconnect: leave the world; RCON list no longer shows the player' },
  { id: 'rejoin', claim: 'rejoin: relaunch the instance, reattach at the current position' }
])

// The placeholder evidence every row starts with. A row that still carries it
// records nothing: it says the operator meant to come back. The prefix is what the
// check reads, so a record written in the operator's own words is evidence and a
// template is not.
export const UNMODDED_PLACEHOLDER = '[MANUAL'

// The state that records a step the operator saw, and it held. It is the only pass on
// a step the list does not declare expected absent; a declared one may be recorded
// `not-seen` instead, and every other word is a refusal (#943). So there is no list of
// failing states: a word nobody defined cannot be read as a pass.
export const UNMODDED_STATE_OK = 'ok'

// The document `--lane unmodded` writes: every step pending, every row carrying the
// placeholder, and `completed` false. Nothing in it is a pass. The operator's own
// edits are the record, and the check reads those, not this file's prose.
//
// `steps` is the list the check is asked to read, and it is `UNMODDED_STEPS` for every
// caller in the tree: the writer and the checker take it the same way, so a test can
// read what the checklist says about a declaration the way it reads the verdict.
export function unmoddedWitness ({ server = '', gateLane = '', now = new Date().toISOString(), steps = UNMODDED_STEPS } = {}) {
  return {
    gate: 'B', row: 'B5-unmodded-witness (G0 manual lane)',
    lane: UNMODDED_WITNESS_LANE,
    clientLane: 'unmodded',
    // The gate lane this witness was written for, and the one value a G0 pass is bound by (#939).
    // Not named `lane`: that key above is the lane *kind*, which the check reads first, and one key
    // cannot be both. The lane is the caller's because only it can ask `scripts/gate-lane.sh`, and
    // an empty string is what a caller that forgot to ask leaves.
    gateLane,
    generatedAt: now,
    completed: false,
    status: 'NOT COMPLETE — exits nonzero until the operator records the manual run',
    how: [
      'Launch the UNMODDED Prism 26.2 instance (no monoplayer-driver mod installed) where you normally play Minecraft.',
      'Join the G0 Paper backend directly (' + server + ').',
      // Only when the caller named one: a checklist reading `belongs to lane ""` would look like a
      // lane name to the operator holding it.
      ...(gateLane === ''
        ? []
        : [
            'This checklist belongs to lane "' + gateLane + '": `--verify-g0` reads it against the lane the run\'s summary names, and refuses a witness from another lane with both lanes printed (#939).',
            'Generate this checklist on the day you walk it: its `generatedAt` is the date `--verify-g0` reads, and a witness outside the window the reports are read in is refused.'
          ]),
      'For each step below, do the action by hand, capture a grim screenshot, and set the row to `' + UNMODDED_STATE_OK + '` when you saw it hold. A step this list declares expected absent may be recorded `' + GAP_STATE + '` instead. Leave a row `pending` until you have looked.',
      'Write what you saw in the row\'s `evidence`. A `' + UNMODDED_PLACEHOLDER + '` placeholder is not evidence, and the check refuses it.'
    ],
    steps: steps.map(({ id, claim }) => ({
      id, claim, state: 'pending', evidence: UNMODDED_PLACEHOLDER + ': what you saw]'
    })),
    limitations: [
      'Manual lane: no driver. Evidence quality relies on coupled client observation + RCON checks, honestly labelled.',
      'A step set to `' + GAP_STATE + '` is a finding, not a pass, unless the step list declares that step expected absent.',
      'When every step carries a record — `' + UNMODDED_STATE_OK + '`, or `' + GAP_STATE + '` on a declared step — set completed true and copy this file to testdata/' + UNMODDED_WITNESS_FILE + '.',
      // #943: built from the declaration, so a step declared expected absent reaches this document
      // instead of leaving the operator to discover the rule in a refusal.
      ...steps.filter(step => step.openUntil !== undefined).map(step =>
        'The step \'' + step.id + '\' is expected to be ' + GAP_STATE + ' today: ' + closes(step.openUntil) +
        '. Record it ' + GAP_STATE + ' with what you saw, and the check accepts that gap.')
    ]
  }
}

// A refusal, in the one shape the two witness checks return, so a caller that reads `ok` and
// `reason` needs no guard on which return it got — and one that maps over a pass's two lists needs
// no guard either, because a refusal carries both empty. Exported because the dev lane's check
// builds its refusals here too, and two copies of a four-key shape drift. It is not the shape
// `verifyG0Evidence` returns: that reads two reports and answers in one sentence.
export const refusal = reason => ({ ok: false, reason, gaps: [], stale: [] })

// What is wrong with the rows before any state is read: whether one row records
// each step of the run, once, by id. No total is checked and no order is checked.
// A document that repeats one step and drops another keeps the count it started
// with, and the rows are looked up by id, so their order in the file carries no
// fact this check needs.
function witnessRowRefusal (rows, list) {
  const stepsAre = 'the steps are ' + namedIds(list.map(step => step.id))
  const named = rows.map((step, at) => ({
    at, id: typeof step?.id === 'string' && step.id !== '' ? step.id : null
  }))
  const unnamed = named.filter(row => row.id === null)
  if (unnamed.length > 0) {
    return 'the witness\'s ' + commaAnd(unnamed.map(row => 'row ' + (row.at + 1))) +
      agree(unnamed.length, ' carries', ' carry') + ' no step id: a row records one step of this run, and ' + stepsAre
  }
  const known = new Set(list.map(step => step.id))
  const unknown = named.filter(row => !known.has(row.id))
  if (unknown.length > 0) {
    return 'the witness\'s ' + commaAnd(unknown.map(row => 'row ' + (row.at + 1) + ' (`' + row.id + '`)')) +
      agree(unknown.length, ' is', ' are') + ' no step of this run: ' + stepsAre
  }
  const ids = named.map(row => row.id)
  const recorded = new Set(ids)
  const missing = list.map(step => step.id).filter(id => !recorded.has(id))
  const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))]
  if (missing.length > 0 || repeated.length > 0) {
    return [
      missing.length === 0 ? null : 'unwitnessed: ' + namedIds(missing),
      repeated.length === 0 ? null : 'recorded twice: ' + namedIds(repeated)
    ].filter(clause => clause !== null).join('; ')
  }
  return null
}

// Whether the unmodded witness records a run. It reads what the document says
// instead of a flag over it: a step still pending, a step carrying the placeholder
// evidence, and a step recorded as anything but `ok` are each refused by name
// (#922). A `not-seen` is the finding it always was too, except on a step
// `UNMODDED_STEPS` declares expected absent, which is the one gap a run accepts
// (#943). `completed` stays as the operator's own signature, so a document whose
// steps are all recorded and which nobody marked done is refused too.
//
// What it does not read: whether the evidence is true. A screenshot path, an RCON
// transcript and a sentence about what a screen showed are a person's word, and no
// check here can hold them.
//
// `steps` is `UNMODDED_STEPS` for every caller in the tree. It is a parameter so the
// rule can be read before the day a step needs it: a rule that first runs on the day
// somebody declares a gap is a rule nobody has read. A witness row cannot reach it —
// the declaration is code, and the row's own copy of it is overwritten below.
//
// #939: the document also has to be about the run it certifies. `gateLane` is the lane the report
// set's summary names, and the caller holding a report set always passes it; `undefined` is the
// caller reading the document alone, the way `verifyG0Evidence` reads a report set alone. The
// binding is read before the rows: a document from another lane is not evidence about this run
// whatever its rows say, and a refusal that began with "still pending" would send the operator to
// look at a checklist for the wrong backend.
export function verifyUnmoddedWitness (document, {
  steps = UNMODDED_STEPS, gateLane, now = Date.now(), maxAgeMs = Infinity,
} = {}) {
  if (document === null || typeof document !== 'object') {
    return refusal('the unmodded witness file is missing or is not a document: run --lane unmodded first')
  }
  if (document.lane !== UNMODDED_WITNESS_LANE) {
    return refusal('the witness names lane ' + JSON.stringify(document.lane) + ', not ' + JSON.stringify(UNMODDED_WITNESS_LANE))
  }
  // #939, the value a G0 pass is bound by. A witness is evidence about the lane it was walked
  // against, and the reports are evidence about theirs; the pair is one run only when the two names
  // agree. Both values are printed, because an operator holding a witness and a report set from
  // different lanes needs to see which one is from where.
  const witnessLane = typeof document.gateLane === 'string' ? document.gateLane : ''
  if (witnessLane === '') {
    return refusal('the witness names no lane, so it is evidence about no run: generate the checklist with --lane unmodded, which writes the lane into it')
  }
  if (gateLane !== undefined && witnessLane !== gateLane) {
    // Both values, and what to do about them: a refusal that only said the two disagreed sends the
    // operator to diff two documents by hand, and the lane that moved is the whole finding.
    return refusal('the witness is from lane "' + witnessLane + '", and the report set it certifies is from lane "' + gateLane +
      '": a G0 pass is one run, and these are two. Run --lane unmodded on the lane the reports name')
  }
  // #939: the age the reports are held to, from the same function. `generatedAt` is the writer's
  // clock and not the walk's — the runbook tells the operator to generate the checklist on the day
  // they walk it, and the rule is stated as what the file can be read as. Nothing offline can date
  // the walk, and this claims no more than it reads.
  const age = ageRefusal({
    at: Date.parse(document.generatedAt),
    now,
    maxAgeMs,
    subject: 'the witness',
    stamped: 'it was generated at',
    field: 'generatedAt',
  })
  if (age !== null) return refusal(age)
  const rows = Array.isArray(document.steps) ? document.steps : []
  const misplaced = witnessRowRefusal(rows, steps)
  if (misplaced !== null) return refusal(misplaced)
  const byId = new Map(rows.map(row => [row.id, row]))
  // Past the identity check every step is present once, and the row is read against
  // the list's step: the claim is the list's, because a row's own claim is a label
  // the operator may have reworded. The declaration is the list's for the same
  // reason, and it is set on every row whether or not the step declares one: a
  // hand-edited row carrying its own `openUntil` would otherwise make its own step
  // expected absent, and the file is the one part of this a person can edit.
  const settled = steps.map(({ id, claim, ...declared }) => ({
    ...byId.get(id), id, claim, ...declared, openUntil: declared.openUntil ?? null
  }))
  const open = settled.filter(step => OPEN_STATES.has(step.state))
  if (open.length > 0) {
    return refusal('still pending: ' + namedIds(open.map(step => step.id)))
  }
  const silent = settled.filter(step => typeof step.evidence !== 'string' || step.evidence.trim() === '')
  if (silent.length > 0) {
    return refusal('no evidence recorded: ' + namedIds(silent.map(step => step.id)))
  }
  // Trimmed before the prefix is read: the file is hand-edited, and a placeholder
  // an operator indented records exactly as little as the one the writer emits.
  const placeholder = settled.filter(step => step.evidence.trim().startsWith(UNMODDED_PLACEHOLDER))
  if (placeholder.length > 0) {
    return refusal('the placeholder `' + UNMODDED_PLACEHOLDER + '` is not evidence: ' + namedIds(placeholder.map(step => step.id)))
  }
  const unknown = settled.filter(step => step.state !== UNMODDED_STATE_OK && step.state !== GAP_STATE)
  if (unknown.length > 0) {
    return refusal('not ok: ' + unknown.map(step => '`' + step.id + '` is `' + String(step.state) + '` (' + step.evidence + ')').join('; '))
  }
  if (document.completed !== true) {
    return refusal('every step is recorded and the witness is not marked completed: set completed true')
  }
  // The one rule, read from the one place both witnesses keep it (#943).
  const { declared, gaps, stale, unexpected } = gapSplit(settled)
  if (unexpected.length > 0) {
    const recorded = 'not seen: ' + unexpected.map(step => '`' + step.id + '` (' + step.evidence + ')').join('; ')
    return refusal(declared.length === 0
      ? recorded + ': no step this run reads is declared expected absent, so every step is recorded `' +
        UNMODDED_STATE_OK + '`. A step recorded `' + GAP_STATE + '` passes only when the step list declares it expected absent with `openUntil`, naming the tickets that close it'
      : recorded + ': the only `' + GAP_STATE + '` this run accepts is a step declared expected absent, ' +
        commaAnd(declared.map(step => '`' + step.id + '` (' + closes(step.openUntil) + ')')))
  }
  // The pass carries what it accepted, so `--verify-g0` prints it: a gap the operator recorded stays
  // on the run's own output, and so does a declaration the operator's record outlived (#963), and the
  // lane the two halves were bound by (#939). A refusal carries neither list: it stops before the
  // split, and its `reason` already names the step.
  return { ok: true, reason: null, gaps: gaps.map(declaredOf), stale: stale.map(declaredOf), gateLane: witnessLane }
}

// The unmodded half of the G0 command's pass (#963): the sentence, one line per gap it accepted, and
// one per declaration its witness outlived. src/driver/run.js prints what this returns and words
// nothing itself, so the lines a reviewer reads are held by a case that reads the verdict, not by a
// string typed in the command. It says nothing about the two driver reports: the command printed that
// line from the summary it verified, and this function is handed only the witness.
//
// The sentence names what the witness recorded as a gap. It used to say the witness "records every
// step", which is true of a pass over a declared hole and reads as "the operator saw every step" — the
// reading #943 exists to stop. It does not now say the witness skipped the step either: a gap is
// recorded, as `not-seen`, and the line says so.
//
// Only a pass reaches here. A refusal carries the two lists empty, and the command stops on one before
// it prints.
export function formatUnmoddedPass (witnessVerdict) {
  const { gaps, stale } = witnessVerdict
  const sentence = gaps.length === 0
    ? 'G0 VERIFIED: the unmodded witness records every step `' + UNMODDED_STATE_OK + '`.'
    : 'G0 VERIFIED: the unmodded witness records every step, and ' + namedIds(gaps.map(gap => gap.id)) +
      ' ' + agree(gaps.length, 'is', 'are') + ' `' + GAP_STATE + '`: ' +
      agree(gaps.length, 'a declared gap', 'declared gaps') + ', printed below.'
  // The lane is the value the pass was bound by (#939), so the terminal that says the proof stands
  // says which run it stands for. It is read from the verdict, not typed here: a document-only pass
  // carries the witness's own lane and this sentence stays true either way.
  return [
    sentence + ' The witness names lane "' + witnessVerdict.gateLane + '".',
    ...gaps.map(gap => gapLine(gap, { withEvidence: true })),
    ...stale.map(step => staleLine(step, { list: UNMODDED_LIST_NAME, state: UNMODDED_STATE_OK }))
  ].join('\n')
}

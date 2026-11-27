// Pure evidence helpers for the driver lane: RCON output parsing,
// numeric comparisons with tolerances, client-status predicates, block-test
// parsing, and the unmodded witness's steps and the check that reads them
// (#922). No I/O and no env access of any kind, so the unit tests stay fully
// offline.
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
  // gate can only be green on evidence this checkout produced recently.
  const finished = Date.parse(sorted[1].finishedAt ?? sorted[1].startedAt)
  if (Number.isFinite(maxAgeMs) && Number.isFinite(finished) && now - finished > maxAgeMs) {
    return {
      ok: false,
      reason: `driver evidence is stale: the newest run finished at ${new Date(finished).toISOString()}, outside the ${Math.round(maxAgeMs / 60000)}-minute window`,
    }
  }
  return { ok: true, reason: '2/2 consecutive driver runs' }
}

// ---------------------------------------------------------------------------
// The unmodded witness (#922)
// ---------------------------------------------------------------------------

// The unmodded lane's human half is recorded in a document a person fills in by
// hand. Its file name is here because the writer names it and the check reads it.
export const UNMODDED_WITNESS_FILE = 'driver-unmodded-witness.json'
export const UNMODDED_WITNESS_LANE = 'unmodded'

// The steps the unmodded witness records, in the order an operator does them. One
// list, read at both ends: `unmoddedWitness` writes a row per step and
// `verifyUnmoddedWitness` reads those rows back, so the checklist and the check
// cannot drift (#922). `id` is the name a refusal carries and the name a row
// records, by the rule `OPERATOR_STEPS` states one file over for the dev lane's
// witness: a row is named by an id, never by prose a rewrite rewords. `claim` is
// the sentence the checklist prints and the operator answers, and it names the
// reading that settles the step, because that sentence is all an operator has to
// go on when they come back to it.
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

// The one state that records a step the operator saw, and it held. Every other
// state is a refusal, which is why there is no list of failing states: `ok` is the
// only pass, so a word nobody defined cannot be read as one.
export const UNMODDED_STATE_OK = 'ok'

// The document `--lane unmodded` writes: every step pending, every row carrying the
// placeholder, and `completed` false. Nothing in it is a pass. The operator's own
// edits are the record, and the check reads those, not this file's prose.
export function unmoddedWitness ({ server = '', now = new Date().toISOString() } = {}) {
  return {
    gate: 'B', row: 'B5-unmodded-witness (G0 manual lane)',
    lane: UNMODDED_WITNESS_LANE,
    clientLane: 'unmodded',
    generatedAt: now,
    completed: false,
    status: 'NOT COMPLETE — exits nonzero until the operator records the manual run',
    how: [
      'Launch the UNMODDED Prism 26.2 instance (no monoplayer-driver mod installed) where you normally play Minecraft.',
      'Join the G0 Paper backend directly (' + server + ').',
      'For each step below, do the action by hand, capture a grim screenshot, and set the row to `' + UNMODDED_STATE_OK + '` or leave it `pending`.',
      'Write what you saw in the row\'s `evidence`. A `' + UNMODDED_PLACEHOLDER + '` placeholder is not evidence, and the check refuses it.'
    ],
    steps: UNMODDED_STEPS.map(({ id, claim }) => ({
      id, claim, state: 'pending', evidence: UNMODDED_PLACEHOLDER + ': what you saw]'
    })),
    limitations: [
      'Manual lane: no driver. Evidence quality relies on coupled client observation + RCON checks, honestly labelled.',
      'When every step is `' + UNMODDED_STATE_OK + '`, set completed true and copy this file to testdata/' + UNMODDED_WITNESS_FILE + '.'
    ]
  }
}

// A list in a sentence: "`a`, `b` and `c`". The two helpers below and this one
// are src/driver/dev-proof.js's, copied so the two witnesses are refused in one
// voice; that file answers the other hand-filled witness and is not this one's to
// change.
const namedIds = ids => ids.map(id => '`' + id + '`').join(', ')
const commaAnd = items => (items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1))
const agree = (count, one, many) => (count === 1 ? one : many)

// What is wrong with the rows before any state is read: whether one row records
// each step of the run, once, by id. No total is checked and no order is checked.
// A document that repeats one step and drops another keeps the count it started
// with, and the rows are looked up by id, so their order in the file carries no
// fact this check needs.
function witnessRowRefusal (steps) {
  const stepsAre = 'the steps are ' + namedIds(UNMODDED_STEPS.map(step => step.id))
  const rows = steps.map((step, at) => ({
    at, id: typeof step?.id === 'string' && step.id !== '' ? step.id : null
  }))
  const unnamed = rows.filter(row => row.id === null)
  if (unnamed.length > 0) {
    return 'the witness\'s ' + commaAnd(unnamed.map(row => 'row ' + (row.at + 1))) +
      agree(unnamed.length, ' carries', ' carry') + ' no step id: a row records one step of this run, and ' + stepsAre
  }
  const known = new Set(UNMODDED_STEPS.map(step => step.id))
  const unknown = rows.filter(row => !known.has(row.id))
  if (unknown.length > 0) {
    return 'the witness\'s ' + commaAnd(unknown.map(row => 'row ' + (row.at + 1) + ' (`' + row.id + '`)')) +
      agree(unknown.length, ' is', ' are') + ' no step of this run: ' + stepsAre
  }
  const ids = rows.map(row => row.id)
  const recorded = new Set(ids)
  const missing = UNMODDED_STEPS.map(step => step.id).filter(id => !recorded.has(id))
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
// evidence, and a step recorded as anything but ok are each refused by name
// (#922). `completed` stays as the operator's own signature, so a document whose
// steps are all recorded and which nobody marked done is refused too.
//
// What it does not read: whether the evidence is true. A screenshot path, an RCON
// transcript and a sentence about what a screen showed are a person's word, and no
// check here can hold them.
export function verifyUnmoddedWitness (document) {
  if (document === null || typeof document !== 'object') {
    return {
      ok: false,
      reason: 'the unmodded witness file is missing or is not a document: run --lane unmodded first'
    }
  }
  if (document.lane !== UNMODDED_WITNESS_LANE) {
    return {
      ok: false,
      reason: 'the witness names lane ' + JSON.stringify(document.lane) + ', not ' + JSON.stringify(UNMODDED_WITNESS_LANE)
    }
  }
  const steps = Array.isArray(document.steps) ? document.steps : []
  const misplaced = witnessRowRefusal(steps)
  if (misplaced !== null) return { ok: false, reason: misplaced }
  const byId = new Map(steps.map(step => [step.id, step]))
  // Past the identity check every step is present once, and the row is read
  // against the module's step: the claim is the module's, because a row's own claim
  // is a label the operator may have reworded, and whatever else a step declares
  // (#920's expectedly-open ticket, when it lands) travels with it instead of being
  // dropped here.
  const settled = UNMODDED_STEPS.map(({ id, claim, ...declared }) => ({ ...byId.get(id), id, claim, ...declared }))
  const open = settled.filter(step => step.state === undefined || step.state === 'pending')
  if (open.length > 0) {
    return { ok: false, reason: 'still pending: ' + namedIds(open.map(step => step.id)) }
  }
  const silent = settled.filter(step => typeof step.evidence !== 'string' || step.evidence.trim() === '')
  if (silent.length > 0) {
    return { ok: false, reason: 'no evidence recorded: ' + namedIds(silent.map(step => step.id)) }
  }
  // Trimmed before the prefix is read: the file is hand-edited, and a placeholder
  // an operator indented records exactly as little as the one the writer emits.
  const placeholder = settled.filter(step => step.evidence.trim().startsWith(UNMODDED_PLACEHOLDER))
  if (placeholder.length > 0) {
    return {
      ok: false,
      reason: 'the placeholder `' + UNMODDED_PLACEHOLDER + '` is not evidence: ' + namedIds(placeholder.map(step => step.id))
    }
  }
  const notOk = settled.filter(step => step.state !== UNMODDED_STATE_OK)
  if (notOk.length > 0) {
    return {
      ok: false,
      reason: 'not ok: ' + notOk.map(step => '`' + step.id + '` is `' + String(step.state) + '` (' + step.evidence + ')').join('; ')
    }
  }
  if (document.completed !== true) {
    return { ok: false, reason: 'every step is recorded and the witness is not marked completed: set completed true' }
  }
  return { ok: true, reason: null }
}

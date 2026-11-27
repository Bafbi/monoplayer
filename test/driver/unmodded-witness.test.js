// #922: the unmodded witness's human half. `--verify-g0` accepted it on `completed: true` and
// `lane: 'unmodded'` and read no step of it, so a document marked done over eight pending rows
// verified — the defect #880 fixed one lane over, still standing here.
//
// The rule now reads the document: src/driver/checks.js's `verifyUnmoddedWitness` over
// `UNMODDED_STEPS`, the rows the writer emits, named by id the way the dev lane's witness is
// (src/driver/dev-proof.js, `OPERATOR_STEPS`).
//
// Why the rule is tested through checks.js and the caller as text: src/driver/run.js runs `main()`
// when it is imported, and its evidence paths are this checkout's `testdata/`, so a test cannot
// import or spawn it offline. The rule is the fact; the last case holds the caller to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  UNMODDED_PLACEHOLDER, UNMODDED_STATE_OK, UNMODDED_STEPS, UNMODDED_WITNESS_LANE, unmoddedWitness,
  verifyUnmoddedWitness,
} from '../../src/driver/checks.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = readFileSync(path.join(ROOT, 'src', 'driver', 'run.js'), 'utf8')
const CHECKS = readFileSync(path.join(ROOT, 'src', 'driver', 'checks.js'), 'utf8')
const DEV_PROOF = readFileSync(path.join(ROOT, 'src', 'driver', 'dev-proof.js'), 'utf8')
const PAGE = readFileSync(path.join(ROOT, 'docs', 'driver-lane.md'), 'utf8')
const SERVER = 'monoplayer-gate-b-paper.tail41e568.ts.net:25565'

// What an operator's finished witness looks like: the writer's document with every row recorded
// and the document signed. Each case below breaks exactly one thing in it.
function recorded () {
  const witness = unmoddedWitness({ server: SERVER, now: '2026-11-09T01:37:37.000Z' })
  return {
    ...witness,
    completed: true,
    steps: witness.steps.map(step => ({ ...step, state: UNMODDED_STATE_OK, evidence: 'what I saw: ' + step.id }))
  }
}

const stepIds = () => UNMODDED_STEPS.map(step => step.id)

// "row 1, row 2 and row 3", built from the count so a step added above needs no
// edit here.
const rowList = count => commaAnd(Array.from({ length: count }, (_, at) => 'row ' + (at + 1)))
const commaAnd = items => (items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1))

test('the checklist the writer emits records no step, and the check refuses it by name', () => {
  const verdict = verifyUnmoddedWitness(unmoddedWitness({ server: SERVER }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'still pending: ' + stepIds().map(id => '`' + id + '`').join(', '),
    'a fresh checklist is refused, and every step it left open is named')
})

test('the writer\'s rows are the declared steps: one row per step, in order, with the list\'s sentence', () => {
  const witness = unmoddedWitness({ server: SERVER })
  assert.equal(witness.lane, UNMODDED_WITNESS_LANE)
  assert.equal(witness.completed, false, 'the writer signs nothing')
  assert.deepEqual(witness.steps.map(step => step.id), stepIds(), 'the rows are UNMODDED_STEPS, in its order')
  assert.deepEqual(witness.steps.map(step => step.claim), UNMODDED_STEPS.map(step => step.claim),
    'each row carries the step\'s own sentence, so the writer and the check cannot drift')
  for (const step of witness.steps) {
    assert.equal(step.state, 'pending', 'nothing is recorded until a person records it: ' + step.id)
    assert.match(step.evidence, /^\[MANUAL/, 'the placeholder is obviously not evidence: ' + step.id)
  }
})

test('a witness marked completed over eight pending steps is refused: the flag is not the record', () => {
  // The document #922 was filed about: every row still pending, every evidence the
  // placeholder, and the operator set completed true.
  const verdict = verifyUnmoddedWitness({ ...unmoddedWitness({ server: SERVER }), completed: true })
  assert.equal(verdict.ok, false, 'completed: true over eight pending steps is not a pass')
  assert.equal(verdict.reason, 'still pending: ' + stepIds().map(id => '`' + id + '`').join(', '))
})

test('a witness marked completed over a step that is missing is refused, and names the step', () => {
  const witness = recorded()
  witness.steps = witness.steps.filter(step => step.id !== 'break')
  const verdict = verifyUnmoddedWitness(witness)
  assert.equal(verdict.ok, false, 'completed: true over seven of eight steps is not a pass')
  assert.equal(verdict.reason, 'unwitnessed: `break`')
})

test('a witness marked completed over a step still pending is refused, and names the step', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'move' ? { ...step, state: 'pending' } : step))
  assert.deepEqual(verifyUnmoddedWitness(witness), { ok: false, reason: 'still pending: `move`', gaps: [] })
})

test('a step left on the placeholder evidence is refused, and named', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'screenshot'
    ? { ...step, evidence: UNMODDED_PLACEHOLDER + ': file path]' }
    : step))
  const verdict = verifyUnmoddedWitness(witness)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'the placeholder `[MANUAL` is not evidence: `screenshot`')
})

test('an indented placeholder is still a placeholder, and is refused', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'render'
    ? { ...step, evidence: '  ' + UNMODDED_PLACEHOLDER + ': notes]' }
    : step))
  assert.deepEqual(verifyUnmoddedWitness(witness),
    { ok: false, reason: 'the placeholder `[MANUAL` is not evidence: `render`', gaps: [] })
})

test('a step left with no evidence at all is refused, and named', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'rejoin' ? { ...step, evidence: '  ' } : step))
  assert.deepEqual(verifyUnmoddedWitness(witness), { ok: false, reason: 'no evidence recorded: `rejoin`', gaps: [] })
})

test('a step recorded as anything but ok is refused, and named, whatever word the operator wrote', () => {
  for (const state of ['not-ok', 'not-ok-seen', 'failed']) {
    const witness = recorded()
    witness.steps = witness.steps.map(step => (step.id === 'break' ? { ...step, state } : step))
    const verdict = verifyUnmoddedWitness(witness)
    // `ok` is the only pass, so a state nobody defined cannot be read as one.
    assert.equal(verdict.ok, false, state + ' is not a pass')
    assert.equal(verdict.reason, 'not ok: `break` is `' + state + '` (what I saw: break)')
  }
})

test('a witness whose every step is recorded but which nobody marked completed is refused', () => {
  const witness = { ...recorded(), completed: false }
  assert.deepEqual(verifyUnmoddedWitness(witness),
    { ok: false, reason: 'every step is recorded and the witness is not marked completed: set completed true', gaps: [] })
})

test('a row that records no step id is refused: the eight steps are named, not counted', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(({ id, ...rest }) => rest)
  const verdict = verifyUnmoddedWitness(witness)
  assert.equal(verdict.ok, false, 'eight unnamed rows are not the eight steps')
  assert.ok(verdict.reason.startsWith('the witness\'s ' + rowList(UNMODDED_STEPS.length) + ' carry no step id: '),
    'every unnamed row is named, and the verb agrees with the count: ' + verdict.reason)
})

test('a row recording a step this run has not got is refused, and the step it names is quoted', () => {
  const witness = recorded()
  witness.steps = [...witness.steps, { id: 'jump', claim: 'jump: something else', state: 'ok', evidence: 'it did' }]
  assert.match(verifyUnmoddedWitness(witness).reason, /^the witness's row 9 \(.jump.\) is no step of this run: /)
  // Two, and the verb agrees: the count is what the sentence turns on, so one row
  // and two rows cannot share a wording.
  const twoUnknown = recorded()
  twoUnknown.steps = [...twoUnknown.steps, { id: 'jump' }, { id: 'hop' }]
  assert.match(verifyUnmoddedWitness(twoUnknown).reason,
    /^the witness's row 9 \(.jump.\) and row 10 \(.hop.\) are no step of this run: /)
})

test('a step recorded twice counts once, and the step it displaced is unwitnessed', () => {
  const witness = recorded()
  witness.steps = witness.steps
    .filter(step => step.id !== 'rejoin')
    .map(step => (step.id === 'join' ? [...[step], { ...step }] : [step]))
    .flat()
  assert.deepEqual(verifyUnmoddedWitness(witness), {
    ok: false, reason: 'unwitnessed: `rejoin`; recorded twice: `join`', gaps: []
  })
})

test('a witness whose every step is ok, with evidence, and signed, passes', () => {
  assert.deepEqual(verifyUnmoddedWitness(recorded()), { ok: true, reason: null, gaps: [] })
})

// #943: the dev lane's witness accepts a `not-seen` on a step its list declares expected absent
// (#920), and this lane refused every one, so the day a G0 step is expected absent an honest
// operator cannot record it and the only way to pass is to write `ok` over something they did not
// see. The rule is #920's, read from one place — `gapSplit` in src/driver/checks.js — which the dev
// lane's witness calls too.
//
// No step of UNMODDED_STEPS is declared absent today, so the declaration these cases read is a copy
// of the list with one entry declared. The day a real step needs one it is the same rule, and the
// case that reads the list without a declaration is the one below it.
const DECLARED_STEP = 'rejoin'
const declaredList = () => UNMODDED_STEPS.map(step => (step.id === DECLARED_STEP
  ? { ...step, openUntil: Object.freeze([647]) }
  : step))
const notSeen = (witness, over = {}) => witness.steps.map(step => (step.id === DECLARED_STEP
  ? { ...step, state: 'not-seen', evidence: 'relaunched, and the client reattached at the spawn point', ...over }
  : step))

test('a step its list declares expected absent verifies when it is recorded not-seen, and the pass names the gap', () => {
  const witness = recorded()
  witness.steps = notSeen(witness)
  const verdict = verifyUnmoddedWitness(witness, { steps: declaredList() })
  assert.deepEqual({ ok: verdict.ok, reason: verdict.reason }, { ok: true, reason: null },
    'an honest run with the declared gap is a record, not a finding: ' + verdict.reason)
  assert.deepEqual(verdict.gaps, [{
    id: DECLARED_STEP,
    claim: UNMODDED_STEPS.find(step => step.id === DECLARED_STEP).claim,
    openUntil: [647],
    evidence: 'relaunched, and the client reattached at the spawn point'
  }], 'the gap the pass accepted is named, with the tickets that close it')
})

test('a not-seen on a step nothing declares is refused, in a sentence naming the step', () => {
  const witness = recorded()
  witness.steps = notSeen(witness)
  assert.deepEqual(verifyUnmoddedWitness(witness), {
    ok: false,
    reason: 'not seen: `rejoin` (relaunched, and the client reattached at the spawn point): ' +
      'no step of UNMODDED_STEPS is declared expected absent, so every step of this run is recorded `ok`. ' +
      'A step recorded `not-seen` needs its own entry in that list to declare it, with the tickets that close it',
    gaps: []
  }, 'a not-seen is the finding it always was unless the list\'s own entry accounts for it')
})

test('a not-seen the list does declare is named against the gap this run expects when another step is refused', () => {
  const witness = recorded()
  witness.steps = notSeen(witness, { evidence: 'the row says so' })
    .map(step => (step.id === 'break' ? { ...step, state: 'not-seen' } : step))
  const verdict = verifyUnmoddedWitness(witness, { steps: declaredList() })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /^not seen: `break` \(what I saw: break\)/, 'the undeclared one is named first')
  assert.match(verdict.reason, /`rejoin` \(#647 closes it\)/, 'and the gap this run does expect is named with its ticket')
})

test('a row that declares its own step expected absent is refused: the declaration is the list\'s', () => {
  const witness = recorded()
  witness.steps = notSeen(witness, { openUntil: [647], evidence: 'the row says so' })
  const verdict = verifyUnmoddedWitness(witness)
  assert.equal(verdict.ok, false, 'the file is hand-edited, and a step that could declare itself absent would pass by writing a line')
  assert.match(verdict.reason, /^not seen: `rejoin` \(the row says so\):/)
})

test('both witnesses read one rule: the gap split is checks.js\'s, and the dev lane imports it', () => {
  assert.match(CHECKS, /export function gapSplit/, 'src/driver/checks.js holds the rule')
  assert.match(DEV_PROOF, /import \{[^}]*\bgapSplit\b[^}]*\} from '\.\/checks\.js'/,
    'src/driver/dev-proof.js reads the rule from there rather than spelling a second one')
  assert.doesNotMatch(DEV_PROOF, /openUntil === null/, 'and no longer decides a gap for itself')
})

test('the runbook states the rule for a step expected absent, in the section an operator reads', () => {
  const from = PAGE.indexOf('## The unmodded witness lane')
  const section = PAGE.slice(from, PAGE.indexOf('## The G0 verdict'))
  assert.ok(from !== -1 && section.length > 0, 'the runbook has the unmodded witness section')
  assert.match(section, /not-seen/, 'the page names the state a gap is recorded in')
  assert.match(section, /openUntil/, 'and the declaration the check reads')
  assert.match(section, /UNMODDED_STEPS/, 'and the one list an operator declares one in')
  assert.match(section, /hand-edited/, 'and why the declaration cannot live in the row')
})

test('the witness is read as a document: no file, another lane, no rows', () => {
  assert.deepEqual(verifyUnmoddedWitness(null),
    { ok: false, reason: 'the unmodded witness file is missing or is not a document: run --lane unmodded first', gaps: [] })
  assert.match(verifyUnmoddedWitness({ ...recorded(), lane: 'driver' }).reason,
    /^the witness names lane "driver", not "unmodded"$/)
  assert.match(verifyUnmoddedWitness({ ...recorded(), steps: undefined }).reason,
    /^unwitnessed: `join`/)
})

test('\`--verify-g0\` refuses with this rule, and no longer on the flag alone', () => {
  assert.match(RUN, /verifyUnmoddedWitness\(witness\)/, 'src/driver/run.js asks the checker about the document')
  assert.match(RUN, /NOT COMPLETE: \$\{witnessVerdict\.reason\}/, 'and prints the reason, which names the step')
  assert.doesNotMatch(RUN, /witness\.completed !== true/,
    'the one-line flag check #922 found is gone: a completed flag is no longer the whole of the human half')
  assert.match(RUN, /unmoddedWitness\(\{ server \}\)/, 'the checklist the lane writes is the checker\'s own document')
})

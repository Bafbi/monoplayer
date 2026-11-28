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
  GAP_STATE, UNMODDED_LIST_NAME, UNMODDED_PLACEHOLDER, UNMODDED_RECORD_STATES, UNMODDED_STATE_OK,
  UNMODDED_STEPS, UNMODDED_WITNESS_FILE, UNMODDED_WITNESS_LANE, declaresGap,
  formatUnmoddedExpectation, formatUnmoddedPass, gapLine, staleLine, unmoddedWitness, verifyUnmoddedWitness,
} from '../../src/driver/checks.js'
import { OPERATOR_LIST_NAME } from '../../src/driver/dev-proof.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = readFileSync(path.join(ROOT, 'src', 'driver', 'run.js'), 'utf8')
const CHECKS = readFileSync(path.join(ROOT, 'src', 'driver', 'checks.js'), 'utf8')
const DEV_PROOF = readFileSync(path.join(ROOT, 'src', 'driver', 'dev-proof.js'), 'utf8')
const PAGE = readFileSync(path.join(ROOT, 'docs', 'driver-lane.md'), 'utf8')
const SERVER = 'monoplayer-gate-b-paper.tail41e568.ts.net:25565'

// #939: the two halves of a G0 pass were verified apart, so a witness recorded on one day verified
// beside two reports produced on another and the pair read as one run. A lane is the value both
// documents can carry, and these are two of them: neither is a lane any worktree derives.
const LANE = 'monoplayer-gate-1a2c3e5'
const OTHER_LANE = 'monoplayer-gate-2b8e4d1'

// What an operator's finished witness looks like: the writer's document with every row recorded
// and the document signed. Each case below breaks exactly one thing in it.
function recorded ({ gateLane = LANE } = {}) {
  const witness = unmoddedWitness({ server: SERVER, gateLane, now: '2026-11-09T01:37:37.000Z' })
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
  const verdict = verifyUnmoddedWitness(unmoddedWitness({ server: SERVER, gateLane: LANE }))
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
  const verdict = verifyUnmoddedWitness({ ...unmoddedWitness({ server: SERVER, gateLane: LANE }), completed: true })
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
  assert.deepEqual(verifyUnmoddedWitness(witness),
    { ok: false, reason: 'still pending: `move`', gaps: [], stale: [] })
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
    { ok: false, reason: 'the placeholder `[MANUAL` is not evidence: `render`', gaps: [], stale: [] })
})

test('a step left with no evidence at all is refused, and named', () => {
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'rejoin' ? { ...step, evidence: '  ' } : step))
  assert.deepEqual(verifyUnmoddedWitness(witness), { ok: false, reason: 'no evidence recorded: `rejoin`', gaps: [], stale: [] })
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
    { ok: false, reason: 'every step is recorded and the witness is not marked completed: set completed true', gaps: [], stale: [] })
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
    ok: false, reason: 'unwitnessed: `rejoin`; recorded twice: `join`', gaps: [], stale: [] })
})

test('a witness whose every step is ok, with evidence, and signed, passes, with no gap and nothing stale', () => {
  // #963: the pass carries the two lists the G0 command prints. Empty here, because the list
  // declares no step expected absent and the operator recorded every one. #939: it carries the
  // lane too, which is the value the pass is bound by.
  assert.deepEqual(verifyUnmoddedWitness(recorded()),
    { ok: true, reason: null, gaps: [], stale: [], gateLane: LANE })
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
// The declaration as a verdict carries it: the step's own words, the tickets the declared list
// names, and what this witness recorded beside the step. Read from the list and the witness, so no
// case types the sentence the command prints (#963).
const gapOf = (witness, id) => {
  const step = declaredList().find(entry => entry.id === id)
  const row = witness.steps.find(entry => entry.id === id)
  return { id, claim: step.claim, openUntil: step.openUntil, evidence: row.evidence }
}
const notSeen = (witness, over = {}) => witness.steps.map(step => (step.id === DECLARED_STEP
  ? { ...step, state: GAP_STATE, evidence: 'relaunched, and the client reattached at the spawn point', ...over }
  : step))

test('a step its list declares expected absent verifies when it is recorded not-seen, and the checklist names the step', () => {
  const witness = recorded()
  witness.steps = notSeen(witness)
  const verdict = verifyUnmoddedWitness(witness, { steps: declaredList() })
  // The writer reads the same list: the checklist an operator is handed names the step it expects
  // them to record as a gap, out of the declaration rather than out of prose that could drift.
  const checklist = unmoddedWitness({ server: SERVER, steps: declaredList() })
  assert.ok(checklist.limitations.some(line => line.includes('The step \'' + DECLARED_STEP + '\' is expected to be not-seen today: #647 closes it')),
    'the generated checklist names the declared step and the ticket that closes it: ' + checklist.limitations.join(' | '))
  assert.equal(checklist.steps.length, declaredList().length, 'and still writes one row per step')
  assert.deepEqual(verdict, {
    ok: true, reason: null, gaps: [gapOf(witness, DECLARED_STEP)], stale: [], gateLane: LANE
  }, 'an honest run with the declared gap is a record, not a finding: ' + verdict.reason)
  // The other half of the declaration: a fix landing must not turn an honest record red. The step is
  // seen, the list still declares it, and the record passes — carrying the declaration it outlived,
  // which #963 prints as the dev lane's `stale declaration:` line.
  const seen = recorded()
  assert.deepEqual(verifyUnmoddedWitness(seen, { steps: declaredList() }),
    { ok: true, reason: null, gaps: [], stale: [gapOf(seen, DECLARED_STEP)], gateLane: LANE },
    'a declared step the operator did see is still a record')
})

test('a not-seen on a step nothing declares is refused, in a sentence naming the step', () => {
  const witness = recorded()
  witness.steps = notSeen(witness)
  assert.deepEqual(verifyUnmoddedWitness(witness), {
    ok: false,
    reason: 'not seen: `rejoin` (relaunched, and the client reattached at the spawn point): ' +
      'no step this run reads is declared expected absent, so every step is recorded `ok`. ' +
      'A step recorded `not-seen` passes only when the step list declares it expected absent with `openUntil`, naming the tickets that close it',
    gaps: [], stale: []
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
    { ok: false, reason: 'the unmodded witness file is missing or is not a document: run --lane unmodded first', gaps: [], stale: [] })
  assert.match(verifyUnmoddedWitness({ ...recorded(), lane: 'driver' }).reason,
    /^the witness names lane "driver", not "unmodded"$/)
  assert.match(verifyUnmoddedWitness({ ...recorded(), steps: undefined }).reason,
    /^unwitnessed: `join`/)
})

test('\`--verify-g0\` refuses with this rule, and no longer on the flag alone', () => {
  assert.match(RUN, /verifyUnmoddedWitness\(witness, \{/, 'src/driver/run.js asks the checker about the document')
  assert.match(RUN, /NOT COMPLETE: \$\{witnessVerdict\.reason\}/, 'and prints the reason, which names the step')
  assert.doesNotMatch(RUN, /witness\.completed !== true/,
    'the one-line flag check #922 found is gone: a completed flag is no longer the whole of the human half')
  assert.match(RUN, /unmoddedWitness\(\{ server, gateLane \}\)/, 'the checklist the lane writes is the checker\'s own document')
})

// #960: the refusal's second line is the sentence an operator reads to know what to write, and it
// named `ok` as the only record. #943 made a `not-seen` a pass on a step the list declares expected
// absent, so from that change the sentence sent an honest operator back to writing `ok` over a step
// they did not see — the record the checklist forbids. It is now built beside the rule it describes,
// out of the states the check accepts and the list that decides which of them apply. The path is the
// command's, because this module names the file and only the command knows the directory.
//
// Every case here reads the whole line, out of the module's constants, the way the pass sentence's
// case does: a fragment assertion leaves the rest of the sentence free to lose a fact the check
// refuses a document on. The two exact lines spell their middle, because an exact-output case has to
// — `lineEnding` is that shared fragment and derives nothing. The list each case reads is built
// locally rather than taken from UNMODDED_STEPS, so the day a real step declares a gap the pair still
// reads both worlds instead of going red on the change #943 and #960 exist for.
const WITNESS_PATH = 'testdata/' + UNMODDED_WITNESS_FILE
const expectation = (steps, gateLane = LANE) => formatUnmoddedExpectation({ witnessPath: WITNESS_PATH, gateLane, steps })
const lineEnding = gateLane => ', completed true, and the lane "' + gateLane + '" the summary names.'
// The records a sentence names, read from UNMODDED_RECORD_STATES rather than from a pair typed here:
// a record the check takes and the line does not name is the defect #960 was filed about, and the two
// cases below assert both directions over whatever that list holds.
const named = line => UNMODDED_RECORD_STATES.filter(record => line.includes('`' + record + '`'))
// One list per world, built from the module's list so a step added to it reaches these cases: declared
// where DECLARED_STEP carries `openUntil`, and undeclared where no entry does.
const undeclaredList = () => UNMODDED_STEPS.map(({ openUntil, ...step }) => step)
const withRecord = (witness, state) => ({
  ...witness,
  steps: witness.steps.map(step => (step.id === DECLARED_STEP ? { ...step, state, evidence: 'what I saw: ' + state } : step))
})

test('the refusal names both records a declared step accepts, and the checker takes either', () => {
  const line = expectation(declaredList())
  assert.equal(line, 'Expected ' + WITNESS_PATH + ' with lane "' + UNMODDED_WITNESS_LANE + '", one row per step ' +
    'recorded `' + UNMODDED_STATE_OK + '`, or `' + GAP_STATE + '` on a step `' + UNMODDED_LIST_NAME +
    '` declares expected absent with `openUntil`' + lineEnding(LANE),
    'the whole sentence, out of the module\'s constants: ' + line)
  assert.deepEqual(named(line), [...UNMODDED_RECORD_STATES], 'and every record the check takes is named: ' + line)
  // What the check does with each record the line names, so the sentence and the rule cannot part in
  // the accepting direction: the same witness, twice, and each record is a verdict that passes.
  for (const state of named(line)) {
    const verdict = verifyUnmoddedWitness(withRecord(recorded(), state), { steps: declaredList() })
    assert.equal(verdict.ok, true, 'the check takes `' + state + '` on the declared step: ' + verdict.reason)
  }
})

test('a list declaring no gap is told one record, and the checker refuses the other', () => {
  const line = expectation(undeclaredList())
  assert.equal(line, 'Expected ' + WITNESS_PATH + ' with lane "' + UNMODDED_WITNESS_LANE + '", one row per step ' +
    'recorded `' + UNMODDED_STATE_OK + '`' + lineEnding(LANE),
    'one record, because this list accepts one: ' + line)
  assert.deepEqual(named(line), [UNMODDED_STATE_OK], 'and the gap is not offered: ' + line)
  assert.ok(!line.includes('openUntil'), 'nor the declaration to look for, which nothing declares: ' + line)
  // The refusing direction: every record the line leaves out is a verdict the check refuses, so a
  // sentence that dropped one would be describing a document this run will not take.
  for (const state of UNMODDED_RECORD_STATES.filter(entry => !named(line).includes(entry))) {
    const verdict = verifyUnmoddedWitness(withRecord(recorded(), state), { steps: undeclaredList() })
    assert.equal(verdict.ok, false, 'a `' + state + '` the line does not name is refused: ' + verdict.reason)
  }
})

test('the line reads the list the check reads, when the caller names none', () => {
  // src/driver/run.js hands no `steps`, so the default is what an operator is answered with. The
  // equality below holds the default's output; it cannot hold that the default is UNMODDED_STEPS,
  // because a list with no declaration would word the same sentence, so the declaration is read here.
  assert.match(CHECKS, /export function formatUnmoddedExpectation \(\{ witnessPath, gateLane, steps = UNMODDED_STEPS \}\)/,
    'the default is the list verifyUnmoddedWitness reads by default')
  assert.equal(formatUnmoddedExpectation({ witnessPath: WITNESS_PATH, gateLane: LANE }), expectation(UNMODDED_STEPS),
    'and a caller that names no list gets that list\'s sentence')
})

test('a declaration carrying null is no declaration, on every side of the question', () => {
  // The two tests of it disagreed before #960 hoisted one out of gapSplit's closure: the split read
  // null as undeclared and the checklist writer read it as declared, then reached closes(null) and
  // threw before it printed anything. The one predicate settles it in the direction that refuses
  // rather than the one that crashes.
  const nulled = () => UNMODDED_STEPS.map(step => (step.id === DECLARED_STEP ? { ...step, openUntil: null } : step))
  assert.equal(declaresGap(nulled().find(step => step.id === DECLARED_STEP)), false, 'the predicate reads it as no declaration')
  assert.deepEqual(named(expectation(nulled())), [UNMODDED_STATE_OK], 'so the line offers one record')
  const verdict = verifyUnmoddedWitness(withRecord(recorded(), GAP_STATE), { steps: nulled() })
  assert.equal(verdict.ok, false, 'and the check refuses the gap it does not declare: ' + verdict.reason)
  assert.ok(!unmoddedWitness({ server: SERVER, steps: nulled() }).limitations.some(entry => entry.includes('expected to be ' + GAP_STATE)),
    'and the checklist prints no gap line for a step nothing declares')
})

// #963: the G0 pass printed one sentence and named nothing about the gap it accepted, so a pass over
// a declared hole read exactly like a pass where every step held — and a declaration its witness had
// outlived was invisible to everybody. The verdict now carries the two lists and src/driver/checks.js
// words them; src/driver/run.js prints what `formatUnmoddedPass` returns and types no sentence of
// its own.
const printed = verdict => formatUnmoddedPass(verdict).split('\n')

test('a pass accepting two declared gaps words both, and says "declared gaps"', () => {
  // The sentence carries an article, so the count reaches it: "a declared gap" cannot stand for two.
  const two = UNMODDED_STEPS.map(step => (['move', 'rejoin'].includes(step.id)
    ? { ...step, openUntil: Object.freeze([647]) }
    : step))
  const witness = recorded()
  witness.steps = witness.steps.map(step => (step.id === 'move' || step.id === 'rejoin'
    ? { ...step, state: 'not-seen', evidence: 'what I saw: ' + step.id }
    : step))
  const verdict = verifyUnmoddedWitness(witness, { steps: two })
  assert.equal(verdict.ok, true, verdict.reason)
  assert.equal(verdict.gaps.length, 2)
  const lines = printed(verdict)
  assert.equal(lines.length, 3, 'the sentence and one line per gap')
  assert.ok(lines[0].includes('`move`, `rejoin` are `not-seen`'), 'both gaps are named: ' + lines[0])
  assert.ok(lines[0].includes('declared gaps'), 'and the plural is worded: ' + lines[0])
  assert.doesNotMatch(lines[0], /a declared gaps/)
})

test('a pass prints one line per declared gap, naming the step, what the operator saw, and the tickets', () => {
  const witness = recorded()
  witness.steps = notSeen(witness)
  const verdict = verifyUnmoddedWitness(witness, { steps: declaredList() })
  const lines = printed(verdict)
  assert.equal(lines.length, 1 + verdict.gaps.length, 'the sentence, then one line per gap, and nothing else')
  // The words are the dev lane's, out of one builder: the line `--verify` prints for the same gap.
  assert.equal(lines[1], gapLine(verdict.gaps[0], { withEvidence: true }),
    'the gap line is the dev lane’s own, so the two commands cannot word one gap differently')
  assert.ok(lines[1].startsWith('known gap: ' + verdict.gaps[0].claim), 'the step’s own sentence leads it')
  assert.ok(lines[1].includes('and #647 closes it'), 'and the ticket that closes it is named: ' + lines[1])
  assert.ok(lines[1].includes(verdict.gaps[0].evidence), 'and what the operator recorded')
})

test('a pass over a declared gap does not claim every step was seen, and does not claim one was skipped', () => {
  const gapped = recorded()
  gapped.steps = notSeen(gapped)
  const sentence = printed(verifyUnmoddedWitness(gapped, { steps: declaredList() }))[0]
  assert.ok(sentence.includes('records every step'), 'the witness did record one: as `not-seen`')
  assert.ok(sentence.includes('`' + DECLARED_STEP + '` is `not-seen`'), 'and the gap is named: ' + sentence)
  assert.ok(sentence.includes('declared gap'), 'and it is named as the gap this pass accepts')
  // The whole line, both sentences: a pass that saw every step says so, and says which run it is a
  // pass for (#939). Built from the constants, so a step's own word and the lane are not retyped here.
  assert.equal(printed(verifyUnmoddedWitness(recorded()))[0],
    'G0 VERIFIED: the unmodded witness records every step `' + UNMODDED_STATE_OK + '`. ' +
    'The witness names lane "' + LANE + '".')
})

test('a declaration its witness outlived is printed, names the list to edit, and the pass still stands', () => {
  const verdict = verifyUnmoddedWitness(recorded(), { steps: declaredList() })
  assert.equal(verdict.ok, true, 'a fix landing must not turn an honest record red')
  const lines = printed(verdict)
  assert.equal(lines.length, 1 + verdict.stale.length)
  assert.match(lines[1], /^stale declaration: /, 'the dev lane’s own word for it, so a reader meets one sentence')
  assert.ok(lines[1].includes(verdict.stale[0].claim), 'the step it outlived is named')
  assert.ok(lines[1].includes(UNMODDED_STATE_OK + ', though ' + UNMODDED_LIST_NAME),
    'the row\'s own word, and the list this lane edits rather than the dev lane\'s: ' + lines[1])
  assert.ok(lines[1].includes(UNMODDED_LIST_NAME + ' still declares it expected absent'))
  assert.ok(lines[1].includes('#647 closes it'), 'and the tickets the declaration names')
  assert.ok(lines[1].includes('drop the step'), 'and what to do about it')
  // Nothing here reads a ticket's state: the gate is offline and no command can. So the line claims
  // what a run can see — the step held — and names the ticket a reviewer checks, which is the answer
  // #963 allows when the state is out of reach.
  assert.doesNotMatch(lines[1], /#647 lands/, 'and it claims nothing about a ticket it cannot read')
})

test('`--verify-g0` prints the expectation line the module words, and types no record of its own', () => {
  // The argument is the path the function already resolved, not a second spelling of it: the shorthand
  // is what makes that checkable, because `witnessPath: 'text'` would read the same to this file.
  assert.match(RUN, /formatUnmoddedExpectation\(\{ witnessPath, gateLane: summary\.gateLane \}\)/,
    'the command prints what the module words, and hands it the path and the lane it resolved')
  // #960's third acceptance: the reason is printed first and the command still exits 1, so the
  // expectation extends that refusal rather than replacing it.
  const reasonAt = RUN.indexOf('NOT COMPLETE: ${witnessVerdict.reason}')
  const expectationAt = RUN.indexOf('formatUnmoddedExpectation({')
  assert.ok(reasonAt !== -1, 'the check\'s reason is still the first line')
  assert.ok(expectationAt > reasonAt, 'and the expectation follows it: ' + reasonAt + ' then ' + expectationAt)
  assert.match(RUN.slice(expectationAt), /^[\s\S]{0,400}?return 1/, 'and the refusal still returns 1')
  assert.doesNotMatch(RUN, /one row per step recorded/,
    'the sentence that named one record is gone from the command, not reworded there')
  // The two constants the typed sentence retyped, banned at the site that retyped them rather than in
  // the whole command: a later line in run.js that legitimately spells one is not this case's business.
  const block = RUN.slice(RUN.indexOf('NOT COMPLETE:'), RUN.indexOf('Generate a checklist first'))
  assert.ok(block.length > 0, 'the refusal block is the span between the reason and the advice')
  assert.doesNotMatch(block, /"unmodded"|`ok`/, 'and it spells neither constant: ' + block)
})

test('`--verify-g0` prints the formatter’s lines, words nothing itself, and still exits 0', () => {
  assert.match(RUN, /formatUnmoddedPass\(witnessVerdict\)/, 'the command prints what the module words')
  assert.match(RUN, /formatUnmoddedPass\(witnessVerdict\)\)\n\s*return 0/,
    'and a pass, gap or stale declaration included, is still a pass: the exit stays 0')
  assert.doesNotMatch(RUN, /records every step/,
    'and the sentence that claimed every step was seen is gone from the command')
  assert.equal((RUN.match(/witnessVerdict\.(gaps|stale)/g) ?? []).length, 0,
    'the command decides nothing about a gap: the formatter reads the verdict')
})

test('the gap and stale lines live in checks.js, and the dev lane reads them from there', () => {
  // Each printed list name is the name of an export in the module that owns it, so a rename cannot
  // leave a stale declaration line telling a reader to edit a constant that no longer exists.
  assert.match(CHECKS, new RegExp('export const ' + UNMODDED_LIST_NAME + '\\b'),
    'the G0 lane\'s list name names an export in checks.js')
  assert.match(DEV_PROOF, new RegExp('export const ' + OPERATOR_LIST_NAME + '\\b'),
    'and the dev lane\'s names an export in dev-proof.js')
  assert.match(CHECKS, /export const gapLine/, 'src/driver/checks.js holds the gap line')
  assert.match(CHECKS, /export const staleLine/, 'and the stale line beside it')
  assert.match(CHECKS, /export function formatUnmoddedPass/, 'and the G0 pass that prints both')
  assert.doesNotMatch(DEV_PROOF, /^const gapLine/m, 'the dev lane no longer words its own copy')
  assert.doesNotMatch(DEV_PROOF, /^const staleLine/m, 'nor the stale one')
  assert.match(DEV_PROOF, /import \{[^}]*\bgapLine\b[^}]*\} from '\.\/checks\.js'/,
    'it imports both, so one gap is one sentence across the two lanes')
  assert.match(DEV_PROOF, /import \{[^}]*\bstaleLine\b[^}]*\} from '\.\/checks\.js'/)
})

// #939: a G0 pass is a claim about one run, and the witness and the report set were read as two
// independent documents. The witness now names the lane it was written for; the command hands the
// check the lane the report set names; a document from another lane is refused, both values named.
test('a witness from one lane beside the report set of another is refused, and the refusal names both', () => {
  const witness = recorded({ gateLane: OTHER_LANE })
  // Neither document is wrong on its own. That is the defect: the pair is the unit a G0 pass claims.
  assert.equal(verifyUnmoddedWitness(witness).ok, true, 'the document is a complete record of a run')
  const verdict = verifyUnmoddedWitness(witness, { gateLane: LANE })
  assert.equal(verdict.ok, false, 'a witness from another lane cannot certify this report set')
  assert.ok(verdict.reason.includes(OTHER_LANE), 'the lane the witness names: ' + verdict.reason)
  assert.ok(verdict.reason.includes(LANE), 'and the lane the report set names: ' + verdict.reason)
})

test('a witness and a report set of one lane pass, and the pass names the lane they share', () => {
  const verdict = verifyUnmoddedWitness(recorded(), { gateLane: LANE })
  assert.deepEqual(verdict, { ok: true, reason: null, gaps: [], stale: [], gateLane: LANE },
    'the fresh pair passes, and a caller can print the lane the two halves name')
  assert.ok(printed(verdict)[0].includes('lane "' + LANE + '"'), 'the pass sentence names it: ' + printed(verdict)[0])
})

test('a witness that names no lane is refused: it is evidence about no run', () => {
  const { gateLane, ...nameless } = recorded()
  assert.equal(gateLane, LANE, 'the writer wrote the lane this case removes')
  assert.match(verifyUnmoddedWitness(nameless).reason,
    /^the witness names no lane, so it is evidence about no run: generate the checklist with --lane unmodded, which writes the lane into it$/)
})

test('a witness generated outside the window the reports are read in is refused, and says when it was written', () => {
  const MAX_AGE = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-11-11T01:37:37.000Z')
  const verdict = verifyUnmoddedWitness(recorded(), { gateLane: LANE, now, maxAgeMs: MAX_AGE })
  assert.equal(verdict.ok, false, 'a witness written two days before the reports is not evidence about them')
  assert.equal(verdict.reason,
    'the witness is stale: it was generated at 2026-11-09T01:37:37.000Z, outside the 1440-minute window')
})

test('a witness inside the window passes, and a date nobody can read is refused rather than trusted', () => {
  const MAX_AGE = 24 * 60 * 60 * 1000
  const soon = Date.parse('2026-11-09T02:37:37.000Z')
  assert.equal(verifyUnmoddedWitness(recorded(), { gateLane: LANE, now: soon, maxAgeMs: MAX_AGE }).ok, true,
    'an hour after the checklist was written is inside a day')
  assert.match(verifyUnmoddedWitness({ ...recorded(), generatedAt: 'yesterday' }, { gateLane: LANE, now: soon, maxAgeMs: MAX_AGE }).reason,
    /^the witness carries no readable generatedAt, so its age cannot be read$/,
    'a generatedAt nobody can parse is not an age anybody can read')
  // A year typo moves the date past every age test there is, so the window is read both ways.
  assert.deepEqual(
    verifyUnmoddedWitness({ ...recorded(), generatedAt: '2062-11-09T01:37:37.000Z' }, { gateLane: LANE, now: soon, maxAgeMs: MAX_AGE }),
    {
      ok: false,
      reason: 'the witness is dated in the future: it says 2062-11-09T01:37:37.000Z, and this check is reading it at 2026-11-09T02:37:37.000Z',
      gaps: [], stale: []
    },
    'a witness no clock can have reached is refused, with both dates printed')
})

test('the writer records the lane beside the server, and the checklist says which lane it belongs to', () => {
  const witness = unmoddedWitness({ server: SERVER, gateLane: LANE })
  assert.equal(witness.gateLane, LANE, 'the lane is a field, not a sentence a reader has to parse')
  // The operator reads the rule in the checklist rather than in a refusal: a witness certifies the
  // reports of its own lane, and the window is the one the reports are read in.
  assert.ok(witness.how.some(line => line.includes('"' + LANE + '"') && line.includes('--verify-g0')),
    'the how list names the lane and the command that reads it: ' + witness.how.join(' | '))
})

test('\`--verify-g0\` writes the report set\'s lane and hands it, and the window, to the witness check', () => {
  // The one caller in the tree. A witness verified without the lane is verified as a document alone,
  // which is the defect #939 files.
  assert.match(RUN, /gateLane: gateLaneOf\(opts\)/, 'a driver run writes the lane it measured into its summary')
  assert.match(RUN, /const gateLaneOf = opts => laneOfAddress\(opts\.server\)/, 'and it is the lane the client joined')
  assert.match(RUN, /gateLane: summary\.gateLane/, 'the check is handed the summary\'s lane')
  assert.match(RUN, /verifyUnmoddedWitness\(witness, \{[^}]*maxAgeMs/, 'with the window the reports are read in')
})

test('the runbook tells a reviewer the two lines a G0 pass prints, by the labels the builders word', () => {
  const from = PAGE.indexOf('## The G0 verdict')
  const section = PAGE.slice(from, PAGE.indexOf('## Client parity lane'))
  assert.ok(from !== -1 && section.length > 0, 'the runbook has the G0 verdict section')
  const witness = recorded()
  witness.steps = notSeen(witness)
  const verdict = verifyUnmoddedWitness(witness, { steps: declaredList() })
  const seen = verifyUnmoddedWitness(recorded(), { steps: declaredList() })
  // The label out of each builder, not out of a literal here: a builder that reworded its line would
  // send the reader to a page naming a line that no longer exists.
  const labels = [
    gapLine(verdict.gaps[0], { withEvidence: true }),
    staleLine(seen.stale[0], { list: UNMODDED_LIST_NAME, state: UNMODDED_STATE_OK })
  ].map(line => line.slice(0, line.indexOf(':') + 1))
  for (const label of labels) {
    assert.ok(section.includes(label), 'the page tells the reader the line to look for: ' + label)
  }
  assert.match(section, /not-seen/, 'and which record the gap line is about')
})

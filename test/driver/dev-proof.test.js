// src/driver/dev-proof.js reads one dev-lane run's record stream and answers the claims of
// #634 that a log can answer (#634). The fixtures below are the shapes the service writes:
// `src/service/monoplayer.js` for the spectate and virtual-player lines, and
// `src/service/start-live.js` for the heartbeat, whose `t` is an ISO 8601 string.
//
// Two halves are tested separately, because they are answered by different people: the frames
// a log holds, and the steps only an operator can record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spectatorModeFrames } from '../../src/core/spectator-mode.js'
import { tempRoot } from '../support/temp.js'
import { functionBody } from '../support/source-scan.js'

import {
  CLAIMS,
  ENTRY_FIELDS,
  OPERATOR_STEPS,
  RECORDS,
  WITNESS_COMMIT,
  WITNESS_LANE,
  WITNESS_WRITE,
  claimsOf,
  formatVerdict,
  momentOf,
  parseRecords,
  readingOf,
  verdict,
  verifyWitness,
  witnessDocument
} from '../../src/driver/dev-proof.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(ROOT, 'src', 'driver', 'dev-proof.js')

const BODY = 'paper.monoplayer-dev.svc.cluster.local_25565'
// The row the picker offers, as the front logs it: `server` is the address, `slug` is
// `pickSlug` of it, and both levels' ids are the slug under their namespace (src/core/picker.js).
const SERVER = 'paper.monoplayer-dev.svc.cluster.local:25565'
const DRIVER = 'channel-driver'
const SPECTATOR = 'channel-spectator'
const AT = Date.parse('2026-11-26T20:00:00.000Z')

const at = seconds => new Date(AT + seconds * 1000).toISOString()

// One record stream as the lane writes it: a claim, a spectator landing, the frames each
// socket was written, and the heartbeat that follows.
function run () {
  return [
    { t: at(0), event: 'pickerServed', username: 'Attach', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', frames: 28, servers: 1 },
    { t: at(0), event: 'pickerPick', username: 'Attach', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', id: 'monoplayer:pick/' + BODY, slug: BODY, server: SERVER, known: true, loginToPickMs: 12 },
    { t: at(0), event: 'pickerVerb', username: 'Attach', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', id: 'monoplayer:claim/' + BODY, verb: 'claim', slug: BODY, server: SERVER },
    { t: at(1), event: 'claimDial', body: BODY, server: 'paper', host: 'paper.monoplayer-dev.svc.cluster.local', port: 25565, name: 'Attach' },
    { t: at(2), event: 'attach', name: 'Attach', reason: 'claim', replayed: 30 },
    { t: at(3), event: 'pickerServed', username: 'Spectator', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', frames: 28, servers: 1 },
    { t: at(3), event: 'pickerPick', username: 'Spectator', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', id: 'monoplayer:pick/' + BODY, slug: BODY, server: SERVER, known: true, loginToPickMs: 9 },
    { t: at(3), event: 'pickerVerb', username: 'Spectator', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', id: 'monoplayer:spectate/' + BODY, verb: 'spectate', slug: BODY, server: SERVER },
    { t: at(4), event: 'spectateAsked', body: BODY, server: 'paper', name: 'Spectator', state: 'attached', attached: true },
    {
      t: at(5),
      event: 'spectateView',
      name: 'Spectator',
      channel: SPECTATOR,
      frames: 30,
      replayed: 30,
      virtualFrames: 3,
      modeFrames: spectatorModeFrames().length,
      packsOffered: 0,
      body: BODY,
      state: 'attached',
      attached: true
    },
    { t: at(5), event: 'puppetSkinSent', name: 'devpuppet', reason: 'spectate', signed: true, puppet: true },
    { t: at(5), event: 'virtualPlayerWritten', reason: 'spectate', channel: SPECTATOR, frame: 'spawn_entity' },
    { t: at(6), event: 'virtualPlayerWritten', reason: 'spectate', channel: DRIVER, frame: 'player_info' },
    { t: at(6), event: 'virtualPlayerWritten', reason: 'spectate', channel: DRIVER, frame: 'spawn_entity' },
    {
      t: at(30),
      event: 'heartbeat',
      attached: true,
      metrics: {
        spectatorViews: 1,
        skinFramesWritten: 2,
        virtualPlayersAnnounced: 1,
        virtualPlayersSpawned: 2,
        virtualPlayersMoved: 4,
        virtualPlayersDespawned: 0,
        virtualPlayersRefused: 0
      },
      channels: [
        { channel: DRIVER, body: BODY, role: 'driver', frames: 44, play: 14, replays: 1, spectators: 1 },
        { channel: SPECTATOR, body: BODY, role: 'spectator', frames: 30, play: 12, replays: 1, spectators: 1 }
      ]
    }
  ]
}

const row = (id, records = run()) => claimsOf(readingOf(records)).find(entry => entry.id === id)

// ---------------------------------------------------------------------------
// The frames half
// ---------------------------------------------------------------------------

test('a two-client run answers every frame-level claim', () => {
  const reading = readingOf(run())
  const rows = claimsOf(reading)

  assert.equal(reading.body, BODY, 'the body is the one the spectator landed on')
  assert.equal(reading.spectate.channel, SPECTATOR, 'the landing is the last spectateView')
  assert.deepEqual(reading.channels, { driver: [DRIVER], spectators: [SPECTATOR] },
    'the heartbeat names both sockets')

  assert.deepEqual(rows.map(entry => entry.id), CLAIMS.map(claim => claim.id), 'one row per claim, in order')
  for (const entry of rows) {
    assert.equal(entry.holds, true, entry.id + ' holds: ' + entry.evidence + ' / ' + entry.because)
  }

  const report = verdict(reading, rows)
  assert.equal(report.framesPassed, true)
  assert.deepEqual(report.failed, [])
  assert.equal(report.driverChannel, DRIVER)
  assert.equal(report.spectatorChannel, SPECTATOR)
  assert.equal(report.heartbeatAt, AT + 30_000, 'the counters come from the heartbeat after the landing')
})

test('the puppet\'s entry is the landing pass\'s own frame, not a per-channel write', () => {
  // #614 writes it once for the whole body, with no channel, so no `virtualPlayerWritten` names
  // the puppet: the reader reads `puppetSkinSent`, and a fixture that invented the per-channel
  // record would be a shape the service never writes.
  const reading = readingOf(run())
  const entry = row('entry')
  assert.equal(entry.holds, true)
  assert.match(entry.evidence, /^puppetSkinSent: devpuppet, signed true, reason spectate$/)
  assert.equal(reading.writes.filter(record => record.frame === 'player_info' && record.channel === SPECTATOR).length, 0,
    'the service writes no player_info for the puppet on a channel')

  // No textures property at all: the entry cannot exist, and a client drops the spawn that
  // follows. The row says so, because every count around it is healthy.
  const noProperty = run().filter(record => record.event !== 'puppetSkinSent')
  const missing = row('entry', noProperty)
  assert.equal(missing.holds, false)
  assert.match(missing.because, /the backend sent no textures property for the puppet/)
  assert.match(missing.because, /client refuses a player spawn it holds no entry for/)
  assert.equal(row('body', noProperty).holds, true,
    'and the spawn is still written, which is why the world is empty with the frames in it')
})

// #931: the page's `puppet-renders` cell states the rule this reader selects a body's entry by — a
// `puppet` true line written after the landing — and no case asked either half of it. The sentence
// stays the page's, and `FAILURE_READS` says so; the behaviour it describes is pinned here, so a
// change to the selection fails in the module instead of leaving the page the only account of the
// old rule. What no case can do is notice the page wording it differently, which is the decision
// that table records.
test('the body entry is a `puppet` true line written after the landing, not the driver\'s own and not an earlier one', () => {
  const records = run()
  const skinned = records.find(record => record.event === 'puppetSkinSent')
  const withLine = line => records.map(record => record === skinned ? line : record)

  // The same record with `puppet` false is the driving client's own entry, which the cell's second
  // sentence names. A run whose only line names the driver has no body entry at all.
  const drivers = withLine({ ...skinned, name: 'Attach', reason: 'landing', puppet: false })
  assert.equal(row('entry', drivers).holds, false,
    'a `puppet` false line is the driver\'s own entry, and the body has none')

  // A line stamped before the landing belongs to an earlier one: the entry is written by the landing
  // pass, so "after the landing" is the selection and not decoration.
  const earlier = drivers.map(record =>
    record.event === 'puppetSkinSent' ? { ...record, t: at(4) } : record)
  assert.equal(row('entry', earlier).holds, false,
    'a line written before the landing is not this body\'s entry')

  // Both lines, the body's after the landing: the body's is the one taken, and the driver's own does
  // not shadow it.
  const both = records.concat([{ ...skinned, name: 'Attach', reason: 'landing', puppet: false, t: at(6) }])
  assert.equal(row('entry', both).holds, true, 'the body\'s line is the entry, and a later driver line does not replace it')
})

// #949: the evidence line prints three of the record's fields, and nothing tied the printed keys to a
// list. `ENTRY_FIELDS` is that list and the line is built from it, so a key printed from a field the
// record does not carry cannot reach a report an operator signs. `test/tooling/transparency-skin-fields.test.js`
// holds the list to the page's cell; this case holds the line to the list, and the list to the sentence
// `RECORDS` states for the same record.
test('the evidence line prints every field of ENTRY_FIELDS, and a false signature is one of them', () => {
  const records = run()
  const skinned = records.find(record => record.event === 'puppetSkinSent')
  assert.ok(ENTRY_FIELDS.length > 0, 'the module names the fields its evidence line prints')
  // The module states the record's fields twice: `RECORDS`'s sentence, which the runbook prints, and
  // this list, which the line prints. This is the one place both are read, so a rename reaches both.
  // One direction, because that sentence also names `puppet`, which the line does not print.
  const stated = RECORDS.find(record => record.name === 'puppetSkinSent').what
  for (const field of ENTRY_FIELDS) {
    assert.ok(stated.includes('`' + field + '`'),
      'the sentence RECORDS states for puppetSkinSent names ' + field + ': ' + stated)
  }

  // Every field reaches the line: a field whose value changes the sentence is a field the reader
  // prints. Read one at a time and off the list rather than off a copy of it, so a fourth field is
  // asked too, and a line built from a constant fails here rather than passing on the fixture's value.
  const render = line => claimsOf(readingOf(records.map(record => record === skinned ? line : record)))
    .find(entry => entry.id === 'entry').evidence
  const other = field => (typeof skinned[field] === 'boolean' ? !skinned[field] : String(skinned[field]) + '-other')
  for (const field of ENTRY_FIELDS) {
    const said = [render(skinned), render({ ...skinned, [field]: other(field) })]
    assert.notEqual(said[0], said[1], 'the line prints ' + field + ': ' + said[0])
  }
  // The false branch is the one no case carried: a property the client cannot verify, which is what
  // the runbook's own step tells the operator to read this line for.
  assert.match(render({ ...skinned, signed: false }), /, signed false, /,
    'a property with no signature says so in the line')
})

test('an entry the proxy withheld is quoted with the profile it could not name', () => {
  const records = run()
    .filter(record => record.event !== 'puppetSkinSent')
    .concat([{ t: at(6), event: 'puppetSkinWithheld', name: null, reason: 'no_identity', puppet: true }])
  const missing = row('entry', records)
  assert.equal(missing.holds, false)
  assert.match(missing.because, /would not write an entry it could not name: no_identity for a nameless profile/)
})

test('a spectator\'s spawn on that socket is the body, and its absence names the empty world', () => {
  const records = run().filter(record => record.frame !== 'spawn_entity' || record.channel !== SPECTATOR)

  const body = row('body', records)
  assert.equal(body.holds, false, 'no spawn on the spectator channel')
  assert.match(body.evidence, /no spawn_entity written on channel-spectator/)
  assert.match(body.because, /a client holding an entry for a player it has no body for/,
    'the reading says what the operator saw: an empty world with the right frames in it')
  assert.equal(row('entry', records).holds, true, 'the entry was still written, which is why a count cannot see it')
  assert.equal(verdict(readingOf(records)).framesPassed, false)
  assert.deepEqual(verdict(readingOf(records)).failed, ['body'])
})

test('a write the leg threw on is quoted with the frame, the socket and the error', () => {
  // The write that would have carried it was refused, so the stream holds the refusal and no
  // written frame: the refusal names the frame it was for.
  const records = run()
    .filter(record => !(record.event === 'virtualPlayerWritten' && record.frame === 'spawn_entity'))
    .concat([
      { t: at(7), event: 'virtualPlayerRefused', reason: 'spectate', channel: SPECTATOR, frame: 'spawn_entity', error: 'socket closed' }
    ])

  assert.match(row('body', records).because, /spawn_entity on channel-spectator: socket closed/,
    'the refusal is quoted rather than summarised')
})

test('a move for nobody fails the row, and the reason says why a zero is not a timing gap', () => {
  const records = run()
  records[records.length - 1] = {
    ...records[records.length - 1],
    metrics: { ...records[records.length - 1].metrics, virtualPlayersMoved: 0 }
  }

  const move = row('move', records)
  assert.equal(move.holds, false, 'no move frame reached any spectator socket')
  assert.match(move.because, /a move is written only to a channel that is not that player's own/)
  assert.match(move.because, /no socket was ever told that a player moved/)
})

test('the driver sees the spectator, or the row says the driver sees nobody', () => {
  const records = run().filter(record => record.channel !== DRIVER)

  const seen = row('seen-by-driver', records)
  assert.equal(seen.holds, false)
  assert.match(seen.evidence, /nothing written to the driver channel channel-driver/)
  assert.match(seen.because, /the driver sees an empty world beside itself/)
})

test('one of the two mode frames is not a spectator, and the row says which half is missing', () => {
  const records = run()
  // Found by event, not by position: the run's record list gains lines as the lane does,
  // and an index here would silently start doctoring a picker record instead of the landing.
  const landing = records.findIndex(record => record.event === 'spectateView')
  assert.notEqual(landing, -1, 'the run holds a spectateView to doctor')
  records[landing] = { ...records[landing], modeFrames: 1 }

  const mode = row('mode', records)
  assert.equal(mode.holds, false)
  assert.equal(mode.evidence, 'spectateView.modeFrames = 1, of ' + spectatorModeFrames().length)
  assert.match(mode.because, /flight and invulnerability come from the first of them/)
})

test('no landing is a run that never reached its second client, and the refusal is quoted', () => {
  const records = [
    { t: at(0), event: 'pickerServed', username: 'Spectator', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', frames: 28, servers: 1 },
    { t: at(1), event: 'spectateRefused', body: BODY, server: 'paper', name: 'Spectator', reason: 'body_not_served', state: 'detached' }
  ]
  const reading = readingOf(records)

  assert.equal(reading.body, null, 'no landing and no claim names a body')
  assert.equal(row('landed', records).holds, false)
  assert.match(row('landed', records).because, /spectateRefused: body_not_served/,
    'the core\'s own reason is quoted, not paraphrased')
  assert.equal(claimsOf(reading).filter(entry => entry.holds === true).length, 0, 'nothing holds without a landing')
  assert.equal(verdict(reading).framesPassed, false)
})

// #670: an empty offer is counted under the word the refusal map keeps, and the parser code
// an operator repairs the list from rides beside it. A reader of the report needs both.
test('#670 an empty offer quotes the refusal word and the offer own cause beside it', () => {
  const records = [
    { t: at(0), event: 'pickerServed', username: 'Spectator', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', frames: 28, servers: 0 },
    { t: at(1), event: 'pickerEmpty', username: 'Spectator', reason: 'empty_offer', offerReason: 'not_json', text: 'Monoplayer: this lane is not offering any server to join.' }
  ]

  assert.match(row('landed', records).because, /pickerEmpty: empty_offer \(not_json\)/,
    'the refusal word and the offer own cause are both quoted, so the repair is still named')
})

test('a stream with no picker join at all says the log is not the run', () => {
  const records = [{ t: at(0), event: 'startLive', account: 'devpuppet' }]
  assert.match(row('landed', records).because, /no client reached the picker in this log/)
  assert.match(row('landed', records).because, /this is not the run/)
})

test('the reading accepts the journal\'s numeric moment as well as the log\'s ISO string', () => {
  assert.equal(momentOf({ t: AT }), AT)
  assert.equal(momentOf({ t: new Date(AT).toISOString() }), AT)
  assert.equal(momentOf({}), null, 'no moment is not a moment of zero')

  const numeric = run().map(record => ({ ...record, t: Date.parse(record.t) }))
  assert.equal(verdict(readingOf(numeric)).framesPassed, true, 'both shapes read the same run')
})

test('the counters a row reads are the ones after the landing, never one before it', () => {
  const early = {
    t: at(-60),
    event: 'heartbeat',
    metrics: { virtualPlayersMoved: 0 },
    channels: [{ channel: DRIVER, body: BODY, role: 'driver' }]
  }
  const report = verdict(readingOf([early, ...run()]))
  assert.equal(report.heartbeatAt, AT + 30_000, 'the heartbeat that covers the run, not the one before it')
})

// ---------------------------------------------------------------------------
// The stream and the report
// ---------------------------------------------------------------------------

test('a line that is not a record is skipped, not a finding', () => {
  const text = [
    'Some kubectl warning nobody wants to read',
    JSON.stringify({ event: 'spectateView', channel: SPECTATOR, body: BODY }),
    '{"event":"truncated"',
    '',
    JSON.stringify({ event: 'heartbeat', metrics: {} })
  ].join('\n')
  assert.equal(parseRecords(text).length, 2, 'two records, and neither the warning nor the half a crash cut')
})

test('the report prints every claim, and says the human half is pending until it is not', () => {
  const report = verdict(readingOf(run()))
  const pending = witnessDocument(report)
  const printed = formatVerdict(report, { witnessPath: '.reports/dev-two-client-witness.json', witness: pending })

  for (const claim of CLAIMS) assert.match(printed, new RegExp(escapeRe(claim.text)), 'the report carries ' + claim.id)
  assert.match(printed, /the frames this run needed reached their sockets/)
  assert.match(printed, /still pending: \.reports\/dev-two-client-witness\.json/)
  assert.match(printed, /PENDING {2}the puppet renders/, 'the operator steps are printed with their state')

  const failed = formatVerdict(verdict(readingOf(run().filter(record => record.frame !== 'spawn_entity'))))
  assert.match(failed, /the run did not reach every socket it needed: body/)

  // #920: a witness that records the one expected gap is recorded, not pending, and the report says
  // which gap and which ticket, beside the row it belongs to.
  const gapped = witnessed()
  gapped.steps = withStep(gapped, 'spectator-own-body', { state: 'not-seen', evidence: 'a body was drawn in third person' })
  const gapReport = formatVerdict(report, { witnessPath: '.reports/dev-two-client-witness.json', witness: gapped })
  assert.match(gapReport, /the half only eyes can answer is recorded/)
  assert.match(gapReport, /NOT-SEEN the spectator has no body of its own/)
  assert.match(gapReport, /#647 and #645 close it/)
})

function escapeRe (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// The witness half
// ---------------------------------------------------------------------------

test('the witness is written pending, with the frames it read and one row per step', () => {
  const report = verdict(readingOf(run()))
  const document = witnessDocument(report, { now: at(40) })

  assert.equal(document.lane, WITNESS_LANE)
  assert.equal(document.completed, false, 'a generated witness is not a completed one')
  assert.equal(document.generatedAt, at(40))
  assert.deepEqual(document.steps.map(step => step.claim), OPERATOR_STEPS.map(step => step.claim))
  for (const step of document.steps) {
    assert.equal(step.state, 'pending')
    assert.match(step.evidence, /^\[MANUAL/, 'the placeholder is obviously not evidence')
  }
  assert.equal(document.frames.passed, true)
  assert.equal(document.frames.spectatorChannel, SPECTATOR)
})

test('a pending witness is refused, and the refusal names the steps still open', () => {
  const document = witnessDocument(verdict(readingOf(run())))
  const check = verifyWitness(document)

  assert.equal(check.ok, false)
  assert.match(check.reason, /6 step\(s\) are still pending/)
  assert.match(check.reason, /the puppet renders/)
})

test('a recorded step with no evidence behind it is not recorded', () => {
  const document = witnessed()
  document.steps = withStep(document, 'spectator-mode', { evidence: '[MANUAL: what you saw]' })

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /carries no evidence: the spectator flies/)
})

// #920: the runbook tells the operator that one step is expected to be `not-seen` today, because
// #647 and #645 are open. Every `not-seen` was refused, so the one honest document a run taken
// today can produce exited 1 forever, and the only way to satisfy the check was to write `seen` on
// a step nobody saw. The declaration is the module's, and the check accepts that step alone.
test('the step a ticket says is open verifies when it is recorded not-seen, and the pass names the ticket', () => {
  const document = witnessed()
  document.steps = withStep(document, 'spectator-own-body', {
    state: 'not-seen',
    evidence: 'a body was drawn in third person, and the client collided with blocks'
  })

  const check = verifyWitness(document)
  assert.deepEqual({ ok: check.ok, reason: check.reason }, { ok: true, reason: null },
    'an honest run with the gap the runbook asks for is a proof, not a finding: ' + check.reason)
  assert.deepEqual(check.gaps.map(gap => gap.id), ['spectator-own-body'])
  assert.deepEqual(check.gaps[0].openUntil, [647, 645], 'the declaration carries the tickets that close it')
  assert.deepEqual(check.stale, [], 'nothing was seen that was declared absent')
})

// The refusal half of #920, and the reason the declaration is a list with one entry rather than a
// relaxed check: a `not-seen` on any other step is still the finding it always was.
test('a step nothing declares open still refuses a not-seen, in today\'s words, and names the gap this run does expect', () => {
  const document = witnessed()
  document.steps = withStep(document, 'drawn-once', {
    state: 'not-seen',
    evidence: 'two bodies, and one of them was mine'
  })

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'a not-seen step is a finding, not a pass')
  assert.match(check.reason,
    /^not seen: the driving client is drawn once, not twice: one body, and it is yours \(two bodies, and one of them was mine\)/)
  assert.match(check.reason, /the spectator has no body of its own/, 'and the one gap this run expects is named')
  assert.match(check.reason, /#647 and #645/, 'with the tickets that close it, so two not-seen rows are told apart')
})

// #920's other half, and the ticket the declaration has to fail loudly for rather than rot on: when
// #647 and #645 land, the operator sees the step and records it. A fix landing must not turn an
// honest witness red, so this passes, and the report names the declaration it outlived.
test('a witness that saw the declared step passes, and names the declaration it outlived', () => {
  const check = verifyWitness(witnessed())
  assert.equal(check.ok, true, check.reason)
  assert.deepEqual(check.gaps, [])
  assert.deepEqual(check.stale.map(step => step.id), ['spectator-own-body'])
  assert.deepEqual(check.stale[0].openUntil, [647, 645])
})

// What the declaration has to be for the cases above to mean anything: a ticket a reader can open,
// and a reason in the failure sentence the runbook holds word for word. The ticket is named once,
// in `openUntil`; a claim that restated it was the second home #920 found, and it said something
// that stopped being true the day this check accepted the gap.
test('a step declared expected absent carries its tickets and its reason, and no claim restates a ticket', () => {
  const declared = OPERATOR_STEPS.filter(step => step.openUntil !== undefined)
  assert.ok(declared.length > 0, 'the tree declares the one gap a run taken today has')
  for (const step of declared) {
    assert.ok(Array.isArray(step.openUntil) && step.openUntil.length > 0,
      'the step ' + step.id + ' names the ticket that closes it')
    for (const ticket of step.openUntil) {
      assert.ok(Number.isInteger(ticket) && ticket > 0, 'a ticket is a number: ' + JSON.stringify(ticket))
    }
    assert.equal(typeof step.because, 'string',
      'the declared step ' + step.id + ' states why in its failure cell, which is the cell the runbook holds to this module')
  }
  // The declaration and the sentence that names it are one fact in two fields, and the runbook guard
  // holds only the sentence. Dropping `openUntil` alone would leave a cell telling the operator to
  // record a gap the check then refuses, and nothing failed, so the two are held to each other here.
  for (const step of OPERATOR_STEPS) {
    const declaredHere = step.openUntil !== undefined
    assert.equal(declaredHere, typeof step.because === 'string' && step.because.includes('not-seen'),
      'step ' + step.id + ': the declaration and the cell that names it are one fact, so a step whose cell tells the ' +
      'operator to record it not-seen carries `openUntil`, and a step carrying `openUntil` says so in that cell')
    if (!declaredHere) continue
    const named = [...new Set([...step.because.matchAll(/#(\d+)/g)].map(match => Number(match[1])))]
    assert.deepEqual(named.sort(), [...step.openUntil].sort(),
      'step ' + step.id + ' names its tickets once: `openUntil` and the sentence it is built into agree')
  }
  for (const { id, claim } of OPERATOR_STEPS) {
    assert.doesNotMatch(claim, /#\d+/,
      'the claim for ' + id + ' is what the operator must see, and nothing else: a ticket in it is a second home for a ' +
      'declaration that `openUntil` already carries, and it goes stale the day the check accepts the gap')
  }
})

test('the witness it generates names the expected gap out of the module, so the operator knows which row is the gap', () => {
  const document = witnessDocument(verdict(readingOf(run())))
  const declared = OPERATOR_STEPS.filter(step => step.openUntil !== undefined)
  const lines = document.limitations.filter(line => line.includes(declared[0].id))

  assert.equal(lines.length, 1, 'the document names the step a run taken today cannot see, once')
  assert.match(lines[0], /#647 and #645/, 'and the tickets that close it')
  assert.match(lines[0], /not-seen/, 'and the state to record it in')
})

const WITNESS_SECTION = 'Record what you saw'

// The labels the page tells the operator to look for are this module's, and it is the module that
// prints them: renaming a line would leave the page describing output nobody sees. The table guard
// reads cells, not paragraphs, so nothing compared the prose that describes these two lines.
test('the runbook names the lines a gapped proof prints, and the labels come from this module', () => {
  const page = section(fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8'), WITNESS_SECTION)
  const report = verdict(readingOf(run()))

  const gapped = witnessed()
  gapped.steps = withStep(gapped, 'spectator-own-body', { state: 'not-seen', evidence: 'a body was drawn in third person' })
  assert.match(formatVerdict(report, { witnessPath: 'w', witness: gapped }), /^\s+known gap: /m)
  assert.match(formatVerdict(report, { witnessPath: 'w', witness: witnessed() }), /^\s+stale declaration: /m,
    'the same report names a declaration the witness outlived')

  for (const label of ['known gap:', 'stale declaration:']) {
    assert.ok(page.includes(label), 'the runbook tells the operator the line to look for: ' + label)
  }
})

// #945: the page's list of what to write, held to the row the check reads — #921's cost. #921 was
// filed because this section said what to do and never named the `id`, so a tidy-up lost it and an
// honest run was refused with `carries no step id`. The wording was repaired by hand and nothing
// kept it: the record table and the step table are compared cell by cell, and no cell comparison
// reaches a paragraph.
//
// What this reads, both ways: the bullets under "Record what you saw", in the order they are written,
// against the keys of the rows `witnessDocument` writes, less `claim`. `claim` is left out
// because no refusal reads it — it is the label the report prints beside a step, so a page asking the
// operator to write it would ask for a field the check never looks at. The page's side is read as
// bullets inside the section and never as the page: for a row's field the list is the only place it
// can be answered, and a name left in the sentence above it answers for nothing, which is #830's hole
// one bound over.
//
// The order is the row literal's, and that is the one false red this guard can give: reorder the keys
// of the row `witnessDocument` writes and the page is asked to follow, while the check's own order
// has not moved. The other way to get an order is a scan of `stepRefusal` and `verifyWitness`
// for the names they read, and a scan of a function's body reads English — a claim about a name that
// greps is a claim about a sentence. So the row is the source, as #945 asks, and the limit is written
// here instead of implied. A field the check *stopped* reading still fails its own case in this file,
// and that is what keeps the row from being a silent second list.
//
// Three names are asked for rather than derived, because none is a row's: `completed`, the flag the
// check refuses a document for leaving unset, and the two paths the section states — `WITNESS_WRITE`,
// the file an operator edits, and `WITNESS_COMMIT`, the copy `--verify` opens when it
// is given no `--witness` (#946). All three are read out of the section's prose and not out of a
// command in it: a path named only inside a fenced block is named to a shell, and the operator reading
// the section is who has to be told. The two paths are asked for one at a time, because the finding was
// a section that named one of them and meant both. `completed` is the one hard name in this file, and the case
// holds it to the module by asking the check to refuse it: the refusal prints the word, so a renamed
// flag fails here instead of leaving the page asking for a field nobody reads.
//
// The generated document is read too, in the one direction it can be (#944). Its `how` steps are the
// same instruction to the same operator, and #944's case runs the last of them: that is the path half,
// and it says nothing about the four words beside it. So every field the page asks for is asked of the
// document, in the same order. A word the document adds is its own — it writes the command and the
// placeholder too — so only the names and their order are compared, which is the judgement
// FAILURE_READS writes down one section over. A field the document names and no row carries is
// therefore not a finding, and a field it drops is.
//
// The red is by construction: delete a bullet, and this fails naming the field.
test('the runbook\'s "Record what you saw" lists the row\'s fields in the order the check reads them, and the generated steps agree', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8')
  const document = witnessDocument(verdict(readingOf(run())))

  // Both sides are read, or a section rewritten as prose would leave the comparison holding two empty
  // lists and passing: `rowFields` throws on a witness with no row and `fieldBullets` on a section
  // with no list, and this answers for the third shape, a row whose only key is `claim`.
  assert.ok(rowFields(document).length > 0, 'a row of the generated witness carries the fields the check reads')
  assert.deepEqual(fieldDisagreement(fieldDrift(readme, document)), [],
    'the runbook\'s "Record what you saw" section and the witness disagree')

  // The one name this file writes rather than imports, held to the module the other way: a field the
  // check no longer refuses a document for leaving is a page asking for something nobody reads, and
  // the refusal is where the module prints the word for it.
  const unset = verifyWitness({ ...recorded(document), completed: false })
  assert.equal(unset.ok, false, 'a document whose flag is unset is refused, so the flag is a field the check reads')
  for (const field of DOCUMENT_FIELDS) {
    assert.match(unset.reason, new RegExp(field),
      'the refusal for an unset ' + field + ' names it: a renamed flag is an edit in verifyWitness, not on the page')
  }
})

// The one field the operator writes that no row carries: `completed` is the document's, a flag set
// by hand, and the section states it in prose rather than in the list above. The check reads two other
// document fields, `lane` and `frames`, and an operator edits neither. Named here
// because no row supplies it, for the reason FAILURE_READS is a table in this file: it is a decision
// about what the guard reads, and the case above holds the name to the module that prints it.
const DOCUMENT_FIELDS = ['completed']

// The fields the rows of the witness carry, as the rows the module writes them: no list of them here,
// so a field added to or renamed in `witnessDocument` reaches the page. `claim` is left out
// because no refusal reads it, and the order is the row's own. Every row, not the first: a field one
// step carries and the others do not is still a field the operator writes.
function rowFields (document) {
  const rows = Array.isArray(document?.steps) ? document.steps : []
  assert.ok(rows.length > 0, 'the generated witness carries a row, so the page is held to the module\'s fields')
  return [...new Set(rows.flatMap(row => Object.keys(row)))].filter(field => field !== 'claim')
}

// The section's list, as the field name each bullet opens with, in its order. Read as one run of
// bullets inside the section and never as the page, for the reason `recordRows` keeps its own copy
// of `section`: a name in the sentence above the list answers for nothing, and a second list in
// the section is the stale copy an operator scrolls into, so the section carries one.
function fieldBullets (text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^- /.test(line))
  assert.notEqual(start, -1, 'the "' + WITNESS_SECTION + '" section carries the list of fields to write')
  let end = start
  while (end < lines.length && /^- /.test(lines[end])) end += 1
  const later = lines.slice(end).filter(line => /^- /.test(line))
  assert.deepEqual(later, [], 'the section carries one list: ' + later.length + ' bullet(s) sit under it')
  return lines.slice(start, end).map(line => {
    const name = line.match(/^- `([A-Za-z][A-Za-z0-9]*)`/)
    assert.ok(name !== null, 'every bullet of the list opens with one field name in code: ' + line)
    return name[1]
  })
}

// The section without its commands, which is the half an operator reads. A path named only inside a
// fenced block is named to a shell, and the person holding the file is not one.
function prose (text) {
  const kept = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) { inside = !inside; continue }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}

// The fields the document's own steps name, in the order it names them: the operator copies those steps
// by hand, so the words have to be there, and in the order the rows are written. Split on everything
// that is not a word rather than matched, so `id` is a word and not the middle of one. A field the
// document names and no row carries is not this comparison's to report: the steps write a command and a
// placeholder of their own, and only the names the page asks for are asked of them.
function howFields (document, fields) {
  const words = (Array.isArray(document?.how) ? document.how.join('\n') : '').split(/[^A-Za-z0-9]+/)
  return fields
    .map(field => ({ field, at: words.indexOf(field) }))
    .filter(({ at }) => at !== -1)
    .sort((one, other) => one.at - other.at)
    .map(({ field }) => field)
}

// What the two surfaces disagree about, one list per repair: a field the page's list leaves out, a
// bullet for a field no row carries, a field named twice, a list out of the order the check reads in, a
// step of the generated document that names no field or names them in another order, a flag the section
// never states, and a path it never names outside a command — one entry per path, because the two
// paths have two jobs and a section can lose either of them alone (#946).
function fieldDrift (text, document, { witnessWrite = WITNESS_WRITE, witnessCommit = WITNESS_COMMIT } = {}) {
  const fields = rowFields(document)
  const documentFields = DOCUMENT_FIELDS
  const page = section(text, WITNESS_SECTION)
  const bullets = fieldBullets(page)
  const missing = fields.filter(field => !bullets.includes(field))
  const unrowed = bullets.filter(field => !fields.includes(field))
  const repeated = [...new Set(bullets.filter((field, at) => bullets.indexOf(field) !== at))]
  // Order is asked only when the two sides hold the same names, once each: a field left out or named
  // twice moves everything after it, and a list of moved names beside it would report one edit twice.
  const sameFields = missing.length === 0 && unrowed.length === 0 && bullets.length === fields.length
  const moved = sameFields
    ? bullets.filter((field, at) => field !== fields[at]).map(field => ({ field, said: bullets, writes: fields }))
    : []
  // The document's own fields follow the row's, because a row is written first and the flag that
  // completes the file is set last, on both surfaces.
  const ordered = [...fields, ...documentFields]
  const named = howFields(document, ordered)
  const howMissing = ordered.filter(field => !named.includes(field))
  const howMoved = howMissing.length === 0 ? named.filter((field, at) => field !== ordered[at]) : []
  const said = prose(page)
  return {
    missing,
    unrowed,
    repeated,
    moved,
    howMissing,
    howMoved,
    silent: documentFields.filter(field => !said.includes(field)),
    // #946: the finding was a section that named one path and meant both, so both are asked for. Each
    // carries the job it has, because the noun in the repair is what tells a reader which sentence to
    // edit: the file the operator edits, or the copy that is the record.
    unnamed: [
      { file: witnessWrite, job: 'the file an operator edits' },
      { file: witnessCommit, job: 'the copy `--verify` opens when it is given no `--witness`' }
    ].filter(({ file }) => !said.includes(file))
  }
}

// The edit each disagreement asks for, one sentence each, naming the field and the side it is on. A
// message that said only "the page and the witness disagree" would leave the reader to work out which
// of the eight edits is theirs, and which field.
function fieldDisagreement ({ missing, unrowed, repeated, moved, howMissing, howMoved, silent, unnamed }) {
  const where = 'deploy/dev/README.md\'s "' + WITNESS_SECTION + '" section'
  return [
    ...missing.map(field => where + ' has no bullet for ' + field +
      ', which a row of the witness carries: name it in the list, in the order the check reads the fields'),
    ...unrowed.map(field => where + ' asks for ' + field + ', and a row of the witness carries no such field: ' +
      'the list is the row\'s fields, so state it in the section\'s prose, or add the field to the row'),
    ...repeated.map(field => where + ' names ' + field + ' in more than one bullet: a field is one line of the ' +
      'list, and two lines for one field say it twice'),
    ...moved.map(({ field, said, writes }) => where + '\'s list is not the order the check reads the fields at ' +
      field + '\n  the list says: ' + said.join(', ') + '\n  a row of the witness writes: ' + writes.join(', ')),
    ...howMissing.map(field => 'the `how` steps of the generated witness (src/driver/dev-proof.js) do not ' +
      'name ' + field + ', and ' + where + ' tells the operator to write it: one instruction in two places, ' +
      'so the side that lost it is the edit'),
    ...howMoved.map(field => 'the `how` steps of the generated witness (src/driver/dev-proof.js) name ' + field +
      ' out of the order the rows are written in, and ' + where + ' lists it in that order: a person copies ' +
      'those steps, so both surfaces say it once'),
    ...silent.map(field => where + ' never tells the operator to set ' + field +
      ': the check refuses a document that leaves it, and this section is where it is set'),
    ...unnamed.map(({ file, job }) => where + ' does not name ' + file + ' outside a command, and it is ' +
      job + ': name it in the prose, or the step is one a reader invents')
  ]
}

// Fixtures, not the tree: the comparison is held by a page and a document built here, so a drift in
// the runbook cannot make this case about the drift instead of the guard.
test('the field comparison reports a missing bullet, a bullet for no field, a field named twice, a moved list, a step naming no field, a step naming them out of order, a silent flag, and a path named only in a command', () => {
  const commit = 'testdata/a-witness.json'
  const write = '.reports/a-witness.json'
  const document = {
    steps: [{ id: 'a-step', claim: 'a sentence', state: 'pending', evidence: '[MANUAL: what you saw]' }],
    how: ['Keep the `id` and the `state`, then write `evidence`.', 'Set `completed` true, then run it.']
  }
  // The page the guard reads, with the parts a case edits as arguments. The sentence above the list
  // names the same three fields, because that is the shape the tree holds: a reader that took the
  // sentence would pass with every bullet gone, which is the hole the bullet reader closes.
  const asPage = ({
    bullets = ['id', 'state', 'evidence'],
    said = 'That writes `' + write + '`. Then set `completed` to `true`,\ncopy it to `' + commit + '`, and read it back.',
    command = 'node src/driver/dev-proof.js --verify'
  } = {}) => [
    '### ' + WITNESS_SECTION,
    '',
    'The check reads a row\'s `id` before anything else, then its `state` and `evidence`:',
    '',
    ...bullets.map(field => '- `' + field + '`, what it is.'),
    '',
    said,
    '',
    '```bash',
    command,
    '```'
  ].join('\n')
  // Both paths are the fixture's own, so each parameter below is exercised rather than left at the
  // module's default: a case that only ever passed the copy path could not tell a reader that reads
  // one parameter from a reader that reads both.
  const drift = (over = {}, changed = document) =>
    fieldDrift(asPage(over), changed, { witnessWrite: write, witnessCommit: commit })

  assert.deepEqual(fieldDisagreement(drift()), [],
    'the fixture agrees with itself, so each case below is about its own edit')
  assert.deepEqual(fieldBullets(section(asPage(), WITNESS_SECTION)), ['id', 'state', 'evidence'],
    'the reader answers with the bullets, and the sentence above them names the same three, which is what makes the next case an edit')
  assert.doesNotMatch(prose(section(asPage(), WITNESS_SECTION)), /--verify/,
    'the prose half leaves the command out, which is what the command-only case below rests on')

  const missing = drift({ bullets: ['id', 'evidence'] })
  assert.deepEqual(missing.missing, ['state'])
  assert.match(fieldDisagreement(missing)[0], /^deploy\/dev\/README\.md's "Record what you saw" section has no bullet for state/)

  const unrowed = drift({ bullets: ['id', 'state', 'evidence', 'completed'] })
  assert.deepEqual(unrowed.unrowed, ['completed'])
  assert.match(fieldDisagreement(unrowed)[0], /asks for completed, and a row of the witness carries no such field/)

  // The arm a set comparison without a duplicate list passes: every field is there, the list is out of
  // order, and the last bullet is one of them again.
  const repeated = drift({ bullets: ['state', 'id', 'evidence', 'id'] })
  assert.deepEqual(repeated.repeated, ['id'])
  assert.deepEqual(repeated.moved, [], 'a list holding a field twice is the repeat\'s finding, and not two')
  assert.match(fieldDisagreement(repeated)[0], /names id in more than one bullet/)

  const moved = drift({ bullets: ['state', 'id', 'evidence'] })
  assert.deepEqual(moved.moved.map(one => one.field), ['state', 'id'])
  assert.match(fieldDisagreement(moved)[0],
    /^deploy\/dev\/README\.md's "Record what you saw" section's list is not the order the check reads the fields at state\n  the list says: state, id, evidence\n  a row of the witness writes: id, state, evidence$/)

  const silent = drift({ said: 'That writes `' + write + '`. Copy it to `' + commit + '` and read it back.' })
  assert.deepEqual(silent.silent, ['completed'])
  assert.match(fieldDisagreement(silent)[0], /never tells the operator to set completed/)

  // #946: one path is not the other, and the finding was a section that named the copy and left the
  // operator guessing where the document is written. Each arm here is that sentence losing one path.
  const noWrite = drift({ said: 'Then set `completed` to `true`, copy it to `' + commit + '`, and\nread it back.' })
  assert.deepEqual(noWrite.unnamed.map(one => one.file), [write])
  assert.match(fieldDisagreement(noWrite)[0],
    /does not name \.reports\/a-witness\.json outside a command, and it is the file an operator edits/)

  const noCopy = drift({ said: 'That writes `' + write + '`. Then set `completed` to `true`\nand read it back.' })
  assert.deepEqual(noCopy.unnamed.map(one => one.file), [commit])
  assert.match(fieldDisagreement(noCopy)[0], /does not name testdata\/a-witness\.json outside a command/)

  // A path in the command is a path a shell is told, and the operator reading the section is not one.
  const commandOnly = drift({
    said: 'That writes `' + write + '`. Then set `completed` to `true` and read the copy back.',
    command: 'cp x ' + commit
  })
  assert.deepEqual(commandOnly.unnamed.map(one => one.file), [commit])
  assert.match(fieldDisagreement(commandOnly)[0], /does not name testdata\/a-witness\.json outside a command/)

  const howMissing = drift({}, { ...document, how: ['Keep the `id`, then write `evidence`.', 'Set `completed` true.'] })
  assert.deepEqual(howMissing.howMissing, ['state'])
  assert.match(fieldDisagreement(howMissing)[0], /generated witness \(src\/driver\/dev-proof\.js\) do not name state/)

  const howMoved = drift({}, { ...document, how: ['Write `state` and `evidence` first.', 'Keep the `id`, then set `completed`.'] })
  assert.deepEqual(howMoved.howMoved, ['state', 'evidence', 'id'])
  assert.match(fieldDisagreement(howMoved)[0], /name state out of the order the rows are written in/)

  // A second list in the section is the stale copy an operator scrolls into, as a second table is one
  // bound over, so the section is held to one list rather than to its first.
  assert.throws(() => fieldDrift(asPage() + '\n\n- `later`, a second list.', document, { witnessWrite: write, witnessCommit: commit }),
    /the section carries one list/, 'a second list in the section is a finding, not a list read twice')
})

// #963: the report walks the document as it stands, and the document a run writes first holds a
// pending row on the one step a ticket declares expected absent. Reading the declaration rule here
// instead of the row's own word called that pending row a stale declaration, which claims sight the
// record does not have.
test('a report over a pending witness names the declared step pending, and calls nothing stale', () => {
  const report = verdict(readingOf(run()))
  const printed = formatVerdict(report, { witnessPath: 'w', witness: witnessDocument(report) })
  assert.match(printed, /^\s+PENDING\s+the spectator has no body of its own/m, 'the declared step is still pending')
  assert.doesNotMatch(printed, /stale declaration:/, 'and a row nobody recorded is not a declaration outlived')
})

// The declaration is `OPERATOR_STEPS`'s fact, so it cannot come from the document: the file is
// hand-edited, and a row that could declare itself expected-absent would pass by writing a line.
test('the declaration is the module\'s, and a row that declares itself expected-absent changes nothing', () => {
  const document = witnessed()
  document.steps = withStep(document, 'drawn-for-driver', {
    state: 'not-seen',
    evidence: 'nothing stood beside me',
    openUntil: [647, 645]
  })

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'a hand-edited row is not a declaration')
  assert.match(check.reason, /^not seen: the spectator appears to the driving client/)
})

// The state vocabulary is the document's, and before #920 the check passed any string it did not
// read: a row saying 'deferred' with evidence beside it verified as a finished proof. That was the
// obvious way to declare a gap from inside the witness, which is the one place the declaration must
// not live, so the two states a witness has are read here rather than assumed.
test('a step in a state no witness has is refused, so a hand-edited row cannot invent its own', () => {
  const document = witnessed()
  document.steps = withStep(document, 'drawn-once', { state: 'deferred', evidence: 'will look on the next run' })

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'a state nothing reads is a step nothing recorded')
  assert.match(check.reason,
    /^a recorded step is in no state a witness has: `drawn-once` says "deferred", and a step is `seen` or `not-seen`/)
})

// A row's own `claim` is the operator's label, and the file is hand-edited: a refusal quotes the
// module's words for the step an id names, so a claim left over from another row cannot be read
// back as evidence of what the operator saw.
test('a refusal quotes the module\'s words for the step, not the row\'s', () => {
  const document = witnessed()
  document.steps = withStep(document, 'drawn-once', {
    state: 'not-seen',
    claim: 'the puppet waves at the spectator',
    evidence: 'two bodies, and one of them was mine'
  })

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /^not seen: the driving client is drawn once, not twice/)
  assert.match(check.reason, /\(two bodies, and one of them was mine\)/)
  assert.doesNotMatch(check.reason, /the puppet waves at the spectator/, 'the row\'s label is not the proof\'s words')
})

test('a completed witness for a run whose frames failed is refused', () => {
  const report = verdict(readingOf(run().filter(record => record.frame !== 'spawn_entity')))
  const document = witnessed(report)

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /the frames half did not pass/)
  assert.match(check.reason, /body/)
})

test('a witness is accepted only when every step is recorded and every frame held', () => {
  const check = verifyWitness(witnessed())
  assert.deepEqual({ ok: check.ok, reason: check.reason }, { ok: true, reason: null })

  assert.equal(verifyWitness(null).ok, false, 'no document is no proof')
  assert.match(verifyWitness({ ...witnessed(), lane: 'unmodded' }).reason, /names lane "unmodded"/)
  assert.match(verifyWitness({ ...witnessed(), steps: [] }).reason,
    /^unwitnessed: `puppet-renders`, `puppet-walks`/, 'an empty document names the steps it is missing')
  assert.match(verifyWitness({ ...witnessed(), completed: false }).reason, /not marked completed/)
})

// #923: the frames half was one boolean the reader copied into the witness, and the log it came
// from is gitignored, so a witness could assert the machine half and nothing could contradict it.
// The witness now names the log it was read from, and `--verify` re-derives the rows from that
// log instead of believing the copy. Without a log the verdict says so, so nobody reads a pass as
// a re-check.
const LOG = '.reports/dev-log.jsonl'
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n'
const failedRun = () => lines(run().filter(record => record.frame !== 'spawn_entity'))

test('#923 a witness and the log it names must agree, and the refusal names the row and both values', () => {
  const document = witnessed()

  const check = verifyWitness(document, { log: { path: LOG, text: failedRun() } })
  assert.equal(check.ok, false, 'a copy that says the frames passed does not overrule the log')
  assert.match(check.reason, /the frames half in the witness and in \.reports\/dev-log\.jsonl disagree/,
    'the refusal names the file it re-read')
  assert.match(check.reason, /row `body` holds true in the witness and false in the log/,
    'and the row, with both values')
  assert.equal(verifyWitness(document, { log: { path: LOG, text: lines(run()) } }).ok, true,
    'the run the rows were read from verifies')
})

test('#923 the frames half is re-read from the log, and the verdict names the file it read', () => {
  const check = verifyWitness(witnessed(), { log: { path: LOG, text: lines(run()) } })
  assert.deepEqual(check.frames, { reread: true, source: LOG })
})

test('#923 with no log the frames half is not re-read, and the verdict says so in its own field', () => {
  const check = verifyWitness(witnessed())
  assert.equal(check.ok, true, 'a witness whose log is gone still records the human half')
  assert.deepEqual(check.frames, { reread: false, source: null })
})

test('#923 a log whose own verdict fails is refused, naming what the witness copied and what the log says', () => {
  const check = verifyWitness(witnessed(), { log: { path: LOG, text: failedRun() } })
  assert.match(check.reason, /frames\.passed is true in the witness and false in the log/)
  assert.match(check.reason, /body/, 'and the row that did not hold is on the same line')
})

test('#923 a row the log answers and the witness does not carry is named, not counted', () => {
  const document = witnessed()
  document.frames = { ...document.frames, rows: document.frames.rows.filter(row => row.id !== 'mode') }

  const check = verifyWitness(document, { log: { path: LOG, text: lines(run()) } })
  assert.equal(check.ok, false)
  assert.match(check.reason, /row `mode` is in the log and not in the witness/)
})

test('#923 the generated witness names the log its rows were read from, and says so when there is none', () => {
  const report = verdict(readingOf(run()))
  const fromFile = witnessDocument(report, { now: at(40), source: LOG })
  assert.equal(fromFile.frames.source, LOG)
  assert.match(fromFile.how.join(' '), new RegExp('--verify --path ' + escapeRe(LOG)),
    'and the step it prints re-reads that file')

  const piped = witnessDocument(report, { now: at(40) })
  assert.equal(piped.frames.source, null, 'a reading from a pipe names no file, rather than implying one')
  assert.match(piped.how.join(' '), /no log to re-read/,
    'and the step it prints says this run saved none')
  assert.doesNotMatch(piped.how.join(' '), /--verify --path \S/,
    'rather than printing a command that would fail on a path nobody wrote')
  // #944: a piped reading writes WITNESS_WRITE like any other, so its step carries the copy too.
  assert.match(piped.how.at(-1), new RegExp('cp ' + escapeRe(WITNESS_WRITE) + ' ' + escapeRe(WITNESS_COMMIT)),
    'and its step copies the document where a bare --verify reads it')
})

// #944: the last step is read at the moment the operator finishes the document, so it has to work
// as written. The reader writes `WITNESS_WRITE` and `--verify` with no `--witness` reads
// `WITNESS_COMMIT`, so a step that named only the command refused every operator who copied nothing:
// the copy it needed was in nobody's sentence. This case runs the reader, records the document, and
// then runs the command the step prints, in a lane nothing has been copied into by hand. It is the
// path half of the guard #945 asks for, and both read `how` — the document's own words — rather
// than a copy of them.
test('#944 the step the witness prints copies the document it wrote, and the copy is what verifies', () => {
  const { dir } = space()
  // Every checkout has testdata/: the verdict pages are tracked there. The lane needs the directory
  // for the copy the step makes, and nothing else about the copy is given to it.
  fs.mkdirSync(path.join(dir, path.dirname(WITNESS_COMMIT)), { recursive: true })
  fs.mkdirSync(path.join(dir, path.dirname(LOG)), { recursive: true })
  fs.writeFileSync(path.join(dir, LOG), lines(run()))

  // The reader writes the document, as it does for the operator. The case hands it nothing.
  const read = spawnSync(process.execPath, [CLI, '--path', LOG], { cwd: dir, encoding: 'utf8' })
  assert.equal(read.status, 0, read.stdout + read.stderr)

  // What the operator does next: record the rows, and set the flag.
  const write = path.join(dir, WITNESS_WRITE)
  const document = JSON.parse(fs.readFileSync(write, 'utf8'))
  document.completed = true
  document.steps = document.steps.map(step => step.id === 'spectator-own-body'
    ? { ...step, state: 'not-seen', evidence: 'a body was drawn in third person, and the hands were still there' }
    : { ...step, state: 'seen', evidence: 'saw it on both clients' })
  fs.writeFileSync(write, JSON.stringify(document, null, 2))

  const step = document.how.at(-1)
  const printed = step.match(/then run: (.+?)\.(?: |$)/)
  assert.ok(printed, 'the last step prints the command that finishes the document: ' + step)
  assert.match(printed[1], /^cp \S+ \S+ && node src\/driver\/dev-proof\.js --verify/,
    'and the copy is in that command, so a reader who follows the step copies nothing by hand')
  // The step names the script by its repo-relative path, and this lane is not the repo, so the one
  // rewrite swaps that path for this checkout's. Every path the step names stays as printed, and
  // they resolve inside the lane: that is where the document it names was written.
  const command = printed[1].replace(/node src\/driver\/dev-proof\.js/, '"' + process.execPath + '" "' + CLI + '"')
  const ran = spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' })

  assert.equal(ran.status, 0, command + '\n' + ran.stdout + ran.stderr)
  assert.match(ran.stdout, /#634 VERIFIED/, 'and the copy the step made is the file the command read')
  assert.match(ran.stdout, /^known gap: /m, 'the one gap the step declared is the one the run accepted')
  assert.equal(fs.existsSync(path.join(dir, WITNESS_COMMIT)), true,
    'the step writes the copy itself: a reader who follows it copies nothing by hand')
})

// #946: the copy the last step makes is the record, so the path it names has to be one git sees. It
// was not: `testdata/*.json` ignored the finished document, so an operator followed the step,
// `git status` said nothing, and the witness a proof depends on never left that machine. Both paths
// the step names are held here to the rules that decide it — the copy lands where a checkout holds it,
// and the file it is written from stays out of git — because the finding was one rule that
// reached a path no sentence expected it to.
//
// The rules are exercised in a throwaway repository seeded with this checkout's `.gitignore`, the way
// `test/tooling/link-secrets.test.js` does it: a case about the rules reads them, not this worktree's
// index, and a local `info/exclude` here cannot answer for the tree. `-q` is the question "is this
// path ignored", and it is the one to ask: `-v` exits 0 for a path a `!` rule matches, so its status
// says a rule matched and not that the path is ignored. `ruleFor` is read inside a failure message only.
test('#946 the copy the step names is a path git does not ignore, and the file it is written from is one it does', () => {
  const rules = path.join(ROOT, '.gitignore')
  const tree = tempRoot('monoplayer-witness-ignore-')
  // The repository is asserted into existence: a failed init makes every answer below exit 128, and a
  // reader would be told the wrong path is tracked.
  const init = spawnSync('git', ['init', '--quiet', tree], { encoding: 'utf8' })
  assert.equal(init.status, 0, 'the throwaway repository holds the rules: ' + init.stderr)
  fs.copyFileSync(rules, path.join(tree, '.gitignore'))

  // The rule that matched, for a message. `-v` names it; only `-q` answers the question, above.
  const ruleFor = candidate =>
    spawnSync('git', ['-C', tree, 'check-ignore', '--no-index', '-v', '--', candidate], { encoding: 'utf8' }).stdout.trim()
  const ignored = candidate => {
    const { status, stderr } = spawnSync('git', ['-C', tree, 'check-ignore', '--no-index', '-q', '--', candidate], { encoding: 'utf8' })
    // 0 is ignored and 1 is not: any other status is git failing, which is not an answer.
    assert.ok(status === 0 || status === 1, 'git answers for ' + candidate + ': ' + stderr)
    return status === 0
  }

  assert.equal(ignored(WITNESS_COMMIT), false, WITNESS_COMMIT + ' is ignored by ' +
    ruleFor(WITNESS_COMMIT) + ', so the copy the last step makes is a record no checkout holds: teach ' +
    '.gitignore to re-include it, and the copy step in src/driver/dev-proof.js is the sentence that names it')

  // The other path is the one the rule is for, and it stays out of git: a case that only asked the
  // first question would pass with .reports/ tracked.
  assert.equal(ignored(WITNESS_WRITE), true, WITNESS_WRITE + ' is tracked, and .reports/ is where a ' +
    'run leaves what git does not keep: the file an operator edits is WITNESS_WRITE in src/driver/dev-proof.js')

  // The exception is the witness files and nothing else, so a run's report is still a run's to lose:
  // a case that only asked the two questions above would pass with the whole rule deleted.
  const report = 'testdata/driver-summary.json'
  assert.equal(ignored(report), true, report + ' is ignored by ' + ruleFor(report) +
    ', and a report a run writes stays ignored: the exception is a witness, not every .json under testdata/')
})

test('#923 a row\'s evidence and the failed list are copies too, and the log contradicts both by name', () => {
  const document = witnessed()
  const rows = document.frames.rows.map(row => row.id === 'body'
    ? { ...row, evidence: 'the spawn went out on every socket' }
    : row)
  const check = verifyWitness({ ...document, frames: { ...document.frames, rows, failed: ['mode'] } },
    { log: { path: LOG, text: lines(run()) } })

  assert.equal(check.ok, false)
  assert.match(check.reason, /row `body`'s evidence is "the spawn went out on every socket" in the witness and/)
  assert.match(check.reason, /frames\.failed is \[mode\] in the witness and \[\] in the log/)
})

test('#923 a row recorded twice is named, not read as its last copy', () => {
  const document = witnessed()
  const rows = document.frames.rows
  document.frames = { ...document.frames, rows: [...rows, { ...rows[0], holds: false }] }

  const check = verifyWitness(document, { log: { path: LOG, text: lines(run()) } })
  assert.equal(check.ok, false)
  assert.match(check.reason, /row `landed` is in the witness twice/)
})

// #880: the check was the count. A document with the right number of rows, every one recorded and
// evidenced, passed no matter which steps those rows were, so one that recorded a step twice and
// never recorded another verified as a finished proof. These cases vary the names and hold the
// count, because a case that varies the count is the case the old check already caught.
test('a witness that keeps the count and loses a step is refused, naming the step nobody recorded', () => {
  const document = witnessed()
  const rows = document.steps
  document.steps = [
    ...rows.filter(step => step.id !== 'spectator-mode'),
    { ...rows.find(step => step.id === 'puppet-walks'), evidence: 'saw it again, on client two' }
  ]

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'the right number of rows is not the right steps')
  assert.match(check.reason, /^unwitnessed: `spectator-mode`/)
  assert.match(check.reason, /; recorded twice: `puppet-walks`/, 'and names the row that took its place')
})

// The other direction of the same bug: a document one row short, which the count check caught and
// refused with a total. The operator's repair is the row the step was lost from, so it is named.
test('a witness with a row deleted names the step it lost, not the count it kept', () => {
  const document = witnessed()
  document.steps = document.steps.filter(step => step.id !== 'puppet-walks')

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /^unwitnessed: `puppet-walks`$/, 'one step, named, and no total to work it out from')
})

test('a witness whose rows are the right steps in another order is refused, row by row', () => {
  const document = witnessed()
  const [first, second] = document.steps
  document.steps = [second, first, ...document.steps.slice(2)]

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'the set of names is not the list')
  assert.match(check.reason,
    /^the witness's row 1 records `puppet-walks`, and the run's step 1 is `puppet-renders`/)
})

test('a row that names no step is refused, and the row is the repair', () => {
  const document = witnessed()
  document.steps = document.steps.map(step => ({ claim: step.claim, state: step.state, evidence: step.evidence }))

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'rows with no names are rows the check cannot place')
  assert.match(check.reason, /carry no step id/)
  assert.match(check.reason, /`puppet-renders`/, 'the repair names the steps a row may record')

  const one = witnessed()
  one.steps = withStep(one, 'spectator-mode', { id: undefined })
  const named = verifyWitness(one)
  assert.equal(named.ok, false, 'one unnamed row is one step nobody can find')
  assert.match(named.reason, /^the witness's row \d+ carries no step id/)
})

test('a row that names a step this run does not have is refused, naming the row', () => {
  const document = witnessed()
  document.steps = withStep(document, 'drawn-once', { id: 'drawn-thrice' })

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /^the witness's row \d+ \(`drawn-thrice`\) is no step of this run/)
})

function witnessed (report = verdict(readingOf(run()))) {
  return recorded(witnessDocument(report))
}

// One row replaced, found by the step it records rather than its position: an index in this file
// would start asserting about a different step the day OPERATOR_STEPS is reordered.
function withStep (document, id, change) {
  return document.steps.map(step => (step.id === id ? { ...step, ...change } : step))
}

// A document an operator finished: every row seen, with evidence, and the completion flag set.
// The rows are the ones `witness` wrote, so a case can reorder them or drop one.
function recorded (document) {
  return {
    ...document,
    completed: true,
    steps: document.steps.map((step, index) => ({
      ...step,
      state: 'seen',
      evidence: 'saw it on client ' + (index % 2 === 0 ? 'one' : 'two')
    }))
  }
}

// ---------------------------------------------------------------------------
// The record list
// ---------------------------------------------------------------------------

test('every record the reader relies on is written by a leg', () => {
  // The three files a run's records are written from, and no fourth list. A hand map of which
  // file writes which name is a third copy of that fact, and a name added to RECORDS without an
  // entry in it failed once with "a leg writes pickerPick" about a line live-front.js holds. A
  // name is written by one of these or it is not written.
  const writers = Object.fromEntries(
    ['src/service/monoplayer.js', 'src/legs/live-front.js', 'src/service/start-live.js']
      .map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')])
  )

  assert.equal(new Set(RECORDS.map(record => record.name)).size, RECORDS.length, 'no record is listed twice')
  for (const { name } of RECORDS) {
    const wrote = Object.entries(writers)
      .filter(([, text]) => text.includes("log('" + name + "'"))
      .map(([file]) => file)
    assert.ok(wrote.length > 0,
      'a leg writes ' + name + ': no log(\'' + name + '\') in ' + Object.keys(writers).join(', '))
  }
})

// The runbook's record table and the module's list, held together both ways (#830). The table is the
// list written out: one row per record, and the module's own sentence in the second cell.
//
// Read as rows, inside the section that documents them, and never as the page. By #867 the names
// were compared both ways, and the sentence was compared nowhere; above that comparison a search of
// the whole page still answered for a row the table did not hold, so a runbook could lose a row and
// keep its record's name alive in the prose around it.
//
// What this reads, and what it does not (#876): one table's rows, and, below them, no second table.
// Every other line of the section is compared to nothing, so a record's fact restated there is a
// second home, and the copy that drifts.
//
// Both halves are runnable. Add a sentence to the prose claiming the `heartbeat` record is written
// every 10 minutes, and this file stays green. Add four words to a row's cell, and it fails, naming
// the row. The runbook says which half is read, because a reader cannot see the difference.
// test/tooling/dev-lane-proof.test.js reads that section too, and it asks rather than compares: the
// counter names in the lower paragraph have to be there, and the service has to count each one.
// Neither file compares a sentence of that prose to anything.
//
// One repair per kind, because they are four different edits in two files: a record with no row, a
// row with no record, a sentence reworded on one side, and a row moved out of the list's order. The
// order is the list's, not the run's: `pickerEmpty` is documented last and written at the picker. The
// reworded one quotes both cells, because a cell can run to hundreds of characters and its name is
// not the edit.
//
// What is not asked, here or anywhere: whether a record a leg starts writing has a row in RECORDS.
// The legs write far more names than this list holds, and that is the list's judgement, so the two
// guards that cover it read the senders (#829's dialogs, and the writers scan above), not the tree.
const RECORD_SECTION = 'Read what the lane recorded'
const RECORD_PAGE = 'deploy/dev/README.md'

test('the runbook\'s record table is the list, a name and a sentence for every record, both ways', () => {
  const rows = recordRows(fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8'))

  // The module's side has to be read, or a list emptied by a bad edit would leave every comparison
  // below holding nothing and passing. The page's side cannot be empty in silence: `recordRows`
  // throws when the section has no table, and a table with no data row reports every record missing
  // one, which is the repair.
  assert.ok(RECORDS.length > 0, 'the module lists the records a run is made of')
  for (const { name, what } of RECORDS) {
    assert.ok(!what.includes('|') && !what.includes('\n'),
      'the sentence for ' + name + ' fits one markdown cell: no pipe and no line break')
  }

  assert.deepEqual(recordDisagreement(recordDrift(rows, RECORDS)), [],
    'the runbook\'s record table and RECORDS disagree')
})

// The table's rows, as the name in the "Record" cell and the sentence beside it. The columns are
// looked up by their header names, so a table whose cells moved is a finding rather than a row read
// wrong, and the next table in the runbook is not this one.
function recordRows (readme) {
  const lines = section(readme, RECORD_SECTION).split('\n')
  const header = lines.findIndex(line => line.trimStart().startsWith('|'))
  assert.notEqual(header, -1, 'the "' + RECORD_SECTION + '" section carries the record table')
  const columns = cells(lines[header])
  const nameAt = columns.indexOf('Record')
  const whatAt = columns.indexOf('What it says')
  assert.ok(nameAt !== -1 && whatAt !== -1,
    'the record table has a "Record" column and a "What it says" column: ' + lines[header])

  assert.match(lines[header + 1], /^\|(\s*:?-+:?\s*\|)+$/,
    'the record table is headed by its separator row: ' + lines[header + 1])
  const rows = []
  let index = header + 2
  for (; index < lines.length && lines[index].trimStart().startsWith('|'); index += 1) {
    const row = cells(lines[index])
    assert.equal(row.length, columns.length,
      'every row of the record table has one cell per column: ' + lines[index])
    const name = row[nameAt].match(/^`([A-Za-z0-9_]+)`$/)
    assert.ok(name !== null, 'every row of the record table opens with one record name: ' + lines[index])
    rows.push({ name: name[1], what: row[whatAt] })
  }
  // One table, so a second copy of it later in the section cannot sit under the one this reads: the
  // runbook is a page an operator scrolls, and the stale copy is the one they would find first.
  const later = lines.slice(index).filter(line => line.trimStart().startsWith('|'))
  assert.deepEqual(later, [], 'the section carries one table: ' + later.length + ' row(s) sit under it')
  return rows
}

// A row's cells: the outer pipes are not cells, and a cell keeps its backticks. This is the split
// src/ladder/next-rung.js's cells() does, kept local for the reason section() below keeps its copy:
// one guard's helper is not another guard's, and a false red costs more than two lines.
function cells (line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

// The section a table is documented in, from its heading to the next heading of the same or a higher
// level. A copy, for the reason test/tooling/dev-lane-proof.test.js gives for keeping its own: a
// guard that shares a helper with the guard it is modelled on fails when that one is edited, and a
// false red costs more than six lines.
function section (text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^#+\s/.test(line) && line.replace(/^#+\s+/, '').trim() === heading)
  assert.notEqual(start, -1, 'the doc has a "' + heading + '" section')
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#+)\s/)
    if (next && next[1].length <= level) { end = index; break }
  }
  return lines.slice(start, end).join('\n')
}

// What the two sides disagree about, one list per repair. Order is asked only when both sides hold
// the same names: a missing name moves everything after it, and a list of moved rows beside it would
// report one edit twice.
function recordDrift (rows, records) {
  const rowOf = new Map(rows.map(row => [row.name, row.what]))
  const recordOf = new Map(records.map(record => [record.name, record.what]))
  const missingRow = records.map(record => record.name).filter(name => !rowOf.has(name))
  const missingRecord = rows.map(row => row.name).filter(name => !recordOf.has(name))
  const reworded = records
    .filter(record => rowOf.has(record.name) && rowOf.get(record.name) !== record.what)
    .map(record => ({ name: record.name, table: rowOf.get(record.name), module: record.what }))
  const counted = rows.reduce((tally, row) => tally.set(row.name, (tally.get(row.name) ?? 0) + 1), new Map())
  const duplicateRow = [...counted].filter(([, count]) => count > 1).map(([name]) => name)
  const sameNames = missingRow.length === 0 && missingRecord.length === 0 && duplicateRow.length === 0
  const moved = sameNames ? rows.map(row => row.name).filter((name, at) => name !== records[at].name) : []
  return { missingRow, missingRecord, duplicateRow, reworded, moved }
}

// The edit each disagreement asks for, one sentence each, naming the record and quoting both sides
// where there are two. A message that said only "the table and the list disagree" would leave the
// reader to work out which of the four edits is theirs, and which row.
function recordDisagreement ({ missingRow, missingRecord, duplicateRow, reworded, moved }) {
  return [
    ...missingRow.map(name => RECORD_PAGE + ' has no row for ' + name +
      ': add one with the name in the Record cell and the sentence beside it'),
    ...missingRecord.map(name => 'RECORDS lists no record named ' + name +
      ', which ' + RECORD_PAGE + ' documents: add the entry, or remove the row'),
    ...duplicateRow.map(name => RECORD_PAGE + ' has more than one row for ' + name +
      ': a row is one record, and two rows for one record say it twice'),
    ...reworded.map(({ name, table, module }) => RECORD_PAGE + '\'s cell for ' + name +
      ' is not the module\'s sentence\n  the table says: ' + table + '\n  RECORDS says: ' + module),
    ...moved.map(name => RECORD_PAGE + '\'s table is not in RECORDS\'s order at ' + name +
      ': the list is the order a reader of RECORDS finds them in')
  ]
}

// Fixtures, not the tree: the reader and the comparison are held by a page built here, so a drift in
// the runbook cannot make this case about the drift instead of the guard. Every name in the fixture
// also appears in the paragraph below its table, which is #830's second hole: a name in the page is
// not a row. The next section's table is not read either, which is the same hole one bound over.
test('the record guard names each side to fix, and a name in the page is not a row', () => {
  const records = [{ name: 'alpha', what: 'the first sentence' }, { name: 'beta', what: 'the second sentence' }]
  const page = rows => [
    '#### ' + RECORD_SECTION,
    '',
    '| Record | What it says |',
    '|---|---|',
    ...rows.map(({ name, what }) => '| `' + name + '` | ' + what + ' |'),
    '',
    'The writer names `alpha` and `beta` in this paragraph.',
    '',
    '### The next section',
    '',
    '| Record | What it says |',
    '|---|---|',
    '| `gamma` | a row of another table |'
  ].join('\n')

  assert.deepEqual(recordDrift(recordRows(page(records)), records),
    { missingRow: [], missingRecord: [], duplicateRow: [], reworded: [], moved: [] },
    'the fixture agrees with itself, so each case below is about its own edit')

  const missingRow = recordDrift(recordRows(page(records.slice(0, 1))), records)
  assert.deepEqual(missingRow.missingRow, ['beta'], 'the paragraph naming beta is not a row for it')
  assert.match(recordDisagreement(missingRow)[0], /^deploy\/dev\/README\.md has no row for beta/)

  const missingRecord = recordDrift(recordRows(page([...records, { name: 'gamma', what: 'a third sentence' }])), records)
  assert.deepEqual(missingRecord.missingRecord, ['gamma'])
  assert.match(recordDisagreement(missingRecord)[0], /^RECORDS lists no record named gamma/)

  const repeated = recordDrift(recordRows(page([...records, records[1]])), records)
  assert.deepEqual(repeated.duplicateRow, ['beta'])
  assert.match(recordDisagreement(repeated)[0], /^deploy\/dev\/README\.md has more than one row for beta/)

  const reworded = recordDrift(recordRows(page([records[0], { name: 'beta', what: 'a sentence of the page' }])), records)
  assert.deepEqual(reworded.reworded.map(({ name }) => name), ['beta'])
  assert.match(recordDisagreement(reworded)[0],
    /^deploy\/dev\/README\.md's cell for beta is not the module's sentence\n  the table says: a sentence of the page\n  RECORDS says: the second sentence$/)

  const moved = recordDrift(recordRows(page([records[1], records[0]])), records)
  assert.deepEqual(moved.moved, ['beta', 'alpha'])
  assert.match(recordDisagreement(moved)[0], /^deploy\/dev\/README\.md's table is not in RECORDS's order at beta/)

  assert.deepEqual(recordRows(page([{ name: 'alpha', what: 'the first sentence' }])),
    [{ name: 'alpha', what: 'the first sentence' }],
    'the reader returns this table\'s rows and no other: the paragraph names beta, and the next section has gamma')
  assert.throws(() => recordRows(page([{ name: 'alpha', what: 'the first sentence' }])
    .replace('\n\nThe writer names', '\n| `beta` |\n\nThe writer names')),
  /one cell per column/, 'a row that is one cell short is a finding, not half a row read')
  assert.throws(() => recordRows(page(records).replace('| Record | What it says |', '| Name | What it says |')),
    /"Record" column/, 'a table that lost the Record column is a finding, not rows of empty names')

  // A row indented under the table is still that table's row, as it is in the rendered page. The
  // header and the rows have to agree about that, or the one shape an operator can add is the one
  // shape the guard does not read.
  assert.deepEqual(recordRows(page([records[0]]).replace('\n\nThe writer names', '\n  | `beta` | the second sentence |\n\nThe writer names')),
    records, 'a row indented under the table is read as a row')

  // A second copy of the table inside the same section is the stale one an operator scrolls into,
  // so the section is held to one table rather than to its first.
  assert.throws(() => recordRows(page(records).replace('\n\nThe writer names',
    '\n\n| `beta` | the second sentence |\n\nThe writer names')),
  /the section carries one table/, 'a second table in the section is a finding, not a table read twice')
})

// #829: a picker click writes a dialog at each end of it, and a dialog's records are the
// operator's proof that a client was shown one. The two senders are read as source, so a line
// added to either is a name this fails on until RECORDS carries it, or an entry beside it names
// it the way `pickerVerb` names `pickerVerbRefused` — the refusal a reader greps for, and not a
// row of its own.
test('every record a picker dialog writes is named by the list, as a row or in an entry', () => {
  const front = fs.readFileSync(path.join(ROOT, 'src', 'legs', 'live-front.js'), 'utf8')
  const named = new Set(RECORDS.map(record => record.name))
  for (const { what } of RECORDS) {
    for (const quoted of what.matchAll(/`([A-Za-z0-9_]+)`/g)) named.add(quoted[1])
  }

  for (const sender of ['sendPickerDialog', 'sendServerDialog']) {
    const written = [...new Set([...functionBody(front, sender).matchAll(/log\('([A-Za-z0-9_]+)'/g)]
      .map(match => match[1]))]
    assert.ok(written.length > 0, 'the scan reads what ' + sender + ' writes')
    // Named, not necessarily a row: `pickerVerbRefused` is named in `pickerVerb`'s sentence and
    // is deliberately not a row of its own. A record another entry's prose happens to name passes
    // here too, which is the price of the list's own idiom.
    for (const name of written) {
      assert.ok(named.has(name), 'RECORDS names ' + name + ', which ' + sender + ' writes')
    }
  }
})

// The runbook's "What you should see" table and the module's operator steps, held together both
// ways (#831). The table above is what a reader of records checks; this one is what a person
// checks while standing in the world, and nothing compared it to `OPERATOR_STEPS`: a step added
// to the module became a witness row the runbook never told the operator to look at, and a step
// removed left the page asking for an observation nothing records. Six rows against six steps
// agreed, which is exactly the state that hides the next drift.
//
// The sentence was the next seam (#881). #831 held the id and the record name; the "You should
// see" cell was a second writing of `claim`, and a step reworded there passed, so the operator
// recorded a witness row asking for something the page never told them to look at. The cell is now
// held to the claim word for word, both ways: the comparison reads both texts, so neither is
// derived from the other, and it strips nothing. Emphasis in a cell is a different sentence.
//
// The fourth cell is the next seam (#882). It is the page's prose, one reading deep: it names the
// step's record and nothing else, so a count written in it was a copy nobody read. The mode step's
// cell said the pair's length was `2`, which is `spectatorModeFrames().length` — a third frame in that
// module would have left the page saying two while every spectator row went red. That cell is now the
// step's own `because` sentence, built in the module with the count inside it, and compared word for
// word like the claim. A step whose failure cell states no derived fact carries no `because`, and its
// cell stays the page's, which is why the field is optional: every other step carries no `because`,
// and no empty string stands in for one.
//
// The rest of the last cell was the next seam (#931). A step whose cell states no fact the module
// computes carries no `because`, so its wording is the page's, and the guard read one name in it:
// the step's own record. A cell could send an operator to `puppetSkinKnown` and stay green the day
// that record was renamed. What is left to compare is the names, so `FAILURE_READS` below declares
// the records each cell reads beyond its own, the guard holds the declaration to the cell both ways,
// and each row writes the sentence #931 asks for: the rest of the cell is what a person sees, and
// that is why nothing compares it. A row for a cell the module owns, or for no step at all, is the
// same table one step stale.
//
// Read as rows, inside its own section, keyed by the id each row carries — never as the page,
// because the runbook names these steps in the prose around the table too. A row says where to
// look, what to see there, and the record that says otherwise when it is missing, so the guard
// asks for all three; and where a step names a `record`, the last cell has to name it. Two tables
// on one page are read by one extraction — `section` and `cells` above — so a row means one thing
// in the record table and in this one.
const STEP_SECTION = 'What you should see'

test('the runbook\'s step table is OPERATOR_STEPS: a name, a sentence, a record where a step has one, and a failure sentence where a step states a count, both ways', () => {
  const rows = stepRows(fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8'))

  // Both sides have to be read, or a table rewritten as prose would leave the comparison holding
  // two empty lists and passing.
  assert.ok(rows.length > 0, 'the "' + STEP_SECTION + '" section carries the table an operator reads')
  assert.ok(OPERATOR_STEPS.length > 0, 'the module names the steps only a person can answer')

  // A failure sentence is a cell, so it carries no pipe and no line break: the precondition the
  // record table asks of `RECORDS`' sentences, and the one thing that would let the comparison
  // below pass while the page rendered something else.
  for (const { id, because } of OPERATOR_STEPS.filter(step => typeof step.because === 'string')) {
    assert.ok(!because.includes('|') && !because.includes('\n'),
      'the failure sentence for ' + id + ' fits one markdown cell: no pipe and no line break')
  }

  assert.deepEqual(stepDisagreement(stepDrift(rows)), [],
    'the runbook\'s step table and OPERATOR_STEPS disagree')
})

test('every failure cell that states no derived fact declares the records it reads, and why the rest is prose', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8')
  assert.deepEqual(failureDisagreement(failureDrift(stepRows(readme))), [],
    'the runbook\'s failure cells and FAILURE_READS disagree')
  assert.match(section(readme, STEP_SECTION), /FAILURE_READS/,
    'the page names the table a reader looks a cell up in, so they can tell which half is compared')
})

// The table's rows, as the step id in the "Step" cell and the three cells beside it. The columns
// are looked up by their header names, so a table whose cells moved is a finding rather than a
// row read wrong, and the next table in the runbook is not this one.
function stepRows (readme) {
  const lines = section(readme, STEP_SECTION).split('\n')
  const header = lines.findIndex(line => line.trimStart().startsWith('|'))
  assert.notEqual(header, -1, 'the "' + STEP_SECTION + '" section carries the step table')
  const columns = cells(lines[header])
  const columnOf = Object.fromEntries([
    ['id', 'Step'], ['look', 'Look at'], ['see', 'You should see'], ['because', 'If you do not']
  ].map(([key, name]) => {
    const at = columns.indexOf(name)
    assert.notEqual(at, -1, 'the step table has a "' + name + '" column: ' + lines[header])
    return [key, at]
  }))

  const rows = []
  for (let index = header + 2; index < lines.length && lines[index].startsWith('|'); index += 1) {
    const row = cells(lines[index])
    assert.equal(row.length, columns.length,
      'every row of the step table has one cell per column: ' + lines[index])
    const id = row[columnOf.id].match(/^`([a-z0-9-]+)`$/)
    assert.ok(id !== null, 'every row of the step table opens with one step id in the Step cell: ' + lines[index])
    rows.push({ id: id[1], look: row[columnOf.look], see: row[columnOf.see], because: row[columnOf.because] })
  }
  return rows
}

// What the two sides disagree about, one list per repair, because they are different edits in two
// files. Order is asked only when both sides hold the same names: a missing name moves everything
// after it, and a list of moved rows beside it would report one edit twice.
const duplicated = ids => ids.filter((id, at) => ids.indexOf(id) !== at)

function stepDrift (rows, steps = OPERATOR_STEPS, records = RECORDS) {
  const rowOf = new Map(rows.map(row => [row.id, row]))
  const stepOf = new Map(steps.map(step => [step.id, step]))
  // A step that states a fact the module computes carries its failure sentence here; one that does
  // not carries nothing, and no cell of it is compared beyond the record's name.
  const statesFailure = step => typeof step.because === 'string'
  const missingRow = steps.map(step => step.id).filter(id => !rowOf.has(id))
  const missingStep = rows.map(row => row.id).filter(id => !stepOf.has(id))
  const thin = rows
    .filter(row => [row.look, row.see, row.because].some(cell => cell === ''))
    .map(row => row.id)
  // The cell against the step's own sentence (#881), compared exactly: no case fold, no stripped
  // markdown, no prefix match. A comparison loose enough to allow those passes a cell worded
  // differently enough to matter, which is the drift it exists to catch. The step's side is read
  // too, so a claim reworded in the module fails here with the page untouched.
  // An empty cell is `thin`'s finding and not this one: one defect, one edit, and a row with no
  // sentence at all is the emptier repair to ask for first.
  const reworded = steps.flatMap(step => {
    const row = rowOf.get(step.id)
    if (row === undefined || row.see === '' || row.see === step.claim) return []
    return [{ id: step.id, table: row.see, module: step.claim }]
  })
  // A step whose cell is the module's sentence already forces the record's name, because the
  // sentence carries it. So a cell that lost the name and the sentence is one defect, reported once
  // as a reworded failure: two messages would ask for one edit twice.
  const unnamedRecord = steps
    .filter(step => step.record !== null && !statesFailure(step) && rowOf.has(step.id) &&
      !namesRecord(rowOf.get(step.id), step.record))
    .map(step => ({ id: step.id, record: step.record }))
  const unlistedRecord = steps
    .filter(step => step.record !== null && !records.some(record => record.name === step.record))
    .map(step => ({ id: step.id, record: step.record }))
  const repeated = [...new Set([...duplicated(rows.map(row => row.id)), ...duplicated(steps.map(step => step.id))])]
  const sameNames = missingRow.length === 0 && missingStep.length === 0 && rows.length === steps.length
  const moved = sameNames ? rows.map(row => row.id).filter((id, at) => id !== steps[at].id) : []
  // #882: the failure cell is the page's prose, except where the step states a fact the module
  // computes. Then the step's `because` is the sentence and the page's cell is that sentence word for
  // word, so a count the module changes moves the page instead of leaving it saying the old number.
  // A step with no `because` is not compared here: its cell is the page's, and `namesRecord` is all
  // the guard reads of it. An empty cell is `thin`'s finding, as above.
  const rewordedFailure = steps.flatMap(step => {
    if (!statesFailure(step)) return []
    const row = rowOf.get(step.id)
    if (row === undefined || row.because === '' || row.because === step.because) return []
    return [{ id: step.id, table: row.because, module: step.because }]
  })
  return { missingRow, missingStep, thin, reworded, rewordedFailure, unnamedRecord, unlistedRecord, repeated, moved }
}

// A row names its record in backticks in the last cell, alone or at the head of a field path: the
// page writes `spectateView.modeFrames`, which is the record's name with the number to read inside
// it. The last cell only, because that is the cell the page says names the record, and a name in
// "You should see" is a row whose diagnostic column disagrees with its instruction.
function namesRecord (row, record) {
  return new RegExp('`' + record + '(?:\\.[A-Za-z0-9_]+)*`').test(row.because)
}

// Which records each failure cell names beyond the step's own, and why the rest of the cell is the
// page's (#931). #882 made a cell that states a fact the module computes a `because` sentence, and
// that cell is compared word for word; every other cell is the page's wording, and the guard read
// one thing in it, the name of the step's own record. So a cell could send an operator to
// `puppetSkinKnown` and stay green the day that record was renamed. What is left to compare is the
// names: `reads` is the records a cell names besides its step's own, and `why` is #931's sentence
// for the half no record can answer, because a default skin and a puppet that walks are what a
// person sees. A row with no `reads` says the cell names only its step's record, which `namesRecord`
// already holds. The table is here rather than in the module for the reason `NOT_PATHS` and `UNREAD`
// are: it is a decision about what a guard reads, and the module's own comment says the absence of a
// `because` is what marks a cell as the page's.
const FAILURE_READS = {
  'puppet-renders': {
    reads: ['puppetSkinKnown', 'puppetSkinWithheld', 'puppetSkinRefused'],
    why: 'the rule the cell states is `landingEntry`\'s, and the module\'s case pins it: what a client ' +
      'draws from the entry is the screen, and only the operator sees it'
  },
  'puppet-walks': {
    reads: [],
    why: 'the lag a watching client sees is the screen, and `virtualPlayersMoved` is the process\'s ' +
      'counter: it says a move was written, never that the puppet walked'
  },
  'drawn-for-driver': {
    reads: [],
    why: 'the frames are the record\'s, and a body standing beside the driver is the screen: no record ' +
      'says what either client drew with what reached its socket'
  },
  'drawn-once': {
    reads: [],
    why: 'one body or two is the screen: `virtualPlayerWritten` says the driver\'s channel was told about ' +
      'its own player, and the operator sees the duplicate'
  }
}

// The backticked record names a cell writes. `RECORDS` is the only thing that can tell a record from
// the field, counter or frame written beside it, so a token it does not list is not asked about. A
// token written `record.field` is that record with the number to read inside it, so the head is the
// name.
function cellRecords (cell, listed) {
  return [...new Set([...cell.matchAll(/`([^`]+)`/g)]
    .map(match => match[1].split('.')[0])
    .filter(name => listed.has(name)))]
}

// One list per repair, the way `stepDrift` is, because each is a different edit: a cell with no row,
// a row for a cell the guard already compares, a row for no step at all, a name `RECORDS` does not
// write, a declared name the cell does not write, a name the cell writes and no row declares, and a
// reason too short to be one.
function failureDrift (rows, steps = OPERATOR_STEPS, records = RECORDS, reads = FAILURE_READS) {
  const rowOf = new Map(rows.map(row => [row.id, row]))
  const stepOf = new Map(steps.map(step => [step.id, step]))
  const listed = new Set(records.map(record => record.name))
  const cellOf = id => rowOf.get(id)?.because ?? ''
  // A cell the module owns is compared word for word by `stepDrift`, so a row here is a decision
  // nothing consults: the table and the field are two answers to one step.
  const unrecorded = steps
    .filter(step => typeof step.because !== 'string' && !Object.hasOwn(reads, step.id))
    .map(step => step.id)
  const orphans = Object.keys(reads)
    .filter(id => stepOf.get(id) === undefined || typeof stepOf.get(id).because === 'string')
  const unlisted = Object.entries(reads).flatMap(([id, row]) => row.reads
    .filter(name => !listed.has(name)).map(name => ({ id, name })))
  // One defect is one finding: a declared name `RECORDS` has dropped is `unlisted`'s, and the cell
  // that still writes it is the same edit, so this arm does not also ask for it.
  const missing = Object.entries(reads).flatMap(([id, row]) => row.reads
    .filter(name => listed.has(name) && !cellRecords(cellOf(id), listed).includes(name))
    .map(name => ({ id, name })))
  const undeclared = Object.entries(reads).flatMap(([id, row]) => {
    const own = stepOf.get(id)?.record ?? null
    return cellRecords(cellOf(id), listed)
      .filter(name => name !== own && !row.reads.includes(name)).map(name => ({ id, name }))
  })
  // `thin` is `stepDrift`'s empty cell, so this arm is named for what it measures: a reason too
  // short to say why. The floor is the one `NOT_PATHS` and `UNREAD` hold a reason to.
  const thinWhy = Object.keys(reads).filter(id => reads[id].why.length <= 40)
  return { unrecorded, orphans, unlisted, missing, undeclared, thinWhy }
}

function failureDisagreement ({ unrecorded, orphans, unlisted, missing, undeclared, thinWhy }) {
  return [
    ...unrecorded.map(id => 'the runbook\'s failure cell for ' + id + ' is the page\'s prose, and FAILURE_READS ' +
      'says which records it reads and why the rest is prose: no row is here, so nothing tells a reader ' +
      'which half of that cell is compared'),
    ...orphans.map(id => 'FAILURE_READS holds a row for ' + id + ', and its cell is OPERATOR_STEPS\' sentence ' +
      'word for word: the row is a decision nothing consults, so drop it, or drop the step\'s `because`'),
    ...unlisted.map(({ id, name }) => 'FAILURE_READS says the failure cell for ' + id + ' reads `' + name +
      '`, and RECORDS lists no such record: name the record the service writes, in the module and in the row'),
    ...missing.map(({ id, name }) => 'the runbook\'s failure cell for ' + id + ' does not write `' + name +
      '`, which FAILURE_READS declares for it: write the name in the cell, or drop it from the row'),
    ...undeclared.map(({ id, name }) => 'the failure cell for ' + id + ' names `' + name + '`, and ' +
      'FAILURE_READS declares no such record for it: add the name to the row, or take it out of the sentence'),
    ...thinWhy.map(id => 'FAILURE_READS gives ' + id + ' a reason too short to say why the rest of its cell is ' +
      'the page\'s prose: a row without its reason is the omission this table replaced')
  ]
}

// The edit each disagreement asks for, one sentence each, naming the row and the side it is on. A
// message that said only "the table and the steps disagree" would leave the reader to work out
// which of the edits is theirs, and which row.
function stepDisagreement ({ missingRow, missingStep, thin, reworded, rewordedFailure, unnamedRecord, unlistedRecord, repeated, moved }) {
  return [
    ...missingRow.map(id => 'deploy/dev/README.md\'s "' + STEP_SECTION + '" table has no row for step ' + id +
      ', which OPERATOR_STEPS carries: add a row with `' + id + '` in the Step cell, or remove the step'),
    ...missingStep.map(id => 'OPERATOR_STEPS defines no step named ' + id +
      ', which the runbook\'s table documents: add the step and its id to the list, or remove the row'),
    ...thin.map(id => 'the runbook\'s row for ' + id + ' leaves a cell empty: a row says where to look, ' +
      'what you should see there, and the record that says otherwise'),
    // Both texts, because the sentence is the edit and neither side is the one to keep by default:
    // the claim is what the witness writes and quotes back, and the cell is what the operator reads.
    ...reworded.map(({ id, table, module }) => 'deploy/dev/README.md\'s "You should see" cell for ' + id +
      ' is not the step\'s claim\n  the table says: ' + table + '\n  OPERATOR_STEPS says: ' + module),
    // #882: both texts, because either side can be the edit: a module sentence that changed its
    // count, or a page that still states the old one.
    ...rewordedFailure.map(({ id, table, module }) => 'deploy/dev/README.md\'s failure cell for ' + id +
      ' is not the step\'s sentence\n  the table says: ' + table + '\n  OPERATOR_STEPS says: ' + module),
    ...unnamedRecord.map(({ id, record }) => 'the runbook\'s row for ' + id + ' does not name `' + record +
      '`, the record that goes into the log when the step fails: name it in the last cell, where the operator reads it'),
    ...unlistedRecord.map(({ id, record }) => 'OPERATOR_STEPS gives step ' + id + ' the record `' + record +
      '`, and RECORDS lists no such record: it is a record a run writes, or nothing at all'),
    ...repeated.map(id => 'the step ' + id + ' is named twice, on the runbook\'s side or the module\'s: ' +
      'the witness writes one row per step, so a repeat is two steps nobody can tell apart'),
    ...moved.map(id => 'the runbook\'s step table is not in OPERATOR_STEPS\'s order at ' + id +
      ': the witness is written in the module\'s order, and the operator records it in the page\'s order')
  ]
}

// Fixtures, not the tree: the comparison is held by a page built here, so a drift in the runbook
// cannot make this case about the drift instead of the guard.
test('the step comparison reports a row on one side only, a thin row, a reworded sentence, a reworded failure sentence, and a row naming no record', () => {
  // The claim and the cell are the same words in the fixture, because that is the state the tree
  // has to hold: a fixture that started apart from itself would report a drift on every case below.
  const steps = [
    { id: 'first-step', claim: 'this', record: 'alphaRecord' },
    { id: 'second-step', claim: 'that', record: null }
  ]
  const records = [{ name: 'alphaRecord', what: 'a sentence' }]
  const rows = [
    { id: 'first-step', look: 'here', see: 'this', because: 'no `alphaRecord` in the log' },
    { id: 'second-step', look: 'there', see: 'that', because: 'nothing writes it' }
  ]
  const page = listed => [
    '## ' + STEP_SECTION,
    '',
    'The step `first-step` is named before the table, and `third-step` after it.',
    '',
    '| Step | Look at | You should see | If you do not |',
    '|---|---|---|---|',
    ...listed.map(row => '| `' + row.id + '` | ' + row.look + ' | ' + row.see + ' | ' + row.because + ' |'),
    '',
    'A paragraph naming `third-step` is not a row for it.',
    '',
    '## After the table',
    ''
  ].join('\n')

  assert.deepEqual(stepDisagreement(stepDrift(stepRows(page(rows)), steps, records)), [],
    'the fixture agrees with itself, so each case below is about its own edit')
  assert.deepEqual(stepRows(page(rows)), rows,
    'the reader returns this table\'s rows and no other: the paragraphs either side name steps, and the next section has none')

  const missingRow = stepDrift(stepRows(page(rows.slice(0, 1))), steps, records)
  assert.deepEqual(missingRow.missingRow, ['second-step'], 'a paragraph naming it is not a row for it')
  assert.match(stepDisagreement(missingRow)[0],
    /^deploy\/dev\/README\.md's "What you should see" table has no row for step second-step/)

  const missingStep = stepDrift(stepRows(page([...rows, { id: 'third-step', look: 'a', see: 'b', because: 'c' }])), steps, records)
  assert.deepEqual(missingStep.missingStep, ['third-step'])
  assert.match(stepDisagreement(missingStep)[0],
    /^OPERATOR_STEPS defines no step named third-step/)

  const thin = stepDrift(stepRows(page([{ ...rows[0], because: '' }, rows[1]])), steps, records)
  assert.deepEqual(thin.thin, ['first-step'])
  assert.match(stepDisagreement(thin)[0], /^the runbook's row for first-step leaves a cell empty/)

  // One defect is one finding: a "You should see" cell with no sentence is thin, and the sentence
  // comparison keeps quiet about it rather than asking for a second edit to the same row.
  const emptySee = stepDrift(stepRows(page([{ ...rows[0], see: '' }, rows[1]])), steps, records)
  assert.deepEqual(emptySee.thin, ['first-step'])
  assert.deepEqual(emptySee.reworded, [], 'an empty cell is the empty-cell finding, and not two')

  // #881: the cell and the step's claim, one message quoting both. The page's side first, then the
  // module's, because the same finding is reported whichever of the two was edited.
  const rewordedCell = stepDrift(stepRows(page([{ ...rows[0], see: 'the page\'s words' }, rows[1]])), steps, records)
  assert.deepEqual(rewordedCell.reworded.map(({ id }) => id), ['first-step'])
  assert.match(stepDisagreement(rewordedCell)[0],
    /^deploy\/dev\/README\.md's "You should see" cell for first-step is not the step's claim\n  the table says: the page's words\n  OPERATOR_STEPS says: this$/)

  const rewordedClaim = stepDrift(stepRows(page(rows)), [{ ...steps[0], claim: 'the module\'s words' }, steps[1]], records)
  assert.deepEqual(rewordedClaim.reworded.map(({ id }) => id), ['first-step'],
    'the module side is read too: a claim reworded there is the same finding, so neither text is derived from the other')
  assert.match(stepDisagreement(rewordedClaim)[0],
    /the table says: this\n  OPERATOR_STEPS says: the module's words$/)

  // How loose the comparison is: not at all. Emphasis a reader would see as styling is a different
  // string, because a comparison that stripped it would also pass a cell worded differently enough
  // to matter.
  assert.deepEqual(stepDrift(stepRows(page([{ ...rows[0], see: '**this**' }, rows[1]])), steps, records).reworded.map(({ id }) => id),
    ['first-step'], 'the comparison is exact, so a cell is the claim and not the claim plus markdown')

  const unnamed = stepDrift(stepRows(page([{ ...rows[0], because: 'nothing was written' }, rows[1]])), steps, records)
  assert.deepEqual(unnamed.unnamedRecord, [{ id: 'first-step', record: 'alphaRecord' }])
  assert.match(stepDisagreement(unnamed)[0], /does not name `alphaRecord`, the record that goes into the log/)

  // The row names it, so the only finding is that RECORDS has no such record.
  const unlisted = stepDrift(stepRows(page([{ ...rows[0], because: 'no `no-such-record` in the log' }, rows[1]])),
    [{ ...steps[0], record: 'no-such-record' }, steps[1]], records)
  assert.deepEqual(unlisted.unlistedRecord, [{ id: 'first-step', record: 'no-such-record' }])
  assert.match(stepDisagreement(unlisted)[0], /^OPERATOR_STEPS gives step first-step the record `no-such-record`/)

  const repeated = stepDrift(stepRows(page([rows[0], rows[1], rows[1]])), steps, records)
  assert.deepEqual(repeated.repeated, ['second-step'])
  assert.match(stepDisagreement(repeated)[0], /^the step second-step is named twice/)

  const moved = stepDrift(stepRows(page([rows[1], rows[0]])), steps, records)
  assert.deepEqual(moved.moved, ['second-step', 'first-step'])
  assert.match(stepDisagreement(moved)[0], /^the runbook's step table is not in OPERATOR_STEPS's order at second-step/)

  // #882: the failure cell that states a count. The step's sentence carries the number, so the
  // page's cell and the module are one string, and a page that still says the old number is the
  // drift. The record name stays in it, because a failure with no log line to open is no use.
  const counted = [{ ...steps[0], because: 'no `alphaRecord` in the log: was not 2' }, steps[1]]
  const countedCell = 'no `alphaRecord` in the log: was not 2'
  assert.deepEqual(stepDisagreement(stepDrift(stepRows(page([{ ...rows[0], because: countedCell }, rows[1]])), counted, records)), [],
    'the count the module states and the count the page states are one string, so the fixture agrees')

  const stale = stepDrift(stepRows(page([{ ...rows[0], because: 'no `alphaRecord` in the log: was not 3' }, rows[1]])), counted, records)
  assert.deepEqual(stale.rewordedFailure.map(({ id }) => id), ['first-step'],
    'a page stating a different count is the finding this compares')
  assert.match(stepDisagreement(stale)[0],
    /^deploy\/dev\/README\.md's failure cell for first-step is not the step's sentence\n  the table says: no `alphaRecord` in the log: was not 3\n  OPERATOR_STEPS says: no `alphaRecord` in the log: was not 2$/)

  // One defect is one finding here too: a cell that is not the sentence and also lost the record name
  // is the failure comparison's, because the module's sentence carries the name the cell was told to
  // hold. Two messages would ask for one edit twice.
  const countedAndUnnamed = stepDrift(stepRows(page([{ ...rows[0], because: 'was not 3' }, rows[1]])), counted, records)
  assert.deepEqual(countedAndUnnamed.rewordedFailure.map(({ id }) => id), ['first-step'])
  assert.deepEqual(countedAndUnnamed.unnamedRecord, [],
    'the record name is inside the module sentence, so a cell that lost both is one edit')

  // A step that states no derived fact keeps the page's wording: no `because`, and nothing reads it.
  assert.deepEqual(stepDrift(stepRows(page([{ ...rows[0], because: 'the page\'s own words, and no `alphaRecord`' }, rows[1]])), steps, records).rewordedFailure,
    [], 'a step with no derived fact keeps the page\'s prose, so the guard reads only its record name')

  assert.equal(namesRecord({ because: '`spectateView.modeFrames` was not 2' }, 'spectateView'),
    true, 'a record named with the field to read inside it is named')
  assert.equal(namesRecord({ because: '`spawn_entity` reached it' }, 'virtualPlayerWritten'),
    false, 'a frame is not the record that carries it')
  assert.equal(namesRecord({ see: '`puppetSkinSent` went out', because: 'a default skin' }, 'puppetSkinSent'),
    false, 'a record named outside the last cell is not the diagnostic the page promises')

  assert.throws(() => stepRows(page(rows).replace('\n\n| Step |', '\n\n| Name |')),
    /"Step" column/, 'a table that lost the Step column is a finding, not rows of empty names')
  assert.throws(() => stepRows(page(rows).replace('| `first-step` |', '| first-step |')),
    /opens with one step id/, 'a row whose first cell is not the id in code is a finding')
})

// The arms the table above needs to keep it honest: a cell with no row, a row nothing consults, a row
// for no step, a name RECORDS dropped, a declared name the cell does not write, a name the cell writes
// and no row declares, and a reason too short to be one. Fixtures, not the tree: a drift in the runbook
// cannot make this case about the drift instead of the guard.
test('the failure-cell comparison reports an undeclared cell, a row for a compared cell, a stale row, an unlisted name, a name the cell does not write, a name the cell never declared, and a thin reason', () => {
  const steps = [
    { id: 'first-step', claim: 'this', record: 'alphaRecord', because: 'was not 2' },
    { id: 'second-step', claim: 'that', record: 'betaRecord' }
  ]
  const records = ['alphaRecord', 'betaRecord', 'gammaRecord', 'epsilonRecord']
    .map(name => ({ name, what: 'a sentence' }))
  const rows = [
    { id: 'first-step', look: 'here', see: 'this', because: 'was not 2' },
    { id: 'second-step', look: 'there', see: 'that', because: 'no `betaRecord` and no `gammaRecord`' }
  ]
  const why = 'what a client draws is the screen, and no record says it was drawn'
  const reads = { 'second-step': { reads: ['gammaRecord'], why } }
  const drift = (over = {}, cells = rows) => failureDrift(cells, steps, records, { ...reads, ...over })

  assert.deepEqual(failureDisagreement(drift()), [],
    'the fixture agrees with itself, so each case below is about its own edit')

  // #931's empty table: the arm a new step lands on, and the one that names what a reader is told.
  const unrecorded = failureDrift(rows, steps, records, {})
  assert.deepEqual(unrecorded.unrecorded, ['second-step'])
  assert.match(failureDisagreement(unrecorded)[0],
    /^the runbook's failure cell for second-step is the page's prose, and FAILURE_READS/)

  // A row for a cell the guard already compares word for word is a decision nothing consults, and a
  // row for no step at all is one that outlived its step.
  assert.deepEqual(drift({ 'first-step': { reads: [], why } }).orphans, ['first-step'])
  assert.deepEqual(drift({ 'gone-step': { reads: [], why } }).orphans, ['gone-step'])
  assert.match(failureDisagreement(drift({ 'gone-step': { reads: [], why } }))[0],
    /^FAILURE_READS holds a row for gone-step/)

  // The name half, which is what #931 could derive: a name the module dropped, a declared name the
  // cell does not write, and a name the cell writes and the row does not declare.
  const unlisted = drift({ 'second-step': { reads: ['deltaRecord'], why } })
  assert.deepEqual(unlisted.unlisted, [{ id: 'second-step', name: 'deltaRecord' }])
  assert.deepEqual(unlisted.missing, [], 'a name RECORDS dropped is one finding, not two')
  assert.match(failureDisagreement(unlisted)[0], /reads `deltaRecord`, and RECORDS lists no such record/)

  const missing = drift({ 'second-step': { reads: ['gammaRecord', 'epsilonRecord'], why } })
  assert.deepEqual(missing.missing, [{ id: 'second-step', name: 'epsilonRecord' }])
  assert.match(failureDisagreement(missing)[0], /does not write `epsilonRecord`, which FAILURE_READS declares/)

  const undeclared = drift({}, rows.map(row => row.id === 'second-step'
    ? { ...row, because: 'no `betaRecord`, `gammaRecord` or `epsilonRecord`' }
    : row))
  assert.deepEqual(undeclared.undeclared, [{ id: 'second-step', name: 'epsilonRecord' }])
  assert.equal(undeclared.missing.length, 0, 'the cell writes both declared names, so only the extra one is a finding')
  assert.match(failureDisagreement(undeclared)[0], /names `epsilonRecord`, and FAILURE_READS declares no such record/)

  const thin = drift({ 'second-step': { reads: ['gammaRecord'], why: 'the screen' } })
  assert.deepEqual(thin.thinWhy, ['second-step'])
  assert.match(failureDisagreement(thin)[0], /a reason too short to say why the rest of its cell is the page's prose/)
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function space () {
  const dir = tempRoot('monoplayer-dev-proof-')
  return {
    dir,
    log: records => {
      const file = path.join(dir, 'dev-log.jsonl')
      fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
      return file
    },
    witness: path.join(dir, 'witness.json'),
    run: (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  }
}

// #923: the page an operator reads names the field the log is recorded in, the command that re-reads
// it, and what a pass without one is worth. Each of those is a fact this module now depends on, so
// the page losing one fails here instead of leaving a reader believing the copy was checked.
test('#923 the runbook names the log, its field, the command that re-reads it, and what a pass without one is', () => {
  const proof = section(fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8'), 'The two-client proof')

  assert.match(proof, /\`frames\.source\`/, 'the witness field that names the log is on the page')
  assert.match(proof, /dev-proof\.js --verify --path/, 'and the command that re-reads it')
  assert.match(proof, /the frames half was not re-read/, 'and what a verdict without a log is worth')
})

test('the command exits 0 on a complete run, 1 when a frame is missing, and 2 without a landing', () => {
  const { log, witness, run: cli } = space()

  const pass = cli('--path', log(run()), '--witness', witness)
  assert.equal(pass.status, 0, pass.stderr || pass.stdout)
  assert.match(pass.stdout, /the frames this run needed reached their sockets/)
  assert.equal(JSON.parse(fs.readFileSync(witness, 'utf8')).completed, false,
    'the run writes the witness it cannot answer')

  const missing = cli('--path', log(run().filter(record => record.frame !== 'spawn_entity')), '--witness', witness)
  assert.equal(missing.status, 1, 'a proof missing its frames is red, and the report says which')
  assert.match(missing.stdout, /body/)

  const never = cli('--path', log([{ t: at(0), event: 'spectateRefused', reason: 'body_not_served' }]), '--witness', witness)
  assert.equal(never.status, 2, 'a run that never reached its second client is not the same failure')
})

test('the command reads the same stream from stdin, which is how kubectl logs reaches it', () => {
  const { witness } = space()
  const piped = spawnSync(process.execPath, [CLI, '--witness', witness], {
    encoding: 'utf8',
    input: run().map(record => JSON.stringify(record)).join('\n') + '\n'
  })
  assert.equal(piped.status, 0, piped.stderr)
  assert.match(piped.stdout, /dev-lane proof/)
})

test('a saved log and a pipe read a line that is not a record the same way', () => {
  const { dir, witness, run: cli } = space()
  const file = path.join(dir, 'dev-log.jsonl')
  fs.writeFileSync(file, 'kubectl: some warning\n' + run().map(record => JSON.stringify(record)).join('\n') + '\n')

  const saved = cli('--path', file, '--witness', witness)
  assert.equal(saved.status, 0, 'a warning line is skipped, not a stack trace: ' + saved.stderr)
  assert.match(saved.stdout, /the frames this run needed reached their sockets/)
})

test('--verify refuses an unrecorded witness and accepts a recorded one', () => {
  const { witness, run: cli } = space()
  cli('--path', space().log(run()), '--witness', witness)

  const pending = cli('--verify', '--witness', witness)
  assert.equal(pending.status, 1)
  assert.match(pending.stderr, /^NOT COMPLETE: 6 step\(s\) are still pending/)

  const document = JSON.parse(fs.readFileSync(witness, 'utf8'))
  fs.writeFileSync(witness, JSON.stringify(witnessed({ ...verdict(readingOf(run())), ...document.frames, framesPassed: document.frames.passed }), null, 2))
  const recorded = cli('--verify', '--witness', witness)
  assert.equal(recorded.status, 0, recorded.stderr)
  assert.match(recorded.stdout, /#634 VERIFIED/)
})

// #923 at the command: the frames half is re-read from the run's log, so a witness whose copy says
// the run passed cannot outlive a log that says it did not.
test('#923 --verify re-reads the log it is given, and refuses a copy that disagrees by naming the row', () => {
  const { dir, witness, run: cli } = space()
  const passing = path.join(dir, 'dev-log.jsonl')
  const failing = path.join(dir, 'failed-log.jsonl')
  fs.writeFileSync(passing, lines(run()))
  fs.writeFileSync(failing, failedRun())

  cli('--path', passing, '--witness', witness)
  fs.writeFileSync(witness, JSON.stringify(recorded(JSON.parse(fs.readFileSync(witness, 'utf8'))), null, 2))

  const reread = cli('--verify', '--path', passing, '--witness', witness)
  assert.equal(reread.status, 0, reread.stderr)
  assert.match(reread.stdout, /the frames half was re-read from .*dev-log\.jsonl/, 'the pass names what it re-read')

  const disagreed = cli('--verify', '--path', failing, '--witness', witness)
  assert.equal(disagreed.status, 1, 'the log is the evidence, and the copy does not overrule it')
  assert.match(disagreed.stderr, /^NOT COMPLETE: the frames half in the witness and in .*failed-log\.jsonl disagree/)
  assert.match(disagreed.stderr, /row `body` holds true in the witness and false in the log/)
})

test('#923 --verify with no log says in words that the frames half was not re-read', () => {
  const { dir, witness, run: cli } = space()
  const file = path.join(dir, 'dev-log.jsonl')
  fs.writeFileSync(file, lines(run()))
  cli('--path', file, '--witness', witness)
  fs.writeFileSync(witness, JSON.stringify(recorded(JSON.parse(fs.readFileSync(witness, 'utf8'))), null, 2))
  fs.rmSync(file)
  assert.equal(fs.existsSync(file), false, 'the log was cleaned, which is the case this witness is for')

  const check = cli('--verify', '--witness', witness)
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /the frames half was not re-read: the witness names .*dev-log\.jsonl, and that file is not here/)
  assert.match(check.stdout, /not a check/, 'and the pass says the copy is the run\'s word')
})

test('#923 --verify re-reads the log the witness names while that file is still there', () => {
  const { witness, log, run: cli } = space()
  const file = log(run())
  cli('--path', file, '--witness', witness)
  fs.writeFileSync(witness, JSON.stringify(recorded(JSON.parse(fs.readFileSync(witness, 'utf8'))), null, 2))

  const check = cli('--verify', '--witness', witness)
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, new RegExp('the frames half was re-read from ' + escapeRe(file)))
})

test('#923 a --path the operator names and that is not there is refused, not passed as no log', () => {
  const { dir, witness, run: cli } = space()
  cli('--path', space().log(run()), '--witness', witness)
  fs.writeFileSync(witness, JSON.stringify(recorded(JSON.parse(fs.readFileSync(witness, 'utf8'))), null, 2))
  const gone = path.join(dir, 'gone.jsonl')

  const check = cli('--verify', '--path', gone, '--witness', witness)
  assert.equal(check.status, 1, 'the operator asked for that log, and it is not there')
  assert.match(check.stderr, /^NOT COMPLETE: the log --path names is not here: .*gone\.jsonl/,
    'a file that is gone is not a file that could not be read')
})

test('#923 the witness records the log its rows were read from, and a pipe leaves it null', () => {
  const { dir, witness, run: cli } = space()
  const file = path.join(dir, 'saved-log.jsonl')
  fs.writeFileSync(file, lines(run()))
  cli('--path', file, '--witness', witness)
  assert.equal(JSON.parse(fs.readFileSync(witness, 'utf8')).frames.source, file, 'the file it was given')

  const piped = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', input: lines(run()) })
  assert.equal(piped.status, 0, piped.stderr)
  assert.equal(JSON.parse(piped.stdout).witness.frames.source, null,
    'a reading from a pipe names no file, rather than implying one')
})

// #920's whole point, at the command: the document the runbook asks for exits 0, and the reader of
// the proof sees the gap and the ticket that closes it on the run's own output.
test('--verify accepts the one honest gap, and the pass names the ticket beside it', () => {
  const { witness, run: cli } = space()
  cli('--path', space().log(run()), '--witness', witness)
  const document = recorded(JSON.parse(fs.readFileSync(witness, 'utf8')))
  const file = steps => JSON.stringify({ ...document, steps }, null, 2)

  fs.writeFileSync(witness, file(withStep(document, 'spectator-own-body', {
    state: 'not-seen',
    evidence: 'a body was drawn in third person, and the client collided with blocks'
  })))
  const honest = cli('--verify', '--witness', witness)
  assert.equal(honest.status, 0, 'the document the runbook asks for is a proof: ' + honest.stderr)
  assert.match(honest.stdout, /#634 VERIFIED/)
  assert.match(honest.stdout, /^known gap: the spectator has no body of its own, and no hands in first person — not seen/m)
  assert.match(honest.stdout, /#647 and #645 close it$/m)

  fs.writeFileSync(witness, file(withStep(document, 'puppet-walks', {
    state: 'not-seen',
    evidence: 'it stood still while the driver walked'
  })))
  const other = cli('--verify', '--witness', witness)
  assert.equal(other.status, 1, 'the gap is that step, and only that step')
  assert.match(other.stderr, /^NOT COMPLETE: not seen: the puppet walks when the driving client walks/)
  assert.match(other.stderr, /#647 and #645/, 'and the refusal names the gap the run does expect')
})

test('--verify names the step a completed witness never recorded, not the count it kept', () => {
  const { witness, run: cli } = space()
  cli('--path', space().log(run()), '--witness', witness)
  const document = recorded(JSON.parse(fs.readFileSync(witness, 'utf8')))
  // The run's own document, finished, then edited the way #880 found it: one step recorded twice
  // and one never recorded, which leaves the count at six.
  fs.writeFileSync(witness, JSON.stringify({
    ...document,
    steps: [document.steps[0], document.steps[1], document.steps[1], ...document.steps.slice(3)]
  }, null, 2))

  const check = cli('--verify', '--witness', witness)
  assert.equal(check.status, 1, 'five steps recorded as six rows is not a completed proof')
  assert.match(check.stderr, /^NOT COMPLETE: unwitnessed: `spectator-mode`/)
})

test('an unknown argument and a missing value are usage errors, and help is not', () => {
  const { run: cli } = space()
  const bad = cli('--nope')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /usage: kubectl -n monoplayer-dev logs/)

  const bare = cli('--path')
  assert.equal(bare.status, 1)
  assert.match(bare.stderr, /--path needs a file/)

  const help = cli('--help')
  assert.equal(help.status, 0, 'help is not a failure')
  assert.match(help.stdout, /Exit 0 when every frame-level claim holds/)
})

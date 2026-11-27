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
import { tempRoot } from '../support/temp.js'
import { functionBody } from '../support/source-scan.js'

import {
  CLAIMS,
  OPERATOR_STEPS,
  RECORDS,
  WITNESS_LANE,
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
      modeFrames: 2,
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
  assert.equal(mode.evidence, 'spectateView.modeFrames = 1, of 2')
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

test('a step the operator did not see fails the proof, and the report names it', () => {
  const document = witnessed()
  document.steps = withStep(document, 'spectator-own-body', { state: 'not-seen', evidence: 'the body was drawn in third person' })

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'a not-seen step is a finding, not a pass')
  assert.match(check.reason, /^not seen: the spectator has no body of its own/)
  assert.match(check.reason, /the body was drawn in third person/)
})

// A row's own `claim` is the operator's label, and the file is hand-edited: a refusal quotes the
// module's words for the step an id names, so a claim left over from another row cannot be read
// back as evidence of what the operator saw.
test('a refusal quotes the module\'s words for the step, not the row\'s', () => {
  const document = witnessed()
  document.steps = withStep(document, 'spectator-own-body', {
    state: 'not-seen',
    claim: 'the puppet waves at the spectator',
    evidence: 'the body was drawn in third person'
  })

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /^not seen: the spectator has no body of its own/)
  assert.match(check.reason, /\(the body was drawn in third person\)$/)
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
  assert.deepEqual(check, { ok: true, reason: null })

  assert.equal(verifyWitness(null).ok, false, 'no document is no proof')
  assert.match(verifyWitness({ ...witnessed(), lane: 'unmodded' }).reason, /names lane "unmodded"/)
  assert.match(verifyWitness({ ...witnessed(), steps: [] }).reason,
    /^unwitnessed: `puppet-renders`, `puppet-walks`/, 'an empty document names the steps it is missing')
  assert.match(verifyWitness({ ...witnessed(), completed: false }).reason, /not marked completed/)
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
// One repair per kind, because they are four different edits in two files: a record with no row, a
// row with no record, a sentence reworded on one side, and a row moved out of the list's order. The
// order is the list's, not the run's: `pickerEmpty` is documented last and written at the picker. The
// reworded one quotes both cells, because a cell is 300 characters and its name is not the edit.
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
// Read as rows, inside its own section, keyed by the id each row carries — never as the page,
// because the runbook names these steps in the prose around the table too. A row says where to
// look, what to see there, and the record that says otherwise when it is missing, so the guard
// asks for all three; and where a step names a `record`, the last cell has to name it. Two tables
// on one page are read by one extraction — `section` and `cells` above — so a row means one thing
// in the record table and in this one.
const STEP_SECTION = 'What you should see'

test('the runbook\'s step table is OPERATOR_STEPS, a name and a record for every step, both ways', () => {
  const rows = stepRows(fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8'))

  // Both sides have to be read, or a table rewritten as prose would leave the comparison holding
  // two empty lists and passing.
  assert.ok(rows.length > 0, 'the "' + STEP_SECTION + '" section carries the table an operator reads')
  assert.ok(OPERATOR_STEPS.length > 0, 'the module names the steps only a person can answer')

  assert.deepEqual(stepDisagreement(stepDrift(rows)), [],
    'the runbook\'s step table and OPERATOR_STEPS disagree')
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
  const missingRow = steps.map(step => step.id).filter(id => !rowOf.has(id))
  const missingStep = rows.map(row => row.id).filter(id => !stepOf.has(id))
  const thin = rows
    .filter(row => [row.look, row.see, row.because].some(cell => cell === ''))
    .map(row => row.id)
  const unnamedRecord = steps
    .filter(step => step.record !== null && rowOf.has(step.id) && !namesRecord(rowOf.get(step.id), step.record))
    .map(step => ({ id: step.id, record: step.record }))
  const unlistedRecord = steps
    .filter(step => step.record !== null && !records.some(record => record.name === step.record))
    .map(step => ({ id: step.id, record: step.record }))
  const repeated = [...new Set([...duplicated(rows.map(row => row.id)), ...duplicated(steps.map(step => step.id))])]
  const sameNames = missingRow.length === 0 && missingStep.length === 0 && rows.length === steps.length
  const moved = sameNames ? rows.map(row => row.id).filter((id, at) => id !== steps[at].id) : []
  return { missingRow, missingStep, thin, unnamedRecord, unlistedRecord, repeated, moved }
}

// A row names its record in backticks in the last cell, alone or at the head of a field path: the
// page writes `spectateView.modeFrames`, which is the record's name with the number to read inside
// it. The last cell only, because that is the cell the page says names the record, and a name in
// "You should see" is a row whose diagnostic column disagrees with its instruction.
function namesRecord (row, record) {
  return new RegExp('`' + record + '(?:\\.[A-Za-z0-9_]+)*`').test(row.because)
}

// The edit each disagreement asks for, one sentence each, naming the row and the side it is on. A
// message that said only "the table and the steps disagree" would leave the reader to work out
// which of the seven edits is theirs, and which row.
function stepDisagreement ({ missingRow, missingStep, thin, unnamedRecord, unlistedRecord, repeated, moved }) {
  return [
    ...missingRow.map(id => 'deploy/dev/README.md\'s "' + STEP_SECTION + '" table has no row for step ' + id +
      ', which OPERATOR_STEPS carries: add a row with `' + id + '` in the Step cell, or remove the step'),
    ...missingStep.map(id => 'OPERATOR_STEPS defines no step named ' + id +
      ', which the runbook\'s table documents: add the step and its id to the list, or remove the row'),
    ...thin.map(id => 'the runbook\'s row for ' + id + ' leaves a cell empty: a row says where to look, ' +
      'what you should see there, and the record that says otherwise'),
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
test('the step comparison reports a row on one side only, a thin row, and a row naming no record', () => {
  const steps = [
    { id: 'first-step', claim: 'one', record: 'alphaRecord' },
    { id: 'second-step', claim: 'two', record: null }
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

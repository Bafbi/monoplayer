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
  assert.deepEqual(document.steps.map(step => step.claim), [...OPERATOR_STEPS])
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
  document.steps[2] = { ...document.steps[2], evidence: '[MANUAL: what you saw]' }

  const check = verifyWitness(document)
  assert.equal(check.ok, false)
  assert.match(check.reason, /carries no evidence: the spectator flies/)
})

test('a step the operator did not see fails the proof, and the report names it', () => {
  const document = witnessed()
  document.steps[3] = { ...document.steps[3], state: 'not-seen', evidence: 'the body was drawn in third person' }

  const check = verifyWitness(document)
  assert.equal(check.ok, false, 'a not-seen step is a finding, not a pass')
  assert.match(check.reason, /^not seen: the spectator has no body of its own/)
  assert.match(check.reason, /the body was drawn in third person/)
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
  assert.match(verifyWitness({ ...witnessed(), steps: [] }).reason, /carries 0 steps/)
  assert.match(verifyWitness({ ...witnessed(), completed: false }).reason, /not marked completed/)
})

function witnessed (report = verdict(readingOf(run()))) {
  const document = witnessDocument(report)
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

test('every record the reader relies on is one the runbook names and a leg writes', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8')
  // The three files a run's records are written from, and no fourth list. A hand map of which
  // file writes which name is a third copy of that fact, and a name added to RECORDS without a
  // row in it failed once with "a leg writes pickerPick" about a line live-front.js holds. A
  // name is written by one of these or it is not written.
  const writers = Object.fromEntries(
    ['src/service/monoplayer.js', 'src/legs/live-front.js', 'src/service/start-live.js']
      .map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')])
  )

  assert.equal(new Set(RECORDS.map(record => record.name)).size, RECORDS.length, 'no record is listed twice')
  for (const { name } of RECORDS) {
    assert.match(readme, new RegExp('`' + name + '`'), 'the runbook names the ' + name + ' record')
    const wrote = Object.entries(writers)
      .filter(([, text]) => text.includes("log('" + name + "'"))
      .map(([file]) => file)
    assert.ok(wrote.length > 0,
      'a leg writes ' + name + ': no log(\'' + name + '\') in ' + Object.keys(writers).join(', '))
  }
})

// The table and the list in one order, both ways. The case above walks RECORDS and asks the
// runbook for a row, so a row with no entry behind it passed; and neither direction asks
// whether a record a leg writes is in the list at all, which is how #829's line went missing
// from both. One comparison, name for name, because the count of two lists that disagree says
// nothing about which row moved. The order is the list's, not the run's: `pickerEmpty` is
// documented last and written at the picker.
test('the runbook\'s record table is the list, name for name and row for row', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8')
  assert.deepEqual(tableRecords(readme), RECORDS.map(record => record.name),
    'the runbook\'s table is RECORDS in the list\'s own order')
})

// One table's record names: the rows under its own header, so no other table in the runbook can
// answer for this one.
function tableRecords (readme) {
  const lines = readme.split('\n')
  const header = lines.findIndex(line => line.startsWith('| Record | What it says |'))
  assert.notEqual(header, -1, 'the runbook carries the record table')
  const names = []
  for (let index = header + 2; index < lines.length && lines[index].startsWith('|'); index += 1) {
    const name = lines[index].match(/^\| `([A-Za-z0-9_]+)` \|/)
    assert.ok(name !== null, 'every row of the record table opens with one record name: ' + lines[index])
    names.push(name[1])
  }
  return names
}

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

// src/driver/dev-proof.js reads one dev-lane run's record stream and answers the claims of
// #634 that a log can answer (#634). The fixtures below are the shapes the service writes:
// `src/service/monoplayer.js` for the spectate and virtual-player lines, and
// `src/service/start-live.js` for the heartbeat, whose `t` is an ISO 8601 string.
//
// The last row of every reading is the operator's, and every case here reads that row back:
// a report that filled it in would be the mistake #634 was filed about.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

import {
  CLAIMS,
  REFUSAL_EVENTS,
  WITNESS_CLAIM,
  bodyOf,
  channelsOf,
  claimsOf,
  formatVerdict,
  heartbeatAfter,
  momentOf,
  ofEvent,
  parseRecords,
  readingOf,
  verdict
} from '../../src/driver/dev-proof.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'driver', 'dev-proof.js')

const BODY = 'paper.monoplayer-dev.svc.cluster.local_25565'
const DRIVER = 'channel-driver'
const WATCHER = 'channel-watcher'
const AT = Date.parse('2026-11-26T20:00:00.000Z')

const at = seconds => new Date(AT + seconds * 1000).toISOString()

// One record stream as the lane writes it: a claim, a spectator landing, the frames each
// socket was written, and the heartbeat that follows.
function run (overrides = {}) {
  const records = [
    { t: at(0), event: 'pickerServed', username: 'Attach', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', frames: 28, servers: 1 },
    { t: at(1), event: 'claimDial', body: BODY, server: 'paper', host: 'paper.monoplayer-dev.svc.cluster.local', port: 25565, name: 'Attach' },
    { t: at(2), event: 'attach', name: 'Attach', reason: 'claim', replayed: 30 },
    { t: at(3), event: 'pickerServed', username: 'Watcher', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', frames: 28, servers: 1 },
    { t: at(4), event: 'spectateAsked', body: BODY, server: 'paper', name: 'Watcher', state: 'attached', attached: true },
    {
      t: at(5),
      event: 'spectateView',
      name: 'Watcher',
      channel: WATCHER,
      frames: 30,
      replayed: 30,
      virtualFrames: 2,
      modeFrames: 2,
      packsOffered: 0,
      body: BODY,
      state: 'attached',
      attached: true
    },
    { t: at(5), event: 'puppetSkinSent', name: 'devpuppet', reason: 'spectate', signed: true, puppet: true },
    { t: at(5), event: 'virtualPlayerWritten', reason: 'spectate', channel: WATCHER, frame: 'player_info' },
    { t: at(5), event: 'virtualPlayerWritten', reason: 'spectate', channel: WATCHER, frame: 'spawn_entity' },
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
        { channel: WATCHER, body: BODY, role: 'spectator', frames: 30, play: 12, replays: 1, spectators: 1 }
      ]
    }
  ]
  return overrides.records ?? records
}

const row = (reading, id) => claimsOf(reading).find(entry => entry.id === id)

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

test('a two-client run answers every frame-level claim, and the witness row stays open', () => {
  const reading = readingOf(run())
  const rows = claimsOf(reading)

  assert.equal(reading.body, BODY, 'the body is the one the spectator landed on')
  assert.equal(reading.spectate.channel, WATCHER, 'the landing is the last spectateView')
  assert.deepEqual(reading.channels, { driver: [DRIVER], spectators: [WATCHER] }, 'the heartbeat names both sockets')

  for (const claim of CLAIMS) {
    const entry = rows.find(row => row.id === claim.id)
    assert.ok(entry, 'the reading answers ' + claim.id)
    assert.equal(entry.by, 'log', claim.id + ' is a frame-level claim')
    assert.equal(entry.holds, true, claim.id + ' holds: ' + entry.evidence + ' / ' + entry.because)
  }

  const witness = rows.at(-1)
  assert.equal(witness.id, null, 'the operator row is last and has no id to fail on')
  assert.equal(witness.by, 'operator')
  assert.equal(witness.holds, null, 'no count makes the witness row true')
  assert.equal(witness.claim, WITNESS_CLAIM)

  const report = verdict(reading, rows)
  assert.equal(report.passed, true, 'every answerable row holds')
  assert.equal(report.witness.proven, false, 'the artifact never claims the visual half')
  assert.deepEqual(report.failed, [])
  assert.equal(report.driverChannel, DRIVER)
  assert.equal(report.spectatorChannel, WATCHER)
})

test('a spectator\'s spawn on that socket is the body, and its absence names the empty world', () => {
  const records = run().filter(record => record.frame !== 'spawn_entity' || record.channel !== WATCHER)
  const reading = readingOf(records)

  const body = row(reading, 'body')
  assert.equal(body.holds, false, 'no spawn on the spectator channel')
  assert.match(body.evidence, /no spawn_entity written on channel-watcher/)
  assert.match(body.because, /a client holding an entry for a player it has no body for/,
    'the reading says what the operator saw: an empty world with the right frames in it')
  assert.equal(row(reading, 'entry').holds, true, 'the entry was still written, which is why the count cannot see it')
  assert.equal(verdict(reading).passed, false)
  assert.deepEqual(verdict(reading).failed, ['body'])
})

test('a write the leg threw on is quoted with the frame, the channel and the error', () => {
  // The write that would have carried it was refused, so the stream holds the refusal and no
  // written frame: the refusal names the frame it was for.
  const records = run()
    .filter(record => !(record.event === 'virtualPlayerWritten' && record.frame === 'spawn_entity'))
    .concat([
      { t: at(7), event: 'virtualPlayerRefused', reason: 'spectate', channel: WATCHER, frame: 'spawn_entity', error: 'socket closed' }
    ])
  const reading = readingOf(records)

  const body = row(reading, 'body')
  assert.equal(body.holds, false)
  assert.match(body.because, /spawn_entity on channel-watcher: socket closed/,
    'the refusal is quoted rather than summarised')
})

test('a rival\'s count is not the operator\'s: a move for nobody still fails the row', () => {
  const records = run()
  records[records.length - 1] = {
    ...records[records.length - 1],
    metrics: { ...records[records.length - 1].metrics, virtualPlayersMoved: 0 }
  }
  const reading = readingOf(records)

  const move = row(reading, 'move')
  assert.equal(move.holds, false, 'no move frame reached any spectator socket')
  assert.match(move.because, /a move is written only to a channel that is not the puppet's own/)
})

test('the driver sees the watcher, or the row says the driver sees nobody', () => {
  const records = run().filter(record => record.channel !== DRIVER)
  const reading = readingOf(records)

  const watcher = row(reading, 'watcher')
  assert.equal(watcher.holds, false)
  assert.match(watcher.evidence, /nothing written to the driver channel channel-driver/)
  assert.match(watcher.because, /the driver sees an empty world beside itself/)
})

test('one of the two mode frames is a half a spectator, and the row says which half is missing', () => {
  const records = run()
  records[5] = { ...records[5], modeFrames: 1 }
  const reading = readingOf(records)

  const mode = row(reading, 'mode')
  assert.equal(mode.holds, false)
  assert.equal(mode.evidence, 'spectateView.modeFrames = 1')
  assert.match(mode.because, /flight and invulnerability come from the first of them/)
})

test('no landing is a run that never reached its second client, and the refusal is quoted', () => {
  const records = [
    { t: at(0), event: 'pickerServed', username: 'Watcher', uuid: '512f9708-59a5-3d00-99bf-c3c0b5271822', frames: 28, servers: 1 },
    { t: at(1), event: 'spectateRefused', body: BODY, server: 'paper', name: 'Watcher', reason: 'body_not_served', state: 'detached' }
  ]
  const reading = readingOf(records)
  const rows = claimsOf(reading)

  assert.equal(reading.body, null, 'no landing and no claim names a body')
  assert.equal(row(reading, 'landed').holds, false)
  assert.match(row(reading, 'landed').because, /spectateRefused: body_not_served/,
    'the core\'s own reason is quoted, not paraphrased')
  assert.equal(rows.filter(entry => entry.holds === true).length, 0, 'nothing holds without a landing')
  assert.equal(verdict(reading).passed, false)
})

test('a stream with no picker join at all says the log is not the run', () => {
  const reading = readingOf([{ t: at(0), event: 'startLive', account: 'devpuppet' }])
  assert.match(row(reading, 'landed').because, /no client reached the picker in this log/)
  assert.match(row(reading, 'landed').because, /this is not the run/)
})

test('the reading accepts the journal\'s numeric moment as well as the log\'s ISO string', () => {
  assert.equal(momentOf({ t: AT }), AT)
  assert.equal(momentOf({ t: new Date(AT).toISOString() }), AT)
  assert.equal(momentOf({}), null, 'no moment is not a moment of zero')

  const numeric = run().map(record => ({ ...record, t: Date.parse(record.t) }))
  assert.equal(verdict(readingOf(numeric)).passed, true, 'both shapes read the same run')
})

test('the heartbeat a row reads is the one after the landing, never one before it', () => {
  const early = { t: at(-60), event: 'heartbeat', metrics: { virtualPlayersMoved: 0 }, channels: [] }
  const records = [early, ...run()]
  const reading = readingOf(records)
  const later = reading.heartbeat
  assert.equal(later.t, at(30), 'the heartbeat after the landing covers it')
  assert.equal(heartbeatAfter(ofEvent(run(), 'heartbeat'), AT + 5000).t, at(30))
})

test('a body is the one a spectator landed on, else the one a claim dialled', () => {
  assert.equal(bodyOf({ spectateViews: [{ body: 'b' }], claims: [{ body: 'a' }] }), 'b')
  assert.equal(bodyOf({ spectateViews: [], claims: [{ body: 'a' }] }), 'a')
  assert.equal(bodyOf({}), null, 'a lane that served nothing names no body')
})

test('a channel roster reads only the rows on the body it was asked about', () => {
  const heartbeat = {
    channels: [
      { channel: 'a', body: 'one', role: 'driver' },
      { channel: 'b', body: 'one', role: 'spectator' },
      { channel: 'c', body: 'two', role: 'driver' }
    ]
  }
  assert.deepEqual(channelsOf(heartbeat, 'one'), { driver: ['a'], spectators: ['b'] })
  assert.deepEqual(channelsOf(heartbeat).driver, ['a', 'c'], 'no body reads every row')
  assert.deepEqual(channelsOf(null), { driver: [], spectators: [] }, 'no heartbeat is no channel')
})

// ---------------------------------------------------------------------------
// The stream and the report
// ---------------------------------------------------------------------------

test('a line that is not a record is skipped, not a finding', () => {
  const text = [
    'Some kubectl warning nobody wants to read',
    JSON.stringify({ event: 'spectateView', channel: WATCHER, body: BODY }),
    '{"event":"truncated"',
    '',
    JSON.stringify({ event: 'heartbeat', metrics: {} })
  ].join('\n')
  const records = parseRecords(text)
  assert.equal(records.length, 2, 'two records, and neither the warning nor the half a crash cut')
})

test('the report prints the witness line last, always, and never says the proof is done', () => {
  const printed = formatVerdict(verdict(readingOf(run())))
  const lines = printed.split('\n')
  const witness = lines.findIndex(line => line.includes('WITNESS'))
  assert.notEqual(witness, -1, 'the unproven half is in the report')
  assert.match(lines[witness], /a client drew the puppet/)
  assert.match(printed, /What a client drew with them is the WITNESS line, and nobody has looked yet/)
  assert.doesNotMatch(printed, /\bproven\b|\bPROVEN\b/, 'a frame count never reads as a proof')

  const failed = formatVerdict(verdict(readingOf(run().filter(record => record.frame !== 'spawn_entity'))))
  assert.match(failed, /the run did not reach every socket it needed: body/)

  // A lane nobody joined has no heartbeat that covers a landing, and the report says which
  // heartbeat it read rather than implying it followed one.
  const untouched = formatVerdict(verdict(readingOf([{ t: at(0), event: 'heartbeat', metrics: {}, channels: [] }])))
  assert.match(untouched, /counters from the last heartbeat at/)
})

test('every refusal the reader relies on is one the service writes', () => {
  const service = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'service', 'monoplayer.js'), 'utf8')
  const front = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'legs', 'live-front.js'), 'utf8')
  // The picker's own refusals live in the front leg and the rest in the core, so the guard
  // reads both files rather than assuming one owner.
  const owners = { pickerEmpty: front, pickerServed: front }
  for (const event of REFUSAL_EVENTS) {
    const file = owners[event] ?? service
    assert.match(file, new RegExp("log\\('" + event + "'"),
      (file === service ? 'src/service/monoplayer.js' : 'src/legs/live-front.js') + ' writes ' + event)
  }
  assert.match(front, /log\('pickerServed'/, 'the join the reader counts is the front\'s own line')
  assert.match(service, /log\('spectateView'/, 'the landing is the core\'s own line')
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function writeLog (records) {
  const file = path.join(tempRoot('monoplayer-dev-proof-'), 'dev-log.jsonl')
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  return file
}

test('the command exits 0 on a run that reached every socket, 1 when a frame is missing, and 2 without a landing', () => {
  const pass = spawnSync(process.execPath, [CLI, '--path', writeLog(run())], { encoding: 'utf8' })
  assert.equal(pass.status, 0, pass.stderr || pass.stdout)
  assert.match(pass.stdout, /nobody has looked yet/)

  const missing = spawnSync(process.execPath, [CLI, '--path', writeLog(run().filter(record => record.frame !== 'spawn_entity'))], { encoding: 'utf8' })
  assert.equal(missing.status, 1, 'a proof missing its frames is red, and the report says which')
  assert.match(missing.stdout, /body/)

  const refused = writeLog([{ t: at(0), event: 'spectateRefused', reason: 'body_not_served' }])
  const never = spawnSync(process.execPath, [CLI, '--path', refused], { encoding: 'utf8' })
  assert.equal(never.status, 2, 'a run that never reached its second client is not the same failure')

  const json = spawnSync(process.execPath, [CLI, '--path', writeLog(run()), '--json'], { encoding: 'utf8' })
  assert.equal(json.status, 0)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.issue, 634)
  assert.equal(parsed.witness.proven, false)
})

test('the command reads the same stream from stdin, which is how kubectl logs reaches it', () => {
  const piped = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    input: run().map(record => JSON.stringify(record)).join('\n') + '\n'
  })
  assert.equal(piped.status, 0, piped.stderr)
  assert.match(piped.stdout, /dev-lane proof/)
})

test('an unknown argument exits 2 with the usage on stderr', () => {
  const bad = spawnSync(process.execPath, [CLI, '--nope'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /usage: kubectl -n monoplayer-dev logs/)

  const bare = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(bare.status, 0, 'help is not a failure')
  assert.match(bare.stdout, /Exit 0 when every frame-level claim holds/)
})

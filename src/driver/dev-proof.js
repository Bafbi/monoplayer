#!/usr/bin/env node
// #634: what the dev lane's own log says about a two-client run, and what it cannot say.
//
// The owner's condition for epic #632 was that a thread making this work must be able to
// validate it on the right harness — and protocol bots passed a bug a real client died on
// (#598: 29 registry frames, a duplicate key, a disconnect). So the last word on "a client
// sees the body" belongs to a person looking at two clients. This file is the other half:
// the reader that turns a run's records into the frame-level verdicts a machine can hold,
// and says out loud which claim it does not answer.
//
// What it reads: the JSONL record stream the dev proxy already writes to its stdout, one
// `kubectl logs` away (`deploy/dev/README.md`, "The two-client proof"). The records it
// needs exist because the epic's write paths log them:
//
//   spectateView            one per landed spectator, with `channel`, `frames`,
//                           `virtualFrames` (what that socket was told about the puppet's
//                           body) and `modeFrames` (the spectator game mode pair)
//   spectateRefused         the picker's Spectate click, refused, with `reason`
//   spectateViewRefused     the landing itself refused, with `reason`
//   puppetSkinSent          #614's `player_info` naming the puppet, written per pass
//   virtualPlayerWritten    one per entry, spawn and despawn, naming the channel it went
//                           to (`src/service/monoplayer.js`, `writeVirtualPlayers`)
//   virtualPlayerRefused    a write the leg threw on, with the frame and the channel
//   virtualPlayerAnnounceRefused  a player the proxy could not name, and why
//   heartbeat               the counters, every 30 s: `metrics.virtualPlayers*`,
//                           `metrics.skinFramesWritten`, and one `channels` row per socket
//
// What it does not read: pixels. A count says a frame reached a socket and nothing about
// what a client drew with it. Every row below is answered "the log" or "the operator", and
// the last row is always the operator's. #634 exists because a count was mistaken for a
// proof; this file is written so it cannot be again.
//
// Why a report and not an assertion in the rung: the rung's socket is a bot's, and the
// ticket's whole point is the socket a person holds. O69, O70 and O71 already assert these
// frames on the loopback rig. This reads the same facts from a lane two real clients joined.
import { readNdjson } from '../observability/journal.js'
import { pathToFileURL } from 'node:url'

const USAGE = `usage: kubectl -n monoplayer-dev logs deploy/monoplayer | node src/driver/dev-proof.js
       node src/driver/dev-proof.js --path .reports/dev-log.jsonl [--json]

Reads one run's JSONL records and answers each claim of #634 with the frame-level
evidence the log holds, or with "the operator" when only eyes can.

  --path FILE   read a saved record stream instead of stdin
  --json        print the same reading as one JSON document
  --help        this text

Exit 0 when every frame-level claim holds, 1 when one does not, and 2 when no
spectator landed at all: that is a run that never reached its second client.
`

// The rows, in the order a run makes them true. `id` is what a failure is called, and the
// text is what the operator reads. The last row has no id: nothing answers it here.
export const CLAIMS = Object.freeze([
  { id: 'landed', text: 'a second client landed on the body as a spectator' },
  { id: 'entry', text: 'the puppet was announced on that socket: a player_info entry for it' },
  { id: 'body', text: 'the puppet had a body there: a spawn_entity for its UUID' },
  { id: 'move', text: 'the puppet moved on a spectator socket after the landing' },
  { id: 'watcher', text: 'the watcher was announced and spawned on the driver\'s own socket' },
  { id: 'mode', text: 'the spectator was told it is a spectator: game_state_change, then abilities' }
])

// Only eyes can answer this one, and it is the claim the ticket was filed for. It is
// printed last, always, so a report that is all "yes" cannot read as a finished proof.
export const WITNESS_CLAIM = 'a client drew the puppet where it stood, with the puppet\'s skin, and the ' +
  'spectator flies with no body of its own'

export function parseRecords (text) {
  const records = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      // A line that is not a record is not a finding: kubectl interleaves its own output
      // on a bad day, and the log may hold a record a crash cut in half.
      continue
    }
    if (record !== null && typeof record === 'object') records.push(record)
  }
  return records
}

const eventOf = record => (typeof record.event === 'string' ? record.event : null)

// The records that stop a two-client run, and the one that says a client reached the
// picker. Named here so a refusal added to the service is one row to add, not a filter to
// find.
export const REFUSAL_EVENTS = Object.freeze([
  'spectateRefused',
  'spectateViewRefused',
  'spectateModeRefused',
  'virtualPlayerRefused',
  'virtualPlayerAnnounceRefused',
  'attachDenied',
  'pickerEmpty'
])

// The records of one event name, in the order they were written.
export function ofEvent (records, event) {
  return records.filter(record => eventOf(record) === event)
}

// A record's moment in epoch milliseconds. The service writes `t` as an ISO 8601 string
// (src/service/start-live.js, `createJsonlLog`) and the packet journal writes a number, and
// a saved stream may hold either.
export function momentOf (record) {
  const t = record?.t
  if (Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const parsed = Date.parse(t)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

const after = (record, moment) => {
  const at = momentOf(record)
  return at !== null && Number.isFinite(moment) && at >= moment
}

// The run's own body: the one a spectator landed on, or, when nobody landed, the one a
// claim dialled. A lane serves one body at a time, so one body is the run's.
export function bodyOf ({ spectateViews = [], claims = [] } = {}) {
  const landed = spectateViews.at(-1)?.body
  if (typeof landed === 'string' && landed !== '') return landed
  const dialled = claims.at(-1)?.body
  return typeof dialled === 'string' && dialled !== '' ? dialled : null
}

// The channels the last heartbeat saw on the body: the driver's own, and the watchers'.
// A channel is the front leg's record, and the heartbeat is the one artifact that names
// them (`src/service/monoplayer.js`, `sampleHeartbeatGroups`).
export function channelsOf (heartbeat, body = null) {
  const rows = Array.isArray(heartbeat?.channels) ? heartbeat.channels : []
  const onBody = rows.filter(row => body === null || row?.body === body)
  return {
    driver: onBody.filter(row => row?.role === 'driver').map(row => row.channel),
    spectators: onBody.filter(row => row?.role === 'spectator').map(row => row.channel)
  }
}

// The heartbeat that covers the landing: the first one written after it, because the
// counters are cumulative and a record from before the landing says nothing about it. The
// last one is the fallback for a run that ended inside one heartbeat window.
export function heartbeatAfter (heartbeats, moment) {
  return heartbeats.find(record => after(record, moment)) ?? heartbeats.at(-1) ?? null
}

// Everything the rows are read from, taken once so two rows cannot disagree about which
// landing they are about.
export function readingOf (records) {
  const spectateViews = ofEvent(records, 'spectateView')
  const claims = ofEvent(records, 'claimDial')
  const body = bodyOf({ spectateViews, claims })
  const spectate = spectateViews.at(-1) ?? null
  const landedAt = momentOf(spectate)
  const heartbeat = heartbeatAfter(ofEvent(records, 'heartbeat'), landedAt)
  return {
    body,
    spectate,
    landedAt,
    heartbeat,
    channels: channelsOf(heartbeat, body),
    writes: ofEvent(records, 'virtualPlayerWritten'),
    // Every line that ends a two-client run before its first landing, so a report can name
    // which one fired instead of saying "nothing happened".
    refusals: records.filter(record => REFUSAL_EVENTS.includes(eventOf(record))),
    // A join that reached the picker at all. It is the difference between "this log is the
    // wrong run" and "the second client never clicked Spectate".
    joins: ofEvent(records, 'pickerServed')
  }
}

// The frames one channel was written, as the log names them.
function writtenTo (writes, channel) {
  return writes.filter(record => record.channel === channel)
}

const names = records => records.map(record => record.frame).filter(name => typeof name === 'string')

// One row per claim, answered from the reading. `by` is `log` when the records decide it and
// `operator` when only a person can. `holds` is null for the operator's row: no count can
// make it true, and a report that filled it in would be the mistake #634 was filed about.
export function claimsOf (reading) {
  const spectate = reading.spectate
  const spectatorChannel = typeof spectate?.channel === 'string' ? spectate.channel : null
  const perChannel = spectatorChannel === null ? [] : writtenTo(reading.writes, spectatorChannel)
  const frames = names(perChannel)
  const metrics = reading.heartbeat?.metrics ?? {}
  const onDriver = reading.channels.driver.flatMap(channel => writtenTo(reading.writes, channel))
  const driverFrames = names(onDriver)

  const row = (id, holds, evidence, because) => {
    const claim = CLAIMS.find(entry => entry.id === id)
    return { id, claim: claim.text, by: 'log', holds, evidence, because }
  }

  const rows = [
    row('landed', spectate !== null,
      spectate === null
        ? 'no spectateView record'
        : 'spectateView on channel ' + spectatorChannel + ', ' + spectate.frames + ' frames replayed',
      spectate === null ? refusalBecause(reading) : null),
    row('entry', spectate !== null && frames.includes('player_info'),
      spectate === null
        ? 'no landing to announce to'
        : (frames.includes('player_info')
            ? 'virtualPlayerWritten: player_info on ' + spectatorChannel
            : 'no player_info written on ' + spectatorChannel),
      spectate === null ? null : entryBecause(reading, frames)),
    row('body', spectate !== null && frames.includes('spawn_entity'),
      spectate === null
        ? 'no landing to spawn to'
        : (frames.includes('spawn_entity')
            ? 'virtualPlayerWritten: spawn_entity on ' + spectatorChannel
            : 'no spawn_entity written on ' + spectatorChannel),
      spectate === null ? null : bodyBecause(reading, frames)),
    row('move', Number.isFinite(metrics.virtualPlayersMoved) && metrics.virtualPlayersMoved > 0,
      'metrics.virtualPlayersMoved = ' + (metrics.virtualPlayersMoved ?? 'not in this log'),
      Number.isFinite(metrics.virtualPlayersMoved) && metrics.virtualPlayersMoved > 0
        ? null
        : 'a move is written only to a channel that is not the puppet\'s own, so a zero here ' +
          'means no spectator socket was ever told where the puppet went'),
    row('watcher', reading.channels.driver.length > 0 &&
      driverFrames.includes('spawn_entity') && driverFrames.includes('player_info'),
      reading.channels.driver.length === 0
        ? 'no driver channel in the heartbeat'
        : (driverFrames.length === 0
            ? 'nothing written to the driver channel ' + reading.channels.driver.join(', ')
            : 'virtualPlayerWritten on the driver channel: ' + [...new Set(driverFrames)].join(', ')),
      driverFrames.length === 0 || reading.channels.driver.length === 0
        ? 'the driver\'s client is told about the watchers by the same two frames a spectator is told ' +
          'about the puppet (#636); nothing here means the driver sees an empty world beside itself'
        : null),
    row('mode', spectate !== null && spectate.modeFrames === 2,
      spectate === null
        ? 'no landing to put in spectator mode'
        : 'spectateView.modeFrames = ' + (spectate.modeFrames ?? 'not in this log'),
      spectate !== null && spectate.modeFrames === 2
        ? null
        : 'a spectator\'s mode is two frames on its own socket (#633); flight and invulnerability ' +
          'come from the first of them')
  ]
  rows.push({ id: null, claim: WITNESS_CLAIM, by: 'operator', holds: null, evidence: 'nobody\'s log', because: null })
  return rows
}

// Why there is no landing, in the records' own words. A reason field is the core's
// (`src/core/picker.js`), so it is quoted rather than paraphrased.
function refusalBecause (reading) {
  const refusals = reading.refusals.filter(record =>
    ['spectateRefused', 'spectateViewRefused', 'attachDenied', 'pickerEmpty'].includes(eventOf(record)))
  if (refusals.length === 0) {
    return reading.joins.length === 0
      ? 'no client reached the picker in this log: a join writes pickerServed, so this is not the ' +
        'run, or the front refused the login before the picker'
      : reading.joins.length + ' client(s) reached the picker and none clicked Spectate: the ' +
        'second client either never picked the claimed row or never got the dialog'
  }
  return refusals.map(record =>
    eventOf(record) + ': ' + (record.reason ?? 'no reason recorded') +
    (typeof record.text === 'string' ? ' — ' + record.text : '')).join('; ')
}

function entryBecause (reading, frames) {
  if (frames.includes('player_info')) return null
  if (reading.writes.length === 0) {
    return 'no virtual player was written at all: the roster was empty, so no channel was owed a ' +
      'player. A spectator whose channel the front never named is the usual cause'
  }
  const announced = ofEvent(reading.refusals, 'virtualPlayerAnnounceRefused')
  if (announced.length > 0) {
    return 'the announcement was refused: ' + announced.map(record =>
      (record.reason ?? 'no reason') + (record.name ? ' for ' + record.name : '')).join('; ')
  }
  return 'the entry a client needs before it places a body is written by #614\'s skin path for the ' +
    'puppet and by this row\'s own writer for a spectator; neither wrote on this socket'
}

function bodyBecause (reading, frames) {
  if (frames.includes('spawn_entity')) return null
  const refused = ofEvent(reading.refusals, 'virtualPlayerRefused')
  if (refused.length > 0) {
    return 'the leg threw on the write: ' + refused.map(record =>
      record.frame + ' on ' + record.channel + ': ' + (record.error ?? 'no error recorded')).join('; ')
  }
  return 'a spawn is written once per channel and then followed by moves; a socket with none is a ' +
    'client holding an entry for a player it has no body for, which is the empty world of #632'
}

// The reading as one document, for a file beside a report.
export function verdict (reading, rows = claimsOf(reading)) {
  const answerable = rows.filter(row => row.by === 'log')
  const failed = answerable.filter(row => row.holds !== true)
  return {
    rung: 'dev-two-client',
    issue: 634,
    lane: 'dev',
    body: reading.body,
    landedAt: reading.landedAt,
    spectatorChannel: reading.spectate?.channel ?? null,
    driverChannel: reading.channels.driver[0] ?? null,
    heartbeatAt: momentOf(reading.heartbeat),
    metrics: reading.heartbeat?.metrics ?? null,
    rows,
    passed: answerable.length > 0 && failed.length === 0,
    // The one thing this reading cannot do, stated in the artifact rather than in a message
    // somebody may not read.
    witness: { by: 'operator', claim: WITNESS_CLAIM, proven: false },
    failed: failed.map(row => row.id)
  }
}

export function formatVerdict (report) {
  const lines = []
  lines.push('#634 dev-lane proof — body ' + (report.body ?? 'unknown') +
    ', spectator channel ' + (report.spectatorChannel ?? 'none') +
    ', driver channel ' + (report.driverChannel ?? 'none'))
  if (report.heartbeatAt !== null) {
    // Named for what it is: with no landing there is no heartbeat that covers one, and the
    // last one is a fallback rather than the run's own.
    lines.push('  counters from the ' + (report.landedAt === null ? 'last ' : '') +
      'heartbeat at ' + new Date(report.heartbeatAt).toISOString())
  }
  lines.push('')
  for (const row of report.rows) {
    const mark = row.by === 'operator' ? 'WITNESS' : (row.holds ? 'YES    ' : 'NO     ')
    lines.push('  ' + mark.padEnd(8) + row.claim)
    if (row.evidence) lines.push('            ' + row.evidence)
    if (row.because) lines.push('            ' + row.because)
  }
  lines.push('')
  lines.push(report.passed
    ? 'the frames this run needed reached their sockets. What a client drew with them is the ' +
      'WITNESS line, and nobody has looked yet.'
    : 'the run did not reach every socket it needed: ' + report.failed.join(', ') +
      '. A proof needs both halves; this one is missing the frames.')
  return lines.join('\n')
}

async function read (path) {
  if (path !== null) {
    const chunks = []
    // readNdjson answers `{ record, file, line }` for a journal shard and for a plain JSONL
    // file alike, and a torn line is its own error rather than a silent skip.
    for await (const entry of readNdjson(path)) chunks.push(entry.record)
    return chunks
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return parseRecords(Buffer.concat(chunks).toString('utf8'))
}

async function main (argv) {
  const options = { path: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { process.stdout.write(USAGE); return 0 }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--path') {
      options.path = argv[index + 1] ?? null
      if (options.path === null) { process.stderr.write('--path needs a file\n\n' + USAGE); return 2 }
      index += 1
      continue
    }
    process.stderr.write('unknown argument: ' + arg + '\n\n' + USAGE)
    return 2
  }

  const records = await read(options.path)
  const reading = readingOf(records)
  const report = verdict(reading)
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(formatVerdict(report) + '\n')
  }
  if (report.rows.find(row => row.id === 'landed')?.holds !== true) return 2
  return report.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 2
  })
}

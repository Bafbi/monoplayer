#!/usr/bin/env node
// #634: the reading half of the dev lane's two-client proof, and the witness the other half
// needs before anybody can call the proof done.
//
// The owner's condition for epic #632 was that a thread making this work must be able to
// validate it on the right harness — and protocol bots passed a bug a real client died on
// (#598: 29 registry frames, a duplicate key, a disconnect). So the last word on "a client
// sees the body" belongs to a person looking at two clients. This file is the other half: it
// reads one run's records, answers each claim a machine can answer, and refuses to report a
// proof while the claims only eyes can answer are still `pending`.
//
// Why a CLI of its own, beside `tools/journal.mjs`. That tool answers one journal question per
// command — which frames, in what direction, in what state, how many — and this one answers a
// run's claims, which need three records put beside each other (a landing, the frames written
// to that socket, and the counters after it). `journal.mjs heartbeat` reads a JSONL log and so
// does this; neither subsumes the other, and teaching the journal about spectator claims would
// put a product question in the observability tool. What this reads is the JSONL log on the
// pod's stdout, one `kubectl logs` away (`deploy/dev/README.md`, "The two-client proof"), not a
// journal shard: a shard is not this lane's input, because a picker lane writes no journal at
// all and the journal's policy drops the move frame this proof needs.
//
// What it reads: `RECORDS`, the one list of the records a run is made of. The table in the
// runbook is held to it by `test/driver/dev-proof.test.js`, so the two cannot drift.
//
// The two halves. `claimsOf` answers the claims a machine can. The other half —
// `OPERATOR_STEPS`, what a person must see — is never answered here: `witnessDocument` writes
// it `pending`, and `verifyWitness` refuses until every step is recorded and the rows are those
// steps (#880). One `not-seen` is accepted: the one a step declares expected absent, with the
// tickets that close it (#920). Every other one is the finding it was. The polarity is
// `src/driver/run.js`'s unmodded witness, on purpose: one exit code 1 for "the human half is
// not recorded", in this same directory, rather than a second meaning for 1.
//
// The machine half is re-read, not trusted. The witness records the log its rows came from
// (`frames.source`) and `--verify` re-derives them from that file, refusing a copy it contradicts
// by name with both values (#923). The log is gitignored and the witness outlives it, so a verdict
// with no log to read says in words that the frames half was not re-read: a pass is then the run's
// word, and the output does not let a reader take it for a check.
import { pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spectatorModeFrames } from '../core/spectator-mode.js'
// The one rule a step expected absent is recorded under, and the sentences a refusal is built from.
// Both hand-filled witnesses read them from src/driver/checks.js, so the dev lane and the G0 lane
// accept a declared gap by the same code rather than by two copies that agree today (#943).
import { GAP_STATE, agree, closes, commaAnd, declaredOf, gapSplit, namedIds, ticketList } from './checks.js'

const USAGE = `usage: kubectl -n monoplayer-dev logs deploy/monoplayer | node src/driver/dev-proof.js
       node src/driver/dev-proof.js --path .reports/dev-log.jsonl [--json] [--witness FILE]
       node src/driver/dev-proof.js --verify [--path LOG] [--witness FILE]

Reads one run's JSONL records and answers each claim of #634 with the frame-level
evidence the log holds. A claim only eyes can answer is written to a witness file,
pending, and --verify refuses until a person has recorded it.

  --path FILE     read a saved record stream instead of stdin; with --verify, the run's own
                  log, re-read so the frames half answers for itself
  --json          print the reading as one JSON document
  --witness FILE  the witness document (default ${'.reports/dev-two-client-witness.json'} to write,
                  testdata/dev-two-client-witness.json to verify)
  --verify        read the witness and refuse unless every step is recorded
  --help          this text

Exit 0 when every frame-level claim holds and, with --verify, every witnessed
step is recorded: seen, or the one gap OPERATOR_STEPS declares. Exit 1 for a
missing frame or an unrecorded witness. Exit 2 when no spectator landed at all:
that is a run that never reached its second client.

A step OPERATOR_STEPS declares expected absent may be recorded not-seen: --verify
accepts that one gap, names the tickets that close it, and refuses any other.

--verify re-reads the frames half from the run's log and refuses a witness whose
rows disagree with it, naming the row and both values. The witness names the log
it was read from (\`frames.source\`), and --path overrides that. With neither, the
verdict says in words that the frames half was not re-read, so a pass is the
run's word and not a check.
`

// The records a run is made of, and what each one settles. One list: the runbook's table is
// held to this one by the guard, so a record renamed in the service fails there instead of
// leaving a reader hunting a line that is no longer written.
export const RECORDS = Object.freeze([
  { name: 'pickerServed', what: 'a client reached the picker. A run with none never joined the lane' },
  { name: 'pickerDialog', what: 'the picker\'s list was offered to a client: one `actions` entry per row, and the `bytes` it cost when the frame went out. It is written even when the write failed, so a client with `pickerServed` and no `pickerDialog` was never offered a list at all, and `pickerDialogFailed` beside it says why the write did not go' },
  { name: 'pickerPick', what: 'a client clicked a row on the picker and the click was read. It names that row\'s `slug` and, when the offer still held the row, its `server`. `known` is false when it did not. A run with `pickerServed` and no `pickerPick` is a client that never clicked one' },
  { name: 'pickerServerDialog', what: 'the chosen server\'s own dialog was offered, with the `verbs` a client may answer it with. It is written even when the write failed, so `pickerPick` with no `pickerVerb` is a client that was never shown this dialog, or never answered it, and `pickerServerDialogFailed` beside it says why the write did not go' },
  { name: 'pickerVerb', what: 'a client answered the chosen server\'s own dialog, carrying the `verb` (`claim`, `spectate` or `disconnect`) and the `server`. This is the click that dials a body or starts a landing. A verb the lane cannot act on writes `pickerVerbRefused` instead' },
  { name: 'claimDial', what: 'a client claimed a body, so a body was dialled. This is where the puppet reaches the Paper' },
  { name: 'spectateView', what: 'a spectator landed on a body. Its `channel` is the socket, `virtualFrames` is what it was told about the puppet\'s body, and `modeFrames` is the spectator game mode pair' },
  { name: 'spectateRefused', what: 'the Spectate click was refused, with the core\'s own reason' },
  { name: 'spectateViewRefused', what: 'the landing itself was refused, with the reason' },
  { name: 'spectateModeRefused', what: 'the spectator game mode pair could not be written to that socket' },
  { name: 'puppetSkinSent', what: '#614\'s `player_info` went out: the body\'s entry, naming the puppet, or the driving client\'s own entry. `puppet` says which entry it is, `true` for the body\'s and `false` for the driver\'s own. `name` is the player it named, `signed` whether the puppet\'s textures property carried a signature, and `reason` what asked for it. It is one frame for the whole body, with no channel, so this record is the entry for every socket at once' },
  { name: 'puppetSkinKnown', what: 'the backend\'s own `player_info` carried a textures property for the puppet. Without it there is no entry to write, and a client drops the spawn that follows' },
  { name: 'puppetSkinWithheld', what: 'an entry the proxy would not write, because the profile it names has no UUID or no name' },
  { name: 'puppetSkinRefused', what: 'the entry could not be built, or the leg could not deliver it' },
  { name: 'virtualPlayerWritten', what: 'one per entry, spawn and despawn, naming the socket and the frame. The only record that says which channel a frame reached, because no counter names a channel' },
  { name: 'virtualPlayerRefused', what: 'the leg threw on a write, with the frame, the socket and the error' },
  { name: 'virtualPlayerAnnounceRefused', what: 'a player the proxy could not name, so no socket was told about it' },
  { name: 'attachDenied', what: 'a login was refused before the picker, with the reason. `not_whitelisted` is the account not being in the lane\'s list' },
  { name: 'pickerEmpty', what: 'the picker offered no row, so there was nothing to claim' },
  { name: 'heartbeat', what: 'the counters, every 30 seconds: `metrics.virtualPlayers*`, `metrics.skinFramesWritten`, and one row per socket with its role' }
])

// The tickets that close the one step a run taken today cannot see. The list's fact is theirs, and
// the step's failure sentence is built from them, so the runbook's cell for the step — held to that
// sentence word for word (#882) — follows a ticket edited here instead of naming one that landed.
const OWN_BODY_TICKETS = Object.freeze([647, 645])

// The claims only a person can answer, in the order the runbook's table asks for them. The
// states are the document's: `pending` until somebody looks, then `seen` or `not-seen`.
//
// `id` is the name the runbook's "What you should see" row carries, and the name a witness row
// records, so the two are one list read at two places rather than two lists that happen to agree.
// `record` is the log record the step's own row names as the thing to read when the step fails,
// and null where nothing is written, because a screen is the whole of the evidence.
// `claim` is the sentence, and it is the only one: the runbook's cell for the step is this string,
// word for word, so the operator reading the page and the witness they sign ask for the same thing
// (#881). It says what a correct run looks like in the operator's terms, including the cues they
// would otherwise miss: a step of lag, the tab list, no hands in first person. The page cannot add
// detail this sentence lacks without becoming a second home for it.
// `openUntil` is the declaration that a step is expected to be `not-seen` today, and the tickets
// that would change it (#920). Optional, like `because`: a step a run taken today shows carries no
// `openUntil` at all, rather than a null standing in for one. `verifyWitness` accepts a `not-seen`
// on a step that carries it and on no other, so the declaration is a list with a reason per entry
// rather than a relaxed check. A row of the witness cannot carry one: the file is hand-edited, and
// a step that could declare itself absent would pass by writing a line.
// `because` is the failure sentence, and it is optional on purpose: what the operator reads when a
// step fails is the page's prose, except where that sentence states a fact this module computes
// (#882). Then the sentence is built here — the mode step's count is `spectatorModeFrames().length`,
// so a third frame fails the guard on the page's cell instead of leaving it quietly stale — and the
// page's cell is this string word for word, the same way it is `claim`'s. A step with no derived fact
// in its failure cell has no `because` at all rather than a null standing in for one: the absence
// is the signal that the page's wording is the only home for that cell, and it stays the page's.
// `test/driver/dev-proof.test.js` holds the runbook's table to every field, both ways.
export const OPERATOR_STEPS = Object.freeze([
  { id: 'puppet-renders', record: 'puppetSkinSent', claim: 'the puppet renders where the driving client stands, wearing the puppet\'s skin' },
  { id: 'puppet-walks', record: 'heartbeat', claim: 'the puppet walks when the driving client walks, a fraction of a step behind' },
  { id: 'spectator-mode', record: 'spectateView', claim: 'the spectator flies, takes no damage, and cannot break or place', because: 'survival behaviour: `spectateView.modeFrames` was not ' + spectatorModeFrames().length },
  {
    id: 'spectator-own-body',
    record: null,
    openUntil: OWN_BODY_TICKETS,
    claim: 'the spectator has no body of its own, and no hands in first person',
    because: 'a body is drawn, and the client collides with blocks: nothing tells the spectator its own ' +
      'player-list entry, and a replayed body keeps its own mode frames. ' + closes(OWN_BODY_TICKETS) +
      ', and until then a witness records this step as not-seen'
  },
  { id: 'drawn-for-driver', record: 'virtualPlayerWritten', claim: 'the spectator appears to the driving client, standing in the world and in the tab list, wearing a default skin' },
  { id: 'drawn-once', record: 'virtualPlayerWritten', claim: 'the driving client is drawn once, not twice: one body, and it is yours' }
])

export const WITNESS_LANE = 'dev-two-client'
export const WITNESS_WRITE = '.reports/dev-two-client-witness.json'
export const WITNESS_COMMIT = 'testdata/dev-two-client-witness.json'

// The rows the records answer, in the order a run makes them true. `id` is what a failure is
// called.
export const CLAIMS = Object.freeze([
  { id: 'landed', text: 'a second client landed on the body as a spectator' },
  { id: 'entry', text: 'the puppet was announced: a player_info entry for it, written for the whole body' },
  { id: 'body', text: 'the puppet had a body there: a spawn_entity for its UUID' },
  { id: 'move', text: 'a move frame was written after the landing, so the puppet was not standing still on every socket' },
  { id: 'seen-by-driver', text: 'the spectator was announced and spawned on the driver\'s own socket' },
  // The pair's two frames, in the order the module writes them: the hand copy #882 found on the
  // runbook's page, one file over, with the same repair — built here, so a third frame reaches this
  // sentence instead of leaving it naming the two it always has.
  { id: 'mode', text: 'the spectator was told it is a spectator: ' + spectatorModeFrames().map(frame => frame.name).join(', then ') }
])

// The events that stop a run before its first landing, or after it.
const REFUSALS = [
  'spectateRefused',
  'spectateViewRefused',
  'spectateModeRefused',
  'virtualPlayerRefused',
  'virtualPlayerAnnounceRefused',
  'attachDenied',
  'pickerEmpty'
]

export function parseRecords (text) {
  const records = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      // A line that is not a record is not a finding: kubectl interleaves its own output on a
      // bad day, and a crash can cut the last record in half. Both streams read the same way,
      // which is why a saved log and a pipe cannot disagree about a run.
      continue
    }
    if (record !== null && typeof record === 'object') records.push(record)
  }
  return records
}

const eventOf = record => (typeof record.event === 'string' ? record.event : null)

// A record's moment in epoch milliseconds. The service writes `t` as an ISO 8601 string
// (`createJsonlLog`, src/service/start-live.js) and the packet journal writes a number, and a
// saved stream may hold either.
export function momentOf (record) {
  const t = record?.t
  if (Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const parsed = Date.parse(t)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

const ofEvent = (records, event) => records.filter(record => eventOf(record) === event)

const after = (record, moment) => {
  const at = momentOf(record)
  return at !== null && Number.isFinite(moment) && at >= moment
}

// The run's body: the one a spectator landed on, or, when nobody landed, the one a claim
// dialled. A lane serves one body at a time, so one body is the run's.
function bodyOf ({ spectateViews = [], claims = [] } = {}) {
  const landed = spectateViews.at(-1)?.body
  if (typeof landed === 'string' && landed !== '') return landed
  const dialled = claims.at(-1)?.body
  return typeof dialled === 'string' && dialled !== '' ? dialled : null
}

// The channels the last heartbeat saw on the body: the driver's own, and the spectators'. A
// channel is the front leg's record, and the heartbeat is the one artifact that names them.
function channelsOf (heartbeat, body = null) {
  const rows = Array.isArray(heartbeat?.channels) ? heartbeat.channels : []
  const onBody = rows.filter(row => body === null || row?.body === body)
  return {
    driver: onBody.filter(row => row?.role === 'driver').map(row => row.channel),
    spectators: onBody.filter(row => row?.role === 'spectator').map(row => row.channel)
  }
}

// The heartbeat that covers the landing: the first one after it, because the counters are
// cumulative and a record from before the landing says nothing about it. The last one is the
// fallback for a run that ended inside one heartbeat window.
function heartbeatAfter (heartbeats, moment) {
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
    // #614's entry for the puppet, and the records that say why it is missing. The entry is one
    // frame for the whole body with no channel, so it is not in `writes`.
    skins: ofEvent(records, 'puppetSkinSent'),
    skinNotes: records.filter(record => ['puppetSkinKnown', 'puppetSkinWithheld', 'puppetSkinRefused'].includes(eventOf(record))),
    // Every line that stops a two-client run, so a report can name which one fired instead of
    // saying "nothing happened".
    refusals: records.filter(record => REFUSALS.includes(eventOf(record))),
    // A join that reached the picker at all. It is the difference between "this log is the
    // wrong run" and "the second client never clicked Spectate".
    joins: ofEvent(records, 'pickerServed')
  }
}

// The entry the landing pass wrote for the puppet: after the landing, and naming the puppet.
// `sendPuppetSkin` writes it once for every channel of the body, which is why this is the row
// that answers for the entry rather than a per-channel record.
function landingEntry (reading) {
  if (reading.landedAt === null) return null
  return reading.skins.find(record => record.puppet === true && after(record, reading.landedAt)) ?? null
}

function writtenTo (writes, channel) {
  return writes.filter(record => record.channel === channel)
}

const names = records => records.map(record => record.frame).filter(name => typeof name === 'string')

// One row per claim, answered from the reading. `holds` is true, false, or — for nothing here
// — answered elsewhere: what only a person can see is `OPERATOR_STEPS`, not a row.
export function claimsOf (reading) {
  const spectate = reading.spectate
  const spectatorChannel = typeof spectate?.channel === 'string' ? spectate.channel : null
  const perChannel = spectatorChannel === null ? [] : writtenTo(reading.writes, spectatorChannel)
  const frames = names(perChannel)
  const metrics = reading.heartbeat?.metrics ?? {}
  const onDriver = reading.channels.driver.flatMap(channel => writtenTo(reading.writes, channel))
  const driverFrames = names(onDriver)
  const moved = Number.isFinite(metrics.virtualPlayersMoved) && metrics.virtualPlayersMoved > 0
  const entry = landingEntry(reading)
  // The pair `src/core/spectator-mode.js` writes, counted rather than assumed: a third frame
  // there is a change this row follows instead of reading as a failure.
  const modePair = spectatorModeFrames().length

  const row = (id, holds, evidence, because) => ({
    id,
    claim: CLAIMS.find(entry => entry.id === id).text,
    holds,
    evidence,
    because
  })

  return [
    row('landed', spectate !== null,
      spectate === null
        ? 'no spectateView record'
        : 'spectateView on channel ' + spectatorChannel + ', ' + spectate.frames + ' frames replayed',
      spectate === null ? refusalBecause(reading) : null),
    row('entry', spectate !== null && entry !== null,
      spectate === null
        ? 'no landing to announce to'
        : (entry === null
            ? 'no puppetSkinSent record after the landing'
            : 'puppetSkinSent: ' + entry.name + ', signed ' + entry.signed + ', reason ' + entry.reason),
      spectate === null ? null : entryBecause(reading)),
    row('body', spectate !== null && frames.includes('spawn_entity'),
      spectate === null
        ? 'no landing to spawn to'
        : (frames.includes('spawn_entity')
            ? 'virtualPlayerWritten: spawn_entity on ' + spectatorChannel
            : 'no spawn_entity written on ' + spectatorChannel),
      spectate === null ? null : bodyBecause(reading, frames)),
    row('move', moved,
      'metrics.virtualPlayersMoved = ' + (metrics.virtualPlayersMoved ?? 'not in this log'),
      // What the counter cannot say is stated on every report, because the row would otherwise
      // read as "the puppet moved for the spectator".
      moved
        ? 'this counter is the process\'s, not a socket\'s: it also counts the spectator\'s own ' +
          'movement on the driver\'s socket, so it cannot say which player moved or to whom'
        : 'a move is written only to a channel that is not that player\'s own, so a zero means no ' +
          'socket was ever told that a player moved'),
    row('seen-by-driver', reading.channels.driver.length > 0 &&
      driverFrames.includes('spawn_entity') && driverFrames.includes('player_info'),
      reading.channels.driver.length === 0
        ? 'no driver channel in the heartbeat'
        : (driverFrames.length === 0
            ? 'nothing written to the driver channel ' + reading.channels.driver.join(', ')
            : 'virtualPlayerWritten on the driver channel: ' + [...new Set(driverFrames)].join(', ')),
      reading.channels.driver.length === 0
        ? 'the heartbeat named no driver socket, so nobody was controlling the body when it was written'
        : (driverFrames.length === 0
            ? 'the driver\'s client is told about the spectators by the same two frames a spectator is ' +
              'told about the puppet (#636); nothing here means the driver sees an empty world beside itself'
            : 'the entry was written to the driver socket and no spawn followed it: the order is entry ' +
              'then spawn, so this is a write the leg dropped or a roster that lost the player between them')),
    row('mode', spectate !== null && spectate.modeFrames === modePair,
      spectate === null
        ? 'no landing to put in spectator mode'
        : 'spectateView.modeFrames = ' + (spectate.modeFrames ?? 'not in this log') + ', of ' + modePair,
      spectate !== null && spectate.modeFrames === modePair
        ? null
        : 'a spectator\'s mode is the pair src/core/spectator-mode.js writes on its own socket (#633); ' +
          'flight and invulnerability come from the first of them')
  ]
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
    // #670: a pickerEmpty keeps the offer's own cause beside the word the refusal map is
    // keyed by, and that code is what an operator repairs the list from (#372).
    (typeof record.offerReason === 'string' ? ' (' + record.offerReason + ')' : '') +
    (typeof record.text === 'string' ? ' — ' + record.text : '')).join('; ')
}

// Why no entry went out, in the terms a reader can act on. The last case is the one that makes
// an empty world while every frame count is healthy, which is #632's own report.
function entryBecause (reading) {
  const withheld = ofEvent(reading.skinNotes, 'puppetSkinWithheld')
  if (withheld.length > 0) {
    return 'the proxy would not write an entry it could not name: ' + withheld.map(record =>
      (record.reason ?? 'no reason') + ' for ' + (record.name ?? 'a nameless profile')).join('; ')
  }
  const refused = ofEvent(reading.skinNotes, 'puppetSkinRefused')
  if (refused.length > 0) {
    return 'the entry could not be delivered: ' + refused.map(record =>
      (record.reason ?? 'no reason') + (record.puppet === true ? ' for the puppet' : '')).join('; ')
  }
  if (ofEvent(reading.skinNotes, 'puppetSkinKnown').length === 0) {
    return 'the backend sent no textures property for the puppet, so #614 has no entry to write. A ' +
      'client refuses a player spawn it holds no entry for (src/core/virtual-players.js), so the body ' +
      'row can be green and the world still empty: that is #632 with the frames in it'
  }
  return 'the property is known and no entry was written after this landing: the skin switch is off, ' +
    'or the entry went out before the spectator landed and was not written again'
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
  const failed = rows.filter(row => row.holds !== true)
  return {
    rung: WITNESS_LANE,
    issue: 634,
    lane: 'dev',
    body: reading.body,
    landedAt: reading.landedAt,
    spectatorChannel: reading.spectate?.channel ?? null,
    driverChannel: reading.channels.driver[0] ?? null,
    heartbeatAt: momentOf(reading.heartbeat),
    metrics: reading.heartbeat?.metrics ?? null,
    rows,
    framesPassed: failed.length === 0,
    failed: failed.map(row => row.id)
  }
}

// The frames half as the witness keeps it. One builder, used by the document this module writes
// and by the re-read `--verify` makes from the log, so the copy and the evidence cannot describe
// one run in two shapes.
function framesOf (report) {
  return {
    body: report.body,
    spectatorChannel: report.spectatorChannel,
    driverChannel: report.driverChannel,
    heartbeatAt: report.heartbeatAt,
    passed: report.framesPassed,
    failed: report.failed,
    rows: report.rows.map(row => ({ id: row.id, holds: row.holds, evidence: row.evidence }))
  }
}

// The witness a person completes, in the shape `src/driver/run.js` uses for the unmodded lane:
// a document that says what is not done, one row per step, and a `completed` only a human sets.
// `source` is the log the frames rows were read from, or null for a reading from a pipe: the
// witness names the artifact it came from, so `--verify` can re-read it instead of trusting the
// copy (#923).
export function witnessDocument (report, { now = new Date().toISOString(), source = null } = {}) {
  return {
    lane: WITNESS_LANE,
    issue: 634,
    generatedAt: now,
    completed: false,
    status: 'NOT COMPLETE — exits nonzero until the operator records what two clients showed',
    how: [
      'Stage the lane and drive two clients: deploy/dev/README.md, "The two-client proof".',
      'Read the run: kubectl -n monoplayer-dev logs deploy/monoplayer | node src/driver/dev-proof.js',
      'For each step, keep its id and set state to seen or not-seen, then write what you saw in evidence.',
      // #923: the command names the log this reading came from, and never a path nobody wrote. A
      // piped reading has no log to name, and the step says so rather than printing a command that
      // would fail on a file this run never saved.
      source === null
        ? 'Set completed true, then run: node src/driver/dev-proof.js --verify. This stream was piped in, so there is no log to re-read: save the next one with --path and the machine half is checkable.'
        : 'Set completed true, then run: node src/driver/dev-proof.js --verify --path ' + source +
          '. The machine half is re-read from that file, not taken on this one\'s word.'
    ],
    // `source` is the log these rows were read from, and it is what `--verify` re-reads. It is null
    // for a reading piped in, and the verdict says so rather than naming a file nobody saved.
    frames: { ...framesOf(report), source },
    // One row per step, named by `id`: the row says which step it records, so a document that
    // repeats one step and leaves another unrecorded is refused by name rather than counted (#880).
    steps: OPERATOR_STEPS.map(({ id, claim }) => ({ id, claim, state: 'pending', evidence: '[MANUAL: what you saw]' })),
    limitations: [
      'The frames half is read off the lane\'s own log. It says which frame reached which socket and nothing about what a client drew with it.',
      'A step set to not-seen is a finding, not a pass, unless OPERATOR_STEPS declares that step expected absent for this run.',
      // #920: built from the declaration, so a ticket added, closed or dropped from the list reaches
      // this sentence instead of leaving a generated document telling the operator to record a gap
      // that no longer exists.
      ...OPERATOR_STEPS.filter(step => step.openUntil !== undefined).map(step =>
        'The step \'' + step.id + '\' is expected to be not-seen today: ' + step.because +
        '. Record it not-seen with what you saw, and the check accepts that one gap.')
    ]
  }
}

const OPEN_STATES = new Set(['pending'])

// The states a recorded row may be in. Every other string is refused: before #920 the check read
// `pending` and `not-seen` and passed everything else, so a hand-edited row saying 'deferred' or
// 'SKIPPED' with evidence beside it verified as a finished proof. The vocabulary is the document's,
// so it is read here rather than assumed.
const RECORDED_STATES = new Set(['seen', GAP_STATE])

// A refusal, with the two lists a pass reads kept in the shape: a caller that prints them needs no
// guard, and a test can assert an empty list rather than an absent key.
const refuse = reason => ({ ok: false, reason, gaps: [], stale: [] })

// A pass, carrying the human half's gaps and whatever answered the frames half: `reread` true with
// the log it was re-derived from, or false when the witness's own copy was all there was (#923).
// One builder, so the two passes cannot describe themselves differently.
const pass = (human, frames) => ({ ok: true, reason: null, gaps: human.gaps, stale: human.stale, frames })

// The one line a declared gap is printed on, wherever this module prints one, so its two readers
// cannot word it differently: the command's pass and the report beside the step.
// `withEvidence` is for the caller that has not printed the operator's words on the line above.
const gapLine = (step, { withEvidence = false } = {}) =>
  'known gap: ' + step.claim + ' — not seen' +
  (withEvidence ? ' (' + step.evidence + ')' : '') + ', and ' + closes(step.openUntil)

// The line a declaration that outlived its ticket is printed on. #920's answer to a declaration that
// would otherwise rot: a witness that saw the step still verifies, because a fix landing must not
// turn an honest record red, and this line names the declaration to drop in the change that closes it.
const staleLine = step =>
  'stale declaration: ' + step.claim + ' — seen, and OPERATOR_STEPS still expects it not seen until ' +
  ticketList(step.openUntil) + ' ' + agree(step.openUntil.length, 'lands', 'land') +
  ': drop the step\'s openUntil in the change that closes it'

// What is wrong with the rows before their states are read: whether they are OPERATOR_STEPS, by
// id and in its order. A row is named by its `id` and never by its `claim`: the claim is prose a
// runbook rewrite rewords, the id is the name both sides already carry, and comparing the prose
// would pass a document whose sentences match and whose steps do not (#880).
//
// No refusal counts rows. A total says what an operator already knows and not which row to open,
// and a document that repeats one step and drops another keeps the count it started with.
function stepRefusal (steps) {
  const stepsAre = 'the steps are, in order: ' + namedIds(OPERATOR_STEPS.map(step => step.id))
  const rows = steps.map((step, at) => ({ at, id: typeof step?.id === 'string' && step.id !== '' ? step.id : null }))
  const unnamed = rows.filter(row => row.id === null)
  if (unnamed.length > 0) {
    return 'the witness\'s ' + commaAnd(unnamed.map(row => 'row ' + (row.at + 1))) +
      agree(unnamed.length, ' carries', ' carry') + ' no step id: a row records one step of this run, and ' + stepsAre
  }
  const known = new Set(OPERATOR_STEPS.map(step => step.id))
  const unknown = rows.filter(row => !known.has(row.id))
  if (unknown.length > 0) {
    return 'the witness\'s ' + commaAnd(unknown.map(row => 'row ' + (row.at + 1) + ' (`' + row.id + '`)')) +
      agree(unknown.length, ' is', ' are') + ' no step of this run: ' + stepsAre
  }
  const ids = rows.map(row => row.id)
  const recorded = new Set(ids)
  const missing = OPERATOR_STEPS.map(step => step.id).filter(id => !recorded.has(id))
  const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))]
  if (missing.length > 0 || repeated.length > 0) {
    return [
      missing.length === 0 ? null : 'unwitnessed: ' + namedIds(missing),
      repeated.length === 0 ? null : 'recorded twice: ' + namedIds(repeated)
    ].filter(clause => clause !== null).join('; ')
  }
  const moved = rows.find(row => row.id !== OPERATOR_STEPS[row.at].id)
  if (moved !== undefined) {
    return 'the witness\'s row ' + (moved.at + 1) + ' records `' + moved.id + '`, and the run\'s step ' +
      (moved.at + 1) + ' is `' + OPERATOR_STEPS[moved.at].id + '`: the rows are OPERATOR_STEPS in its order'
  }
  return null
}

// Every field the frames half carries, as the log contradicts it: one sentence per field, with what
// the witness says and what the log says. #923: a refusal that only says the two disagree sends the
// reader to diff two documents by hand, and the field that moved is the whole finding. The walk is
// over `framesOf`'s own object, so a field added to the document is compared without a second list
// to keep in step; the two lists it carries — the rows and the failed ids — get a sentence per
// entry instead.
function frameDisagreements (copy, reread) {
  const claims = []
  const derived = framesOf(reread)
  // The identity of the run first: a log from another run answers these before it answers a row.
  for (const [key, value] of Object.entries(derived)) {
    if (key === 'rows' || key === 'failed') continue
    const at = copy?.[key] ?? null
    if (at === value) continue
    claims.push('frames.' + key + ' is ' + JSON.stringify(at) + ' in the witness and ' +
      JSON.stringify(value) + ' in the log')
  }
  const failed = Array.isArray(copy?.failed) ? copy.failed : []
  if (failed.join(',') !== derived.failed.join(',')) {
    claims.push('frames.failed is [' + failed.join(', ') + '] in the witness and [' + derived.failed.join(', ') + '] in the log')
  }
  const rows = (Array.isArray(copy?.rows) ? copy.rows : []).filter(row => typeof row?.id === 'string')
  const copied = new Map(rows.map(row => [row.id, row]))
  // A row recorded twice is named before its value is read: a Map keeps the last one, and a document
  // that repeats a row and drops another is exactly the shape #880 found in the steps.
  for (const id of new Set(rows.map(row => row.id).filter((id, at) => rows.findIndex(row => row.id === id) !== at))) {
    claims.push('row `' + id + '` is in the witness twice')
  }
  const answered = new Set(derived.rows.map(row => row.id))
  for (const row of derived.rows) {
    if (!copied.has(row.id)) {
      claims.push('row `' + row.id + '` is in the log and not in the witness')
      continue
    }
    const said = copied.get(row.id)
    if ((said.holds ?? null) !== row.holds) {
      claims.push('row `' + row.id + '` holds ' + (said.holds ?? null) + ' in the witness and ' + row.holds + ' in the log')
    }
    // The evidence is the sentence the operator read beside the row, so a copy of it that the log
    // does not answer for is the same finding as a row that moved.
    if ((said.evidence ?? null) !== row.evidence) {
      claims.push('row `' + row.id + '`\'s evidence is ' + JSON.stringify(said.evidence ?? null) +
        ' in the witness and ' + JSON.stringify(row.evidence) + ' in the log')
    }
  }
  for (const id of copied.keys()) {
    if (!answered.has(id)) claims.push('row `' + id + '` is in the witness and not in the log')
  }
  return claims
}

// What a witness has to say before it counts, and which step stops it. One message per kind of
// gap, each naming what to write.
//
// `log` is the run's own record stream as `{ path, text }` when one answered for this witness, and
// null when none did. A log turns the frames half from a claim into a reading: the rows are
// re-derived from it, and a copy that disagrees is refused by name with both values (#923). No log
// is not a refusal — the log is gitignored and the witness outlives it — but the result then says
// `frames.reread` false, so a caller cannot print a pass as if a machine had checked the copy.
export function verifyWitness (document, { lane = WITNESS_LANE, log = null } = {}) {
  if (document === null || typeof document !== 'object') {
    return refuse('no witness file: run the reader on the lane\'s log first, then record what you saw')
  }
  if (document.lane !== lane) {
    return refuse('the witness names lane ' + JSON.stringify(document.lane) + ', not ' + JSON.stringify(lane))
  }
  const steps = Array.isArray(document.steps) ? document.steps : []
  const misplaced = stepRefusal(steps)
  if (misplaced !== null) return refuse(misplaced)
  // Past that check the rows are OPERATOR_STEPS in its order, so each step's words are the
  // module's. A row's own `claim` is the operator's label and no refusal reads it: the file is
  // hand-edited, and a claim that drifted from its id would otherwise be quoted back as evidence.
  //
  // `openUntil` comes from the module for that reason, and it overwrites whatever the row held:
  // declaring a gap is this list's fact (#920), and a row that could declare its own step expected
  // absent would verify by writing one line.
  const settled = steps.map((step, at) => ({
    ...step,
    claim: OPERATOR_STEPS[at].claim,
    openUntil: OPERATOR_STEPS[at].openUntil ?? null
  }))
  const unrecorded = settled.filter(step => OPEN_STATES.has(step?.state) || step?.state === undefined)
  if (unrecorded.length > 0) {
    return refuse(unrecorded.length + ' step(s) are still pending: ' + unrecorded.map(step => step.claim).join('; '))
  }
  const silent = settled.filter(step => typeof step.evidence !== 'string' || step.evidence.trim() === '' ||
    step.evidence.startsWith('[MANUAL'))
  if (silent.length > 0) {
    return refuse('a recorded step carries no evidence: ' + silent.map(step => step.claim).join('; '))
  }
  const invented = settled.filter(step => !RECORDED_STATES.has(step.state))
  if (invented.length > 0) {
    return refuse('a recorded step is in no state a witness has: ' + invented.map(step =>
      '`' + step.id + '` says ' + JSON.stringify(step.state) + ', and a step is `seen` or `not-seen`').join('; '))
  }
  if (document.completed !== true) {
    return refuse('every step is recorded, and the document is not marked completed: set completed true')
  }
  // #920: a `not-seen` is the finding it always was, on every step but the ones this module declares
  // expected absent today. The split is `gapSplit`'s, shared with the unmodded witness one file over,
  // so the two documents read one rule rather than two that agree today (#943). The declaration is a
  // list with a ticket per entry, not a relaxed check: the refusal keeps the sentence it always had,
  // and names the one gap this run does expect, so an operator holding two `not-seen` rows is told
  // which one is the honest one.
  const { declared, gaps, unexpected } = gapSplit(settled)
  if (unexpected.length > 0) {
    return refuse('not seen: ' + unexpected.map(step => step.claim + ' (' + step.evidence + ')').join('; ') +
      (declared.length === 0
        ? ''
        : '. The only not-seen this run accepts is a step declared expected absent: ' + commaAnd(declared.map(step =>
          step.claim + ' (' + closes(step.openUntil) + ')'))))
  }
  // What the human half answered, built once: both passes carry it, and the only thing that differs
  // between them is what answered the frames half.
  const human = {
    gaps: gaps.map(declaredOf),
    stale: settled.filter(step => step.state === 'seen' && step.openUntil !== null).map(declaredOf)
  }
  const frames = document.frames ?? {}
  if (log === null) {
    if (frames.passed !== true) {
      return refuse('the frames half did not pass in the run this witness records: ' + (frames.failed ?? []).join(', '))
    }
    return pass(human, { reread: false, source: null })
  }
  const reread = verdict(readingOf(parseRecords(log.text)))
  const disagreements = frameDisagreements(frames, reread)
  if (disagreements.length > 0) {
    return refuse('the frames half in the witness and in ' + log.path + ' disagree: ' + disagreements.join('; '))
  }
  // Agreed, and the run it describes did not pass: the witness records an honest failure, which is
  // still not a proof. Refused in the words the no-log case uses, naming the rows that did not hold.
  if (reread.framesPassed !== true) {
    return refuse('the frames half did not pass in the run this witness records: ' + reread.failed.join(', ') +
      ' did not hold in ' + log.path)
  }
  return pass(human, { reread: true, source: log.path })
}

export function formatVerdict (report, { witnessPath = null, witness = null } = {}) {
  const lines = []
  lines.push('#634 dev-lane proof — body ' + (report.body ?? 'unknown') +
    ', spectator channel ' + (report.spectatorChannel ?? 'none') +
    ', driver channel ' + (report.driverChannel ?? 'none'))
  if (report.heartbeatAt !== null) {
    // Named for what it is: with no landing there is no heartbeat that covers one, and the last
    // one is a fallback rather than the run's own.
    lines.push('  counters from the ' + (report.landedAt === null ? 'last ' : '') +
      'heartbeat at ' + new Date(report.heartbeatAt).toISOString())
  }
  lines.push('')
  for (const row of report.rows) {
    lines.push('  ' + (row.holds ? 'YES  ' : 'NO   ') + row.claim)
    if (row.evidence) lines.push('            ' + row.evidence)
    if (row.because) lines.push('            ' + row.because)
  }
  lines.push('')
  if (witness !== null) {
    for (const step of witness.steps ?? []) {
      lines.push('  ' + String(step.state).toUpperCase().padEnd(9) + step.claim)
      if (step.state !== 'pending') lines.push('            ' + step.evidence)
      // #920: the declaration beside the row it belongs to, so a reader of the report sees which gap
      // is the known one, and which declaration a witness that saw the step outlived.
      const entry = OPERATOR_STEPS.find(row => row.id === step?.id)
      if (entry?.openUntil !== undefined && step?.state === 'not-seen') lines.push('            ' + gapLine(entry))
      if (entry?.openUntil !== undefined && step?.state === 'seen') lines.push('            ' + staleLine(entry))
    }
    lines.push('')
  }
  lines.push(report.framesPassed
    ? 'the frames this run needed reached their sockets.'
    : 'the run did not reach every socket it needed: ' + report.failed.join(', ') + '.')
  if (witnessPath !== null) {
    lines.push('the half only eyes can answer is ' +
      (witness !== null && verifyWitness(witness).ok ? 'recorded' : 'still pending') +
      ': ' + witnessPath + ', and node src/driver/dev-proof.js --verify reads the steps back and ' +
      're-reads the frames half from the log this document names.')
  }
  return lines.join('\n')
}

// The log a re-read answers from, or the reason there is none. `given` is --path, which the operator
// asked for, and which a read failure turns into a refusal. `named` is the path the witness recorded
// itself, and it is expected to be gone once .reports/ is cleaned, so its absence is the no-log case
// rather than an error: the witness outlives the log by design.
function logForVerify ({ given, named }) {
  const wanted = given ?? (typeof named === 'string' && named !== '' ? named : null)
  if (wanted === null) return { log: null, gone: null, refusal: null }
  try {
    return { log: { path: wanted, text: readFileSync(wanted, 'utf8') }, gone: null, refusal: null }
  } catch (error) {
    // A file that is gone and a file that cannot be read are two findings, and saying "not here"
    // about a permission error sends the operator looking for a missing file.
    const why = error?.code === 'ENOENT'
      ? 'is not here'
      : 'could not be read: ' + String(error?.message ?? error)
    const gone = { path: wanted, why }
    return given === null ? { log: null, gone, refusal: null } : { log: null, gone, refusal: 'the log --path names ' + why + ': ' + wanted }
  }
}

// The one sentence a pass says about the frames half (#923). A frames half that was not re-read is
// the run's word, and the sentence says so instead of letting a reader take the pass for a check.
function framesLine (frames, gone) {
  if (frames.reread) return 'the frames half was re-read from ' + frames.source + ': every row holds there.'
  return 'the frames half was not re-read: ' +
    (gone === null ? 'no log answered for it' : 'the witness names ' + gone.path + ', and that file ' + gone.why) +
    ', so `frames.passed` is the run\'s word in the witness file and not a check. ' +
    'Re-read the log while it is still there: --verify --path <the run\'s log>.'
}

function readStream (path) {
  if (path !== null) return readFileSync(path, 'utf8')
  const chunks = []
  return new Promise(resolve => {
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function main (argv) {
  const options = { path: null, json: false, witness: null, verify: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { process.stdout.write(USAGE); return 0 }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--verify') { options.verify = true; continue }
    if (arg === '--path' || arg === '--witness') {
      const value = argv[index + 1] ?? null
      if (value === null) { process.stderr.write(arg + ' needs a file\n\n' + USAGE); return 1 }
      options[arg.slice(2)] = value
      index += 1
      continue
    }
    process.stderr.write('unknown argument: ' + arg + '\n\n' + USAGE)
    return 1
  }

  if (options.verify) {
    const file = options.witness ?? WITNESS_COMMIT
    let document = null
    try {
      document = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      document = null
    }
    // #923: the frames half is read from the run's own log and never from the copy in the witness.
    // --path names that log; with none, the witness names the one it was read from.
    const found = logForVerify({ given: options.path, named: document?.frames?.source ?? null })
    if (found.refusal !== null) {
      process.stderr.write('NOT COMPLETE: ' + found.refusal + '\n')
      return 1
    }
    const verdictOfWitness = verifyWitness(document, { log: found.log })
    if (!verdictOfWitness.ok) {
      process.stderr.write('NOT COMPLETE: ' + verdictOfWitness.reason + '\n')
      process.stderr.write('Record it: ' + WITNESS_WRITE + ', then copy it to ' + WITNESS_COMMIT + ' and run this again.\n')
      return 1
    }
    process.stdout.write('#634 VERIFIED: the frames reached their sockets and a person recorded what two clients showed.\n')
    process.stdout.write(framesLine(verdictOfWitness.frames, found.gone) + '\n')
    // #920: the gap the run declares, on the run's own output, so the proof a reader picks up names
    // what it does not show and the ticket that closes it. The exit stays 0: the record the runbook
    // asks an operator to make verifies, which is the whole point of declaring the gap.
    for (const gap of verdictOfWitness.gaps) process.stdout.write(gapLine(gap, { withEvidence: true }) + '\n')
    for (const step of verdictOfWitness.stale) process.stdout.write(staleLine(step) + '\n')
    return 0
  }

  const records = parseRecords(await readStream(options.path))
  const reading = readingOf(records)
  const report = verdict(reading)
  const witnessPath = options.witness ?? WITNESS_WRITE
  let witness = null
  if (!options.json) {
    try {
      witness = JSON.parse(readFileSync(witnessPath, 'utf8'))
    } catch {
      witness = witnessDocument(report, { source: options.path })
      try {
        mkdirSync(path.dirname(witnessPath), { recursive: true })
        writeFileSync(witnessPath, JSON.stringify(witness, null, 2) + '\n')
      } catch (error) {
        process.stderr.write('the witness file could not be written: ' + String(error?.message ?? error) + '\n')
      }
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({ ...report, witness: witness ?? witnessDocument(report, { source: options.path }) }, null, 2) + '\n')
  } else {
    process.stdout.write(formatVerdict(report, { witnessPath, witness }) + '\n')
  }
  if (report.rows.find(row => row.id === 'landed')?.holds !== true) return 2
  return report.framesPassed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}

// What one card says, and why. The page's promise is that every number carries
// the timestamp of the log line it came from, and that a puppet which is not
// serving says which fact is missing. Both are asserted here, on the HTML a
// browser gets and on the JSON an agent queries.
//
// No cluster: the API client is three methods, the log is a string, and the clock
// is fixed. The records below are the shapes docs/telemetry.md documents, copied
// from a live pod's tail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { activity } from '../../src/panel/activity.js'
import { uuidRefusalReason } from '../../src/custody/util.js'
import { deploymentCaps, ReadRefused } from '../../src/panel/kube.js'
import { renderPage } from '../../src/panel/views/page.js'
import { createPanelHandler } from '../../src/panel/server.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565'
}

const HEARTBEAT_AT = '2026-11-18T10:37:12.906Z'
const HEARTBEAT_MS = Date.parse(HEARTBEAT_AT)
// Twelve seconds after the heartbeat: inside one 30 s interval, so this record is
// current and the page says "12 s".
const NOW = HEARTBEAT_MS + 12_000
const START_AT = '2026-11-18T09:00:00.000Z'

// Three uuids: two Mojang could issue, and one Java derived from a name, which is the
// shape #677 found in the dev lane's own document. `entryOf` asks `uuidRefusalReason`
// for each, so the record below is the one the lane writes (#705) and this file never
// spells an entry's answer a second time (#703).
const V4 = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const SECOND = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const DERIVED = '62e2a856-7342-3096-b19f-938454443a11'
const entryOf = uuid => ({ uuid, refusalReason: uuidRefusalReason(uuid) })

// #331: one label for one fact. The start record carries the backend the lane
// dialled, which is the configured one, and no second copy of it. The panel still
// shows both facts, because a reconnect moves the effective one and not this one.
//
// #748: and the entries the count counts, with the UUID decision the same read wrote
// (#705). The panel prints this record's answer; it does not make a second one.
const startLive = {
  t: START_AT,
  event: 'startLive',
  version: '1.2.3',
  front: '0.0.0.0:25565',
  backend: 'play2.excalia.fr:25565',
  whitelistCount: 1,
  whitelistEntries: [entryOf(V4)],
  control: { whitelistReload: true }
}

const refusal = {
  t: '2026-11-18T10:00:00.000Z',
  event: 'preAuthRefused',
  reason: 'preauth_connection_cap',
  maxConnections: 3,
  inWindow: 3,
  refused: 1
}

const expiry = {
  t: '2026-11-18T10:10:00.000Z',
  event: 'preAuthExpired',
  reason: 'preauth_deadline',
  deadlineMs: 15_000,
  expired: 1
}

const attach = {
  t: '2026-11-18T10:30:00.000Z',
  event: 'attach',
  name: 'Bafbi',
  reason: 'attach',
  tookMs: 42,
  replayed: 120,
  domains: { config: 0, prefix: 30, chunks: 40, blocks: 0, entities: 5, inventories: 2, latest: 1, generic: 42 },
  entities: { withoutSpawn: 2 }
}

const heartbeat = {
  t: HEARTBEAT_AT,
  event: 'heartbeat',
  attached: false,
  warm: true,
  backendLogins: 2,
  // #833: the core's own group. This is a sample of it rather than all of it, the
  // declaration's first rows and its last three, carrying one packet name in each map, so
  // the page's projection is read against a record shaped like the one a pod writes.
  metrics: {
    backendFrames: 61_844,
    configFrames: 412,
    framesCached: 51_260,
    framesReplayed: 120,
    replayFramesRefused: 1,
    positionsSynthesized: 1,
    serverboundForwarded: 42,
    serverboundDropped: 2,
    serverboundNotAttached: 3,
    serverboundByName: { held_item_slot: 41, player_loaded: 1 },
    serverboundDroppedByName: { chat: 2 },
    chatBlocked: 2,
    chatRelayed: 118,
    chatSent: 6,
    clientboundBlocked: 14,
    clientboundBlockedByName: { entity_destroy: 9, transfer: 5 },
    clientboundUnclassified: 0,
    attaches: 2,
    denials: 0,
    frontKicks: 0
  },
  sizes: { prefix: 360, config: 34, chunks: 166, blocks: 0, entities: 10, inventories: 0, latest: 1, generic: 512 },
  chunkBytes: 2_243_099,
  front: { denied: 0, allowed: 1, attaches: 1, preAuthRefused: 3, preAuthExpired: 0, preAuthInWindow: 0, policyRefused: 0, stateRefused: 0 },
  wire: { checked: 0, rejected: 0, byState: {}, lastFailure: null },
  telemetry: {
    enabled: true,
    logs: { accepted: 54, sent: 54, dropped: 0, queued: 0, batches: 11 },
    metrics: { accepted: 154_796, sent: 95_637, dropped: 0, queued: 67, batches: 1473 },
    requests: 1484,
    retries: 0,
    failures: 0,
    lastError: null
  },
  journal: {
    enabled: true,
    disabledReason: null,
    dir: '/tmp/journal',
    file: '/tmp/journal/journal-2026-11-18T10-frames-1.ndjson',
    frames: 51_260,
    events: 2,
    bytes: 6_000_000,
    sealed: 3,
    pruned: 1,
    prunedBytes: 1000,
    dirBytes: 7_000_000
  },
  account: { alias: 'GlowSquidye', expiresAt: Date.parse('2026-11-25T00:00:00.000Z') },
  // #419: the two groups #415 added. Three shapes the page has to survive are here:
  // a body nobody claimed, a spectator with no claim, and a connection the lane
  // admitted itself, which names no body and carries no open.
  bodies: [
    { body: 'sky', active: true, warm: true, frames: 923, chunkBytes: 2_243_099, framesCached: 51_260, framesDropped: 12, claimMs: 45_000 },
    { body: 'nether', active: false, warm: false, frames: 0, chunkBytes: 0, framesCached: 0, framesDropped: 0 }
  ],
  channels: [
    { channel: 'holder-1', body: 'sky', role: 'driver', ageMs: 120_000, frames: 900, play: 880, configuration: 20, bytes: 1_048_576, replays: 1, spectators: 2, claimMs: 45_000 },
    { channel: 'holder-2', body: 'sky', role: 'spectator', ageMs: 60_000, frames: 400, play: 395, configuration: 5, bytes: 524_288, replays: 1, spectators: 2 },
    { channel: 'holder-3', role: 'spectator', frames: 0, play: 0, configuration: 0, bytes: 0, replays: 0, spectators: 0 }
  ]
}

const pod = {
  metadata: { name: 'monoplayer-84855d7f8b-5h5bd', creationTimestamp: START_AT },
  status: {
    phase: 'Running',
    startTime: START_AT,
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ restartCount: 0 }]
  }
}

const tail = (...records) => records.map(record => JSON.stringify(record)).join('\n') + '\n'

function facts (overrides = {}) {
  return activity({
    puppet,
    pod,
    log: { text: tail(startLive, refusal, expiry, attach, heartbeat) },
    now: NOW,
    ...overrides
  })
}

function kube ({ pods = [pod], log = tail(startLive, refusal, expiry, attach, heartbeat), fail = null } = {}) {
  return {
    async deployment () {
      if (fail === 'deployment') throw new ReadRefused('read Deployment monoplayer/monoplayer: the API server answered 403 Forbidden', { status: 403 })
      return { spec: { selector: { matchLabels: { app: 'monoplayer' } } } }
    },
    async pods () {
      return { items: pods }
    },
    async podLog () {
      if (fail === 'log') throw new ReadRefused('read the log of monoplayer/monoplayer-84855d7f8b-5h5bd: the API server answered 403 Forbidden', { status: 403 })
      return log
    }
  }
}

async function panel (options = {}) {
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets: [puppet] }),
    kubernetes: kube(),
    now: () => NOW,
    ...options
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: 'http://127.0.0.1:' + port, close: () => new Promise(resolve => server.close(resolve)) }
}

// --- the facts ---

test('each group carries the timestamp of the record it came from', () => {
  const card = facts()
  assert.equal(card.heartbeat.at, HEARTBEAT_AT)
  assert.equal(card.heartbeat.ageSeconds, 12)
  assert.equal(card.heartbeat.stale, false)
  assert.equal(card.start.at, START_AT)
  assert.equal(card.attach.at, attach.t)
  assert.equal(card.pod.startedAt, START_AT)
  // The instant of the read is not a fact from the lane and is not used as one.
  assert.equal(card.observedAt, new Date(NOW).toISOString())
})

test('the heartbeat fields are the documented ones, projected by name', () => {
  const { heartbeat: beat, backend, whitelist, preAuth } = facts()
  assert.equal(beat.attached, false)
  assert.equal(beat.warm, true)
  assert.equal(beat.backendLogins, 2)
  assert.equal(beat.sizes.chunks, 166)
  assert.equal(beat.chunkBytes, 2_243_099)
  assert.equal(beat.front.preAuthRefused, 3)
  // #833: the core's counters, projected whole and by the same rule, maps included.
  assert.equal(beat.metrics.replayFramesRefused, 1)
  assert.equal(beat.metrics.framesCached, 51_260)
  assert.deepEqual(beat.metrics.serverboundByName, { held_item_slot: 41, player_loaded: 1 })
  assert.equal(beat.journal.sealed, 3)
  assert.equal(beat.journal.dirBytes, 7_000_000)
  assert.equal(beat.wire.checked, 0)
  assert.equal(beat.telemetry.queuedSeries, 67, 'metrics.queued is distinct series, kept apart from the log queue')
  assert.equal(beat.telemetry.queuedLogRecords, 0)
  // #419: the per-body and per-channel groups, projected field by field like every
  // group above. The doc's three keys that can be absent stay absent: a body nobody
  // claimed has no claim age, a spectator holds no claim, and a connection the lane
  // admitted itself names no body (#263 D2).
  assert.deepEqual(beat.bodies[0], {
    body: 'sky',
    active: true,
    warm: true,
    frames: 923,
    chunkBytes: 2_243_099,
    framesCached: 51_260,
    framesDropped: 12,
    claimMs: 45_000
  })
  assert.equal(beat.bodies[1].body, 'nether')
  assert.ok(!('claimMs' in beat.bodies[1]), 'a body nobody claimed has no claim age, and not a zero')
  assert.deepEqual(beat.channels[0], {
    channel: 'holder-1',
    body: 'sky',
    role: 'driver',
    ageMs: 120_000,
    frames: 900,
    play: 880,
    configuration: 20,
    bytes: 1_048_576,
    replays: 1,
    spectators: 2,
    claimMs: 45_000
  })
  assert.equal(beat.channels[1].role, 'spectator')
  assert.ok(!('claimMs' in beat.channels[1]), 'a spectator holds no claim, so its row carries no claim age')
  assert.ok(!('body' in beat.channels[2]), 'a connection the lane admitted itself names no body')
  assert.ok(!('ageMs' in beat.channels[2]), 'a leg that stamped no open has no age')
  // The effective backend comes from the start record, and the registry's copy is
  // a different fact with no timestamp.
  assert.deepEqual(backend.effective, { value: 'play2.excalia.fr:25565', source: 'start', at: START_AT })
  assert.deepEqual(backend.registry, { value: 'play2.excalia.fr:25565', source: 'registry', at: null })
  assert.deepEqual(whitelist, {
    count: 1,
    at: START_AT,
    source: 'startLive',
    entries: [entryOf(V4)]
  }, 'the count, and the entry it counts, from the one record')
  // The pre-auth caps are only in the lines the window writes, each with its own
  // timestamp.
  assert.deepEqual(preAuth, {
    maxConnections: 3,
    maxConnectionsAt: refusal.t,
    deadlineMs: 15_000,
    deadlineMsAt: expiry.t
  })
})

test('a successful reconnect moves the effective backend off the start record', () => {
  const reconnect = { t: '2026-11-18T10:20:00.000Z', event: 'backendReconnect', target: 'alt.excalia.fr:25565', warm: true }
  const card = facts({ log: { text: tail(startLive, reconnect, heartbeat) } })
  assert.deepEqual(card.backend.effective, { value: 'alt.excalia.fr:25565', source: 'reconnect', at: reconnect.t })
  // #331: the configured target is the start record's one backend label, so a
  // transfer leaves it where the lane started. One record field, two facts.
  assert.deepEqual(card.backend.configured, { value: 'play2.excalia.fr:25565', source: 'start', at: START_AT },
    'the configured target is the start record\'s backend, and a transfer does not move it')
})

// #748: this row was the last place the panel reported a whitelist size and named no
// entry. A count cannot tell three controllers from two and one uuid nobody owns, which
// is the state #677 found in the dev lane's document. The card is the one of the three
// places that shows the list.
test('the start row names the entries it counts, with the decision the record wrote', () => {
  const entries = [V4, SECOND, DERIVED].map(entryOf)
  const card = activity({
    puppet,
    pod,
    log: { text: tail({ ...startLive, whitelistCount: 3, whitelistEntries: entries }, heartbeat) },
    now: NOW
  })
  assert.deepEqual(card.whitelist.entries, entries, 'the entries reach the page, in the record\'s order')
  assert.equal(card.whitelist.count, 3, 'and the count is the list the row names')
  const page = renderPage({ version: 1, puppets: [puppet] }, [card])
  // The fault is stated where the count is: a row of three with one bad entry is easy
  // to read past, and the words are the block's and `mise run dev:status`'s (#677).
  assert.match(page, /3 entries, 2 of which can authenticate \(startLive, 2026-11-18T09:00:00\.000Z\)/)
  // One row per entry, each under the uuid the lane started with: the answer travels
  // with its entry, so two lists cannot fall out of step by position.
  for (const uuid of [V4, SECOND]) {
    assert.ok(page.includes('<dt>' + uuid + '</dt><dd>can authenticate</dd>'),
      'the page names ' + uuid + ' and says a session can answer for it')
  }
  assert.ok(page.includes('<dt>' + DERIVED + '</dt><dd>cannot authenticate: ' + uuidRefusalReason(DERIVED) + '</dd>'),
    'the derived uuid is named as one no Mojang session can answer for, in the one home\'s words')
  // A lane where every entry is usable carries no ratio sentence: one sentence per fact.
  const healthy = renderPage({ version: 1, puppets: [puppet] }, [facts()])
  assert.match(healthy, /1 entry \(startLive, 2026-11-18T09:00:00\.000Z\); re-read at each login/)
  assert.doesNotMatch(healthy, /of which can authenticate/, 'nothing is wrong, so nothing says a ratio')
})

// The record that names no entry is a lane older than #705, or a tail whose only start
// line is the core one. The row keeps the count and says in one clause where the
// per-entry answer is, rather than printing a number that reads as the whole fact.
test('a start record that names no entry shows the count and points at the block', () => {
  const { whitelistEntries, ...countOnly } = startLive
  const card = activity({ puppet, pod, log: { text: tail(countOnly, heartbeat) }, now: NOW })
  assert.deepEqual(card.whitelist, { count: 1, at: START_AT, source: 'startLive', entries: null })
  const page = renderPage({ version: 1, puppets: [puppet] }, [card])
  assert.match(page, /1 entry \(startLive, 2026-11-18T09:00:00\.000Z\); the record carries no per-entry answer, and the attach whitelist block below answers for the file as it stands/)
  assert.doesNotMatch(page, /Whitelist entries at start/, 'and it draws no empty row set')

  // An entry that carries a uuid and no decision is a record this page cannot read, and
  // absent is not a yes: printing it as usable would turn a missing answer into a
  // positive one, which is the failure #748 is about.
  const undecided = activity({
    puppet,
    pod,
    log: { text: tail({ ...startLive, whitelistEntries: [{ uuid: DERIVED }] }, heartbeat) },
    now: NOW
  })
  assert.equal(undecided.whitelist.entries, null, 'a list with no answer in it is no list')
  const undecidedPage = renderPage({ version: 1, puppets: [puppet] }, [undecided])
  assert.doesNotMatch(undecidedPage, /can authenticate/, 'the entry it cannot answer for is not called usable')
  assert.match(undecidedPage, /the record carries no per-entry answer/)

  // The core start record carries uuids and no answer, so it is the count's source and
  // never the row's: the panel prints the decision the lane made, not one it invents.
  const core = { t: START_AT, event: 'start', whitelist: [V4, DERIVED] }
  const coreCard = activity({ puppet, pod, log: { text: tail(core, heartbeat) }, now: NOW })
  assert.deepEqual(coreCard.whitelist, { count: 2, at: START_AT, source: 'start', entries: null })
})

test('an entry whose uuid the record could not normalise is named, not dropped', () => {
  const card = activity({
    puppet,
    pod,
    log: {
      text: tail({
        ...startLive,
        whitelistEntries: [{ uuid: null, refusalReason: uuidRefusalReason(null) }]
      }, heartbeat)
    },
    now: NOW
  })
  assert.deepEqual(card.whitelist.entries, [{ uuid: null, refusalReason: uuidRefusalReason(null) }],
    'the entry that admits nobody is the last one a projection may drop')
  const page = renderPage({ version: 1, puppets: [puppet] }, [card])
  assert.ok(page.includes('<dt>no uuid recorded</dt><dd>cannot authenticate: ' + uuidRefusalReason(null) + '</dd>'))
  assert.match(page, /and it cannot authenticate/, 'one entry, and it admits nobody')
})

test('the last attach names the bodies that never spawned', () => {
  const card = facts()
  assert.equal(card.attach.tookMs, 42)
  assert.equal(card.attach.withoutSpawn, 2)
  assert.equal(card.attach.domains.chunks, 40)
})

// #735: #717 split the attach record's delivery into the frames a socket took and the
// frames the front leg refused, and the card kept drawing one half. A replay count then
// read as a total, and the operator could not tell a replay that lost a frame from one
// that lost none, which is the whole point of the split.
//
// The two numbers are drawn apart and never added: replayed excludes the synthesized
// position while refused includes a position the leg refused (docs/telemetry.md), so a
// ratio between them would print a frame count that is not a frame count.
test('#735 the last attach draws the frames the leg refused beside the ones it wrote', () => {
  const withRefused = refused => ({ ...attach, refused })
  const cardOf = record => facts({ log: { text: tail(startLive, record, heartbeat) } })
  const pageOf = card => renderPage({ version: 1, puppets: [puppet] }, [card])

  const clean = cardOf(withRefused(0))
  assert.equal(clean.attach.refused, 0, 'a record that carries the count carries it as a number, zero included')
  const cleanPage = pageOf(clean)
  assert.match(cleanPage, /<dt>replayed<\/dt><dd>120<\/dd>/,
    'the frames the attach stream wrote, which is the frames a socket took')
  assert.match(cleanPage, /<dt>refused<\/dt><dd>0<\/dd>/,
    'and the frames the leg refused, which is zero: the card shows both numbers, so neither reads as the whole')

  const lossy = cardOf(withRefused(1))
  assert.equal(lossy.attach.refused, 1)
  const lossyPage = pageOf(lossy)
  assert.match(lossyPage, /<dt>replayed<\/dt><dd>120<\/dd>/, 'the same 120 took a socket')
  assert.match(lossyPage,
    /<dt>refused<\/dt><dd>1 \(a frame the front leg refused or threw on, and the attach stream is written once, so the client keeps the gap until it attaches again\)<\/dd>/,
    'one refused frame is a gap in the client world, said in words, and the drop is the behaviour #738 decided rather than a fault')

  // A record written before the field existed answers nothing, and the page says so
  // instead of printing a zero the record never measured.
  const older = cardOf(attach)
  assert.equal(older.attach.refused, null)
  const olderPage = pageOf(older)
  assert.match(olderPage,
    /<dt>refused<\/dt><dd>unknown: the record carries no refusal count, so a frame the leg refused is not separated from the ones it wrote<\/dd>/,
    'a lane older than the field says which half it cannot answer')

  // A record that carries neither count has no pair to draw, and the card says nothing
  // rather than a sentence about a number the record never wrote.
  const bare = cardOf({ t: attach.t, event: 'attach', name: 'Bafbi', reason: 'attach' })
  assert.equal(bare.attach.refused, null)
  assert.equal(bare.attach.replayed, null)
  assert.doesNotMatch(pageOf(bare), /<dt>refused<\/dt>|<dt>replayed<\/dt>/,
    'two absent counts are not a pair, and neither is a zero')
})

// --- the four sentences ---

const sentence = (card) => card.state.reason

test('a puppet with no pod says so, and names the Deployment', () => {
  const card = activity({ puppet, pod: null, log: null, now: NOW })
  assert.equal(card.state.state, 'no-pod')
  assert.match(sentence(card), /^no pod: Deployment monoplayer\/monoplayer has no pod/)
})

test('a pod that is not ready says why, in words', () => {
  const starting = { ...pod, status: { ...pod.status, conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }] } }
  const card = activity({ puppet, pod: starting, log: { text: '' }, now: NOW })
  assert.equal(card.state.state, 'not-ready')
  assert.match(sentence(card), /^pod not ready: monoplayer-84855d7f8b-5h5bd is not Ready \(ContainersNotReady\)/)
})

test('a tail with no heartbeat says how many lines it read and how old they are', () => {
  const card = activity({ puppet, pod, log: { text: tail(startLive, attach) }, now: NOW })
  assert.equal(card.state.state, 'no-heartbeat')
  assert.match(sentence(card), /^no heartbeat in the last 2 lines of monoplayer-84855d7f8b-5h5bd/)
  assert.match(sentence(card), /the newest line is 2026-11-18T10:30:00\.000Z/)
})

test('a refused log read is its own sentence, with the status the API answered', () => {
  const card = activity({
    puppet,
    pod,
    log: { error: new ReadRefused('read the log of monoplayer/x: the API server answered 403 Forbidden', { status: 403 }) },
    now: NOW
  })
  assert.equal(card.state.state, 'log-refused')
  assert.match(sentence(card), /^log fetch refused: read the log of monoplayer\/x: the API server answered 403 Forbidden/)
})

test('a refused Deployment read is its own sentence too', () => {
  const card = activity({
    puppet,
    failure: new ReadRefused('read Deployment monoplayer/monoplayer: the API server answered 403 Forbidden', { status: 403 }),
    now: NOW
  })
  assert.equal(card.state.state, 'read-refused')
  assert.match(sentence(card), /^read refused: read Deployment/)
})

test('a panel with no API client says exactly that', async () => {
  const { readPuppet } = await import('../../src/panel/routes/info.js')
  const card = await readPuppet({ kubernetes: null, puppet, now: NOW })
  assert.equal(card.caps, null, 'no client, no Deployment to read caps from')
  assert.equal(card.state.state, 'read-refused')
  assert.match(card.state.reason, /started without a Kubernetes client/)
})

// --- staleness and expiry ---

test('a heartbeat older than three intervals is its own state, never the live one', () => {
  const late = HEARTBEAT_MS + 10 * 60_000
  const card = activity({ puppet, pod, log: { text: tail(startLive, heartbeat) }, now: late })
  assert.equal(card.heartbeat.stale, true)
  assert.equal(card.heartbeat.ageSeconds, 600)
  assert.equal(card.state.state, 'stale', 'a stale record is not the live colour')
  assert.match(card.state.reason, /^stale: the newest heartbeat was written 600 s ago/)
  assert.match(card.state.reason, /read every number below as old/)
  // And the timestamp a reader sees is the record's, not the clock's.
  assert.equal(card.heartbeat.at, HEARTBEAT_AT)
})

test('the caps the Deployment sets are shown, and the ones it does not stay unknown', () => {
  const deployment = {
    spec: {
      selector: { matchLabels: { app: 'monoplayer' } },
      template: {
        spec: {
          containers: [{
            name: 'monoplayer',
            env: [
              { name: 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS', value: '3' },
              { name: 'MONOPLAYER_PREAUTH_DEADLINE_MS', value: '15000' },
              { name: 'MONOPLAYER_JOURNAL_MAX_BYTES', value: '67108864' },
              { name: 'MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES', value: '268435456' },
              { name: 'MONOPLAYER_JOURNAL_MAX_AGE_MS', value: '172800000' }
            ]
          }]
        }
      }
    }
  }
  const caps = deploymentCaps(deployment)
  const card = activity({ puppet, pod, log: { text: tail(startLive, heartbeat) }, caps, now: NOW })
  assert.deepEqual(caps, {
    preAuthMaxConnections: 3,
    preAuthDeadlineMs: 15_000,
    journalMaxBytes: 67_108_864,
    journalMaxTotalBytes: 268_435_456,
    journalMaxAgeMs: 172_800_000
  })
  // A healthy lane writes no refusal line, so the Deployment's env is the only
  // statement of the cap, and the page says where it came from.
  const page = renderPage({ version: 1, puppets: [puppet] }, [card])
  assert.match(page, /3 \(Deployment env, no timestamp\)/)
  assert.match(page, /67108864 \(64 MiB\) \(Deployment env, no timestamp\)/)
  // An empty env is unknown, never the compiled default guessed.
  const bare = activity({ puppet, pod, log: { text: tail(startLive, heartbeat) }, caps: deploymentCaps({}), now: NOW })
  const barePage = renderPage({ version: 1, puppets: [puppet] }, [bare])
  assert.match(barePage, /unknown: no refusal line in the tail, and the Deployment does not set it/)
  assert.match(barePage, /not in the Deployment env; the compiled defaults apply and the panel cannot see them/)
})

test('the last dial is shown with its outcome, so a failed reconnect is visible', () => {
  const failed = { t: '2026-11-18T10:36:00.000Z', event: 'backendReconnectFailed', target: 'alt.excalia.fr:25565', attempt: 1 }
  const card = activity({ puppet, pod, log: { text: tail(startLive, failed, heartbeat) }, now: NOW })
  assert.deepEqual(card.backend.lastDial, { value: 'alt.excalia.fr:25565', at: failed.t, connected: false })
  // A failed dial does not move the effective backend: the lane is still where
  // the start record put it.
  assert.equal(card.backend.effective.value, 'play2.excalia.fr:25565')
  assert.equal(card.backend.effective.source, 'start')
  const page = renderPage({ version: 1, puppets: [puppet] }, [card])
  assert.match(page, /alt\.excalia\.fr:25565 \(failed, 2026-11-18T10:36:00\.000Z\)/)
})

test('an expiry inside seven days is a date and a warning', () => {
  const card = facts()
  assert.equal(card.heartbeat.account.expiresAtDate, '2026-11-25T00:00:00.000Z')
  assert.ok(card.heartbeat.account.expiresInDays <= 7)
  assert.match(card.heartbeat.account.warning, /expires in 6\.6 days/)
})

test('a null expiry is unknown, which is not the same as no expiry', () => {
  const card = activity({ puppet, pod, log: { text: tail({ ...heartbeat, account: { alias: 'GlowSquidye', expiresAt: null } }) }, now: NOW })
  assert.equal(card.heartbeat.account.expiresAt, null)
  assert.equal(card.heartbeat.account.warning, null)
})

// --- the token never reaches the page ---

test('a secret-shaped key in the tail reaches neither the page nor the JSON', async () => {
  const leaked = {
    ...heartbeat,
    access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2VjcmV0LXNpZ25hdHVyZQ',
    mca_token: 'mca-should-never-be-shown',
    authorization: 'Bearer should-never-be-shown',
    cookie: 'should-never-be-shown',
    password: 'should-never-be-shown',
    metrics: { ...heartbeat.metrics, client_secret: 'should-never-be-shown' },
    journal: { ...heartbeat.journal, refresh_token: 'should-never-be-shown' }
  }
  const secretFacts = activity({ puppet, pod, log: { text: tail(startLive, leaked) }, now: NOW })
  const html = renderPage({ version: 1, puppets: [puppet] }, [secretFacts])
  const json = JSON.stringify(secretFacts)
  for (const value of ['mca-should-never-be-shown', 'should-never-be-shown', 'c2VjcmV0LXNpZ25hdHVyZQ']) {
    assert.ok(!html.includes(value), 'the page does not print ' + value)
    assert.ok(!json.includes(value), 'the JSON does not carry ' + value)
  }
  // The key names too, not only the values: the panel renders a field it names,
  // so a secret-shaped key never has a row to print.
  for (const key of ['access_token', 'mca_token', 'authorization', 'cookie', 'password',
    'client_secret', 'refresh_token']) {
    assert.ok(!html.includes(key), 'the page has no row for ' + key)
    assert.ok(!json.includes(key), 'the JSON has no field named ' + key)
  }
})

test('an expired token reads as expired, not as a negative forecast', () => {
  const yesterday = NOW - 86_400_000
  const card = activity({
    puppet,
    pod,
    log: { text: tail({ ...heartbeat, account: { alias: 'GlowSquidye', expiresAt: yesterday } }) },
    now: NOW
  })
  assert.equal(card.heartbeat.account.expired, true)
  assert.equal(card.heartbeat.account.expiresInDays, -1)
  assert.match(card.heartbeat.account.warning, /expired 1 day ago/)
})

// --- the routes ---

test('/api/puppets/<name> answers the same facts the page shows', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/api/puppets/glowsquidye')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    const body = await response.json()
    assert.equal(body.name, 'glowsquidye')
    assert.equal(body.heartbeat.at, HEARTBEAT_AT)
    assert.equal(body.heartbeat.sizes.chunks, 166)
    assert.equal(body.state.state, 'serving')
    // #748: an agent reads the same row the browser does, entry by entry.
    assert.deepEqual(body.whitelist.entries, [{ uuid: V4, refusalReason: null }])
    assert.equal((await fetch(url + '/api/puppets/nobody')).status, 404)
  } finally {
    await close()
  }
})

test('/ is the card for each puppet, under the timestamp of every record', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/)
    const page = await response.text()
    assert.match(page, /serving: the newest heartbeat was written 12 s ago/)
    for (const text of [HEARTBEAT_AT, START_AT, attach.t,
      '2243099 (2.1 MiB)', 'monoplayer-84855d7f8b-5h5bd',
      'play2.excalia.fr:25565 (start, ' + START_AT + ')',
      '1 entry (startLive, ' + START_AT + '); re-read at each login',
      'monoplayer-control', 'glowsquidye.tail41e568.ts.net',
      '<h4>Body sky</h4>', '<h4>Channel holder-1</h4>']) {
      assert.ok(page.includes(text), 'the page shows ' + text)
    }
    // Every asset the page loads is served by the panel itself. The tailnet
    // Service is the only thing answering on that name, so a stylesheet, a script,
    // a font or an icon fetched from anywhere else is a request that fails on the
    // one network this page is opened from (#248).
    const urls = [...page.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1])
    assert.ok(urls.length >= 4, 'the page loads its stylesheet, htmx, its sse extension and its own script')
    for (const url of urls) {
      assert.match(url, /^\/static\//, url + ' is served by the panel, not fetched from elsewhere')
    }
    assert.match(page, /1 puppet\b/)
  } finally {
    await close()
  }
})

test('a not-ready pod reaches the page as a sentence, not a badge with no words', async () => {
  const starting = { ...pod, status: { ...pod.status, conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }] } }
  const { url, close } = await panel({ kubernetes: kube({ pods: [starting] }) })
  try {
    const page = await (await fetch(url + '/')).text()
    assert.match(page, /pod not ready: monoplayer-84855d7f8b-5h5bd is not Ready \(ContainersNotReady\)/)
    assert.match(page, /state not-ready/)
  } finally {
    await close()
  }
})

test('a body that never spawned is named as the defect it is', async () => {
  const { url, close } = await panel()
  try {
    const page = await (await fetch(url + '/')).text()
    assert.match(page, /bodies without a spawn/)
    assert.match(page, /a client was told about a body it never saw appear/)
  } finally {
    await close()
  }
})

test('the page escapes what it renders', async () => {
  const hostile = activity({
    puppet: { ...puppet, name: '<script>alert(1)</script>' },
    pod: { ...pod, metadata: { ...pod.metadata, name: '"><b>x' } },
    log: { text: tail({ ...heartbeat, account: { alias: '<img src=x onerror=alert(1)>', expiresAt: null } }) },
    now: NOW
  })
  const page = renderPage({ version: 1, puppets: [{ ...puppet, name: '<script>alert(1)</script>' }] }, [hostile])
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(page.includes('&quot;&gt;&lt;b&gt;x'))
  assert.doesNotMatch(page, /<script>alert/)
})

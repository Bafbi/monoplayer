// What one card says, and why. The page's promise is that every number carries
// the timestamp of the log line it came from, and that a puppet which is not
// serving says which fact is missing. Both are asserted here, on the HTML a
// browser gets and on the JSON an agent queries.
//
// No cluster: the API client is four functions, the log is a string, and the clock
// is fixed. The records below are the shapes docs/telemetry.md documents, copied
// from a live pod's tail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { activity } from '../../src/panel/activity.js'
import { ReadRefused } from '../../src/panel/kube.js'
import { createPanelHandler } from '../../src/panel/server.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565'
}

const HEARTBEAT_AT = '2026-11-18T10:37:12.906Z'
const HEARTBEAT_MS = Date.parse(HEARTBEAT_AT)
// Twelve seconds after the heartbeat: inside one 30 s interval, so this record is
// current and the page says "12 s".
const NOW = HEARTBEAT_MS + 12_000
const START_AT = '2026-11-18T09:00:00.000Z'

const startLive = {
  t: START_AT,
  event: 'startLive',
  version: '1.2.3',
  front: '0.0.0.0:25565',
  backend: 'play2.excalia.fr:25565',
  backendConfigured: 'play2.excalia.fr:25565',
  whitelistCount: 1,
  control: { file: '/etc/monoplayer/control', allowBackendSwitch: true, whitelistReload: true }
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
  account: { alias: 'GlowSquidye', expiresAt: Date.parse('2026-11-25T00:00:00.000Z') }
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
  assert.equal(beat.journal.sealed, 3)
  assert.equal(beat.journal.dirBytes, 7_000_000)
  assert.equal(beat.wire.checked, 0)
  assert.equal(beat.telemetry.queuedSeries, 67, 'metrics.queued is distinct series, kept apart from the log queue')
  assert.equal(beat.telemetry.queuedLogRecords, 0)
  // The effective backend comes from the start record, and the registry's copy is
  // a different fact with no timestamp.
  assert.deepEqual(backend.effective, { value: 'play2.excalia.fr:25565', source: 'start', at: START_AT })
  assert.deepEqual(backend.registry, { value: 'play2.excalia.fr:25565', source: 'registry', at: null })
  assert.deepEqual(whitelist, { count: 1, at: START_AT, source: 'startLive' })
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
  assert.equal(card.backend.configured.value, 'play2.excalia.fr:25565', 'the config document\'s target is still its own fact')
})

test('the last attach names the bodies that never spawned', () => {
  const card = facts()
  assert.equal(card.attach.tookMs, 42)
  assert.equal(card.attach.withoutSpawn, 2)
  assert.equal(card.attach.domains.chunks, 40)
})

// --- the four sentences ---

const serving = (card) => card.state.reason

test('a puppet with no pod says so, and names the Deployment', () => {
  const card = activity({ puppet, pod: null, log: null, now: NOW })
  assert.equal(card.state.state, 'no-pod')
  assert.equal(card.state.serving, false)
  assert.match(serving(card), /^no pod: Deployment monoplayer\/monoplayer has no pod/)
})

test('a pod that is not ready says why, in words', () => {
  const starting = { ...pod, status: { ...pod.status, conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }] } }
  const card = activity({ puppet, pod: starting, log: { text: '' }, now: NOW })
  assert.equal(card.state.state, 'not-ready')
  assert.match(serving(card), /^pod not ready: monoplayer-84855d7f8b-5h5bd is not Ready \(ContainersNotReady\)/)
})

test('a tail with no heartbeat says how many lines it read and how old they are', () => {
  const card = activity({ puppet, pod, log: { text: tail(startLive, attach) }, now: NOW })
  assert.equal(card.state.state, 'no-heartbeat')
  assert.match(serving(card), /^no heartbeat in the last 2 lines of monoplayer-84855d7f8b-5h5bd/)
  assert.match(serving(card), /the newest line is 2026-11-18T10:30:00\.000Z/)
})

test('a refused log read is its own sentence, with the status the API answered', () => {
  const card = activity({
    puppet,
    pod,
    log: { error: new ReadRefused('read the log of monoplayer/x: the API server answered 403 Forbidden', { status: 403 }) },
    now: NOW
  })
  assert.equal(card.state.state, 'log-refused')
  assert.match(serving(card), /^log fetch refused: read the log of monoplayer\/x: the API server answered 403 Forbidden/)
})

test('a refused Deployment read is its own sentence too', () => {
  const card = activity({
    puppet,
    failure: new ReadRefused('read Deployment monoplayer/monoplayer: the API server answered 403 Forbidden', { status: 403 }),
    now: NOW
  })
  assert.equal(card.state.state, 'read-refused')
  assert.match(serving(card), /^read refused: read Deployment/)
})

test('a panel with no API client says exactly that', async () => {
  const { readPuppet } = await import('../../src/panel/routes/info.js')
  const card = await readPuppet({ kubernetes: null, puppet, now: NOW })
  assert.equal(card.state.state, 'read-refused')
  assert.match(card.state.reason, /started without a Kubernetes client/)
})

// --- staleness and expiry ---

test('a heartbeat older than three intervals is shown as old, never as live', () => {
  const late = HEARTBEAT_MS + 10 * 60_000
  const card = activity({ puppet, pod, log: { text: tail(startLive, heartbeat) }, now: late })
  assert.equal(card.heartbeat.stale, true)
  assert.equal(card.heartbeat.ageSeconds, 600)
  assert.match(card.state.reason, /^serving: the newest heartbeat was written 600 s ago/)
  assert.match(card.state.reason, /more than three intervals, so read these numbers as old/)
  // And the timestamp a reader sees is the record's, not the clock's.
  assert.equal(card.heartbeat.at, HEARTBEAT_AT)
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
  const html = (await import('../../src/panel/routes/info.js')).renderPage({ version: 1, puppets: [puppet] }, [secretFacts])
  const json = JSON.stringify(secretFacts)
  for (const value of ['mca-should-never-be-shown', 'should-never-be-shown', 'c2VjcmV0LXNpZ25hdHVyZQ']) {
    assert.ok(!html.includes(value), 'the page does not print ' + value)
    assert.ok(!json.includes(value), 'the JSON does not carry ' + value)
  }
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
      '1 entries (startLive, ' + START_AT + ')',
      'monoplayer-control', 'glowsquidye.tail41e568.ts.net']) {
      assert.ok(page.includes(text), 'the page shows ' + text)
    }
    // One page, no asset the browser has to fetch: the panel is reached over a
    // tailnet and nothing else serves its files.
    assert.doesNotMatch(page, /<(script|link|img)\b/i, 'the page loads no external asset')
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
  const { renderPage } = await import('../../src/panel/routes/info.js')
  const page = renderPage({ version: 1, puppets: [{ ...puppet, name: '<script>alert(1)</script>' }] }, [hostile])
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(page.includes('&quot;&gt;&lt;b&gt;x'))
  assert.doesNotMatch(page, /<script>alert/)
})

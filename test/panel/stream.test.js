// The stream: GET /api/puppets/<name>/stream, held open and written to (#248).
//
// Every test here runs against a real HTTP server on a loopback port, because the
// three things that can break this route are all wire facts: a header that holds
// the frames, a frame that is not the fragment, and a timer that outlives the
// client. A handler called directly would pass while a proxy buffered the answer.
//
// The cadence is shortened to milliseconds, so the file costs no seconds. The
// default is what the page's sentence says, and it is asserted as a constant.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPanelHandler } from '../../src/panel/server.js'
import { activity } from '../../src/panel/activity.js'
import { HEARTBEAT_MS, TICK_MS } from '../../src/panel/routes/stream.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: true
}

const HEARTBEAT_AT = '2026-11-18T10:37:12.906Z'
const NOW = Date.parse(HEARTBEAT_AT) + 12_000

const tail = (...records) => records.map(record => JSON.stringify(record)).join('\n') + '\n'

const heartbeat = {
  t: HEARTBEAT_AT,
  event: 'heartbeat',
  attached: false,
  warm: true,
  backendLogins: 2,
  front: { allowed: 1 },
  journal: { enabled: true, sealed: 3 },
  wire: { checked: 0, rejected: 0 },
  telemetry: { enabled: true, logs: { queued: 0 }, metrics: { queued: 0 } },
  account: { alias: 'GlowSquidye', expiresAt: null }
}

const pod = {
  metadata: { name: 'monoplayer-84855d7f8b-5h5bd', creationTimestamp: '2026-11-18T09:00:00.000Z' },
  status: {
    phase: 'Running',
    startTime: '2026-11-18T09:00:00.000Z',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ restartCount: 0 }]
  }
}

function kube ({ log = tail(heartbeat), delayMs = 0, calls = { podLog: 0 } } = {}) {
  return {
    calls,
    async deployment () {
      return { spec: { selector: { matchLabels: { app: 'monoplayer' } } } }
    },
    async pods () {
      return { items: [pod] }
    },
    async podLog () {
      calls.podLog += 1
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return log
    }
  }
}

async function serve ({ kubernetes = kube(), tickMs = 25, heartbeatMs = 60, registry, log } = {}) {
  const server = http.createServer(createPanelHandler({
    registry: registry ?? (() => ({ version: 1, puppets: [puppet] })),
    kubernetes,
    now: () => NOW,
    tickMs,
    heartbeatMs,
    log
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

// The frames of an event stream, as the browser splits them: one block per blank
// line, a block being comment lines and data lines.
const frames = text => text.split('\n\n').filter(block => block.trim() !== '')
// Only the frames that carry a fragment. A comment heartbeat is a frame on the wire
// too, so a test that counted every frame could be satisfied by two heartbeats and
// never see a tick at all.
const datas = text => frames(text).filter(block => block.startsWith('data:'))
const dataOf = block => block.split('\n')
  .filter(line => line.startsWith('data:'))
  .map(line => line.slice(5).replace(/^ /, ''))
  .join('\n')

// Read the stream until the predicate says it has seen enough, or until the
// deadline. The stream has no end of its own, so every read here is bounded by the
// test and the connection is aborted, which is what a browser does on a reload.
async function read (url, { until = () => true, timeoutMs = 3_000 } = {}) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  // The deadline is taken once. A comparison against a fresh Date.now() on each
  // pass is always true, so a stream that stopped writing would hang the file
  // instead of failing the test.
  const deadline = Date.now() + timeoutMs
  let text = ''
  try {
    while (until(text) === false && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch { /* the abort below, or the server closing the socket */ } finally {
    controller.abort()
  }
  return { response, text }
}

test('the stream declares itself and names every header that keeps a frame moving', async () => {
  const panel = await serve()
  try {
    const { response } = await read(panel.url + '/api/puppets/glowsquidye/stream')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/event-stream; charset=utf-8$/)
    assert.equal(response.headers.get('cache-control'), 'no-store',
      'a cached tick is a page that lies about when it was read')
    assert.equal(response.headers.get('x-accel-buffering'), 'no',
      'a proxy in front of this would hold the frames until it had a buffer full')
    assert.equal(response.headers.get('content-length'), null, 'the answer has no end until the client goes')
    assert.equal(response.headers.get('content-encoding'), null, 'a compressor buffer is another place a tick waits')
  } finally {
    await panel.close()
  }
})

test('the first fragment arrives at once, and it is the live region, not a page', async () => {
  const panel = await serve()
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => frames(value).length >= 1
    })
    const fragment = dataOf(frames(text)[0])
    // The state sentence and the record's own timestamp: the two things the page
    // promises are never missing.
    assert.match(fragment, /serving: the newest heartbeat was written 12 s ago/)
    assert.match(fragment, new RegExp(HEARTBEAT_AT))
    assert.match(fragment, /<dl>/)
    assert.match(fragment, /class="stage"/)
    // The fragment is the card's body, not a document: a whole page here would be
    // a page swapped inside a page.
    assert.doesNotMatch(fragment, /<!doctype|<html|<body/i)
    assert.doesNotMatch(fragment, /sse-connect/, 'the element that opened the stream is not replaced by its own content')
  } finally {
    await panel.close()
  }
})

test('one fragment per tick, so the page updates without a reload', async () => {
  const panel = await serve({ tickMs: 20 })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => frames(value).filter(block => block.startsWith('data:')).length >= 3
    })
    const datas = frames(text).filter(block => block.startsWith('data:'))
    assert.ok(datas.length >= 3, 'three ticks arrive')
    for (const block of datas) {
      assert.match(dataOf(block), /read at 2026-11-18T10:37:24\.906Z/, 'each tick carries the instant it was read')
    }
  } finally {
    await panel.close()
  }
})

test('a comment heartbeat keeps the socket alive without inventing an event', async () => {
  const panel = await serve({ tickMs: 10_000, heartbeatMs: 20 })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => /^: heartbeat /m.test(value)
    })
    const beats = text.split('\n\n').filter(block => block.startsWith(': heartbeat'))
    assert.ok(beats.length >= 1, 'the heartbeat is a comment line')
    assert.match(beats[0], /^: heartbeat \d{4}-\d{2}-\d{2}T/)
    // A comment carries no data, so the browser dispatches nothing: an event would
    // make htmx swap the same fragment twice.
    assert.doesNotMatch(beats[0], /^data:/m)
  } finally {
    await panel.close()
  }
})

test('the heartbeat is not held up by a slow first read', async () => {
  // The first tick is three sequential API reads. A comment timer started after it
  // would leave the connection silent for as long as those reads take, which is the
  // window the comment exists to cover.
  const panel = await serve({
    kubernetes: kube({ delayMs: 400 }),
    tickMs: 10_000,
    heartbeatMs: 40
  })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => /^: heartbeat /m.test(value) && value.includes('data:'),
      timeoutMs: 3_000
    })
    const order = frames(text).map(block => (block.startsWith(':') ? 'beat' : 'data'))
    assert.equal(order[0], 'beat', 'the comment arrives before the slow read answers: ' + order.join(','))
    assert.ok(order.includes('data'), 'and the fragment still arrives')
  } finally {
    await panel.close()
  }
})

test('the stream stops reading and stops writing when the client closes', async () => {
  const calls = { podLog: 0 }
  const panel = await serve({ kubernetes: kube({ calls }), tickMs: 15 })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 2
    })
    assert.ok(text.length > 0)
    // The abort above closed the client. Nothing may read the pod again: a timer
    // that outlived its socket is a pod-log read per five seconds per closed tab,
    // for as long as the pod lives.
    const after = calls.podLog
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(calls.podLog, after, 'no tick ran after the client closed')
    // The timers themselves are unref'd, so a leaked one does not show in the
    // handle table: the assertion is on the read the timer would have made, which
    // is the cost a closed tab imposes on the API server.
  } finally {
    await panel.close()
  }
})

test('a tick that meets an unanswered read is skipped, never queued behind it', async () => {
  const calls = { podLog: 0 }
  const events = []
  // The read takes far longer than a tick, which is what a slow API server does to
  // three sequential requests.
  const panel = await serve({
    kubernetes: kube({ calls, delayMs: 150 }),
    tickMs: 10,
    log: (event, fields = {}) => events.push([event, fields])
  })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 2,
      timeoutMs: 2_000
    })
    const skipped = events.filter(([event]) => event === 'panelStreamTickSkipped')
    assert.ok(skipped.length >= 1, 'a tick that met a pending read says so in the log')
    assert.equal(skipped[0][1].puppet, 'glowsquidye')
    // Two answers, and no third read queued behind them: 20 ticks would have
    // started had each one been allowed to overlap.
    assert.ok(calls.podLog <= datas(text).length + 1,
      'the stream does not read the pod once per interval while a read is outstanding: ' + calls.podLog)
  } finally {
    await panel.close()
  }
})

test('a puppet the registry does not name is a 404 before any stream opens', async () => {
  const panel = await serve()
  try {
    const response = await fetch(panel.url + '/api/puppets/nobody/stream')
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type'), /^text\/plain/)
    assert.match(await response.text(), /no such puppet: nobody/)
  } finally {
    await panel.close()
  }
})

test('a broken registry is a 500 that names the reason, and no stream', async () => {
  const panel = await serve({ registry: () => { throw new Error('registry: puppets is empty') } })
  try {
    const response = await fetch(panel.url + '/api/puppets/glowsquidye/stream')
    assert.equal(response.status, 500)
    assert.match(await response.text(), /registry: puppets is empty/)
  } finally {
    await panel.close()
  }
})

test('the cadence is the one the page promises', () => {
  // The page says "every 5 s" in words, and a sentence a deployment detail can
  // falsify is a sentence that will be wrong.
  assert.equal(TICK_MS, 5_000)
  assert.equal(HEARTBEAT_MS, 15_000)
})

test('a recorded document travels the same path a cluster read does', async () => {
  const recorded = activity({
    puppet,
    pod,
    log: { text: tail(heartbeat) },
    now: NOW
  })
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets: [puppet] }),
    kubernetes: null,
    recorded: name => (name === puppet.name ? recorded : null),
    now: () => NOW,
    tickMs: 10
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port
  try {
    const { text } = await read(url + '/api/puppets/glowsquidye/stream', {
      until: value => frames(value).length >= 1
    })
    assert.match(dataOf(frames(text)[0]), /serving: the newest heartbeat was written 12 s ago/,
      'a recording travels the same path a cluster read does')
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

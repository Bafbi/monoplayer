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
// The repo's own deadline, from a leaf module that imports nothing: a predicate
// poll that rejects with the label of the event it never saw.
import { waitFor } from '../../src/service/cli.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
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

const ATTACH = {
  version: 1,
  players: [
    { uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi', addedAt: '2026-11-17T09:12:00.000Z' }
  ]
}

// The other control key (#309): the servers the picker offers, read by the same
// tick and carried in the same fragment as an out-of-band swap.
const ALLOWED = {
  version: 1,
  servers: [
    { host: 'paper.example.net', port: 25565, addedAt: '2026-11-23T12:00:00.000Z' }
  ]
}

function kube ({ log = tail(heartbeat), delayMs = 0, calls = { podLog: 0 }, attach = ATTACH, allowed = ALLOWED, attachFails = false } = {}) {
  return {
    calls,
    // Both control keys come from the control ConfigMap, through the same readers the
    // routes use (#232, #262). A stream tick reads them too, so each block's list
    // refreshes with the card (#248, #309).
    async configMap () {
      if (attachFails) throw new Error('read ConfigMap monoplayer/monoplayer-control: the API server answered 403 Forbidden')
      return {
        metadata: { resourceVersion: '41221' },
        data: {
          'attach-whitelist.json': JSON.stringify(attach),
          'allowed-servers.json': JSON.stringify(allowed)
        }
      }
    },
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

test('a tick carries the attach whitelist beside the live region, as an out-of-band swap', async () => {
  const panel = await serve()
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 1
    })
    const fragment = dataOf(datas(text)[0])
    // The list is in the fragment, marked for a swap into the element that holds it and
    // not into the live region: a tick must not disarm a remove button or clear a name
    // the operator is typing.
    assert.match(fragment, /<div class="attach" id="whitelist-glowsquidye" hx-swap-oob="true">/)
    assert.match(fragment, /6eb73524-ff88-4a62-a8d0-c63905e7afba/)
    assert.match(fragment, /added 2026-11-17T09:12:00\.000Z/)
    assert.match(fragment, /and the attach whitelist read at 2026-11-18T10:37:24\.906Z at ConfigMap resourceVersion 41221 \(a version, not a time\)/)
    // The live region's own element is not in the fragment, so the out-of-band swap is
    // the only way the list gets there.
    assert.doesNotMatch(fragment, /class="live"/)
  } finally {
    await panel.close()
  }
})

test('a tick carries the allowed servers beside the live region, as an out-of-band swap', async () => {
  const panel = await serve()
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 1
    })
    const fragment = dataOf(datas(text)[0])
    // The list is in the fragment, marked for a swap into the element that holds it:
    // an added server appears without a reload, and a half-typed address survives.
    assert.match(fragment, /<div class="allowed" id="allowed-glowsquidye" hx-swap-oob="true">/)
    assert.match(fragment, /paper\.example\.net:25565/)
    assert.match(fragment, /added 2026-11-23T12:00:00\.000Z/)
    assert.match(fragment, /and the allowed servers read at 2026-11-18T10:37:24\.906Z at ConfigMap resourceVersion 41221 \(a version, not a time\)/)
    // The add form and the answer area are outside the swapped element, so a tick
    // cannot clear what the operator typed or a refusal they are reading.
    assert.doesNotMatch(fragment, /data-write="add-server"/)
  } finally {
    await panel.close()
  }
})

test('a whitelist read that failed is a sentence in the block, not a lost tick', async () => {
  const panel = await serve({ kubernetes: kube({ attachFails: true }) })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 1
    })
    const fragment = dataOf(datas(text)[0])
    assert.match(fragment, /the attach whitelist could not be read: read ConfigMap monoplayer\/monoplayer-control: the API server answered 403 Forbidden/)
    // The same failed read is the other block's sentence too: one refused ConfigMap
    // read, two lists that say why they are missing.
    assert.match(fragment, /the allowed servers could not be read: read ConfigMap monoplayer\/monoplayer-control: the API server answered 403 Forbidden/)
    // And the card is still the card: one failed read of one object does not cost the
    // rest of the fragment.
    assert.match(fragment, /serving: the newest heartbeat was written 12 s ago/)
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
  const events = []
  const tickMs = 15
  const panel = await serve({
    kubernetes: kube({ calls }),
    tickMs,
    log: (event, fields = {}) => events.push([event, fields])
  })
  try {
    const { text } = await read(panel.url + '/api/puppets/glowsquidye/stream', {
      until: value => datas(value).length >= 2
    })
    assert.ok(text.length > 0)
    // The abort above closed the client, but the server learns that on its own
    // schedule: the socket close is a later turn of the event loop than the abort,
    // and under a full suite on a loaded machine it is later still. Waiting for the
    // route to say it stopped is the event; a sleep here instead asked the server to
    // have noticed within the sleep, which is what made this line fail about once
    // per full-suite run at 15 ms ticks (#330).
    await waitFor(() => events.some(([event]) => event === 'panelStreamEnd'),
      'the stream to report that it stopped', 2_000)
    const ended = events.find(([event]) => event === 'panelStreamEnd')
    assert.equal(ended[1].puppet, 'glowsquidye', 'the end names the puppet whose stream ended')
    // One interval after the end, for the read a tick had already started: the route
    // checks for the close around its reads and not before them, so a tick that began
    // in the gap above still finishes one read. That read is not a leak, and the
    // snapshot below must not count it. This fake answers in a turn, so the read
    // usually lands long before now; a fake that waited would land here.
    await new Promise(resolve => setTimeout(resolve, tickMs))
    // Nothing may read the pod again: a timer that outlived its socket is a
    // pod-log read per five seconds per closed tab, for as long as the pod lives.
    // The window is the other half of the claim and not the wait: the event above
    // says the route stopped, and eight tick intervals say the timer that would have
    // read again is cleared.
    const after = calls.podLog
    await new Promise(resolve => setTimeout(resolve, 8 * tickMs))
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

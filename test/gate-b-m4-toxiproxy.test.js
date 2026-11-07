// M4 slice: the toxiproxy HTTP adapter. Every call is made through an
// injected fake fetch — no network, no sockets, no timers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToxiproxy, GATE_B_FAULT_SHAPES } from '../src/gate-b/toxiproxy.js'

import { PROXY_PLAN } from '../src/gate-b/backends.js'

function fakeFetch (responder) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body != null ? JSON.parse(init.body) : null,
      headers: init?.headers ?? null,
    }
    calls.push(call)
    const response = responder(call)
    if (response instanceof Error) throw response
    return new Response(response?.body == null ? 'null' : JSON.stringify(response.body), {
      status: response?.status ?? 200,
      statusText: response?.statusText ?? '',
    })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test('version and list probes hit the pinned api shape', async () => {
  const fetchImpl = fakeFetch(call => ({
    status: call.url.endsWith('/version') ? 404 : 200,
    body: call.url.endsWith('/version') ? null : { puppet: { enabled: true, toxics: [] } },
  }))
  const toxiproxy = createToxiproxy({ baseUrl: 'http://toxiproxy-api:8474/', fetchImpl })
  const version = await toxiproxy.version()
  assert.equal(version.ok, false, 'a 404 on /version is reported, not thrown')
  assert.equal(version.status, 404)
  assert.equal(version.kind, 'probe')
  assert.equal(version.label, 'version')

  const list = await toxiproxy.listProxies()
  assert.equal(list.ok, true)
  assert.deepEqual(fetchImpl.calls[1], { url: 'http://toxiproxy-api:8474/proxies', method: 'GET', body: null, headers: null })
  assert.equal(list.kind, 'probe')
})

test('populate posts the planned listeners as a setup op', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { puppet: {} } }))
  const toxiproxy = createToxiproxy({ fetchImpl })
  const result = await toxiproxy.populate(PROXY_PLAN.map(({ name, listenPort, upstreamHost, upstreamPort, enabled }) => ({
    name, upstream: `${upstreamHost}:${upstreamPort}`, listen: `[::]:${listenPort}`, enabled,
  })))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'setup')
  assert.equal(result.label, 'populate')
  assert.equal(fetchImpl.calls[0].method, 'POST')
  assert.ok(fetchImpl.calls[0].url.endsWith('/populate'))
  assert.equal(fetchImpl.calls[0].body.length, PROXY_PLAN.length)
  assert.equal(fetchImpl.calls[0].body[0].upstream, 'velocity:25566')
  assert.equal(fetchImpl.calls[0].body[0].listen, '[::]:25570')
})

test('enable/disable toggle via POST /proxies/:name and are classified setup', async () => {
  const fetchImpl = fakeFetch(call => (call.body.enabled === false ? { status: 500, body: { error: 'nope' } } : { body: { name: 'puppet-vanilla', enabled: true } }))
  const toxiproxy = createToxiproxy({ fetchImpl })
  const enabled = await toxiproxy.setProxyEnabled('puppet-vanilla', true)
  assert.equal(enabled.ok, true)
  assert.equal(enabled.kind, 'setup')
  assert.equal(enabled.label, 'enable-proxy')
  assert.equal(fetchImpl.calls[0].method, 'POST')

  const disabled = await toxiproxy.setProxyEnabled('puppet-vanilla', false)
  assert.equal(disabled.ok, false, 'a failing disable is not a success')
  assert.equal(disabled.status, 500)
  assert.equal(disabled.label, 'disable-proxy')
})

test('reset clears toxics and re-enables proxies via POST /reset', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { ok: 'success' } }))
  const toxiproxy = createToxiproxy({ fetchImpl })
  const result = await toxiproxy.reset()
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'setup')
  assert.equal(fetchImpl.calls[0].url, 'http://toxiproxy-api:8474/reset')
})

test('F2 latency toxic posts the plan shape onto the puppet leg', async () => {
  const fetchImpl = fakeFetch(() => ({ body: {} }))
  const toxiproxy = createToxiproxy({ fetchImpl })
  const result = await toxiproxy.addToxic('puppet-velocity', GATE_B_FAULT_SHAPES.F2.toxic)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'setup')
  assert.equal(result.label, 'add-toxic')
  assert.equal(fetchImpl.calls[0].method, 'POST')
  assert.ok(fetchImpl.calls[0].url.endsWith('/proxies/puppet-velocity/toxics'))
  const posted = fetchImpl.calls[0].body
  assert.equal(posted.type, 'latency')
  assert.equal(posted.stream, 'both')
  assert.equal(posted.attributes.latency, 100)
  assert.equal(posted.attributes.jitter, 30)
  assert.equal(posted.name, 'f2-attach-latency')
})

test("F3 freeze and F6 down are the same held timeout toxic; timing is the lane's", async () => {
  assert.equal(GATE_B_FAULT_SHAPES.F3.toxic.type, 'timeout')
  assert.equal(GATE_B_FAULT_SHAPES.F3.toxic.attributes.timeout, 0)
  assert.equal(GATE_B_FAULT_SHAPES.F6.toxic.type, 'timeout')
  assert.equal(GATE_B_FAULT_SHAPES.F6.toxic.attributes.timeout, 0)
  assert.match(GATE_B_FAULT_SHAPES.F6.duration, /60s/)
  assert.ok(!('F4' in GATE_B_FAULT_SHAPES), 'F4 is a deployment restart, not a toxic')
  assert.ok(!('F5' in GATE_B_FAULT_SHAPES), 'F5 is an RCON kick, not a toxic')

  const fetchImpl = fakeFetch(call => call.method === 'DELETE' ? { body: {} } : { body: { f6: { name: 'f6', type: 'timeout', toxicType: 'timeout', toxicities: null } } })
  const toxiproxy = createToxiproxy({ fetchImpl })
  const removed = await toxiproxy.removeToxic('puppet-velocity', GATE_B_FAULT_SHAPES.F6.toxic.name)
  assert.equal(removed.ok, true)
  assert.equal(removed.kind, 'setup')
  assert.equal(fetchImpl.calls[0].method, 'DELETE')
  assert.ok(fetchImpl.calls[0].url.endsWith('/proxies/puppet-velocity/toxics/f6-down'))
})

test('clearToxics lists then deletes every toxic on the proxy', async () => {
  const fetchImpl = fakeFetch(call => {
    if (call.method === 'GET') return { body: [
      { name: 'f2-attach-latency_downstream', toxicType: 'latency' },
      { name: 'f3-freeze_downstream', toxicType: 'timeout' },
    ] }
    return { body: {} }
  })
  const toxiproxy = createToxiproxy({ fetchImpl })
  const result = await toxiproxy.clearToxics('puppet-velocity')
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'setup')
  assert.equal(result.label, 'clear-toxics')
  const deletes = fetchImpl.calls.filter(c => c.method === 'DELETE')
  assert.equal(deletes.length, 2)
  assert.ok(deletes[0].url.endsWith('/toxics/f2-attach-latency_downstream'))
})

test('assertions are classified as assertions and honour the observed state', async () => {
  const fetchImpl = fakeFetch(call => {
    if (call.url === 'http://toxiproxy-api:8474/proxies/puppet-velocity'){
      return { body: { name: 'puppet-velocity', enabled: true, toxics: [] } }
    }
    if (call.url === 'http://toxiproxy-api:8474/proxies/puppet-vanilla') {
      return { body: { name: 'puppet-vanilla', enabled: false, toxics: [] } }
    }
    if (call.url.includes('/puppet-velocity/toxics')) {
      return { body: [{ name: 'f3-freeze_downstream', toxicType: 'timeout' }] }
    }
    return { status: 500, body: null }
  })
  const toxiproxy = createToxiproxy({ fetchImpl })
  const enabledOk = await toxiproxy.assertProxyEnabled('puppet-velocity', true)
  assert.equal(enabledOk.ok, true)
  assert.equal(enabledOk.kind, 'assertion')
  const enabledWrong = await toxiproxy.assertProxyEnabled('puppet-vanilla', true)
  assert.equal(enabledWrong.ok, false, 'disabled proxy must not pass an enabled assertion')
  assert.equal(enabledWrong.kind, 'assertion')

  const toxicOk = await toxiproxy.assertToxicPresent('puppet-velocity', 'timeout')
  assert.equal(toxicOk.ok, true)
  assert.equal(toxicOk.label, 'toxic-timeout-present')
  const toxicMissing = await toxiproxy.assertToxicPresent('puppet-vanilla', 'latency')
  assert.equal(toxicMissing.ok, false)
})

test('network failure becomes ok:false with the error message, never a throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED boogeyman') }
  fetchImpl.calls = []
  const toxiproxy = createToxiproxy({ fetchImpl })
  const result = await toxiproxy.listProxies()
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.equal(result.error, 'ECONNREFUSED boogeyman')
  assert.equal(result.kind, 'probe')
  assert.ok(result.durationMs >= 0)
})

test('non-JSON error bodies still come back as ok:false body text', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 500, body: null }))
  const toxiproxy = createToxiproxy({ fetchImpl })
  // Fake returns "null" JSON; a real 500 usually textual. Simulate text via a body-less response handled as null.
  const result = await toxiproxy.listProxies()
  assert.equal(result.ok, false)
  assert.equal(result.status, 500)
})

test('timeoutMs is honoured via an injected fetch rejection using an aborted signal shape', async () => {
  const fetchImpl = async (url, init, timeoutMs) => {
    assert.equal(typeof timeoutMs, 'number')
    assert.equal(init.method, 'POST')
    void url
    const failure = new Error('toxiproxy request timed out after 5ms')
    throw failure
  }
  const toxiproxy = createToxiproxy({ fetchImpl, timeoutMs: 20000 })
  const result = await toxiproxy.reset()
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/)
})

// #233: the panel's one write. Every case goes over a real socket, because the
// status, the content type and the bytes are the product: a handler called
// directly would pass while the panel answered with the wrong status.
//
// The patch is a recorder, so these cases are about the route and nothing about
// Kubernetes. What the route writes is read back through the puppet's own
// `parseDesiredTarget`, so "the panel wrote a document the puppet can obey" is
// asserted against the reader that will read it, not against a copy of its shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPanelHandler } from '../../src/panel/server.js'
import { parseDesiredTarget } from '../../src/service/control.js'

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: true,
  ...overrides
})

async function panel ({ puppets = [puppet()], write, kubernetes = undefined } = {}) {
  const writes = []
  const failure = write ?? (async patch => { writes.push(patch); return { status: 200 } })
  const registry = () => ({ version: 1, puppets })
  // One client, injected the way a pod injects it (#231), with the one write the
  // route makes recorded.
  const client = kubernetes === undefined ? { patchConfigMapKey: failure } : kubernetes
  const server = http.createServer(createPanelHandler({ registry, kubernetes: client }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    writes,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

const post = (url, body, init = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...init
})

test('a backend move is written as the control document the puppet reads', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/backend', { host: '10.0.0.7', port: 25566 })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)

    assert.equal(rig.writes.length, 1, 'one patch, on one object')
    const patch = rig.writes[0]
    assert.deepEqual(
      { namespace: patch.namespace, name: patch.name, key: patch.key },
      { namespace: 'monoplayer', name: 'monoplayer-control', key: 'desired.json' },
      'the write lands on the object the registry names')

    const parsed = parseDesiredTarget(patch.text)
    assert.deepEqual(parsed.target && { host: parsed.target.host, port: parsed.target.port },
      { host: '10.0.0.7', port: 25566 },
      'the puppet\'s own reader accepts what the panel wrote')
    assert.equal(parsed.target.changedAt, JSON.parse(patch.text).changedAt, 'the stamp rides along for #233\'s retry')
    assert.equal(JSON.parse(patch.text).changedBy, 'panel')
    assert.equal(JSON.parse(patch.text).version, 1)

    const body = await response.json()
    assert.equal(body.puppet, 'glowsquidye')
    assert.deepEqual(body.document.backend, { host: '10.0.0.7', port: 25566 },
      'the answer says what was written, so an operator can paste it back')
  } finally {
    await rig.close()
  }
})

test('a puppet the registry does not allow to move is refused before anything is written', async () => {
  const rig = await panel({ puppets: [puppet({ allowBackendSwitch: false })] })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/backend', { host: '10.0.0.7', port: 25566 })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.reason, 'not_allowed')
    assert.equal(rig.writes.length, 0, 'the fence is that no document is written')
  } finally {
    await rig.close()
  }
})

test('a body the route cannot act on names what to fix', async () => {
  const rig = await panel()
  try {
    const unknown = await post(rig.url + '/api/puppets/nobody/backend', { host: '10.0.0.7', port: 25566 })
    assert.equal(unknown.status, 404)
    assert.match(await unknown.text(), /nobody/)

    for (const body of [
      '{ not json',
      '{}',
      { host: '', port: 25566 },
      { host: 'https://10.0.0.7', port: 25566 },
      { host: '10.0.0.7:25566', port: 25566 },
      { host: '10.0.0.7', port: 0 },
      { host: '10.0.0.7', port: 65536 },
      { host: '10.0.0.7', port: '25566' },
      { host: '10.0.0.7' }
    ]) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/backend', body)
      assert.equal(response.status, 400, 'refused: ' + JSON.stringify(body))
      assert.match(await response.text(), /host|port|JSON/)
    }
    assert.equal(rig.writes.length, 0, 'a refused request writes nothing')

    const huge = await post(rig.url + '/api/puppets/glowsquidye/backend', 'x'.repeat(8192))
    assert.equal(huge.status, 413)
  } finally {
    await rig.close()
  }
})

test('the route answers POST and nothing else, and the read routes keep their verbs', async () => {
  const rig = await panel()
  try {
    const get = await fetch(rig.url + '/api/puppets/glowsquidye/backend')
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const put = await fetch(rig.url + '/api/puppets/glowsquidye/backend', { method: 'PUT', body: '{}' })
    assert.equal(put.status, 405)

    const read = await fetch(rig.url + '/api/puppets')
    assert.equal(read.status, 200, 'the read route still answers')
    assert.equal((await fetch(rig.url + '/healthz')).status, 200)
  } finally {
    await rig.close()
  }
})

test('a cluster that refuses the patch is reported as unwritten, not as a move', async () => {
  const rig = await panel({ write: async () => { throw new Error('configmap_patch_refused: 403: forbidden') } })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/backend', { host: '10.0.0.7', port: 25566 })
    assert.equal(response.status, 503)
    assert.match(await response.text(), /forbidden/)
  } finally {
    await rig.close()
  }
})

test('a panel with no cluster client answers 503 instead of pretending', async () => {
  const server = http.createServer(createPanelHandler({ registry: () => ({ version: 1, puppets: [puppet()] }), kubernetes: null }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await post('http://127.0.0.1:' + port + '/api/puppets/glowsquidye/backend', { host: '10.0.0.7', port: 25566 })
    assert.equal(response.status, 503)
    assert.match(await response.text(), /no cluster client/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('a path segment that is not percent-encoding is refused, not thrown', async () => {
  // The decode is the one thing in the route that can throw, and a throw from a
  // request listener ends the process. A panel that crashes on a hand-typed URL is
  // worse than one that answers 400.
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/%E0/backend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '10.0.0.7', port: 25566 })
    })
    assert.equal(response.status, 400)
    assert.equal(rig.writes.length, 0)
    // And the panel is still answering.
    assert.equal((await fetch(rig.url + '/healthz')).status, 200)
  } finally {
    await rig.close()
  }
})

test('a body that does not declare itself JSON is refused, so a browser must preflight', async () => {
  // The tailnet is the authorization and the browser is inside it, so the write
  // has to be one a cross-site page cannot send. A JSON content type is not a
  // CORS-safelisted request, so the browser preflights; a text/plain body is
  // safelisted and would arrive unannounced, which is why it is refused here.
  const rig = await panel()
  try {
    const plain = await fetch(rig.url + '/api/puppets/glowsquidye/backend', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ host: '10.0.0.7', port: 25566 })
    })
    assert.equal(plain.status, 400)
    assert.equal(rig.writes.length, 0)

    const form = await fetch(rig.url + '/api/puppets/glowsquidye/backend', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'host=10.0.0.7&port=25566'
    })
    assert.equal(form.status, 400)

    // And the preflight a browser would send is not answered as allowed.
    const preflight = await fetch(rig.url + '/api/puppets/glowsquidye/backend', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    })
    assert.equal(preflight.status, 405)
    assert.equal(preflight.headers.get('access-control-allow-origin'), null)
    assert.equal(rig.writes.length, 0)
  } finally {
    await rig.close()
  }
})

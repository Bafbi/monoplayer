// The panel's surface, asserted on the wire: a real http server on a loopback
// port, and the status, the content type, and the bytes a browser receives. A
// handler called directly would pass while the server sent the wrong status or
// no content type, and this is the whole product today.
//
// The puppet cards (#231) have their own file, test/panel/info.test.js. Here the
// API client is a stub that answers "no pod", because what this file checks is the
// surface around the cards: the probe, the registry list, the 500, the 405.
//
// /healthz is the interesting one. It is the readiness and liveness probe, so it
// must answer while the registry is broken: a panel that fails its probe when the
// registry cannot be read is a pod that restarts forever instead of showing the
// operator what is wrong. The registry here throws, and the route still answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPanelHandler } from '../../src/panel/server.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
}

const registry = () => ({ version: 1, puppets: [puppet] })

// The panel's read path, answering what a cluster with no pod would: the registry
// facts are on the page, and the card says why there are no others.
const kubernetes = {
  deployment: async () => ({ spec: { selector: { matchLabels: { app: 'monoplayer' } } } }),
  pods: async () => ({ items: [] }),
  podLog: async () => ''
}

async function panel (options = {}) {
  const server = http.createServer(createPanelHandler({ registry, kubernetes, ...options }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

test('/healthz answers without reading the registry', async () => {
  const broken = await panel({ registry: () => { throw new Error('registry: puppets is empty') } })
  try {
    const response = await fetch(broken.url + '/healthz')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    await broken.close()
  }
})

test('/api/puppets serves the registry as JSON', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/api/puppets')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.deepEqual(await response.json(), { version: 1, puppets: [puppet] })
    // A query string is not part of the route: a browser or a curl that adds one
    // still gets the list.
    const withQuery = await fetch(url + '/api/puppets?cache=0')
    assert.equal(withQuery.status, 200)
  } finally {
    await close()
  }
})

test('/ is the page a human opens, naming each puppet and its targets', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/)
    const page = await response.text()
    for (const text of [puppet.name, puppet.namespace, puppet.frontHostname, puppet.backend,
      puppet.deployment, puppet.controlConfigMap]) {
      assert.ok(page.includes(text), 'the page names ' + text)
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
  } finally {
    await close()
  }
})

test('the page says which puppet count it is showing', async () => {
  const { url, close } = await panel()
  try {
    const page = await (await fetch(url + '/')).text()
    assert.match(page, /1 puppet\b/)
  } finally {
    await close()
  }
})

test('a registry the panel cannot read is a 500 that names the reason', async () => {
  const { url, close } = await panel({
    registry: () => { throw new Error('registry: puppets[0].backend must be host:port, not "play2"') }
  })
  try {
    for (const route of ['/', '/api/puppets']) {
      const response = await fetch(url + route)
      assert.equal(response.status, 500, route + ' reports the broken registry')
      assert.match(await response.text(), /backend must be host:port/, route + ' names the reason')
    }
  } finally {
    await close()
  }
})

test('the handler answers GET and refuses everything else', async () => {
  const { url, close } = await panel()
  try {
    const refused = await fetch(url + '/api/puppets', { method: 'POST' })
    assert.equal(refused.status, 405)
    assert.equal(refused.headers.get('allow'), 'GET')
    assert.equal((await fetch(url + '/nothing')).status, 404)
    // A panel is a read-only page today, so a write method is refused before the
    // route is even looked at.
    assert.equal((await fetch(url + '/nothing', { method: 'DELETE' })).status, 405)
  } finally {
    await close()
  }
})

test('a puppet the registry does not name is a 404, not an empty card', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/api/puppets/nobody')
    assert.equal(response.status, 404)
    assert.match(await response.text(), /no such puppet: nobody/)
    // '/api/puppets' is the registry list, and it is not read as a puppet name.
    assert.equal((await fetch(url + '/api/puppets')).status, 200)
  } finally {
    await close()
  }
})

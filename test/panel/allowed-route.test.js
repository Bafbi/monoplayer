// #262: the panel's allowed-server route. Every case goes over a real socket,
// because the status, the content type, and the bytes are the product.
//
// The cluster is a fake that holds two ConfigMaps as text: the puppet's control
// document, which the route writes, and the seed copy Git commits, which answers
// when the live key is absent. It applies the merge patch the route sends, so "the
// panel did not clobber a key it does not own" and "a lost race was re-read" are
// asserted against state rather than against a call log.
//
// What the route writes is read back through the lane's own reader,
// `createControlDocument(...).allowedServers()`, so "the picker can offer what the
// panel wrote" (#265) is asserted against the code that will read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createPanelHandler } from '../../src/panel/server.js'
import { mergePatchBody, ReadRefused, WriteRefused } from '../../src/panel/kube.js'
import { createControlDocument } from '../../src/service/control.js'
import { ALLOWED_KEY } from '../../src/panel/routes/allowed.js'

const CONTROL = 'monoplayer-control'
const SEED = 'monoplayer-config'
const PAPER = { host: 'paper.example.net', port: 25565 }
const SKY = { host: 'sky.example.net', port: 25565 }
const NOW = Date.parse('2026-11-23T12:00:00.000Z')

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: CONTROL,
  seedConfigMap: SEED,
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'paper.example.net:25565',
  allowBackendSwitch: false,
  ...overrides
})

const document = servers => ({ version: 1, servers })
const text = doc => JSON.stringify(doc, null, 2) + '\n'

// The cluster, as two ConfigMaps held as text plus a version. `conflicts` is how
// many patches report 409 before one lands, and each one also rewrites the live
// document the way a second writer would, so a panel that forgot to re-read is
// caught by the result.
function cluster ({
  live = text(document([PAPER])),
  liveKey = true,
  seed = text(document([PAPER, SKY])),
  seedKey = true,
  seedRefused = null,
  conflicts = 0,
  refuse = null
} = {}) {
  const state = { text: live, version: 1, liveKey, seed, seedKey, reads: 0, patches: [], conflicts }
  return {
    state,
    client: {
      async configMap (namespace, name) {
        state.reads += 1
        assert.equal(namespace, puppet().namespace)
        if (name === SEED) {
          if (seedRefused !== null) throw new ReadRefused(seedRefused, { status: 404 })
          return {
            metadata: { name, namespace, resourceVersion: '900' },
            data: state.seedKey ? { [ALLOWED_KEY]: state.seed, 'attach-whitelist.json': '{}' } : {}
          }
        }
        assert.equal(name, CONTROL, 'the read asks for the ConfigMap the registry names')
        return {
          metadata: { name, namespace, resourceVersion: String(state.version) },
          data: state.liveKey ? { [ALLOWED_KEY]: state.text, 'desired.json': '{"version":1}' } : { 'desired.json': '{"version":1}' }
        }
      },
      async patchConfigMapKey (patch) {
        state.patches.push(patch)
        if (typeof refuse === 'function') return refuse(patch)
        const body = JSON.parse(mergePatchBody(patch))
        assert.equal(patch.namespace, puppet().namespace)
        assert.equal(patch.name, CONTROL, 'the panel writes the object the registry names')
        assert.equal(Object.keys(body.data).length, 1, 'one key is patched, and only that key')
        assert.equal(body.metadata.resourceVersion, String(state.version), 'the patch carries the version it read')
        if (state.conflicts > 0) {
          state.conflicts -= 1
          const raced = JSON.parse(state.text)
          if (!raced.servers.some(server => server.host === 'racer.example.net')) {
            raced.servers.push({ host: 'racer.example.net', port: 25565 })
          }
          state.text = JSON.stringify(raced, null, 2) + '\n'
          state.version += 1
          state.liveKey = true
          throw new WriteRefused('write ' + ALLOWED_KEY + ' in ConfigMap ' + CONTROL + ': the API server answered 409: ' +
            'the object has been modified; please apply your changes to the latest version and try again', { status: 409 })
        }
        state.text = body.data[ALLOWED_KEY]
        state.liveKey = true
        state.version += 1
        return { namespace: patch.namespace, name: patch.name, key: patch.key, status: 200, resourceVersion: String(state.version) }
      }
    }
  }
}

async function panel ({ cluster: made = cluster(), puppets = [puppet()], kubernetes, log } = {}) {
  const lines = []
  const record = log ?? ((event, fields) => lines.push({ event, ...fields }))
  const client = kubernetes === undefined ? made.client : kubernetes
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets }),
    kubernetes: client,
    log: record,
    now: () => NOW
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    state: made.state,
    lines: () => lines,
    // The lane's own reader, over the text the patch left behind.
    laneReads: (seedText = null) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-allowed-'))
      const file = path.join(dir, 'allowed-servers.json')
      const seedFile = path.join(dir, 'seed.json')
      fs.writeFileSync(file, made.state.text)
      if (seedText !== null) fs.writeFileSync(seedFile, seedText)
      return createControlDocument({
        allowedServersFile: file,
        allowedServersSeedFile: seedText === null ? null : seedFile
      }).allowedServers()
    },
    close: () => new Promise(resolve => server.close(resolve))
  }
}

const post = (url, body, init = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...init
})

test('GET is the live list, with both ConfigMap names and the version it was read at', async () => {
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const body = await response.json()
    assert.equal(body.puppet, 'glowsquidye')
    assert.equal(body.controlConfigMap, CONTROL)
    assert.equal(body.seedConfigMap, SEED, 'the answer names the file the fallback reads')
    assert.equal(body.key, ALLOWED_KEY)
    assert.equal(body.source, 'control')
    assert.equal(body.resourceVersion, '1')
    assert.equal(body.count, 1)
    assert.deepEqual(body.servers.map(server => server.host), [PAPER.host])
    assert.equal(rig.state.patches.length, 0, 'a read writes nothing')
    assert.equal(rig.lines().length, 0, 'a read that answered says nothing')
  } finally {
    await rig.close()
  }
})

test('GET with no live key lists the copy Git commits, and says so', async () => {
  const rig = await panel({ cluster: cluster({ liveKey: false }) })
  try {
    const body = await (await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')).json()
    assert.equal(body.source, 'seed')
    assert.deepEqual(body.servers.map(server => server.host), [PAPER.host, SKY.host],
      'the seed is the list an unedited lane offers')
  } finally {
    await rig.close()
  }
})

test('POST adds one server, and the lane\'s own reader sees it', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', SKY)
    assert.equal(response.status, 200)
    assert.equal(rig.state.patches.length, 1, 'one patch')
    assert.equal(rig.state.patches[0].key, ALLOWED_KEY)

    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host + ':' + server.port),
      ['paper.example.net:25565', 'sky.example.net:25565'],
      'the list the picker would offer is the one the panel wrote')

    const body = await response.json()
    assert.equal(body.changed, true)
    assert.equal(body.count, 2)
    assert.equal(body.source, 'control')
    // The window is the next offer, not the next boot. #265 is what reads it, so the
    // answer may not promise an offer that does not exist yet.
    assert.match(body.takesEffect, /no lane reads this key yet/)
    assert.match(body.takesEffect, /#265/)

    const audit = rig.lines().find(line => line.event === 'panelAllowedServerAdd')
    assert.ok(audit, 'the write is audited')
    assert.equal(audit.server, 'sky.example.net:25565')
    assert.equal(audit.count, 2)
    assert.ok('address' in audit, 'the peer is the actor the panel can name')
  } finally {
    await rig.close()
  }
})

test('a first write is built on the seed, so it does not silently drop the servers Git offers', async () => {
  const rig = await panel({ cluster: cluster({ liveKey: false }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers',
      { host: 'new.example.net', port: 25565 })
    assert.equal(response.status, 200)
    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host),
      [PAPER.host, SKY.host, 'new.example.net'],
      'the committed list survives the first panel write, which is what the lane was already offering')
    const body = await response.json()
    assert.equal(body.changed, true)
  } finally {
    await rig.close()
  }
})

test('a server already in the list is a no-op, not a second row', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', PAPER)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.changed, false)
    assert.equal(body.count, 1)
    assert.equal(rig.state.patches.length, 0, 'nothing was written for a document that already says it')
  } finally {
    await rig.close()
  }
})

test('DELETE removes by address, and the lane\'s own reader agrees', async () => {
  const rig = await panel({ cluster: cluster({ live: text(document([PAPER, SKY])) }) })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/sky.example.net:25565',
      { method: 'DELETE' })
    assert.equal(response.status, 200)
    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host), [PAPER.host])
    const body = await response.json()
    assert.equal(body.changed, true)
    assert.deepEqual(body.removed, { host: SKY.host, port: SKY.port })
    assert.ok(rig.lines().some(line => line.event === 'panelAllowedServerRemove'))
  } finally {
    await rig.close()
  }
})

test('a server that is not in the list is a 404, and nothing is written', async () => {
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/sky.example.net:25565',
      { method: 'DELETE' })
    assert.equal(response.status, 404)
    assert.match(await response.text(), /nothing was removed/)
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('an address the dialog could not name is refused before it is stored', async () => {
  const rig = await panel()
  try {
    for (const body of [
      { host: 'https://paper.example.net', port: 25565 },
      { host: 'paper.example.net:25565', port: 25565 },
      { host: 'paper', port: 25565 },
      { host: 'paper.example.net', port: '25565' },
      { host: 'paper.example.net' },
      { port: 25565 },
      { host: '', port: 25565 }
    ]) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', body)
      assert.equal(response.status, 400, JSON.stringify(body) + ' is refused')
      assert.match(await response.text(), /host must be a hostname or an IPv4 address/)
    }
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('a path segment that is not an address names what to fix', async () => {
  const rig = await panel()
  try {
    const noPort = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/sky.example.net', { method: 'DELETE' })
    assert.equal(noPort.status, 400)
    assert.match(await noPort.text(), /host:port/)

    const badEncode = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/%E0%A4%A', { method: 'DELETE' })
    assert.equal(badEncode.status, 400)
    assert.match(await badEncode.text(), /percent-encoding/)
  } finally {
    await rig.close()
  }
})

test('a live document that does not parse is refused, never rewritten', async () => {
  const broken = '{"version": 1, "servers": [{"host": "paper.example.net"}]}'
  const rig = await panel({ cluster: cluster({ live: broken }) })
  try {
    const listed = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(listed.status, 500)
    assert.match(await listed.text(), /not touched/)

    const written = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', SKY)
    assert.equal(written.status, 500)
    assert.equal(rig.state.text, broken, 'the document is byte for byte what the operator left')
    assert.equal(rig.state.patches.length, 0)
    assert.ok(rig.lines().some(line => line.event === 'panelAllowedUnreadable'))
  } finally {
    await rig.close()
  }
})

test('a live key that is absent and a seed that does not parse is refused by the seed\'s name', async () => {
  const rig = await panel({ cluster: cluster({ liveKey: false, seed: 'not json' }) })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(response.status, 500)
    const said = await response.text()
    assert.match(said, new RegExp(SEED), 'the refusal names the file that did not parse')
    assert.match(said, /not JSON/)
  } finally {
    await rig.close()
  }
})

test('a lost race is re-read and re-applied, and the other writer\'s server survives', async () => {
  const rig = await panel({ cluster: cluster({ conflicts: 1 }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', SKY)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.attempts, 2)
    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host).sort(),
      ['paper.example.net', 'racer.example.net', 'sky.example.net'],
      'the entry the other writer landed between the read and the patch is still there')
    assert.equal(rig.state.patches.length, 2)
  } finally {
    await rig.close()
  }
})

test('three lost races are reported by name, and nothing pretends to have landed', async () => {
  const rig = await panel({ cluster: cluster({ conflicts: 3 }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', SKY)
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.reason, 'conflict')
    assert.equal(body.attempts, 3)
    assert.equal(rig.state.patches.length, 3)
    assert.ok(rig.lines().some(line => line.event === 'panelAllowedConflict'))
  } finally {
    await rig.close()
  }
})

test('the route answers its own verbs, and the read guard keeps the rest', async () => {
  const rig = await panel()
  try {
    const wrong = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers', { method: 'PUT' })
    assert.equal(wrong.status, 405)
    assert.equal(wrong.headers.get('allow'), 'GET, POST')

    const entryWrong = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/sky.example.net:25565',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(entryWrong.status, 405)
    assert.equal(entryWrong.headers.get('allow'), 'DELETE')

    const elsewhere = await fetch(rig.url + '/api/puppets/glowsquidye', { method: 'POST' })
    assert.equal(elsewhere.status, 405, 'the read routes are still GET only')
    assert.equal(elsewhere.headers.get('allow'), 'GET')
  } finally {
    await rig.close()
  }
})

test('a body that does not declare itself JSON is refused, so a browser must preflight', async () => {
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(SKY)
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /application\/json/)
    assert.equal(rig.state.patches.length, 0)

    const notJson = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', 'paper')
    assert.equal(notJson.status, 400)
    assert.match(await notJson.text(), /must be JSON/)

    const both = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', { host: 'a.b', port: 1, name: 'x' })
    assert.equal(both.status, 200, 'an extra field is not this route\'s business, and the document is what counts')

    const tooLarge = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers',
      JSON.stringify({ host: 'a.example.net', port: 1, pad: 'x'.repeat(5000) }))
    assert.equal(tooLarge.status, 413)
  } finally {
    await rig.close()
  }
})

test('an unregistered puppet is a 404 on all three verbs', async () => {
  const rig = await panel()
  try {
    for (const [method, url] of [
      ['GET', '/api/puppets/nobody/allowed-servers'],
      ['POST', '/api/puppets/nobody/allowed-servers'],
      ['DELETE', '/api/puppets/nobody/allowed-servers/sky.example.net:25565']
    ]) {
      const response = await fetch(rig.url + url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(SKY) : undefined
      })
      assert.equal(response.status, 404, method + ' names no puppet')
      assert.match(await response.text(), /no puppet named/)
    }
  } finally {
    await rig.close()
  }
})

test('a panel with no cluster client, or a cluster that refuses, says which read failed', async () => {
  const none = await panel({ kubernetes: null })
  try {
    const response = await fetch(none.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(response.status, 503)
    assert.match(await response.text(), /no cluster client/)
  } finally {
    await none.close()
  }

  const unreadable = await panel({
    kubernetes: {
      configMap: async () => {
        throw new ReadRefused('read ConfigMap monoplayer/monoplayer-control: the API server answered 403 Forbidden', { status: 403 })
      },
      patchConfigMapKey: async () => { throw new WriteRefused('unreachable', { status: 403 }) }
    }
  })
  try {
    for (const [method, url] of [
      ['GET', '/api/puppets/glowsquidye/allowed-servers'],
      ['POST', '/api/puppets/glowsquidye/allowed-servers']
    ]) {
      const response = await fetch(unreadable.url + url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(SKY) : undefined
      })
      assert.equal(response.status, 503, method + ' says the read was refused')
      assert.match(await response.text(), /403/)
    }
  } finally {
    await unreadable.close()
  }

  const refused = await panel({ cluster: cluster({ refuse: async () => { throw new WriteRefused('the API server answered 403 Forbidden', { status: 403 }) } }) })
  try {
    const response = await post(refused.url + '/api/puppets/glowsquidye/allowed-servers', SKY)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /was not written/)
  } finally {
    await refused.close()
  }
})

test('the YAML is the block a human pastes into deploy/manifests/configmap.yaml', async () => {
  const rig = await panel()
  try {
    const body = await (await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', SKY)).json()
    assert.equal(body.pasteInto, 'deploy/manifests/configmap.yaml')
    assert.match(body.yaml, /^data:\n {2}allowed-servers\.json: \|\n/)
    // The block is a document the lane can read, indented as a ConfigMap key.
    const pasted = body.yaml.split('\n').slice(2).map(line => line.slice(4)).join('\n')
    assert.equal(pasted.trim(), text(body.document).trim())
  } finally {
    await rig.close()
  }
})

test('a seed ConfigMap the cluster will not hand over is named, not skipped', async () => {
  const rig = await panel({ cluster: cluster({ liveKey: false, seedRefused: 'read ConfigMap monoplayer/monoplayer-config: the API server answered 403 Forbidden' }) })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(response.status, 503)
    const said = await response.text()
    assert.match(said, /monoplayer-config/, 'the refusal names the object the panel could not read')
    assert.match(said, /403/)
  } finally {
    await rig.close()
  }
})

test('a control ConfigMap key that is not text is refused rather than replaced', async () => {
  const made = cluster()
  const client = {
    ...made.client,
    async configMap (namespace, name) {
      if (name === SEED) return made.client.configMap(namespace, name)
      return { metadata: { resourceVersion: '5' }, data: { [ALLOWED_KEY]: 42 } }
    }
  }
  const rig = await panel({ cluster: made, kubernetes: client })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(response.status, 500)
    assert.match(await response.text(), /is not text/)
    assert.equal(made.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

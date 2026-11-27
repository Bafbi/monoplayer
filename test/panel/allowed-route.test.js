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
import http from 'node:http'

import { createPanelHandler } from '../../src/panel/server.js'
import { mergePatchBody, ReadRefused, WriteRefused } from '../../src/panel/kube.js'
import { createControlDocument } from '../../src/service/control.js'
import { ALLOWED_KEY, targetOf } from '../../src/panel/routes/allowed.js'
import { pickTarget } from '../../src/core/picker.js'

const CONTROL = 'monoplayer-control'
const SEED = 'monoplayer-config'
const PAPER = { host: 'paper.example.net', port: 25565 }
const SKY = { host: 'sky.example.net', port: 25565 }
// #339: the same server with the root dot on its host. A row may be written this way by
// hand, and since #890 the add form accepts it too: the host rule is the service's own
// (`hostRefusal`), and a host a dial can take is a host this route takes.
const DOTTED = { host: PAPER.host + '.', port: PAPER.port }
const NOW = Date.parse('2026-11-23T12:00:00.000Z')

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: CONTROL,
  seedConfigMap: SEED,
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'paper.example.net:25565',
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
          data: state.liveKey ? { [ALLOWED_KEY]: state.text, 'attach-whitelist.json': '{}' } : { 'attach-whitelist.json': '{}' }
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
    // The lane's own reader, over the text the patch left behind. No temporary file:
    // the document is a string already, and `readFile` is the seam
    // `createControlDocument` takes.
    laneReads: () => createControlDocument({
      allowedServersFile: '/control/allowed-servers.json',
      allowedServersSeedFile: '/config/allowed-servers.json',
      readFile: file => {
        const present = file.startsWith('/control') ? made.state.liveKey === true : made.state.seedKey === true
        if (!present) {
          const missing = new Error('ENOENT: no such file or directory')
          missing.code = 'ENOENT'
          throw missing
        }
        return file.startsWith('/control') ? made.state.text : made.state.seed
      }
    }).allowedServers(),
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
    // The window is the next offer, not the next boot (#352). The picker landed in #265
    // behind MONOPLAYER_PICKER and reads this list at each offer. The answer names the
    // switch that decides it, instead of claiming nothing offers the list.
    assert.match(body.takesEffect, /MONOPLAYER_PICKER/)
    assert.match(body.takesEffect, /each offer/)
    assert.match(body.takesEffect, /start record/)
    assert.match(body.takesEffect, /#265/)
    assert.doesNotMatch(body.takesEffect, /nothing offers the list to a client yet/,
      'the picker has offered this list since #265, and the answer may not say otherwise')

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

// #339: one address, one rule. The panel used to build its own `toLowerCase() + ':' +
// port` key, so a dotted row and the plain spelling were two servers. An add then appended
// a second row the lane's parser refused as a duplicate, and the panel could not repair
// the list it wrote.
test('#339 an add of the plain spelling finds a row written with the root dot', async () => {
  const rig = await panel({ cluster: cluster({ live: text(document([DOTTED])) }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', PAPER)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.changed, false, 'the server is already offered, in the other spelling')
    assert.equal(body.count, 1)
    assert.equal(rig.state.patches.length, 0, 'nothing was written, so the document still parses')
    const lane = rig.laneReads()
    assert.equal(lane.reason, null, 'and the lane still reads the list the panel left behind')
    assert.deepEqual(lane.servers.map(server => server.host), [DOTTED.host])
  } finally {
    await rig.close()
  }
})

test('#339 a remove of the plain spelling drops the row written with the root dot', async () => {
  const rig = await panel({ cluster: cluster({ live: text(document([DOTTED, SKY])) }) })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/' + PAPER.host + ':' + PAPER.port,
      { method: 'DELETE' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.changed, true)
    assert.deepEqual(body.removed, DOTTED, 'the entry it dropped is the one the document held')
    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host), [SKY.host])
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

// #890: the host rule is the service's own (`hostRefusal`, #891), so this case lists what that
// rule refuses and nothing else. Two shapes this route used to refuse are accepted now, and both
// are honest. A bare single label (`paper`) is a name the pod's search domains can resolve. And an
// IPv4 shape with an octet out of range is a host `hostRefusal` cannot tell from a numeric
// hostname, which DNS allows. The octet guard was this route's own third rule, and a route that
// validates its own way is what #890 removes: a typo it would have caught now fails at the socket
// under the row's own name, as a wrong name always has.
test('an address no dial can take is refused before it is stored, in the words that say which half', async () => {
  const rig = await panel()
  try {
    for (const [body, said] of [
      [{ host: 'https://paper.example.net', port: 25565 }, /^host must be a host: a DNS name or an IP address, with no scheme and no path, got "https:\/\/paper\.example\.net"/],
      // A port inside the host: the one colon that separates an address from its port has one
      // home, and it is this route's split. #891 names the rule the operator broke.
      [{ host: 'paper.example.net:25565', port: 25565 }, /^host must be a host with no port/],
      // The page trims what it splits, so this arrives from curl, which is where a paste of two
      // values lands.
      [{ host: ' paper.example.net', port: 25565 }, /^host must be a host with no surrounding space/],
      [{ host: '[2001:db8::1', port: 25565 }, /^host must be a host with no brackets/],
      // The document carries a port as a number, so text is refused rather than coerced.
      [{ host: 'paper.example.net', port: '25565' }, /^port must be an integer from 1 to 65535, got "25565"/],
      [{ host: 'paper.example.net' }, /^port must be an integer from 1 to 65535, got null/],
      [{ port: 25565 }, /^host must be a host/],
      [{ host: '', port: 25565 }, /^host must be a host/],
      // A host that is not text names no host at all, and is not read as the string "5".
      [{ host: 5, port: 25565 }, /^host must be a host/]
    ]) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', body)
      assert.equal(response.status, 400, JSON.stringify(body) + ' is refused')
      assert.match((await response.text()).trim(), said, JSON.stringify(body) + ' names the half to fix')
    }
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('#890 the two shapes this route stopped refusing are stored, and the port rule still holds', async () => {
  const rig = await panel()
  try {
    // A single label is a host a dial can take, and the service's rule says so.
    const label = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', { host: 'paper', port: 25565 })
    assert.equal(label.status, 200)

    // Four dot-separated groups is still one colon-free host to `hostRefusal`, and a row a dial
    // cannot reach fails at the socket under its own name. #891 is where that rule lives.
    const typo = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', { host: '999.999.999.999', port: 25565 })
    assert.equal(typo.status, 200)

    const lane = rig.laneReads()
    assert.deepEqual(lane.servers.map(server => server.host), [PAPER.host, 'paper', '999.999.999.999'])
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

// #890: an IPv6 host holds more than one colon. Two defects met here, and IPv4 could see
// neither, which is why three passes over this family left them standing: the route printed
// `host + ':' + port`, which runs the port into the last group, and `isTargetHost` refused
// every IPv6 host the operator sent, so there was no way to register one at all.
const IPV6 = { host: '2001:db8::1', port: 25565 }
// The bracketed form the picker writes and the service's records print (#815, #906).
const IPV6_WRITTEN = '[2001:db8::1]:25565'
// What the page's split of that address hands the route: the bracket comes with the host.
const IPV6_SPLIT = '[' + IPV6.host + ']'

test('#890 an IPv6 server is added, printed bracketed, read back by the lane, and removed', async () => {
  const rig = await panel()
  try {
    const added = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers',
      { host: IPV6_SPLIT, port: IPV6.port })
    assert.equal(added.status, 200, 'an operator with an IPv6 server can register it')
    const body = await added.json()
    assert.equal(body.changed, true)
    assert.equal(body.count, 2)
    // The printed address is the bracketed spelling, because it is the one the host and the
    // port split back out of. `2001:db8::1:25565` has no colon that separates the two.
    assert.equal(body.server, IPV6_WRITTEN, 'the route prints the address the picker can read back')
    assert.deepEqual(pickTarget(body.server), { host: IPV6.host, port: IPV6.port },
      'and what the route prints, the picker reads as the address it dials')

    // The document holds the host bare, which is the shape the service's own host rule takes:
    // the bracket belongs to the printed address, not to the host (#891).
    assert.deepEqual(body.servers.at(-1), { host: IPV6.host, port: IPV6.port, addedAt: new Date(NOW).toISOString() })
    const lane = rig.laneReads()
    assert.equal(lane.reason, null, 'the lane still reads the list the panel wrote')
    assert.deepEqual(lane.servers.map(server => server.host), [PAPER.host, IPV6.host])

    const audit = rig.lines().find(line => line.event === 'panelAllowedServerAdd')
    assert.equal(audit.server, IPV6_WRITTEN, 'the audit line names the row the operator sees')

    // The removal takes the address the row is called, which is the printed one. The literal the
    // ticket names is this segment decoded, and the route reads it back as the row it just wrote.
    assert.deepEqual(targetOf(IPV6_WRITTEN), { target: { host: IPV6.host, port: IPV6.port } },
      '[2001:db8::1]:25565 is the address the removal path takes, once the path decodes it')
    const removed = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers/' +
      encodeURIComponent(IPV6_WRITTEN), { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const gone = await removed.json()
    assert.equal(gone.server, IPV6_WRITTEN)
    assert.deepEqual(gone.removed, { host: IPV6.host, port: IPV6.port, addedAt: new Date(NOW).toISOString() },
      'the removal drops the row the add wrote')
    assert.deepEqual(rig.laneReads().servers.map(server => server.host), [PAPER.host])
  } finally {
    await rig.close()
  }
})

test('#890 the bracketed and the unbracketed IPv6 host are one address, so one row', async () => {
  const rig = await panel()
  try {
    const first = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers',
      { host: IPV6_SPLIT, port: IPV6.port })
    assert.equal(first.status, 200)

    // A human copying the address out of a log types the bracket; a human reading `ip a`
    // types the bare host. Both name the same server, so the second add rewrites nothing.
    const second = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', IPV6)
    assert.equal(second.status, 200, 'the bare spelling is a host a dial can take')
    const body = await second.json()
    assert.equal(body.changed, false, 'one address, one row, in either spelling')
    assert.equal(body.count, 2)
    assert.equal(rig.state.patches.length, 1, 'the second add wrote nothing')
  } finally {
    await rig.close()
  }
})

test('#890 a refusal says which half of the address broke', async () => {
  const rig = await panel()
  try {
    // The host carries a port of its own: the colon is not an IPv6 address, and the port has
    // its own field. The sentence names the host, because that is the half to fix.
    const host = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers',
      { host: 'paper.example.net:25565', port: 25565 })
    assert.equal(host.status, 400)
    const hostSaid = (await host.text()).trim()
    assert.match(hostSaid, /^host /, 'the refusal names the host')
    assert.match(hostSaid, /no port/, 'and the rule it broke: #891 states it for a colon in a host')
    assert.match(hostSaid, /"paper\.example\.net:25565"/, 'and the value as the operator wrote it')
    assert.doesNotMatch(hostSaid, /^port /, 'the port was fine, and is not blamed')

    const port = await post(rig.url + '/api/puppets/glowsquidye/allowed-servers', { host: 'paper.example.net', port: 70000 })
    assert.equal(port.status, 400)
    const portSaid = (await port.text()).trim()
    assert.match(portSaid, /^port /, 'the refusal names the port')
    assert.match(portSaid, /1 to 65535/)
    assert.match(portSaid, /70000/, 'and the value that broke it')
    assert.doesNotMatch(portSaid, /^host /, 'the host was fine, and is not blamed')

    assert.equal(rig.state.patches.length, 0, 'neither refusal wrote a document')
  } finally {
    await rig.close()
  }
})

// #890: two sentences this route owes a reader, and neither had a case. A document the lane cannot
// read is refused by the field that broke and by the rule's own words, which is where an operator
// learns which line of the file to open.
test('#890 a document that names no host, or a port that is not one, is refused by the field', async () => {
  for (const [broken, said] of [
    ['{"version": 1, "servers": [{"host": "", "port": 25565}]}', /servers\[0\]\.host must be a host: a DNS name or an IP address, with no scheme and no path/],
    ['{"version": 1, "servers": [{"host": "paper.example.net", "port": "25565"}]}', /servers\[0\]\.port must be an integer from 1 to 65535/]
  ]) {
    const rig = await panel({ cluster: cluster({ live: broken }) })
    try {
      const response = await fetch(rig.url + '/api/puppets/glowsquidye/allowed-servers')
      assert.equal(response.status, 500)
      assert.match(await response.text(), said)
    } finally {
      await rig.close()
    }
  }
})

// #232: the panel's whitelist route. Every case goes over a real socket, because
// the status, the content type, and the bytes are the product.
//
// The cluster is a fake that holds the document as text and applies the merge
// patch the route sends, so "the panel did not clobber a key it does not own" and
// "a lost race was re-read" are asserted against state, not against a call log
// alone. What the route writes is read back through the puppet's own reader,
// `createWhitelistStore` from src/custody/store.js, so "the puppet can obey what
// the panel wrote" is asserted against the code that will read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPanelHandler } from '../../src/panel/server.js'
import { mergePatchBody, ReadRefused, WriteRefused } from '../../src/panel/kube.js'
import { createWhitelistStore } from '../../src/custody/store.js'

const KEY = 'attach-whitelist.json'
const CONTROL = 'monoplayer-control'
const PUPPET_UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const PLAYER_UUID = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const OTHER_UUID = '4b1e0d8a-5c6f-4c31-9d2e-2b8a0f7c6d51'
// The entry a second writer lands between the panel's read and its patch.
const RACER_UUID = '9c2f6a41-0b3d-4e58-8a77-1d5e9c0b2f36'
const NOW = Date.parse('2026-11-18T10:00:00.000Z')

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: CONTROL,
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: false,
  ...overrides
})

const document = (players) => ({ version: 1, players })
const onePlayer = document([{ uuid: PLAYER_UUID, name: 'Bafbi', addedAt: '2026-11-07T13:04:51.092Z' }])
const text = (doc) => JSON.stringify(doc, null, 2) + '\n'

// The cluster, as text plus a version. `conflicts` is how many patches report
// 409 before one lands. Each one also rewrites the document, the way a second writer
// would, so a panel that forgot to re-read is caught by the result.
function cluster ({ doc = onePlayer, missingKey = false, conflicts = 0, refuse = null, puppetUuid = PUPPET_UUID } = {}) {
  const state = {
    text: text(doc),
    version: 1,
    missingKey,
    reads: 0,
    patches: [],
    conflicts
  }
  return {
    state,
    client: {
      async deployment () {
        const env = []
        if (puppetUuid !== null) env.push({ name: 'MONOPLAYER_PUPPET_UUID', value: puppetUuid })
        return { spec: { template: { spec: { containers: [{ name: 'monoplayer', env }] } } } }
      },
      async configMap (namespace, name) {
        state.reads += 1
        assert.equal(namespace, puppet().namespace)
        assert.equal(name, CONTROL, 'the read asks for the ConfigMap the registry names')
        return {
          metadata: { name, namespace, resourceVersion: String(state.version) },
          data: state.missingKey && state.patches.length === 0 ? {} : { [KEY]: state.text }
        }
      },
      async patchConfigMapKey (patch) {
        state.patches.push(patch)
        if (typeof refuse === 'function') return refuse(patch)
        const body = JSON.parse(mergePatchBody(patch))
        assert.equal(patch.namespace, puppet().namespace)
        assert.equal(patch.name, CONTROL)
        assert.equal(Object.keys(body.data).length, 1, 'one key is patched, and only that key')
        assert.equal(body.metadata.resourceVersion, String(state.version), 'the patch carries the version it read')
        if (state.conflicts > 0) {
          state.conflicts -= 1
          // The other writer's patch landed first: a new player and a new version.
          const raced = JSON.parse(state.text)
          if (!raced.players.some(player => player.uuid === RACER_UUID)) {
            raced.players.push({ uuid: RACER_UUID, name: 'Racer', addedAt: '2026-11-18T09:59:00.000Z' })
          }
          state.text = JSON.stringify(raced, null, 2) + '\n'
          state.version += 1
          state.missingKey = false
          // The API server's own words for a failed precondition, which is what a
          // caller has to see when the panel gives up.
          throw new WriteRefused('write ' + KEY + ' in ConfigMap ' + CONTROL + ': the API server answered 409: ' +
            'Operation cannot be fulfilled on configmaps "' + CONTROL + '": the object has been modified; ' +
            'please apply your changes to the latest version and try again', { status: 409 })
        }
        state.text = body.data[KEY]
        state.missingKey = false
        state.version += 1
        return { namespace: patch.namespace, name: patch.name, key: patch.key, status: 200, resourceVersion: String(state.version) }
      }
    }
  }
}

async function panel ({ cluster: made = cluster(), puppets = [puppet()], kubernetes, lookup, log } = {}) {
  const lines = []
  const record = log ?? ((event, fields) => lines.push({ event, ...fields }))
  const client = kubernetes === undefined ? made.client : kubernetes
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets }),
    kubernetes: client,
    log: record,
    now: () => NOW,
    lookup
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    state: made.state,
    lines: () => lines,
    // The reader the puppet uses, over the text the patch left behind.
    puppetReads: () => createWhitelistStore({ file: 'ignored', readFile: () => made.state.text, existsSync: () => true }).list(),
    close: () => new Promise(resolve => server.close(resolve))
  }
}

const post = (url, body, init = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...init
})

test('GET is the parsed list, with the ConfigMap name and its resourceVersion', async () => {
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const body = await response.json()
    assert.equal(body.puppet, 'glowsquidye')
    assert.equal(body.controlConfigMap, CONTROL)
    assert.equal(body.key, KEY)
    assert.equal(body.resourceVersion, '1')
    assert.equal(body.count, 1)
    assert.deepEqual(body.document.players.map(player => player.uuid), [PLAYER_UUID])
    assert.equal(rig.state.patches.length, 0, 'a read writes nothing')
  } finally {
    await rig.close()
  }
})

test('POST adds one uuid, and the puppet\'s own reader sees it', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID.toUpperCase() })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)

    assert.equal(rig.state.patches.length, 1, 'one patch')
    assert.equal(rig.state.patches[0].key, KEY)

    const players = rig.puppetReads()
    assert.deepEqual(players.map(player => player.uuid), [PLAYER_UUID, OTHER_UUID],
      'the puppet reads both entries, and the uuid is stored lowercase')

    const body = await response.json()
    assert.equal(body.changed, true)
    assert.equal(body.count, 2)
    assert.equal(body.uuid, OTHER_UUID)
    assert.equal(body.document.players.length, 2)
    // The change lands without a restart, and the route says so rather than
    // leaving the operator to read docs/panel.md to find out.
    assert.match(body.takesEffect, /next login/)
    assert.match(body.takesEffect, /mid-login/)

    const audit = rig.lines().find(line => line.event === 'panelWhitelistAdd')
    assert.ok(audit, 'the write is audited')
    assert.equal(audit.puppet, 'glowsquidye')
    assert.equal(audit.namespace, 'monoplayer')
    assert.equal(audit.uuid, OTHER_UUID)
    assert.equal(audit.name, null)
    assert.equal(audit.count, 2)
    assert.ok('address' in audit, 'the peer is the actor the panel can name')
  } finally {
    await rig.close()
  }
})

test('POST by name resolves through the lookup and stores the resolved uuid', async () => {
  const asked = []
  const rig = await panel({
    lookup: async name => { asked.push(name); return { uuid: OTHER_UUID.replace(/-/g, ''), name: 'Aria' } }
  })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { name: 'Aria' })
    assert.equal(response.status, 200)
    assert.deepEqual(asked, ['Aria'])
    const body = await response.json()
    assert.equal(body.uuid, OTHER_UUID, 'the undashed uuid the endpoints answer becomes the canonical one')
    assert.equal(body.name, 'Aria')
    const added = rig.puppetReads().find(player => player.uuid === OTHER_UUID)
    assert.deepEqual({ uuid: added.uuid, name: added.name }, { uuid: OTHER_UUID, name: 'Aria' })
    assert.equal(added.addedAt, new Date(NOW).toISOString(), 'the stamp is the panel\'s clock')
    assert.equal(rig.lines().find(line => line.event === 'panelWhitelistAdd').name, 'Aria')
  } finally {
    await rig.close()
  }
})

test('a name the resolver cannot answer is a 400 that asks for a uuid', async () => {
  const unresolved = await panel({ lookup: async () => ({ failed: true, reason: 'name_lookup_exhausted' }) })
  try {
    const response = await post(unresolved.url + '/api/puppets/glowsquidye/whitelist', { name: 'Aria' })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /uuid/i)
    assert.equal(unresolved.state.patches.length, 0, 'a name that did not resolve writes nothing')
  } finally {
    await unresolved.close()
  }
  const unknown = await panel({ lookup: async () => null })
  try {
    const response = await post(unknown.url + '/api/puppets/glowsquidye/whitelist', { name: 'Nobody' })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /Nobody/)
    assert.equal(unknown.state.patches.length, 0)
  } finally {
    await unknown.close()
  }
})

test('a uuid already in the list is a no-op, not a second entry', async () => {
  // Once by uuid, once by the name that resolves to the same account: a retried
  // request and a double click are the same request, and neither rewrites the entry.
  const rig = await panel({ lookup: async name => (name === 'Bafbi' ? { uuid: PLAYER_UUID, name: 'Bafbi' } : null) })
  try {
    for (const body of [{ uuid: PLAYER_UUID }, { name: 'Bafbi' }]) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', body)
      assert.equal(response.status, 200)
      const answer = await response.json()
      assert.equal(answer.changed, false, 'refused to rewrite for: ' + JSON.stringify(body))
      assert.equal(answer.count, 1)
      assert.equal(answer.document.players[0].addedAt, onePlayer.players[0].addedAt, 'the original stamp survives')
      assert.equal(answer.document.players[0].name, 'Bafbi', 'a stored name is not replaced by a request')
    }
    assert.equal(rig.state.patches.length, 0, 'nothing is written when nothing changes')
  } finally {
    await rig.close()
  }
})

test('DELETE removes by uuid, and the puppet\'s own reader agrees', async () => {
  const rig = await panel({ cluster: cluster({ doc: document([...onePlayer.players, { uuid: OTHER_UUID, name: 'Other', addedAt: '2026-11-18T09:00:00.000Z' }]) }) })
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist/' + OTHER_UUID, { method: 'DELETE' })
    assert.equal(response.status, 200)
    assert.equal(rig.state.patches.length, 1)
    assert.deepEqual(rig.puppetReads().map(player => player.uuid), [PLAYER_UUID],
      'the entry left the document the puppet reads')
    const body = await response.json()
    assert.equal(body.removed.uuid, OTHER_UUID)
    assert.equal(body.count, 1)
    assert.match(body.takesEffect, /next login/)
    assert.equal(rig.lines().find(line => line.event === 'panelWhitelistRemove').uuid, OTHER_UUID)
  } finally {
    await rig.close()
  }
})

test('a uuid that is not in the list is a 404, and nothing is written', async () => {
  const rig = await panel()
  try {
    const response = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist/' + OTHER_UUID, { method: 'DELETE' })
    assert.equal(response.status, 404)
    assert.match(await response.text(), new RegExp(OTHER_UUID))
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('a lost race is re-read and re-applied, and the other writer\'s entry survives', async () => {
  const rig = await panel({ cluster: cluster({ conflicts: 2 }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 200, 'the third attempt landed')
    assert.equal(rig.state.patches.length, 3, 'three patches')
    assert.equal(rig.state.reads, 3, 'each attempt re-read the document')
    const uuids = rig.puppetReads().map(player => player.uuid)
    assert.deepEqual(uuids, [PLAYER_UUID, RACER_UUID, OTHER_UUID],
      'the entry the other writer added is still there, and ours landed after it')
  } finally {
    await rig.close()
  }
})

test('three lost races are reported by name, and nothing pretends to have landed', async () => {
  const rig = await panel({ cluster: cluster({ conflicts: 99 }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 409)
    assert.equal(rig.state.patches.length, 3, 'at most three attempts')
    const body = await response.json()
    assert.equal(body.reason, 'conflict')
    assert.equal(body.attempts, 3)
    assert.match(body.detail, /modified/)
    assert.ok(rig.lines().some(line => line.event === 'panelWhitelistConflict'))
  } finally {
    await rig.close()
  }
})

test('a document that does not parse is refused with the parse error, never rewritten', async () => {
  const rig = await panel({ cluster: cluster({ doc: null }) })
  rig.state.text = '{ "version": 1, "players": [ '
  try {
    for (const path of ['/api/puppets/glowsquidye/whitelist']) {
      const read = await fetch(rig.url + path)
      assert.equal(read.status, 500)
      assert.match(await read.text(), /not JSON/)
    }
    const write = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(write.status, 500)
    assert.match(await write.text(), /not JSON/)
    assert.equal(rig.state.patches.length, 0, 'the file it could not parse is left alone')
    assert.equal(rig.state.text, '{ "version": 1, "players": [ ', 'byte for byte')
  } finally {
    await rig.close()
  }
})

test('a document of the wrong shape, or another version, is refused by name', async () => {
  const wrongShape = await panel({ cluster: cluster({ doc: null }) })
  wrongShape.state.text = JSON.stringify({ version: 1, players: 'nope' })
  try {
    const response = await post(wrongShape.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 500)
    assert.match(await response.text(), /players/)
    assert.equal(wrongShape.state.patches.length, 0)
  } finally {
    await wrongShape.close()
  }
  const later = await panel({ cluster: cluster({ doc: null }) })
  later.state.text = JSON.stringify({ version: 2, players: [] })
  try {
    const response = await post(later.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 500)
    assert.match(await response.text(), /version/)
    assert.equal(later.state.patches.length, 0)
  } finally {
    await later.close()
  }
})

test('a ConfigMap with no whitelist key is an empty whitelist, and the add creates the key', async () => {
  const rig = await panel({ cluster: cluster({ missingKey: true }) })
  try {
    const read = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist')
    assert.equal(read.status, 200)
    assert.equal((await read.json()).count, 0)
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 200)
    assert.deepEqual(rig.puppetReads().map(player => player.uuid), [OTHER_UUID])
  } finally {
    await rig.close()
  }
})

test('the puppet\'s own uuid is refused, and neither the answer nor the log repeats it', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: PUPPET_UUID })
    assert.equal(response.status, 409)
    const said = await response.text()
    assert.match(said, /puppet/)
    assert.doesNotMatch(said, new RegExp(PUPPET_UUID), 'the account\'s uuid is not printed back')
    assert.equal(rig.state.patches.length, 0, 'the puppet is never added')
    assert.equal(rig.lines().some(line => line.event === 'panelWhitelistAdd'), false)
    assert.doesNotMatch(JSON.stringify(rig.lines()), new RegExp(PUPPET_UUID))
  } finally {
    await rig.close()
  }
})

test('the YAML is what a human pastes into deploy/manifests/configmap.yaml', async () => {
  const rig = await panel()
  try {
    const body = await (await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })).json()
    assert.equal(body.pasteInto, 'deploy/manifests/configmap.yaml')
    const lines = body.yaml.split('\n')
    assert.deepEqual(lines.slice(0, 2), ['data:', '  ' + KEY + ': |'])
    // Every JSON line is indented four spaces, so the block scalar holds it whole.
    for (const line of lines.slice(2, -1)) assert.match(line, /^    /)
    const pasted = JSON.parse(lines.slice(2).map(line => line.replace(/^ {4}/, '')).join('\n'))
    assert.deepEqual(pasted, body.document, 'the pasted block is the document the panel wrote')
  } finally {
    await rig.close()
  }
})

test('the route answers its own verbs, and the read routes keep theirs', async () => {
  const rig = await panel()
  try {
    const read = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist', { method: 'PUT' })
    assert.equal(read.status, 405)
    assert.equal(read.headers.get('allow'), 'GET, POST')

    const entry = await post(rig.url + '/api/puppets/glowsquidye/whitelist/' + OTHER_UUID, { uuid: OTHER_UUID })
    assert.equal(entry.status, 405)
    assert.equal(entry.headers.get('allow'), 'DELETE')

    assert.equal((await fetch(rig.url + '/api/puppets')).status, 200, 'the registry list still answers')
    assert.equal((await fetch(rig.url + '/healthz')).status, 200)
  } finally {
    await rig.close()
  }
})

test('a body that does not declare itself JSON is refused, so a browser must preflight', async () => {
  const rig = await panel()
  try {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', 'uuid=' + OTHER_UUID,
        { headers: { 'content-type': type } })
      assert.equal(response.status, 400)
    }
    const preflight = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    })
    assert.equal(preflight.status, 405)
    assert.equal(preflight.headers.get('access-control-allow-origin'), null)
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('a body the route cannot act on names what to fix', async () => {
  const rig = await panel()
  try {
    for (const body of ['{ not json', '{}', { uuid: 'not-a-uuid' }, { uuid: 42 }, { uuid: OTHER_UUID, name: 'Bafbi' }]) {
      const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', body)
      assert.equal(response.status, 400, 'refused: ' + JSON.stringify(body))
      assert.match(await response.text(), /uuid|JSON/)
    }
    const huge = await post(rig.url + '/api/puppets/glowsquidye/whitelist', 'x'.repeat(8192))
    assert.equal(huge.status, 413)
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('an unregistered puppet is a 404 on all three verbs', async () => {
  const rig = await panel()
  try {
    assert.equal((await fetch(rig.url + '/api/puppets/nobody/whitelist')).status, 404)
    assert.equal((await post(rig.url + '/api/puppets/nobody/whitelist', { uuid: OTHER_UUID })).status, 404)
    assert.equal((await fetch(rig.url + '/api/puppets/nobody/whitelist/' + OTHER_UUID, { method: 'DELETE' })).status, 404)
    assert.equal(rig.state.patches.length, 0)
  } finally {
    await rig.close()
  }
})

test('a panel with no cluster client, or a cluster that refuses, says so', async () => {
  const blind = await panel({ kubernetes: null })
  try {
    assert.equal((await fetch(blind.url + '/api/puppets/glowsquidye/whitelist')).status, 503)
    assert.equal((await post(blind.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })).status, 503)
    assert.equal((await fetch(blind.url + '/api/puppets/glowsquidye/whitelist/' + OTHER_UUID, { method: 'DELETE' })).status, 503)
  } finally {
    await blind.close()
  }
  const refused = await panel({
    cluster: cluster({ refuse: async () => { throw new WriteRefused('write ' + KEY + ': the API server answered 403 Forbidden', { status: 403 }) } })
  })
  try {
    const response = await post(refused.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 503)
    assert.match(await response.text(), /403/)
    assert.equal(refused.state.patches.length, 1)
  } finally {
    await refused.close()
  }
})

test('a path segment that is not percent-encoding is refused, not thrown', async () => {
  const rig = await panel()
  try {
    const response = await post(rig.url + '/api/puppets/%E0/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 400)
    assert.equal(rig.state.patches.length, 0)
    assert.equal((await fetch(rig.url + '/healthz')).status, 200, 'the panel is still answering')
  } finally {
    await rig.close()
  }
})

test('a lane whose Deployment names no puppet uuid cannot be written, and is told which line to fix', async () => {
  // start-live resolves the account from custody when MONOPLAYER_PUPPET_UUID is
  // unset, so the panel has no uuid to compare against. It refuses rather than
  // skipping the rule, and names the variable that fixes it.
  const rig = await panel({ cluster: cluster({ puppetUuid: null }) })
  try {
    const response = await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })
    assert.equal(response.status, 503)
    const said = await response.text()
    assert.match(said, /MONOPLAYER_PUPPET_UUID/)
    assert.match(said, /could not check|names no/)
    assert.equal(rig.state.patches.length, 0, 'the rule is total: nothing is written without it')
    assert.equal(rig.state.reads, 0, 'and nothing is even read')
    assert.ok(rig.lines().some(line => line.event === 'panelWhitelistOwnUuidUnknown'))
  } finally {
    await rig.close()
  }
})

test('a ConfigMap the cluster will not hand over is a 503 on every verb', async () => {
  const rig = await panel({
    kubernetes: {
      deployment: async () => ({ spec: { template: { spec: { containers: [] } } } }),
      configMap: async () => { throw new ReadRefused('read ConfigMap monoplayer/monoplayer-control: the API server answered 404', { status: 404 }) },
      patchConfigMapKey: async () => { throw new Error('nothing should be written') }
    },
    cluster: cluster()
  })
  try {
    const read = await fetch(rig.url + '/api/puppets/glowsquidye/whitelist')
    assert.equal(read.status, 503)
    assert.match(await read.text(), /404/)
    assert.equal((await post(rig.url + '/api/puppets/glowsquidye/whitelist', { uuid: OTHER_UUID })).status, 503)
    assert.equal((await fetch(rig.url + '/api/puppets/glowsquidye/whitelist/' + OTHER_UUID, { method: 'DELETE' })).status, 503)
  } finally {
    await rig.close()
  }
})

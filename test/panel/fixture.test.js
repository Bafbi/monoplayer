// Fixture mode: a recorded document instead of a cluster, and the one fence that
// keeps it out of a pod (#248).
//
// The fence is the assertion with the most riding on it. A fixture is a
// development aid, and a panel that served one while the lane it describes ran on
// would be showing a recording as though it were the lane: that is the failure the
// whole page exists to prevent, one level down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFixture } from '../../src/panel/fixture.js'
import { startPanel } from '../../src/panel/start.js'
import { activity } from '../../src/panel/activity.js'
import { createPanelHandler } from '../../src/panel/server.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'panel.json')
const quiet = { stdout: { write () {} }, stderr: { write () {} } }

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  ...overrides
})

// A token file the panel would find in a pod: mounted, and not empty.
function tokenFile (contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-token-'))
  const file = path.join(dir, 'token')
  fs.writeFileSync(file, contents)
  return file
}

function fixtureFile (document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-fixture-'))
  const file = path.join(dir, 'fixture.json')
  fs.writeFileSync(file, JSON.stringify(document))
  return file
}

// The recorded attach whitelist, which every fixture needs: the page draws the block
// for every puppet it shows, so a fixture without one would be refused rather than
// rendered with a list it never had.
const attachFor = (name, players = []) => ({
  [name]: {
    resourceVersion: '41221',
    puppetUuid: '11111111-2222-4333-8444-555555555555',
    document: { version: 1, players }
  }
})

// The recorded allowed-server list (#309), which every fixture needs for the same
// reason: the page draws that block beside the whitelist for every puppet it shows.
// `document` is the live key in the control ConfigMap; `seed` is the copy Git commits,
// which answers when the live key is absent.
const allowedFor = (name, servers = []) => ({
  [name]: { document: { version: 1, servers } }
})

// The smallest client the page needs to render a card: a Deployment with a selector, no
// pods, and a control ConfigMap with an empty attach whitelist.
const kubeFor = () => ({
  async deployment () {
    return { spec: { selector: { matchLabels: { app: 'monoplayer' } }, template: { spec: { containers: [{ name: 'monoplayer', env: [] }] } } } }
  },
  async pods () {
    return { items: [] }
  },
  async podLog () {
    return ''
  },
  async configMap () {
    return { metadata: { resourceVersion: '1' }, data: { 'attach-whitelist.json': JSON.stringify({ version: 1, players: [] }) } }
  }
})

const factsFor = (name, overrides = {}) => activity({
  puppet: puppet({ name }),
  pod: {
    metadata: { name: name + '-pod', creationTimestamp: '2026-11-18T09:00:00.000Z' },
    status: {
      phase: 'Running',
      startTime: '2026-11-18T09:00:00.000Z',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ restartCount: 0 }]
    }
  },
  log: { text: JSON.stringify({ t: '2026-11-18T10:37:12.906Z', event: 'heartbeat', warm: true }) + '\n' },
  now: Date.parse('2026-11-18T10:37:24.906Z'),
  ...overrides
})

test('fixture mode serves the recorded document, with no cluster at all', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  try {
    const url = 'http://127.0.0.1:' + panel.port
    const page = await (await fetch(url + '/')).text()
    // The two states the ticket asks a screenshot to show: a puppet with a
    // heartbeat, and one with none.
    assert.match(page, /glowsquidye/)
    assert.match(page, /serving: the newest heartbeat was written 12 s ago/)
    assert.match(page, /quiet/)
    assert.match(page, /no heartbeat in the last \d+ lines of monoplayer-quiet-/)
    // And the one write the card offers: the attach whitelist's add form. The move
    // is retired (#264), so the page a reviewer screenshots has no control that
    // names another server.
    assert.match(page, /data-write="add"/)
    assert.doesNotMatch(page, /data-write="backend"/)

    const one = await fetch(url + '/api/puppets/glowsquidye')
    assert.equal(one.status, 200)
    const body = await one.json()
    assert.equal(body.name, 'glowsquidye')
    assert.equal(body.state.state, 'serving')
    assert.equal((await fetch(url + '/api/puppets/nobody')).status, 404)
  } finally {
    await panel.close()
  }
})

test('a fixture refuses to start when the in-cluster token is mounted', async () => {
  // The token a pod always has. The refusal names the file and the reason, and it
  // happens before the socket exists.
  //
  // A panel that started anyway is closed in the finally: a test whose failure
  // mode is a hung process reports nothing.
  let started = null
  try {
    await assert.rejects(async () => {
      started = await startPanel({
        argv: ['--fixture', FIXTURE, '--port', '0'],
        io: quiet,
        tokenFile: tokenFile('a projected service account token')
      })
    }, /--fixture refuses to start: .*token.*ServiceAccount token/s)
  } finally {
    if (started !== null) await started.close()
  }
})

test('an empty token file is not a mounted identity', async () => {
  // A kubelet projection that has not been written yet is an empty file, and the
  // panel treats it as no identity everywhere else too.
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: tokenFile('')
  })
  try {
    assert.equal((await fetch('http://127.0.0.1:' + panel.port + '/healthz')).status, 200)
  } finally {
    await panel.close()
  }
})

test('fixture mode and a registry are two sources, and the panel reads one', async () => {
  for (const argv of [
    ['--fixture', FIXTURE, '--registry', 'deploy/panel/registry.yaml', '--port', '0'],
    ['--registry', 'deploy/panel/registry.yaml', '--fixture', FIXTURE, '--port', '0']
  ]) {
    await assert.rejects(startPanel({ argv, io: quiet, tokenFile: '/nonexistent/token' }),
      /--fixture and --registry name two sources/)
  }
})

test('a rewrite of the fixture reaches the next read, which is how the stream rolls', async () => {
  const first = factsFor('glowsquidye')
  const file = fixtureFile({
    version: 1,
    puppets: [puppet()],
    facts: { glowsquidye: first },
    whitelist: attachFor('glowsquidye'),
    allowed: allowedFor('glowsquidye')
  })
  const panel = await startPanel({
    argv: ['--fixture', file, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  try {
    const url = 'http://127.0.0.1:' + panel.port + '/api/puppets/glowsquidye'
    assert.equal((await (await fetch(url)).json()).observedAt, first.observedAt)

    // The operator's live roll: the recording is rewritten, and the next request
    // reads the new one, exactly as the registry is re-read.
    const later = factsFor('glowsquidye', { now: Date.parse('2026-11-18T10:39:12.906Z') })
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      puppets: [puppet()],
      facts: { glowsquidye: later },
      whitelist: attachFor('glowsquidye'),
      allowed: allowedFor('glowsquidye')
    }))
    const next = await (await fetch(url)).json()
    assert.equal(next.observedAt, '2026-11-18T10:39:12.906Z')
    assert.notEqual(next.observedAt, first.observedAt)
  } finally {
    await panel.close()
  }
})

test('the committed fixture holds the states a reviewer has to see', () => {
  const { registry, facts, whitelists } = parseFixture(fs.readFileSync(FIXTURE, 'utf8'))
  const states = registry.puppets.map(puppet => facts.get(puppet.name).state.state)
  assert.ok(states.includes('serving'), 'a puppet with a heartbeat: ' + states.join(', '))
  assert.ok(states.includes('no-heartbeat'), 'a puppet with none: ' + states.join(', '))
  // And the attach whitelist the block renders: one puppet with entries, one with an
  // empty list, so the block's two states are both on the page.
  const counts = registry.puppets.map(puppet => whitelists.get(puppet.name).document.players.length)
  assert.ok(counts.includes(0), 'a puppet nobody may attach as: ' + counts.join(', '))
  assert.ok(counts.some(count => count > 0), 'a puppet with entries: ' + counts.join(', '))
  const withEntries = registry.puppets.find(puppet => whitelists.get(puppet.name).document.players.length > 0)
  assert.ok(withEntries !== undefined)
  for (const player of whitelists.get(withEntries.name).document.players) {
    assert.match(player.addedAt, /^\d{4}-\d{2}-\d{2}T/, 'every entry carries the time it was added')
  }
})

test('the committed fixture carries the allowed servers, in both the states the block draws', () => {
  const { registry, allowed } = parseFixture(fs.readFileSync(FIXTURE, 'utf8'))
  // Every puppet the page draws has one: a recording that omitted it would render a
  // block with nothing in it, which is the hole #309 closed.
  for (const puppet of registry.puppets) {
    assert.ok(allowed.get(puppet.name) !== undefined, 'no recorded allowed servers for ' + puppet.name)
  }
  const counts = registry.puppets.map(puppet => allowed.get(puppet.name).document.servers.length)
  assert.ok(counts.includes(0), 'a puppet whose picker offers nothing: ' + counts.join(', '))
  assert.ok(counts.some(count => count > 0), 'a puppet with servers: ' + counts.join(', '))
  const withServers = registry.puppets.find(puppet => allowed.get(puppet.name).document.servers.length > 0)
  for (const server of allowed.get(withServers.name).document.servers) {
    assert.match(server.host, /^[a-z0-9.-]+$/, 'a host a dial can target: ' + server.host)
    assert.ok(Number.isInteger(server.port) && server.port > 0 && server.port < 65_536, 'a port a dial can target')
    assert.match(server.addedAt, /^\d{4}-\d{2}-\d{2}T/, 'every server carries the time it was added')
  }
  // And the fallback the other key has: one puppet offers the copy Git commits, so the
  // block's seed sentence is on the page a reviewer screenshots.
  const sources = registry.puppets.map(puppet => allowed.get(puppet.name).source)
  assert.ok(sources.includes('control'), 'a puppet whose live key holds the list: ' + sources.join(', '))
  assert.ok(sources.includes('seed'), 'a puppet offering the copy Git commits: ' + sources.join(', '))
  // The puppet with both recorded reads its live key, because that is the rule the route
  // applies: the seed answers only while the live key is absent.
  const both = registry.puppets.find(puppet => allowed.get(puppet.name).live !== null && allowed.get(puppet.name).seed !== null)
  assert.ok(both !== undefined, 'a puppet records both the live key and its seed')
  assert.equal(allowed.get(both.name).source, 'control')
})

test('a fixture the panel cannot act on is refused by name', () => {
  const base = {
    version: 1,
    puppets: [puppet()],
    facts: { glowsquidye: factsFor('glowsquidye') },
    whitelist: attachFor('glowsquidye'),
    allowed: allowedFor('glowsquidye')
  }
  const cases = [
    ['{"version":1,"puppets":[', /fixture: not JSON/],
    ['[]', /fixture: the document is not an object/],
    [JSON.stringify({ ...base, extra: 1 }), /unknown key "extra"/],
    [JSON.stringify({ ...base, puppets: [puppet({ backend: 'play2' })] }), /backend must be host:port/],
    [JSON.stringify({ ...base, facts: {} }), /no recorded document for "glowsquidye"/],
    [JSON.stringify({ ...base, facts: { nobody: {} } }), /an entry for "nobody"/],
    [JSON.stringify({ ...base, facts: { glowsquidye: { name: 'other', state: { state: 'serving', reason: 'x' } } } }),
      /facts\["glowsquidye"\]\.name is "other"/],
    [JSON.stringify({ ...base, facts: { glowsquidye: { name: 'glowsquidye' } } }), /no state sentence/],
    // The attach whitelist is validated by the route's own parser, so a fixture cannot
    // hold a document the panel would refuse to rewrite.
    [JSON.stringify({ ...base, whitelist: undefined }), /whitelist must be an object keyed by puppet name/],
    [JSON.stringify({ ...base, whitelist: {} }), /whitelist has no entry for "glowsquidye"/],
    [JSON.stringify({ ...base, whitelist: { glowsquidye: { document: { version: 1, players: [{ uuid: 'not-a-uuid' }] } } } }),
      /players\[0\]\.uuid is not a Minecraft uuid/],
    [JSON.stringify({ ...base, whitelist: { ...attachFor('glowsquidye'), nobody: {} } }), /an entry for "nobody"/],
    // Every field a whitelist record may hold is named, so a misspelling is refused
    // instead of becoming a recording that silently names no puppet account.
    [JSON.stringify({ ...base, whitelist: { glowsquidye: { ...attachFor('glowsquidye').glowsquidye, puppetUUID: 'x' } } }),
      /whitelist\["glowsquidye"\] has the unknown key "puppetUUID"/],
    // The allowed servers are the same bargain: one record per puppet, every field
    // named, and the document judged by the route's own parser so a recording cannot
    // hold a list the panel would refuse to show.
    [JSON.stringify({ ...base, allowed: undefined }), /allowed must be an object keyed by puppet name/],
    [JSON.stringify({ ...base, allowed: {} }), /allowed has no entry for "glowsquidye"/],
    [JSON.stringify({ ...base, allowed: { ...allowedFor('glowsquidye'), nobody: {} } }), /an entry for "nobody"/],
    [JSON.stringify({ ...base, allowed: { glowsquidye: {} } }),
      /allowed\["glowsquidye"\] names neither a live document nor a seed/],
    [JSON.stringify({ ...base, allowed: { glowsquidye: { document: { version: 1, servers: [{ host: 'paper.example.net', port: '25565' }] } } } }),
      /allowed\["glowsquidye"\]\.document: servers\[0\]\.port must be an integer between 1 and 65535/],
    // And the seed is judged by the same parser, so a recording cannot hold a fallback
    // the lane would refuse to read.
    [JSON.stringify({ ...base, allowed: { glowsquidye: { seed: { version: 1, servers: [{ host: 'paper.example.net', port: 70000 }] } } } }),
      /allowed\["glowsquidye"\]\.seed: servers\[0\]\.port must be an integer between 1 and 65535/],
    [JSON.stringify({ ...base, allowed: { glowsquidye: { ...allowedFor('glowsquidye').glowsquidye, documents: {} } } }),
      /allowed\["glowsquidye"\] has the unknown key "documents"/]
  ]
  for (const [text, expected] of cases) {
    assert.throws(() => parseFixture(text), expected)
  }
})

test('a fixture with only one puppet for two registry rows names the one it lacks', () => {
  const text = JSON.stringify({
    version: 1,
    puppets: [puppet(), puppet({ name: 'quiet', controlConfigMap: 'quiet-control', deployment: 'quiet' })],
    facts: { glowsquidye: factsFor('glowsquidye') },
    whitelist: { ...attachFor('glowsquidye'), ...attachFor('quiet') },
    allowed: { ...allowedFor('glowsquidye'), ...allowedFor('quiet') }
  })
  assert.throws(() => parseFixture(text), /no recorded document for "quiet"/)
})

test('the panel serves a fixture and writes nothing', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  const post = (path, body) => fetch('http://127.0.0.1:' + panel.port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  try {
    // A fixture has no cluster, so both writes the panel makes answer 503 and say
    // why. Neither pretends to have written a document.
    const refused = await post('/api/puppets/glowsquidye/whitelist', { uuid: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af' })
    assert.equal(refused.status, 503)
    assert.match(await refused.text(), /fixture mode is a recording, so no document was written/)
    // The allowed servers are recorded (#309), so this write reads the recording's
    // document and then reaches the write a recording refuses, by name.
    const servers = await post('/api/puppets/glowsquidye/allowed-servers', { host: 'new.example.net', port: 25565 })
    assert.equal(servers.status, 503)
    assert.match(await servers.text(), /the allowed-server list was not written: fixture mode is a recording/)
  } finally {
    await panel.close()
  }
})

test('a page served from a recording says so on the page', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  try {
    const page = await (await fetch('http://127.0.0.1:' + panel.port + '/')).text()
    // The start line and a refused write both say it, and neither is on the page a
    // screenshot of this branch shows.
    assert.match(page, /<p class="recording">this panel is serving a recording, not a cluster/)
  } finally {
    await panel.close()
  }
})

test('a panel reading a cluster carries no recording banner', async () => {
  // The same view with no recording behind it: the banner is a fact about where the
  // facts came from, so it is absent when they came from a cluster.
  const registry = () => ({ version: 1, puppets: [puppet()] })
  const server = http.createServer(createPanelHandler({ registry, kubernetes: kubeFor() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const page = await (await fetch('http://127.0.0.1:' + server.address().port + '/')).text()
    assert.doesNotMatch(page, /class="recording"/)
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

test('the allowed servers are read from the recording, and the two states are on the page', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  const url = 'http://127.0.0.1:' + panel.port
  try {
    // The route the page calls answers out of the recording, through the reader the
    // route would use in a pod.
    const listed = await fetch(url + '/api/puppets/glowsquidye/allowed-servers')
    assert.equal(listed.status, 200)
    const list = await listed.json()
    assert.equal(list.source, 'control')
    // One ConfigMap, one version: the recording names it once, in the whitelist record.
    assert.equal(list.resourceVersion, '41221')
    assert.deepEqual(list.servers.map(server => server.host + ':' + server.port), ['paper.example.net:25565', 'sky.example.net:25566'])

    // The other puppet's live key is absent, so the lane offers the copy Git commits,
    // and the answer says which file it read.
    const seed = await (await fetch(url + '/api/puppets/quiet/allowed-servers')).json()
    assert.equal(seed.source, 'seed')
    assert.equal(seed.count, 0)

    // And both are on the page: the fixture's whole job is that a reviewer can see the
    // block before it is merged.
    const page = await (await fetch(url + '/')).text()
    assert.match(page, /<h3>Allowed servers<\/h3>/)
    assert.match(page, /paper\.example\.net:25565/)
    assert.match(page, /sky\.example\.net:25566/)
    assert.match(page, /no allowed servers: the picker offers a joining player nothing/)
    assert.match(page, /<code>monoplayer-quiet-config<\/code>/, 'the puppet whose list is the copy Git commits says so')
  } finally {
    await panel.close()
  }
})

test('the whitelist block answers every refusal through the recording', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  const url = 'http://127.0.0.1:' + panel.port
  const send = (body) => fetch(url + '/api/puppets/glowsquidye/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  try {
    // The list is the recording's, through the route the page calls.
    const listed = await fetch(url + '/api/puppets/glowsquidye/whitelist')
    assert.equal(listed.status, 200)
    const list = await listed.json()
    assert.equal(list.count, 2)
    assert.equal(list.resourceVersion, '41221')
    assert.deepEqual(list.document.players.map(player => player.name), ['Bafbi', 'Second'])

    // A name resolves to nothing in a recording, and the route answers with the
    // instruction the block renders as one: send the uuid instead.
    const byName = await send({ name: 'Bafbi' })
    assert.equal(byName.status, 400)
    assert.match(await byName.text(), /no Minecraft account is named "Bafbi", so send the uuid instead/)

    // The puppet's own uuid is refused by the rule, not by the missing cluster,
    // because the recording names one in the Deployment's environment.
    const own = await send({ uuid: '11111111-2222-4333-8444-555555555555' })
    assert.equal(own.status, 409)
    assert.match(await own.text(), /that uuid is the puppet's own account/)

    // A uuid already in the list is not a write at all: the route answers 200 with
    // changed: false, so a retried request and a double click are the same request.
    const already = await send({ uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba' })
    assert.equal(already.status, 200)
    assert.equal((await already.json()).changed, false)

    // A uuid that is neither the puppet's nor already there reaches the write, and the
    // write is the one thing a recording cannot do.
    const write = await send({ uuid: '99999999-8888-4777-8666-555555555555' })
    assert.equal(write.status, 503)
    assert.match(await write.text(), /the attach whitelist was not written: fixture mode is a recording/)
  } finally {
    await panel.close()
  }
})

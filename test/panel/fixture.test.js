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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFixture } from '../../src/panel/fixture.js'
import { startPanel } from '../../src/panel/start.js'
import { activity } from '../../src/panel/activity.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'panel.json')
const quiet = { stdout: { write () {} }, stderr: { write () {} } }

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: true,
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
    // And the refused write: this puppet's registry row forbids the move, so the
    // block says so instead of rendering a form.
    assert.match(page, /move: refused by the registry/)

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
  const file = fixtureFile({ version: 1, puppets: [puppet()], facts: { glowsquidye: first } })
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
    fs.writeFileSync(file, JSON.stringify({ version: 1, puppets: [puppet()], facts: { glowsquidye: later } }))
    const next = await (await fetch(url)).json()
    assert.equal(next.observedAt, '2026-11-18T10:39:12.906Z')
    assert.notEqual(next.observedAt, first.observedAt)
  } finally {
    await panel.close()
  }
})

test('the committed fixture holds the three states a reviewer has to see', () => {
  const { registry, facts } = parseFixture(fs.readFileSync(FIXTURE, 'utf8'))
  const states = registry.puppets.map(puppet => facts.get(puppet.name).state.state)
  assert.ok(states.includes('serving'), 'a puppet with a heartbeat: ' + states.join(', '))
  assert.ok(states.includes('no-heartbeat'), 'a puppet with none: ' + states.join(', '))
  const refused = registry.puppets.filter(puppet => puppet.allowBackendSwitch === false)
  assert.ok(refused.length >= 1, 'a write the registry refuses')
})

test('a fixture the panel cannot act on is refused by name', () => {
  const cases = [
    ['{"version":1,"puppets":[', /fixture: not JSON/],
    ['[]', /fixture: the document is not an object/],
    [JSON.stringify({ version: 1, puppets: [puppet()], facts: {}, extra: 1 }), /unknown key "extra"/],
    [JSON.stringify({ version: 1, puppets: [puppet({ backend: 'play2' })], facts: {} }), /backend must be host:port/],
    [JSON.stringify({ version: 1, puppets: [puppet()], facts: {} }), /no recorded document for "glowsquidye"/],
    [JSON.stringify({ version: 1, puppets: [puppet()], facts: { nobody: {} } }), /an entry for "nobody"/],
    [JSON.stringify({ version: 1, puppets: [puppet()], facts: { glowsquidye: { name: 'other', state: { state: 'serving', reason: 'x' } } } }),
      /facts\["glowsquidye"\]\.name is "other"/],
    [JSON.stringify({ version: 1, puppets: [puppet()], facts: { glowsquidye: { name: 'glowsquidye' } } }),
      /no state sentence/]
  ]
  for (const [text, expected] of cases) {
    assert.throws(() => parseFixture(text), expected)
  }
})

test('a fixture with only one puppet for two registry rows names the one it lacks', () => {
  const text = JSON.stringify({
    version: 1,
    puppets: [puppet(), puppet({ name: 'quiet', controlConfigMap: 'quiet-control', deployment: 'quiet' })],
    facts: { glowsquidye: factsFor('glowsquidye') }
  })
  assert.throws(() => parseFixture(text), /no recorded document for "quiet"/)
})

test('the panel serves a fixture and writes nothing', async () => {
  const panel = await startPanel({
    argv: ['--fixture', FIXTURE, '--port', '0', '--host', '127.0.0.1'],
    io: quiet,
    tokenFile: '/nonexistent/token'
  })
  try {
    // A fixture has no cluster, so the one write the panel makes answers 503 and
    // says why. It never pretends to have written a document.
    const response = await fetch('http://127.0.0.1:' + panel.port + '/api/puppets/glowsquidye/backend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'alt.excalia.fr', port: 25565 })
    })
    assert.equal(response.status, 503)
    assert.match(await response.text(), /no cluster client/)
  } finally {
    await panel.close()
  }
})

// The entrypoint's two promises: a registry the panel cannot read fails the pod
// instead of the first visitor, and a registry edit reaches the next request
// without a restart. Both are about when the document is read, which is the one
// thing the routes cannot show on their own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { main, startPanel } from '../../src/panel/start.js'

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  ...overrides
})

function registryFile (puppets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-registry-'))
  const file = path.join(dir, 'puppets.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, puppets }))
  return file
}

test('a registry the panel cannot parse stops it before it listens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-registry-'))
  const file = path.join(dir, 'puppets.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, puppets: [puppet({ backend: 'play2' })] }))

  await assert.rejects(
    startPanel({ argv: ['--registry', file, '--port', '0'], io: { stdout: { write () {} }, stderr: { write () {} } } }),
    /backend must be host:port/,
    'a document the panel could not act on never reaches a listener'
  )
})

test('the panel serves the document it was started with', async () => {
  const file = registryFile([puppet({ name: 'one' })])
  const panel = await startPanel({
    argv: ['--registry', file, '--port', '0'],
    io: { stdout: { write () {} }, stderr: { write () {} } }
  })
  try {
    // The panel binds every interface, because a Service targets the pod IP and
    // not its loopback. The test still reaches it on loopback.
    const url = 'http://127.0.0.1:' + panel.port
    const body = await (await fetch(url + '/api/puppets')).json()
    assert.deepEqual(body.puppets.map(entry => entry.name), ['one'])
    assert.equal((await fetch(url + '/healthz')).status, 200)
  } finally {
    await panel.close()
  }
})

test('a registry edit reaches the next request without a restart', async () => {
  const file = registryFile([puppet({ name: 'one' })])
  const panel = await startPanel({
    argv: ['--registry', file, '--port', '0'],
    io: { stdout: { write () {} }, stderr: { write () {} } }
  })
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, puppets: [puppet({ name: 'one' }), puppet({ name: 'two', controlConfigMap: 'two-control' })] }))
    const body = await (await fetch('http://127.0.0.1:' + panel.port + '/api/puppets')).json()
    assert.deepEqual(body.puppets.map(entry => entry.name), ['one', 'two'],
      'the kubelet rewrites a mounted ConfigMap in place, so a read at start would show the old list until a pod restart')
  } finally {
    await panel.close()
  }
})

test('an unknown flag is refused instead of ignored', async () => {
  const file = registryFile([puppet()])
  for (const argv of [['--registry', file, '--por', '8080'], ['--registry', file, '--port', 'eighty']]) {
    await assert.rejects(
      startPanel({ argv, io: { stdout: { write () {} }, stderr: { write () {} } } }),
      /--port|--por/,
      'a flag the panel does not know is a mistake, not a default: ' + argv.join(' ')
    )
  }
})

test('main reports a broken registry on stderr and exits 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-registry-'))
  const file = path.join(dir, 'puppets.json')
  // Broken JSON, not a broken shape: the two get different messages, and this
  // case is the one an operator sees when a ConfigMap edit loses a brace.
  fs.writeFileSync(file, '{"version": 1, "puppets": [')
  let stderr = ''
  const code = await main({
    argv: ['--registry', file, '--port', '0'],
    io: { stdout: { write () {} }, stderr: { write (chunk) { stderr += chunk } } }
  })
  assert.equal(code, 2)
  assert.match(stderr, /registry: not JSON/)
})

test('main names the registry file it could not read', async () => {
  let stderr = ''
  const code = await main({
    argv: ['--registry', path.join(os.tmpdir(), 'panel-no-such-registry.json'), '--port', '0'],
    io: { stdout: { write () {} }, stderr: { write (chunk) { stderr += chunk } } }
  })
  assert.equal(code, 2)
  assert.match(stderr, /panel-no-such-registry\.json/)
})

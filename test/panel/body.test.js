// #250: one body cap, for every panel route that takes a body.
//
// The reader at src/panel/routes/body.js was already shared, but each write route
// declared its own `MAX_BODY_BYTES` and passed it in. Two 4096s agree until one of
// them is edited, and nothing in the suite would have said so: the two 413 cases in
// whitelist-route.test.js and allowed-route.test.js send 8192 and 5042 bytes, which
// stay refused at any cap under 5042. A whitelist route capped at 8191 was green.
//
// The first case is source text, because "the number has one home" is not a claim a
// request can make. The second is the socket, and it makes the claim a caller can
// check: both routes refuse at the same length, and the answer they give is the
// reader's own sentence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPanelHandler } from '../../src/panel/server.js'
import { BODY_TOO_LARGE, MAX_BODY_BYTES } from '../../src/panel/routes/body.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROUTES = path.join(ROOT, 'src', 'panel', 'routes')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const BODY = read('src/panel/routes/body.js')
// Every other module under src/panel/routes that reads a request body, found rather
// than listed, so a third write route is held to this the day it lands. The reader
// itself is excluded: it defines readBody, and this is a rule about its callers.
const MODULES = Object.fromEntries(
  fs.readdirSync(ROUTES)
    .filter(name => name.endsWith('.js') && name !== 'body.js')
    .map(name => ['src/panel/routes/' + name, fs.readFileSync(path.join(ROUTES, name), 'utf8')])
)
const READERS = Object.fromEntries(Object.entries(MODULES).filter(([, source]) => source.includes('readBody(')))

const count = (source, literal) => source.split(literal).length - 1

test('the cap is spelled once, in the reader, and every body-reading route takes it from there', () => {
  assert.equal(count(BODY, '4096'), 1,
    'src/panel/routes/body.js spells the cap once, and it is the only place that does')

  // The counts below are also true of a route that reads no body at all, so the walk
  // has to have found the routes this ticket is about: one whitelist, one server list.
  const names = Object.keys(READERS)
  assert.ok(names.length >= 2, 'the walk found the routes that read a body, and it found ' + JSON.stringify(names))

  for (const [name, source] of Object.entries(MODULES)) {
    // A route that listens to the request itself bounds the body itself, which is the
    // regression this file exists for, whether or not it also calls readBody.
    assert.equal(count(source, "req.on('data'"), 0,
      name + ' reads no request body of its own: the reader in src/panel/routes/body.js is the only one that does')
  }

  for (const [name, source] of Object.entries(READERS)) {
    assert.equal(count(source, '4096'), 0,
      name + ' spells no cap of its own: the number has one home, in src/panel/routes/body.js')
    assert.equal(count(source, 'MAX_BODY_BYTES'), 0,
      name + ' mentions no cap constant: it answers with the sentence the reader exports')
    assert.equal(count(source, 'readBody(req)'), 1,
      name + ' reads one body through readBody, and passes it no cap to disagree about')
  }
})

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'paper.example.net:25565'
}

// The cluster, as far as a request that is refused for its body ever sees it: the
// route's own verb guard wants a client, and a refused body may reach no write.
async function panel () {
  const writes = []
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets: [puppet] }),
    kubernetes: {
      async configMap () { return { metadata: { resourceVersion: '1' }, data: {} } },
      async patchConfigMapKey (patch) { writes.push(patch) }
    },
    now: () => Date.parse('2026-11-26T09:00:00.000Z')
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    writes,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

// A body of exactly this many bytes that parses as JSON. Padding with spaces after
// the object keeps it valid, so the route's own field checks are what refuse it.
const JSON_BODY = '{"pad":0}'
const padded = bytes => JSON_BODY + ' '.repeat(bytes - Buffer.byteLength(JSON_BODY))
const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body
})

test('both write routes refuse the same body length, in the same words', async () => {
  const rig = await panel()
  try {
    for (const route of ['whitelist', 'allowed-servers']) {
      const url = rig.url + '/api/puppets/glowsquidye/' + route

      const atCap = await post(url, padded(MAX_BODY_BYTES))
      assert.equal(atCap.status, 400,
        route + ' reads a body of exactly ' + MAX_BODY_BYTES + ' bytes and refuses it for what it says, not for its size')

      const over = await post(url, padded(MAX_BODY_BYTES + 1))
      assert.equal(over.status, 413, route + ' refuses a body of ' + (MAX_BODY_BYTES + 1) + ' bytes')
      assert.equal(await over.text(), BODY_TOO_LARGE,
        route + ' answers with the sentence the reader exports, which quotes the cap it enforced')
    }
    assert.equal(rig.writes.length, 0, 'no refused request reached a write')
  } finally {
    await rig.close()
  }
})

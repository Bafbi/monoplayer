// #12: the direct baseline join refuses what it cannot do before it opens a
// socket. The join itself needs a real Paper server, so what is testable here is
// the setup contract: a host, a port, and an account that resolves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { announceBrand, phaseOf, runBaseline } from '../../src/ladder/observer-baseline.js'
import { BRAND_CHANNEL, decodeBrand, FABRIC_BRAND } from '../../src/core/client-settings.js'

const UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'

function accountsDir (profile = { uuid: UUID, name: 'GlowSquidye', alias: 'glowsquidye' }) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'observer-baseline-'))
  if (profile) {
    const account = path.join(dir, profile.uuid)
    fs.mkdirSync(account, { recursive: true })
    fs.writeFileSync(path.join(account, 'profile.json'), JSON.stringify(profile))
  }
  return dir
}

test('a host is required', async () => {
  await assert.rejects(() => runBaseline({ host: '', port: 25565, accountsDir: accountsDir() }), /host is required/)
})

test('the port has to be a port', async () => {
  for (const port of [0, 70000, 1.5, Number.NaN]) {
    await assert.rejects(
      () => runBaseline({ host: '127.0.0.1', port, accountsDir: accountsDir() }),
      /port must be an integer/,
      String(port)
    )
  }
})

// #78: the report's brand row is only a comparison if both clients announce one.
// The fake client is the packet seam: what the baseline writes, and how often.
const fakeClient = () => {
  const handlers = new Map()
  const written = []
  return {
    written,
    once (event, handler) { handlers.set(event, () => { handlers.delete(event); handler() }) },
    write (name, packet) { written.push({ name, packet }) },
    emit (event) { handlers.get(event)?.() },
    has (event) { return handlers.has(event) }
  }
}

test('the baseline announces the Fabric brand the puppet announces', () => {
  const client = fakeClient()
  const log = []
  announceBrand(client, { log: (event, fields) => log.push({ event, ...fields }) })
  assert.equal(client.written.length, 0, 'nothing is written before the configuration phase')
  client.emit('select_known_packs')
  assert.equal(client.written.length, 1)
  assert.equal(client.written[0].name, 'custom_payload')
  assert.equal(client.written[0].packet.channel, BRAND_CHANNEL)
  assert.equal(decodeBrand(client.written[0].packet.data), FABRIC_BRAND)
  assert.deepEqual(log.at(-1), { event: 'baselineBrand', channel: BRAND_CHANNEL, brand: FABRIC_BRAND })
})

test('one connection announces once, as the proxy does per connection', () => {
  // The listener is registered with once(), so a second configuration frame on
  // the same connection does not announce a second brand.
  const client = fakeClient()
  announceBrand(client)
  client.emit('select_known_packs')
  client.emit('select_known_packs')
  assert.equal(client.written.length, 1)
})

test('a write that the leg refuses is logged, never silent', () => {
  const client = fakeClient()
  client.write = () => { throw new Error('socket closed') }
  const log = []
  announceBrand(client, { log: (event, fields) => log.push({ event, ...fields }) })
  client.emit('select_known_packs')
  assert.equal(log.at(-1).event, 'baselineBrandFailed')
  assert.match(log.at(-1).error, /socket closed/)
})

test('announceBrand refuses something that is not a client', () => {
  assert.throws(() => announceBrand(null), /minecraft-protocol client/)
  assert.throws(() => announceBrand({ write: () => {} }), /minecraft-protocol client/)
})

test('an account that does not resolve fails before any socket opens', async () => {
  await assert.rejects(
    () => runBaseline({ host: '127.0.0.1', port: 25565, accountsDir: accountsDir(), account: 'nosuchpuppet' }),
    error => {
      assert.match(error.message, /cannot resolve the account/)
      // #79: the script reads the rung's exit status to tell a setup it refused
      // from a join the server refused, so this one has to say which it is.
      assert.equal(phaseOf(error), 'setup')
      return true
    }
  )
})

test('a join that the server refuses is not reported as a refused setup', async () => {
  // The other half of the same split. Anything the rung did not refuse before
  // opening a socket is a join, so an untagged failure reads as one.
  assert.equal(phaseOf(new Error('bot GlowSquidye: ended before play')), 'join')
  assert.equal(phaseOf(undefined), 'join')
  const refused = await runBaseline({ host: '', port: 25565, accountsDir: accountsDir() }).catch(error => error)
  assert.equal(phaseOf(refused), 'setup', 'a bad host is refused before any socket opens')
})

test('an empty accounts directory is reported, not guessed at', async () => {
  await assert.rejects(
    () => runBaseline({ host: '127.0.0.1', port: 25565, accountsDir: accountsDir(null) }),
    /cannot resolve the account/
  )
})

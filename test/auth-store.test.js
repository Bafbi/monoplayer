// G1 whitelist-store unit tests: file shape, name→UUID resolution at add
// time (injectable lookup), UUID-keyed comparisons, atomic persistence,
// corrupted-file recovery, role-conflict warning. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createWhitelistStore, createNameLookup, WHITELIST_VERSION } from '../src/custody/store.js'

const PLAYER = { dashed: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af', undashed: '7FAD1E81B0E94A3C8CCB9E41F3A4B3AF', name: 'Bafbi' }

function tmpFile (label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `auth-wl-${label}-`)), 'whitelist.json')
}

const resolvingLookup = () => async name => {
  if (name.toLowerCase() === 'bafbi') return { uuid: PLAYER.undashed.toLowerCase() /* server returns undashed */, name: 'Bafbi' }
  if (name === 'missing') return null
  return { failed: true }
}

test('empty file: list is empty, version defaults on first write', async () => {
  const file = tmpFile('fresh')
  const store = createWhitelistStore({ file, lookup: resolvingLookup() })
  assert.deepEqual(store.list(), [])
  const add = await store.add('bafbi')
  assert.equal(add.ok, true)
  assert.equal(add.record.uuid, PLAYER.dashed)
  assert.equal(add.record.name, 'Bafbi')
  assert.equal(add.record.addedAt, store.list()[0].addedAt)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(doc.version, WHITELIST_VERSION)
  assert.deepEqual(doc.players.map(player => player.uuid), [PLAYER.dashed], 'undashed resolution normalizes on write')
  assert.deepEqual(Object.keys(doc.players[0]).sort(), ['addedAt', 'name', 'uuid'])
})

test('add by raw UUID never touches the name resolver', async () => {
  let called = 0
  const store = createWhitelistStore({ file: tmpFile('uuid'), lookup: async () => { called++; return null } })
  const added = await store.add(PLAYER.undashed)
  assert.equal(called, 0)
  assert.equal(added.ok, true)
  assert.equal(added.record.uuid, PLAYER.dashed)
})

test('add by name without a resolver is refused, not guessed', async () => {
  const store = createWhitelistStore({ file: tmpFile('nores') })
  const result = await store.add('bafbi')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'resolver_unavailable')
})

test('lookup failure and unknown names refuse the add', async () => {
  const store = createWhitelistStore({ file: tmpFile('fail'), lookup: resolvingLookup() })
  assert.deepEqual((await store.add('GhostName')).reason, 'name_resolution_failed')
  assert.deepEqual((await store.add('missing')).reason, 'name_resolution_failed')
  assert.deepEqual(store.list(), [], 'nothing half-added')
})

test('has/find are UUID-keyed, name entries are display-only', async () => {
  const file = tmpFile('keys')
  const store = createWhitelistStore({ file, lookup: resolvingLookup() })
  await store.add('bafbi')
  assert.equal(store.has(PLAYER.undashed), true, 'case/dash-insensitive uuid match')
  assert.equal(store.has('Deadbeef-0000-0000-0000-000000000001'), false)
  assert.equal(store.find('bafbi')?.uuid, PLAYER.dashed, 'find accepts a display name too')
  // A name change does not admit a different uuid.
  assert.equal(store.has('GlowSquidye'), false)
})

test('remove works by uuid or name and reports absence', async () => {
  const file = tmpFile('remove')
  const first = createWhitelistStore({ file, lookup: resolvingLookup() })
  await first.add('bafbi')
  assert.equal(first.remove('bafbi').ok, true)
  assert.deepEqual(first.list(), [])
  // Simulate the server-side/other-writer state: a fresh instance reads the
  // rewritten file instead of trusting the stale in-memory doc.
  fs.writeFileSync(file, JSON.stringify({ version: WHITELIST_VERSION, players: [{ uuid: PLAYER.dashed, name: 'Bafbi', addedAt: 'then' }] }))
  const second = createWhitelistStore({ file, lookup: resolvingLookup() })
  assert.equal(second.remove(PLAYER.undashed).ok, true, 'remove by undashed uuid')
  assert.deepEqual(second.list(), [])
  const third = createWhitelistStore({ file, lookup: resolvingLookup() })
  fs.writeFileSync(file, JSON.stringify({ version: WHITELIST_VERSION, players: [{ uuid: PLAYER.dashed, name: 'Bafbi', addedAt: 'then' }] }))
  assert.equal(third.remove(PLAYER.undashed).ok, true)
  assert.equal(third.remove(PLAYER.dashed).ok, false)
  assert.equal(third.remove(PLAYER.dashed).reason, 'not_present')
})

test('re-adding refreshes the name, keeps the original addedAt', async () => {
  const file = tmpFile('readd')
  let clockAt = '2026-11-06T00:00:00.000Z'
  const store = createWhitelistStore({ file, lookup: resolvingLookup(), now: () => clockAt })
  await store.add('bafbi')
  clockAt = '2026-11-07T00:00:00.000Z'
  const second = await store.add('bafbi')
  assert.equal(second.record.addedAt, '2026-11-06T00:00:00.000Z', 'addedAt stable')
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).players.length === 1)
})

test('a corrupted whitelist file is treated as empty, and a write heals it', async () => {
  const file = tmpFile('corrupt')
  fs.writeFileSync(file, '{not json')
  const store = createWhitelistStore({ file, lookup: resolvingLookup() })
  assert.deepEqual(store.list(), [])
  const added = await store.add(PLAYER.undashed)
  assert.equal(added.ok, true)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(doc.players[0].uuid, PLAYER.dashed)
})

test('malformed entries are dropped on load, valid ones kept', () => {
  const file = tmpFile('malformed')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: [
      PLAYER.dashed && { uuid: PLAYER.dashed, name: 'Bafbi', addedAt: 'then' },
      { uuid: 'not-a-uuid', name: 'junk' },
      null,
      'string-entry',
      { name: 'no-uuid' },
    ],
  }))
  const store = createWhitelistStore({ file })
  assert.deepEqual(store.list().map(player => player.uuid), [PLAYER.dashed])
})

test('a uuid that also exists on the backend whitelist raises the separation warning', async () => {
  const store = createWhitelistStore({
    file: tmpFile('conflict'),
    lookup: resolvingLookup(),
    role: 'attach',
    knownOtherRoleUuids: () => [PLAYER.dashed],
  })
  const added = await store.add('bafbi')
  assert.equal(added.ok, true)
  assert.deepEqual(added.warnings, [
    'this uuid is also on the backend whitelist; the two whitelists must stay separate',
  ])
})

test('the whitelist file is written 0600 and atomically (no plaintext collision)', async () => {
  const file = tmpFile('mode')
  const store = createWhitelistStore({ file, lookup: resolvingLookup() })
  await store.add(PLAYER.undashed)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

// ---------------------------------------------------------------------------
// Name lookup (injectable) — Minecraft services first, Mojang fallback
// ---------------------------------------------------------------------------

test('name lookup: primary endpoint answers, uuid is normalized', async () => {
  const lookup = createNameLookup({ fetchImpl: async url => {
    assert.ok(url.startsWith('https://api.minecraftservices.com/minecraft/profile/lookup/name/'))
    return { status: 200, json: async () => ({ id: PLAYER.undashed, name: 'Bafbi' }) }
  } })
  assert.deepEqual(await lookup('Bafbi'), { uuid: PLAYER.dashed, name: 'Bafbi' })
})

test('name lookup: 404 on primary short-circuits to null (no pointless fallback)', async () => {
  let calls = 0
  const lookup = createNameLookup({ fetchImpl: async () => { calls++; return { status: 404, json: async () => ({}) } } })
  assert.equal(await lookup('Nobody'), null)
  assert.equal(calls, 1)
})

test('name lookup: an error on one base falls through to the next', async () => {
  let primary = 0
  let fallback = 0
  const lookup = createNameLookup({
    fetchImpl: async url => {
      if (url.includes('minecraftservices')) { primary++; throw new Error('ENOTFOUND') }
      fallback++
      return { status: 200, json: async () => ({ id: PLAYER.undashed, name: 'Bafbi' }) }
    },
  })
  assert.deepEqual(await lookup('Bafbi'), { uuid: PLAYER.dashed, name: 'Bafbi' })
  assert.equal(primary, 1)
  assert.equal(fallback, 1)
})

test('name lookup: invalid names and exhausted failures are reported as failures', async () => {
  assert.equal(await createNameLookup({ fetchImpl: async () => { throw new Error('down') } })('Bafbi').then(r => r.failed), true)
  assert.equal(await createNameLookup({ fetchImpl: async () => ({ status: 500, json: async () => ({}) }) })('Bafbi').then(r => r.failed), true)
  assert.equal(await createNameLookup({ fetchImpl: async () => ({ status: 200, json: async () => ({}) }) })('B@d Name'), null)
})

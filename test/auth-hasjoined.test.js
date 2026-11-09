// G1 hasJoined unit tests: pure stubs for the injectable fetch, UUID
// normalization, serverId parameter, fail-closed behavior, TTL cache.
// No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeUuid, sameUuid, sameName } from '../src/custody/util.js'
import { createHasJoined, computeServerId, normalizeProfile } from '../src/custody/hasjoined.js'

const PLAYER = {
  undashedUpper: '7FAD1E81B0E94A3C8CCB9E41F3A4B3AF',
  dashed: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af',
  name: 'Bafbi',
}

// Minimal fetch stub: a plain object shaped enough for the checker.
function stubFetch (status, body) {
  return async () => ({
    status,
    json: async () => body ?? {},
  })
}

// ---------------------------------------------------------------------------
// UUID normalization
// ---------------------------------------------------------------------------

test('UUID normalization: undashed, dashed, uppercase all canonicalize', () => {
  assert.equal(normalizeUuid(PLAYER.undashedUpper), PLAYER.dashed)
  assert.equal(normalizeUuid(PLAYER.undashedUpper.toLowerCase()), PLAYER.dashed)
  assert.equal(normalizeUuid(PLAYER.dashed), PLAYER.dashed)
})

test('UUID normalization rejects garbage, wrong lengths, and empties', () => {
  for (const bad of ['', null, undefined, 'zzz', '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3', 'g'.repeat(32),
    `${'a'.repeat(31)}g`, `${'a'.repeat(33)}`, '{}']) {
    assert.equal(normalizeUuid(bad), null, JSON.stringify(bad))
  }
})

test('strict UUID equality ignores case and dashes; names compare case-insensitively', () => {
  assert.equal(sameUuid(PLAYER.undashedUpper, PLAYER.dashed), true)
  assert.equal(sameUuid(PLAYER.dashed, 'dead'.padEnd(32, '0')), false)
  assert.equal(sameName('Bafbi', 'bafbi'), true)
  assert.equal(sameName('Bafbi', 'GlowSquidye'), false)
})

// ---------------------------------------------------------------------------
// hasJoined allow / deny / fail-closed
// ---------------------------------------------------------------------------

test('hasJoined: joined profile allows and normalizes the UUID', async () => {
  let requested = ''
  const hasJoined = createHasJoined({
    fetchImpl: async url => {
      requested = url
      return { status: 200, json: async () => ({ id: PLAYER.undashedUpper, name: PLAYER.name }) }
    },
  })
  const result = await hasJoined.check({ username: PLAYER.name, serverId: 'cafebabe' })
  assert.equal(result.ok, true)
  assert.equal(result.allowed, true)
  assert.equal(result.profile.uuid, PLAYER.dashed)
  // serverId parameter must reach the sessionserver query.
  assert.ok(requested.includes('/session/minecraft/hasJoined?username=Bafbi&serverId=cafebabe'))
})

test('hasJoined: sessionserver 204 / non-200 means not joined (allowed false)', async () => {
  const hasJoined = createHasJoined({ fetchImpl: stubFetch(204, null) })
  const result = await hasJoined.check({ username: 'Ghost', serverId: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'sessionserver_status_204')
})

test('hasJoined: profile name must cross-check the requested username', async () => {
  const hasJoined = createHasJoined({
    fetchImpl: stubFetch(200, { id: PLAYER.undashedUpper, name: 'SomeoneElse' }),
  })
  const result = await hasJoined.check({ username: PLAYER.name, serverId: 'x' })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'username_profile_mismatch')
})

test('hasJoined: known-expected UUID cross-check denies a different profile', async () => {
  const hasJoined = createHasJoined({
    fetchImpl: stubFetch(200, { id: PLAYER.undashedUpper, name: PLAYER.name }),
  })
  const result = await hasJoined.check({ username: PLAYER.name, serverId: 'x', uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'uuid_mismatch')
})

test('hasJoined: an unreachable sessionserver fails closed (never allow)', async () => {
  const hasJoined = createHasJoined({ fetchImpl: async () => { throw new Error('ENOTFOUND') } })
  const result = await hasJoined.check({ username: PLAYER.name, serverId: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.allowed, false, 'fail closed')
  assert.equal(result.reason.includes('sessionserver_unreachable'), true)
})

test('hasJoined: malformed bodies fail closed', async () => {
  const hasJoined = createHasJoined({ fetchImpl: stubFetch(200, { id: '!!!!', name: PLAYER.name }) })
  const result = await hasJoined.check({ username: PLAYER.name, serverId: 'x' })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'sessionserver_profile_invalid')
})

test('hasJoined: invalid requests never reach the network', async () => {
  let calls = 0
  const hasJoined = createHasJoined({ fetchImpl: async () => { calls++; return { status: 200, json: async () => ({}) } } })
  assert.deepEqual((await hasJoined.check({})).reason, 'invalid_request')
  assert.equal(calls, 0)
})

test('hasJoined: TTL cache serves repeats within the window and expires after it', async () => {
  let calls = 0
  let clock = 1000
  const hasJoined = createHasJoined({
    fetchImpl: async () => { calls++; return { status: 200, json: async () => ({ id: PLAYER.undashedUpper, name: PLAYER.name }) } },
    ttlMs: 500,
    now: () => clock,
  })
  const first = await hasJoined.check({ username: PLAYER.name, serverId: 's' })
  const second = await hasJoined.check({ username: PLAYER.name, serverId: 's' })
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  clock += 600 // past TTL
  const third = await hasJoined.check({ username: PLAYER.name, serverId: 's' })
  assert.equal(third.cached, false)
  assert.equal(calls, 2)
  assert.equal(hasJoined.size(), 1)
})

// ---------------------------------------------------------------------------
// serverId digest + profile shape
// ---------------------------------------------------------------------------

test('computeServerId hashes serverId string + secret + public key like the vanilla handshake', () => {
  assert.equal(computeServerId('', Buffer.alloc(0), Buffer.alloc(0)),
    'da39a3ee5e6b4b0d3255bfef95601890afd80709')
  const a = computeServerId('gate-b', Buffer.from('secret'), Buffer.from('pub'))
  const b = computeServerId('gate-b', Buffer.from('secret'), Buffer.from('pub'))
  const c = computeServerId('other', Buffer.from('secret'), Buffer.from('pub'))
  assert.equal(a, b, 'same material, same digest')
  assert.notEqual(a, c, 'different serverId string, different digest')
  assert.match(a, /^[0-9a-f]{40}$/)
})

test('normalizeProfile accepts sessionserver shape and throws away junk', () => {
  assert.deepEqual(normalizeProfile({ id: PLAYER.undashedUpper, name: PLAYER.name }),
    { uuid: PLAYER.dashed, name: PLAYER.name })
  assert.equal(normalizeProfile({ id: PLAYER.undashedUpper }), null, 'missing name')
  assert.equal(normalizeProfile({ name: PLAYER.name }), null, 'missing id')
})

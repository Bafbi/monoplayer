// B1 target: identity gates with an injected verifier (pure decisions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrontIdentity, DENY_REASONS, ALLOW_REASONS } from '../src/core/identity.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44' // "Bafbi" shape; placeholder
const PUPPET = '1e135e26-fed1-4a2c-8989-5a3bb7f9d3a4' // "GlowSquidye" shape

const identity = createFrontIdentity({
  attachWhitelist: [PLAYER],
  puppetProfile: { username: 'GlowSquidye', uuid: PUPPET }
})

test('whitelisted Login Start is allowed', () => {
  const decision = identity.reviewLoginStart({ uuid: PLAYER, name: 'Bafbi' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.reason, ALLOW_REASONS.WHITELISTED)
  assert.equal(decision.phase, 'login_start')
})

test('non-whitelisted Login Start is denied at phase login_start (deny before Login Success)', () => {
  const stranger = '3f7f2c60-5fd1-4b3c-94b7-000000000042'
  const decision = identity.reviewLoginStart({ uuid: stranger, name: 'Stranger' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, DENY_REASONS.NOT_WHITELISTED)
  assert.equal(decision.phase, 'login_start')
})

test('malformed/absent UUID cannot sneak past gate 1, denied with a distinct reason + surfaced identity', () => {
  const noUuid = identity.reviewLoginStart({ name: 'NoUuid' })
  assert.equal(noUuid.allowed, false)
  assert.equal(noUuid.reason, DENY_REASONS.MALFORMED_UUID)
  assert.equal(noUuid.phase, 'login_start')
  assert.equal(noUuid.name, 'NoUuid')

  const bad = identity.reviewLoginStart({ uuid: 'not-a-uuid', name: 'X' })
  assert.equal(bad.allowed, false)
  assert.equal(bad.reason, DENY_REASONS.MALFORMED_UUID, 'shape failure is not conflated with not_whitelisted')
  assert.equal(bad.uuid, 'not-a-uuid')
  assert.equal(bad.name, 'X')
})

test('injected verifier: exact profile match allows', async () => {
  const strict = createFrontIdentity({
    attachWhitelist: [PLAYER],
    verifyProfile: async ({ uuid, name }) => ({ id: uuid, name })
  })
  const decision = await strict.verifySession({ uuid: PLAYER, name: 'Bafbi', serverId: 'hash' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.reason, ALLOW_REASONS.VERIFIED)
})

test('injected verifier: identity mismatch denies (spoofed name/uuid), before Login Success', async () => {
  const strict = createFrontIdentity({
    attachWhitelist: [PLAYER],
    verifyProfile: async () => ({ id: PUPPET, name: 'GlowSquidye' })
  })
  const decision = await strict.verifySession({ uuid: PLAYER, name: 'Bafbi', serverId: 'hash' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, DENY_REASONS.VERIFY_FAILED)
})

test('injected verifier: offline (null profile) or thrown lookup denies, no crash', async () => {
  const absent = createFrontIdentity({
    attachWhitelist: [PLAYER],
    verifyProfile: async () => null
  })
  assert.equal((await absent.verifySession({ uuid: PLAYER, name: 'Bafbi' })).allowed, false)

  const broken = createFrontIdentity({
    attachWhitelist: [PLAYER],
    verifyProfile: async () => { throw new Error('mojang down') }
  })
  assert.equal((await broken.verifySession({ uuid: PLAYER, name: 'Bafbi' })).allowed, false)
})

test('no verifier injected: gate 2 explicitly passes through (offline/dev mode, documented)', async () => {
  const decision = await identity.verifySession({ uuid: PLAYER, name: 'Bafbi' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.reason, ALLOW_REASONS.NO_VERIFIER)
})

test('whitelist is case-insensitive on UUID', () => {
  assert.equal(identity.reviewLoginStart({ uuid: PLAYER.toUpperCase(), name: 'Bafbi' }).allowed, true)
})

test('whoAmI exposes configuration without secrets', () => {
  const me = identity.whoAmI()
  assert.deepEqual(me.puppet, { username: 'GlowSquidye', uuid: PUPPET })
  assert.equal(me.whitelist.length, 1)
  assert.equal(me.hasLiveVerifier, false)
})

// G1 attach-check unit tests: allow/deny decisions, events, denial ordering
// (all denials carry stage:'login' — the check runs before Login Success),
// sanitized payloads and redacted denial details. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createAttachCheck, DENY_REASONS } from '../src/custody/attach.js'

const PLAYER_UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const PUPPET_UUID = 'dead0000-0000-0000-0000-000000000001'

const allowedVerification = () => ({ ok: true, allowed: true, profile: { id: PLAYER_UUID, name: 'Bafbi' } })
const noop = () => {}

function collectors ({ events } = {}) {
  const seen = { allowed: [], denied: [] }
  if (events) {
    events.on('attachAllowed', a => seen.allowed.push(a))
    events.on('attachDenied', d => seen.denied.push(d))
  }
  return seen
}

test('allow: verified identity on the attach whitelist is admitted with a login-stage ok', async () => {
  const events = new EventEmitter()
  const seen = collectors({ events })
  const { check } = createAttachCheck({ events, log: noop })
  const result = await check({
    client: { username: 'Bafbi' },
    store: { has: uuid => uuid === PLAYER_UUID },
    verify: allowedVerification,
  })
  assert.equal(result.ok, true)
  assert.equal(result.uuid, PLAYER_UUID)
  assert.equal(result.reason, null)
  assert.equal(seen.allowed.length, 1)
  assert.equal(seen.allowed[0].uuid, PLAYER_UUID)
  assert.equal(seen.denied.length, 0)
})

test('deny: sessionserver says not joined → not_joined, stage login, attachDenied emitted', async () => {
  const events = new EventEmitter()
  const seen = collectors({ events })
  const { check } = createAttachCheck({ events, log: noop })
  const result = await check({
    client: { username: 'Ghost' },
    store: { has: () => true },
    verify: () => ({ ok: true, allowed: false, reason: 'sessionserver_status_204' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, DENY_REASONS.HASJOINED_NOT_JOINED)
  assert.equal(result.stage, 'login')
  assert.equal(seen.denied.length, 1)
  assert.equal(seen.denied[0].reason, 'not_joined')
})

test('deny: verify transport failure is hasjoined_failed (ok=false verdicts are not allow)', async () => {
  const events = new EventEmitter()
  const seen = collectors({ events })
  const { check } = createAttachCheck({ events, log: noop })
  const result = await check({
    client: { username: 'Bafbi' },
    store: { has: () => true },
    verify: () => ({ ok: false, allowed: false, reason: 'sessionserver_unreachable: ENOTFOUND' }),
  })
  assert.equal(result.reason, DENY_REASONS.HASJOINED_FAILED)
})

test('deny: uuid not on the whitelist is not_whitelisted and says which uuid', async () => {
  const events = new EventEmitter()
  const seen = collectors({ events })
  const { check } = createAttachCheck({ events, log: noop })
  const result = await check({
    client: { username: 'Bafbi' },
    store: { has: uuid => uuid === PUPPET_UUID },
    verify: allowedVerification,
  })
  assert.equal(result.reason, DENY_REASONS.NOT_WHITELISTED)
  assert.equal(result.uuid, PLAYER_UUID, 'denial carries the normalized uuid')
  assert.equal(seen.denied[0].stage, 'login')
})

test('deny: verified profile name must cross-check the requested username', async () => {
  const { check } = createAttachCheck({ log: noop })
  const result = await check({
    client: { username: 'Imposter' },
    store: { has: () => true },
    verify: () => ({ ok: true, allowed: true, profile: { id: PLAYER_UUID, name: 'Bafbi' } }),
  })
  assert.equal(result.reason, DENY_REASONS.NAME_MISMATCH)
})

test('deny without a username, without verify, or without a store', async () => {
  const { check } = createAttachCheck({ log: noop })
  assert.equal((await check({ client: {}, store: { has: () => true }, verify: allowedVerification })).reason,
    DENY_REASONS.MISSING_USERNAME)
  assert.equal((await check({ client: { username: 'Bafbi' }, store: { has: () => true } })).reason,
    DENY_REASONS.VERIFY_UNAVAILABLE)
  assert.equal((await check({ client: { username: 'Bafbi' }, verify: allowedVerification })).reason,
    DENY_REASONS.WHITELIST_UNAVAILABLE)
})

test('deny: a verify stub that throws produces verify_error', async () => {
  const { check } = createAttachCheck({ log: noop })
  const result = await check({
    client: { username: 'Bafbi' },
    store: { has: () => true },
    verify: () => { throw new Error('stub explode') },
  })
  assert.equal(result.reason, DENY_REASONS.VERIFY_ERROR)
  assert.equal(result.stage, 'login')
})

test('both normalized and raw sessionserver profiles are accepted', async () => {
  const store = { has: () => true }
  const rawShape = () => ({ ok: true, allowed: true, profile: { id: PLAYER_UUID.replaceAll('-', ''), name: 'Bafbi' } })
  const prenormalized = () => ({ ok: true, allowed: true, profile: { uuid: PLAYER_UUID, name: 'Bafbi' } })
  assert.equal((await createAttachCheck({ log: noop }).check({ client: { username: 'Bafbi' }, store, verify: rawShape })).ok, true)
  assert.equal((await createAttachCheck({ log: noop }).check({ client: { username: 'Bafbi' }, store, verify: prenormalized })).ok, true)
})

test('denial details are redacted: a token-shaped error never reaches the event', async () => {
  const seen = { denied: [] }
  const { check } = createAttachCheck({
    log: noop,
    events: { emit: (name, payload) => { if (name === 'attachDenied') seen.denied.push(payload) } },
  })
  const leaked = 'Bearer eyJhbGciOiJIUzI1NiJ9.payLoadPartHere.sigPartHere'
  await check({
    client: { username: 'Bafbi' },
    store: { has: () => true },
    verify: () => { throw new Error(`upstream said ${leaked}`) },
  })
  assert.equal(seen.denied.length, 1)
  const payload = JSON.stringify(seen.denied[0])
  const sentinels = ['eyJhbGciOiJIUzI1NiJ9', 'payLoadPartHere', 'sigPartHere']
  for (const sentinel of sentinels) {
    assert.equal(payload.includes(sentinel), false, `sentinel ${sentinel} must not survive redaction`)
  }
})

test('denial reasons are exactly the constant set the B4 row will assert on', () => {
  assert.deepEqual(Object.keys(DENY_REASONS).sort(), [
    'HASJOINED_FAILED', 'HASJOINED_NOT_JOINED', 'MISSING_USERNAME',
    'NAME_MISMATCH', 'NOT_WHITELISTED', 'PROFILE_INVALID',
    'VERIFY_ERROR', 'VERIFY_UNAVAILABLE', 'WHITELIST_UNAVAILABLE',
  ])
})

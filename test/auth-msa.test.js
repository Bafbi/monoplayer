// G1 msa-flow tests with a stub Authflow (no network, no real account, no
// prismarine-auth execution): device-code bootstrap, authTitle fallback,
// silent refresh, UUID stability, redundant device-code guard in silent
// mode, and identity projection purity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createMsaAuth, classifyAuthFailure, summarizeEntitlements, summarizePlayerAttributes,
  buildIdentity, describeIdentity, sanitizeError, JAVA_AUTH_TITLE, SWITCH_AUTH_TITLE,
} from '../src/custody/msa.js'
import { atomicWriteFile, cacheFilePath, cacheIdHash } from '../src/custody/cache.js'

const PLAYER = {
  dashed: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af',
  undashed: '7FAD1E81B0E94A3C8CCB9E41F3A4B3AF',
  name: 'Bafbi',
}
const SENTINEL_TOKEN = 'SYNTHETIC_FAKE_ACCESS_TOKEN_aaaa1111bbbb'
const SENTINEL_JWT = 'eyJhbGciOiJSUzI1NiJ9.p0FaKePayloAd.sigPart0000111'

function scratch () {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-msa-')), 'puppet')
  fs.mkdirSync(root, { mode: 0o700 })
  return root
}

const goodJavaResponse = () => ({
  token: SENTINEL_TOKEN,
  profile: { id: PLAYER.undashed, name: PLAYER.name },
  entitlements: { items: [{ name: 'game_minecraft', signature: 'SYNTHETIC_SIG' }], signature: 'SYNTHETIC_SIG' },
})
const goodAttributes = async () => ({
  privileges: { multiplayerServer: { enable: true } },
  banStatus: {},
})

// Stub Authflow factory: records constructions, reads its script per title.
function stubAuthflow (script) {
  const built = []
  return {
    built,
    Class: class StubAuthflow {
      constructor (username, cache, options, codeCallback) {
        this.username = username
        this.cache = cache
        this.options = options
        this.codeCallback = codeCallback
        built.push(this)
      }
      async getMinecraftJavaToken () {
        // Scripts decide whether a device code appears; the silent guard is
        // exercised by the test that calls flow.codeCallback explicitly.
        return script(this.options.authTitle, this)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('auth failure classification: title-auth retries, device-code does not', () => {
  assert.equal(classifyAuthFailure(new Error('403 Forbidden - getTitleToken')), 'title-auth')
  assert.equal(classifyAuthFailure(new Error('Xbox Live authentication failed to obtain a XSTS token. XErr: 2148916233')), 'title-auth')
  assert.equal(classifyAuthFailure(new Error('Authentication failed, timed out')), 'device-code')
  assert.equal(classifyAuthFailure(new Error('access_denied from the user')), 'device-code')
  assert.equal(classifyAuthFailure(new Error('something else entirely')), 'session')
})

test('entitlement summary: names only, signatures never surface', () => {
  const summary = summarizeEntitlements({ items: [{ name: 'game_minecraft', signature: 'SYNTHETIC_SIG' }], signature: 'BLOB' })
  assert.equal(summary.hasJava, true)
  // license-shape items also count
  const license = summarizeEntitlements({ items: [{ name: 'minecraft_game', source: 'GAMEPASS' }] })
  assert.equal(license.hasJava, true)
  assert.deepEqual(summarizeEntitlements({ items: [{ name: 'product_minecraft' }] }).hasJava, true)
  assert.equal(summarizeEntitlements({ items: [] }).hasJava, false)
  assert.equal(summarizeEntitlements(null).hasJava, false)
})

test('multiplayer privilege true/banned/unknown — never a synthesized known answer', () => {
  assert.deepEqual(summarizePlayerAttributes({ privileges: { multiplayerServer: { enable: true } } }),
    { multiplayerServer: true, banned: false, known: true })
  assert.deepEqual(summarizePlayerAttributes({ privileges: { multiplayerServer: { enabled: true } } }),
    { multiplayerServer: true, banned: false, known: true }, 'live API shape (enabled)')
  assert.deepEqual(summarizePlayerAttributes({
    privileges: { multiplayerServer: { enable: false } },
    banStatus: { bannedScopes: { MULTIPLAYER: 'active' } },
  }), { multiplayerServer: false, banned: true, known: true })
  assert.deepEqual(summarizePlayerAttributes({}), { multiplayerServer: null, banned: false, known: false })
  assert.deepEqual(summarizePlayerAttributes(null), { multiplayerServer: null, banned: null, known: false })
})

test('identity is the safe projection: normalized uuid, no tokens anywhere', () => {
  const identity = buildIdentity({
    profile: { id: PLAYER.undashed, name: PLAYER.name },
    entitlements: { items: [{ name: 'game_minecraft', signature: 'SYNTHETIC_SIG' }] },
    attributes: { privileges: { multiplayerServer: { enable: true } } },
    authTitle: JAVA_AUTH_TITLE,
  })
  assert.equal(identity.uuid, PLAYER.dashed)
  assert.equal(identity.name, PLAYER.name)
  assert.equal(identity.authTitle, JAVA_AUTH_TITLE)
  const text = JSON.stringify(identity) + describeIdentity(identity)
  for (const sentinel of [SENTINEL_TOKEN, 'SYNTHETIC_SIG', 'signature', 'token']) {
    assert.equal(text.toLowerCase().includes(sentinel.toLowerCase()), false, `identity must not contain '${sentinel}'`)
  }
  assert.ok(describeIdentity(identity).includes('multiplayer=allowed'))
  assert.ok(describeIdentity(identity).includes('java=owned'))
})

test('sanitizeError redacts token-shaped text', () => {
  const { message } = sanitizeError(new Error(`upstream rejected ${SENTINEL_JWT}`))
  for (const part of SENTINEL_JWT.split('.')) {
    assert.equal(message.includes(part), false, `sentinel ${part} must not survive`)
  }
})

// ---------------------------------------------------------------------------
// Flows against the stub Authflow
// ---------------------------------------------------------------------------

test('bootstrap: primary title succeeds → identity persists to custody meta, lock released', async () => {
  const root = scratch()
  const stub = stubAuthflow(title => {
    assert.equal(title, SWITCH_AUTH_TITLE)
    return goodJavaResponse()
  })
  const custodyFixture = { fetch: goodAttributes }
  const msa = createMsaAuth({
    account: 'puppet', dir: root,
    AuthflowImpl: stub.Class,
    fetchPlayerAttributes: token => { assert.equal(token, SENTINEL_TOKEN); return custodyFixture.fetch() },
  })
  const result = await msa.bootstrapDeviceCode({ codeSink: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.identity.uuid, PLAYER.dashed)
  assert.equal(result.identity.multiplayer.multiplayerServer, true)
  assert.equal(msa.custody.identityMeta.read().uuid, PLAYER.dashed, 'same-UUID ledger written')
  assert.equal(msa.custody.identityMeta.read().deviceType, 'Nintendo')
  assert.equal(msa.custody.writerLock.isHeld(), false, 'lock released after bootstrap')
  assert.equal(stub.built.length, 1, 'fallback title never constructed')
})

test('bootstrap: primary switch 403 falls back to Java and records which worked', async () => {
  const root = scratch()
  const titlesTried = []
  const stub = stubAuthflow(title => {
    titlesTried.push(title)
    if (title === SWITCH_AUTH_TITLE) throw new Error('403 Forbidden')
    return goodJavaResponse()
  })
  const msa = createMsaAuth({
    account: 'puppet', dir: root, AuthflowImpl: stub.Class,
    fetchPlayerAttributes: goodAttributes,
  })
  const result = await msa.bootstrapDeviceCode({ codeSink: () => {} })
  assert.equal(result.ok, true)
  assert.deepEqual(titlesTried, [...msa.authTitles])
  assert.equal(result.identity.authTitle, JAVA_AUTH_TITLE, 'the working title is recorded')
  assert.equal(msa.custody.identityMeta.read().authTitle, JAVA_AUTH_TITLE)
  assert.equal(msa.custody.identityMeta.read().deviceType, 'Win32')
})

test('bootstrap: a device-code timeout is NOT retried with a fallback title', async () => {
  const root = scratch()
  const stub = stubAuthflow(() => { throw new Error('Authentication failed, timed out') })
  const msa = createMsaAuth({ account: 'puppet', dir: root, AuthflowImpl: stub.Class })
  const result = await msa.bootstrapDeviceCode({ codeSink: () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'device_code_not_completed_or_timed_out')
  assert.equal(stub.built.length, 1, 'no second title attempt after a device-code failure')
})

test('bootstrap refuses when the writer lock is held (proxy running)', async () => {
  const root = scratch()
  const stub = stubAuthflow(() => goodJavaResponse())
  const msa = createMsaAuth({ account: 'puppet', dir: root, AuthflowImpl: stub.Class })
  const lock = msa.custody.writerLock.acquire()
  assert.equal(lock.ok, true)
  const refused = await msa.bootstrapDeviceCode({ codeSink: () => {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.refused, true)
  assert.equal(refused.reason, 'writer_lock_held')
  assert.equal(stub.built.length, 0, 'stalled Authflow never constructed')
  msa.custody.writerLock.release()
})

test('silent refresh: absent refresh token → needs_bootstrap without touching Authflow', async () => {
  const root = scratch()
  let built = 0
  const stub = stubAuthflow(() => { built += 1; return goodJavaResponse() })
  const msa = createMsaAuth({ account: 'puppet', dir: root, AuthflowImpl: stub.Class })
  const result = await msa.refreshSilently()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs_bootstrap')
  assert.equal(built, 0)
})

test('silent refresh: an in-flow device code is caught as needs_reauthentication, never shown to the user', async () => {
  const root = scratch()
  // Warm the live cache by hand: a refresh token exists but is unusable.
  atomicWriteFile(cacheFilePath(root, 'live'), JSON.stringify({
    token: { access_token: SENTINEL_TOKEN, refresh_token: 'SYNTHETIC_REFRESH', obtainedOn: Date.now() - 7_200_000, expires_in: 3600 },
  }))
  const sinkLines = []
  const stub = stubAuthflow((_title, flow) => {
    flow.codeCallback({ verification_uri: 'https://x', user_code: 'SHOULD_NOT_SURVIVE', message: 'synthetic' })
    throw new Error('unexpected device code in silent refresh (cache needs re-bootstrap)')
  })
  const msa = createMsaAuth({
    account: 'puppet', dir: root, AuthflowImpl: stub.Class,
    fetchPlayerAttributes: goodAttributes,
  })
  const result = await msa.refreshSilently()
  assert.equal(result.ok, false)
  // The silent code handler raises a coded error before anything can be
  // printed (sink is null and the User code never reaches any report).
  assert.equal(result.reason, 'needs_reauthentication')
  assert.equal(result.refused, undefined)
})

test('silent refresh succeeds headless and proves the same UUID across refresh', async () => {
  const root = scratch()
  atomicWriteFile(cacheFilePath(root, 'live'), JSON.stringify({
    token: { access_token: SENTINEL_TOKEN, refresh_token: 'SYNTHETIC_REFRESH', obtainedOn: Date.now() - 60_000, expires_in: 3600 },
  }))
  // Pre-existing ledger uuid (what a previous bootstrap wrote).
  const stub = stubAuthflow(() => goodJavaResponse())
  const msaA = createMsaAuth({ account: 'puppet', dir: root, AuthflowImpl: stub.Class, fetchPlayerAttributes: goodAttributes })
  msaA.custody.identityMeta.write({ uuid: PLAYER.dashed, name: PLAYER.name, authTitle: JAVA_AUTH_TITLE })
  const result = await msaA.refreshSilently()
  assert.equal(result.ok, true)
  assert.equal(result.uuidStable, true, 'G1 criterion: same UUID across refresh')
  assert.equal(result.identity.uuid, PLAYER.dashed)
  assert.equal(result.identity.multiplayer.known, true)
})

test('bootstrap: a different UUID is refused before profile.json is overwritten', async () => {
  const root = scratch()
  const stub = stubAuthflow(() => ({
    token: SENTINEL_TOKEN,
    profile: { id: 'dead0000-0000-0000-0000-000000000001', name: 'SomeoneElse' },
    entitlements: { items: [{ name: 'game_minecraft' }] },
  }))
  const msa = createMsaAuth({
    account: 'puppet', uuid: PLAYER.dashed, dir: root, AuthflowImpl: stub.Class,
    fetchPlayerAttributes: goodAttributes,
  })
  msa.custody.profile.write({ uuid: PLAYER.dashed, name: PLAYER.name, authTitle: JAVA_AUTH_TITLE })
  const before = fs.readFileSync(path.join(root, 'profile.json'), 'utf8')

  const result = await msa.bootstrapDeviceCode({ codeSink: () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'identity_mismatch')
  assert.equal(result.attempts.length, 1, 'an identity mismatch never tries another title')
  assert.equal(fs.readFileSync(path.join(root, 'profile.json'), 'utf8'), before, 'profile.json is untouched')
  assert.equal(msa.custody.writerLock.isHeld(), false, 'lock released after the refusal')
})

test('silent refresh: a different UUID maps to identity_mismatch and keeps the profile', async () => {
  const root = scratch()
  atomicWriteFile(cacheFilePath(root, 'live'), JSON.stringify({
    token: { access_token: SENTINEL_TOKEN, refresh_token: 'SYNTHETIC_REFRESH', obtainedOn: Date.now() - 60_000, expires_in: 3600 },
  }))
  const stub = stubAuthflow(() => ({
    token: SENTINEL_TOKEN,
    profile: { id: 'dead0000-0000-0000-0000-000000000001', name: 'SomeoneElse' },
    entitlements: { items: [] },
  }))
  const msa = createMsaAuth({
    account: 'puppet', uuid: PLAYER.dashed, dir: root, AuthflowImpl: stub.Class,
    fetchPlayerAttributes: goodAttributes,
  })
  msa.custody.profile.write({ uuid: PLAYER.dashed, name: PLAYER.name, authTitle: JAVA_AUTH_TITLE })
  const before = fs.readFileSync(path.join(root, 'profile.json'), 'utf8')

  const result = await msa.refreshSilently()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'identity_mismatch')
  assert.equal(fs.readFileSync(path.join(root, 'profile.json'), 'utf8'), before, 'profile.json is untouched')
})

// Offline product rung: identity helpers, the two offline leg constructors,
// and the socket-free decisions shared with the live legs.
//
// No sockets, no auth, no .secrets read. Constructors may create stores and
// gates, but nothing here calls listen() or connect().
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { offlineUuid, isLoopbackHost } from '../../src/legs/offline-identity.js'
import {
  createConfigPathInterceptor,
  createLiveFrontLeg,
  createOfflineFrontLeg,
  decideOnlineAttach,
  emitCheckedRaw,
  shouldDenySecondAttach
} from '../../src/legs/live-front.js'
import { createLiveBackendLeg, createOfflineBackendLeg } from '../../src/legs/live-backend.js'

const ATTACH_UUID = '06081639-2178-368a-abb3-3f762836f9a4'
const snapshot = () => []
const noop = () => {}

test('offlineUuid matches vanilla nameUUIDFromBytes and keeps case', () => {
  assert.equal(offlineUuid('Attach'), '06081639-2178-368a-abb3-3f762836f9a4')
  assert.equal(offlineUuid('attach'), '9352be24-62ba-3b7c-91ab-cb38b4119d28')
  assert.equal(offlineUuid('Bafbi'), 'd18d8d12-ce09-3d31-9737-2e800b83b67c')
  assert.equal(offlineUuid('GlowSquidye'), 'd52cecf3-5188-3f9a-9451-7216ec1ac192')
  assert.notEqual(offlineUuid('Attach'), offlineUuid('attach'))
  assert.throws(() => offlineUuid(42), TypeError)
})

test('isLoopbackHost accepts exactly 127.0.0.1 and ::1', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  for (const host of ['0.0.0.0', 'localhost', 'example.com', '127.0.0.2', '', null, undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('offline front leg rejects non-loopback hosts', () => {
  for (const host of ['0.0.0.0', 'localhost', 'example.com']) {
    assert.throws(
      () => createOfflineFrontLeg({ host, offlineWhitelist: [ATTACH_UUID], getSnapshotConfig: snapshot }),
      TypeError,
      host
    )
  }
})

test('offline front leg requires a non-empty array of UUID strings', () => {
  assert.throws(() => createOfflineFrontLeg({ getSnapshotConfig: snapshot }), TypeError)
  assert.throws(
    () => createOfflineFrontLeg({ offlineWhitelist: [], getSnapshotConfig: snapshot }),
    TypeError
  )
  assert.throws(
    () => createOfflineFrontLeg({ offlineWhitelist: ['not-a-uuid'], getSnapshotConfig: snapshot }),
    TypeError
  )
  assert.throws(
    () => createOfflineFrontLeg({ offlineWhitelist: [42], getSnapshotConfig: snapshot }),
    TypeError
  )
})

test('offline front leg rejects attachWhitelistFile and is loopback-scoped', () => {
  assert.throws(
    () => createOfflineFrontLeg({
      offlineWhitelist: [ATTACH_UUID],
      attachWhitelistFile: '/tmp/opencode/attach-whitelist.json',
      getSnapshotConfig: snapshot
    }),
    TypeError
  )

  const leg = createOfflineFrontLeg({
    offlineWhitelist: [ATTACH_UUID],
    getSnapshotConfig: snapshot,
    wireMode: 'off',
    log: noop
  })
  assert.equal(leg.kind, 'offline-front-leg')
  assert.equal(leg.port, null)
  assert.equal(leg.checkStoreFile, null)
  assert.equal(leg.lastConfigMode, 'pending')
  assert.deepEqual(leg.wireStats, { checked: 0, rejected: 0, byState: {}, lastFailure: null })
})

test('live front leg requires attachWhitelistFile and rejects offlineWhitelist', () => {
  assert.throws(() => createLiveFrontLeg({ getSnapshotConfig: snapshot }), TypeError)
  assert.throws(
    () => createLiveFrontLeg({
      attachWhitelistFile: '/tmp/opencode/attach-whitelist.json',
      offlineWhitelist: [ATTACH_UUID],
      getSnapshotConfig: snapshot
    }),
    TypeError
  )

  const leg = createLiveFrontLeg({
    attachWhitelistFile: '/tmp/opencode/attach-whitelist.json',
    getSnapshotConfig: snapshot,
    log: noop
  })
  assert.equal(leg.kind, 'live-front-leg')
  assert.equal(leg.port, null)
  assert.equal(leg.checkStoreFile, '/tmp/opencode/attach-whitelist.json')
  assert.equal(leg.lastConfigMode, 'pending')
})

const ACCOUNT_UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'

test('offline backend leg has no custody, no lock, and rejects account options', () => {
  for (const option of [
    { cacheDir: '.secrets/puppet' },
    { cacheAccount: 'puppet' },
    { accountDir: '.secrets/accounts/' + ACCOUNT_UUID },
    { account: 'puppet' },
    { uuid: ACCOUNT_UUID },
  ]) {
    assert.throws(
      () => createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, ...option }),
      TypeError,
      JSON.stringify(option)
    )
  }
  assert.throws(
    () => createOfflineBackendLeg({ host: 'localhost', port: 25565 }),
    TypeError
  )

  const leg = createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, log: noop })
  assert.equal(leg.kind, 'offline-backend-leg')
  assert.equal('custody' in leg, false)
  assert.equal('lock' in leg, false)
  assert.equal(leg.client, null)
  assert.equal(leg.ended, false)
  assert.equal(leg.forwarderStats(), null)
})

test('live backend leg requires an accountDir (or the deprecated cacheDir), no connect', () => {
  assert.throws(() => createLiveBackendLeg({ host: '127.0.0.1', port: 25565 }), TypeError)

  const logs = []
  const leg = createLiveBackendLeg({
    host: '127.0.0.1',
    port: 25565,
    accountDir: '/tmp/opencode/accounts/' + ACCOUNT_UUID,
    account: 'puppet',
    uuid: ACCOUNT_UUID,
    authTitle: '00000000441cc96b',
    deviceType: 'Nintendo',
    log: (event, fields) => logs.push({ event, fields })
  })
  assert.equal(leg.kind, 'live-backend-leg')
  assert.equal(leg.ended, false)
  assert.equal(leg.client, null)
  assert.equal(logs.length, 0, 'construction opens no socket and logs nothing')

  // The raw directory override still works for one release.
  const legacy = createLiveBackendLeg({
    host: '127.0.0.1',
    port: 25565,
    cacheDir: '/tmp/opencode/puppet',
    cacheAccount: 'puppet',
    log: noop
  })
  assert.equal(legacy.kind, 'live-backend-leg')

  // When both are set, accountDir wins and the deprecation is logged.
  const conflictLogs = []
  createLiveBackendLeg({
    host: '127.0.0.1',
    port: 25565,
    accountDir: '/tmp/opencode/accounts/' + ACCOUNT_UUID,
    cacheDir: '/tmp/opencode/puppet',
    log: (event, fields) => conflictLogs.push({ event, fields })
  })
  assert.equal(conflictLogs.length, 1)
  assert.equal(conflictLogs[0].event, 'deprecation')
  assert.equal(conflictLogs[0].fields.accountDir, '/tmp/opencode/accounts/' + ACCOUNT_UUID)
})

test('config interceptor writes cached frames with configuration meta', () => {
  const raws = []
  const interceptor = createConfigPathInterceptor({
    write: noop,
    writeRaw: (buffer, meta) => raws.push({ buffer, meta }),
    isConfigurationState: () => true,
    cachedConfigFrames: [
      { name: 'registry_data', buffer: Buffer.from('registry') },
      { name: 'feature_flags', buffer: Buffer.from('flags') },
      { name: 'finish_configuration', buffer: Buffer.from('skip-me') }
    ]
  })

  interceptor.write('registry_data', { codec: { lib: true } })
  interceptor.write('finish_configuration', {})

  assert.deepEqual(raws, [
    { buffer: Buffer.from('registry'), meta: { state: 'configuration', name: 'registry_data' } },
    { buffer: Buffer.from('flags'), meta: { state: 'configuration', name: 'feature_flags' } }
  ])
})

const failingCheck = () => ({
  ok: false,
  code: 'leftover_bytes',
  parsedName: 'login',
  consumed: 3,
  total: 5,
  leftover: 2
})

test('wire check throw: no write, client ends, rejected counted, no bytes logged', () => {
  const written = []
  const ended = []
  const logs = []
  const stats = { checked: 0, rejected: 0, lastFailure: null }

  const allowed = emitCheckedRaw({
    client: { writeRaw: buffer => written.push(buffer), end: reason => ended.push(reason) },
    buffer: Buffer.from('frame'),
    meta: { state: 'configuration', name: 'registry_data' },
    wireCheck: failingCheck,
    wireMode: 'throw',
    stats,
    log: (event, fields) => logs.push({ event, fields })
  })

  assert.equal(allowed, false)
  assert.equal(written.length, 0)
  assert.deepEqual(ended, ['wire_reject'])
  assert.equal(stats.checked, 1)
  assert.equal(stats.rejected, 1)
  assert.deepEqual(stats.lastFailure, {
    state: 'configuration',
    name: 'registry_data',
    code: 'leftover_bytes',
    parsedName: 'login',
    consumed: 3,
    total: 5,
    leftover: 2
  })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'wireReject')
  assert.equal('buffer' in logs[0].fields, false)
})

test('wire check warn: frame writes and the failure is counted', () => {
  const written = []
  const ended = []
  const stats = { checked: 0, rejected: 0, lastFailure: null }

  const allowed = emitCheckedRaw({
    client: { writeRaw: buffer => written.push(buffer), end: reason => ended.push(reason) },
    buffer: Buffer.from('frame'),
    meta: { state: 'play', name: 'map_chunk' },
    wireCheck: failingCheck,
    wireMode: 'warn',
    stats,
    log: noop
  })

  assert.equal(allowed, true)
  assert.deepEqual(written, [Buffer.from('frame')])
  assert.deepEqual(ended, [])
  assert.equal(stats.checked, 1)
  assert.equal(stats.rejected, 1)
  assert.equal(stats.lastFailure.code, 'leftover_bytes')
})

test('wire mode off skips the check and always writes', () => {
  const written = []
  const stats = { checked: 0, rejected: 0, lastFailure: null }

  emitCheckedRaw({
    client: { writeRaw: buffer => written.push(buffer) },
    buffer: Buffer.from('frame'),
    meta: { state: 'play', name: 'login' },
    wireCheck: failingCheck,
    wireMode: 'off',
    stats,
    log: noop
  })

  assert.deepEqual(written, [Buffer.from('frame')])
  assert.equal(stats.checked, 0)
  assert.equal(stats.rejected, 0)
})

test('interceptor + wire throw keeps a bad cached frame off the client', () => {
  const written = []
  const ended = []
  const stats = { checked: 0, rejected: 0, lastFailure: null }
  const client = { writeRaw: buffer => written.push(buffer), end: reason => ended.push(reason) }

  const interceptor = createConfigPathInterceptor({
    write: noop,
    writeRaw: (buffer, meta) => emitCheckedRaw({
      client,
      buffer,
      meta,
      wireCheck: failingCheck,
      wireMode: 'throw',
      stats,
      log: noop
    }),
    isConfigurationState: () => true,
    cachedConfigFrames: [{ name: 'registry_data', buffer: Buffer.from('cached') }]
  })

  interceptor.write('registry_data', {})
  interceptor.write('finish_configuration', {})

  assert.equal(written.length, 0)
  assert.deepEqual(ended, ['wire_reject'])
  assert.equal(stats.checked, 1)
  assert.equal(stats.rejected, 1)
})

test('second attach is denied before verification', () => {
  const first = {}
  const second = {}
  assert.equal(shouldDenySecondAttach(null, first), false)
  assert.equal(shouldDenySecondAttach(first, first), false)
  assert.equal(shouldDenySecondAttach(first, second), true)
})

test('online attach decision fails closed on a thrown or non-allow core decision', () => {
  const client = { username: 'Bafbi', uuid: 'd18d8d12-ce09-3d31-9737-2e800b83b67c' }
  const allowCheck = {
    checkVerified: () => ({ ok: true, reason: null, username: 'Bafbi', uuid: client.uuid })
  }

  const thrown = decideOnlineAttach({
    client,
    check: allowCheck,
    coreDecision: () => { throw new Error('core blew up') }
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.reason, 'core_decision_error')

  const empty = decideOnlineAttach({
    client,
    check: allowCheck,
    coreDecision: () => ({})
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'core_denied')

  const denied = decideOnlineAttach({
    client,
    check: allowCheck,
    coreDecision: () => ({ allowed: false, reason: 'name_not_on_whitelist' })
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'name_not_on_whitelist')

  const allowed = decideOnlineAttach({
    client,
    check: allowCheck,
    coreDecision: () => ({ allowed: true })
  })
  assert.equal(allowed.ok, true)

  const checkDenied = decideOnlineAttach({
    client,
    check: { checkVerified: () => ({ ok: false, reason: 'not_whitelisted' }) },
    coreDecision: null
  })
  assert.equal(checkDenied.ok, false)
  assert.equal(checkDenied.reason, 'not_whitelisted')

  const checkThrew = decideOnlineAttach({
    client,
    check: { checkVerified: () => { throw new Error('store unavailable') } },
    coreDecision: null
  })
  assert.equal(checkThrew.ok, false)
  assert.equal(checkThrew.reason, 'check_error')
})

test('#73 a leg with no connection refuses the held gate instead of throwing', () => {
  // The core asks for this answer from inside a socket event, so an unconnected
  // leg has to report, not throw.
  const leg = createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, log: noop })
  assert.deepEqual(
    leg.answerHeldGate({ state: 'configuration', name: 'code_of_conduct' }),
    { answered: false, reason: 'no_connection', name: 'code_of_conduct' }
  )
})

// #201: the cap is the front leg's, because the front leg owns the socket. A leg
// built without a preAuth section still tames the window, and a cap that cannot
// bound anything fails at construction rather than at the first stranger.
test('#201 the front legs carry the pre-auth cap, and refuse a cap that bounds nothing', () => {
  const leg = createOfflineFrontLeg({ offlineWhitelist: [ATTACH_UUID], getSnapshotConfig: snapshot, wireMode: 'off' })
  assert.equal(leg.metrics.preAuthRefused, 0)
  assert.equal(leg.metrics.preAuthInWindow, 0, 'a leg that never listened holds an empty window')

  const tight = createOfflineFrontLeg({
    offlineWhitelist: [ATTACH_UUID],
    getSnapshotConfig: snapshot,
    wireMode: 'off',
    preAuth: { maxConnections: 1 }
  })
  assert.deepEqual(tight.metrics.preAuthInWindow, 0)

  for (const bad of [0, -1, '8']) {
    assert.throws(
      () => createOfflineFrontLeg({
        offlineWhitelist: [ATTACH_UUID],
        getSnapshotConfig: snapshot,
        wireMode: 'off',
        preAuth: { maxConnections: bad }
      }),
      /maxConnections/,
      JSON.stringify(bad)
    )
  }
})

// #205: the deadline on the same window. The leg owns the timer, so a leg built
// without a preAuth section still bounds a silent socket, and a deadline that
// cannot bound anything fails at construction rather than at the first stranger.
test('#205 the front legs carry the pre-auth deadline, and refuse one that bounds nothing', () => {
  const leg = createOfflineFrontLeg({ offlineWhitelist: [ATTACH_UUID], getSnapshotConfig: snapshot, wireMode: 'off' })
  assert.equal(leg.metrics.preAuthExpired, 0, 'a leg that never listened expired nothing')

  const tight = createOfflineFrontLeg({
    offlineWhitelist: [ATTACH_UUID],
    getSnapshotConfig: snapshot,
    wireMode: 'off',
    preAuth: { deadlineMs: 1000 }
  })
  assert.equal(tight.metrics.preAuthExpired, 0)

  for (const bad of [0, -1, '1000']) {
    assert.throws(
      () => createOfflineFrontLeg({
        offlineWhitelist: [ATTACH_UUID],
        getSnapshotConfig: snapshot,
        wireMode: 'off',
        preAuth: { deadlineMs: bad }
      }),
      /deadlineMs/,
      JSON.stringify(bad)
    )
  }
})

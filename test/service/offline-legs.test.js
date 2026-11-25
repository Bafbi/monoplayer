// #391: the service can compose the offline legs, so a test lane serves a real
// Paper with no Minecraft account, no custody chain and no Microsoft auth.
//
// The seam is the composition function, not a socket: each case hands it four
// recording constructors and reads which one it asked for, and with which
// options. Nothing here connects, listens or reads a custody directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createServiceLegs, envOverlay, offlinePuppet } from '../../src/service/start-live.js'
import { DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'

const ATTACH_UUID = '06081639-2178-368a-abb3-3f762836f9a4'
const ACCOUNT_UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const snapshot = () => []

// Four constructors that record their call and answer an object with the kind
// they were asked for. A case reads the decision off the calls.
function recorders () {
  const calls = []
  const record = kind => options => {
    calls.push({ kind, options })
    return { kind, options }
  }
  return {
    calls,
    legs: {
      liveBackend: record('live-backend-leg'),
      liveFront: record('live-front-leg'),
      offlineBackend: record('offline-backend-leg'),
      offlineFront: record('offline-front-leg')
    }
  }
}

const lane = overrides => loadConfig({
  attachWhitelist: [ATTACH_UUID],
  front: { host: '127.0.0.1', port: 0 },
  backend: { host: '127.0.0.1', port: 25565 },
  ...overrides
})

const RESOLVED = {
  ok: true,
  account: {
    dir: '/data/accounts/' + ACCOUNT_UUID,
    alias: 'puppet',
    name: 'Puppet',
    uuid: ACCOUNT_UUID,
    profile: { name: 'Puppet', authTitle: null, deviceType: null }
  }
}

const kinds = calls => calls.map(call => call.kind)
const optionsOf = (calls, kind) => calls.find(call => call.kind === kind).options

test('#391 the switch is off by default, and only 1 and 0 are read', () => {
  assert.equal(DEFAULT_CONFIG.offlineLegs, false, 'a lane that names no switch keeps the live legs')
  assert.equal(envOverlay({}, { MONOPLAYER_OFFLINE_LEGS: '1' }).offlineLegs, true)
  assert.equal(envOverlay({}, { MONOPLAYER_OFFLINE_LEGS: '0' }).offlineLegs, false)

  // An unset variable is not a removal, and a typo leaves the lane on the only
  // legs that can talk to a real server.
  const doc = { offlineLegs: true }
  assert.equal(envOverlay(doc, {}).offlineLegs, true, 'an unset variable leaves the document alone')
  const warnings = []
  assert.equal(envOverlay(doc, { MONOPLAYER_OFFLINE_LEGS: 'yes' }, w => warnings.push(w)).offlineLegs, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /must be 1 or 0/)
  assert.equal(envOverlay({}, { MONOPLAYER_OFFLINE_LEGS: '' }).offlineLegs, undefined,
    'an empty value is unset, not a typo to warn about')
})

test('#391 loadConfig refuses an offlineLegs that is not a boolean', () => {
  assert.throws(() => loadConfig({ offlineLegs: '1' }), /config\.offlineLegs must be a boolean/)
  assert.equal(loadConfig({ offlineLegs: true }).offlineLegs, true)
})

test('#391 a lane with the switch off builds the live legs', () => {
  const { calls, legs } = recorders()
  const cfg = lane({})

  const built = createServiceLegs({
    cfg, resolved: RESOLVED, control: null, getSnapshotConfig: snapshot, legs
  })

  assert.deepEqual(kinds(calls), ['live-backend-leg', 'live-front-leg'])
  assert.equal(built.backend.kind, 'live-backend-leg', 'the caller receives the leg it built')
  assert.equal(built.front.kind, 'live-front-leg')
  const backend = optionsOf(calls, 'live-backend-leg')
  assert.equal(backend.accountDir, RESOLVED.account.dir, 'the live leg dials through the account directory')
  assert.equal(backend.uuid, ACCOUNT_UUID)
  assert.equal(backend.host, '127.0.0.1')

  const front = optionsOf(calls, 'live-front-leg')
  assert.equal(front.attachWhitelistFile, cfg.attachWhitelistFile)
  assert.equal(front.host, '127.0.0.1', 'the live front keeps the host the lane configures')

  // Neither live leg is handed the fence-lifting option: it belongs to the
  // offline pair, and a lane with the switch off must not be able to carry it.
  for (const kind of ['live-backend-leg', 'live-front-leg']) {
    assert.equal('allowNonLoopback' in optionsOf(calls, kind), false, kind)
  }
})

test('#391 a lane with the switch on builds the offline legs, with no custody', () => {
  const { calls, legs } = recorders()
  // The addresses a deployed test lane really has: a front bound to every
  // interface, and a Paper in another pod.
  const cfg = lane({
    offlineLegs: true,
    front: { host: '0.0.0.0', port: 25565 },
    backend: { host: 'paper.monoplayer-dev.svc.cluster.local', port: 25565 }
  })

  createServiceLegs({ cfg, resolved: null, control: null, getSnapshotConfig: snapshot, legs })

  assert.deepEqual(kinds(calls), ['offline-backend-leg', 'offline-front-leg'])

  const backend = optionsOf(calls, 'offline-backend-leg')
  assert.equal(backend.host, 'paper.monoplayer-dev.svc.cluster.local',
    'the offline body dials the lane backend the config names')
  assert.equal(backend.username, 'GlowSquidye', 'the offline puppet is a fixed name, not an account')
  for (const key of ['accountDir', 'account', 'uuid', 'cacheDir', 'cacheAccount']) {
    assert.equal(key in backend, false, 'the offline leg has no ' + key + ', and is handed none')
  }
  assert.equal(backend.allowNonLoopback, true, 'the composition root lifts the rung fence for a deployed lane')

  const front = optionsOf(calls, 'offline-front-leg')
  assert.equal(front.host, '0.0.0.0', 'a pod front binds every interface')
  assert.deepEqual(front.offlineWhitelist, [ATTACH_UUID], 'the lane still admits by whitelist')
  assert.equal(front.allowNonLoopback, true)
  assert.equal(front.chat, cfg.chat)
})

test('#391 the offline body joins as the name the lane selects', () => {
  const { calls, legs } = recorders()
  // The dev lane sets only the account selector, and an offline lane has no
  // account to resolve: it is the body's name.
  const cfg = lane({ offlineLegs: true, puppet: { account: 'devpuppet' } })
  createServiceLegs({ cfg, resolved: null, control: null, getSnapshotConfig: snapshot, legs })
  assert.equal(optionsOf(calls, 'offline-backend-leg').username, 'devpuppet')
})

test('#391 the whitelist file is the offline front list when the lane names one', () => {
  const { calls, legs } = recorders()
  const store = { has: () => true }
  const cfg = lane({ offlineLegs: true, attachWhitelist: [] })

  createServiceLegs({
    cfg, resolved: null, control: { whitelistStore: store }, getSnapshotConfig: snapshot, legs
  })

  const front = optionsOf(calls, 'offline-front-leg')
  assert.equal(front.whitelistStore, store, 'the reloading store is what the leg reads at each login')
  assert.equal(front.offlineWhitelist, null, 'and the frozen array would only shadow it')
})

test('#391 the offline puppet is named, and its UUID is the one that name derives', () => {
  // A known-good literal, from the offline identity's own worked example.
  assert.deepEqual(offlinePuppet({}), {
    username: 'GlowSquidye',
    uuid: 'd52cecf3-5188-3f9a-9451-7216ec1ac192'
  })
  assert.deepEqual(offlinePuppet({ username: 'devpuppet' }), {
    username: 'devpuppet',
    uuid: offlineUuid('devpuppet')
  })
  // The dev lane names its account and nothing else, and an offline lane has no
  // account to resolve: the selector is the name.
  assert.deepEqual(offlinePuppet({ account: 'devpuppet' }), {
    username: 'devpuppet',
    uuid: offlineUuid('devpuppet')
  })
  // An explicit username wins over the selector, so a lane can keep both.
  assert.equal(offlinePuppet({ account: 'devpuppet', username: 'puppet' }).username, 'puppet')
  // A UUID that agrees is accepted, so a lane may assert the identity it expects.
  assert.equal(offlinePuppet({ username: 'devpuppet', uuid: offlineUuid('devpuppet') }).uuid,
    offlineUuid('devpuppet'))
})

test('#391 a UUID the offline name does not derive is refused, not carried', () => {
  // The backend derives the UUID from the name on its own side, so a lane that
  // kept another one would name a player the server does not have.
  assert.throws(
    () => offlinePuppet({ username: 'devpuppet', uuid: ACCOUNT_UUID }),
    /offline_puppet_uuid_mismatch: config asserts 7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af, and the offline UUID of devpuppet is/
  )
})

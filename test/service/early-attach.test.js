// #16: the front configuration path for a pre-warm early attach.
//
// A client may attach while the puppet's backend connection is still in its
// configuration phase. The core streams the puppet's configuration frames to
// it, refuses to send play frames until the client itself is in play, and
// replays the join prefix and warm state as soon as the backend is warm.
//
// The warm attach path is pinned by test/monoplayer-integration.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const OTHER = '3f7f2c60-5fd1-4b3c-94b7-000000000042'

// The front's own wiring: gate 1, then the configuring attach, then the
// play-ready callback its library fires at playerJoin.
function frontAttach (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  const decision = rig.frontLeg.loginStart({ name, uuid })
  assert.equal(decision.allowed, true)
  assert.equal(decision.phase, 'configuring')
  const configuring = rig.core.attachConfiguringPlayer({ name, uuid })
  assert.equal(configuring.attached, true)
  return configuring
}

function playReady (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  return rig.core.attachPlayer({ name, uuid, includeConfig: false })
}

function joinPrefix (rig, { from = 0 } = {}) {
  const frames = [
    { name: 'login', data: { entityId: 42, viewDistance: 10 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]
  for (const frame of frames.slice(from)) rig.backendLeg.deliver({ state: 'play', ...frame })
}

test('#16 a client attaches during configuration and follows the live stream', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.equal(rig.core.backendConfiguring, true)

  frontAttach(rig)
  assert.equal(rig.core.session.state, 'configuring')
  assert.equal(rig.core.metrics.attachesConfiguring, 1)

  rig.backendLeg.deliver({ state: 'configuration', name: 'select_known_packs', data: {} })
  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })

  const streamed = rig.frontLeg.frames().filter(frame => frame.kind === 'raw')
  assert.deepEqual(
    streamed.map(frame => frame.name),
    ['registry_data', 'select_known_packs', 'finish_configuration'],
    'the puppet configuration reaches the client frame by frame'
  )
  assert.equal(streamed.every(frame => frame.meta?.state === 'configuration'), true)
  assert.equal(rig.core.metrics.configFramesRelayed, 3)
})

test('#16 no play frame reaches the client before its own configuration ends', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontAttach(rig)
  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })

  // The backend logs in and starts sending play state while the client has not
  // reported its own configuration as finished.
  joinPrefix(rig)

  const playNames = rig.frontLeg.frames().filter(frame => frame.meta?.state === 'play').map(frame => frame.name)
  assert.deepEqual(playNames, [], 'nothing in play goes to a configuring client')
  assert.equal(rig.core.session.state, 'attached', 'the session is attached at the backend login')
})

test('#16 a play-ready client gets the warm replay once the backend is warm', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontAttach(rig)
  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })

  // Client ready before the backend warm: the replay waits.
  const pending = playReady(rig)
  assert.equal(pending.attached, true)
  assert.equal(pending.pending, true)

  joinPrefix(rig)
  // Play frames plus the synthesized position (a packet write, no raw meta).
  const replayNames = rig.frontLeg.frames()
    .filter(frame => frame.meta?.state !== 'configuration')
    .map(frame => frame.name)
  assert.deepEqual(
    replayNames.slice(0, 6),
    ['login', 'game_state_change', 'position', 'chunk_batch_start', 'map_chunk', 'chunk_batch_finished'],
    'the replay lands once the join prefix is warm'
  )
  assert.equal(rig.core.session.warmReady, true)
})

test('#16 a play-ready client after warm is replayed immediately', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontAttach(rig)
  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  joinPrefix(rig)

  const outcome = playReady(rig)
  assert.equal(outcome.replayed > 0, true)
  assert.equal(rig.frontLeg.frames().some(frame => frame.name === 'map_chunk'), true)
})

test('#16 a second client is rejected while one is configuring', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontAttach(rig)

  const second = rig.core.attachConfiguringPlayer({ name: 'Second', uuid: OTHER })
  assert.equal(second.attached, false)
  assert.equal(second.reason, 'already_attached')
})

test('#16 a configuring attach is refused when no backend configuration is open', () => {
  const rig = makeCore()
  const outcome = rig.core.attachConfiguringPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, false)
  assert.equal(outcome.reason, 'not_ready')
  const decision = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(decision.allowed, false, 'gate 1 still refuses an attach with no backend session')
})

test('#16 a backend fault during configuration detaches the configuring client', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontAttach(rig)

  rig.backendLeg.deliverEnd({ reason: 'backend_restart' })
  assert.equal(rig.frontLeg.endReasons().length, 1, 'the client is kicked, never stranded')
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.attached, false)
})

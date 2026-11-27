// #683: the core publishes the attach it performed.
//
// The cut a parity rung compares is three facts about one replay: the state
// snapshot it was built from, the pose it synthesized into it, and the frames it
// wrote. The core holds all three while it builds the replay and used to keep
// them to itself, so three lanes (two rigs in src/ladder/loopback.js, one wrapper
// in src/ladder/online.js) each took their own copy of the snapshot and the pose
// around the attach call and read the outcome's frames afterwards.
//
// Seam: the event, on a core built on the fake legs, because the question is what
// the core publishes and when, not what a lane does with it. test/support/
// harness.js takes no listener, so a case subscribes on the core it is handed and
// attaches through the core, which is the API a lane's leg reaches.
//
// The claim: one 'attach' event per attach replay, carrying the values that replay
// used; nothing when no replay happens; and the snapshot stays the one that was
// replayed after later frames arrive.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const SECOND = '3f7f2c60-5fd1-4b3c-94b7-000000000042'

// The join prefix the cache warms on: the warm marker is chunk_batch_finished.
function joinPrefix (rig) {
  for (const frame of [
    { name: 'login', data: { entityId: 42, viewDistance: 10 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) rig.backendLeg.deliver({ state: 'play', ...frame })
}

// One core warmed by a prefix, with a listener on the event.
function warmCore () {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  joinPrefix(rig)
  assert.equal(rig.core.cache.warm, true, 'the prefix warmed the cache')
  assert.equal(rig.core.session.warmReady, true, 'and the session, which is the attach gate')
  const events = []
  rig.core.on('attach', event => events.push(event))
  return { rig, events }
}

test('#683 the attach event carries the replay\'s own cut, in one shape', () => {
  const { rig, events } = warmCore()
  const cut = rig.core.cache.snapshot()
  const pose = { ...rig.core.session.currentPose }

  const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'the attach happened, so it has a cut to publish')

  assert.equal(events.length, 1, 'one replay publishes one event')
  const [event] = events
  // The whole shape, not the fields this case reads: a field added later is a
  // decision, and reconnect_due is pinned the same way
  // (test/service/reconnect.test.js:91).
  assert.deepEqual(Object.keys(event).sort(),
    ['frames', 'name', 'pose', 'reason', 'replayed', 'snapshot'],
    'the event is the six facts a reader of one replay wants together')
  assert.equal(event.name, 'Bafbi', 'the client the replay was built for')
  assert.equal(event.reason, 'attach', 'a warm play login, which is the row the handler reaches')
  assert.equal(event.replayed, outcome.replayed, 'the count the record carries, from the same expression')
  assert.deepEqual(event.frames, outcome.frames, 'the frames the replay wrote, not a reconstruction of them')
  assert.deepEqual(event.snapshot, cut,
    'the snapshot the replay was built from, as the cache stood at the call')
  assert.deepEqual(event.pose, pose, 'and the pose the replay was built with')
})

test('#683 the cut is the value the replay used, and a later frame does not rewrite it', () => {
  const { rig, events } = warmCore()
  const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  const [event] = events

  // The rings are bounded FIFOs and the replay is one turn, so a lane that
  // re-read the cache later would compare a state the client never received.
  // The event was written from the replay's own copy, so this cannot move it.
  const before = rig.core.cache.snapshot()
  rig.backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 1, z: 1 } })
  assert.deepEqual(event.snapshot, before, 'a frame after the replay leaves the published cut alone')
  assert.deepEqual(event.frames, outcome.frames, 'and so do the frames it wrote')

  // And the replay it names is the one that was written: the join prefix is in
  // the cut, so a listener can say what the client should have decoded.
  assert.ok(event.frames.some(frame => frame.name === 'map_chunk'),
    'the frames the event carries are the attach stream, not an empty list')
})

test('#683 a deferred replay publishes when it happens, against the state it replayed', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  const decision = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(decision.allowed, true, 'the front admits the client while the puppet configures')
  assert.equal(rig.core.attachConfiguringPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)

  const events = []
  rig.core.on('attach', event => events.push(event))
  // The state at the call: unwarm, and not what the client will be sent.
  const atTheCall = rig.core.cache.snapshot()
  assert.equal(atTheCall.warm, false, 'nothing has warmed yet, so there is no state to replay')

  const pending = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(pending.pending, true, 'the replay is deferred until the backend is warm')
  assert.deepEqual(events, [], 'a call that replays nothing publishes nothing')

  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  joinPrefix(rig)

  assert.equal(events.length, 1, 'the deferred replay publishes one event, where it happens')
  const [event] = events
  assert.equal(event.reason, 'early_attach', 'and names the path it took')
  assert.equal(event.snapshot.warm, true,
    'the cut is the warm state the replay was built from, not the unwarm state at the call that deferred it')
  assert.ok(event.snapshot.prefix.some(frame => frame.name === 'chunk_batch_finished'),
    'which is the join prefix the replay sent')
  assert.ok(event.frames.some(frame => frame.name === 'map_chunk'),
    'and the stream built from it')
})

test('#683 an attach the core refuses publishes no replay', () => {
  const { rig, events } = warmCore()
  assert.equal(rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)
  assert.equal(events.length, 1, 'the first client has its replay')

  const refused = rig.core.attachPlayer({ name: 'Second', uuid: SECOND })
  assert.equal(refused.attached, false, 'a second client is refused while one is attached')
  assert.equal(refused.reason, 'already_attached')
  assert.equal(events.length, 1, 'a refusal replays nothing, so it publishes nothing')
})

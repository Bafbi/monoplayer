// #597, #627: the snapshot's pre-auth group.
//
// Seam: the fake-integration rig's core built on a front leg the test holds
// (test/support/harness.js), because the question is what the core asks its leg and
// when. The window's own numbers are test/core/preauth-window.test.js's subject.
//
// The rule this file pins: `laneState()` carries the pre-auth window as the leg
// answers it, read at the call, and the group is null — not zero, not an empty
// object — for a lane whose leg declares no such read. A missing group and a group
// of zeroes are different facts about a lane, and an operator reads the difference.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { fakeClock } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const PUPPET = { username: 'GlowSquidye', uuid: null }

// A lane's reading of its pre-auth window, in the five names src/core/preauth-window.js
// answers with. A busy lane: two sockets in the window, one refusal, one expiry.
const WINDOW = { inWindow: 2, maxConnections: 16, deadlineMs: 30_000, refused: 1, expired: 1 }

// One started core on a front leg the test supplies, so a test can declare the read
// on the leg before start() and keep a handle on it afterwards.
function coreOn (frontLeg) {
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: PUPPET }),
    backendLeg: createFakeBackendLeg(),
    frontLeg,
    clock: fakeClock()
  })
  core.start()
  return core
}

test('#627 a lane whose leg declares the read carries the window, in the window\'s own names', () => {
  const core = coreOn(Object.assign(createFakeFrontLeg(), { preAuthStats: () => ({ ...WINDOW }) }))

  const { preAuth } = core.laneState()

  assert.deepEqual(Object.keys(preAuth).sort(),
    ['deadlineMs', 'expired', 'inWindow', 'maxConnections', 'refused'],
    'the group is the five numbers src/core/preauth-window.js answers with, under its names')
  assert.deepEqual(preAuth, WINDOW, 'and the values are what the leg answered, not a summary of them')
})

test('#627 the group is read at the call, so a later snapshot carries later numbers', () => {
  let window = { ...WINDOW }
  const core = coreOn(Object.assign(createFakeFrontLeg(), { preAuthStats: () => ({ ...window }) }))

  assert.equal(core.laneState().preAuth.inWindow, 2, 'two sockets are in the window')

  window = { inWindow: 0, maxConnections: 16, deadlineMs: 30_000, refused: 2, expired: 1 }

  assert.equal(core.laneState().preAuth.inWindow, 0,
    'a snapshot taken after the sockets left reads the window it is taken at, not the one captured at start')
  assert.equal(core.laneState().preAuth.refused, 2, 'and the refusal it counted since')
})

test('#627 the counters come from the window, not from the leg\'s metrics bag', () => {
  // The counter path this group exists to end: the leg folds two of the window's
  // numbers into `metrics`, and a snapshot that read those would be a second home
  // for a count that moves. Here the two disagree, and the window wins.
  const leg = Object.assign(createFakeFrontLeg(), {
    preAuthStats: () => ({ ...WINDOW }),
    metrics: { preAuthInWindow: 99, preAuthExpired: 99, allowed: 0 }
  })
  const core = coreOn(leg)

  assert.equal(core.laneState().preAuth.inWindow, 2, 'the window\'s count, not the bag\'s')
  assert.equal(core.laneState().preAuth.expired, 1, 'and its expiry count, not the bag\'s')
})

test('#627 the read is a row of the front table, so a leg without it is named', () => {
  // The row and the call are two jobs: the row is what the wiring report answers, and
  // what test/legs/adapters.test.js holds every real front leg to. Without a test that
  // reads `called`, a leg could keep the method under another name and only the
  // snapshot would notice.
  const core = coreOn(Object.assign(createFakeFrontLeg(), { preAuthStats: () => ({ ...WINDOW }) }))

  assert.ok(core.legWiring.front.called.includes('preAuthStats'),
    'the report names the read the snapshot takes, so a lane logs a leg that carries it')

  const bare = coreOn(createFakeFrontLeg())
  assert.ok(bare.legWiring.front.missing.includes('preAuthStats'),
    'and a leg that carries none is a hole in the report rather than a silent null')
})

test('#627 a lane whose leg declares no read carries null, not zeros', () => {
  // createFakeFrontLeg carries no window and no read: it is src/legs/fake-legs.js,
  // the front every service rig builds, and the shape a body leg has too.
  const core = coreOn(createFakeFrontLeg())

  const state = core.laneState()

  assert.deepEqual(Object.keys(state).sort(), ['bodies', 'preAuth'],
    'the group is named on every lane, so a reader never has to ask whether it exists')
  assert.equal(state.preAuth, null,
    'and a lane with no window says null: four zeroes are a quiet window, which this lane does not have')
  assert.notDeepEqual(state.preAuth, {}, 'an empty object would read as a window that answers nothing')
})

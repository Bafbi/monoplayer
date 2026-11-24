// #18/#269: which client information frames the front leg reports to the core.
// The decision is the channel's role, not a slot: the fields the puppet sends are
// the driver's, and a spectator's are its own, recorded on its own channel.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reportsClientInformation } from '../../src/legs/live-front.js'

test('the driver reports its configuration-phase information', () => {
  assert.equal(reportsClientInformation({ role: 'driver', state: 'configuration' }), true)
})

test('a play-state change is left to the serverbound rewrite', () => {
  assert.equal(reportsClientInformation({ role: 'driver', state: 'play' }), false)
})

test('a connection that holds no channel reports nothing', () => {
  assert.equal(reportsClientInformation({ role: null, state: 'configuration' }), false)
  assert.equal(reportsClientInformation({}), false)
})

test('a spectator never reports over the driver', () => {
  assert.equal(reportsClientInformation({ role: 'spectator', state: 'configuration' }), false)
  assert.equal(reportsClientInformation({ role: 'spectator', state: 'play' }), false)
})

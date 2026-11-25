// #261: a body's lifecycle, and the two rules the picker can see.
//
// Seam: the fake-integration rig (test/support/harness.js). What a socket hides is
// the decision this file pins — whether a fault arms a retry, whether a requested
// end takes the body down, and which of the two the session lands in. O64 proves the
// same path over a real socket, with a real protocol bot and a client that clicks
// Disconnect.
//
// The rules (#261):
//   1. a claim is the reason a body is kept alive, so a body nobody claims stays
//      down when its session faults, and a body whose claim is held still reconnects;
//   2. a client may end a body on request, and only while nobody claims it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickSlug } from '../../src/core/picker.js'
import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const TARGET = { host: '127.0.0.1', port: 25566 }
const CLAIMED = { body: pickSlug(TARGET.host + ':' + TARGET.port), target: TARGET }

// The body's join, cached: configuration first, then its play login and the warm
// marker the claim landing waits on.
function warmABody (backendLeg) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', buffer: Buffer.from('config:registry_data') })
  backendLeg.deliver({ state: 'play', name: 'login', buffer: Buffer.from('play:login'), data: { entityId: 42 } })
  backendLeg.deliver({ state: 'play', name: 'position', buffer: Buffer.from('play:position'), data: { x: 1, y: 2, z: 3 } })
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', buffer: Buffer.from('marker'), data: {} })
}

async function landABody (rig) {
  const dial = rig.core.connectClaimedBody(CLAIMED)
  await Promise.resolve()
  warmABody(rig.backendLeg)
  rig.clock.tick(50)
  const landed = await dial
  assert.equal(landed.connected, true, 'the fixture body lands')
  return landed
}

test('#261 a body nobody claims stays down when its session faults, and arms no retry', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  const cache = rig.core.cache
  assert.equal(rig.core.session.state, 'warm')

  // Nobody holds a claim on it: the front leg's board is empty, and the session
  // asks that board rather than keeping a copy of its own.
  rig.backendLeg.deliverEnd({ reason: 'body_fault' })
  assert.equal(rig.core.session.state, 'down')
  assert.equal(rig.core.session.pendingReconnect, false, 'no retry is armed for a body nobody holds')
  assert.deepEqual(rig.events, [], 'and no reconnect is announced to the adapter')
  assert.equal(rig.core.session.isAttachReady(), false)
  assert.equal(cache.warm, false, 'the cache went with the session')

  // A spectator is told the body is down, in the sentence that asks for a claim.
  const refused = rig.core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body })
  assert.equal(refused.watching, false)
  assert.equal(refused.reason, 'body_down')

  // The retry that was never armed cannot fire later either.
  rig.clock.tick(60_000)
  assert.equal(rig.core.session.state, 'down')
  assert.equal(rig.backendLeg.dialledTargets().length, 1, 'the body dialled once and was not dialled again')
})

test('#261 a body whose claim is held reconnects, and comes back to the same claim', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.frontLeg.claim(CLAIMED.body, { name: 'Pilot' })

  rig.backendLeg.deliverEnd({ reason: 'body_fault' })
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.session.pendingReconnect, true, 'the claim is what buys the retry')

  // The dial the claim paid for opens, and the body logs in again. The claim was
  // never released, so the body comes back to the client that kept it: one body,
  // two backend logins, and the same claim on the front's board.
  rig.clock.tick(1000)
  assert.equal(rig.core.session.state, 'boot')
  assert.deepEqual(rig.events.map(event => event.attempt), [1], 'the adapter is told to dial once')
  warmABody(rig.backendLeg)
  assert.equal(rig.core.session.state, 'warm')
  assert.equal(rig.core.session.backendLogins, 2)
  assert.equal(rig.core.session.isAttachReady(), true, 'the body is up again, and a client may enter it')
  assert.equal(rig.core.cache.warm, true, 'and its cache is the one the new session warmed')
  assert.equal(rig.frontLeg.claimOn(CLAIMED.body).name, 'Pilot', 'the claim is still the one that kept it')
})

test('#261 a claim that ends while an attempt is pending spends no further attempt', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.frontLeg.claim(CLAIMED.body, { name: 'Pilot' })

  rig.backendLeg.deliverEnd({ reason: 'body_fault' })
  assert.equal(rig.core.session.state, 'reconnecting')

  // The attempt fires against a body nobody claims any more, and it fails: there
  // is nothing left to come back for, so it is the last attempt, not a loop.
  rig.frontLeg.releaseClaim(CLAIMED.body)
  rig.clock.tick(1000)
  assert.equal(rig.core.session.state, 'boot')
  rig.backendLeg.deliverEnd({ reason: 'refused' })
  assert.equal(rig.core.session.state, 'down')
  assert.equal(rig.core.session.pendingReconnect, false)
  assert.equal(rig.clock.pending, 0)
  rig.clock.tick(60_000)
  assert.equal(rig.core.session.state, 'down')
})

test('#261 a body a player asked to end goes down, and its channels end with it', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  const cache = rig.core.cache

  const asked = rig.core.disconnectBody({ body: CLAIMED.body, server: CLAIMED.body, name: 'Pilot' })
  assert.equal(asked.ended, true)
  assert.equal(asked.reason, 'requested')
  assert.equal(asked.body, CLAIMED.body)
  assert.equal(rig.core.session.state, 'down')
  assert.equal(rig.core.session.pendingReconnect, false, 'the end arms no retry')
  assert.deepEqual(rig.events, [], 'and nothing is announced to the adapter to dial')
  assert.equal(cache.warm, false)
  assert.deepEqual(rig.frontLeg.endReasons().map(entry => entry.reason), ['body_disconnected'],
    'every channel watching the body ends with it')

  // The session is still the one this lane serves, so a claim is what dials it
  // back: the row says the body is down, not that the lane serves another server.
  assert.equal(rig.core.claimedBody, CLAIMED.body)
  assert.equal(rig.core.metrics.bodyDisconnects, 1)

  rig.clock.tick(60_000)
  assert.equal(rig.core.session.state, 'down', 'a body that was ended is not retried')
})

test('#261 the body a client asked to end is the body that ends', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)

  // A row naming another body: this session serves one, so the frame names
  // something that is not there to end.
  const elsewhere = rig.core.disconnectBody({ body: 'sky', server: 'sky:25565', name: 'Pilot' })
  assert.equal(elsewhere.ended, false)
  assert.equal(elsewhere.reason, 'body_not_served')
  assert.equal(elsewhere.body, CLAIMED.body)
  assert.equal(rig.core.session.state, 'warm', 'a refusal ends nothing')

  // A lane that has dialled nothing has no body to end.
  const bare = makeCore({ config: { picker: true } })
  const nothing = bare.core.disconnectBody({ body: CLAIMED.body })
  assert.equal(nothing.ended, false)
  assert.equal(nothing.reason, 'no_body')

  // And a lane with no picker has no claims, so no client may end a body there.
  const off = makeCore()
  assert.deepEqual(off.core.disconnectBody({ body: CLAIMED.body }), {
    ended: false,
    reason: 'picker_off',
    body: CLAIMED.body
  })
})

test('#261 a body a client is standing in cannot be ended on request', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  assert.equal(rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)

  const refused = rig.core.disconnectBody({ body: CLAIMED.body, server: CLAIMED.body, name: 'Rival' })
  assert.equal(refused.ended, false)
  assert.equal(refused.reason, 'client_attached')
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.attached, true, 'the driver keeps the body they are standing in')
  assert.equal(rig.frontLeg.endReasons().length, 0, 'and loses no channel for the asking')
})

test('#261 a claim dials a body back after it was ended', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.disconnectBody({ body: CLAIMED.body, server: CLAIMED.body, name: 'Pilot' })
  assert.equal(rig.core.session.state, 'down')

  const again = rig.core.connectClaimedBody(CLAIMED)
  await Promise.resolve()
  assert.equal(rig.core.session.state, 'boot', 'the claim is the dial, out of down the way it left boot')
  warmABody(rig.backendLeg)
  rig.clock.tick(50)
  const landed = await again
  assert.equal(landed.connected, true)
  assert.equal(rig.core.metrics.claimDials, 2)
  assert.equal(rig.core.session.state, 'warm')
})

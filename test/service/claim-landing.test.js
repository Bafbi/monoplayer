// #258: the landing's rules, at the fake-integration seam. The offline loopback
// rung (O58) proves the whole path over real sockets; what is cheap to pin here is
// the part a socket would hide: which dials a claim is allowed to make, and what a
// claim gets when it is not. One body at a time is the boundary this file holds
// still for #260, which is where a second body's cache arrives.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

// The body a claim names, and the address its row carried.
const CLAIMED_BODY = { body: 'paper_25565', target: { host: '127.0.0.1', port: 25565 } }

// A body the core can release a client on: its configuration is cached, its play
// login has landed, and its warm marker has been seen. That is the same pair of
// conditions an ordinary warm attach reads.
function warmABody (backendLeg, { config = ['registry_data'], play = ['login'], marker = true } = {}) {
  for (const name of config) {
    backendLeg.deliver({ state: 'configuration', name, buffer: Buffer.from('config:' + name) })
  }
  for (const name of play) {
    backendLeg.deliver({ state: 'play', name, buffer: Buffer.from('play:' + name), data: { entityId: 42 } })
  }
  if (marker) {
    backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', buffer: Buffer.from('marker'), data: {} })
  }
}

test('#258 a lane without the picker never lands a claim', async () => {
  const { core } = makeCore()
  const outcome = await core.connectClaimedBody(CLAIMED_BODY)
  assert.equal(outcome.connected, false)
  assert.equal(outcome.reason, 'picker_off')
})

test('#258 a claim with no address dials nothing', async () => {
  const { core, backendLeg } = makeCore({ config: { picker: true } })
  const outcome = await core.connectClaimedBody({ body: 'sky' })
  assert.equal(outcome.connected, false)
  assert.equal(outcome.reason, 'no_target')
  assert.equal(backendLeg.connected, false, 'a body with no address is never dialled')
})

test('#258 the claim dials the body it names, and another body after it is refused', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const dial = core.connectClaimedBody(CLAIMED_BODY)
  // The dial is in flight: the leg has the target and the session is booting.
  await Promise.resolve()
  assert.deepEqual(backendLeg.target, CLAIMED_BODY.target)
  assert.equal(backendLeg.dialledTargets().length, 1)
  // The claim is a fresh login: no transfer handshake and no cookies.
  assert.equal(backendLeg.dialledTargets()[0].transfer, false)
  assert.equal(backendLeg.dialledTargets()[0].keepCookies, false)

  warmABody(backendLeg)
  // The wait polls: one tick is what re-reads the cache it is waiting on.
  clock.tick(50)
  const outcome = await dial
  assert.equal(outcome.connected, true)
  assert.equal(outcome.body, CLAIMED_BODY.body)
  assert.equal(core.claimedBody, CLAIMED_BODY.body)
  assert.equal(core.metrics.claimDials, 1)
  assert.equal(core.metrics.claimBodies, 1)

  // One body at a time. A second body's frames arriving while this one is
  // delivered is the per-body cache of #260, so the second claim is refused with
  // the body this session already serves.
  const second = await core.connectClaimedBody({ body: 'sky', target: { host: '127.0.0.1', port: 25566 } })
  assert.equal(second.connected, false)
  assert.equal(second.reason, 'one_body')
  assert.equal(second.body, CLAIMED_BODY.body)
  assert.equal(backendLeg.dialledTargets().length, 1, 'the refused claim dialled nothing')
})

test('#258 a body that ended before it warmed does not hold the next claim', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  // The first body's connection ends while the claim is still waiting for it.
  const died = core.connectClaimedBody({ body: 'dead', target: { host: '127.0.0.1', port: 1 } })
  await Promise.resolve()
  backendLeg.deliverEnd({ reason: 'refused' })
  clock.tick(30_000)
  const dead = await died
  assert.equal(dead.connected, false)
  assert.equal(dead.reason, 'body_not_warm')
  // A second client may claim a different body: nothing is connected, so there is
  // nothing for it to contend with.
  const live = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  warmABody(backendLeg)
  clock.tick(50)
  const landed = await live
  assert.equal(landed.connected, true)
  assert.equal(core.claimedBody, CLAIMED_BODY.body)
})

test('#258 the same body may be redialled after its session faulted, and another body may not', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const first = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  warmABody(backendLeg)
  clock.tick(50)
  assert.equal((await first).connected, true)

  // The body's session faults with nobody attached: the cache goes, the session
  // arms its reconnect, and the claim on that body is still the one this session
  // serves. Coming back to it is a redial of the same body, not a second cache.
  backendLeg.deliverEnd({ reason: 'body_fault' })
  assert.equal(core.session.state, 'reconnecting')
  clock.tick(1000)
  assert.equal(core.session.state, 'boot')
  assert.equal(core.claimedBody, CLAIMED_BODY.body)

  const again = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  warmABody(backendLeg)
  clock.tick(50)
  assert.equal((await again).connected, true)
  assert.equal(core.metrics.claimDials, 2)

  // A different body is still refused: one body per session is #260's edge.
  const other = await core.connectClaimedBody({ body: 'sky', target: { host: '127.0.0.1', port: 25566 } })
  assert.equal(other.connected, false)
  assert.equal(other.reason, 'one_body')
})

test('#258 a second claim on a body still dialling waits for that dial, not a new one', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  // A client that clicks Claim twice: the second click lands the same body, and
  // must not change the target of a socket that is still coming up.
  const first = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  const second = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  assert.equal(backendLeg.dialledTargets().length, 1, 'one dial, not two')
  warmABody(backendLeg)
  clock.tick(50)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.connected, true)
  assert.equal(b.connected, true)
  assert.equal(core.metrics.claimDials, 1)
  assert.equal(core.claimedBody, CLAIMED_BODY.body)
})

test('#258 a body that never warms is refused in bounded time, not held forever', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const dial = core.connectClaimedBody(CLAIMED_BODY)
  // The body connects and then says nothing: no configuration, no login, no warm
  // marker. The wait is the only thing between the client and a hang.
  await Promise.resolve()
  assert.equal(backendLeg.connected, true)
  let settled = null
  dial.then(outcome => { settled = outcome })
  await Promise.resolve()
  assert.equal(settled, null, 'the landing waits while the body is still coming up')
  // Past the bound, the wait gives up. One tick, because the core sleeps on the
  // clock it was given rather than on a real timer.
  clock.tick(30_000)
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await dial
  assert.equal(settled.connected, false)
  assert.equal(settled.reason, 'body_not_warm')
  assert.equal(core.claimedBody, null)
  assert.equal(core.metrics.claimDialsFailed, 1)
})

test('#258 a claim that timed out waiting for its body waits again instead of dialling a second', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const first = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  // The body logs in and caches its configuration, and never sends the warm
  // marker: a connected body no client can be released on yet.
  warmABody(backendLeg, { marker: false })
  clock.tick(30_000)
  const timedOut = await first
  assert.equal(timedOut.connected, false)
  assert.equal(timedOut.reason, 'body_not_warm')
  assert.equal(backendLeg.dialledTargets().length, 1)

  // The picker offers the list again, so the client may click Claim again. The
  // second claim must wait on the body this session already dialled, not refuse a
  // client the picker just invited.
  const second = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  assert.equal(backendLeg.dialledTargets().length, 1, 'the second claim dialled nothing')
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', buffer: Buffer.from('marker'), data: {} })
  clock.tick(50)
  const warmed = await second
  assert.equal(warmed.connected, true)
  assert.equal(core.claimedBody, CLAIMED_BODY.body)
  assert.equal(core.metrics.claimDials, 1)
  assert.equal(core.metrics.claimBodies, 1)
})

test('#258 a body with no cached configuration is not ready for a client, however warm it is', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const dial = core.connectClaimedBody(CLAIMED_BODY)
  await Promise.resolve()
  // Warm and logged in, but nothing to configure the client with: a client
  // released on this cache would land in a world it has no registries for.
  warmABody(backendLeg, { config: [] })
  let settled = null
  dial.then(outcome => { settled = outcome })
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  assert.equal(settled, null)
  clock.tick(30_000)
  await dial
  assert.equal(settled.connected, false)
  assert.equal(settled.reason, 'body_not_warm')
  assert.equal(settled.warm.configFrames, 0)
})

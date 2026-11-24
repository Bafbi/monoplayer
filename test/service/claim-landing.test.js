// #258: the landing's rules, at the fake-integration seam. The offline loopback
// rung (O58) proves the whole path over real sockets; what is cheap to pin here is
// the part a socket would hide: which dials a claim is allowed to make, and what a
// claim gets when it is not. One body at a time is the boundary this file holds
// still for #260, which is where a second body's cache arrives.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PARTY = { body: 'paper_25565', target: { host: '127.0.0.1', port: 25565 } }

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
  const outcome = await core.connectClaimedBody(PARTY)
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
  const dial = core.connectClaimedBody(PARTY)
  // The dial is in flight: the leg has the target and the session is booting.
  await Promise.resolve()
  assert.deepEqual(backendLeg.target, PARTY.target)
  assert.equal(backendLeg.dialledTargets().length, 1)
  // The claim is a fresh login: no transfer handshake and no cookies.
  assert.equal(backendLeg.dialledTargets()[0].transfer, false)
  assert.equal(backendLeg.dialledTargets()[0].keepCookies, false)

  warmABody(backendLeg)
  // The wait polls: one tick is what re-reads the cache it is waiting on.
  clock.tick(50)
  const outcome = await dial
  assert.equal(outcome.connected, true)
  assert.equal(outcome.body, PARTY.body)
  assert.equal(core.claimedBody, PARTY.body)
  assert.equal(core.metrics.claimDials, 1)
  assert.equal(core.metrics.claimBodies, 1)

  // One body at a time. A second body's frames arriving while this one is
  // delivered is the per-body cache of #260, so the second claim is refused with
  // the body this session already serves.
  const second = await core.connectClaimedBody({ body: 'sky', target: { host: '127.0.0.1', port: 25566 } })
  assert.equal(second.connected, false)
  assert.equal(second.reason, 'one_body')
  assert.equal(second.body, PARTY.body)
  assert.equal(backendLeg.dialledTargets().length, 1, 'the refused claim dialled nothing')
})

test('#258 a body that never warms is refused in bounded time, not held forever', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const dial = core.connectClaimedBody(PARTY)
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

test('#258 a body with no cached configuration is not ready for a client, however warm it is', async () => {
  const { core, backendLeg, clock } = makeCore({ config: { picker: true } })
  const dial = core.connectClaimedBody(PARTY)
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

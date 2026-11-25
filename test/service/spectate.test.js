// #259: who may watch a body, and what a spectator's own client is told.
//
// Seam: the fake-integration rig (test/support/harness.js), because what a socket
// hides is exactly the two decisions here: whether a client may watch a given body,
// and which frames its client gets for it. O62 proves the same path over a real
// socket, with a real protocol bot and a fake backend that counts what it receives.
//
// The rule this file pins (#259): any client the lane's identity gate admitted may
// watch any body the lane serves and has up, whether or not a driver holds it, and
// no dial is made for a spectator.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickSlug } from '../../src/core/picker.js'
import { makeCore } from '../support/harness.js'

// The body a claim dials: a server that is not the lane's configured backend, so
// "the body this lane serves" and "the body it was configured with" stay apart.
const TARGET = { host: '127.0.0.1', port: 25566 }
const CLAIMED = { body: pickSlug(TARGET.host + ':' + TARGET.port), target: TARGET }

// A body a spectator could be offered and is not: one server, one body id.
const OTHER = 'sky'

// The body's join, cached: configuration first, then its play login and the warm
// marker. Same shape the claim landing waits on.
function warmABody (backendLeg) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', buffer: Buffer.from('config:registry_data') })
  backendLeg.deliver({ state: 'play', name: 'login', buffer: Buffer.from('play:login'), data: { entityId: 42 } })
  backendLeg.deliver({ state: 'play', name: 'position', buffer: Buffer.from('play:position'), data: { x: 1, y: 2, z: 3 } })
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', buffer: Buffer.from('marker'), data: {} })
}

// Dial and land the claimed body, so a spectator has something to watch.
async function landABody (rig) {
  const dial = rig.core.connectClaimedBody(CLAIMED)
  await Promise.resolve()
  warmABody(rig.backendLeg)
  rig.clock.tick(50)
  const landed = await dial
  assert.equal(landed.connected, true, 'the fixture body lands')
  return landed
}

test('#259 a lane without the picker has no spectator at all', () => {
  const { core } = makeCore()
  assert.deepEqual(core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body }), {
    watching: false,
    reason: 'picker_off',
    body: CLAIMED.body
  })
})

test('#259 a lane that serves no body refuses a spectator, and dials nothing for one', async () => {
  const { core, backendLeg } = makeCore({ config: { picker: true } })
  const answer = core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body })
  assert.equal(answer.watching, false)
  assert.equal(answer.reason, 'no_body')
  // Watching is not a claim: nothing is dialled, so the lane still has no body.
  assert.equal(backendLeg.dialledTargets().length, 0)
  assert.equal(core.claimedBody, null)
})

test('#259 a row naming another body is refused, and the answer names the body it serves', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  const answer = rig.core.spectateBody({ body: OTHER, server: OTHER })
  assert.equal(answer.watching, false)
  assert.equal(answer.reason, 'body_not_served')
  assert.equal(answer.body, CLAIMED.body, 'the answer names what this lane serves instead')
  // One body at a time is the session's limit, and watching does not change it.
  assert.equal(rig.backendLeg.dialledTargets().length, 1)
})

test('#259 any admitted client may watch a body a driver holds', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  assert.equal(rig.core.attached, true)
  const answer = rig.core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body, name: 'Watcher' })
  assert.equal(answer.watching, true)
  assert.equal(answer.body, CLAIMED.body)
  // Watching never becomes a claim: the driver keeps the body and the session is
  // untouched.
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.session.attachCount, 1)
})

test('#259 a body nobody drives is still watchable, and watching attaches nobody', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  // The driver leaves. The claim goes with its connection; the body does not.
  rig.frontLeg.clientDisconnect({ reason: 'player_quit' })
  assert.equal(rig.core.attached, false)
  assert.equal(rig.core.session.state, 'detached')
  assert.equal(rig.core.claimedBody, CLAIMED.body, 'the body outlives the claim it was dialled for')
  const answer = rig.core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body, name: 'Watcher' })
  assert.equal(answer.watching, true)
  assert.equal(answer.reason, null)
  // Nobody was attached to serve the spectator, and nobody is now.
  assert.equal(rig.core.attached, false)
  assert.equal(rig.core.session.attachCount, 1)
})

test('#259 a body that is not up is refused in words, and the word says which', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  // #261: a body nobody claims stays down, so this fault would end the body rather
  // than arm a retry. The claim is held here because the two answers a spectator can
  // get — waiting for a body that is coming back, and a body that is down — need a
  // body that is coming back first. The claim is dropped by #261's own rule and not
  // by this one: a claim is what keeps a body alive.
  rig.frontLeg.claim(CLAIMED.body, { name: 'Pilot' })
  // The body's session ends with nobody attached: the session arms its one
  // reconnect, and a spectator is asked to wait rather than served a frozen world.
  rig.backendLeg.deliverEnd({ reason: 'body_fault' })
  assert.equal(rig.core.session.state, 'reconnecting')
  const waiting = rig.core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body })
  assert.equal(waiting.watching, false)
  assert.equal(waiting.reason, 'body_not_warm')
  // The reconnect spends the budget and the body is down. That is a different
  // answer, because it asks the player for something else.
  rig.clock.tick(1000)
  assert.equal(rig.core.session.state, 'boot')
  rig.backendLeg.deliverEnd({ reason: 'body_fault_again' })
  assert.equal(rig.core.session.state, 'failed')
  const down = rig.core.spectateBody({ body: CLAIMED.body, server: CLAIMED.body })
  assert.equal(down.watching, false)
  assert.equal(down.reason, 'body_down')
})

test('#259 a spectator that never landed takes no watcher away from one that did', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  rig.frontLeg.clientDisconnect({ reason: 'player_quit' })
  rig.core.spectateView({ name: 'Watcher', channel: 'spectator-one' })
  // A client that left between its landing and the body's play state closes as a
  // spectator's channel too, and it was never handed the body. The relay is still
  // somebody's: a count would take the one that stayed away for it.
  assert.equal(rig.core.spectatorLeft({ channel: 'spectator-two' }).watching, 1,
    'the spectator that stayed is still watching')
  assert.equal(rig.core.spectatorLeft({ channel: 'spectator-one' }).watching, 0,
    'and the last one leaving ends it')
})

test('#259 a spectator is told it is spectating, on its own channel and after the replay', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  // The body's own abilities and game mode are cached: a spectator replays them
  // like any other state, so the frames that tell it it is spectating have to
  // arrive after them or the client fights the world it was put in.
  rig.backendLeg.deliver({
    state: 'play',
    name: 'abilities',
    buffer: Buffer.from('play:abilities'),
    data: { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }
  })
  rig.backendLeg.deliver({
    state: 'play',
    name: 'game_state_change',
    buffer: Buffer.from('play:game_state_change'),
    data: { reason: 3, gameMode: 0 }
  })
  const mark = rig.frontLeg.frames().length
  const backendWrites = rig.backendLeg.rawWrites().length + rig.backendLeg.packetWrites().length
  const view = rig.core.spectateView({ name: 'Watcher', channel: 'spectator-channel' })
  assert.equal(view.watching, true)
  assert.equal(view.reason, null)
  const frames = rig.frontLeg.frames().slice(mark)
  const onOwnChannel = frames.filter(frame => frame.channel === 'spectator-channel')
  assert.equal(onOwnChannel.length, frames.length, 'every frame goes to that spectator and no other socket')
  // What the client is told, and in which order.
  const told = frames.filter(frame => frame.name === 'game_state_change' || frame.name === 'abilities').slice(-2)
  assert.deepEqual(told.map(frame => frame.name), ['game_state_change', 'abilities'])
  assert.deepEqual(told[0].packet, { reason: 3, gameMode: 3 }, 'game mode 3 is spectator')
  assert.equal(told[1].packet.flags, 7, 'invulnerable, flying, and flying allowed')
  assert.equal(told[1].packet.flyingSpeed, 0.05)
  assert.equal(told[1].packet.walkingSpeed, 0.1)
  // The replay came first: the spectator is in the body's world before it is told
  // what it is there as.
  const replayNames = frames.slice(0, -2).map(frame => frame.name)
  assert.ok(replayNames.includes('login'), "the body's play login is replayed")
  assert.ok(replayNames.includes('position'), 'and its pose')
  // Watching writes nothing to the backend and moves nobody.
  assert.equal(rig.backendLeg.rawWrites().length + rig.backendLeg.packetWrites().length, backendWrites)
  assert.equal(rig.core.metrics.spectatorViews, 1)
})

test('#259 a spectator of a body nobody drives is handed that body as it stands', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  rig.frontLeg.clientDisconnect({ reason: 'player_quit' })
  const mark = rig.frontLeg.frames().length
  const view = rig.core.spectateView({ name: 'Watcher', channel: 'spectator-channel' })
  assert.equal(view.watching, true)
  assert.equal(rig.core.attached, false, 'a spectator never becomes the driver')
  const names = rig.frontLeg.frames().slice(mark).map(frame => frame.name)
  assert.ok(names.includes('login'))
  assert.equal(names.at(-1), 'abilities', 'and it is still told it is spectating')
})

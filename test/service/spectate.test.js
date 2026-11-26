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
// #516: the two clients a body has, and the puppet whose skin both of their own
// bodies should wear. The driver's UUID is the one the attach names; the
// spectator's is its own.
const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const WATCHER = '11111111-2222-3333-4444-555555555555'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const TEXTURES = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }
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

// The skin switch is on by default; the skin itself is the backend's, and the
// config has to name the puppet's UUID for the proxy to attribute it (#134).
const skinConfig = () => ({
  picker: true,
  skin: { showPuppetSkin: true },
  puppet: { username: 'Wiriaw', uuid: PUPPET }
})

// The backend's own frame for the puppet, as Paper sends it: the only skin the
// proxy will ever send, and the moment it has one.
function deliverPlayerInfo ({ backendLeg }, properties = [TEXTURES]) {
  backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: Buffer.from('play:player_info:' + properties[0]?.value),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: [{ uuid: PUPPET, player: { name: 'Wiriaw', properties } }]
    }
  })
}

// The proxy's own skin frames. The relayed player_info is a raw frame and belongs
// to the backend, so only the synthesized kind is the proxy's.
const skinFrames = frontLeg =>
  frontLeg.frames().filter(frame => frame.name === 'player_info' && frame.kind === 'synth')

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

// #516: #99 gave the driver's own player the puppet's skin, and a spectator's own
// player draws the same body: the front authenticated it as itself and handed it the
// puppet's world, so with no entry for its own UUID it renders a vanilla default.
// The entry names one player, so a body's second client needs its own, on its own
// channel. The driver's frame is the one #99 wrote and stays that frame.
test('#516 a spectator is handed the skin entry that names it, on its own channel', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })

  const driverFrames = skinFrames(rig.frontLeg)
  assert.equal(driverFrames.length, 1, 'the driver is owed its frame, as #99 proved it')
  assert.equal(driverFrames[0].channel, null, 'the driver\'s entry is unchanged: the frame #99 wrote')
  assert.equal(driverFrames[0].packet.data[0].uuid, PLAYER, 'and it names the driver')

  const before = skinFrames(rig.frontLeg).length
  const view = rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  assert.equal(view.watching, true)

  const spectatorFrames = skinFrames(rig.frontLeg).slice(before)
  assert.equal(spectatorFrames.length, 1, 'one entry for the spectator, and the driver is handed no second one')
  assert.equal(spectatorFrames[0].channel, 'spectator-channel', 'a per-channel packet, which is what a channel is for')
  assert.equal(spectatorFrames[0].packet.data[0].uuid, WATCHER, 'the entry names the spectator, not the driver')
  assert.equal(spectatorFrames[0].packet.data[0].player.name, 'Watcher')
  assert.deepEqual(spectatorFrames[0].packet.data[0].player.properties, [TEXTURES],
    'the property is the backend\'s own, signature and all')
  assert.equal(spectatorFrames[0].packet.action.update_listed, undefined,
    'the tab list gains no line for a spectator either')
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
  // The spectator's mode frames are still the last word on that socket (#259).
  assert.equal(rig.frontLeg.frames().at(-1).name, 'abilities')
})

// The ordinary order on Paper: the backend lists the puppet a moment after the
// join, so a spectator is usually already in play when the skin arrives. Only the
// property's own pass can reach it, and it has to reach every channel that is owed
// one rather than the driver alone (#134 fixed the same hole for the driver).
test('#516 a spectator that landed before the property is told when it arrives', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  assert.equal(skinFrames(rig.frontLeg).length, 0, 'a proxy that holds no property writes nothing to either client')

  deliverPlayerInfo(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 2, 'the driver and the spectator are each owed their own entry')
  const named = new Map(frames.map(frame => [frame.channel, frame.packet.data[0].uuid]))
  assert.equal(named.get(null), PLAYER, 'the driver names the driver')
  assert.equal(named.get('spectator-channel'), WATCHER, 'and the spectator is reached when the property arrives')
})

// A client's entry map wins over a later add_player for the same UUID, so a second
// frame for one play state is a write nobody sees. The fact is per channel: a
// spectator that watched the property arrive holds its entry, and a spectator that
// left and came back holds none.
test('#516 a spectator is sent one entry per play state, not one per property frame', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  const after = skinFrames(rig.frontLeg).length
  assert.equal(after, 2)

  deliverPlayerInfo(rig)
  deliverPlayerInfo(rig)
  assert.equal(skinFrames(rig.frontLeg).length, after, 'the same property is not a second entry')

  // The channel ended, so the play state it held went with it: a spectator that
  // lands again on a new connection is owed the entry again.
  rig.core.spectatorLeft({ channel: 'spectator-channel' })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-again' })
  const reLanded = skinFrames(rig.frontLeg).slice(after)
  assert.equal(reLanded.length, 1)
  assert.equal(reLanded[0].channel, 'spectator-again')
  assert.equal(reLanded[0].packet.data[0].uuid, WATCHER)
})

// A frame the leg finds no socket for is not a frame. The entry is not marked sent,
// so a channel that comes back is still owed one, and the line says the write failed
// rather than counting a frame nobody received (#134, #516). The leg answers `false`
// when a channel resolves to no client (src/legs/live-front.js): a socket that closed
// between the landing and the write.
test('#516 a write that reaches nobody is refused, and a later pass repairs it', async () => {
  const logLines = []
  const rig = makeCore({ config: skinConfig(), logLines })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  const write = rig.frontLeg.write.bind(rig.frontLeg)
  rig.frontLeg.write = (name, packet, options = {}) =>
    name === 'player_info' && options.channel === 'spectator-channel'
      ? false
      : write(name, packet, options)

  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })

  const refused = logLines.filter(line => line.event === 'puppetSkinRefused')
  assert.equal(refused.length, 1, 'one line, because one channel received nothing')
  assert.equal(refused[0].reason, 'write_failed')
  assert.equal(refused[0].channel, 'spectator-channel')
  assert.equal('error' in refused[0], false, 'nothing threw, so there is no error to report')
  assert.equal(skinFrames(rig.frontLeg).filter(frame => frame.channel === 'spectator-channel').length, 0)
  assert.equal(rig.core.metrics.skinFramesWritten, 1, 'only the driver\'s entry was written')

  // The socket is back, and a property the proxy has not held is what runs the pass
  // that owes the channel its entry again.
  rig.frontLeg.write = write
  deliverPlayerInfo(rig, [{ name: 'textures', value: 'cmVzaWduZWQ=', signature: 'c2lnbmF0dXJl' }])

  const repaired = skinFrames(rig.frontLeg).filter(frame => frame.channel === 'spectator-channel')
  assert.equal(repaired.length, 1, 'the channel is owed the entry it never received')
  assert.equal(repaired[0].packet.data[0].uuid, WATCHER)
  assert.equal(repaired[0].packet.data[0].player.name, 'Watcher')
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
})

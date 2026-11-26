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
// #618: the spectator's own account skin, distinct from the puppet's in every field, so
// a frame that carries the wrong one is a frame this file can tell apart.
const WATCHER_TEXTURES = { value: 'd2F0Y2hlciBza2lu', signature: 'd2F0Y2hlciBzaWc=' }
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
  // #597: an idle lane still has a row, because the body it is configured with is the
  // body it will dial. Nothing claims it, nothing watches it, and its join is not warm.
  const [idle] = core.laneState().bodies
  assert.equal(idle.body, pickSlug(core.config.backend.host + ':' + core.config.backend.port))
  assert.equal(idle.state, 'boot')
  assert.equal(idle.claim, null)
  assert.equal(idle.spectators, 0)
  assert.equal(idle.warm, false)
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
  // #597: one snapshot, where this file read the stage off the session and the body
  // off the claim. The claim went with its connection; the body it dialled did not.
  const [row] = rig.core.laneState().bodies
  assert.equal(row.state, 'detached')
  assert.equal(row.claim, null, 'the claim went with the connection that held it')
  assert.equal(row.body, CLAIMED.body, 'the body outlives the claim it was dialled for')
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
  // #597: who watches the body is the snapshot's own field, so the count below is
  // read from the lane rather than from what a call happened to answer.
  assert.equal(rig.core.laneState().bodies[0].spectators, 1, 'one channel watches the body')
  // A client that left between its landing and the body's play state closes as a
  // spectator's channel too, and it was never handed the body. The relay is still
  // somebody's: a count would take the one that stayed away for it.
  assert.equal(rig.core.spectatorLeft({ channel: 'spectator-two' }).watching, 1,
    'the spectator that stayed is still watching')
  assert.equal(rig.core.laneState().bodies[0].spectators, 1, 'and the lane still counts one')
  assert.equal(rig.core.spectatorLeft({ channel: 'spectator-one' }).watching, 0,
    'and the last one leaving ends it')
  assert.equal(rig.core.laneState().bodies[0].spectators, 0, 'the body has no watcher left')
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

// #614: one rule for who sees the puppet. The entry that names the puppet goes to
// every channel of the body, and no channel is handed the puppet's skin on its own
// player.
//
// #516 wrote one entry per channel, naming that channel's own player, carrying the
// puppet's textures. A client draws a player's body from the entry that names that
// player, so a spectator's own player wore the puppet's skin and no entry named the
// puppet at all. Both halves of the owner's report follow from that one choice, and the
// fix is the rule: the body's entry names the puppet, and every channel of the body
// receives it.
//
// The driver keeps a second entry, and it is #99's frame: the measured client resolved
// the puppet's skin for the body it controls from the entry naming that player
// (testdata/skin-verdict.md).
//
// #618: a spectator is named too, by an entry that carries its own account's skin
// (test below). This test is the other half of that rule: an account whose answer
// carried no textures hands the landing nothing, so no entry names that spectator and
// its client resolves the default it always did.
test('#614 a spectator whose account sent no textures is handed the entry that names the puppet, and none that names itself', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })

  const driverPass = skinFrames(rig.frontLeg)
  assert.deepEqual(driverPass.map(frame => frame.packet.data[0].uuid), [PUPPET, PLAYER],
    "the body's entry, then #99's frame naming the driver's own player")
  for (const frame of driverPass) {
    assert.equal(frame.channel, null, 'neither entry is addressed to one channel')
    assert.equal(frame.packet.action.update_listed, undefined, 'the tab list gains no line beside the puppet')
  }
  assert.deepEqual(driverPass[0].packet.data[0].player.properties, [TEXTURES],
    "the property is the backend's own, signature and all")
  assert.equal(driverPass[0].packet.data[0].player.name, 'Wiriaw', "and the name is the backend's own too")

  const before = skinFrames(rig.frontLeg).length
  const view = rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  assert.equal(view.watching, true)

  const spectatorPass = skinFrames(rig.frontLeg).slice(before)
  assert.equal(spectatorPass.length, 1, 'one entry for the channel that just landed')
  assert.equal(spectatorPass[0].channel, null, 'written to every channel of the body, which is what the rule says')
  assert.equal(spectatorPass[0].packet.data[0].uuid, PUPPET, 'and it names the puppet')
  assert.equal(spectatorPass[0].packet.data[0].player.name, 'Wiriaw')
  assert.deepEqual(spectatorPass[0].packet.data[0].player.properties, [TEXTURES])
  assert.equal(skinFrames(rig.frontLeg).some(frame => frame.packet.data[0].uuid === WATCHER), false,
    'no frame names the spectator, because this landing was handed no skin for it (#618)')
  assert.equal(rig.core.metrics.skinFramesWritten, 3)
  // The spectator's mode frames are still the last word on that socket (#259).
  assert.equal(rig.frontLeg.frames().at(-1).name, 'abilities')
})

// #618: the correction of #614's rule. "No entry names a spectator's own player" leaves a
// client to resolve `DefaultPlayerSkin.get(uuid)` for the body it controls, which is a
// vanilla default and not the account's skin (testdata/skin-verdict.md, control case).
//
// The rule now: an entry names the spectator, carrying the property the account's own
// hasJoined answer carried, and it is written on that spectator's channel alone. Two
// entries, two skins — the body's carries the puppet's, the spectator's carries its own —
// and neither may cross. What the puppet is owed here is unchanged: every channel of the
// body still receives the entry naming it.
test('#618 a spectator is named by an entry carrying its own account skin, and never the puppet\'s', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  const before = {
    frames: skinFrames(rig.frontLeg).length,
    written: rig.core.metrics.skinFramesWritten
  }

  // The front verifies this client and hands the landing the property off the profile
  // the sessionserver answered: the spectator's own, which no frame of this body has.
  const view = rig.core.spectateView({
    name: 'Watcher',
    uuid: WATCHER,
    channel: 'spectator-channel',
    skin: WATCHER_TEXTURES
  })
  assert.equal(view.watching, true)

  const landed = skinFrames(rig.frontLeg).slice(before.frames)
  assert.deepEqual(landed.map(frame => frame.packet.data[0].uuid), [PUPPET, WATCHER],
    "two entries: the body's, naming the puppet, then the one naming the spectator itself")
  const [bodyEntry, ownEntry] = landed
  assert.equal(bodyEntry.channel, null, "the body's entry is still every channel's")
  assert.deepEqual(bodyEntry.packet.data[0].player.properties, [TEXTURES],
    "and it still carries the puppet's skin, signature and all")
  assert.equal(ownEntry.channel, 'spectator-channel', "the spectator's entry is its own channel's alone")
  assert.equal(ownEntry.packet.data[0].player.name, 'Watcher')
  assert.deepEqual(ownEntry.packet.data[0].player.properties,
    [{ name: 'textures', value: WATCHER_TEXTURES.value, signature: WATCHER_TEXTURES.signature }],
    "the property is the account's own, carried as it arrived")
  assert.notDeepEqual(ownEntry.packet.data[0].player.properties, bodyEntry.packet.data[0].player.properties,
    "two entries, two skins: the puppet's never reaches the body the spectator controls (#516)")
  assert.equal(ownEntry.packet.action.update_listed, undefined, 'the tab list gains no line for it')
  assert.equal(view.ownSkin, true, 'the landing says the entry was written')
  assert.equal(rig.core.metrics.skinFramesWritten, before.written + 2,
    "both entries count as skin frames written")
})

// #618's guard, from the other side: a landing handed no skin writes no entry of its own,
// and the account's client keeps the vanilla default. #516's bug was the puppet's skin on
// the spectator's own body, and the only frame that could put it there is this one.
test('#618 a landing handed no skin writes no entry of its own, and never the puppet\'s', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  const before = skinFrames(rig.frontLeg).length

  const view = rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  const landed = skinFrames(rig.frontLeg).slice(before)

  assert.equal(view.ownSkin, false, 'the landing says nothing was written for its own player')
  assert.deepEqual(landed.map(frame => frame.packet.data[0].uuid), [PUPPET],
    "only the body's entry: no frame names the spectator, so its own player keeps the default")
  assert.equal(landed.some(frame => frame.packet.data[0].uuid === WATCHER), false)
})

// #218's shape, on a spectator's socket. The relayed `player_info` is ordinary state in
// the cache's generic ring, and a live session evicts that ring in about ninety seconds,
// so a spectator that lands afterwards replays no entry naming the puppet. That is the
// reported "cannot see the puppet in the world": the proxy's own entry is what puts it
// back, because it is written on the landing rather than replayed from the cache.
test('#614 a spectator that lands after the cache forgot the puppet is still told who it is', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  for (let i = 0; i < 600; i++) {
    rig.backendLeg.deliver({ state: 'play', name: 'sound_effect', data: { soundId: 'minecraft:block.note_block.harp', x: i } })
  }

  const mark = rig.frontLeg.frames().length
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  const landed = rig.frontLeg.frames().slice(mark)
  assert.equal(landed.some(frame => frame.name === 'player_info' && frame.kind === 'raw'), false,
    'the replay carries no relayed entry: the generic ring evicted it an hour of frames ago')
  const entries = landed.filter(frame => frame.name === 'player_info')
  assert.equal(entries.length, 1, 'and the proxy writes the entry the replay lost')
  assert.equal(entries[0].packet.data[0].uuid, PUPPET)
})

// A client's entry map wins over a later `add_player` for the same UUID, so a second
// frame for one play state is a write nobody sees. The body's entry is a fact about the
// connection a client holds, so a landing is what a channel is owed it on, and a skin
// change is what every channel is owed again.
//
// #618: and nothing rewrites a spectator's own entry, because a change of the puppet's
// property is not a change of the spectator's account. This landing was handed no skin,
// which is the case that has no entry to rewrite.
test('#614 no entry names a spectator whose account sent no textures, however often the puppet\'s skin changes', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  const after = skinFrames(rig.frontLeg).length
  assert.equal(after, 3)

  deliverPlayerInfo(rig)
  deliverPlayerInfo(rig)
  assert.equal(skinFrames(rig.frontLeg).length, after, 'the same property is not a second entry')

  // A change the client has not been told about reaches every channel: the body's entry
  // is rewritten, and #99's frame is not, because the driver's client keeps the entry it
  // holds (#134).
  deliverPlayerInfo(rig, [{ name: 'textures', value: 'cmVzaWduZWQ=', signature: 'c2lnbmF0dXJl' }])
  const changed = skinFrames(rig.frontLeg).slice(after)
  assert.deepEqual(changed.map(frame => frame.packet.data[0].uuid), [PUPPET],
    "the body's entry carries the new property, and no driver entry follows it")

  // The channel ended, so the play state it held went with it: a spectator that lands
  // again on a new connection is owed the body's entry again.
  rig.core.spectatorLeft({ channel: 'spectator-channel' })
  const before = skinFrames(rig.frontLeg).length
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-again' })
  const reLanded = skinFrames(rig.frontLeg).slice(before)
  assert.equal(reLanded.length, 1)
  assert.equal(reLanded[0].packet.data[0].uuid, PUPPET)
  assert.equal(skinFrames(rig.frontLeg).some(frame => frame.packet.data[0].uuid === WATCHER), false)
})

// #134's repair story, in the rule's own shape: a write that reaches no channel of the
// body is not a frame anyone received, so it is not marked sent, and the next pass writes
// it. The pass is a landing or a new property value, which is what the proxy has when a
// socket comes back.
test('#614 an entry that reached nobody is refused, and the next pass writes it', async () => {
  const logLines = []
  const rig = makeCore({ config: skinConfig(), logLines })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  const written = rig.core.metrics.skinFramesWritten
  const write = rig.frontLeg.write.bind(rig.frontLeg)
  rig.frontLeg.write = (name, packet, options = {}) =>
    name === 'player_info' ? false : write(name, packet, options)

  const before = skinFrames(rig.frontLeg).length
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })

  const refused = logLines.filter(line => line.event === 'puppetSkinRefused')
  assert.equal(refused.length, 1, 'one line, because the body received nothing')
  assert.equal(refused[0].reason, 'write_failed')
  assert.equal(refused[0].puppet, true, "the entry refused is the body's")
  assert.equal('error' in refused[0], false, 'nothing threw, so there is no error to report')
  assert.equal(skinFrames(rig.frontLeg).length, before, 'and no frame was written')
  assert.equal(rig.core.metrics.skinFramesWritten, written, 'a frame nobody received is not counted as sent')

  // The socket is back, and a property the proxy has not held is the pass that writes the
  // entry the body was still owed.
  rig.frontLeg.write = write
  deliverPlayerInfo(rig, [{ name: 'textures', value: 'cmVzaWduZWQ=', signature: 'c2lnbmF0dXJl' }])

  const repaired = skinFrames(rig.frontLeg).slice(before)
  assert.equal(repaired.length, 1, 'the body is owed the entry it never received')
  assert.equal(repaired[0].packet.data[0].uuid, PUPPET)
  assert.equal(rig.core.metrics.skinFramesWritten, written + 1)
})

// #614: the pack. The backend sends it once, during its own configuration phase, and a
// spectator is in play, so `canReceiveControl('configuration')` withholds it. The held
// copy is what a client that lands later is offered, and a play-state
// `add_resource_pack` is a frame both 26.1 and 26.2 define
// (`node tools/protocol.mjs frame 26.1 play toClient add_resource_pack`), so the pack is
// re-encoded into the state the spectator is in rather than written as the frame it
// arrived as, whose packet id is the configuration state's.
const PACK_UUID = '22222222-3333-4444-8555-666666666666'
const packFrame = ({ state = 'configuration', uuid = PACK_UUID } = {}) => ({
  state,
  name: 'add_resource_pack',
  buffer: Buffer.from(state + ':add_resource_pack'),
  data: { uuid, url: 'https://example.invalid/pack.zip', hash: '', forced: false, promptMessage: null }
})

test('#614 a spectator that lands after a pack was held is offered that pack', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.backendLeg.deliver(packFrame())
  assert.equal(rig.core.pendingPacks.held, true, 'held for a client that can answer it')
  assert.equal(rig.core.metrics.resourcePacksRelayed, 0, 'nobody was in a state that could take it')

  const mark = rig.frontLeg.frames().length
  const view = rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
  assert.equal(view.watching, true)
  assert.equal(view.packsOffered, 1, 'the landing says how many packs it offered')
  const offered = rig.frontLeg.frames().slice(mark).filter(frame => frame.name === 'add_resource_pack')
  assert.equal(offered.length, 1, 'the pack the body holds is offered to the client that landed')
  assert.equal(offered[0].kind, 'packet', 'in the state the client is in, not as the configuration frame it arrived as')
  assert.equal(offered[0].channel, 'spectator-channel', 'on the channel that landed')
  assert.equal(offered[0].packet.uuid, PACK_UUID)
  assert.equal(offered[0].packet.url, 'https://example.invalid/pack.zip', 'the same pack content the driver is offered')

  // Offering it is not answering it. The puppet answered for the account when no client
  // could, and a spectator's own decline never reaches the core (src/legs/live-front.js
  // drops a spectator's frames), so nothing a spectator says can deny the body its pack.
  assert.equal(rig.core.metrics.resourcePacksAnswered, 0, "the proxy answered nothing on the spectator's behalf")
  assert.equal(rig.core.pendingPacks.held, true, 'the held copy stays, for the body and for the next client')
})

test('#614 a pack held on a body reaches the spectator watching it, in the state it is in', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })

  // A configuration-state pack: the relay asks for a client in configuration, and a
  // spectator is in play, so the held copy is offered where it can be read.
  const mark = rig.frontLeg.frames().length
  rig.backendLeg.deliver(packFrame())
  const offered = rig.frontLeg.frames().slice(mark).filter(frame => frame.name === 'add_resource_pack')
  assert.equal(offered.length, 1, 'a pack held on a body with a spectator watching is offered to it at once')
  assert.equal(offered[0].channel, 'spectator-channel')
  assert.equal(offered[0].kind, 'packet', 're-encoded into play, because the frame arrived in configuration')

  // A play-state pack with no driver is withheld for the puppet's answer, and the
  // spectator is offered that one too: the relay needed a driver in play, not a reader.
  const withheldMark = rig.frontLeg.frames().length
  const PLAY_PACK = '33333333-4444-4555-8666-777777777777'
  rig.backendLeg.deliver(packFrame({ state: 'play', uuid: PLAY_PACK }))
  const withheld = rig.frontLeg.frames().slice(withheldMark).filter(frame => frame.name === 'add_resource_pack')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].kind, 'raw', 'a play-state pack is the bytes the backend sent')
  assert.equal(withheld[0].channel, 'spectator-channel')

  // With a driver on the body the relay carries a play-state pack to every channel
  // itself, so it is written once and not offered a second time.
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  const relayMark = rig.frontLeg.frames().length
  rig.backendLeg.deliver(packFrame({ state: 'play', uuid: '44444444-5555-4666-8777-888888888888' }))
  const relayed = rig.frontLeg.frames().slice(relayMark).filter(frame => frame.name === 'add_resource_pack')
  assert.equal(relayed.length, 1, 'one write, which is the live relay')
  assert.equal(relayed[0].kind, 'raw')
  assert.equal(relayed[0].channel, null, 'and it goes to the body, the spectator included')
})

// #633: a body that respawns states its own game mode, so a spectator is told what it is
// again. `respawn` is ordinary state and reaches every channel of the body, which is where
// a dimension change would undo #259's pair: no flight, its own body drawn again, and the
// driver's hotbar back. So the same two frames follow it on the spectator's own channel.
test('#633 a body that respawns tells each spectator again, and never the driver', async () => {
  const rig = makeCore({ config: { picker: true } })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: null })
  rig.core.spectateView({ name: 'Watcher', channel: 'spectator-channel' })
  const mark = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', name: 'respawn', buffer: Buffer.from('play:respawn'), data: {} })
  const frames = rig.frontLeg.frames().slice(mark)

  const respawn = frames.find(frame => frame.name === 'respawn')
  assert.ok(respawn, 'the body respawns')
  assert.equal(respawn.channel, null, 'and the frame reaches every channel of the body')

  const told = frames.filter(frame => frame.name === 'game_state_change' || frame.name === 'abilities')
  assert.deepEqual(told.map(frame => frame.name), ['game_state_change', 'abilities'],
    'the mode, then the abilities that mode holds')
  assert.deepEqual(told.map(frame => frame.channel), ['spectator-channel', 'spectator-channel'],
    'on the spectator and no other socket')
  assert.deepEqual(told[0].packet, { reason: 3, gameMode: 3 })
  assert.equal(told[1].packet.flags, 7)
  assert.equal(rig.core.metrics.spectatorViews, 1, 'a respawn is not a landing')
})

// #685: the other half of #618. #618 named a spectator on its own channel, carrying its
// account's skin. The entry that tells one channel about **another** client's body carried
// no property, so a driver drew a spectator in a vanilla default, and one spectator drew
// another in one. The property is held with the spectator, in the one record both writes
// read, and every channel told about that player is told its skin.
const SECOND = '33333333-4444-4555-8666-777777777777'
const SECOND_TEXTURES = { value: 'c2Vjb25kIHNraW4=', signature: 'c2Vjb25kIHNpZ2c=' }

// The entries a channel received for one UUID, as the textures values they carried.
const entriesFor = (frontLeg, channel, uuid) => frontLeg.frames()
  .filter(frame => frame.name === 'player_info' && frame.kind === 'packet' && frame.channel === channel)
  .flatMap(frame => frame.packet.data ?? [])
  .filter(entry => entry.uuid === uuid)
  .map(entry => (entry.player.properties ?? [])
    .filter(property => property.name === 'textures')
    .map(property => property.value))

test('#685 a channel told about a spectator is told that spectator\'s skin, and never the puppet\'s', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  // The driver's own socket, which the fake owns no record of until a test names it.
  rig.frontLeg.channelRecord({ id: 'driver-channel' })

  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'a-channel', skin: WATCHER_TEXTURES })

  // The driver draws the spectator from this entry: the account's own property, on the
  // driver's channel, which is the frame this ticket is about.
  assert.deepEqual(entriesFor(rig.frontLeg, 'driver-channel', WATCHER), [[WATCHER_TEXTURES.value]],
    "the driver is told the spectator's own skin, not a vanilla default and never the puppet's")

  // A second spectator, with a skin of its own: the first one's channel is told about it,
  // and neither channel is told about itself.
  rig.core.spectateView({ name: 'Second', uuid: SECOND, channel: 'b-channel', skin: SECOND_TEXTURES })
  assert.deepEqual(entriesFor(rig.frontLeg, 'a-channel', SECOND), [[SECOND_TEXTURES.value]],
    "one spectator draws another with that spectator's own skin")
  assert.deepEqual(entriesFor(rig.frontLeg, 'b-channel', WATCHER), [[WATCHER_TEXTURES.value]],
    "and the second is told the first one's")
  assert.deepEqual(entriesFor(rig.frontLeg, 'a-channel', WATCHER), [],
    'no channel is told about its own player')
  assert.deepEqual(entriesFor(rig.frontLeg, 'b-channel', SECOND), [])

  // The body's entry is the other skin in the same payload, and it keeps the puppet's:
  // two entries naming two players, two skins, and neither on the other's body.
  const bodyEntries = skinFrames(rig.frontLeg).filter(frame => frame.packet.data[0].uuid === PUPPET)
  assert.ok(bodyEntries.length >= 1, 'the body is announced to every channel')
  for (const frame of bodyEntries) {
    assert.deepEqual(frame.packet.data[0].player.properties, [TEXTURES], "the body's entry carries the puppet's")
  }
  assert.notEqual(TEXTURES.value, WATCHER_TEXTURES.value)
  assert.notEqual(WATCHER_TEXTURES.value, SECOND_TEXTURES.value)
})

test('#685 with the skin switch off, the entry naming a spectator carries no property', async () => {
  const rig = makeCore({
    config: { picker: true, skin: { showPuppetSkin: false }, puppet: { username: 'Wiriaw', uuid: PUPPET } }
  })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  rig.frontLeg.channelRecord({ id: 'driver-channel' })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'a-channel', skin: WATCHER_TEXTURES })

  // The entry is still written, because the body needs it to be drawn at all, and it
  // claims no skin: one switch, and off means no entry carrying one.
  assert.deepEqual(entriesFor(rig.frontLeg, 'driver-channel', WATCHER), [[]],
    'the entry is written and carries no texture')
})
// #685: a property the entry builder would refuse is no skin, and it must not cost the body
// either. A client drops a spawn whose UUID it holds no entry for, so an entry withheld for a
// bad property would delete the spectator from every other channel's world.
test('#685 a landing handed a property the builder refuses is announced without a skin, and the body still stands', async () => {
  const rig = makeCore({ config: skinConfig() })
  await landABody(rig)
  deliverPlayerInfo(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
  rig.frontLeg.channelRecord({ id: 'driver-channel' })

  const view = rig.core.spectateView({
    name: 'Watcher',
    uuid: WATCHER,
    channel: 'a-channel',
    skin: { value: '' }
  })

  assert.equal(view.ownSkin, false, 'no entry names the spectator on its own channel')
  assert.deepEqual(entriesFor(rig.frontLeg, 'driver-channel', WATCHER), [[]],
    'the entry is written and claims no skin')
  const spawned = rig.frontLeg.frames()
    .filter(frame => frame.name === 'spawn_entity' && frame.channel === 'driver-channel')
    .map(frame => frame.packet.objectUUID)
  assert.ok(spawned.includes(WATCHER), 'and the body it belongs to is still spawned')
})

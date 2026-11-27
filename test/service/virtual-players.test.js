// #635: what a spectator's socket is told about the puppet's body.
//
// The owner's report, twice from the live lane: the frames arrive and the world is empty.
// A client draws another player from a `player_info` entry *and an entity for that UUID*,
// and a server never sends a client its own player entity, so the body's own stream holds
// no spawn for the puppet. #614 gave every channel the entry; this is the entity, and the
// rules this file pins are the ones a frame count cannot see:
//
//   the order      entry, then spawn, then a move. A move before the spawn is dropped by
//                  the client, and a stream of the right frames in the wrong order is the
//                  same empty world (src/core/virtual-players.test.js pins the module's
//                  half; this file pins the order on one socket).
//   the exemption  a channel is never told about the player it speaks for, so the body's
//                  own stream carries no spawn and the parity rung's premise survives.
//   the honesty    a frame the leg could not deliver is not counted, and the leg's two
//                  refusals are two events: a throw leaves a channel that is owed the frame on
//                  the next pass, and a false says nothing is owed, and both are refusals
//                  (#736).
//
// Seam: the fake-integration rig (test/support/harness.js). What a socket hides is exactly
// which channel a frame went to and in what order, and the fake front leg records both
// (src/legs/fake-legs.js). O69 proves the same path over a real socket, with a real
// protocol bot.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHANNEL_ROLES } from '../../src/core/channels.js'
import { pickSlug } from '../../src/core/picker.js'
import { FIRST_VIRTUAL_ENTITY_ID, playerEntityTypeFor } from '../../src/core/virtual-players.js'
import { makeCore } from '../support/harness.js'

// The body a claim dials, and the body a spectator watches it through. The driver's UUID is
// the puppet's: a driver is the body, and that is why its channel is never offered a spawn.
const TARGET = { host: '127.0.0.1', port: 25566 }
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const WATCHER = '11111111-2222-3333-4444-555555555555'
const CLAIMED = { body: pickSlug(TARGET.host + ':' + TARGET.port), target: TARGET }
const CHANNEL = 'spectator-channel'

const config = () => ({
  picker: true,
  skin: { showPuppetSkin: true },
  puppet: { username: 'Wiriaw', uuid: PUPPET }
})

// The body's join, cached: configuration first, then its play login, a pose, and the warm
// marker. The pose is the one the puppet is at when the spectator lands.
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

// The proxy's own entity frames, on the one channel a spectator holds.
const entityFrames = (frontLeg, name) =>
  frontLeg.frames().filter(frame => frame.name === name && frame.channel === CHANNEL)

// Land a spectator on a driven body and hand it the puppet's entry, which is the order the
// real lane writes them in: #614's entry, then the entity.
function spectate (rig) {
  rig.core.attachPlayer({ name: 'Pilot', uuid: PUPPET })
  rig.backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: Buffer.from('play:player_info'),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [] } }]
    }
  })
  const view = rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })
  assert.equal(view.watching, true)
  return view
}

test('#635 a spectator is told the puppet\'s body, after the entry that names it', async () => {
  const rig = makeCore({ config: config() })
  await landABody(rig)
  const view = spectate(rig)

  const spawns = entityFrames(rig.frontLeg, 'spawn_entity')
  assert.equal(spawns.length, 1, 'one body for the one player this lane serves')
  const spawn = spawns[0]
  assert.equal(spawn.packet.objectUUID, PUPPET, 'for the UUID the entry names')
  // The type the module was built with: this rig's config names no version, so it runs the
  // default pin, and the table's own rows are held to the data by the core test and by O69.
  assert.equal(spawn.packet.type, playerEntityTypeFor('26.1'), 'as a player, or a client draws a boat')
  assert.deepEqual([spawn.packet.x, spawn.packet.y, spawn.packet.z], [1, 2, 3], 'where the body is')

  // The order on that socket: the entry, then the body, and the mode frames stay last.
  const names = rig.frontLeg.frames()
    .filter(frame => frame.channel === CHANNEL)
    .map(frame => frame.name)
  const entry = names.lastIndexOf('player_info')
  assert.ok(entry !== -1, 'the entry #614 wrote is on this channel')
  assert.ok(entry < names.indexOf('spawn_entity'), 'the entry comes before the body it is a face for')
  assert.ok(names.indexOf('spawn_entity') < names.length - 2, 'and the world is not the last thing said')
  assert.equal(names.at(-2), 'game_state_change', 'the spectator is told what it is, last (#259)')
  assert.equal(names.at(-1), 'abilities')

  assert.equal(view.virtualFrames, 1, 'the landing says what it handed that client')
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 1)
  assert.equal(rig.core.metrics.virtualPlayersMoved, 0)
  assert.equal(rig.core.metrics.virtualPlayersDespawned, 0)
  assert.equal(rig.core.metrics.virtualPlayersRefused, 0, 'a socket took every frame, so nothing was refused')

  // No other socket and no broadcast carries a spawn: a channel is never told about the
  // player it speaks for, and the body's own stream is not a place for one.
  const everywhere = rig.frontLeg.frames().filter(frame => frame.name === 'spawn_entity')
  assert.deepEqual(everywhere.map(frame => frame.channel), [CHANNEL])
})

test('#635 the body follows the puppet\'s own movement, one frame per window', async () => {
  const rig = makeCore({ config: config() })
  await landABody(rig)
  spectate(rig)
  const spawn = entityFrames(rig.frontLeg, 'spawn_entity')[0]

  // The puppet walks. Its own client sends the position, and its probe is the backend.
  rig.frontLeg.serverbound({ name: 'position_look', data: { x: 4, y: 64, z: 6, yaw: 90, pitch: 0 } })
  let moves = entityFrames(rig.frontLeg, 'entity_teleport')
  assert.equal(moves.length, 0, 'nothing inside the window the spawn opened')

  rig.clock.tick(50)
  rig.frontLeg.serverbound({ name: 'position_look', data: { x: 8, y: 64, z: 6, yaw: 90, pitch: 0 } })
  moves = entityFrames(rig.frontLeg, 'entity_teleport')
  assert.equal(moves.length, 1, 'one frame for the window, however many poses arrived')
  assert.equal(moves[0].packet.entityId, spawn.packet.entityId, 'the body the spawn gave it')
  assert.deepEqual([moves[0].packet.x, moves[0].packet.y, moves[0].packet.z], [8, 64, 6])
  assert.equal(moves[0].packet.yaw, 90)
  assert.equal(rig.core.metrics.virtualPlayersMoved, 1)

  // The body's own entity id never appears: the id is the proxy's, from a range a backend
  // does not allocate into.
  assert.ok(spawn.packet.entityId !== 42, 'the body\'s own login entity id is not reused')
})

test('#635 a spawn the leg refused is owed again, and is not counted as told', async () => {
  const logLines = []
  const rig = makeCore({ config: config(), logLines })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: PUPPET })
  const write = rig.frontLeg.write.bind(rig.frontLeg)
  rig.frontLeg.write = (name, packet, options = {}) => {
    if (name === 'spawn_entity') throw new Error('the socket is gone')
    return write(name, packet, options)
  }

  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 0, 'a frame nobody received is not counted as told')
  assert.equal(rig.core.metrics.virtualPlayersRefused, 1)
  const refused = logLines.filter(line => line.event === 'virtualPlayerRefused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].frame, 'spawn_entity')
  assert.equal(refused[0].channel, CHANNEL)

  // The socket answers again, and the body it was owed is written on the next pass.
  rig.frontLeg.write = write
  rig.clock.tick(50)
  rig.frontLeg.serverbound({ name: 'position', data: { x: 2, y: 2, z: 2 } })
  assert.equal(entityFrames(rig.frontLeg, 'spawn_entity').length, 1)
  assert.equal(entityFrames(rig.frontLeg, 'entity_destroy').length, 1,
    'the id it never received a body for is destroyed first, then spawned')
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 1)
})

test('#736 a spawn the leg answers false for is a refusal, not a frame the client was told', async () => {
  const logLines = []
  const rig = makeCore({ config: config(), logLines })
  await landABody(rig)
  const write = rig.frontLeg.write.bind(rig.frontLeg)
  // The leg's own answer for a frame it did not take: `false`, and the frame is dropped. The
  // fake answers `undefined`, which the core reads as taken, so a refusal is this one patched
  // method — the shape test/service/replay-refused.test.js uses.
  rig.frontLeg.write = (name, packet, options = {}) =>
    name === 'spawn_entity' ? false : write(name, packet, options)

  spectate(rig)

  // The two numbers, apart. `Spawned` is the frames a socket took, and this socket took
  // none; `Refused` is the frames a socket did not, and it is where the false lands. A
  // case that only asserted their sum would pass a build that counted the frame twice.
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 0, 'a frame no socket took is not counted as told')
  assert.equal(rig.core.metrics.virtualPlayersRefused, 1, 'and the refusal is the number that moved')
  assert.equal(rig.core.metrics.virtualPlayersAnnounced, 0,
    'the entry is written by the skin path here, so the refusal is the spawn and nothing else')
  assert.equal(rig.core.metrics.virtualPlayersDespawned, 0)
  assert.equal(rig.core.metrics.virtualPlayersMoved, 0)

  // Where the operator looks next: one line, naming the frame and the channel, and carrying no
  // `error`, because a false is not a throw.
  const refused = logLines.filter(line => line.event === 'virtualPlayerRefused')
  assert.equal(refused.length, 1, 'one line for the one frame the leg did not take')
  assert.equal(refused[0].frame, 'spawn_entity', 'the line names the frame no client received')
  assert.equal(refused[0].channel, CHANNEL)
  assert.equal(refused[0].reason, 'spectate', 'and the path that wrote it')
  assert.ok(!('error' in refused[0]), 'a false is the leg saying no, not the leg raising')
  assert.equal(logLines.filter(line => line.event === 'virtualPlayerWritten').length, 0,
    'and nothing counts the frame as written')
})

test('#736 a move the leg answers false for moves the refusal counter, not the move counter', async () => {
  const logLines = []
  const rig = makeCore({ config: config(), logLines })
  await landABody(rig)
  spectate(rig)
  assert.equal(rig.core.metrics.virtualPlayersMoved, 0, 'the landing wrote no move yet')

  const write = rig.frontLeg.write.bind(rig.frontLeg)
  rig.frontLeg.write = (name, packet, options = {}) =>
    name === 'entity_teleport' ? false : write(name, packet, options)

  // The puppet walks, one window later, so the steady-state path writes its move.
  rig.clock.tick(50)
  rig.frontLeg.serverbound({ name: 'position', data: { x: 5, y: 64, z: 5 } })

  // The frame the leg answered false for is the same event on this path as on the landing:
  // the move counter counts the moves a socket took, and this socket took none of them.
  assert.equal(rig.core.metrics.virtualPlayersMoved, 0, 'a move no socket took is not a frame a client was told')
  assert.equal(rig.core.metrics.virtualPlayersRefused, 1, 'it is the refusal')
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 1, 'and the spawn that landed is untouched')

  const refused = logLines.filter(line => line.event === 'virtualPlayerRefused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].frame, 'entity_teleport')
  assert.equal(refused[0].channel, CHANNEL)
  assert.equal(refused[0].reason, 'movement', 'the sweep this move came out of: the puppet walked')
  assert.ok(!('error' in refused[0]))
})

test('#635 a respawn voids the client\'s entities, so the body is destroyed and spawned again', async () => {
  const rig = makeCore({ config: config() })
  await landABody(rig)
  spectate(rig)
  const spawn = entityFrames(rig.frontLeg, 'spawn_entity')[0]

  rig.backendLeg.deliver({
    state: 'play',
    name: 'respawn',
    buffer: Buffer.from('play:respawn'),
    data: { dimension: 0, worldName: 'minecraft:overworld', hashedSeed: 1, gameMode: 0, previousGameMode: 0, isDebug: false, isFlat: false, copyMetadata: true }
  })

  const names = rig.frontLeg.frames()
    .filter(frame => frame.channel === CHANNEL)
    .map(frame => frame.name)
  assert.deepEqual(names.slice(-2), ['entity_destroy', 'spawn_entity'],
    'the destroy comes after the frame that voided the client\'s map, and the spawn after it')
  const destroyed = entityFrames(rig.frontLeg, 'entity_destroy').at(-1)
  assert.deepEqual(destroyed.packet.entityIds, [spawn.packet.entityId])
  assert.equal(rig.core.metrics.virtualPlayersDespawned, 1)
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 2)
})

// --- #636: the channels see each other ---
//
// The owner's ask: "making the claim client be able to see the spectator in a transparent
// way would be nice and also spectator between themself". The seam is the same rig, and
// what a socket hides is the whole point of the case: which channel was told what, in what
// order, and which channel was told nothing.
const DRIVER_CHANNEL = 'holder-driver'
// The human's own account. The driver's channel speaks for the puppet all the same, which
// is the rule that keeps the body's own client from being handed a second copy of itself.
const HUMAN = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const WATCHER_B = '99999999-8888-7777-6666-555555555555'
const CHANNEL_B = 'spectator-channel-b'

const framesOn = (frontLeg, channel) => frontLeg.frames().filter(frame => frame.channel === channel)

// One body, a driver, and the driver's channel in the front's registry, which is where a
// channel id exists.
async function driverOnABody (rig) {
  rig.frontLeg.channelRecord({ id: DRIVER_CHANNEL, role: CHANNEL_ROLES.DRIVER })
  await landABody(rig)
  rig.core.attachPlayer({ name: 'Pilot', uuid: HUMAN })
  return rig
}

test('#636 the driver sees who is watching: an entry, then a body, at the position that client sent', async () => {
  const rig = await driverOnABody(makeCore({ config: config() }))
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })

  const told = framesOn(rig.frontLeg, DRIVER_CHANNEL)
  const entry = told.findIndex(frame => frame.name === 'player_info' && frame.packet.data[0].uuid === WATCHER)
  const body = told.findIndex(frame => frame.name === 'spawn_entity' && frame.packet.objectUUID === WATCHER)
  assert.ok(entry !== -1, 'the driver is told who is watching, or its client drops the body that follows')
  assert.ok(body !== -1, 'and is given a body for that UUID')
  assert.ok(entry < body, 'the entry comes first: a spawn before it is a body the client throws away')
  const spawn = told[body].packet
  assert.ok(spawn.entityId >= FIRST_VIRTUAL_ENTITY_ID, 'the id is the proxy\'s own, not one a backend hands out')

  // The driver's own world keeps exactly itself: the puppet\'s body is the body it controls.
  assert.equal(told.filter(frame => frame.name === 'spawn_entity' && frame.packet.objectUUID === PUPPET).length, 0,
    'no second copy of the body the driver controls')

  // The spectator\'s client moves, which is the second position source. Outside the
  // coalescing window the spawn opened, so one frame is owed.
  rig.clock.tick(50)
  const sent = { x: 9.5, y: 10.5, z: 11.5, yaw: 90, pitch: 0 }
  rig.frontLeg.spectatorMoved({ channel: CHANNEL, name: 'position_look', data: sent })
  const moves = framesOn(rig.frontLeg, DRIVER_CHANNEL).filter(frame => frame.name === 'entity_teleport')
  assert.equal(moves.length, 1, 'one move frame for the pose that arrived')
  assert.deepEqual([moves[0].packet.x, moves[0].packet.y, moves[0].packet.z], [sent.x, sent.y, sent.z])
  assert.equal(moves[0].packet.entityId, spawn.entityId, 'for the body the spawn gave it')
  // The counters are frames, per channel, because that is what a client was told: one body
  // for the spectator's view of the puppet and one for the driver's view of the spectator,
  // one announcement each, and the move on the one channel that was not the mover's own.
  assert.equal(rig.core.metrics.virtualPlayersMoved, 1)
  assert.equal(rig.core.metrics.virtualPlayersSpawned, 2)
  assert.equal(rig.core.metrics.virtualPlayersAnnounced, 1, 'one announcement, for the one player #614 does not name')
  assert.equal(rig.core.metrics.virtualPlayersDespawned, 0)
})

test('#636 two spectators see each other, and neither is told about itself', async () => {
  const rig = await driverOnABody(makeCore({ config: config() }))
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })
  rig.frontLeg.channelRecord({ id: CHANNEL_B, role: CHANNEL_ROLES.SPECTATOR })
  rig.core.spectateView({ name: 'Second', uuid: WATCHER_B, channel: CHANNEL_B })

  // Each spectator\'s socket carries the other player\'s entry and body.
  const entriesOn = channel => framesOn(rig.frontLeg, channel)
    .filter(frame => frame.name === 'player_info').map(frame => frame.packet.data[0].uuid)
  const bodiesOn = channel => framesOn(rig.frontLeg, channel)
    .filter(frame => frame.name === 'spawn_entity').map(frame => frame.packet.objectUUID)

  assert.ok(entriesOn(CHANNEL).includes(WATCHER_B), 'the first spectator is told about the second')
  assert.ok(bodiesOn(CHANNEL).includes(WATCHER_B))
  assert.ok(entriesOn(CHANNEL_B).includes(WATCHER), 'and the second about the first')
  assert.ok(bodiesOn(CHANNEL_B).includes(WATCHER))
  assert.ok(!entriesOn(CHANNEL).includes(WATCHER), 'nobody is told about themselves')
  assert.ok(!bodiesOn(CHANNEL).includes(WATCHER))
  assert.ok(!entriesOn(CHANNEL_B).includes(WATCHER_B))
  assert.ok(!bodiesOn(CHANNEL_B).includes(WATCHER_B))
  // The driver sees both, and still not itself.
  const driverBodies = bodiesOn(DRIVER_CHANNEL)
  assert.deepEqual(driverBodies.sort(), [WATCHER, WATCHER_B].sort())
  assert.ok(!driverBodies.includes(PUPPET))

  // One spectator moving moves the other one\'s copy of it, and not the mover\'s own.
  rig.clock.tick(50)
  rig.frontLeg.spectatorMoved({ channel: CHANNEL, name: 'position', data: { x: 4, y: 70, z: 4 } })
  assert.equal(framesOn(rig.frontLeg, CHANNEL_B).filter(frame => frame.name === 'entity_teleport').length, 1)
  assert.equal(framesOn(rig.frontLeg, CHANNEL).filter(frame => frame.name === 'entity_teleport').length, 0)
})

test('#636 a spectator that leaves is destroyed on the channels that were shown it', async () => {
  const rig = await driverOnABody(makeCore({ config: config() }))
  rig.frontLeg.channelRecord({ id: CHANNEL_B, role: CHANNEL_ROLES.SPECTATOR })
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })
  rig.core.spectateView({ name: 'Second', uuid: WATCHER_B, channel: CHANNEL_B })
  const body = framesOn(rig.frontLeg, DRIVER_CHANNEL)
    .find(frame => frame.name === 'spawn_entity' && frame.packet.objectUUID === WATCHER).packet

  // The spectator\'s client goes: its channel closes, and the front says so.
  rig.frontLeg.forgetChannelRecord(CHANNEL)
  rig.core.spectatorLeft({ channel: CHANNEL, name: 'Watcher' })

  for (const channel of [DRIVER_CHANNEL, CHANNEL_B]) {
    const destroyed = framesOn(rig.frontLeg, channel)
      .filter(frame => frame.name === 'entity_destroy').flatMap(frame => frame.packet.entityIds)
    assert.deepEqual(destroyed, [body.entityId], 'the id that channel was given, on ' + channel)
  }
  assert.equal(rig.core.metrics.virtualPlayersDespawned, 2, 'two channels were shown it, so two destroys')
})

test('#636 a spectator\'s own position reaches no backend frame, and names nothing on the puppet\'s connection', async () => {
  // The transparency rule (docs/transparency.md): a spectator carries no claim, because the
  // server does not know it exists. The frames this ticket adds are clientbound, and the one
  // serverbound thing a spectator now contributes is a pose. Anything else would be the
  // proxy telling the server about a player it never admitted.
  const rig = await driverOnABody(makeCore({ config: config() }))
  const clients = {
    raw: rig.backendLeg.rawWrites().length,
    packets: rig.backendLeg.packetWrites().length,
    forwarded: rig.core.metrics.serverboundForwarded
  }
  rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: CHANNEL })
  rig.clock.tick(50)
  rig.frontLeg.spectatorMoved({ channel: CHANNEL, name: 'position_look', data: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } })

  assert.equal(rig.backendLeg.rawWrites().length, clients.raw, 'no raw frame reached the puppet\'s connection')
  assert.equal(rig.backendLeg.packetWrites().length, clients.packets, 'and no packet did either')
  assert.equal(rig.core.metrics.serverboundForwarded, clients.forwarded, 'and nothing was forwarded')
  // Named, not only counted: no frame the backend was handed says the spectator exists.
  const written = JSON.stringify([rig.backendLeg.rawWrites(), rig.backendLeg.packetWrites()])
  assert.ok(!written.includes(WATCHER), 'no serverbound frame names the spectator\'s UUID')
  assert.ok(!written.toLowerCase().includes('watcher'), 'and none names it either')
})


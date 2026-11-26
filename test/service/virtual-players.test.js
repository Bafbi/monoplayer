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
//   the honesty    a frame the leg could not deliver is not counted, and what it was owed
//                  is written on the next pass.
//
// Seam: the fake-integration rig (test/support/harness.js). What a socket hides is exactly
// which channel a frame went to and in what order, and the fake front leg records both
// (src/legs/fake-legs.js). O69 proves the same path over a real socket, with a real
// protocol bot.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickSlug } from '../../src/core/picker.js'
import { playerEntityTypeFor } from '../../src/core/virtual-players.js'
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

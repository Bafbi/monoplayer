// #635: the players a body's channels are told about, as entities they can draw.
//
// A spectator is handed the body's whole play stream and renders an empty world: a
// Minecraft client draws another player from a `player_info` entry *and an entity for
// that UUID*, and a server never sends a client its own player entity. So the body's
// cached stream carries no spawn for the puppet, and nothing in the relay invents one.
// #614 gave every channel the entry; this module gives every channel but the player's
// own the entity that goes with it.
//
// The order is the interface, and it is the reason this is a module and not three call
// sites: an entry before the spawn (#614 writes it, the service writes it first), a
// move only after the spawn, and one despawn at the end. A move for an entity the client
// cannot place is dropped by the client and by src/ladder/client-state.js, so an
// ordering bug is invisible to every count of frames — only the sequence catches it.
//
// What this file pins is the module's contract, not the wire: the service proves the
// delivery in test/service/virtual-players.test.js and the rung (O69) proves it over a
// socket. Nothing here opens one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  FIRST_VIRTUAL_ENTITY_ID,
  MOVE_INTERVAL_MS,
  PLAYER_ENTITY_TYPES,
  createVirtualPlayers,
  playerEntityTypeFor
} from '../../src/core/virtual-players.js'
import { applyFrames, createClientState, stateSnapshot } from '../../src/ladder/client-state.js'

const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const WATCHER = '11111111-2222-3333-4444-555555555555'
const pose = (x = 0, yaw = 0) => ({ x, y: 64, z: 0, yaw, pitch: 0 })

// 26.2's row, which is the version the vendored tree carries. 26.1's row is held to the
// data by O69, on the wire and on the version that rung speaks.
const PLAYER_TYPE = playerEntityTypeFor('26.2')

const worldOf = (...players) => ({ players: () => players })
const roster = (...channels) => () => channels
const puppetAt = at => worldOf({ uuid: PUPPET, name: 'GlowSquidye', pose: at })

const watcherChannel = Object.freeze({ id: 'watcher-channel', uuid: WATCHER })
const pilotChannel = Object.freeze({ id: 'pilot-channel', uuid: PUPPET })

// The frames one channel is owed, in the order it is owed them.
function framesOn (updates, id) {
  const update = updates.find(entry => entry.channel === id)
  return update === undefined ? [] : update.frames
}

const namesOn = (updates, id) => framesOn(updates, id).map(frame => frame.name)

// The entity a run of frames leaves in the client's own model, so the module's frame is
// read by the same reader the parity rung uses rather than by a second one written here.
function entityAfter (frames, entityId) {
  const state = applyFrames(createClientState(), frames)
  return stateSnapshot(state).entities.find(entity => String(entity.entityId) === String(entityId)) ?? null
}

test('#635 a channel is told the players that are not its own, and never its own', () => {
  const virtual = createVirtualPlayers({ world: puppetAt(pose()), channels: roster(watcherChannel, pilotChannel), entityType: PLAYER_TYPE })
  const updates = virtual.owed({ at: 0 })

  const told = framesOn(updates, watcherChannel.id)
  assert.deepEqual(told.map(frame => frame.name), ['spawn_entity'])
  const spawn = told[0].packet
  assert.equal(spawn.objectUUID, PUPPET, 'the entity names the puppet')
  assert.equal(spawn.type, PLAYER_TYPE, 'as a player, or the client draws the wrong thing')
  assert.ok(spawn.entityId >= FIRST_VIRTUAL_ENTITY_ID, 'from the range a backend cannot hand out')
  assert.deepEqual([spawn.x, spawn.y, spawn.z], [0, 64, 0], 'at the pose the body is at')
  assert.deepEqual(spawn.velocity, { x: 0, y: 0, z: 0 })

  // The driver's channel speaks for the puppet. A spawn there is a duplicate of the body
  // the client already controls, so the module never writes one.
  assert.deepEqual(framesOn(updates, pilotChannel.id), [], 'no frame on the channel that is the player')

  // One update per channel that is owed something, and none for a channel owed nothing.
  assert.deepEqual(updates.map(update => update.channel), [watcherChannel.id])
})

test('#635 the spawn’s own angles are the pose’s, read back by the client-state model', () => {
  const virtual = createVirtualPlayers({
    world: puppetAt({ x: 1, y: 2, z: 3, yaw: 90, pitch: -45 }),
    channels: roster(watcherChannel),
    entityType: PLAYER_TYPE
  })
  const [spawn] = framesOn(virtual.owed({ at: 0 }), watcherChannel.id)
  const entity = entityAfter([{ name: spawn.name, data: spawn.packet }], spawn.packet.entityId)
  assert.ok(entity !== null, 'the client-state model places the entity')
  assert.equal(entity.removed, false)
  const field = key => entity.fields.find(entry => entry.key === key)?.value
  assert.deepEqual([field('x'), field('y'), field('z')], [1, 2, 3])
  // An i8 angle is 1/256 of a turn, so a whole byte is what round-trips exactly.
  assert.equal(field('yaw'), 90)
  assert.equal(field('pitch'), -45)
})

test('#635 a move follows the spawn, and never arrives before it', () => {
  let at = pose(0)
  const world = { players: () => [{ uuid: PUPPET, name: 'GlowSquidye', pose: at }] }
  const virtual = createVirtualPlayers({ world, channels: roster(watcherChannel), entityType: PLAYER_TYPE })
  const first = virtual.owed({ at: 0 })
  assert.deepEqual(namesOn(first, watcherChannel.id), ['spawn_entity'])
  const id = framesOn(first, watcherChannel.id)[0].packet.entityId

  // The puppet moved, one window later.
  at = pose(0.4)
  const moved = virtual.owed({ at: MOVE_INTERVAL_MS })
  // The puppet really moved: one absolute frame, for the id the spawn gave it.
  const teleport = framesOn(moved, watcherChannel.id).find(frame => frame.name === 'entity_teleport')
  assert.ok(teleport !== undefined, 'the move is one frame, and it is a teleport')
  assert.equal(teleport.packet.entityId, id)
  assert.equal(teleport.packet.x, 0.4, 'absolute, so a coalesced stream cannot lose the path')
  assert.equal(teleport.packet.dx, 0, 'and no relative offset rides on it')
  assert.equal(teleport.packet.dy, 0)
  assert.equal(teleport.packet.dz, 0)
})

test('#635 movement inside one window is coalesced, and a still puppet is sent nothing', () => {
  let at = pose(0)
  const world = { players: () => [{ uuid: PUPPET, name: 'GlowSquidye', pose: at }] }
  const virtual = createVirtualPlayers({ world, channels: roster(watcherChannel), entityType: PLAYER_TYPE })
  virtual.owed({ at: 0 })

  // Ten pose changes inside the window, which is what a walking puppet sends.
  for (let ms = 5; ms < MOVE_INTERVAL_MS; ms += 5) {
    at = pose(ms / 100)
    assert.deepEqual(namesOn(virtual.owed({ at: ms }), watcherChannel.id), [],
      'no frame inside the window, at ' + ms + ' ms')
  }
  at = pose(0.5)
  assert.deepEqual(namesOn(virtual.owed({ at: MOVE_INTERVAL_MS }), watcherChannel.id), ['entity_teleport'],
    'one frame for the burst, carrying the newest pose')

  // The puppet stands still: the window passes and there is nothing to say.
  assert.deepEqual(namesOn(virtual.owed({ at: MOVE_INTERVAL_MS * 4 }), watcherChannel.id), [])
})

test('#635 a world change destroys the id it gave, then spawns it again', () => {
  const virtual = createVirtualPlayers({ world: puppetAt(pose()), channels: roster(watcherChannel), entityType: PLAYER_TYPE })
  const [spawn] = framesOn(virtual.owed({ at: 0 }), watcherChannel.id)
  const id = spawn.packet.entityId

  // The client's entity map is voided by a play login or a respawn, so it holds no
  // entity for an id it was given before.
  virtual.forget({ reason: 'respawn' })
  assert.deepEqual(namesOn(virtual.owed({ at: 10 }), watcherChannel.id), ['entity_destroy', 'spawn_entity'],
    'the destroy comes first, and the spawn follows it')
  const frames = framesOn(virtual.owed({ at: 20 }), watcherChannel.id)
  assert.deepEqual(frames, [], 'and the second sweep has nothing left to say')
})

test('#635 a player that leaves the world is destroyed once, and the channel keeps its bookkeeping', () => {
  let players = [{ uuid: PUPPET, name: 'GlowSquidye', pose: pose() }]
  const world = { players: () => players }
  const virtual = createVirtualPlayers({ world, channels: roster(watcherChannel), entityType: PLAYER_TYPE })
  const [spawn] = framesOn(virtual.owed({ at: 0 }), watcherChannel.id)

  players = []
  const leaving = framesOn(virtual.owed({ at: 10 }), watcherChannel.id)
  assert.deepEqual(leaving.map(frame => frame.name), ['entity_destroy'])
  assert.deepEqual(leaving[0].packet.entityIds, [spawn.packet.entityId])
  assert.deepEqual(framesOn(virtual.owed({ at: 20 }), watcherChannel.id), [], 'one despawn, not one per sweep')

  // The same player comes back: a fresh spawn, and no second destroy.
  players = [{ uuid: PUPPET, name: 'GlowSquidye', pose: pose(2) }]
  assert.deepEqual(namesOn(virtual.owed({ at: 30 }), watcherChannel.id), ['spawn_entity'])
})

test('#635 a channel that ended is owed nothing, and a player with no uuid is nobody', () => {
  // The roster is the one record of which connections exist: the service removes a
  // spectator from it when its socket closes, and the module keeps no second copy that
  // could disagree.
  let open = [watcherChannel]
  const channels = () => open
  const virtual = createVirtualPlayers({ world: puppetAt(pose()), channels, entityType: PLAYER_TYPE })
  assert.deepEqual(namesOn(virtual.owed({ at: 0 }), watcherChannel.id), ['spawn_entity'])

  open = []
  assert.deepEqual(virtual.owed({ at: 10 }), [], 'a channel that ended is never written to')

  // And what it was shown went with it, so the same connection coming back is a fresh
  // spawn rather than an entity the module thought was still on that client.
  open = [watcherChannel]
  assert.deepEqual(namesOn(virtual.owed({ at: 20 }), watcherChannel.id), ['spawn_entity'])

  const unnamed = createVirtualPlayers({ world: worldOf({ uuid: null, pose: pose() }), channels: roster(watcherChannel), entityType: PLAYER_TYPE })
  assert.deepEqual(unnamed.owed({ at: 0 }), [], 'a player the proxy cannot name is not spawned')
})

test('#635 the player entity type is the pinned protocol data’s, and a lane must name its version', () => {
  // The vendored tree is what the installed package carries (scripts/patch-minecraft-data-
  // 26.2.mjs copies it), so this reads the file that owns the number rather than a second
  // copy of it. 26.1's row is held to the data by O69, on the version that rung speaks.
  const entities = JSON.parse(fs.readFileSync(
    new URL('../../vendor/minecraft-data-26.2/data/pc/26.2/entities.json', import.meta.url)
  ))
  const player = entities.find(entry => entry.name === 'player')
  assert.ok(player !== undefined, 'the data names a player entity')
  assert.equal(PLAYER_ENTITY_TYPES['26.2'], player.id, 'a wrong type id draws the wrong body')
  // The two versions this tree speaks disagree, which is why the number is not one
  // constant: a lane pinned to 26.1 that drew 26.2's id would draw a body nobody asked for.
  assert.notEqual(PLAYER_ENTITY_TYPES['26.1'], PLAYER_ENTITY_TYPES['26.2'])
  assert.equal(playerEntityTypeFor('26.2'), player.id)
  // A version nobody pinned is a lane that cannot be drawn, and it fails where it is named
  // rather than drawing the wrong body quietly.
  assert.throws(() => playerEntityTypeFor('27.0'), /no player entity type/)
  assert.throws(() => createVirtualPlayers({ world: worldOf(), channels: roster() }), /entityType/)
})

test('#635 the id range is a varint a backend cannot reach', () => {
  // entityId is a varint, so the largest id a client accepts is 2^31-1. A backend
  // allocates from zero and increments, so a base far above any real allocation cannot
  // collide with a body it spawned.
  assert.ok(FIRST_VIRTUAL_ENTITY_ID > 0 && FIRST_VIRTUAL_ENTITY_ID < 2 ** 31 - 1)
  const virtual = createVirtualPlayers({
    world: worldOf({ uuid: PUPPET, pose: pose() }, { uuid: WATCHER, pose: pose() }),
    channels: roster({ id: 'a', uuid: null }),
    entityType: PLAYER_TYPE
  })
  const ids = virtual.owed({ at: 0 })
    .flatMap(update => update.frames.filter(frame => frame.name === 'spawn_entity'))
    .map(frame => frame.packet.entityId)
  assert.equal(new Set(ids).size, 2, 'two players, two ids')
  assert.ok(ids.every(id => id >= FIRST_VIRTUAL_ENTITY_ID && id < 2 ** 31 - 1))
})

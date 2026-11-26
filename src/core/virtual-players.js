// #635: the players a body's channels are told about, as entities a client can draw.
//
// A Minecraft client draws another player from two facts, and a body's own stream carries
// neither of them for the puppet:
//
//   a `player_info` entry   the skin and the name. #614 sends the one that names the
//                            puppet to every channel of the body (src/core/skin.js).
//   an entity for its UUID  the body: a spawn, and then where it is. **A server never
//                            sends a client its own player entity**, so the body's cache
//                            holds no spawn for the puppet, and a spectator's world has a
//                            tab list line and nobody standing in it.
//
// The owner reported it twice from the live lane: the frames arrive (skinFramesWritten 6,
// 5058 frames replayed) and the world is empty. This module is the missing half. The entry
// is not built here: it has one home, a second `add_player` for one UUID is a frame #614
// already writes, and the caller writes it first.
//
// Where the pose comes from: the puppet's own client and the backend's corrections, read
// once by `capturePose` (src/core/relay.js) into `session.currentPose`. It is not in the
// state cache and never was: `position` is a per-leg frame (PLAY_PER_LEG in
// src/core/clientbound-policy.js), so this module is handed the pose and reads nothing.
//
// The order is the interface, and it is why this is a module rather than three call sites:
//
//   the entry, then the spawn   the caller writes #614's entry first. A spawn is what gives
//                               a player its body (GLOSSARY.md, Entity slot); an entry is
//                               only what gives it a face.
//   a move only after it        a move for an entity a client cannot place is dropped, by
//                               the client and by this repository's own model
//                               (src/ladder/client-state.js, applyEntityDelta). A wrong
//                               order is therefore invisible to every count of frames, and
//                               only the sequence catches it, which is what the tests pin.
//   one despawn at the end      no second destroy for one spawn, and no destroy without a
//                               spawn before it.
//
// Coalescing, and why this choice. The puppet moves at its client's own tick rate, up to 20
// times a second, and a spectator does not need every frame of that. This module owes at
// most one move frame per channel per `MOVE_INTERVAL_MS` (50 ms, one server tick), carrying
// the newest pose, and nothing at all while the pose does not change — the common case, and
// the real saving. The cost is stated plainly: a puppet that stops mid-stride leaves a
// spectator up to one window of motion behind, about a fifth of a block for a walking
// player, and a client interpolates between frames, so the motion itself still reads as
// motion.
//
// A move is an absolute `entity_teleport`, never a relative `rel_entity_move`, because
// coalescing deletes frames: a delta stream that skips one delta is a lie about the path,
// and one dropped delta is unrecoverable (docs/adr/keep-relative-moves-out-of-the-entity-
// ring.md argues the same for the cache).
//
// Entity identity. Nothing else in this tree allocates an entity id, and a client keeps one
// id space per connection: a collision with a body the backend spawned would replace that
// body in the client's world. So the ids here are the proxy's own, from
// `FIRST_VIRTUAL_ENTITY_ID` upward, one per player UUID for the life of the process and
// never reused. A backend's ids come from a counter that starts at zero, so a base of a
// thousand million is out of reach of any allocation a server makes, and the field is a
// varint, so 2^31 - 1 is the ceiling.
//
// The entity type is protocol data and it moves between the two versions this tree speaks,
// so it is an input: `playerEntityTypeFor(version)`, and the caller passes the lane's own
// pin. A wrong type draws the wrong body, and a client has no way to say so, which is why
// each row is held to the data by a test rather than trusted: 26.2 by
// test/core/virtual-players.test.js, 26.1 by the O69 rung on the protocol it speaks.
//
// A world change voids every entity a client holds: a play `login` is a new session and a
// `respawn` is a new dimension (src/core/state-cache.js, `flushEntities`, is the cache's
// own copy of that rule). `forget()` is how a caller says so, and what is owed next is the
// destroy of the id it gave and then a spawn. A connection that ends leaves the channels
// it is reported on: its socket is gone, so it is owed no frame and none is counted.
//
// Purity: in = the world's players, the channels, the moment; out = frames, ordered, per
// channel. No socket, no timer, no clock of its own, no cache, no write. The caller writes
// what this returns, which is also where a frame is counted as delivered.

// The player entity type per protocol version this tree speaks, as the data states it. It
// moves between the two (see above), and a lane pinned to one version must not draw the
// other's body:
//   node -e "console.log(require('minecraft-data')('26.1').entitiesByName.player.id)"
//   node tools/protocol.mjs ... / vendor/minecraft-data-26.2/data/pc/26.2/entities.json
export const PLAYER_ENTITY_TYPES = Object.freeze({ '26.1': 155, '26.2': 156 })

export function playerEntityTypeFor (version) {
  const type = PLAYER_ENTITY_TYPES[version]
  if (!Number.isInteger(type)) {
    throw new TypeError(
      'no player entity type for protocol version ' + JSON.stringify(version) +
      ': this module knows ' + Object.keys(PLAYER_ENTITY_TYPES).join(', ')
    )
  }
  return type
}

// The first entity id this module hands out: above any id a backend's own counter reaches
// (it starts at zero and increments once per body), and below the varint's ceiling.
export const FIRST_VIRTUAL_ENTITY_ID = 1_000_000_000

// At most one move frame per channel per window: one server tick, the rate a backend
// tracks a player at. See the header for what the window costs.
export const MOVE_INTERVAL_MS = 50

const ANGLES_PER_TURN = 256
const DEGREES_PER_TURN = 360

const numeric = value => typeof value === 'number' && Number.isFinite(value)

// A UUID as a comparison key. The same player reaches this module from config, from a claim
// and from a decoded frame, and case and hyphens are not a difference between them.
const uuidKey = value =>
  typeof value === 'string' && value !== '' ? value.replace(/-/g, '').toLowerCase() : null

// An i8 angle: 1/256 of a turn, as a signed byte. Degrees in, the wire's unit out, and a
// client multiplies by 360/256 to get back where the caller started.
function angle8 (degrees) {
  if (!numeric(degrees)) return 0
  const raw = Math.round(degrees * ANGLES_PER_TURN / DEGREES_PER_TURN)
  const wrapped = ((raw % ANGLES_PER_TURN) + ANGLES_PER_TURN) % ANGLES_PER_TURN
  return wrapped >= ANGLES_PER_TURN / 2 ? wrapped - ANGLES_PER_TURN : wrapped
}

// A player's pose as this module reads it, or null when it cannot be placed. A player whose
// position nobody knows has nowhere to be drawn, and a body at the origin is a body in the
// wrong place, which is worse than no body at all.
function poseOf (player) {
  const pose = player?.pose
  if (pose === null || typeof pose !== 'object') return null
  if (!numeric(pose.x) || !numeric(pose.y) || !numeric(pose.z)) return null
  return {
    x: pose.x,
    y: pose.y,
    z: pose.z,
    yaw: numeric(pose.yaw) ? pose.yaw : 0,
    pitch: numeric(pose.pitch) ? pose.pitch : 0
  }
}

function moved (before, after) {
  return before === null ||
    before.x !== after.x || before.y !== after.y || before.z !== after.z ||
    before.yaw !== after.yaw || before.pitch !== after.pitch
}

function spawnFrame (shown, pose, entityType) {
  // headPitch is the head's own yaw, so a player whose head does not turn keeps its head on
  // its shoulders.
  const yaw = angle8(pose.yaw)
  return {
    name: 'spawn_entity',
    kind: 'spawn',
    packet: {
      entityId: shown.entityId,
      objectUUID: shown.uuid,
      type: entityType,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      velocity: { x: 0, y: 0, z: 0 },
      pitch: angle8(pose.pitch),
      yaw,
      headPitch: yaw,
      objectData: 0
    }
  }
}

function moveFrame (entityId, pose) {
  return {
    name: 'entity_teleport',
    kind: 'move',
    packet: {
      entityId,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      // Absolute: the relative offsets are zero and the flags say so.
      dx: 0,
      dy: 0,
      dz: 0,
      yaw: pose.yaw,
      pitch: pose.pitch,
      flags: 0,
      onGround: false
    }
  }
}

function despawnFrame (entityId) {
  return { name: 'entity_destroy', kind: 'despawn', packet: { entityIds: [entityId] } }
}

// The players a body's channels are told about.
//
//   world       `players()` -> [{ uuid, name, pose }]. The players that exist in the world
//               this body serves, and where each is now. Read at every call, so nothing
//               here is a copy that can go stale. `name` is carried for a caller's log and
//               is not written: the name a client draws comes from the entry (#614).
//   channels    `() -> [{ id, uuid }]`: one entry per connection a player may be written
//               to, with the player that connection speaks for, or null when it speaks for
//               nobody. A channel is never told about its own player, which is the rule
//               that keeps a driver's client from being handed a duplicate of the body it
//               controls.
//   entityType  the player entity type for the lane's protocol version, from
//               `playerEntityTypeFor`.
export function createVirtualPlayers ({ world, channels, entityType } = {}) {
  if (world === null || typeof world !== 'object' || typeof world.players !== 'function') {
    throw new TypeError('createVirtualPlayers needs a world whose players() answers the players it holds')
  }
  if (typeof channels !== 'function') {
    throw new TypeError('createVirtualPlayers needs channels(), the connections a player may be written to')
  }
  if (!Number.isInteger(entityType)) {
    throw new TypeError('createVirtualPlayers needs entityType, the player entity type of the lane\'s version')
  }

  // channel id -> Map<uuid key, what that channel has been shown of that player>: the entity
  // id it was given, whether a spawn of it is live, whether the client's map has since been
  // voided, and the pose it was last told.
  const shown = new Map()
  // uuid key -> entity id. One player keeps one id for the life of the process, so a
  // re-spawn after a world change re-uses the identity the channel already knows.
  const identities = new Map()
  let nextEntityId = FIRST_VIRTUAL_ENTITY_ID

  function entityIdFor (key) {
    let id = identities.get(key)
    if (id === undefined) {
      id = nextEntityId++
      identities.set(key, id)
    }
    return id
  }

  function shownOn (channelId) {
    let records = shown.get(channelId)
    if (records === undefined) {
      records = new Map()
      shown.set(channelId, records)
    }
    return records
  }

  // What every connection is owed now, in the order it is owed it. A connection with
  // nothing to say is absent, so a caller writes only what somebody needs.
  function owed ({ at = 0 } = {}) {
    const now = numeric(at) ? at : 0
    const targets = channels()
    if (!Array.isArray(targets)) {
      throw new TypeError('channels() must answer an array of { id, uuid }, got ' + JSON.stringify(targets))
    }
    const players = world.players()
    if (!Array.isArray(players)) {
      throw new TypeError('world.players() must answer an array of { uuid, pose }, got ' + JSON.stringify(players))
    }
    const present = new Set()
    const owed = []

    for (const target of targets) {
      if (target === null || typeof target !== 'object') {
        throw new TypeError('a channel is { id, uuid }, got ' + JSON.stringify(target))
      }
      const id = target.id
      if (typeof id !== 'string' || id === '') {
        throw new TypeError('a channel needs a non-empty id, got ' + JSON.stringify(target))
      }
      present.add(id)
      const own = uuidKey(target.uuid)
      const records = shownOn(id)
      const frames = []
      const announced = new Set()

      for (const player of players) {
        const key = uuidKey(player?.uuid)
        // A player the proxy cannot name cannot be spawned, and a channel's own player is
        // the body it controls, not somebody to draw beside it.
        if (key === null || key === own) continue
        const pose = poseOf(player)
        if (pose === null) continue
        announced.add(key)

        let record = records.get(key)
        if (record === undefined) {
          record = { uuid: player.uuid, entityId: entityIdFor(key), spawned: false, stale: false, pose: null, at: null }
          records.set(key, record)
        }
        record.uuid = player.uuid

        if (!record.spawned || record.stale) {
          if (record.spawned) frames.push(despawnFrame(record.entityId))
          frames.push(spawnFrame(record, pose, entityType))
          record.spawned = true
          record.stale = false
          record.pose = pose
          record.at = now
          continue
        }
        if (!moved(record.pose, pose)) continue
        if (record.at !== null && now - record.at < MOVE_INTERVAL_MS) continue
        frames.push(moveFrame(record.entityId, pose))
        record.pose = pose
        record.at = now
      }

      // A player this channel was shown and no longer has: one destroy, and it is the last
      // frame of that player's presence here.
      for (const [key, record] of [...records]) {
        if (announced.has(key)) continue
        if (record.spawned) frames.push(despawnFrame(record.entityId))
        records.delete(key)
      }

      if (frames.length > 0) owed.push({ channel: id, frames })
    }

    // A connection no longer reported by `channels()` has ended. What it was shown goes with
    // it, and it is owed no frame: a write would reach no client, and counting it would say
    // a client was told something it was not.
    for (const id of [...shown.keys()]) if (!present.has(id)) shown.delete(id)
    return owed
  }

  // The client's entity map was voided: a play `login` or a `respawn`. Every spawn this
  // module made is now a body the client does not hold, so what is owed next is the destroy
  // of the id it gave and then a spawn. `channel` names one connection's fresh play state;
  // null is the whole body.
  function forget ({ channel = null } = {}) {
    const targets = channel === null ? [...shown.values()] : [shown.get(channel)]
    let count = 0
    for (const records of targets) {
      if (records === undefined) continue
      for (const record of records.values()) {
        if (!record.spawned) continue
        record.stale = true
        count++
      }
    }
    return { forgotten: count }
  }

  return { owed, forget }
}

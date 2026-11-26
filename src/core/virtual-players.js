// #635: the players a body's channels are told about, as entities a client can draw.
//
// A Minecraft client draws another player from two facts, and a body's stream carries
// neither for the puppet:
//
//   a `player_info` entry   the skin and the name. #614 sends the one that names the
//                            puppet to every channel of the body (src/core/skin.js).
//   an entity for its UUID  the body: a spawn, and then where it is. **A server never
//                            sends a client its own player entity**, so the body's cache
//                            holds no spawn for the puppet and a spectator's world has a
//                            tab list line and no player in it.
//
// The owner reported it twice from the live lane: the frames arrive (skinFramesWritten 6,
// 5058 frames replayed), and the world is empty. This module is the missing half. The
// entry is not built here — it has one home, and a second `add_player` for one UUID is
// what #614 already writes.
//
// Where the pose comes from: the puppet's own client and the backend's corrections, read
// once by `capturePose` (src/core/relay.js) into `session.currentPose`. It is not in the
// state cache and never was: `position` is a per-leg frame (src/core/clientbound-policy.js
// PLAY_PER_LEG), so this module is handed the pose and reads nothing.
//
// The order is the interface, and it is why this is a module rather than three call sites:
//
//   entry, then spawn      #614's entry is written first by the caller. A spawn is what
//                          gives a player its body (GLOSSARY.md, Entity slot), an entry
//                          is only what gives it a face.
//   a move only after it   a move for an entity a client cannot place is dropped by the
//                          client and by this repo's own model
//                          (src/ladder/client-state.js, applyEntityDelta). So a wrong
//                          order is invisible to every count of frames — only the
//                          sequence catches it, which is what the tests pin.
//   one despawn at the end  no second destroy for one life, and no destroy without a
//                          spawn before it.
//
// Coalescing, and why this choice. The puppet moves at the client's own tick rate, up to
// 20 times a second, and a spectator does not need every frame of it. This module sends
// at most one move frame per channel per `MOVE_INTERVAL_MS` (50 ms, one server tick),
// carrying the newest pose, and nothing at all when the pose did not change — the common
// case, and the real saving. The cost is stated plainly: a puppet that stops mid-stride
// leaves the spectator up to one window of motion stale, about a fifth of a block for a
// walking player, and the client interpolates between frames so the motion itself reads
// as motion.
//
// The move is an absolute `entity_teleport` and not a relative `rel_entity_move`, because
// coalescing deletes frames: a delta stream that skips one delta is a lie about the path,
// and one dropped delta is unrecoverable (docs/adr/keep-relative-moves-out-of-the-entity-
// ring.md argues the same for the cache).
//
// Entity identity. Nothing in this tree allocates an entity id, and a client keeps one id
// space per connection: a collision with a body the backend spawned would replace it in
// the client's world. So the ids here are the proxy's own, from `FIRST_VIRTUAL_ENTITY_ID`
// upward, monotonic for the life of the process, one per player UUID and never reused. A
// backend's ids come from a counter that starts at zero, so a base of a thousand million
// is out of reach of any allocation a server makes, and the field is a varint, so
// 2^31 - 1 is the ceiling.
//
// A world change voids every entity a client holds: a play `login` is a new session and
// `respawn` is a new dimension (src/core/state-cache.js, flushEntities, is the cache's own
// copy of that rule). `void()` is how a caller says so, and the next sweep destroys the
// id it gave and spawns it again, in that order. A channel that ends leaves the roster:
// its socket is gone, so it is owed no frame and none is counted, and the roster is the
// one record of which connections exist.
//
// Purity: in = the world's players, the channels, and the moment; out = frames, ordered,
// per channel. No socket, no timer, no clock of its own, no cache, and no write. The
// caller writes what this returns, which is also where a frame is counted as delivered.

// The player entity type, as the pinned protocol data states it. A client renders a
// `spawn_entity` by this number, so a wrong one draws a boat. It moves between the two
// versions this tree speaks (155 in 26.1, 156 in 26.2), which is why it is a named export
// with a test that reads the data:
//   node -e "console.log(require('minecraft-data')('26.2').entitiesByName.player.id)"
export const PLAYER_ENTITY_TYPE = 156

// The first entity id this module hands out. Above any id a backend's own counter reaches
// (it starts at zero and increments once per body), and below the varint's ceiling of
// 2^31 - 1.
export const FIRST_VIRTUAL_ENTITY_ID = 1_000_000_000

// At most one move frame per channel per window: one server tick, the rate a backend
// tracks a player at. See the header for what it costs.
export const MOVE_INTERVAL_MS = 50

const ANGLES_PER_TURN = 256
const DEGREES_PER_TURN = 360

const numeric = value => typeof value === 'number' && Number.isFinite(value)

// A UUID as a comparison key. The same player reaches this module from config, from a
// claim and from a decoded frame, and case and hyphens are not a difference between them.
const uuidKey = value =>
  typeof value === 'string' && value !== '' ? value.replace(/-/g, '').toLowerCase() : null

// An i8 angle: 1/256 of a turn, as a signed byte. Degrees in, the wire's unit out, and
// the client multiplies by 360/256 to get back where the caller started.
function angle8 (degrees) {
  if (!numeric(degrees)) return 0
  const raw = Math.round(degrees * ANGLES_PER_TURN / DEGREES_PER_TURN)
  const wrapped = ((raw % ANGLES_PER_TURN) + ANGLES_PER_TURN) % ANGLES_PER_TURN
  return wrapped >= ANGLES_PER_TURN / 2 ? wrapped - ANGLES_PER_TURN : wrapped
}

// A player's pose as this module reads it, or null when it cannot be placed. A player
// whose position nobody knows has nowhere to be drawn, and a spawn at the origin is a
// body in the wrong place, which is worse than no body.
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

function spawnFrame (life, pose) {
  // headPitch is the head's own yaw, so a player whose head does not turn keeps its
  // head on its shoulders.
  const yaw = angle8(pose.yaw)
  return {
    name: 'spawn_entity',
    packet: {
      entityId: life.entityId,
      objectUUID: life.uuid,
      type: PLAYER_ENTITY_TYPE,
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

function teleportFrame (entityId, pose) {
  return {
    name: 'entity_teleport',
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

function destroyFrame (entityId) {
  return { name: 'entity_destroy', packet: { entityIds: [entityId] } }
}

// The players a body's channels are told about.
//
//   world      `players()` -> [{ uuid, name, pose }]. The players that exist in the world
//              this body serves, and where each is now. Read at every sweep, so nothing
//              here is a copy that can go stale. `name` is carried for a caller's log and
//              is not written: the name a client draws comes from the entry (#614).
//   channels   `() -> [{ id, uuid }]`: one entry per connection a virtual player may be
//              written to, with the player that connection speaks for, or null when it
//              speaks for nobody. A channel is never told about its own player, which is
//              the rule that keeps the driver's client from being handed a duplicate of
//              the body it controls.
export function createVirtualPlayers ({ world, channels } = {}) {
  if (world === null || typeof world !== 'object' || typeof world.players !== 'function') {
    throw new TypeError('createVirtualPlayers needs a world whose players() answers the players it holds')
  }
  if (typeof channels !== 'function') {
    throw new TypeError('createVirtualPlayers needs channels(), the roster of connections to write to')
  }

  // channel id -> Map<uuid key, life>. One life per player per channel: the entity id it
  // was given, whether that spawn is still live, and the pose it was last told.
  const lives = new Map()
  // uuid key -> entity id. One player keeps one id for the life of the process, so a
  // re-spawn after a world change re-uses the identity the channel already knows.
  const entityIds = new Map()
  let nextEntityId = FIRST_VIRTUAL_ENTITY_ID

  function entityIdFor (key) {
    let id = entityIds.get(key)
    if (id === undefined) {
      id = nextEntityId++
      entityIds.set(key, id)
    }
    return id
  }

  function seatsOf (channelId) {
    let held = lives.get(channelId)
    if (held === undefined) {
      held = new Map()
      lives.set(channelId, held)
    }
    return held
  }

  // What every channel is owed now, in the order it is owed it. A channel with nothing
  // to say is absent, so a caller writes only what somebody needs.
  function sweep ({ at = 0 } = {}) {
    const now = numeric(at) ? at : 0
    const roster = channels()
    const players = world.players()
    const present = new Set()
    const updates = []

    for (const channel of Array.isArray(roster) ? roster : []) {
      if (channel === null || typeof channel !== 'object') continue
      const id = channel.id
      if (typeof id !== 'string' || id === '') continue
      present.add(id)
      const own = uuidKey(channel.uuid)
      const held = seatsOf(id)
      const frames = []
      const announced = new Set()

      for (const player of Array.isArray(players) ? players : []) {
        const key = uuidKey(player?.uuid)
        // A player the proxy cannot name cannot be spawned, and a channel's own player
        // is the body it controls, not somebody to draw beside it.
        if (key === null || key === own) continue
        const pose = poseOf(player)
        if (pose === null) continue
        announced.add(key)

        let life = held.get(key)
        if (life === undefined) {
          life = { uuid: player.uuid, entityId: entityIdFor(key), spawned: false, voided: false, pose: null, at: null }
          held.set(key, life)
        }
        life.uuid = player.uuid

        if (!life.spawned || life.voided) {
          if (life.spawned) frames.push(destroyFrame(life.entityId))
          frames.push(spawnFrame(life, pose))
          life.spawned = true
          life.voided = false
          life.pose = pose
          life.at = now
          continue
        }
        if (!moved(life.pose, pose)) continue
        if (life.at !== null && now - life.at < MOVE_INTERVAL_MS) continue
        frames.push(teleportFrame(life.entityId, pose))
        life.pose = pose
        life.at = now
      }

      // A player this channel was told about and no longer has: one destroy, and it is
      // the last frame of that life.
      for (const [key, life] of [...held]) {
        if (announced.has(key)) continue
        if (life.spawned) frames.push(destroyFrame(life.entityId))
        held.delete(key)
      }

      if (frames.length > 0) updates.push({ channel: id, frames })
    }

    // A channel no longer in the roster is a connection that ended. Its bookkeeping goes,
    // and it is owed no frame: a write would reach no client, and a count of it would say
    // a client was told something it was not.
    for (const id of [...lives.keys()]) if (!present.has(id)) lives.delete(id)
    return updates
  }

  // The client's entity map was voided: a play `login` or a `respawn`. Every spawn this
  // module made is now a body the client does not hold, so the next sweep destroys the id
  // it gave and spawns it again. `channel` names one connection's fresh play state; null
  // is the whole body.
  function voidSpawns ({ channel = null } = {}) {
    const targets = channel === null ? [...lives.values()] : [lives.get(channel)]
    let count = 0
    for (const held of targets) {
      if (held === undefined) continue
      for (const life of held.values()) {
        if (!life.spawned) continue
        life.voided = true
        count++
      }
    }
    return { voided: count }
  }

  // `void` is the name the caller says: the client's entity map was voided, so what this
  // module spawned is gone from the client's world.
  return { sweep, void: voidSpawns }
}

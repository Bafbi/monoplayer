// B1 monoplayer core: pure attach-stream synthesis from a state-cache snapshot.
//
// Produces the ordered clientbound attach stream a reattaching client receives:
//   1. configuration replay prefix (per-leg keep-alives/pings already stripped
//      by the cache; join-synth strips them again defensively)
//   2. the join prefix verbatim (login/game_state/chunks)
//   3. ONE synthesized position at the current pose, injected before the first
//      chunk-batch start (spike semantics); a fresh teleportId is issued
//      per attach and is owned by the proxy, never replayed from the prefix
//   4. warm-state domains in snapshot order (chunks, blocks, entities,
//      inventories, latest, generic), except that the relative-move frames
//      replay with the entity ring in capture order (`replayFrames`)
//
// Never replayed, by cache and (defensively) here: frames the clientbound
// policy marks not replayable — per-leg mechanics, live-only chat, and blocked
// connection control (transfer, cookies, dialogs, kick). A replayed transfer
// would tell a later client to leave the proxy, and a replayed chat frame
// breaks the per-connection message index.
//
// Purity: in = snapshot + pose, out = ordered frames. Buffers pass through.

import { NOT_REPLAYABLE } from './clientbound-policy.js'

export const LEG_OWNED = new Set([
  ...NOT_REPLAYABLE
])

const POSITION_PACKET_DEFAULTS = Object.freeze({
  dx: 0,
  dy: 0,
  dz: 0,
  flags: 0
})

// The sections a replay covers. `replayFrames` is the only reader, so no second
// list of this order exists to drift from it.
const REPLAY_SECTIONS = Object.freeze([
  'config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic'
])

// The `generic` frames that belong with entity state: a relative move only means
// something after the absolute it followed, so it replays in the entity ring's
// stream instead of at the end of the replay (issue #35). Every other generic
// frame keeps its place, because moving them would reorder state that does not
// interact with entity positions, such as a `close_window` after its
// `window_items`.
const ENTITY_MOVE_FRAMES = new Set(['rel_entity_move', 'entity_move_look', 'entity_look'])

// Cache entries in replay order.
//
// Every section replays where the header documents it, except that the relative
// move frames replay merged with `entities` by capture sequence. The cache
// routes an entity's absolute position frames to one ring and its deltas to
// another, so a section-ordered replay applies the deltas after the correction
// that ended them and lands the entity somewhere the backend never put it.
// Entries carry the sequence, so the merge needs no new field.
//
// One function for the replay and for the parity expectation: two orders would
// drift, and the parity check would then compare against a replay nobody sends.
export function replayFrames (snapshot, { includeConfig = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot is required')
  if (typeof includeConfig !== 'boolean') throw new TypeError('includeConfig must be a boolean')

  const entityFrames = snapshot.entities ?? []
  const generic = snapshot.generic ?? []
  const entityMoves = generic.filter(frame => ENTITY_MOVE_FRAMES.has(frame?.name))
  const restOfGeneric = generic.filter(frame => !ENTITY_MOVE_FRAMES.has(frame?.name))

  const frames = []
  for (const section of REPLAY_SECTIONS) {
    if (section === 'config') {
      if (includeConfig) frames.push(...(snapshot.config ?? []))
      continue
    }
    if (section === 'entities') {
      frames.push(...mergeByCapture(entityFrames, entityMoves))
      continue
    }
    if (section === 'generic') {
      frames.push(...restOfGeneric)
      continue
    }
    frames.push(...(snapshot[section] ?? []))
  }
  return frames
}

// Two lists, each already in capture order, merged into one. A frame without a
// sequence sorts last, so a hand-built snapshot stays deterministic and keeps
// its documented order.
function mergeByCapture (entityFrames, entityMoves) {
  const merged = []
  let e = 0
  let m = 0
  while (e < entityFrames.length || m < entityMoves.length) {
    const nextEntity = entityFrames[e]
    const nextMove = entityMoves[m]
    if (nextMove === undefined || (nextEntity !== undefined && captureSeq(nextEntity) <= captureSeq(nextMove))) {
      merged.push(nextEntity)
      e++
    } else {
      merged.push(nextMove)
      m++
    }
  }
  return merged
}

function captureSeq (frame) {
  return Number.isFinite(frame?.seq) ? frame.seq : Number.POSITIVE_INFINITY
}

export function synthAttach ({
  snapshot,
  pose,
  teleportId = 0,
  positionName = 'position',
  includeConfig = true
} = {}) {
  if (!snapshot) throw new TypeError('snapshot is required')
  if (!pose || typeof pose !== 'object') throw new TypeError('pose is required')
  if (typeof includeConfig !== 'boolean') throw new TypeError('includeConfig must be a boolean')

  const frames = []
  const counts = { replayed: 0, skipped: 0, synthesized: 0 }
  let nextTeleportId = teleportId
  let positionInjected = false
  let sawBatchStart = false

  function injectPositionIfNeeded () {
    if (positionInjected) return
    positionInjected = true
    counts.synthesized++
    frames.push({
      synth: 'position',
      name: positionName,
      packet: {
        teleportId: ++nextTeleportId,
        x: pose.x,
        y: pose.y,
        z: pose.z,
        yaw: pose.yaw ?? 0,
        pitch: pose.pitch ?? 0,
        ...POSITION_PACKET_DEFAULTS
      }
    })
  }

  // When omitConfiguration is set the configuration replay prefix is left
  // out entirely: the live front leg already replays the cached configuration
  // frames during its own configuration phase, so the play-state attach must
  // not replay them a second time. Default keeps B1 fake-test behavior.
  for (const frame of replayFrames(snapshot, { includeConfig })) {
    if (LEG_OWNED.has(frame.name)) {
      counts.skipped++ // belt-and-suspenders: the cache should have dropped it
      continue
    }
    if (!positionInjected && (frame.name === 'chunk_batch_start' || frame.name === 'map_chunk')) {
      injectPositionIfNeeded()
      sawBatchStart = sawBatchStart || frame.name === 'chunk_batch_start'
    }
    frames.push({ name: frame.name, buffer: frame.buffer })
    counts.replayed++
  }

  if (!positionInjected) {
    // No chunk-bearing frame in the snapshot: still land the client on the
    // current pose, at the end of the replay.
    injectPositionIfNeeded()
  }

  return { frames, teleportId: nextTeleportId, counts, sawBatchStart }
}

// Live (attached) handling of a backend position frame: the attaching client
// gets a renewed position packet with the proxy's own teleportId, and the
// session pose follows the backend's teleport.
export function synthBackendPosition ({ backendPacket, pose, teleportId }) {
  return {
    pose: {
      x: backendPacket.x,
      y: backendPacket.y,
      z: backendPacket.z,
      yaw: backendPacket.yaw,
      pitch: backendPacket.pitch
    },
    frame: {
      synth: 'position',
      name: 'position',
      packet: {
        teleportId: teleportId + 1, // caller's monotonic counter
        x: backendPacket.x,
        y: backendPacket.y,
        z: backendPacket.z,
        yaw: backendPacket.yaw,
        pitch: backendPacket.pitch,
        ...POSITION_PACKET_DEFAULTS
      }
    }
  }
}

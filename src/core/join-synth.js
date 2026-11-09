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
//      inventories, latest, generic)
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
  const sections = [
    ...(includeConfig ? [snapshot.config] : []),
    snapshot.prefix,
    snapshot.chunks,
    snapshot.blocks,
    snapshot.entities,
    snapshot.inventories,
    snapshot.latest,
    snapshot.generic
  ]

  for (const section of sections) {
    for (const frame of section) {
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

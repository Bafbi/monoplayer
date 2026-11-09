// B1 monoplayer core: pure relay decisions (serverbound drop rules, pose
// capture).
//
// Three outcomes for a serverbound play frame:
//   drop     never reaches the backend
//   rewrite  reaches the backend only in the form the proxy builds
//   forward  reaches the backend as the client sent it
//
// Frames that must never reach the backend untouched: per-leg connection
// mechanics (keep-alive, teleport confirm, chunk batch acks, configuration ack,
// cookie responses), fresh-client-only answers (resource pack, ping/pong — a
// replayed ping must not be answered with the fresh client's pong), and chat.
// Chat is relayed read-only: the attached client sees clientbound chat, but its
// own messages, commands, session key, and acknowledgements stay on the front
// leg.
//
// Client information (`settings`) is rewritten, not forwarded: the human's
// locale, skin parts, main hand, and chat settings must reach the server, but
// their render distance must not lower the server's chunk send below the
// backend cap (#18).

export const SERVERBOUND_DROPS = new Set([
  'teleport_confirm', // proxy owns teleport IDs per leg
  'keep_alive', // the front leg answers its own keep-alives
  'chat_message', // read-only chat: never forwarded
  'chat_command',
  'chat_command_signed',
  'chat_session_update',
  'chat_ack',
  'message_acknowledgement', // the client acks its own chat stream, not the puppet's
  'configuration_acknowledged',
  'chunk_batch_received', // legs ack their own batch ends
  'cookie_response', // replayed cookie answers are the proxy's
  'resource_pack_receive', // no required resource pack in MVP
  'pong' // never answer a replayed ping with the fresh client's pong
])

// Rewritten by the proxy before they reach the backend. `settings` is the
// 26.x Client Information packet: the human's fields pass through, the view
// distance is replaced with the backend's advertised cap.
export const SERVERBOUND_REWRITE = new Set([
  'settings'
])

// Plugin-message channels that carry a client's own identity. The proxy
// announces the puppet's brand itself, so a brand from the human's connection
// must never reach the backend: it would name the client the human actually
// runs. Other plugin channels are ordinary mod traffic and stay forwarded.
export const CLIENT_IDENTITY_CHANNELS = new Set([
  'minecraft:brand'
])

export const CHAT_SERVERBOUND = new Set([
  'chat_message',
  'chat_command',
  'chat_command_signed',
  'chat_session_update',
  'chat_ack'
])

export function classifyServerbound (name, data = null) {
  if (name === 'custom_payload' && CLIENT_IDENTITY_CHANNELS.has(data?.channel)) {
    return { action: 'drop', chat: false, reason: 'client_identity_channel' }
  }
  if (SERVERBOUND_DROPS.has(name)) {
    return { action: 'drop', chat: CHAT_SERVERBOUND.has(name), reason: 'per_leg_or_blocked' }
  }
  if (SERVERBOUND_REWRITE.has(name)) {
    return { action: 'rewrite', chat: false, reason: 'client_identity' }
  }
  return { action: 'forward', chat: false, reason: 'state_or_input' }
}

const numeric = v => typeof v === 'number' && Number.isFinite(v)

// Relay pose: the puppet's authoritative pose comes from backend teleports,
// but attaching-client movement must update it too, so a reattach lands
// where the player actually left the puppet (spike invariant).

// Pure pose update. backend = true for a backend position frame (authoritative
// teleport); false for a serverbound client movement frame.
export function capturePose (pose, name, data, { backend = false } = {}) {
  if (!data) return pose
  if (backend) {
    // Backend position frames carry the whole packet; only a full teleport
    // set is honored.
    if (!numeric(data.x) || !numeric(data.y) || !numeric(data.z)) return pose
    return {
      ...pose,
      x: data.x,
      y: data.y,
      z: data.z,
      yaw: numeric(data.yaw) ? data.yaw : pose.yaw,
      pitch: numeric(data.pitch) ? data.pitch : pose.pitch
    }
  }
  // Clientbound movement: position/position_look/look.
  let next = pose
  if (name === 'position' || name === 'position_look') {
    if (!numeric(data.x) || !numeric(data.y) || !numeric(data.z)) return pose
    next = { ...next, x: data.x, y: data.y, z: data.z }
  }
  if (name === 'look' || name === 'position_look') {
    next = {
      ...next,
      yaw: numeric(data.yaw) ? data.yaw : next.yaw,
      pitch: numeric(data.pitch) ? data.pitch : next.pitch
    }
  }
  return next
}

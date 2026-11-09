// B1 monoplayer core: pure relay decisions (serverbound drop rules, pose
// capture).
//
// Four outcomes for a serverbound play frame:
//   drop     never reaches the backend
//   rewrite  reaches the backend only in the form the proxy builds
//   speak    the proxy sends the text on the backend leg as the puppet
//   forward  reaches the backend as the client sent it
//
// Frames that must never reach the backend untouched: per-leg connection
// mechanics (keep-alive, teleport confirm, chunk batch acks, configuration ack,
// cookie responses), fresh-client-only answers (resource pack, ping/pong — a
// replayed ping must not be answered with the fresh client's pong), and the
// chat frames that carry the human's own signature state.
//
// Chat text is spoken, not forwarded (#19). A `chat_message` or
// `chat_command` from the human carries a signature made with the human's
// profile key and an offset into the human's own last-seen window, so the
// backend would reject it. The proxy takes the text and lets the backend leg
// sign and send it as the puppet instead. The human's session key, its
// acknowledgements, and its last-seen window stay on the front leg in every
// mode. `read-only` drops the text too, and `off` drops clientbound chat as
// well.
//
// Client information (`settings`) is rewritten, not forwarded: the human's
// locale, skin parts, main hand, and chat settings must reach the server, but
// their render distance must not lower the server's chunk send below the
// backend cap (#18).

// Configuration-phase frames the front client's own connection answers. They
// are handshake, not the puppet's: a second `finish_configuration` reaches a
// backend leg the library already moved to play, `select_known_packs` was
// negotiated on a different connection, and the human's `settings` reaches the
// backend through the client-information path, which writes the puppet's own
// packet (#16, #18).
//
// Everything else in configuration state forwards: the human's dialog answers
// (`custom_click_action`, `accept_code_of_conduct`) are the frames this state
// exists to carry.
export const CONFIG_SERVERBOUND_DROPS = new Set([
  'finish_configuration',
  'select_known_packs',
  'settings'
])

export const SERVERBOUND_DROPS = new Set([
  'teleport_confirm', // proxy owns teleport IDs per leg
  'keep_alive', // the front leg answers its own keep-alives
  'chat_message', // never forwarded: spoken as the puppet, or dropped
  'chat_command',
  'chat_command_signed',
  'chat_session_update', // the human's session key is not the puppet's
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

// Chat frames whose text the proxy may speak as the puppet. Their signature
// state never crosses; only the text does, and only when a human is attached.
export const CHAT_SPEAK = new Set([
  'chat_message',
  'chat_command',
  'chat_command_signed'
])

// The text a chat frame carries, in the form the backend leg sends it: a plain
// message, or a command with its leading slash. Null when the frame carries no
// usable text.
export function chatText (name, data = null) {
  const field = name === 'chat_message' ? 'message' : 'command'
  if (name !== 'chat_message' && !CHAT_SPEAK.has(name)) return null
  const raw = data?.[field]
  if (typeof raw !== 'string') return null
  const text = name === 'chat_message' ? raw : `/${raw.replace(/^\/+/, '')}`
  if (text.length === 0 || text === '/') return null
  return { text, command: name !== 'chat_message' }
}

// `mode` is the configured chat mode, and it defaults to the mode the config
// defaults to. `full` speaks the human's chat as the puppet; `read-only` and
// `off` drop it. `state` is the phase the client sent the frame in, so a
// configuration answer is not mistaken for a play frame (#16).
export function classifyServerbound (name, data = null, { mode = 'read-only', state = 'play' } = {}) {
  if (state === 'configuration' && CONFIG_SERVERBOUND_DROPS.has(name)) {
    return { action: 'drop', chat: false, reason: 'front_owned_config_handshake' }
  }
  if (name === 'custom_payload' && CLIENT_IDENTITY_CHANNELS.has(data?.channel)) {
    return { action: 'drop', chat: false, reason: 'client_identity_channel' }
  }
  if (mode === 'full' && CHAT_SPEAK.has(name)) {
    return { action: 'speak', chat: true, reason: 'human_chat' }
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

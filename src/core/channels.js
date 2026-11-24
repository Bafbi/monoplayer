// #269: the channel. One attaching player's delivery of one body.
//
// Until now the front leg held one `attached` client, and that pointer decided
// everything: who was admitted, which socket a clientbound frame was written to,
// and whose client information the puppet sent. A body is watched by more than
// one connection — its driver and any spectators — so one pointer cannot say
// which of them has been handed what, and two clients on one body were
// indistinguishable to every caller.
//
// A channel is that per-connection record (GLOSSARY.md):
//   - its role, driver or spectator, which the claim decides and this registry
//     records;
//   - what it has been sent, as a count per protocol state and the last frame, so
//     a late arrival and a driver are never confused for one;
//   - its own client information, so one client's settings cannot overwrite
//     another's.
//
// One body carries one driver, and any number of spectators. The exclusivity is
// the claim's (src/core/claims.js): a second claim on a body is refused there,
// with the name of the player who holds it. This module refuses a second driver
// as a programming error rather than as a second authority, because a body with
// two drivers would be one body delivered two ways.
//
// Purity: no sockets, no timers, no I/O, no clock. The caller passes the moment it
// opened a channel and the frames it delivered, and reads copies back so a reader
// cannot write into the record the leg holds.
export const CHANNEL_ROLES = Object.freeze({
  DRIVER: 'driver',
  SPECTATOR: 'spectator'
})

const ROLES = new Set(Object.values(CHANNEL_ROLES))
const STATES = new Set(['configuration', 'play'])

// Why a channel was not opened. `driver_held` is the programming error above;
// `in_use` is one connection trying to hold two channels.
export const CHANNEL_REFUSAL = Object.freeze({
  DRIVER_HELD: 'driver_held',
  IN_USE: 'in_use'
})

function requiredString (value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(field + ' must be a non-empty string')
  }
  return value
}

// A channel as a caller sees it: its own field map, so a reader cannot write into
// the record the registry holds.
function channelView (record) {
  return {
    id: record.id,
    body: record.body,
    role: record.role,
    name: record.name,
    at: record.at,
    delivered: { ...record.delivered, last: record.delivered.last === null ? null : { ...record.delivered.last } },
    settings: record.settings === null ? null : { ...record.settings },
    settingsAt: record.settingsAt
  }
}

export function createChannels () {
  const byId = new Map() // channel id -> channel
  const byBody = new Map() // body -> Map<id, channel>, in the order they opened

  function open ({ id, body = null, role = CHANNEL_ROLES.SPECTATOR, name = null, at = null } = {}) {
    requiredString(id, 'id')
    if (!ROLES.has(role)) {
      throw new TypeError('role must be one of ' + [...ROLES].join(', ') + ', got ' + JSON.stringify(role))
    }
    if (body !== null && (typeof body !== 'string' || body.length === 0)) {
      throw new TypeError('body must be null or a non-empty string')
    }
    const held = byId.get(id)
    if (held !== undefined) {
      return { ok: false, reason: CHANNEL_REFUSAL.IN_USE, channel: channelView(held) }
    }
    const onBody = channelsOn(body)
    if (role === CHANNEL_ROLES.DRIVER) {
      const driver = driverOf(body)
      if (driver !== null) {
        return { ok: false, reason: CHANNEL_REFUSAL.DRIVER_HELD, channel: driver }
      }
    }
    const record = {
      id,
      body,
      role,
      name,
      at,
      delivered: { frames: 0, play: 0, configuration: 0, last: null, replays: 0 },
      settings: null,
      settingsAt: null
    }
    byId.set(id, record)
    onBody.set(id, record)
    return { ok: true, reason: null, channel: channelView(record) }
  }

  // The map one body's channels live in, created on first use. A null body is the
  // lane's own: a connection the lane admits without a claim was opened there
  // because no claim named a server.
  function channelsOn (body) {
    const key = body === null ? '' : body
    let onBody = byBody.get(key)
    if (onBody === undefined) {
      onBody = new Map()
      byBody.set(key, onBody)
    }
    return onBody
  }

  // A connection ended, or its body did. The body keeps whatever is left: closing
  // the driver leaves its spectators watching, and closing the last channel leaves
  // nothing.
  function close (id) {
    if (typeof id !== 'string') return null
    const record = byId.get(id)
    if (record === undefined) return null
    byId.delete(id)
    const onBody = channelsOn(record.body)
    onBody.delete(id)
    if (onBody.size === 0) byBody.delete(record.body === null ? '' : record.body)
    return channelView(record)
  }

  // One frame reached this channel. The count is per channel, which is what keeps
  // a spectator that arrived mid-stream apart from the driver that has been
  // following the body since it landed.
  function noteDelivery ({ id, state = 'play', name = null } = {}) {
    if (!STATES.has(state)) {
      throw new TypeError('state must be one of ' + [...STATES].join(', ') + ', got ' + JSON.stringify(state))
    }
    const record = byId.get(id)
    if (record === undefined) return null
    record.delivered.frames++
    record.delivered[state]++
    record.delivered.last = { state, name: typeof name === 'string' ? name : null }
    return channelView(record)
  }

  // The channel was handed its body's replay. A channel holds one at most: a
  // replay is the one moment a client is told what its body holds.
  function markReplay (id) {
    const record = byId.get(id)
    if (record === undefined) return null
    record.delivered.replays++
    return channelView(record)
  }

  // This channel's own client information, as the client reported it. Recorded and
  // copied, never merged into another channel's: two clients on one body have two
  // sets of settings, and #296 decides what a claim does with them.
  function settings (id, data = {}, { at = null } = {}) {
    const record = byId.get(id)
    if (record === undefined) return null
    record.settings = data === null || typeof data !== 'object' ? null : { ...data }
    record.settingsAt = at
    return channelView(record)
  }

  function of (id) {
    const record = byId.get(id)
    return record === undefined ? null : channelView(record)
  }

  // The one driver this process delivers through. A leg serves one body at a time,
  // so its driver's channel is what names that body; a body with no driver is a body
  // nobody is delivered (#261 gives each body its own leg).
  function driverChannel () {
    for (const record of byId.values()) {
      if (record.role === CHANNEL_ROLES.DRIVER) return channelView(record)
    }
    return null
  }

  function driverOf (body) {
    for (const record of channelsOn(body).values()) {
      if (record.role === CHANNEL_ROLES.DRIVER) return channelView(record)
    }
    return null
  }

  // Every channel on one body, the driver first. A caller that delivers a frame
  // reads this and writes to each socket, so the body's stream reaches every
  // client that is watching it and no client watching another.
  function on (body) {
    const records = [...channelsOn(body).values()]
    const driver = records.filter(record => record.role === CHANNEL_ROLES.DRIVER)
    const spectators = records.filter(record => record.role === CHANNEL_ROLES.SPECTATOR)
    return [...driver, ...spectators].map(channelView)
  }

  return {
    open,
    close,
    noteDelivery,
    markReplay,
    settings,
    of,
    driverOf,
    driverChannel,
    on,
    holds: id => byId.has(id),
    snapshot: () => [...byId.values()].map(channelView),
    get size () { return byId.size }
  }
}

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
//   - what it has been sent, as a count per protocol state, the bytes those frames
//     took, and the last frame, so a late arrival and a driver are never confused
//     for one, and a cap has a size to be decided from (#417);
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

// #416: the identity a record carries. One record says three things at once: the
// account the lane speaks for, the body the record is about, and the channel it was
// written on. The three are named once, here, so a caller never repeats them and no
// two records can disagree about what a `body` field means.
//
// A key is written only where the thing it names exists (#263 D2): a record written
// before a pick carries the account and no `body` key, because a `body: null`
// would make "every record with a body" a query that also returns the records
// without one.
//
// Journal and log records carry all three. No OTLP metric carries the channel: a
// body is bounded by the allowed-server list, and a channel is one connection, so a
// channel attribute is one series per socket (#415, #263 D1). The gauge side of
// that rule is test/service/heartbeat-groups.test.js.
export const RECORD_IDENTITY_FIELDS = Object.freeze(['account', 'body', 'channel'])

const namesSomething = value => typeof value === 'string' && value.length > 0

// The identity three as they are written: present keys only.
export function recordIdentity ({ account = null, body = null, channel = null } = {}) {
  const identity = {}
  if (namesSomething(account)) identity.account = account
  if (namesSomething(body)) identity.body = body
  if (namesSomething(channel)) identity.channel = channel
  return identity
}

// One record's field map with the identity filled in. A field the caller names
// itself wins, because a record about another body knows better than the context
// does. That covers a claim's body and a pick the lane refused. A null or empty
// identity key is removed from the caller's fields rather than written.
export function stampIdentity (fields = {}, identity = {}) {
  const stamped = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (RECORD_IDENTITY_FIELDS.includes(key) && !namesSomething(value)) continue
    stamped[key] = value
  }
  return { ...recordIdentity(identity), ...stamped }
}

// The lane's account, as one identifier: the alias the custody tree resolved, else
// its UUID, else the name an offline lane joins as. Null when the lane holds no
// account at all, which is the one record shape that names none.
export function accountIdentifier ({ alias = null, uuid = null, name = null } = {}) {
  for (const candidate of [alias, uuid, name]) {
    if (namesSomething(candidate)) return candidate
  }
  return null
}

// One channel's identity: what a record about it says. A channel the lane admitted
// with no claim names no body, so it writes none. The account is the lane's and not
// the channel's, so it is stamped where the line is written, not here.
export function channelIdentity (channel) {
  if (channel === null || typeof channel !== 'object') return {}
  return recordIdentity({ body: channel.body, channel: channel.id })
}

// The key one body's channels live under. A connection the lane admitted with no
// claim names no body, and the empty body is what it is filed under. Two callers
// read this: the registry below, and #415's heartbeat, which groups the same way so
// a body's rows and its audience cannot disagree about where a channel belongs.
export function bodyKey (body) {
  return body === null || body === undefined ? '' : body
}

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
      delivered: { frames: 0, play: 0, configuration: 0, bytes: 0, last: null, replays: 0 },
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
    const key = bodyKey(body)
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
    if (onBody.size === 0) byBody.delete(bodyKey(record.body))
    return channelView(record)
  }

  // One frame reached this channel. The count is per channel, which is what keeps
  // a spectator that arrived mid-stream apart from the driver that has been
  // following the body since it landed.
  //
  // #417: `bytes` is the frame's length, passed by the caller that holds the buffer.
  // A caller that holds a packet object rather than a buffer has no length to pass,
  // and passes none: the count then holds what was measured, rather than inventing a
  // size for a frame whose length nobody has. A length that is not a byte count is a
  // caller's mistake and is refused, because a negative or fractional one makes the
  // sum lie quietly.
  function noteDelivery ({ id, state = 'play', name = null, bytes = null } = {}) {
    if (!STATES.has(state)) {
      throw new TypeError('state must be one of ' + [...STATES].join(', ') + ', got ' + JSON.stringify(state))
    }
    if (bytes !== null && bytes !== undefined && !(Number.isInteger(bytes) && bytes >= 0)) {
      throw new TypeError('bytes must be a non-negative integer when given, got ' + JSON.stringify(bytes))
    }
    const record = byId.get(id)
    if (record === undefined) return null
    record.delivered.frames++
    record.delivered[state]++
    record.delivered.bytes += bytes ?? 0
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

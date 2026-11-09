// #17/#18: the puppet's own client identity on the backend leg.
//
// Two frames the *server* reads make the puppet look like a normal Fabric
// client, and both belong to the proxy, never to the human's client:
//
//   custom_payload  channel minecraft:brand, payload "fabric" (Fabric Loader).
//                   Announced in the configuration phase, once per backend
//                   connection.
//   settings        the Client Information packet (the 26.x wire name). It
//                   carries the backend's advertised view distance as the
//                   requested view distance, plus the human's locale, skin
//                   parts, main hand, and chat settings while a human is
//                   attached.
//
// Everything here is pure: encode, decode, validate, merge. The core decides
// when to write; the legs decide how the bytes leave.
//
// Why the view distance is the backend's: the server caps how far it sends
// chunks, and a client that asks for less makes the server send less. A
// vanilla client asks for its own render distance; the puppet asks for the
// cap, so the human's local render distance never shrinks the world the
// proxy's cache holds.

export const BRAND_CHANNEL = 'minecraft:brand'

// Fabric Loader's ClientBrandRetriever value. A vanilla client sends "vanilla";
// the proxy must never send that, or the server sees a game that is not the
// one the human plays.
export const FABRIC_BRAND = 'fabric'

// The Client Information values the protocol library sends for a client with
// no override (minecraft-protocol's `clientSettings` defaults), which are the
// vanilla-safe values. Any field the human's client reports replaces the
// default; the view distance is always replaced with the backend cap.
export const DEFAULT_CLIENT_SETTINGS = Object.freeze({
  locale: 'en_us',
  viewDistance: 10,
  chatFlags: 0,
  chatColors: true,
  skinParts: 127,
  mainHand: 1,
  enableTextFiltering: false,
  enableServerListing: true,
  particleStatus: 'all'
})

const PARTICLE_STATUS = new Set(['all', 'decreased', 'minimal'])
const SETTINGS_FIELDS = Object.keys(DEFAULT_CLIENT_SETTINGS)

const isIntBetween = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max

// VarInt: 7 bits per byte, low group first, high bit means "more follows".
// The brand payload is the vanilla `string` type, which is exactly this length
// prefix followed by UTF-8 bytes.
export function encodeVarInt (value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError('encodeVarInt expects a non-negative integer')
  const out = []
  let n = value
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

export function decodeVarInt (buffer, offset = 0) {
  let value = 0
  let shift = 0
  let index = offset
  while (index < buffer.length) {
    const byte = buffer[index++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, bytes: index - offset }
    shift += 7
    if (shift > 35) return null
  }
  return null
}

// The brand is a string payload inside the custom_payload's restBuffer.
export function encodeBrand (brand = FABRIC_BRAND) {
  if (typeof brand !== 'string' || brand.length === 0) throw new TypeError('brand must be a non-empty string')
  const body = Buffer.from(brand, 'utf8')
  return Buffer.concat([encodeVarInt(body.length), body])
}

// Reads a brand payload back. Used by the observer, the tests, and the
// loopback rung; returns null for anything that is not a string payload.
export function decodeBrand (data) {
  if (!Buffer.isBuffer(data) || data.length === 0) return null
  const length = decodeVarInt(data, 0)
  if (!length || length.value !== data.length - length.bytes) return null
  return data.subarray(length.bytes).toString('utf8')
}

export function brandFrame (brand = FABRIC_BRAND) {
  return {
    name: 'custom_payload',
    packet: { channel: BRAND_CHANNEL, data: encodeBrand(brand) }
  }
}

// The backend advertises its view distance (a varint, the server's cap) in the
// play login packet. Anything that is not a positive integer is "no cap", and
// the puppet then leaves the library's configuration-phase value alone.
export function capFromLogin (data) {
  if (!data || typeof data !== 'object') return null
  return isIntBetween(data.viewDistance, 1, 127) ? data.viewDistance : null
}

// How many chunk frames the cache must hold for a view distance: the square
// the server sends, plus one ring. The spare ring covers the overlap while a
// moving player's new chunks arrive before the old ones are unloaded.
export function chunkBoundFor (viewDistance) {
  if (!isIntBetween(viewDistance, 0, 127)) return null
  return (2 * viewDistance + 3) ** 2
}

// Keep only the fields a client may report, with the vanilla type and range of
// each. Returns null when the frame carries nothing usable, so the caller can
// ignore it instead of writing a half-guessed packet.
export function normalizeClientSettings (data) {
  if (!data || typeof data !== 'object') return null
  const out = { ...DEFAULT_CLIENT_SETTINGS }
  let usable = 0

  if (typeof data.locale === 'string' && data.locale.length > 0 && data.locale.length <= 16) {
    out.locale = data.locale
    usable++
  }
  if (isIntBetween(data.viewDistance, 0, 127)) {
    out.viewDistance = data.viewDistance
    usable++
  }
  if (isIntBetween(data.chatFlags, 0, 255)) {
    out.chatFlags = data.chatFlags
    usable++
  }
  if (typeof data.chatColors === 'boolean') {
    out.chatColors = data.chatColors
    usable++
  }
  if (isIntBetween(data.skinParts, 0, 255)) {
    out.skinParts = data.skinParts
    usable++
  }
  if (isIntBetween(data.mainHand, 0, 1)) {
    out.mainHand = data.mainHand
    usable++
  }
  if (typeof data.enableTextFiltering === 'boolean') {
    out.enableTextFiltering = data.enableTextFiltering
    usable++
  }
  if (typeof data.enableServerListing === 'boolean') {
    out.enableServerListing = data.enableServerListing
    usable++
  }
  if (typeof data.particleStatus === 'string' && PARTICLE_STATUS.has(data.particleStatus)) {
    out.particleStatus = data.particleStatus
    usable++
  }

  return usable === 0 ? null : out
}

// The packet the puppet writes: the human's client information with the
// backend's view distance. A human value for any other field is authoritative;
// the human's own view distance is not, because it is a local render setting
// and the server's chunk send must stay at the cap.
export function mergeClientSettings (human, viewDistance) {
  const merged = { ...DEFAULT_CLIENT_SETTINGS }
  if (human && typeof human === 'object') {
    for (const field of SETTINGS_FIELDS) {
      if (human[field] !== undefined && human[field] !== null) merged[field] = human[field]
    }
  }
  if (isIntBetween(viewDistance, 1, 127)) merged.viewDistance = viewDistance
  return merged
}

// Strict client-facing wire-frame checker for the B1 failure class.
//
// protodef's FullPacketParser accepts a frame with trailing bytes: it logs a
// size mismatch and still emits the packet. Vanilla rejects such a frame. This
// checker parses exactly one clientbound frame in a supported state and fails
// when the parse does not consume every byte.
//
// `buffer` is a minecraft-protocol `raw` frame (packet id + body). The checker
// never logs and never returns the frame bytes.
import mc from 'minecraft-protocol'

export const WIRE_CODES = Object.freeze({
  OK: 'ok',
  NOT_BUFFER: 'not_buffer',
  TOO_LARGE: 'too_large',
  UNSUPPORTED_STATE: 'unsupported_state',
  PARSE_ERROR: 'parse_error',
  LEFTOVER_BYTES: 'leftover_bytes',
  NAME_MISMATCH: 'name_mismatch'
})

const SUPPORTED_STATES = new Set(['configuration', 'play'])

// One deserializer per state (and version, so two checkers built with
// different versions cannot collide) for the process lifetime. parsePacketBuffer
// does not mutate the parser, so the cache is safe to share across calls.
const DESERIALIZERS = new Map()

function deserializerFor (version, state) {
  const key = `${version}\u0000${state}`
  let deserializer = DESERIALIZERS.get(key)
  if (deserializer === undefined) {
    deserializer = mc.createDeserializer({ state, isServer: false, version, noErrorLogging: true })
    DESERIALIZERS.set(key, deserializer)
  }
  return deserializer
}

export function createWireChecker ({ version = '26.1', maxFrameBytes = 2 * 1024 * 1024 } = {}) {
  const stats = {
    checked: 0,
    failures: 0,
    tooLarge: 0,
    unsupportedState: 0,
    leftover: 0,
    nameMismatch: 0,
    parseErrors: 0
  }

  function fail (result, code) {
    result.ok = false
    result.code = code
    stats.failures++
    return result
  }

  function check ({ state, name, buffer } = {}) {
    stats.checked++
    const result = { ok: false, code: WIRE_CODES.OK, state, name }
    if (Buffer.isBuffer(buffer)) result.total = buffer.length

    if (!SUPPORTED_STATES.has(state)) {
      stats.unsupportedState++
      return fail(result, WIRE_CODES.UNSUPPORTED_STATE)
    }
    if (!Buffer.isBuffer(buffer)) {
      return fail(result, WIRE_CODES.NOT_BUFFER)
    }
    if (buffer.length > maxFrameBytes) {
      stats.tooLarge++
      return fail(result, WIRE_CODES.TOO_LARGE)
    }

    let packet
    try {
      packet = deserializerFor(version, state).parsePacketBuffer(buffer)
    } catch (err) {
      stats.parseErrors++
      result.error = String(err && err.message ? err.message : err).slice(0, 200)
      return fail(result, WIRE_CODES.PARSE_ERROR)
    }

    const consumed = packet.metadata.size
    const total = buffer.length
    const leftover = total - consumed
    result.parsedName = packet.data.name
    result.consumed = consumed
    result.total = total
    result.leftover = leftover

    // Trailing bytes are the more specific failure: report them before a name
    // mismatch, because a replayed frame often parses as the wrong packet.
    if (leftover !== 0) {
      stats.leftover++
      return fail(result, WIRE_CODES.LEFTOVER_BYTES)
    }
    if (packet.data.name !== name) {
      stats.nameMismatch++
      return fail(result, WIRE_CODES.NAME_MISMATCH)
    }

    result.ok = true
    return result
  }

  return { check, stats }
}

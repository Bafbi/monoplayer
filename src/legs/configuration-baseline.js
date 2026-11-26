// The configuration baseline: a real server's configuration phase, recorded as a
// fixture, and the frames the front serves when no backend is connected (#257).
//
// Why a recording and not a construction. minecraft-protocol writes registry
// frames only from `options.registryCodec`, and the registry it can write is the
// codec vendored in minecraft-data: a copy of the 1.20.5 login codec with no
// registry tags, and for 26.2 one registry short of what a server sends. A 26.2
// client fails registry loading on that set and crashes, which the front leg
// already recorded (see the comment on `allowLibraryFallback`). The one other
// registry in the system is a replay of a real Paper's. This module is that
// replay, committed, so a lane with no backend still has a configuration phase
// to give a joining client.
//
// What the fixture is: every clientbound configuration frame one join received
// from the gate lane's Paper 26.2 build 135, in order, as the bytes that
// connection carried. src/ladder/capture-config.js records it, and its header
// holds the command to refresh it. Two captures of the same server are
// byte-identical, so the file is evidence and not a snapshot of a mood.
//
// What the module does not do: decode a frame, reorder one, add one, or edit one.
// A frame the server did not send is exactly the failure this file exists to
// avoid. The one frame a phase leaves out is the registry set a picker may not
// carry (#598), and `baselineFramesFor` leaves it out by not putting it in the list
// a join is served from.
import fs from 'node:fs'

import { clientboundPolicy } from '../core/clientbound-policy.js'
import { decodeVarInt } from '../core/client-settings.js'

// The frame that ends the phase. The baseline carries the server's, and the
// front never serves it: the picker keeps the client in configuration on
// purpose (#257), and the phase ends at the pick or the refusal.
export const BASELINE_FINISH_FRAME = 'finish_configuration'

// The frames the ticket names, and the reason each one is required of a capture.
// A capture missing one is a bad capture and not a smaller baseline: the recording
// is evidence of what one server sent, and half of a phase is not evidence of
// anything. What a phase then serves is a different question, answered by
// `baselineFramesFor`: a picker serves the recording without its registry set
// (#598), and whether a client accepts known packs and tags with no registry to
// resolve them against is unmeasured here (#603).
export const BASELINE_REQUIRED_FRAMES = Object.freeze([
  'select_known_packs',
  'feature_flags',
  'registry_data',
  'tags'
])

const CONFIGURATION = 'configuration'

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Parse and validate a capture document. Throws on anything a replay could not
// serve as-is, because a baseline that half-works is a crashed client with a
// confusing log line.
export function parseConfigurationBaseline (document) {
  if (!isPlainObject(document)) throw new TypeError('configuration baseline must be an object')
  const { version, protocolVersion, capturedFrom, frames } = document
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('configuration baseline needs a version string')
  }
  if (!Number.isInteger(protocolVersion) || protocolVersion <= 0) {
    throw new TypeError('configuration baseline needs an integer protocolVersion')
  }
  if (!isPlainObject(capturedFrom)) throw new TypeError('configuration baseline needs capturedFrom')
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new TypeError('configuration baseline needs a non-empty frames array')
  }

  const parsed = frames.map((frame, index) => {
    if (!isPlainObject(frame)) throw new TypeError('baseline frame ' + index + ' is not an object')
    if (frame.state !== CONFIGURATION) {
      throw new TypeError('baseline frame ' + index + ' is not a configuration frame: ' + JSON.stringify(frame.state))
    }
    if (typeof frame.name !== 'string' || frame.name.length === 0) {
      throw new TypeError('baseline frame ' + index + ' has no name')
    }
    // The policy table is the tree's one answer to "may this frame cross to a
    // front client". A name it does not know is a protocol bump nobody taught
    // this table, and replaying it blind is how a client gets a frame it parses
    // as something else. An unknown name also fails the replay path, so the
    // baseline refuses to hold one.
    const policy = clientboundPolicy(CONFIGURATION, frame.name)
    if (policy.unknown) {
      throw new TypeError('baseline frame ' + index + ' is not in the clientbound policy table: ' + frame.name)
    }
    if (!policy.replay && frame.name !== BASELINE_FINISH_FRAME) {
      throw new TypeError('baseline frame ' + index + ' is not replayable: ' + frame.name + ' (' + policy.decision + ')')
    }
    if (typeof frame.bytes !== 'string' || frame.bytes.length === 0) {
      throw new TypeError('baseline frame ' + index + ' (' + frame.name + ') has no bytes')
    }
    const buffer = Buffer.from(frame.bytes, 'base64')
    if (buffer.length === 0) {
      throw new TypeError('baseline frame ' + index + ' (' + frame.name + ') decoded to zero bytes')
    }
    return { state: CONFIGURATION, name: frame.name, buffer }
  })

  const finishes = parsed.filter(frame => frame.name === BASELINE_FINISH_FRAME)
  if (finishes.length !== 1) {
    throw new TypeError('configuration baseline needs exactly one ' + BASELINE_FINISH_FRAME + ', found ' + finishes.length)
  }
  if (parsed[parsed.length - 1].name !== BASELINE_FINISH_FRAME) {
    throw new TypeError('the baseline ends with ' + parsed[parsed.length - 1].name + ', not ' + BASELINE_FINISH_FRAME)
  }
  for (const name of BASELINE_REQUIRED_FRAMES) {
    if (!parsed.some(frame => frame.name === name)) {
      throw new TypeError('configuration baseline carries no ' + name)
    }
  }

  return {
    version,
    protocolVersion,
    capturedFrom,
    frames: parsed,
    // What a replay sends, in order: everything the phase carried except the
    // frame that ends it. A frame the policy will not replay is already refused
    // above, so this filter only removes the finish. Evidence, not a client's
    // phase: `baselineFramesFor` is the reader a join is served through, and it
    // withholds the registry set (#598).
    replayFrames: parsed
      .filter(frame => frame.name !== BASELINE_FINISH_FRAME)
      .map(frame => ({ name: frame.name, buffer: frame.buffer }))
  }
}

// The committed fixture. Read once per call, because a refresh is a file edit
// and a cached copy would keep serving the old one until the next restart
// anyway. A missing or broken fixture is not fatal to the lane: a lane with no
// baseline refuses a picker join with a clear reason instead of guessing.
export function readConfigurationBaseline (file = defaultBaselinePath()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return parseConfigurationBaseline(JSON.parse(text))
}

export function defaultBaselinePath () {
  return new URL('./configuration-baseline/26.2.json', import.meta.url)
}

// #598: the set a picker phase never carries. A client loads a Minecraft registry
// once, at the frame that ends the phase, and a second copy of one id is not a
// merge: it is a disconnect ("Adding duplicate key 'ResourceKey[minecraft:
// worldgen/biome / minecraft:badlands]' to registry", at
// `ClientboundFinishConfigurationPacket`). The picker's phase is the recording's,
// and the body a claim lands the client in continues that same open phase with
// its own frames, so the recording's set would be the first of two.
const PICKER_WITHHELD_FRAMES = new Set(['registry_data'])

// The frames a picker join is served. Null when the baseline was recorded at
// another protocol version. The configuration state happens to carry the same
// packet ids in 26.1 and 26.2 (`node tools/protocol.mjs diff 26.1 26.2
// configuration toClient` prints no differences), so this guard is not a bug fix:
// it is the line between evidence and a guess. The recording is evidence for the
// version it was taken at, and a lane that speaks another version has none.
//
// The registry set is withheld here, and this is the reader a picker join is
// served through, so the frames the front leg receives never include it. The
// dialog needs a phase the client parses; the body's set is the only one such a
// phase carries.
export function baselineFramesFor (baseline, { version } = {}) {
  if (!baseline) return null
  if (typeof version !== 'string' || version.length === 0) return null
  if (baseline.version !== version) return null
  return baseline.replayFrames.filter(frame => !PICKER_WITHHELD_FRAMES.has(frame.name))
}

// The registry ids a baseline carries, in frame order. Pure, and the one place a
// reader can ask what the recording covers without decoding a frame.
export function baselineRegistryIds (baseline) {
  if (!baseline) return []
  const ids = []
  for (const frame of baseline.frames) {
    if (frame.name !== 'registry_data') continue
    const id = registryIdOf(frame.buffer)
    if (id !== null) ids.push(id)
  }
  return ids
}

// The `id` of a registry_data frame: a VarInt length then the identifier. Two
// bytes of parsing rather than a decoder, because the frame's payload is the
// server's bytes and nothing here needs to look inside it.
//
// Exported because a client loads registries once, at the frame that ends the
// phase, and the assertion that no id arrives twice (#598) reads the id off the
// bytes a client was sent, not off the recording they came from. An id is the
// frame's own identifier: the `minecraft:worldgen/biome` a registry entry is
// filed under, not a name this repo gives it.
export function registryIdOf (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  // The frame's own id byte comes first, then a VarInt length and the
  // identifier. Decoded with the one VarInt reader in core
  // (src/core/client-settings.js), like every other length on the wire.
  const length = decodeVarInt(buffer, 1)
  if (length === null || length.value <= 0) return null
  const start = 1 + length.bytes
  const end = start + length.value
  if (end > buffer.length) return null
  return buffer.toString('utf8', start, end)
}

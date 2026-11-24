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
// connection carried. src/ladder/capture-config.js records it; its header holds
// the command to refresh it. Two captures of the same server are byte-identical,
// so the file is evidence and not a snapshot of a mood.
//
// What the module does not do: decode a frame, reorder one, or add one. A frame
// the server did not send is exactly the failure this file exists to avoid.
import fs from 'node:fs'

import { clientboundPolicy } from '../core/clientbound-policy.js'

// The frame that ends the phase. The baseline carries the server's, and the
// front never serves it: the picker keeps the client in configuration on
// purpose (#257), and the phase ends at the pick or the refusal.
export const BASELINE_FINISH_FRAME = 'finish_configuration'

// The frames the ticket names, and the reason each one is required. A capture
// missing one is a bad capture, not a smaller baseline: a client that gets
// registries without tags, or packs without a registry to resolve them against,
// is exactly the client that refuses the phase.
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
    // above, so this filter only removes the finish.
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

// The frames to serve a client speaking `version`. Null when the baseline was
// recorded at another protocol version. The configuration state happens to carry
// the same packet ids in 26.1 and 26.2 (`node tools/protocol.mjs diff 26.1 26.2
// configuration toClient` prints no differences), so this guard is not a bug fix:
// it is the line between evidence and a guess. The recording is evidence for the
// version it was taken at, and a lane that speaks another version has none.
export function baselineFramesFor (baseline, { version } = {}) {
  if (!baseline) return null
  if (typeof version !== 'string' || version.length === 0) return null
  if (baseline.version !== version) return null
  return baseline.replayFrames
}

// The registries a baseline carries, in frame order. Pure, and the one place a
// reader can ask what the recording covers without decoding a frame.
export function baselineRegistryNames (baseline) {
  if (!baseline) return []
  const names = []
  for (const frame of baseline.frames) {
    if (frame.name !== 'registry_data') continue
    const name = registryNameOf(frame.buffer)
    if (name !== null) names.push(name)
  }
  return names
}

// The `id` of a registry_data frame: a VarInt length then the identifier. Two
// bytes of parsing rather than a decoder, because the frame's payload is the
// server's bytes and nothing here needs to look inside it.
function registryNameOf (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  let offset = 1 // the packet id
  let length = 0
  let shift = 0
  while (offset < buffer.length) {
    const byte = buffer[offset++]
    length |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 28) return null
  }
  if (length <= 0 || offset + length > buffer.length) return null
  return buffer.toString('utf8', offset, offset + length)
}

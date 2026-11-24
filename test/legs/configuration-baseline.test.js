// #257: the committed configuration baseline. A recording, not a construction:
// these tests pin what it must carry and what a corrupt one must be refused for,
// because a baseline that half-works is a crashed client with a confusing log
// line.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BASELINE_FINISH_FRAME,
  BASELINE_REQUIRED_FRAMES,
  baselineFramesFor,
  baselineRegistryNames,
  parseConfigurationBaseline,
  readConfigurationBaseline
} from '../../src/legs/configuration-baseline.js'

function frame (name, bytes = 'AA==') {
  return { state: 'configuration', name, bytes }
}

// The smallest document the parser accepts: the four required frames and one
// finish, in the order a server sends them.
function document (overrides = {}) {
  return {
    version: '26.2',
    protocolVersion: 776,
    capturedFrom: { kind: 'paper', lane: 'monoplayer-gate-b' },
    frames: [
      frame('select_known_packs'),
      frame('feature_flags'),
      frame('registry_data'),
      frame('tags'),
      frame(BASELINE_FINISH_FRAME)
    ],
    ...overrides
  }
}

test('#257 the committed recording parses, and carries what the ticket names', () => {
  const baseline = readConfigurationBaseline()
  assert.notEqual(baseline, null, 'src/legs/configuration-baseline/26.2.json is committed')
  assert.equal(baseline.version, '26.2')
  assert.equal(baseline.protocolVersion, 776)
  // The recording is a real server's, so these numbers are measured, not chosen.
  assert.equal(baseline.frames.length, 34)
  assert.equal(baseline.replayFrames.length, 33, 'the finish is the one frame a replay never sends')
  assert.equal(baseline.frames.at(-1).name, BASELINE_FINISH_FRAME)
  for (const name of BASELINE_REQUIRED_FRAMES) {
    assert.ok(baseline.frames.some(entry => entry.name === name), name + ' is in the recording')
  }
  const registries = baselineRegistryNames(baseline)
  assert.equal(registries.length, 29, 'Paper 26.2 build 135 sends 29 registries')
  // The registry the library's own codec cannot write, and the reason this file
  // exists at all.
  assert.ok(registries.includes('minecraft:sulfur_cube_archetype'))
  assert.ok(registries.includes('minecraft:dimension_type'))
  assert.ok(registries.includes('minecraft:dialog'))
  assert.equal(new Set(registries).size, registries.length, 'no registry twice')
})

test('#257 the recording is served only at the version it was recorded at', () => {
  const baseline = readConfigurationBaseline()
  const served = baselineFramesFor(baseline, { version: '26.2' })
  assert.equal(served.length, 33)
  assert.ok(served.every(entry => entry.name !== BASELINE_FINISH_FRAME), 'the phase stays open')
  assert.ok(served.every(entry => Buffer.isBuffer(entry.buffer) && entry.buffer.length > 0))
  assert.equal(baselineFramesFor(baseline, { version: '26.1' }), null)
  assert.equal(baselineFramesFor(baseline, { version: '' }), null)
  assert.equal(baselineFramesFor(null, { version: '26.2' }), null)
})

test('#257 a frame the policy cannot place is refused, not replayed', () => {
  const bad = document({ frames: [...document().frames.slice(0, 4), frame('invented_frame'), frame(BASELINE_FINISH_FRAME)] })
  assert.throws(() => parseConfigurationBaseline(bad), /not in the clientbound policy table/)
})

test('#257 a per-leg frame is refused: it belongs to one connection', () => {
  const bad = document({ frames: [frame('keep_alive'), ...document().frames] })
  assert.throws(() => parseConfigurationBaseline(bad), /not replayable/)
})

test('#257 a recording missing one of the required frames is refused', () => {
  for (const missing of BASELINE_REQUIRED_FRAMES) {
    const frames = document().frames.filter(entry => entry.name !== missing)
    assert.throws(() => parseConfigurationBaseline(document({ frames })), new RegExp('carries no ' + missing), missing)
  }
})

test('#257 the phase must end with exactly one finish frame', () => {
  assert.throws(
    () => parseConfigurationBaseline(document({ frames: document().frames.filter(f => f.name !== BASELINE_FINISH_FRAME) })),
    /exactly one finish_configuration/
  )
  assert.throws(
    () => parseConfigurationBaseline(document({ frames: [...document().frames, frame(BASELINE_FINISH_FRAME)] })),
    /exactly one finish_configuration/
  )
  assert.throws(
    () => parseConfigurationBaseline(document({ frames: [frame(BASELINE_FINISH_FRAME), frame('tags')] })),
    /ends with tags/
  )
})

test('#257 a frame from another state or with no bytes is refused', () => {
  assert.throws(
    () => parseConfigurationBaseline(document({ frames: [{ state: 'play', name: 'tags', bytes: 'AA==' }] })),
    /not a configuration frame/
  )
  assert.throws(() => parseConfigurationBaseline(document({ frames: [frame('tags', '')] })), /has no bytes/)
  assert.throws(() => parseConfigurationBaseline(document({ frames: [] })), /non-empty frames array/)
  assert.throws(() => parseConfigurationBaseline(document({ version: '' })), /version string/)
  assert.throws(() => parseConfigurationBaseline(document({ protocolVersion: 'x' })), /protocolVersion/)
})

test('#257 a missing fixture is null, not a throw', () => {
  assert.equal(readConfigurationBaseline(new URL('file:///nonexistent/26.2.json')), null)
})

test('#257 the registry names are read out of the frames, not kept beside them', () => {
  // One registry_data frame carrying the id "minecraft:test": packet id 0x07, then
  // a VarInt length of 14 and the identifier.
  const id = Buffer.from('minecraft:test', 'utf8')
  const bytes = Buffer.concat([Buffer.from([0x07, id.length]), id, Buffer.from([0x00])]).toString('base64')
  const baseline = parseConfigurationBaseline(document({
    frames: [frame('select_known_packs'), frame('feature_flags'), frame('registry_data', bytes), frame('tags'), frame(BASELINE_FINISH_FRAME)]
  }))
  assert.deepEqual(baselineRegistryNames(baseline), ['minecraft:test'])
})

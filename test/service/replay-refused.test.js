// #717: a replay frame the front leg refused is not a frame the client was sent.
//
// `replaySnapshot` writes every synthesized frame through `writeSynthFrame`, which
// answers whether the front leg took it, and the loop dropped that answer: a frame
// no socket took was counted in `metrics.framesReplayed`, in the `attach` record's
// `replayed`, and in the `attach` event's `replayed`.
//
// Seam: the `attach` record, the `attach` event, and the core's metrics, on the fake
// legs (test/support/harness.js). The question is what the replay counted, not what a
// socket did with it, so the case refuses a frame by replacing one method on the fake
// front leg — the shape test/service/virtual-players.test.js:151 uses — rather than by
// adding a refusal knob to src/legs/fake-legs.js. The fake answers `undefined` to every
// write, which the core reads as taken, so the control case needs no patch at all.
//
// The claim, as a pair: a frame the leg took is counted once and as written, and a frame
// it refused is counted zero times as written and once as refused, in the record, on the
// event, and in the metrics a heartbeat copies. The two branches of `writeSynthFrame` are
// two cases, because a cached frame is a raw write and the synthesized position is a
// library packet, and a count that subtracted one number from the other would pass one
// case and fail the other: `replayed` is the cached frames a socket took, and `refused`
// is every frame the leg refused, the position included.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { synthAttach } from '../../src/core/join-synth.js'
import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// The join prefix the cache warms on: the warm marker is chunk_batch_finished. One
// map_chunk, so a case can refuse the only cached chunk frame the replay carries.
function joinPrefix (rig) {
  for (const frame of [
    { name: 'login', data: { entityId: 42, viewDistance: 10 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) rig.backendLeg.deliver({ state: 'play', ...frame })
}

// One core, warm, with a listener on the attach event and the log collected.
function warmRig () {
  const logLines = []
  const rig = makeCore({ logLines })
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  joinPrefix(rig)
  assert.equal(rig.core.cache.warm, true, 'the prefix warmed the cache')
  const events = []
  rig.core.on('attach', event => events.push(event))
  return { rig, events, logLines }
}

// The one `attach` record a case wrote.
function attachRecord (logLines) {
  const records = logLines.filter(line => line.event === 'attach')
  assert.equal(records.length, 1, 'one attach writes one record')
  return records[0]
}

test('#717 a cached replay frame the leg refused is counted as refused, and not as replayed', () => {
  const taken = warmRig()
  const written = taken.rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(written.attached, true, 'the replay ran')
  const replayed = attachRecord(taken.logLines).replayed
  assert.ok(replayed > 0, 'the control replay wrote frames, so the pair compares two numbers')
  // Every frame the replay built is counted once, and the count is the module's own: not
  // a total taken around the write, and not a frame counted twice.
  assert.equal(replayed, synthAttach({
    snapshot: taken.rig.core.cache.snapshot(),
    pose: taken.rig.core.session.currentPose
  }).counts.replayed, 'a frame the leg took is counted once')
  assert.equal(taken.rig.core.metrics.replayFramesRefused, 0, 'nothing was refused')

  const refused = warmRig()
  // The leg drops one frame instead of writing it, which is the answer
  // `src/legs/live-front.js` gives when it refuses a raw frame (`writeRawTo`).
  const writeRaw = refused.rig.frontLeg.writeRaw.bind(refused.rig.frontLeg)
  refused.rig.frontLeg.writeRaw = (buffer, meta, options = {}) => {
    if (meta?.name === 'map_chunk') return false
    return writeRaw(buffer, meta, options)
  }
  const outcome = refused.rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'a refused frame is not a refused attach')

  // The record, which is the operator's copy.
  const record = attachRecord(refused.logLines)
  assert.equal(record.refused, 1, 'the record says the leg refused one frame')
  assert.equal(record.replayed, replayed - 1, 'and does not count it as written')
  assert.equal(record.replayed + record.refused, replayed,
    'what the leg took plus what it refused is the cached frames the control case wrote')

  // The event, which is the cut a parity rung compares.
  const [event] = refused.events
  assert.equal(event.replayed, replayed - 1, 'the event does not count it as written either')
  assert.equal(event.refused, record.refused, 'and carries the same refusal count the record does')

  // The metrics a heartbeat copies.
  assert.equal(refused.rig.core.metrics.framesReplayed, replayed - 1,
    'the frames replayed are the ones a socket took, so the refused one does not move this')
  assert.equal(refused.rig.core.metrics.replayFramesRefused, 1,
    'and it is in the counter of replay frames the leg refused')
  assert.equal(refused.rig.core.metrics.positionsSynthesized, 1,
    'the position was still invented for the join, which is what that counter says')

  // Where the operator looks next: one line per refused frame, naming it.
  const lines = refused.logLines.filter(line => line.event === 'replayFrameRefused')
  assert.equal(lines.length, record.refused, 'one line per refused frame')
  assert.equal(lines[0].frame, 'map_chunk', 'the line names the frame the client never got')
  assert.equal(lines[0].reason, 'attach', 'and the path that replayed it')
})

test('#717 a synthesized position the leg refused is refused, and was never a replayed frame', () => {
  const refused = warmRig()
  const write = refused.rig.frontLeg.write.bind(refused.rig.frontLeg)
  refused.rig.frontLeg.write = (name, packet, options = {}) => {
    if (name === 'position') return false
    return write(name, packet, options)
  }
  refused.rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })

  const record = attachRecord(refused.logLines)
  assert.equal(record.refused, 1, 'the one frame the leg refused is counted')
  // The synthesized position is not in `replayed` by construction, so the refusal is the
  // only number that moved: a fix that subtracted refusals from the built count would
  // take a cached frame off this record and leave the position in.
  assert.ok(record.replayed > 0, 'the cached frames were written, so they are counted')
  assert.equal(refused.rig.core.metrics.framesReplayed, record.replayed)
  assert.equal(refused.rig.core.metrics.replayFramesRefused, 1)
  assert.equal(refused.rig.core.metrics.positionsSynthesized, 1,
    'a position the client never received was still invented, and this counter says invented')
  assert.equal(refused.logLines.filter(line => line.event === 'replayFrameRefused')[0].frame, 'position')
})

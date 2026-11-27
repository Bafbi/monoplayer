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
//
// #738 is the other half of the answer, and it is a decision rather than a count: a frame
// the leg refused, or threw on, is offered once and never again
// (docs/adr/a-refused-replay-frame-is-not-retried.md). The attach stream is written in one
// synchronous turn, so a second write reaches the same socket with the same state and the
// same policy answer, and can only answer what the first one did. The two cases at the end
// of this file hold that, and they hold it from the side that costs something: the frame is
// refused on its **first** offer only, so a second offer would be taken. Nothing else in
// this file can see that, because a retry that also fails and logs nothing leaves every
// counter and every line exactly as they are.
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

// #738's rig: one core whose leg records every call it is handed, in order, on both write
// paths. The record is taken before the answer, because an attempt is an offer and a frame
// the leg refuses is still one. `frame` names the one frame this rig answers instead of
// writing, on that frame's **first** offer only: every later offer is written as usual, so a
// retry would be taken and an offer count is what separates this code from one that retries.
function attemptRig ({ frame = null, refuseWith = null } = {}) {
  const { rig, logLines } = warmRig()
  const attempts = []
  let offered = 0
  for (const name of ['write', 'writeRaw']) {
    const write = rig.frontLeg[name].bind(rig.frontLeg)
    rig.frontLeg[name] = (first, meta, options = {}) => {
      const thisFrame = name === 'write' ? first : meta?.name ?? null
      attempts.push(thisFrame)
      if (refuseWith !== null && thisFrame === frame) {
        offered++
        if (offered === 1) return refuseWith()
      }
      return write(first, meta, options)
    }
  }
  return { rig, logLines, attempts, offered: () => offered }
}

// The same attach with the leg taking every frame: what a refusal case is compared with.
function controlAttach () {
  const { rig, logLines, attempts } = attemptRig()
  const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'the control attach ran')
  const record = attachRecord(logLines)
  assert.ok(record.replayed > 1, 'the control replayed several cached frames')
  assert.equal(record.refused, 0, 'and the leg refused none of them')
  assert.equal(attempts.filter(name => name === 'map_chunk').length, 1,
    'the replay offers the cached chunk once, so one more offer of it in a case is a retry')
  return { record, attempts, names: rig.frontLeg.namesOf() }
}

// #739's throw, as the one the live path can raise: the writable's argument check under
// `emitCheckedRaw`, which is upstream of the socket. A dead socket does not throw there.
const WRITE_FAILED = 'The "chunk" argument must be of type string or an instance of Buffer'

test('#738 a frame the leg refused once is offered once, even though a second offer would be taken', () => {
  const control = controlAttach()
  const refused = attemptRig({ frame: 'map_chunk', refuseWith: () => false })
  const outcome = refused.rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'a refused frame is not a refused attach')

  // The claim: the leg was handed exactly what the control attach handed it. A retry, at any
  // point in the attach stream, adds one entry here, and no count in the record would show it.
  assert.deepEqual(refused.attempts, control.attempts,
    'the replay offered the leg one of each frame, the refused one included')
  assert.equal(refused.offered(), 1, 'the refused frame was offered once and not again')

  // What the client holds: a gap. The decision is that it keeps it until it attaches again.
  assert.deepEqual(refused.rig.frontLeg.namesOf(), control.names.filter(name => name !== 'map_chunk'),
    'the client was sent every frame but the refused one, in the order the control wrote them')

  const record = attachRecord(refused.logLines)
  assert.equal(record.refused, 1, 'the record says one frame did not reach a socket')
  assert.equal(record.replayed, control.record.replayed - 1, 'and does not count it as written')
  assert.equal(refused.rig.core.metrics.replayFramesRefused, 1,
    'the counter moved once, not once per attempt')

  const lines = refused.logLines.filter(line => line.event === 'replayFrameRefused')
  assert.equal(lines.length, 1, 'one line for one refused frame, however many attempts it took')
  assert.equal(lines[0].frame, 'map_chunk', 'the line names the frame the client never got')
  assert.equal('error' in lines[0], false, 'a leg that answered false raised nothing')
})

test('#738 a frame the leg threw on once is offered once, even though a second offer would be taken', () => {
  const control = controlAttach()
  const refused = attemptRig({ frame: 'map_chunk', refuseWith: () => { throw new TypeError(WRITE_FAILED) } })
  const outcome = refused.rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'a frame that threw is not a refused attach')

  // #739 decided the throw costs one frame and the rest of the stream is attempted. This is
  // the other half of it: the frame that threw is not offered a second time.
  assert.deepEqual(refused.attempts, control.attempts,
    'the replay offered the leg one of each frame, the one that threw included')
  assert.equal(refused.offered(), 1, 'the frame that threw was offered once and not again')

  assert.deepEqual(refused.rig.frontLeg.namesOf(), control.names.filter(name => name !== 'map_chunk'),
    'every frame behind the throw reached the client, and the one that threw did not')

  const record = attachRecord(refused.logLines)
  assert.equal(record.refused, 1, 'the throw is one frame the client did not get')
  assert.equal(record.replayed, control.record.replayed - 1)

  const lines = refused.logLines.filter(line => line.event === 'replayFrameRefused')
  assert.equal(lines.length, 1, 'one line for the one frame, however many attempts it took')
  assert.equal(lines[0].error, WRITE_FAILED, 'and it carries what the leg raised')
})

// #739: a front-leg write that throws during a replay costs one frame, not the stream.
//
// `replaySnapshot` writes its synthesized frames through `writeSynthFrame`. A leg that
// answers false is #717's refusal, and `test/service/replay-refused.test.js` is that
// case. A leg that throws was #739. The throw left `replaySnapshot` halfway down the
// list, so every frame behind it was skipped. So were the client settings, the puppet's
// skin and both resends. The `attach` record is written after all of them, so no record
// was written at all, and an operator saw an attach that left no trace.
//
// Seam: the frames the fake front leg recorded, the core's metrics, and the `attach`
// record, on the fake legs (test/support/harness.js). The fake never raises on its own,
// so a case replaces one method on it, the shape test/service/virtual-players.test.js
// uses, rather than adding a throw knob to src/legs/fake-legs.js. The fake answers
// nothing to a write, which the core reads as taken, so the control case needs no patch
// at all.
//
// The claim, as three. A throw costs the one frame: every other frame reaches the
// client, in the same order, including the frames behind it and the held dialog that is
// resent after the replay. The frame that threw is counted once as one the client did
// not get, in the record and in the metrics, and is named on its own line. And the
// `attach` record exists, because a record written after the risky work has to survive
// it.
//
// Both branches of `writeSynthFrame` are driven, because a cached frame is a raw write
// and the synthesized position is a library packet, and a guard that caught only one
// would pass a case that threw on the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// The join prefix the cache warms on: the warm marker is chunk_batch_finished.
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

// One core with a warm cache and one held play dialog, so the resend that runs after
// the replay has something to send. The stages after the throw are the half of the
// stream a throw used to skip, and a count of zero would prove nothing about them.
function warmRig () {
  const logLines = []
  const rig = makeCore({ logLines })
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  joinPrefix(rig)
  assert.equal(rig.core.cache.warm, true, 'the prefix warmed the cache')
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })
  assert.equal(rig.core.pendingDialog.held, true, 'the dialog waits for a client')
  return { rig, logLines }
}

// The one `attach` record a case wrote.
function attachRecord (logLines) {
  const records = logLines.filter(line => line.event === 'attach')
  assert.equal(records.length, 1, 'one attach writes one record')
  return records[0]
}

// The same attach with no throw anywhere: the stream a case compares against, and the
// count it subtracts from.
function controlAttach () {
  const { rig, logLines } = warmRig()
  const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'the control attach ran')
  const record = attachRecord(logLines)
  assert.ok(record.replayed > 1, 'the control replayed several cached frames')
  assert.equal(record.dialogs.resent, 1, 'and the held dialog was resent after the replay')
  return { record, names: rig.frontLeg.namesOf() }
}

// The leg's throw, as the one the live path can raise: the writable's argument check
// under `emitCheckedRaw`, which is upstream of the socket. A dead socket does not throw
// there, it returns.
const WRITE_FAILED = 'The "chunk" argument must be of type string or an instance of Buffer'

// A warm core whose writes throw: the `nth` call of `method`, the call naming `frame`
// when one is given, or every call of both writers when `all` is set.
function throwingRig ({ method = 'writeRaw', nth = null, frame = null, all = false } = {}) {
  const { rig, logLines } = warmRig()
  let thrownName = null
  for (const name of all ? ['write', 'writeRaw'] : [method]) {
    const write = rig.frontLeg[name].bind(rig.frontLeg)
    let calls = 0
    rig.frontLeg[name] = (first, meta, options = {}) => {
      calls++
      const thisFrame = name === 'write' ? first : meta?.name ?? null
      if (all || calls === nth || (frame !== null && thisFrame === frame)) {
        thrownName = thisFrame
        throw new TypeError(WRITE_FAILED)
      }
      return write(first, meta, options)
    }
  }
  return { rig, logLines, lostName: () => {
    assert.notEqual(thrownName, null, 'the case threw on a frame')
    return thrownName
  } }
}

// Both ends of a cached stream, because a throw at the first frame leaves the whole
// stream behind it and a throw mid-stream leaves the two halves either side of it.
for (const nth of [1, 2]) {
  test(`#739 a throw on cached frame ${nth} of a replay costs that frame and not the rest of the attach`, () => {
    const control = controlAttach()
    const { rig, logLines, lostName } = throwingRig({ nth })

    const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
    assert.equal(outcome.attached, true, 'a frame the leg could not write is not a refused attach')
    const lost = lostName()

    // What reached the client: every frame the control wrote, in the same order, but the
    // one that threw. The frames behind it are the ones a throw used to skip.
    assert.deepEqual(rig.frontLeg.namesOf(), control.names.filter(name => name !== lost),
      'every frame but the one that threw reached the client, in the order the control wrote them')

    // The record, which is the operator's copy, and the ticket's real complaint. It is
    // written after the replay, the skin and both resends, so it exists only if nothing
    // above it throws out.
    const record = attachRecord(logLines)
    assert.equal(record.refused, 1, 'the record says one frame did not reach the client')
    assert.equal(record.replayed, control.record.replayed - 1, 'and does not count it as written')
    assert.equal(record.dialogs.resent, 1, 'the dialog the replay used to be ahead of was still resent')

    // The metrics a heartbeat copies.
    assert.equal(rig.core.metrics.replayFramesRefused, 1,
      'the frame that threw is in the counter of replay frames the client did not get')
    assert.equal(rig.core.metrics.framesReplayed, control.record.replayed - 1,
      'and the frames replayed are the ones a socket took')

    // Where the operator looks next: one line naming the frame, with what the leg raised.
    const lines = logLines.filter(line => line.event === 'replayFrameRefused')
    assert.equal(lines.length, 1, 'one line for the one frame')
    assert.equal(lines[0].frame, lost, 'the line names the frame the client never got')
    assert.equal(lines[0].reason, 'attach', 'and the path that replayed it')
    assert.equal(lines[0].error, WRITE_FAILED, 'and carries what the leg raised')
  })
}

test('#739 a throw on the synthesized position is counted, and leaves the cached count alone', () => {
  const control = controlAttach()
  // The other branch of `writeSynthFrame`: a packet, not cached bytes.
  const { rig, logLines, lostName } = throwingRig({ method: 'write', frame: 'position' })
  rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(lostName(), 'position')

  assert.deepEqual(rig.frontLeg.namesOf(), control.names.filter(name => name !== 'position'),
    'the cached stream behind the position reached the client')

  const record = attachRecord(logLines)
  assert.equal(record.refused, 1, 'the position is counted as a frame the client did not get')
  // The position was never in `replayed` by construction: it is not a cached frame. A fix
  // that subtracted refusals from the built count would take a cached frame off this
  // record and leave the position in.
  assert.equal(record.replayed, control.record.replayed, 'and the cached count is untouched')
  assert.equal(rig.core.metrics.framesReplayed, control.record.replayed)
  assert.equal(rig.core.metrics.replayFramesRefused, 1)
  assert.equal(rig.core.metrics.positionsSynthesized, 1,
    'a position the client never received was still invented, and this counter says invented')
  assert.equal(logLines.filter(line => line.event === 'replayFrameRefused')[0].frame, 'position')
})

// A throw that repeats is what a wrong argument produces on every frame, since the
// argument is the same one each time. The count then has to be the frames attempted, or
// the record reports one loss out of a stream that died.
test('#739 a leg that throws on every frame is counted once per frame, and the record exists', () => {
  const control = controlAttach()
  const { rig, logLines } = throwingRig({ all: true })
  const outcome = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(outcome.attached, true, 'and the attach is still an attach')

  // Every frame the replay builds: the cached ones the control counted, and the one
  // invented position.
  const attempted = control.record.replayed + 1
  const record = attachRecord(logLines)
  assert.equal(record.refused, attempted, 'every frame the replay attempted is counted as lost')
  assert.equal(record.replayed, 0, 'and none of them is counted as written')
  assert.equal(rig.core.metrics.replayFramesRefused, attempted)
  assert.equal(rig.core.metrics.framesReplayed, 0)
  assert.equal(logLines.filter(line => line.event === 'replayFrameRefused').length, attempted,
    'one line per attempted frame, so the operator can count them')
  assert.equal(rig.frontLeg.namesOf().length, 0, 'the client was sent nothing')
  assert.equal(record.dialogs.resent, 0, 'and the dialog resend failed on its own guard')
})

// #16: the interceptor's live mode. The puppet's configuration is streamed to
// the attaching client by the core, so the library's own registry and finish
// writes must never reach it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConfigPathInterceptor } from '../../src/legs/live-front.js'

function rig ({ live = true, cached = [] } = {}) {
  const writes = []
  const raws = []
  const configuring = []
  const suppressed = []
  let configuration = true
  const interceptor = createConfigPathInterceptor({
    onConfiguring: () => configuring.push('configuring'),
    onSuppressed: ({ name }) => suppressed.push({ name }),
    write: (name, params) => writes.push({ name, params }),
    writeRaw: (buffer, meta) => raws.push({ buffer, meta }),
    isConfigurationState: () => configuration,
    cachedConfigFrames: cached,
    live,
    allowLibraryFallback: false,
    onUnavailable: () => { throw new Error('must not be unavailable in live mode') }
  })
  return {
    interceptor,
    writes,
    raws,
    configuring,
    suppressed,
    endConfiguration: () => { configuration = false },
    startConfiguration: () => { configuration = true }
  }
}

test('live mode holds the library registry and finish writes', () => {
  const r = rig()
  r.interceptor.write('registry_data', { codec: {} })
  r.interceptor.write('finish_configuration', {})
  assert.deepEqual(r.writes, [], 'nothing the library generates reaches the client')
  assert.equal(r.interceptor.replayMode, 'live_stream')
  assert.equal(r.interceptor.resolved, false)
})

test('the core finisher ends the phase without a second finish frame', () => {
  const r = rig()
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.interceptor.finishFromCore(), true)
  assert.equal(r.interceptor.resolved, true)
  assert.deepEqual(r.writes, [], 'the library finish is dropped, not sent twice')
  assert.equal(r.interceptor.stats.finishedByCore, 1)
  assert.equal(r.interceptor.finishFromCore(), false, 'finishing twice is a no-op')
})

test('#16 the configuration phase is reported once, before the frames', () => {
  const r = rig()
  r.interceptor.write('finish_configuration', {})
  r.interceptor.write('finish_configuration', {})
  assert.deepEqual(r.configuring, ['configuring'], 'one report per client, however often the library writes')
  assert.deepEqual(r.writes, [])
})

test('cached mode still replays what it has and is unaffected by live', () => {
  const r = rig({ live: false, cached: [{ name: 'registry_data', buffer: Buffer.from('r') }] })
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.raws.length, 1, 'the cached frame is replayed')
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0].name, 'finish_configuration')
  assert.equal(r.interceptor.replayMode, 'cached_replay')
})

// #257: the picker. With no backend connected there is nothing to replay and
// nothing to stream, so the front serves the committed configuration baseline
// and keeps the client in configuration: the dialog is the phase, and the phase
// ends at the pick, not at a finish frame the client was never shown a world
// for.
function pickerRig ({ baseline = null, cached = [] } = {}) {
  const writes = []
  const raws = []
  const events = []
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => writes.push({ name, params }),
    writeRaw: (buffer, meta) => raws.push({ buffer, meta }),
    isConfigurationState: () => true,
    cachedConfigFrames: cached,
    baselineConfigFrames: baseline,
    onBaselineFrames: () => events.push('baseline'),
    live: false,
    allowLibraryFallback: false,
    onUnavailable: () => events.push('unavailable')
  })
  return { interceptor, writes, raws, events }
}

test('#257 the baseline replays the recording and keeps the phase open', () => {
  const baseline = [
    { name: 'feature_flags', buffer: Buffer.from('f') },
    { name: 'registry_data', buffer: Buffer.from('r') },
    { name: 'tags', buffer: Buffer.from('t') }
  ]
  const r = pickerRig({ baseline })
  r.interceptor.write('registry_data', { codec: {} })
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.interceptor.replayMode, 'baseline')
  assert.deepEqual(r.raws.map(frame => frame.meta), [
    { state: 'configuration', name: 'feature_flags' },
    { state: 'configuration', name: 'registry_data' },
    { state: 'configuration', name: 'tags' }
  ], 'the recording goes out in its own order, as configuration frames')
  assert.deepEqual(r.writes, [], 'the library finish is dropped: the phase stays open for the picker')
  assert.deepEqual(r.events, ['baseline'], 'the dialog hook fires once, after the frames')
  assert.equal(r.interceptor.stats.baselineFrames, 3)
  assert.equal(r.interceptor.stats.replayedConfigFrames, 0, 'the library registry is not a fallback here')
  assert.equal(r.interceptor.stats.unavailable, 0)
})

// #541: the phase's finish is the last configuration frame a client can parse.
// The client answers it in play, and this leg does not learn that until the
// answer arrives, so a frame written inside that window carries a configuration
// packet id into a connection that is already reading the play table. The
// library's keep-alive does exactly that on its four-second interval: the
// offline rung recorded 9 bytes of configuration keep_alive read in play as
// acknowledge_player_digging, seven bytes left over.
test('#541 a configuration frame written after the phase finish never reaches the client', () => {
  const r = rig()
  r.interceptor.finishFromCore()
  assert.equal(r.interceptor.write('keep_alive', { keepAliveId: 7n }), false, 'and the caller is told nothing was written')
  assert.deepEqual(r.writes, [], 'the keep-alive does not follow the phase finish')
  assert.deepEqual(r.suppressed, [{ name: 'keep_alive' }], 'and the leg is told which frame it was')
})

test('#541 the next round opens the phase again, so its keep-alives are sent', () => {
  const r = rig()
  r.interceptor.finishFromCore()
  r.endConfiguration()
  // The leg opens the next round on the connection it holds: it reopens the
  // phase, writes the play-state start_configuration, and flips its own state
  // when the client answers it.
  r.interceptor.reopenConfiguration()
  r.interceptor.write('start_configuration', {})
  r.startConfiguration()
  r.interceptor.write('keep_alive', { keepAliveId: 8n })
  assert.deepEqual(r.writes.map(write => write.name), ['start_configuration', 'keep_alive'])
  assert.deepEqual(r.suppressed, [])
})

test('#541 a later round in cached mode closes the phase as well', () => {
  // The login replay resolves the interceptor on the first finish. A followed
  // move on the same connection opens a second round, and its finish frame is
  // the core's too, so the phase has to close again.
  const r = rig({ live: false, cached: [{ name: 'registry_data', buffer: Buffer.from('r') }] })
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.interceptor.replayMode, 'cached_replay')
  r.endConfiguration()
  r.interceptor.reopenConfiguration()
  r.interceptor.write('start_configuration', {})
  r.startConfiguration()
  assert.equal(r.interceptor.finishFromCore(), false, 'the login replay already resolved the interceptor')
  r.interceptor.write('keep_alive', { keepAliveId: 9n })
  assert.deepEqual(r.writes.map(write => write.name), ['finish_configuration', 'start_configuration'])
  assert.deepEqual(r.suppressed, [{ name: 'keep_alive' }])
})

test('#257 a baseline for another protocol version is not a baseline', () => {
  // The choice of baseline is the leg's (baselineFramesFor returns null for a
  // version it does not have), so an empty baseline is what the interceptor sees
  // and it must behave exactly as it did before: unavailable, never the library.
  const r = pickerRig({ baseline: [] })
  r.interceptor.write('finish_configuration', {})
  assert.deepEqual(r.raws, [])
  assert.deepEqual(r.events, ['unavailable'], 'no dialog, and no invented frames, without a baseline')
  assert.equal(r.interceptor.stats.baselineFrames, 0)
})

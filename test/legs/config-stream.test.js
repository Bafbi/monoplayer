// #16: the interceptor's live mode. The puppet's configuration is streamed to
// the attaching client by the core, so the library's own registry and finish
// writes must never reach it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConfigPathInterceptor } from '../../src/legs/live-front.js'
import {
  baselineFramesFor,
  baselineRegistryIds,
  readConfigurationBaseline,
  registryIdOf
} from '../../src/legs/configuration-baseline.js'

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

// #598: one configuration phase, one registry set.
//
// The picker opens the client's configuration phase with the recorded baseline,
// and a granted claim continues that same open phase with the body's own frames
// and one finish frame. A client loads registries at `finish_configuration` and
// nothing before it, so a registry id the phase already carried is not a
// mergeable second copy: a real 26.2 client dropped the connection with
//
//   Failed to handle packet ClientboundFinishConfigurationPacket
//   java.lang.IllegalStateException: Adding duplicate key
//     'ResourceKey[minecraft:worldgen/biome / minecraft:badlands]' to registry
//
// These two tests are that collision without a client. The first is the
// reproduction and the rule: a picker phase carries no registry data, because only
// the body a claim lands the client in supplies a registry set. The second is the
// gate the ticket names: for one landed claim, every registry id across the whole
// phase appears exactly once.
//
// What this file composes by hand, the leg does for real. The interceptor writes the
// picker's frames through its own `writeRaw`, and a landing writes the body's
// through a different call (`sendBodyConfiguration`'s `emitCheckedRaw`), so the
// order below is the client's order and not one sink's. `picker-registry-set.test.js`
// is the same gate at the leg, on a real client, which is what catches a wiring
// mistake here.

// Every registry id the client was sent, in the order it arrived.
function registryIdsOnTheWire (frames) {
  return frames
    .filter(frame => frame.name === 'registry_data')
    .map(frame => registryIdOf(frame.buffer))
}

function idsThatRepeat (ids) {
  const seen = new Set()
  const repeated = new Set()
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  return [...repeated]
}

// One landing, as the client receives it: the picker's frames out of the
// interceptor, then the body's own frames. The finish a landing writes is not here:
// a landing writes it through the library's own writer, which no sink in this file
// sees.
function landedPhase (baseline, body) {
  const r = pickerRig({ baseline: baselineFramesFor(baseline, { version: baseline.version }) })
  // The library's own configuration writes, which is what opens the phase: its
  // registry_data is suppressed, and its finish is the moment the baseline goes out.
  r.interceptor.write('registry_data', { codec: {} })
  r.interceptor.write('finish_configuration', {})
  const phase = r.raws.map(frame => ({ name: frame.meta.name, buffer: frame.buffer }))
  return {
    phase: [...phase, ...body.map(frame => ({ name: frame.name, buffer: frame.buffer }))],
    picker: phase,
    interceptor: r.interceptor
  }
}

test('#598 a picker phase carries no registry data', () => {
  const baseline = readConfigurationBaseline()
  const landed = landedPhase(baseline, [])
  const ids = registryIdsOnTheWire(landed.picker)

  assert.deepEqual(ids, [],
    'the recording carries ' + baselineRegistryIds(baseline).length +
    ' registries and a picker serves none of them: the body a claim lands the client in is the phase\'s one registry set')
  // The rest of the recording still goes out, in recorded order: the phase is what
  // the client parses a dialog in, and it is still the recording's own frames.
  assert.deepEqual(landed.picker.map(frame => frame.name), [
    'custom_payload',
    'feature_flags',
    'select_known_packs',
    'tags'
  ], 'every frame of the recording a dialog needs, and no registry set')
  assert.equal(landed.interceptor.replayMode, 'baseline', 'and it is still the baseline path, not the library fallback')
})

test('#598 one landed claim carries every registry id exactly once', () => {
  const baseline = readConfigurationBaseline()
  // The body here is the recording's own replay, so its registry ids are the
  // baseline's: that equality is what made the live client die, and it is the worst
  // case rather than a contrived one. It follows that this test cannot tell whose
  // set arrived, only how many ids did; the socket gate reads the leg for that.
  const body = baseline.replayFrames
  const ids = registryIdsOnTheWire(landedPhase(baseline, body).phase)

  assert.deepEqual(idsThatRepeat(ids), [], 'no registry id reaches the client twice in one phase')
  assert.equal(ids.length, baselineRegistryIds(baseline).length,
    'the phase carries the body\'s set, once: one id per registry the body sends')
  assert.ok(ids.includes('minecraft:dimension_type'), 'the ids are a real Paper 26.2 registry set, not one this test made up')
})

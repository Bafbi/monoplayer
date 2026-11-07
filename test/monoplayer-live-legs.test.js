// Targeted tests for the live-leg interfaces (src/monoplayer/live-backend.js,
// live-front.js) with fakes — no sockets, no auth, no Microsoft involvement.
// The real legs plug into the same interfaces the fake legs test in
// monoplayer-integration.test.js; here we test the adapter-local decisions:
//
//   live-backend: raw/decoded frame pairing, keep-alive swallowing
//   join-synth + core: includeConfig:false omit configuration on attach
//   live-front: cached-config interceptor (cached_replay vs library_fallback)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createBackendFrameForwarder } from '../src/monoplayer/live-backend.js'
import { createConfigPathInterceptor } from '../src/monoplayer/live-front.js'
import { synthAttach, LEG_OWNED } from '../src/monoplayer/join-synth.js'
import { createMonoplayer, DEFAULT_CONFIG } from '../src/monoplayer.js'
import { createStateCache } from '../src/monoplayer/state-cache.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../src/monoplayer/fake-legs.js'
import { createAttachGate } from '../src/auth/attach.js'
import { createWhitelistStore } from '../src/auth/store.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// Small fake-leg harness for the includeConfig attach behavior (same shape
// as monoplayer-integration.test.js's rig, warmed once).
function attachPlayerHarness () {
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: { ...DEFAULT_CONFIG, attachWhitelist: [PLAYER] },
    backendLeg,
    frontLeg
  })
  core.start()
  const config = [{ state: 'configuration', name: 'registry_data', data: { codec: 1 } }]
  for (const f of config) backendLeg.deliver(f)
  const join = [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]
  for (const f of join) backendLeg.deliver({ state: 'play', ...f })
  return { core, frontLeg, attachPlayer: payload => {
    frontLeg.setClient({ username: payload.name, uuid: PLAYER })
    return core.attachPlayer({ name: payload.name, uuid: PLAYER, includeConfig: payload.includeConfig })
  } }
}

const buf = (label) => Buffer.from(label)

test('backend forwarder: pairs decoded data with the raw frame, same name/state', () => {
  const frames = []
  const forwarder = createBackendFrameForwarder({ deliver: frame => frames.push(frame) })

  // minecraft-protocol emits `packet` (decoded) then `raw` (frame), in order.
  forwarder.onPacket({ entityId: 115 }, { name: 'login', state: 'play' })
  forwarder.onRaw(buf('raw:login'), { name: 'login', state: 'play' })

  assert.equal(frames.length, 1)
  assert.equal(frames[0].name, 'login')
  assert.equal(frames[0].state, 'play')
  assert.equal(frames[0].data.entityId, 115)
  assert.deepEqual([...frames[0].buffer], [...buf('raw:login')])
})

test('backend forwarder: keep_alive is swallowed (library keep-alive plugin owns it)', () => {
  const frames = []
  const forwarder = createBackendFrameForwarder({ deliver: frame => frames.push(frame) })
  forwarder.onPacket({ keepAliveId: 7 }, { name: 'keep_alive', state: 'play' })
  forwarder.onRaw(buf('raw:ka'), { name: 'keep_alive', state: 'play' })
  forwarder.onRaw(buf('raw:pos'), { name: 'position', state: 'play' })

  assert.equal(forwarder.counters.swallowed, 1)
  assert.equal(forwarder.counters.frames, 1)
  assert.deepEqual(frames.map(f => f.name), ['position'])
})

test('backend forwarder: unknown raw without a matching packet still forwards with data {}', () => {
  const frames = []
  const forwarder = createBackendFrameForwarder({ deliver: frame => frames.push(frame) })
  forwarder.onRaw(buf('x'), { name: 'custom_frame', state: 'play' })
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].data, {})
})

test('backend forwarder: bundle delimiters drop, enclosed packets relay individually', () => {
  const frames = []
  const forwarder = createBackendFrameForwarder({ deliver: frame => frames.push(frame) })
  forwarder.onRaw(buf('start'), { name: 'bundle_delimiter', state: 'play' })
  forwarder.onRaw(buf('entity'), { name: 'add_entity', state: 'play' })
  forwarder.onRaw(buf('chunk'), { name: 'map_chunk', state: 'play' })
  forwarder.onRaw(buf('end'), { name: 'bundle_delimiter', state: 'play' })
  forwarder.onRaw(buf('login'), { name: 'login', state: 'play' })
  assert.deepEqual(frames.map(f => f.name), ['add_entity', 'map_chunk', 'login'])
  assert.equal(forwarder.counters.bundledDelimiters, 2)
  assert.equal(forwarder.counters.bundledFramesRelayed, 2)
})

test('join-synth includeConfig:false omits the configuration replay prefix', () => {
  const snapshot = {
    config: [{ name: 'registry_data', buffer: buf('cfg1') }],
    prefix: [{ name: 'login', buffer: buf('join1') }],
    chunks: [{ name: 'map_chunk', buffer: buf('chunk') }],
    blocks: [], entities: [], inventories: [], latest: [], generic: []
  }
  const pose = { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 }

  const withConfig = synthAttach({ snapshot, pose, teleportId: 0 })
  assert.deepEqual(withConfig.frames.map(f => f.name), ['registry_data', 'login', 'position', 'map_chunk'])

  const withoutConfig = synthAttach({ snapshot, pose, teleportId: 0, includeConfig: false })
  assert.deepEqual(withoutConfig.frames.map(f => f.name), ['login', 'position', 'map_chunk'])
  assert.ok(LEG_OWNED.has('position'), 'the position frame is synthesized per attach, not replayed')
})

test('core attachPlayer({includeConfig:false}) omits config frames; default keeps B1 behavior', () => {
  // default: config frames replayed (fake-leg behavior unchanged)
  const rigA = attachPlayerHarness()
  const defaultOutcome = rigA.attachPlayer({ name: 'Bafbi' })
  assert.equal(defaultOutcome.attached, true)
  assert.equal(defaultOutcome.frames.map(f => f.name)[0], 'registry_data')

  // explicit includeConfig=false: live front owns config, the play attach
  // replays the join prefix only
  const rigB = attachPlayerHarness()
  const liveOutcome = rigB.attachPlayer({ name: 'Bafbi', includeConfig: false })
  assert.equal(liveOutcome.attached, true)
  const names = liveOutcome.frames.map(f => f.name)
  assert.equal(names.includes('registry_data'), false)
  assert.deepEqual(names[0], 'login')
})

test('cache forceWarm (live fallback for unbatched backends): prefix pins, warm domains activate', () => {
  const cache = createStateCache()
  cache.push('play', 'login', Buffer.from('login'), { entityId: 1 })
  cache.push('play', 'map_chunk', Buffer.from('c1'), { x: 0, z: 0 })
  const before = cache.stats()
  assert.equal(before.warm, false)
  assert.equal(before.sizes.prefix, 2)

  assert.deepEqual(cache.forceWarm(), { forced: true, warm: true })
  assert.deepEqual(cache.forceWarm(), { forced: false, warm: true })

  // post-fallback: chunk stream goes to the chunk domain, prefix stops growing
  cache.push('play', 'map_chunk', Buffer.from('c2'), { x: 1, z: 0 })
  const after = cache.stats()
  assert.equal(after.warm, true)
  assert.equal(after.sizes.prefix, 2)
  assert.equal(after.sizes.chunks, 1)
  assert.equal(after.metrics.warmFallback, 1)
})

test('warm fallback clears attach readiness end-to-end (not_ready gone)', () => {
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: { ...DEFAULT_CONFIG, attachWhitelist: [PLAYER] },
    backendLeg,
    frontLeg
  })
  core.start()
  // config + login + one chunk arrive, but the backend NEVER sends the warm marker
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 9 } })
  backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 0, z: 0 } })

  assert.equal(core.attachPlayer({ name: 'early', uuid: PLAYER }).reason, 'not_ready')

  const forced = core.cache.forceWarm()
  core.session.warmComplete({ marker: 'warm_fallback_join_settled' })
  assert.equal(forced.forced, true)

  frontLeg.setClient({ username: 'Bafbi', uuid: PLAYER })
  const outcome = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER, includeConfig: false })
  assert.equal(outcome.attached, true)
  assert.equal(outcome.frames[0].name, 'login')
  assert.equal(core.attached, true)
})

test('config interceptor: cached replay — registry suppressed, cached frames raw, finish last', () => {
  const written = []
  const raws = []
  const configFrames = [
    { name: 'registry_data', buffer: buf('backend-registry') },
    { name: 'feature_flags', buffer: buf('backend-flags') },
    { name: 'finish_configuration', buffer: buf('backend-finish') } // must be excluded
  ]
  let configurationState = true
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => written.push({ name, params }),
    writeRaw: (buffer) => raws.push(buffer),
    isConfigurationState: () => configurationState,
    cachedConfigFrames: configFrames
  })

  // library-authored config
  interceptor.write('registry_data', { codec: { lib: true } })
  interceptor.write('registry_data', { codec: { lib: 'seg2' } })
  interceptor.write('finish_configuration', {})

  assert.equal(interceptor.resolved, true)
  assert.equal(interceptor.replayMode, 'cached_replay')
  assert.equal(interceptor.stats.suppressedRegistryData, 2)
  assert.equal(interceptor.stats.replayedConfigFrames, 2)
  // written = only the one finish_configuration, ordered after the replay
  assert.deepEqual(written, [{ name: 'finish_configuration', params: {} }])
  assert.deepEqual(raws.map(b => b.toString()), ['backend-registry', 'backend-flags'])
})

test('config interceptor: empty cache falls back to the library-generated config', () => {
  const written = []
  const raws = []
  let configurationState = true
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => written.push({ name, params }),
    writeRaw: (buffer) => raws.push(buffer),
    isConfigurationState: () => configurationState,
    cachedConfigFrames: []
  })

  interceptor.write('registry_data', { codec: { lib: true } })
  interceptor.write('finish_configuration', {})

  assert.equal(interceptor.replayMode, 'library_fallback')
  assert.deepEqual(written, [
    { name: 'registry_data', params: { codec: { lib: true } } },
    { name: 'finish_configuration', params: {} }
  ])
  assert.equal(raws.length, 0)
})

test('config interceptor: play-state writes pass through untouched', () => {
  const written = []
  let configurationState = false
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => written.push({ name, params }),
    writeRaw: (buffer) => written.push({ name: 'raw', buffer }),
    isConfigurationState: () => configurationState,
    cachedConfigFrames: [{ name: 'registry_data', buffer: buf('x') }]
  })

  interceptor.write('position', { teleportId: 5 })
  assert.deepEqual(written, [{ name: 'position', params: { teleportId: 5 } }])
  assert.equal(interceptor.resolved, false)
})

test('attach gate + whitelist store (public APIs embedded by the live front leg)', () => {
  const file = '/tmp/opencode/attach-whitelist-test.json'
  fs.mkdirSync('/tmp/opencode', { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: [{ uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi' }]
  }))
  const store = createWhitelistStore({ file })
  const gate = createAttachGate()

  const allowed = gate.gateVerified({
    client: { username: 'Bafbi', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', profile: { id: '6eb73524ff884a62a8d0c63905e7afba', name: 'Bafbi' } },
    store
  })
  assert.equal(allowed.ok, true)

  const denied = gate.gateVerified({
    client: { username: 'Stranger', uuid: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed' },
    store
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'not_whitelisted')
  // The puppet must never be attach-whitelisted (B4 separation).
  assert.equal(store.has('73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'), false)
})

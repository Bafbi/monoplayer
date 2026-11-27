// Adapter-local unit tests for the leg interfaces (src/legs/live-backend.js,
// live-front.js), driven with fakes — no sockets, no auth, no Microsoft
// involvement. The real legs plug into the same interfaces the fake legs test
// in monoplayer-integration.test.js; here we test the adapter-local decisions:
//
//   live-backend: raw/decoded frame pairing, keep-alive swallowing
//   join-synth + core: includeConfig:false omit configuration on attach
//   live-front: cached-config interceptor (cached_replay vs library_fallback)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createBackendFrameForwarder, createLiveBackendLeg, createOfflineBackendLeg, MAX_BACKEND_FRAME_NAMES } from '../../src/legs/live-backend.js'
import minecraftData from 'minecraft-data'

import { bumpBounded, OVERFLOW_KEY } from '../../src/core/bounded-counter.js'
import { createPreAuthWindow } from '../../src/core/preauth-window.js'
import { createConfigPathInterceptor, createLiveFrontLeg, createOfflineFrontLeg, profileTextures } from '../../src/legs/live-front.js'
import { BACKEND_LEG_CALL_INS, FRONT_LEG_CALL_INS } from '../../src/service/wire-leg-to-core.js'
import { synthAttach, LEG_OWNED } from '../../src/core/join-synth.js'
import { createMonoplayer, DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { createStateCache } from '../../src/core/state-cache.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { createAttachCheck } from '../../src/custody/attach.js'
import { createWhitelistStore } from '../../src/custody/store.js'
import { tempRoot } from '../support/temp.js'

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

// #554: the forwarder's name map is copied into every heartbeat line, so its size is a
// log line's size. What this leg owns is the cap it passes and the key it counts under;
// the rule itself is src/core/bounded-counter.js's, so it is not restated here.
test('#554 the forwarder counts under the key and cap the leg passes', () => {
  const forwarder = createBackendFrameForwarder({ deliver: () => {} })
  const past = 5
  const names = Array.from({ length: MAX_BACKEND_FRAME_NAMES + past }, (_, index) => 'frame-' + index)
  const shared = {}
  for (const name of names) {
    forwarder.onRaw(buf('x'), { name, state: 'play' })
    bumpBounded(shared, `play/${name}`, MAX_BACKEND_FRAME_NAMES)
  }

  assert.deepEqual(forwarder.nameCounts, shared,
    'the leg keys the map state/name and hands the shared rule its own cap, so the rule the map follows is the one in src/core/bounded-counter.js')
  assert.equal(forwarder.nameCounts[OVERFLOW_KEY], past,
    'and the cap is a bound that bites: the last five names of a run past it are turned away')
})

// The cap is a number, so a test keeps it true: a protocol version that adds frames
// must not push a real name into the overflow bucket with nothing failing first.
test('#554 the cap is headroom over the clientbound vocabulary, not a second one', () => {
  const clientboundNames = (version, state) => Object.values(
    minecraftData(version).protocol[state].toClient.types.packet[1][0].type[1].mappings)
  const vocabulary = ['login', 'configuration', 'play']
    .reduce((total, state) => total + clientboundNames('26.2', state).length, 0)

  assert.ok(vocabulary > 0, 'the guard found the frames it counts')
  assert.ok(MAX_BACKEND_FRAME_NAMES > vocabulary,
    `the cap is above the ${vocabulary} state/name pairs a version names, so a real frame is not the overflow bucket`)
  for (const state of ['login', 'configuration', 'play']) {
    assert.equal(clientboundNames('26.1', state).length, clientboundNames('26.2', state).length,
      `the two versions the cap's comment names hold the same ${state} names, so the larger one is the one counted`)
  }
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

test('config interceptor: the live path refuses the library fallback instead of crashing the client', () => {
  const written = []
  const raws = []
  let unavailable = 0
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => written.push({ name, params }),
    writeRaw: (buffer) => raws.push(buffer),
    isConfigurationState: () => true,
    cachedConfigFrames: [],
    allowLibraryFallback: false,
    onUnavailable: () => { unavailable++ }
  })

  interceptor.write('registry_data', { codec: { lib: true } })
  interceptor.write('finish_configuration', {})

  assert.equal(unavailable, 1, 'the front is told to close the client')
  assert.equal(interceptor.stats.unavailable, 1)
  assert.equal(interceptor.stats.replayedConfigFrames, 0)
  assert.equal(written.length, 0, 'no registry_data and no finish_configuration')
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

test('attach check + whitelist store (public APIs embedded by the live front leg)', () => {
  const file = '/tmp/opencode/attach-whitelist-test.json'
  fs.mkdirSync('/tmp/opencode', { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: [{ uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi' }]
  }))
  const store = createWhitelistStore({ file })
  const check = createAttachCheck()

  const allowed = check.checkVerified({
    client: { username: 'Bafbi', uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', profile: { id: '6eb73524ff884a62a8d0c63905e7afba', name: 'Bafbi' } },
    store
  })
  assert.equal(allowed.ok, true)

  const denied = check.checkVerified({
    client: { username: 'Stranger', uuid: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed' },
    store
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'not_whitelisted')
  // The puppet must never be attach-whitelisted (B4 separation).
  assert.equal(store.has('73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'), false)
})

// #97: the front leg checks the configured chat mode before it constructs, and
// the service hands it whatever loadConfig returned. Both read `CHAT_MODES` from
// src/core/clientbound-policy.js (#103), so the two cannot drift apart. The test
// stays as the tripwire for a local copy coming back.
// #618: a client's own skin is on the profile the front verified, and the front holds no
// skin of its own. `client.profile` is the sessionserver's hasJoined body, set by the
// library before the front's own hook; an offline client has none, and a lane with no
// sessionserver supplies the properties by hand (the offline leg's `profiles` option).
test("the front reads an account's own skin off the profile it verified, and invents none", () => {
  const signed = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }
  assert.deepEqual(
    profileTextures({ id: '6eb73524ff884a62a8d0c63905e7afba', name: 'Bafbi', properties: [signed] }),
    { value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' },
    "the property is the account's own, carried as it arrived"
  )
  assert.deepEqual(
    profileTextures({ properties: [{ name: 'textures', value: 'dGV4dHVyZXM=' }] }),
    { value: 'dGV4dHVyZXM=' },
    'an unsigned property is carried without a signature the proxy added'
  )
  assert.equal(profileTextures({ name: 'Bafbi', properties: [] }), null, 'no property is no skin')
  assert.equal(profileTextures({ name: 'Bafbi' }), null)
  assert.equal(profileTextures(undefined), null, 'an offline client holds no profile at all')
  assert.equal(profileTextures({ properties: [{ name: 'textures', value: '' }] }), null,
    'a property with no value is not a skin')
  assert.equal(profileTextures({ properties: [{ name: 'textures' }] }), null)
})

// #618: the offline leg's stand-in for the sessionserver. It is an option on the
// constructor a rung builds, and the deployed leg refuses it: a live lane's answer comes
// from Mojang, and a name that let a caller plant one would be a skin nobody verified.
test("#618 the offline leg takes the account's properties, and the live leg refuses to", () => {
  const build = profiles => createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    offlineWhitelist: [PLAYER],
    getSnapshotConfig: () => [],
    wireMode: 'off',
    profiles
  })
  assert.doesNotThrow(() => build({ Bafbi: [{ name: 'textures', value: 'dGV4dHVyZXM=' }] }))
  assert.doesNotThrow(() => build(null))
  assert.throws(() => build('a blob'), /profiles must be null or an object/)
  assert.throws(() => build({ Bafbi: 'a blob' }), /must be an array of profile properties/)
  assert.throws(
    () => createLiveFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: '26.1',
      attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-profiles-refused.json'),
      getSnapshotConfig: () => [],
      wireMode: 'off',
      profiles: {}
    }),
    /does not accept profiles/
  )
})

test('the live front leg accepts every chat mode the config accepts', () => {
  const build = chat => createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-chat-mode-whitelist.json'),
    getSnapshotConfig: () => [],
    wireMode: 'off',
    chat
  })
  for (const chat of ['full', 'commands', 'read-only', 'off']) {
    assert.equal(loadConfig({ chat }).chat, chat, chat)
    assert.doesNotThrow(() => build(chat), chat)
  }
  assert.throws(() => build('write'), /chat must be one of/)
})

// #592, #605: the call-ins the tables declare are the leg's contract, and every
// leg a lane builds is measured against them through a real core's start(). A leg
// that drops one keeps its own fallback and says nothing: live-front answers every
// attach from a default that refuses, and reads a missing setBodyServed as a null
// body. The doubles' holes are declared in test/service/wire-leg-to-core.test.js,
// which is the tables' own test.
function startedOn (frontLeg, backendLeg = createFakeBackendLeg()) {
  const core = createMonoplayer({
    config: { ...DEFAULT_CONFIG, attachWhitelist: [PLAYER] },
    backendLeg,
    frontLeg,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout }
  })
  core.start()
  return core
}

const offlineFront = () => createOfflineFrontLeg({
  host: '127.0.0.1',
  port: 0,
  version: '26.1',
  offlineWhitelist: [PLAYER],
  getSnapshotConfig: () => [],
  wireMode: 'off'
})

test('every front leg a lane builds carries the call-ins the core declares', () => {
  const live = startedOn(createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-leg-call-ins-whitelist.json'),
    getSnapshotConfig: () => [],
    wireMode: 'off'
  }))
  assert.deepEqual(live.legWiring.front.missing, [],
    'the live front leg carries every call-in: an absent one is a lane that refuses a client and logs nothing')

  const offline = startedOn(offlineFront())
  assert.deepEqual(offline.legWiring.front.missing, [],
    'and so does the offline front leg every rig builds')

  // The other half of the contract: a row that names a method the core does not
  // have would register a handler that throws the first time the leg calls it.
  // Both interfaces are walked: a backend row's typo is otherwise found by a
  // frame arriving, not by the gate.
  for (const { reaches } of [...FRONT_LEG_CALL_INS, ...BACKEND_LEG_CALL_INS]) {
    if (reaches === undefined) continue
    assert.equal(typeof offline[reaches], 'function',
      'the core the table is applied to carries ' + reaches)
  }
})

// #627: the leg a live lane builds answers its own pre-auth window, in the policy's
// names. The offline front shares createFrontLeg, so one case covers the factory. The row
// in FRONT_LEG_CALL_INS says a leg declares the read, and this says what the reading is.
// A row carries a name and no answer shape (#672), so the expectation below is built from
// src/core/preauth-window.js rather than written out here.
test('#627 the live front leg answers its own pre-auth window, in the window\'s names', () => {
  const leg = createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-preauth-read-whitelist.json'),
    getSnapshotConfig: () => [],
    wireMode: 'off',
    preAuth: { maxConnections: 5, deadlineMs: 4000 }
  })
  const core = startedOn(leg)

  assert.deepEqual(leg.preAuthStats(),
    createPreAuthWindow({ maxConnections: 5, deadlineMs: 4000 }).stats(),
    'the window this leg was built with, in the names src/core/preauth-window.js answers with. The module answers, and this case reads it rather than restating the names, so a name added there is a leg that owes it')
  assert.deepEqual(core.laneState().preAuth, leg.preAuthStats(),
    'and the lane snapshot is that reading, passed on rather than summarised')
})

// #605: the backend leg's contract is measured the same way. The offline leg is
// the real one with auth 'offline', the factory every gate lane builds.
test('#605 every backend leg a lane builds carries the call-ins the core declares', () => {
  const real = startedOn(offlineFront(), createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, version: '26.1' }))
  assert.deepEqual(real.legWiring.backend.missing, [],
    'the real backend leg carries every call-in and both calls: a missing frame handler serves no client at all')

  const fake = startedOn(createFakeFrontLeg())
  assert.deepEqual(fake.legWiring.backend.missing, [],
    'and the backend double every service test builds carries them too, so a rig cannot meet a hole here')
})

// #605: the report names what a leg lacks. This is the other direction, which the
// report cannot see: a member a leg carries and no row names is a hook nothing
// calls, and it reads as part of the interface.
//
// #672: the walk is the leg's whole call surface, not its `set*` keys. `claimOn`,
// `preAuthStats`, `write`, `spectate`, `close` and the getters beside them are each
// reached by a caller, and a guard that reads only the setters leaves the rest of the
// interface to a reader. Every member is either a row of its table or a line below with
// the reason it is outside. A line for a member the leg no longer carries fails too, so
// an exception is a claim rather than a comment.
//
// A member a caller reaches by calling it is a method, or a getter, which runs when it
// is read. A plain value (`kind`) is a label and no caller calls it, so the walk leaves
// it alone. The chain is walked too: every leg in the tree is an object literal, and a
// factory that built one from a class would otherwise hide its methods here.
function callSurface (leg) {
  const names = new Set()
  for (let object = leg; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))) {
      if (typeof descriptor.value === 'function' || typeof descriptor.get === 'function') names.add(name)
    }
  }
  return [...names]
}

// The drift between a leg's call surface and the lines declared for it, in both
// directions: a member nothing declares, and a line whose member the leg has lost.
function memberDrift (label, leg, table) {
  const inTable = new Set(table.map(row => row.name))
  const declared = MEMBERS_OUTSIDE_THE_TABLES[label] ?? {}
  const outside = callSurface(leg).filter(name => !inTable.has(name))
  return {
    undeclared: outside.filter(name => declared[name] === undefined),
    stale: Object.keys(declared).filter(name => !outside.includes(name))
  }
}

// Every leg a lane builds or a test hands a core, each with the factory that makes it,
// the table its interface is declared in, and the arguments that factory demands. One
// table, so the cases below walk one surface.
//
// #727: the names are the directory's, not a list here. `legFactoryNames` reads what
// src/legs/ exports and the coverage case holds this table to it in both directions, so a
// seventh factory fails until it has a row, and a row whose export is gone fails too. The
// arguments are the one fact a row has to keep by hand, because a factory that wants
// custody on disk cannot be built without them.
const LEGS = [
  {
    factory: 'createLiveFrontLeg',
    label: 'live front leg',
    table: FRONT_LEG_CALL_INS,
    build: () => createLiveFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: '26.1',
      attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-leg-setters-whitelist.json'),
      getSnapshotConfig: () => [],
      wireMode: 'off'
    })
  },
  { factory: 'createOfflineFrontLeg', label: 'offline front leg', table: FRONT_LEG_CALL_INS, build: offlineFront },
  { factory: 'createFakeFrontLeg', label: 'fake front leg', table: FRONT_LEG_CALL_INS, build: createFakeFrontLeg },
  {
    // The one factory no guard built before #727. It takes an account directory and reads
    // none of it here: custody is acquired in `prepareConnection`, which only `connect()`
    // calls, so a path that does not exist holds the interface and opens no socket.
    factory: 'createLiveBackendLeg',
    label: 'live backend leg',
    table: BACKEND_LEG_CALL_INS,
    build: () => createLiveBackendLeg({ host: '127.0.0.1', port: 25565, accountDir: '/nonexistent/monoplayer-custody' })
  },
  {
    factory: 'createOfflineBackendLeg',
    label: 'real backend leg',
    table: BACKEND_LEG_CALL_INS,
    build: () => createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, version: '26.1' })
  },
  { factory: 'createFakeBackendLeg', label: 'fake backend leg', table: BACKEND_LEG_CALL_INS, build: createFakeBackendLeg }
]

function legsCarryingTheTables () {
  return LEGS.map(row => [row.label, row.build(), row.table])
}

// The `create…Leg` names one directory of modules exports, read from the files (#727).
// A name is a factory that builds one of the interface's objects and not one of its
// parts: `createFakeBackend` is the Paper the driver lane runs, and
// `createBackendFrameForwarder` builds a piece of a leg.
async function legFactoryNames (directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'legs')) {
  const found = []
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()) {
    const module = await import(pathToFileURL(path.join(directory, file)).href)
    for (const name of Object.keys(module)) {
      if (/^create[A-Za-z]*Leg$/.test(name)) found.push(name)
    }
  }
  return found.sort()
}

// The two directions of the coverage claim, as names: a factory no row builds, and a row
// whose factory the directory does not export. Both are lists, so a case can feed the
// function a directory of its own and watch it bite (#727).
function unbuiltFactories (factories, rows = LEGS) {
  const declared = rows.map(row => row.factory)
  return {
    missing: factories.filter(name => !declared.includes(name)),
    gone: declared.filter(name => !factories.includes(name))
  }
}

// #727: the guard measured five legs a hand-kept list named, so a sixth factory in
// src/legs/ was invisible to both the table guard and the whole-surface guard: nothing
// built it, so nothing failed. The list is the directory's now, and this case is the
// claim: every factory src/legs/ exports is a leg the cases below build.
test('#727 every leg factory src/legs/ exports is a leg the guards measure', async () => {
  const factories = await legFactoryNames()
  assert.ok(factories.includes('createLiveFrontLeg') && factories.includes('createOfflineBackendLeg'),
    'the walk found factories the cases below build, so a moved or emptied directory fails here rather than passing')
  const { missing, gone } = unbuiltFactories(factories)
  assert.deepEqual(missing, [],
    'src/legs/ exports ' + missing.join(', ') + ', and no row of the table above builds ' +
    (missing.length === 1 ? 'it' : 'them') + '. A leg no case builds is a leg no guard measures, which is the ' +
    'hole #727 found. Add a row, with the arguments that factory demands.')
  assert.deepEqual(gone, [],
    'the table above names ' + gone.join(', ') + ', and src/legs/ exports no such factory. A row for a factory ' +
    'that is gone is a claim a reader cannot check, and the leg it measured is unmeasured now.')
})

// #727: a claim about a directory is proved against one this file writes, because the
// other way to watch the guard find a sixth leg is to put a file in the tree and take it
// back out. The walk reads the modules it is handed, so a fixture is enough: the names
// come from the file, never from a list here.
test('#727 the walk finds a factory no row names, and a row whose factory is gone', async () => {
  const root = tempRoot('monoplayer-leg-walk-')
  fs.writeFileSync(path.join(root, 'sixth-leg.js'), 'export function createSixthLeg () { return {} }\n')
  const factories = await legFactoryNames(root)
  assert.deepEqual(factories, ['createSixthLeg'],
    'the walk reads the modules in the directory it is given, so a file added there is a name it finds')
  assert.deepEqual(unbuiltFactories(factories).missing, ['createSixthLeg'],
    'a factory the table has no row for is the missing leg, which is the case #727 opened with')
  assert.deepEqual(unbuiltFactories([], LEGS).gone, LEGS.map(row => row.factory),
    'and a row whose factory the directory does not export is reported the other way')
})

// #672: what each leg carries that its table does not name, one line per member with
// the reason it is outside. The two real front legs build through one factory
// (src/legs/live-front.js) and each double stands in for the same interface, so what
// they share is declared once and each list reads as what that leg adds.

// The lane's own surface: the socket it opens and the picker verb. No core calls one.
const FRONT_LANE = {
  listen: 'the lane starts and stops this leg\'s own socket. The core is handed a leg that accepts its clients',
  spectate: '#269: the picker\'s Spectate verb, which a lane calls (src/ladder/loopback.js, src/driver/dev-proof.js) and the core never does',
  close: 'the socket\'s own ending, which a lane and the rungs that stop it call (src/ladder/*). The core ends a session through `end`'
}

// A reading is a getter that runs when a caller asks for it. Every leg carries some, and
// no table names one, because a row names a function the core registers or calls.
function readings (names, reason) {
  return Object.fromEntries(names.map(name => [name, reason]))
}

// A double's script hooks drive that double from a test. src/legs/fake-legs.js groups them
// under "Test helpers", and no src/ module calls one.
const SCRIPT_HOOK = 'a script hook of the double, which drives it from a test. src/legs/fake-legs.js groups these under "Test helpers", and no src/ module calls one'

// What both real front legs read of themselves, one list because one factory builds both.
// `channels` is not here: the core reads it, so it has its own line below.
const FRONT_READINGS = readings(
  ['listening', 'driver', 'claims', 'metrics', 'checkStoreFile', 'port', 'wireStats', 'lastConfigMode'],
  'a reading of the lane\'s own state: the socket it listens on, the claims on it and the counters beside it. A lane, a rung or a test asks for one, and no core reaches for any'
)

// And what both real backend legs read of themselves. `target` is the core\'s read, so it
// has its own line.
const BACKEND_READINGS = readings(
  ['cookieCount', 'client', 'ended'],
  'a reading of the leg\'s own state: its cookie count, its client and whether it ended. No core reaches for one, and a rung or a test does'
)

// Both real front legs build through one factory (src/legs/live-front.js), so one
// declaration covers what both carry. #727 added the live backend factory to the walk,
// and it builds through src/legs/live-backend.js's other factory the same way, which is
// why the two backend legs share one declaration too.
const REAL_FRONT_LEG = {
  ...FRONT_LANE,
  ...FRONT_READINGS,
  channels: 'the channels this leg holds, one record per connection delivered a body. The core reads it (#636), and no table names a reading, because a row names a function the core registers or calls',
  setErrorHandler: 'the front leg logs its own socket errors through this hook, which the core registers nowhere. The row of this name on the backend leg is that leg\'s (#667)'
}

const REAL_BACKEND_LEG = {
  ...BACKEND_READINGS,
  target: 'the body this leg dialled, which the core reads to bind a frame to a body (syncDialledBody, src/service/monoplayer.js)',
  close: 'the socket\'s own ending, which a lane and the rungs that stop it call (src/ladder/*, test/legs/backend-close.test.js). The core ends a session through `end`',
  forwarderStats: 'the leg\'s own frame counters, which src/service/start-live.js prints on its heartbeat line and no core reads'
}

const MEMBERS_OUTSIDE_THE_TABLES = {
  'live front leg': REAL_FRONT_LEG,
  'offline front leg': REAL_FRONT_LEG,
  'fake front leg': {
    ...readings([
      'channelRecord', 'forgetChannelRecord', 'setClient', 'frames', 'namesOf', 'endReasons',
      'loginStart', 'spectatorMoved', 'serverbound', 'clientConfiguring', 'clientSettings',
      'clientDisconnect', 'clientReconfigured', 'reconfigurations', 'claim', 'releaseClaim'
    ], SCRIPT_HOOK),
    channels: 'the channels a test planted. The core makes the same read on a real leg (#636)',
    client: 'the client the double pretends to serve, which a test names'
  },
  'live backend leg': REAL_BACKEND_LEG,
  'real backend leg': REAL_BACKEND_LEG,
  'fake backend leg': {
    ...readings([
      'dialledTargets', 'rawWrites', 'packetWrites', 'spoken', 'heldGateAnswers',
      'deliver', 'deliverEnd', 'deliverError'
    ], SCRIPT_HOOK),
    target: 'the same dial the core reads on the real leg, recorded by the double',
    ...readings(['connected', 'ended', 'written'], 'the double\'s own reading of what it recorded, which a test asserts on')
  }
}

test('#605, #672 a leg carries no member its table does not name, but the ones declared here', () => {
  // The walk reads the surface it claims to: a method and a getter that the setters filter
  // could not see, and not the label, which no caller calls.
  const surface = callSurface(legsCarryingTheTables()[0][1])
  assert.ok(surface.includes('claimOn') && surface.includes('preAuthStats') && surface.includes('driver'),
    'the walk reaches the members a caller calls and reads on a real leg')
  assert.ok(!surface.includes('kind'),
    'and leaves the label, which is a value rather than a call')

  for (const [label, leg, table] of legsCarryingTheTables()) {
    const { undeclared, stale } = memberDrift(label, leg, table)
    assert.deepEqual(undeclared, [],
      label + ' carries a member that no row names and no line above declares. It belongs in the table, or in the declaration with its reason')
    assert.deepEqual(stale, [],
      label + ' declares a member its surface no longer carries outside the table. That line is a claim a reader cannot check')
  }
})

// #672: the walk is a claim about real legs, so a case reads it in both directions. Each
// leg here is a double built by its own factory, and nothing about it is invented.
test('#672 the walk reports a member nothing declares, and a line the leg has lost', () => {
  const withAnExtraHook = createFakeFrontLeg()
  withAnExtraHook.aHookNoRowNames = () => {}
  assert.deepEqual(memberDrift('fake front leg', withAnExtraHook, FRONT_LEG_CALL_INS).undeclared, ['aHookNoRowNames'],
    'a member added to a real double and named nowhere is what the case above fails on. The walk reads past the setters')

  const withoutChannels = createFakeFrontLeg()
  delete withoutChannels.channels
  assert.deepEqual(memberDrift('fake front leg', withoutChannels, FRONT_LEG_CALL_INS).stale, ['channels'],
    'and a line whose member the leg no longer carries is reported rather than read as settled. The ' +
    'member is one the tables cannot name, because a member they name is their row and not a line here')
})

// #672: a `call` row carries no answer shape, and the table's header gives the reason: the
// module that answers owns the shape. For the one call row whose answer reaches a published
// value (#627's `preAuth` group) that module is src/core/preauth-window.js's `stats()`, so
// the comparison is against it and not against a list here. A name the window adds is a leg
// that owes it, and a name it does not have is a leg that answers too much.
function preAuthShapeDrift (leg) {
  const owed = new Set(Object.keys(createPreAuthWindow().stats()))
  const answered = new Set(Object.keys(leg.preAuthStats()))
  return {
    missing: [...owed].filter(name => !answered.has(name)),
    extra: [...answered].filter(name => !owed.has(name))
  }
}

test('#672 every leg that answers the pre-auth read answers it in the window\'s own names', () => {
  const answerers = legsCarryingTheTables().filter(([, leg]) => typeof leg.preAuthStats === 'function')
  assert.equal(answerers.length, 2,
    'both real front legs answer it and no double does. The two build through one factory, and the doubles\' hole is declared in test/service/wire-leg-to-core.test.js')
  for (const [label, leg] of answerers) {
    assert.deepEqual(preAuthShapeDrift(leg), { missing: [], extra: [] },
      label + ' answers the names src/core/preauth-window.js publishes. A leg that stops answering one of them is this line, not a snapshot that quietly loses it')
  }

  const short = legsCarryingTheTables()[0][1]
  short.preAuthStats = () => ({ inWindow: 0, maxConnections: 5, deadlineMs: 4000, refused: 0 })
  assert.deepEqual(preAuthShapeDrift(short), { missing: ['expired'], extra: [] },
    'and the comparison bites. A real leg that leaves one name out is caught here, which is the failure a lane snapshot cannot report')
})

// #672: the pre-auth read is not the only `call` row a leg answers. The fields the core
// reads off an answer are declared here, one row each. A table row carries no shape (the
// header of src/service/wire-leg-to-core.js says why), and this is where a leg that
// answers other fields is caught. The core reads the answer one field at a time, so a leg
// answering `{ ok, why }` answers nothing and the gate stays held in silence.
const CALL_ROW_FIELDS = {
  // #627: the window's own names. The lane snapshot publishes this answer whole, so the
  // case above compares it to that module in both directions and this line only names the
  // owner.
  preAuthStats: () => Object.keys(createPreAuthWindow().stats()),
  // The detach handoff tests `outcome?.answered !== true` and reads `outcome?.reason`
  // (src/service/monoplayer.js). The answer also echoes the gate's name and the
  // connection's click budget, which are the leg's own record and not the core's read.
  answerHeldGate: () => ['answered', 'reason'],
  // The human's sentence goes out as the puppet and nothing comes back.
  chat: () => [],
  // #22: the core tests `started !== true` and logs `reason`, so both fields are the
  // contract of a leg that carries the row.
  startReconfiguration: () => ['started', 'reason'],
  // The rest answer a value the core reads whole: `write` and `writeRaw` a boolean it
  // compares to false, `claimOn` a claim or null, `finishConfigurationFrame` the bytes,
  // and `connect`, `end` and `setTarget` nothing. No field is read off any of them, and
  // the case below does not call one: a leg it ended or dialled would be a socket the
  // guard opened, and this file opens none.
  write: () => [],
  writeRaw: () => [],
  end: () => [],
  claimOn: () => [],
  finishConfigurationFrame: () => [],
  connect: () => [],
  setTarget: () => []
}

// The fields a leg left out of one answer, against the fields the core reads off it.
function absentFields (answer, owed) {
  return owed.filter(field => !(field in Object(answer)))
}

test('#672 every leg answers a `call` row with the fields the core reads off it', () => {
  const ASKED = {
    preAuthStats: [],
    answerHeldGate: [{ state: 'configuration', name: 'code_of_conduct' }],
    chat: ['list'],
    startReconfiguration: [{ reason: 'transfer' }]
  }
  let checked = 0
  for (const [label, leg, table] of legsCarryingTheTables()) {
    for (const { kind, name } of table.filter(row => row.kind === 'call')) {
      assert.ok(CALL_ROW_FIELDS[name] !== undefined,
        'the tables declare ' + name + ' as a call row now, and no case here says which fields the core reads off its answer')
      if (typeof leg[name] !== 'function') continue
      const owed = CALL_ROW_FIELDS[name]()
      if (owed.length === 0) { checked++; continue }
      const answer = leg[name](...ASKED[name])
      assert.deepEqual(absentFields(answer, owed), [],
        label + ' answers ' + name + ' without a field the core reads off it. Its answer is ' + JSON.stringify(answer))
      checked++
    }
  }
  assert.ok(checked > 0, 'the walk found the legs that carry a call row')

  // A real double answering the gate with names of its own is what the case above is for:
  // the core tests `answered !== true` and reads nothing else, so { ok, why } reads as a
  // held gate and the lane logs a reason the leg never gave.
  const answeringOtherNames = createFakeBackendLeg()
  answeringOtherNames.answerHeldGate = () => ({ ok: true, why: 'held' })
  assert.deepEqual(absentFields(answeringOtherNames.answerHeldGate(), CALL_ROW_FIELDS.answerHeldGate()), ['answered', 'reason'],
    'a leg that answers { ok, why } answers nothing the core reads')
})


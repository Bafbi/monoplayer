// #17/#18: the puppet's own client identity on the backend leg.
//
// #17: the puppet announces the Fabric Loader brand in the configuration
// phase, once per backend connection, and the human's brand never replaces it.
// #18: the puppet requests the view distance the backend advertises in its play
// login (the server's cap), the chunk cache is raised to hold that view, and
// the human's locale, skin parts, main hand, and chat settings reach the server
// when the human attaches.
//
// Every assertion here is on an external effect: the frames written to the
// backend leg and the cache's reported state. Nothing reaches into a helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMonoplayer, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { createStateCache } from '../../src/core/state-cache.js'
import {
  FABRIC_BRAND,
  brandFrame,
  decodeBrand,
  chunkBoundFor,
  capFromLogin,
  mergeClientSettings,
  normalizeClientSettings
} from '../../src/core/client-settings.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) { const t = { fn, fires: now + ms }; timers.push(t); return t },
    clearTimeout (t) { timers = timers.filter(x => x !== t) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

function makeCore (overrides = {}) {
  const clock = overrides.clock ?? fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER],
      ...(overrides.config ?? {})
    },
    backendLeg,
    frontLeg,
    clock,
    logStream: overrides.logStream ?? null
  })
  core.start()
  return { clock, backendLeg, frontLeg, core }
}

// Scripted warmup: configuration frames, then the play join prefix ending at
// the warm marker. `viewDistance` is the backend's advertised cap.
function warmBackend ({ backendLeg, core }, { viewDistance = 10 } = {}) {
  for (const frame of [
    { name: 'registry_data', data: {} },
    { name: 'select_known_packs', data: {} }
  ]) backendLeg.deliver({ state: 'configuration', ...frame })

  const login = { entityId: 42 }
  if (viewDistance !== null) login.viewDistance = viewDistance
  backendLeg.deliver({ state: 'play', name: 'login', data: login })
  for (const frame of [
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backendLeg.deliver({ state: 'play', ...frame })

  assert.equal(core.session.state, 'warm')
}

const writes = (backendLeg, name) => backendLeg.packetWrites().filter(entry => entry.name === name)

function attach (rig) {
  const decision = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(decision.allowed, true, 'attach allowed')
  return rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
}

// --- the wire shape -------------------------------------------------------

test('the brand frame is minecraft:brand carrying the Fabric Loader string', () => {
  const frame = brandFrame()
  assert.equal(frame.name, 'custom_payload')
  assert.equal(frame.packet.channel, 'minecraft:brand')
  assert.equal(Buffer.isBuffer(frame.packet.data), true)
  assert.equal(decodeBrand(frame.packet.data), FABRIC_BRAND)
  assert.equal(FABRIC_BRAND, 'fabric', 'Fabric Loader announces itself as "fabric"')
  // A varint length prefix, then UTF-8 (the vanilla string type).
  assert.equal(frame.packet.data[0], FABRIC_BRAND.length)
  assert.equal(frame.packet.data.subarray(1).toString('utf8'), FABRIC_BRAND)
})

test('a long brand string keeps a correct varint length prefix', () => {
  const name = 'x'.repeat(200)
  const payload = brandFrame(name).packet.data
  assert.equal(payload[0], 0xc8)
  assert.equal(payload[1], 0x01)
  assert.equal(decodeBrand(payload), name)
})

test('chunk bound covers the view distance square plus one ring for unload overlap', () => {
  assert.equal(chunkBoundFor(10), 23 ** 2)
  assert.equal(chunkBoundFor(16), 35 ** 2)
  assert.equal(chunkBoundFor(0), 9)
  assert.equal(chunkBoundFor(-1), null)
  assert.equal(chunkBoundFor('16'), null)
})

test('the view-distance cap comes only from a positive integer login field', () => {
  assert.equal(capFromLogin({ viewDistance: 16 }), 16)
  assert.equal(capFromLogin({ viewDistance: 32 }), 32)
  assert.equal(capFromLogin({}), null)
  assert.equal(capFromLogin({ viewDistance: 0 }), null)
  assert.equal(capFromLogin({ viewDistance: -4 }), null)
  assert.equal(capFromLogin({ viewDistance: '16' }), null)
  assert.equal(capFromLogin(null), null)
})

test('merged settings keep the backend cap and adopt the human fields', () => {
  const human = normalizeClientSettings({
    locale: 'fr_fr', viewDistance: 2, chatFlags: 1, chatColors: false,
    skinParts: 96, mainHand: 0, enableTextFiltering: true, enableServerListing: false
  })
  const merged = mergeClientSettings(human, 16)
  assert.equal(merged.viewDistance, 16, 'the backend cap wins over the human render distance')
  assert.equal(merged.locale, 'fr_fr')
  assert.equal(merged.chatFlags, 1)
  assert.equal(merged.chatColors, false)
  assert.equal(merged.skinParts, 96)
  assert.equal(merged.mainHand, 0)
  assert.equal(merged.enableTextFiltering, true)
  assert.equal(merged.enableServerListing, false)
  assert.equal(merged.particleStatus, 'all', 'unset human fields keep the vanilla default')
})

test('an empty or malformed client information falls back to the vanilla defaults', () => {
  assert.equal(mergeClientSettings(null, 16).locale, 'en_us')
  assert.equal(mergeClientSettings(null, 16).skinParts, 127)
  assert.equal(mergeClientSettings(null, 16).mainHand, 1)
  assert.equal(normalizeClientSettings({}), null)
  assert.equal(normalizeClientSettings({ locale: 5, viewDistance: 'x' }), null)
  assert.equal(normalizeClientSettings({ locale: 'fr_fr' }).viewDistance, 10)
})

// --- #17: the brand -------------------------------------------------------

test('#17 the puppet announces the Fabric brand once, in configuration', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig.backendLeg.deliver({ state: 'configuration', name: 'select_known_packs', data: {} })

  const brands = writes(rig.backendLeg, 'custom_payload')
  assert.equal(brands.length, 1, 'exactly one brand per backend connection')
  assert.equal(brands[0].packet.channel, 'minecraft:brand')
  assert.equal(decodeBrand(brands[0].packet.data), 'fabric')
  assert.equal(rig.core.metrics.brandAnnounced, 1)
})

test('#17 the brand is re-announced on the next backend connection', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  warmBackend(rig)

  // A backend fault: the session arms a reconnect and the adapter reconnects.
  rig.backendLeg.deliverEnd({ reason: 'backend_restart' })
  rig.clock.tick(1000)
  rig.core.session.backendConnecting({ initial: false })
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })

  const brands = writes(rig.backendLeg, 'custom_payload')
  assert.equal(brands.length, 2, 'one brand per connection, never two on one')
})

test('#17 a play-state-only connection announces no brand', () => {
  const rig = makeCore()
  // No configuration frame seen: nothing announced. The brand belongs to the
  // configuration phase, not to a play leg that never had one.
  warmBackend(rig)
  const before = writes(rig.backendLeg, 'custom_payload').length
  rig.backendLeg.deliver({ state: 'play', name: 'game_state_change', data: { reason: 13, gameMode: 0 } })
  assert.equal(before, 1, 'the configuration frame announced it')
  assert.equal(writes(rig.backendLeg, 'custom_payload').length, before)
})

test('#17 the human client brand never replaces the puppet brand', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  warmBackend(rig)
  attach(rig)
  // A front client's brand belongs to its own connection. Even when a
  // serverbound brand frame reaches the core, the backend sees only Fabric.
  rig.frontLeg.serverbound({
    state: 'play',
    name: 'custom_payload',
    buffer: Buffer.from('client:custom_payload'),
    data: { channel: 'minecraft:brand', data: Buffer.from([7, 118, 97, 110, 105, 108, 108, 97]) }
  })
  const brands = writes(rig.backendLeg, 'custom_payload')
  assert.equal(brands.length, 1, 'only the puppet announced a brand')
  assert.deepEqual(brands.map(entry => decodeBrand(entry.packet.data)), [FABRIC_BRAND])
  assert.equal(
    rig.backendLeg.rawWrites().some(entry => entry.buffer?.toString() === 'client:custom_payload'),
    false,
    'the human brand channel never reaches the backend raw')
  assert.equal(rig.core.metrics.serverboundDroppedByName.custom_payload, 1)
})

// --- #18: view distance and client information ----------------------------

test('#18 the puppet requests the backend view distance after play login', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: 16 })

  const settings = writes(rig.backendLeg, 'settings')
  assert.equal(settings.length, 1, 'one client information write per backend login')
  assert.equal(settings[0].packet.viewDistance, 16, 'the server cap, not the local default')
  assert.equal(settings[0].packet.locale, 'en_us', 'a vanilla default with no human attached')
  assert.equal(rig.core.metrics.clientSettingsSent, 1)
})

test('#18 no cap in the login means no client information write', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: null })
  assert.equal(writes(rig.backendLeg, 'settings').length, 0)
  assert.equal(rig.core.metrics.clientSettingsSent, 0)
})

test('#18 the chunk cache is raised to hold the backend view distance', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: 16 })

  const bound = chunkBoundFor(16)
  for (let i = 0; i < bound; i++) {
    rig.backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: i, z: 0 } })
  }
  const stats = rig.core.cache.stats()
  assert.equal(stats.chunkBound, bound)
  assert.equal(stats.sizes.chunks, bound, 'every chunk of the view is still replayable')
  assert.equal(stats.metrics.overflows.chunk, 0)
  assert.equal(stats.chunkBytes > 0, true, 'the memory the ring holds is reported')
})

test('#18 a chunk beyond the raised bound is the first to be evicted', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: 16 })
  const bound = chunkBoundFor(16)
  for (let i = 0; i < bound + 1; i++) {
    rig.backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: i, z: 0 } })
  }
  const stats = rig.core.cache.stats()
  assert.equal(stats.sizes.chunks, bound)
  assert.equal(stats.metrics.overflows.chunk, 1)
})

test('#18 the human client information reaches the backend when attached', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: 16 })
  rig.core.noteClientSettings({
    locale: 'fr_fr', viewDistance: 2, chatFlags: 0, chatColors: true,
    skinParts: 96, mainHand: 0, enableTextFiltering: false, enableServerListing: true
  })
  attach(rig)

  const settings = writes(rig.backendLeg, 'settings')
  const last = settings[settings.length - 1]
  assert.equal(last.packet.locale, 'fr_fr')
  assert.equal(last.packet.skinParts, 96)
  assert.equal(last.packet.mainHand, 0)
  assert.equal(last.packet.viewDistance, 16, 'the human render distance never lowers the server cap')
})

test('#18 a human settings change in play is rewritten, never relayed raw', () => {
  const rig = makeCore()
  warmBackend(rig, { viewDistance: 16 })
  attach(rig)
  const before = writes(rig.backendLeg, 'settings').length

  rig.frontLeg.serverbound({
    state: 'play',
    name: 'settings',
    buffer: Buffer.from('client:settings'),
    data: { locale: 'de_de', viewDistance: 2, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true }
  })

  const settings = writes(rig.backendLeg, 'settings')
  assert.equal(settings.length, before + 1, 'one rewritten client information frame')
  const last = settings[settings.length - 1]
  assert.equal(last.packet.locale, 'de_de')
  assert.equal(last.packet.viewDistance, 16, 'the cap holds through a human change')
  assert.equal(
    rig.frontLeg.frames().some(entry => entry.kind === 'raw' && entry.buffer?.toString() === 'client:settings'),
    false,
    'the client frame is rewritten, not forwarded')
  assert.equal(rig.core.metrics.clientSettingsRewritten, 1)
})

test('#18 the cache raise is sticky across a reconnect and never lowers', () => {
  const cache = createStateCache({ maxChunks: 4 })
  assert.equal(cache.raiseChunkBound(100), 100)
  assert.equal(cache.raiseChunkBound(50), 100)
  cache.reset()
  assert.equal(cache.stats().chunkBound, 100, 'reset keeps the raised bound')
})

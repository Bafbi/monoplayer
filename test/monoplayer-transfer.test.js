// Clientbound containment: a backend transfer can never move the attached
// client off the proxy, and a server reconfiguration recovers through the
// normal backend-down path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, DEFAULT_CONFIG } from '../src/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../src/monoplayer/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const BUFFER = name => Buffer.from(`backend:${name}`)

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

function makeCore (config = {}) {
  const clock = fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER],
      ...config
    },
    backendLeg,
    frontLeg,
    clock
  })
  core.start()
  return { clock, backendLeg, frontLeg, core }
}

function warmBackend ({ backendLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  for (const frame of [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backendLeg.deliver({ state: 'play', ...frame })
  assert.equal(core.cache.warm, true)
}

function attach ({ frontLeg, core }) {
  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  const result = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(result.attached, true)
  return result
}

const transfer = () => ({
  name: 'transfer',
  buffer: BUFFER('transfer'),
  data: { host: 'sky-2.excalia.fr', port: 25565 }
})

test('a transfer while attached never reaches the client, is not cached, and notifies once', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...transfer() })

  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['system_chat'], 'only the local notice crosses')
  const notice = live[0].packet.content.value.text.value
  assert.match(notice, /blocked/i)
  assert.match(notice, /stay on the current server/i)
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.core.metrics.clientboundBlocked, 1)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'transfer'), false)

  // A second transfer is still blocked but does not repeat the notice.
  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  const after = rig.frontLeg.frames().slice(before)
  assert.equal(after.filter(f => f.name === 'system_chat').length, 1)
  assert.equal(rig.core.metrics.transfersBlocked, 2)
})

test('a transfer while detached is never cached or replayed into a later attach', () => {
  const rig = makeCore()
  warmBackend(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.frontLeg.frames().length, 0, 'no client, no notice')
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'transfer'), false)

  attach(rig)
  const replayed = rig.frontLeg.frames().map(f => f.name)
  assert.equal(replayed.includes('transfer'), false)
  assert.equal(replayed.includes('system_chat'), false, 'the notice is live only')
})

test('start_configuration ends the backend leg and the client with a reconnect reason', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', name: 'start_configuration', buffer: BUFFER('start_configuration'), data: {} })
  assert.equal(rig.backendLeg.ended, 1, 'the puppet leg is ended on purpose')
  assert.equal(rig.core.metrics.clientboundBlocked, 1)
  assert.equal(rig.core.session.state, 'attached', 'the end handler has not fired yet')

  rig.backendLeg.deliverEnd({ reason: 'backend_reconfigure' })
  assert.equal(rig.core.cache.warm, false, 'the dead session cache is reset')
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect')
  const reason = rig.frontLeg.endReasons().at(-1)?.reason
  assert.match(String(reason), /reconfigured this session/i)
})

test('connection-control frames are blocked in both states', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  for (const name of ['kick_disconnect', 'cookie_request', 'store_cookie', 'show_dialog', 'clear_dialog', 'player_chat', 'hide_message']) {
    rig.backendLeg.deliver({ state: 'play', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)

  for (const name of ['transfer', 'disconnect', 'cookie_request', 'store_cookie', 'show_dialog', 'clear_dialog', 'code_of_conduct']) {
    rig.backendLeg.deliver({ state: 'configuration', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.cache.snapshot().config.length, 1, 'only registry_data was cacheable')
  assert.equal(rig.core.cache.snapshot().generic.some(f => ['show_dialog', 'store_cookie'].includes(f.name)), false)
})

test('login is cached for replay but never relayed into a live session', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', name: 'login', buffer: BUFFER('login'), data: { entityId: 42 } })
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'login'), true)
})

test('ping_response is relayed live but never cached', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', name: 'ping_response', buffer: BUFFER('ping_response'), data: { id: 7n } })
  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['ping_response'])
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'ping_response'), false)
})

test('configuration transfer is blocked and configuration ping is answered per-leg', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })

  rig.backendLeg.deliver({ state: 'configuration', name: 'transfer', buffer: BUFFER('transfer'), data: { host: 'x.invalid', port: 1 } })
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.frontLeg.frames().length, 0)
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'transfer'), false)

  rig.backendLeg.deliver({ state: 'configuration', name: 'ping', buffer: BUFFER('ping'), data: { id: 7 } })
  const pong = rig.backendLeg.packetWrites().find(p => p.name === 'pong' && p.packet.id === 7)
  assert.ok(pong, 'the puppet leg answers its own configuration ping')
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'ping'), false)
})

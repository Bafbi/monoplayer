// Transfer handling: the frame never crosses to the front; the puppet follows
// the target on the next reconnect, or refuses with a local notice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

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
      ...config,
      transfer: { ...DEFAULT_CONFIG.transfer, ...(config.transfer ?? {}) }
    },
    backendLeg,
    frontLeg,
    clock
  })
  core.start()
  const events = []
  core.on('reconnect_due', event => events.push(event))
  return { clock, backendLeg, frontLeg, core, events }
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

function transfer (host = 'sky-2.excalia.fr', port = 25565) {
  return { name: 'transfer', buffer: BUFFER('transfer'), data: { host, port } }
}

test('a followed transfer never reaches the client and dials the target next', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const framesBefore = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...transfer() })

  assert.equal(rig.frontLeg.frames().length, framesBefore, 'the transfer frame never crosses')
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.backendLeg.ended, 1, 'the old backend leg is ended')
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.cache.warm, false, 'the old session cache is gone')
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect')
  assert.match(String(rig.frontLeg.endReasons().at(-1)?.reason), /moving/i)

  rig.clock.tick(1000)
  assert.equal(rig.events.length, 1)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
})

test('a followed transfer while detached still moves the puppet and sends no notice', () => {
  const rig = makeCore()
  warmBackend(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.frontLeg.frames().length, 0)
  assert.equal(rig.frontLeg.endReasons().length, 0)
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.cache.snapshot().generic.some(frame => frame.name === 'transfer'), false)

  rig.clock.tick(1000)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
})

test('follow disabled keeps the session and sends the refusal notice', () => {
  const rig = makeCore({ transfer: { follow: false } })
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.core.metrics.transfersFollowed, 0)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 0)
  assert.equal(rig.core.session.state, 'attached')
  const notice = rig.frontLeg.frames().at(-1)
  assert.equal(notice.name, 'system_chat')
  assert.match(notice.packet.content.value.text.value, /could not follow/i)
})

test('an invalid target is refused without ending the session', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', name: 'transfer', buffer: BUFFER('transfer'), data: { host: '', port: 0 } })
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 0)
  assert.equal(rig.frontLeg.frames().at(-1).name, 'system_chat')
})

test('a repeated target is refused as a loop after a re-warm', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('sky-2.excalia.fr', 25565) })
  rig.clock.tick(1000)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })

  // The new session comes up on the target, warms, and the user reattaches.
  warmBackend(rig)
  attach(rig)
  rig.backendLeg.deliver({ state: 'play', ...transfer('sky-2.excalia.fr', 25565) })

  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 1, 'the refused transfer does not end the leg again')
  assert.equal(rig.frontLeg.frames().at(-1).name, 'system_chat')
})

test('the chain limit refuses the hop beyond it', () => {
  const rig = makeCore({ transfer: { chainLimit: 1 } })
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('a.excalia.fr', 25565) })
  rig.clock.tick(1000)
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('b.excalia.fr', 25565) })
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.frontLeg.frames().at(-1).name, 'system_chat')
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
  for (const name of ['kick_disconnect', 'cookie_request', 'store_cookie', 'hide_message']) {
    rig.backendLeg.deliver({ state: 'play', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)

  for (const name of ['disconnect', 'cookie_request', 'store_cookie']) {
    rig.backendLeg.deliver({ state: 'configuration', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.cache.snapshot().config.length, 1, 'only registry_data was cacheable')
  assert.equal(rig.core.cache.snapshot().generic.some(f => ['show_dialog', 'store_cookie'].includes(f.name)), false)
})

test('#16 a control dialog crosses while connection control stays contained', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)
  const before = rig.frontLeg.frames().length

  // Play dialogs reach the human (#16). A configuration gate does not: this
  // client is in play, so the gate waits for a client in configuration.
  for (const name of ['show_dialog', 'clear_dialog']) {
    rig.backendLeg.deliver({ state: 'play', name, buffer: BUFFER(name), data: {} })
  }
  rig.backendLeg.deliver({ state: 'configuration', name: 'code_of_conduct', buffer: BUFFER('coc'), data: {} })

  const crossed = rig.frontLeg.frames().slice(before).map(frame => frame.name)
  assert.deepEqual(crossed, ['show_dialog', 'clear_dialog'])
  // A dialog is neither ordinary state nor an attach replay: the pending
  // holder keeps the one copy, so a replay can never deliver a stale one.
  const snapshot = rig.core.cache.snapshot()
  const cachedNames = [
    ...snapshot.config, ...snapshot.generic, ...snapshot.latest
  ].map(frame => frame.name)
  assert.equal(cachedNames.some(name => ['show_dialog', 'clear_dialog', 'code_of_conduct'].includes(name)), false)
  assert.equal(rig.core.pendingDialog.peek().name, 'code_of_conduct', 'the withheld gate is still pending')
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
  assert.equal(rig.core.metrics.transfersFollowed, 0, 'v1 does not follow configuration transfers')
  assert.equal(rig.frontLeg.frames().length, 0)
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'transfer'), false)

  rig.backendLeg.deliver({ state: 'configuration', name: 'ping', buffer: BUFFER('ping'), data: { id: 7 } })
  const pong = rig.backendLeg.packetWrites().find(p => p.name === 'pong' && p.packet.id === 7)
  assert.ok(pong, 'the puppet leg answers its own configuration ping')
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'ping'), false)
})

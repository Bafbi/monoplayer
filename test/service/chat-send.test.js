// #19: the human's chat and commands are spoken by the puppet leg.
//
// The attached client's own chat never crosses to the backend as a frame: its
// signature belongs to the human's profile and its last-seen window belongs to
// the front connection. Instead the core hands the text to the backend leg,
// which signs and sends it as the puppet (GlowSquidye) with the puppet's own
// profile keys and its own window.
//
// The server's signed chat comes back to the human, so they can follow the
// conversation. It is relayed live and never cached: a fresh join after a
// transfer must not replay it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const BUFFER = name => Buffer.from(`backend:${name}`)

function fakeClock () {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) { const t = { fn, fires: now + ms }; timers.push(t); return t },
    clearTimeout (t) { timers.splice(timers.indexOf(t), 1) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      for (const t of due) timers.splice(timers.indexOf(t), 1)
      for (const t of due) t.fn()
    }
  }
}

function makeCore (config = {}) {
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
    clock: fakeClock()
  })
  core.start()
  return { backendLeg, frontLeg, core }
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
  const decision = frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(decision.allowed, true, JSON.stringify(decision))
  return core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
}

const signedPlayerChat = (text = 'hello everyone') => ({
  name: 'player_chat',
  buffer: BUFFER('player_chat'),
  data: {
    globalIndex: 7,
    index: 0,
    sender: '6f8b2f2c-1b52-4a3f-9a4e-6c7f0d5b1a11',
    plainMessage: text,
    signature: Buffer.alloc(256)
  }
})

test('the attached client chat is spoken by the puppet leg, not forwarded raw', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)
  attach(rig)

  rig.frontLeg.serverbound({ name: 'chat_message', data: { message: 'hello everyone' } })

  assert.deepEqual(rig.backendLeg.spoken(), [{ text: 'hello everyone', command: false }])
  assert.equal(rig.core.metrics.chatSent, 1)
  assert.equal(rig.core.metrics.chatBlocked, 0)
  assert.deepEqual(rig.backendLeg.rawWrites(), [], 'the client frame never crosses to the backend')
})

test('the attached client command is spoken by the puppet leg as a command', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)
  attach(rig)

  rig.frontLeg.serverbound({ name: 'chat_command', data: { command: 'msg Bafbi good game' } })

  assert.deepEqual(rig.backendLeg.spoken(), [{ text: '/msg Bafbi good game', command: true }])
  assert.equal(rig.core.metrics.chatSent, 1)
})

test('a signed command frame is spoken once, as one command', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)
  attach(rig)

  rig.frontLeg.serverbound({ name: 'chat_command_signed', data: { command: 'tp 0 70 0' } })

  assert.deepEqual(rig.backendLeg.spoken(), [{ text: '/tp 0 70 0', command: true }])
})

test('chat sent while no client is attached is not spoken', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)

  rig.frontLeg.serverbound({ name: 'chat_message', data: { message: 'detached' } })

  assert.deepEqual(rig.backendLeg.spoken(), [])
  assert.equal(rig.core.metrics.chatSent, 0)
})

test('the read-only and off modes never speak for the client', () => {
  for (const chat of ['read-only', 'off']) {
    const rig = makeCore({ chat })
    warmBackend(rig)
    attach(rig)
    rig.frontLeg.serverbound({ name: 'chat_message', data: { message: 'hi' } })
    rig.frontLeg.serverbound({ name: 'chat_command', data: { command: 'list' } })
    assert.deepEqual(rig.backendLeg.spoken(), [], `${chat} mode spoke`)
  }
})

test('session keys and acknowledgements stay on the front connection', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)
  attach(rig)

  rig.frontLeg.serverbound({ name: 'chat_session_update', data: { sessionUUID: PLAYER } })
  rig.frontLeg.serverbound({ name: 'chat_ack', data: { count: 1 } })
  rig.frontLeg.serverbound({ name: 'message_acknowledgement', data: { count: 1 } })

  assert.deepEqual(rig.backendLeg.rawWrites(), [], 'no human session key or ack reaches the backend')
  assert.deepEqual(rig.backendLeg.spoken(), [])
  assert.equal(rig.core.metrics.chatBlocked, 2, 'the session key and the chat ack are blocked chat')
  assert.equal(rig.core.metrics.serverboundDropped, 3)
})

test('the server signed chat reaches the human and is never cached', () => {
  const rig = makeCore({ chat: 'full' })
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...signedPlayerChat('good game') })

  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['player_chat'])
  assert.equal(live[0].buffer.toString(), 'backend:player_chat')
  assert.equal(rig.core.metrics.chatRelayed, 1)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'player_chat'), false)
  assert.equal(rig.core.cache.snapshot().prefix.some(f => f.name === 'player_chat'), false)
})

test('the full chat mode is a valid mode and the default', () => {
  assert.equal(loadConfig().chat, 'full')
  assert.equal(loadConfig({ chat: 'full' }).chat, 'full')
  assert.equal(loadConfig({ chat: 'read-only' }).chat, 'read-only')
  assert.throws(() => loadConfig({ chat: 'write' }), /config\.chat/)
})

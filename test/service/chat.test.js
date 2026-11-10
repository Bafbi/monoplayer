// B1 target: clientbound chat relay. Clientbound chat reaches the attached
// client live and is never cached or replayed. The human's own text is spoken
// as the puppet rather than forwarded, which test/service/chat-send.test.js
// pins (#19).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/service/monoplayer.js'
import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const BUFFER = name => Buffer.from(`backend:${name}`)

// Configuration prefix plus the play join prefix through the warm marker.
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

const systemChat = (text = 'hello') => ({
  name: 'system_chat',
  buffer: BUFFER(`system_chat:${text}`),
  data: {
    content: { type: 'compound', value: { text: { type: 'string', value: text } } },
    isActionBar: false
  }
})

test('read-only chat relays system_chat live and never caches it', () => {
  const rig = makeCore({ config: { chat: 'read-only' } })
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...systemChat('hello') })

  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['system_chat'])
  assert.equal(live[0].buffer.toString(), 'backend:system_chat:hello')
  assert.equal(rig.core.metrics.chatRelayed, 1)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'system_chat'), false)
  assert.equal(rig.core.cache.snapshot().prefix.some(f => f.name === 'system_chat'), false)
})

test('read-only chat relays profileless_chat (unsigned player chat)', () => {
  const rig = makeCore({ config: { chat: 'read-only' } })
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({
    state: 'play',
    name: 'profileless_chat',
    buffer: BUFFER('profileless_chat'),
    data: { name: { type: 'compound', value: { text: { type: 'string', value: 'Bafbi' } } } }
  })

  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['profileless_chat'])
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'profileless_chat'), false)
})

test('signed player_chat stays blocked in read-only mode', () => {
  const rig = makeCore({ config: { chat: 'read-only' } })
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({
    state: 'play',
    name: 'player_chat',
    buffer: BUFFER('player_chat'),
    data: { globalIndex: 5, index: 5, plainMessage: 'signed', signature: Buffer.alloc(256) }
  })

  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.metrics.chatRelayed, 0)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'player_chat'), false)
})

test('chat sent while detached is not replayed on the next attach', () => {
  const rig = makeCore({ config: { chat: 'read-only' } })
  warmBackend(rig)

  rig.backendLeg.deliver({ state: 'play', ...systemChat('while detached') })
  assert.equal(rig.core.metrics.chatRelayed, 1, 'counted even with no client attached')
  assert.equal(rig.frontLeg.frames().length, 0, 'no client, no frame')

  attach(rig)
  const replayed = rig.frontLeg.frames().map(f => f.name)
  assert.equal(replayed.includes('system_chat'), false)
  assert.equal(replayed.includes('profileless_chat'), false)
})

test('serverbound chat and chat acknowledgements never reach the backend', () => {
  const rig = makeCore({ config: { chat: 'read-only' } })
  warmBackend(rig)
  attach(rig)

  for (const name of ['chat_message', 'chat_command', 'chat_command_signed', 'chat_session_update', 'chat_ack']) {
    rig.frontLeg.serverbound({ name, data: { message: 'hi' } })
  }
  rig.frontLeg.serverbound({ name: 'message_acknowledgement', data: { count: 3 } })

  assert.equal(rig.backendLeg.rawWrites().length, 0)
  assert.equal(rig.core.metrics.chatBlocked, 5)
  assert.equal(rig.core.metrics.serverboundDropped, 6)
})

test('chat off drops clientbound chat as before', () => {
  const rig = makeCore({ config: { chat: 'off' } })
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...systemChat('off') })
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.metrics.chatRelayed, 0)
})

test('the chat mode is validated', () => {
  assert.equal(loadConfig().chat, 'read-only')
  assert.equal(loadConfig({ chat: 'off' }).chat, 'off')
  assert.equal(loadConfig({ chat: 'commands' }).chat, 'commands')
  assert.throws(() => loadConfig({ chat: 'write' }), /config\.chat/)
})

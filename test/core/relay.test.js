// B1 target: relay drop rules and pose capture (pure decisions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POSE_FRAME_NAMES,
  classifyServerbound,
  capturePose,
  chatText,
  isPoseFrame,
  CHAT_SERVERBOUND,
  speaks,
  CLIENT_IDENTITY_CHANNELS,
  CONFIG_SERVERBOUND_DROPS,
  SERVERBOUND_DROPS,
  SERVERBOUND_REWRITE
} from '../../src/core/relay.js'

test('#636 the frames that carry where a client is are the ones capturePose reads', () => {
  // #636: two sources read a pose — the body's own client over the relay, and a spectator's
  // client at the front, whose frame is dropped after its position is taken. One list, so a
  // caller that has to tell a movement frame from the rest asks the module that reads it.
  assert.deepEqual([...POSE_FRAME_NAMES].sort(), ['look', 'position', 'position_look'])
  const before = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
  for (const name of POSE_FRAME_NAMES) {
    assert.equal(isPoseFrame(name), true, name)
    const after = capturePose(before, name, { x: 1, y: 2, z: 3, yaw: 90, pitch: 45 })
    assert.notDeepEqual(after, before, 'the frame the list names is a frame capturePose changes: ' + name)
  }
  // A frame a client sends that carries no position is not on the list, and reading one
  // would invent a pose out of a packet that has none.
  for (const name of ['flying', 'chat_message', 'settings', 'entity_action', 'keep_alive']) {
    assert.equal(isPoseFrame(name), false, name)
    assert.deepEqual(capturePose(before, name, { x: 1, y: 2, z: 3 }), before,
      'and capturePose leaves the pose alone for it: ' + name)
  }
})

test('per-leg connection mechanics drop serverbound', () => {
  for (const name of ['teleport_confirm', 'keep_alive', 'configuration_acknowledged', 'chunk_batch_received', 'cookie_response', 'pong', 'message_acknowledgement']) {
    assert.equal(classifyServerbound(name).action, 'drop', name)
    assert.equal(classifyServerbound(name).chat, false, name)
  }
})

test('#16 a configuration answer forwards, the front-owned handshake drops', () => {
  // The frames the human's own connection answers are per-leg; the frames that
  // answer something the puppet's backend asked are the whole point.
  for (const name of ['custom_click_action', 'accept_code_of_conduct']) {
    assert.equal(classifyServerbound(name, null, { state: 'configuration' }).action, 'forward', name)
  }
  for (const name of CONFIG_SERVERBOUND_DROPS) {
    const decision = classifyServerbound(name, null, { state: 'configuration' })
    assert.equal(decision.action, 'drop', name)
    assert.equal(decision.reason, 'front_owned_config_handshake', name)
  }
  // The state is what decides: in play, `settings` is still rewritten, not dropped.
  assert.equal(classifyServerbound('settings').action, 'rewrite')
})

test('the human chat text is spoken as the puppet in full mode', () => {
  for (const name of ['chat_message', 'chat_command', 'chat_command_signed']) {
    assert.equal(CHAT_SERVERBOUND.has(name), true, name)
    const d = classifyServerbound(name, null, { mode: 'full' })
    assert.equal(d.action, 'speak', name)
    assert.equal(d.chat, true, name)
    assert.equal(d.reason, 'human_chat')
  }
})

test('the read-only and off modes drop the chat text and count it as chat', () => {
  for (const mode of ['read-only', 'off']) {
    for (const name of ['chat_message', 'chat_command', 'chat_command_signed', 'chat_session_update', 'chat_ack']) {
      const d = classifyServerbound(name, null, { mode })
      assert.equal(d.action, 'drop', `${mode} ${name}`)
      assert.equal(d.chat, true, `${mode} ${name}`)
    }
  }
})

test('#97 the commands mode speaks the command frames and drops the chat message', () => {
  // The human can run /profil, /msg, /tp without the account speaking in open
  // chat. The command family crosses; the plain message does not.
  for (const name of ['chat_command', 'chat_command_signed']) {
    assert.equal(CHAT_SERVERBOUND.has(name), true, name)
    const d = classifyServerbound(name, null, { mode: 'commands' })
    assert.equal(d.action, 'speak', name)
    assert.equal(d.chat, true, name)
    assert.equal(d.reason, 'human_chat', name)
  }
  const message = classifyServerbound('chat_message', null, { mode: 'commands' })
  assert.equal(message.action, 'drop', 'chat_message')
  assert.equal(message.chat, true, 'chat_message')
  // The full mode keeps speaking all three: the fourth mode sits beside it.
  assert.equal(classifyServerbound('chat_message', null, { mode: 'full' }).action, 'speak')
})

test('#97 speaks answers by mode and fails closed on a mode it does not know', () => {
  assert.equal(speaks('chat_message', 'full'), true)
  assert.equal(speaks('chat_command', 'full'), true)
  assert.equal(speaks('chat_command', 'commands'), true)
  assert.equal(speaks('chat_command_signed', 'commands'), true)
  assert.equal(speaks('chat_message', 'commands'), false, 'the command mode never speaks open chat')
  for (const mode of ['read-only', 'off', undefined, 'write']) {
    assert.equal(speaks('chat_command', mode), false, String(mode))
  }
  // A prototype key is a missing mode, not a lookup that throws.
  for (const mode of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(speaks('chat_command', mode), false, mode)
  }
  assert.equal(speaks('keep_alive', 'full'), false, 'only chat frames speak')
})

test('the session key and the chat ack drop in every mode', () => {
  for (const mode of ['full', 'commands', 'read-only', 'off']) {
    for (const name of ['chat_session_update', 'chat_ack']) {
      const d = classifyServerbound(name, null, { mode })
      assert.equal(d.action, 'drop', `${mode} ${name}`)
      assert.equal(d.chat, true, `${mode} ${name}`)
    }
  }
})

test('chatText returns the message, or the command with its slash', () => {
  assert.deepEqual(chatText('chat_message', { message: 'hi there' }), { text: 'hi there', command: false })
  assert.deepEqual(chatText('chat_command', { command: 'msg Bafbi gg' }), { text: '/msg Bafbi gg', command: true })
  assert.deepEqual(chatText('chat_command_signed', { command: '/tp 0 70 0' }), { text: '/tp 0 70 0', command: true })
  assert.equal(chatText('chat_message', { message: '' }), null)
  assert.equal(chatText('chat_message', {}), null)
  assert.equal(chatText('chat_command', { command: '/' }), null)
  assert.equal(chatText('keep_alive', { message: 'hi' }), null)
})

test('client information is rewritten, never forwarded or dropped', () => {
  assert.equal(SERVERBOUND_REWRITE.has('settings'), true)
  const decision = classifyServerbound('settings')
  assert.equal(decision.action, 'rewrite')
  assert.equal(decision.reason, 'client_identity')
  assert.equal(decision.chat, false)
})

test('a plugin channel that names the client is dropped, other channels forward', () => {
  assert.equal(CLIENT_IDENTITY_CHANNELS.has('minecraft:brand'), true)
  const brand = classifyServerbound('custom_payload', { channel: 'minecraft:brand', data: Buffer.from('vanilla') })
  assert.equal(brand.action, 'drop')
  assert.equal(brand.reason, 'client_identity_channel')
  const modChannel = classifyServerbound('custom_payload', { channel: 'example:mod_channel', data: Buffer.from('x') })
  assert.equal(modChannel.action, 'forward')
})

test('input and state frames forward to the backend', () => {
  for (const name of ['position', 'position_look', 'look', 'block_dig', 'block_place', 'held_item_slot', 'window_click']) {
    const d = classifyServerbound(name)
    assert.equal(d.action, 'forward', name)
    assert.equal(d.chat, false, name)
  }
})

test('pose capture: client movement writes position and look parts separately', () => {
  let pose = { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 }
  pose = capturePose(pose, 'position', { x: 2.5, y: 1.62, z: 3.5, onGround: true })
  assert.deepEqual(pose, { x: 2.5, y: 1.62, z: 3.5, yaw: 0, pitch: 0 })
  pose = capturePose(pose, 'look', { yaw: 90, pitch: 10 })
  assert.deepEqual(pose, { x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 })
  pose = capturePose(pose, 'position_look', { x: 4.5, y: 1.62, z: 3.5, yaw: 180, pitch: -5 })
  assert.deepEqual(pose, { x: 4.5, y: 1.62, z: 3.5, yaw: 180, pitch: -5 })
})

test('pose capture: backend teleport overrides everything (authoritative)', () => {
  const pose = capturePose({ x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 }, 'position',
    { x: 8.5, y: -61, z: 8.5, teleportId: 7, active: false },
    { backend: true })
  assert.deepEqual(pose, { x: 8.5, y: -61, z: 8.5, yaw: 90, pitch: 10 })
})

test('pose capture: garbage data tolerated, pose unchanged', () => {
  const pose = { x: 1, y: 2, z: 3, yaw: 4, pitch: 5 }
  assert.deepEqual(capturePose(pose, 'position', {}), pose)
  assert.deepEqual(capturePose(pose, 'look', { yaw: 'oops' }), pose)
  assert.deepEqual(capturePose(pose, 'unknown_frame', { x: 9 }), pose)
  assert.deepEqual(capturePose(pose, 'position', null), pose)
})

test('drop set matches the spike rules that stay (superset source of truth)', () => {
  // The spike dropped exactly these serverbound frames; B1 keeps them all.
  assert.equal(SERVERBOUND_DROPS.has('teleport_confirm'), true)
  assert.equal(SERVERBOUND_DROPS.size >= 12, true)
})

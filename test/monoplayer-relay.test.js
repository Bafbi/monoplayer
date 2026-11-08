// B1 target: relay drop rules and pose capture (pure decisions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyServerbound, capturePose, CHAT_SERVERBOUND, SERVERBOUND_DROPS } from '../src/monoplayer/relay.js'

test('per-leg connection mechanics drop serverbound', () => {
  for (const name of ['teleport_confirm', 'keep_alive', 'configuration_acknowledged', 'chunk_batch_received', 'cookie_response', 'resource_pack_receive', 'pong', 'message_acknowledgement']) {
    assert.equal(classifyServerbound(name).action, 'drop', name)
    assert.equal(classifyServerbound(name).chat, false, name)
  }
})

test('chat is blocked and counted as chat', () => {
  for (const name of ['chat_message', 'chat_command', 'chat_command_signed', 'chat_session_update', 'chat_ack']) {
    assert.equal(CHAT_SERVERBOUND.has(name), true, name)
    const d = classifyServerbound(name)
    assert.equal(d.action, 'drop')
    assert.equal(d.chat, true, name)
  }
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

test('drop set matches the Gate A spike rules that stay (superset source of truth)', () => {
  // Gate A dropped exactly these serverbound frames; B1 keeps them all.
  assert.equal(SERVERBOUND_DROPS.has('teleport_confirm'), true)
  assert.equal(SERVERBOUND_DROPS.size >= 12, true)
})

// B1 target: join-synth ordered attach stream (pure).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthAttach, synthBackendPosition, LEG_OWNED } from '../../src/core/join-synth.js'

const b = n => Buffer.from(`frame:${n}`)

function freshSnapshot () {
  const entry = (name, data = {}) => ({ name, buffer: b(name), data })
  return {
    config: [entry('registry_data'), entry('select_known_packs'), entry('keep_alive')],
    prefix: [
      entry('login', { entityId: 42 }),
      entry('game_state_change', { reason: 13 }),
      entry('position', { teleportId: 9 }), // backend position: NEVER replayed
      entry('chunk_batch_start'),
      entry('map_chunk', { x: 0, z: 0 }),
      entry('chunk_batch_finished')
    ],
    chunks: [entry('map_chunk', { x: 1, z: 0 })],
    blocks: [entry('block_update')],
    entities: [entry('entity_metadata', { entityId: 42 })],
    inventories: [entry('window_items', { windowId: 0 })],
    latest: [entry('health')],
    generic: [entry('bossbar')]
  }
}

const POSE = { x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 }

test('replay order: config replay prefix, join prefix, synthesized position, warm domains', () => {
  const { frames } = synthAttach({ snapshot: freshSnapshot(), pose: POSE, teleportId: 0 })

  const names = frames.map(f => f.name)
  assert.deepEqual(names, [
    'registry_data',
    'select_known_packs',
    'login',
    'game_state_change',
    'position', // synthesized
    'chunk_batch_start',
    'map_chunk',
    'chunk_batch_finished',
    'map_chunk', // warm chunk domain
    'block_update',
    'entity_metadata',
    'window_items',
    'health',
    'bossbar'
  ])

  // Exactly one position frame, synthesized at the current pose, with a fresh
  // proxy-owned teleportId.
  const positions = frames.filter(f => f.name === 'position')
  assert.equal(positions.length, 1)
  assert.equal(positions[0].synth, 'position')
  assert.equal(positions[0].packet.teleportId, 1)
  assert.equal(positions[0].packet.x, 2.5)
  assert.equal(positions[0].packet.y, 1.62)
  assert.equal(positions[0].packet.z, 3.5)
  assert.equal(positions[0].packet.yaw, 90)
  assert.equal(positions[0].packet.pitch, 10)
  assert.equal(frames.find(f => f.name === 'login').buffer.toString(), 'frame:login')
})

test('no replayed keep-alives, backend positions, or chat frames', () => {
  const shot = freshSnapshot()
  shot.prefix.push({ name: 'player_chat', buffer: b('chat'), data: {} })
  shot.prefix.push({ name: 'keep_alive', buffer: b('ka'), data: {} })
  shot.generic.push({ name: 'profileless_chat', buffer: b('pc'), data: {} })

  const { frames, counts } = synthAttach({ snapshot: shot, pose: POSE, teleportId: 0 })
  const names = frames.map(f => f.name)
  for (const name of ['keep_alive', 'player_chat', 'profileless_chat']) {
    assert.equal(names.filter(n => n === name).length, 0, name)
  }
  assert.equal(names.filter(n => n === 'position').length, 1) // only the synthesized one
  // skipped = config keep_alive + prefix position (of this snapshot) +
  // player_chat + prefix keep_alive + generic profileless_chat
  assert.equal(counts.skipped, 5) // cache should already have dropped these; synth double-checks
})

test('teleportId is monotonic across attaches (fresh per attach, never stale)', () => {
  const shot = freshSnapshot()
  const a = synthAttach({ snapshot: shot, pose: POSE, teleportId: 0 })
  const backPos = synthBackendPosition({
    backendPacket: { teleportId: 5, x: 8.5, y: 1.62, z: 8.5, yaw: 0, pitch: 0 },
    pose: POSE,
    teleportId: a.teleportId
  })
  const b2 = synthAttach({ snapshot: shot, pose: backPos.pose, teleportId: backPos.frame.packet.teleportId })

  assert.equal(b2.frames.find(f => f.name === 'position').packet.teleportId, 3)
  // Live synth of backend teleport follows a separate live path.
  assert.equal(backPos.frame.packet.x, 8.5)
  assert.deepEqual(backPos.pose, { x: 8.5, y: 1.62, z: 8.5, yaw: 0, pitch: 0 })
})

test('fallback: snapshot without chunk-bearing frames still synthesizes the pose', () => {
  const empty = {
    config: [], prefix: [{ name: 'login', buffer: b('login'), data: {} }],
    chunks: [], blocks: [], entities: [], inventories: [], latest: [], generic: []
  }
  const { frames } = synthAttach({ snapshot: empty, pose: POSE, teleportId: 7 })
  const last = frames.at(-1)
  assert.equal(last.name, 'position')
  assert.equal(last.packet.x, 2.5)
  assert.equal(last.packet.teleportId, 8)
})

test('LEG_OWNED is exactly the never-replayed set the plan demands', () => {
  for (const name of ['keep_alive', 'position', 'player_chat', 'profileless_chat', 'hide_message', 'system_chat', 'ping', 'pong']) {
    assert.equal(LEG_OWNED.has(name), true, name)
  }
})

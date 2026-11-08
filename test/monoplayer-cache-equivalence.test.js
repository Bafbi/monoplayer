// Property target: replay(cache(stream)) == stream.
//
// `stream` is the clientbound play sequence the backend sent after the join
// prefix warmed. `cache(stream)` is createStateCache's bounded per-domain
// rebuild, and `replay` is the same section order join-synth.synthAttach emits.
// The client-state model gives both sides the same shape, so a cache domain
// that keys or evicts the wrong frames fails here.
//
// Bounded FIFO domains (block, entity, generic) cannot replay state they
// evicted. For those streams the exact property is defined on the replayed
// suffix: replay(cache(stream)) == apply(tail(stream)), where tail is the
// frames the ring kept. The tests say which case they assert.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateCache } from '../src/monoplayer/state-cache.js'
import { synthAttach } from '../src/monoplayer/join-synth.js'
import {
  createClientState,
  applyFrames,
  stateSnapshot
} from '../src/ladder/client-state.js'

// The exact cross-domain order join-synth.synthAttach uses.
const SECTION_ORDER = ['config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic']

const empty = () => ({ itemCount: 0 })
const item = (itemId, itemCount = 1) => ({ itemCount, itemId })
const baseItems = (length = 46) => Array.from({ length }, empty)
const windowItems = (windowId, stateId, items) => ({
  name: 'window_items',
  data: { windowId, stateId, items }
})
const setSlot = (windowId, stateId, slot, slotItem) => ({
  name: 'set_slot',
  data: { windowId, stateId, slot, item: slotItem }
})

// Warm completes at the first chunk_batch_finished, so this prefix is pinned
// verbatim and every stream starts from a joined client.
function joinPrefix () {
  return [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: { batchSize: 1 } }
  ]
}

function buildCache (stream, overrides = {}) {
  const cache = createStateCache(overrides)
  stream.forEach((frame, index) => {
    cache.push('play', frame.name, Buffer.from(`${frame.name}:${index}`), frame.data ?? {})
  })
  return cache
}

function replayFrames (snapshot) {
  const frames = []
  for (const section of SECTION_ORDER) {
    for (const entry of snapshot[section] ?? []) {
      frames.push({ name: entry.name, data: entry.data ?? {} })
    }
  }
  return frames
}

function replayState (snapshot) {
  return applyFrames(createClientState(), replayFrames(snapshot))
}

// expectedFrames defaults to the whole stream; bounded domains pass the
// suffix the ring actually kept.
function assertEquivalent (stream, overrides = {}, expectedFrames = stream) {
  const cache = buildCache(stream, overrides)
  const snapshot = cache.snapshot()
  const replayed = replayState(snapshot)
  const expected = applyFrames(createClientState(), expectedFrames)
  assert.deepEqual(stateSnapshot(replayed), stateSnapshot(expected))
  return { cache, snapshot, replayed, expected }
}

test('replay equals the stream: inventory churn across a second window frame', () => {
  const items = baseItems()
  items[36] = item(1)
  items[37] = item(2)

  const stream = [
    ...joinPrefix(),
    windowItems(0, 1, items),
    setSlot(0, 1, 36, item(10)),
    setSlot(0, 1, 37, item(11)),
    setSlot(0, 1, 40, item(12)),
    windowItems(0, 2, baseItems()), // resets the whole window
    setSlot(0, 2, 36, item(13)),
    setSlot(0, 2, 41, item(14))
  ]

  const { snapshot, replayed } = assertEquivalent(stream)

  // The replay keeps the newest base and only the slot updates captured after
  // it. The first window and its three patches are superseded.
  assert.deepEqual(snapshot.inventories.map(frame => frame.name), ['window_items', 'set_slot', 'set_slot'])
  assert.deepEqual(snapshot.inventories.map(frame => frame.data.slot), [undefined, 36, 41])

  const window = stateSnapshot(replayed).windows.find(entry => entry.windowId === 0)
  const slots = Object.fromEntries(window.slots.map(slot => [slot.slot, slot.item]))
  assert.deepEqual(slots[36], item(13))
  assert.deepEqual(slots[41], item(14))
  assert.deepEqual(slots[37], empty()) // reset by the second window_items, was item(11)
})

test('replay equals the stream: chunk set, re-set, unload, set', () => {
  const stream = [
    ...joinPrefix(),
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'map_chunk', data: { x: 1, z: 0 } }, // re-set: latest wins
    // 26.1 decodes unload_chunk as chunkZ/chunkX.
    { name: 'unload_chunk', data: { chunkX: 1, chunkZ: 0 } },
    { name: 'map_chunk', data: { x: 1, z: 0 } }
  ]

  const { snapshot, replayed } = assertEquivalent(stream)
  assert.deepEqual(
    snapshot.chunks.map(frame => `${frame.data.x},${frame.data.z}`),
    ['1,0']
  )
  // The join chunk lives in the prefix, not the warm chunk domain.
  assert.deepEqual(stateSnapshot(replayed).chunks, ['0,0', '1,0'])

  // The last map_chunk re-adds the key, so the final state alone cannot tell
  // whether the unload was honored. Check the unload step on its own cache:
  // a 26.1 unload_chunk carries chunkZ/chunkX, not x/z.
  const unloadOnly = createStateCache()
  unloadOnly.push('play', 'chunk_batch_finished', Buffer.from('warm'), {})
  unloadOnly.push('play', 'map_chunk', Buffer.from('chunk'), { x: 1, z: 0 })
  unloadOnly.push('play', 'unload_chunk', Buffer.from('unload'), { chunkX: 1, chunkZ: 0 })
  assert.equal(unloadOnly.snapshot().chunks.length, 0)
})

test('replay equals the applied tail: block ring eviction', () => {
  const limit = 4
  const blocks = Array.from({ length: 7 }, (_, index) => ({
    name: 'block_change',
    data: { location: { x: index, y: 64, z: 0 }, type: 100 + index }
  }))
  const stream = [...joinPrefix(), ...blocks]

  const { snapshot, replayed } = assertEquivalent(
    stream,
    { maxBlocks: limit },
    [...joinPrefix(), ...blocks.slice(-limit)]
  )

  assert.equal(snapshot.blocks.length, limit)
  assert.deepEqual(snapshot.blocks.map(frame => frame.data.location.x), [3, 4, 5, 6])

  const values = Object.fromEntries(stateSnapshot(replayed).blocks.map(block => [block.key, block.value]))
  assert.equal(values['0,64,0'], undefined) // evicted from the ring
  assert.equal(values['6,64,0'], 106)
})

test('replay equals the stream: entity metadata merge, removal, and the entity bound', () => {
  // No overflow: the full stream is replayable.
  const merge = [
    ...joinPrefix(),
    { name: 'entity_metadata', data: { entityId: 42, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'entity_metadata', data: { entityId: 42, metadata: [{ key: 1, type: 'int', value: 2 }] } },
    { name: 'entity_teleport', data: { entityId: 42, x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } },
    { name: 'remove_entities', data: { entityIds: [42] } }
  ]
  const merged = assertEquivalent(merge).replayed
  const removed = stateSnapshot(merged).entities.find(entity => entity.entityId === 42)
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.fields, [])

  // More entities than maxEntities: the ring must keep the newest maxEntities.
  const limit = 3
  const many = Array.from({ length: 6 }, (_, index) => ({
    name: 'entity_metadata',
    data: { entityId: index + 1, metadata: [{ key: 0, type: 'byte', value: index }] }
  }))
  const stream = [...joinPrefix(), ...many]

  const cache = buildCache(stream, { maxEntities: limit })
  const snapshot = cache.snapshot()
  assert.equal(snapshot.entities.length, limit) // independent of maxGeneric
  assert.deepEqual(snapshot.entities.map(frame => frame.data.entityId), [4, 5, 6])

  assertEquivalent(
    stream,
    { maxEntities: limit },
    [...joinPrefix(), ...many.slice(-limit)]
  )
})

test('replay equals the stream: repeated latest health and abilities', () => {
  const stream = [
    ...joinPrefix(),
    { name: 'health', data: { health: 20, food: 20, foodSaturation: 5 } },
    { name: 'health', data: { health: 15, food: 17, foodSaturation: 3 } },
    { name: 'abilities', data: { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 } },
    { name: 'health', data: { health: 12, food: 15, foodSaturation: 1 } },
    { name: 'abilities', data: { flags: 2, flyingSpeed: 0.1, walkingSpeed: 0.2 } }
  ]

  const { snapshot, replayed } = assertEquivalent(stream)
  assert.equal(snapshot.latest.length, 2)
  assert.deepEqual(
    snapshot.latest.find(frame => frame.name === 'health').data,
    { health: 12, food: 15, foodSaturation: 1 }
  )
  assert.deepEqual(
    snapshot.latest.find(frame => frame.name === 'abilities').data,
    { flags: 2, flyingSpeed: 0.1, walkingSpeed: 0.2 }
  )
  assert.equal(
    stateSnapshot(replayed).latest.find(frame => frame.name === 'health').data.health,
    12
  )
})

test('replay equals the applied tail: generic FIFO', () => {
  const limit = 3
  // update_health is a 26.1 state frame; the cache puts it in the generic FIFO,
  // so its exact replay is the suffix, not the whole stream.
  const generic = Array.from({ length: 6 }, (_, index) => ({
    name: 'update_health',
    data: { health: 20 - index, food: 20, foodSaturation: 5 - index * 0.1 }
  }))
  const stream = [...joinPrefix(), ...generic]

  const { snapshot, replayed } = assertEquivalent(
    stream,
    { maxGeneric: limit },
    [...joinPrefix(), ...generic.slice(-limit)]
  )

  assert.equal(snapshot.generic.length, limit)
  assert.equal(
    stateSnapshot(replayed).latest.find(frame => frame.name === 'update_health').data.health,
    15
  )
})

test('replay equals the stream: mixed realistic domains', () => {
  const items = baseItems()
  items[36] = item(1)
  items[37] = item(2)
  const record = (42 << 12) | (1 << 8) | (2 << 4) | 3

  const stream = [
    ...joinPrefix(),
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } },
    { name: 'multi_block_change', data: { chunkCoordinates: { x: 4, y: 5, z: 6 }, records: [record] } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'entity_teleport', data: { entityId: 9, x: 8, y: 64, z: 8, yaw: 0, pitch: 0 } },
    windowItems(0, 7, items),
    setSlot(0, 7, 36, item(3)),
    { name: 'held_item_slot', data: { slot: 2 } },
    { name: 'health', data: { health: 18, food: 20, foodSaturation: 5 } },
    { name: 'update_health', data: { health: 17, food: 20, foodSaturation: 5 } },
    { name: 'abilities', data: { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 } },
    { name: 'boss_bar', data: { entityUUID: 'x', action: 0 } } // unknown to the model
  ]

  assertEquivalent(stream)
})

test('regression: set_slot after window_items keeps the base and both items', () => {
  const items = baseItems()
  items[36] = empty()
  items[37] = item(9)

  const stream = [
    ...joinPrefix(),
    windowItems(0, 7, items),
    setSlot(0, 7, 36, item(5)),
    setSlot(0, 7, 40, item(1, 64))
  ]

  const cache = buildCache(stream)
  const snapshot = cache.snapshot()

  // The 4f2a1b2 bug keyed window_items and set_slot by windowId, so the last
  // set_slot replaced the base frame. The replay must carry all three.
  assert.deepEqual(snapshot.inventories.map(frame => frame.name), ['window_items', 'set_slot', 'set_slot'])
  assert.deepEqual(snapshot.inventories.map(frame => frame.data.slot), [undefined, 36, 40])

  const replayed = replayState(snapshot)
  const window = stateSnapshot(replayed).windows.find(entry => entry.windowId === 0)
  const slots = Object.fromEntries(window.slots.map(slot => [slot.slot, slot.item]))
  assert.deepEqual(slots[36], item(5))
  assert.deepEqual(slots[40], item(1, 64))
  assert.deepEqual(slots[37], item(9)) // only the base can supply this slot

  // The full stream agrees, so the assertion is not just about frame presence.
  assert.deepEqual(
    stateSnapshot(replayed),
    stateSnapshot(applyFrames(createClientState(), stream))
  )
})

test('replay section order matches join-synth.synthAttach', () => {
  const cache = createStateCache()
  // A non-empty configuration section so its position in the order is checked.
  cache.push('configuration', 'registry_data', Buffer.from('config:registry_data'), {})
  cache.push('configuration', 'select_known_packs', Buffer.from('config:select_known_packs'), {})

  const stream = [
    ...joinPrefix(),
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [] } },
    windowItems(0, 1, [item(1)]),
    { name: 'health', data: { health: 20 } },
    { name: 'update_health', data: { health: 19 } }
  ]
  stream.forEach((frame, index) => {
    cache.push('play', frame.name, Buffer.from(`${frame.name}:${index}`), frame.data ?? {})
  })

  const snapshot = cache.snapshot()
  const { frames } = synthAttach({
    snapshot,
    pose: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }
  })

  // The synthesized position is per-attach, not cached state; skip it.
  const names = frames.filter(frame => frame.synth !== 'position').map(frame => frame.name)
  const expected = SECTION_ORDER.flatMap(section => snapshot[section].map(frame => frame.name))
  assert.deepEqual(names, expected)
})

// Unit target: src/ladder/client-state.js, the client half of the
// cache-replay equivalence check. One test per merge rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createClientState,
  applyFrame,
  applyFrames,
  stateSnapshot
} from '../src/ladder/client-state.js'

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
const findWindow = (state, windowId) =>
  stateSnapshot(state).windows.find(window => window.windowId === windowId)

test('window_items replaces the window; a later set_slot patches one slot', () => {
  const state = createClientState()
  const items = baseItems()
  items[36] = item(1)
  items[37] = item(2)

  applyFrame(state, windowItems(0, 3, items))
  applyFrame(state, setSlot(0, 3, 36, item(5)))
  applyFrame(state, setSlot(0, 3, 40, item(6)))

  let window = findWindow(state, 0)
  const slots = Object.fromEntries(window.slots.map(slot => [slot.slot, slot.item]))
  assert.deepEqual(slots[36], item(5))
  assert.deepEqual(slots[37], item(2)) // still from the base frame
  assert.deepEqual(slots[40], item(6))
  assert.equal(window.stateId, 3)

  // A second window_items resets every slot, including the patched ones.
  applyFrame(state, windowItems(0, 4, [empty(), item(7)]))
  window = findWindow(state, 0)
  assert.equal(window.stateId, 4)
  assert.deepEqual(window.slots.map(slot => slot.slot), [0, 1])
  assert.deepEqual(window.slots[1].item, item(7))
})

test('a windowId-less frame lands in the main window, like the cache', () => {
  const state = createClientState()
  applyFrame(state, { name: 'window_items', data: { stateId: 1, items: [item(3)] } })
  applyFrame(state, { name: 'set_slot', data: { stateId: 1, slot: 0, item: item(4) } })
  const window = findWindow(state, 'main')
  assert.deepEqual(window.slots, [{ slot: 0, item: item(4) }])
})

test('map_chunk adds and unload_chunk removes, in both field shapes', () => {
  const state = createClientState()
  applyFrame(state, { name: 'map_chunk', data: { x: 1, z: 2 } })
  applyFrame(state, { name: 'map_chunk', data: { x: 1, z: 2 } }) // re-set is idempotent
  assert.deepEqual(stateSnapshot(state).chunks, ['1,2'])

  applyFrame(state, { name: 'unload_chunk', data: { x: 1, z: 2 } })
  assert.deepEqual(stateSnapshot(state).chunks, [])

  // 26.1 decodes unload_chunk as chunkZ/chunkX.
  applyFrame(state, { name: 'map_chunk', data: { x: 3, z: 4 } })
  applyFrame(state, { name: 'unload_chunk', data: { chunkX: 3, chunkZ: 4 } })
  assert.deepEqual(stateSnapshot(state).chunks, [])
})

test('block_change/block_update set, multi_block_change expands, break animation is ignored', () => {
  const state = createClientState()
  applyFrame(state, { name: 'block_change', data: { location: { x: 1, y: 64, z: 2 }, type: 11 } })
  applyFrame(state, { name: 'block_update', data: { location: { x: 1, y: 64, z: 2 }, type: 12 } })
  applyFrame(state, { name: 'block_change', data: { location: { x: 3, y: 65, z: 4 }, type: 13 } })

  // block state 42 at relative (1, 3, 2) inside section (4, 5, 6).
  const record = (42 << 12) | (1 << 8) | (2 << 4) | 3
  applyFrame(state, {
    name: 'multi_block_change',
    data: { chunkCoordinates: { x: 4, y: 5, z: 6 }, records: [record] }
  })
  applyFrame(state, { name: 'block_break_animation', data: { location: { x: 9, y: 9, z: 9 } } })

  const blocks = Object.fromEntries(stateSnapshot(state).blocks.map(block => [block.key, block.value]))
  assert.deepEqual(blocks, {
    '1,64,2': 12,
    '3,65,4': 13,
    '65,83,98': 42
  })
  assert.equal(blocks['9,9,9'], undefined)
})

test('entity_metadata merges by key, teleport sets position, remove tombstones', () => {
  const state = createClientState()
  applyFrame(state, { name: 'entity_metadata', data: { entityId: 7, metadata: [{ key: 0, type: 'byte', value: 1 }] } })
  applyFrame(state, { name: 'entity_metadata', data: { entityId: 7, metadata: [{ key: 1, type: 'int', value: 9 }] } })
  applyFrame(state, {
    name: 'entity_teleport',
    data: { entityId: 7, x: 1.5, y: 2.5, z: 3.5, yaw: 90, pitch: 10 }
  })

  let entity = stateSnapshot(state).entities.find(entry => entry.entityId === 7)
  const fields = Object.fromEntries(entity.fields.map(field => [field.key, field.value]))
  assert.deepEqual(fields, { 0: 1, 1: 9, x: 1.5, y: 2.5, z: 3.5, yaw: 90, pitch: 10 })
  assert.equal(entity.removed, false)

  applyFrame(state, { name: 'remove_entities', data: { entityIds: [7] } })
  entity = stateSnapshot(state).entities.find(entry => entry.entityId === 7)
  assert.equal(entity.removed, true)
  assert.deepEqual(entity.fields, [])
})

test('entity_position and sync_entity_position also set position fields', () => {
  const state = createClientState()
  applyFrame(state, { name: 'entity_position', data: { entityId: 8, x: 4, y: 5, z: 6 } })
  applyFrame(state, { name: 'sync_entity_position', data: { entityId: 8, x: 7, y: 8, z: 9 } })
  const entity = stateSnapshot(state).entities.find(entry => entry.entityId === 8)
  assert.deepEqual(
    Object.fromEntries(entity.fields.map(field => [field.key, field.value])),
    { x: 7, y: 8, z: 9 }
  )
})

test('latest keeps the newest frame per name; held_item_slot updates selectedSlot', () => {
  const state = createClientState()
  applyFrame(state, { name: 'health', data: { health: 20, food: 20, foodSaturation: 5 } })
  applyFrame(state, { name: 'health', data: { health: 17, food: 18, foodSaturation: 4 } })
  applyFrame(state, { name: 'abilities', data: { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 } })
  applyFrame(state, { name: 'held_item_slot', data: { slot: 3 } })
  applyFrame(state, { name: 'held_item_slot', data: { slot: 4 } })

  const snapshot = stateSnapshot(state)
  assert.equal(snapshot.latest.length, 3)
  assert.deepEqual(
    snapshot.latest.find(frame => frame.name === 'health').data,
    { health: 17, food: 18, foodSaturation: 4 }
  )
  assert.equal(snapshot.selectedSlot, 4)
})

test('position sets the client pose (the cache synthesizes it on attach)', () => {
  const state = createClientState()
  applyFrame(state, {
    name: 'position',
    data: { teleportId: 5, x: 1.5, y: 64.62, z: -2.5, yaw: 180, pitch: -10 }
  })
  assert.deepEqual(stateSnapshot(state).pose, { x: 1.5, y: 64.62, z: -2.5, yaw: 180, pitch: -10 })
})

test('unknown frames are ignored and snapshots do not depend on insertion order', () => {
  const a = createClientState()
  applyFrame(a, { name: 'made_up_frame', data: { x: 1 } })
  applyFrame(a, { name: 'map_chunk', data: { x: 2, z: 0 } })
  applyFrame(a, { name: 'map_chunk', data: { x: 1, z: 0 } })

  const b = createClientState()
  applyFrame(b, { name: 'map_chunk', data: { x: 1, z: 0 } })
  applyFrame(b, { name: 'map_chunk', data: { x: 2, z: 0 } })

  assert.deepEqual(stateSnapshot(a), stateSnapshot(b))
  assert.deepEqual(stateSnapshot(a).chunks, ['1,0', '2,0'])
})

test('applyFrames applies in order', () => {
  const state = applyFrames(createClientState(), [
    windowItems(0, 1, [item(1)]),
    setSlot(0, 1, 0, item(2)),
    { name: 'health', data: { health: 10 } }
  ])
  const snapshot = stateSnapshot(state)
  assert.deepEqual(snapshot.windows[0].slots, [{ slot: 0, item: item(2) }])
  assert.deepEqual(snapshot.latest, [{ name: 'health', data: { health: 10 } }])
})

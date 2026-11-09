// Client-state model for the cache-replay equivalence harness.
//
// A vanilla client builds state from the clientbound play frames it receives.
// The monoplayer cache replays a rebuilt stream instead of the original one, so
// the two states must agree. This module models the client side of that
// comparison; it is pure (no I/O, no timers, no protocol dependency).
//
// Every merge rule names the frame it mirrors. Unknown frame names are ignored
// so a new packet never makes the harness throw.
//
// 26.1 packet field names are taken from minecraft-data:
//   window_items  windowId, stateId, items
//   set_slot      windowId, stateId, slot, item
//   map_chunk     x, z
//   unload_chunk  chunkZ, chunkX (legacy callers pass x, z; both are accepted)
//   block_change  location, type
//   multi_block_change  chunkCoordinates { x, y, z }, records [packed varint]
//   entity_metadata     entityId, metadata [{ key, type, value }]
//   entity_teleport     entityId, x, y, z, yaw, pitch
//   spawn_entity  entityId, x, y, z, yaw, pitch (i8 angles)
//   rel_entity_move     entityId, dX, dY, dZ (i16, 1/4096 block)
//   entity_move_look    entityId, dX, dY, dZ, yaw, pitch (i8 angles)
//   entity_look   entityId, yaw, pitch (i8 angles)
//   position      x, y, z, yaw, pitch
//   held_item_slot slot

// The wire units the entity frames use. Position deltas are i16 in
// 1/4096-block fixed point, and an i8 angle is 1/256 of a turn. The model keeps
// degrees, like the absolute frames carry, so both sides of a comparison agree.
const POSITION_DELTA_UNITS = 1 / 4096
const ANGLE_DEGREES = 360 / 256

const LATEST_FRAMES = new Set([
  'health',
  'update_health', // 26.1 name; the cache classifies it as generic, state is the same
  'food',
  'experience',
  'abilities',
  'held_item_slot',
  'game_state_change',
  'entity_event',
  'advancements'
])

// The client's advancement map after a run of `advancements` frames, applied
// the way the vanilla client applies them: reset clears the map, identifiers
// remove one advancement each, the mapping adds or replaces, and progress
// attaches to an advancement the client holds. A notice that adds and then
// removes one id leaves this map as the server left it.
export function applyAdvancementFrames (frames = [], held = new Map()) {
  for (const frame of frames) {
    if (frame.reset) held.clear()
    for (const id of frame.identifiers ?? []) held.delete(id)
    for (const entry of frame.advancementMapping ?? []) held.set(entry.key, entry.value)
    for (const entry of frame.progressMapping ?? []) {
      const current = held.get(entry.key)
      if (current !== undefined) held.set(entry.key, { ...current, progress: entry.value })
    }
  }
  return held
}

export function createClientState () {
  return {
    windows: new Map(), // windowId -> { stateId, slots: Map<slot, item> }
    chunks: new Set(), // "x,z"
    blocks: new Map(), // "x,y,z" -> block state id
    entities: new Map(), // entityId -> { removed, fields: Map }
    latest: new Map(), // frame name -> newest data
    pose: null, // { x, y, z, yaw, pitch }
    selectedSlot: null
  }
}

export function applyFrame (state, frame) {
  const name = frame?.name
  const data = frame?.data ?? {}

  switch (name) {
    case 'window_items':
      applyWindowItems(state, data)
      return state
    case 'set_slot':
      applySetSlot(state, data)
      return state
    case 'map_chunk':
      state.chunks.add(chunkKey(data))
      return state
    case 'unload_chunk':
      state.chunks.delete(chunkKey(data))
      return state
    case 'block_change':
    case 'block_update':
      applyBlockChange(state, data)
      return state
    case 'multi_block_change':
      applyMultiBlockChange(state, data)
      return state
    case 'block_break_animation':
      // Dig animation is transient; it never changes the block the client keeps.
      return state
    case 'entity_metadata':
      applyEntityMetadata(state, data)
      return state
    case 'remove_entities':
    case 'entity_destroy':
      applyRemoveEntities(state, data)
      return state
    case 'entity_teleport':
    case 'entity_position':
    case 'sync_entity_position':
      applyEntityPosition(state, data)
      return state
    case 'spawn_entity':
      applyEntitySpawn(state, data)
      return state
    case 'rel_entity_move':
    case 'entity_move_look':
    case 'entity_look':
      applyEntityDelta(state, data)
      return state
    case 'position':
      state.pose = {
        x: data.x,
        y: data.y,
        z: data.z,
        yaw: data.yaw ?? 0,
        pitch: data.pitch ?? 0
      }
      return state
    default:
      if (!LATEST_FRAMES.has(name)) return state // unknown names are ignored
      // Newest frame wins per name, mirroring the cache's `latest` domain.
      state.latest.set(name, { ...data })
      if (name === 'held_item_slot') state.selectedSlot = data.slot ?? null
      return state
  }
}

export function applyFrames (state, frames) {
  for (const frame of frames) applyFrame(state, frame)
  return state
}

// Plain JSON with every map sorted so deepEqual is insertion-order independent.
export function stateSnapshot (state) {
  return {
    windows: sortedEntries(state.windows, compareKeys).map(([windowId, window]) => ({
      windowId,
      stateId: window.stateId,
      slots: sortedEntries(window.slots, compareKeys).map(([slot, item]) => ({ slot, item }))
    })),
    chunks: [...state.chunks].sort(compareStrings),
    blocks: sortedEntries(state.blocks, compareStrings).map(([key, value]) => ({ key, value })),
    entities: sortedEntries(state.entities, compareKeys).map(([entityId, entity]) => ({
      entityId,
      removed: entity.removed,
      fields: sortedEntries(entity.fields, compareKeys).map(([key, value]) => ({ key, value }))
    })),
    latest: sortedEntries(state.latest, compareStrings).map(([name, data]) => ({ name, data })),
    pose: state.pose === null ? null : { ...state.pose },
    selectedSlot: state.selectedSlot
  }
}

function chunkKey (data) {
  // 26.1 decodes chunkZ/chunkX; the cache's own key contract uses x/z.
  const x = data.x ?? data.chunkX
  const z = data.z ?? data.chunkZ
  return `${x},${z}`
}

function windowFor (state, windowId) {
  const key = windowId ?? 'main' // the cache defaults a missing windowId to 'main'
  let window = state.windows.get(key)
  if (!window) {
    window = { stateId: null, slots: new Map() }
    state.windows.set(key, window)
  }
  return window
}

// window_items replaces the whole window, exactly like the client's container
// setContents call. A later set_slot patches one slot; it must not drop the rest.
function applyWindowItems (state, data) {
  const window = windowFor(state, data.windowId)
  window.stateId = data.stateId ?? null
  window.slots = new Map()
  const items = Array.isArray(data.items) ? data.items : []
  for (let slot = 0; slot < items.length; slot++) {
    if (items[slot] !== undefined) window.slots.set(slot, items[slot])
  }
}

// set_slot replaces one slot and carries the container stateId the client keeps.
function applySetSlot (state, data) {
  const window = windowFor(state, data.windowId)
  if (data.stateId !== undefined) window.stateId = data.stateId
  window.slots.set(data.slot ?? 'cursor', data.item ?? { itemCount: 0 })
}

function applyBlockChange (state, data) {
  const location = data.location ?? data.position ?? {}
  const value = data.type ?? data.blockId ?? data.stateId
  state.blocks.set(`${location.x},${location.y},${location.z}`, value)
}

// 26.1 packs one record per block as a varint:
//   block state in the high bits, then relative x, z, y (4 bits each).
function applyMultiBlockChange (state, data) {
  const chunk = data.chunkCoordinates ?? {}
  const records = Array.isArray(data.records) ? data.records : []
  for (const record of records) {
    if (typeof record === 'number') {
      const x = (chunk.x ?? 0) * 16 + ((record >> 8) & 0xf)
      const z = (chunk.z ?? 0) * 16 + ((record >> 4) & 0xf)
      const y = (chunk.y ?? 0) * 16 + (record & 0xf)
      state.blocks.set(`${x},${y},${z}`, record >>> 12)
    } else if (record && typeof record === 'object') {
      // Pre-decoded record shape, accepted for callers that unpack upstream.
      const value = record.value ?? record.type ?? record.blockId ?? record.stateId
      state.blocks.set(`${record.x},${record.y},${record.z}`, value)
    }
  }
}

function entityFor (state, entityId) {
  let entity = state.entities.get(entityId)
  if (!entity) {
    entity = { removed: false, fields: new Map() }
    state.entities.set(entityId, entity)
  }
  return entity
}

// entity_metadata merges by metadata key: a frame carries only the changed keys.
function applyEntityMetadata (state, data) {
  const entity = entityFor(state, data.entityId)
  entity.removed = false // metadata for a live entity clears an earlier destroy
  const metadata = Array.isArray(data.metadata)
    ? data.metadata
    : Object.values(data.metadata ?? {})
  for (const entry of metadata) {
    if (!entry || entry.key === undefined) continue
    entity.fields.set(entry.key, entry.value)
  }
}

// remove_entities deletes the entity's state; the tombstone keeps the removal
// visible in the snapshot.
function applyRemoveEntities (state, data) {
  for (const entityId of data.entityIds ?? []) {
    const entity = entityFor(state, entityId)
    entity.removed = true
    entity.fields.clear()
  }
}

// spawn_entity carries the first absolute pose for most entities, and nothing
// else in the stream gives them a position. Its rotation is an i8 angle.
function applyEntitySpawn (state, data) {
  const entity = entityFor(state, data.entityId)
  entity.removed = false
  for (const axis of ['x', 'y', 'z']) {
    if (data[axis] !== undefined) entity.fields.set(axis, data[axis])
  }
  for (const key of ['yaw', 'pitch']) {
    if (data[key] !== undefined) entity.fields.set(key, data[key] * ANGLE_DEGREES)
  }
}

// A relative move adjusts a position the client already has. A delta for an
// entity with no position on record is ignored, exactly as the vanilla client
// ignores a move for an entity it does not know. Rotation in these frames is an
// absolute i8 angle, not a delta.
function applyEntityDelta (state, data) {
  const entity = state.entities.get(data.entityId)
  if (!entity || entity.removed) return
  if (entity.fields.has('x')) {
    for (const [key, delta] of [['x', data.dX], ['y', data.dY], ['z', data.dZ]]) {
      if (delta === undefined) continue
      entity.fields.set(key, (entity.fields.get(key) ?? 0) + delta * POSITION_DELTA_UNITS)
    }
  }
  for (const key of ['yaw', 'pitch']) {
    const angle = data[key]
    if (angle === undefined) continue
    entity.fields.set(key, angle * ANGLE_DEGREES)
  }
}

// entity_teleport/entity_position set the entity's position fields.
function applyEntityPosition (state, data) {
  const entity = entityFor(state, data.entityId)
  for (const key of ['x', 'y', 'z', 'yaw', 'pitch']) {
    if (data[key] !== undefined) entity.fields.set(key, data[key])
  }
}

function sortedEntries (map, compare) {
  return [...map.entries()].sort((a, b) => compare(a[0], b[0]))
}

function compareKeys (a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return compareStrings(String(a), String(b))
}

function compareStrings (a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Live parity guard for the cache-replay attach.
//
// The cache rebuilds a bounded state snapshot and join-synth replays it to the
// attaching client. This module decodes the same two streams through the pure
// client-state model and compares the domains a live backend can reshape:
// inventory slots, the held slot, the pose, the chunk set, the block map, and
// the entity state.
//
// It is the check that catches backend-specific packet shapes the fake backend
// never models: the client's decoded state must equal the state the cache says
// it replayed.
//
// Pure: no I/O, no timers, no protocol dependency.
import { createClientState, applyFrames, stateSnapshot } from './client-state.js'

// The exact cross-domain order join-synth.synthAttach uses.
export const PARITY_SECTIONS = Object.freeze([
  'config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic'
])

export const PARITY_DOMAINS = Object.freeze([
  'inventory', 'heldItemSlot', 'pose', 'chunks', 'blocks', 'entities'
])

// Cache domains (state-cache.js DOMAINS) mapped to the parity domains that
// compare them. This map and UNPARITY are the test contract: every DOMAINS
// entry must be compared through a non-empty mapping or excused below. They are
// not read at run time.
export const DOMAIN_PARITY = Object.freeze({
  chunk: Object.freeze(['chunks']),
  block: Object.freeze(['blocks']),
  entity: Object.freeze(['entities']),
  inventory: Object.freeze(['inventory']),
  latest: Object.freeze(['heldItemSlot']),
  prefix: Object.freeze([]),
  config: Object.freeze([]),
  generic: Object.freeze([])
})

// Cache domains with no comparison of their own. Each reason says why, so a
// new domain must either map to a parity domain or land here with an
// explanation. A domain can appear here and in DOMAIN_PARITY when only part of
// it is compared.
export const UNPARITY = Object.freeze({
  prefix: 'The join prefix is replayed verbatim. Its state frames are compared through chunks, blocks, entities, inventory, and heldItemSlot, but the prefix has no state of its own to compare.',
  config: 'The configuration phase replay carries no play state. The client-state model ignores configuration frame names, so the domain has nothing to compare.',
  generic: 'The generic ring holds unclassified frames. rel_entity_move, entity_move_look, and entity_look are captured here and not decoded, so a moved entity is compared only at its last absolute position. update_health decodes into latest, which is not compared.',
  latest: 'Only held_item_slot is compared. health, food, experience, abilities, game_state_change, entity_event, and advancements are decoded but not compared by this issue.'
})

const POSE_FIELDS = Object.freeze(['x', 'y', 'z', 'yaw', 'pitch'])

// Flatten a cache snapshot into decoded model frames, in join-synth order.
//
// `position` is per-leg: the cache drops every position frame and the proxy
// synthesizes one from the session pose on attach. A caller that wants the
// pose domain compared carries that pose on the snapshot (`snapshot.pose`);
// without it the pose expectation stays null, exactly like the cache.
export function snapshotFrames (cacheSnapshot) {
  const frames = []
  for (const section of PARITY_SECTIONS) {
    for (const entry of cacheSnapshot?.[section] ?? []) {
      frames.push({ name: entry.name, data: entry.data ?? {} })
    }
  }
  const pose = cacheSnapshot?.pose
  if (pose && typeof pose === 'object') {
    frames.push({ name: 'position', data: { ...pose } })
  }
  return frames
}

// Compare the client's decoded state against the state the cache replayed.
//
// cacheSnapshot is a core.cache.snapshot() body, optionally carrying the
// proxy-synthesized pose. clientFrames are { name, data } frames in arrival
// order, already decoded by the attaching client.
export function parityReport ({ cacheSnapshot, clientFrames = [], domains = PARITY_DOMAINS } = {}) {
  if (!cacheSnapshot || typeof cacheSnapshot !== 'object') {
    throw new TypeError('cacheSnapshot is required')
  }
  if (!Array.isArray(clientFrames)) throw new TypeError('clientFrames must be an array')
  if (!Array.isArray(domains)) throw new TypeError('domains must be an array')

  const expected = stateSnapshot(applyFrames(createClientState(), snapshotFrames(cacheSnapshot)))
  const actual = stateSnapshot(applyFrames(createClientState(), clientFrames))

  const results = {}
  let ok = true
  for (const name of domains) {
    if (!PARITY_DOMAINS.includes(name)) {
      throw new TypeError(`unknown parity domain: ${JSON.stringify(name)}`)
    }
    const result = compareDomain(name, expected, actual)
    results[name] = result
    if (!result.ok) ok = false
  }
  return { ok, domains: results }
}

function compareDomain (name, expected, actual) {
  switch (name) {
    case 'inventory':
      return compareInventory(expected, actual)
    case 'heldItemSlot':
      return scalarResult(expected.selectedSlot ?? null, actual.selectedSlot ?? null)
    case 'pose':
      return comparePose(expected.pose, actual.pose)
    case 'chunks':
      return compareChunks(expected.chunks, actual.chunks)
    case 'blocks':
      return compareBlocks(expected.blocks, actual.blocks)
    case 'entities':
      return compareEntities(expected.entities, actual.entities)
    default:
      throw new TypeError(`no comparator for parity domain: ${JSON.stringify(name)}`)
  }
}

// The window slot map per windowId: items by slot. stateId is not compared;
// the client keeps it, but two replayed streams can only disagree there after
// a slot frame the slot map already reports.
function inventoryView (snapshot) {
  return snapshot.windows.map(window => ({
    windowId: window.windowId,
    slots: window.slots
      .map(({ slot, item }) => ({ slot, item: canonical(item) }))
      .sort((a, b) => compareSlotKeys(String(a.slot), String(b.slot)))
  }))
}

function compareInventory (expectedSnapshot, actualSnapshot) {
  const expected = inventoryView(expectedSnapshot)
  const actual = inventoryView(actualSnapshot)
  const diff = inventoryDiff(expected, actual)
  const result = { ok: diff.changes.length === 0, expected, actual }
  if (!result.ok) result.diff = diff
  return result
}

function inventoryDiff (expected, actual) {
  const changes = []
  const expectedWindows = new Map(expected.map(window => [String(window.windowId), window]))
  const actualWindows = new Map(actual.map(window => [String(window.windowId), window]))
  const windowIds = [...new Set([...expectedWindows.keys(), ...actualWindows.keys()])]
    .sort(compareStrings)

  for (const windowId of windowIds) {
    const expectedWindow = expectedWindows.get(windowId)
    const actualWindow = actualWindows.get(windowId)
    if (!expectedWindow || !actualWindow) {
      const window = expectedWindow ?? actualWindow
      changes.push({
        windowId: window.windowId,
        expected: expectedWindow ? expectedWindow.slots : null,
        actual: actualWindow ? actualWindow.slots : null
      })
      continue
    }

    const expectedSlots = slotsByKey(expectedWindow)
    const actualSlots = slotsByKey(actualWindow)
    const keys = [...new Set([...expectedSlots.keys(), ...actualSlots.keys()])]
      .sort(compareSlotKeys)

    for (const key of keys) {
      const expectedItem = expectedSlots.get(key)
      const actualItem = actualSlots.get(key)
      if (!equal(expectedItem, actualItem)) {
        changes.push({
          windowId: expectedWindow.windowId,
          slot: slotOf(key),
          expected: expectedItem ?? null,
          actual: actualItem ?? null
        })
      }
    }
  }

  return { changes }
}

function slotsByKey (window) {
  return new Map(window.slots.map(entry => [String(entry.slot), entry.item]))
}

function comparePose (expectedPose, actualPose) {
  const expected = poseView(expectedPose)
  const actual = poseView(actualPose)
  return { ok: equal(expected, actual), expected, actual }
}

function poseView (pose) {
  if (pose === null || pose === undefined) return null
  const view = {}
  for (const field of POSE_FIELDS) view[field] = pose[field] ?? null
  return view
}

function compareChunks (expectedChunks, actualChunks) {
  const expected = [...expectedChunks].sort(compareStrings)
  const actual = [...actualChunks].sort(compareStrings)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter(key => !actualSet.has(key))
  const unexpected = actual.filter(key => !expectedSet.has(key))
  const result = { ok: missing.length === 0 && unexpected.length === 0, expected, actual }
  if (!result.ok) result.diff = { missing, unexpected }
  return result
}

// The block map per "x,y,z". stateSnapshot already sorts the entries; the
// view canonicalizes each state id so bigint and Buffer-shaped values compare
// like the rest of the report.
function blockView (blocks) {
  return [...blocks]
    .map(({ key, value }) => ({ key, value: canonical(value) }))
    .sort((a, b) => compareBlockKeys(a.key, b.key))
}

function compareBlocks (expectedBlocks, actualBlocks) {
  const expected = blockView(expectedBlocks)
  const actual = blockView(actualBlocks)
  const expectedByKey = new Map(expected.map(entry => [entry.key, entry.value]))
  const actualByKey = new Map(actual.map(entry => [entry.key, entry.value]))
  const keys = [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])]
    .sort(compareBlockKeys)

  const missing = []
  const unexpected = []
  const changed = []
  for (const key of keys) {
    const expectedValue = expectedByKey.get(key)
    const actualValue = actualByKey.get(key)
    if (!actualByKey.has(key)) {
      missing.push(key)
    } else if (!expectedByKey.has(key)) {
      unexpected.push(key)
    } else if (!equal(expectedValue, actualValue)) {
      changed.push({ key, expected: expectedValue, actual: actualValue })
    }
  }

  const result = {
    ok: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    expected,
    actual
  }
  if (!result.ok) result.diff = { missing, unexpected, changed }
  return result
}

// The entity view keeps `removed` and every metadata field, so a tombstone
// from remove_entities/entity_destroy is compared like any other entity state.
function entityView (entity) {
  const fields = [...(entity.fields ?? [])]
    .map(({ key, value }) => ({ key: canonical(key), value: canonical(value) }))
    .sort((a, b) => compareEntityIds(a.key, b.key))
  return { entityId: canonical(entity.entityId), removed: canonical(entity.removed), fields }
}

function compareEntities (expectedEntities, actualEntities) {
  const expected = [...expectedEntities]
    .map(entityView)
    .sort((a, b) => compareEntityIds(a.entityId, b.entityId))
  const actual = [...actualEntities]
    .map(entityView)
    .sort((a, b) => compareEntityIds(a.entityId, b.entityId))
  const expectedById = new Map(expected.map(entity => [entity.entityId, entity]))
  const actualById = new Map(actual.map(entity => [entity.entityId, entity]))
  const entityIds = [...new Set([...expectedById.keys(), ...actualById.keys()])]
    .sort(compareEntityIds)

  const missing = []
  const unexpected = []
  const changed = []
  for (const entityId of entityIds) {
    const expectedEntity = expectedById.get(entityId)
    const actualEntity = actualById.get(entityId)
    if (!actualById.has(entityId)) {
      missing.push(entityId)
    } else if (!expectedById.has(entityId)) {
      unexpected.push(entityId)
    } else if (!equal(expectedEntity, actualEntity)) {
      changed.push({ entityId, expected: expectedEntity, actual: actualEntity })
    }
  }

  const result = {
    ok: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    expected,
    actual
  }
  if (!result.ok) result.diff = { missing, unexpected, changed }
  return result
}

function scalarResult (expected, actual) {
  return { ok: equal(expected, actual), expected, actual }
}

function equal (expected, actual) {
  return JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual))
}

// Plain JSON in a stable key order, so a report is reproducible and survives
// JSON.stringify: bigint becomes a string, Buffer becomes base64.
function canonical (value) {
  return sortValue(jsonSafe(value))
}

function jsonSafe (value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Map) return jsonSafe(Object.fromEntries(value))
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return { buffer: value.toString('base64') }
    if (typeof value.toJSON === 'function') return jsonSafe(value.toJSON())
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = jsonSafe(inner)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return value
}

function sortValue (value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
    return out
  }
  return value
}

function slotOf (key) {
  return /^-?\d+$/.test(key) ? Number(key) : key
}

function compareSlotKeys (a, b) {
  const numberA = /^-?\d+$/.test(a) ? Number(a) : null
  const numberB = /^-?\d+$/.test(b) ? Number(b) : null
  if (numberA !== null && numberB !== null) return numberA - numberB
  if (numberA !== null) return -1
  if (numberB !== null) return 1
  return compareStrings(a, b)
}

// Block keys are "x,y,z"; compare each coordinate numerically so the diff
// order does not put "10,0,0" before "2,0,0".
function compareBlockKeys (a, b) {
  const partsA = String(a).split(',')
  const partsB = String(b).split(',')
  if (partsA.length !== partsB.length) return compareStrings(String(a), String(b))
  for (let i = 0; i < partsA.length; i++) {
    const order = compareSlotKeys(partsA[i], partsB[i])
    if (order !== 0) return order
  }
  return 0
}

// Entity ids are numbers on the wire; compare numerically when both are, then
// fall back to the usual string order for mixed shapes.
function compareEntityIds (a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return compareStrings(String(a), String(b))
}

function compareStrings (a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

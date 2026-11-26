// Unit target: src/ladder/state-parity.js, the live attach parity guard.
//
// Each test builds the cache snapshot the way an attach would see it, then
// feeds the client a stream that differs in exactly one domain. The matching
// domain must fail and the others must pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOMAINS, createStateCache } from '../../src/core/state-cache.js'
import { synthAttach } from '../../src/core/join-synth.js'
import {
  ONLINE_ASSERTION_IDS,
  evaluateOnlineAssertions,
  parityEvidence,
  parityNameEvidence
} from '../../src/ladder/online.js'
import {
  DOMAIN_PARITY,
  PARITY_DOMAINS,
  PARITY_FRAME_NAMES,
  UNPARITY,
  attachParity,
  parityReplayNames,
  snapshotFrames,
  parityReport
} from '../../src/ladder/state-parity.js'

const empty = () => ({ itemCount: 0 })
const item = (itemId, itemCount = 1) => ({ itemCount, itemId })
const baseItems = (length = 46) => Array.from({ length }, empty)

function buildSnapshot (stream, overrides = {}) {
  const cache = createStateCache(overrides)
  stream.forEach((frame, index) => {
    cache.push(
      frame.state ?? 'play',
      frame.name,
      Buffer.from(`${frame.name}:${index}`),
      frame.data ?? {}
    )
  })
  return cache.snapshot()
}

function joinedStream (...frames) {
  return [
    { name: 'login', data: { entityId: 42 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: { batchSize: 1 } },
    ...frames
  ]
}

function assertDomains (report, expected) {
  for (const domain of PARITY_DOMAINS) {
    assert.equal(report.domains[domain].ok, expected[domain], `${domain}: ${JSON.stringify(report.domains[domain].diff ?? null)}`)
  }
}

// Fail closed like clientbound-policy.js: a cache domain must be compared by
// at least one parity domain or carry a written UNPARITY reason. Kept local to
// the test so no test-only helper leaks out of src.
function assertDomainCoverage (domains) {
  for (const domain of domains) {
    const mapped = DOMAIN_PARITY[domain]
    const reason = UNPARITY[domain]
    const comparedByDomain = Array.isArray(mapped) && mapped.length > 0
    const excused = typeof reason === 'string' && reason.trim().length > 0
    if (!comparedByDomain && !excused) {
      throw new Error(
        `cache domain ${JSON.stringify(domain)} has no parity comparison and no UNPARITY reason`)
    }
    if (!comparedByDomain) continue
    for (const name of mapped) {
      if (!PARITY_DOMAINS.includes(name)) {
        throw new Error(
          `cache domain ${JSON.stringify(domain)} maps to unknown parity domain ${JSON.stringify(name)}`)
      }
    }
  }

  for (const [domain, reason] of Object.entries(UNPARITY)) {
    if (!domains.includes(domain)) {
      throw new Error(`UNPARITY entry ${JSON.stringify(domain)} is not a cache domain`)
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(`UNPARITY entry ${JSON.stringify(domain)} has no reason`)
    }
  }
}

test('matching snapshot and client frames pass every domain', () => {
  const items = baseItems()
  items[36] = item(1)
  const snapshot = buildSnapshot(joinedStream(
    { name: 'window_items', data: { windowId: 0, stateId: 1, items } },
    { name: 'set_slot', data: { windowId: 0, stateId: 1, slot: 40, item: item(7) } },
    { name: 'held_item_slot', data: { slot: 3 } },
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } },
    // state 7 at relative (1, 3, 2) in chunk (0, 4, 0) -> "1,67,2"
    { name: 'multi_block_change', data: { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [28963] } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'entity_teleport', data: { entityId: 9, x: 1, y: 64, z: 2, yaw: 90, pitch: 0 } }
  ))
  // The proxy synthesizes the attach position; the cache never stores it.
  snapshot.pose = { x: 1.5, y: 64.62, z: -2.5, yaw: 90, pitch: -10 }

  const report = parityReport({ cacheSnapshot: snapshot, clientFrames: snapshotFrames(snapshot) })

  assert.equal(report.ok, true)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: true,
    entities: true
  })
})

test('a set_slot missing from the client frames fails inventory and names the slot', () => {
  const items = baseItems()
  items[36] = item(1)
  const snapshot = buildSnapshot(joinedStream(
    { name: 'window_items', data: { windowId: 0, stateId: 1, items } },
    { name: 'set_slot', data: { windowId: 0, stateId: 1, slot: 36, item: item(5) } }
  ))

  const clientFrames = snapshotFrames(snapshot).filter(frame =>
    !(frame.name === 'set_slot' && frame.data.slot === 36))
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: false,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: true,
    entities: true
  })

  const change = report.domains.inventory.diff.changes.find(entry => entry.slot === 36)
  assert.ok(change, 'the diff names the missing slot')
  assert.deepEqual(change.expected, item(5))
  assert.deepEqual(change.actual, item(1)) // the window base still holds the old slot
})

test('a different held slot fails only heldItemSlot', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'held_item_slot', data: { slot: 3 } }
  ))

  const clientFrames = snapshotFrames(snapshot).map(frame =>
    frame.name === 'held_item_slot' ? { ...frame, data: { ...frame.data, slot: 4 } } : frame)
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: false,
    pose: true,
    chunks: true,
    blocks: true,
    entities: true
  })
  assert.equal(report.domains.heldItemSlot.expected, 3)
  assert.equal(report.domains.heldItemSlot.actual, 4)
})

test('a different pose fails only pose', () => {
  const snapshot = buildSnapshot(joinedStream())
  snapshot.pose = { x: 1, y: 64, z: 2, yaw: 90, pitch: 0 }

  const clientFrames = snapshotFrames(snapshot).map(frame =>
    frame.name === 'position' ? { ...frame, data: { ...frame.data, x: 9 } } : frame)
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: false,
    chunks: true,
    blocks: true,
    entities: true
  })
  assert.equal(report.domains.pose.expected.x, 1)
  assert.equal(report.domains.pose.actual.x, 9)
})

test('a missing chunk fails only chunks', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'map_chunk', data: { x: 1, z: 0 } }
  ))

  const clientFrames = snapshotFrames(snapshot).filter(frame =>
    !(frame.name === 'map_chunk' && frame.data.x === 1))
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: false,
    blocks: true,
    entities: true
  })
  assert.deepEqual(report.domains.chunks.diff.missing, ['1,0'])
})

test('a block change missing from the client frames fails only blocks and names the key', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'block_change', data: { location: { x: 2, y: 64, z: 3 }, type: 11 } }
  ))

  const clientFrames = snapshotFrames(snapshot).filter(frame => frame.name !== 'block_change')
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: false,
    entities: true
  })
  assert.deepEqual(report.domains.blocks.diff.missing, ['2,64,3'])
  assert.deepEqual(report.domains.blocks.diff.unexpected, [])
  assert.deepEqual(report.domains.blocks.diff.changed, [])
})

test('a block value that differs on the client fails only blocks and names the key', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'block_change', data: { location: { x: 2, y: 64, z: 3 }, type: 11 } }
  ))

  const clientFrames = snapshotFrames(snapshot).map(frame =>
    frame.name === 'block_change'
      ? { ...frame, data: { ...frame.data, type: 12 } }
      : frame)
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: false,
    entities: true
  })
  assert.deepEqual(report.domains.blocks.diff.changed, [{
    key: '2,64,3',
    expected: 11,
    actual: 12
  }])
  assert.deepEqual(report.domains.blocks.diff.missing, [])
  assert.deepEqual(report.domains.blocks.diff.unexpected, [])
})

test('an entity metadata value that differs on the client fails only entities', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } }
  ))

  const clientFrames = snapshotFrames(snapshot).map(frame =>
    frame.name === 'entity_metadata'
      ? {
          ...frame,
          data: { ...frame.data, metadata: [{ key: 0, type: 'byte', value: 2 }] }
        }
      : frame)
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: true,
    entities: false
  })

  const change = report.domains.entities.diff.changed.find(entry => entry.entityId === 9)
  assert.ok(change, 'the diff names the entity id')
  assert.deepEqual(change.expected.fields, [{ key: 0, value: 1 }])
  assert.deepEqual(change.actual.fields, [{ key: 0, value: 2 }])
  assert.equal(change.expected.removed, false)
  assert.equal(change.actual.removed, false)
})

test('a dropped remove_entities tombstone fails entities', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'remove_entities', data: { entityIds: [9] } }
  ))

  const clientFrames = snapshotFrames(snapshot).filter(frame => frame.name !== 'remove_entities')
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: true,
    entities: false
  })

  const change = report.domains.entities.diff.changed.find(entry => entry.entityId === 9)
  assert.ok(change, 'the diff names the entity id')
  assert.equal(change.expected.removed, true)
  assert.deepEqual(change.expected.fields, [])
  assert.equal(change.actual.removed, false)
  assert.deepEqual(change.actual.fields, [{ key: 0, value: 1 }])
})

test('a dropped entity_destroy tombstone fails entities', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'entity_destroy', data: { entityIds: [9] } }
  ))

  const clientFrames = snapshotFrames(snapshot).filter(frame => frame.name !== 'entity_destroy')
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.equal(report.ok, false)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true,
    blocks: true,
    entities: false
  })

  const change = report.domains.entities.diff.changed.find(entry => entry.entityId === 9)
  assert.ok(change, 'the diff names the entity id')
  assert.equal(change.expected.removed, true)
  assert.deepEqual(change.expected.fields, [])
  assert.equal(change.actual.removed, false)
  assert.deepEqual(change.actual.fields, [{ key: 0, value: 1 }])
})

test('block diffs order by coordinate and classify missing and unexpected keys', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'block_change', data: { location: { x: 10, y: 0, z: 0 }, type: 1 } },
    { name: 'block_change', data: { location: { x: 2, y: 0, z: 0 }, type: 2 } }
  ))

  const clientFrames = snapshotFrames(snapshot)
    .filter(frame => !(frame.name === 'block_change' && frame.data.location.x === 10))
    .concat({ name: 'block_change', data: { location: { x: 3, y: 0, z: 0 }, type: 3 } })
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.deepEqual(report.domains.blocks.expected.map(entry => entry.key), ['2,0,0', '10,0,0'])
  assert.deepEqual(report.domains.blocks.diff.missing, ['10,0,0'])
  assert.deepEqual(report.domains.blocks.diff.unexpected, ['3,0,0'])
  assert.deepEqual(report.domains.blocks.diff.changed, [])
})

test('entity diffs order by id and classify missing and unexpected ids', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'entity_metadata', data: { entityId: 10, metadata: [{ key: 0, type: 'byte', value: 1 }] } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] } }
  ))

  const clientFrames = snapshotFrames(snapshot)
    .filter(frame => !(frame.name === 'entity_metadata' && frame.data.entityId === 10))
    .concat({ name: 'entity_metadata', data: { entityId: 8, metadata: [{ key: 0, type: 'byte', value: 1 }] } })
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames })

  assert.deepEqual(report.domains.entities.expected.map(entry => entry.entityId), [9, 10])
  assert.deepEqual(report.domains.entities.diff.missing, [10])
  assert.deepEqual(report.domains.entities.diff.unexpected, [8])
  assert.deepEqual(report.domains.entities.diff.changed, [])
})

test('a bigint entity id and field value stay JSON-safe', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'entity_metadata', data: { entityId: 9n, metadata: [{ key: 0, type: 'long', value: 5n }] } }
  ))

  const report = parityReport({ cacheSnapshot: snapshot, clientFrames: snapshotFrames(snapshot) })

  assert.equal(report.ok, true)
  assert.doesNotThrow(() => JSON.stringify(report))
  assert.deepEqual(report.domains.entities.expected, [{
    entityId: '9',
    removed: false,
    fields: [{ key: 0, value: '5' }]
  }])
})

test('every state-cache domain is compared or excused in UNPARITY', () => {
  assertDomainCoverage(DOMAINS)

  for (const [domain, reason] of Object.entries(UNPARITY)) {
    assert.equal(typeof reason, 'string', `${domain} reason is a string`)
    assert.ok(reason.trim().length > 0, `${domain} reason is non-empty`)
  }
  for (const domain of Object.keys(DOMAIN_PARITY)) {
    assert.ok(DOMAINS.includes(domain), `${domain} is a state-cache domain`)
  }

  // A domain added to DOMAINS without a comparison must fail the check.
  assert.throws(
    () => assertDomainCoverage([...DOMAINS, 'new_domain']),
    /no parity comparison/
  )
  // A name that happens to match a parity domain gains nothing from the name.
  assert.throws(
    () => assertDomainCoverage([...DOMAINS, 'blocks']),
    /no parity comparison/
  )
})

test('snapshotFrames order matches join-synth.synthAttach, move frames merged included', () => {
  const cache = createStateCache()
  cache.push('configuration', 'registry_data', Buffer.from('config:registry_data'), {})
  cache.push('configuration', 'select_known_packs', Buffer.from('config:select_known_packs'), {})

  const stream = joinedStream(
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } },
    { name: 'spawn_entity', data: { entityId: 9, x: 0, y: 64, z: 0, yaw: 0, pitch: 0 } },
    // The delta comes after the spawn and before the metadata: the entity ring
    // holds the two absolutes, the generic ring holds the delta, and the replay
    // must keep the wire order.
    { name: 'rel_entity_move', data: { entityId: 9, dX: 4096, dY: 0, dZ: 0 } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [] } },
    { name: 'window_items', data: { windowId: 0, stateId: 1, items: [item(1)] } },
    { name: 'held_item_slot', data: { slot: 2 } },
    { name: 'update_health', data: { health: 19 } }
  )
  stream.forEach((frame, index) => {
    cache.push('play', frame.name, Buffer.from(`${frame.name}:${index}`), frame.data ?? {})
  })
  const snapshot = cache.snapshot()

  const expected = [
    'registry_data', 'select_known_packs',
    'login', 'map_chunk', 'chunk_batch_finished',
    'map_chunk', // warm chunk
    'block_change',
    // entity state, with the relative move frames in capture order
    'spawn_entity', 'rel_entity_move', 'entity_metadata',
    'window_items', // inventories
    'held_item_slot', // latest
    'update_health' // generic, which keeps its place
  ]
  assert.deepEqual(snapshotFrames(snapshot).map(frame => frame.name), expected)

  // join-synth omits the per-attach synthesized position; every replayed frame
  // must appear in the same order.
  const { frames } = synthAttach({ snapshot, pose: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 } })
  assert.deepEqual(
    frames.filter(frame => frame.synth !== 'position').map(frame => frame.name),
    expected
  )
})

test('parityReport returns JSON-safe values', () => {
  const snapshot = buildSnapshot(joinedStream(
    { name: 'set_slot', data: { windowId: 0, stateId: 1, slot: 0, item: { itemCount: 1n, itemId: 5 } } }
  ))
  const report = parityReport({ cacheSnapshot: snapshot, clientFrames: snapshotFrames(snapshot) })

  assert.equal(report.ok, true)
  assert.doesNotThrow(() => JSON.stringify(report))
  assert.deepEqual(report.domains.inventory.expected[0].slots[0].item, { itemCount: '1', itemId: 5 })
})

test('parityEvidence keeps diffs and scalar values but drops replayed state', () => {
  const evidence = parityEvidence({
    inventory: { ok: true, expected: [{ windowId: 0 }], actual: [{ windowId: 0 }] },
    blocks: {
      ok: false,
      expected: [{ key: '1,2,3' }],
      actual: [],
      diff: { missing: ['1,2,3'], unexpected: [], changed: [] }
    },
    heldItemSlot: { ok: false, expected: 3, actual: 4 }
  })

  assert.deepEqual(evidence.inventory, { ok: true })
  assert.deepEqual(evidence.blocks, {
    ok: false,
    diff: { missing: ['1,2,3'], unexpected: [], changed: [] }
  })
  assert.deepEqual(evidence.heldItemSlot, { ok: false, expected: 3, actual: 4 })
})

// --- N13: the attach replay is the expectation, not the live cache ----------
//
// The cache rings are bounded FIFOs. Live traffic during the parity wait can
// evict a frame the client already received, so comparing a post-settle
// snapshot with every captured frame fails on a correct cache (issue #24).
// attachParity compares the snapshot taken when the replay was built with the
// first K captured frames, where K is the number of parity frames the replay
// sent.

// Build the attach the way the core does: snapshot, replay frames, and the
// frames the client decodes from that replay.
function attachCut (stream, overrides = {}) {
  const cache = createStateCache(overrides)
  stream.forEach((frame, index) => {
    cache.push('play', frame.name, Buffer.from(`${frame.name}:${index}`), frame.data ?? {})
  })
  const snapshot = cache.snapshot()
  const pose = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0 }
  const { frames } = synthAttach({ snapshot, pose })
  return {
    cache,
    attachSnapshot: { ...snapshot, pose },
    replayFrames: frames,
    clientFrames: decodedReplay(snapshotFrames({ ...snapshot, pose }), frames)
  }
}

// The frames the client decodes, in the order the proxy wrote them: the replay
// order, restricted to the names the parity model captures. The cache snapshot
// supplies the decoded fields for each replayed buffer.
function decodedReplay (decoded, replayFrames) {
  const pool = new Map()
  for (const frame of decoded) {
    if (!pool.has(frame.name)) pool.set(frame.name, [])
    pool.get(frame.name).push(frame)
  }
  return parityReplayNames(replayFrames).map(name => {
    const queue = pool.get(name)
    if (!queue || queue.length === 0) throw new Error(`no decoded frame for replayed ${name}`)
    return queue.shift()
  })
}

test('attachParity passes when live traffic evicts the entity the client already has', () => {
  const cut = attachCut(
    joinedStream(
      { name: 'entity_metadata', data: { entityId: 1, metadata: [{ key: 0, type: 'byte', value: 7 }] } }
    ),
    { maxEntities: 2 }
  )

  // Live frames after the attach push entity 1 out of the 2048-entry ring.
  cut.cache.push('play', 'entity_metadata', Buffer.from('live:2'), { entityId: 2, metadata: [] })
  cut.cache.push('play', 'entity_metadata', Buffer.from('live:3'), { entityId: 3, metadata: [] })
  assert.equal(cut.cache.snapshot().entities.some(frame => frame.data.entityId === 1), false)

  // The cut snapshot still holds entity 1, so the replay is verified.
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: cut.clientFrames,
    settled: true
  })
  assert.equal(evidence.ok, true, JSON.stringify(evidence.domains))
  assert.equal(evidence.expectedFrames, cut.replayFrames.filter(frame => PARITY_FRAME_NAMES.has(frame.name)).length)
  assert.equal(evidence.capturedFrames, evidence.expectedFrames)
})

test('attachParity ignores live frames captured after the replay', () => {
  const cut = attachCut(joinedStream(
    { name: 'entity_metadata', data: { entityId: 1, metadata: [] } }
  ))

  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    // A live frame the cache never replayed trails the capture.
    clientFrames: [...cut.clientFrames, { name: 'entity_metadata', data: { entityId: 99, metadata: [] } }],
    settled: true
  })
  assert.equal(evidence.ok, true, JSON.stringify(evidence.domains))
})

test('attachParity fails when the replay diverges from the cache', () => {
  const cut = attachCut(joinedStream(
    { name: 'entity_metadata', data: { entityId: 1, metadata: [] } },
    { name: 'entity_teleport', data: { entityId: 9, x: 7, y: 64, z: 0, yaw: 0, pitch: 0 } }
  ))

  const clientFrames = cut.clientFrames.map(frame =>
    frame.name === 'entity_teleport' ? { name: frame.name, data: { ...frame.data, x: 5 } } : frame)

  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames,
    settled: true
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.names.ok, true) // the same frames, a different state
  assert.equal(evidence.domains.entities.ok, false)
})

test('attachParity fails when the replay never settled', () => {
  const cut = attachCut(joinedStream())
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: cut.clientFrames,
    settled: false
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.settled, false)
  // Unsettled is the only reason this run fails: the compared state agrees.
  assert.equal(evidence.domains.chunks.ok, true)
})

test('attachParity fails when fewer parity frames arrived than the replay sent', () => {
  const cut = attachCut(joinedStream(
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } }
  ))
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: cut.clientFrames.slice(0, cut.clientFrames.length - 1),
    settled: true // the caller claims settled; the count says otherwise
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.capturedFrames, evidence.expectedFrames - 1)
})

test('attachParity fails when a live frame slips into the replay prefix', () => {
  const cut = attachCut(joinedStream(
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } }
  ))
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    // A frame the front relayed before the replay finished shifts the cut.
    clientFrames: [{ name: 'set_slot', data: { windowId: 0, slot: 1, item: { itemCount: 1 } } }, ...cut.clientFrames],
    settled: true
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.names.ok, false)
  assert.ok(evidence.names.actual.includes('set_slot'))
})

test('attachParity fails closed when the replay carried no parity frame', () => {
  const cut = attachCut(joinedStream())
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames.filter(frame => !PARITY_FRAME_NAMES.has(frame.name)),
    clientFrames: [],
    settled: true
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.expectedFrames, 0)
})

test('parityNameEvidence keeps the counts and trims a name mismatch', () => {
  const expected = Array.from({ length: 40 }, (_, index) => `frame_${index}`)
  const matched = parityNameEvidence({ ok: true, expected, actual: expected.slice() })
  assert.deepEqual(matched, { ok: true, expectedFrames: 40, actualFrames: 40 })

  const actual = expected.slice()
  actual[3] = 'stray_frame'
  const mismatch = parityNameEvidence({ ok: false, expected, actual })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.mismatchAt, 3)
  assert.equal(mismatch.expected.length, 12)
  assert.equal(mismatch.actual.length, 12)
  assert.equal(mismatch.expected[3], 'frame_3')
  assert.equal(mismatch.actual[3], 'stray_frame')

  // A short capture names its first missing index, not -1.
  assert.equal(parityNameEvidence({ ok: false, expected, actual: expected.slice(0, 5) }).mismatchAt, 5)
  assert.equal(parityNameEvidence(null), null)
})

test('attachParity compares where a moved entity ends, not just its last absolute', () => {
  // Issue #35: the parity model used to ignore the delta frames, so both sides
  // agreed on the absolute position and a wrong replay passed.
  const cut = attachCut(joinedStream(
    { name: 'spawn_entity', data: { entityId: 9, x: 0, y: 64, z: 0, yaw: 0, pitch: 0 } },
    { name: 'rel_entity_move', data: { entityId: 9, dX: 4096, dY: 0, dZ: 0 } },
    { name: 'rel_entity_move', data: { entityId: 9, dX: 4096, dY: 0, dZ: 0 } }
  ))

  const moved = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: cut.clientFrames,
    settled: true
  })
  assert.equal(moved.ok, true, JSON.stringify(moved.domains))
  const entity = moved.domains.entities.expected.find(entry => entry.entityId === 9)
  const fields = Object.fromEntries(entity.fields.map(field => [field.key, field.value]))
  assert.equal(fields.x, 2) // 0 + 1 + 1, exactly where the backend ended

  // One delta applied differently on the client is a mismatch in entities.
  const skewed = cut.clientFrames.map(frame =>
    frame.name === 'rel_entity_move' ? { name: frame.name, data: { ...frame.data, dX: 4096 * 5 } } : frame)
  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: skewed,
    settled: true
  })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.domains.entities.ok, false)
})

test('attachParity sees an effect the old section order would have kept', () => {
  // #222, at the attach seam. The add is captured before its removal, so the
  // newest frame about effect 1 is the removal and the replay sends it alone.
  // The parity cut counts the effect frames now, so a client that was served the
  // add as well parts from the expectation at that frame.
  const cut = attachCut(joinedStream(
    { name: 'spawn_entity', data: { entityId: 9, x: 0, y: 64, z: 0, yaw: 0, pitch: 0 } },
    { name: 'entity_effect', data: { entityId: 9, effectId: 1, amplifier: 0, duration: 200, flags: 0 } },
    { name: 'remove_entity_effect', data: { entityId: 9, effectId: 1 } }
  ))

  const evidence = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: cut.clientFrames,
    settled: true
  })
  assert.equal(evidence.ok, true, JSON.stringify(evidence.domains))
  assert.deepEqual(
    evidence.names.expected.filter(name => name.endsWith('effect') || name === 'remove_entity_effect'),
    ['remove_entity_effect'],
    'the pair collapses to the frame that ended the effect'
  )

  const entity = evidence.domains.entities.expected.find(entry => entry.entityId === 9)
  const fields = Object.fromEntries(entity.fields.map(field => [field.key, field.value]))
  assert.equal(fields['effect:1'], undefined)

  // A section-ordered replay sends the add too: the client's frame stream then
  // carries a frame the expectation does not, and the cut names where they part.
  const staleOrder = [...cut.clientFrames]
  const at = staleOrder.findIndex(frame => frame.name === 'spawn_entity')
  staleOrder.splice(at + 1, 0, {
    name: 'entity_effect',
    data: { entityId: 9, effectId: 1, amplifier: 0, duration: 200, flags: 0 }
  })
  const stale = attachParity({
    attachSnapshot: cut.attachSnapshot,
    replayFrames: cut.replayFrames,
    clientFrames: staleOrder,
    settled: true
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.names.ok, false)
  const parted = stale.names.expected.findIndex((name, index) => name !== stale.names.actual[index])
  assert.equal(parted, evidence.expectedFrames - 1, 'the two streams part at the frame the stale order kept')
})

test('N13 fails the run on a parity mismatch and passes only on a settled ok', () => {
  assert.ok(ONLINE_ASSERTION_IDS.includes('N13'))

  const n13 = evidence => evaluateOnlineAssertions({ parity: evidence })
    .find(assertion => assertion.id === 'N13')

  const mismatch = n13({
    ok: false,
    settled: true,
    domains: { inventory: { ok: false, diff: { changes: [{ slot: 36 }] } } }
  })
  assert.equal(mismatch.status, 'fail')
  assert.equal(mismatch.detail.domains.inventory.ok, false)

  // A cut that never settled cannot pass, even with an empty diff: the compared
  // frames may be a prefix of a replay that had not finished.
  const unsettled = n13({ ok: true, settled: false, domains: {} })
  assert.equal(unsettled.status, 'fail')
  assert.equal(unsettled.detail.settled, false)

  const passed = n13({ ok: true, settled: true, domains: {} })
  assert.equal(passed.status, 'pass')
  assert.equal(passed.ok, true)
})

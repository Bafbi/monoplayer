// Unit target: src/ladder/state-parity.js, the live attach parity guard.
//
// Each test builds the cache snapshot the way an attach would see it, then
// feeds the client a stream that differs in exactly one domain. The matching
// domain must fail and the others must pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateCache } from '../src/monoplayer/state-cache.js'
import { synthAttach } from '../src/monoplayer/join-synth.js'
import {
  ONLINE_ASSERTION_IDS,
  evaluateOnlineAssertions
} from '../src/ladder/online.js'
import {
  PARITY_DOMAINS,
  PARITY_SECTIONS,
  snapshotFrames,
  parityReport
} from '../src/ladder/state-parity.js'

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

test('matching snapshot and client frames pass every domain', () => {
  const items = baseItems()
  items[36] = item(1)
  const snapshot = buildSnapshot(joinedStream(
    { name: 'window_items', data: { windowId: 0, stateId: 1, items } },
    { name: 'set_slot', data: { windowId: 0, stateId: 1, slot: 40, item: item(7) } },
    { name: 'held_item_slot', data: { slot: 3 } },
    { name: 'map_chunk', data: { x: 1, z: 0 } }
  ))
  // The proxy synthesizes the attach position; the cache never stores it.
  snapshot.pose = { x: 1.5, y: 64.62, z: -2.5, yaw: 90, pitch: -10 }

  const report = parityReport({ cacheSnapshot: snapshot, clientFrames: snapshotFrames(snapshot) })

  assert.equal(report.ok, true)
  assertDomains(report, {
    inventory: true,
    heldItemSlot: true,
    pose: true,
    chunks: true
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
    chunks: true
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
    chunks: true
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
    chunks: true
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
    chunks: false
  })
  assert.deepEqual(report.domains.chunks.diff.missing, ['1,0'])
})

test('snapshotFrames order matches join-synth.synthAttach', () => {
  const cache = createStateCache()
  cache.push('configuration', 'registry_data', Buffer.from('config:registry_data'), {})
  cache.push('configuration', 'select_known_packs', Buffer.from('config:select_known_packs'), {})

  const stream = joinedStream(
    { name: 'map_chunk', data: { x: 1, z: 0 } },
    { name: 'block_change', data: { location: { x: 1, y: 64, z: 0 }, type: 5 } },
    { name: 'entity_metadata', data: { entityId: 9, metadata: [] } },
    { name: 'window_items', data: { windowId: 0, stateId: 1, items: [item(1)] } },
    { name: 'held_item_slot', data: { slot: 2 } },
    { name: 'update_health', data: { health: 19 } }
  )
  stream.forEach((frame, index) => {
    cache.push('play', frame.name, Buffer.from(`${frame.name}:${index}`), frame.data ?? {})
  })
  const snapshot = cache.snapshot()

  const expected = PARITY_SECTIONS.flatMap(section =>
    snapshot[section].map(frame => frame.name))
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

test('N13 fails the run on a parity mismatch and passes only on ok', () => {
  assert.ok(ONLINE_ASSERTION_IDS.includes('N13'))

  const failed = evaluateOnlineAssertions({
    parity: { ok: false, domains: { inventory: { ok: false, diff: { changes: [{ slot: 36 }] } } } }
  }).find(assertion => assertion.id === 'N13')
  assert.equal(failed.status, 'fail')
  assert.equal(failed.detail.domains.inventory.ok, false)

  const passed = evaluateOnlineAssertions({ parity: { ok: true, domains: {} } })
    .find(assertion => assertion.id === 'N13')
  assert.equal(passed.status, 'pass')
  assert.equal(passed.ok, true)
})

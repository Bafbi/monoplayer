// B1 target: state-cache classification, bounds, overflow, snapshot grouping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateCache, classifyPlay, classifyConfig } from '../../src/core/state-cache.js'

const buf = label => Buffer.from(`cache:${label}`)
const frame = name => ({ name, buffer: buf(name), data: {} })

test('classification: per-leg-owned play frames are never cached', () => {
  for (const name of ['keep_alive', 'position', 'player_chat', 'profileless_chat', 'hide_message', 'system_chat', 'ping', 'bundle_delimiter']) {
    assert.equal(classifyPlay(name).domain, 'drop', name)
  }
})

test('bundle delimiters are dropped; enclosed packets remain cacheable', () => {
  const cache = createStateCache()
  cache.push('play', 'bundle_delimiter', buf('bundle_delimiter'), {})
  cache.push('play', 'add_entity', buf('add_entity'), { entityId: 5 })
  cache.push('play', 'bundle_delimiter', buf('bundle_delimiter'), {})
  const snapshot = cache.snapshot()
  assert.equal(snapshot.prefix.some(f => f.name === 'bundle_delimiter'), false)
  assert.equal(snapshot.prefix.some(f => f.name === 'add_entity'), true)
})

test('classification: chunk/block/entity/inventory/latest/generic domains', () => {
  assert.deepEqual(classifyPlay('map_chunk'), { domain: 'chunk', op: 'set' })
  assert.deepEqual(classifyPlay('unload_chunk'), { domain: 'chunk', op: 'remove' })
  assert.equal(classifyPlay('block_update').domain, 'block')
  assert.equal(classifyPlay('entity_metadata').domain, 'entity')
  assert.equal(classifyPlay('window_items').domain, 'inventory')
  assert.equal(classifyPlay('health').domain, 'latest')
  assert.equal(classifyPlay('bossbar').domain, 'generic')
})

test('classification: configuration keep-alives drop, unknown config frames cache', () => {
  assert.equal(classifyConfig('keep_alive').domain, 'drop')
  assert.equal(classifyConfig('ping').domain, 'drop')
  assert.equal(classifyConfig('pong').domain, 'drop')
  assert.equal(classifyConfig('registry_data').domain, 'config')
})

test('classification: 26.2 entity names share the entity domain, relative moves stay generic', () => {
  // GitHub issue #23: the entity domain held the pre-rename spellings while the
  // live 26.2 names fell through to `generic`, which join-synth replays after
  // `entity`, so wire order between the two domains was lost.
  for (const name of ['sync_entity_position', 'entity_destroy']) {
    assert.equal(classifyPlay(name).domain, 'entity', name)
  }
  // Relative moves and rotations keep falling to `generic`: they are per-tick
  // deltas, and an entity slot holds the newest frame for its key, so promoting
  // them would replay the last delta and none of the ones it built on.
  for (const name of ['rel_entity_move', 'entity_move_look', 'entity_look']) {
    assert.equal(classifyPlay(name).domain, 'generic', name)
  }
})

test('join prefix is pinned in order and completes at chunk_batch_finished', () => {
  const cache = createStateCache()
  // Backend position is per-leg owned and dropped at capture; join-synth owns
  // the synthesized one. The rest of the join sequence pins verbatim.
  const warmNames = ['login', 'game_state_change', 'chunk_batch_start', 'map_chunk', 'chunk_batch_finished']
  for (const name of warmNames) cache.push('play', name, buf(name), { x: 0, z: 0 })
  cache.push('play', 'position', buf('position'), { teleportId: 9 })

  assert.deepEqual(cache.snapshot().prefix.map(f => f.name), warmNames)
  assert.equal(cache.warm, true)
  assert.equal(cache.stats().metrics.warmComplete, 1)

  // After warm, play frames leave the prefix and go to their domains.
  cache.push('play', 'block_update', buf('block_update'), { x: 1, z: 2 })
  assert.equal(cache.stats().sizes.prefix, warmNames.length)
  assert.deepEqual(cache.snapshot().blocks.map(f => f.name), ['block_update'])
})

test('warm chunk map_chunk is keyed and unload_chunk removes it', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('marker'))
  assert.equal(cache.warm, true)

  cache.push('play', 'map_chunk', buf('chunk-0-0'), { x: 0, z: 0 })
  cache.push('play', 'map_chunk', buf('chunk-1-0'), { x: 1, z: 0 })
  // same chunk again: latest wins, single entry
  cache.push('play', 'map_chunk', buf('chunk-0-0-v2'), { x: 0, z: 0 })
  assert.deepEqual(cache.snapshot().chunks.map(f => f.data.x), [1, 0])
  assert.equal(cache.snapshot().chunks[1].buffer.toString(), 'cache:chunk-0-0-v2')

  cache.push('play', 'unload_chunk', buf('unload'), { x: 1, z: 0 })
  assert.deepEqual(cache.snapshot().chunks.map(f => f.data.x), [0])
  assert.equal(cache.stats().sizes.chunks, 1)
  // The wire decodes unload_chunk as chunkX/chunkZ, not x/z. Keying only on
  // x/z made every live unload a silent no-op.
  cache.push('play', 'unload_chunk', buf('unload-decoded'), { chunkX: 0, chunkZ: 0 })
  assert.equal(cache.stats().sizes.chunks, 0)
})

test('bounded rings overflow honestly (counted eviction, FIFO); the entity bound counts entities', () => {
  const cache = createStateCache({ maxBlocks: 3, maxGeneric: 2, maxEntities: 2 })
  cache.push('play', 'chunk_batch_finished', buf('warm'))
  for (let i = 0; i < 5; i++) cache.push('play', 'block_update', buf(`b${i}`), { x: i, z: 0 })
  for (let i = 0; i < 4; i++) cache.push('play', 'bossbar', buf(`g${i}`), {})
  for (let i = 0; i < 3; i++) cache.push('play', 'entity_metadata', buf(`e${i}`), { entityId: i })

  const snap = cache.snapshot()
  assert.deepEqual(snap.blocks.map(f => f.buffer.toString()), ['cache:b2', 'cache:b3', 'cache:b4'])
  assert.deepEqual(snap.generic.map(f => f.buffer.toString()), ['cache:g2', 'cache:g3'])
  assert.deepEqual(snap.entities.map(f => f.buffer.toString()), ['cache:e1', 'cache:e2'])

  const m = cache.stats().metrics.overflows
  assert.equal(m.block, 2)
  assert.equal(m.generic, 2)
  assert.equal(m.entity, 1)
})

test('the entity domain is bounded by maxEntities, not maxGeneric', () => {
  const cache = createStateCache({ maxEntities: 2, maxGeneric: 8 })
  cache.push('play', 'chunk_batch_finished', buf('warm'))
  for (let i = 0; i < 4; i++) cache.push('play', 'entity_metadata', buf(`e${i}`), { entityId: i })
  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:e2', 'cache:e3'])
  assert.equal(cache.stats().metrics.overflows.entity, 2)
})

test('the entity domain keys metadata by index: a newer frame replaces only its index', () => {
  // #213: metadata is a map of indexes, so the last frame that wrote index 0
  // says nothing about index 1. Keying by arrival order made the two compete.
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'entity_metadata', buf('idx0-v1'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] })
  cache.push('play', 'entity_metadata', buf('idx0-v2'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 2 }] })
  cache.push('play', 'entity_metadata', buf('idx1'), { entityId: 9, metadata: [{ key: 1, type: 'int', value: 3 }] })

  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:idx0-v2', 'cache:idx1'])
  assert.equal(cache.stats().sizes.entities, 1, 'one entity, not one frame')
  assert.equal(cache.stats().entitySlots, 2, 'one slot per metadata index')
})

test('one metadata frame carrying several indexes is one entry and several slots', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'entity_metadata', buf('two-indexes'), {
    entityId: 9,
    metadata: [{ key: 0, type: 'byte', value: 1 }, { key: 1, type: 'byte', value: 2 }]
  })

  // The frame replays once: the two indexes share the one buffer it arrived in.
  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:two-indexes'])
  assert.equal(cache.stats().entitySlots, 2)
})

test('entity_effect keeps one slot per effect id', () => {
  // The frame adds one effect and removes none, so two effects are two slots and
  // a newer frame for one leaves the other alone.
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'entity_effect', buf('effect-1-v1'), { entityId: 9, effectId: 1 })
  cache.push('play', 'entity_effect', buf('effect-2'), { entityId: 9, effectId: 2 })
  cache.push('play', 'entity_effect', buf('effect-1-v2'), { entityId: 9, effectId: 1 })

  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:effect-2', 'cache:effect-1-v2'])
  assert.equal(cache.stats().entitySlots, 2)
})

test('an entity frame without decoded data keeps one shared record', () => {
  // The id and the metadata index are decoded fields, not buffer offsets, so a
  // caller that passes no `data` gets one id-less record per frame name. The
  // header of state-cache.js says the entity domain needs `data`; this pins what
  // happens when it is missing.
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn'), {})
  cache.push('play', 'entity_metadata', buf('meta-0'), {})
  cache.push('play', 'entity_metadata', buf('meta-1'), {})

  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:spawn', 'cache:meta-1'])
  assert.equal(cache.stats().sizes.entities, 1)
})

test('the entity bound counts entities, so one chatty entity cannot evict another', () => {
  // The defect of #213: eight metadata frames for entity 9 filled the old
  // 2048-frame ring and took entity 9's own spawn with them.
  const cache = createStateCache({ maxEntities: 2 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn-9'), { entityId: 9 })
  for (let index = 0; index < 8; index++) {
    cache.push('play', 'entity_metadata', buf(`meta-${index}`), { entityId: 9, metadata: [{ key: index, type: 'byte', value: index }] })
  }
  cache.push('play', 'spawn_entity', buf('spawn-10'), { entityId: 10 })

  const replay = cache.snapshot().entities.map(f => f.buffer.toString())
  assert.equal(replay.includes('cache:spawn-9'), true, 'the spawn survives its own entity metadata churn')
  assert.equal(cache.stats().sizes.entities, 2)
  assert.equal(cache.stats().metrics.overflows.entity, 0)
  assert.equal(cache.stats().metrics.overflows.entityDepth, 0)
})

test('an entity past its depth is dropped whole, never truncated', () => {
  // A head-truncated record replays the dropped index at the client default,
  // which is the defect. The whole entity goes instead.
  const cache = createStateCache({ maxEntitySlots: 3 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn'), { entityId: 9 })
  for (let index = 0; index < 3; index++) {
    cache.push('play', 'entity_metadata', buf(`meta-${index}`), { entityId: 9, metadata: [{ key: index, type: 'byte', value: index }] })
  }

  assert.deepEqual(cache.snapshot().entities, [], 'the whole entity went, not its oldest slot')
  assert.equal(cache.stats().sizes.entities, 0)
  assert.equal(cache.stats().entitySlots, 0)
  assert.equal(cache.stats().metrics.overflows.entityDepth, 1)
})

test('a respawn and a play login flush the whole entity domain', () => {
  // #213: a respawn is ordinary play state and nothing else in the pipeline
  // sees it, so the hook is the cache's own and a caller cannot forget it.
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('overworld'), { entityId: 9 })
  cache.push('play', 'entity_metadata', buf('overworld-meta'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] })
  assert.equal(cache.stats().sizes.entities, 1)

  cache.push('play', 'respawn', buf('respawn'), {})
  assert.deepEqual(cache.snapshot().entities, [], 'the new world has no entity id of the old one')
  assert.equal(cache.stats().metrics.entityFlushes, 1)

  // Nothing to flush is not a flush.
  cache.push('play', 'respawn', buf('respawn-2'), {})
  assert.equal(cache.stats().metrics.entityFlushes, 1)

  cache.push('play', 'spawn_entity', buf('next-session'), { entityId: 11 })
  cache.push('play', 'login', buf('login'), { entityId: 42 })
  assert.deepEqual(cache.snapshot().entities, [])
  assert.equal(cache.stats().metrics.entityFlushes, 2)

  // The explicit form answers the count it dropped.
  cache.push('play', 'spawn_entity', buf('again'), { entityId: 12 })
  assert.deepEqual(cache.flushEntities('stopped'), { flushed: 1, reason: 'stopped' })
  assert.equal(cache.stats().metrics.entityFlushes, 3)
})

test('a removal for a body the cache never held spends no entity and still replays', () => {
  // Every entity the join prefix spawned is in this position: the prefix replays
  // verbatim and the domain never saw the spawn. A record per such id would let a
  // busy world's removals evict the bodies that are still alive.
  const cache = createStateCache({ maxEntities: 16 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn-9'), { entityId: 9 })
  for (let id = 100; id < 110; id++) {
    cache.push('play', 'entity_destroy', buf(`destroy-${id}`), { entityIds: [id] })
  }

  assert.equal(cache.stats().sizes.entities, 1, 'the live body is still the only entity')
  assert.equal(cache.stats().entityRemovals, 10, 'the removals wait without a record each')
  assert.equal(cache.stats().metrics.overflows.entity, 0, 'nothing was evicted for them')
  const replay = cache.snapshot().entities.map(f => f.buffer.toString())
  assert.equal(replay.includes('cache:spawn-9'), true)
  assert.equal(replay.includes('cache:destroy-100'), true)
})

test('a body the bounds dropped stays dropped until a spawn restarts it', () => {
  // Replaying metadata for a body with no spawn hands the client an entity it
  // cannot model, which is the defect #213 exists to fix (#218 measures it).
  const cache = createStateCache({ maxEntities: 1 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn-9'), { entityId: 9 })
  cache.push('play', 'spawn_entity', buf('spawn-10'), { entityId: 10 }) // evicts 9
  assert.equal(cache.stats().metrics.overflows.entity, 1)

  cache.push('play', 'entity_metadata', buf('orphan'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] })
  assert.equal(cache.stats().metrics.entitySuppressed, 1)
  assert.deepEqual(cache.snapshot().entities.map(f => f.name), ['spawn_entity'], 'no metadata without its spawn')

  // A spawn is what a body starts from, and `add_entity` is the same frame under
  // its pre-rename spelling.
  cache.push('play', 'add_entity', buf('add-9'), { entityId: 9 })
  cache.push('play', 'entity_metadata', buf('meta-9'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 2 }] })
  assert.equal(cache.stats().metrics.entitySuppressed, 1)
  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:add-9', 'cache:meta-9'])
})

test('the slot bound caps the domain as a number, not as a product', () => {
  // maxEntities x maxEntitySlots is the pathological product, so the domain also
  // bounds the slots it holds and evicts the least recently updated body.
  const cache = createStateCache({ maxEntities: 4, maxEntityFrames: 3 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  for (const id of [9, 10, 11, 12]) cache.push('play', 'spawn_entity', buf(`spawn-${id}`), { entityId: id })

  assert.equal(cache.stats().entitySlots, 3)
  assert.equal(cache.stats().sizes.entities, 3)
  assert.equal(cache.stats().metrics.overflows.entityFrames, 1)
  assert.equal(cache.stats().metrics.overflows.entity, 0, 'the count bound never fired')
  assert.deepEqual(
    cache.snapshot().entities.map(f => f.buffer.toString()),
    ['cache:spawn-10', 'cache:spawn-11', 'cache:spawn-12']
  )
})

test('restore keeps the dropped ids and the removals that have no record', () => {
  const cache = createStateCache({ maxEntities: 1 })
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'entity_destroy', buf('destroy-100'), { entityIds: [100] })
  cache.push('play', 'spawn_entity', buf('spawn-9'), { entityId: 9 })
  cache.push('play', 'spawn_entity', buf('spawn-10'), { entityId: 10 }) // evicts 9
  const before = cache.snapshot()
  assert.deepEqual(before.entityDropped, [9])
  assert.deepEqual(before.entities.map(f => f.buffer.toString()), ['cache:destroy-100', 'cache:spawn-10'])

  cache.reset()
  cache.restore(before)

  assert.deepEqual(cache.snapshot().entityDropped, [9], 'the suppression travels with the snapshot')
  assert.equal(cache.stats().sizes.entities, 1, 'the untracked removal creates no record')
  assert.equal(cache.stats().entityRemovals, 1)
  cache.push('play', 'entity_metadata', buf('orphan'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] })
  assert.equal(cache.stats().metrics.entitySuppressed, 1)
  assert.deepEqual(cache.snapshot().entities.map(f => f.buffer.toString()), ['cache:destroy-100', 'cache:spawn-10'])
})

test('restore rebuilds the keyed entity map, slots and capture order intact', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'), {})
  cache.push('play', 'spawn_entity', buf('spawn'), { entityId: 9 })
  cache.push('play', 'entity_metadata', buf('meta-0'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 1 }] })
  cache.push('play', 'entity_metadata', buf('meta-0-new'), { entityId: 9, metadata: [{ key: 0, type: 'byte', value: 2 }] })
  cache.push('play', 'entity_metadata', buf('meta-1'), { entityId: 9, metadata: [{ key: 1, type: 'int', value: 3 }] })
  const before = cache.snapshot()

  cache.reset()
  cache.restore(before)

  const names = () => cache.snapshot().entities.map(f => f.buffer.toString())
  assert.deepEqual(names(), ['cache:spawn', 'cache:meta-0-new', 'cache:meta-1'], 'capture order, superseded frame gone')
  assert.equal(cache.stats().sizes.entities, 1)
  assert.equal(cache.stats().entitySlots, 3)

  // The keying rule came back with the map: writing index 1 again replaces only
  // index 1.
  cache.push('play', 'entity_metadata', buf('meta-1-new'), { entityId: 9, metadata: [{ key: 1, type: 'int', value: 4 }] })
  assert.deepEqual(names(), ['cache:spawn', 'cache:meta-0-new', 'cache:meta-1-new'])
})

test('inventories keep the newest frame per windowId and bound the map', () => {
  const cache = createStateCache({ maxInventories: 2 })
  cache.push('play', 'chunk_batch_finished', buf('warm'))
  cache.push('play', 'window_items', buf('win0-v1'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('win0-v2'), { windowId: 0, slot: 36 })
  cache.push('play', 'window_items', buf('win1'), { windowId: 1 })
  cache.push('play', 'window_items', buf('win9'), { windowId: 9 }) // evicts win0 (oldest insertion)

  // Evicted oldest-by-last-update; insertion order preserved for replay. The
  // evicted window takes its slot updates with it.
  const inv = cache.snapshot().inventories
  assert.equal(inv.length, 2)
  assert.deepEqual(inv.map(f => f.data.windowId), [1, 9])
  assert(inv.some(f => f.buffer.toString() === 'cache:win0-v2') === false)
  assert.equal(cache.stats().metrics.evictions.inventory, 1)
})

test('inventory replay keeps the full window frame and the slots changed after it', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'))
  cache.push('play', 'window_items', buf('win0-v1'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('slot36'), { windowId: 0, slot: 36 })
  cache.push('play', 'set_slot', buf('slot40'), { windowId: 0, slot: 40 })

  let inv = cache.snapshot().inventories
  assert.deepEqual(inv.map(f => f.buffer.toString()), ['cache:win0-v1', 'cache:slot36', 'cache:slot40'])

  // A newer full window frame supersedes the earlier per-slot updates.
  cache.push('play', 'window_items', buf('win0-v2'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('slot44'), { windowId: 0, slot: 44 })
  inv = cache.snapshot().inventories
  assert.deepEqual(inv.map(f => f.buffer.toString()), ['cache:win0-v2', 'cache:slot44'])
})

test('latest domain keeps one newest frame per volatile name', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('warm'))
  cache.push('play', 'health', buf('hp20'), { health: 20 })
  cache.push('play', 'health', buf('hp17'), { health: 17 })
  cache.push('play', 'abilities', buf('ab1'), {})
  const latest = cache.snapshot().latest
  assert.equal(latest.length, 2)
  assert.equal(latest.find(f => f.name === 'health').buffer.toString(), 'cache:hp17')
  assert.equal(cache.stats().sizes.latest, 2)
})

test('snapshot exposes every domain and metrics count cached vs dropped', () => {
  const cache = createStateCache()
  const snapBefore = cache.snapshot()
  assert.deepEqual(
    Object.keys(snapBefore).sort(),
    ['blocks', 'chunkFrames', 'chunks', 'config', 'entities', 'entityDropped', 'frameSeq', 'generic', 'inventories', 'latest', 'prefix', 'warm'].sort()
  )
  cache.push('play', 'login', buf('login'))
  cache.push('play', 'keep_alive', buf('ka'))
  cache.push('play', 'player_chat', buf('chat'))
  const s = cache.stats()
  assert.equal(s.sizes.prefix, 1) // prefix got login; ka/chat dropped
  assert.deepEqual(cache.snapshot().prefix.map(f => f.name), ['login'])
  assert.equal(s.metrics.framesCached, 1)
  assert.equal(s.metrics.framesDropped, 2)
})

test('the cache counts the chunk frames it holds, in the prefix and in the chunk ring', () => {
  const cache = createStateCache()
  assert.equal(cache.stats().chunkFrames, 0, 'an empty cache holds no chunk')

  // Before warm every play frame joins the prefix, chunk frames included. A
  // client released on this cache still gets terrain, so the count is the chunk
  // data the cache holds, not the chunk ring's size (#87).
  cache.push('play', 'map_chunk', buf('c0'), { x: 0, z: 0 })
  assert.equal(cache.stats().chunkFrames, 1)
  assert.equal(cache.stats().sizes.chunks, 0, 'pre-warm chunks live in the prefix')

  cache.push('play', 'chunk_batch_finished', buf('marker'), {})
  cache.push('play', 'map_chunk', buf('c1'), { x: 1, z: 0 })
  assert.equal(cache.stats().chunkFrames, 2)
  assert.equal(cache.stats().sizes.chunks, 1, 'after warm they live in the chunk ring')

  // The count travels with the snapshot, so a restore puts it back, and a reset
  // starts the next session at zero.
  const snapshot = cache.snapshot()
  cache.reset()
  assert.equal(cache.stats().chunkFrames, 0)
  cache.restore(snapshot)
  assert.equal(cache.stats().chunkFrames, 2)

  // An unload is not chunk data: it removes terrain and never adds it.
  cache.push('play', 'unload_chunk', buf('u'), { chunkX: 0, chunkZ: 0 })
  assert.equal(cache.stats().chunkFrames, 2)
})

test('restore puts a snapshot back exactly, warm and sequence numbers included', () => {
  const cache = createStateCache()
  cache.push('play', 'login', buf('login'), { entityId: 42 })
  cache.push('play', 'chunk_batch_finished', buf('marker'), {})
  cache.push('play', 'block_update', buf('block'), { location: { x: 1, y: 0, z: 1 } })
  cache.push('play', 'window_items', buf('window'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('slot'), { windowId: 0, slot: 40 })
  cache.push('play', 'health', buf('health'), { health: 20 })
  cache.push('play', 'bossbar', buf('bossbar'), { uuid: 'b1' })
  cache.push('play', 'map_chunk', buf('chunk'), { x: 0, z: 0 })
  cache.push('configuration', 'registry_data', buf('registry'), {})
  const before = cache.snapshot()
  const sizes = cache.stats().sizes

  cache.reset()
  assert.equal(cache.warm, false)
  cache.push('play', 'login', buf('other'), {})

  const outcome = cache.restore(before)
  assert.equal(outcome.restored, true)
  assert.equal(outcome.warm, true)
  assert.equal(cache.warm, true)
  assert.deepEqual(cache.stats().sizes, sizes)
  const after = cache.snapshot()
  assert.deepEqual(
    after.prefix.map(entry => entry.name),
    before.prefix.map(entry => entry.name)
  )
  assert.deepEqual(after.blocks.map(entry => entry.name), ['block_update'])
  assert.deepEqual(after.latest.map(entry => entry.name), ['health'])
  assert.deepEqual(after.generic.map(entry => entry.name), ['bossbar'])
  assert.deepEqual(after.inventories.map(entry => entry.name), ['window_items', 'set_slot'])
  assert.deepEqual(after.chunks.map(entry => entry.data.x), [0])
  assert.deepEqual(after.config.map(entry => entry.name), ['registry_data'])
  assert.equal(cache.stats().metrics.restores, 1)
})

test('restore keeps the capture sequence, so a restored inventory replays in order', () => {
  const cache = createStateCache()
  cache.push('play', 'chunk_batch_finished', buf('marker'), {})
  cache.push('play', 'window_items', buf('window'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('slot'), { windowId: 0, slot: 40 })
  const snapshot = cache.snapshot()
  const baseSeq = snapshot.inventories[0].seq
  const slotSeq = snapshot.inventories[1].seq

  cache.restore(snapshot)
  const restored = cache.snapshot()
  assert.equal(restored.frameSeq >= slotSeq, true, 'frameSeq is raised past the snapshot')
  assert.equal(restored.inventories[0].seq, baseSeq)
  assert.equal(restored.inventories[1].seq, slotSeq)

  // A new frame after the restore is newer than everything restored.
  cache.push('play', 'set_slot', buf('slot-41'), { windowId: 0, slot: 41 })
  const newest = cache.snapshot().inventories.at(-1)
  assert.equal(newest.name, 'set_slot')
  assert.equal(newest.data.slot, 41)
  assert.equal(newest.seq > slotSeq, true)
})

test('restore rejects a value that is not a snapshot', () => {
  const cache = createStateCache()
  assert.throws(() => cache.restore(null), /snapshot/)
  assert.throws(() => cache.restore({ prefix: [] }), /snapshot\.config must be an array/)
})

// B1 monoplayer core: pure, bounded state cache.
//
// Product-shaped replacement for the protocol spike's raw frame ring
// (src/spike/proxy.js cacheFrame). The cache partitions every clientbound frame
// into bounded domains so a reattach can be rebuilt from state, not from an
// unbounded stream replay.
//
// Domains:
//   prefix    - ordered join prefix captured before warm; replayed verbatim
//   config    - ordered configuration-phase replay prefix (per-leg frames off)
//   chunk     - latest map_chunk per chunk key; unload_chunk removes the key
//   block     - FIFO ring of block-mutation frames
//   entity    - FIFO ring of entity-state frames
//   inventory - latest window frame per windowId
//   latest    - latest volatile state frame (health, abilities, ...) per name
//   generic   - FIFO ring for everything else state-bearing
//
// Whether a frame is cacheable comes from clientbound-policy.js. Per-leg
// frames, live-only chat, and blocked connection-control frames never enter
// the cache and therefore cannot be replayed onto a later attach.
//
// Purity: no I/O, no timers, no sockets. `buffer` is opaque; `data` (the
// decoded fields used for keys) is optional but recommended. The caller owns
// both.

import { clientboundPolicy } from './clientbound-policy.js'

const CHUNK_OP = { domain: 'chunk', op: 'set' }
const UNLOAD_OP = { domain: 'chunk', op: 'remove' }

const BLOCK_FRAMES = new Set([
  'block_update',
  'block_change',
  'block_action',
  'multi_block_change',
  'block_break_animation'
])

const ENTITY_FRAMES = new Set([
  'entity_metadata',
  'entity_position',
  'entity_move',
  'rel_move',
  'entity_teleport',
  'entity_head_rotation',
  'entity_velocity',
  'entity_effect',
  'remove_entities',
  'add_entity',
  'spawn_entity',
  'named_entity_spawn',
  'attach_entity',
  'collect_item',
  'entity_sound_effect',
  'update_attributes'
])

const INVENTORY_FRAMES = new Set(['window_items', 'set_slot'])

// Volatile frame-to-frame state where only the newest value matters.
const LATEST_FRAMES = new Set([
  'health',
  'food',
  'experience',
  'abilities',
  'held_item_slot',
  'game_state_change',
  'entity_event',
  'advancements' // full-state replace frame; latest wins, which a raw replay would drop
])

export const DOMAINS = ['prefix', 'config', 'chunk', 'block', 'entity', 'inventory', 'latest', 'generic']

// Classify one clientbound play frame.
export function classifyPlay (name) {
  if (!clientboundPolicy('play', name).cache) return { domain: 'drop', op: 'discard' }
  if (name === 'map_chunk') return CHUNK_OP
  if (name === 'unload_chunk') return UNLOAD_OP
  if (BLOCK_FRAMES.has(name)) return { domain: 'block', op: 'append' }
  if (ENTITY_FRAMES.has(name)) return { domain: 'entity', op: 'append' }
  if (INVENTORY_FRAMES.has(name)) return { domain: 'inventory', op: 'set' }
  if (LATEST_FRAMES.has(name)) return { domain: 'latest', op: 'set' }
  return { domain: 'generic', op: 'append' }
}

// Classify one clientbound configuration frame. Names the policy does not
// classify fail closed (drop), so a protocol bump cannot silently replay a
// new connection-control frame.
export function classifyConfig (name) {
  if (!clientboundPolicy('configuration', name).cache) return { domain: 'drop', op: 'discard' }
  return { domain: 'config', op: 'append' }
}

export function createStateCache (overrides = {}) {
  const opts = {
    maxPrefix: 8192,
    maxConfig: 1024,
    maxChunks: 1024,
    maxBlocks: 2048,
    maxEntities: 2048,
    maxInventories: 32,
    maxInventorySlots: 512,
    maxGeneric: 512,
    blockBreakFrames: false, // dig animations are transient noise unless asked for
    ...overrides
  }

  const prefix = []
  const config = []
  const chunks = new Map() // 'x,z' -> {name, buffer, data}
  // Inventory state splits in two: the latest full window frame (`window_items`)
  // per window, and the latest per-slot update (`set_slot`) per window+slot.
  // A single map keyed by windowId would let one set_slot overwrite the full
  // window frame, so an attaching client would replay one slot and no base.
  const inventoryBase = new Map() // windowId -> {name, buffer, data}
  const inventorySlots = new Map() // 'windowId:slot' -> {name, buffer, data}
  const latest = new Map() // frame name -> {name, buffer, data}
  const rings = { block: [], entity: [], generic: [] }

  const metrics = {
    framesCached: 0,
    framesDropped: 0,
    overflows: { prefix: 0, config: 0, chunk: 0, block: 0, entity: 0, generic: 0 },
    evictions: { inventory: 0, latest: 0 },
    warmComplete: 0,
    warmFallback: 0
  }

  let warm = false
  let frameSeq = 0

  function ringPush (domain, entry) {
    const ring = rings[domain]
    // Each ring has its own bound: the entity ring is the largest state domain,
    // and folding it into maxGeneric silently capped it at 512 by default.
    const max = domain === 'block'
      ? opts.maxBlocks
      : domain === 'entity' ? opts.maxEntities : opts.maxGeneric
    ring.push(entry)
    while (ring.length > max) {
      ring.shift()
      metrics.overflows[domain]++
    }
  }

  // Chunk frames disagree on field names: map_chunk carries x/z, unload_chunk
  // carries chunkX/chunkZ. Key on both or every unload is a silent no-op and a
  // reattach replays terrain the server already dropped.
  function chunkKey (data = {}) {
    const x = data.x ?? data.chunkX
    const z = data.z ?? data.chunkZ
    return `${x},${z}`
  }

  function boundedInsert (map, key, entry, max, overflowKind) {
    if (map.has(key)) map.delete(key) // refresh insertion order
    map.set(key, entry)
    while (map.size > max) {
      const oldest = map.keys().next().value
      map.delete(oldest)
      metrics.evictions[overflowKind]++
    }
  }

  // A window base evicted without its slot updates would replay orphan slots
  // against a window the client never received, so evict the pair together.
  function insertInventoryBase (windowId, entry) {
    if (inventoryBase.has(windowId)) inventoryBase.delete(windowId)
    inventoryBase.set(windowId, entry)
    while (inventoryBase.size > opts.maxInventories) {
      const oldest = inventoryBase.keys().next().value
      inventoryBase.delete(oldest)
      for (const [key, slot] of inventorySlots) {
        if (slot.windowId === oldest) inventorySlots.delete(key)
      }
      metrics.evictions.inventory++
    }
  }

  // state: 'configuration' | 'play'. data: decoded fields for keys (optional).
  // Returns { cached, domain, warmed } for logging/tests.
  function push (state, name, buffer, data = {}) {
    const classification = state === 'configuration' ? classifyConfig(name) : classifyPlay(name)
    const entry = { name, buffer, data, seq: ++frameSeq }
    let cached = false

    if (classification.domain === 'drop') {
      metrics.framesDropped++
      return { cached: false, domain: 'drop', warmed: warm }
    }

    metrics.framesCached++

    if (classification.domain === 'prefix') {
      // Join prefix: captured verbatim until warm. Bounded; an oversized join
      // eats its own tail and is counted, never silent.
      prefix.push(entry)
      while (prefix.length > opts.maxPrefix) {
        prefix.shift()
        metrics.overflows.prefix++
      }
      cached = true
    } else if (classification.domain === 'config') {
      config.push(entry)
      while (config.length > opts.maxConfig) {
        config.shift()
        metrics.overflows.config++
      }
      cached = true
    } else if (!warm) {
      // All domain behavior only starts once the join prefix is warm.
      prefix.push(entry)
      while (prefix.length > opts.maxPrefix) {
        prefix.shift()
        metrics.overflows.prefix++
      }
      cached = true
    } else {
      switch (classification.domain) {
        case 'chunk':
          if (classification.op === 'remove') {
            chunks.delete(chunkKey(data))
          } else {
            const key = chunkKey(data)
            if (chunks.has(key)) chunks.delete(key) // refresh insertion order
            chunks.set(key, entry)
            while (chunks.size > opts.maxChunks) {
              const oldest = chunks.keys().next().value
              chunks.delete(oldest)
              metrics.overflows.chunk++
            }
          }
          cached = true
          break
        case 'block':
          if (!(name === 'block_break_animation' && !opts.blockBreakFrames)) {
            ringPush('block', entry)
          }
          cached = true
          break
        case 'entity':
          ringPush('entity', entry)
          cached = true
          break
        case 'inventory':
          entry.windowId = data.windowId ?? 'main'
          if (name === 'window_items') {
            insertInventoryBase(entry.windowId, entry)
          } else {
            const key = `${entry.windowId}:${data.slot ?? 'cursor'}`
            boundedInsert(inventorySlots, key, entry, opts.maxInventorySlots, 'inventory')
          }
          cached = true
          break
        case 'latest':
          boundedInsert(latest, name, entry, LATEST_FRAMES.size, 'latest')
          cached = true
          break
        case 'generic':
          ringPush('generic', entry)
          cached = true
          break
      }
    }

    // Warm completes at chunk_batch_finished: the join sequence is pinned
    // through the first full chunk batch (same marker as the protocol spike).
    if (!warm && classification.domain !== 'config' && name === 'chunk_batch_finished') {
      warm = true
      metrics.warmComplete++
    }

    return { cached, domain: classification.domain, warmed: warm }
  }

  // Live-leg fallback for backends that stream chunks unbatched (empirically:
  // Paper 26.x never sends chunk_batch_finished to a protocol-leg client):
  // the join prefix is declared pinned at the CURRENT edge so the cache moves
  // to warm-domain behavior (recency per chunk, bounded rings) instead of
  // growing the prefix until eviction eats the login frame. Pure state
  // mutation, counted separately; the marker path is untouched. Caller owns
  // the decided-ness (the orchestrator's grace policy).
  function forceWarm () {
    if (warm) return { forced: false, warm }
    warm = true
    metrics.warmFallback++
    return { forced: true, warm }
  }

  // Grouped snapshot for join synthesis. Ordering across warm domains is
  // chunk -> block -> entity -> inventory -> latest -> generic; within each
  // domain it is capture/recency order. Cross-domain interleaving is
  // deliberately flattened (see docs/product-core.md limits).
  //
  // Inventory replays the newest full window frame first, then only the
  // per-slot updates captured after it. Slots from before that frame are
  // already inside it, and replaying their older stateId after it would
  // desync the client's container state.
  function inventoryFrames () {
    const frames = []
    const based = new Set()
    for (const base of inventoryBase.values()) {
      frames.push(base)
      based.add(base.windowId)
      for (const slot of inventorySlots.values()) {
        if (slot.windowId === base.windowId && slot.seq > base.seq) frames.push(slot)
      }
    }
    // A window that only ever sent set_slot frames keeps its latest slots.
    for (const windowId of new Set([...inventorySlots.values()].map(slot => slot.windowId))) {
      if (based.has(windowId)) continue
      for (const slot of inventorySlots.values()) {
        if (slot.windowId === windowId) frames.push(slot)
      }
    }
    return frames
  }

  function snapshot () {
    return {
      config: [...config],
      prefix: [...prefix],
      chunks: [...chunks.values()],
      blocks: [...rings.block],
      entities: [...rings.entity],
      inventories: inventoryFrames(),
      latest: [...latest.values()],
      generic: [...rings.generic]
    }
  }

  function stats () {
    // The memory the chunk ring actually holds. Sizes drive the raise decision;
    // this is the measurement #18 records (optimization is deferred).
    let chunkBytes = 0
    for (const entry of chunks.values()) chunkBytes += entry.buffer?.length ?? 0
    return {
      warm,
      chunkBound: opts.maxChunks,
      chunkBytes,
      sizes: {
        prefix: prefix.length,
        config: config.length,
        chunks: chunks.size,
        blocks: rings.block.length,
        entities: rings.entity.length,
        inventories: inventoryBase.size + inventorySlots.size,
        latest: latest.size,
        generic: rings.generic.length
      },
      metrics
    }
  }

  // #18: the backend advertises its view distance in the play login, and the
  // ring must hold the whole view. Raise only: lowering would evict chunks a
  // later attach still needs, and the value is sticky across reset() because
  // the next connection to the same backend needs the same room.
  function raiseChunkBound (bound) {
    if (!Number.isInteger(bound) || bound < 1) return opts.maxChunks
    if (bound > opts.maxChunks) opts.maxChunks = bound
    return opts.maxChunks
  }

  function reset () {
    prefix.length = 0
    config.length = 0
    chunks.clear()
    inventoryBase.clear()
    inventorySlots.clear()
    latest.clear()
    rings.block.length = 0
    rings.entity.length = 0
    rings.generic.length = 0
    warm = false
    frameSeq = 0
  }

  return { push, snapshot, stats, reset, forceWarm, raiseChunkBound, get warm () { return warm } }
}

// Joined convenience: warm completion + unload handling already hold through a
// prefix that contains both map_chunk and unload_chunk frames (they replay in
// capture order, so an unload of a not-yet-replayed chunk is a no-op that the
// sequence then re-loads — harmless, and preserved in the prefix verbatim).
export const WARM_MARKER = 'chunk_batch_finished'

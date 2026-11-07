// B1 monoplayer core: pure, bounded state cache.
//
// Product-shaped replacement for the Gate A spike's raw frame ring
// (src/proxy.js cacheFrame). The cache partitions every clientbound frame
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
// Per-leg-owned frames are never cached: keep-alives, position (synthesized
// per attach), chat frames, pings, pong.
//
// Purity: no I/O, no timers, no sockets. `buffer` is opaque; `data` (the
// decoded fields used for keys) is optional but recommended. The caller owns
// both.

const CHUNK_OP = { domain: 'chunk', op: 'set' }
const UNLOAD_OP = { domain: 'chunk', op: 'remove' }

// Never cached; per-leg ownership or forbidden content.
const DROP_PLAY = new Set([
  'keep_alive',
  'position', // synthesized from the live pose on attach
  'player_chat',
  'profileless_chat',
  'hide_message',
  'system_chat', // read-only chat is a later slice
  'ping' // per-leg
])

// Per-leg owned in the configuration phase: keep-alives and connection pings
// must be answered on the leg that received them, never replayed.
const DROP_CONFIG = new Set(['keep_alive', 'ping', 'pong'])

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
  'advancements' // full-state replace frame; latest wins like Gate A behavior would otherwise drop
])

export const DOMAINS = ['prefix', 'config', 'chunk', 'block', 'entity', 'inventory', 'latest', 'generic']

// Classify one clientbound play frame.
export function classifyPlay (name) {
  if (DROP_PLAY.has(name)) return { domain: 'drop', op: 'discard' }
  if (name === 'map_chunk') return CHUNK_OP
  if (name === 'unload_chunk') return UNLOAD_OP
  if (BLOCK_FRAMES.has(name)) return { domain: 'block', op: 'append' }
  if (ENTITY_FRAMES.has(name)) return { domain: 'entity', op: 'append' }
  if (INVENTORY_FRAMES.has(name)) return { domain: 'inventory', op: 'set' }
  if (LATEST_FRAMES.has(name)) return { domain: 'latest', op: 'set' }
  return { domain: 'generic', op: 'append' }
}

// Classify one clientbound configuration frame.
// Unknown config frames are cached (append); the config replay path decides
// replay order live, so staying conservative here is safe.
export function classifyConfig (name) {
  if (DROP_CONFIG.has(name)) return { domain: 'drop', op: 'discard' }
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
    maxGeneric: 512,
    blockBreakFrames: false, // dig animations are transient noise unless asked for
    ...overrides
  }

  const prefix = []
  const config = []
  const chunks = new Map() // 'x,z' -> {name, buffer, data}
  const inventories = new Map() // windowId -> {name, buffer, data}
  const latest = new Map() // frame name -> {name, buffer, data}
  const rings = { block: [], entity: [], generic: [] }

  const metrics = {
    framesCached: 0,
    framesDropped: 0,
    overflows: { prefix: 0, config: 0, chunk: 0, block: 0, entity: 0, generic: 0 },
    evictions: { inventory: 0, latest: 0 },
    warmComplete: 0
  }

  let warm = false

  function ringPush (domain, entry) {
    const ring = rings[domain]
    const max = domain === 'block' ? opts.maxBlocks : opts.maxGeneric
    ring.push(entry)
    while (ring.length > max) {
      ring.shift()
      metrics.overflows[domain]++
    }
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

  // state: 'configuration' | 'play'. data: decoded fields for keys (optional).
  // Returns { cached, domain, warmed } for logging/tests.
  function push (state, name, buffer, data = {}) {
    const classification = state === 'configuration' ? classifyConfig(name) : classifyPlay(name)
    const entry = { name, buffer, data }
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
            chunks.delete(`${data.x},${data.z}`)
          } else {
            const key = `${data.x},${data.z}`
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
          boundedInsert(inventories, data.windowId ?? 'main', entry, opts.maxInventories, 'inventory')
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
    // through the first full chunk batch (same marker as the Gate A spike).
    if (!warm && classification.domain !== 'config' && name === 'chunk_batch_finished') {
      warm = true
      metrics.warmComplete++
    }

    return { cached, domain: classification.domain, warmed: warm }
  }

  // Grouped snapshot for join synthesis. Ordering across warm domains is
  // chunk -> block -> entity -> inventory -> latest -> generic; within each
  // domain it is capture/recency order. Cross-domain interleaving is
  // deliberately flattened (see docs/gate-b-b1.md limits).
  function snapshot () {
    return {
      config: [...config],
      prefix: [...prefix],
      chunks: [...chunks.values()],
      blocks: [...rings.block],
      entities: [...rings.entity],
      inventories: [...inventories.values()],
      latest: [...latest.values()],
      generic: [...rings.generic]
    }
  }

  function stats () {
    return {
      warm,
      sizes: {
        prefix: prefix.length,
        config: config.length,
        chunks: chunks.size,
        blocks: rings.block.length,
        entities: rings.entity.length,
        inventories: inventories.size,
        latest: latest.size,
        generic: rings.generic.length
      },
      metrics
    }
  }

  function reset () {
    prefix.length = 0
    config.length = 0
    chunks.clear()
    inventories.clear()
    latest.clear()
    rings.block.length = 0
    rings.entity.length = 0
    rings.generic.length = 0
    warm = false
  }

  return { push, snapshot, stats, reset, get warm () { return warm } }
}

// Joined convenience: warm completion + unload handling already hold through a
// prefix that contains both map_chunk and unload_chunk frames (they replay in
// capture order, so an unload of a not-yet-replayed chunk is a no-op that the
// sequence then re-loads — harmless, and preserved in the prefix verbatim).
export const WARM_MARKER = 'chunk_batch_finished'

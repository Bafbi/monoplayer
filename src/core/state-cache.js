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
//   entity    - keyed by entity and slot: the newest frame per entity, per
//               metadata index; raw frames, replayed as captured
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

// Entity state is keyed by entity, not by arrival order (#213): see the
// `entities` map below for the slot rule and the reason. An absolute position
// belongs here rather than in `generic`, so a correction and the delta it ended
// are in different domains (issue #23).
//
// Only names the clientbound policy accepts appear here: the policy answers
// `block` for an unknown name, and `classifyPlay` drops it before this set is
// consulted. `entity_position` is the pre-rename spelling the older fakes
// still send.
//
// The relative-move frames (`rel_entity_move`, `entity_move_look`,
// `entity_look`) are deliberately absent. They are per-tick deltas, and a slot
// holds the newest frame for its key, so routing one here would replay the last
// delta and none of the ones it built on. They stay in `generic`, and
// join-synth replays the two domains merged in capture order, so a delta still
// follows the frame it adjusts (issue #35).
const ENTITY_FRAMES = new Set([
  'sync_entity_position',
  'entity_destroy',
  'entity_teleport',
  'entity_metadata',
  'spawn_entity',
  'entity_head_rotation',
  'entity_velocity',
  'entity_effect',
  'remove_entities',
  'add_entity',
  'attach_entity',
  'entity_sound_effect',
  'entity_position'
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
    // How many slots one entity may hold before the whole entity is dropped: a
    // body with every metadata index set is about 60 slots, so the default
    // never touches a real entity.
    maxEntitySlots: 64,
    // The slots the whole domain may hold. Without it the worst case is
    // maxEntities x maxEntitySlots, which is 64 times the frame ring this
    // replaced (#213). Typical traffic is about 12 slots per body, so 2048
    // bodies fit here with room.
    maxEntityFrames: 32768,
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
  // #213: entity state by entity and slot, not by arrival order.
  //
  // `entity_metadata` is a map of indexes: the client merges each `{key, value}`
  // pair into the body it holds, and a frame carries only the indexes it
  // changed. The newest frame for index 5 therefore says nothing about index 6,
  // and a FIFO over frames is the wrong shape: metadata and move traffic filled
  // it and evicted `spawn_entity`, so a reattaching client got a body it never
  // spawned, or none at all.
  //
  // A slot is one addressable piece of an entity's state, and a slot holds the
  // raw frame the backend sent, buffer included, so the replay replays bytes:
  // this domain locates an index, it never rebuilds a frame. Where a slot is:
  //
  //   entity_metadata          one slot per metadata index (`metadata:<key>`)
  //   entity_effect            one slot per effect id (`effect:<id>`): the
  //                            frame adds one effect and removes none
  //   entity_destroy,          `destroy`: the frame stays beside the body it
  //   remove_entities          ends, so a replay applies the removal after it
  //   any other entity frame   the frame name, because it carries the whole
  //                            value: a spawn, a teleport, a velocity
  const entities = new Map() // entityId -> Map<slot, entry>
  // A removal for a body the cache never held has no record to write to: every
  // entity the join prefix spawned is in that position, because the prefix is
  // replayed verbatim and the domain never saw the spawn. Creating a record per
  // such id would let the removals of a busy world evict the bodies that are
  // still alive, so the frames wait here instead, bounded, still naming the ids
  // they remove.
  const removals = []
  // The ids whose record a bound dropped. A later metadata frame cannot rebuild
  // that body, and replaying it would hand a client a body with no spawn, which
  // is the defect. Only a spawn starts one again.
  const droppedEntities = new Map() // entityId -> true, least recently dropped first
  // The slots the domain holds, so the frame bound costs no scan.
  let entitySlotCount = 0
  const rings = { block: [], generic: [] }

  const metrics = {
    framesCached: 0,
    framesDropped: 0,
    overflows: { prefix: 0, config: 0, chunk: 0, block: 0, entity: 0, entityDepth: 0, entityFrames: 0, generic: 0 },
    evictions: { inventory: 0, latest: 0 },
    entityFlushes: 0,
    // Entity frames the cache ignored because the bound had already dropped the
    // body they are about (#213, and #218 measures the same gap).
    entitySuppressed: 0,
    warmComplete: 0,
    warmFallback: 0,
    restores: 0
  }

  let warm = false
  let frameSeq = 0
  // #87: how many chunk frames this session's cache accepted, whichever domain
  // they landed in. Before warm a chunk frame joins the join prefix and after
  // warm the chunk ring, so the ring's size alone says nothing about whether the
  // target ever sent terrain. This is a "did the target send any" count, not a
  // measure of what the cache still holds: an unload or an eviction does not
  // decrement it, and a caller that needs deliverable state reads sizes.chunks.
  let chunkFrames = 0

  function ringPush (domain, entry) {
    const ring = rings[domain]
    // Each ring has its own bound: the block ring is the largest, and folding it
    // into maxGeneric silently capped it at 512 by default.
    const max = domain === 'block' ? opts.maxBlocks : opts.maxGeneric
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

  // The entity ids one entity-domain frame is about. `entity_destroy` names
  // several in one frame; every other name the policy routes here carries one.
  function entityIds (data = {}) {
    if (Array.isArray(data.entityIds)) return data.entityIds
    return data.entityId === undefined ? [] : [data.entityId]
  }

  // The slots one entity frame occupies. Every branch reads a field the backend
  // leg already decoded, so nothing here parses a buffer.
  function entitySlots (name, data = {}) {
    if (name === 'entity_metadata') {
      const metadata = Array.isArray(data.metadata) ? data.metadata : Object.values(data.metadata ?? {})
      const indexes = metadata.map(entry => entry?.key).filter(key => key !== undefined)
      // A frame that names no index belongs to no slot. One shared slot keeps
      // the newest frame of that shape instead of dropping it.
      return indexes.length === 0 ? ['metadata'] : indexes.map(key => `metadata:${key}`)
    }
    if (name === 'entity_effect') return [`effect:${data.effectId ?? data.effect ?? 'unknown'}`]
    if (name === 'entity_destroy' || name === 'remove_entities') return ['destroy']
    return [name]
  }

  function isRemoval (name) {
    return name === 'entity_destroy' || name === 'remove_entities'
  }

  // A spawn is what gives a body a model, so it is the one frame that starts a
  // record the bound dropped. `add_entity` is the pre-rename spelling of the
  // same frame.
  function isSpawn (name) {
    return name === 'spawn_entity' || name === 'add_entity'
  }

  // Write one entity frame into its records. push and restore share this, so the
  // keying rule cannot drift between the two. Returns the ids it covered; a
  // removal that covers none waited in `removals` instead.
  function placeEntity (entry) {
    const ids = entityIds(entry.data)
    if (ids.length === 0) ids.push('unknown') // an id-less frame still replays
    // A removal is about the bodies it names, and the cache only holds one it
    // can write to. One frame naming a live body and a dead one still removes
    // both: the buffer carries every id.
    const covered = isRemoval(entry.name) ? ids.filter(id => entities.has(id)) : ids
    if (covered.length === 0) {
      removals.push(entry)
      while (removals.length > opts.maxEntities) {
        removals.shift()
        metrics.overflows.entity++
      }
      return covered
    }
    const slots = entitySlots(entry.name, entry.data)
    for (const id of covered) {
      const record = entities.get(id) ?? new Map()
      // Re-insert, so the map's order stays "least recently updated first".
      entities.delete(id)
      for (const slot of slots) {
        if (!record.has(slot)) entitySlotCount++
        record.set(slot, entry)
      }
      entities.set(id, record)
    }
    return covered
  }

  // Drop one record and remember the id, so a later frame cannot rebuild a body
  // with no spawn behind it.
  function forgetEntity (id) {
    const record = entities.get(id)
    if (record === undefined) return
    entitySlotCount -= record.size
    entities.delete(id)
    droppedEntities.delete(id)
    droppedEntities.set(id, true)
    // The memory of a dropped id is bounded too: forgetting one costs an orphan
    // frame later, never a lost body.
    while (droppedEntities.size > opts.maxEntities) {
      droppedEntities.delete(droppedEntities.keys().next().value)
    }
  }

  // Enforce the domain's bounds, in this order: one entity's depth (the whole
  // entity goes, never its head), the entity count, then the slots the domain
  // holds (the worst case is a number, not a product). `ids` is what the frame
  // just wrote, so the depth check costs nothing per frame.
  function boundEntities (ids) {
    for (const id of ids) {
      const record = entities.get(id)
      if (record === undefined || record.size <= opts.maxEntitySlots) continue
      forgetEntity(id)
      metrics.overflows.entityDepth++
    }
    while (entities.size > opts.maxEntities) {
      forgetEntity(entities.keys().next().value)
      metrics.overflows.entity++
    }
    while (entitySlotCount > opts.maxEntityFrames && entities.size > 1) {
      forgetEntity(entities.keys().next().value)
      metrics.overflows.entityFrames++
    }
  }

  // Store one entity frame within the bounds, and keep it out of the domain
  // entirely when its body is already gone: metadata for a body with no spawn
  // replays as a body the client cannot model.
  function pushEntity (entry) {
    const ids = entityIds(entry.data)
    const spawn = isSpawn(entry.name)
    if (!spawn && ids.length > 0 && ids.every(id => droppedEntities.has(id))) {
      metrics.entitySuppressed++
      return
    }
    if (spawn) for (const id of ids) droppedEntities.delete(id)
    boundEntities(placeEntity(entry))
  }

  // Every stored entity frame once, in capture order: a metadata frame writes one
  // slot per index but is one frame, and a removal can sit in several records, so
  // the list is deduplicated by entry and sorted by the sequence each one carries.
  // join-synth merges it with the generic move frames by `seq`, so the order has
  // to come from the sequence rather than from the map.
  function entityFrames () {
    const seen = new Set()
    const frames = []
    for (const entry of removals) {
      seen.add(entry)
      frames.push(entry)
    }
    for (const record of entities.values()) {
      for (const entry of record.values()) {
        if (seen.has(entry)) continue
        seen.add(entry)
        frames.push(entry)
      }
    }
    return frames.sort(compareCapture)
  }

  // A frame without a sequence keeps its place: the sort is stable, and a
  // hand-built snapshot is the only source of one.
  function compareCapture (a, b) {
    const left = Number.isFinite(a?.seq) ? a.seq : Number.POSITIVE_INFINITY
    const right = Number.isFinite(b?.seq) ? b.seq : Number.POSITIVE_INFINITY
    if (left === right) return 0
    return left < right ? -1 : 1
  }

  // A world change voids every entity id the client holds: a play `login` is a
  // new session, and `respawn` carries the new dimension (26.x has no separate
  // dimension-change frame). Nothing else in the pipeline sees either one, and a
  // record that survived a respawn would replay the last dimension's bodies into
  // the new one.
  function flushEntities (reason = 'flush') {
    const flushed = entities.size
    entities.clear()
    removals.length = 0
    droppedEntities.clear()
    entitySlotCount = 0
    if (flushed > 0) metrics.entityFlushes++
    return { flushed, reason }
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
    if (state === 'play' && (name === 'login' || name === 'respawn')) flushEntities(name)
    const classification = state === 'configuration' ? classifyConfig(name) : classifyPlay(name)
    const entry = { name, buffer, data, seq: ++frameSeq }
    let cached = false

    if (classification.domain === 'drop') {
      metrics.framesDropped++
      return { cached: false, domain: 'drop', warmed: warm }
    }

    metrics.framesCached++
    // An unload removes terrain and adds none, so only the set op counts.
    if (classification.domain === 'chunk' && classification.op === 'set') chunkFrames++

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
          pushEntity(entry)
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
  // domain it is capture/recency order, except that the entity domain is a
  // keyed map, so its entries are rebuilt in capture order before they leave.
  // Cross-domain interleaving is deliberately flattened (see
  // docs/product-core.md limits).
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

  // The whole cache as one value. `warm` and `frameSeq` travel with it so
  // restore() can put the cache back exactly as it was: a restored cache that
  // lost the warm flag would file every new frame into the join prefix, and a
  // reset sequence number would reorder the entity/generic merge that
  // join-synth builds on capture order.
  function snapshot () {
    return {
      warm: warm,
      frameSeq: frameSeq,
      chunkFrames: chunkFrames,
      config: [...config],
      prefix: [...prefix],
      chunks: [...chunks.values()],
      blocks: [...rings.block],
      entities: entityFrames(),
      // The ids a bound dropped, so a restore keeps suppressing the frames that
      // would rebuild a body with no spawn behind it.
      entityDropped: [...droppedEntities.keys()],
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
      // Chunk frames this session's cache accepted, in the prefix or the ring
      // (#87). Zero means the target has sent no terrain at all.
      chunkFrames,
      // The slots the entity domain holds. One metadata frame can occupy several,
      // so this is the memory the bound actually spends, not a frame count.
      entitySlots: entitySlotCount,
      // The removals waiting for a body the cache never held.
      entityRemovals: removals.length,
      // The ids a bound dropped, and the frames suppressed because of it.
      entitiesDropped: droppedEntities.size,
      sizes: {
        prefix: prefix.length,
        config: config.length,
        chunks: chunks.size,
        blocks: rings.block.length,
        entities: entities.size,
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

  // The inverse of snapshot() (#22): put a captured cache back, entry order
  // and sequence numbers intact. It clears first, so a failed snapshot cannot
  // leave part of the previous session behind. Bounds are not re-applied: the
  // snapshot came from this cache, so it already fits.
  function restore (snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new TypeError('restore requires a snapshot from snapshot()')
    }
    for (const key of ['config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic']) {
      if (!Array.isArray(snapshot[key])) throw new TypeError(`snapshot.${key} must be an array`)
    }
    if (snapshot.entityDropped !== undefined && !Array.isArray(snapshot.entityDropped)) {
      throw new TypeError('snapshot.entityDropped must be an array')
    }

    reset()

    let maxSeq = 0
    const restored = []
    function keep (entry) {
      restored.push(entry)
      if (Number.isFinite(entry?.seq) && entry.seq > maxSeq) maxSeq = entry.seq
      return entry
    }

    for (const entry of snapshot.config) config.push(keep(entry))
    for (const entry of snapshot.prefix) prefix.push(keep(entry))
    for (const entry of snapshot.chunks) {
      keep(entry)
      const key = chunkKey(entry.data)
      if (chunks.has(key)) chunks.delete(key) // refresh insertion order
      chunks.set(key, entry)
    }
    for (const entry of snapshot.blocks) rings.block.push(keep(entry))
    // The bounds do not re-apply here: the snapshot came from this cache, so it
    // already fits. The entity map is rebuilt through the same keying push uses,
    // in capture order, which is also the order the map evicts in. A snapshot
    // taken before #213 carries no `entityDropped`, which reads as "nothing was
    // dropped".
    for (const entry of snapshot.entities) {
      keep(entry)
      placeEntity(entry)
    }
    for (const id of snapshot.entityDropped ?? []) droppedEntities.set(id, true)
    for (const entry of snapshot.inventories) {
      keep(entry)
      const windowId = entry.windowId ?? entry.data?.windowId ?? 'main'
      if (entry.name === 'window_items') {
        inventoryBase.set(windowId, entry)
      } else {
        inventorySlots.set(`${windowId}:${entry.data?.slot ?? 'cursor'}`, entry)
      }
    }
    for (const entry of snapshot.latest) {
      keep(entry)
      latest.set(entry.name, entry)
    }
    for (const entry of snapshot.generic) rings.generic.push(keep(entry))

    // A snapshot taken before warm restores as unwarm, so the join prefix
    // stays pinned exactly where it was.
    chunkFrames = Number.isFinite(snapshot.chunkFrames) ? snapshot.chunkFrames : 0
    warm = snapshot.warm !== false
    frameSeq = Number.isFinite(snapshot.frameSeq) && snapshot.frameSeq > maxSeq
      ? snapshot.frameSeq
      : maxSeq
    metrics.restores++
    return { restored: true, warm, frames: restored.length }
  }

  function reset () {
    prefix.length = 0
    config.length = 0
    chunks.clear()
    inventoryBase.clear()
    inventorySlots.clear()
    latest.clear()
    entities.clear()
    removals.length = 0
    droppedEntities.clear()
    entitySlotCount = 0
    rings.block.length = 0
    rings.generic.length = 0
    warm = false
    frameSeq = 0
    chunkFrames = 0
  }

  return { push, snapshot, restore, stats, reset, forceWarm, raiseChunkBound, flushEntities, get warm () { return warm } }
}

// Joined convenience: warm completion + unload handling already hold through a
// prefix that contains both map_chunk and unload_chunk frames (they replay in
// capture order, so an unload of a not-yet-replayed chunk is a no-op that the
// sequence then re-loads — harmless, and preserved in the prefix verbatim).
export const WARM_MARKER = 'chunk_batch_finished'

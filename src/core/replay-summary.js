// #218: what one attach stream carries, counted from the snapshot it is built
// from.
//
// The question that opened this arrived as a report: a player could not see
// another player after attaching. The state cache's entity domain keeps a
// bounded window (#213), so a body that spawned earlier has no `spawn_entity`
// left to send, while `player_info` is a keyed domain and behaves. The
// predicted shape, present in the tab list and absent from the world, is
// testable, but nothing recorded what an attach stream contained, so the
// prediction could not be checked against production.
//
// This module is that measurement. It reads the same snapshot the attach stream
// is built from, through the same `replayFrames` reader, so the counts describe
// the frames the client receives and no second order exists to drift from it.
//
// Pure: in = snapshot, out = counts. No socket, no timer, and no frame passes
// through here. Nothing it computes can change what the client is sent.
//
// Every field it returns is a count. Byte sizes belong to `cache.stats()`,
// which measures what the state cache holds rather than what one attach sent.
//
// One function counts the sections and then walks the frames again, rather than
// counting in the single pass over `replayFrames`. Counting a section means
// counting what the snapshot holds in it, and a frame's section is not a property
// of the frame: the relative-move frames sit in `generic` and are sent with the
// entity domain. The walk answers the other question, which is what the client
// was told, in order. The test that the two agree (`domains` sums to what the
// replay writes) is what keeps them from drifting apart.

import { LEG_OWNED, replayFrames } from './join-synth.js'

// The snapshot sections, spelled as `snapshot()` in state-cache.js spells them.
// Counting per section does not need the attach stream's order, which
// `replayFrames` owns. This list is read only to know which keys to count, and
// the sum check in test/core/replay-summary.test.js holds it to the frames the
// replay actually writes.
export const REPLAY_DOMAINS = Object.freeze([
  'config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic'
])

// The frames that tell a client a body exists. `add_entity` is the pre-rename
// spelling of `spawn_entity` and is what the older fakes and fixtures send.
// Counting only `spawn_entity` would report a body that has a spawn as one with
// no spawn, which would confirm a false positive on exactly the player bodies
// the report describes (#218).
const SPAWN_FRAMES = new Set(['spawn_entity', 'add_entity'])

const METADATA_FRAME = 'entity_metadata'
const TAB_LIST_FRAME = 'player_info'

// What one attach stream carries, per snapshot domain, and what it says about
// bodies.
//
//   domains[domain]     frames the attach stream carries from that section, with
//                       the frames a leg owns excluded. Their sum is the number
//                       the replay writes minus its synthesized position, which
//                       is not a snapshot entry and has its own counter.
//   entities.replayed   distinct entity ids the attach stream gives a spawn.
//                       This is bodies where `domains` counts frames, and it is
//                       the number `players.bodies` is a subset of.
//   entities.withoutSpawn  metadata frames naming an id with no spawn earlier in
//                       the same attach stream. Non-zero is #213's defect,
//                       measured.
//   players.info        distinct player UUIDs the `player_info` frames leave
//                       listed, which is the tab list this client is told about.
//   players.bodies      distinct spawned ids whose spawn carried one of those
//                       UUIDs, so a body for a player the tab list names.
//
// `withoutSpawn` walks the attach stream rather than `snapshot.entities`
// alone. A state cache that is not warm yet files every entity frame into
// `prefix`, so the entity domain is empty and the prefix holds both the spawn
// and the metadata. Reading the entity domain alone would report 0 for a pre-warm
// attach whatever it carried. Walking the stream is also the only way to answer
// the reporter's question, which is about what the client was told, in order.
//
// A spawn frame with no decoded `entityId` cannot be attributed and is skipped.
// Every protocol version this product carries decodes `entityId` on both the
// entity frames and `entity_metadata`, so a skipped one means a hand-built
// fixture, not a production frame.
export function replaySummary (snapshot, { includeConfig = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot is required')
  if (typeof includeConfig !== 'boolean') throw new TypeError('includeConfig must be a boolean')

  const domains = {}
  for (const domain of REPLAY_DOMAINS) {
    domains[domain] = domain === 'config' && !includeConfig
      ? 0
      : countReplayed(snapshot[domain])
  }

  const spawned = new Set()
  const spawnUuid = new Map()
  const announced = new Set()
  let withoutSpawn = 0

  // One pass, in attach-stream order, over the frames the client will receive.
  for (const frame of replayFrames(snapshot, { includeConfig })) {
    const name = frame?.name
    if (LEG_OWNED.has(name)) continue
    const data = frame?.data
    if (SPAWN_FRAMES.has(name)) {
      const id = entityIdOf(data)
      if (id === null) continue
      spawned.add(id)
      const uuid = uuidOf(data?.objectUUID ?? data?.uuid)
      if (uuid !== null) spawnUuid.set(id, uuid)
      continue
    }
    if (name === METADATA_FRAME) {
      const id = entityIdOf(data)
      if (id !== null && !spawned.has(id)) withoutSpawn++
      continue
    }
    if (name === TAB_LIST_FRAME) {
      trackTabList(announced, data)
    }
  }

  let bodies = 0
  for (const uuid of spawnUuid.values()) if (announced.has(uuid)) bodies++

  return {
    domains,
    entities: { replayed: spawned.size, withoutSpawn },
    players: { info: announced.size, bodies }
  }
}

// The frames one section contributes. A frame a leg owns is never written to a
// client and `synthAttach` skips it, so counting it would describe a stream that
// was not sent.
function countReplayed (entries) {
  if (!Array.isArray(entries)) return 0
  let count = 0
  for (const entry of entries) if (!LEG_OWNED.has(entry?.name)) count++
  return count
}

// Entity ids are compared as strings so a fixture that writes 55 and a decode
// that writes '55' are one body, not two.
function entityIdOf (data) {
  const id = data?.entityId
  return id === undefined || id === null ? null : String(id)
}

function uuidOf (value) {
  if (typeof value !== 'string' || value === '') return null
  return value.toLowerCase()
}

// The tab list as the frames leave it. The decoded shape is
// `{ action, data: [{ uuid, ... }] }` in every protocol version this product
// carries. A frame carries only the fields its action bit selects, and `uuid`
// is always one of them.
//
// An entry with `update_listed` set lists or unlists that identity, and a later
// frame wins. An entry without it lists the identity only when it carries
// `add_player`, because a partial update cannot create an entry a client never
// received, and this counts what the client is left with.
function trackTabList (listed, data) {
  if (!Array.isArray(data?.data)) return
  const adds = data?.action?.add_player === true
  for (const entry of data.data) {
    const uuid = uuidOf(entry?.uuid)
    if (uuid === null) continue
    if (typeof entry.listed === 'boolean' || typeof entry.listed === 'number') {
      if (entry.listed) listed.add(uuid)
      else listed.delete(uuid)
      continue
    }
    if (adds) listed.add(uuid)
  }
}

// #218: the attach record's counts, derived from the snapshot the replay is
// built from. Pure, so every derivation is proved without a socket: the merge
// order, the pre-warm prefix, the two spawn spellings, and the tab-list match.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthAttach } from '../../src/core/join-synth.js'
import { REPLAY_DOMAINS, replaySummary } from '../../src/core/replay-summary.js'

const b = n => Buffer.from(`frame:${n}`)
const entry = (name, data = {}) => ({ name, buffer: b(name), data })
const POSE = { x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 }

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

function snapshot (overrides = {}) {
  return {
    config: [entry('registry_data')],
    prefix: [entry('login', { entityId: 42 }), entry('map_chunk', { x: 0, z: 0 })],
    chunks: [entry('map_chunk', { x: 1, z: 0 })],
    blocks: [entry('block_update')],
    entities: [],
    inventories: [entry('window_items', { windowId: 0 })],
    latest: [entry('update_health')],
    generic: [entry('bossbar')],
    ...overrides
  }
}

const spawn = (entityId, extra = {}) => entry('spawn_entity', { entityId, objectUUID: UUID_A, ...extra })
const metadata = entityId => entry('entity_metadata', { entityId, metadata: [] })
const move = (entityId, seq) => ({ ...entry('rel_entity_move', { entityId }), seq })

// What the replay writes, minus its synthesized position, which is not a
// snapshot entry and has its own counter.
const replayed = (snapshot, options = {}) => synthAttach({ snapshot, pose: POSE, ...options }).counts.replayed
const domainTotal = summary => REPLAY_DOMAINS.reduce((sum, domain) => sum + summary.domains[domain], 0)

test('a body with a spawn beside it does not count as missing one', () => {
  const summary = replaySummary(snapshot({ entities: [spawn(99), metadata(99)] }))

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 0 })
})

test('metadata for an id with no spawn is counted, and names no body', () => {
  const summary = replaySummary(snapshot({ entities: [spawn(99), metadata(99), metadata(55)] }))

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 1 })
})

test('a spawn that arrives after its metadata does not clear the count', () => {
  // The order the client sees, not membership of the snapshot, is what answers
  // the reporter's question: a body spawned after its metadata leaves the
  // client with metadata for an entity it never saw.
  const summary = replaySummary(snapshot({ entities: [metadata(55), spawn(55)] }))

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 1 })
})

test('add_entity counts as a spawn, so its metadata is not reported missing one', () => {
  // #218: add_entity is the pre-rename spelling of spawn_entity, and counting
  // only spawn_entity would report a body that has a spawn as one without it.
  const summary = replaySummary(snapshot({ entities: [entry('add_entity', { entityId: 7 }), metadata(7)] }))

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 0 })
})

test('a pre-warm snapshot is read through the prefix, not the empty entity domain', () => {
  // Before warm the state cache files every entity frame into prefix, so the
  // entity domain is empty and reading it alone would report 0 whatever the
  // attach carried.
  const preWarm = snapshot({
    prefix: [
      entry('login', { entityId: 42 }),
      spawn(99),
      metadata(99),
      metadata(55),
      entry('chunk_batch_finished')
    ],
    entities: [],
    chunks: [],
    blocks: [],
    inventories: [],
    latest: [],
    generic: []
  })
  const summary = replaySummary(preWarm)

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 1 })
})

test('the domains sum to what the replay writes', () => {
  // One reader for the order, so a section this counter forgets shows up here.
  const cases = {
    ordinary: snapshot(),
    entities: snapshot({ entities: [spawn(99), metadata(99), metadata(55)] }),
    merged: snapshot({
      entities: [spawn(99), metadata(99)],
      generic: [move(99, 1), entry('bossbar'), move(99, 2)]
    }),
    preWarm: snapshot({ prefix: [entry('login', { entityId: 42 }), spawn(99), metadata(55)] }),
    empty: snapshot({ config: [], prefix: [], chunks: [], blocks: [], entities: [], inventories: [], latest: [], generic: [] })
  }

  for (const [label, value] of Object.entries(cases)) {
    assert.equal(domainTotal(replaySummary(value)), replayed(value), `${label}: domains sum to the replay's own count`)
    assert.equal(domainTotal(replaySummary(value, { includeConfig: false })), replayed(value, { includeConfig: false }),
      `${label}: and the same without the configuration prefix`)
  }
})

test('the configuration prefix is zero when the attach leaves it out', () => {
  const withConfig = replaySummary(snapshot())
  const without = replaySummary(snapshot(), { includeConfig: false })

  assert.equal(withConfig.domains.config, 1)
  assert.equal(without.domains.config, 0)
  assert.equal(domainTotal(without), replayed(snapshot(), { includeConfig: false }))
})

test('a frame a leg owns is not counted: it is never written to a client', () => {
  const dirty = snapshot({
    config: [entry('registry_data'), entry('keep_alive')],
    prefix: [entry('login', { entityId: 42 }), entry('position', { teleportId: 9 })]
  })
  const summary = replaySummary(dirty)

  assert.equal(summary.domains.config, 1)
  assert.equal(summary.domains.prefix, 1)
  assert.equal(domainTotal(summary), replayed(dirty))
})

test('the tab list and the bodies are counted apart, and matched by UUID', () => {
  const listed = snapshot({
    entities: [spawn(99, { objectUUID: UUID_A }), spawn(98, { objectUUID: UUID_B })],
    generic: [
      entry('player_info', { action: { add_player: true }, data: [{ uuid: UUID_A }, { uuid: UUID_B.toUpperCase() }] }),
      entry('player_info', { action: { update_latency: true }, data: [{ uuid: UUID_A }] })
    ]
  })
  const summary = replaySummary(listed)

  // Two identities, however many frames announce them.
  assert.equal(summary.players.info, 2)
  // Both bodies are named by the tab list. A spawn whose UUID the tab list does
  // not name is a body for something that is not a listed player.
  assert.equal(summary.players.bodies, 2)
  assert.equal(summary.entities.replayed, 2)

  const unlisted = replaySummary(snapshot({
    entities: [spawn(99, { objectUUID: UUID_A }), spawn(70, { objectUUID: '33333333-3333-3333-3333-333333333333' })],
    generic: [entry('player_info', { action: { add_player: true }, data: [{ uuid: UUID_A }] })]
  }))
  assert.equal(unlisted.players.info, 1)
  assert.equal(unlisted.players.bodies, 1, 'a body the tab list does not name is not a player body')
})

test('an identity a later frame unlists leaves the tab list it was listed on', () => {
  // "Present in the tab list" is the report's own phrase, so the count is what
  // the client is left listing, not what any one frame mentioned.
  const summary = replaySummary(snapshot({
    entities: [spawn(99, { objectUUID: UUID_A }), spawn(70, { objectUUID: UUID_B })],
    generic: [
      entry('player_info', { action: { add_player: true, update_listed: true }, data: [{ uuid: UUID_A, listed: 1 }, { uuid: UUID_B, listed: 1 }] }),
      entry('player_info', { action: { update_listed: true }, data: [{ uuid: UUID_B, listed: 0 }] })
    ]
  }))

  assert.equal(summary.players.info, 1)
  assert.equal(summary.players.bodies, 1, 'the unlisted body is not a listed player any more')
})

test('a partial player_info update does not invent a listed identity', () => {
  // The frame that added it is not in the attach stream, so the client cannot
  // create the entry from this one.
  const summary = replaySummary(snapshot({
    generic: [entry('player_info', { action: { update_latency: true }, data: [{ uuid: UUID_A, latency: 20 }] })]
  }))

  assert.equal(summary.players.info, 0)
})

test('a tab list with no player_info frame is empty, not absent', () => {
  const summary = replaySummary(snapshot({ entities: [spawn(99)] }))

  assert.deepEqual(summary.players, { info: 0, bodies: 0 })
})

test('a metadata frame with no decoded entity id is not attributed to anything', () => {
  // The ids are not recovered by decoding a payload here: an entry the leg
  // decoded without an id cannot be attributed, and counting it against an
  // unknown body would be a number nobody can act on.
  const summary = replaySummary(snapshot({
    entities: [entry('entity_metadata', { metadata: [] }), spawn(99), metadata(99)]
  }))

  assert.deepEqual(summary.entities, { replayed: 1, withoutSpawn: 0 })
})

test('an empty cache reports zeros rather than throwing', () => {
  const summary = replaySummary({})

  assert.deepEqual(summary.domains, {
    config: 0, prefix: 0, chunks: 0, blocks: 0, entities: 0, inventories: 0, latest: 0, generic: 0
  })
  assert.deepEqual(summary.entities, { replayed: 0, withoutSpawn: 0 })
  assert.deepEqual(summary.players, { info: 0, bodies: 0 })
})

test('the summary leaves the snapshot exactly as it found it', () => {
  // The derivation measures; it must not change what the replay replays.
  const before = snapshot({
    entities: [spawn(99), metadata(99), metadata(55)],
    generic: [move(99, 1), entry('player_info', { action: {}, data: [{ uuid: UUID_A }] })]
  })
  const copy = JSON.parse(JSON.stringify(before))
  replaySummary(before)

  assert.deepEqual(JSON.parse(JSON.stringify(before)), copy)
})

test('the input guards name what is wrong', () => {
  assert.throws(() => replaySummary(null), /snapshot is required/)
  assert.throws(() => replaySummary({}, { includeConfig: 'no' }), /includeConfig must be a boolean/)
})

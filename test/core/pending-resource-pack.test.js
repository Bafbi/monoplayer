// #98: the held resource pack. One copy per pack UUID, outside the state cache,
// so the next client receives a frame the 512-entry generic ring would have
// evicted long before.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPendingResourcePacks, TERMINAL_RESULTS } from '../../src/core/pending-resource-pack.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const frame = name => Buffer.from('backend:' + name)

test('a pack is held, and a second frame for the same UUID replaces it', () => {
  const packs = createPendingResourcePacks()
  assert.equal(packs.held, false)

  assert.deepEqual(packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } }), { replaced: false, uuid: A })
  assert.deepEqual(packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: B } }), { replaced: false, uuid: B })
  assert.equal(packs.size, 2)

  const replaced = packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })
  assert.equal(replaced.replaced, true)
  assert.equal(packs.size, 2, 'a re-send of the same pack does not stack')
  assert.deepEqual(packs.list('play').map(entry => entry.uuid), [A, B], 'send order survives')
})

test('a pack belongs to the state it was sent in', () => {
  const packs = createPendingResourcePacks()
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })
  packs.add({ state: 'configuration', buffer: frame('add_resource_pack'), data: { uuid: B } })
  assert.deepEqual(packs.list('play').map(entry => entry.uuid), [A])
  assert.deepEqual(packs.list('configuration').map(entry => entry.uuid), [B])
})

test('remove withdraws one pack, and an absent UUID withdraws them all', () => {
  const packs = createPendingResourcePacks()
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: B } })
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: {} })

  assert.deepEqual(packs.remove({ uuid: A }), { dropped: 1, all: false })
  assert.deepEqual(packs.list('play').map(entry => entry.uuid), [B, null])
  assert.deepEqual(packs.remove({ uuid: A }), { dropped: 0, all: false }, 'a withdrawn pack is not re-withdrawn')
  // The UUID is `option UUID` on the wire, and an absent one means every pack
  // the connection pushed: the client is told to withdraw them all.
  assert.deepEqual(packs.remove({}), { dropped: 2, all: true })
  assert.equal(packs.held, false)
})

test('remove all leaves an empty holder, not one pack the client was told to drop', () => {
  const packs = createPendingResourcePacks()
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })
  packs.add({ state: 'configuration', buffer: frame('add_resource_pack'), data: { uuid: B } })
  assert.deepEqual(packs.remove({}), { dropped: 2, all: true })
  assert.deepEqual(packs.list('play'), [])
  assert.deepEqual(packs.list('configuration'), [])
  assert.deepEqual(packs.clear(), { dropped: 0 })
})

test('only a terminal result ends the round', () => {
  const packs = createPendingResourcePacks()
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })

  // Accepted and downloaded are the middle of a round: a client that leaves
  // there has not told the server the pack is in place.
  assert.equal(packs.answered({ uuid: A, result: 3 }).terminal, false)
  assert.equal(packs.unanswered().length, 1)
  assert.equal(packs.answered({ uuid: A, result: 4 }).terminal, false)
  assert.equal(packs.unanswered().length, 1)

  assert.equal(packs.answered({ uuid: A, result: 0 }).terminal, true)
  assert.equal(packs.unanswered().length, 0)
  assert.equal(packs.held, true, 'an answered pack stays installed for the next client')
  assert.equal(packs.peek()[0].lastResult, 0)
})

test('every terminal result code is one the protocol defines', () => {
  for (const result of [0, 1, 2, 5, 6, 7]) {
    assert.equal(TERMINAL_RESULTS.has(result), true, String(result))
  }
  for (const result of [3, 4]) {
    assert.equal(TERMINAL_RESULTS.has(result), false, String(result))
  }
})

test('an unknown UUID answers nothing', () => {
  const packs = createPendingResourcePacks()
  packs.add({ state: 'play', buffer: frame('add_resource_pack'), data: { uuid: A } })
  assert.deepEqual(packs.answered({ uuid: B, result: 0 }), { answered: false, terminal: true })
  assert.deepEqual(packs.answered({ result: 0 }), { answered: false })
  assert.equal(packs.unanswered().length, 1)
})

test('the holder refuses a frame it cannot hold', () => {
  const packs = createPendingResourcePacks()
  assert.throws(() => packs.add({ state: 'login', buffer: frame('add_resource_pack') }), TypeError)
  assert.throws(() => packs.add({ state: 'play', buffer: 'not a buffer' }), TypeError)
  assert.throws(() => packs.add({ state: 'play', buffer: frame('x'), name: '' }), TypeError)
})

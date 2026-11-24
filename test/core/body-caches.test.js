// #260: the state cache a body owns.
//
// The cache is already a pure factory (src/core/state-cache.js), and the fault
// this file pins is ownership, not the cache's own behaviour: the composition
// root created one cache and served every body from it. Two bodies of one
// account therefore shared one replay, one set of bounds, and one frame counter,
// and a fault on either emptied both.
//
// Nothing here opens a socket: a body is named and a cache is pushed a frame,
// exactly as test/core/state-cache.test.js drives one cache.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBodyCaches } from '../../src/core/body-caches.js'
import { replayFrames } from '../../src/core/join-synth.js'

const buf = label => Buffer.from('body-cache:' + label)

// A body past its warm marker: its configuration and join prefix are cached and
// its warm domains hold what the body sent. Only the names the cache's own
// classification knows are used, so this warms any body the same way.
function warmBody (cache, label) {
  cache.push('configuration', 'registry_data', buf(label + ':registry'))
  cache.push('play', 'login', buf(label + ':login'), { entityId: 42 })
  cache.push('play', 'chunk_batch_finished', buf(label + ':warm'), {})
}

test('#260 a body has one cache, and a second read of it is the same cache', () => {
  const bodies = createBodyCaches()
  const first = bodies.cacheFor('paper_25565')
  const again = bodies.cacheFor('paper_25565')

  assert.equal(first, again, 'a driver and a spectator read one body\'s cache, so the replay is computed once')
  assert.equal(bodies.get('paper_25565'), first, 'a non-creating read names the cache that exists')
  assert.equal(bodies.get('sky_25565'), null, 'a body nothing has touched has no cache')
  assert.equal(bodies.stats().count, 1)
  assert.equal(bodies.stats().metrics.created, 1)
  assert.equal(bodies.stats().metrics.reused, 1)
})

test('#260 two bodies do not share state, sequence numbers, or a snapshot', () => {
  const bodies = createBodyCaches()
  const paper = bodies.cacheFor('paper_25565')
  const sky = bodies.cacheFor('sky_25565')
  assert.notEqual(paper, sky)

  warmBody(paper, 'paper')
  paper.push('play', 'spawn_entity', buf('paper:spawn'), { entityId: 9 })
  warmBody(sky, 'sky')
  sky.push('play', 'spawn_entity', buf('sky:spawn'), { entityId: 10 })

  const paperSnapshot = paper.snapshot()
  const skySnapshot = sky.snapshot()
  assert.equal(paperSnapshot.entities.length, 1)
  assert.equal(skySnapshot.entities.length, 1)
  assert.equal(paperSnapshot.entities[0].data.entityId, 9, 'the paper body holds only its own entity')
  assert.equal(skySnapshot.entities[0].data.entityId, 10, 'the sky body holds only its own entity')
  assert.equal(
    paperSnapshot.prefix.some(frame => frame.buffer.equals(buf('sky:login'))),
    false,
    'no frame of one body is in the other body\'s join prefix'
  )
  // The capture order is the cache's own, and two bodies of one account must not
  // interleave into one counter: a shared counter would reorder the entity/generic
  // merge join-synth builds on it.
  assert.equal(paperSnapshot.frameSeq, 4, 'the paper body counts its own frames')
  assert.equal(skySnapshot.frameSeq, 4, 'the sky body counts from its own first frame')

  // A replay is computed per body: each carries its own entity and no other's.
  const paperReplay = replayFrames(paperSnapshot)
  const skyReplay = replayFrames(skySnapshot)
  assert.equal(
    paperReplay.filter(frame => frame.name === 'spawn_entity').map(frame => frame.data.entityId).join(','),
    '9'
  )
  assert.equal(
    skyReplay.filter(frame => frame.name === 'spawn_entity').map(frame => frame.data.entityId).join(','),
    '10'
  )
})

test('#260 one body\'s fault leaves the other body\'s cache and replay intact', () => {
  const bodies = createBodyCaches()
  const paper = bodies.cacheFor('paper_25565')
  const sky = bodies.cacheFor('sky_25565')
  warmBody(paper, 'paper')
  warmBody(sky, 'sky')
  sky.push('play', 'block_update', buf('sky:block:1'), { location: { x: 1, y: 2, z: 3 } })

  const skyBefore = sky.snapshot()
  const skyReplayBefore = replayFrames(skyBefore).map(frame => frame.name)
  assert.equal(paper.warm, true)

  // The paper body's session faulted: the composition root resets the cache of
  // the body that ended, and nothing else.
  paper.reset()

  assert.equal(bodies.get('paper_25565'), paper, 'a fault resets a body\'s cache; it does not discard the body')
  assert.equal(paper.warm, false, 'the faulted body rebuilds its join from nothing')
  assert.deepEqual(paper.snapshot().prefix, [])
  assert.deepEqual(sky.snapshot(), skyBefore, 'the sibling body\'s cache is byte for byte the one it had')
  assert.equal(sky.warm, true, 'the sibling body is still warm')
  assert.deepEqual(replayFrames(sky.snapshot()).map(frame => frame.name), skyReplayBefore)

  // And the sibling is not merely unchanged: it still takes frames, in its own
  // domains, after the other body died.
  sky.push('play', 'block_update', buf('sky:block:2'), { location: { x: 4, y: 5, z: 6 } })
  assert.equal(sky.snapshot().blocks.length, 2)
  assert.equal(paper.snapshot().blocks.length, 0)
})

test('#260 the bounds belong to the cache, so one body raising a bound leaves the other', () => {
  const bodies = createBodyCaches({ bounds: { maxChunks: 8 } })
  const paper = bodies.cacheFor('paper_25565')
  const sky = bodies.cacheFor('sky_25565')

  // #18: a backend advertises its view distance and the cache grows to hold it.
  // That is one body's backend, so the number is that body's.
  assert.equal(paper.raiseChunkBound(32), 32)
  assert.equal(paper.stats().chunkBound, 32)
  assert.equal(sky.stats().chunkBound, 8, 'the sibling body keeps the configured bound')
})

test('#260 the registry is bounded, and it names the bodies it holds', () => {
  const bodies = createBodyCaches({ maxBodies: 2 })
  bodies.cacheFor('one')
  bodies.cacheFor('two')
  bodies.cacheFor('three')

  assert.deepEqual(bodies.stats().bodies, ['two', 'three'], 'the least recently touched body goes first')
  assert.equal(bodies.get('one'), null, 'an evicted body re-warms from nothing on its next claim')
  assert.equal(bodies.stats().metrics.evicted, 1)
})

test('#260 a body must be named', () => {
  const bodies = createBodyCaches()
  for (const body of ['', null, undefined, 7]) {
    assert.throws(() => bodies.cacheFor(body), TypeError, String(body))
  }
})

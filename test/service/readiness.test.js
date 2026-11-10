// Readiness gates the warm fallback (#87). The cache's chunk count is what
// decides whether a followed transfer may release its client, so the decision
// is pure and tested without sockets or timers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shouldForceWarm, waitForReady } from '../../src/service/readiness.js'

const stats = ({ warm = false, chunkFrames = 0, config = 2, prefix = 40 } = {}) => ({
  warm,
  chunkFrames,
  sizes: { config, prefix, chunks: 0 },
  metrics: { framesCached: 42, framesDropped: 0 }
})

const ready = (body) => ({
  hasConfig: true,
  hasPrefix: true,
  warm: false,
  configFrames: 2,
  prefixFrames: 40,
  chunkFrames: 0,
  ...body
})

test('the warm fallback is refused for a target that has sent no chunk frame', () => {
  assert.equal(shouldForceWarm(ready({ chunkFrames: 0 })), false, 'no terrain, no release')
  assert.equal(shouldForceWarm(ready({ chunkFrames: 1 })), true)
})

test('the warm fallback refuses a cache that is not ready at all', () => {
  assert.equal(shouldForceWarm(ready({ hasConfig: false })), false)
  assert.equal(shouldForceWarm(ready({ hasPrefix: false })), false)
  assert.equal(shouldForceWarm(null), false)
  assert.equal(shouldForceWarm(undefined), false)
})

test('an already warm cache needs no fallback', () => {
  assert.equal(shouldForceWarm(ready({ warm: true, chunkFrames: 0 })), false)
})

test('a start-up call may force warm without chunk data, because it releases nobody', () => {
  assert.equal(shouldForceWarm(ready({ chunkFrames: 0 }), { requireChunks: false }), true)
})

test('waitForReady reports the chunk data the cache holds', async () => {
  const core = { cache: { stats: () => stats({ warm: true, chunkFrames: 0 }) } }
  const outcome = await waitForReady({ core, log: () => {}, maxWarmMs: 1 })
  assert.equal(outcome.warm, true)
  assert.equal(outcome.chunkFrames, 0, 'a warm backend can still have sent no chunk yet')
  assert.equal(shouldForceWarm(outcome), false)

  const withChunks = { cache: { stats: () => stats({ warm: false, chunkFrames: 3 }) } }
  const second = await waitForReady({ core: withChunks, log: () => {}, maxWarmMs: 1 })
  assert.equal(second.chunkFrames, 3)
  assert.equal(shouldForceWarm(second), true)
})

// #16: the interceptor's live mode. The puppet's configuration is streamed to
// the attaching client by the core, so the library's own registry and finish
// writes must never reach it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConfigPathInterceptor } from '../../src/legs/live-front.js'

function rig ({ live = true, cached = [] } = {}) {
  const writes = []
  const raws = []
  let configuration = true
  const interceptor = createConfigPathInterceptor({
    write: (name, params) => writes.push({ name, params }),
    writeRaw: (buffer, meta) => raws.push({ buffer, meta }),
    isConfigurationState: () => configuration,
    cachedConfigFrames: cached,
    live,
    allowLibraryFallback: false,
    onUnavailable: () => { throw new Error('must not be unavailable in live mode') }
  })
  return { interceptor, writes, raws, endConfiguration: () => { configuration = false } }
}

test('live mode holds the library registry and finish writes', () => {
  const r = rig()
  r.interceptor.write('registry_data', { codec: {} })
  r.interceptor.write('finish_configuration', {})
  assert.deepEqual(r.writes, [], 'nothing the library generates reaches the client')
  assert.equal(r.interceptor.replayMode, 'live_stream')
  assert.equal(r.interceptor.resolved, false)
})

test('the core finisher ends the phase without a second finish frame', () => {
  const r = rig()
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.interceptor.finishFromCore(), true)
  assert.equal(r.interceptor.resolved, true)
  assert.deepEqual(r.writes, [], 'the library finish is dropped, not sent twice')
  assert.equal(r.interceptor.stats.finishedByCore, 1)
  assert.equal(r.interceptor.finishFromCore(), false, 'finishing twice is a no-op')
})

test('cached mode still replays what it has and is unaffected by live', () => {
  const r = rig({ live: false, cached: [{ name: 'registry_data', buffer: Buffer.from('r') }] })
  r.interceptor.write('finish_configuration', {})
  assert.equal(r.raws.length, 1, 'the cached frame is replayed')
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0].name, 'finish_configuration')
  assert.equal(r.interceptor.replayMode, 'cached_replay')
})

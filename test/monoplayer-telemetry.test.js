// OTLP/HTTP JSON telemetry: exact payload shapes, batching, drop accounting,
// and the inert default. The fake fetch captures the request without a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTelemetry } from '../src/monoplayer/telemetry.js'
import { createMonoplayer, DEFAULT_CONFIG } from '../src/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../src/monoplayer/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const OTHER = '3f7f2c60-5fd1-4b3c-94b7-000000000042'
const NOW = 1_700_000_000_000
const NANO = '1700000000000000000'

function fakeFetch ({ status = 200, error = null } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) }
    calls.push(call)
    if (error) throw error
    return { ok: status >= 200 && status < 300, status, text: async () => '{}' }
  }
  impl.calls = calls
  return impl
}

function failingThenOk (failures = 1) {
  let attempts = 0
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    attempts++
    if (attempts <= failures) return { ok: false, status: 503, text: async () => '' }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  impl.calls = calls
  return impl
}

async function waitFor (predicate, label = 'condition', timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('no endpoint means a no-op: no fetch, no timers, same shape', async () => {
  const fetchImpl = fakeFetch()
  const telemetry = createTelemetry({ env: {}, fetchImpl, clock: () => NOW })

  assert.equal(telemetry.enabled, false)
  telemetry.log({ event: 'attach', fields: { secret: 'x' } })
  telemetry.metric('monoplayer.frames', 1)
  await telemetry.flush()
  await telemetry.close()

  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(telemetry.stats().enabled, false)
  assert.equal(telemetry.stats().logs.sent, 0)
})

test('log record carries the exact OTLP shape, typed attributes, and no secrets', async () => {
  const fetchImpl = fakeFetch()
  const telemetry = createTelemetry({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
      OTEL_SERVICE_NAME: 'monoplayer-test',
      OTEL_SERVICE_VERSION: '1.2.3',
      HOSTNAME: 'pod-a',
      MONOPLAYER_ACCOUNT_ALIAS: 'glow'
    },
    fetchImpl,
    clock: () => NOW
  })

  telemetry.log({
    event: 'attach',
    fields: {
      name: 'Bafbi',
      replayed: 7,
      synthetic: true,
      ratio: 0.5,
      nested: { a: 1 },
      big: 'x'.repeat(4096),
      access_token: 'MUST_NOT_LEAK',
      ignored: undefined,
      nothing: null
    }
  })
  await telemetry.flush()

  assert.equal(fetchImpl.calls.length, 1)
  const { url, init, body } = fetchImpl.calls[0]
  assert.equal(url, 'http://collector:4318/v1/logs')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/json')

  assert.deepEqual(body, {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'monoplayer-test' } },
          { key: 'service.version', value: { stringValue: '1.2.3' } },
          { key: 'service.instance.id', value: { stringValue: 'pod-a' } },
          { key: 'monoplayer.account.alias', value: { stringValue: 'glow' } }
        ]
      },
      scopeLogs: [{
        scope: { name: 'monoplayer', version: '1.2.3' },
        logRecords: [{
          timeUnixNano: NANO,
          observedTimeUnixNano: NANO,
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: 'attach' },
          attributes: [
            { key: 'name', value: { stringValue: 'Bafbi' } },
            { key: 'replayed', value: { intValue: '7' } },
            { key: 'synthetic', value: { boolValue: true } },
            { key: 'ratio', value: { stringValue: '0.5' } },
            { key: 'nested', value: { stringValue: '{"a":1}' } },
            { key: 'big', value: { stringValue: 'x'.repeat(1024) } }
          ]
        }]
      }]
    }]
  })
  assert.equal(JSON.stringify(body).includes('MUST_NOT_LEAK'), false)
  assert.equal(telemetry.stats().logs.sent, 1)
})

test('metrics emit the exact sum and gauge shapes, aggregating within a batch', async () => {
  const fetchImpl = fakeFetch()
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', HOSTNAME: 'pod-a' },
    fetchImpl,
    clock: () => NOW
  })

  telemetry.metric('monoplayer.frames', 3, { direction: 's2c', state: 'play', name: 'map_chunk' })
  telemetry.metric('monoplayer.frames', 1, { direction: 's2c', state: 'play', name: 'map_chunk' })
  telemetry.metric('monoplayer.attached', 1, {}, 'gauge')
  await telemetry.flush()

  assert.equal(fetchImpl.calls.length, 1)
  const { url, body } = fetchImpl.calls[0]
  assert.equal(url, 'http://collector:4318/v1/metrics')
  assert.deepEqual(body, {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'monoplayer' } },
          { key: 'service.version', value: { stringValue: 'unknown' } },
          { key: 'service.instance.id', value: { stringValue: 'pod-a' } }
        ]
      },
      scopeMetrics: [{
        scope: { name: 'monoplayer', version: 'unknown' },
        metrics: [
          {
            name: 'monoplayer.frames',
            sum: {
              dataPoints: [{
                asInt: '4',
                timeUnixNano: NANO,
                startTimeUnixNano: NANO,
                attributes: [
                  { key: 'direction', value: { stringValue: 's2c' } },
                  { key: 'state', value: { stringValue: 'play' } },
                  { key: 'name', value: { stringValue: 'map_chunk' } }
                ]
              }],
              aggregationTemporality: 2,
              isMonotonic: true
            }
          },
          {
            name: 'monoplayer.attached',
            gauge: {
              dataPoints: [{
                asInt: '1',
                timeUnixNano: NANO,
                startTimeUnixNano: NANO,
                attributes: []
              }]
            }
          }
        ]
      }]
    }]
  })
  assert.equal(JSON.stringify(body).includes('aggregationTemporality":2,"isMonotonic'), true)
  assert.equal(telemetry.stats().metrics.sent, 2)
})

test('the log batch flushes at 512 records, not before', async () => {
  const fetchImpl = fakeFetch()
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })

  for (let i = 0; i < 511; i++) telemetry.log({ event: 'tick', fields: { i } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fetchImpl.calls.length, 0, '511 records stay queued')
  assert.equal(telemetry.stats().logs.queued, 511)

  telemetry.log({ event: 'tick', fields: { i: 511 } })
  await waitFor(() => telemetry.stats().logs.batches === 1, 'the 512-record batch')

  assert.equal(fetchImpl.calls.length, 1)
  const records = fetchImpl.calls[0].body.resourceLogs[0].scopeLogs[0].logRecords
  assert.equal(records.length, 512)
  assert.equal(telemetry.stats().logs.sent, 512)
  await telemetry.close()
})

test('a failed export is retried once, then dropped and counted', async () => {
  const fetchImpl = fakeFetch({ error: new Error('connection refused') })
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })

  telemetry.log({ event: 'attach' })
  telemetry.metric('monoplayer.frames', 1)
  await telemetry.flush()

  const stats = telemetry.stats()
  assert.equal(stats.logs.dropped, 1)
  assert.equal(stats.metrics.dropped, 1)
  assert.equal(stats.requests, 4, 'two attempts per signal')
  assert.equal(stats.retries, 2)
  assert.match(stats.lastError, /connection refused/)
  await telemetry.close()
})

test('a 5xx response is retried once and a later success is recorded', async () => {
  const fetchImpl = failingThenOk(1)
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })

  telemetry.log({ event: 'attach' })
  await telemetry.flush()

  const stats = telemetry.stats()
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(stats.logs.sent, 1)
  assert.equal(stats.logs.dropped, 0)
  assert.equal(stats.retries, 1)
  await telemetry.close()
})

test('a 4xx response is not retried', async () => {
  const fetchImpl = fakeFetch({ status: 400 })
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })

  telemetry.log({ event: 'attach' })
  await telemetry.flush()

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(telemetry.stats().logs.dropped, 1)
  await telemetry.close()
})

test('MONOPLAYER_OTEL_ENDPOINT is accepted as the endpoint', async () => {
  const fetchImpl = fakeFetch()
  const telemetry = createTelemetry({
    env: { MONOPLAYER_OTEL_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })
  telemetry.log({ event: 'start' })
  await telemetry.flush()
  assert.equal(fetchImpl.calls[0].url, 'http://collector:4318/v1/logs')
  await telemetry.close()
})

test('the core forwards lifecycle logs, journals both directions, and emits frame metrics', () => {
  const telemetry = {
    enabled: true,
    logs: [],
    metrics: [],
    log (record) { telemetry.logs.push(record) },
    metric (...args) { telemetry.metrics.push(args) },
    async flush () {},
    async close () {},
    stats: () => ({ enabled: true })
  }
  const journal = {
    enabled: true,
    frames: [],
    events: [],
    frame (record) { journal.frames.push(record) },
    event (name, fields) { journal.events.push({ name, fields }) },
    close () {},
    stats: () => ({ enabled: true })
  }
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER]
    },
    backendLeg,
    frontLeg,
    telemetry,
    journal
  })
  core.start()

  const deliver = (state, name, buffer) => backendLeg.deliver({ state, name, buffer: buffer ?? Buffer.from(`backend:${name}`) })
  deliver('configuration', 'registry_data')
  deliver('play', 'login', Buffer.from('backend:login'))
  deliver('play', 'game_state_change')
  deliver('play', 'position')
  deliver('play', 'chunk_batch_finished')

  const denied = frontLeg.loginStart({ name: 'Other', uuid: OTHER })
  assert.equal(denied.allowed, false)

  const attached = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(attached.attached, true)

  frontLeg.serverbound({ name: 'position' })
  frontLeg.serverbound({ name: 'chat_message' })

  const s2c = journal.frames.filter(frame => frame.dir === 's2c').map(frame => frame.name)
  assert.deepEqual(s2c, ['registry_data', 'login', 'game_state_change', 'position', 'chunk_batch_finished'])
  const c2s = journal.frames.filter(frame => frame.dir === 'c2s')
  assert.deepEqual(c2s.map(frame => [frame.name, frame.state]), [['position', 'play'], ['chat_message', 'play']])

  const frameMetrics = telemetry.metrics.filter(([name]) => name === 'monoplayer.frames')
  assert.ok(frameMetrics.some(([, value, attrs]) =>
    value === 1 && attrs.direction === 's2c' && attrs.name === 'login' && attrs.result === 'forwarded'))
  assert.ok(frameMetrics.some(([, value, attrs]) =>
    value === 1 && attrs.direction === 'c2s' && attrs.name === 'position' && attrs.result === 'forwarded'))
  assert.ok(frameMetrics.some(([, value, attrs]) =>
    value === 1 && attrs.direction === 'c2s' && attrs.name === 'chat_message' && attrs.result === 'dropped'))

  assert.ok(telemetry.logs.some(record => record.event === 'start'))
  assert.ok(telemetry.logs.some(record => record.event === 'backendLogin'))
  assert.ok(telemetry.logs.some(record => record.event === 'attach'))
  assert.ok(telemetry.logs.some(record => record.event === 'attachDenied'))

  assert.ok(telemetry.metrics.some(([name, value]) => name === 'monoplayer.attaches' && value === 1))
  assert.ok(telemetry.metrics.some(([name, value]) => name === 'monoplayer.denials' && value === 1))
  assert.ok(telemetry.metrics.some(([name, value]) => name === 'monoplayer.backend.logins' && value === 1))
  assert.ok(telemetry.metrics.some(([name, value]) => name === 'monoplayer.replay.frames' && value === 4))
})

// #290: the claim a picker click records is the service's own product record,
// and its outcome is a counter an operator reads. The front leg counts the claim
// in its own metrics (#267) and writes its lines through the service's log, but a
// reader of the service's records could not say whether a click took a body, and
// no OTLP series counted a grant at all.
//
// The seam is the composition function, not a socket: createServiceLegs hands the
// front a recording constructor, and the case calls the picker callbacks that
// constructor was given. Nothing here listens, dials or reads custody.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createServiceLegs } from '../../src/service/start-live.js'
import { loadConfig } from '../../src/service/monoplayer.js'

const ATTACH_UUID = '06081639-2178-368a-abb3-3f762836f9a4'
const ACCOUNT_UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'

const RESOLVED = {
  ok: true,
  account: {
    dir: '/data/accounts/' + ACCOUNT_UUID,
    alias: 'puppet',
    name: 'Puppet',
    uuid: ACCOUNT_UUID,
    profile: { name: 'Puppet', authTitle: null, deviceType: null }
  }
}

// The server the click names, as the front's own dialog layer hands it over.
const SERVER = { name: 'paper', slug: 'paper_25565', host: '127.0.0.1', port: 25565 }

// One lane built from recording constructors, and the front options it was
// handed. The metric calls and the log lines are the two readings a case takes.
function lane () {
  const calls = []
  const metrics = []
  const lines = []
  const record = kind => options => {
    calls.push({ kind, options })
    return { kind, options, close () {}, metrics: {}, wireStats: { rejected: 0 } }
  }
  createServiceLegs({
    cfg: loadConfig({
      picker: true,
      attachWhitelist: [ATTACH_UUID],
      front: { host: '127.0.0.1', port: 0 },
      backend: { host: '127.0.0.1', port: 25565 }
    }),
    resolved: RESOLVED,
    control: { allowedServers: () => null },
    telemetry: { metric: (...args) => metrics.push(args) },
    log: (event, fields) => lines.push({ event, ...fields }),
    getSnapshotConfig: () => [],
    legs: {
      liveBackend: record('live-backend-leg'),
      liveFront: record('live-front-leg'),
      offlineBackend: record('offline-backend-leg'),
      offlineFront: record('offline-front-leg')
    }
  })
  const front = calls.find(call => call.kind === 'live-front-leg').options
  return { front, metrics, lines }
}

// A click on a body's own dialog, with the claim outcome the front recorded. Only
// a `claim` verb carries a report, which is what the front hands over: its own
// guard reads `action.verb === 'claim'` and passes null for every other answer.
function verb (claim, action = 'claim') {
  return {
    id: 7,
    verb: action,
    slug: SERVER.slug,
    server: SERVER,
    uuid: '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44',
    name: 'Bafbi',
    claim
  }
}

const claimMetrics = metrics => metrics.filter(([name]) => name === 'monoplayer.picker_claims')

test('#290 a refused claim reaches the service record with its reason', () => {
  const { front, metrics, lines } = lane()
  front.onPickerVerb(verb({ granted: false, repeated: false, reason: 'body_claimed', claimedBy: 'Wren' }))

  const recorded = lines.find(line => line.event === 'pickerVerbRecorded')
  assert.ok(recorded, 'the service still writes its own record of the click')
  assert.equal(recorded.claim.granted, false, 'the record says the click took no body')
  assert.equal(recorded.claim.reason, 'body_claimed', 'and names the contention it hit')
  assert.equal(recorded.claim.claimedBy, 'Wren', 'and who held the body it could not take')

  const [point] = claimMetrics(metrics)
  assert.ok(point, 'a refusal is a counter, not only a line in the log')
  assert.equal(point[1], 1)
  assert.deepEqual(point[2], { outcome: 'refused' }, 'the attribute is the outcome alone, never a player')
})

test('#290 a grant emits the counter an operator reads beside picker_picks', () => {
  const { front, metrics } = lane()
  front.onPickerVerb(verb({ granted: true, repeated: false, reason: null, claimedBy: 'Bafbi' }))

  const [point] = claimMetrics(metrics)
  assert.ok(point, 'a granted claim is counted')
  assert.deepEqual(point[2], { outcome: 'granted' })
})

test('#290 the holder clicking again is a repeat, and not a second claim', () => {
  const { front, metrics } = lane()
  front.onPickerVerb(verb({ granted: true, repeated: true, reason: null, claimedBy: 'Bafbi' }))

  const [point] = claimMetrics(metrics)
  assert.deepEqual(point[2], { outcome: 'repeated' },
    'a repeat is granted but records no new claim, which is what the front counts')
})

test('#290 a verb that is not a claim emits no claim counter', () => {
  const { front, metrics, lines } = lane()
  front.onPickerVerb(verb(null, 'spectate'))
  assert.equal(claimMetrics(metrics).length, 0, 'spectate and disconnect claim nothing')
  const recorded = lines.find(line => line.event === 'pickerVerbRecorded')
  assert.equal(recorded.verb, 'spectate')
  assert.equal('claim' in recorded, false, 'no claim was recorded, so the record names none')
})

test('#290 the counter carries no identity attribute', () => {
  const { front, metrics } = lane()
  front.onPickerVerb(verb({ granted: true, repeated: false, reason: null, claimedBy: 'Bafbi' }))
  const point = claimMetrics(metrics)[0]
  assert.deepEqual(Object.keys(point[2]), ['outcome'],
    'a per-picker or per-player attribute is the cardinality bomb #415 refused')
})

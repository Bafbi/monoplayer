// #415: the per-body and per-channel groups the heartbeat carries.
//
// The heartbeat itself lives inside the module-private runForever, so these are
// the numbers it writes, sampled the way the 30-second tick samples them. The
// measurements it does not take are named in docs/telemetry.md, under "The
// per-body and per-channel groups", with the file each one needs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sampleHeartbeatGroups, emitBodyGauges } from '../../src/service/start-live.js'
import { createTelemetry } from '../../src/observability/telemetry.js'
import { pickSlug } from '../../src/core/picker.js'
import { makeCore } from '../support/harness.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'telemetry.md'), 'utf8')

// A leg that holds two channels on one body, and a claim on it. The shape is the
// one src/core/channels.js and src/core/claims.js return, read through the getters
// the live leg already exposes (src/legs/live-front.js).
function frontFixture () {
  return {
    channels: [
      {
        id: 'channel-1',
        body: 'sky',
        role: 'driver',
        name: 'Bafbi',
        at: 1000,
        delivered: { frames: 9, play: 8, configuration: 1, bytes: 91_004, last: { state: 'play', name: 'map_chunk' }, replays: 1 },
        settings: { viewDistance: 8 },
        settingsAt: 2000
      },
      {
        id: 'channel-2',
        body: 'sky',
        role: 'spectator',
        name: 'Watcher',
        at: 1500,
        delivered: { frames: 4, play: 4, configuration: 0, bytes: 51_493, last: { state: 'play', name: 'map_chunk' }, replays: 1 },
        settings: null,
        settingsAt: null
      }
    ],
    claims: [{ body: 'sky', server: 'Sky', holder: 'channel-1', name: 'Bafbi', at: 900 }]
  }
}

test('#415 the body group names each body the registry holds and what its cache carries', () => {
  const { core } = makeCore()
  const configured = pickSlug(core.config.backend.host + ':' + core.config.backend.port)

  const { bodies } = sampleHeartbeatGroups({ core, front: {}, now: 0 })

  assert.equal(bodies.length, 1, 'a lane with no claim holds one body')
  assert.equal(bodies[0].body, configured)
  assert.equal(bodies[0].active, true, 'the served body is the active one')
  assert.equal(bodies[0].warm, false, 'the fake lane has warmed nothing yet')
  assert.equal(bodies[0].frames, 0, 'an unwarmed cache holds no frames')
  assert.equal(bodies[0].chunkBytes, 0)
  assert.equal(bodies[0].framesCached, 0)
  assert.equal(bodies[0].framesDropped, 0)
})

test('#415 a claimed body reports the claim it holds, and a lane with no claim reports none', () => {
  const { core } = makeCore()
  const served = pickSlug(core.config.backend.host + ':' + core.config.backend.port)
  const answers = (claims) => sampleHeartbeatGroups({ core, front: { channels: [], claims }, now: 4000 })

  assert.equal(answers([]).bodies[0].claimMs, undefined, 'a body nobody claimed has no claim age')
  assert.equal(answers([{ body: 'sky', at: 900 }]).bodies[0].claimMs, undefined,
    'a claim on another body leaves this one without an age')
  assert.equal(answers([{ body: served, at: 900 }]).bodies[0].claimMs, 3100,
    'the served body carries the claim held on it')
})

test('#415 a channel that names no body leaves the key out rather than writing null', () => {
  const { core } = makeCore()
  const front = {
    channels: [{ id: 'channel-9', body: null, role: 'driver', name: 'Bafbi', at: 1000, delivered: { frames: 1 } }],
    claims: []
  }
  const { channels } = sampleHeartbeatGroups({ core, front, now: 2000 })

  assert.equal('body' in channels[0], false, 'a body that does not exist is absent, not null (D2)')
  assert.equal('claimMs' in channels[0], false, 'and no claim age either')
  assert.equal(channels[0].ageMs, 1000)
})

test('#415 a channel row carries its age, what it was sent, and its body\'s spectator count', () => {
  const { core } = makeCore()
  const { channels } = sampleHeartbeatGroups({ core, front: frontFixture(), now: 4000 })

  assert.equal(channels.length, 2)
  const [driver, spectator] = channels
  assert.deepEqual(
    { channel: driver.channel, body: driver.body, role: driver.role, ageMs: driver.ageMs },
    { channel: 'channel-1', body: 'sky', role: 'driver', ageMs: 3000 })
  assert.equal(driver.frames, 9)
  assert.equal(driver.play, 8)
  assert.equal(driver.configuration, 1)
  assert.equal(driver.replays, 1)
  assert.equal(driver.bytes, 91_004, 'the bytes written to this channel, and no other\'s (#417)')
  assert.equal(driver.spectators, 1, 'one channel of this body watches it')

  assert.equal(spectator.role, 'spectator')
  assert.equal(spectator.ageMs, 2500)
  assert.equal(spectator.bytes, 51_493, 'the late arrival counts what it was sent, not what the driver saw')
  assert.equal(spectator.spectators, 1, 'the spectator counts itself: it is watching too')
})

test("#415 the driver's row carries the claim's own age, and a spectator's row does not", () => {
  const { core } = makeCore()
  const { channels } = sampleHeartbeatGroups({ core, front: frontFixture(), now: 4000 })

  assert.equal(channels[0].claimMs, 3100, 'the claim was recorded 3100 ms before this instant')
  assert.equal(channels[1].claimMs, undefined, 'a spectator holds no claim, so it has no claim age')
})

// #417: a channel row a leg wrote before the byte count existed holds no number.
// A count of nothing is 0, which is what the row already says for its frames.
test('#417 a channel the leg counted no bytes for reports none rather than failing', () => {
  const { core } = makeCore()
  const front = {
    channels: [{ id: 'channel-9', body: null, role: 'driver', name: 'Bafbi', at: 1000, delivered: { frames: 1 } }],
    claims: []
  }
  const { channels } = sampleHeartbeatGroups({ core, front, now: 2000 })
  assert.equal(channels[0].bytes, 0)
})

test('#415 a leg that keeps no channel registry reports no channels rather than failing', () => {
  const { core } = makeCore()
  const { channels } = sampleHeartbeatGroups({ core, front: {}, now: 0 })
  assert.deepEqual(channels, [], 'the fake front leg holds no channels, and the lane still reports')
})

test('#415 the group gauges carry a body and never a channel', async () => {
  const bodies = []
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => '{}' }
    },
    clock: () => 1_700_000_000_000
  })

  emitBodyGauges(telemetry, [
    { body: 'sky', warm: true, frames: 12, chunkBytes: 4096 },
    { body: 'nether', warm: false, frames: 0, chunkBytes: 0 }
  ])
  await telemetry.flush()
  await telemetry.close()

  const metrics = bodies[0].resourceMetrics[0].scopeMetrics[0].metrics
  assert.ok(metrics.length > 0, 'the group gauges were exported')

  for (const metric of metrics) {
    assert.ok(metric.gauge, metric.name + ' is a gauge')
    for (const point of metric.gauge.dataPoints) {
      const keys = point.attributes.map(attribute => attribute.key)
      assert.deepEqual(keys, ['body'], metric.name + ' carries the body and nothing per channel')
    }
  }

  const names = [...new Set(metrics.map(metric => metric.name))].sort()
  assert.deepEqual(names, [
    'monoplayer.body.chunkBytes',
    'monoplayer.body.frames',
    'monoplayer.body.warm'
  ])
  const warm = metrics
    .filter(metric => metric.name === 'monoplayer.body.warm')
    .flatMap(metric => metric.gauge.dataPoints)
  assert.equal(warm.length, 2, 'one point per body the lane holds')
  assert.deepEqual(
    warm.map(point => point.attributes[0].value.stringValue).sort(),
    ['nether', 'sky'])
})

// The doc is the only place a reader learns what a field means, so a field the
// record writes and the doc does not name is a number nobody can interpret.
// Names are read off the sampled rows, so a rename that skips the doc fails here.
// The row's own table names it with its group, so a field cannot pass off an
// unrelated row that happens to end in the same word (`monoplayer.frames`).
function documentedField (group, name) {
  // One line at a time: a fenced code block holds two backtick runs, and a
  // pattern that crosses lines pairs them wrongly.
  const backticked = [...DOC.matchAll(/`([^`\n]+)`/g)].map(match => match[1])
  return backticked.includes(group + name)
}

test('#415 every field the two groups write is named in docs/telemetry.md', () => {
  const { core } = makeCore()
  const served = pickSlug(core.config.backend.host + ':' + core.config.backend.port)
  // The fixture as it stands, plus a claim on the body the registry holds, so the
  // conditional `claimMs` key is sampled and its doc row is checked too.
  const groups = sampleHeartbeatGroups({
    core,
    front: { ...frontFixture(), claims: [...frontFixture().claims, { body: served, at: 900 }] },
    now: 4000
  })
  const written = [
    ...Object.keys(groups.bodies[0]).map(name => ['bodies[].', name]),
    ...Object.keys(groups.channels[0]).map(name => ['channels[].', name])
  ]

  assert.ok(written.length > 0, 'the groups write fields to check')
  const missing = written.filter(([group, name]) => !documentedField(group, name)).map(([, name]) => name)
  assert.deepEqual(missing, [], 'docs/telemetry.md does not name: ' + missing.join(', '))
})

// docs/telemetry.md against the exporter it describes (#48). The metrics
// section spells the OTLP temporality value, so the number and the word beside
// it have to be the pair src/observability/telemetry.js sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTelemetry } from '../../src/observability/telemetry.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = path.join(ROOT, 'docs', 'telemetry.md')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const START_LIVE = read('src/service/start-live.js')
const TELEMETRY = read('docs/telemetry.md')
const NOW = 1_700_000_000_000

// The OTLP AggregationTemporality enum: 0 unspecified, 1 delta, 2 cumulative.
// The doc quotes the number, so it has to use this name for it.
const OTLP_NAME = { 1: 'delta', 2: 'cumulative' }

// The temporality the exporter really sends, read off the payload rather than
// off the literal, so the doc is compared to behaviour.
async function sentTemporality () {
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, text: async () => '{}' }
  }
  const telemetry = createTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
    fetchImpl,
    clock: () => NOW
  })
  telemetry.metric('monoplayer.frames', 1, { direction: 's2c' })
  await telemetry.flush()
  await telemetry.close()

  const metrics = bodies[0].resourceMetrics[0].scopeMetrics[0].metrics
  return metrics.find(metric => metric.sum).sum.aggregationTemporality
}

// Every file under docs/, so a stray second claim elsewhere cannot hide from
// the once-only assertion.
function docFiles (dir = path.join(ROOT, 'docs'), found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) docFiles(full, found)
    else found.push(full)
  }
  return found
}

test('the doc calls the exporter temporality by its OTLP name', async () => {
  const sent = await sentTemporality()
  const name = OTLP_NAME[sent]
  assert.ok(name, 'the exporter sends a temporality OTLP gives a name to: ' + sent)

  const doc = fs.readFileSync(DOC, 'utf8')
  const line = doc.split('\n').find(entry => entry.includes('aggregationTemporality'))
  assert.ok(line, 'the metrics section quotes the aggregationTemporality value')
  assert.match(line, new RegExp('aggregationTemporality: ' + sent + '\\b'), 'the doc quotes the value the exporter sends')
  assert.ok(line.includes(name), 'the doc calls value ' + sent + ' ' + name + ': ' + line)

  for (const [value, other] of Object.entries(OTLP_NAME)) {
    if (Number(value) === sent) continue
    assert.ok(!line.includes(other), 'the doc does not call value ' + sent + ' ' + other + ': ' + line)
  }
})

// #331: the start record and the table that documents it name the same labels. A
// rename that leaves the doc naming a field the record stopped writing is worse
// than the duplicate it removed. The doc would describe a fact nobody reports.
// One direction only: the table documents the fields a reader needs, and it never
// claimed to be the whole record.
// Read the labels the `log('startLive', {...})` call writes, by brace matching and
// not by line shape. A nested object then contributes its own name and no inner key.
function recordLabels (source) {
  const open = source.indexOf("log('startLive', {")
  assert.notEqual(open, -1, 'src/service/start-live.js writes a startLive record')
  const from = source.indexOf('{', open)
  let depth = 0
  let end = -1
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.notEqual(end, -1, 'the startLive record closes')
  const labels = new Set()
  let inner = 0
  for (const line of source.slice(from + 1, end).split('\n')) {
    const key = inner === 0 ? line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/) : null
    if (key) labels.add(key[1])
    inner += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  return labels
}

// Read the fields the doc's `startLive` rows name. A dotted name such as
// `control.whitelistReload` is a key of the nested object, so its first segment is
// the record's label.
function documentedLabels (doc) {
  return doc.split('\n')
    .filter(line => line.startsWith('| `startLive`'))
    // Read the Field column only, so a backticked word in the Meaning column is not a label.
    .flatMap(line => [...(line.split('|')[2] ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]))
    .map(name => name.split('.')[0])
}

test('the start record writes every label the telemetry table names', () => {
  const written = recordLabels(START_LIVE)
  const documented = documentedLabels(TELEMETRY)
  assert.ok(documented.length > 0, 'the table documents the startLive record')
  const missing = documented.filter(name => !written.has(name))
  assert.deepEqual(missing, [], 'docs/telemetry.md names a startLive field the record does not write: ' + missing.join(', '))
})

test('docs/ quote the value once, so a reader has one place to check it', () => {
  const hits = []
  for (const file of docFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.includes('aggregationTemporality')) hits.push(path.relative(ROOT, file) + ':' + (index + 1))
    })
  }
  assert.equal(hits.length, 1, 'docs/ quote aggregationTemporality once, found ' + hits.join(', '))
})

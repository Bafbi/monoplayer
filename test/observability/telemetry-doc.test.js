// docs/telemetry.md against the exporter it describes (#48). The metrics
// section spells the OTLP temporality value, so the number and the word beside
// it have to be the pair src/observability/telemetry.js sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTelemetry } from '../../src/observability/telemetry.js'
import { RECORD_IDENTITY_FIELDS } from '../../src/core/channels.js'
import { MAX_REFUSAL_REASONS } from '../../src/legs/live-front.js'
import { DENY_REASONS } from '../../src/custody/attach.js'
import { pickerClaimOutcome } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = path.join(ROOT, 'docs', 'telemetry.md')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const START_LIVE = read('src/service/start-live.js')
const LIVE_FRONT = read('src/legs/live-front.js')
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

// #416: the identity table is read off the module that decides the shape, so a
// fourth identity key, or a row that names a key the code stopped writing, is a
// failure here rather than a reader's confusion.
test('#416 the doc names every identity key a record can carry, and why one is absent', () => {
  const doc = fs.readFileSync(DOC, 'utf8')
  const missing = RECORD_IDENTITY_FIELDS.filter(field => !doc.includes('| `' + field + '` |'))
  assert.deepEqual(missing, [], 'docs/telemetry.md does not name: ' + missing.join(', '))
  assert.ok(doc.includes('carries `account` and no `body` key'),
    'the doc says why a record written before a body exists carries none')
})

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

// #290: the claim report is shaped in one place, and the doc describes it. The
// keys are read off `claimReport`'s returned literal, so a fifth field, or a
// rename, fails here instead of leaving a page that describes a record nobody
// writes. Each field sits at the literal's own depth, so nothing nested leaks in.
function claimReportKeys (source) {
  const at = source.indexOf('function claimReport (outcome) {')
  assert.notEqual(at, -1, 'src/legs/live-front.js shapes the claim report')
  const body = source.slice(at, source.indexOf('\n  }', at))
  return [...body.matchAll(/^\s+(\w+):/gm)].map(match => match[1])
}

test('#290 the doc names the claim report the front shapes, and the lines it writes', () => {
  const keys = claimReportKeys(LIVE_FRONT)
  assert.ok(keys.length > 0, 'claimReport returns a literal the guard can read')
  const missing = keys.filter(key => !TELEMETRY.includes('`' + key + '`'))
  assert.deepEqual(missing, [], 'docs/telemetry.md does not name: ' + missing.join(', '))

  // The three lines the doc describes are three lines the leg writes.
  for (const line of ['pickerClaim', 'pickerClaimRefused', 'pickerClaimReleased']) {
    assert.ok(LIVE_FRONT.includes("'" + line + "'"), 'src/legs/live-front.js writes ' + line)
    assert.ok(TELEMETRY.includes(line), 'docs/telemetry.md names ' + line)
  }
})

test('#290 the doc names the claim counter, its attribute, and every outcome it sends', () => {
  const row = TELEMETRY.split('\n').find(line => line.startsWith('| `monoplayer.picker_claims`'))
  assert.ok(row, 'docs/telemetry.md documents monoplayer.picker_claims')
  assert.match(row, /\|\s*sum\s*\|/, 'the row says the series is a sum')
  assert.ok(row.includes('`outcome`'), 'the row names the one attribute it carries')

  const sent = [
    pickerClaimOutcome({ granted: true, repeated: false, reason: null }),
    pickerClaimOutcome({ granted: true, repeated: true, reason: null }),
    pickerClaimOutcome({ granted: false, repeated: false, reason: 'body_claimed' })
  ]
  for (const outcome of sent) {
    assert.ok(row.includes('`' + outcome + '`'), 'the row explains outcome ' + outcome)
  }
})

// #670: a client the picker ends because the lane offers no rows is a client the refusal
// map answers for, like the one whose dialog the leg could not write: both are pickers
// the lane could not give, not only requests it turned down. The page has to name the
// word, and say where the offer's own cause went, because that parser code is the fact
// an operator repairs a file from (#315, #372).
test('#670 the page counts a lane with no rows as a refusal, and says where the offer cause went', () => {
  const row = prefix => TELEMETRY.split('\n').find(line => line.startsWith(prefix))
  const refusals = row('| `front.pickerRefusals`')
  const pickers = row('| `front.pickers`')
  assert.ok(refusals, 'the page documents the refusal map')
  assert.ok(pickers, 'and the picker join counters')

  assert.ok(refusals.includes('`empty_offer`'),
    'the refusal row names the word a lane with no rows counts under')
  assert.match(refusals, /pickerEmpty[^|]*offerReason/,
    'and says where the offer own cause went, so a reader does not look for it in `reason`')
  assert.match(pickers, /no row to offer/,
    'the join row says such a join is counted there too, because it was served before it ended')
})

// #670: the cap is headroom over the closed set, and the set is that row. A word added to
// the row without raising the bound is a word `bumpBounded` folds into `other` the moment the
// map is full, which reads as a reason nobody named (#435). So the two move together or this
// fails. The row names one word that counts nowhere, `no_client`, which is why clearing every
// word leaves the keys one slot of headroom, as #435's rule asks.
test('#670 the refusal bound clears every reason the refusal row names', () => {
  const row = TELEMETRY.split('\n').find(line => line.startsWith('| `front.pickerRefusals`'))
  assert.ok(row, 'the page documents the refusal map')
  const words = [...new Set([...row.matchAll(/`([^`]+)`/g)].map(match => match[1]))]
    .filter(word => /^[a-z][a-z0-9_]*$/.test(word))

  assert.ok(words.length > 2, 'the row names its reasons in backticks, not in prose')
  assert.ok(MAX_REFUSAL_REASONS >= words.length,
    'MAX_REFUSAL_REASONS is ' + MAX_REFUSAL_REASONS + ' and the row names ' + words.length +
      ' words, so the bound no longer clears the set: raise it, or say in the row why a word is not a key')
})

// #722: the sessionserver's refusal is the one front refusal no denial counts, so the
// page owes it a row of its own, in the reason word the code writes. The three places
// that have to agree are read here: the doc's two rows, the leg that names the record,
// and the sampler that turns the leg's count into a sum. A rename in any one of them is
// a lane whose number an operator cannot find.
test('#722 the doc names the sessionserver refusal, its reason, and the counter behind it', () => {
  const row = prefix => TELEMETRY.split('\n').find(line => line.startsWith(prefix))
  const series = row('| `monoplayer.session.refused`')
  const counter = row('| `front.sessionVerificationRefused`')
  assert.ok(series, 'docs/telemetry.md documents monoplayer.session.refused')
  assert.ok(counter, 'and the leg counter the sum is sampled from')
  assert.match(series, /\|\s*sum\s*\|/, 'the row says the series is a sum')
  assert.ok(series.includes('`' + DENY_REASONS.HASJOINED_FAILED + '`'),
    'the row names the reason the code sends, which is the attach check\'s own word for a failed hasJoined')
  assert.ok(counter.includes('front.denied'),
    'the row says this is not the denial count, because no review ran for such a client')

  // The denial row is where a reader used to learn that this case had no path. It says
  // where the number went instead, and does not name it twice.
  const denials = row('| `monoplayer.denials`')
  assert.ok(denials, 'the page documents the denial sum')
  assert.ok(denials.includes('monoplayer.session.refused'),
    'the denial row points at the sum that does count a session the sessionserver refused')

  // The record and the sum are the same fact in two places: the leg counts one and
  // writes it, and the service samples that count.
  assert.match(LIVE_FRONT, /log\('sessionVerificationRefused', \{[\s\S]{0,200}reason: DENY_REASONS\.HASJOINED_FAILED/,
    'the leg still records the refusal under that reason')
  assert.match(START_LIVE, /front\.metrics\.sessionVerificationRefused/,
    'the service still samples the leg counter the doc names')
  assert.match(START_LIVE, /monoplayer\.session\.refused[\s\S]{0,200}DENY_REASONS\.HASJOINED_FAILED/,
    'and the series it writes carries the reason the doc names')
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

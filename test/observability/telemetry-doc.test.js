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
import { MAX_REFUSAL_REASONS, PICKER_REFUSAL_REASONS } from '../../src/legs/live-front.js'
import { CLAIM_REFUSAL } from '../../src/core/claims.js'
import { OVERFLOW_KEY, UNKNOWN_KEY } from '../../src/core/bounded-counter.js'
import { PICK_VERBS } from '../../src/core/picker.js'
import { DENY_REASONS } from '../../src/custody/attach.js'
import { pickerClaimOutcome } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = path.join(ROOT, 'docs', 'telemetry.md')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const START_LIVE = read('src/service/start-live.js')
const LIVE_FRONT = read('src/legs/live-front.js')
const PICKER = read('src/core/picker.js')
const SERVICE = read('src/service/monoplayer.js')
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
      ' reasons, so the bound no longer clears the set: raise it with the set in PICKER_REFUSAL_REASONS, ' +
      'and declare a reason that is no key in the #671 case below')
})

// #671: one function's body, by brace matching from its own body brace, so a nested object
// or a template cannot end it early. Both modules this case reads declare their functions
// at two spaces inside a factory.
function sourceBody (source, name) {
  const at = source.indexOf('\n  function ' + name + ' (')
  assert.notEqual(at, -1, 'the module has the function ' + name)
  const open = source.indexOf(') {', at) + 2
  assert.ok(open > 2, name + ' has a body')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  assert.fail(name + ' closes')
}

// The snake_case words a piece of source quotes. A reason is one word with no capital in
// it, which is what tells one from an event name or a record field.
const quotedWords = text => [...new Set([...text.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]))]

// Every counted refusal site in the leg, as the object text it passes, by brace matching so
// a record closure inside one site is not mistaken for the end of it. test/legs/picker-numbers.test.js
// scans the same sites with the same walk, and is the file that pins their order.
function countedSites (source) {
  const sites = []
  for (let at = source.indexOf('refuseAndCount({'); at !== -1; at = source.indexOf('refuseAndCount({', at + 1)) {
    const from = source.indexOf('{', at)
    let depth = 0
    let end = -1
    for (let i = from; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    assert.notEqual(end, -1, 'the refusal site at byte ' + at + ' closes')
    sites.push(source.slice(from + 1, end))
  }
  return sites
}

// The words this leg can key its refusal map with: the literals its counted sites pass, and
// the landing's own closure. Three counted sites pass the answer's reason and one the
// outcome's, which is the word the board or the claim decided, so those are read from that
// module instead of this file.
function legWords (source) {
  const words = new Set()
  for (const site of countedSites(source)) {
    const named = site.match(/reason:\s*'([a-z][a-z0-9_]*)'/)
    if (named !== null) words.add(named[1])
  }
  const landing = sourceBody(source, 'landSpectator')
  for (const call of landing.matchAll(/\brefused\(([^)]*)\)/g)) {
    for (const quoted of call[1].matchAll(/'([a-z][a-z0-9_]*)'/g)) words.add(quoted[1])
  }
  for (const named of landing.matchAll(/reason:\s*'([a-z][a-z0-9_]*)'/g)) words.add(named[1])
  return [...words].sort()
}

// The two reasons the picker board writes and the refusal set never holds: a frame that is
// not this dialog's counts nothing, so the client keeps its dialog instead of being refused
// (#257). Each is pinned to that answer in the case below.
const PICKER_UNCOUNTED = ['not_a_click', 'not_a_pick']

// One module's refusal reasons, read the way that module states them. Four modules decide one
// between them, and each says so in its own shape. A module that starts deciding reasons and
// is named nowhere here would still be caught by the page comparison only if its reasons
// reached the page, which is why the four are named rather than found.
const WRITERS = {
  // The claim board's own map, imported: a reason cannot be added there without arriving here.
  'src/core/claims.js': () => Object.values(CLAIM_REFUSAL),
  // The picker board answers a click with a `reason: '<reason>'` literal. Its `case` arms name
  // reasons someone else wrote, so this asks for a write and not a read.
  'src/core/picker.js': () => [...new Set([...PICKER.matchAll(/reason:\s*'([a-z][a-z0-9_]*)'/g)].map(match => match[1]))]
    .filter(reason => !PICKER_UNCOUNTED.includes(reason)),
  // The Spectate answer. Its own reasons are the `reason:` literals it returns, and the rest are
  // the words of the one helper it assigns to `reason`, which is where `body_down` and
  // `body_not_warm` are decided. A log field or a state name in that body is not read.
  'src/service/monoplayer.js': () => {
    const answer = sourceBody(SERVICE, 'spectateBody')
    const reasons = [...new Set([...answer.matchAll(/reason:\s*'([a-z][a-z0-9_]*)'/g)].map(match => match[1]))]
    const helper = answer.match(/const reason = (\w+)\(\)/)
    return helper === null ? reasons : reasons.concat(quotedWords(sourceBody(SERVICE, helper[1])))
  },
  // This leg's counted sites and its one landing closure.
  'src/legs/live-front.js': () => legWords(LIVE_FRONT)
}

// #671: the row's closed set, read against the code that writes it, in both directions.
//
// The row claims a closed set, and until this case nothing read the claim: #670 and #708 each
// moved the set inside four hours and the page did not fail with them. The code side is
// `PICKER_REFUSAL_REASONS` (src/legs/live-front.js), the one list of the reasons that map can
// be keyed by, so the set is stated once in code and once for an operator, and this holds the
// two equal.
//
// Four modules decide a reason, and each is read the way it states one: the claim board's
// `CLAIM_REFUSAL` is a map, imported; the picker board's are the literals it answers a click
// with; the Spectate answer's are its own literals and the helper it assigns to `reason`; and
// the leg's own are its counted sites and the closure its landing refuses through. A new
// reason on either side fails here, and the failure names the row to edit.
//
// It reads names and no behaviour: test/legs/picker-numbers.test.js and
// test/legs/picker-ends.test.js are what read a refusal's count and record off a real leg. What
// it cannot see: a reason that reaches a site through a variable rather than a literal, a reason
// a module answers through a path neither reader below names, and a reason that moved from one
// of the four modules to another, because the set says which reasons exist and not which module
// decides each.
test('#671 the refusal row names every reason the code writes, and no other', () => {
  const row = TELEMETRY.split('\n').find(line => line.startsWith('| `front.pickerRefusals`'))
  assert.ok(row, 'the page documents the refusal map')

  // The three backticked reasons in the row that are not reasons: the two buckets the rule adds
  // (`UNKNOWN_KEY` for a key that is not a name, `OVERFLOW_KEY` past the cap) and the one
  // sentence that reaches no client. A row that stops naming one fails here, so this list
  // cannot go stale.
  const NOT_A_REASON = [UNKNOWN_KEY, OVERFLOW_KEY, 'no_client']
  const backticked = [...new Set([...row.matchAll(/`([^`]+)`/g)].map(match => match[1]))]
    .filter(entry => /^[a-z][a-z0-9_]*$/.test(entry))
  for (const reason of NOT_A_REASON) {
    assert.ok(backticked.includes(reason),
      'the row no longer names `' + reason + '`, which this case reads as not a reason: drop it from that list')
  }
  const pageReasons = backticked.filter(entry => !NOT_A_REASON.includes(entry)).sort()

  const setReasons = [...PICKER_REFUSAL_REASONS].sort()
  const written = new Set(Object.values(WRITERS).flatMap(read => read()))

  // Each module against the set first, so the failure names the module that wrote the reason
  // and not only that something, somewhere, is short.
  for (const [module, read] of Object.entries(WRITERS)) {
    const unnamed = read().filter(reason => !setReasons.includes(reason))
    assert.deepEqual(unnamed, [],
      module + ' writes ' + unnamed.join(', ') + ', and PICKER_REFUSAL_REASONS does not name ' +
        (unnamed.length === 1 ? 'it' : 'them') + ': add each to that list, and to docs/telemetry.md\'s ' +
        '`front.pickerRefusals` row')
  }
  const unwritten = setReasons.filter(reason => !written.has(reason))
  assert.deepEqual(unwritten, [],
    'PICKER_REFUSAL_REASONS names ' + unwritten.join(', ') + ', and no module writes ' +
      (unwritten.length === 1 ? 'it' : 'them') + ': delete ' + (unwritten.length === 1 ? 'it' : 'them') +
      ', or add the module that decides ' + (unwritten.length === 1 ? 'it' : 'them'))

  // The picker board's two uncounted reasons, each pinned to the answer it is: an ignored frame
  // is not a refusal, which is why neither is in the set.
  assert.match(PICKER, /if \(action\.reason === 'not_a_click'\)[\s\S]{0,300}?kind: 'ignore'/,
    'not_a_click is the branch that answers nothing, which is why it counts nowhere')
  assert.match(PICKER, /\{ kind: 'ignore',[^}]*reason: 'not_a_pick'/,
    'and not_a_pick is that answer\'s own reason')
  assert.notEqual(sourceBody(SERVICE, 'spectateBody').match(/const reason = (\w+)\(\)/), null,
    'the Spectate answer names two of its reasons through the helper it assigns to reason, and the reader above follows it')

  const missingFromPage = setReasons.filter(reason => !pageReasons.includes(reason))
  assert.deepEqual(missingFromPage, [],
    'the code writes ' + missingFromPage.join(', ') + ', and docs/telemetry.md\'s `front.pickerRefusals` row ' +
      'omits ' + (missingFromPage.length === 1 ? 'it' : 'them') + ': add ' +
      (missingFromPage.length === 1 ? 'it' : 'each') + ' to that row')

  const notWritten = pageReasons.filter(reason => !setReasons.includes(reason))
  assert.deepEqual(notWritten, [],
    'docs/telemetry.md\'s `front.pickerRefusals` row names ' + notWritten.join(', ') +
      ', and no module writes ' + (notWritten.length === 1 ? 'it' : 'them') + ': delete ' +
      (notWritten.length === 1 ? 'it' : 'them') + ' from that row, or add the module that writes ' +
      (notWritten.length === 1 ? 'it' : 'them') + ' to PICKER_REFUSAL_REASONS')

  // #435's rule, read from both sides now: the cap clears the set and the two buckets the rule
  // adds, so a reason added to the set without raising it is a reason `bumpBounded` folds into
  // `other` the moment the map is full, which reads as a reason nobody named.
  assert.equal(MAX_REFUSAL_REASONS, setReasons.length + 3,
    'MAX_REFUSAL_REASONS is ' + MAX_REFUSAL_REASONS + ' and the set is ' + setReasons.length +
      ' reasons: the cap is the set, the two buckets (`unknown`, `other`) and one clear, so raise it with the set')
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

// #709: the words `configurationEnded`'s `reason` can hold, read off the leg's own end
// sites. Every end takes three arguments and the reason is the second: a literal at ten
// sites, and one string concatenation at the eleventh, which is the guard for a verb no lane
// carries. These two helpers are a third copy of a scanner: endSites is endConfigurationSites
// in test/legs/picker-numbers.test.js, and argumentsOf is its splitArguments, character for
// character. #764 names the two this file already shared with that one (countedSites and
// sourceBody) and not these two, which a comment on it now names.
function endSites (source) {
  const sites = []
  for (let at = source.indexOf('endConfiguration('); at !== -1; at = source.indexOf('endConfiguration(', at + 1)) {
    // The declaration, which is not a call.
    if (/function\s+$/.test(source.slice(0, at))) continue
    const open = source.indexOf('(', at)
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    assert.notEqual(end, -1, 'the end site at byte ' + at + ' closes')
    sites.push({ at, args: source.slice(open + 1, end) })
  }
  return sites
}

// One call's arguments, split at the commas that sit outside brackets, braces and strings.
// The third argument of an end is a call as often as a name, so a plain split on a comma
// would cut it in two.
function argumentsOf (text) {
  const args = []
  let depth = 0
  let quote = null
  let from = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== null) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) { args.push(text.slice(from, i).trim()); from = i + 1 }
  }
  args.push(text.slice(from).trim())
  return args
}

// The one end whose word is composed rather than written: the guard for a verb `PICK_VERBS`
// carries and this leg has no branch for. It is one pattern on the page, because it is one
// site in the code, and the page names the verbs the pattern takes.
const UNBUILT_SITE = /^'verb_' \+ [\w$]+\.verb \+ '_unbuilt'$/
const UNBUILT_WORD = 'verb_<verb>_unbuilt'

// The words the leg ends a client under: ten of them, sorted.
function endWords (source) {
  const words = new Set()
  for (const site of endSites(source)) {
    const reason = argumentsOf(site.args)[1] ?? ''
    if (UNBUILT_SITE.test(reason)) {
      words.add(UNBUILT_WORD)
      continue
    }
    const literal = reason.match(/^'([a-z][a-z0-9_]*)'$/)
    assert.notEqual(literal, null,
      'the end site at byte ' + site.at + ' passes a reason this case cannot read: ' + reason +
        '. Give it a quoted word, or teach this case the shape it writes')
    words.add(literal[1])
  }
  return [...words].sort()
}

// The page's own section on that record, and the words its table states in the first cell. A
// word in another column, such as the refusal key a row explains, is not a word of this set.
function endSection (doc = TELEMETRY) {
  const at = doc.indexOf('\n### The picker end record\n')
  assert.notEqual(at, -1, 'docs/telemetry.md documents the picker end record')
  const next = doc.indexOf('\n#', at + 1)
  return doc.slice(at, next === -1 ? doc.length : next)
}

function endRows (doc = TELEMETRY) {
  const cells = line => line.split('|').map(cell => cell.trim())
  return endSection(doc).split('\n')
    .filter(line => /^\| `[a-z][a-z0-9_<>]*` \|/.test(line))
    .map(line => ({ word: cells(line)[1].replaceAll('`', ''), cells: cells(line) }))
}

// Every file under src/, which is where a record name is either written or read.
function sourceFiles (dir = path.join(ROOT, 'src'), found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, found)
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

// #709: the end line's reason is a second vocabulary on one client, and no page named it: an
// operator reading `picker_empty` on a journal line had to guess, when the map beside the same
// client was keyed `empty_offer`. The set is stated once in the leg's end sites and once for an
// operator, so this holds the two equal in both directions, the way #671 holds the refusal set.
// It reads names and no behaviour: test/legs/picker-ends.test.js is what ends a real leg and
// reads the record it wrote.
test('#709 the page names every word an ended client is recorded under, and no other', () => {
  const words = endWords(LIVE_FRONT)
  const rows = endRows()
  const pageWords = rows.map(row => row.word)

  // The set is closed only while the record has one write site: a second
  // record(client, 'configurationEnded', ...) in the leg would write a word no end site
  // passes, and this case would never see it.
  assert.equal(LIVE_FRONT.match(/'configurationEnded'/g).length, 1,
    'src/legs/live-front.js writes the record once, which is what makes its end sites the whole set: ' +
      "a second write site needs its own reader in this case, and its words in the table")

  assert.ok(endSection().includes('closed'),
    'the section claims the set is closed, which this case is what makes true')

  const missingFromPage = words.filter(word => !pageWords.includes(word))
  assert.deepEqual(missingFromPage, [],
    'src/legs/live-front.js ends a client under ' + missingFromPage.join(', ') + ', and docs/telemetry.md\'s ' +
      '"The picker end record" table omits ' + (missingFromPage.length === 1 ? 'it' : 'them') +
      ': add ' + (missingFromPage.length === 1 ? 'a row' : 'a row each') + ' saying what wrote it')

  const notWritten = pageWords.filter(word => !words.includes(word))
  assert.deepEqual(notWritten, [],
    'docs/telemetry.md\'s "The picker end record" table names ' + notWritten.join(', ') +
      ', and no end site in src/legs/live-front.js writes ' + (notWritten.length === 1 ? 'it' : 'them') +
      ': delete ' + (notWritten.length === 1 ? 'the row' : 'the rows') + ', or add the site that ends a client under it')

  // One row per word: a second row would let the table state two producers for one end.
  assert.deepEqual(pageWords.slice().sort(),
    pageWords.slice().sort().filter((word, index, all) => all.indexOf(word) === index),
    'the table names a word twice')

  // The pattern's verbs, off the module that owns them, in both directions: a verb the dialogs
  // gained, or a verb they dropped, is a section that no longer names what the pattern can take.
  const section = endSection()
  const named = section.match(/member of `PICK_VERBS` \(([^)]*)\)/)
  assert.notEqual(named, null, 'the section names the verbs the pattern takes, in a parenthetical after PICK_VERBS')
  const pageVerbs = [...named[1].matchAll(/`([a-z][a-z0-9_]*)`/g)].map(match => match[1]).sort()
  assert.deepEqual(pageVerbs, [...PICK_VERBS].sort(),
    'the section names ' + pageVerbs.join(', ') + ' as the verbs PICK_VERBS carries, and PICK_VERBS is ' +
      [...PICK_VERBS].join(', ') + ': name them all, and no other, in the parenthetical after PICK_VERBS')

  // The page says the failed disconnect carries the same reason, so the two records are one
  // word set here rather than a second one a reader has to find.
  assert.match(LIVE_FRONT, /configurationDisconnectFailed', \{\s*reason,/,
    'endConfiguration reports a disconnect it could not write under the same reason the end line carries')
})

// #709: which of the ten is an interface and which is documentation of a decision is a claim
// about code, so this reads it off src/. One reader filters that record on one word, and a
// second reader on another word is a word the page calls documentation and no longer is. A line
// that names the record and quotes no word is a comment, so it is skipped; and a branch that
// compares the reason to a variable rather than to a literal is not seen here, because what the
// page claims is which words a reader names, and a word a reader names is a literal. The scan
// is one line wide: a filter that names the record on one line and compares `reason` on the
// next is invisible, and nothing in src/ reads that way today.
test('#709 only spectate_refused is branched on, and the page says which word it is', () => {
  const LEG = path.join('src', 'legs', 'live-front.js')
  const LOOPBACK = path.join('src', 'ladder', 'loopback.js')
  const mentions = []
  for (const file of sourceFiles()) {
    const relative = path.relative(ROOT, file)
    if (relative === LEG) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.includes('configurationEnded')) mentions.push({ where: relative + ':' + (index + 1), line })
    })
  }
  const branches = mentions.filter(mention => /'[a-z][a-z0-9_]*'/.test(mention.line))
  assert.ok(branches.length > 0, 'the page names src/ladder/loopback.js as the record\'s one reader, and no file but the leg compares its reason with a word')

  for (const branch of branches) {
    const words = [...branch.line.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1])
    assert.deepEqual(words, ['spectate_refused'],
      branch.where + ' compares configurationEnded\'s reason with ' +
        (words.length === 0 ? 'no word' : words.join(', ')) +
        ', and the page says the only word a branch reads is spectate_refused: name that branch and its word in ' +
        '"The picker end record"\'s "Branched on" column, and in this case')
  }

  // The file the page names is the branch this case reads, so a reader that stops comparing the
  // record with a word leaves a row pointing at nothing.
  assert.ok(branches.some(branch => branch.where.startsWith(LOOPBACK + ':')),
    'docs/telemetry.md names src/ladder/loopback.js as the reader of spectate_refused, and it no longer compares the record with a word')

  // The table's third column, row by row: the one reader's path, or the word no.
  for (const row of endRows()) {
    const branched = row.cells[3] ?? ''
    if (row.word === 'spectate_refused') {
      assert.equal(branched, '`src/ladder/loopback.js`',
        'the row for ' + row.word + ' names the file that reads it, which is ' +
          branches.map(branch => branch.where).join(', '))
      continue
    }
    assert.equal(branched, 'no',
      'the row for ' + row.word + ' says no branch reads it, in the table\'s third column: ' + branched)
  }
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

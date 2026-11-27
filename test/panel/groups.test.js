// The heartbeat's groups on the page: the per-body and per-channel ones (#419), the
// front leg's counters (#743), and the core's (#833).
//
// #415 added `bodies` and `channels` to the heartbeat, and docs/telemetry.md, under
// "The per-body and per-channel groups", defines every field of both. The panel's
// projection is a whitelist, so a field it does not name never reaches the page, and
// before #419 the two groups were named nowhere: they reached the pod log, the
// journal and OTLP and no page. This file compares the whitelist to the doc's own
// tables, in both directions, so a documented field with no entry is a red gate
// rather than a number the panel silently drops, and an undocumented one is refused
// by name.
//
// The absent and empty cases are here too, because a deployed lane older than #415
// writes neither group and a lane with nobody connected writes an empty channel
// list. A page that threw on either would be worse than one that shows nothing.
//
// #743 is the same finding one group over. The front leg counts a login the
// sessionserver refused, and the panel's own list of front fields did not name it, so the
// count reached the pod log, the journal and OTLP and stopped. The two counter groups are
// projected by shape now, not by name: a counter is a number, so a counter nobody named
// is a row the page draws.
//
// #833 is the third group, and the one #743 left behind: the service writes every
// counter it keeps as the heartbeat's `metrics` group, and the panel's projection named
// eight groups and not that one, so every core counter stopped at the pod log. The tests below are the shape #743's rule implies — a counter the record
// carries and this file has never heard of is a row the page draws — pointed at the
// group where the rule had not been applied.
//
// That last rule is why the front half of this file is not shaped like the bodies half.
// These tests hold the doc's field list against the page in the one direction the doc can
// answer, that every field it names is a row here. The other direction, that every row is
// a field the doc names, is #781's, because the leg writes counters docs/telemetry.md does
// not name yet. Until it lands, a both-directions comparison would fail on the doc's
// silence rather than on the page, and a gate that is red for a reason nobody is fixing
// is a gate somebody silences.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { activity } from '../../src/panel/activity.js'
import { renderLive } from '../../src/panel/views/live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'telemetry.md'), 'utf8')
const HEARTBEAT_AT = '2026-11-18T10:37:12.906Z'
const NOW = Date.parse(HEARTBEAT_AT) + 12_000

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565'
}

const pod = {
  metadata: { name: 'monoplayer-84855d7f8b-5h5bd', creationTimestamp: '2026-11-18T09:00:00.000Z' },
  status: {
    phase: 'Running',
    startTime: '2026-11-18T09:00:00.000Z',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ restartCount: 0 }]
  }
}

// One heartbeat with the groups the test names, and the clock at one instant.
function facts (heartbeat = {}) {
  const record = { t: HEARTBEAT_AT, event: 'heartbeat', attached: false, warm: true, ...heartbeat }
  return activity({ puppet, pod, log: { text: JSON.stringify(record) + '\n' }, now: NOW })
}

// Every field the doc names for one group, in the order its table lists them. Read
// off the page and not listed here: the doc is the field list's home, and a copy of
// it in this file would be the second one. A table row may name two fields, which is
// why this collects every backticked name on the line rather than one per row.
//
// `marker` is the group's prefix in the Field column: `bodies[].` for a list of rows,
// `front.` for a flat group whose row names the field as `front.<field>`. A name the
// doc writes with a `.*` tail is a map's keys, which the doc states as one row.
function documented (marker) {
  const found = []
  // A table row may name its first field in full and the rest as `.field`, which is how
  // the metrics rows are written, and a reader that took only the fully prefixed name
  // would hold one field of each row to the page and let the others drop (#833). The group is the first name's own prefix, so a sibling is read under
  // the row it belongs to and the next table's rows start a group of their own.
  let group = null
  for (const line of DOC.split('\n')) {
    const cells = line.split('|')
    if (cells.length < 3) continue
    // The Field column only, which is the second cell: the Meaning column names
    // files and metrics in backticks too, and none of those is a field.
    const names = [...(cells[1] ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1])
    if (names.length === 0) group = null
    for (const name of names) {
      if (name.startsWith('.')) {
        if (group !== null && group.startsWith(marker)) found.push((group + name.slice(1)).slice(marker.length))
        continue
      }
      const dot = name.indexOf('.')
      group = dot > 0 ? name.slice(0, dot + 1) : null
      if (name.startsWith(marker)) found.push(name.slice(marker.length))
    }
  }
  return [...new Set(found)]
}

// A value of the shape the field's own name says, so a field the doc carries and the
// projection drops shows up as a missing key and not as a missing value.
function valueOf (name) {
  if (name === 'body') return 'sky'
  if (name === 'channel') return 'holder-1'
  if (name === 'role') return 'driver'
  if (name === 'active' || name === 'warm') return true
  return 7
}

function rowOf (group) {
  return Object.fromEntries(documented(group + '[].').map(name => [name, valueOf(name)]))
}

test('#743 the page shows a login the sessionserver refused, beside the front counters', () => {
  // #722 gave the front leg a counter for the refusal the protocol library makes on
  // its own, and the records and the doc row came with it. The card is the only place
  // an operator watches that number, and it never appeared.
  const page = renderLive(facts({ front: { denied: 1, preAuthRefused: 3, sessionVerificationRefused: 4 } }))
  const start = page.indexOf('<h4>Front</h4>')
  assert.notEqual(start, -1, 'the card draws the front group')
  const front = page.slice(start, page.indexOf('</dl>', start))
  assert.match(front, /<dt>sessionserver refused the login<\/dt><dd>4<\/dd>/,
    'the sessionserver refusal is a row in the front group, and its label says which hand refused the login')
  assert.match(front, /<dt>pre-auth refused<\/dt><dd>3<\/dd>/, 'beside the pre-auth counters a reader compares it to')
})

test('#743 every field docs/telemetry.md names for the front group is a row on the page', () => {
  const named = documented('front.')
  assert.ok(named.length > 0, 'docs/telemetry.md names the front group')
  // A distinct number per field, so a row the projection drops is a value missing from
  // the page and not a value another row happens to print too.
  const record = {}
  const numbers = []
  let next = 101
  for (const name of named) {
    if (name.endsWith('.*')) {
      record[name.slice(0, -2)] = { body_claimed: 901, claim_held: 902 }
      continue
    }
    record[name] = next
    numbers.push([name, next])
    next += 1
  }
  const page = renderLive(facts({ front: record }))
  const start = page.indexOf('<h4>Front</h4>')
  const front = page.slice(start, page.indexOf('<h4>', start + 1))
  for (const [name, value] of numbers) {
    assert.ok(front.includes('<dd>' + value + '</dd>'),
      'docs/telemetry.md names front.' + name + ' and the page draws no row for its ' + value)
  }
  assert.equal((front.match(/<div>/g) ?? []).length, numbers.length,
    'one row per counted field: this record carries the doc\'s fields and no others, so a row beside them is a row the doc does not name')
  assert.match(page, /<h4>picker refusals by reason<\/h4>[\s\S]{0,200}<dt>body_claimed<\/dt><dd>901<\/dd>/,
    'a field the doc writes as a map is one row per key, and the key is drawn as the leg wrote it')
})

test('#743 a counter nobody named is a row the page draws, under its own name', () => {
  // The defect was that a field had to be named in two files before an operator could
  // see it. A counter is a number, so the page draws it and says what the leg called it.
  const card = facts({ front: { denied: 2, spectateRefused: 7 } })
  assert.equal(card.heartbeat.front.spectateRefused, 7,
    'the projection keeps a counter this file has no field list for')
  assert.match(renderLive(card), /<dt>spectate refused<\/dt><dd>7<\/dd>/,
    'a field this file has never heard of is a row, with its own name spaced out as its label')
})

test('#743 the front rows keep the order the record carries them in', () => {
  // The order is the leg's declaration and the page has no second opinion about it, so a
  // counter the leg adds lands where the leg put it instead of at the end of a list.
  // The record below is the one that decides: the page prints its keys in the order it
  // receives them, whatever order the leg writes them in.
  const page = renderLive(facts({ front: { sessionVerificationRefused: 1, denied: 2, allowed: 3 } }))
  const at = label => page.indexOf('<dt>' + label + '</dt>')
  assert.ok(at('sessionserver refused the login') < at('denied'),
    'the page kept the record\'s order: the sessionserver refusal was declared first and is drawn first')
  assert.ok(at('denied') < at('allowed'))
})

test('#743 the picker refusals by reason are one row per reason, under their own heading', () => {
  const page = renderLive(facts({
    front: { pickerRefusals: 3, pickerRefusalsByReason: { body_claimed: 2, unknown_server: 1 } }
  }))
  assert.match(page, /<h4>Front<\/h4>[\s\S]*?<dt>picker refusals<\/dt><dd>3<\/dd>/,
    'the total is a counter like any other')
  const heading = page.indexOf('<h4>picker refusals by reason</h4>')
  assert.notEqual(heading, -1, 'the map is a group of its own, named by the field')
  const rows = page.slice(heading, page.indexOf('</dl>', heading))
  assert.match(rows, /<dt>body_claimed<\/dt><dd>2<\/dd>/,
    'a reason is drawn as the leg wrote it: a machine word is not one this file improves')
  assert.match(rows, /<dt>unknown_server<\/dt><dd>1<\/dd>/)
})

test('#743 a front group shows no string and no map that is not counts', () => {
  // What the field list also guarded, and what the shape rule keeps: a value the page
  // cannot render never reaches it. A counter group holds numbers and booleans, so a
  // string — which is where a secret lives — is never a row, whatever its name is.
  // A boolean is refused too, for a smaller reason: neither group holds a flag, and a
  // view that read one as a count would print it wrongly rather than drop it.
  const card = facts({
    front: {
      denied: 1,
      access_token: 'a-token-shaped-secret',
      note: 'hello',
      pickerEnabled: true,
      pickerRefusalsByReason: { body_claimed: 'x' }
    }
  })
  const page = renderLive(card)
  assert.match(page, /<dt>denied<\/dt><dd>1<\/dd>/, 'the counters beside them still draw')
  assert.equal(card.heartbeat.front.access_token, undefined, 'a string is not a counter, whatever it is called')
  assert.equal(card.heartbeat.front.note, undefined)
  assert.equal(card.heartbeat.front.pickerEnabled, undefined, 'a boolean is not a counter either')
  assert.equal(card.heartbeat.front.pickerRefusalsByReason, undefined,
    'a map whose values are not counts is a map the page has no row for, and it is not one the page invents')
  assert.doesNotMatch(page, /<dt>access_token<\/dt>|a-token-shaped-secret|<dt>note<\/dt>|<dt>picker enabled<\/dt>/)
})

test('#833 a core counter nobody named is a row the page draws, under its own name', () => {
  // The test #743's shape implies, on the group where the rule was missing: neither this
  // file nor the view holds a list of the group's counters, and the page draws one that
  // nothing names. `koanCountedByNobody` is the unanticipated key: a counter this
  // repository does not write anywhere, which the record carried once.
  const card = facts({ metrics: { replayFramesRefused: 4, koanCountedByNobody: 7 } })
  assert.equal(card.heartbeat.metrics.koanCountedByNobody, 7,
    'the projection keeps a core counter this file has no field list for')
  const page = renderLive(card)
  assert.match(page, /<dt>replay frames refused<\/dt><dd>4<\/dd>/,
    'the counter an operator went looking for when #833 was filed')
  assert.match(page, /<dt>koan counted by nobody<\/dt><dd>7<\/dd>/,
    'a core counter this file has never heard of is a row, with its own name spaced out as its label')
})

test('#833 every field docs/telemetry.md names for the metrics group is a row on the page', () => {
  const named = documented('metrics.')
  assert.ok(named.length > 0, 'docs/telemetry.md names the metrics group')
  // The doc writes these rows as `metrics.first`, `.second`, `.third`, so the field
  // list is the two parsers agreeing: the doc's own spelling, and the record's.
  const record = {}
  const numbers = []
  let next = 201
  for (const name of named) {
    if (name.endsWith('.*')) {
      record[name.slice(0, -2)] = { chat: 901, use_item: 902 }
      continue
    }
    record[name] = next
    numbers.push([name, next])
    next += 1
  }
  const page = renderLive(facts({ metrics: record }))
  const start = page.indexOf('<h4>Core</h4>')
  assert.notEqual(start, -1, 'the card draws the core group')
  const core = page.slice(start, page.indexOf('<h4>', start + 1))
  for (const [name, value] of numbers) {
    assert.ok(core.includes('<dd>' + value + '</dd>'),
      'docs/telemetry.md names metrics.' + name + ' and the page draws no row for its ' + value)
  }
  assert.equal((core.match(/<div>/g) ?? []).length, numbers.length,
    'one row per counted field: this record carries the doc\'s fields and no others, so a row beside them is a row the doc does not name')
  assert.match(page, /<h4>serverbound by name<\/h4>[\s\S]{0,200}<dt>chat<\/dt><dd>901<\/dd>/,
    'a field the doc writes as a map is one row per key, and the key is drawn as the service wrote it')
})

test('#833 the core rows keep the order the record carries them in', () => {
  // The order is the service's declaration and the page has no second opinion about
  // it, so a counter added beside its family lands beside it.
  const page = renderLive(facts({ metrics: { framesCached: 1, replayFramesRefused: 2, serverboundForwarded: 3 } }))
  const at = label => page.indexOf('<dt>' + label + '</dt>')
  assert.ok(at('frames cached') < at('replay frames refused'),
    'the page kept the record\'s order: frames cached was declared first and is drawn first')
  assert.ok(at('replay frames refused') < at('serverbound forwarded'),
    'and the counter declared after it follows it')
})

test('#833 a core group shows no string and no map that is not counts', () => {
  // The same rule as the front group, on the group where a leak would be worse: this is
  // the group the service writes most of its state into. `/api/puppets/<name>` serves
  // the object asserted here, so a value absent from it is absent from both.
  const card = facts({
    metrics: {
      framesCached: 1,
      access_token: 'a-token-shaped-secret',
      note: 'hello',
      armed: true,
      serverboundByName: { chat: 'x' }
    }
  })
  const page = renderLive(card)
  assert.match(page, /<dt>frames cached<\/dt><dd>1<\/dd>/, 'the counters beside them still draw')
  assert.equal(card.heartbeat.metrics.access_token, undefined, 'a string is not a counter, whatever it is called')
  assert.equal(card.heartbeat.metrics.note, undefined)
  assert.equal(card.heartbeat.metrics.armed, undefined, 'a boolean is not a counter either')
  assert.equal(card.heartbeat.metrics.serverboundByName, undefined,
    'a map whose values are not counts is a map the page has no row for, and it is not one the page invents')
  assert.doesNotMatch(page, /a-token-shaped-secret|<dt>note<\/dt>|<dt>armed<\/dt>/)
  assert.doesNotMatch(JSON.stringify(card), /a-token-shaped-secret/,
    '/api/puppets/<name> serves this object, so the secret reaches neither the page nor the answer')
})

test('#833 a core counter whose name reads wrong says the word the lookup gives it', () => {
  // The lookup is a lookup and not a filter: a counter with no entry is drawn under its
  // own name spaced out, which is what every core counter but these two does.
  const page = renderLive(facts({ metrics: { frontKicks: 2, noticeGhosts: 5, lateFramesAfterHandover: 1 } }))
  assert.match(page, /<dt>clients kicked<\/dt><dd>2<\/dd>/,
    '"front kicks" read as though the front were the thing kicked')
  assert.match(page, /<dt>ghost states answered<\/dt><dd>5<\/dd>/)
  assert.match(page, /<dt>late frames after handover<\/dt><dd>1<\/dd>/, 'and the fallback still draws the rest')
})

test('#833 a lane older than the metrics group draws no core row', () => {
  // A deployed lane older than the record's group writes no `metrics` key, and null is
  // that: the page says nothing rather than drawing a heading over a group of zeros.
  const card = facts()
  assert.equal(card.heartbeat.metrics, null)
  assert.doesNotMatch(renderLive(card), /<h4>Core<\/h4>/)
})

test('#743 a cache domain nobody named is a number the page still shows', () => {
  // `sizes` was the same list with the same defect, and the view already drew whatever
  // the group held: the projection was the thing that dropped a domain.
  assert.match(renderLive(facts({ sizes: { chunks: 166, structures: 4 } })),
    /<dt>domains<\/dt><dd>chunks 166, structures 4<\/dd>/)
})

for (const group of ['bodies', 'channels']) {
  test('#419 the projection of ' + group + ' is the fields docs/telemetry.md names, and no other', () => {
    const named = documented(group + '[].')
    assert.ok(named.length > 0, 'docs/telemetry.md names the fields of ' + group)

    // A field the doc does not name rides beside them: a secret-shaped one, because
    // that is the case the whitelist exists for, and an innocent one, because a
    // stray key is refused on its name and not on its shape.
    const card = facts({ [group]: [{ ...rowOf(group), access_token: 'should-never-be-shown', undocumented: 'x' }] })
    const projected = card.heartbeat[group]
    assert.equal(projected.length, 1, 'one row in, one row out')
    assert.deepEqual(Object.keys(projected[0]).sort(), [...named].sort(),
      'the panel renders the documented fields of ' + group + ' and no other, so a documented field with no entry here is a number the page drops and an undocumented one is a key the page prints')
    assert.ok(!Object.keys(projected[0]).includes('access_token'),
      'a secret-shaped key never reaches the page, whatever the field list says')
  })
}

test('#419 the page renders one row per body, with its frames, bytes, warmth and claim age', () => {
  const page = renderLive(facts({
    bodies: [
      { body: 'sky', active: true, warm: true, frames: 923, chunkBytes: 2_243_099, framesCached: 51_260, framesDropped: 12, claimMs: 45_000 },
      { body: 'nether', active: false, warm: false, frames: 0, chunkBytes: 0, framesCached: 0, framesDropped: 0 }
    ]
  }))
  assert.match(page, /<h4>Body sky<\/h4>/, 'each body is its own row set, named by its slug')
  assert.match(page, /<h4>Body nether<\/h4>/)
  assert.match(page, /<dt>frames<\/dt><dd>923<\/dd>/, 'the entries the cache holds now')
  assert.match(page, /<dt>chunk bytes<\/dt><dd>2243099 \(2\.1 MiB\)<\/dd>/)
  assert.match(page, /<dt>warm<\/dt><dd>yes<\/dd>/)
  assert.match(page, /<dt>claim held<\/dt><dd>45 s<\/dd>/, '45 000 ms reads as an age, not a number of milliseconds')
  // A body nobody claimed has no claim age, and the page says so in words rather
  // than printing a zero (#263 D2).
  assert.match(page, /<dt>claim held<\/dt><dd>no claim stands<\/dd>/)
})

test('#419 the page renders one row per channel, with its role, age, frames and audience', () => {
  const page = renderLive(facts({
    channels: [
      { channel: 'holder-1', body: 'sky', role: 'driver', ageMs: 120_000, frames: 900, play: 880, configuration: 20, bytes: 1_048_576, replays: 1, spectators: 2, claimMs: 45_000 },
      { channel: 'holder-2', body: 'sky', role: 'spectator', ageMs: 60_000, frames: 400, play: 395, configuration: 5, bytes: 524_288, replays: 1, spectators: 2 }
    ]
  }))
  assert.match(page, /<h4>Channel holder-1<\/h4>/, 'each channel is its own row set, named by its id')
  assert.match(page, /<h4>Channel holder-2<\/h4>/)
  assert.match(page, /<dt>role<\/dt><dd>spectator<\/dd>/)
  assert.match(page, /<dt>open for<\/dt><dd>1 min<\/dd>/, 'a minute-old channel reads as a minute')
  assert.match(page, /<dt>frames<\/dt><dd>400<\/dd>/)
  assert.match(page, /<dt>spectator channels<\/dt><dd>2<\/dd>/, 'the audience of the body, not of this channel alone')
  assert.match(page, /<dt>claim held<\/dt><dd>a spectator holds no claim<\/dd>/)
})

test('#419 an age reads in the unit a reader compares to the heartbeat interval', () => {
  const channel = (id, ageMs) => ({
    channel: id, body: 'sky', role: 'spectator', ageMs, frames: 0, play: 0, configuration: 0, bytes: 0, replays: 0, spectators: 1
  })
  const page = renderLive(facts({
    channels: [channel('holder-1', 10_500), channel('holder-2', 150_000), channel('holder-3', 7_200_000),
      channel('holder-4', 172_800_000)]
  }))
  const rowFor = id => page.slice(page.indexOf('<h4>Channel ' + id + '</h4>'), page.indexOf('</dl>', page.indexOf('<h4>Channel ' + id + '</h4>')))
  assert.match(rowFor('holder-1'), /<dt>open for<\/dt><dd>11 s<\/dd>/, 'ten seconds is a second count')
  assert.match(rowFor('holder-2'), /<dt>open for<\/dt><dd>3 min<\/dd>/, 'two and a half minutes is a minute count')
  assert.match(rowFor('holder-3'), /<dt>open for<\/dt><dd>2 hours<\/dd>/, 'an age of hours is a count of hours, not milliseconds')
  assert.match(rowFor('holder-4'), /<dt>open for<\/dt><dd>2 days<\/dd>/, 'and an age of days is a count of days')
})

test('#419 a duration that rounds over its unit crosses into the next one', () => {
  // 59.5 s rounds to 60 s, which is a minute: a unit has one zero, and it is the
  // next unit's.
  const channel = (id, ageMs) => ({ channel: id, body: 'sky', role: 'spectator', ageMs, frames: 0, play: 0, configuration: 0, bytes: 0, replays: 0, spectators: 1 })
  const page = renderLive(facts({ channels: [channel('holder-1', 59_500), channel('holder-2', 3_599_000), channel('holder-3', 86_390_000)] }))
  const rowFor = id => page.slice(page.indexOf('<h4>Channel ' + id + '</h4>'), page.indexOf('</dl>', page.indexOf('<h4>Channel ' + id + '</h4>')))
  assert.match(rowFor('holder-1'), /<dt>open for<\/dt><dd>1 min<\/dd>/)
  assert.match(rowFor('holder-2'), /<dt>open for<\/dt><dd>1 hour<\/dd>/)
  assert.match(rowFor('holder-3'), /<dt>open for<\/dt><dd>1 day<\/dd>/)
})

test('#419 a row with no role says so, and prints no blank line', () => {
  // docs/telemetry.md says `channel` and `role` are always written, so a null one
  // is a record the page cannot explain. A blank row would be the page printing a
  // field with no value, which it never does.
  const page = renderLive(facts({ channels: [{ channel: 'holder-1', role: null, frames: 0, play: 0, configuration: 0, bytes: 0, replays: 0, spectators: 0 }] }))
  assert.match(page, /<dt>role<\/dt><dd>the record carries no role<\/dd>/)
})

test('#419 a heartbeat older than #415 renders as it did, and says nothing about the groups', () => {
  const card = facts()
  assert.equal(card.heartbeat.bodies, null, 'a record with no bodies key is "no groups", not "no rows"')
  assert.equal(card.heartbeat.channels, null)
  const page = renderLive(card)
  assert.doesNotMatch(page, /<h4>Bodies? /, 'the page invents no body row for a lane that writes none')
  assert.doesNotMatch(page, /<h4>Channels? /)
  assert.match(page, /<h4>Session<\/h4>/, 'and every group the record does carry is still rendered')
})

test('#419 an empty group is a lane that holds none, in words', () => {
  const page = renderLive(facts({ bodies: [], channels: [] }))
  assert.match(page, /<h4>Bodies<\/h4>\s*<dl>\s*<div><dt>none<\/dt><dd>the process holds no cache for a body<\/dd>/)
  assert.match(page, /<h4>Channels<\/h4>\s*<dl>\s*<div><dt>none<\/dt><dd>the front holds no channel open<\/dd>/)
})

test('#419 a group of rows the panel cannot read is silence, never "the lane holds none"', () => {
  // The shape a future record could take by mistake. A page that said "the process
  // holds no cache for a body" here would report a measurement the record just
  // contradicted, and the page exists to keep a number and its record together.
  for (const group of [{ bodies: {} }, { bodies: 'sky' }, { bodies: [null, 'x', 7] }, { channels: {} }, { channels: [null] }]) {
    const card = facts(group)
    for (const name of ['bodies', 'channels']) {
      assert.ok(card.heartbeat[name] === null || Array.isArray(card.heartbeat[name]), name + ' is null or a list')
    }
    assert.doesNotThrow(() => renderLive(card))
    assert.doesNotMatch(renderLive(card), /<h4>Bodies<\/h4>|<h4>Channels<\/h4>|<h4>Body |<h4>Channel /)
  }
})

test('#419 one unreadable row does not take the rows beside it with it', () => {
  const card = facts({ bodies: [{ body: 'sky', warm: true }, null, 'x'] })
  assert.deepEqual(card.heartbeat.bodies, [{ body: 'sky', warm: true }])
  assert.match(renderLive(card), /<h4>Body sky<\/h4>/)
})

test('#419 a driver row with no claim age says that about the record, not the lane', () => {
  const page = renderLive(facts({
    channels: [{ channel: 'holder-1', role: 'driver', ageMs: 5_000, frames: 0, play: 0, configuration: 0, bytes: 0, replays: 0, spectators: 0 }]
  }))
  assert.match(page, /<dt>claim held<\/dt><dd>the record carries no claim age<\/dd>/,
    'the doc says a spectator is the only row without a claim age, so a driver without one is a record the panel cannot explain')
  assert.match(page, /<dt>body<\/dt><dd>no claim: the lane admitted this connection itself<\/dd>/)
})

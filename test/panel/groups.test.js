// The heartbeat's per-body and per-channel groups on the page (#419).
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
function documented (group) {
  const found = [...DOC.matchAll(new RegExp('`' + group + '\\[\\]\\.([A-Za-z]+)`', 'g'))]
    .map(match => match[1])
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
  return Object.fromEntries(documented(group).map(name => [name, valueOf(name)]))
}

for (const group of ['bodies', 'channels']) {
  test('#419 the projection of ' + group + ' is the fields docs/telemetry.md names, and no other', () => {
    const named = documented(group)
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

// docs/telemetry.md's attach record against the card (#834).
//
// attachFacts (src/panel/activity.js) picks the fields the card shows off the attach
// record by hand, and nothing compared that list to the doc that defines the record.
// #735 is the defect that costs: `refused` was documented, written by the service and
// counted, and the projection dropped it, so the card printed half of a delivery and the
// gate stayed green. Seven more fields the doc's table names have never reached the page,
// and `synthesizedPositions`, which the paragraph above that table names, is the eighth.
//
// So this file reads both sides. The doc's field list is its table's Field column plus the
// sentence above that table which names the fields the table leaves out. The card's is
// what attachFacts answers, and what the rendered page prints. A documented field with no
// row on the page fails unless the projection declares it in ATTACH_DECLINED with the
// reason it is not drawn, which is the shape #419 and #743 give the same decision.
//
// Both directions are asserted, in the one place the doc can answer. A documented field
// the card drops is the #735 defect. A field the projection answers and the doc does not
// name is a fact nobody documented, and this record carries exactly the doc's fields, so a
// name the projection answers beside them is a name it made up or renamed.
//
// The direction no doc can answer — a field the record writes and this doc never names —
// is the writer's drift, and nothing holds it for this record yet. test/observability/
// telemetry-doc.test.js does that comparison for `startLive`, and #868 carries it for the
// attach record. Until it lands, a field the service starts writing and this page and its
// doc both lack is a number in the pod log. The same holds for a key the record adds inside
// a group: the projection keeps the group whole, and the card draws the fields the doc names
// under its own words, so a key the doc never names is #868's question and not this file's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { activity, ATTACH_DECLINED } from '../../src/panel/activity.js'
import { renderLive } from '../../src/panel/views/live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'telemetry.md'), 'utf8')
const ATTACH_AT = '2026-11-18T10:30:00.000Z'
const NOW = Date.parse(ATTACH_AT) + 60_000

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

// The doc's section for the record, from its heading to the next one, so a row of
// another record's table is never read as this record's field.
function section () {
  const start = DOC.indexOf('\n### The attach record\n')
  if (start === -1) return ''
  const end = DOC.indexOf('\n### ', start + 1)
  return DOC.slice(start, end === -1 ? undefined : end)
}

// The Field column of the section's table, in the order it lists them. One row per field,
// spelled the way the record spells it, group and all: `entities.replayed`. Read off the
// page and not listed here, because the doc is the field list's home and a copy of it in
// this file would be the second one.
function tableFields (text) {
  const found = []
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const first = line.split('|')[1] ?? ''
    for (const match of first.matchAll(/`([^`]+)`/g)) found.push(match[1])
  }
  return found
}

// The fields the paragraph above the table names and the table does not, off the one
// sentence that claims them: "`name`, `reason`, ... describe the attach itself." The
// sentence is the anchor, so a paragraph rewritten without it fails the test below with
// that failure and not with a silent empty list.
const PROSE_CLAIM = 'describe the attach itself.'

function proseFields (text) {
  const prose = text.split('\n').filter(line => !line.trimStart().startsWith('|')).join(' ')
  const flat = prose.replace(/\s+/g, ' ')
  const at = flat.indexOf(PROSE_CLAIM)
  if (at === -1) return []
  const before = flat.slice(0, at)
  const sentence = before.slice(before.lastIndexOf('. ') + 1)
  return [...sentence.matchAll(/`([^`]+)`/g)].map(match => match[1])
}

const documented = [...new Set([...tableFields(section()), ...proseFields(section())])]

// What one documented field reads as in the record, as a value no other row prints. A
// number per field rather than a shared one, so a row the projection drops shows up as a
// missing value and not as a value some other row happened to print.
const STRINGS = { name: 'Bafbi', reason: 'transfer_restored' }
const FLAGS = { includeConfig: true }
const OBJECTS = { pose: { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } }
const FIRST_SENTINEL = 1_000_001

// One attach record carrying every documented field, and the value each one was given.
// The two fields of a group are nested as the record nests them, because the doc's own
// spelling (`packs.held`) is the record's shape.
function recordOf (fields) {
  const record = { t: ATTACH_AT, event: 'attach' }
  const values = new Map()
  let next = FIRST_SENTINEL
  for (const field of fields) {
    const dot = field.indexOf('.')
    const [group, name] = dot === -1 ? [null, field] : [field.slice(0, dot), field.slice(dot + 1)]
    const value = STRINGS[name] ?? FLAGS[name] ?? OBJECTS[name] ?? next++
    values.set(field, value)
    if (group === null) record[name] = value
    else record[group] = { ...(record[group] ?? {}), [name]: value }
  }
  return { record, values }
}

function cardOf (record) {
  return activity({ puppet, pod, log: { text: JSON.stringify(record) + '\n' }, now: NOW })
}

// The fields the projection answers, in the doc's spelling: a group it carries as an
// object is one field per key. `at` is the projection's own name for the record's `t`,
// which is the line the row set is dated from rather than a field of the record.
function projected (attach) {
  if (attach === null) return []
  const fields = []
  for (const [key, value] of Object.entries(attach)) {
    if (key === 'at') continue
    if (value !== null && typeof value === 'object') {
      for (const inner of Object.keys(value)) fields.push(key + '.' + inner)
      continue
    }
    fields.push(key)
  }
  return fields
}

// The rows the card draws for the attach, from the record's heading to the next one, so a
// number printed by the heartbeat or the pod cannot stand in for one of these.
function attachRegion (page) {
  const start = page.indexOf('<h3>Last attach')
  assert.notEqual(start, -1, 'the card draws the last attach')
  const end = page.indexOf('<h3>', start + 1)
  return page.slice(start, end === -1 ? page.length : end)
}

test('#834 docs/telemetry.md still names the attach record the way this file reads it', () => {
  assert.ok(tableFields(section()).length > 0, 'the section "### The attach record" has a table whose Field column names its fields')
  assert.ok(proseFields(section()).length > 0,
    'the paragraph above that table still names the fields the table leaves out: the sentence ending "' + PROSE_CLAIM + '" is where they are')
  assert.ok(documented.length > 0)
})

// The eight fields #834 was filed for, named here because they are the debt and not
// because this file holds the list: the next test holds the whole doc. Each one says what
// a reader does with the number, which is the decision the ticket asks for.
test('#834 every field #834 names is a row on the last attach', () => {
  const { record, values } = recordOf(documented)
  const page = renderLive(cardOf(record))
  const region = attachRegion(page)
  // The bodies the replay gives a spawn, which is the denominator of the one row the card
  // already drew: a count of bodies without a spawn with no count of bodies reads as a
  // fault of unknown size.
  assert.match(region, new RegExp('<dt>bodies given a spawn</dt><dd>' + values.get('entities.replayed') + '</dd>'),
    'entities.replayed: the card draws it beside "bodies without a spawn" so a reader can size the fault')
  // Non-zero is #213's defect, so the row carries its sentence beside the number.
  assert.match(region, new RegExp('<dt>bodies without a spawn</dt><dd>' + values.get('entities.withoutSpawn') + ' \\('))
  // The tab list this client is told about, and the bodies the attach stream gave one of
  // its players. The doc's #218 shape is the pair, and the card printed neither.
  assert.match(region, new RegExp('<dt>players listed</dt><dd>' + values.get('players.info') + '</dd>'),
    'players.info: the tab list the client is handed, which is what players.bodies is read against')
  assert.match(region, new RegExp('<dt>listed players with a body</dt><dd>' + values.get('players.bodies') + '</dd>'),
    'players.bodies: a listed player the stream gave no body to is the invisible player #218 is about')
  // What the two holders offered the client beside the stream: zero or one dialog, and the
  // packs the play state kept.
  assert.match(region, new RegExp('<dt>dialogs held</dt><dd>' + values.get('dialogs.held') + '</dd>'))
  assert.match(region, new RegExp('<dt>dialogs resent</dt><dd>' + values.get('dialogs.resent') + '</dd>'))
  assert.match(region, new RegExp('<dt>packs held</dt><dd>' + values.get('packs.held') + '</dd>'))
  assert.match(region, new RegExp('<dt>packs resent</dt><dd>' + values.get('packs.resent') + '</dd>'))
  // The third delivery number, and the one that makes the other two read: replayed excludes
  // the synthesized position and refused includes a position the leg refused, so a reader
  // comparing the first two needs the count of positions to place the difference.
  // "join" and not just "positions synthesized", which is what the Core group calls the
  // process's cumulative counter of the same name: one card, one word per fact.
  assert.match(region, new RegExp('<dt>join positions synthesized</dt><dd>' + values.get('synthesizedPositions') + '</dd>'),
    'synthesizedPositions: the doc names it above its table, and without it a refused position reads as a lost cached frame')
})

test('#834 the card answers every field the doc names, and the doc names every field the card answers', () => {
  const { record } = recordOf(documented)
  const drawn = documented.filter(field => !(field in ATTACH_DECLINED))
  const card = cardOf(record)
  const answers = projected(card.attach)

  const dropped = drawn.filter(field => !answers.includes(field))
  assert.deepEqual(dropped, [],
    'attachFacts drops fields docs/telemetry.md documents: ' + dropped.join(', ') +
    '. Draw the row, or add the field to ATTACH_DECLINED in src/panel/activity.js with the reason the card does not carry it (#834).')

  const invented = answers.filter(field => !documented.includes(field))
  assert.deepEqual(invented, [],
    'attachFacts answers fields docs/telemetry.md does not name: ' + invented.join(', ') +
    '. A number on the card that the record\'s own doc never explains is a fact nobody documented.')

  // And the page, which is what an operator reads: the projection carrying a field is half
  // the answer, and a view that never draws it is the other half of #735. The value has to
  // land inside a <dd>, so a number printed in another row's sentence cannot stand in for
  // the row this field is missing. It does not check which <dt> introduces it: the eight
  // fields #834 was filed for carry that assertion above, and the words for the rest are
  // the view's, which is not a second list this file may hold.
  const region = attachRegion(renderLive(card))
  const unprinted = drawn.filter(field => {
    const [group, name] = field.includes('.') ? field.split('.') : [null, field]
    const source = group === null ? card.attach : card.attach[group]
    const value = source === null || source === undefined ? null : source[name]
    // A flag is drawn as the two words the page shares for one (html.js, yesno), and every
    // other value as itself.
    const printed = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
    return value === null || value === undefined ||
      !new RegExp('<dd>[^<]*' + printed + '(?:[ ,<(]|</dd>)').test(region)
  })
  assert.deepEqual(unprinted, [],
    'the projection answers these attach fields and the card prints no row for them: ' + unprinted.join(', ') +
    '. A field the record carries, the doc defines and the page never shows is the #735 defect (docs/panel.md, "The Last attach card").')
})

test('#834 a field the card declines is declared with its reason, and is not drawn', () => {
  for (const [field, why] of Object.entries(ATTACH_DECLINED)) {
    assert.ok(documented.includes(field),
      field + ' is declared in ATTACH_DECLINED and docs/telemetry.md does not document it: a declaration for a field that is not there is a list nobody reads')
    assert.equal(typeof why, 'string')
    assert.ok(why.trim().length > 20,
      field + ' is declared in ATTACH_DECLINED with no reason. The reason is the decision the ticket asks for, in words a reader can check')
  }
  // The record the declaration is about: only the declined fields, so every row on the page
  // would be one the declaration is wrong about.
  const { record, values } = recordOf(Object.keys(ATTACH_DECLINED))
  const card = cardOf(record)
  assert.deepEqual(projected(card.attach).filter(field => field in ATTACH_DECLINED), [],
    'a declined field reached the projection, so the card draws a row the file says it does not')

  const region = attachRegion(renderLive(card))
  assert.doesNotMatch(region, /<dl>/,
    'the card draws no row for a record carrying only the declined fields: ' + JSON.stringify(card.attach))
  for (const [field, value] of values) {
    if (typeof value === 'number') assert.ok(!region.includes(String(value)), field + ' is declined and the card printed its ' + value)
  }
})

test('#834 a lane that attached before these fields existed draws no row for them', () => {
  // A record written by a lane older than #218 and #717: no delivery split, no holders, no
  // counted bodies. The card draws what it has and says nothing about the rest, rather than
  // printing zeros it never measured.
  const card = cardOf({ t: ATTACH_AT, event: 'attach', name: 'Bafbi', reason: 'attach', tookMs: 42, replayed: 120 })
  assert.equal(card.attach.refused, null)
  assert.equal(card.attach.entities, null)
  assert.equal(card.attach.dialogs, null)
  const region = attachRegion(renderLive(card))
  assert.match(region, /<dt>replayed<\/dt><dd>120<\/dd>/)
  assert.doesNotMatch(region, /<dt>bodies given a spawn<\/dt>|<dt>dialogs held<\/dt>|<dt>join positions synthesized<\/dt>|<dt>configuration replayed<\/dt>/,
    'no row for a field the record does not carry')
  assert.doesNotMatch(region, /<h4>Entities<\/h4>|<h4>Held and resent<\/h4>|<h4>Players<\/h4>/,
    'no heading over a group the record does not carry')
})

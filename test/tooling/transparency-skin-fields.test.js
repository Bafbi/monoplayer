// The skin records' fields, and the page that states them (#949).
//
// docs/transparency.md carries one row per skin record: the event, the fields it carries, and what
// each one means. That field list is the page's side of a fact whose other side is the `log(...)`
// call sites in src/service/monoplayer.js, so this case holds the two against each other in both
// directions: a field a site writes and the cell leaves out is a finding, and so is a field the cell
// promises and no site writes. A record written at more than one site holds the union: refused is
// three sites, and the third writes no `error`. A field a site can leave out is a finding until the
// row's Meaning says so, and so is that sentence for a field every site always writes.
//
// The names are the other half. The page's rows and the events the service writes are one set, read
// both ways, which is what keeps docs/telemetry.md's sentence honest: it names the two families and
// points here, rather than counting the events. It counted five while the service wrote eight
// (#618's and #685's three spectator records were the ones missing), and nothing read it.
//
// src/driver/dev-proof.js names the three fields the driver report's evidence line prints, in
// `ENTRY_FIELDS`, and says why each one is there. Every key in that list is a field this page
// lists, so a key printed from a field the record does not carry fails here rather than reaching a
// signed report as "signed undefined" (#949's second finding).
//
// What is not compared: `t`, `event`, `account`, and `body` are stamped by the funnels rather than
// passed by a call site (monoplayer.js's `log`, src/core/channels.js's `stampIdentity`), and
// docs/telemetry.md documents them once for every record (#416 holds that table to the module). The
// cells state a call site's fields, which is the fact read here.
//
// `emit('puppet_skin', ...)` carries a related payload and is not a log record, so it is not a row
// this table can hold; nothing reads it today. Why test/tooling/ rather than test/service/, which the
// area rule would name: docs/transparency.md is the repo's claim about itself, and this directory
// holds the guards for those. The technique is not new. test/observability/telemetry-doc.test.js
// and test/service/spectate.test.js read a page's field column off a `log()` literal the same way,
// and test/driver/dev-proof.test.js holds a page's table to a module's list in both directions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { blockSpan, callSpans } from '../support/source-scan.js'
import { ENTRY_FIELDS } from '../../src/driver/dev-proof.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE = 'docs/transparency.md'
const SOURCE = 'src/service/monoplayer.js'
const TELEMETRY = 'docs/telemetry.md'
const GUARD = 'test/tooling/transparency-skin-fields.test.js'
const SECTION = "A client's own player"
const SRC = path.join(ROOT, 'src')

const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGE_TEXT = read(PAGE)
const SOURCE_TEXT = read(SOURCE)
const TELEMETRY_TEXT = read(TELEMETRY)

// A skin record's name is its family and a word, spelled once: a record added to the service is a row
// this guard asks the page for, without an edit here.
const SKIN_PREFIX = '(?:puppetSkin|spectatorSkin)'
const SKIN_EVENT = new RegExp('^' + SKIN_PREFIX + '[A-Za-z]+$')
// A line that speaks of a skin record at all, with or without a suffix: the page names the families,
// and docs/telemetry.md's pointer names them rather than listing a member.
const SKIN_LINE = new RegExp('`' + SKIN_PREFIX)

// The fields the page and the service disagree about, one entry per repair.
test('the event table is the service\'s skin records, the fields of each and what each means, both ways', () => {
  const rows = skinRows(PAGE_TEXT)
  const sites = skinSites(SOURCE_TEXT)
  // Both sides read, or a table emptied by a bad edit would leave every list below holding nothing
  // and passing. The page's side cannot be quiet either: `skinRows` throws when the section has no
  // table, and a table with no row reports every event missing one, which is the repair.
  assert.ok(rows.size > 0, PAGE + ' carries a row per skin record')
  assert.ok(sites.size > 0, SOURCE + ' writes the skin records')

  assert.deepEqual(fieldDisagreement(fieldDrift(rows, sites)), [],
    PAGE + "'s event table and " + SOURCE + ' disagree')
})

// The evidence line's keys, against the record they are read off. One direction: the line prints
// some of the record's fields, so a key it prints must be one the page lists, and a field the page
// lists that the line leaves out is the page's business and not this print's.
test('every key the driver report prints is a field the page lists for puppetSkinSent', () => {
  assert.ok(ENTRY_FIELDS.length > 0, 'src/driver/dev-proof.js names the fields its evidence line prints')
  const printed = printedDrift(ENTRY_FIELDS, skinRows(PAGE_TEXT))
  assert.deepEqual(printed, [], printedDriftRefusal(printed, ENTRY_FIELDS.length))
})

// The page says which two sides its cells are held between, so a reader knows they are checked and
// not prose. docs/telemetry.md points here instead of counting the events.
test('the page names the guard that holds its cells, and docs/telemetry.md points here rather than counting the events', () => {
  const pointers = pointerDrift(PAGE_TEXT, TELEMETRY_TEXT)
  assert.deepEqual(pointers.uncited, [], PAGE + "'s skin section does not name " + GUARD +
    ': state which two sides the Fields cells are read between, so a reader is not left to take them for prose')
  assert.deepEqual(pointers.unpointed, [], TELEMETRY + ' does not point at ' + PAGE +
    " for a skin record's fields, so a reader looking for the fields is sent nowhere")
  assert.deepEqual(pointers.members, [], TELEMETRY + ' names skin records one by one: ' +
    pointers.members.join(', ') + '. Name the families and ' + PAGE + ' for the fields, so the sentence cannot ' +
    'count a list that has grown. It said five events while the service wrote eight (#949)')
})

// The scan's own blindness: a site spelled `log(SKIN_EVENT, { ... })` names its event with a
// variable, so no scan can read it and the page would never be asked for it. Every call of the funnel
// names its event with a literal, which is what makes the set above every site there is. A member call
// is not the funnel: `telemetry.log({ event, fields })` names its event in the payload.
test('every call of the log() funnel names its event with a literal, and no other module under src/ writes a skin record', () => {
  const sites = skinSites(SOURCE_TEXT)
  assert.ok(sites.size > 0, SOURCE + ' writes the skin records')
  const funnel = callSpans(SOURCE_TEXT, 'log')
    .filter(call => SOURCE_TEXT[call.at - 1] !== '.')
    .filter(call => !inComment(call.at))
  assert.ok(funnel.length > 0, SOURCE + ' writes records through the log() funnel')
  const unnamed = funnel.filter(call => !/^['"][A-Za-z0-9_]+['"]$/.test(call.args[0].trim()))
  assert.deepEqual(unnamed.map(call => 'byte ' + call.at + ': ' + call.args[0].trim()), [],
    'a log() call in ' + SOURCE + ' names its event some other way, so this guard cannot read it: pass a quoted name')
  const elsewhere = moduleSources(SRC)
    .filter(file => path.relative(ROOT, file).split(path.sep).join('/') !== SOURCE)
    .filter(file => new RegExp("log\\(\\s*['\"]" + SKIN_PREFIX).test(fs.readFileSync(file, 'utf8')))
  assert.deepEqual(elsewhere.map(file => path.relative(ROOT, file).split(path.sep).join('/')), [],
    'a module under src/ other than ' + SOURCE + ' writes a skin record: move the write, or teach ' +
    GUARD + ' to read both files')
})

// ---------------------------------------------------------------------------
// The page's side
// ---------------------------------------------------------------------------

// The event table's rows, inside the section that documents them: the event, the fields its cell
// lists in its order, the sentence that says what it means, and the line it is. The columns are looked
// up by their header names, so a table whose cells moved is a finding rather than a row read wrong.
function skinRows (page) {
  const lines = section(page, SECTION).split('\n')
  const headers = lines
    .map((line, at) => ({ at, columns: line.trimStart().startsWith('|') ? cells(line) : [] }))
    .filter(({ columns }) => columns.includes('Event') && columns.includes('Fields'))
  assert.equal(headers.length, 1,
    'the "' + SECTION + '" section carries one event table, headed "Event" and "Fields": ' + headers.length + ' found')
  const { at: header, columns } = headers[0]
  const eventAt = columns.indexOf('Event')
  const fieldsAt = columns.indexOf('Fields')
  const meaningAt = columns.indexOf('Meaning')
  assert.notEqual(meaningAt, -1, 'the event table has a "Meaning" column: ' + columns.join(', '))
  assert.match(lines[header + 1], /^\|(\s*:?-+:?\s*\|)+$/,
    'the event table is headed by its separator row: ' + lines[header + 1])

  const rows = new Map()
  let index = header + 2
  for (; index < lines.length && lines[index].trimStart().startsWith('|'); index += 1) {
    const row = cells(lines[index])
    assert.equal(row.length, columns.length,
      'every row of the event table has one cell per column: ' + lines[index])
    const name = row[eventAt].match(/^`([A-Za-z0-9_]+)`$/)
    assert.ok(name !== null, 'every row of the event table opens with one event name: ' + lines[index])
    assert.ok(!rows.has(name[1]), 'the event table names ' + name[1] + ' once: ' + lines[index])
    rows.set(name[1], { fields: backticked(row[fieldsAt]), meaning: row[meaningAt], line: lines[index] })
  }
  // One table, so a second copy of it under this one cannot sit there unread: the page is one a
  // reader scrolls, and the stale copy is the one they find first.
  const later = lines.slice(index).filter(line => line.trimStart().startsWith('|'))
  assert.deepEqual(later, [], 'the section carries one event table: ' + later.length + ' row(s) sit under it')
  return rows
}

// The backticked names a cell lists, in its order.
function backticked (cell) {
  return [...cell.matchAll(/`([^`\n]+)`/g)].map(match => match[1])
}

// A row's cells: the outer pipes are not cells, and a cell keeps its backticks. This is the split
// test/driver/dev-proof.test.js's cells() makes, kept local for the reason section() below keeps its
// copy: one guard's helper is not another guard's, and a false red costs more than two lines.
function cells (line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

// The section a table is documented in, from its heading to the next heading of the same or a higher
// level. A copy, for the reason test/tooling/dev-lane-proof.test.js gives for keeping its own: a guard
// that shares a helper with the guard it is modelled on fails when that one is edited.
function section (text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^#+\s/.test(line) && line.replace(/^#+\s+/, '').trim() === heading)
  assert.notEqual(start, -1, 'the doc has a "' + heading + '" section')
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#+)\s/)
    if (next && next[1].length <= level) { end = index; break }
  }
  return lines.slice(start, end).join('\n')
}

// ---------------------------------------------------------------------------
// The service's side
// ---------------------------------------------------------------------------

// Every `log('<skin record>', { ... })` call in the source, by the event it writes: where the call
// starts and the fields its payload names. The name is read off the call's own first argument, so a
// sentence in a comment cannot stand in for a site.
function skinSites (source) {
  const sites = new Map()
  for (const call of callSpans(source, 'log')) {
    const event = call.args[0].match(/^['"]([A-Za-z0-9_]+)['"]$/)
    if (event === null || !SKIN_EVENT.test(event[1])) continue
    assert.equal(call.args.length, 2,
      'the ' + event[1] + ' call at byte ' + call.at + ' passes its payload and nothing else')
    if (!sites.has(event[1])) sites.set(event[1], [])
    sites.get(event[1]).push({ at: call.at, fields: payloadFields(source, call, event[1]) })
  }
  return sites
}

// The keys a payload literal names. The literal is brace matched by the shared scan and then split at
// its commas; `topLevelNames` reads one field where a payload written on one line names four, which is
// what test/support/source-scan.js says it does and what 7 of the 12 sites here are. A part that does
// not open with a name is the tail of the value before it, because `slice(0, 200)` holds a comma of
// its own. It belongs to that part and is not a field of its own.
function payloadFields (source, call, event) {
  const from = source.indexOf('{', call.open)
  assert.ok(from !== -1 && from < call.close,
    'the ' + event + ' call at byte ' + call.at + ' passes a payload literal')
  const literal = blockSpan(source.slice(from, call.close), 0, 'the payload of ' + event + ' at byte ' + call.at)
  assert.doesNotMatch(literal.body, /[{}]/,
    'the payload of ' + event + ' at byte ' + call.at + ' holds no nested literal, so a split at its commas ' +
    'is its field list. Teach ' + GUARD + ' to read the nested fields rather than reading a subset of them')
  const fields = []
  for (const part of literal.body.split(',')) {
    const named = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)
    if (named !== null) fields.push(named[1])
  }
  assert.ok(fields.length > 0, 'the ' + event + ' call at byte ' + call.at + ' names at least one field')
  return fields
}

// Whether a byte of the source sits in a comment: a sentence that names the funnel is not a call of it,
// and the file says "only from the log() funnel" in one. Read from the line's start to the byte, so a
// line comment, a block comment's opening line and a block comment's body are all read.
function inComment (at) {
  const line = SOURCE_TEXT.slice(SOURCE_TEXT.lastIndexOf('\n', at) + 1, at)
  return line.includes('//') || line.includes('/*') || /^\s*\*/.test(line)
}

// Every .js file under src/, so a second write site is found wherever it is.
function moduleSources (dir) {
  return fs.readdirSync(dir, { recursive: true })
    .map(name => path.join(dir, name))
    .filter(file => file.endsWith('.js') && fs.statSync(file).isFile())
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

// What the two sides disagree about, one list per repair.
function fieldDrift (rows, sites) {
  const written = new Map([...sites].map(([event, calls]) => [event, new Set(calls.flatMap(call => call.fields))]))
  const missingRow = [...sites.keys()].filter(event => !rows.has(event))
  const missingSite = [...rows.keys()].filter(event => !sites.has(event))
  const writtenNotPage = []
  const pageNotWritten = []
  const unnamedAbsent = []
  const overSaid = []
  for (const [event, fields] of written) {
    const row = rows.get(event)
    if (row === undefined) continue
    const cell = new Set(row.fields)
    for (const field of fields) {
      if (!cell.has(field)) { writtenNotPage.push({ event, field }); continue }
      const writes = sites.get(event).filter(call => call.fields.includes(field)).length
      if (writes === sites.get(event).length) continue
      // A field one site of several leaves out is the union's other half, and a field list cannot say
      // it: the row's sentence has to, or a reader is told every record carries it.
      if (!claimedAbsent(row.meaning).includes(field)) {
        unnamedAbsent.push({ event, field, sites: sites.get(event).length, writes })
      }
    }
    for (const field of cell) if (!fields.has(field)) pageNotWritten.push({ event, field })
    // The other direction of the same sentence: a Meaning that says a field can be absent, for a
    // field every site writes, is the page stating a rule the code does not have.
    for (const field of claimedAbsent(row.meaning)) {
      if (!cell.has(field)) overSaid.push({ event, field, because: "the row's Fields cell does not list it" })
      else if (sites.get(event).every(call => call.fields.includes(field))) {
        overSaid.push({ event, field, because: 'every one of its ' + sites.get(event).length + ' call sites writes it' })
      }
    }
  }
  return { missingRow, missingSite, writtenNotPage, pageNotWritten, unnamedAbsent, overSaid }
}

// The edit each disagreement asks for, naming the record, the field, and the side that lost it. A
// message that said only "the page and the service disagree" would leave the reader to find which of
// the five edits is theirs.
function fieldDisagreement ({ missingRow, missingSite, writtenNotPage, pageNotWritten, unnamedAbsent, overSaid }) {
  const page = PAGE + "'s event table"
  return [
    ...missingRow.map(event => page + ' has no row for ' + event + ', and ' + SOURCE + ' writes it: add the ' +
      'row, the fields its call sites pass, and what it means'),
    ...missingSite.map(event => page + ' has a row for ' + event + ', and no log() call site in ' + SOURCE +
      ' writes that event: rename the row and the record together, or delete the row'),
    ...writtenNotPage.map(({ event, field }) => 'a ' + event + ' call site writes ' + field + ', and ' + page +
      " leaves it out of that row's Fields cell: name it there, or stop writing it"),
    ...pageNotWritten.map(({ event, field }) => page + "'s row for " + event + ' promises ' + field +
      ', and no call site writes it: a cell is the union of the fields the record\'s sites pass, and nothing else'),
    ...unnamedAbsent.map(({ event, field, sites, writes }) => 'the ' + event + " row's Fields cell lists " + field +
      ', and ' + writes + ' of its ' + sites + ' call sites write it: the row\'s Meaning must say `' + field +
      '` is absent, so a reader is told which site leaves it out'),
    ...overSaid.map(({ event, field, because }) => 'the ' + event + " row's Meaning says `" + field +
      '` is absent, and ' + because + ': a field list states the union, and the sentence beside it says ' +
      'which site leaves a field out, so say it only for a field a site leaves out')
  ]
}

// The fields a row's Meaning says a site can leave out. One phrase, read both ways: a field a site
// omits has to be said here, and a field said here has to be one a site omits.
const claimedAbsent = meaning => [...meaning.matchAll(/`([^`\n]+)` is absent/g)].map(match => match[1])

// The keys the evidence line prints that the record's own cell does not list, and the sentence that
// names the repair.
function printedDrift (fields, rows) {
  const row = rows.get('puppetSkinSent')
  assert.ok(row !== undefined, PAGE + ' has a row for puppetSkinSent, the record the evidence line reads')
  return fields.filter(field => !row.fields.includes(field))
}

function printedDriftRefusal (printed, total) {
  return 'the evidence line in src/driver/dev-proof.js prints ' + printed.join(', ') + ', one of the ' + total +
    ' fields of ENTRY_FIELDS, and ' + PAGE + "'s puppetSkinSent cell does not list it: an operator signs a " +
    'report quoting that line, so a key printed from a field the record does not carry reaches them as ' +
    '"signed undefined". List the field in the cell, or stop printing it'
}

// The page's own sentence naming its guard, and docs/telemetry.md's pointer at the page.
function pointerDrift (page, telemetry) {
  const sectionText = section(page, SECTION)
  const skinLines = telemetry.split('\n').filter(line => SKIN_LINE.test(line))
  assert.ok(skinLines.length > 0, TELEMETRY + ' says where a skin record\'s fields are documented')
  return {
    uncited: sectionText.includes(GUARD) ? [] : [GUARD],
    unpointed: skinLines.filter(line => !line.includes(PAGE)).length === 0 ? [] : [PAGE],
    members: skinLines.flatMap(line =>
      [...line.matchAll(new RegExp('`(' + SKIN_PREFIX + '[A-Za-z]+)`', 'g'))].map(match => match[1]))
  }
}

// ---------------------------------------------------------------------------
// The comparison, on a page and a service built here
// ---------------------------------------------------------------------------

// The shape the tree holds, small enough to edit one side of at a time: one record written once, and
// one written at two sites where the second leaves `error` out.
const AGREEING = Object.freeze({
  puppetSkinSent: [['name', 'signed']],
  puppetSkinRefused: [['reason', 'error'], ['reason']]
})

const ROWS = Object.freeze([
  { event: 'puppetSkinSent', fields: ['name', 'signed'], meaning: 'an entry was written' },
  { event: 'puppetSkinRefused', fields: ['reason', 'error'], meaning: '`error` is absent when nothing threw' }
])

// The page the guard reads, with the parts a case edits as arguments. The sentence naming the guard
// is in the section, as it is in docs/transparency.md.
const asPage = ({
  rows = ROWS,
  heading = '## ' + SECTION,
  note = '`Fields` cells are held to the `log(...)` call sites in `src/service/monoplayer.js` by ' + GUARD + '.'
} = {}) => [
  '# A page',
  '',
  'Prose above the section is not the table, and a name in it answers for nothing.',
  '',
  heading,
  '',
  note,
  '',
  'What the proxy says about it, one event per thing that happened:',
  '',
  '| Event | Fields | Meaning |',
  '|---|---|---|',
  ...rows.map(row => '| `' + row.event + '` | ' + row.fields.map(field => '`' + field + '`').join(', ') +
    ' | ' + row.meaning + ' |'),
  '',
  '## The next section'
].join('\n')

// The service's side as the scan reads it: one entry per call site, in source order.
const asSites = spec => new Map(Object.entries(spec)
  .map(([event, calls]) => [event, calls.map((fields, at) => ({ at, fields }))]))

const pointing = 'The skin records are `puppetSkin*` and `spectatorSkin*`. ' + PAGE + " gives each one's fields."
const counting = 'The skin reports through two events: `puppetSkinKnown` and `puppetSkinSent`. ' +
  PAGE + " gives each one's fields."

test('a page and a service that agree report nothing, so the findings below are the comparison and not its shape', () => {
  assert.deepEqual(fieldDrift(skinRows(asPage()), asSites(AGREEING)), {
    missingRow: [], missingSite: [], writtenNotPage: [], pageNotWritten: [], unnamedAbsent: [], overSaid: []
  })
})

test('the comparison names the record and the side that lost the field, one sentence per repair', () => {
  const rows = skinRows(asPage())

  // A record the service writes and the page has no row for.
  const extraSite = asSites({ ...AGREEING, puppetSkinWithheld: [['name']] })
  assert.match(fieldDisagreement(fieldDrift(rows, extraSite))[0],
    /^docs\/transparency\.md's event table has no row for puppetSkinWithheld, and src\/service\/monoplayer\.js writes it/)

  // A row for an event no call site writes.
  const extraRow = skinRows(asPage({
    rows: [...ROWS, { event: 'spectatorSkinSent', fields: ['channel'], meaning: 'an entry was written' }]
  }))
  assert.match(fieldDisagreement(fieldDrift(extraRow, asSites(AGREEING)))[0],
    /has a row for spectatorSkinSent, and no log\(\) call site in src\/service\/monoplayer\.js writes that event/)

  // A field a site writes and the cell leaves out: #949's first finding, with `signed` as the field.
  const wider = asSites({ ...AGREEING, puppetSkinSent: [['name', 'signed', 'reason']] })
  assert.match(fieldDisagreement(fieldDrift(rows, wider))[0],
    /a puppetSkinSent call site writes reason, and docs\/transparency\.md's event table leaves it out/)

  // A field the cell promises and no site writes.
  const narrower = asSites({ ...AGREEING, puppetSkinSent: [['name']] })
  assert.match(fieldDisagreement(fieldDrift(rows, narrower))[0],
    /promises signed, and no call site writes it:/)

  // The same sentence from the other side: a Meaning that says a field is absent while every site
  // writes it is a rule the code does not have.
  const overclaiming = skinRows(asPage({
    rows: [ROWS[0], { event: 'puppetSkinRefused', fields: ['reason'], meaning: '`reason` is absent when nothing threw' }]
  }))
  assert.match(fieldDisagreement(fieldDrift(overclaiming, asSites({
    puppetSkinSent: [['name', 'signed']], puppetSkinRefused: [['reason']]
  })))[0],
    /the puppetSkinRefused row's Meaning says `reason` is absent, and every one of its 1 call sites writes it/)

  // One field is one finding: a field the cell leaves out is not also asked to say a site can omit it.
  const dropped = skinRows(asPage({
    rows: [ROWS[0], { event: 'puppetSkinRefused', fields: ['reason'], meaning: 'the packet could not be built' }]
  }))
  const one = fieldDisagreement(fieldDrift(dropped, asSites(AGREEING)))
  assert.equal(one.filter(line => line.includes('error')).length, 1,
    'a field the cell leaves out is one finding, not two: ' + one.join(' | '))

  // A field one site of two leaves out, with a Meaning that does not say so.
  const silent = skinRows(asPage({
    rows: [ROWS[0], { ...ROWS[1], meaning: 'the packet could not be built' }]
  }))
  assert.match(fieldDisagreement(fieldDrift(silent, asSites(AGREEING)))[0],
    /the puppetSkinRefused row's Fields cell lists error, and 1 of its 2 call sites write it: the row's Meaning must say `error` is absent/)
})

test('the printed keys, the evidence sentence, and the page\'s pointer are read against a page built here too', () => {
  const page = asPage()
  assert.deepEqual(printedDrift(['name', 'signed'], skinRows(page)), [])
  assert.deepEqual(printedDrift(['name', 'signed', 'reason'], skinRows(page)), ['reason'])
  assert.match(printedDriftRefusal(['reason'], 3), /prints reason, one of the 3 fields of ENTRY_FIELDS/)
  assert.match(printedDriftRefusal(['reason'], 3), /reaches them as "signed undefined"/)

  assert.deepEqual(pointerDrift(page, pointing), { uncited: [], unpointed: [], members: [] })
  assert.deepEqual(pointerDrift(asPage({ note: 'the call sites pass these fields.' }), pointing).uncited, [GUARD])
  assert.deepEqual(pointerDrift(page, 'The skin records are `puppetSkin*`.').unpointed, [PAGE])
  // A sentence that names the records is a list the page already holds, and the list here went stale:
  // it said five events while the service wrote eight (#949).
  assert.deepEqual(pointerDrift(page, counting).members, ['puppetSkinKnown', 'puppetSkinSent'])
})

test('a page with no section, no table, or no row is a throw rather than a comparison holding nothing', () => {
  assert.throws(() => skinRows(asPage({ heading: '## Another section' })), /has a "A client's own player" section/)
  assert.throws(() => skinRows('# A page\n\n## ' + SECTION + '\n\nNo table here.'),
    /carries one event table, headed "Event" and "Fields": 0 found/)
  assert.throws(() => pointerDrift(asPage(), 'Nothing here names a skin record.'),
    /docs\/telemetry\.md says where a skin record's fields are documented/)
})

// docs/panel.md against the records src/panel/ writes (#341).
//
// The page tells a reader which records to grep for, and one paragraph states an
// order: `panelStreamEnd` is written after both intervals are cleared, so a test
// that waits on that record is a test that waits for the stream to start no new
// read. #330's test waits on it, and before this file a rename of the record cost
// that test a two-second budget and a message about a clock instead of naming the
// drift. The order nothing saw at all: with the log moved above the clears,
// test/panel/stream.test.js passes 14 of 14, because stop() sets closed first.
//
// The shape is test/observability/telemetry-doc.test.js: the page and the source are
// read as text, the names are extracted from each side, and the two sets are
// compared. Nothing here runs a stream, and nothing here needs one.
//
// One direction is asserted and the other is declined, on purpose. The page names
// the records an operator acts on — a write landed, a tick was skipped, a stream
// ended, the panel started. It does not name the panel's diagnostics, and a runbook
// page that listed every one would be a catalogue nobody reads. So a record
// src/panel/ writes and the page does not name is not a failure here.
// test/observability/telemetry-doc.test.js declines the same direction in its own
// words ("the table documents the fields a reader needs, and it never claimed to be
// the whole record"), so this is the precedent's answer and not a second vocabulary.
//
// The direction that is asserted covers that drift in both readings: when a record
// is renamed or deleted in src/panel/, the page is left naming a record nothing
// writes, and the doc-against-code comparison fails with the name. Everything here
// reads statements and not lines: a reformat, or a record moved onto one long line,
// keeps every test green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const PANEL = path.join(ROOT, 'src', 'panel')
const STREAM = 'src/panel/routes/stream.js'
const DOC = 'docs/panel.md'
// The test the page's own paragraph points at: "A test waits on that record instead
// of on a clock, which is why the order matters."
const WAITING = 'test/panel/stream.test.js'
// The page's claim about the order, as one sentence: matched with its whitespace
// collapsed on both sides, so a rewrapped paragraph is not a changed claim.
const ORDER_CLAIM = 'Both intervals are cleared before that record is written'

// The records the page has promised an operator, and the names it may not stop
// teaching without this file saying so. #341 asks for that direction as well as the
// other one, and it is the direction a page drifts in quietly: a paragraph rewritten
// and a record name dropped, leaving a reader who greps the panel log with a name the
// page never explains.
//
// This is a list and not a mirror of the code. src/panel/ writes 42 names and only the
// ones the page teaches are here. Nor is it a copy of the page: the page may name a
// record this file does not list, and needs no edit here to do it. What it holds is the
// smaller fact that these seven were documented, which neither the code nor the page
// can answer alone. Add a line when the page documents another record worth keeping;
// a removal is the deliberate act this test exists to catch. That a name here is a
// record the code writes follows from the page naming it, which the next test checks.
const NAMED = [
  'panelAllowedServerAdd',
  'panelAllowedServerRemove',
  'panelStart',
  'panelStreamEnd',
  'panelStreamTickSkipped',
  'panelWhitelistAdd',
  'panelWhitelistRemove'
]

function panelSources (dir = PANEL, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) panelSources(full, found)
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

// Every quoted camelCase name beginning `panel` in a piece of source. One reader for
// all three extracts below, so a record written in either quote style is read the
// same way by the code side, the ternary side, and the check that accounts for every
// literal.
function panelNames (text) {
  return [...text.matchAll(/(['"])panel([A-Z][A-Za-z]*)\1/g)].map(match => 'panel' + match[2])
}

// Every log() call in a piece of source: its event name when the first argument is
// that name, where the call starts, where its first argument ends, and where the call
// closes. Read by paren matching and not by line shape, so a reformat changes
// nothing.
function logCalls (source) {
  const calls = []
  for (const call of source.matchAll(/\blog\(/g)) {
    const from = call.index + call[0].length
    let depth = 0
    let end = -1
    let close = source.length
    for (let i = from; i < source.length; i += 1) {
      const char = source[i]
      if ('([{'.includes(char)) depth += 1
      else if (')]}'.includes(char)) {
        if (depth === 0) { close = i; break }
        depth -= 1
      } else if (char === ',' && depth === 0 && end === -1) end = i
    }
    const [name] = panelNames(source.slice(from, end === -1 ? close : end))
    if (name !== undefined) calls.push({ name, at: call.index, from, close })
  }
  return calls
}

// The four write records are not written as log('…'): each route chooses one of two
// names in a ternary and passes the result, so a scan for log arguments finds none
// of them. src/panel/routes/whitelist.js and src/panel/routes/allowed.js are the two
// that do it, and a third would have to add its own branch to this extractor.
function ternaryEvents (source) {
  return [...source.matchAll(/\?\s*(['"])panel([A-Z][A-Za-z]*)\1\s*:\s*(['"])panel([A-Z][A-Za-z]*)\3/g)]
    .flatMap(match => ['panel' + match[2], 'panel' + match[4]])
}

function writtenRecords () {
  const written = new Set()
  for (const file of panelSources()) {
    const source = fs.readFileSync(file, 'utf8')
    for (const name of [...logCalls(source).map(call => call.name), ...ternaryEvents(source)]) {
      written.add(name)
    }
  }
  return written
}

// Every record the page names, in either shape it uses: a backticked word, and a
// record pasted as a JSON line. Both are the name a reader greps for, so both count.
function documentedRecords (doc) {
  return [...doc.matchAll(/panel[A-Z][A-Za-z]*/g)].map(match => match[0])
}

// The records a test waits on, read off that test rather than listed here. A list in
// this file would be a copy of a fact the test already holds, and it would go stale
// the day the test waits for something else.
function waitedRecords (file) {
  return [...file.matchAll(/event === '(panel[A-Z][A-Za-z]*)'/g)].map(match => match[1])
}

// The body of a function, found by its signature and closed by brace matching. The
// page's claim is about the order of statements in stop(), so this reads statements
// and not lines.
function bodyOf (source, signature) {
  const open = source.indexOf(signature)
  assert.notEqual(open, -1, STREAM + ' declares ' + signature)
  const from = source.indexOf('{', open)
  let depth = 0
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from + 1, i)
    }
  }
  return assert.fail(STREAM + ': ' + signature + ' closes')
}

// The timers a function clears, each with the position of the statement that clears
// it. Two shapes count: a clearInterval that names the timer, and a loop over a list
// of timers that clears each in turn — "both intervals are cleared here" is the claim,
// and the loop says it as plainly as the two ifs do.
function clearedTimers (body) {
  const cleared = new Map()
  for (const call of body.matchAll(/clearInterval\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (!cleared.has(call[1])) cleared.set(call[1], call.index)
  }
  for (const loop of body.matchAll(/for\s*\(const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\][^{]*\{[^}]*clearInterval\(\s*\1\s*\)[^}]*\}/g)) {
    for (const name of loop[2].split(',').map(part => part.trim()).filter(part => part !== '')) {
      if (!cleared.has(name)) cleared.set(name, loop.index)
    }
  }
  return cleared
}

// The keys of the payload a log() call writes, by brace matching inside that call and
// not by line shape: `ticks, beats` is shorthand and carries no colon, so a split on
// the names that do would report half of the record.
function recordFields (body, call) {
  const from = body.indexOf('{', call.from)
  assert.ok(from !== -1 && from < call.close, STREAM + ' writes ' + call.name + ' with a payload')
  let depth = 0
  let end = -1
  for (let i = from; i < call.close; i += 1) {
    if (body[i] === '{') depth += 1
    else if (body[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.notEqual(end, -1, STREAM + ': the payload of ' + call.name + ' closes')
  return body.slice(from + 1, end).split(',')
    .map(part => part.trim().split(':')[0].trim())
    .filter(part => part !== '')
}

// The fail-closed half of the code side. The written set is what reaches log(), so a
// quoted `panel…` string that does not — a CSS class, an element id, a sentence in a
// comment — would otherwise be read as evidence that a record exists.
test('#341 every panel literal under src/panel/ is a record a log() call writes', () => {
  const written = writtenRecords()
  const loose = new Set()
  for (const file of panelSources()) {
    for (const name of panelNames(fs.readFileSync(file, 'utf8'))) loose.add(name)
  }
  const unexplained = [...loose].filter(name => !written.has(name))
  assert.deepEqual(unexplained, [],
    'src/panel/ holds a panel literal that no log() call writes: ' + unexplained.join(', ') +
    '. If it is a record, pass it to log(). If it is not, delete the literal, so that nothing can read it as a record.')
})

test('#341 docs/panel.md names no record that src/panel/ does not write', () => {
  const written = writtenRecords()
  const named = documentedRecords(read(DOC))
  assert.ok(named.length > 0, 'docs/panel.md names the records a reader greps for')
  const missing = named.filter(name => !written.has(name))
  assert.deepEqual(missing, [],
    'docs/panel.md names a panel record no module under src/panel/ writes: ' + missing.join(', ') +
    '. A record name is what a route passes to log() as its event, so rename the page and the record together.')
})

test('#341 docs/panel.md keeps naming every record it teaches a reader to look for', () => {
  const named = new Set(documentedRecords(read(DOC)))
  assert.ok(NAMED.length > 0, 'this file holds the record names the page has promised')
  const dropped = NAMED.filter(name => !named.has(name))
  assert.deepEqual(dropped, [],
    'docs/panel.md no longer names a record it documents: ' + dropped.join(', ') +
    '. A reader who greps the panel log for it finds a name the page never explains. Name it again, or delete its line from this file and say why the page stopped teaching it.')
})

test('#341 docs/panel.md names every record ' + WAITING + ' waits on', () => {
  const waited = waitedRecords(read(WAITING))
  assert.ok(waited.length > 0,
    WAITING + ' compares the stream to at least one panel record, so the extractor read the file it guards')
  const named = new Set(documentedRecords(read(DOC)))
  const unexplained = waited.filter(name => !named.has(name))
  assert.deepEqual(unexplained, [],
    'docs/panel.md never names a record ' + WAITING + ' waits on: ' + unexplained.join(', ') +
    '. That test fails on that record when a stream does not end, so the page has to be where a reader learns the name.')
})

// The order the page states, and the paragraph #330's test depends on: "Both
// intervals are cleared before that record is written, so the record is the point
// after which the stream starts no new read." A test that waits on panelStreamEnd is
// only waiting for a stopped stream while that order holds. Moving the log above the
// clears breaks nothing else in this repository: test/panel/stream.test.js passes 14
// of 14 with the log moved, because stop() sets closed before either line.
test('#341 both intervals are cleared before panelStreamEnd is written, as the page says', () => {
  assert.ok(read(DOC).replace(/\s+/g, ' ').includes(ORDER_CLAIM),
    'docs/panel.md states the order: ' + ORDER_CLAIM + '. It is the sentence #330\'s test depends on')

  const source = read(STREAM)
  const body = bodyOf(source, 'function stop ()')
  const end = logCalls(body).find(call => call.name === 'panelStreamEnd')
  assert.ok(end, 'stop() writes panelStreamEnd: ' + STREAM)
  // The intervals the file creates, named as the variables that hold them, so the
  // page's word "Both" is what is counted and not the number of clearInterval calls:
  // clearing them from a loop over the two is still both intervals.
  const intervals = [...source.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*setInterval\(/g)].map(match => match[1])
  assert.equal(intervals.length, 2,
    'src/panel/routes/stream.js creates two intervals, the tick and the heartbeat: the page says "Both intervals"')
  const cleared = clearedTimers(body)
  const uncleared = intervals.filter(name => !cleared.has(name))
  assert.deepEqual(uncleared, [],
    'stop() does not clear an interval it created: ' + uncleared.join(', ') + '. Both intervals are cleared before the record is written, ' + STREAM)
  const late = [...cleared].filter(([, at]) => at > end.at).map(([name]) => name)
  assert.deepEqual(late, [],
    'src/panel/routes/stream.js writes panelStreamEnd before it clears ' + late.join(', ') + ', and docs/panel.md says the opposite. ' +
    'Clear both intervals first, or amend the page together with the test that waits on the record (#330).')
})

test('#341 panelStreamEnd carries the puppet, the ticks and the beats the page promises', () => {
  const body = bodyOf(read(STREAM), 'function stop ()')
  const call = logCalls(body).find(entry => entry.name === 'panelStreamEnd')
  assert.ok(call, 'stop() writes panelStreamEnd: ' + STREAM)
  const fields = recordFields(body, call)
  const promised = ['puppet', 'ticks', 'beats']
  const missing = promised.filter(name => !fields.includes(name))
  assert.deepEqual(missing, [],
    'docs/panel.md says panelStreamEnd is written with the puppet\'s name and the ticks and beats it wrote, and the record does not carry: ' + missing.join(', '))
})

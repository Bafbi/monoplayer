// #340, #371, #606: cells of docs/product-core.md, each pinned to the module that owns
// the fact the cell states.
//
// The page is a map of where a decision lives. A cell that names half a list sends a
// reader who needs the other half somewhere else, and nothing failed when it did.
//
//   #340  the module map's row for `src/service/cli.js` lists the helpers that module
//         exports. The row named four of five, and `waitFor` was the one left out:
//         #104 folded it into this module and touched no page. The row's authority is
//         the module, so the guard imports it rather than keeping a list here.
//         `waitFor` is the deadline a rung waits with, and the map did not name it.
//
//   #371  the picker bullet answers why a lane offers no servers. #356 gave that list
//         two sources, `config.control.allowedServers` and the seed behind it. The
//         bullet kept the one-variable reading, and its repair for `no_key` named half
//         of the edit. The switches are read here by calling `envOverlay`, the function
//         that owns the config surface, so a rename fails on the page. A comment that
//         names a switch is not a read: the header of src/service/start-live.js is
//         itself a list of the switches.
//
//   #606  the page is also a way in to the leg interfaces, and #592 moved the call-ins
//         out of src/service/monoplayer.js into one table per interface in
//         src/service/wire-leg-to-core.js. The map kept calling the composition root
//         the home of "leg wiring", so nothing routed a reader to the new module. The
//         interface section kept a second copy of both lists: eight of the front
//         table's sixteen rows, each with a payload shape the table also states, and
//         two of the seven the leg cannot serve a client without. #605 and #607 changed
//         that list twice in one night, which is how a copy rots. So the section names
//         the rows and states no shape, the map has a row for the module, and every
//         module in src/service/ has a row: the wiring module landed with none.
//
// What is compared is names. No sentence is parsed, because a guard that read English
// would be a guard that lies about what it checked. The interface section's prose is
// scanned for two name shapes, a `set…` call-in and a `core.…` method (#691), and
// nothing else in a sentence is read. Two things are left to review, and
// no test decides them: what "the copy Git commits answers" covers, and that a lane
// naming neither variable offers nothing. What the offer does with the two sources is
// driven through src/service/control.js by test/service/control.test.js, including
// "#356 the seed answers when the live key offers no list".
//
// Nothing here opens a socket or reaches a cluster: every case reads a file and calls
// one pure function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../../src/service/monoplayer.js'
import { envOverlay } from '../../src/service/start-live.js'
import { BACKEND_LEG_CALL_INS, FRONT_LEG_CALL_INS } from '../../src/service/wire-leg-to-core.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGE = read('docs/product-core.md')

// The rows whose cell lists the module's exports, so the cell is read rather than
// trusted. #340 pinned src/service/cli.js; #606 adds the wiring module, whose row names
// the two tables and the function a lane applies to a leg.
const EXPORT_ROWS = ['src/service/cli.js', 'src/service/wire-leg-to-core.js']

const MODULE = EXPORT_ROWS[0]

// The two config keys that hold the one list the picker offers. A key's name is the
// page's name for it, so the guard resolves the switch from the key rather than keeping
// a switch name of its own.
const SERVER_KEYS = ['control.allowedServers', 'control.allowedServersSeed']

// A bullet is one claim, so a true sentence on the next line cannot cover for a stale
// one above it. The split is the one test/tooling/doc-status.test.js makes, and the
// blank-line paragraphs that belong to a bullet stay with it.
const bullets = text => text.split(/(?=^- )/m).filter(block => block.startsWith('- '))

// The names one cell of the module map carries in backticks. Every name in the role
// column wears them, so the column is its own list and needs no prose parsing.
const cellNames = cell => [...cell.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map(match => match[1])

// One row of the module map, as its cells. The module column names the module, so a
// row found this way is the row about that module and no other.
function row (module) {
  const line = PAGE.split('\n').find(text => text.startsWith('| `' + module + '` |'))
  assert.ok(line, 'docs/product-core.md has a module-map row for ' + module + ', which is where a reader looks for what it holds')
  return line.split('|').map(cell => cell.trim())
}

// The document a switch is probed against: the compiled default, so every control key
// the service holds resolves to a leaf and a probed value lands on that leaf's path.
const DOC = loadConfig({})

// Which switch sets each control key, from the function rather than from its text. The
// probe's environment is a proxy that records what it is asked for, so a switch the
// overlay stops reading stops answering here. What a switch sets is then the control key
// whose value the probe moved.
//
// Two guards already read this overlay: test/tooling/usage-env-vars.test.js with the same
// proxy, and test/tooling/glossary-control-document.test.js mapping switch to key with a
// deep diff of the whole document. This one compares the control branch alone, because
// one list is the whole of the page's claim.
function controlSwitch () {
  const reads = new Set()
  const env = new Proxy({}, {
    get (target, key) {
      if (typeof key === 'string') reads.add(key)
      return undefined
    }
  })
  envOverlay(DOC, env, () => {})
  const found = new Map()
  for (const name of reads) {
    const probed = envOverlay(DOC, { [name]: '1' }, () => {}).control ?? {}
    for (const [key, value] of Object.entries(probed)) {
      if (value !== DOC.control[key]) found.set('control.' + key, name)
    }
  }
  return found
}

// Each key the page names, paired with the switch behind it, so no case joins two lists by
// position.
const SWITCH = controlSwitch()
const SERVER_LIST = SERVER_KEYS.map(key => ({ key, name: SWITCH.get(key) }))

// The picker's own bullet: the one claim that names the `no_key` reason, which is the
// answer that says nothing names a list at all. Its paragraphs are part of the bullet,
// so the offer's reasons and the list's sources are read together, as one claim.
function pickerBullet () {
  const found = bullets(PAGE).filter(block => block.includes('`no_key`'))
  assert.equal(found.length, 1,
    'docs/product-core.md has one claim that answers `no_key`, which is the claim that says what an empty list is')
  return found[0]
}

for (const module of EXPORT_ROWS) {
  test('the module-map row for ' + module + ' names every name that module exports', async () => {
    const names = Object.keys(await import('../../' + module))
    assert.ok(names.length > 0, module + ' exports its names, and that list is what the row carries')
    const listed = cellNames(row(module)[2])
    const missing = names.filter(name => !listed.includes(name))
    const unknown = listed.filter(name => !names.includes(name))
    assert.deepEqual(missing, [],
      module + ' exports ' + missing.join(', ') + ' and the module-map row does not name ' +
      (missing.length === 1 ? 'it' : 'them') + '. The row is the map a reader uses to find a name, and one ' +
      'missing from it sends that reader to another file. Add ' + (missing.length === 1 ? 'it' : 'them') +
      ' beside its neighbours.')
    assert.deepEqual(unknown, [],
      'the module-map row names ' + unknown.join(', ') + ', which ' + module + ' does not export. A name ' +
      'the module does not hold is one a reader looks for and cannot find there.')
  })
}

test('the picker bullet is the whole list of what an operator can name', () => {
  for (const { key, name } of SERVER_LIST) {
    assert.ok(typeof name === 'string' && /^MONOPLAYER_[A-Z0-9_]+$/.test(name),
      'envOverlay in src/service/start-live.js sets config.' + key + ' from one switch, and this case read ' +
      'none. A key no switch sets leaves the claim below with nothing to compare.')
  }
  const bullet = pickerBullet()
  for (const { name } of SERVER_LIST) {
    assert.ok(bullet.includes(name),
      'the picker bullet never names ' + name + '. Since #356 the list has two sources, and only a lane that ' +
      'names neither offers nothing, so the repair the bullet gives for `no_key` has to name both switches. ' +
      'The order they are asked in is `allowedServerSources` in src/service/control.js.')
  }
})

test('the picker bullet does not say a lane with no allowed-server key offers nothing', () => {
  // The sentence #356 removed. `src/core/picker.js` `pickerOfferedRows` reads one answer
  // from `control.allowedServers()`, and that answer is the seed's whenever the live key
  // offers no list, including a live key that was never named.
  const bullet = pickerBullet()
  assert.doesNotMatch(bullet, /with no such key offers nothing/i,
    'the picker bullet still says a lane with no such key offers nothing. #356 rebuilt the precedence in ' +
    '`allowedServerSources` in src/service/control.js: the live file answers, else the copy Git commits, else ' +
    'nothing. Only a lane that names neither switch offers nothing.')
})

// --- the leg interfaces (#606) ---

// Every fenced block of the page, each with the paragraph above it. The paragraph is
// what tells one block from another: the page points at a table in prose and lists the
// rows under it.
function fencedBlocks () {
  return [...PAGE.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(match => ({
    body: match[1],
    // The blank line before a fence leaves an empty tail, so split and drop the empties
    // rather than trusting the last element to be the paragraph.
    above: PAGE.slice(0, match.index).split(/\n\s*\n/).filter(Boolean).pop()
  }))
}

// The block the page puts under its pointer to a table. The marker is the table's name,
// so a block that follows a sentence about something else is not this list.
function blockUnder (marker) {
  const found = fencedBlocks().filter(block => block.above.includes('`' + marker + '`'))
  assert.equal(found.length, 1,
    'docs/product-core.md has one fenced block under the paragraph that names `' + marker +
    '`, which is where a reader finds its rows. Found ' + found.length + '.')
  return found[0].body.split('\n').map(line => line.trim()).filter(Boolean)
}

// The interface block itself, found by the name of the variable it assigns and cut at
// that assignment's own closing brace. It holds the rest of the interface: the members
// no table names, because the core calls them on the leg directly. Both legs share one
// fenced block, so the cut is what keeps one leg's members out of the other's case.
function interfaceBlock (leg) {
  const found = fencedBlocks().filter(block => block.body.includes(leg + ' = {'))
  assert.equal(found.length, 1,
    'docs/product-core.md has one block that assigns `' + leg + '`, which is where a reader looks for the ' +
    'rest of that interface. Found ' + found.length + '.')
  const body = found[0].body
  const start = body.indexOf(leg + ' = {')
  const end = body.indexOf('\n}', start)
  assert.ok(end > start,
    'the `' + leg + '` assignment in docs/product-core.md ends on its own line, so this case can read the ' +
    'members of one leg and no other')
  return body.slice(start, end)
}

// The two tables the page points at, the leg each one wires, and the block that assigns
// that leg. The rows are the module's, never a list kept here: a call-in the table adds
// or drops has to reach the page, and a list in this file would be the second copy the
// guard exists to stop.
const INTERFACES = [
  { table: 'FRONT_LEG_CALL_INS', leg: 'frontLeg', rows: FRONT_LEG_CALL_INS },
  { table: 'BACKEND_LEG_CALL_INS', leg: 'backendLeg', rows: BACKEND_LEG_CALL_INS }
]

// The section the two blocks sit in, found by its heading. It names the module, and
// that pointer is the claim the blocks cannot make: a list under a section that points
// nowhere is still a second home.
function interfaceSection () {
  const found = PAGE.match(/^## Interface for the live legs[\s\S]*?(?=^## )/m)
  assert.ok(found, 'docs/product-core.md has the section that holds the leg interfaces, which is where a ' +
    'reader writing a leg looks. Its heading is "## Interface for the live legs".')
  return found[0]
}

test('the interface section points at the module that declares the call-in tables', () => {
  const section = interfaceSection()
  assert.ok(section.includes('`src/service/wire-leg-to-core.js`'),
    'the interface section does not name src/service/wire-leg-to-core.js. That module declares the call-ins ' +
    'each leg carries, and a section that names neither the module nor the tables is a section whose rows ' +
    'live nowhere (#606, #592).')
  for (const { table } of INTERFACES) {
    assert.ok(section.includes('`' + table + '`'),
      'the interface section does not name `' + table + '`, the table that declares its rows. A reader ' +
      'cannot check a list against a table the page never names.')
  }
})

// A call-in named outside the two lists is still a call-in the page says a leg carries.
// The scan is bounded to the section and to the setter convention, because a `call` row
// (chat, preAuthStats) is named with an ordinary word that a sentence may use for its
// own purpose.
test('the interface section names no call-in the two tables do not declare', () => {
  const declared = [...FRONT_LEG_CALL_INS, ...BACKEND_LEG_CALL_INS].map(row => row.name)
  const named = [...new Set([...interfaceSection().matchAll(/\bset[A-Z][A-Za-z0-9]*\b/g)]
    .map(match => match[0]))]
  const unknown = named.filter(name => !declared.includes(name))
  assert.deepEqual(unknown, [],
    'the interface section names ' + unknown.join(', ') + ', and neither table in ' +
    'src/service/wire-leg-to-core.js declares ' + (unknown.length === 1 ? 'it' : 'them') + '. A call-in ' +
    'the module does not carry is one a reader looks for in the table and cannot find (#606). Name the row ' +
    'that exists, or add the row first.')
})

// A core method named in the section's prose is a claim about the same tables: "the
// front leg calls `core.processLoginStart`" says a registration reaches that method.
// The setter scan above cannot see one, because a method carries no `set` prefix, and
// that is the hole #691 came through: the sentence named `core.processVerifySession`,
// no row reached it, and nothing here said so. The row's `reaches` is the fact, so the
// name is held to it rather than to a list kept in this file.
//
// What this case does not read: a method written without the `core.` prefix. The section
// names a core method bare too (`backendFrame`, `chat`, one paragraph down), and a bare
// name is the same shape as a leg's own member (`claimOn`, `write`, `end`, in the fenced
// blocks below), so no rule here can tell the two apart. The prefix is what says "this is
// the core's", and a sentence that claims a call without it is the review's to catch.
test('the interface section names no core method the two tables do not reach', () => {
  const reached = [...FRONT_LEG_CALL_INS, ...BACKEND_LEG_CALL_INS]
    .map(row => row.reaches)
    .filter(name => name !== undefined)
  // A method name carries a capital. That is what keeps the section's own pointer to
  // `src/service/wire-leg-to-core.js` from reading as a call to `core.js`.
  const named = [...new Set([...interfaceSection().matchAll(/\bcore\.([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)/g)]
    .map(match => match[1]))]
  assert.ok(named.length > 0,
    'the interface section names no core method at all, so this case checked nothing. The section states ' +
    'which call-ins the front leg makes in order, and that sentence is what a reader writes a leg from.')
  const unknown = named.filter(name => !reached.includes(name))
  assert.deepEqual(unknown, [],
    'the interface section names ' + unknown.join(', ') + ' as a method of the core, and no row of ' +
    'FRONT_LEG_CALL_INS or BACKEND_LEG_CALL_INS reaches ' + (unknown.length === 1 ? 'it' : 'them') + '. A ' +
    'core method no call-in reaches is one no leg calls, so the sentence sends a reader to a lane that does ' +
    'not exist, which is what #691 found. Add the row that reaches it, with a leg that carries it, or take ' +
    'the name off the page.')
})

for (const { table, leg, rows } of INTERFACES) {
  const names = rows.map(row => row.name)

  test('the page names every ' + table + ' row, and no call-in the table does not declare', () => {
    const listed = blockUnder(table)
    const missing = names.filter(name => !listed.includes(name))
    const unknown = listed.filter(name => !names.includes(name))
    assert.deepEqual(missing, [],
      table + ' in src/service/wire-leg-to-core.js declares ' + missing.join(', ') + ', and the page does not ' +
      'name ' + (missing.length === 1 ? 'it' : 'them') + '. A reader who counts the call-ins off this page ' +
      'wires a leg that is missing one, and nothing else on the page says so.')
    assert.deepEqual(unknown, [],
      'the page names ' + unknown.join(', ') + ' as a ' + table + ' call-in, and the table does not declare ' +
      (unknown.length === 1 ? 'it' : 'them') + '. A call-in the module does not carry is one a reader looks ' +
      'for and cannot find there.')
  })

  test('the page states no payload shape for a ' + table + ' row', () => {
    const shaped = blockUnder(table).filter(line => !/^[A-Za-z][A-Za-z0-9_]*$/.test(line))
    assert.deepEqual(shaped, [],
      'the page states a shape for ' + shaped.join(' | ') + '. The payload shape of each ' + table + ' row, and ' +
      'the method of the core it reaches, are declared in src/service/wire-leg-to-core.js. A second copy of a ' +
      'shape is what #606 found, and that list changed twice in one night (#605, #607). Name the call-in ' +
      'and stop there.')
  })

  test('the ' + leg + ' block does not restate a ' + table + ' call-in', () => {
    const restated = interfaceBlock(leg).split('\n')
      .map(line => /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(line))
      .filter(Boolean)
      .map(match => match[1])
      .filter(name => names.includes(name))
    assert.deepEqual(restated, [],
      'the ' + leg + ' block still writes ' + restated.join(', ') + ', which ' + table + ' declares. That block ' +
      'is for the rest of the interface, the members no table names; a call-in written there as well is the ' +
      'second copy this page stopped keeping (#606).')
  })
}

// The module map's section, read to its next heading so a `src/...js` row in another
// table of the page cannot answer for a module the map never names. It is the bound
// test/ladder/loopback-contract.test.js makes of its own claim, for the same reason.
function moduleMap () {
  const found = PAGE.match(/^## Module map[\s\S]*?(?=^## )/m)
  assert.ok(found, 'docs/product-core.md has a module map, which is where a reader looks for what a module holds')
  return found[0]
}

// Every module a map row names, in the order the rows appear.
function moduleRows () {
  return moduleMap().split('\n')
    .map(line => /^\| `(src\/[^`]*\.js)` \|/.exec(line))
    .filter(Boolean)
    .map(match => match[1])
}

test('the module map has a row for every module in src/service', () => {
  // src/service/ alone, and not the map's other three directories: the composition root
  // holds one module per job, and a reader arrives at this page looking for a step, so a
  // step with no row is a dead end. The other directories hold the modules a reader
  // reaches from a row, and the map names a selection of them on purpose.
  const modules = fs.readdirSync(path.join(ROOT, 'src/service'))
    .filter(name => name.endsWith('.js'))
    .map(name => 'src/service/' + name)
    .sort()
  const rows = moduleRows()
  const unrowed = modules.filter(module => !rows.includes(module))
  assert.deepEqual(unrowed, [],
    unrowed.join(', ') + ' has no module-map row in docs/product-core.md. ' +
    'src/service/wire-leg-to-core.js landed with none (#592), so a reader looking for where a leg is wired ' +
    'landed on the composition root, which stopped doing it. Add the row.')
  const gone = rows.filter(row => !fs.existsSync(path.join(ROOT, row)))
  assert.deepEqual(gone, [],
    'the module map names ' + gone.join(', ') + ', which ' +
    (gone.length === 1 ? 'is not a file' : 'are not files') + '. A row is a promise that a reader can open ' +
    'the module it names.')
})

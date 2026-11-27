// #340, #371, #606, #668, #690, #726, #763, #825, #893: the cells of docs/product-core.md and its leg interface,
// each pinned to the module that owns the fact it states.
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
//   #690  the interface section is two lists: the call-ins, held to their tables since
//         #606, and the members no table names, which nothing read. The blocks had drifted
//         apart from the composition root. The front block had lost `channels`,
//         `startReconfiguration` and `finishConfigurationFrame`, the backend block `target`
//         and `setTarget`, and neither named the `close()` a teardown awaits. The calls in
//         src/service/monoplayer.js are the list now, and both blocks are read against it.
//
//   #763  #690's fence left the composition root out of the change, so the header of
//         src/service/monoplayer.js kept its own copy of both blocks, and the shorter one.
//         Nothing saw it: the cases above cut comments before they read a call, because a
//         sentence that names a call is not a call. The header points now, at the section
//         and at this file, and the two cases at the end of this section ask it for that
//         pointer and for the absence of the block.
//
//   #825  #763 guarded the file's header and stopped there, so the block above the two
//         wireLegToCore calls in start() was read by no case. #758 is its one drift: it is the
//         block a lane learns the report from, so a stale sentence there sends that reader after
//         a capability the report dropped. #592's case and #718's hold two of its four claims
//         already; the pointer to the module that owns a row and the event were held by nothing.
//         The section below reads them, and the block now names the tables its own calls apply.
//
//   #893  the record of the report's retired fields named three, and #818's `called` was not one of
//         them: #818 removed it and #894 landed the removal with this file outside the run's fence. A record
//         short by one is worse than none, because the next reader takes the surviving list as the
//         whole of it and writes the name back. The list names it now, and the set beside it asks the
//         next retirement to be written down.
//
//   #668  the section was a third home of the leg interfaces, restated by hand, and nothing
//         read it. #606 and #690 made it the page's view of what a row cannot name; this entry
//         records that it is no longer a copy of anything, and the cases below are the guard
//         #668 asked for, reading the page against the composition root and the built legs,
//         in both directions.
//
//   #726  a row is every member the core calls on a leg. The delivery it sends through, the
//         dial, and the calls it makes when the leg carries one moved out of the blocks and
//         into the tables, so the blocks keep only the two readings and `close()`, which no
//         core code calls. What the page keeps is what a row cannot state: which channel a
//         write reaches, that end() returns while close() resolves, and what the claim board
//         is. A member the core calls and the page names in a block is a row now, and the
//         case that refuses a restated call-in holds the page to that.
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
// Nothing here opens a socket or reaches a cluster: every case reads a file, calls one
// pure function, or builds one of the two offline legs, which opens neither until it is
// started (#690).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../../src/service/monoplayer.js'
import { envOverlay } from '../../src/service/start-live.js'
import { BACKEND_LEG_CALL_INS, FRONT_LEG_CALL_INS, wireLegToCore } from '../../src/service/wire-leg-to-core.js'
import { functionBody } from '../support/source-scan.js'

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

// The two tables the page points at, the leg each one wires, the block that assigns that
// leg, the module that builds it, and the build. The rows are the module's, never a list
// kept here: a call-in the table adds or drops has to reach the page, and a list in this
// file would be the second copy the guard exists to stop.
//
// Each build is the offline constructor's, because the live ones want custody on disk. They
// open no socket until `listen()` on the front leg and `connect()` on the backend one, so
// a build reads the interface a caller holds and nothing else (#690, #712).
// The one name a leg's constructor demands and this file never uses: the offline front leg
// refuses to build with no whitelist, and a member list does not depend on whose uuid it is.
const OFFLINE_UUID = '00000000-0000-0000-0000-000000000000'

const INTERFACES = [
  {
    table: 'FRONT_LEG_CALL_INS',
    leg: 'frontLeg',
    rows: FRONT_LEG_CALL_INS,
    source: 'src/legs/live-front.js',
    build: async () => {
      const { createOfflineFrontLeg } = await import('../../src/legs/live-front.js')
      return createOfflineFrontLeg({
        offlineWhitelist: [OFFLINE_UUID],
        getSnapshotConfig: () => ({}),
        wireCheck: () => {}
      })
    }
  },
  {
    table: 'BACKEND_LEG_CALL_INS',
    leg: 'backendLeg',
    rows: BACKEND_LEG_CALL_INS,
    source: 'src/legs/live-backend.js',
    build: async () => {
      const { createOfflineBackendLeg } = await import('../../src/legs/live-backend.js')
      return createOfflineBackendLeg({ host: '127.0.0.1', port: 25565 })
    }
  }
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
// The scan is bounded to the section, to its prose, and to the setter convention, because
// a `call` row (chat, preAuthStats) is named with an ordinary word that a sentence may
// use for its own purpose. The fenced blocks are cut before the scan: they hold the
// members no table names, so a `set`-shaped name there is not a registration. A block is
// not prose (#690, #726).
test('the interface section names no call-in the two tables do not declare', () => {
  const declared = [...FRONT_LEG_CALL_INS, ...BACKEND_LEG_CALL_INS].map(row => row.name)
  const prose = interfaceSection().replace(/```[\s\S]*?```/g, '')
  const named = [...new Set([...prose.matchAll(/\bset[A-Z][A-Za-z0-9]*\b/g)]
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
// name is the same shape as a leg's own member, which the fenced blocks below hold, so no
// rule here can tell the two apart. The prefix is what says "this is the core's", and a
// sentence that claims a call without it is the review's to catch.
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

// The members no table names, held to the two things that own them (#690, #712).
//
// #606 held the two call-in tables: the section names the rows and states no shape. The
// fenced block beside them is the page's list of the rest of each interface, the members
// the core calls on a leg directly and no row declares, and until #712 nothing compared
// it to anything. #712 pinned the backend block to the leg it describes and left the
// front block unread, which is how #690 found both blocks short.
//
// Two authorities, and neither is a list kept in this file:
//
//   the composition root  src/service/monoplayer.js dereferences the leg at every member
//                         the core calls on it, so those calls are the list the block
//                         has to name after the table's rows are taken out. A member the
//                         core starts calling reaches the page or fails here, which is
//                         the drift #690 found: `channels` landed with #636 and the page
//                         never learned it.
//   the leg               src/legs/live-front.js and src/legs/live-backend.js build the
//                         object, so a name the block keeps for a member the leg dropped
//                         fails here.
//
// The second is one direction only. A leg answers members a reader writing a leg does not
// need (the counters, the driver, the port), so the composition root's calls set the
// list and the leg only answers for the names on it.
//
// A block that names `end()` and stops leaves out the one member that is a wait, and no
// code in the composition root calls it: every teardown does, so the scan above cannot
// see it and each block is asked for `close()` by name (#690, #712).

// The members one block names, one per line. The page writes one member a line with its
// comment to the right, so the first identifier on a line is the member and a
// continuation line, which opens with `//`, is not. A member written on another
// member's line after a comma is missed, and the case then fails on it as a member the
// block does not name: the page's list has to be readable name by name.
function blockMembers (leg) {
  return interfaceBlock(leg).split('\n')
    .filter(line => !new RegExp('^' + leg + '\\s*=\\s*\\{').test(line))
    .map(line => /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(line))
    .filter(Boolean)
    .map(match => match[1])
}

// The composition root with its line comments cut, because a sentence that names a call is
// not a call: the file writes `frontLeg.end` in prose, and a guard that counted prose
// would ask the page for a member on the strength of a comment. Nothing else is read.
const COMPOSITION_ROOT_SOURCE = read('src/service/monoplayer.js')
const COMPOSITION_ROOT = COMPOSITION_ROOT_SOURCE
  .split('\n')
  .map(line => line.replace(/\/\/.*$/, ''))
  .join('\n')

// Every member the core reaches on one leg, as the composition root spells it.
function legCalls (leg) {
  const pattern = new RegExp('\\b' + leg + '\\??\\.([A-Za-z][A-Za-z0-9_]*)', 'g')
  return [...new Set([...COMPOSITION_ROOT.matchAll(pattern)].map(match => match[1]))].sort()
}

for (const { table, leg, rows, source, build } of INTERFACES) {
  const rowNames = rows.map(row => row.name)

  test('the ' + leg + ' block names every member the core calls on the leg (#690)', () => {
    const calls = legCalls(leg)
    assert.ok(calls.length > 0,
      'this case read no call on ' + leg + ' in src/service/monoplayer.js, so it checked nothing. The ' +
      'composition root is where the core reaches a leg, and those calls are what the block must name.')
    const called = calls.filter(name => !rowNames.includes(name))
    const named = blockMembers(leg)
    const missing = called.filter(name => !named.includes(name))
    assert.deepEqual(missing, [],
      'src/service/monoplayer.js calls ' + missing.join(', ') + ' on ' + leg + ', and the ' + leg + ' block in ' +
      'docs/product-core.md does not name ' + (missing.length === 1 ? 'it' : 'them') + '. That block is the ' +
      'page\'s list of the rest of the interface, the members no row of ' + table + ' declares, and a reader ' +
      'who writes a leg from it writes one the core calls into and cannot reach. Add ' +
      (missing.length === 1 ? 'it' : 'them') + ' to the block, or make ' +
      (missing.length === 1 ? 'it' : 'them') + ' a row of ' + table + ', which is where a member ' +
      'the core calls belongs since #726 (#690).')

    assert.ok(named.includes('close'),
      'the ' + leg + ' block in docs/product-core.md does not name close(). It is the member that waits: ' +
      'end() returns, close() resolves once the socket the leg ended has reported its own end, and the ' +
      'teardowns in src/ladder/rig.js and src/service/start-live.js await it. No code in the composition ' +
      'root calls it, so only this assertion can hold the block to it (#690, #712).')
  })

  test('every member the ' + leg + ' block names, the leg answers (#712)', async () => {
    const members = Object.keys(await build())
    const unknown = blockMembers(leg).filter(name => !members.includes(name))
    assert.deepEqual(unknown, [],
      'the ' + leg + ' block names ' + unknown.join(', ') + ', and the leg ' +
      (unknown.length === 1 ? 'answers no such member' : 'answers no such members') + '. ' + source + ' builds ' +
      'that object, and this case reads it: a name the page keeps for a member the leg dropped is one a ' +
      'reader writes a leg from and cannot (#712).')
  })
}

// --- the composition root's own header (#763) ---

// Every case above reads src/service/monoplayer.js with its comments cut, on purpose: a
// sentence that names a call is not a call. That cut is also why the header kept a second
// copy of both interface blocks through #690, and the shorter copy: no case here could see
// it. So this section reads the comments, and asks them for two things.
//
// No sentence is parsed. One case asks the header for two names, the section that lists the
// members and this file; the other asks it for the shape a pasted interface has, a comment
// line that carries an indent, and for the assignment that opens either block.
//
// That second case catches the shape this copy took, and not every copy a writer could
// invent: a member list pasted flush to the marker passes it, and prose cannot be told from
// a list without reading the prose. The limit is stated rather than papered over, because a
// rule that guessed at English would be the guard that lies.
//
// Why the copy goes rather than gets a case of its own: #763's criterion 1 offered either
// one list or a test comparing two by name. A comparison would have kept two homes for one
// list, and the repo has paid for that twice (#606, #690). So the header points and the case
// below asks it for no block, which is the whole fix: there is nothing left to compare.

// The file's leading comment block: every line down to the first line of code. The blocks
// #763 removed sat in it. The file writes prose flush to the marker, so a comment line that
// carries an indent is the shape a member list has, and no sentence here has one.
function compositionHeader () {
  const head = []
  for (const line of COMPOSITION_ROOT_SOURCE.split('\n')) {
    if (!line.trimStart().startsWith('//')) break
    head.push(line)
  }
  return head
}

// The section's own title, not the page's path: the header names the page twice, and the
// path alone is satisfied by the sentence that says what is injected. A reader who follows
// this pointer has to land on the list.
const SECTION_TITLE = 'Interface for the live legs'
const GUARD = 'test/tooling/product-core-map.test.js'

test('the composition root header sends a reader who writes a leg to the page and the guard (#763)', () => {
  const header = compositionHeader().join('\n')
  for (const where of [SECTION_TITLE, GUARD]) {
    assert.ok(header.includes(where),
      'the header of src/service/monoplayer.js does not name ' + where + '. The two adapter interfaces are not ' +
      'a fact this file owns: the members no call-in table names are the fenced blocks under "Interface for ' +
      'the live legs" in docs/product-core.md, and ' + GUARD + ' holds those blocks to the calls the core ' +
      'makes here (#690). The header is the first thing a reader of this file sees, so it is where the pointer ' +
      'belongs. A header that carries the list instead is the second copy #763 removed.')
  }
})

test('the composition root header keeps no copy of a leg interface (#763)', () => {
  const header = compositionHeader()
  assert.ok(header.length > 0,
    'this case read no comment block at the top of src/service/monoplayer.js, so it checked nothing. The ' +
    'header is the file\'s leading run of comment lines, and it is where #763 removed the second copy of ' +
    'both interfaces.')
  const indented = header.filter(line => /^\/\/\s{2,}\S/.test(line))
  assert.deepEqual(indented, [],
    'the header of src/service/monoplayer.js indents ' + indented.length + ' comment lines, the first: ' +
    indented[0] + '. Every line of that block is prose flush to the marker. An indented line is the shape a ' +
    'pasted interface takes, and this is the copy #690 left behind and #763 removed, three members behind the ' +
    'page by the time it went. Write the sentence flush, and add a member to the page instead.')
  const assigned = header.filter(line => /\b(?:frontLeg|backendLeg)\s*=\s*\{/.test(line))
  assert.deepEqual(assigned, [],
    'the header of src/service/monoplayer.js assigns ' + assigned.join(', ') + '. That assignment opens the ' +
    'page\'s two blocks, under "Interface for the live legs" in docs/product-core.md, and a second one here ' +
    'is the copy #763 removed. Name the page and ' + GUARD + ' instead.')
})

// --- the comment above the wiring (#825) ---

// The block above the two wireLegToCore calls in start() is the comment a lane reaches first in
// src/service/monoplayer.js: it is where a lane learns what the report gives it, and where to go
// when the report gives it nothing. #758 is its one drift, and it has the shape this file keeps
// paying for, a capability moving and the sentence staying. Nothing failed: the cases above that
// read a call cut this file's comments on purpose, and #763 guarded the file's header rather than
// this block, which is how the block stayed unread until #825.
//
// Two of the block's claims are held elsewhere, so this section does not restate them:
//
//   the tables are applied here, and in no other place
//                         test/service/wire-leg-to-core.test.js counts the two calls below and
//                         refuses a hand registration in the core's body (#592, #605)
//   the report carries names and no handler
//                         the same file holds `'handlers' in wiring` false (#718) and keeps
//                         the report's fields to the ones a production reader reads (#757)
//
// The two that no case held are names, so both are read here: the module that owns a row and
// what a lane does instead, and the two tables the calls below apply with the event that
// replaced the cut a lane used to wrap. The block names its tables because it has to be
// checkable: "both tables" sent a reader two lines down to learn which two.
//
// The event rule is this case's own, and it is the one place here that a marker word is read: a
// backticked name the block calls an event has to be one the core emits. The shape is
// test/tooling/surface-pointers.test.js's "title" in page, where a marker word decides what a
// quoted name is. Neither shape it reads is this one, so this case says what it reads instead of
// borrowing that file's authority. Its limit is real: a sentence rewritten to keep the event and
// drop the word "event" fails here, and the repair is to write it in the shape this case reads.

// The block, found by the line it explains rather than by its words: `legWiring = {` is the
// assignment the block explains, and the comment lines directly above it are the block. #887
// moved `started = true` below that assignment, so the flag this case used to anchor on is now
// the wrong side of it. A block anchored on a line that can move is a sentence to repair, and
// this one is anchored on the assignment the block is about. The body is
// test/support/source-scan.js's, so a block moved out of start() is not this block, and the lines
// are stripped of their marker and joined with a space, so a sentence still reads as one
// sentence after a wrap, which is how the block states its claims.
function wiringComment () {
  const lines = functionBody(COMPOSITION_ROOT_SOURCE, 'start').split('\n')
  const at = lines.findIndex(line => line.trimStart().startsWith('legWiring = {'))
  assert.notEqual(at, -1,
    'src/service/monoplayer.js assigns `legWiring = {` in start(), and the comment above it is the ' +
    'block this case reads. No line says it, so this case cannot find the block it reads (#825).')
  const block = []
  for (let index = at - 1; index >= 0; index--) {
    const line = lines[index]
    if (line.trim() === '' || !line.trimStart().startsWith('//')) break
    block.unshift(line)
  }
  assert.ok(block.length > 0,
    'src/service/monoplayer.js keeps no comment above `legWiring = {`. That block is where a lane ' +
    'learns what the report gives it, and the two calls below are not self-explanatory: they apply a ' +
    'table the lane never sees (#825).')
  return block.map(line => line.replace(/^\s*\/\/ ?/, '')).join(' ')
}

// The tables the two calls below the block apply, read off the call sites rather than kept in a
// list here. Applying a table is what makes it applied, so a table renamed at its call is a name
// the block has to follow.
function appliedTables () {
  return [...COMPOSITION_ROOT.matchAll(/wireLegToCore\(\{[^}]*\btable:\s*([A-Z][A-Z0-9_]*)/g)]
    .map(match => match[1])
}

// The names the block calls an event, in the code's spelling: a backticked name and the word
// event is `emit('attach'`. A table-shaped name is the other half of the same idea, and no
// list here holds either.
const eventNames = block => [...block.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`\s+event\b/g)].map(match => match[1])
const tableNames = block => [...block.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map(match => match[0])

test('the comment above the wiring names the module, the tables its two calls apply, and the event the core emits (#825)', () => {
  const block = wiringComment()

  // The pointer: the file that owns what a row is, and the replacement for a different
  // registration. A module that moves or is renamed leaves this sentence pointing nowhere, which
  // is the shape test/tooling/surface-pointers.test.js sweeps for in the documents.
  assert.ok(block.includes('src/service/wire-leg-to-core.js'),
    'the comment above the wiring does not name src/service/wire-leg-to-core.js. That module is the ' +
    'one home of the call-ins a leg interface carries, so it is also the answer to what a lane does ' +
    'when it needs a different registration. A block that sends that lane nowhere leaves it copying a ' +
    'call-in into a lane, which is the second home #592 removed (#825).')

  // The tables: the two the calls below apply, and no third.
  const applied = appliedTables()
  assert.equal(applied.length, 2,
    'src/service/monoplayer.js applies one table per leg interface, and this case read ' +
    applied.length + '. It compares the block to those two names, so a count it cannot read is a block ' +
    'with nothing to be held to (#592, #825).')
  const named = tableNames(block)
  const missing = applied.filter(name => !named.includes(name))
  assert.deepEqual(missing, [],
    'the comment above the wiring ' +
    (missing.length === 1 ? 'names no ' + missing[0] : 'names neither ' + missing.join(' nor ')) +
    ', and the calls below it apply ' +
    (missing.length === 1 ? 'it' : 'them') + '. The block said "both tables" and a reader had to look ' +
    'down to learn which two. Naming them is what makes the sentence checkable, and a table renamed at ' +
    'its call is a name this block has to follow (#825).')
  const unknown = named.filter(name => !applied.includes(name))
  assert.deepEqual(unknown, [],
    'the comment above the wiring names ' + unknown.join(', ') + ', and neither call below applies ' +
    (unknown.length === 1 ? 'it' : 'them') + '. A table a reader looks for and no call site applies is ' +
    'the sentence describing a wiring this file does not have (#825).')

  // The event: the cut a lane used to wrap, as the core publishes it.
  const events = eventNames(block)
  assert.ok(events.length > 0,
    'the comment above the wiring names no event. The attach cut a lane used to wrap is the core\'s own ' +
    'now (#683), and a block that stops saying so leaves a lane wrapping a call-in the report gives it ' +
    'no handler for (#825).')
  const unpublished = events.filter(name => !COMPOSITION_ROOT.includes("emit('" + name + "'"))
  assert.deepEqual(unpublished, [],
    'the comment above the wiring calls ' + unpublished.join(', ') + ' an event, and ' +
    'src/service/monoplayer.js never emits ' + (unpublished.length === 1 ? 'it' : 'them') + '. A lane that ' +
    'waits on the cut for an event the core does not publish waits forever, and says nothing while it ' +
    'does (#683, #825). Name the event the core emits.')
})

// The names the report used to carry. #718 removed `handlers`, #757 removed `wired` and
// `requiredMissing`, and #818 removed `called`, so the report carries none of them, and there is
// nothing in the tree to derive the list from: it is the record of those four retirements. What each
// one named, and why it went, is the header of src/service/wire-leg-to-core.js: this list is the
// names and not the reasons, because the module that owns the report is where a field's replacement
// is. A whole word match reads it, and the block is the only text this case looks at, so a sentence
// there that used `wired` in the ordinary sense would fail and needs rewording. That costs one word,
// and the miss it buys is the drift #758 was.
//
// #893: `called` was missing from that record. A retirement becomes visible when the field's row
// leaves `REPORT_READERS` in test/service/wire-leg-to-core.test.js (#757). Nothing there asks this
// list to grow, so #818's removal landed and left this file's line out. `EVER_FIELDS` below is that
// ask: a name it holds that the report no longer carries is a retirement this list has to name.
//
// The block's own word is the singular, "carries names and no handler", and this list cannot see
// it: `handlers` is a field name and `handler` is English. The assertion below the list
// holds that sentence instead, by asking every field of the report to be a list of names, so a
// field holding a function fails here whatever it is called.
const RETIRED_FIELDS = ['handlers', 'wired', 'requiredMissing', 'called']

// Every field the report has carried, in the order the retirements went, the live one last. It is the
// record this file allows where no module holds one: the report's own keys cannot say what a past key
// was, because a deletion takes its own record with it (test/ladder/loopback-contract.test.js:185).
//
// The live name is a copy of the report's key on purpose, and the case named #893 fails when the copy
// slips. The four retired names are typed twice for a sharper reason: a name `EVER_FIELDS` keeps and
// `RETIRED_FIELDS` drops is the only thing that notices a retirement line going, so the obvious
// de-duplication, `[...RETIRED_FIELDS, 'missing']`, is a silent weakening of the record.
//
// `EVER_FIELDS` only grows. A rename that drops one field and adds another therefore keeps a sum of
// `RETIRED_FIELDS` and the report's fields the same size, and leaves this set naming the field that
// went, which is why the case named #893 reads a set and not a count.
const EVER_FIELDS = ['handlers', 'wired', 'requiredMissing', 'called', 'missing']

test('the comment above the wiring spells no field the report no longer carries (#825)', () => {
  const block = wiringComment()
  // The report as its own function builds it, so the field set is the code's and not this file's.
  const report = wireLegToCore({ core: {}, leg: {}, table: FRONT_LEG_CALL_INS })
  const fields = Object.keys(report)
  assert.ok(fields.length > 0,
    'this case read no field of the report wireLegToCore returns, so it checked nothing (#825).')

  const notNames = Object.entries(report)
    .filter(([, value]) => !Array.isArray(value) || value.some(entry => typeof entry !== 'string'))
    .map(([field]) => field)
  assert.deepEqual(notNames, [],
    'the report carries ' + notNames.join(', ') + ', and it is not a list of names. The comment above ' +
    'the wiring says the report carries names and no handler, and a lane that reads a field it cannot ' +
    'use as a name has the promise #758 removed back, under whatever name it came back as ' +
    '(#718, #825).')

  for (const field of RETIRED_FIELDS) {
    assert.ok(!fields.includes(field),
      'the report carries ' + field + ' again. This case names it as retired, and the comment above the ' +
      'wiring is where a lane reads what the report gives it: decide whether the field stays and write ' +
      'the sentence that says so, or drop the row from RETIRED_FIELDS (#825).')
    assert.doesNotMatch(block, new RegExp('\\b' + field + '\\b'),
      'the comment above the wiring spells ' + field + ', and the report wireLegToCore returns does not ' +
      'carry it: ' + fields.join(', ') + '. This is the drift #758 fixed, a sentence that keeps promising ' +
      'a capability the report dropped, and a lane that reads it writes a caller no module has ' +
      '(#718, #757, #825).')
  }
})

// #893: the record of the report's fields, read in both directions. The case above holds the comment
// above the wiring to this record; this one holds the record to the report. #818 removed `called` and
// the record kept three names, so the block could have promised a fourth field unchallenged. A count
// would have caught that day and not the next: a rename that drops one field and adds another keeps
// the sum. It is its own case because a failure here is the record's, and the ticket a reader needs is
// this one, not the comment's (#825).
test('the record of the report fields is whole, in both directions (#893)', () => {
  const report = wireLegToCore({ core: {}, leg: {}, table: FRONT_LEG_CALL_INS })
  const fields = Object.keys(report)
  assert.ok(fields.length > 0,
    'this case read no field of the report wireLegToCore returns, so it checked nothing (#893).')

  const unknown = RETIRED_FIELDS.filter(name => !EVER_FIELDS.includes(name))
  assert.deepEqual(unknown, [],
    'RETIRED_FIELDS names ' + unknown.join(', ') + ', and EVER_FIELDS names no such ' +
    (unknown.length === 1 ? 'field' : 'fields') + '. EVER_FIELDS is every name the report has ' +
    'carried, the retired ones included (test/ladder/loopback-contract.test.js:305 makes the same ' +
    'claim one record over). A retirement line it does not hold names a field this report never had, ' +
    'and the next reader takes the name for a real one. Add ' +
    (unknown.length === 1 ? 'the name' : 'the names') + ' to EVER_FIELDS, or drop ' +
    (unknown.length === 1 ? 'the line' : 'the lines') + ' from RETIRED_FIELDS (#893).')

  const unread = fields.filter(name => !EVER_FIELDS.includes(name))
  assert.deepEqual(unread, [],
    'the report carries ' + unread.join(', ') + ', and EVER_FIELDS in this file names no such ' +
    (unread.length === 1 ? 'field' : 'fields') + '. Add ' + (unread.length === 1 ? 'it' : 'them') +
    ' to EVER_FIELDS, beside the names it retires, so a reader meets the field before it goes the way ' +
    'of the four there (#893).')

  const unrecorded = EVER_FIELDS.filter(name => !fields.includes(name) && !RETIRED_FIELDS.includes(name))
  assert.deepEqual(unrecorded, [],
    'EVER_FIELDS names ' + unrecorded.join(', ') + ', the report carries ' +
    (unrecorded.length === 1 ? 'no such field' : 'no such fields') + ', and RETIRED_FIELDS does not ' +
    'retire ' + (unrecorded.length === 1 ? 'it' : 'them') + '. One of two edits is missing. If the ' +
    'report dropped the field, add it to RETIRED_FIELDS with the ticket that removed it: the next ' +
    'reader takes the surviving list as the whole of it and writes the name back into the comment ' +
    'above the wiring. If a retirement line was deleted, put it back, because the name is the only ' +
    'thing that says the field must not return (#818, #893).')
})

// What this section cannot see: a sentence whose names all survive a rewrite, a claim written in
// words no name marks, and the record's own history. The first is a fact lost rather than a fact lied
// about, and #718's and #757's cases hold the fact itself. The second is a reviewer's, for the reason
// the file's header gives. The third is one record over, test/ladder/loopback-contract.test.js's
// limit: `EVER_FIELDS` and `RETIRED_FIELDS` lowered in one commit pass this case, and nothing but the
// diff says whether that change found the retirement or hid it. No checksum closes it either, because
// the same edit lowers the checksum.

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

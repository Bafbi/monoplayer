// The core-to-leg wiring (#592, #605). The core needs a set of call-ins on each
// leg it is handed: some it cannot work without, the rest it uses when the leg
// carries them. The lanes used to register that first group by hand, and the rest
// sat behind typeof guards in the core's own start().
//
// The seam is the composition function, not a socket: each case hands it a
// recording core and a recording leg and reads which setter got which payload.
// Nothing here connects, listens or reads a custody directory.
//
// One case is source text, because "the ritual has one home" is not a claim a
// call can make. It copies the idiom test/ladder/rig.test.js uses for the rig
// factory (#223): read the file, count the literal, assert the count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import {
  BACKEND_LEG_CALL_INS,
  FRONT_LEG_CALL_INS,
  wireLegToCore
} from '../../src/service/wire-leg-to-core.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { createOfflineBackendLeg } from '../../src/legs/live-backend.js'
import { createOfflineFrontLeg } from '../../src/legs/live-front.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const count = (source, literal) => source.split(literal).length - 1
// A comment is not a read: a module that names a literal while explaining why it
// spells no such thing wires nothing. The rig guard reads a file the same way
// (test/ladder/rig.test.js:41).
const code = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// A core that records what its call-ins were asked, so a payload shape is read
// here rather than inferred from the module's body.
function recordingCore (table) {
  const calls = []
  const core = { name: 'recording-core' }
  // One stand-in per row, built from the row itself, so a call-in added to the
  // table cannot arrive with no stand-in to answer it.
  for (const { reaches } of table) {
    if (reaches === undefined) continue
    core[reaches] = (...args) => {
      calls.push({ name: reaches, args })
      return { name: reaches, args }
    }
  }
  return { core, calls }
}

// A leg that records which setter was handed which function, and can be built
// without some of them: a leg missing a call-in is the case that matters.
function recordingLeg (table, { omit = [] } = {}) {
  const handlers = new Map()
  const leg = {}
  for (const { name } of table) {
    if (omit.includes(name)) continue
    leg[name] = fn => handlers.set(name, fn)
  }
  return { leg, handlers }
}

test('#592 the core hands every front call-in to a leg that carries them', () => {
  const { core, calls } = recordingCore(FRONT_LEG_CALL_INS)
  const { leg, handlers } = recordingLeg(FRONT_LEG_CALL_INS)

  const wiring = wireLegToCore({ core, leg, table: FRONT_LEG_CALL_INS })

  assert.deepEqual(wiring.missing, [],
    'a leg that carries every setter is wired whole')
  // #757: the report no longer counts what it installed, so the leg's own record is
  // read directly: every register row reached it, and no call row did. #818 removed the
  // list of carried calls, so "every call row is carried" is the empty `missing` above:
  // a call row this leg lacked would be its one entry.
  const registrationRows = FRONT_LEG_CALL_INS.filter(row => row.kind === 'register').map(row => row.name)
  assert.deepEqual([...handlers.keys()].sort(), registrationRows.sort(),
    'every register row reached the leg, and no call row did')

  // The payload shapes a caller must not have to know. `attachPlayer` takes
  // includeConfig, and a lane's attach never re-sends the configuration phase:
  // the client already has it, which is what includeConfig:false says.
  handlers.get('setCoreAttach')({ name: 'Bafbi', uuid: PLAYER })
  assert.deepEqual(calls.at(-1), {
    name: 'attachPlayer',
    args: [{ name: 'Bafbi', uuid: PLAYER, includeConfig: false }]
  }, 'setCoreAttach lands as attachPlayer with includeConfig:false')

  handlers.get('setCoreAttachConfiguring')({ name: 'Bafbi', uuid: PLAYER })
  assert.deepEqual(calls.at(-1), {
    name: 'attachConfiguringPlayer',
    args: [{ name: 'Bafbi', uuid: PLAYER }]
  }, 'setCoreAttachConfiguring lands as attachConfiguringPlayer')

  handlers.get('setConfiguringHandler')({ name: 'Bafbi', uuid: PLAYER })
  assert.deepEqual(calls.at(-1), { name: 'configuringReady', args: [{ name: 'Bafbi' }] },
    'setConfiguringHandler lands as configuringReady, which takes the name alone')

  handlers.get('setClientSettingsHandler')({ locale: 'en_gb' })
  assert.deepEqual(calls.at(-1), { name: 'noteClientSettings', args: [{ locale: 'en_gb' }] },
    'setClientSettingsHandler lands as noteClientSettings, unreshaped')

  // #259: the picker row reads the body this lane serves and whether it is up.
  // The leg has a fallback for an absent call-in, which is why an absent one is
  // silent today and is named by the case below.
  handlers.get('setBodyServed')()
  assert.deepEqual(calls.at(-1), { name: 'bodyServed', args: [] },
    'setBodyServed lands as bodyServed, which takes no payload')

  // #605: the three start() registered by hand until the front table owned them.
  handlers.get('setLoginStartHandler')({ name: 'Bafbi', uuid: PLAYER })
  assert.deepEqual(calls.at(-1), { name: 'processLoginStart', args: [{ name: 'Bafbi', uuid: PLAYER }] },
    'setLoginStartHandler lands as processLoginStart, which decides and lets the leg answer')

  handlers.get('setServerboundHandler')({ state: 'play', name: 'chat_message' })
  assert.deepEqual(calls.at(-1), {
    name: 'frontServerbound',
    args: [{ state: 'play', name: 'chat_message' }]
  }, 'setServerboundHandler lands as frontServerbound, with the frame the client sent')

  handlers.get('setDetachHandler')({ reason: 'player_quit' })
  assert.deepEqual(calls.at(-1), { name: 'detachPlayer', args: [{ reason: 'player_quit' }] },
    'setDetachHandler lands as detachPlayer')
  handlers.get('setDetachHandler')()
  assert.deepEqual(calls.at(-1), { name: 'detachPlayer', args: [{ reason: 'player_quit' }] },
    'and a leg that names no reason is the player_quit the leg always meant')
})

test('#605 the core hands every backend call-in to a leg that carries them', () => {
  const { core, calls } = recordingCore(BACKEND_LEG_CALL_INS)
  const { leg, handlers } = recordingLeg(BACKEND_LEG_CALL_INS)

  const wiring = wireLegToCore({ core, leg, table: BACKEND_LEG_CALL_INS })

  assert.deepEqual(wiring.missing, [],
    'a backend leg that carries every row is wired whole')
  // #757, #818: the same reading of the leg's own record the front case makes, so neither
  // table is the one the partition happens to be checked on, and the empty `missing` above
  // is every call row of the backend table carried: the delivery, the dial and the two
  // optional calls.
  const registrationRows = BACKEND_LEG_CALL_INS.filter(row => row.kind === 'register').map(row => row.name)
  assert.deepEqual([...handlers.keys()].sort(), registrationRows.sort(),
    'every register row reached the backend leg, and no call row did')

  handlers.get('setFrameHandler')({ state: 'play', name: 'login', buffer: Buffer.from('x'), data: { entityId: 42 } })
  assert.deepEqual(calls.at(-1), {
    name: 'backendFrame',
    args: [{ state: 'play', name: 'login', buffer: Buffer.from('x'), data: { entityId: 42 } }]
  }, 'setFrameHandler lands as backendFrame, with the frame the backend sent')

  handlers.get('setEndHandler')({ reason: 'backend_end' })
  assert.deepEqual(calls.at(-1), { name: 'backendEnd', args: [{ reason: 'backend_end' }] },
    'setEndHandler lands as backendEnd')
  handlers.get('setEndHandler')()
  assert.deepEqual(calls.at(-1), { name: 'backendEnd', args: [{ reason: 'backend_end' }] },
    'and a leg that names no reason keeps the one the handler gave it')

  handlers.get('setErrorHandler')({ error: new Error('socket') })
  assert.equal(calls.at(-1).name, 'backendError',
    'setErrorHandler lands as backendError, which records the leg fault')
  assert.equal(calls.at(-1).args[0].error.message, 'socket',
    'and the error itself arrives, not a string a reader cannot act on')
})

test('#592 a leg missing a call-in is named, in the order the table declares the rows', () => {
  const { core } = recordingCore(FRONT_LEG_CALL_INS)

  const partial = recordingLeg(FRONT_LEG_CALL_INS, { omit: ['setBodyServed'] })
  const named = wireLegToCore({ core, leg: partial.leg, table: FRONT_LEG_CALL_INS })
  assert.ok(named.missing.includes('setBodyServed'),
    'a leg without setBodyServed is named: its own fallback reads null and nothing else says so')

  const absent = recordingLeg(FRONT_LEG_CALL_INS, { omit: ['setCoreAttach', 'setSpectateBody'] })
  const answered = wireLegToCore({ core, leg: absent.leg, table: FRONT_LEG_CALL_INS })
  assert.deepEqual(answered.missing, ['setCoreAttach', 'setSpectateBody'],
    'both holes are in the one list, in the order the table declares the rows: setCoreAttach comes before setSpectateBody there, and a report that sorted the names would read the other way')
})

// #605: a backend leg's hole is the report's business too. The two calls are the
// rows a leg answers rather than registers, and a leg without them was a typeof
// guard in the core's body until the table took them.
test('#605 a backend leg missing a call is named like any other hole', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)

  const OMITTED = ['chat', 'answerHeldGate', 'setErrorHandler']
  const absent = recordingLeg(BACKEND_LEG_CALL_INS, { omit: OMITTED })
  const wiring = wireLegToCore({ core, leg: absent.leg, table: BACKEND_LEG_CALL_INS })
  assert.deepEqual(wiring.missing, ['setErrorHandler', 'answerHeldGate', 'chat'],
    'the report names the missing registration and both missing calls in table order: #818 made a hole the report\'s whole vocabulary, so a call row this leg omits is a hole like the registration it omits')
})

// #605: the freeze is a claim, so a case reads it: a table a reader can rewrite is a
// payload shape with a second author.
test('#605 each table and each row of it is frozen', () => {
  for (const [label, table] of [['FRONT_LEG_CALL_INS', FRONT_LEG_CALL_INS], ['BACKEND_LEG_CALL_INS', BACKEND_LEG_CALL_INS]]) {
    assert.ok(Object.isFrozen(table), label + ' is frozen, so a row cannot be added at run time')
    for (const row of table) {
      assert.ok(Object.isFrozen(row), label + ' freezes ' + row.name + ', the row its handler lives on')
    }
  }
})

// #605: a backend leg without its end handler is named, like any other hole. Before the
// table, a leg without this one threw at start() instead. What the hole costs is the row
// comment's line in src/service/wire-leg-to-core.js — a leg that keeps the end to itself
// leaves the core attached to a session that is gone — and #757 is why this case reads the
// hole rather than a severity the report no longer carries.
test('#605 a backend leg without its end handler is a named hole', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)
  const absent = recordingLeg(BACKEND_LEG_CALL_INS, { omit: ['setEndHandler'] })
  const wiring = wireLegToCore({ core, leg: absent.leg, table: BACKEND_LEG_CALL_INS })
  assert.deepEqual(wiring.missing, ['setEndHandler'],
    'the end of a session is a hole a client cannot be served without, and the report names it either way')
})

// The table is an argument, so a leg cannot be measured against the other
// interface's rows by omission: the mistake that shape makes is silent otherwise.
test('#605 a leg is measured against the table it was handed, and against no other', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)
  assert.throws(() => wireLegToCore({ core, leg: {} }), /needs the table/,
    'an omitted table is refused, not defaulted to the front interface')

  const front = recordingLeg(FRONT_LEG_CALL_INS).leg
  const measuredAsBackend = wireLegToCore({ core, leg: front, table: BACKEND_LEG_CALL_INS })
  // #726: the two interfaces share the delivery (`write`, `writeRaw`, `end`), so a front
  // leg answers those rows and lacks the rest. The expectation is the backend table minus
  // the rows both tables declare, which is a fact about the two interfaces and not about
  // this leg: a leg that answered a backend row of its own would fail here.
  const shared = BACKEND_LEG_CALL_INS
    .filter(row => FRONT_LEG_CALL_INS.some(declared => declared.name === row.name))
    .map(row => row.name)
  assert.deepEqual(measuredAsBackend.missing,
    BACKEND_LEG_CALL_INS.map(row => row.name).filter(name => !shared.includes(name)),
    'a front leg measured against the backend table carries the delivery both interfaces declare and nothing else of it')
  assert.ok(measuredAsBackend.missing.includes('setFrameHandler') && measuredAsBackend.missing.includes('connect'),
    'so the registrations and the dial it does not carry are the holes a wiring mistake reads')
})

// The register rows of both tables, as the case below walks them (#885). The set is the
// tables' own, so a row added there is counted without an edit here and no list can leave one
// out. A `call` row is a member the core reaches itself, which the #818 case reads.
const REGISTER_ROWS = [...FRONT_LEG_CALL_INS, ...BACKEND_LEG_CALL_INS]
  .filter(row => row.kind === 'register')

// Every module under one directory, as absolute paths. It recurses, so a lane in a
// subdirectory is read too.
function laneFiles (directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...laneFiles(file))
    else if (entry.name.endsWith('.js')) found.push(file)
  }
  return found.sort()
}

// The lanes, as files and their text (#885). The set is the directory's, for the reason #607's
// case gives: a module added under src/ladder is a caller too, and a hand-kept list would let it
// through. The live lane's starter is the one caller outside that directory.
function laneSources () {
  const modules = laneFiles(path.join(ROOT, 'src/ladder')).map(file => ({
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8')
  }))
  return [...modules, { file: 'src/service/start-live.js', source: read('src/service/start-live.js') }]
}

// Every hand registration of a register row, as the violations a reader acts on (#885). A file
// the excuse table does not name for the row is held to 0, so the walk covers both tables whole
// and the table is only the excuses. Comments are stripped: a lane explaining why it spells no
// such thing wires nothing (test/ladder/rig.test.js:41).
//
// The count is of a literal: `.setX(` reads a plain call and an optional one (`.setX(`,
// `?.setX(`). A member reached through a computed name, or destructured off the leg, is outside
// a count of source text, which is the trade the file's header names. An assignment over the
// setter (`leg.setX = fn`) is outside it too, and it also walks past the refusal #824 gave every
// call-in, so that spelling is #918 rather than a sentence here.
function handRegistrations (rows, lanes, excused) {
  const wrong = []
  for (const { name } of rows) {
    for (const { file, source } of lanes) {
      const named = count(code(source), '.' + name + '(')
      const allowed = excused[name]?.[file] ?? 0
      if (named === allowed) continue
      wrong.push(file + ' names ' + name + ' ' + (named === 1 ? 'once' : named + ' times') + ', and ' +
        (allowed === 0
          ? 'no row of the excuse table allows it: route the registration through the core\'s start(), or add the row with this file and its count'
          : 'the row allows ' + allowed))
    }
  }
  return wrong
}

// The excuses, read against the rows and the files the case walks (#885): an excuse for a row
// the tables no longer declare, or for a lane the walk no longer reads, is a count nothing
// holds. That is the hand-kept list one step on.
function staleExcuses (rows, lanes, excused) {
  const names = rows.map(row => row.name)
  const files = lanes.map(lane => lane.file)
  const claimed = [...new Set(Object.values(excused).flatMap(byFile => Object.keys(byFile)))]
  return {
    rows: Object.keys(excused).filter(name => !names.includes(name)),
    files: claimed.filter(file => !files.includes(file))
  }
}

test('#592 the ritual has one home: no lane registers the core\'s call-ins by hand', () => {
  const MODULE = read('src/service/wire-leg-to-core.js')

  // The module is the one home, so each row of either table is declared there once per
  // table that names it. The quotes are what tell setCoreAttach from
  // setCoreAttachConfiguring.
  //
  // #726: the two interfaces share the delivery, so `write`, `writeRaw` and `end` are a
  // row of each and are declared twice. The count is derived from the tables rather
  // than relaxed, so a third copy in the module still fails, and a table that names a
  // row it does not declare fails here too.
  const tables = [FRONT_LEG_CALL_INS, BACKEND_LEG_CALL_INS]
  for (const table of tables) {
    const names = table.map(row => row.name)
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [],
      'a table declares each row name once, so a member is one row and not two')
    for (const { name } of table) {
      const declaring = tables.filter(candidate => candidate.some(row => row.name === name)).length
      assert.equal(count(MODULE, "'" + name + "'"), declaring,
        'src/service/wire-leg-to-core.js declares ' + name + ' once per table that names it: ' + declaring)
    }
  }

  // The lanes are the directory's and the rows are the tables', so this count covers both
  // tables whole (#885). The rows are the `register` ones: a `call` row is a member the core
  // reaches itself, and the #818 case below holds that side.
  //
  // #885: the row list and the lane list were both hand-kept. The rows no entry named were
  // setReconfiguredHandler, setConnectClaimedBody, setSpectateBody, setSpectatorAttach,
  // setDisconnectBody, setBodyServed, setSpectatorLeft and setSpectatorPose, so a lane that
  // named one of them was outside a case whose job is coverage, and a row added tomorrow would
  // have joined them in silence. The lane list held four names, fewer than the walks beside this
  // case already read.
  //
  // src/ladder/loopback.js's raw funnel registers setSpectateBody by hand, and the case passed
  // because no row named it. That registration is legitimate — a leg no core is handed — and the
  // excuse table below is where it is said.
  //
  // The instrument is still a count, and the file's header says why: the claim is negative ("no
  // lane registers the row"), so a lane that names the literal is the whole failure. The table
  // below is only the excuses. The two cases above pin the payload of eleven of these rows at
  // this seam; the other seven are rows this case counts, and no case here reads what they
  // reshape.
  const lanes = laneSources()
  assert.ok(['src/ladder/rig.js', 'src/ladder/online.js', 'src/ladder/loopback.js']
    .every(file => lanes.some(lane => lane.file === file)),
    'the walk found the modules it reads, so a moved directory fails here rather than passing')

  // The one rung that stands outside, and the factory's header is why: the two pre-auth rigs,
  // and #666's raw funnel, build a front leg and no core, so a setter is all they have to
  // drive. Their calls are theirs, and none is the ritual. The two body legs of O59 keep their
  // own caches, so a lane fills one of their frame handlers.
  //
  // #683: setCoreAttach earns no entry. The rig factory used to offer an `attach` hook for a
  // wrapper around that call-in, and #683 deleted the lanes that took it, because the cut is
  // the core's event now. A wrapper is the same literal, so the walk below reads it.
  const BY_HAND = {
    // The two pre-auth stubs of O48 and O49.
    setCoreAttachConfiguring: { 'src/ladder/loopback.js': 2 },
    // #666's raw funnel: the login review a picker dialog needs, on a leg no core is handed.
    setLoginStartHandler: { 'src/ladder/loopback.js': 1 },
    // #666's raw funnel again: the one verb it serves, and the body that verb names.
    setSpectateBody: { 'src/ladder/loopback.js': 1 },
    // The frame handler of O59's two body legs, each reading its own cache.
    setFrameHandler: { 'src/ladder/loopback.js': 1 }
  }

  const stale = staleExcuses(REGISTER_ROWS, lanes, BY_HAND)
  assert.deepEqual(stale.rows, [],
    'the excuse table names ' + stale.rows.join(', ') + ', and the tables declare no such `register` row. ' +
    'An excuse for a row that is gone is a lane nothing holds (#885)')
  assert.deepEqual(stale.files, [],
    'the excuse table excuses ' + stale.files.join(', ') + ', and the walk reads no such file. A lane that ' +
    'moved leaves a count no assertion reads (#885)')

  const byHand = handRegistrations(REGISTER_ROWS, lanes, BY_HAND)
  assert.deepEqual(byHand, [],
    'no lane registers a row of either table by hand: the core applies both tables in its start(), and a ' +
    'lane\'s own registration is the second one the leg refuses (#592, #824). The rows here are the tables\' ' +
    '`register` rows, so a row added to a table is counted without an edit to this case (#885). These lanes ' +
    'take a registration back:\n  ' + byHand.join('\n  '))

  // The walk bites, and the row set is not a list. The row fed here is one no table declares,
  // because the tree's own lanes are the claim above and a case that only watched them pass
  // would pass on a walk that counted nothing.
  const ROW_NO_TABLE_DECLARES = [{ kind: 'register', name: 'setRowNoTableDeclares' }]
  const SAMPLE = [{ file: 'src/ladder/sample.js', source: 'leg.setRowNoTableDeclares(fn)' }]
  const bit = handRegistrations(ROW_NO_TABLE_DECLARES, SAMPLE, {})
  assert.equal(bit.length, 1,
    'a row a lane names and the excuse table does not allow is one violation, which is the case #885 was about')
  assert.match(bit[0], /src\/ladder\/sample\.js names setRowNoTableDeclares/,
    'and the violation names the file and the row, so a reader knows where the registration is')
  assert.deepEqual(handRegistrations(ROW_NO_TABLE_DECLARES, [{ file: 'src/ladder/sample.js', source: '// leg.setRowNoTableDeclares(fn)' }], {}), [],
    'and a comment that names the literal wires nothing: the count reads code, as #607\'s walk does')
  assert.deepEqual(staleExcuses(ROW_NO_TABLE_DECLARES, SAMPLE, { setGoneRow: { 'src/ladder/gone.js': 1 } }),
    { rows: ['setGoneRow'], files: ['src/ladder/gone.js'] },
    'an excuse for a row the tables lost, or for a lane the walk lost, is reported rather than left to pass')

  // The core registers nothing by hand either: the two calls are the two tables, and a lane's
  // copy would have to reappear beside them.
  const CORE = code(read('src/service/monoplayer.js'))
  assert.equal(count(CORE, 'wireLegToCore({'), 2,
    'src/service/monoplayer.js applies one table per leg interface, in start()')
  for (const { name } of REGISTER_ROWS) {
    assert.equal(count(CORE, '.' + name + '('), 0,
      'src/service/monoplayer.js registers no call-in by hand: ' + name + ' is a row of a table')
  }

  // And the lanes that record a cut subscribe to it instead. A file a row does not name states
  // 0, so a new lane that subscribes fails here until its row says how many replays it records;
  // a lane that neither registers nor subscribes records nothing, and its parity rung fails on
  // the empty cut.
  const ATTACH_SUBSCRIBERS = {
    // The main rig's O27 and O28, and the entity rig's O51.
    'src/ladder/loopback.js': 2,
    // N13's cut. This is the lane #683 deleted the attach wrapper from: the 1 counts a
    // subscription to the `attach` event, and BY_HAND above is why it is not a registration.
    'src/ladder/online.js': 1
  }
  for (const { file, source } of lanes) {
    assert.equal(count(code(source), ".on('attach'"), ATTACH_SUBSCRIBERS[file] ?? 0,
      file + ' subscribes to the attach event ' + (ATTACH_SUBSCRIBERS[file] ?? 0) + ' times: a lane that records a cut reads the core\'s publish, and one that records none names no event')
  }
})

// #818: a `call` row is a member the core calls on the leg itself, so the row has a call
// site in the core or it is a name a leg is measured against and nothing reaches. That is
// the shape #721 found one module over: a declared step whose last caller had been deleted,
// still read as part of the interface by everyone who opened the page.
//
// The register rows have the negative guard above (the core registers no row by hand).
// This is the positive half, and together they read a row from both sides: a row the core
// stops calling fails here, and a registration written in the core by hand fails there.
//
// The binding is the interface's own. A front row reached through `backendLeg` is a row a
// leg of the other interface answers, and a shape test is not a call site, which is the
// hole #818 opened with: `typeof backendLeg.chat === 'function'` asks the leg instead of the
// report, and this case would not count it.
const LEG_BINDING = new Map([
  [FRONT_LEG_CALL_INS, 'frontLeg'],
  [BACKEND_LEG_CALL_INS, 'backendLeg']
])

function callSites (source, binding, name) {
  return count(source, binding + '.' + name + '(') + count(source, binding + '?.' + name + '(')
}

test('#818 every `call` row is a member the core calls on the leg its table declares', () => {
  const CORE = code(read('src/service/monoplayer.js'))

  const rows = [...LEG_BINDING].flatMap(([table, binding]) =>
    table.filter(row => row.kind === 'call').map(row => [binding, row.name]))
  assert.ok(rows.length > 0,
    'the tables declare call rows, so this case has a row to walk. An empty walk would pass on an empty table')

  for (const [binding, name] of rows) {
    assert.ok(callSites(CORE, binding, name) > 0,
      'src/service/monoplayer.js never calls ' + binding + '.' + name + ', the call row ' + name +
      ' declares. A row the core stops calling is a member every leg is still measured against and nothing reaches (#721, #818)')
  }

  // The other half of #818's hole. A backend call row is answered by the report
  // (`backendCarries`), so a `typeof` test on one is the second home #605 removed: the
  // core would ask the leg's shape where the table already answered. The front's three
  // optional calls are `typeof`-tested on purpose — the header says why, and `laneState`
  // asks the leg at each read because the report is null until start() — so this half
  // names the backend's rows only.
  for (const { name, kind } of BACKEND_LEG_CALL_INS) {
    if (kind !== 'call') continue
    assert.equal(count(CORE, 'typeof backendLeg.' + name) + count(CORE, 'typeof backendLeg?.' + name), 0,
      'src/service/monoplayer.js must not test backendLeg.' + name + ' with typeof: `backendCarries` answers whether the leg carried the row, and a shape test is a second home for the same fact (#605, #818)')
  }

  // The walk bites, and it reads a call rather than a shape test. Both halves are fed a
  // string here, because the tree's call sites are the claim above and a case that only
  // watched them pass would pass on a walk that counted nothing.
  assert.equal(callSites('backendLeg.chat(text)', 'backendLeg', 'chat'), 1,
    'a call on the interface\'s own binding is the site a row is held to')
  assert.equal(callSites("typeof backendLeg.chat === 'function'", 'backendLeg', 'chat'), 0,
    'a shape test is not a call site: #605 makes the core ask the report what the backend leg carries, and a typeof guard is the second home it replaced')
  assert.equal(callSites('backendLeg.chat(text)', 'frontLeg', 'chat'), 0,
    'and the other interface\'s binding answers for its own rows: a front row the core reaches through backendLeg is a row the wrong leg answers')
})

// #718: the report carries what a reader acts on, and nothing else. It used to
// carry every handler it installed, so a lane could wrap one call-in after start();
// #683 deleted the lanes that did, because the attach cut is the core's event now.
// A handler in the report is a fact about a caller no module writes, so the field
// went with the cases that built that caller.
test('#718 the report carries no handler, because no lane wraps a call-in any more', () => {
  const { core } = recordingCore(FRONT_LEG_CALL_INS)
  const { leg } = recordingLeg(FRONT_LEG_CALL_INS)
  const wiring = wireLegToCore({ core, leg, table: FRONT_LEG_CALL_INS })
  assert.equal('handlers' in wiring, false,
    'the report names rows: #607 carried a handler for a lane that wrapped a call-in after start(), and no lane does')
})

// #757: a field of the report is a fact a production reader acts on, and the reader is
// named here, on the module that reads it. The module header says why `wired` and
// `requiredMissing` went; this case is what keeps the remaining set honest. A field added
// without a row here fails, and a row whose literal the module stops reading fails too, so
// "no production reader" is the build's error rather than a finding a later ticket files.
const REPORT_READERS = [
  // The start record names every declared call-in a leg did not carry, both interfaces on
  // one line, which is what a lane operator reads. Both literals are named: a line that
  // dropped one interface would pass a guard that named one, and the report would carry
  // that interface's list for nothing.
  //
  // #818: `called` is gone. It named the call rows a leg carries, which is the table's
  // call rows minus `missing`, so it carried no fact of its own: the reason #757 removed
  // `wired`, which was the table minus `called` and `missing`. Only the backend's half
  // had a production reader (`backendCarries`), and it reads `missing` now.
  {
    field: 'missing',
    file: 'src/service/monoplayer.js',
    reads: ['legWiring.front.missing', 'legWiring.backend.missing']
  }
]

test('#757 every field of the report has a production reader, named at the line', () => {
  const { core } = recordingCore(FRONT_LEG_CALL_INS)
  const { leg } = recordingLeg(FRONT_LEG_CALL_INS)
  const wiring = wireLegToCore({ core, leg, table: FRONT_LEG_CALL_INS })

  assert.deepEqual(Object.keys(wiring).sort(), REPORT_READERS.map(row => row.field).sort(),
    'the report carries the fields this case names a production reader for, and no field a test is the only reader of')

  for (const { field, file, reads } of REPORT_READERS) {
    for (const literal of reads) {
      // Comments are stripped, so a module that names a field while explaining why it
      // reads no such thing is not a reader (test/ladder/rig.test.js:41 has the idiom).
      assert.ok(code(read(file)).includes(literal),
        file + ' reads ' + literal + ' for ' + field + ': a field whose reader stops reading it is a field that exists for its own test')
    }
  }
})

// #817: the report is a value the core reads at start(), not a surface the core
// publishes. Every reader of `get legWiring()` was a test: the core reads the closure
// variable, and a lane operator reads the start record. A getter whose only caller is a
// test describes a caller the tests build for themselves, which is the reason #718
// removed `handlers` and #757 removed `wired` one level down.
//
// The seam a test uses is the artifact a lane reads: the start record's `legMissing`.
// The cases around this one read it, and test/legs/adapters.test.js holds every real leg
// to the tables through it.
test('#817 the core publishes no wiring report, because its only readers were tests', () => {
  const lines = []
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
    backendLeg: createFakeBackendLeg(),
    frontLeg: createFakeFrontLeg(),
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    logStream: { write: line => lines.push(JSON.parse(line)) }
  })
  core.start()

  assert.equal('legWiring' in core, false,
    'the core handle carries no wiring report: the getter exists so a test can read a value the core already holds, and a value with no production reader is the field #718 and #757 removed')

  const start = lines.find(entry => entry.event === 'start')
  assert.deepEqual(start.legMissing, { front: DOUBLE_HOLES.front.missing, backend: [] },
    'and the report a reader reads is the start record, which names every row this leg did not carry')
})

// #607: the acceptance criterion, as a count. A caller that writes the literal has
// a second copy of the table's row, and a change to the table leaves it on the old
// value in silence. Comments are stripped: a module explaining why it spells no
// such thing wires nothing (test/ladder/rig.test.js:41).
//
// The set is the directory, not a list of three files. A module added under
// src/ladder is a caller too, and a hand-kept list would let it through, which is
// the "fails loudly" rule in AGENTS.md rather than a claim in prose. The live lane
// is the one caller outside it, and it registers no wrapper. The walk is `laneSources`
// above, so "which files are lanes" is one answer in this file and the ritual case's
// count and this one cannot disagree about a subdirectory (#885).
test('#607 no module that builds a core over legs rebuilds the handler\'s argument', () => {
  const lanes = laneSources()
  assert.ok(lanes.some(lane => lane.file === 'src/ladder/rig.js') && lanes.some(lane => lane.file === 'src/ladder/online.js'),
    'the walk found the modules it reads, so an empty or moved directory fails here rather than passing')

  for (const { file, source } of lanes) {
    // The defect's other spelling: a direct call with no includeConfig at all, which
    // rebinds the core's `includeConfig = true` and brings the configuration replay
    // back. Counting only the literal would let that through.
    assert.equal(count(code(source), '.attachPlayer('), 0,
      file + ' attaches through the handler the core installed: a direct attachPlayer is a payload of its own')
    assert.equal(count(code(source), 'includeConfig: false'), 0,
      file + ' leaves the attach\'s argument to the table: a caller that writes includeConfig is holding a second copy of the row')
  }
  // The table still names the key. Counted without its value, so lifting the value
  // into a named constant keeps this case true while the property it guards stands;
  // the payload itself is pinned by the recorded attach at the top of this file.
  assert.equal(count(code(read('src/service/wire-leg-to-core.js')), 'includeConfig'), 1,
    'and src/service/wire-leg-to-core.js is the one place the key is named for this shape')
})

// #605: both doubles are hand-built, so a row added to a table and not to the
// double is a hole a lane would meet in production and no test would name. The
// holes are declared here, one list per interface: adding a row fails this case
// until the double carries it, which is what makes the fake the guard.
const DOUBLE_HOLES = {
  front: {
    missing: [
      'setCoreAttach',
      'setCoreAttachConfiguring',
      'setConnectClaimedBody',
      'setSpectateBody',
      'setSpectatorAttach',
      'setDisconnectBody',
      'setBodyServed',
      'setSpectatorLeft',
      'preAuthStats'
    ],
  },
  // The backend double carries its whole interface: a rig that arrives at a
  // handler it does not have would record nothing and say nothing.
  backend: { missing: [] }
}

test('#605 each double carries every row of its interface, or a hole declared here', () => {
  const cases = [
    ['front', createFakeFrontLeg()],
    ['backend', createFakeBackendLeg()]
  ]
  for (const [leg, fake] of cases) {
    const lines = []
    const core = createMonoplayer({
      config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
      backendLeg: leg === 'backend' ? fake : createFakeBackendLeg(),
      frontLeg: leg === 'front' ? fake : createFakeFrontLeg(),
      clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
      logStream: { write: line => lines.push(JSON.parse(line)) }
    })
    core.start()
    // #757: the holes are read off the start record, the line a lane operator reads,
    // rather than off a report field a test was the only reader of. The record is built
    // from the wiring the core applied, so a row added to a table and not to
    // src/legs/fake-legs.js fails this line, and the report carries no count of the rows
    // it installed for this case to add up.
    const start = lines.find(entry => entry.event === 'start')
    assert.deepEqual(start.legMissing[leg], DOUBLE_HOLES[leg].missing,
      'the ' + leg + ' double carries every row but the ones declared here')
  }
})

// The report is only a check if something reads it. A lane reads the start record,
// and on every leg in the tree the list is empty, which is a claim this case makes
// false on purpose: one call-in hidden from a real front leg, and the record names
// it. setBodyServed is the row the ticket opened with, because the leg answers a
// lane that never wired it with a null body and nothing else says so.
test('#592 a leg with a hole is named on the start record', () => {
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    offlineWhitelist: [PLAYER],
    getSnapshotConfig: () => [],
    wireMode: 'off'
  })
  const holey = new Proxy(leg, {
    get (target, name) { return name === 'setBodyServed' ? undefined : target[name] }
  })
  const lines = []
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
    backendLeg: createFakeBackendLeg(),
    frontLeg: holey,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    logStream: { write: line => lines.push(JSON.parse(line)) }
  })
  core.start()
  const start = lines.find(entry => entry.event === 'start')
  assert.deepEqual(start.legMissing, { front: ['setBodyServed'], backend: [] },
    'the start record names the call-in this leg did not carry, which is the one place a lane would see it')
})

// #726: the delivery half is a row now, so its absence is a name on the start line
// rather than a TypeError on the member the first frame reaches. This is the ticket's
// first acceptance criterion, as a case: before the row existed, `write` was not in
// either list, and a leg without it failed at the first relay and said nothing before.
test('#726 a leg with no delivery is named on the start record', () => {
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    offlineWhitelist: [PLAYER],
    getSnapshotConfig: () => [],
    wireMode: 'off'
  })
  const holey = new Proxy(leg, {
    get (target, name) { return name === 'write' ? undefined : target[name] }
  })
  const lines = []
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
    backendLeg: createFakeBackendLeg(),
    frontLeg: holey,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    logStream: { write: line => lines.push(JSON.parse(line)) }
  })
  core.start()
  assert.deepEqual(lines.find(entry => entry.event === 'start').legMissing, { front: ['write'], backend: [] },
    'the start record names the delivery this leg does not carry, which is the line a lane operator reads')
})

// #605: a backend leg with a hole is named by the same report, and the call that
// hole would have served falls back in words a reader can see. This is the
// ticket's second acceptance criterion, and the reason the two typeof guards are
// gone: the table is where the core learns what the leg carries.
test('#605 a backend leg missing a call-in is named on the start record, and chat falls back', () => {
  const backend = createFakeBackendLeg()
  const holey = new Proxy(backend, {
    get (target, name) { return name === 'chat' ? undefined : target[name] }
  })
  const lines = []
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null }, chat: 'full' }),
    backendLeg: holey,
    frontLeg,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    logStream: { write: line => lines.push(JSON.parse(line)) }
  })
  core.start()
  const start = lines.find(entry => entry.event === 'start')
  assert.deepEqual(start.legMissing, { front: DOUBLE_HOLES.front.missing, backend: ['chat'] },
    'the start record names the backend call-in this leg did not carry, beside the front list this double is known to have')

  // The call the hole would have served: the human's chat. It is dropped with the
  // leg's reason, which is what the guard used to say and the report now knows.
  backend.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  for (const frame of [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backend.deliver({ state: 'play', ...frame })
  assert.equal(frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER }).allowed, true)
  assert.equal(core.attachPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)

  frontLeg.serverbound({ name: 'chat_message', data: { message: 'hello' } })
  const blocked = lines.find(entry => entry.event === 'chatBlocked')
  assert.equal(blocked.reason, 'leg_has_no_chat',
    'the chat the leg cannot speak is dropped for the reason the report named, and the client is not told otherwise')
  assert.equal(core.metrics.chatSent, 0)
})

// #887: start() set its flag before it wired the legs, so a wiring a leg refused left
// the core started and unwired. The first throw is the guard doing its job (#824). The
// second start() is this case's subject: it returned at the guard, so a caller that
// caught the first throw had no second chance and no error to read.
//
// The leg is the middle registration of src/service/wire-leg-to-core.js's header — a lane
// filled a call-in while the leg was still the lane's, so the core's registration is the
// second one. test/legs/call-in-slots.test.js holds that refusal at the wireLegToCore seam;
// what this case holds is the state the core is left in afterwards.
test('#887 a start() the wiring refused leaves a core a second start() asks again', () => {
  const frontLeg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: '26.1',
    offlineWhitelist: [PLAYER],
    getSnapshotConfig: () => [],
    wireMode: 'off'
  })
  // The lane's own handler, made before any core is handed this leg.
  frontLeg.setCoreAttach(() => ({ attached: false, reason: 'a_lane_registered_first' }))

  const lines = []
  // Both legs are the real offline ones, so both refuse a second registration and this
  // case cannot pass on a double that accepts what a lane's leg rejects.
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
    backendLeg: createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, username: 'GlowSquidye' }),
    frontLeg,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
    logStream: { write: line => lines.push(JSON.parse(line)) }
  })

  assert.throws(() => core.start(), /setCoreAttach already holds a handler/,
    'the wiring refuses on the call-in the lane filled, which is the report #824 exists for')
  assert.equal(core.started, false,
    'the flag says the legs are wired, and they are not: it is set after the wiring, so a refused registration leaves it false')
  // #894 took the wiring report off the handle, so the start record is what a reader
  // has left of it: a refused start writes none.
  assert.deepEqual(lines.filter(line => line.event === 'start'), [],
    'and no start record claims a start that did not happen')

  assert.throws(() => core.start(), /already holds a handler/,
    'a second start() asks again, instead of returning at the guard on a core with no call-ins. It cannot converge: ' +
    'the first attempt installed the backend leg\'s call-ins before the front refused, so the retry meets that leg\'s ' +
    'own refusal. A caller learns the start did not happen; what it does about the lane\'s registration is its line')
  assert.equal(core.started, false, 'and it leaves the flag false again, so a caller always learns the start did not happen')
})

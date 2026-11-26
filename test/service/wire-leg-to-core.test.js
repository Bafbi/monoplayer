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
import { createOfflineFrontLeg } from '../../src/legs/live-front.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const count = (source, literal) => source.split(literal).length - 1

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
  assert.deepEqual(wiring.requiredMissing, [],
    'and none of the call-ins the core cannot work without is missing')
  // #627: the front table has a `call` row of its own now, the backend table's form:
  // the pre-auth window's numbers are read off the leg and nothing is registered for
  // them, so a registered row and a carried one are counted apart.
  assert.deepEqual(wiring.called, ['preAuthStats'],
    'the call the core makes on the leg is carried, not registered')
  assert.equal(wiring.wired.length + wiring.called.length, FRONT_LEG_CALL_INS.length,
    'and every declared call-in was either registered or carried')

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
  assert.deepEqual(wiring.called, ['answerHeldGate', 'chat'],
    'the two calls the core makes on the leg are carried, not registered')

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

test('#592 a leg missing a call-in is named, and the required ones are named apart', () => {
  const { core } = recordingCore(FRONT_LEG_CALL_INS)

  const partial = recordingLeg(FRONT_LEG_CALL_INS, { omit: ['setBodyServed'] })
  const named = wireLegToCore({ core, leg: partial.leg, table: FRONT_LEG_CALL_INS })
  assert.ok(named.missing.includes('setBodyServed'),
    'a leg without setBodyServed is named: its own fallback reads null and nothing else says so')
  assert.ok(!named.wired.includes('setBodyServed'),
    'and it is not reported as wired')

  const absent = recordingLeg(FRONT_LEG_CALL_INS, { omit: ['setCoreAttach', 'setSpectateBody'] })
  const answered = wireLegToCore({ core, leg: absent.leg, table: FRONT_LEG_CALL_INS })
  assert.deepEqual(answered.requiredMissing.sort(), ['setCoreAttach'],
    'the required ones are named separately: a lane without setCoreAttach refuses every attach through the leg\'s own default')
  assert.deepEqual(answered.missing, ['setCoreAttach', 'setSpectateBody'],
    'and both holes are in the one list, in table order: setCoreAttach is a required row and comes first')
})

// #605: a backend leg's hole is the report's business too. The two calls are the
// rows a leg answers rather than registers, and a leg without them was a typeof
// guard in the core's body until the table took them.
test('#605 a backend leg missing a call is named, and only a required row hides a client', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)

  const absent = recordingLeg(BACKEND_LEG_CALL_INS, { omit: ['chat', 'answerHeldGate', 'setErrorHandler'] })
  const wiring = wireLegToCore({ core, leg: absent.leg, table: BACKEND_LEG_CALL_INS })
  assert.deepEqual(wiring.missing, ['setErrorHandler', 'answerHeldGate', 'chat'],
    'the report names the missing registration and both missing calls, in table order')
  assert.deepEqual(wiring.requiredMissing, [],
    'and none of them is a row a client cannot be served without: the frame and end registrations are')
  assert.deepEqual(wiring.called, [],
    'a call this leg does not carry is not reported as carried')
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

// #605: a required backend row is the one whose absence hides a client, and the
// report names it apart from the calls a leg can work without. Before the table,
// a leg without this one threw at start() instead: the report is the quieter half
// of the same fact, and this case keeps it read.
test('#605 a backend leg without its end handler is named as required', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)
  const absent = recordingLeg(BACKEND_LEG_CALL_INS, { omit: ['setEndHandler'] })
  const wiring = wireLegToCore({ core, leg: absent.leg, table: BACKEND_LEG_CALL_INS })
  assert.deepEqual(wiring.requiredMissing, ['setEndHandler'],
    'the end of a session is not optional: a leg that keeps it to itself leaves the core attached to nothing')
  assert.deepEqual(wiring.missing, ['setEndHandler'],
    'and it is in the one list of holes as well')
})

// The table is an argument, so a leg cannot be measured against the other
// interface's rows by omission: the mistake that shape makes is silent otherwise.
test('#605 a leg is measured against the table it was handed, and against no other', () => {
  const { core } = recordingCore(BACKEND_LEG_CALL_INS)
  assert.throws(() => wireLegToCore({ core, leg: {} }), /needs the table/,
    'an omitted table is refused, not defaulted to the front interface')

  const front = recordingLeg(FRONT_LEG_CALL_INS).leg
  const measuredAsBackend = wireLegToCore({ core, leg: front, table: BACKEND_LEG_CALL_INS })
  assert.deepEqual(measuredAsBackend.missing, BACKEND_LEG_CALL_INS.map(entry => entry.name),
    'a front leg measured against the backend table carries none of it, which is how a wiring mistake reads')
})

test('#592 the ritual has one home: no lane registers the core\'s call-ins by hand', () => {
  const MODULE = read('src/service/wire-leg-to-core.js')
  const LANES = {
    'src/service/start-live.js': read('src/service/start-live.js'),
    'src/ladder/rig.js': read('src/ladder/rig.js'),
    'src/ladder/client-parity.js': read('src/ladder/client-parity.js'),
    'src/ladder/loopback.js': read('src/ladder/loopback.js')
  }

  // The module is the one home, so each row of either table is declared there
  // exactly once. The quotes are what tell setCoreAttach from
  // setCoreAttachConfiguring.
  for (const table of [FRONT_LEG_CALL_INS, BACKEND_LEG_CALL_INS]) {
    for (const { name } of table) {
      assert.equal(count(MODULE, "'" + name + "'"), 1,
        'src/service/wire-leg-to-core.js declares ' + name + ' once, for every lane')
    }
  }

  // Three of the four attach rows are never a lane's decision, so no lane with a
  // core may name them.
  const WIRED_LANES = {
    'src/service/start-live.js': LANES['src/service/start-live.js'],
    'src/ladder/rig.js': LANES['src/ladder/rig.js'],
    'src/ladder/client-parity.js': LANES['src/ladder/client-parity.js']
  }
  for (const [file, source] of Object.entries(WIRED_LANES)) {
    for (const name of ['setCoreAttachConfiguring', 'setConfiguringHandler', 'setClientSettingsHandler']) {
      assert.equal(count(source, '.' + name + '('), 0,
        file + ' leaves ' + name + ' to the core: a lane that registers it again has taken the ritual back')
    }
  }

  // The online rung joined them in #610: it declined the client-information
  // call-in, and a rung that declines a row is a rung whose backend sees less
  // than the product's. It keeps one hand registration, the attach wrapper
  // below, and nothing else.
  assert.equal(count(read('src/ladder/online.js'), '.setClientSettingsHandler('), 0,
    'src/ladder/online.js wires no call-in by hand either: its backend sees the same client information every lane sends')

  // The one rung that stands outside, and the factory's header is why: the two
  // pre-auth rigs, and #666's raw funnel, build a front leg and no core, so a
  // setter is all they have to drive. Their calls are theirs, and none is the
  // ritual.
  assert.equal(count(LANES['src/ladder/loopback.js'], '.setCoreAttachConfiguring('), 2,
    'src/ladder/loopback.js keeps the two pre-auth stubs of O48 and O49, which build no core')

  // The core registers nothing by hand either: the two calls are the two tables,
  // and a lane's copy would have to reappear beside them.
  const CORE = read('src/service/monoplayer.js')
  assert.equal(count(CORE, 'wireLegToCore({'), 2,
    'src/service/monoplayer.js applies one table per leg interface, in start()')
  for (const table of [FRONT_LEG_CALL_INS, BACKEND_LEG_CALL_INS]) {
    // A `call` row is one the core makes on the leg, so the call itself is the
    // point: only a registration has to be absent from the core's body.
    for (const { name, kind } of table) {
      if (kind !== 'register') continue
      assert.equal(count(CORE, '.' + name + '('), 0,
        'src/service/monoplayer.js registers no call-in by hand: ' + name + ' is a row of a table')
    }
  }
  // #605: the acceptance criterion, as a count rather than a promise.
  for (const name of ['setFrameHandler', 'setEndHandler', 'setErrorHandler',
    'setLoginStartHandler', 'setServerboundHandler', 'setDetachHandler']) {
    assert.equal(count(CORE, '.' + name + '('), 0,
      'src/service/monoplayer.js leaves ' + name + ' to its table: a registration here is a lane\'s copy of it elsewhere')
  }

  // #605: the six the core registered by hand are rows too, so no lane names one
  // either, with two excuses the rung's own header gives. The count is per file
  // because both are loopback rigs that build a leg and no core, so a setter is all
  // they have to drive: the frame handler of the two body legs of O59, and #666's
  // raw-funnel login review. Neither leg is one this core was handed.
  const BY_HAND = {
    setLoginStartHandler: { 'src/ladder/loopback.js': 1 },
    setServerboundHandler: {},
    setDetachHandler: {},
    setEndHandler: {},
    setErrorHandler: {},
    setFrameHandler: { 'src/ladder/loopback.js': 1 }
  }
  for (const [name, excused] of Object.entries(BY_HAND)) {
    for (const [file, source] of Object.entries(LANES)) {
      assert.equal(count(source, '.' + name + '('), excused[file] ?? 0,
        file + ' leaves ' + name + ' to the core: a lane that names one has taken the registration back')
    }
  }

  // setCoreAttach is the one a lane may wrap, and exactly two do: the rig, to
  // read the attach record, and the online rung, to cut its evidence. Each
  // registers one, after the core wired the default.
  assert.equal(count(LANES['src/ladder/rig.js'], '.setCoreAttach('), 1,
    'src/ladder/rig.js keeps its one wrapper, and no copy of the ritual around it')
  assert.equal(count(read('src/ladder/online.js'), '.setCoreAttach('), 1,
    'src/ladder/online.js keeps its one wrapper')
  assert.equal(count(LANES['src/service/start-live.js'], '.setCoreAttach('), 0,
    'src/service/start-live.js registers none: the live lane has no wrapper')
  assert.equal(count(LANES['src/ladder/client-parity.js'], '.setCoreAttach('), 0,
    'src/ladder/client-parity.js registers none')
  assert.equal(count(LANES['src/ladder/loopback.js'], '.setCoreAttach('), 0,
    'src/ladder/loopback.js registers none')
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
    requiredMissing: ['setCoreAttach', 'setCoreAttachConfiguring']
  },
  // The backend double carries its whole interface: a rig that arrives at a
  // handler it does not have would record nothing and say nothing.
  backend: { missing: [], requiredMissing: [] }
}

test('#605 each double carries every row of its interface, or a hole declared here', () => {
  const cases = [
    ['front', createFakeFrontLeg(), FRONT_LEG_CALL_INS],
    ['backend', createFakeBackendLeg(), BACKEND_LEG_CALL_INS]
  ]
  for (const [leg, fake, table] of cases) {
    const lines = []
    const core = createMonoplayer({
      config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
      backendLeg: leg === 'backend' ? fake : createFakeBackendLeg(),
      frontLeg: leg === 'front' ? fake : createFakeFrontLeg(),
      clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout },
      logStream: { write: line => lines.push(JSON.parse(line)) }
    })
    core.start()
    const report = core.legWiring[leg]
    assert.deepEqual(report.missing, DOUBLE_HOLES[leg].missing,
      'the ' + leg + ' double carries every row but the ones declared here: a row added to the table and not to src/legs/fake-legs.js fails this line')
    assert.deepEqual(report.requiredMissing, DOUBLE_HOLES[leg].requiredMissing,
      'and its required holes are the declared ones')
    assert.equal(report.wired.length + report.called.length + report.missing.length, table.length,
      'so every row of the table is reported as wired, carried or missing')
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
  assert.deepEqual(core.legWiring.front.missing, ['setBodyServed'],
    'and the report the record is built from says the same')
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
  assert.deepEqual(core.legWiring.backend.missing, ['chat'],
    'and the report the record is built from says the same about the backend leg')

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

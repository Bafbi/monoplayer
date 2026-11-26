// The core-to-leg wiring (#592). The core needs a set of call-ins on the front leg
// it is handed: some it cannot work without, the rest it uses when the leg carries
// them. The lanes used to register that first group by hand, and the rest sat
// behind typeof guards in the core's own start().
//
// The seam is the composition function, not a socket: each case hands it a
// recording core and a recording leg and reads which setter got which payload.
// Nothing here connects, listens or reads a custody directory.
//
// The last case is source text, because "the ritual has one home" is not a claim
// a call can make. It copies the idiom test/ladder/rig.test.js uses for the rig
// factory (#223): read the file, count the literal, assert the count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { LEG_CALL_INS, wireLegToCore } from '../../src/service/wire-leg-to-core.js'
import { createFakeBackendLeg } from '../../src/legs/fake-legs.js'
import { createOfflineFrontLeg } from '../../src/legs/live-front.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const count = (source, literal) => source.split(literal).length - 1

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// A core that records what its call-ins were asked, so a payload shape is read
// here rather than inferred from the module's body.
function recordingCore () {
  const calls = []
  const core = {}
  // One stand-in per row, built from the row itself, so a call-in added to the
  // table cannot arrive with no stand-in to answer it.
  for (const { reaches } of LEG_CALL_INS) {
    core[reaches] = (...args) => {
      calls.push({ name: reaches, args })
      return { name: reaches, args }
    }
  }
  return { core, calls }
}

// A leg that records which setter was handed which function, and can be built
// without some of them: a leg missing a call-in is the case that matters.
function recordingLeg ({ omit = [] } = {}) {
  const handlers = new Map()
  const leg = {}
  for (const { name } of LEG_CALL_INS) {
    if (omit.includes(name)) continue
    leg[name] = fn => handlers.set(name, fn)
  }
  return { leg, handlers }
}

test('#592 the core hands every call-in it needs to a leg that carries them', () => {
  const { core, calls } = recordingCore()
  const { leg, handlers } = recordingLeg()

  const wiring = wireLegToCore({ core, leg })

  assert.deepEqual(wiring.missing, [],
    'a leg that carries every setter is wired whole')
  assert.deepEqual(wiring.requiredMissing, [],
    'and none of the call-ins the core cannot work without is missing')
  assert.equal(wiring.wired.length, LEG_CALL_INS.length,
    'every declared call-in was registered')

  // The two payload shapes a caller must not have to know. `attachPlayer` takes
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
})

test('#592 a leg missing a call-in is named, and the required ones are named apart', () => {
  const { core } = recordingCore()

  const partial = recordingLeg({ omit: ['setBodyServed'] })
  const named = wireLegToCore({ core, leg: partial.leg })
  assert.ok(named.missing.includes('setBodyServed'),
    'a leg without setBodyServed is named: its own fallback reads null and nothing else says so')
  assert.ok(!named.wired.includes('setBodyServed'),
    'and it is not reported as wired')

  const absent = recordingLeg({ omit: ['setCoreAttach', 'setSpectateBody'] })
  const answered = wireLegToCore({ core, leg: absent.leg })
  assert.deepEqual(answered.requiredMissing.sort(), ['setCoreAttach'],
    'the required ones are named separately: a lane without setCoreAttach refuses every attach through the leg\'s own default')
  assert.deepEqual(answered.missing, ['setCoreAttach', 'setSpectateBody'],
    'and both holes are in the one list, in table order: setCoreAttach is a required row and comes first')
})

test('#592 the ritual has one home: no lane registers the core\'s attach call-ins by hand', () => {
  const MODULE = read('src/service/wire-leg-to-core.js')
  const LANES = {
    'src/service/start-live.js': read('src/service/start-live.js'),
    'src/ladder/rig.js': read('src/ladder/rig.js'),
    'src/ladder/client-parity.js': read('src/ladder/client-parity.js'),
    'src/ladder/loopback.js': read('src/ladder/loopback.js')
  }

  // The module is the one home, so each of the four is declared there exactly
  // once. The quotes are what tell setCoreAttach from setCoreAttachConfiguring.
  for (const name of ['setCoreAttachConfiguring', 'setConfiguringHandler', 'setClientSettingsHandler', 'setCoreAttach']) {
    assert.equal(count(MODULE, "'" + name + "'"), 1,
      'src/service/wire-leg-to-core.js declares ' + name + ' once, for every lane')
  }

  // Three of the four are never a lane's decision, so no lane with a core may
  // name them.
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

  // The one rung that stands outside, and the factory's header is why: the two
  // pre-auth rigs build a front leg and no core, so the setter is all they have
  // to drive. Two calls, both theirs, and neither is the ritual.
  assert.equal(count(LANES['src/ladder/loopback.js'], '.setCoreAttachConfiguring('), 2,
    'src/ladder/loopback.js keeps the two pre-auth stubs of O48 and O49, which build no core')

  // The core registers nothing by hand either: the one call is the table, and a
  // lane's copy would have to reappear beside it.
  const CORE = read('src/service/monoplayer.js')
  assert.equal(count(CORE, 'wireLegToCore({'), 1,
    'src/service/monoplayer.js applies the table once, in start()')
  for (const name of ['setCoreAttachConfiguring', 'setConfiguringHandler', 'setClientSettingsHandler', 'setCoreAttach']) {
    assert.equal(count(CORE, '.' + name + '('), 0,
      'src/service/monoplayer.js registers no call-in by hand: ' + name + ' is a row of the table')
  }

  // One lane still makes a hand registration, and it declines a call-in rather
  // than wiring one: the online rung keeps the comparison it was built for.
  assert.equal(count(read('src/ladder/online.js'), '.setClientSettingsHandler(null)'), 1,
    'src/ladder/online.js declines the client-information call-in in one line: its other hand registration is the attach wrapper below')

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
  assert.deepEqual(start.legMissing, ['setBodyServed'],
    'the start record names the call-in this leg did not carry, which is the one place a lane would see it')
  assert.deepEqual(core.legWiring.missing, ['setBodyServed'],
    'and the report the record is built from says the same')
})

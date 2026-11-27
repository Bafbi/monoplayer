// #824: a call-in is one slot on a leg, and its setter fills that slot once.
//
// Every setter on a real leg was a plain assignment, so a second registration replaced
// the first with nothing said. Two registrations can reach one slot, and neither is a
// handler the leg may lose on its own:
//   - a lane's, before it hands the leg to a core. The core's start() then registers over
//     it (src/service/wire-leg-to-core.js), and the call-in the lane wrote runs nothing.
//     This is the case no report could show, because a lane reads `missing: []` either
//     way;
//   - a lane's, after that start(). It replaces the core's handler, and the wiring report
//     still reads whole: `wireLegToCore` measures the leg's shape at the call, so a name
//     present is a name carried, whether or not the handler installed there is the core's.
//
// Seam: the leg and its setters, and `wireLegToCore` over a stub core. A registration is
// a call on the leg's own surface, so the refusal is reachable with no socket, no auth and
// no custody: nothing here listens or dials.
//
// The last case is the lane the rule must leave alone. A leg a core is never handed — the
// two pre-auth rigs and #666's raw funnel in src/ladder/loopback.js — is a leg whose slots
// a lane fills itself, and one registration on such a slot is the whole rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { createOfflineBackendLeg } from '../../src/legs/live-backend.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { BACKEND_LEG_CALL_INS, FRONT_LEG_CALL_INS, wireLegToCore } from '../../src/service/wire-leg-to-core.js'

const VERSION = '26.1'
const NAME = 'Bafbi'

const frontLeg = () => createOfflineFrontLeg({
  host: '127.0.0.1',
  port: 0,
  version: VERSION,
  offlineWhitelist: [offlineUuid(NAME)],
  getSnapshotConfig: () => [],
  wireMode: 'off'
})

const backendLeg = () => createOfflineBackendLeg({
  host: '127.0.0.1', port: 25565, version: VERSION, username: 'GlowSquidye'
})

// A handler of the shape the slot takes, and a second one the leg must never end up
// holding: the cases below read which of the two a registration left behind.
const first = () => ({ attached: true, replayed: 0 })
const second = () => ({ attached: false, reason: 'a_second_registration' })

test('#824 a front leg refuses a second registration on a call-in, in the slot\'s own name', () => {
  const leg = frontLeg()
  assert.doesNotThrow(() => leg.setCoreAttach(first),
    'the first registration is the one the leg was built to wait for')

  assert.throws(() => leg.setCoreAttach(second), /setCoreAttach is already filled/,
    'a second registration is refused rather than assigned over: the leg used to answer it by replacing the handler, which is #824')

  assert.throws(() => leg.setCoreAttach(first), /setCoreAttach is already filled/,
    'and a refused registration neither replaced the handler nor emptied the slot, so the slot still holds the one registration it took')

  assert.doesNotThrow(() => leg.setCoreAttachConfiguring(first),
    'the rule is one slot per call-in, not a switch on the leg: the neighbouring slot is a slot of its own')
})

test('#824 a registration made before the core\'s start is refused at that start, not lost', () => {
  const leg = frontLeg()
  // The lane's own registration, made while the leg is still the lane's.
  leg.setServerboundHandler(() => ({ allowed: true }))

  assert.throws(() => wireLegToCore({ core: {}, leg, table: FRONT_LEG_CALL_INS }),
    /setServerboundHandler is already filled/,
    'the core\'s registration is the second one, so the core\'s start() is where it is said: before #824 the core assigned over the lane in silence and the lane\'s call-in ran nothing')
})

test('#824 a registration made after the start is refused, so a whole wiring is the core\'s handlers', () => {
  const leg = frontLeg()
  const wiring = wireLegToCore({ core: {}, leg, table: FRONT_LEG_CALL_INS })
  assert.deepEqual(wiring.missing, [],
    'the report reads whole: every call-in the table declares is a name this leg carries')

  assert.throws(() => leg.setCoreAttach(second), /setCoreAttach is already filled/,
    'and the handler in that slot is the core\'s, because a lane cannot install its own after the start: #824 is a report that named a whole wiring while the handler was somebody else\'s')
})

test('#824 the backend leg keeps one slot per call-in in the same words', () => {
  const leg = backendLeg()
  assert.doesNotThrow(() => leg.setFrameHandler(() => {}), 'the first registration is the leg\'s own slot filling')

  assert.throws(() => leg.setFrameHandler(() => {}), /setFrameHandler is already filled/,
    'the backend leg\'s setters were the same plain assignment, so the rule is the front leg\'s rule here too')

  const fresh = backendLeg()
  fresh.setEndHandler(() => {})
  assert.throws(() => wireLegToCore({ core: {}, leg: fresh, table: BACKEND_LEG_CALL_INS }),
    /setEndHandler is already filled/,
    'and a lane\'s end handler on a leg handed to the core is refused at the core\'s start, as the front leg\'s is')
})

test('#824 a lane\'s own leg takes one registration per slot and nothing else', () => {
  const leg = frontLeg()
  for (const row of FRONT_LEG_CALL_INS) {
    if (row.kind !== 'register') continue
    assert.equal(typeof leg[row.name], 'function',
      row.name + ' is a row of FRONT_LEG_CALL_INS and a member of the live front leg')
    assert.doesNotThrow(() => leg[row.name](() => {}),
      row.name + ' takes one registration on a leg no core is handed: src/ladder/loopback.js builds such legs, and a rule that refused this one would refuse the rungs')
  }
})

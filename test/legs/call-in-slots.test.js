// #824: a leg's call-in holds one handler, and its setter refuses the second registration.
//
// Every setter on a real leg was a plain assignment, so a second registration replaced the
// first with nothing said. Two of the three registrations a call-in can see are a lane's,
// and both were silent. One made before the core's start() was replaced by the core's. One
// made after it replaced the core's, and the wiring report still read whole.
//
// Seam: the leg and its setters, and `wireLegToCore` over a stub core. A registration is a
// call on the leg's own surface, so the refusal is reachable with no socket, no auth and no
// custody: nothing here listens or dials.
//
// The last two cases are the lanes the rule must leave alone. A leg a core is never handed —
// the two pre-auth rigs and #666's raw funnel in src/ladder/loopback.js — is a leg whose
// call-ins a lane fills itself, and one registration on each is the whole rule.
//
// The rule itself is src/legs/call-in-handler.js's. What this file holds is that both real
// legs keep it.
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

// A handler of the shape the call-in takes, and a second one the leg must never end up
// holding: the cases below read which of the two a registration left behind.
const first = () => ({ attached: true, replayed: 0 })
const second = () => ({ attached: false, reason: 'a_second_registration' })

test('#824 a front leg refuses a second registration on a call-in, in the call-in\'s own name', () => {
  const leg = frontLeg()
  assert.doesNotThrow(() => leg.setCoreAttach(first),
    'the first registration is the one the leg was built to wait for')

  assert.throws(() => leg.setCoreAttach(second), /setCoreAttach already holds a handler/,
    'a second registration is refused rather than assigned over: the leg used to answer it by replacing the handler, which is #824')

  assert.throws(() => leg.setCoreAttach(first), /setCoreAttach already holds a handler/,
    'and a refused registration neither replaced the handler nor emptied the call-in, so the call-in still holds the one registration it took')

  assert.doesNotThrow(() => leg.setCoreAttachConfiguring(first),
    'the rule is one handler per call-in, not a switch on the leg: the neighbouring call-in is a call-in of its own')
})

test('#824 a call-in takes a function, and a refused value leaves the call-in open', () => {
  const leg = frontLeg()
  assert.throws(() => leg.setCoreAttach(null), /setCoreAttach takes the function/,
    'a value that is not a function is refused by name: the setter used to store it in the same variable a handler goes in, and the leg then called null at a client\'s join')

  assert.doesNotThrow(() => leg.setCoreAttach(first),
    'and the refusal filled nothing, so the call-in still takes its one handler')
})

test('#824 a registration made before the core\'s start is refused at that start, not lost', () => {
  const leg = frontLeg()
  // The lane's own registration, made while the leg is still the lane's.
  leg.setServerboundHandler(() => ({ allowed: true }))

  assert.throws(() => wireLegToCore({ core: {}, leg, table: FRONT_LEG_CALL_INS }),
    /setServerboundHandler already holds a handler/,
    'the core\'s registration is the second one, so the core\'s start() is where it is said. Before #824 the core assigned over the lane in silence, and the lane\'s call-in ran nothing')
})

test('#824 a registration made after the start is refused, so a whole wiring is the core\'s handlers', () => {
  const leg = frontLeg()
  const wiring = wireLegToCore({ core: {}, leg, table: FRONT_LEG_CALL_INS })
  assert.deepEqual(wiring.missing, [],
    'the report reads whole: every call-in the table declares is a name this leg carries')

  assert.throws(() => leg.setCoreAttach(second), /setCoreAttach already holds a handler/,
    'and the handler behind that name is the core\'s, because a lane cannot install its own after the start. #824 is a report that named a whole wiring while the handler was somebody else\'s')
})

test('#824 the backend leg keeps one handler per call-in in the same words', () => {
  const leg = backendLeg()
  assert.doesNotThrow(() => leg.setFrameHandler(() => {}), 'the first registration is the leg\'s own call-in filling')

  assert.throws(() => leg.setFrameHandler(() => {}), /setFrameHandler already holds a handler/,
    'the backend leg\'s setters were the same plain assignment, so the rule is the front leg\'s rule here too')

  const fresh = backendLeg()
  fresh.setEndHandler(() => {})
  assert.throws(() => wireLegToCore({ core: {}, leg: fresh, table: BACKEND_LEG_CALL_INS }),
    /setEndHandler already holds a handler/,
    'and a lane\'s end handler on a leg handed to the core is refused at the core\'s start, as the front leg\'s is')
})

test('#824 a lane\'s own leg takes one registration per call-in and nothing else', () => {
  const leg = frontLeg()
  for (const row of FRONT_LEG_CALL_INS) {
    if (row.kind !== 'register') continue
    assert.equal(typeof leg[row.name], 'function',
      row.name + ' is a row of FRONT_LEG_CALL_INS and a member of the live front leg')
    assert.doesNotThrow(() => leg[row.name](() => {}),
      row.name + ' takes one registration on a leg no core is handed: src/ladder/loopback.js builds such legs, and a rule that refused this one would refuse the rungs')
  }
})

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
// legs keep it, and since #886 that both doubles keep it too.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { createOfflineBackendLeg } from '../../src/legs/live-backend.js'
import { createFakeFrontLeg, createFakeBackendLeg } from '../../src/legs/fake-legs.js'
import { CALL_IN_SETTER } from '../../src/legs/call-in-handler.js'
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

// Two functions a registration can hand a call-in, and the cases below read which of the
// two a leg ended up holding. No case here calls one, so no answer's shape is under test.
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

// #886: a double is an oracle, and one that answers a call the product refuses is a test
// that passes on a lane that would not boot. #824 filled both real legs' call-ins one
// registration deep and left src/legs/fake-legs.js assigning plainly, so a service test
// could plant a second registration and read a whole wiring off a leg whose real
// counterpart throws. That is #631's general form: the fake built a claim by hand.
//
// Seam: the doubles' own setters, each on a leg built here. A registration is a call on
// the leg's own surface, so the refusal is reachable with no core, no socket and no
// custody.
//
// A double keeps its declared holes: it carries neither setCoreAttach nor
// setCoreAttachConfiguring, and test/service/wire-leg-to-core.test.js names the rest. A row
// a double does not carry is not this case's to ask about, so the walk is the two tables
// filtered by what that double answers.
const DOUBLES = [
  ['fake front leg', createFakeFrontLeg, FRONT_LEG_CALL_INS],
  ['fake backend leg', createFakeBackendLeg, BACKEND_LEG_CALL_INS]
]

test('#886 a double refuses a second registration on every call-in it fills', () => {
  let callInsWalked = 0
  for (const [label, build, table] of DOUBLES) {
    const rows = table.filter(row => row.kind === 'register' && typeof build()[row.name] === 'function')
    assert.ok(rows.length > 0, label + ' fills at least one call-in, or this case asserts nothing')

    for (const row of rows) {
      const leg = build()
      assert.doesNotThrow(() => leg[row.name](first),
        label + ': ' + row.name + ' takes the first registration, which is the whole rule')

      assert.throws(() => leg[row.name](second), new RegExp(row.name + ' already holds a handler'),
        label + ': ' + row.name + ' refuses a second registration in the call-in\'s own name. Before #886 the double assigned over the first and said nothing, which is what a real leg stopped doing in #824')

      assert.throws(() => leg[row.name](first), new RegExp(row.name + ' already holds a handler'),
        label + ': ' + row.name + ' refuses a repeat of the same function too: a registration is a write, not a call')

      assert.throws(() => leg[row.name](null), new RegExp(row.name + ' takes the function'),
        label + ': ' + row.name + ' refuses a value that is not a function, the other half of the rule')
      callInsWalked++
    }
  }
  assert.equal(callInsWalked, 10,
    'ten call-ins across the two doubles answer the rule: the front double\'s seven and the backend double\'s three. A register row one of them stops carrying fails this count, and that is the number #886 turned from a silent overwrite into a refusal. A setter with no row in the tables is outside this walk, and test/legs/adapters.test.js\'s #672 case is what names it')
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

// #918: #824 refused the second registration inside the setter, and an own-property write never
// reached it: `leg.setCoreAttach = fn` replaced the setter, so before the core's start() the
// lane's function answered the core's registration and after it the core's handler was gone,
// while `wireLegToCore` read the member as carried either way. The property carries the rule now
// (src/legs/call-in-handler.js's `sealCallIns`). Three routes reach a member of an object, and
// the case below takes each: an assignment, a `defineProperty`, and a `delete`. The fourth is the
// field behind the setter, which is a closure variable and has no name on the leg.
//
// Seam: the legs' own members, which are the surface #918 is about. Nothing here listens,
// dials or attaches, so the walk needs no socket, no core and no custody.
const LEGS = [
  ['live front leg', frontLeg, FRONT_LEG_CALL_INS],
  ['live backend leg', backendLeg, BACKEND_LEG_CALL_INS],
  ['fake front leg', createFakeFrontLeg, FRONT_LEG_CALL_INS],
  ['fake backend leg', createFakeBackendLeg, BACKEND_LEG_CALL_INS]
]

// The call-in setters a leg carries, as its own members. The walk reads the rule the seal reads
// (CALL_IN_SETTER, imported) rather than spelling it a second time, and a walk that found nothing
// fails below, so a rule that stopped matching the members is this case and not a green silence.
function callInSetters (leg) {
  return Object.keys(leg).filter(name => CALL_IN_SETTER.test(name) && typeof leg[name] === 'function')
}

test('#918 a leg\'s call-in setter cannot be written over, and the call-in keeps its handler', () => {
  for (const [label, build, table] of LEGS) {
    const names = callInSetters(build())
    assert.ok(names.length > 0, label + ' carries call-in setters, or this case asserts nothing')
    // The rows whose member holds a handler, so the one registration below is a registration
    // and not a call like setTarget.
    const registering = new Set(table.filter(row => row.kind === 'register').map(row => row.name))

    for (const name of names) {
      const leg = build()
      const setter = leg[name]
      assert.throws(() => { leg[name] = second }, TypeError,
        label + ': ' + name + ' refuses the assignment. Before #918 it took it in silence, which is the route around #824')
      assert.equal(leg[name], setter,
        label + ': and the refused write left the setter the leg was built with')

      const descriptor = Object.getOwnPropertyDescriptor(leg, name)
      assert.equal(descriptor.writable, false,
        label + ': ' + name + ' holds a call-in, so a write over it installs a handler the core never made (#918). The member is not writable')
      assert.equal(descriptor.configurable, false,
        label + ': and it is not configurable either, or a descriptor write is the same replacement by another spelling')
      assert.throws(() => Object.defineProperty(leg, name, { value: second }), TypeError,
        label + ': ' + name + ' refuses a descriptor write too, so the property is the leg\'s and not the caller\'s')
      assert.throws(() => { delete leg[name] }, TypeError,
        label + ': and it cannot be deleted, which would leave the core a call-in short with the report naming the hole')

      if (!registering.has(name)) continue
      // The legitimate case, on the leg the write was refused over: the setter still takes the
      // one registration a lane or the core makes. A seal that refused this would refuse a
      // correct lane, and #887 is what a core left half-started by a throw costs.
      assert.doesNotThrow(() => leg[name](first),
        label + ': ' + name + ' takes the one registration a lane or the core makes')
      assert.throws(() => leg[name](second), new RegExp(name + ' already holds a handler'),
        label + ': and the second is still refused in the call-in\'s own name, which is #824 standing beside the property')
    }
  }
})

// The fourth route, and the one no descriptor can close: a caller that writes the field the
// setter fills. It is a closure variable in every leg, so the name has no member to write, and
// a write of that name adds something the leg never reads. This case is green before #918 as
// well, and it is here to say why the setter was the only route worth sealing.
test('#918 the field behind a call-in is a closure variable, so the setter is the only name a caller writes', () => {
  const leg = createFakeFrontLeg()
  let answered = null
  leg.setServerboundHandler(({ name }) => { answered = name })

  assert.equal('serverboundHandler' in leg, false,
    'the field the setter fills is not a member under its own name, which is why the setter was the whole surface #824 had to guard')

  leg.serverboundHandler = () => { answered = 'written over' }
  leg.serverbound({ name: 'player_chat' })
  assert.equal(answered, 'player_chat',
    'a write of that name adds a member the leg reads nowhere, and the registration still answers')

  assert.equal('coreAttach' in frontLeg(), false,
    'and the real front leg is the same shape: the attach the core registers is the one its setter filled')
})

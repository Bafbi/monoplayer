// The rig factory (#223). Seven loopback rigs built their own front leg, backend
// leg, core and clock, and the copies drifted: one clock literal bound its timer
// functions bare, and two rigs logged their core as `core`, a tag nothing read.
// `src/ladder/rig.js` is the one home for that wiring now, and this case holds
// the rung to it.
//
// A source-text guard, not a socket. The rung that proves the wiring is
// `mise run loopback`, and every rig it builds needs a fake backend and a real
// client, so a case here that built one would double the gate's socket load. What
// a green run cannot show is that no rig was wired by hand again: that is the
// claim this guard makes, and the cheapest form that fails loudly.
//
// Nothing here opens a socket: both cases read two files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const RUN = read('src/ladder/loopback.js')
const FACTORY = read('src/ladder/rig.js')

const count = (source, literal) => source.split(literal).length - 1

test('every loopback rig is built by the factory, and the clock has one home', () => {
  // A rig wired by hand starts with a core, and `createMonoplayer` is the call
  // the factory makes on the rung's behalf. Nothing in the rung should make it.
  assert.equal(count(RUN, 'createMonoplayer('), 0,
    'src/ladder/loopback.js builds no core of its own: a rig goes through createRig, in src/ladder/rig.js')

  // The clock literal is what the copies actually differed on, so it is the
  // literal this guard pins: none in the rung, one in the factory.
  assert.equal(count(RUN, 'now: Date.now'), 0,
    'src/ladder/loopback.js spells no clock: the factory hands every rig the same one')
  assert.equal(count(FACTORY, 'now: Date.now'), 1,
    'src/ladder/rig.js spells the clock once, for every rig it builds')
})

test('the rung reaches the factory it is held to', () => {
  // The two assertions above are also true of a rung that builds no rig at all,
  // so the call is counted too. Five is a floor, not the number of rigs: the rigs
  // with no core (the pre-auth cap and deadline, the two body-cache legs) keep
  // their own wiring, because a core in the middle is what createRig is.
  assert.ok(count(RUN, 'await createRig(') >= 5,
    'src/ladder/loopback.js builds its rigs through createRig, one call per rig that has a core')
})

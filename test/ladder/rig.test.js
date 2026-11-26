// The rig factory (#223, #624). Seven loopback rigs built their own front leg,
// backend leg, core and clock, and the copies drifted: one clock literal bound its
// timer functions bare, and two rigs logged their core as `core`, a tag nothing
// read. `src/ladder/rig.js` is the one home for that wiring now, and this case
// holds every module under `src/ladder/` to it.
//
// #624: this guard read two files by name, the rung and the factory, so a third
// module could hand-wire a core and copy the clock literal and pass.
// `src/ladder/loopback-lane.js` (#594) is the first module that could have, and
// nothing would have said so. It reads the directory now: a module that spells a
// core or a clock has a row below saying how many of each it may spell and why, and
// a module with no row fails. The rows are explicit and not a glob, because two
// modules under this directory own a core and a clock on purpose.
//
// A source-text guard, not a socket. The rung that proves the wiring is
// `mise run loopback`, and every rig it builds needs a fake backend and a real
// client, so a case here that built one would double the gate's socket load. What
// a green run cannot show is that no rig was wired by hand again: that is the
// claim this guard makes, and the cheapest form that fails loudly.
//
// Nothing here opens a socket: the modules are read once, at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LADDER_DIR = 'src/ladder'
const RIG_FACTORY = 'src/ladder/rig.js'
const LOOPBACK_RUNG = 'src/ladder/loopback.js'
const LOOPBACK_LANE = 'src/ladder/loopback-lane.js'
const ONLINE_RUNG = 'src/ladder/online.js'
const PARITY_RUNG = 'src/ladder/client-parity.js'

const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// A comment is not a read. A module that names a literal while explaining why it
// spells no such thing wires nothing, and the sibling guard says so the same way
// (test/tooling/env-overlay-surface.test.js:168).
const code = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

const count = (source, literal) => source.split(literal).length - 1

// The two literals a rig wired by hand spells. `createMonoplayer` is the call the
// factory makes on the rung's behalf, and the clock is what the copies actually
// differed on, so the pair is the shape a hand-wired rig cannot avoid.
const CORE = 'createMonoplayer('
const CLOCK = 'now: Date.now'

// What a module may spell for itself: the core it creates, and the clock it hands
// that core. A row is a decision, and its `why` is the reason, so the next module
// that wants one argues with a sentence instead of passing. Zero and zero is a row
// too: the rung says so, which is the claim every other row is measured against.
const SPELLS = {
  [RIG_FACTORY]: {
    core: 1,
    clock: 1,
    why: 'the factory: one core and one clock, for every rig it builds'
  },
  [LOOPBACK_RUNG]: {
    core: 0,
    clock: 0,
    why: 'the rung: every rig of its own goes through createRig, which brings both'
  },
  [LOOPBACK_LANE]: {
    core: 0,
    clock: 1,
    why: 'laneClock() is the rig clock beside a ledger of the timers it arms, which is what a close reads (#661). It builds no core'
  },
  [ONLINE_RUNG]: {
    core: 1,
    clock: 1,
    why: 'the online rung owns its core and clock, and builds no loopback rig'
  },
  [PARITY_RUNG]: {
    core: 1,
    clock: 1,
    why: 'the parity rung owns its core and clock too'
  }
}

// Every module under the directory, at any depth. A module one folder down would
// escape a walk that stopped at the top level, and `mise run lint` reads `.js` and
// `.mjs` alike, so this does too.
function modules (dir = LADDER_DIR) {
  const found = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const name = dir + '/' + entry.name
    if (entry.isDirectory()) found.push(...modules(name))
    else if (/\.(js|mjs)$/.test(entry.name)) found.push(name)
  }
  return found.sort()
}

// Each module read once, so every case below counts the same text.
const SOURCE = new Map(modules().map(name => [name, code(read(name))]))
const spells = name => count(SOURCE.get(name), CORE) + count(SOURCE.get(name), CLOCK)

// What a count asks a reader to edit. The row held the number, so either the module
// goes back to the factory or the row moves: printing the reason alone would explain
// the allowance without saying how to restore it.
const repair = (name, literal, found, allowed, why) =>
  name + ' spells ' + literal + ' ' + found + ' times, and its row allows ' + allowed + ': ' + why +
  '. Route that wiring through createRig in ' + RIG_FACTORY + ', or change the row to ' + found

test('a module under src/ladder that spells a core or a clock has a row here', () => {
  // A filter broken by a rename fails on this sentence rather than on a TypeError
  // from the case below, so the floor names the two modules it has to find: the rung
  // that spells neither, and the factory that spells both.
  assert.ok(SOURCE.has(LOOPBACK_RUNG) && SOURCE.has(RIG_FACTORY),
    'the walk reads ' + LOOPBACK_RUNG + ' and ' + RIG_FACTORY)

  // The claim, in the direction that catches a new module: nothing in this
  // directory wires a rig without a row saying so.
  const spelling = [...SOURCE.keys()].filter(name => spells(name) > 0)
  assert.deepEqual(spelling.filter(name => !(name in SPELLS)), [],
    'every module under src/ladder that spells createMonoplayer( or now: Date.now has a row in SPELLS, with the reason it may: a rig goes through createRig (#624)')

  // And the other direction, so a row cannot outlive the module it describes.
  assert.deepEqual(Object.keys(SPELLS).filter(name => !SOURCE.has(name)), [],
    'every row in SPELLS names a module under src/ladder: drop the row with the module')
})

test('a named module spells what its row allows, and no more', () => {
  // A hand-wired rig starts with a core of its own, and a copied clock literal is
  // what the copies drifted on. Both are counted, so a row that allows neither
  // fails the moment one appears: that is the claim #624 exists to make.
  for (const [name, allowed] of Object.entries(SPELLS)) {
    assert.equal(count(SOURCE.get(name), CORE), allowed.core, repair(name, CORE, count(SOURCE.get(name), CORE), allowed.core, allowed.why))
    assert.equal(count(SOURCE.get(name), CLOCK), allowed.clock, repair(name, CLOCK, count(SOURCE.get(name), CLOCK), allowed.clock, allowed.why))
  }
})

test('the rung reaches the factory it is held to', () => {
  // The cases above are also true of a rung that builds no rig at all, so the call
  // is counted too. Five is a floor, not the number of rigs: the rigs with no core
  // (the pre-auth cap and deadline, the two body-cache legs) keep their own wiring,
  // because a core in the middle is what createRig is. Lower this floor when #594's
  // remaining conversions replace the rig sites.
  assert.ok(count(SOURCE.get(LOOPBACK_RUNG), 'await createRig(') >= 5,
    'src/ladder/loopback.js builds its rigs through createRig, one call per rig that has a core')
})

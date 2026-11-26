// #438: one bounded map of counts, keyed by a string that is not a closed set, and
// now one rule for both callers of it. #437 asked for this test: the cap, the
// overflow bucket, and what an empty key counts as. The front leg's own cap keeps
// its test in test/legs/picker-numbers.test.js, because that file is where the leg's
// cap is rung; the rule itself is tested here.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bumpBounded, OVERFLOW_KEY, UNKNOWN_KEY } from '../../src/core/bounded-counter.js'

test('#438 a key already in the map counts up, and a new one enters at one', () => {
  const map = {}

  bumpBounded(map, 'keep_alive', 4)
  bumpBounded(map, 'keep_alive', 4)
  bumpBounded(map, 'chat', 4)

  assert.deepEqual(map, { keep_alive: 2, chat: 1 })
})

test('#438 the cap is the caller\'s, so two maps in one process keep their own headroom', () => {
  const narrow = {}
  const wide = {}

  for (const name of ['a', 'b', 'c']) {
    bumpBounded(narrow, name, 2)
    bumpBounded(wide, name, 8)
  }

  assert.deepEqual(narrow, { a: 1, b: 1, [OVERFLOW_KEY]: 1 },
    'a cap of two holds two names, and the third lands in the overflow bucket')
  assert.deepEqual(wide, { a: 1, b: 1, c: 1 },
    'a cap of eight holds all three, so the cap is what the caller passed')
})

test('#438 a name past the cap is not in the map, and the map stops growing', () => {
  const map = {}
  const cap = 3

  for (let index = 0; index < cap; index++) bumpBounded(map, 'reason-' + index, cap)
  assert.equal(Object.keys(map).length, cap, 'the map holds exactly its cap while the cap has room')

  bumpBounded(map, 'one-too-many', cap)
  bumpBounded(map, 'one-too-many-again', cap)

  assert.equal(Object.keys(map).length, cap + 1,
    'the overflow bucket is the one key past the cap, so the map is bounded by the cap plus one')
  assert.equal(map[OVERFLOW_KEY], 2, 'and it counts every name the cap turned away')
  assert.equal(map['one-too-many'], undefined, 'a name the cap turned away is not in the map')
})

test('#438 a name the map already holds keeps counting past the cap', () => {
  const map = {}
  const cap = 2

  bumpBounded(map, 'held', cap)
  bumpBounded(map, 'held', cap)
  bumpBounded(map, 'other-name', cap)
  bumpBounded(map, 'one-too-many', cap)

  assert.equal(map[OVERFLOW_KEY], 1, 'the overflow bucket counted the one name it turned away')
  bumpBounded(map, 'held', cap)
  assert.equal(map.held, 3,
    'a name the map already holds counts up on its own key, because the overflow bucket is for names it never held')
  assert.equal(map[OVERFLOW_KEY], 1, 'and the overflow bucket did not move')
})

test('#438 a key that is not a name counts as unknown, and the empty string is not a name', () => {
  const map = {}

  for (const key of [null, undefined, '', 7, {}]) bumpBounded(map, key, 8)
  bumpBounded(map, 'no_body', 8)

  assert.deepEqual(map, { [UNKNOWN_KEY]: 5, no_body: 1 },
    'a caller with no word for the key is counted as unknown, once per call')
  assert.equal(map[''], undefined,
    'an empty key is not a label of its own: it reads as a label with nothing in it, which says less than unknown does')
})

// #552: the whole point of the helper is that its key is a string nobody closed, so
// the key is asked about as a key and never as a path into the language. The three
// below are the names on Object.prototype a protocol would collide with first: a
// function, the prototype accessor, and the constructor. Each counts on its own key,
// and none of them reads or writes the map's prototype.
test('#552 a key naming a member of Object.prototype counts as an ordinary key', () => {
  const map = {}

  bumpBounded(map, 'toString', 8)
  bumpBounded(map, 'toString', 8)
  assert.equal(Object.hasOwn(map, 'toString'), true, 'toString is the map\'s own key, not the inherited function')
  assert.equal(map.toString, 2, 'and it counts up from one, rather than incrementing the function into NaN')

  bumpBounded(map, '__proto__', 8)
  bumpBounded(map, '__proto__', 8)
  assert.equal(Object.hasOwn(map, '__proto__'), true,
    '__proto__ is a key like any other: the inherited setter does not swallow it and leave the map empty')
  assert.equal(map['__proto__'], 2, 'and the second count lands on the first')
  assert.equal(Object.getPrototypeOf(map), Object.prototype, 'while the map\'s own prototype is untouched')

  bumpBounded(map, 'constructor', 8)
  assert.equal(Object.hasOwn(map, 'constructor'), true, 'constructor is the map\'s own key, not Object\'s')
  assert.equal(map.constructor, 1, 'and a count of one is one, not NaN')

  assert.deepEqual(Object.keys(map).sort(), ['__proto__', 'constructor', 'toString'],
    'all three are enumerable keys of the map, so a reader that lists the map sees them')
  // The expected object spells its key as a computed name, because a literal
  // `__proto__: 2` in an object literal is the setter this test is about.
  assert.deepEqual(JSON.parse(JSON.stringify(map)), { ['__proto__']: 2, constructor: 1, toString: 2 },
    'and they survive the heartbeat line: no NaN for the JSON encoder to write as null')
})

test('#552 a prototype name still counts up after the map has passed its cap', () => {
  const map = {}
  for (let index = 0; index < 2; index++) bumpBounded(map, 'reason-' + index, 2)
  bumpBounded(map, 'toString', 2)
  bumpBounded(map, 'toString', 2)

  assert.equal(map[OVERFLOW_KEY], 2, 'a prototype name past the cap is a name the cap turned away, like any other')
  assert.equal(Object.hasOwn(map, 'toString'), false, 'so it is not in the map')
})

// The header promises this runs in a live session's relay path and adds no throw of
// its own. A cap that is not a number is the shape of that promise: no throw, and a
// count still lands somewhere.
test('#438 a cap that is not a number neither throws nor loses a count', () => {
  const map = {}

  for (const cap of [undefined, Number.NaN, 'four']) bumpBounded(map, 'chat', cap)

  assert.equal(map.chat, 3, 'the count lands on its own key, because the cap bounded nothing')
  assert.doesNotThrow(() => bumpBounded({}, 'chat', null), 'and a cap that is not a number is not an error')
})

test('#438 the helper answers the map it was handed, and writes no copy', () => {
  const map = { held: 1 }

  const same = bumpBounded(map, 'held', 4)

  assert.equal(same, map, 'the map comes back, so a caller may count and read in one expression')
  assert.equal(map.held, 2, 'and the count landed on the caller\'s own object')
})

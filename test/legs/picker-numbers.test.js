// #417: the numbers #415 could not reach are the front leg's, because the leg is
// where the frame is written and where the picker connection lives.
//
// Four of them, and each is measured at the only place that knows it: the bytes at
// the buffer handed to the socket, the picker's duration on the connection's own
// context, a refusal's reason at the site that refuses, and the dialog's size from
// the one encode that also writes it.
//
// The seams below are exported for exactly this: the leg itself is reached only
// through a listening server, and a number that only a listening server can be
// asked about is a number no test reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import mc from 'minecraft-protocol'

import { bumpReason, elapsedSince, encodeFrame, MAX_REFUSAL_REASONS } from '../../src/legs/live-front.js'
import { bumpBounded, OVERFLOW_KEY } from '../../src/core/bounded-counter.js'
import { pickerDialogParams, pickerRows } from '../../src/core/picker.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'legs', 'live-front.js'), 'utf8')
const VERSION = '26.1'

// A row is named for the host:port its claim dials (GLOSSARY.md, *Allowed server*),
// and pickerRows derives the slug and the id from that name.
const ROWS = pickerRows([
  { name: 'paper:25565' },
  { name: 'sky:25565' }
])

function serializer (state = 'configuration') {
  return mc.createSerializer({ state, isServer: true, version: VERSION })
}

test("#417 the picker dialog's encoded size is the frame the codec builds", () => {
  const params = pickerDialogParams({ rows: ROWS })
  const { ok, buffer } = encodeFrame({ serializer: serializer(), name: 'show_dialog', params })

  assert.equal(ok, true)
  assert.ok(Buffer.isBuffer(buffer), 'the encode answers the bytes, not a length to trust separately')
  assert.deepEqual(buffer, serializer().createPacketBuffer({ name: 'show_dialog', params }),
    'and they are the frame the library itself encodes from the same params')
  assert.ok(buffer.length > 0, 'a dialog with two rows is more than a header')

  const wider = pickerDialogParams({ rows: [...ROWS, ...pickerRows([{ name: 'nether:25565' }])] })
  assert.ok(encodeFrame({ serializer: serializer(), name: 'show_dialog', params: wider }).buffer.length > buffer.length,
    'a third row costs bytes, so the number follows what the dialog carries')
})

test('#417 a frame the codec cannot build is absent, never a size of zero', () => {
  const params = pickerDialogParams({ rows: ROWS })

  assert.deepEqual(encodeFrame({ serializer: null, name: 'show_dialog', params }),
    { ok: false, buffer: null, error: 'no serializer for this connection' },
    'a connection with no serializer builds nothing, and says why')
  assert.equal(encodeFrame({ serializer: {}, name: 'show_dialog', params }).ok, false,
    'and neither does one whose serializer cannot encode a packet')

  const refused = encodeFrame({
    serializer: { createPacketBuffer () { throw new Error('no such frame in this state') } },
    name: 'show_dialog',
    params
  })
  assert.equal(refused.ok, false, 'a codec that refuses the frame answers nothing rather than failing the join')
  assert.equal(refused.error, 'no such frame in this state',
    'and the reason comes back with it, because an operator cannot guess at a codec refusal')
})

// The dialog is the one frame a picker connection is shown, so its size is the
// number a reader is looking for when they ask how large the picker is. It is
// written and measured from one encode: a second one could disagree with it.
test('#417 the picker dialog is written and measured from one encode', () => {
  const dialog = SOURCE.slice(SOURCE.indexOf('function sendPickerDialog'), SOURCE.indexOf('function handlePickerClick'))
  assert.ok(dialog.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.match(dialog, /encoded = encodeFrame\(/, 'the dialog is encoded once')
  assert.equal((dialog.match(/encodeFrame\(/g) ?? []).length, 1, 'and only once')
  assert.match(dialog, /client\.writeRaw\(encoded\.buffer\)/, 'the bytes written are the bytes measured')
  assert.match(dialog, /log\('pickerDialog', \{/, 'the pickerDialog record is still written')
  assert.match(dialog, /bytes: encoded\.buffer\.length/, 'and it carries the size it wrote')
  assert.match(dialog, /try \{\s*encoded = encodeFrame\(/, 'the params build is inside a guard too')
})

// #417: a refusal's reason, as a bounded map. The reasons are a closed set the leg
// already writes, and the cap is what keeps a lane from growing a map no reader
// asked for if one ever is not.
//
// #555: what the leg owns here is the cap it passes and the seam a reader counts
// through. The count-up, the overflow bucket and what an empty key becomes are
// src/core/bounded-counter.js's rule, and that rule is asserted once, in
// test/core/bounded-counter.test.js. Restating it here would leave one of the two
// stale the day the rule changes, and would read as coverage that proves the leg.
test('#417 the leg passes its own cap to the shared rule, and its map stops at that cap', () => {
  // As many distinct words as a reason can be, far past the cap, so a map that grew
  // one key per word would show it.
  const reasons = Array.from({ length: MAX_REFUSAL_REASONS * 50 }, (_, index) => 'reason-' + index)
  const leg = {}
  const shared = {}
  for (const reason of reasons) {
    bumpReason(leg, reason)
    bumpBounded(shared, reason, MAX_REFUSAL_REASONS)
  }

  assert.deepEqual(leg, shared,
    'the leg hands the shared rule its own cap, so the rule the map follows is the one in src/core/bounded-counter.js')
  assert.ok(Object.keys(leg).length <= MAX_REFUSAL_REASONS + 1,
    'and the map the leg hands a reader stops at that cap, with the one bucket the rule adds past it')
  assert.ok(leg[OVERFLOW_KEY] > 0,
    'and the cap is a bound that bites: a thousand words cannot fit under it, so the leg\'s number is headroom and not a second vocabulary')
})

// #417: the duration is one connection's. Both moments are the leg's: it sees the
// login, and it sees the pick on the same socket. A number keyed by player name
// cannot say which of two connections from one account picked.
test("#417 a connection's login-to-pick age is its own, and absent when it never logged in", () => {
  assert.equal(elapsedSince(1000, 4000), 3000, 'the pick came 3 s after the login')
  assert.equal(elapsedSince(null, 4000), null, 'a connection the leg never stamped has no age')
  assert.equal(elapsedSince(undefined, 4000), null)
  assert.equal(elapsedSince(Number.NaN, 4000), null)
  assert.equal(elapsedSince(4000, 1000), 0, 'a clock that stepped backwards is 0, never a negative age')
  assert.equal(elapsedSince(1000, 1000), 0, 'and a pick in the same millisecond is 0, which is real')
})

// The guard the four rest on: one helper writes the counters, so the total and the
// map by reason cannot disagree, and no call site can add a refusal to one without
// the other.
test('#417 every refusal the leg counts is counted once, through one helper', () => {
  assert.equal((SOURCE.match(/metrics\.pickerRefusals\+\+/g) ?? []).length, 1,
    'only the helper counts a refusal')
  assert.equal((SOURCE.match(/metrics\.pickerRefusalsByReason/g) ?? []).length, 1,
    'and only the helper writes the map by reason')

  const start = SOURCE.indexOf('function bumpPickerRefusal')
  assert.ok(start > 0, 'the helper exists')
  const helper = SOURCE.slice(start, start + 500)
  assert.match(helper, /bumpReason\(/, 'the helper is what bumps the map')

  // Seven refusal sites: the two dialogs the leg could not write, the click it could
  // not read, the two frames naming a server it does not offer, the claim the core
  // answers, and the Spectate landing's own refusals. The key each one passes is
  // asserted too, because a site swapped to the wrong word still counts and still
  // lies about why.
  const sites = [...SOURCE.matchAll(/bumpPickerRefusal\(([^)]*)\)/g)].map(match => match[1]).sort()
  assert.deepEqual(sites, [
    "'picker_unavailable'",
    "'picker_unavailable'",
    "'unknown_server'",
    "'unknown_server'",
    'action.reason',
    'outcome.reason',
    'reason'
  ].sort(), 'every refusal site counts, and each passes the reason its own record carries')

  // #435: the Spectate landing's four refusals are one site, the closure they all
  // return through, so a branch added there cannot refuse without counting. The
  // guard is the closure's own shape: it bumps, and it writes the record whose
  // reason the map is keyed by, so the count and the line cannot part ways.
  const landing = SOURCE.slice(SOURCE.indexOf('function landSpectator'), SOURCE.indexOf('function sendBodyConfiguration'))
  assert.ok(landing.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.match(landing, /const refused = reason => \{/, 'the refusals return through one closure')
  assert.match(landing, /bumpPickerRefusal\(reason\)/, 'and it is what counts them')
  assert.match(landing, /record\(client, 'spectateRefused', \{/, 'and what records them')
  assert.equal((landing.match(/watching: false/g) ?? []).length, 2,
    'the two shape literals are the answer the leg builds when it has no core, and the closure, and no branch builds a third')

  // #435: the landing is counted after the write that ends the client's phase. Before
  // it, a phase the leg could not end read as a landing and a refusal at once, and
  // `finish_failed` now counts as the refusal it is. No test can make that write
  // throw without reaching into the library's socket, so the order is the fact pinned.
  const landingCount = landing.indexOf('metrics.spectateLandings++')
  const landingWrite = landing.indexOf("client.write('finish_configuration'")
  assert.ok(landingWrite > 0, 'the write that ends the phase is still in this function')
  assert.ok(landingCount > landingWrite,
    'the landing is counted after the phase-end write, so a write that threw is not a landing')
})

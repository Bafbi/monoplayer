// The waits inside `createLoopbackLane`'s close, and the record the close writes
// that O68 reads.
//
// `close()` reports the timers a lane left armed, and the lane arms the last one
// behind the backend leg's own socket end: ending the backend leg is a fault, and a
// fault schedules a reconnect (`src/core/session.js:232`). So the close answers two
// questions before it reads, and the first one is not its own:
//
//   the leg's close()  has the socket the close ended ended? The leg answers that
//                itself since #662: its close() resolves once the socket reported its
//                own end, bound and destroy included, and `rig.close()` awaits it
//                (`src/ladder/rig.js:148`). The lane takes that answer and holds no
//                wait of its own (#711). Its copy was invisible from outside — a
//                listener answers the same event the leg's promise does — so the
//                first case below reads the shape rather than the timing.
//   drainTimers  what is still armed after that? Dropping once and reading once
//                reports an arm that lands behind the drop as a timer the lane left
//                running, which is the same failure one window later (#661).
//
// No case here opens a socket. One case reads the lane's source, because the fact it
// holds is the shape of the close; the rest read `laneClock`, the ledger `close()`
// drains. The socket-level claim is O68 in `src/ladder/loopback.js`, and it costs the
// rung a fake backend, a real client and a journal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLoopbackLane, drainTimers, laneClock, droppedReconnect } from '../../src/ladder/loopback-lane.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'

const VERSION = '26.1'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LANE = 'src/ladder/loopback-lane.js'
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// A comment is not a read: a module that explains why it holds no listener wires
// nothing. Only whole-line comments are dropped, as test/ladder/rig.test.js and
// test/tooling/env-var-pages.test.js drop them.
const code = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

// One turn of the event loop, as the close takes them.
const turn = () => new Promise(resolve => setTimeout(resolve, 0))

// The front leg refuses to build with no whitelist, so a lane that serves nobody still
// names one entry: the client the cases below never open.
const WHITELIST = [offlineUuid('Attach')]

// #711: the lane's close takes the socket end from the leg's own close(), and holds
// no wait of its own. The second copy was not a behaviour a case could catch: a
// listener on `leg.client` answers the same event the leg's promise answers, so
// every close this repo drives passes either way, and the two homes drift apart with
// nothing red. The shape is what is left to hold, and the shape is two lines: a
// handler registered for the event, and the reach through `leg.client` that finds the
// socket to register it on.
test('the lane close takes the leg answer and keeps no listener of its own (#711)', () => {
  const source = code(read(LANE))

  const listeners = [...source.matchAll(/\.(on|once|addListener|prependListener|prependOnceListener)\(\s*['"]end['"]/g)]
    .map(match => match[0])
  assert.deepEqual(listeners, [],
    LANE + ' registers ' + listeners.join(', ') + ' for a socket end. Its two sockets ' +
    "are answered elsewhere: the bot's by client.close(), and the backend leg's by the " +
    'leg\'s own close(), which rig.close() awaits (src/ladder/rig.js:148). A handler ' +
    'here is the second home of one fact, and this file\'s copy is the one that ' +
    "drifted (#662, #711). The lane's own wait is on the record, and it is drainTimers.")

  const reaches = [...source.matchAll(/\bleg\??\.client\b/g)].map(match => match[0])
  assert.deepEqual(reaches, [],
    LANE + ' reaches ' + reaches.join(', ') + ". A leg's socket is the leg's to end " +
    'and to answer; a lane that holds the client ' +
    'is a lane that can read a socket the leg has already replaced with its next one, ' +
    'which is the reconnect #662 measured.')
})

// The other half of #711, and the line the whole wait rests on: the lane's close is the
// leg's answer because `rig.close()` awaits it (`src/ladder/rig.js:148`). Nothing else
// fails when that await goes: the leg's close never resolves in a case, so a lane that
// stopped waiting for it answers first and writes a record the dials have not filled.
// This case holds the answer open and reads the record on either side of it.
test('the lane close waits for the answer rig.close() takes from the leg (#711)', async (t) => {
  const lane = await createLoopbackLane({ name: 'laneRigClose', version: VERSION, whitelist: WHITELIST })
  let answer = null
  lane.backend.close = () => new Promise(resolve => { answer = resolve })
  t.after(async () => {
    answer?.()
    await lane.close()
  })

  let record = null
  const closing = lane.close().then(value => { record = value })
  // The bound is this case's own, not a wait: a lane that answers while the leg close
  // is pending has answered in milliseconds, and 500 ms is far past that.
  const early = await Promise.race([
    closing.then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('waiting'), 500))
  ])
  assert.equal(early, 'waiting',
    'the lane close answered while the leg close it asked for was still pending. ' +
    'src/ladder/rig.js:148 is the await the wait rests on, and without it the lane ' +
    'dials ports the rig has not closed and drains a ledger nothing has armed (#711).')
  assert.equal(record, null, 'and it wrote no record while the leg had not answered')

  answer()
  await closing
  assert.equal(record.closed, true, 'and wrote its record once the leg answered')
  assert.deepEqual(record.sockets.map(entry => entry.code), ['ECONNREFUSED', 'ECONNREFUSED'],
    'with both ports dialled after the rig closed, which is the order O68 reads')
})

test('a timer armed after the first drop is dropped by the next pass, and counted', async () => {
  // The ordering at `893ecb3`: the drop runs, and the arm lands behind it.
  const ledger = laneClock()
  ledger.clock.setTimeout(() => {}, 5)
  let passes = 0
  const { dropped, reading } = await drainTimers(ledger, {
    turn: async () => {
      passes += 1
      if (passes === 1) ledger.clock.setTimeout(() => {}, 5)
      await turn()
    }
  })

  assert.deepEqual(dropped.map(entry => entry.ms), [5, 5],
    'both timers are in the record, including the one the first drop could not see')
  assert.deepEqual(reading, [], 'nothing is armed once a pass arms nothing')
  assert.equal(passes, 2, 'the drain stopped at the pass that armed nothing')
})

test('a close that drops only the transfer chain timer dropped no reconnect', () => {
  // #663: the two shapes 40 real closes took at e7c5029. The chain reset is armed
  // by the backend's play login, 120 s before this close could matter, and the
  // teardown clears it on the leg's end; the reconnect backoff is the one the close
  // arms. Any dropped timer satisfied the old reading, so both shapes below passed
  // it while only the third is evidence that the close ended what it left.
  const chainOnly = { timersDropped: [{ id: 2, ms: 120_000 }], timersLeft: [] }
  const chainAndRetryLeft = {
    timersDropped: [{ id: 2, ms: 120_000 }],
    timersLeft: [{ id: 3, ms: 1000 }]
  }
  const named = { timersDropped: [{ id: 2, ms: 1000 }], timersLeft: [] }
  const both = {
    timersDropped: [{ id: 2, ms: 120_000 }, { id: 3, ms: 1000 }],
    timersLeft: []
  }

  assert.equal(droppedReconnect(chainOnly, { ms: 1000 }), false,
    'the chain reset the teardown already cleared is not the reconnect')
  assert.equal(droppedReconnect(chainAndRetryLeft, { ms: 1000 }), false,
    'a reconnect the record lists as still armed is not one its dropped list names')
  assert.equal(droppedReconnect(both, { ms: 1000 }), true,
    'the close dropped the backoff, and the delay names which')
  assert.equal(droppedReconnect({ timersDropped: [], timersLeft: [] }, { ms: 1000 }), false,
    'a close that armed nothing dropped no reconnect')
  assert.equal(droppedReconnect(named, {}), false,
    'a caller that names no delay gets no answer, so a miswired assertion fails')
  assert.equal(droppedReconnect(named, { ms: 0 }), false,
    'a zero delay names no backoff')
})

test('a clean close takes no turn at all', async () => {
  const ledger = laneClock()
  const { dropped, reading } = await drainTimers(ledger, {
    turn: async () => { throw new Error('a ledger with nothing armed needs no turn') }
  })
  assert.deepEqual(dropped, [])
  assert.deepEqual(reading, [])
})

test('a ledger that keeps arming is reported instead of spinning', async () => {
  // The bound is what keeps the reading falsifiable: a timer still armed when the
  // drain gives up is named in the record, so O68 fails on it rather than passing
  // on a close that dropped its way to silence.
  const ledger = laneClock()
  ledger.clock.setTimeout(() => {}, 5)
  const { reading } = await drainTimers(ledger, {
    turns: 3,
    turn: async () => { ledger.clock.setTimeout(() => {}, 5); await turn() }
  })
  assert.equal(reading.length, 1, 'the timer that escaped the bound is named')
  assert.equal(reading[0].ms, 5)
})

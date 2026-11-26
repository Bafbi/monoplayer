// The two waits inside `createLoopbackLane`'s close (#661), and the record the
// close writes that O68 reads (#663).
//
// `close()` reports the timers a lane left armed, and the lane arms the last one
// behind the backend leg's own socket end: ending the backend leg is a fault, and a
// fault schedules a reconnect (`src/core/session.js:232`). So the close answers two
// questions before it reads, and neither is a wait on the clock:
//
//   endOfLeg     has the socket the close ended ended? The leg's close() resolves
//                before that event once the leg is ended
//                (`src/legs/live-backend.js:679`), so one turn of the event loop is a
//                bet that the kernel has been read. On a public runner at
//                `893ecb3` it had not been, and O68 failed on a commit that passed
//                here (#661).
//   drainTimers  what is still armed after that? Dropping once and reading once
//                reports an arm that lands behind the drop as a timer the lane left
//                running, which is the same failure one window later.
//
// No case here opens a socket. The leg is an emitter, and the ledger is
// `laneClock`, the object `close()` reads. The socket-level claim is O68 in
// `src/ladder/loopback.js`, and it costs the rung a fake backend, a real client
// and a journal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { endOfLeg, drainTimers, laneClock, droppedReconnect } from '../../src/ladder/loopback-lane.js'

// One turn of the event loop, as the close takes them.
const turn = () => new Promise(resolve => setTimeout(resolve, 0))

test('the close waits for the backend leg to end, not for a number of turns', async () => {
  const client = new EventEmitter()
  let waited = null
  const waiting = endOfLeg({ client })
  const ending = waiting.then(value => { waited = value })

  // Two turns in, the wait has given up on nothing: a turn count is not what it
  // waits for, which is the whole of #661.
  await turn()
  await turn()
  assert.equal(waited, null, 'the close is still waiting for the socket it ended')
  assert.equal(client.listenerCount('end'), 1, 'one listener waits for the socket end')

  client.emit('end', 'proxy_stopped')
  assert.equal(await waiting, 'end')
  assert.equal(await ending, undefined)
  assert.equal(waited, 'end', 'the close learned the socket ended')
  assert.equal(client.listenerCount('end'), 0, 'the listener is gone once the socket ended')
})

test('a leg with no socket has no end to wait for', async () => {
  // A lane with no fake backend, or a leg that faulted earlier and dropped its
  // client: the event this waits for has already fired.
  assert.equal(await endOfLeg({ client: null }), 'none')
  assert.equal(await endOfLeg(null), 'none')
})

test('a socket that never ends still reaches the record', async () => {
  // The bound, not the event: a wedged peer must not hold the rung. The record is
  // still written, and the reading names whatever is armed.
  const client = new EventEmitter()
  assert.equal(await endOfLeg({ client }, { ms: 10 }), 'bound')
  assert.equal(client.listenerCount('end'), 0, 'the listener is gone once the bound passed')
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

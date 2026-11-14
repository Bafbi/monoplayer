// #201: the pre-auth window's total connection cap. The window runs from
// accepting a socket to the attach whitelist's accept, and this module holds the
// count and answers allow or refuse. The front leg owns the socket, the log line,
// and the counter; nothing here reads a clock or touches a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createPreAuthWindow,
  DEFAULT_MAX_CONNECTIONS,
  PREAUTH_REFUSAL
} from '../../src/core/preauth-window.js'

test('#201 the window admits up to its cap and refuses the connection over it', () => {
  const window = createPreAuthWindow({ maxConnections: 2 })

  assert.deepEqual(window.admit(), {
    admitted: true, reason: null, inWindow: 1, maxConnections: 2, refused: 0
  })
  assert.equal(window.admit().admitted, true, 'the second connection fits')

  const refused = window.admit()
  assert.equal(refused.admitted, false)
  assert.equal(refused.reason, PREAUTH_REFUSAL.CONNECTION_CAP, 'the cap has its own reason')
  assert.equal(refused.inWindow, 2, 'a refused connection never enters the window')
  assert.equal(refused.refused, 1)
  assert.equal(window.stats().inWindow, 2)
})

test('#201 a released slot is admitted again, which is why a session is never refused', () => {
  const window = createPreAuthWindow({ maxConnections: 1 })
  assert.equal(window.admit().admitted, true)
  assert.equal(window.admit().admitted, false)

  // The connection left the window (the whitelist accepted it, or its socket
  // ended). Its slot is free, so the next stranger is admitted like the first.
  assert.deepEqual(window.release(), { released: true, inWindow: 0 })
  assert.equal(window.admit().admitted, true)
  assert.equal(window.stats().refused, 1, 'the earlier refusal stays counted')
})

test('#201 every refusal is counted, and only the first of a saturated window asks to be logged', () => {
  const window = createPreAuthWindow({ maxConnections: 1 })
  window.admit()

  // One flood attempt after another. The count is the operator's evidence; the
  // log line is what a reader sees, and a line per attempt makes the log the
  // second flood.
  const first = window.admit()
  const second = window.admit()
  const third = window.admit()

  assert.equal(first.first, true, 'the window that just filled is logged once')
  assert.equal(second.first, false)
  assert.equal(third.first, false)
  assert.equal(third.refused, 3, 'all three attempts are counted')
  assert.equal(window.stats().refused, 3)
})

test('#201 a window that is no longer full logs its next refusal again', () => {
  const window = createPreAuthWindow({ maxConnections: 2 })
  window.admit()
  window.admit()
  assert.equal(window.admit().first, true)

  window.release()
  // One slot free and the burst ended: the next refusal is a new window's first,
  // so a second attack is visible in the log instead of being swallowed.
  assert.equal(window.admit().admitted, true, 'the free slot is taken')
  assert.equal(window.admit().first, true, 'the window filled again, so it is logged again')
})

test('#201 a stray release never makes the window wider than its cap', () => {
  const window = createPreAuthWindow({ maxConnections: 1 })
  assert.deepEqual(window.release(), { released: false, inWindow: 0 })
  assert.equal(window.admit().admitted, true)
  window.release()
  window.release()
  assert.equal(window.stats().inWindow, 0)
  assert.equal(window.admit().admitted, true)
  assert.equal(window.admit().admitted, false, 'a double release did not buy a second slot')
})

test('#201 stats reports the window without handing out the internals', () => {
  const window = createPreAuthWindow({ maxConnections: 3 })
  window.admit()
  const stats = window.stats()
  assert.deepEqual(stats, { inWindow: 1, maxConnections: 3, refused: 0 })
  stats.inWindow = 99
  assert.equal(window.stats().inWindow, 1, 'a reader cannot move the count')
})

test('#201 a cap that cannot bound anything refuses to build', () => {
  for (const bad of [0, -1, 1.5, '8', null, NaN]) {
    assert.throws(() => createPreAuthWindow({ maxConnections: bad }),
      /maxConnections must be a positive integer/, JSON.stringify(bad))
  }
})

test('#201 the default is conservative, and a window built without a number uses it', () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_CONNECTIONS), true)
  // Two players, their status pings, and a burst's headroom. The rungs drive one
  // bot at a time, and the dev lane and the gate Paper carry one player, so the
  // default must sit above a busy lane and below a flood.
  assert.ok(DEFAULT_MAX_CONNECTIONS >= 8, 'a busy lane with a ping each must fit')
  assert.ok(DEFAULT_MAX_CONNECTIONS <= 64, 'a cap of hundreds bounds nothing')
  assert.equal(createPreAuthWindow().stats().maxConnections, DEFAULT_MAX_CONNECTIONS)
})

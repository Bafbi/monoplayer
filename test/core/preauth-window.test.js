// #201: the pre-auth window's total connection cap, and #205: its deadline. The
// window runs from accepting a socket to the attach whitelist's accept, and this
// module holds the count, answers allow or refuse, and names a connection that
// stayed too long. The front leg owns the socket, the timer, the log line, and
// the counter. Nothing here reads a clock or touches a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createPreAuthWindow,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_CONNECTIONS,
  MAX_DEADLINE_MS,
  PREAUTH_CLOSE_REASON
} from '../../src/core/preauth-window.js'

test('#201 the window admits up to its cap and refuses the connection over it', () => {
  const window = createPreAuthWindow({ maxConnections: 2 })

  assert.deepEqual(window.admit(), { admitted: true, reason: null, inWindow: 1 })
  assert.equal(window.admit().admitted, true, 'the second connection fits')

  const refused = window.admit()
  assert.equal(refused.admitted, false)
  assert.equal(refused.reason, PREAUTH_CLOSE_REASON.CONNECTION_CAP, 'the cap has its own reason')
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

  // One attempt after another. The count is the operator's evidence. The log
  // line is what a reader sees, so a burst writes one line, not thousands.
  const first = window.admit()
  const second = window.admit()
  const third = window.admit()

  assert.equal(first.shouldLog, true, 'the window that just filled is logged once')
  assert.equal(second.shouldLog, false)
  assert.equal(third.shouldLog, false)
  assert.equal(third.refused, 3, 'all three attempts are counted')
  assert.equal(window.stats().refused, 3)
})

test('#201 a window that is no longer full logs its next refusal again', () => {
  const window = createPreAuthWindow({ maxConnections: 2 })
  window.admit()
  window.admit()
  assert.equal(window.admit().shouldLog, true)

  window.release()
  // One slot free and the burst ended: the next refusal is a new window's first,
  // so a second attack is visible in the log instead of being swallowed.
  assert.equal(window.admit().admitted, true, 'the free slot is taken')
  assert.equal(window.admit().shouldLog, true, 'the window filled again, so it is logged again')
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
  assert.deepEqual(stats, {
    inWindow: 1,
    maxConnections: 3,
    deadlineMs: DEFAULT_DEADLINE_MS,
    refused: 0,
    expired: 0
  })
  stats.inWindow = 99
  assert.equal(window.stats().inWindow, 1, 'a reader cannot move the count')
})

test('#201 a cap that cannot bound anything refuses to build', () => {
  for (const bad of [0, -1, 1.5, '8', null, NaN]) {
    assert.throws(() => createPreAuthWindow({ maxConnections: bad }),
      /maxConnections must be a positive integer/, JSON.stringify(bad))
  }
})

test('#205 an expiry has its own reason, and every close is counted', () => {
  const window = createPreAuthWindow({ maxConnections: 1 })
  window.admit()

  // The leg's timer fired: the connection is still in the window and its socket
  // is about to be destroyed.
  const first = window.expire()
  const second = window.expire()

  assert.equal(first.reason, PREAUTH_CLOSE_REASON.DEADLINE, 'a stuck window has its own reason')
  assert.notEqual(PREAUTH_CLOSE_REASON.DEADLINE, PREAUTH_CLOSE_REASON.CONNECTION_CAP,
    'an operator can tell a flood from a stuck one')
  assert.equal(first.expired, 1)
  assert.equal(second.expired, 2)
})

test('#205 no expiry is held back, because the window bounds how many there can be', () => {
  const window = createPreAuthWindow({ maxConnections: 2 })
  window.admit()
  window.admit()

  // The cap logs one line per saturated window because a flood writes thousands
  // of refusals a second. The deadline cannot: the window admits at most
  // maxConnections at once, so one deadline period produces at most that many
  // lines. Holding them back would cost an operator the only signal a sustained
  // attack gives, because staggered silent sockets never let the window empty.
  assert.equal('shouldLog' in window.expire(), false, 'the policy never suppresses an expiry')
  window.release()
  assert.equal('shouldLog' in window.expire(), false)
})

test('#205 a deadline that cannot bound anything refuses to build', () => {
  for (const bad of [0, -1, 1.5, '8', null, NaN, Infinity]) {
    assert.throws(() => createPreAuthWindow({ deadlineMs: bad }),
      /deadlineMs must be an integer between 1 and/, JSON.stringify(bad))
  }
  assert.equal(createPreAuthWindow({ deadlineMs: 1000 }).stats().deadlineMs, 1000,
    'the window carries the deadline it was built with')
})

test('#205 a deadline past what a timer can hold is refused, not fired at once', () => {
  // Node clamps a delay above MAX_DEADLINE_MS to 1 ms and warns. A deadline like
  // that would destroy every admitted connection the moment it arrived, which is
  // the lockout this bound exists to prevent.
  assert.equal(MAX_DEADLINE_MS, 2_147_483_647)
  for (const bad of [MAX_DEADLINE_MS + 1, 3_000_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createPreAuthWindow({ deadlineMs: bad }),
      /deadlineMs must be an integer between 1 and/, JSON.stringify(bad))
  }
  assert.equal(createPreAuthWindow({ deadlineMs: MAX_DEADLINE_MS }).stats().deadlineMs,
    MAX_DEADLINE_MS, 'the largest delay a timer holds is still a deadline')
})

test('#205 the default deadline is conservative, and a window built without one uses it', () => {
  assert.equal(Number.isInteger(DEFAULT_DEADLINE_MS), true)
  // A real login is a handshake, an encryption round trip and one hasJoined
  // call, and it leaves the window at the whitelist's accept. The default must
  // sit far above that on a slow tunnel, and below the point where a silent
  // socket has taken the front offline for a noticeable while.
  assert.ok(DEFAULT_DEADLINE_MS >= 10_000, 'a slow but real login must never be cut')
  assert.ok(DEFAULT_DEADLINE_MS <= 120_000, 'a deadline of minutes bounds nothing an operator notices')
  assert.equal(createPreAuthWindow().stats().deadlineMs, DEFAULT_DEADLINE_MS,
    'a window built without a deadline uses the compiled one')
})

test('#201 the default is conservative, and a window built without a number uses it', () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_CONNECTIONS), true)
  // A player, a status ping, and a burst's headroom. The rungs drive one bot at
  // a time and the dev lane and the gate Paper serve one attach at a time, so the
  // default must sit above a busy lane and below a flood.
  assert.ok(DEFAULT_MAX_CONNECTIONS >= 8, 'a busy lane with a ping each must fit')
  assert.ok(DEFAULT_MAX_CONNECTIONS <= 64, 'a cap of hundreds bounds nothing')
  assert.equal(createPreAuthWindow().stats().maxConnections, DEFAULT_MAX_CONNECTIONS)
})

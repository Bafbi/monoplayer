// Reconnect wiring: the session schedules exactly one reconnect, the core
// announces it once as reconnect_due, and a failed reconnect fails closed.
// Fake legs + an injected clock: no sockets, no real timers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSession, STATES } from '../../src/core/session.js'
import { fakeClock, makeCore } from '../support/harness.js'

// Bring a fake core to warm with one real backend login.
function warm (core, backend) {
  backend.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  backend.deliver({ state: 'play', name: 'chunk_batch_finished', data: { batchSize: 1 } })
}

test('backendDown schedules exactly one onReconnect; a second fault adds none', () => {
  const clock = fakeClock()
  const calls = []
  const s = createSession({
    clock,
    reconnectDelayMs: 1000,
    onReconnect: payload => calls.push(payload)
  })
  s.backendLogin({})
  s.warmComplete({})

  s.backendDown({ reason: 'drop' })
  s.backendDown({ reason: 'drop_again' })
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1, 'a second fault while reconnecting must not arm a timer')
  assert.equal(calls.length, 0, 'the callback waits for the timer')

  clock.tick(1000)
  assert.deepEqual(calls, [{ delayMs: 1000, attempt: 1 }], 'exactly one callback per scheduled reconnect')
  assert.equal(s.state, STATES.BOOT)
  assert.equal(clock.pending, 0)

  // The fired attempt fails again: the session fails closed, no new callback.
  s.backendDown({ reason: 'refused' })
  assert.equal(s.state, STATES.FAILED)
  assert.equal(calls.length, 1)
})

test('a retry policy keeps reconnecting with capped backoff until the budget runs out', () => {
  const clock = fakeClock()
  const calls = []
  const s = createSession({
    clock,
    reconnectDelayMs: 1000,
    reconnectPolicy: { attempts: 3, maxDelayMs: 5000 },
    onReconnect: payload => calls.push(payload)
  })
  s.backendLogin({})
  s.warmComplete({})

  s.backendDown({ reason: 'drop' })
  assert.equal(clock.pending, 1)

  clock.tick(1000)
  assert.deepEqual(calls, [{ delayMs: 1000, attempt: 1 }])
  assert.equal(s.state, STATES.BOOT)

  // The fired attempt failed before the play login: back off and retry.
  s.backendDown({ reason: 'refused' })
  assert.equal(s.state, STATES.RECONNECTING)
  clock.tick(2000)
  assert.deepEqual(calls.at(-1), { delayMs: 2000, attempt: 2 })
  assert.equal(s.state, STATES.BOOT)

  s.backendDown({ reason: 'refused_again' })
  clock.tick(4000)
  assert.deepEqual(calls.at(-1), { delayMs: 4000, attempt: 3 })

  // Budget exhausted: fail closed, no fourth timer.
  s.backendDown({ reason: 'still_down' })
  assert.equal(s.state, STATES.FAILED)
  assert.equal(clock.pending, 0)
  assert.equal(calls.length, 3)
})

test('a successful reconnect resets the backoff budget', () => {
  const clock = fakeClock()
  const calls = []
  const s = createSession({
    clock,
    reconnectDelayMs: 1000,
    reconnectPolicy: { attempts: 2, maxDelayMs: 60_000 },
    onReconnect: payload => calls.push(payload)
  })
  s.backendLogin({})
  s.warmComplete({})

  s.backendDown({ reason: 'drop' })
  clock.tick(1000)
  s.backendDown({ reason: 'refused' })
  clock.tick(2000)
  assert.equal(calls.length, 2)

  s.backendLogin({ entityId: 7 }) // the second attempt succeeded
  s.backendDown({ reason: 'later_drop' })
  clock.tick(1000)
  assert.deepEqual(calls.at(-1), { delayMs: 1000, attempt: 1 }, 'back to the base delay')
})

test('a rescinded reconnect never calls onReconnect', () => {
  const clock = fakeClock()
  const calls = []
  const s = createSession({
    clock,
    reconnectDelayMs: 1000,
    onReconnect: payload => calls.push(payload)
  })
  s.backendLogin({})
  s.warmComplete({})

  s.backendDown({ reason: 'timeout' })
  s.backendUp()
  clock.tick(10_000)
  assert.equal(calls.length, 0)
  assert.equal(s.state, STATES.BOOT)
})

test('core emits one reconnect_due and the next backend login returns WARM', () => {
  const clock = fakeClock()
  const { core, backendLeg: backend, events: dues } = makeCore({ clock })
  warm(core, backend)
  assert.equal(core.session.state, STATES.WARM)
  assert.equal(core.session.backendLogins, 1)

  backend.deliverEnd({ reason: 'drop' })
  backend.deliverEnd({ reason: 'drop_again' })
  assert.equal(core.session.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1)
  assert.equal(dues.length, 0)

  clock.tick(1000)
  assert.deepEqual(dues, [{ delayMs: 1000, attempt: 1, target: null }])
  assert.equal(core.session.state, STATES.BOOT)

  // A fresh backend login finishes the one reconnect.
  backend.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  assert.equal(core.session.state, STATES.WARM)
  assert.equal(core.session.backendLogins, 2)
  assert.equal(dues.length, 1, 'still exactly one reconnect_due')
})

test('fail() after a failed reconnect reaches FAILED', () => {
  const clock = fakeClock()
  const { core, backendLeg: backend } = makeCore({ clock })
  warm(core, backend)

  backend.deliverEnd({ reason: 'drop' })
  clock.tick(1000) // the one reconnect fires; the attempt is now in BOOT
  assert.equal(core.session.state, STATES.BOOT)

  core.session.fail()
  assert.equal(core.session.state, STATES.FAILED)
  assert.equal(core.session.backendLogins, 1)
})

test('a fault during the fired attempt fails closed without another timer', () => {
  const clock = fakeClock()
  const { core, backendLeg: backend, events: dues } = makeCore({ clock })
  warm(core, backend)

  backend.deliverEnd({ reason: 'drop' })
  clock.tick(1000)
  backend.deliverEnd({ reason: 'refused' })

  assert.equal(core.session.state, STATES.FAILED)
  assert.equal(clock.pending, 0)
  assert.equal(dues.length, 1)
})

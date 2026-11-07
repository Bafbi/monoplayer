// Reconnect wiring: the session schedules exactly one reconnect, the core
// announces it once as reconnect_due, and a failed reconnect fails closed.
// Fake legs + an injected clock: no sockets, no real timers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMonoplayer, loadConfig } from '../src/monoplayer.js'
import { createSession, STATES } from '../src/monoplayer/session.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../src/monoplayer/fake-legs.js'

function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) {
      const timer = { fn, fires: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimeout (timer) { timers = timers.filter(t => t !== timer) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

function buildCore (clock) {
  const backend = createFakeBackendLeg()
  const front = createFakeFrontLeg()
  const core = createMonoplayer({
    config: loadConfig(),
    backendLeg: backend,
    frontLeg: front,
    clock
  })
  const dues = []
  core.on('reconnect_due', payload => dues.push(payload))
  core.start()
  return { core, backend, front, dues }
}

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
  assert.deepEqual(calls, [{ delayMs: 1000 }], 'exactly one callback per scheduled reconnect')
  assert.equal(s.state, STATES.BOOT)
  assert.equal(clock.pending, 0)

  // The fired attempt fails again: the session fails closed, no new callback.
  s.backendDown({ reason: 'refused' })
  assert.equal(s.state, STATES.FAILED)
  assert.equal(calls.length, 1)
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
  const { core, backend, dues } = buildCore(clock)
  warm(core, backend)
  assert.equal(core.session.state, STATES.WARM)
  assert.equal(core.session.backendLogins, 1)

  backend.deliverEnd({ reason: 'drop' })
  backend.deliverEnd({ reason: 'drop_again' })
  assert.equal(core.session.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1)
  assert.equal(dues.length, 0)

  clock.tick(1000)
  assert.deepEqual(dues, [{ delayMs: 1000 }])
  assert.equal(core.session.state, STATES.BOOT)

  // A fresh backend login finishes the one reconnect.
  backend.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  assert.equal(core.session.state, STATES.WARM)
  assert.equal(core.session.backendLogins, 2)
  assert.equal(dues.length, 1, 'still exactly one reconnect_due')
})

test('fail() after a failed reconnect reaches FAILED', () => {
  const clock = fakeClock()
  const { core, backend } = buildCore(clock)
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
  const { core, backend, dues } = buildCore(clock)
  warm(core, backend)

  backend.deliverEnd({ reason: 'drop' })
  clock.tick(1000)
  backend.deliverEnd({ reason: 'refused' })

  assert.equal(core.session.state, STATES.FAILED)
  assert.equal(clock.pending, 0)
  assert.equal(dues.length, 1)
})

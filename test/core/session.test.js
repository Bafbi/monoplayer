// B1 target: session state machine (pure, fake clock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, STATES } from '../../src/core/session.js'

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

const PLAYER = 'player-uuid'

test('boot -> warm -> attach -> detach -> reattach keeps backendLogins === 1', () => {
  const s = createSession()
  assert.equal(s.state, STATES.BOOT)
  assert.equal(s.isAttachReady(), false)

  s.backendLogin({ entityId: 42 })
  assert.equal(s.state, STATES.WARM)
  assert.equal(s.backendLogins, 1)

  // attach before warm completion is rejected
  assert.equal(s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' }).reason, 'not_ready')

  s.warmComplete({ prefixFrames: 6 })
  assert.equal(s.isAttachReady(), true)

  assert.equal(s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' }).accepted, true)
  assert.equal(s.state, STATES.ATTACHED)

  // second attach while attached: clear single-attach failure
  assert.equal(s.attachAttempt({ uuid: 'other', name: 'Other' }).reason, 'already_attached')
  assert.equal(s.attachCount, 1)

  s.detach({ reason: 'player_quit' })
  assert.equal(s.state, STATES.DETACHED)
  assert.equal(s.detachCount, 1)

  // the whole attach/detach cycle: backendLogins untouched
  assert.equal(s.backendLogins, 1)

  assert.equal(s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' }).accepted, true)
  assert.equal(s.attachCount, 2)
  assert.equal(s.backendLogins, 1)
  assert.equal(s.state, STATES.ATTACHED)
})

test('backend fault: exactly one reconnect scheduled, never a loop', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })

  s.backendLogin({}); s.warmComplete({})
  assert.equal(s.backendLogins, 1)

  s.backendDown({ reason: 'test_end' })
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1)

  // A second fault while reconnecting is recorded, not re-armed.
  const again = s.backendDown({ reason: 'test_end_again' })
  assert.equal(again.scheduled, false)
  assert.equal(clock.pending, 1)

  // attach attempt during the gap: clear failure
  assert.equal(s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' }).reason, 'backend_down')

  // the single reconnect fires
  clock.tick(1000)
  assert.equal(s.state, STATES.BOOT)
  assert.equal(clock.pending, 0)
  assert.equal(s.backendLogins, 1)

  // fresh backend login completes the one reconnect: backendLogins === 2 total
  s.backendLogin({})
  assert.equal(s.state, STATES.WARM)
  assert.equal(s.backendLogins, 2)
  const events = s.events()
  assert.equal(events.filter(e => e.type === 'reconnect_scheduled').length, 1)
})

test('backend back up before the timer fires: reconnect rescinded, no timer leak', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})

  s.backendDown({ reason: 'timeout' })
  s.backendUp()
  assert.equal(s.state, STATES.BOOT)
  assert.equal(clock.pending, 0)

  // backendUp after the fact is a no-op
  const after = s.backendUp()
  assert.equal(after.ignored, true)

  clock.tick(10_000)
  assert.equal(s.state, STATES.BOOT) // stayed; no rogue reconnect fired
})

test('reconnect attempt fails again: fail-closed, no infinite loop', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.backendDown({ reason: 'kick' })

  clock.tick(1000) // reconnect fires -> BOOT (attempt in progress)
  // the reset connect fails again ("initial"-style boot failure, has logins)
  s.backendDown({ reason: 'refused' })
  assert.equal(s.state, STATES.FAILED)
  assert.equal(clock.pending, 0)
})

test('initial backend connect could not be made: fail fast, no reconnect', () => {
  const clock = fakeClock()
  const s = createSession({ clock })
  s.backendDown({ reason: 'connection_refused' })
  assert.equal(s.state, STATES.FAILED)
  assert.equal(clock.pending, 0)
  assert.equal(s.backendLogins, 0)
})

test('backend fault while attached: front is ended and counted detached', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })

  s.setPose({ x: 9.5, y: 1.62, z: 9.5 })
  const outcome = s.backendDown({ reason: 'SIGKILL' })
  assert.equal(outcome.wasAttached, true)
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(s.detachCount, 1)
  // pose survives the fault for the diagnostic trail
  assert.equal(s.currentPose.x, 9.5)
})

test('pose lifecycle across attach/detach/reattach', () => {
  const s = createSession()
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.setPose({ x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 })
  const detached = s.detach({})
  assert.deepEqual(detached.pose, { x: 2.5, y: 1.62, z: 3.5, yaw: 90, pitch: 10 })
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  assert.equal(s.currentPose.x, 2.5)
})

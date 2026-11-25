// B1 target: session state machine (pure, fake clock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, STATES } from '../../src/core/session.js'
import { fakeClock } from '../support/harness.js'

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

// #261: a body nobody claims stays down. A claim is the reason to keep a
// session, so a lane whose body nobody holds does not pay for a retry: the fault
// lands in `down`, which is a body a claim may dial again and no client may enter.
test('#261 a body nobody claims stays down when its session faults, and arms no retry', () => {
  const clock = fakeClock()
  const s = createSession({ clock, claimHeld: () => false })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.detach({ reason: 'player_quit' })
  assert.equal(s.state, STATES.DETACHED)

  const outcome = s.backendDown({ reason: 'body_fault' })
  assert.equal(s.state, STATES.DOWN)
  assert.equal(outcome.scheduled, false)
  assert.equal(outcome.unclaimed, true)
  assert.equal(clock.pending, 0, 'no retry is armed for a body nobody holds')
  assert.equal(s.isAttachReady(), false, 'nothing may attach to a body that is down')

  // A claim is what brings it back: the dial is the entry the first one used.
  s.backendConnecting({ initial: true })
  assert.equal(s.state, STATES.BOOT)
  s.backendLogin({})
  assert.equal(s.state, STATES.WARM)
})

test('#261 a body whose claim is held still reconnects, and stops when the claim goes', () => {
  const clock = fakeClock()
  let claimed = true
  const s = createSession({ clock, reconnectDelayMs: 1000, claimHeld: () => claimed })
  s.backendLogin({}); s.warmComplete({})
  s.detach({ reason: 'player_quit' })

  // Nobody is attached, and a claim is held: this is #295's parked claimant, and
  // the body is kept for it exactly as it was before this rule.
  const outcome = s.backendDown({ reason: 'body_fault' })
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(outcome.scheduled, true)
  assert.equal(clock.pending, 1)

  // The claim ends while the retry is pending. The retry that fires has no body
  // to come back to, so the attempt it spends is the last one.
  claimed = false
  clock.tick(1000)
  assert.equal(s.state, STATES.BOOT)
  const failed = s.backendDown({ reason: 'connection_refused' })
  assert.equal(s.state, STATES.DOWN)
  assert.equal(failed.scheduled, false)
  assert.equal(clock.pending, 0)
})

test('#261 a lane with no claim board keeps today\'s reconnect contract', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.detach({ reason: 'player_quit' })

  // No oracle: the lane has no picker, so no claim exists to keep or drop the
  // body, and the fault contract is the one every lane had before this rule.
  s.backendDown({ reason: 'body_fault' })
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1)
})

test('#261 a body can be ended on request, and a claim is what brings it back', () => {
  const clock = fakeClock()
  const s = createSession({ clock, claimHeld: () => false })
  s.backendLogin({}); s.warmComplete({})

  const ended = s.end({ reason: 'requested' })
  assert.equal(ended.ended, true)
  assert.equal(ended.reason, 'requested')
  assert.equal(s.state, STATES.DOWN)
  assert.equal(clock.pending, 0)
  assert.equal(s.isAttachReady(), false)
  // The transition says why the body is down, and the oracle is what it asked: a
  // reader of the run does not have to guess whether a claim was in the way.
  const down = s.events().filter(event => event.to === STATES.DOWN).at(-1)
  assert.equal(down.unclaimed, true, 'nobody claimed the body that was ended')

  s.backendConnecting({ initial: true })
  assert.equal(s.state, STATES.BOOT)
})

test('#261 a body a driver holds cannot be ended on request', () => {
  const s = createSession()
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })

  const ended = s.end({ reason: 'requested' })
  assert.equal(ended.ended, false)
  assert.equal(ended.reason, 'client_attached')
  assert.equal(s.state, STATES.ATTACHED, 'the driver keeps the body they are standing in')
  assert.equal(s.isAttachReady(), false)
})

test('#261 a fault while the body is down is recorded, and dials nothing', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000, claimHeld: () => false })
  s.backendLogin({}); s.warmComplete({})
  s.backendDown({ reason: 'body_fault' })
  assert.equal(s.state, STATES.DOWN)

  // The socket of the session that ended reports its close late. It belongs to a
  // body that is not there, so it arms no second timer and announces nothing.
  const late = s.backendDown({ reason: 'socket_closed' })
  assert.equal(late.scheduled, false)
  assert.equal(s.state, STATES.DOWN)
  assert.equal(clock.pending, 0)
  assert.equal(s.events().filter(event => event.type === 'fault_while_down').length, 1)
})

test('#261 an oracle that throws keeps the body, because nobody can be asked', () => {
  const clock = fakeClock()
  const s = createSession({
    clock,
    reconnectDelayMs: 1000,
    claimHeld: () => { throw new Error('claim board unreadable') }
  })
  s.backendLogin({}); s.warmComplete({})
  s.detach({ reason: 'player_quit' })

  const outcome = s.backendDown({ reason: 'body_fault' })
  assert.equal(outcome.scheduled, true, 'a body nobody can be asked about is kept, not dropped')
  assert.equal(s.state, STATES.RECONNECTING)
  assert.equal(clock.pending, 1)
  const failure = s.events().filter(event => event.type === 'claim_oracle_failed').at(-1)
  assert.equal(failure.error, 'claim board unreadable')
})

test('#261 ending a body cancels the retry it had armed', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.backendDown({ reason: 'body_fault' })
  assert.equal(clock.pending, 1)

  const ended = s.end({ reason: 'requested' })
  assert.equal(ended.ended, true)
  assert.equal(ended.cancelled, true)
  assert.equal(clock.pending, 0, 'the armed retry is cleared, not left to fire at a body that ended')
  clock.tick(60_000)
  assert.equal(s.state, STATES.DOWN)
  assert.equal(s.backendLogins, 1)
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

test('a followed transfer keeps the client and ends at the target login', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })

  const started = s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  assert.equal(started.started, true)
  assert.equal(s.state, STATES.TRANSFERRING)
  assert.equal(s.transferring, true)
  // The client holds the slot through the move: a second attach is refused,
  // and the session is not attach-ready for a fresh one.
  assert.equal(s.attachAttempt({ uuid: 'other', name: 'Other' }).reason, 'already_attached')
  assert.equal(s.isAttachReady(), false)

  // The backend end under the move is not a detach: one reconnect is armed
  // and the client stays.
  const down = s.backendDown({ reason: 'backend_transfer', retainFront: true })
  assert.equal(down.retained, true)
  assert.equal(down.wasAttached, true)
  assert.equal(s.state, STATES.TRANSFERRING)
  assert.equal(s.detachCount, 0)
  assert.equal(clock.pending, 1)

  // The dial starts and the target's play login lands on the retained client.
  clock.tick(1000)
  assert.equal(s.state, STATES.TRANSFERRING, 'the fired reconnect keeps a retained client')
  s.backendConnecting({ initial: false })
  assert.equal(s.state, STATES.TRANSFERRING)
  const login = s.backendLogin({ entityId: 7 })
  assert.equal(login.fromTransfer, true)
  assert.equal(s.state, STATES.ATTACHED)

  const done = s.transferComplete()
  assert.equal(done.completed, true)
  assert.equal(s.state, STATES.ATTACHED)
  assert.equal(s.backendLogins, 2)
  assert.equal(s.detachCount, 0)
})

test('a failed target restores the client and arms one reconnect to the base', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000 })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  s.backendDown({ reason: 'backend_transfer', retainFront: true })
  clock.tick(1000)

  const failed = s.transferFailed({ reason: 'target_unreachable' })
  assert.equal(failed.failed, true)
  assert.equal(failed.restored, true)
  assert.equal(s.state, STATES.ATTACHED, 'the client keeps its connection')
  assert.equal(s.detachCount, 0)
  assert.equal(clock.pending, 1, 'one reconnect goes back to the configured backend')

  // The returning backend login does not move the restored client back to warm.
  s.backendConnecting({ initial: false })
  const login = s.backendLogin({ entityId: 42 })
  assert.equal(login.restored, true)
  assert.equal(s.state, STATES.ATTACHED)
  assert.equal(s.backendLogins, 2)
})

test('a detached session cannot transfer, so the puppet moves alone', () => {
  const clock = fakeClock()
  const s = createSession({ clock })
  s.backendLogin({}); s.warmComplete({})
  const started = s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  assert.equal(started.started, false)
  assert.equal(s.state, STATES.WARM)
})

test('the client may still leave during a transfer', () => {
  const clock = fakeClock()
  const s = createSession({ clock })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  const outcome = s.detach({ reason: 'player_quit' })
  assert.equal(outcome.detached, true)
  assert.equal(s.state, STATES.DETACHED)
})

test('a refused dial does not arm a second reconnect while one is pending', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000, reconnectPolicy: { attempts: 3 } })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  s.backendDown({ reason: 'backend_transfer', retainFront: true })
  clock.tick(1000)

  // #87: the dial opened and closed before its first frame. The core keeps the
  // move and arms one retry; the connect rejection that follows is the same
  // fault, not a second one.
  s.backendDown({ reason: 'socketClosed', retainFront: true })
  assert.equal(s.pendingReconnect, true)
  const duplicate = s.fail()
  assert.equal(duplicate.scheduled, false)
  assert.equal(duplicate.alreadyArmed, true)
  assert.equal(s.state, STATES.TRANSFERRING)
  assert.equal(s.detachCount, 0)
  assert.equal(clock.pending, 1, 'one retry armed, not two')
})

test('a retained transfer never fails closed on a retry budget', () => {
  const clock = fakeClock()
  const s = createSession({ clock, reconnectDelayMs: 1000, reconnectPolicy: { attempts: 1 } })
  s.backendLogin({}); s.warmComplete({})
  s.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  s.transferStart({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  s.backendDown({ reason: 'backend_transfer', retainFront: true })
  clock.tick(1000)

  // Two failed dials in a row, past the one-attempt budget: the session keeps
  // the client and keeps retrying; the follow controller owns the give-up. Each
  // dial waits for the retry the previous one armed (1000 ms, then 2000 ms).
  assert.equal(s.fail().scheduled, true)
  assert.equal(s.state, STATES.TRANSFERRING)
  clock.tick(2000)
  assert.equal(s.fail().scheduled, true)
  assert.equal(s.state, STATES.TRANSFERRING)
  assert.equal(s.detachCount, 0)
})

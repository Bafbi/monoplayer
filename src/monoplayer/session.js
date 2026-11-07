// B1 monoplayer core: pure boot/warm/attached/detached state machine with an
// injected clock.
//
// States:
//   boot          - backend leg not connected / connecting, nothing yet
//   warm          - backend logged in, cache warming or warmed; attach ready
//   attached      - one player client attached and driving the puppet
//   detached      - player gone; puppet session alive on the backend
//   reconnecting  - backend fault; exactly ONE reconnect scheduled
//   failed        - the single scheduled reconnect was exhausted
//
// Hard invariants:
//   - backendLogins counts real backend login events only, so an
//     attach/detach cycle alone leaves it untouched.
//   - A fault schedules exactly one reconnect. A second fault while
//     reconnecting is recorded but never schedules a second timer (F4/F5
//     "one reconnect, never a loop").
//   - An attach attempt arriving during connecting/reconnecting is a clear
//     failure for the caller: rejected with 'not_ready' / 'backend_down'.
//
// Purity: no real timers unless injected; the default clock is inert (you must
// inject `clock` to use the reconnect path in tests deterministically).

export const STATES = Object.freeze({
  BOOT: 'boot',
  WARM: 'warm',
  ATTACHED: 'attached',
  DETACHED: 'detached',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed'
})

export const DEFAULT_POSE = Object.freeze({ x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 })

const inertClock = Object.freeze({
  now: () => 0,
  setTimeout: () => null,
  clearTimeout: () => {}
})

export function createSession ({
  clock = inertClock,
  reconnectDelayMs = 1000,
  pose = DEFAULT_POSE
} = {}) {
  let state = STATES.BOOT
  let warmReady = false // join prefix warm: attach requires this
  let backendLogins = 0
  let attachCount = 0
  let detachCount = 0
  let currentPose = { ...pose }
  let pendingReconnect = false
  let reconnectTimer = null
  let reconnectScheduledAt = null
  let lastFault = null

  // Transition log: [{ t, type, from, to, ...fields }] with injected clock times.
  const events = []

  function transition (type, to, fields = {}) {
    const from = state
    state = to
    events.push({ t: clock.now(), type, from, to, ...fields })
    return from
  }

  function emit (type, fields = {}) {
    events.push({ t: clock.now(), type, state, ...fields })
  }

  // --- backend-leg lifecycle ---

  // Backend connection attempt started (initial boot or after a scheduled
  // reconnect fired). Attaches arriving in 'boot' are rejected.
  function backendConnecting ({ initial = false } = {}) {
    if (!initial) {
      transition('reconnect_attempt', STATES.BOOT, { reconnecting: true })
      return
    }
    transition('connecting', STATES.BOOT, { initial })
  }

  function backendLogin (packet = {}) {
    backendLogins++ // counts real backend login events ONLY
    transition('backend_login', STATES.WARM, { backendLogins, entityId: packet.entityId })
    return { backendLogins }
  }

  function warmComplete (info = {}) {
    warmReady = true
    emit('warm_complete', { ...info })
    return warmReady
  }

  // Backend fault (end/error/status). Schedules exactly one reconnect while
  // the session is alive. Never loops: a second fault while already
  // reconnecting is recorded but never schedules another timer (F4/F5
  // "one reconnect, total two backend logins", not a loop).
  function backendDown ({ reason = 'unknown', at = clock.now() } = {}) {
    lastFault = { reason, at }
    if (state === STATES.RECONNECTING) {
      emit('fault_while_reconnecting', { reason }) // recorded, NOT a new timer
      return { scheduled: false, state }
    }
    if (state === STATES.BOOT) {
      if (backendLogins > 0) {
        // The single reconnect attempt was fired and failed again.
        transition('failed', STATES.FAILED, { reason, backendLogins })
        return { scheduled: false, state, failed: true }
      }
      // Initial connect never succeeded: fail fast, no reconnect loop.
      transition('initial_connect_failed', STATES.FAILED, { reason })
      return { scheduled: false, state, failed: true }
    }
    const wasAttached = state === STATES.ATTACHED
    if (wasAttached) {
      transition('backend_down', STATES.RECONNECTING, { reason, frontEnded: true })
      detachCount++
    } else {
      transition('backend_down', STATES.RECONNECTING, { reason, frontEnded: false })
    }
    // Schedule exactly one reconnect.
    pendingReconnect = true
    reconnectScheduledAt = clock.now()
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer)
    reconnectTimer = clock.setTimeout(() => {
      if (!pendingReconnect) return // backendUp() rescinded it
      pendingReconnect = false
      reconnectTimer = null
      transition('reconnect_fired', STATES.BOOT, { delayMs: reconnectDelayMs })
    }, reconnectDelayMs)
    emit('reconnect_scheduled', { delayMs: reconnectDelayMs })
    return { scheduled: true, state, wasAttached }
  }

  // Backend is reachable again while a reconnect was pending: rescind the
  // timer and go back to boot-waiting; the fresh backendLogin() finishes it.
  function backendUp () {
    if (state !== STATES.RECONNECTING) return { ignored: true, state }
    if (reconnectTimer !== null) {
      clock.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    pendingReconnect = false
    transition('reconnect_rescinded', STATES.BOOT)
    return { ignored: false, state }
  }

  // The single scheduled reconnect was exhausted (adapter saw the reset
  // connect fail); called by the adapter after a reconnect attempt fails.
  function fail () {
    if (state === STATES.BOOT && backendLogins > 0) {
      transition('failed', STATES.FAILED, { reason: 'reconnect_exhausted' })
    }
  }

  // --- front-leg lifecycle ---

  function attachAttempt ({ uuid, name } = {}) {
    if (state === STATES.RECONNECTING) {
      emit('attach_rejected', { uuid, name, reason: 'backend_down' })
      return { accepted: false, reason: 'backend_down' }
    }
    if (state === STATES.BOOT || !warmReady) {
      emit('attach_rejected', { uuid, name, reason: 'not_ready' })
      return { accepted: false, reason: 'not_ready' }
    }
    if (state === STATES.ATTACHED) {
      emit('attach_rejected', { uuid, name, reason: 'already_attached' })
      return { accepted: false, reason: 'already_attached' }
    }
    attachCount++
    transition('attach', STATES.ATTACHED, { uuid, name })
    return { accepted: true }
  }

  function detach ({ reason = 'client_disconnect' } = {}) {
    if (state !== STATES.ATTACHED) {
      emit('detach_ignored', { reason })
      return { detached: false, state }
    }
    detachCount++
    transition('detach', STATES.DETACHED, { reason, pose: { ...currentPose } })
    return { detached: true, pose: { ...currentPose } }
  }

  function setPose (next) {
    currentPose = { ...currentPose, ...next }
    return { ...currentPose }
  }

  function isAttachReady () {
    return warmReady && (state === STATES.WARM || state === STATES.DETACHED)
  }

  return {
    get state () { return state },
    get warmReady () { return warmReady },
    get backendLogins () { return backendLogins },
    get attachCount () { return attachCount },
    get detachCount () { return detachCount },
    get currentPose () { return { ...currentPose } },
    get lastFault () { return lastFault },
    get pendingReconnect () { return pendingReconnect },
    events: () => [...events],
    isAttachReady,
    backendConnecting,
    backendLogin,
    warmComplete,
    backendDown,
    backendUp,
    fail,
    attachAttempt,
    detach,
    setPose
  }
}

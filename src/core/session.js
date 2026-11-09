// B1 monoplayer core: pure boot/warm/attached/detached state machine with an
// injected clock.
//
// States:
//   boot          - backend leg not connected / connecting, nothing yet
//   warm          - backend logged in, cache warming or warmed; attach ready
//   configuring   - one player client attached while the puppet is still in
//                   the backend's configuration phase (pre-warm early attach);
//                   it becomes `attached` at the backend play login, with no
//                   replay because it has followed the live stream
//   attached      - one player client attached and driving the puppet
//   detached      - player gone; puppet session alive on the backend
//   reconnecting  - backend fault; one reconnect armed at a time, with an
//                   optional retry budget and capped exponential backoff
//   failed        - the retry budget was exhausted (default: after one attempt)
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
  CONFIGURING: 'configuring',
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
  // Production retries until the backend returns; the default keeps the G0
  // fault contract ("one reconnect, total two backend logins") for the tests
  // and the fake rigs.
  reconnectPolicy = { attempts: 1, maxDelayMs: 60_000 },
  pose = DEFAULT_POSE,
  // Called once each time a scheduled reconnect fires (the session has moved
  // to boot and the adapter may now re-open the backend). Null keeps the
  // inert-clock behavior: the timer never fires, so the callback never runs.
  onReconnect = null
} = {}) {
  const attempts = Number.isFinite(reconnectPolicy?.attempts) && reconnectPolicy.attempts > 0
    ? Math.floor(reconnectPolicy.attempts)
    : Infinity
  const maxDelayMs = Number.isFinite(reconnectPolicy?.maxDelayMs) && reconnectPolicy.maxDelayMs > 0
    ? Math.floor(reconnectPolicy.maxDelayMs)
    : 60_000
  let state = STATES.BOOT
  let warmReady = false // join prefix warm: attach requires this
  let backendLogins = 0
  let attachCount = 0
  let detachCount = 0
  let currentPose = { ...pose }
  let pendingReconnect = false
  let reconnectTimer = null
  let reconnectScheduledAt = null
  let reconnectAttempts = 0
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
    // A reconnect starts from an empty cache: no attach until the fresh
    // session completes its own warm.
    if (!initial) warmReady = false
    if (!initial) {
      transition('reconnect_attempt', STATES.BOOT, { reconnecting: true })
      return
    }
    transition('connecting', STATES.BOOT, { initial })
  }

  function backendLogin (packet = {}) {
    backendLogins++ // counts real backend login events ONLY
    reconnectAttempts = 0
    pendingReconnect = false
    // A client that attached during the puppet's configuration is already
    // playing: it followed the live stream into play, so the login moves it to
    // `attached` without a replay.
    const wasConfiguring = state === STATES.CONFIGURING
    transition('backend_login', wasConfiguring ? STATES.ATTACHED : STATES.WARM, {
      backendLogins,
      entityId: packet.entityId,
      fromConfiguring: wasConfiguring
    })
    return { backendLogins, wasConfiguring }
  }

  function warmComplete (info = {}) {
    warmReady = true
    emit('warm_complete', { ...info })
    return warmReady
  }

  // Exponential backoff, capped. The first attempt uses the base delay so the
  // G0 fault contract (one reconnect at 1000 ms) is unchanged.
  function backoffDelay () {
    const exponent = Math.min(Math.max(0, reconnectAttempts - 1), 16)
    return Math.min(reconnectDelayMs * 2 ** exponent, maxDelayMs)
  }

  function scheduleReconnect (reason) {
    reconnectAttempts++
    const delayMs = backoffDelay()
    pendingReconnect = true
    reconnectScheduledAt = clock.now()
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer)
    reconnectTimer = clock.setTimeout(() => {
      if (!pendingReconnect) return // backendUp() rescinded it
      pendingReconnect = false
      reconnectTimer = null
      transition('reconnect_fired', STATES.BOOT, { delayMs, attempt: reconnectAttempts })
      // Exactly one call per scheduled reconnect. A fault that arrives while
      // RECONNECTING returns before scheduling, so it never lands here.
      if (onReconnect) onReconnect({ delayMs, attempt: reconnectAttempts })
    }, delayMs)
    emit('reconnect_scheduled', { delayMs, attempt: reconnectAttempts, reason })
    return { scheduled: true, state, delayMs, attempt: reconnectAttempts }
  }

  // A fired attempt failed. Retry while the budget lasts, otherwise fail
  // closed. `attempts: 1` reproduces the G0 behavior exactly.
  function retryOrFail (reason) {
    if (reconnectAttempts >= attempts) {
      transition('failed', STATES.FAILED, { reason, backendLogins, attempts: reconnectAttempts })
      return { scheduled: false, state, failed: true }
    }
    transition('reconnect_retry', STATES.RECONNECTING, { reason, attempt: reconnectAttempts })
    return scheduleReconnect(reason)
  }

  // Backend fault (end/error/status). A second fault while a reconnect is
  // already pending is recorded but never arms a second timer. A failed
  // attempt retries with backoff while the policy allows it.
  function backendDown ({ reason = 'unknown', at = clock.now() } = {}) {
    lastFault = { reason, at }
    warmReady = false // the cache is reset with the session; require a fresh warm
    if (state === STATES.RECONNECTING) {
      emit('fault_while_reconnecting', { reason }) // recorded, NOT a new timer
      return { scheduled: false, state }
    }
    if (state === STATES.BOOT) {
      if (backendLogins > 0) {
        // A reconnect attempt was fired and the connection dropped before the
        // play login: retry or fail per policy.
        return retryOrFail(reason)
      }
      // Initial connect never succeeded: fail fast, no reconnect loop.
      transition('initial_connect_failed', STATES.FAILED, { reason })
      return { scheduled: false, state, failed: true }
    }
    const wasAttached = state === STATES.ATTACHED || state === STATES.CONFIGURING
    if (wasAttached) {
      transition('backend_down', STATES.RECONNECTING, { reason, frontEnded: true })
      detachCount++
    } else {
      transition('backend_down', STATES.RECONNECTING, { reason, frontEnded: false })
    }
    return { ...scheduleReconnect(reason), wasAttached }
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

  // The adapter's connect() threw while the attempt was in flight. Retry while
  // the policy allows it; the G0 default fails closed after one attempt.
  function fail () {
    if (state !== STATES.BOOT || backendLogins === 0) return { scheduled: false, state }
    return retryOrFail('reconnect_failed')
  }

  // --- front-leg lifecycle ---

  function attachAttempt ({ uuid, name, configuring = false } = {}) {
    if (state === STATES.RECONNECTING) {
      emit('attach_rejected', { uuid, name, reason: 'backend_down' })
      return { accepted: false, reason: 'backend_down' }
    }
    if (state === STATES.ATTACHED || state === STATES.CONFIGURING) {
      emit('attach_rejected', { uuid, name, reason: 'already_attached' })
      return { accepted: false, reason: 'already_attached' }
    }
    // Pre-warm early attach (#16): the backend has a connection in its
    // configuration phase, so there is no warm state to replay yet, but the
    // client can follow the puppet's configuration stream and land in play.
    // Only a booting session can be configuring; the core decides whether the
    // backend is actually in configuration and asks for this path.
    if (configuring) {
      if (state !== STATES.BOOT) {
        emit('attach_rejected', { uuid, name, reason: 'not_ready' })
        return { accepted: false, reason: 'not_ready' }
      }
      attachCount++
      transition('attach_configuring', STATES.CONFIGURING, { uuid, name })
      return { accepted: true, configuring: true }
    }
    if (state === STATES.BOOT || !warmReady) {
      emit('attach_rejected', { uuid, name, reason: 'not_ready' })
      return { accepted: false, reason: 'not_ready' }
    }
    attachCount++
    transition('attach', STATES.ATTACHED, { uuid, name })
    return { accepted: true }
  }

  function detach ({ reason = 'client_disconnect' } = {}) {
    if (state !== STATES.ATTACHED && state !== STATES.CONFIGURING) {
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
    get configuring () { return state === STATES.CONFIGURING },
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

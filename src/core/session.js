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
//   down          - (#261) no session, and no retry armed: nobody claims the body,
//                   so there is nothing to come back for, or somebody asked the
//                   body to end. A claim dials it out of here, through the same
//                   `backendConnecting` the first dial used.
//   failed        - the retry budget was exhausted (default: after one attempt)
//   transferring  - (#22) the attaching client keeps its connection while the
//                   puppet moves to another server, or while the backend
//                   restarts its configuration phase on the same connection.
//                   The client re-enters configuration on its own socket and
//                   the session returns to `attached` at the target's play
//                   login. A failed target returns it to `attached` on the
//                   restored pre-transfer snapshot instead, so the client is
//                   never detached for a move it can follow.
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
  TRANSFERRING: 'transferring',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  DOWN: 'down'
})

export const DEFAULT_POSE = Object.freeze({ x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 })

const inertClock = Object.freeze({
  now: () => 0,
  setTimeout: () => null,
  clearTimeout: () => {}
})

// A state that keeps the front connection through a backend move (#22): the
// move itself, or a client playing the restored snapshot while the puppet
// comes back. These are the only states where a backend end is not a detach.
const KEEPS_FRONT = new Set([STATES.TRANSFERRING, STATES.ATTACHED])

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
  onReconnect = null,
  // (#261) Does a claim hold this body right now? A claim is the reason a body is
  // kept alive, so a fault that would arm a retry asks here first: nobody claims
  // it, and the body lands in `down` with no retry. The claim is the front leg's
  // record, so the caller answers from its board and this session keeps no copy.
  //
  // Null is a lane with no claim board, which is every lane with no picker: no
  // claim exists there to keep or drop a body, and its faults reconnect exactly as
  // they always have. That absent oracle is the whole of the picker-off rule, so
  // it has to stay absent there rather than be answered `false`.
  claimHeld = null
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
  // #22: the target's play login can land before the caller marks the move
  // done, so the login itself records that the transfer reached the client.
  let transferLanded = false
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
      // #22: a client that is following a move (or playing a restored
      // snapshot) keeps the session where it is; the dial only changes which
      // backend the puppet talks to.
      if (KEEPS_FRONT.has(state)) {
        emit('transfer_connecting', { state })
        return
      }
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
    // #22: a login during a followed move, or while a restored client is
    // playing, is the target's play login. The client is already on the
    // connection, so the session lands in `attached` and the front replays the
    // new session's state on it.
    const fromTransfer = state === STATES.TRANSFERRING
    const restored = state === STATES.ATTACHED
    const carriesClient = wasConfiguring || fromTransfer || restored
    if (fromTransfer) transferLanded = true
    transition('backend_login', carriesClient ? STATES.ATTACHED : STATES.WARM, {
      backendLogins,
      entityId: packet.entityId,
      fromConfiguring: wasConfiguring,
      fromTransfer,
      restored
    })
    return { backendLogins, wasConfiguring, fromTransfer, restored }
  }

  function warmComplete (info = {}) {
    warmReady = true
    emit('warm_complete', { ...info })
    return warmReady
  }

  // (#261) Is a claim what keeps this body alive? An absent oracle is a lane with
  // no claims at all, and the answer there is "keep it", which is the contract
  // every lane had before this rule. An oracle that throws is a bug in the lane's
  // claim read, and it is recorded rather than allowed to break a fault handler:
  // the body is kept, because a body nobody can ask about is not a body to drop.
  function claimed () {
    if (typeof claimHeld !== 'function') return true
    try {
      return claimHeld() !== false
    } catch (error) {
      emit('claim_oracle_failed', { error: String(error?.message ?? error).slice(0, 200) })
      return true
    }
  }

  // A retry that is armed but not due yet belongs to a body somebody wants. The
  // body ends with the retry, so the timer is cleared here and the caller is told
  // it was, rather than left to fire at a session with nothing to dial.
  function cancelReconnect () {
    const armed = pendingReconnect
    if (reconnectTimer !== null) {
      clock.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    pendingReconnect = false
    reconnectScheduledAt = null
    return armed
  }

  // (#261) The body lands in `down`: no session, no retry, and a claim is what
  // dials it out. Two callers reach it, a fault nobody claims and a requested end,
  // because they leave the body in the same place and the picker says the same
  // thing about both. `unclaimed` is the record's own word for why: the fault
  // paths reached this because no claim held the body, and the requested end
  // reports what the oracle said at the moment it was asked.
  function bodyDown ({ reason, type, cancelled = false, unclaimed = true }) {
    warmReady = false
    transition(type, STATES.DOWN, { reason, frontEnded: false, unclaimed, cancelled })
    return { scheduled: false, state, cancelled, unclaimed }
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
      // #22: a retained client keeps its state through the dial. A session
      // only reaches here in `attached` because a failed transfer restored it
      // and armed the next attempt itself.
      const fired = KEEPS_FRONT.has(state) ? state : STATES.BOOT
      transition('reconnect_fired', fired, { delayMs, attempt: reconnectAttempts })
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
    // #22: under a retained client the session never fails closed. The
    // transfer-follow controller owns the give-up, and it reverts to the
    // configured backend instead of ending the connection.
    if (KEEPS_FRONT.has(state)) {
      transition('transfer_retry', state, { reason, attempt: reconnectAttempts })
      return scheduleReconnect(reason)
    }
    // #261: the retry budget is the claim's. A claim that ended while an attempt
    // was pending spends no further attempt, so a body nobody holds cannot be
    // retried for ever by a lane that retries without a bound.
    if (!claimed()) return bodyDown({ reason, type: 'body_down_unclaimed' })
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
  function backendDown ({ reason = 'unknown', at = clock.now(), retainFront = false } = {}) {
    lastFault = { reason, at }
    warmReady = false // the cache is reset with the session; require a fresh warm
    // #22: the attached client follows a move on its own connection, so the
    // backend end under a transfer is not a detach. One reconnect is armed and
    // the session stays put; the front learns about the move from the transfer
    // state, never from a kick.
    if (retainFront && KEEPS_FRONT.has(state)) {
      transition('backend_down_retained', state, { reason, frontEnded: false })
      return { ...scheduleReconnect(reason), wasAttached: true, retained: true }
    }
    if (state === STATES.RECONNECTING) {
      emit('fault_while_reconnecting', { reason }) // recorded, NOT a new timer
      return { scheduled: false, state }
    }
    // A body that is down has nothing to reconnect: the session is not there to
    // dial. A claim reaches it through `backendConnecting`, never through a fault.
    if (state === STATES.DOWN) {
      emit('fault_while_down', { reason })
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
    } else if (!claimed()) {
      // #261: nobody claims this body, so nothing on it is worth a dial. It stays
      // down and the picker says so, and the claim that comes next is what brings
      // it back.
      return bodyDown({ reason, type: 'body_down_unclaimed' })
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
  // the policy allows it; the G0 default fails closed after one attempt. A
  // retained client (#22) never fails closed: retryOrFail keeps the session.
  function fail () {
    if (KEEPS_FRONT.has(state)) {
      // #87: a dial can refuse while the retained teardown already armed the
      // retry. That is the same fault, so it must not spend the follow budget
      // twice: the armed attempt owns the next dial.
      if (pendingReconnect) return { scheduled: false, state, alreadyArmed: true }
      return retryOrFail('reconnect_failed')
    }
    if (state !== STATES.BOOT || backendLogins === 0) return { scheduled: false, state }
    return retryOrFail('reconnect_failed')
  }

  // --- front-leg lifecycle ---

  function attachAttempt ({ uuid, name, configuring = false } = {}) {
    if (state === STATES.RECONNECTING) {
      emit('attach_rejected', { uuid, name, reason: 'backend_down' })
      return { accepted: false, reason: 'backend_down' }
    }
    if (state === STATES.ATTACHED || state === STATES.CONFIGURING || state === STATES.TRANSFERRING) {
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
    if (state !== STATES.ATTACHED && state !== STATES.CONFIGURING && state !== STATES.TRANSFERRING) {
      emit('detach_ignored', { reason })
      return { detached: false, state }
    }
    detachCount++
    transferLanded = false
    transition('detach', STATES.DETACHED, { reason, pose: { ...currentPose } })
    return { detached: true, pose: { ...currentPose } }
  }

  // (#261) A requested end. A player asked for this body to go down from the
  // picker, and only while no claim holds it. The body lands in `down`, where it
  // arms no retry, and a claim is what dials it back.
  //
  // The invariant is the core's: a body a driver is standing in is refused here
  // whatever the caller asked, because ending it would take a client's world away
  // from a client that still holds the claim.
  function end ({ reason = 'requested' } = {}) {
    if (state === STATES.ATTACHED || state === STATES.CONFIGURING || state === STATES.TRANSFERRING) {
      emit('body_end_refused', { reason, state })
      return { ended: false, reason: 'client_attached', state }
    }
    if (state === STATES.DOWN) {
      emit('body_end_repeated', { reason })
      return { ended: false, reason: 'already_down', state, cancelled: false }
    }
    const cancelled = cancelReconnect()
    bodyDown({ reason, type: 'body_end', cancelled, unclaimed: !claimed() })
    return { ended: true, reason, state, cancelled }
  }

  // --- transfer lifecycle (#22) ---

  // The attaching client starts following a move (a backend transfer) or a
  // server-initiated reconfiguration. Only a session that holds a client can
  // transfer: with nobody attached there is no connection to keep, and the
  // ordinary backend-down path moves the puppet.
  function transferStart ({ target = null, reason = 'transfer' } = {}) {
    transferLanded = false
    if (state !== STATES.ATTACHED && state !== STATES.CONFIGURING) {
      emit('transfer_start_ignored', { reason, target, state })
      return { started: false, state }
    }
    const from = transition('transfer_start', STATES.TRANSFERRING, { reason, target })
    return { started: true, from, target }
  }

  // The target's play login landed on the retained connection.
  function transferComplete ({ reason = 'transfer_complete' } = {}) {
    if (state === STATES.TRANSFERRING) {
      transferLanded = false
      transition('transfer_complete', STATES.ATTACHED, { reason })
      return { completed: true }
    }
    // The login already landed the client in the target; this call only marks
    // the move done, so nothing is transitioned twice.
    if (state === STATES.ATTACHED && transferLanded) {
      transferLanded = false
      emit('transfer_complete_recorded', { reason })
      return { completed: true, landed: true }
    }
    return { completed: false, state }
  }

  // The target failed. The client keeps its connection and is restored from
  // the pre-transfer snapshot, so the session returns to `attached` and one
  // reconnect goes back to the configured backend.
  function transferFailed ({ reason = 'transfer_failed' } = {}) {
    // A target can also fail after its play login landed and before the move
    // is marked done. The client is still the one that has to be restored.
    const landed = state === STATES.ATTACHED && transferLanded
    if (state !== STATES.TRANSFERRING && !landed) return { failed: false, state }
    transferLanded = false
    warmReady = false
    if (landed) {
      emit('transfer_fail', { reason, restored: true, landed: true })
    } else {
      transition('transfer_fail', STATES.ATTACHED, { reason, restored: true })
    }
    return { failed: true, restored: true, ...scheduleReconnect(reason) }
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
    get transferring () { return state === STATES.TRANSFERRING },
    isAttachReady,
    backendConnecting,
    backendLogin,
    warmComplete,
    backendDown,
    backendUp,
    fail,
    attachAttempt,
    detach,
    transferStart,
    transferComplete,
    transferFailed,
    end,
    setPose
  }
}

// #22: the transfer of an attached session to another server.
//
// A followed transfer does not detach the human. The front keeps the client's
// connection, re-enters configuration with the target's configuration, and
// lands the client in the target's play state. The session's own move is
// session.transferStart -> transferComplete, and the cache is reset for the
// target's session as usual.
//
// The piece this module owns is the fallback: the state the client had before
// the move, captured the moment the move starts. If the target fails, that
// snapshot is what the client is restored to, on the same connection, and the
// puppet goes back to the configured backend.
//
// Because the snapshot must outlive the cache reset that clears the old
// session, it is taken here, before anything else in the move runs.
//
// Pure: no timers, no sockets. `session` is src/core/session.js and `cache` is
// src/core/state-cache.js. The composition root drives it; the fake-leg tests
// and the loopback prove the transitions.

export const TRANSFER_KINDS = Object.freeze({
  // A backend `transfer`: the puppet dials the target on a new connection.
  TRANSFER: 'transfer',
  // A backend `start_configuration`: the same connection restarts its
  // configuration phase.
  RECONFIGURE: 'reconfigure'
})

export function createTransfer ({ session, cache } = {}) {
  if (!session || typeof session.transferStart !== 'function') {
    throw new TypeError('createTransfer requires a session')
  }
  if (!cache || typeof cache.snapshot !== 'function' || typeof cache.restore !== 'function') {
    throw new TypeError('createTransfer requires a state cache with snapshot() and restore()')
  }

  let held = null // { snapshot, pose, target, kind } while a move is in flight
  let phase = 'idle' // idle | in_flight | restored

  // Start following a move. A session with no client cannot transfer (there is
  // no connection to keep), and this returns began: false so the caller uses
  // the ordinary backend-down path.
  function begin ({ target = null, kind = TRANSFER_KINDS.TRANSFER, reason = 'transfer' } = {}) {
    if (phase === 'in_flight') {
      return { began: false, reason: 'already_in_flight', snapshot: held.snapshot, target: held.target }
    }
    const started = session.transferStart({ target, reason })
    if (started.started !== true) return { began: false, reason: 'no_client', state: session.state }
    // The pre-transfer snapshot is taken here, before the cache reset the
    // move triggers and before any target frame can enter the cache.
    held = {
      snapshot: cache.snapshot(),
      pose: session.currentPose,
      target,
      kind
    }
    phase = 'in_flight'
    return { began: true, kind, target, snapshot: held.snapshot, pose: held.pose }
  }

  // The target's play login landed and the client is in the target's state.
  function commit ({ reason = 'transfer_complete' } = {}) {
    if (phase !== 'in_flight') return { committed: false, phase }
    const outcome = session.transferComplete({ reason })
    held = null
    phase = 'idle'
    return { ...outcome, committed: outcome.completed === true }
  }

  // The target failed. Put the pre-transfer state back in the cache, restore
  // the pose, and return the session to its attached client. The caller owns
  // the client-facing half (replaying the snapshot onto the connection) and
  // the notice.
  function fail ({ reason = 'transfer_failed' } = {}) {
    if (phase !== 'in_flight') return { failed: false, phase }
    const restorePoint = held
    const outcome = session.transferFailed({ reason })
    cache.restore(restorePoint.snapshot)
    session.setPose(restorePoint.pose)
    phase = 'restored'
    return {
      failed: outcome.failed === true,
      restored: outcome.restored === true,
      snapshot: restorePoint.snapshot,
      pose: restorePoint.pose,
      target: restorePoint.target,
      kind: restorePoint.kind,
      scheduled: outcome.scheduled === true
    }
  }

  // The reconnect that follows a restore starts a fresh backend session: the
  // frames it caches must not append to the snapshot the client was put back
  // on. The caller resets the cache on that dial, and this call makes it once
  // per restore, so a later reconnect does not wipe a warm cache (issue #87).
  function claimRestore () {
    if (phase !== 'restored') return false
    phase = 'idle'
    return true
  }

  // Release the held snapshot without changing the session (a second move
  // replaced this one, or the process is stopping).
  function discard () {
    const dropped = held !== null
    held = null
    if (phase === 'in_flight') phase = 'idle'
    return { dropped }
  }

  return {
    begin,
    commit,
    fail,
    claimRestore,
    discard,
    get phase () { return phase },
    get inFlight () { return phase === 'in_flight' },
    get restored () { return phase === 'restored' },
    get kind () { return held?.kind ?? null },
    get target () { return held?.target ?? null },
    get snapshot () { return held?.snapshot ?? null },
    get pose () { return held?.pose ?? null }
  }
}

// Transfer-follow controller: which backend target the next reconnect dials,
// and when to give up on a followed target.
//
// The core emits `reconnect_due` with a `target` only on the hop that follows a
// transfer. Later retries of the same target arrive with `target: null`, so the
// controller must remember the target until a connect succeeds or the follow
// budget runs out.
//
// It reports the target it holds, the retries against that target, and whether a
// connect landed on it. What the dial itself should be — a transfer handshake or
// a plain login — is the service's decision, and `src/service/start-live.js` is
// where it is made (#332, #348).
//
// Pure: no timers, no sockets. `src/service/start-live.js` is the only caller;
// `test/core/transfer-follow.test.js` tests this module on its own.

export const DEFAULT_MAX_TARGET_FAILURES = 3

export function createTransferFollowController ({ maxTargetFailures = DEFAULT_MAX_TARGET_FAILURES } = {}) {
  if (!Number.isInteger(maxTargetFailures) || maxTargetFailures < 1) {
    throw new TypeError('maxTargetFailures must be a positive integer')
  }

  let target = null // { host, port } or null for the configured base backend
  let failures = 0
  let reverts = 0

  function normalize (value) {
    if (!value || typeof value !== 'object') return null
    const host = typeof value.host === 'string' ? value.host.trim() : ''
    const port = Number(value.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  }

  return {
    // A reconnect is due. A non-null `event.target` starts a new followed hop.
    onDue (event = {}) {
      const next = normalize(event.target)
      if (next) {
        target = next
        failures = 0
      }
      return { target, failures }
    },

    // The connect succeeded: the followed target (if any) is now the session.
    onSuccess () {
      const followed = target !== null
      target = null
      failures = 0
      return { followed }
    },

    // The connect failed. After maxTargetFailures, abandon the target and let
    // the next reconnect use the configured base backend.
    onFailure () {
      if (!target) return { target: null, failures: 0, reverted: false, abandoned: null }
      failures++
      if (failures >= maxTargetFailures) {
        const abandoned = target
        target = null
        failures = 0
        reverts++
        return { target: null, failures: 0, reverted: true, abandoned }
      }
      return { target, failures, reverted: false, abandoned: null }
    },

    // Give up now (for example, a target that is unreachable for a reason
    // other than a failed connect).
    abort (reason = 'aborted') {
      const abandoned = target
      target = null
      failures = 0
      return { expected: false, abandoned, reason }
    },

    // The dial address for the current state; null means the configured base.
    get target () { return target },
    get failures () { return failures },
    get reverts () { return reverts }
  }
}

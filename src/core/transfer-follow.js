// Transfer-follow controller: which backend target the next reconnect dials,
// how to dial it, and when to give up on a followed target.
//
// The core emits `reconnect_due` with a `target` only on the hop that follows a
// transfer. Later retries of the same target arrive with `target: null`, so the
// controller must remember the target until a connect succeeds or the follow
// budget runs out.
//
// It remembers the `kind` for the same reason (#233): a retry of an operator's
// move is still an operator's move, and it must dial as a fresh login rather than
// with the transfer handshake. Deriving the kind from the event would get it
// right once and wrong on every retry, which is the one hop where the difference
// costs a rejected connection.
//
// Pure: no timers, no sockets. Used by start-live and the offline loopback, and
// unit-tested on its own.

export const DEFAULT_MAX_TARGET_FAILURES = 3

export function createTransferFollowController ({ maxTargetFailures = DEFAULT_MAX_TARGET_FAILURES } = {}) {
  if (!Number.isInteger(maxTargetFailures) || maxTargetFailures < 1) {
    throw new TypeError('maxTargetFailures must be a positive integer')
  }

  let target = null // { host, port } or null for the configured base backend
  // 'transfer' (the server moved the session) or 'operator' (an operator did,
  // #233). Meaningless while `target` is null, and reset with it.
  let kind = null
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
    // `event.kind` names who started it, and a value it does not recognise is a
    // transfer: the dialect every lane had before #233.
    onDue (event = {}) {
      const next = normalize(event.target)
      if (next) {
        target = next
        kind = event.kind === 'operator' ? 'operator' : 'transfer'
        failures = 0
      }
      return { target, kind: target === null ? null : kind, failures }
    },

    // The connect succeeded: the followed target (if any) is now the session.
    onSuccess () {
      const followed = target !== null
      target = null
      kind = null
      failures = 0
      return { followed }
    },

    // The connect failed. After maxTargetFailures, abandon the target and let
    // the next reconnect use the configured base backend.
    onFailure () {
      if (!target) return { target: null, kind: null, failures: 0, reverted: false, abandoned: null }
      failures++
      if (failures >= maxTargetFailures) {
        const abandoned = target
        target = null
        kind = null
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
      kind = null
      failures = 0
      return { expected: false, abandoned, reason }
    },

    // The dial address for the current state; null means the configured base.
    get target () { return target },
    get kind () { return target === null ? null : kind },
    get failures () { return failures },
    get reverts () { return reverts }
  }
}

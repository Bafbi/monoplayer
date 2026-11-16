// #201: the total connection cap on the pre-auth window, and #205: the deadline
// that bounds how long one connection may hold a slot.
//
// The window runs from accepting a socket to the moment the front leg has
// resolved the client's UUID and the attach whitelist has accepted it. A
// connection past that point is never examined again, so an established,
// authenticated session can never be refused by this count.
//
// The cap is the one pre-auth limit that survives a TCP tunnel. A per-source
// limit reads the peer address, and a tunnel may present its own address rather
// than the client's. A count of the sockets in the window does not care whose
// address they carry (#199, #204).
//
// The cap alone bounds how many sockets sit in the window and nothing bounds how
// long one stays. minecraft-protocol sets no idle timeout on its client,
// closeTimeout starts only after end(), and keep-alive runs in the play state
// only, so a socket that is accepted and never speaks holds its slot until its
// peer closes or the process restarts. A stranger who opens maxConnections
// silent sockets therefore closes the window with no work at all (#205). The
// deadline is the bound: a connection still in the window when its timer fires
// is destroyed by the leg.
//
// Pure by construction: no socket, no clock, no log. The front leg owns every
// effect of the decision: the closed socket, the timer, the counted refusal, and
// the one log line per saturated window or per deadline episode.

export const PREAUTH_REFUSAL = Object.freeze({
  CONNECTION_CAP: 'preauth_connection_cap',
  DEADLINE: 'preauth_deadline'
})

// The cap in force when the config names none. It has to sit above a busy lane
// and below a flood. A player, a status ping, and a login burst's headroom fit,
// while the window closes long before a stranger's script does anything with it.
// The rungs drive one bot at a time and the dev lane and the gate Paper serve
// one attach at a time, so nothing this repo starts reaches it.
export const DEFAULT_MAX_CONNECTIONS = 16

// The deadline in force when the config names none. A real login is a handshake,
// an encryption round trip and one sessionserver hasJoined call, and it leaves
// the window at the whitelist's accept: on a LAN or the dev lane that is
// milliseconds, and through a free tunnel on another continent it is a second or
// two. Thirty seconds sits far above the slowest of those and matches the
// library's own 30 s closeTimeout, which is this codebase's existing notion of a
// connection that will not close. A silent socket therefore costs a slot for
// half a minute, not for the life of the pod.
export const DEFAULT_DEADLINE_MS = 30_000

export function createPreAuthWindow ({
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  deadlineMs = DEFAULT_DEADLINE_MS
} = {}) {
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new TypeError('maxConnections must be a positive integer, got ' + JSON.stringify(maxConnections))
  }
  // A deadline of 0 or less would bound nothing, which is the defect this
  // exists to close, so it is refused rather than defaulted away.
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) {
    throw new TypeError('deadlineMs must be a positive integer, got ' + JSON.stringify(deadlineMs))
  }

  let inWindow = 0
  let refused = 0
  let expired = 0
  // A refusal is logged once per saturated window rather than once per attempt,
  // so a burst writes one line instead of thousands. The flag is set by the
  // refusal that found the window full and cleared when a slot frees, which is
  // what makes the next attack visible again.
  let logged = false
  // The deadline's own flag, for the same reason: a flood of silent sockets that
  // expire together writes one line, and the count says how many there were. An
  // episode ends when the window empties, because the next silent socket is a
  // new event rather than the tail of the last one.
  let loggedDeadline = false

  // A connection arrives. A refusal carries what the leg logs, because that
  // record is the decision's whole operator surface. `shouldLog` says this is
  // the refusal of a window that just filled.
  function admit () {
    if (inWindow >= maxConnections) {
      refused++
      const shouldLog = !logged
      logged = true
      return {
        admitted: false,
        reason: PREAUTH_REFUSAL.CONNECTION_CAP,
        inWindow,
        maxConnections,
        refused,
        shouldLog
      }
    }
    inWindow++
    return { admitted: true, reason: null, inWindow }
  }

  // A connection left the window: the whitelist accepted it, or its socket
  // ended. Every path releases once. A second release for the same connection
  // must not widen the window.
  function release () {
    if (inWindow === 0) return { released: false, inWindow }
    inWindow--
    if (inWindow < maxConnections) logged = false
    if (inWindow === 0) loggedDeadline = false
    return { released: true, inWindow }
  }

  // A connection stayed in the window past its deadline. The leg destroys the
  // socket and releases the slot; this counts the close and says whether it is
  // the episode's first, which is what the log line is for.
  function expire () {
    expired++
    const shouldLog = !loggedDeadline
    loggedDeadline = true
    return { reason: PREAUTH_REFUSAL.DEADLINE, expired, shouldLog, inWindow }
  }

  return {
    admit,
    release,
    expire,
    stats: () => ({ inWindow, maxConnections, refused })
  }
}

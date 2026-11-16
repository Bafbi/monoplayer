// #201: the total connection cap on the pre-auth window.
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
// Pure by construction: no socket, no clock, no log. The front leg owns every
// effect of the decision: the closed socket, the counted refusal, the one log
// line per saturated window.

export const PREAUTH_REFUSAL = Object.freeze({
  CONNECTION_CAP: 'preauth_connection_cap'
})

// The cap in force when the config names none. It has to sit above a busy lane
// and below a flood. A player, a status ping, and a login burst's headroom fit,
// while the window closes long before a stranger's script does anything with it.
// The rungs drive one bot at a time and the dev lane and the gate Paper serve
// one attach at a time, so nothing this repo starts reaches it.
export const DEFAULT_MAX_CONNECTIONS = 16

export function createPreAuthWindow ({ maxConnections = DEFAULT_MAX_CONNECTIONS } = {}) {
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new TypeError('maxConnections must be a positive integer, got ' + JSON.stringify(maxConnections))
  }

  let inWindow = 0
  let refused = 0
  // A refusal is logged once per saturated window rather than once per attempt,
  // so a burst writes one line instead of thousands. The flag is set by the
  // refusal that found the window full and cleared when a slot frees, which is
  // what makes the next attack visible again.
  let logged = false

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
    return { released: true, inWindow }
  }

  return {
    admit,
    release,
    stats: () => ({ inWindow, maxConnections, refused })
  }
}

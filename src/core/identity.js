// B1 monoplayer core: the pure front-leg identity gate.
//
// One gate the core offers an attaching client before its Login Success: the Login
// Start (#0x00) review, where the claimed UUID must be on the attach whitelist. A
// non-whitelisted UUID is denied right here, before Login Success. Every lane runs this
// one. An online lane runs it after the encryption response, inside `beforeLogin`.
//
// The attach check's other step is the front leg's: src/legs/live-front.js runs on a
// library that answers the sessionserver's `hasJoined` before this module is asked
// anything, so a login that arrives here has already passed it. #721 deleted the
// second pass in here, which no lane injected a verifier into and nothing called.
//
// The decision is returned; the front-leg adapter owns every I/O side effect
// (kick packets, disconnects, encryption handshake).

export const DENY_REASONS = Object.freeze({
  NOT_WHITELISTED: 'not_whitelisted',
  MALFORMED_UUID: 'malformed_uuid' // shape failure, distinct from a valid-but-unlisted UUID
})

export const ALLOW_REASONS = Object.freeze({
  WHITELISTED: 'whitelisted'
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// #229: the whitelist is an array (frozen here, the default) or a provider
// read at each login. The provider is what a named attach whitelist file turns on:
// an operator adds a UUID to the file on disk and the next login sees it, with no
// restart. A provider that throws, or that returns anything but an array,
// denies: a broken control document must never allow a player.
export function createFrontIdentity ({
  attachWhitelist = [],
  puppetProfile
} = {}) {
  const provided = typeof attachWhitelist === 'function' ? attachWhitelist : null
  if (provided === null && !Array.isArray(attachWhitelist)) {
    throw new TypeError('attachWhitelist must be an array of UUIDs or a function returning one')
  }
  const frozen = new Set((provided === null ? attachWhitelist : []).map(u => u.toLowerCase()))

  function whitelistNow () {
    if (provided === null) return [...frozen]
    try {
      const list = provided()
      return Array.isArray(list) ? list.map(u => String(u).toLowerCase()) : []
    } catch {
      return []
    }
  }

  // Whitelist review — Login Start. Synchronous, deny-before-anything-else.
  // deny phase is 'login_start': this must fire before Login Success by
  // construction of the front leg's handshake order (Login Start always
  // precedes Login Success).
  function reviewLoginStart ({ uuid, name, username } = {}) {
    const who = name ?? username
    if (!uuid || !UUID_RE.test(uuid)) {
      return { allowed: false, reason: DENY_REASONS.MALFORMED_UUID, phase: 'login_start', uuid, name: who }
    }
    const listed = provided === null ? frozen.has(uuid.toLowerCase()) : whitelistNow().includes(uuid.toLowerCase())
    if (!listed) {
      return { allowed: false, reason: DENY_REASONS.NOT_WHITELISTED, phase: 'login_start', uuid, name: who }
    }
    return { allowed: true, reason: ALLOW_REASONS.WHITELISTED, phase: 'login_start', uuid, name: who }
  }

  const whoAmI = () => ({
    whitelist: whitelistNow(),
    puppet: puppetProfile ?? null
  })

  return {
    reviewLoginStart,
    whoAmI,
    get includes () { return whitelistNow().map(u => u.toUpperCase()) }
  }
}

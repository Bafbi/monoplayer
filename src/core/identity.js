// B1 monoplayer core: pure front-leg identity gate with an injected verifier.
//
// Two gates run before the attaching client ever gets Login Success:
//   1. Login Start (#0x00) review: the claimed UUID must be on the attach
//      whitelist. A non-whitelisted UUID is denied right here — before any
//      encryption response, session verification, or Login Success packet.
//   2. Session verify (online-mode): after the front leg's encryption response,
//      the injected verifier resolves the client's session-server lookup
//      ("hasJoined"). Exact name+UUID match required.
//
// The decision is returned; the front-leg adapter owns every I/O side effect
// (kick packets, disconnects, encryption handshake). Purity also means no
// verifier is provided: the caller injects the live session-mo lookup
// (G1) or a stub.

export const ATTACK_SURFACE_NAMES = ['login_start']

export const DENY_REASONS = Object.freeze({
  NOT_WHITELISTED: 'not_whitelisted',
  MALFORMED_UUID: 'malformed_uuid', // shape failure, distinct from a valid-but-unlisted UUID
  VERIFY_FAILED: 'verify_failed',
  NO_PROFILE: 'no_profile'
})

export const ALLOW_REASONS = Object.freeze({
  WHITELISTED: 'whitelisted',
  VERIFIED: 'verified',
  NO_VERIFIER: 'no_verifier_injected'
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createFrontIdentity ({
  attachWhitelist = [],
  puppetProfile,
  verifyProfile = null
} = {}) {
  const whitelist = new Set(attachWhitelist.map(u => u.toLowerCase()))

  // Gate 1 — Login Start review. Synchronous, deny-before-anything-else.
  // deny phase is 'login_start': this must fire before Login Success by
  // construction of the front leg's handshake order (Login Start always
  // precedes Login Success).
  function reviewLoginStart ({ uuid, name, username } = {}) {
    const who = name ?? username
    if (!uuid || !UUID_RE.test(uuid)) {
      return { allowed: false, reason: DENY_REASONS.MALFORMED_UUID, phase: 'login_start', uuid, name: who }
    }
    if (!whitelist.has(uuid.toLowerCase())) {
      return { allowed: false, reason: DENY_REASONS.NOT_WHITELISTED, phase: 'login_start', uuid, name: who }
    }
    return { allowed: true, reason: ALLOW_REASONS.WHITELISTED, phase: 'login_start', uuid, name: who }
  }

  // Gate 2 — session verification. `serverId` is the digest the online-mode
  // handshake produces; the verifier's contract is:
  //   async ({ uuid, name, serverId }) -> { id, name } on success, null/throws on miss
  async function verifySession ({ uuid, name, serverId } = {}) {
    if (!verifyProfile) return { allowed: true, reason: ALLOW_REASONS.NO_VERIFIER, phase: 'verify', uuid, name }
    try {
      const profile = await verifyProfile({ uuid, name, serverId })
      if (!profile) return { allowed: false, reason: DENY_REASONS.NO_PROFILE, phase: 'verify', uuid, name }
      if (String(profile.id ?? '').toLowerCase() !== String(uuid).toLowerCase() ||
          profile.name !== name) {
        return { allowed: false, reason: DENY_REASONS.VERIFY_FAILED, phase: 'verify', uuid: profile.id, name: profile.name }
      }
      return { allowed: true, reason: ALLOW_REASONS.VERIFIED, phase: 'verify', uuid, name, profile }
    } catch {
      return { allowed: false, reason: DENY_REASONS.NO_PROFILE, phase: 'verify', uuid, name }
    }
  }

  const whoAmI = () => ({
    whitelist: [...whitelist],
    puppet: puppetProfile ?? null,
    hasLiveVerifier: verifyProfile != null
  })

  return {
    reviewLoginStart,
    verifySession,
    whoAmI,
    get includes () { return [...whitelist].map(u => u.toUpperCase()) }
  }
}

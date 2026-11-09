// The single embeddable attach check for Monoplayer's front leg (G1).
//
//   check: async ({ client, store, verify }) => { ok, reason, stage }
//
// It is meant to run inside a `beforeLogin` handler, so a denial happens
// BEFORE Login Success: the connecting player never reaches play state, the
// puppet's backend session is untouched, and nothing about the denial needs
// to be replayed. Every decision emits `attachAllowed` / `attachDenied` on
// the check's own event emitter with sanitized payloads (username/uuid/reason
// only — never credentials).
//
// `verify` is the identity step (real hasJoined via ./hasjoined.js, or a stub
// in tests/fixture). `store` is the attach whitelist backend (./store.js):
// must expose has(uuid) / find(uuid), keyed strictly by normalized UUID.
import { EventEmitter } from 'node:events'

import { normalizeUuid } from './util.js'
import { redactSecrets } from '../driver/checks.js'

export const ATTACH_ALLOWED_EVENT = 'attachAllowed'
export const ATTACH_DENIED_EVENT = 'attachDenied'

// The exact denial reasons the B4 identity-separation row will assert on:
export const DENY_REASONS = Object.freeze({
  MISSING_USERNAME: 'missing_username',
  VERIFY_UNAVAILABLE: 'verify_unavailable',
  VERIFY_ERROR: 'verify_error',
  HASJOINED_FAILED: 'hasjoined_failed',
  HASJOINED_NOT_JOINED: 'not_joined',
  PROFILE_INVALID: 'profile_invalid',
  NAME_MISMATCH: 'profile_name_mismatch',
  NOT_WHITELISTED: 'not_whitelisted',
  WHITELIST_UNAVAILABLE: 'whitelist_unavailable',
})

export function createAttachCheck ({
  events: externalEvents = null,
  log = () => {},
  // Optional default store so callers embedding the check do not re-wire it
  // per connection; the per-call `store` argument still wins.
  store: defaultStore = null,
  // Optional default identity step; per-call `verify` still wins.
  verify: defaultVerify = null,
} = {}) {
  const events = externalEvents ?? new EventEmitter()

  function deny ({ reason, username, uuid = null, detail = null }) {
    log(`attachDenied reason=${reason} user=${username ?? '?'} uuid=${uuid ?? '-'}${detail ? ` detail=${detail}` : ''}`)
    events.emit(ATTACH_DENIED_EVENT, { username: username ?? null, uuid, reason, detail, stage: 'login' })
    return { ok: false, reason, stage: 'login', username: username ?? null, uuid }
  }

  function allow ({ username, uuid, name }) {
    log(`attachAllowed user=${username} uuid=${uuid}`)
    events.emit(ATTACH_ALLOWED_EVENT, { username, uuid, name, stage: 'login' })
    return { ok: true, reason: null, stage: 'login', username, uuid, name }
  }

  // Synchronous check for servers (minecraft-protocol) that have already
  // completed the real online-mode hasJoined and hand us client.uuid/client.profile
  // before beforeLogin. The async check above is for custom front legs.
  function checkVerified ({ client, store = defaultStore } = {}) {
    const username = typeof client?.username === 'string' ? client.username : null
    if (!username) return deny({ reason: DENY_REASONS.MISSING_USERNAME, username: null })
    const uuid = normalizeUuid(client?.uuid ?? client?.profile?.id)
    if (!uuid) return deny({ reason: DENY_REASONS.PROFILE_INVALID, username })
    if (!store || typeof store.has !== 'function') {
      return deny({ reason: DENY_REASONS.WHITELIST_UNAVAILABLE, username, uuid })
    }
    if (!store.has(uuid)) return deny({ reason: DENY_REASONS.NOT_WHITELISTED, username, uuid })
    return allow({ username, uuid, name: client.profile?.name ?? username })
  }

  async function check ({ client, store = defaultStore, verify = defaultVerify } = {}) {
    const username = typeof client?.username === 'string' ? client.username : null
    if (!username) {
      return deny({ reason: DENY_REASONS.MISSING_USERNAME, username: null })
    }
    if (typeof verify !== 'function') {
      return deny({ reason: DENY_REASONS.VERIFY_UNAVAILABLE, username })
    }
    if (!store || typeof store.has !== 'function') {
      return deny({ reason: DENY_REASONS.WHITELIST_UNAVAILABLE, username })
    }

    // 1. Identity verification (real hasJoined in production).
    let verification
    try {
      verification = await verify({ client, username })
    } catch (error) {
      return deny({
        reason: DENY_REASONS.VERIFY_ERROR,
        username,
        detail: redactSecrets(String(error && error.message ? error.message : error)).text.slice(0, 200),
      })
    }
    if (!verification || verification.ok !== true || verification.allowed !== true) {
      return deny({
        reason: verification?.ok === true ? DENY_REASONS.HASJOINED_NOT_JOINED : DENY_REASONS.HASJOINED_FAILED,
        username,
        detail: verification?.reason ? redactSecrets(String(verification.reason)).text.slice(0, 120) : null,
      })
    }
    const profile = verification.profile
    // Both shapes supported: raw sessionserver profile ({id, name}) and the
    // pre-normalized shape from ./hasjoined.js ({uuid, name}).
    const uuid = normalizeUuid(profile?.id ?? profile?.uuid)
    if (!uuid) {
      return deny({ reason: DENY_REASONS.PROFILE_INVALID, username })
    }
    if (typeof profile.name === 'string' && profile.name.toLowerCase() !== username.toLowerCase()) {
      return deny({ reason: DENY_REASONS.NAME_MISMATCH, username, uuid })
    }

    // 2. Attach whitelist: UUID-keyed, never name-keyed. The earlier cross-
    // check kept the verified name in sync with the connecting username; the
    // store decides on the UUID alone.
    if (!store.has(uuid)) {
      return deny({ reason: DENY_REASONS.NOT_WHITELISTED, username, uuid })
    }
    return allow({ username, uuid, name: profile.name })
  }

  return { check, checkVerified, events, denyReasons: DENY_REASONS }
}

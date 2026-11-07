// Real Mojang sessionserver `hasJoined` check for the Monoplayer front leg.
//
// The vanilla online-mode handshake ends with the *server's* sessionserver
// call: GET /session/minecraft/hasJoined?username=<name>&serverId=<sha1>. The
// 26.x server sends the client a serverId string, then after encryption the
// client runs the join itself — but a front leg that wants to deny BEFORE
// Login Success performs the equivalent check server-side (same endpoint).
//
// Injectable fetch keeps the unit tests pure; short TTL cache protects the
// ~200/15min Mojang API rate ceiling; failures are fail-closed.
import crypto from 'node:crypto'

import { normalizeUuid, sameName, sameUuid } from './util.js'

export const SESSIONSERVER_BASE = 'https://sessionserver.mojang.com'

// serverId for the hasJoined query = sha1(serverId-string + sharedSecret +
// publicKeyDER), hex. Callers that already have the final digest may pass it
// directly as `serverId`; this computes it from the handshake material.
export function computeServerId (serverIdString, sharedSecret, publicKeyDer) {
  const hash = crypto.createHash('sha1')
  hash.update(String(serverIdString ?? ''), 'binary')
  if (sharedSecret) hash.update(sharedSecret)
  if (publicKeyDer) hash.update(publicKeyDer)
  return hash.digest('hex')
}

export function normalizeProfile (profile) {
  if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') return null
  return { uuid: normalizeUuid(profile.id), name: profile.name }
}

export function createHasJoined ({
  fetchImpl = globalThis.fetch,
  baseUrl = SESSIONSERVER_BASE,
  ttlMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createHasJoined needs an injectable fetch (fetchImpl)')
  }
  const cache = new Map()

  async function check ({ username, serverId, uuid = null } = {}) {
    if (typeof username !== 'string' || username.length === 0 || typeof serverId !== 'string' || serverId.length === 0) {
      return { ok: true, allowed: false, reason: 'invalid_request', cached: false }
    }
    const key = `${username}/${serverId}`
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now()) {
      return { ok: true, allowed: hit.allowed, reason: hit.reason ?? null, profile: hit.profile ?? null, cached: true }
    }
    if (hit) cache.delete(key)

    const url = `${baseUrl}/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`
    let sessionserver
    try {
      sessionserver = await fetchImpl(url)
    } catch (error) {
      // Fail closed: an unreachable sessionserver must deny, never allow.
      return {
        ok: false,
        allowed: false,
        reason: `sessionserver_unreachable: ${String(error && error.message ? error.message : error).slice(0, 120)}`,
        cached: false,
      }
    }

    // 200 → joined with profile JSON; 204 → sessionserver says not joined.
    if (sessionserver.status !== 200) {
      const result = { ok: true, allowed: false, reason: `sessionserver_status_${sessionserver.status}`, cached: false }
      cache.set(key, { ...result, profile: null, expiresAt: now() + ttlMs })
      return result
    }

    let body
    try {
      body = await sessionserver.json()
    } catch {
      return { ok: true, allowed: false, reason: 'sessionserver_body_unreadable', cached: false }
    }

    const profile = normalizeProfile(body)
    if (!profile || !profile.uuid) {
      const result = { ok: true, allowed: false, reason: 'sessionserver_profile_invalid', cached: false }
      cache.set(key, { ...result, profile: null, expiresAt: now() + ttlMs })
      return result
    }

    // Cross-checks: the sessionserver answers for the verified name — the
    // profile must be for the username we asked about, and (when the caller
    // knows the expected UUID, e.g. from the attach whitelist) it must match.
    if (!sameName(profile.name, username)) {
      return { ok: true, allowed: false, reason: 'username_profile_mismatch', profile, cached: false }
    }
    if (uuid && !sameUuid(profile.uuid, uuid)) {
      return { ok: true, allowed: false, reason: 'uuid_mismatch', profile, cached: false }
    }
    const result = { ok: true, allowed: true, reason: null, profile, cached: false }
    cache.set(key, { ...result, profile, expiresAt: now() + ttlMs })
    return result
  }

  return { check, clearCache: () => cache.clear(), size: () => cache.size }
}

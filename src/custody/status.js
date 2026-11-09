// Read-only auth health for the Gate B puppet account (G1 `status`).
//
// Every operation here is read-only unless the caller explicitly asks for a
// refresh; a refresh takes custody's writer lock and REFUSES while the proxy
// holds it (`writer_lock_held`) — never contends silently, never rotates the
// rolling refresh token twice.
//
// The report is a redaction-enforced projection: it carries expiry, obtain
// times, file custody facts, and identity metadata only. All text leaves
// through redactForReport, so an accidental secret-shaped string (a token
// pasted into a field, a JWT in a message) is tagged, not emitted.
import fs from 'node:fs'

import { scanSecrets, redactSecrets, REDACTION_TAG } from '../gate-b/checks.js'
import { createTokenCustody } from './cache.js'
import { createMsaAuth, describeIdentity } from './msa.js'

// Cache-file meta projection. These readers walk the JSON structures but
// never copy token values out — only obtainedOn / expires_in style facts.
function msExpiry (token) {
  if (!token || typeof token !== 'object') return null
  const obtainedOn = typeof token.obtainedOn === 'number' ? token.obtainedOn : null
  const expiresInMs = typeof token.expires_in === 'number' ? token.expires_in * 1000 : null
  if (obtainedOn === null || expiresInMs === null) return null
  return obtainedOn + expiresInMs
}

export function createAuthStatus ({
  account = null,
  uuid = null,
  dir,
  custody = createTokenCustody({ account, uuid, dir, create: false }),
} = {}) {
  function cacheSummary (cacheName) {
    const file = custody.cacheFile(cacheName)
    let exists = false
    let bytes = null
    try {
      const stat = fs.statSync(file)
      exists = true
      bytes = stat.size
    } catch {
      return { cacheName, file, exists: false, bytes: null, hasAccessToken: false, hasRefreshToken: false, accessTokenExpiresAt: null, tokensExpired: false }
    }
    const cache = custody.readCache(cacheName)
    const token = cache?.token
    const hasAccessToken = Boolean(token && typeof token.access_token === 'string' && token.access_token.length > 0)
    // The refresh token is the password — represent it as presence only.
    const hasRefreshToken = Boolean(token && typeof token.refresh_token === 'string' && token.refresh_token.length > 0)
    const accessTokenExpiresAt = msExpiry(token)
    return {
      cacheName,
      file,
      exists,
      bytes,
      hasAccessToken,
      hasRefreshToken,
      accessTokenExpiresAt,
      tokensExpired: accessTokenExpiresAt !== null && accessTokenExpiresAt <= Date.now(),
    }
  }

  function mcaSummary () {
    const cache = custody.readCache('mca')
    const token = cache?.mca
    return {
      hasAccessToken: Boolean(token && typeof token.access_token === 'string'),
      expiresAt: msExpiry(token),
    }
  }

  // Read-only health snapshot. Pure file custody: no network, no token
  // rotation, no device-code path, no directory creation. custody.ensure() is
  // deliberately not called — status against a missing account dir must
  // report absence, not mkdir it.
  async function collect () {
    const files = custody.listFiles()
    const profile = custody.profile.read()
    return {
      account: {
        uuid: profile?.uuid ?? custody.uuid ?? null,
        name: profile?.name ?? null,
        alias: profile?.alias ?? null,
      },
      dir: custody.dir,
      profile,
      files,
      live: cacheSummary('live'),
      xbl: { exists: fs.existsSync(custody.cacheFile('xbl')), hasAccessToken: false, expiresAt: null },
      mca: mcaSummary(),
      identity: profile
        ? {
            uuid: profile.uuid,
            name: profile.name ?? null,
            alias: profile.alias ?? null,
            authTitle: profile.authTitle ?? null,
            updatedAt: profile.updatedAt ?? null,
          }
        : null,
      writerLock: {
        file: custody.writerLock.file,
        held: custody.writerLock.isHeld(),
        holder: custody.writerLock.holder(),
      },
      generatedAt: new Date().toISOString(),
      // Compatibility aliases for the single-account reports.
      cacheDir: custody.dir,
      cacheDirMode: custody.mode(),
    }
  }

  // Refresh status line: reports the stale/fresh identity, used after a
  // successful silent refresh to document the G1 "same UUID across refresh"
  // criterion. Read-only: file meta only.
  async function refreshLedger () {
    const profile = custody.profile.read()
    const live = cacheSummary('live')
    return {
      identity: profile
        ? {
            uuid: profile.uuid,
            name: profile.name,
            alias: profile.alias ?? null,
            authTitle: profile.authTitle,
            updatedAt: profile.updatedAt,
          }
        : null,
      liveCache: { hasRefreshToken: live.hasRefreshToken, accessTokenExpiresAt: live.accessTokenExpiresAt },
    }
  }

  // The only mutating operation this module exposes, behind the one-writer
  // lock. Refuses (does not wait) when the proxy holds the lock.
  async function refresh () {
    const ledger = await refreshLedger()
    const beforeUuid = ledger.identity?.uuid ?? null
    const msa = createMsaAuth({
      account: custody.account,
      uuid: custody.uuid,
      dir: custody.dir,
      custody,
    })
    const result = await msa.refreshSilently()
    if (result.refused) {
      return { ok: false, refused: true, reason: result.reason, holder: result.holder, ledger }
    }
    const afterLedger = await refreshLedger()
    return {
      ok: result.ok,
      reason: result.reason ?? null,
      error: result.error ?? null,
      identity: result.identity ?? null,
      identityLine: result.identity ? describeIdentity(result.identity) : null,
      uuidStable: result.ok
        ? (beforeUuid === null ? null : result.identity.uuid === beforeUuid)
        : null,
      previousUuid: result.previousUuid ?? null,
      ledger: { before: ledger, after: afterLedger },
    }
  }

  return { account: custody.account, custody, collect, refresh, refreshLedger }
}

// ---------------------------------------------------------------------------
// Report redaction
// ---------------------------------------------------------------------------

// Redaction sentinel contract: any secret-shaped string that sneaks into a
// report is replaced before the report leaves the process. Synthetic token
// strings used in tests (assigned to `token`, `access_token`, `refresh_token`,
// `device_code`, or bare JWT shapes) must never survive.
//
// Two passes: our local, auth-specific assignment prepass (device/refresh/
// access code-and-token keys, which the shared Gate B scanner does not know
// about) first, then the repo-wide scanner for the general shapes.
const LOCAL_ASSIGNMENT =
  /\b(device[_-]?code|refresh[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?:"([^"]{6,})"|'([^']{6,})'|([^\s"',;]{6,}))/gi

function localRedact (text) {
  const source = String(text ?? '')
  let out = ''
  let last = 0
  for (const match of source.matchAll(LOCAL_ASSIGNMENT)) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const start = match.index
    const valueStart = source.indexOf(value, start)
    if (start !== -1 && valueStart !== -1) {
      out += source.slice(last, valueStart) + `${REDACTION_TAG}<${key}>`
      last = valueStart + value.length
    }
  }
  out += source.slice(last)
  return out
}

export function redactForReport (text) {
  return redactSecrets(localRedact(text)).text
}

export function scanForLeaks (text) {
  const source = String(text ?? '')
  const seen = new Set()
  const findings = []
  for (const finding of [...scanSecrets(source)]) {
    const key = `${finding.kind}|${finding.index}`
    if (!seen.has(key)) { seen.add(key); findings.push({ kind: finding.kind, index: finding.index }) }
  }
  for (const match of source.matchAll(LOCAL_ASSIGNMENT)) {
    findings.push({ kind: `local:${match[1]}`, index: match.index })
  }
  return findings
}

export function stringifyForReport (value) {
  return JSON.stringify(value, (_key, val) => (typeof val === 'function' ? undefined : val))
}

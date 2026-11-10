// Microsoft auth for the puppet account via prismarine-auth 3.1.1.
//
// Boundary (architectural, repeated here so reviewers can enforce it):
//   - this module RETURNS identity facts only (name, uuid, entitlement
//     names, multiplayer privilege) — never tokens, signatures, or secrets;
//   - device-code URLs and user codes go to the caller's sink (the CLI sends
//     them to stderr), never stdout, never a report;
//   - the token cache is custody-owned (see ./cache.js): 0700 dir, 0600
//     files, atomic writes, one writer lock.
//
// authTitle fallback: the public Java launcher title `00000000402b5328`
// (Titles.MinecraftJava) is tried first; on title-auth-shaped errors (the
// known 403 at getTitleToken) the library-default Nintendo Switch title is
// tried next. Which title actually worked is recorded in the result.
// Deliberately NOT `sisu` (research 03 §2.2: profile 404 / empty
// entitlements reports for affected accounts).
import prismarineAuth from 'prismarine-auth'

import { createTokenCustody } from './cache.js'
import { normalizeUuid } from './util.js'
import { redactSecrets } from '../observability/secrets.js'

export const JAVA_AUTH_TITLE = '00000000402b5328'
export const SWITCH_AUTH_TITLE = '00000000441cc96b'
export const FALLBACK_AUTH_TITLES = [JAVA_AUTH_TITLE]
export const DEFAULT_DEVICE_TYPE = 'Win32'

// Live evidence on 2026-11-06: Titles.MinecraftJava + Win32 returns HTTP 403
// from Xbox titleAuth (known prismarine-auth issue #54/#182), while
// MinecraftNintendoSwitch + Nintendo is the working live device-code pair for
// a Minecraft Java profile. Try the working pair first; keep the Java title as
// the fallback and record whichever pair actually worked.
export const DEFAULT_AUTH_TITLE_PROFILES = [
  { authTitle: SWITCH_AUTH_TITLE, deviceType: 'Nintendo' },
  { authTitle: JAVA_AUTH_TITLE, deviceType: 'Win32' },
]
export const MC_SERVICES_ATTRIBUTES_URL = 'https://api.minecraftservices.com/player/attributes'

// Entitlement names that satisfy "owns Java Edition" on either entitlement
// endpoint (`mcstore`: product_* / game_*; newer `license`: minecraft_game).
const JAVA_ENTITLEMENT_NAMES = new Set(['product_minecraft', 'game_minecraft', 'minecraft_game'])

// Classify an auth failure: 'title-auth' failures are candidates for the
// next authTitle; device-code failures (timeout, user decline, poll stalled)
// and everything else are NOT retried with a different title — the user may
// already have approved the first device code.
export function classifyAuthFailure (error) {
  const text = String(error && error.message ? error.message : error ?? '')
  if (/timed out|authorization_pending|access_denied|device[_ ]code|declined|expired/i.test(text)) {
    return 'device-code'
  }
  if (/\b4\d\d\b|forbidden|unauthorized|xsts?|xerr|title/i.test(text)) {
    return 'title-auth'
  }
  return 'session'
}

// Entitlements summary: names only — the item `signature` blobs never leave
// this module. Accepts both mcstore shape (`items: [{name, signature}]`) and
// the license shape (`items: [{name, source}]`).
export function summarizeEntitlements (entitlements) {
  const items = entitlements && Array.isArray(entitlements.items) ? entitlements.items : []
  const products = items.map(item => item.name).filter(name => typeof name === 'string')
  return {
    hasJava: products.some(name => JAVA_ENTITLEMENT_NAMES.has(name)),
    products,
  }
}

// Multiplayer privilege from Minecraft services player/attributes:
//   privileges.multiplayerServer.enable === true, and no
//   banStatus.bannedScopes.MULTIPLAYER entry. Unknown (null) on any failure —
//   never synthesized false "known" answers.
export function summarizePlayerAttributes (attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return { multiplayerServer: null, banned: null, known: false }
  }
  const multiplayer = attributes.privileges?.multiplayerServer
  // Minecraft's live API currently returns `enabled`; older fixtures/docs use
  // `enable`. Accept both so a real account reports allowed, not unknown.
  const enable = multiplayer?.enabled ?? multiplayer?.enable
  const banned = Boolean(attributes.banStatus?.bannedScopes?.MULTIPLAYER)
  return {
    multiplayerServer: enable === true ? true : enable === false ? false : null,
    banned,
    known: enable === true || enable === false,
  }
}

// Identity is the safe projection callers may hold, log, or report.
export function buildIdentity ({ profile, entitlements, attributes, authTitle }) {
  const uuid = profile && normalizeUuid(profile.id)
  return {
    name: profile && typeof profile.name === 'string' ? profile.name : null,
    uuid,
    entitlements: summarizeEntitlements(entitlements),
    multiplayer: summarizePlayerAttributes(attributes),
    authTitle: typeof authTitle === 'string' ? authTitle : null,
  }
}

export function describeIdentity (identity) {
  if (!identity) return 'no identity'
  const mp = identity.multiplayer
  const mpText = mp.known
    ? `multiplayer=${mp.multiplayerServer ? 'allowed' : 'blocked'}` + (mp.banned ? ' (banned)' : '')
    : 'multiplayer=unknown'
  const java = identity.entitlements.hasJava ? 'java=owned' : 'java=NOT owned'
  return `name=${identity.name ?? '?'} uuid=${identity.uuid ?? '?'} ${java} ${mpText} authTitle=${identity.authTitle ?? '?'}`
}

// An error that may be surfaced to a user/report: message only, redacted.
export function sanitizeError (error) {
  const raw = String(error && error.message ? error.message : error ?? '')
  return { message: redactSecrets(raw).text }
}

// Minecraft services player/attributes check. Runs only when the caller
// already holds a Minecraft bearer token in its local variable; the token is
// consumed here and never returned.
async function defaultFetchPlayerAttributes (mcToken, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(MC_SERVICES_ATTRIBUTES_URL, {
      headers: { Authorization: `Bearer ${mcToken}` },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

export function createMsaAuth ({
  account = null,
  uuid = null,
  dir,
  custody = createTokenCustody({ account, uuid, dir, create: false }),
  AuthflowImpl = prismarineAuth.Authflow,
  titleProfiles = DEFAULT_AUTH_TITLE_PROFILES,
  fetchPlayerAttributes = defaultFetchPlayerAttributes,
  flow = 'live',
} = {}) {
  if (!custody.cacheFactory || !custody.writerLock || !custody.profile) {
    throw new Error('custody must provide cacheFactory, writerLock and profile (use createTokenCustody)')
  }

  // codeCallback: device code goes wherever the caller sends it (CLI →
  // stderr). Throwing inside a callback aborts the flow silently-for-us.
  const codeHandler = (sink, silent) => (response) => {
    if (silent) {
      const error = new Error('unexpected device code in silent refresh (cache needs re-bootstrap)')
      error.code = 'unexpected_device_code'
      throw error
    }
    sink?.(`To authorize, open: ${response.verification_uri}`)
    sink?.(`User code: ${response.user_code}`)
    sink?.(`(${response.message ?? ''})`)
  }
  async function toIdentity (flowInstance, authTitle, deviceType) {
    // getMinecraftJavaToken returns { token, entitlements, profile }; token
    // stays a local variable and is consumed for the attributes check only.
    const result = await flowInstance.getMinecraftJavaToken({
      fetchProfile: true,
      fetchEntitlements: true,
    })
    const attributes = result.token
      ? await fetchPlayerAttributes(result.token, {})
      : null
    const identity = buildIdentity({ profile: result.profile, entitlements: result.entitlements, attributes, authTitle })
    if (!identity.uuid) {
      throw new Error('auth succeeded but the profile response had no usable UUID (account may not own Java)')
    }
    // The account directory is keyed by UUID. A login that resolves to another
    // account must never overwrite this directory's profile.json.
    if (custody.uuid && identity.uuid !== custody.uuid) {
      const error = new Error(`identity uuid ${identity.uuid} does not match account uuid ${custody.uuid}`)
      error.code = 'identity_mismatch'
      throw error
    }
    custody.profile.write({ uuid: identity.uuid, name: identity.name, authTitle, deviceType })
    return identity
  }

  // The custody factory owns the cache paths; the auth flow username is never
  // used to compute a file name. uuid ?? account keeps the identity stable for
  // the flow's own session bookkeeping.
  function newFlow ({ authTitle, deviceType = DEFAULT_DEVICE_TYPE, silent = false, codeSink = null } = {}) {
    return new AuthflowImpl(custody.uuid ?? custody.account ?? 'monoplayer', (opts) => custody.cacheFactory(opts), {
      flow,
      authTitle,
      deviceType,
    }, codeHandler(codeSink, silent))
  }

  // Interactive device-code bootstrap. Holds the writer lock for the whole
  // flow: nothing else may rotate the token while the user is approving, and
  // the resulting cache write is the custody write.
  async function bootstrapDeviceCode ({ codeSink = null, onAttempt = null } = {}) {
    const lock = custody.writerLock.acquire()
    if (!lock.ok) {
      return { ok: false, refused: true, reason: lock.reason, holder: lock.holder ?? null }
    }
    try {
      const attempts = []
      for (const profile of titleProfiles) {
        try {
          const identity = await toIdentity(
            newFlow({ authTitle: profile.authTitle, deviceType: profile.deviceType, codeSink }),
            profile.authTitle,
            profile.deviceType
          )
          return { ok: true, attempts: attempts.length, identity }
        } catch (error) {
          const attempt = {
            authTitle: profile.authTitle,
            deviceType: profile.deviceType,
            failure: error.code === 'identity_mismatch' ? 'identity_mismatch' : classifyAuthFailure(error),
            ...sanitizeError(error),
          }
          attempts.push(attempt)
          onAttempt?.(attempt)
          // A different account resolved from the same token cache: no title
          // can change that, and the profile must stay untouched.
          if (error.code === 'identity_mismatch') {
            return { ok: false, reason: 'identity_mismatch', attempts }
          }
          if (attempt.failure !== 'title-auth') break
          // next title
        }
      }
      return {
        ok: false,
        reason: attempts[attempts.length - 1]?.failure === 'device-code'
          ? 'device_code_not_completed_or_timed_out'
          : 'auth_failed_after_all_titles',
        attempts,
      }
    } finally {
      const release = custody.writerLock.release()
      if (!release.ok) {
        // Never expected: the lock we just acquired is somehow not ours.
        onAttempt?.({ authTitle: null, failure: 'lock', failureNote: release.reason })
      }
    }
  }

  // Silent refresh. Must NEVER wait for user input:
  //   - refuse upfront when the live cache has no refresh token at all,
  //   - any device-code prompt inside the flow is an error of type
  //     `needs_reauthentication`, not a code on screen.
  async function refreshSilently () {
    const lock = custody.writerLock.acquire()
    if (!lock.ok) {
      return { ok: false, refused: true, reason: lock.reason, holder: lock.holder ?? null }
    }
    try {
      const live = custody.readCache('live')
      if (!live || !live.token || typeof live.token.refresh_token !== 'string' || live.token.refresh_token === '') {
        return { ok: false, reason: 'needs_bootstrap' }
      }
      try {
        const before = custody.profile.read()
        const profile = titleProfiles.find(item => item.authTitle === before?.authTitle) ??
          { authTitle: before?.authTitle ?? titleProfiles[0].authTitle, deviceType: before?.deviceType ?? titleProfiles[0].deviceType }
        const identity = await toIdentity(
          newFlow({ authTitle: profile.authTitle, deviceType: profile.deviceType, silent: true }),
          profile.authTitle,
          profile.deviceType
        )
        return {
          ok: true,
          identity,
          uuidStable: before ? before.uuid === identity.uuid : null,
          previousUuid: before?.uuid ?? null,
        }
      } catch (error) {
        if (error.code === 'unexpected_device_code') {
          return { ok: false, reason: 'needs_reauthentication' }
        }
        if (error.code === 'identity_mismatch') {
          // Do not try another title: the account is wrong, not the title.
          return { ok: false, reason: 'identity_mismatch' }
        }
        return { ok: false, reason: 'refresh_failed', error: sanitizeError(error) }
      }
    } finally {
      custody.writerLock.release()
    }
  }

  return {
    custody,
    bootstrapDeviceCode,
    refreshSilently,
    titleProfiles,
    authTitles: titleProfiles.map(profile => profile.authTitle),
  }
}

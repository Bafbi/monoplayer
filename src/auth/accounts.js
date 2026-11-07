// Multi-account directory model for Gate B puppet tokens.
//
// Layout (all under `.secrets/`):
//   accounts/<canonical-uuid>/   one custody directory per Minecraft UUID
//     profile.json               version, uuid, name, alias, authTitle, ...
//     <family>-cache.json        live/xbl/mca/... readable token caches
//     writer.lock                per-account, transient
//   staging/<16-hex>/            pre-login bootstrap; never selectable
//   retired/                     quarantined legacy directories
//   .accounts.lock               short structure lock for rename/finalize
//
// This module is pure filesystem logic with an optional injected fs subset.
// Token contents are never read or returned here; only profiles, names, and
// paths.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { normalizeUuid } from './util.js'
import { createWriterLock, readProfile, writeProfile } from './cache.js'

export const DEFAULT_ACCOUNTS_DIR = '.secrets/accounts'
export const DEFAULT_STAGING_DIR = '.secrets/staging'
export const DEFAULT_RETIRED_DIR = '.secrets/retired'
export const ACCOUNTS_LOCK_FILE = '.accounts.lock'
export const STAGING_DIR_MODE = 0o700

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/
const CACHE_FILE_PATTERN = /-cache\.json$/

const defaultFs = {
  readdirSync: fs.readdirSync,
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
  readFileSync: fs.readFileSync,
  chmodSync: fs.chmodSync,
}

function ops (fsOps) {
  return fsOps ? { ...defaultFs, ...fsOps } : defaultFs
}

export function isUuid (value) {
  return normalizeUuid(value) !== null
}

// Normalize a selector the same way the directory model keys accounts:
// trimmed, lowercase, and UUIDs in canonical dashed form. Text selectors are
// never interpreted as paths.
export function normalizeAccountSelector (value) {
  const text = String(value ?? '').trim().toLowerCase()
  return isUuid(text) ? normalizeUuid(text) : text
}

function canonicalDirName (name) {
  const normalized = normalizeUuid(name)
  return normalized !== null ? normalized : null
}

function candidateFor (account) {
  return {
    uuid: account.uuid,
    name: account.name ?? null,
    alias: account.alias ?? null,
    dir: account.dir,
  }
}

function cacheFilesIn (dir, f) {
  try {
    return f.readdirSync(dir).filter(name => CACHE_FILE_PATTERN.test(name))
  } catch {
    return []
  }
}

// List account directories. Only real directories whose basename parses as a
// UUID are selectable. Symlinks are skipped. Broken directories (no profile,
// basename/profile uuid mismatch, duplicate uuid) are reported separately and
// are never selectable. Non-UUID directories holding a cache are 'pending'
// and only reported.
export function listAccounts ({ accountsDir, fsOps = null } = {}) {
  const f = ops(fsOps)
  const broken = []
  const pending = []
  const accounts = []

  let names
  try {
    names = f.readdirSync(String(accountsDir))
  } catch {
    return { accounts: [], broken: [], pending: [] }
  }

  for (const name of names) {
    const dir = path.join(String(accountsDir), name)
    let stat
    try { stat = f.lstatSync(dir) } catch { continue }
    if (stat.isSymbolicLink && stat.isSymbolicLink()) continue
    if (!stat.isDirectory()) continue

    const normalized = canonicalDirName(name)
    if (!normalized) {
      const cacheFiles = cacheFilesIn(dir, f)
      if (cacheFiles.length > 0) {
        pending.push({ name, dir, cacheFiles, reason: 'not_a_uuid_dir' })
      }
      continue
    }

    const profile = readProfile(dir, { readFile: f.readFileSync })
    if (!profile) {
      broken.push({ uuid: normalized, dir, name: null, alias: null, reason: 'missing_profile', profile: null })
      continue
    }
    if (profile.uuid !== normalized) {
      broken.push({
        uuid: normalized,
        dir,
        name: profile.name ?? null,
        alias: profile.alias ?? null,
        reason: 'uuid_mismatch',
        profile,
      })
      continue
    }
    accounts.push({
      uuid: normalized,
      name: profile.name ?? null,
      alias: profile.alias ?? null,
      dir,
      profile,
    })
  }

  // Deduplicate defensively: a duplicate uuid makes every directory with that
  // uuid unselectable until an operator removes one.
  const byUuid = new Map()
  for (const account of accounts) {
    if (!byUuid.has(account.uuid)) byUuid.set(account.uuid, [])
    byUuid.get(account.uuid).push(account)
  }
  const usable = []
  for (const [uuid, group] of byUuid) {
    if (group.length === 1) {
      usable.push(group[0])
      continue
    }
    for (const account of group) {
      broken.push({ ...account, reason: 'duplicate_uuid', duplicateOf: group.map(item => item.dir) })
    }
  }

  const order = account => (account.alias ?? account.name ?? account.uuid).toLowerCase()
  usable.sort((a, b) => order(a).localeCompare(order(b)))
  return { accounts: usable, broken, pending }
}

// Resolve one selector to exactly one usable account. Selection order:
// UUID (normalized), then alias (case-insensitive), then name
// (case-insensitive). A UUID-shaped selector matches only a UUID; it never
// falls through to an alias or name. Path-like selectors simply fail to
// match — they are never joined into a path.
export function resolveAccount ({ accountsDir, selector = null, fsOps = null } = {}) {
  const listing = listAccounts({ accountsDir, fsOps })
  const candidates = listing.accounts.map(candidateFor)

  if (listing.accounts.length === 0) {
    return {
      ok: false,
      account: null,
      reason: listing.broken.length > 0 ? 'no_usable_accounts' : 'no_accounts',
      candidates,
    }
  }

  if (selector === null || selector === undefined) {
    if (listing.accounts.length === 1) {
      return { ok: true, account: listing.accounts[0], reason: null, candidates }
    }
    return { ok: false, account: null, reason: 'account_required', candidates }
  }

  const wanted = normalizeAccountSelector(selector)
  let matches
  if (isUuid(wanted)) {
    matches = listing.accounts.filter(account => account.uuid === wanted)
  } else {
    matches = listing.accounts.filter(account =>
      typeof account.alias === 'string' && account.alias.toLowerCase() === wanted)
    if (matches.length === 0) {
      matches = listing.accounts.filter(account =>
        typeof account.name === 'string' && account.name.toLowerCase() === wanted)
    }
  }

  if (matches.length === 1) {
    return { ok: true, account: matches[0], reason: null, candidates }
  }
  if (matches.length > 1) {
    return { ok: false, account: null, reason: 'ambiguous', candidates: matches.map(candidateFor) }
  }
  return { ok: false, account: null, reason: 'not_found', candidates }
}

export function accountDir (accountsDir, uuid) {
  const normalized = normalizeUuid(uuid)
  if (!normalized) {
    throw new Error(`accountDir requires a valid UUID, got ${JSON.stringify(uuid)}`)
  }
  return path.join(String(accountsDir), normalized)
}

// Create a fresh staging directory named with 16 hex characters, mode 0700.
// Callers hold the staging writer.lock here during login; a staging directory
// is never selectable by listAccounts/resolveAccount.
export function createStagingDir ({ stagingDir = DEFAULT_STAGING_DIR, mkdirSync = fs.mkdirSync, randomBytes = crypto.randomBytes } = {}) {
  const name = randomBytes(8).toString('hex')
  const dir = path.join(String(stagingDir), name)
  mkdirSync(dir, { recursive: true, mode: STAGING_DIR_MODE })
  try { fs.chmodSync(dir, STAGING_DIR_MODE) } catch { /* best effort */ }
  return dir
}

// Promulgate a fully-authenticated staging directory into the account tree.
// The caller MUST release the staging writer.lock before calling this: the
// staging directory is about to move, so a lock file inside it would move
// with it and poison the new account.
//
// The short structure lock (<secretsDir>/.accounts.lock) makes alias
// validation and the rename one step: two bootstraps cannot claim the same
// alias or uuid.
export function finalizeStaging ({ stagingDir, accountsDir, secretsDir, profile, alias = null, fsOps = null } = {}) {
  const f = ops(fsOps)
  const uuid = normalizeUuid(profile?.uuid)
  if (!uuid) return { ok: false, reason: 'invalid_uuid' }

  const chosenAlias = alias ?? profile?.alias ?? null
  if (chosenAlias !== null && chosenAlias !== undefined) {
    if (!ALIAS_PATTERN.test(chosenAlias) || isUuid(chosenAlias)) {
      return { ok: false, reason: 'invalid_alias' }
    }
  }

  try { f.mkdirSync(String(secretsDir), { recursive: true, mode: 0o700 }) } catch { /* lock acquire will fail loudly if not */ }
  const lock = createWriterLock({ dir: String(secretsDir), name: ACCOUNTS_LOCK_FILE })
  const acquired = lock.acquire()
  if (!acquired.ok) {
    return { ok: false, reason: acquired.reason, holder: acquired.holder ?? null }
  }

  try {
    if (!f.existsSync(String(stagingDir))) return { ok: false, reason: 'staging_missing' }
    if (chosenAlias !== null && chosenAlias !== undefined) {
      const taken = listAccounts({ accountsDir, fsOps: f }).accounts
        .some(account => typeof account.alias === 'string' && account.alias.toLowerCase() === chosenAlias.toLowerCase())
      if (taken) return { ok: false, reason: 'alias_taken' }
    }
    const target = accountDir(accountsDir, uuid)
    if (f.existsSync(target)) return { ok: false, reason: 'target_exists' }

    writeProfile(String(stagingDir), { ...profile, uuid, alias: chosenAlias }, { allowUuidChange: true })
    f.mkdirSync(String(accountsDir), { recursive: true, mode: 0o700 })
    f.renameSync(String(stagingDir), target)
    try { f.chmodSync(target, 0o700) } catch { /* best effort */ }

    return {
      ok: true,
      dir: target,
      account: {
        uuid,
        name: profile.name ?? null,
        alias: chosenAlias ?? null,
        dir: target,
        profile: readProfile(target, { readFile: f.readFileSync }),
      },
    }
  } catch (error) {
    return { ok: false, reason: 'finalize_failed', error: error?.message ?? String(error) }
  } finally {
    lock.release()
  }
}

// Report a pre-migration legacy custody directory (`<secretsDir>/puppet`).
// Read-only.
export function detectLegacyLayout ({ secretsDir, from = 'puppet', accountsDir = DEFAULT_ACCOUNTS_DIR } = {}) {
  const dir = path.join(String(secretsDir), from)
  const resolvedAccountsDir = accountsDir === DEFAULT_ACCOUNTS_DIR && String(secretsDir) !== '.secrets'
    ? path.join(String(secretsDir), 'accounts')
    : String(accountsDir)
  let stat = null
  try { stat = fs.lstatSync(dir) } catch { /* absent */ }
  if (!stat || !stat.isDirectory()) {
    return { found: false, dir, profile: null, files: [], target: null, targetExists: false, reason: 'not_found' }
  }

  const profile = readProfile(dir)
  const files = []
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^([0-9a-f]{6})_([a-z]+)-cache\.json$/.exec(name)
      if (!match) continue
      let bytes = null
      try { bytes = fs.statSync(path.join(dir, name)).size } catch { /* race */ }
      files.push({ name, file: path.join(dir, name), family: match[2], bytes })
    }
  } catch { /* unreadable */ }

  if (!profile && files.length === 0) {
    return { found: false, dir, profile: null, files: [], target: null, targetExists: false, reason: 'empty' }
  }

  const target = profile?.uuid ? path.join(resolvedAccountsDir, profile.uuid) : null
  return {
    found: true,
    dir,
    profile,
    files,
    target,
    targetExists: target ? fs.existsSync(target) : false,
    reason: profile?.uuid ? null : 'no_identity',
  }
}

// Run `fn` while holding the structure lock. Async-safe: the lock is released
// after the promise settles.
export async function withAccountsLock ({ secretsDir, name = ACCOUNTS_LOCK_FILE }, fn) {
  fs.mkdirSync(String(secretsDir), { recursive: true, mode: 0o700 })
  const lock = createWriterLock({ dir: String(secretsDir), name })
  const acquired = lock.acquire()
  if (!acquired.ok) {
    const error = new Error('accounts structure lock is held')
    error.code = 'accounts_lock_held'
    error.holder = acquired.holder ?? null
    throw error
  }
  try {
    return await fn(lock)
  } finally {
    lock.release()
  }
}

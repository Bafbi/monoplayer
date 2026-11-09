// Token-cache custody for Gate B puppet accounts.
//
// The refresh token is the password. This module owns the file custody:
//   - one account directory (default `.secrets/accounts/<uuid>/`), mode 0700,
//   - readable cache files (`<family>-cache.json`) written 0600 via temp-file
//     + fsync + rename (atomic),
//   - one writer lock per account so exactly one process ever rotates a
//     token,
//   - a profile (`profile.json`) carrying uuid/name/alias/authTitle, never
//     token values,
//   - a path-only API: callers pass directories and receive file paths,
//     never cached token values.
//
// The factory returned by createAtomicCacheFactory satisfies the
// prismarine-auth Cache contract ({ getCached, setCached, setCachedPartial,
// reset }). prismarine-auth only computes a filename when the `cache`
// argument is a string; when it is a function the library calls it with
// `{ cacheName, username }` and uses whatever cache object we return
// (node_modules/prismarine-auth/src/MicrosoftAuthFlow.js:44-70). Our factory
// therefore owns the path and writes readable names.
//
// One-release compatibility: old custody directories used
// `<sha1(username).slice(0,6)>_<cacheName>-cache.json`. cache.file is readable
// now, and the factory adopts a legacy hashed file on first touch (same-dir
// rename, atomic). Writes always use the readable name.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { normalizeUuid } from './util.js'

export const PRISMARINE_CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb']

export const PROFILE_FILE = 'profile.json'
export const LEGACY_PROFILE_FILE = 'identity.meta.json'
export const WRITER_LOCK_FILE = 'writer.lock'

export const CACHE_DIR_MODE = 0o700
export const CACHE_FILE_MODE = 0o600

// sha1 hex prefix — the name prismarine-auth's own FileCache writes.
export function cacheIdHash (username) {
  return crypto.createHash('sha1').update(String(username ?? ''), 'binary').digest('hex').slice(0, 6)
}

function assertCacheName (cacheName) {
  if (!PRISMARINE_CACHE_IDS.includes(cacheName)) {
    throw new Error(`Cannot compute a cache path for unknown cache ID: '${cacheName}'`)
  }
}

// Readable cache location: `<dir>/<family>-cache.json`.
export function cacheFilePath (dir, cacheName) {
  assertCacheName(cacheName)
  return path.join(String(dir ?? ''), `${cacheName}-cache.json`)
}

// Legacy hashed location, kept for migration and one-release adoption only.
export function legacyCacheFilePath (dir, username, cacheName) {
  assertCacheName(cacheName)
  return path.join(String(dir ?? ''), `${cacheIdHash(username)}_${cacheName}-cache.json`)
}

// Create the custody directory if missing and force 0700 when we can (an
// existing directory installed with looser mode is the operator's problem,
// but we still record mode in status).
export function ensureCacheDir (dir) {
  fs.mkdirSync(String(dir), { recursive: true, mode: CACHE_DIR_MODE })
  try { fs.chmodSync(String(dir), CACHE_DIR_MODE) } catch { /* best effort */ }
  return String(dir)
}

export function dirMode (dir) {
  try {
    return (fs.statSync(String(dir)).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

function safeJson (readFile, file) {
  try {
    return JSON.parse(String(readFile(file, 'utf8')))
  } catch {
    return null
  }
}

// Canonical profile shape. Unknown fields are dropped; token values are never
// part of a profile.
function normalizeProfile (raw) {
  const uuid = normalizeUuid(raw?.uuid)
  if (!uuid) return null
  const profile = {
    version: Number.isInteger(raw.version) ? raw.version : 1,
    uuid,
    name: typeof raw.name === 'string' ? raw.name : null,
    alias: typeof raw.alias === 'string' ? raw.alias : null,
    authTitle: typeof raw.authTitle === 'string' ? raw.authTitle : null,
    deviceType: typeof raw.deviceType === 'string' ? raw.deviceType : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
  if (typeof raw.createdAt === 'string') profile.createdAt = raw.createdAt
  if (typeof raw.migratedAt === 'string') profile.migratedAt = raw.migratedAt
  if (typeof raw.migratedFrom === 'string') profile.migratedFrom = raw.migratedFrom
  return profile
}

// Read the account profile. Try profile.json first; fall back to the legacy
// identity.meta.json (mapping its `account` field to `alias`). Bad JSON or a
// missing uuid yields null. Never writes.
export function readProfile (dir, { readFile = fs.readFileSync } = {}) {
  const fromProfile = normalizeProfile(safeJson(readFile, path.join(String(dir), PROFILE_FILE)))
  if (fromProfile) return fromProfile

  const meta = safeJson(readFile, path.join(String(dir), LEGACY_PROFILE_FILE))
  if (!meta) return null
  return normalizeProfile({
    uuid: meta.uuid,
    name: meta.name,
    alias: meta.alias ?? meta.account ?? null,
    authTitle: meta.authTitle,
    deviceType: meta.deviceType,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    migratedAt: meta.migratedAt,
    migratedFrom: meta.migratedFrom,
  })
}

function definedEntries (value) {
  return Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)
}

// Atomic 0600 profile write. Merges with the existing profile so a refresh
// that supplies only uuid/name/authTitle keeps alias/version/createdAt and
// migration provenance. A uuid change is refused unless the caller opts in.
export function writeProfile (dir, profile, { allowUuidChange = false, now = Date.now, ...writeOpts } = {}) {
  const uuid = normalizeUuid(profile?.uuid)
  if (!uuid) {
    throw new Error('refusing to write a profile without a normalized uuid')
  }
  const existing = readProfile(dir)
  if (existing && existing.uuid !== uuid && !allowUuidChange) {
    throw new Error(`refusing to change profile uuid from ${existing.uuid} to ${uuid}`)
  }
  const merged = {
    ...(existing ?? {}),
    ...Object.fromEntries(definedEntries(profile)),
    uuid,
  }
  merged.version = Number.isInteger(merged.version) ? merged.version : 1
  merged.updatedAt = typeof profile.updatedAt === 'string'
    ? profile.updatedAt
    : new Date(now()).toISOString()
  if (!merged.createdAt) merged.createdAt = existing?.createdAt ?? merged.updatedAt
  const normalized = normalizeProfile(merged)
  ensureCacheDir(dir)
  atomicWriteFile(path.join(String(dir), PROFILE_FILE), JSON.stringify(normalized), writeOpts)
  return normalized
}

// One cache-file read for exactly one cache family. Readable name first, then
// the legacy hashed name. Returns the parsed JSON object or null. This is the
// *meta* reading API for status; callers must never log the returned object
// raw (it contains tokens when the cache is warm — status picks only
// expiry/obtain fields out of it).
export function readCacheFile (dir, username, cacheName, readFile = fs.readFileSync) {
  const candidates = [cacheFilePath(dir, cacheName)]
  if (username !== null && username !== undefined) {
    candidates.push(legacyCacheFilePath(dir, username, cacheName))
  }
  for (const file of candidates) {
    const parsed = safeJson(readFile, file)
    if (parsed !== null) return parsed
  }
  return null
}

// Atomic JSON write: temp file in the same directory (mode 0600), fsync,
// rename over the target. `beforeRename` is a test hook that may throw to
// simulate a crash mid-write; the previous cache file must survive.
export function atomicWriteFile (file, data, { beforeRename = null, mode = CACHE_FILE_MODE, writeFileSync = fs.writeFileSync, open = fs.openSync, close = fs.closeSync, fsync = fs.fsyncSync, rename = fs.renameSync, unlink = fs.unlinkSync } = {}) {
  const dir = path.dirname(String(file))
  const tmp = path.join(dir, `.${path.basename(String(file))}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  let fd = null
  try {
    fd = open(tmp, 'wx', mode)
    writeFileSync(fd, data)
    fsync(fd)
    if (beforeRename) beforeRename({ tmp })
    rename(tmp, String(file))
  } catch (error) {
    // Do not leave temp-file orphans behind on failed custody writes.
    try { if (!error?.alreadyRenamed) unlink(tmp) } catch { /* best effort */ }
    throw error
  } finally {
    if (fd !== null) {
      try { close(fd) } catch { /* best effort */ }
    }
  }
  // rename preserves the mode bit we opened with; chmod defensively anyway.
  try { fs.chmodSync(String(file), mode) } catch { /* best effort */ }
  return tmp // already gone after a successful rename; returned for tests
}

// Cache factory compatible with prismarine-auth's Authflow `cache` argument:
// Authflow calls it with { cacheName, username } for each of the cache
// families it manages. Writes always use the readable name. On the first
// getCached/setCached for a family, a legacy hashed file (if present and the
// readable file is absent) is renamed into place — same directory, atomic.
export function createAtomicCacheFactory ({ dir, create = true, legacyAccount = null, beforeRename = null, now = Date.now } = {}) {
  if (create) ensureCacheDir(dir)
  return function cacheFactory ({ username, cacheName }) {
    const file = cacheFilePath(dir, cacheName)
    const legacyUser = legacyAccount ?? username
    const legacyFile = legacyUser === null || legacyUser === undefined
      ? null
      : legacyCacheFilePath(dir, legacyUser, cacheName)
    let adopted = false
    let memory

    function adoptLegacy () {
      if (adopted) return
      adopted = true
      if (!legacyFile || legacyFile === file) return
      try {
        if (!fs.existsSync(file) && fs.existsSync(legacyFile)) {
          if (create) ensureCacheDir(dir)
          fs.renameSync(legacyFile, file)
          try { fs.chmodSync(file, CACHE_FILE_MODE) } catch { /* best effort */ }
        }
      } catch {
        // Adoption is best effort; a read then starts empty and a write uses
        // the readable name anyway.
      }
    }

    const legit = {
      async reset () {
        adoptLegacy()
        memory = {}
        if (create) ensureCacheDir(dir)
        atomicWriteFile(file, JSON.stringify({}), { beforeRename })
        return memory
      },
      async getCached () {
        adoptLegacy()
        if (memory === undefined) {
          try {
            memory = JSON.parse(fs.readFileSync(file, 'utf8'))
          } catch {
            return legit.reset()
          }
        }
        return memory
      },
      async setCached (value) {
        adoptLegacy()
        memory = value ?? {}
        if (create) ensureCacheDir(dir)
        atomicWriteFile(file, JSON.stringify(memory), { beforeRename })
        return memory
      },
      async setCachedPartial (value) {
        const current = await legit.getCached()
        return legit.setCached({ ...current, ...value })
      },
    }
    // Path-only introspection surface (never the value):
    legit.file = file
    legit.cacheName = cacheName
    legit.username = String(username ?? '')
    legit.now = now
    return legit
  }
}

export function listCacheFiles (dir) {
  let entries
  try {
    entries = fs.readdirSync(String(dir))
  } catch {
    return []
  }
  return entries
    .filter(name => name.endsWith('-cache.json') || name === WRITER_LOCK_FILE || name === PROFILE_FILE || name === LEGACY_PROFILE_FILE)
    .map(name => {
      const full = path.join(String(dir), name)
      let stat = null
      try { stat = fs.statSync(full) } catch { return null }
      return { name, file: full, bytes: stat.size, mtimeIso: new Date(stat.mtimeMs).toISOString() }
    })
    .filter(Boolean)
}

// Compatibility aliases: old callers read/write identity.meta.json through
// these. Both now go through the profile, so a refresh cannot fork the
// identity record into two files. readIdentityMeta still falls back to a
// pre-migration identity.meta.json (readProfile does that).
export function readIdentityMeta (dir, readFile = fs.readFileSync) {
  return readProfile(dir, { readFile })
}

export function writeIdentityMeta (dir, meta, opts = {}) {
  return writeProfile(dir, meta, opts)
}

// ---------------------------------------------------------------------------
// The one-writer lock
// ---------------------------------------------------------------------------

// The refresh token is rolling/single-use: two refreshers race and can leave
// every cached value invalid (`invalid_grant`). The proxy (later workstream)
// is the only writer while it runs; the CLI's device-code / --refresh paths
// acquire this lock and refuse while it is held. Locks live inside the
// account directory, so account A's lock never blocks account B.
export function createWriterLock ({
  dir,
  name = WRITER_LOCK_FILE,
  now = Date.now,
  // Injectable liveness check for the polling case; default: same-machine pid.
  isProcessAlive = pid => {
    if (typeof pid !== 'number' || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) {
      return error.code === 'EPERM' // exists, we cannot signal it: treat as alive
    }
  },
  open = fs.openSync,
  close = fs.closeSync,
  unlink = fs.unlinkSync,
} = {}) {
  const file = path.join(String(dir), name)
  // The id of the lock this instance currently owns (per-instance, so two
  // lock objects in one process still cannot release each other).
  let mine = null

  function readHolder () {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw && typeof raw.pid === 'number' ? raw : null
    } catch {
      return null
    }
  }

  function isHeld () {
    if (!fs.existsSync(file)) return false
    const holder = readHolder()
    if (!holder) return true // unreadable/damaged lock: treat as held, fail closed
    return isProcessAlive(holder.pid)
  }

  function stealStaleLock () {
    const holder = readHolder()
    if (holder && isProcessAlive(holder.pid)) return null
    try { unlink(file) } catch { /* someone else may have removed it */ }
    return holder
  }

  function acquire () {
    if (fs.existsSync(file)) {
      const stale = stealStaleLock()
      if (!stale && fs.existsSync(file)) {
        // Still present: someone holds it.
        return { ok: false, reason: 'writer_lock_held', holder: readHolder(), file }
      }
    }
    const ownerId = crypto.randomUUID()
    let fd = null
    try {
      fd = open(file, 'wx', CACHE_FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id: ownerId, acquiredAt: new Date(now()).toISOString() }))
    } catch (error) {
      if (fd !== null) try { close(fd) } catch { /* ignore */ }
      fd = null
      if (error.code === 'EEXIST') {
        return { ok: false, reason: 'writer_lock_held', holder: readHolder(), file }
      }
      throw error
    } finally {
      if (fd !== null) close(fd)
    }
    mine = ownerId
    return { ok: true, holder: { pid: process.pid, id: ownerId, acquiredAt: new Date(now()).toISOString() }, file }
  }

  // Ownership-checked release: a party that does not own the lock must not
  // delete another writer's lock. Ownership is tracked per lock instance, so
  // even two lock objects in one process cannot release each other.
  function release () {
    if (!fs.existsSync(file)) {
      mine = null
      return { ok: false, reason: 'lock_not_present' }
    }
    const holder = readHolder()
    if (holder && holder.id !== mine) {
      return { ok: false, reason: 'lock_owned_by_other', holder }
    }
    try { unlink(file) } catch (error) {
      return { ok: false, reason: `unlink_failed: ${error.code ?? error.message}` }
    }
    mine = null
    return { ok: true }
  }

  return { file, acquire, release, isHeld, holder: readHolder }
}

// Everything the rest of the auth slice needs, under one custody object.
// Path-only: no token value ever leaves this module through its surface.
//
// create=false is the read-only mode: it never creates the directory (status
// and live inspection must not mkdir) and ensure() is a no-op.
export function createTokenCustody ({ account = null, dir, uuid = null, create = true, legacyAccount = account } = {}) {
  const resolvedDir = String(dir)
  if (create) ensureCacheDir(resolvedDir)

  const explicitUuid = uuid === null || uuid === undefined ? null : normalizeUuid(uuid)
  if (uuid !== null && uuid !== undefined && !explicitUuid) {
    throw new Error(`createTokenCustody received an invalid uuid: ${JSON.stringify(uuid)}`)
  }
  const existingProfile = readProfile(resolvedDir)
  const base = path.basename(resolvedDir)
  const baseUuid = normalizeUuid(base)
  const canonicalBaseUuid = baseUuid !== null && base === baseUuid ? baseUuid : null
  const derivedUuid = explicitUuid ?? existingProfile?.uuid ?? canonicalBaseUuid

  const writerLock = createWriterLock({ dir: resolvedDir })
  const profile = {
    read: () => readProfile(resolvedDir),
    write: (next, opts) => writeProfile(resolvedDir, next, opts),
  }

  return {
    account,
    uuid: derivedUuid,
    dir: resolvedDir,
    ensure: () => (create ? ensureCacheDir(resolvedDir) : resolvedDir),
    cacheFile: (cacheName) => cacheFilePath(resolvedDir, cacheName),
    legacyCacheFile: (cacheName) => legacyCacheFilePath(resolvedDir, legacyAccount ?? account ?? '', cacheName),
    cacheFactory: createAtomicCacheFactory({ dir: resolvedDir, create, legacyAccount }),
    listFiles: () => listCacheFiles(resolvedDir),
    readCache: (cacheName) => readCacheFile(resolvedDir, legacyAccount, cacheName),
    profile,
    // Compatibility surface used by msa.js/status.js today.
    identityMeta: {
      read: () => profile.read(),
      write: (meta, opts) => writeProfile(resolvedDir, meta, opts),
    },
    writerLock,
    mode: () => dirMode(resolvedDir),
  }
}

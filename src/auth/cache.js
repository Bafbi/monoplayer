// Token-cache custody for the Gate B puppet account (G1).
//
// The refresh token is the password. This module owns the file custody:
//   - one cache directory (default `.secrets/puppet/`), mode 0700,
//   - cache files written 0600 via temp-file + fsync + rename (atomic),
//   - a single writer lock so exactly one process ever rotates the token,
//   - a path-only API: callers pass directories and receive file paths,
//     never cached token values.
//
// The factory returned by createAtomicCacheFactory satisfies the
// prismarine-auth Cache contract ({ getCached, setCached, setCachedPartial,
// reset }) with the same on-disk naming prismarine-auth's own FileCache uses
// (`<sha1(username).slice(0,6)>_<cacheName>-cache.json`), so token files land
// in the custody directory with hardened permissions instead of the
// library's default writeFileSync (no fsync, default umask).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { normalizeUuid } from './util.js'

export const PRISMARINE_CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb']

export const CACHE_DIR_MODE = 0o700
export const CACHE_FILE_MODE = 0o600

// sha1 hex prefix — the same hash prismarine-auth uses for cache file names.
export function cacheIdHash (username) {
  return crypto.createHash('sha1').update(String(username ?? ''), 'binary').digest('hex').slice(0, 6)
}

// Path-only cache location. Both `puppet` (stable key) and the raw username
// hash are supported inputs.
export function cacheFilePath (dir, username, cacheName) {
  if (!PRISMARINE_CACHE_IDS.includes(cacheName)) {
    throw new Error(`Cannot compute a cache path for unknown cache ID: '${cacheName}'`)
  }
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

// One cache-file read for exactly one cache family. Returns the parsed JSON
// object or null. This is the *meta* reading API for status; callers must
// never log the returned object raw (it contains tokens when the cache is
// warm — status picks only expiry/obtain fields out of it).
export function readCacheFile (dir, username, cacheName, readFile = fs.readFileSync) {
  const file = cacheFilePath(dir, username, cacheName)
  try {
    return JSON.parse(String(readFile(file, 'utf8')))
  } catch {
    return null
  }
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
// families it manages.
export function createAtomicCacheFactory ({ dir, beforeRename = null, now = Date.now } = {}) {
  ensureCacheDir(dir)
  return function cacheFactory ({ username, cacheName }) {
    const file = cacheFilePath(dir, username, cacheName)
    let memory
    const legit = {
      async reset () {
        memory = {}
        atomicWriteFile(file, JSON.stringify({}), { beforeRename })
        return memory
      },
      async getCached () {
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
        memory = value ?? {}
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
    .filter(name => name.endsWith('-cache.json') || name === 'writer.lock' || name === 'identity.meta.json')
    .map(name => {
      const full = path.join(String(dir), name)
      let stat = null
      try { stat = fs.statSync(full) } catch { return null }
      return { name, file: full, bytes: stat.size, mtimeIso: new Date(stat.mtimeMs).toISOString() }
    })
    .filter(Boolean)
}

// Non-secret identity metadata the custody keeps between operations so a
// later refresh can prove the UUID did not change (G1: same UUID across
// refresh). Written 0600; contains uuid/name/authTitle/updatedAt only —
// never tokens.
export function readIdentityMeta (dir, readFile = fs.readFileSync) {
  try {
    const meta = JSON.parse(String(readFile(path.join(String(dir), 'identity.meta.json'), 'utf8')))
    return meta && normalizeUuid(meta.uuid) ? meta : null
  } catch {
    return null
  }
}

export function writeIdentityMeta (dir, meta, opts = {}) {
  const uuid = normalizeUuid(meta.uuid)
  if (!uuid) {
    throw new Error('refusing to write identity metadata without a normalized uuid')
  }
  return atomicWriteFile(path.join(String(dir), 'identity.meta.json'), JSON.stringify({
    ...meta, uuid, updatedAt: new Date().toISOString(),
  }), opts)
}

// ---------------------------------------------------------------------------
// The one-writer lock
// ---------------------------------------------------------------------------

// The refresh token is rolling/single-use: two refreshers race and can leave
// every cached value invalid (`invalid_grant`). The proxy (later workstream)
// is the only writer while it runs; the CLI's device-code / --refresh paths
// acquire this lock and refuse while it is held.
export function createWriterLock ({
  dir,
  name = 'writer.lock',
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
export function createTokenCustody ({ account = 'puppet', dir }) {
  const resolvedDir = String(dir)
  ensureCacheDir(resolvedDir)
  const writerLock = createWriterLock({ dir: resolvedDir })
  return {
    account,
    dir: resolvedDir,
    ensure: () => ensureCacheDir(resolvedDir),
    cacheFile: (cacheName) => cacheFilePath(resolvedDir, account, cacheName),
    cacheFactory: createAtomicCacheFactory({ dir: resolvedDir }),
    listFiles: () => listCacheFiles(resolvedDir),
    readCache: (cacheName) => readCacheFile(resolvedDir, account, cacheName),
    identityMeta: {
      read: () => readIdentityMeta(resolvedDir),
      write: (meta) => writeIdentityMeta(resolvedDir, { ...meta, account }),
    },
    writerLock,
    mode: () => dirMode(resolvedDir),
  }
}

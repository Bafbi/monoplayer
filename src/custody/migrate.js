// One-shot migration from the single-account custody layout to the
// per-UUID account tree.
//
// Legacy:  <secretsDir>/puppet/<sha1>_<family>-cache.json + identity.meta.json
// Target:  <accountsDir>/<uuid>/<family>-cache.json + profile.json
//
// The directory rename is the atomic commit point; it happens before any
// token file is touched, so a failure before it leaves the legacy tree
// untouched. After it, failures reverse the file renames and the directory
// rename when possible. Tokens are never copied, printed, or returned —
// metadata (names, sizes, uuid, alias) only.
import fs from 'node:fs'
import path from 'node:path'

import { normalizeUuid } from './util.js'
import {
  LEGACY_PROFILE_FILE,
  PROFILE_FILE,
  WRITER_LOCK_FILE,
  CACHE_FILE_MODE,
  CACHE_DIR_MODE,
  createWriterLock,
  readProfile,
  writeProfile,
} from './cache.js'
import { DEFAULT_ACCOUNTS_DIR, DEFAULT_RETIRED_DIR, listAccounts } from './accounts.js'

export const LEGACY_QUARANTINE_NAME = 'puppet-java-403'

const LEGACY_CACHE_PATTERN = /^([0-9a-f]{6})_([a-z]+)-cache\.json$/
const LIVE_FAMILY = 'live'

function resolveDirs ({ secretsDir, accountsDir, retiredDir }) {
  const secrets = String(secretsDir)
  const accounts = accountsDir === DEFAULT_ACCOUNTS_DIR && secrets !== '.secrets'
    ? path.join(secrets, 'accounts')
    : String(accountsDir)
  const retired = retiredDir === DEFAULT_RETIRED_DIR && secrets !== '.secrets'
    ? path.join(secrets, 'retired')
    : String(retiredDir)
  return { secretsDir: secrets, accountsDir: accounts, retiredDir: retired }
}

function isDirectory (dir) {
  try { return fs.lstatSync(dir).isDirectory() } catch { return false }
}

function isProcessAlive (pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readLegacyMeta (dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_PROFILE_FILE), 'utf8'))
    if (!raw || !normalizeUuid(raw.uuid)) return null
    return {
      uuid: normalizeUuid(raw.uuid),
      name: typeof raw.name === 'string' ? raw.name : null,
      alias: typeof raw.account === 'string' ? raw.account : (typeof raw.alias === 'string' ? raw.alias : null),
      authTitle: typeof raw.authTitle === 'string' ? raw.authTitle : null,
      deviceType: typeof raw.deviceType === 'string' ? raw.deviceType : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  } catch {
    return null
  }
}

function legacyCacheFiles (dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const files = []
  for (const name of names) {
    const match = LEGACY_CACHE_PATTERN.exec(name)
    if (!match) continue
    const file = path.join(dir, name)
    let bytes = null
    try { bytes = fs.statSync(file).size } catch { /* race */ }
    files.push({ name, file, family: match[2], bytes })
  }
  files.sort((a, b) => a.family.localeCompare(b.family))
  return files
}

function readLegacyWriterLock (dir) {
  const file = path.join(dir, WRITER_LOCK_FILE)
  if (!fs.existsSync(file)) return { present: false, pid: null, alive: false, file }
  let pid = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw.pid === 'number') pid = raw.pid
  } catch { /* damaged lock: present but not alive */ }
  return { present: true, pid, alive: isProcessAlive(pid), file }
}

function nearestExistingDev (start) {
  let current = path.resolve(String(start))
  for (;;) {
    try {
      return fs.statSync(current).dev
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

function sameFilesystem (a, b) {
  const left = nearestExistingDev(a)
  const right = nearestExistingDev(b)
  return left !== null && right !== null && left === right
}

function clockStamp (now) {
  return new Date(now()).toISOString().replace(/[:.]/g, '-')
}

function maybeQuarantineCandidate (secretsDir) {
  const dir = path.join(String(secretsDir), LEGACY_QUARANTINE_NAME)
  const present = isDirectory(dir)
  if (!present) return { dir, present: false, hasIdentity: false, identityFile: null }
  const identityFile = path.join(dir, LEGACY_PROFILE_FILE)
  return {
    dir,
    present: true,
    hasIdentity: fs.existsSync(identityFile) || fs.existsSync(path.join(dir, PROFILE_FILE)),
    identityFile,
  }
}

function readableFamilyPresent (dir, family) {
  return fs.existsSync(path.join(String(dir), `${family}-cache.json`))
}

// Read-only migration plan. Returns metadata only — never token values.
export function planMigration ({ secretsDir = '.secrets', accountsDir = DEFAULT_ACCOUNTS_DIR, from = 'puppet', retiredDir = DEFAULT_RETIRED_DIR } = {}) {
  const dirs = resolveDirs({ secretsDir, accountsDir, retiredDir })
  const legacyDir = path.join(dirs.secretsDir, from)
  const legacyExists = isDirectory(legacyDir)
  const meta = legacyExists ? readLegacyMeta(legacyDir) : null
  const files = legacyExists ? legacyCacheFiles(legacyDir) : []
  const writerLock = legacyExists
    ? readLegacyWriterLock(legacyDir)
    : { present: false, pid: null, alive: false, file: path.join(legacyDir, WRITER_LOCK_FILE) }
  const families = new Set(files.map(file => file.family))
  const target = meta?.uuid ? path.join(dirs.accountsDir, meta.uuid) : null
  const plannedFiles = files.map(file => ({
    ...file,
    target: target ? path.join(target, `${file.family}-cache.json`) : null,
  }))
  const quarantine = maybeQuarantineCandidate(dirs.secretsDir)

  let reason = null
  if (!legacyExists) reason = 'not_found'
  else if (!meta) reason = 'missing_identity_meta'
  else if (!families.has(LIVE_FAMILY)) reason = 'missing_live_cache'

  return {
    ok: reason === null,
    reason,
    from,
    secretsDir: dirs.secretsDir,
    accountsDir: dirs.accountsDir,
    retiredDir: dirs.retiredDir,
    legacy: {
      dir: legacyDir,
      exists: legacyExists,
      meta,
      files: plannedFiles,
      writerLock,
    },
    uuid: meta?.uuid ?? null,
    name: meta?.name ?? null,
    alias: meta?.alias ?? null,
    target,
    targetExists: target ? fs.existsSync(target) : false,
    sameFilesystem: sameFilesystem(dirs.secretsDir, path.dirname(dirs.accountsDir)),
    quarantine: {
      dir: quarantine.dir,
      present: quarantine.present,
      hasIdentity: quarantine.hasIdentity,
      target: quarantine.present ? path.join(dirs.retiredDir, `${LEGACY_QUARANTINE_NAME}-<stamp>`) : null,
    },
  }
}

// Find an account whose profile records a migration from this legacy path.
// This is how a second `apply` proves the migration already happened: the
// legacy directory no longer exists.
function findMigratedAccount ({ accountsDir, legacyDir }) {
  const matches = []
  for (const account of listAccounts({ accountsDir }).accounts) {
    const from = account.profile?.migratedFrom
    if (typeof from !== 'string') continue
    if (from === legacyDir || path.resolve(from) === path.resolve(legacyDir)) {
      matches.push(account)
    }
  }
  return matches
}

function fsyncDir (dir) {
  let fd = null
  try {
    fd = fs.openSync(String(dir), 'r')
    fs.fsyncSync(fd)
  } catch {
    // Directory fsync is best effort (some filesystems refuse it).
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

function tokenFilesForReport (files) {
  return files.map(file => ({
    family: file.family,
    name: file.name,
    target: `${file.family}-cache.json`,
    bytes: file.bytes,
  }))
}

// Plan or perform the migration. `apply: false` (the default) mutates
// nothing. On apply the legacy directory is renamed into
// accounts/<uuid>, hashed cache files are renamed to readable names, a
// profile.json is written (alias from identity.meta.json `account`), and the
// legacy metadata files are removed.
export function applyMigration ({
  secretsDir = '.secrets',
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  from = 'puppet',
  retiredDir = DEFAULT_RETIRED_DIR,
  apply = false,
  quarantineLegacy = true,
  now = Date.now,
} = {}) {
  const plan = planMigration({ secretsDir, accountsDir, from, retiredDir })

  if (!apply) {
    return { ...plan, dryRun: true, applied: false }
  }

  const dirs = {
    secretsDir: plan.secretsDir,
    accountsDir: plan.accountsDir,
    retiredDir: plan.retiredDir,
  }

  // Idempotency: the legacy directory is gone but an account records this
  // migration. Change nothing.
  if (!plan.legacy.exists) {
    const migrated = findMigratedAccount({ accountsDir: dirs.accountsDir, legacyDir: plan.legacy.dir })
    if (migrated.length === 1 && readableFamilyPresent(migrated[0].dir, LIVE_FAMILY)) {
      return {
        ...plan,
        ok: true,
        reason: null,
        dryRun: false,
        applied: false,
        alreadyMigrated: true,
        target: migrated[0].dir,
        uuid: migrated[0].uuid,
        name: migrated[0].name,
        alias: migrated[0].alias,
        files: [],
      }
    }
    return {
      ...plan,
      dryRun: false,
      applied: false,
      alreadyMigrated: false,
      reason: migrated.length > 1 ? 'ambiguous_migrated' : (plan.reason ?? 'not_found'),
    }
  }

  if (!plan.ok) {
    return { ...plan, dryRun: false, applied: false, alreadyMigrated: false }
  }
  if (plan.legacy.writerLock.alive) {
    return {
      ...plan,
      ok: false,
      reason: 'legacy_writer_lock_held',
      holder: { pid: plan.legacy.writerLock.pid },
      dryRun: false,
      applied: false,
      alreadyMigrated: false,
    }
  }

  // A target that already exists is either a previous migration or a
  // conflict. Never merge two token sets.
  if (plan.targetExists) {
    const existingProfile = readProfile(plan.target)
    if (!existingProfile || existingProfile.uuid !== plan.uuid) {
      return { ...plan, ok: false, reason: 'target_conflict', dryRun: false, applied: false, alreadyMigrated: false }
    }
    const complete = plan.legacy.files.every(file => readableFamilyPresent(plan.target, file.family))
    const sameBytes = complete && plan.legacy.files.every(file => {
      try {
        const source = fs.readFileSync(file.file)
        const target = fs.readFileSync(path.join(plan.target, `${file.family}-cache.json`))
        return source.equals(target)
      } catch {
        return false
      }
    })
    if (complete && sameBytes) {
      return {
        ...plan,
        ok: true,
        reason: null,
        dryRun: false,
        applied: false,
        alreadyMigrated: true,
        target: plan.target,
        files: tokenFilesForReport(plan.legacy.files),
      }
    }
    return { ...plan, ok: false, reason: 'target_conflict', dryRun: false, applied: false, alreadyMigrated: false }
  }

  if (!plan.sameFilesystem) {
    return { ...plan, ok: false, reason: 'cross_device', dryRun: false, applied: false, alreadyMigrated: false }
  }
  if (!plan.uuid) {
    return { ...plan, ok: false, reason: 'missing_identity_meta', dryRun: false, applied: false, alreadyMigrated: false }
  }

  try { fs.mkdirSync(dirs.secretsDir, { recursive: true, mode: CACHE_DIR_MODE }) } catch { /* exists */ }
  const lock = createWriterLock({ dir: dirs.secretsDir, name: '.accounts.lock' })
  const acquired = lock.acquire()
  if (!acquired.ok) {
    return {
      ...plan,
      ok: false,
      reason: 'accounts_lock_held',
      holder: acquired.holder ?? null,
      dryRun: false,
      applied: false,
      alreadyMigrated: false,
    }
  }

  let renamedDir = false
  let profileWritten = false
  const fileRenames = []

  try {
    // Re-check under the structure lock: another process may have migrated
    // or a writer may have appeared between plan and commit.
    const fresh = planMigration({ secretsDir, accountsDir, from, retiredDir })
    if (!fresh.legacy.exists) {
      const migrated = findMigratedAccount({ accountsDir: dirs.accountsDir, legacyDir: fresh.legacy.dir })
      if (migrated.length === 1) {
        return {
          ...fresh,
          ok: true,
          reason: null,
          dryRun: false,
          applied: false,
          alreadyMigrated: true,
          target: migrated[0].dir,
          files: [],
        }
      }
      return { ...fresh, ok: false, reason: 'not_found', dryRun: false, applied: false, alreadyMigrated: false }
    }
    if (fresh.legacy.writerLock.alive) {
      return {
        ...fresh,
        ok: false,
        reason: 'legacy_writer_lock_held',
        holder: { pid: fresh.legacy.writerLock.pid },
        dryRun: false,
        applied: false,
        alreadyMigrated: false,
      }
    }
    if (fresh.targetExists) {
      return { ...fresh, ok: false, reason: 'target_conflict', dryRun: false, applied: false, alreadyMigrated: false }
    }
    if (!fresh.ok || !fresh.uuid) {
      return { ...fresh, dryRun: false, applied: false, alreadyMigrated: false }
    }

    fs.mkdirSync(dirs.accountsDir, { recursive: true, mode: CACHE_DIR_MODE })
    try { fs.chmodSync(dirs.accountsDir, CACHE_DIR_MODE) } catch { /* best effort */ }
    fs.mkdirSync(dirs.retiredDir, { recursive: true, mode: CACHE_DIR_MODE })
    try { fs.chmodSync(dirs.retiredDir, CACHE_DIR_MODE) } catch { /* best effort */ }

    // Atomic commit point: rename the whole custody directory.
    fs.renameSync(fresh.legacy.dir, fresh.target)
    renamedDir = true
    try { fs.chmodSync(fresh.target, CACHE_DIR_MODE) } catch { /* best effort */ }

    for (const file of fresh.legacy.files) {
      const source = path.join(fresh.target, file.name)
      const destination = path.join(fresh.target, `${file.family}-cache.json`)
      if (!fs.existsSync(source)) continue
      fs.renameSync(source, destination)
      try { fs.chmodSync(destination, CACHE_FILE_MODE) } catch { /* best effort */ }
      fileRenames.push({ from: source, to: destination })
    }

    profileWritten = true
    writeProfile(fresh.target, {
      version: 1,
      uuid: fresh.uuid,
      name: fresh.name,
      alias: fresh.alias,
      authTitle: fresh.legacy.meta?.authTitle ?? null,
      deviceType: fresh.legacy.meta?.deviceType ?? null,
      // Preserve the last identity/auth write; the move gets its own stamp.
      updatedAt: fresh.legacy.meta?.updatedAt ?? undefined,
      migratedAt: new Date(now()).toISOString(),
      migratedFrom: fresh.legacy.dir,
    }, { allowUuidChange: true, now })

    // Legacy metadata must not survive beside profile.json.
    try { fs.unlinkSync(path.join(fresh.target, LEGACY_PROFILE_FILE)) } catch { /* absent */ }
    // A stale lock moved with the directory; it is dead (checked above).
    try { fs.unlinkSync(path.join(fresh.target, WRITER_LOCK_FILE)) } catch { /* absent */ }

    // Quarantine the failed bootstrap only after the token migration is
    // committed. A quarantine failure is a warning, never a rollback.
    let quarantined = null
    let warning = null
    if (quarantineLegacy && fresh.quarantine.present && !fresh.quarantine.hasIdentity) {
      try {
        const destination = path.join(dirs.retiredDir, `${LEGACY_QUARANTINE_NAME}-${clockStamp(now)}`)
        fs.renameSync(fresh.quarantine.dir, destination)
        quarantined = { from: fresh.quarantine.dir, to: destination }
      } catch (error) {
        warning = `could not quarantine ${fresh.quarantine.dir}: ${error.code ?? error.message}`
      }
    }

    fsyncDir(dirs.accountsDir)
    fsyncDir(dirs.secretsDir)
    fsyncDir(dirs.retiredDir)

    return {
      ...fresh,
      ok: true,
      reason: null,
      dryRun: false,
      applied: true,
      alreadyMigrated: false,
      target: fresh.target,
      files: tokenFilesForReport(fresh.legacy.files),
      profile: {
        uuid: fresh.uuid,
        name: fresh.name,
        alias: fresh.alias,
        authTitle: fresh.legacy.meta?.authTitle ?? null,
        deviceType: fresh.legacy.meta?.deviceType ?? null,
      },
      quarantined,
      warning,
      recovery: [],
    }
  } catch (error) {
    const recovery = []
    // Reverse the file renames first, then the directory rename. Never delete
    // a token file.
    for (const rename of [...fileRenames].reverse()) {
      try {
        if (fs.existsSync(rename.to) && !fs.existsSync(rename.from)) {
          fs.renameSync(rename.to, rename.from)
          recovery.push(`restored ${path.basename(rename.from)}`)
        }
      } catch (reversalError) {
        recovery.push(`could not restore ${path.basename(rename.from)}: ${reversalError.code ?? reversalError.message}`)
      }
    }
    if (profileWritten) {
      try { fs.unlinkSync(path.join(plan.target, PROFILE_FILE)) } catch { /* absent or already reversed */ }
    }
    if (renamedDir) {
      try {
        if (fs.existsSync(plan.target) && !fs.existsSync(plan.legacy.dir)) {
          fs.renameSync(plan.target, plan.legacy.dir)
          recovery.push(`restored legacy directory ${plan.legacy.dir}`)
        }
      } catch (reversalError) {
        recovery.push(`could not restore legacy directory; tokens remain in ${plan.target}: ${reversalError.code ?? reversalError.message}`)
      }
    }
    fsyncDir(dirs.secretsDir)
    return {
      ...plan,
      ok: false,
      reason: error?.code === 'EXDEV' ? 'cross_device' : 'migration_failed',
      dryRun: false,
      applied: false,
      alreadyMigrated: false,
      error: error?.message ?? String(error),
      recovery,
    }
  } finally {
    lock.release()
  }
}

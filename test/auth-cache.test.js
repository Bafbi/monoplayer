// Auth custody unit tests: readable cache names, atomic writes, 0700/0600,
// per-account writer lock, profile merge rules, and legacy adoption. No
// network, no real account, no prismarine-auth I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ensureCacheDir, dirMode, cacheFilePath, legacyCacheFilePath, cacheIdHash,
  createAtomicCacheFactory, atomicWriteFile, listCacheFiles,
  createWriterLock, createTokenCustody, readProfile, writeProfile,
  readIdentityMeta, writeIdentityMeta,
  PROFILE_FILE, LEGACY_PROFILE_FILE, CACHE_FILE_MODE,
} from '../src/custody/cache.js'

function tmpDir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `auth-${label}-`))
}

const UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'

// ---------------------------------------------------------------------------
// Directory + file custody
// ---------------------------------------------------------------------------

test('ensureCacheDir creates the directory as 0700', () => {
  const dir = path.join(tmpDir('dir'), 'nested', 'puppet')
  ensureCacheDir(dir)
  assert.equal(dirMode(dir), '700')
})

test('cache paths are readable; legacy paths keep the sha1 prefix', () => {
  const dir = tmpDir('paths')
  assert.equal(cacheFilePath(dir, 'live'), path.join(dir, 'live-cache.json'))
  assert.equal(
    legacyCacheFilePath(dir, 'puppet', 'live'),
    path.join(dir, `${cacheIdHash('puppet')}_live-cache.json`)
  )
  assert.match(legacyCacheFilePath(dir, 'puppet', 'live'), /[0-9a-f]{6}_live-cache\.json$/)
})

test('atomic cache factory writes 0600 files with readable names and path-only API', async () => {
  const dir = tmpDir('atomic')
  const factory = createAtomicCacheFactory({ dir })
  const cache = factory({ username: 'puppet', cacheName: 'live' })
  assert.equal(cache.file, path.join(dir, 'live-cache.json'))
  cache.file // path only: no token value on the surface

  await cache.setCached({ token: { access_token: 'A', refresh_token: 'R', obtainedOn: 1, expires_in: 3600 } })
  const stat = fs.statSync(cache.file)
  assert.equal(stat.mode & 0o777, CACHE_FILE_MODE, 'cache file must be 0600')
  assert.deepEqual(JSON.parse(fs.readFileSync(cache.file, 'utf8')), {
    token: { access_token: 'A', refresh_token: 'R', obtainedOn: 1, expires_in: 3600 },
  })

  // setCachedPartial merges, it does not clobber.
  await cache.setCachedPartial({ meta: { x: 1 } })
  const merged = await cache.getCached()
  assert.equal(merged.token.access_token, 'A')
  assert.equal(merged.meta.x, 1)

  // reset empties the file without deleting it.
  await cache.reset()
  assert.deepEqual(JSON.parse(fs.readFileSync(cache.file, 'utf8')), {})
})

test('cache factory refuses unknown cache ids (same contract as prismarine-auth)', () => {
  const dir = tmpDir('ids')
  assert.throws(() => cacheFilePath(dir, 'bogus'), /unknown cache ID/i)
  assert.throws(() => legacyCacheFilePath(dir, 'puppet', 'bogus'), /unknown cache ID/i)
  assert.throws(() => createAtomicCacheFactory({ dir })({ username: 'puppet', cacheName: 'bogus' }), /unknown cache ID/i)
})

test('a crashed write leaves the previous cache intact', async () => {
  const dir = tmpDir('crash')
  const file = path.join(dir, 'state.json')
  atomicWriteFile(file, JSON.stringify({ v: 1 }))
  for (const attempt of [1, 2]) {
    assert.throws(() => atomicWriteFile(file, JSON.stringify({ v: 2 }), {
      beforeRename: () => { throw new Error(`simulated crash ${attempt}`) },
    }), /simulated crash/)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 }, 'old tokens survive a failed write')
  // No stray temp files beyond the crash leftover the test left behind.
  const leftovers = fs.readdirSync(dir).filter(name => !name.startsWith('.'))
  assert.deepEqual(leftovers.length, 1)
})

// ---------------------------------------------------------------------------
// Profile custody
// ---------------------------------------------------------------------------

test('writeProfile normalizes the uuid and readProfile round-trips', () => {
  const dir = tmpDir('profile')
  const written = writeProfile(dir, { uuid: UUID.toUpperCase(), name: 'Bafbi', authTitle: '00000000402b5328' })
  assert.equal(written.uuid, UUID)
  assert.equal(written.version, 1)
  assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  const profile = readProfile(dir)
  assert.equal(profile.uuid, UUID)
  assert.equal(profile.name, 'Bafbi')
  assert.equal(profile.alias, null)
  assert.equal(fs.statSync(path.join(dir, PROFILE_FILE)).mode & 0o777, CACHE_FILE_MODE)
  assert.throws(() => writeProfile(dir, { uuid: 'not-a-uuid' }), /normalized uuid/i)
})

test('writeProfile merges a refresh without losing alias/version/createdAt/migration fields', () => {
  const dir = tmpDir('merge')
  writeProfile(dir, {
    uuid: UUID,
    name: 'Bafbi',
    alias: 'main',
    version: 1,
    migratedAt: '2026-11-01T00:00:00.000Z',
    migratedFrom: '.secrets/puppet',
  })
  const before = readProfile(dir)
  assert.ok(before.createdAt)

  const refreshed = writeProfile(dir, { uuid: UUID, name: 'Bafbi2', authTitle: '00000000441cc96b', deviceType: 'Nintendo' })
  assert.equal(refreshed.name, 'Bafbi2')
  assert.equal(refreshed.alias, 'main')
  assert.equal(refreshed.version, 1)
  assert.equal(refreshed.createdAt, before.createdAt)
  assert.equal(refreshed.migratedAt, before.migratedAt)
  assert.equal(refreshed.migratedFrom, '.secrets/puppet')
})

test('writeProfile refuses a uuid change unless explicitly allowed', () => {
  const dir = tmpDir('uuidguard')
  writeProfile(dir, { uuid: UUID, name: 'Bafbi' })
  const other = '11111111-2222-4333-8444-555555555555'
  assert.throws(() => writeProfile(dir, { uuid: other, name: 'Other' }), /refusing to change profile uuid/i)
  assert.equal(readProfile(dir).uuid, UUID)
  const changed = writeProfile(dir, { uuid: other, name: 'Other' }, { allowUuidChange: true })
  assert.equal(changed.uuid, other)
  assert.equal(readProfile(dir).uuid, other)
})

test('readProfile falls back to identity.meta.json and maps account to alias', () => {
  const dir = tmpDir('legacymeta')
  fs.writeFileSync(path.join(dir, LEGACY_PROFILE_FILE), JSON.stringify({
    uuid: UUID,
    name: 'GlowSquidye',
    authTitle: '00000000441cc96b',
    deviceType: 'Nintendo',
    account: 'puppet',
    updatedAt: '2026-11-07T13:05:33.264Z',
  }))
  const profile = readProfile(dir)
  assert.equal(profile.uuid, UUID)
  assert.equal(profile.alias, 'puppet')
  assert.equal(profile.deviceType, 'Nintendo')

  const bad = tmpDir('badjson')
  fs.writeFileSync(path.join(bad, PROFILE_FILE), '{not json')
  assert.equal(readProfile(bad), null)
  assert.equal(readProfile(path.join(tmpDir('missing'), 'nope')), null)
})

test('writeIdentityMeta/readIdentityMeta keep working through profile.json', () => {
  const dir = tmpDir('compatmeta')
  writeIdentityMeta(dir, { uuid: UUID.toUpperCase(), name: 'Bafbi', authTitle: '00000000402b5328' })
  const meta = readIdentityMeta(dir)
  assert.equal(meta.uuid, UUID)
  assert.equal(meta.name, 'Bafbi')
  assert.equal(meta.alias, null)
  assert.equal(fs.existsSync(path.join(dir, LEGACY_PROFILE_FILE)), false)
  assert.throws(() => writeIdentityMeta(dir, { uuid: 'nope' }), /normalized uuid/i)
})

// ---------------------------------------------------------------------------
// Adoption / listFiles
// ---------------------------------------------------------------------------

test('cache factory adopts a legacy hashed file on first read', async () => {
  const dir = tmpDir('adopt')
  ensureCacheDir(dir)
  const legacy = legacyCacheFilePath(dir, 'puppet', 'live')
  fs.writeFileSync(legacy, JSON.stringify({ token: { refresh_token: 'LEGACY' } }), { mode: 0o600 })

  const factory = createAtomicCacheFactory({ dir, legacyAccount: 'puppet' })
  const cache = factory({ username: 'puppet', cacheName: 'live' })
  const value = await cache.getCached()
  assert.equal(value.token.refresh_token, 'LEGACY', 'legacy bytes are adopted, not dropped')
  assert.equal(fs.existsSync(legacy), false, 'legacy name is gone after atomic rename')
  assert.equal(fs.existsSync(path.join(dir, 'live-cache.json')), true)
  assert.equal(cache.file, path.join(dir, 'live-cache.json'))
})

test('listCacheFiles includes profile.json and legacy-prefixed cache files', () => {
  const dir = tmpDir('list')
  writeProfile(dir, { uuid: UUID, name: 'Bafbi', alias: 'main' })
  fs.writeFileSync(path.join(dir, 'live-cache.json'), '{}')
  fs.writeFileSync(path.join(dir, `${cacheIdHash('puppet')}_xbl-cache.json`), '{}')
  const names = listCacheFiles(dir).map(file => file.name)
  assert.ok(names.includes(PROFILE_FILE))
  assert.ok(names.includes('live-cache.json'))
  assert.ok(names.includes(`${cacheIdHash('puppet')}_xbl-cache.json`))
  const listing = JSON.stringify(listCacheFiles(dir))
  assert.equal(listing.includes('SECRETVALUE'), false, 'listing is metadata only')
})

// ---------------------------------------------------------------------------
// The one-writer lock
// ---------------------------------------------------------------------------

test('writer lock: second writer is refused while the lock is held', () => {
  const dir = tmpDir('lock')
  const first = createWriterLock({ dir })
  const second = createWriterLock({ dir })
  const acquired = first.acquire()
  assert.equal(acquired.ok, true)
  assert.equal(second.acquire().ok, false)
  assert.equal(second.acquire().reason, 'writer_lock_held')
  assert.equal(second.isHeld(), true)
  // Only the owner may release:
  assert.equal(second.release().ok, false)
  assert.equal(second.release().reason, 'lock_owned_by_other')
  assert.equal(first.release().ok, true)
  assert.equal(second.isHeld(), false)
  assert.equal(second.acquire().ok, true, 'lock is usable again after release')
  second.release()
})

test('writer lock: a dead holder is stale and gets stolen', () => {
  const dir = tmpDir('stale')
  const lockFile = path.join(dir, 'writer.lock')
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, acquiredAt: 'before' }))
  const lock = createWriterLock({ dir, isProcessAlive: () => false })
  assert.equal(lock.isHeld(), false, 'dead pid is not a held lock')
  const acquired = lock.acquire()
  assert.equal(acquired.ok, true)
  fs.rmSync(lockFile)
})

test('writer lock file is 0600 inside the custody directory', () => {
  const dir = tmpDir('lockmode')
  const lock = createWriterLock({ dir })
  assert.equal(lock.acquire().ok, true)
  const stat = fs.statSync(lock.file)
  assert.equal(stat.mode & 0o777, CACHE_FILE_MODE)
  lock.release()
})

// ---------------------------------------------------------------------------
// Custody object
// ---------------------------------------------------------------------------

test('custody wires directory, readable cache paths, profile and one writer lock together', async () => {
  const dir = path.join(tmpDir('custody'), 'puppet')
  const custody = createTokenCustody({ account: 'puppet', dir })
  assert.equal(dirMode(custody.dir), '700')
  assert.equal(custody.uuid, null)
  assert.equal(custody.cacheFile('live'), path.join(dir, 'live-cache.json'))
  assert.ok(custody.legacyCacheFile('live').endsWith('_live-cache.json'))
  assert.equal(custody.readCache('live'), null)
  custody.identityMeta.write({ uuid: UUID, name: 'Bafbi' })
  assert.equal(readIdentityMeta(dir).uuid, UUID)
  assert.equal(custody.profile.read().uuid, UUID)
  assert.equal(createTokenCustody({ account: 'puppet', dir }).uuid, UUID, 'existing profile uuid is derived on construction')
  const lockResult = custody.writerLock.acquire()
  assert.equal(lockResult.ok, true)
  assert.equal(custody.writerLock.isHeld(), true)
  custody.writerLock.release()
})

test('custody create:false never creates the directory; ensure is a no-op', () => {
  const dir = path.join(tmpDir('readonly'), 'accounts', UUID)
  const custody = createTokenCustody({ account: 'main', dir, uuid: UUID, create: false })
  assert.equal(fs.existsSync(dir), false, 'read-only custody must not mkdir')
  assert.equal(custody.uuid, UUID)
  assert.equal(custody.profile.read(), null)
  assert.deepEqual(custody.listFiles(), [])
  custody.ensure()
  assert.equal(fs.existsSync(dir), false, 'ensure() must respect create:false')
})

test('custody derives uuid from an explicit arg, profile, or canonical dir basename', () => {
  const root = tmpDir('derive')
  const explicit = createTokenCustody({ account: 'main', dir: path.join(root, 'a'), uuid: UUID })
  assert.equal(explicit.uuid, UUID)

  const fromDir = createTokenCustody({ account: 'main', dir: path.join(root, UUID) })
  assert.equal(fromDir.uuid, UUID)

  const nonCanonical = createTokenCustody({ account: 'main', dir: path.join(root, 'not-a-uuid') })
  assert.equal(nonCanonical.uuid, null)

  const fromProfile = path.join(root, 'b')
  writeProfile(fromProfile, { uuid: UUID })
  assert.equal(createTokenCustody({ account: 'main', dir: fromProfile }).uuid, UUID)
})

test('custody readCache reads readable first and falls back to the legacy hashed file', () => {
  const dir = tmpDir('readlegacy')
  ensureCacheDir(dir)
  fs.writeFileSync(legacyCacheFilePath(dir, 'puppet', 'live'), JSON.stringify({ from: 'legacy' }), { mode: 0o600 })
  const custody = createTokenCustody({ account: 'puppet', dir })
  assert.deepEqual(custody.readCache('live'), { from: 'legacy' })
  fs.writeFileSync(path.join(dir, 'live-cache.json'), JSON.stringify({ from: 'readable' }), { mode: 0o600 })
  assert.deepEqual(custody.readCache('live'), { from: 'readable' })
})

// G1 auth unit tests: cache custody (atomic writes, 0700/0600, one-writer
// lock), pure file meta. No network, no real account, no prismarine-auth I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ensureCacheDir, dirMode, cacheFilePath, cacheIdHash,
  createAtomicCacheFactory, atomicWriteFile, listCacheFiles,
  createWriterLock, createTokenCustody, readIdentityMeta, writeIdentityMeta,
  CACHE_FILE_MODE,
} from '../src/auth/cache.js'

function tmpDir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `auth-${label}-`))
}

// ---------------------------------------------------------------------------
// Directory + file custody
// ---------------------------------------------------------------------------

test('ensureCacheDir creates the directory as 0700', () => {
  const dir = path.join(tmpDir('dir'), 'nested', 'puppet')
  ensureCacheDir(dir)
  assert.equal(dirMode(dir), '700')
})

test('atomic cache factory writes 0600 files with prismarine-auth naming and path-only API', async () => {
  const dir = tmpDir('atomic')
  const factory = createAtomicCacheFactory({ dir })
  const username = 'puppet'
  const cache = factory({ username, cacheName: 'live' })
  // Same path prismarine-auth's FileCache would use.
  assert.equal(cache.file, path.join(dir, `${cacheIdHash('puppet')}_live-cache.json`))
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
  assert.throws(() => cacheFilePath(dir, 'puppet', 'bogus'), /unknown cache ID/i)
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

test('identity meta round-trips normalized uuids and rejects junk', () => {
  const dir = tmpDir('meta')
  writeIdentityMeta(dir, { uuid: '7FAD1E81B0E94A3C8CCB9E41F3A4B3AF', name: 'Bafbi', authTitle: '00000000402b5328' })
  const meta = readIdentityMeta(dir)
  assert.equal(meta.uuid, '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af')
  assert.equal(meta.name, 'Bafbi')
  assert.equal(meta.account, undefined)
  assert.throws(() => writeIdentityMeta(dir, { uuid: 'not-a-uuid' }), /normalized uuid/i)
  assert.equal(readIdentityMeta(path.join(tmpDir('empty-x')), ), null)
})

test('listCacheFiles reports the custody files present without their values', async () => {
  const dir = tmpDir('list')
  const factory = createAtomicCacheFactory({ dir })
  await factory({ username: 'puppet', cacheName: 'live' }).setCached({ token: { access_token: 'SECRETVALUE' } })
  const names = listCacheFiles(dir).map(f => f.name)
  assert.ok(names.includes(`${cacheIdHash('puppet')}_live-cache.json`))
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

test('custody wires directory, cache paths, meta and one writer lock together', async () => {
  const dir = path.join(tmpDir('custody'), 'puppet')
  const custody = createTokenCustody({ account: 'puppet', dir })
  assert.equal(dirMode(custody.dir), '700')
  assert.ok(custody.cacheFile('live').endsWith('_live-cache.json'))
  assert.equal(custody.readCache('live'), null)
  custody.identityMeta.write({ uuid: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af', name: 'Bafbi' })
  assert.equal(readIdentityMeta(dir).uuid, '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af')
  const lockResult = custody.writerLock.acquire()
  assert.equal(lockResult.ok, true)
  assert.equal(custody.writerLock.isHeld(), true)
  custody.writerLock.release()
})

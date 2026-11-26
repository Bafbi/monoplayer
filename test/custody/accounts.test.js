// Multi-account directory model tests: listing, broken/pending reporting,
// selector resolution, staging finalize, and per-account lock independence.
// Temp directories only; no network, no real .secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempRoot } from '../support/temp.js'

import {
  DEFAULT_ACCOUNTS_DIR,
  isUuid,
  normalizeAccountSelector,
  listAccounts,
  resolveAccount,
  accountDir,
  createStagingDir,
  finalizeStaging,
  detectLegacyLayout,
  withAccountsLock,
} from '../../src/custody/accounts.js'
import { createTokenCustody, writeProfile, readProfile } from '../../src/custody/cache.js'

const A = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const B = '11111111-2222-4333-8444-555555555555'
const C = '99999999-8888-4777-8666-555555555555'

function root (label) {
  return tempRoot(`auth-accounts-${label}-`)
}

function makeAccount (accountsDir, dirName, { uuid = dirName, name = 'Player', alias = null } = {}) {
  const dir = path.join(accountsDir, dirName)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeProfile(dir, { uuid, name, alias })
  return dir
}

test('isUuid and normalizeAccountSelector accept dashed and undashed UUIDs', () => {
  assert.equal(isUuid(A), true)
  assert.equal(isUuid(A.replace(/-/g, '')), true)
  assert.equal(isUuid('nope'), false)
  assert.equal(normalizeAccountSelector(`  ${A.toUpperCase()}  `), A)
  assert.equal(normalizeAccountSelector(A.replace(/-/g, '')), A)
  assert.equal(normalizeAccountSelector('  Main  '), 'main')
})

test('0 accounts: no_accounts for null and text selectors', () => {
  const accountsDir = path.join(root('zero'), 'accounts')
  const first = resolveAccount({ accountsDir })
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'no_accounts')
  assert.deepEqual(first.candidates, [])
  assert.equal(resolveAccount({ accountsDir, selector: 'main' }).reason, 'no_accounts')
})

test('1 account resolves with null selector, uuid forms, alias, and name', () => {
  const accountsDir = path.join(root('one'), 'accounts')
  makeAccount(accountsDir, A, { name: 'GlowSquidye', alias: 'main' })

  const auto = resolveAccount({ accountsDir })
  assert.equal(auto.ok, true)
  assert.equal(auto.account.uuid, A)
  assert.equal(auto.account.alias, 'main')

  for (const selector of [A, A.toUpperCase(), A.replace(/-/g, ''), 'main', 'MAIN', 'glowsquidye']) {
    const result = resolveAccount({ accountsDir, selector })
    assert.equal(result.ok, true, `selector ${selector}`)
    assert.equal(result.account.uuid, A)
  }
})

test('N accounts: null selector demands a choice and lists candidates', () => {
  const accountsDir = path.join(root('many'), 'accounts')
  makeAccount(accountsDir, A, { name: 'GlowSquidye', alias: 'main' })
  makeAccount(accountsDir, B, { name: 'AltOne', alias: 'alt' })

  const nullSelector = resolveAccount({ accountsDir })
  assert.equal(nullSelector.ok, false)
  assert.equal(nullSelector.reason, 'account_required')
  assert.deepEqual(nullSelector.candidates.map(candidate => candidate.uuid).sort(), [A, B].sort())

  assert.equal(resolveAccount({ accountsDir, selector: 'alt' }).account.uuid, B)
  assert.equal(resolveAccount({ accountsDir, selector: 'ALTONE' }).account.uuid, B)
  assert.equal(resolveAccount({ accountsDir, selector: A }).account.uuid, A)
})

test('ambiguous name and unknown selector are reported, not guessed', () => {
  const accountsDir = path.join(root('ambiguous'), 'accounts')
  makeAccount(accountsDir, A, { name: 'SameName', alias: 'first' })
  makeAccount(accountsDir, B, { name: 'SameName', alias: 'second' })

  const ambiguous = resolveAccount({ accountsDir, selector: 'samename' })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, 'ambiguous')
  assert.equal(ambiguous.candidates.length, 2)

  const missing = resolveAccount({ accountsDir, selector: 'ghost' })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not_found')
  assert.equal(missing.account, null)
})

test('uuid-shaped selectors never fall through to alias or name', () => {
  const accountsDir = path.join(root('uuidshape'), 'accounts')
  // The alias itself is not UUID-shaped (validation forbids that), but the
  // name can be text; a UUID-shaped selector must not match it.
  makeAccount(accountsDir, A, { name: C, alias: 'main' })
  const result = resolveAccount({ accountsDir, selector: C })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not_found')
})

test('duplicate uuid directories are both broken and unselectable', () => {
  const accountsDir = path.join(root('duplicate'), 'accounts')
  makeAccount(accountsDir, A, { name: 'Dup', alias: 'one' })
  // An undashed directory name normalizes to the same UUID.
  makeAccount(accountsDir, A.replace(/-/g, ''), { uuid: A, name: 'Dup', alias: 'two' })

  const listing = listAccounts({ accountsDir })
  assert.equal(listing.accounts.length, 0)
  const duplicates = listing.broken.filter(item => item.reason === 'duplicate_uuid')
  assert.equal(duplicates.length, 2)
  assert.ok(duplicates.every(item => item.duplicateOf.length === 2))
  assert.equal(resolveAccount({ accountsDir }).reason, 'no_usable_accounts')
})

test('dir/profile uuid mismatch and missing profile are broken', () => {
  const accountsDir = path.join(root('broken'), 'accounts')
  makeAccount(accountsDir, A, { uuid: B, name: 'Mismatch' })
  fs.mkdirSync(path.join(accountsDir, C), { recursive: true, mode: 0o700 })

  const listing = listAccounts({ accountsDir })
  assert.equal(listing.accounts.length, 0)
  const reasons = listing.broken.map(item => item.reason).sort()
  assert.deepEqual(reasons, ['missing_profile', 'uuid_mismatch'])
  assert.equal(resolveAccount({ accountsDir, selector: A }).reason, 'no_usable_accounts')
})

test('non-UUID directories holding a cache are pending, not accounts', () => {
  const accountsDir = path.join(root('pending'), 'accounts')
  const incoming = path.join(accountsDir, 'incoming')
  fs.mkdirSync(incoming, { recursive: true })
  fs.writeFileSync(path.join(incoming, 'live-cache.json'), '{}')
  fs.mkdirSync(path.join(accountsDir, 'empty-dir'), { recursive: true })

  const listing = listAccounts({ accountsDir })
  assert.equal(listing.accounts.length, 0)
  assert.equal(listing.pending.length, 1)
  assert.equal(listing.pending[0].name, 'incoming')
  assert.deepEqual(listing.pending[0].cacheFiles, ['live-cache.json'])
})

test('symlinked account directories are skipped', () => {
  const base = root('symlink')
  const accountsDir = path.join(base, 'accounts')
  const real = path.join(base, 'real')
  fs.mkdirSync(real, { recursive: true })
  writeProfile(real, { uuid: A, name: 'Linked', alias: 'main' })
  fs.mkdirSync(accountsDir, { recursive: true })
  fs.symlinkSync(real, path.join(accountsDir, A))

  const listing = listAccounts({ accountsDir })
  assert.equal(listing.accounts.length, 0)
  assert.equal(listing.broken.length, 0)
})

test('path-like selectors never reach the filesystem as paths', () => {
  const accountsDir = path.join(root('traversal'), 'accounts')
  makeAccount(accountsDir, A, { name: 'GlowSquidye', alias: 'main' })
  for (const selector of ['../../etc/passwd', '/etc/passwd', `../${A}`, `..\\${A}`]) {
    const result = resolveAccount({ accountsDir, selector })
    assert.equal(result.ok, false, selector)
    assert.equal(result.reason, 'not_found', selector)
  }
  assert.throws(() => accountDir(accountsDir, '../../etc'), /valid UUID/i)
  assert.equal(accountDir(accountsDir, A.toUpperCase()), path.join(accountsDir, A))
})

test('createStagingDir makes a 16-hex 0700 directory', () => {
  const stagingDir = path.join(root('staging'), 'staging')
  const dir = createStagingDir({ stagingDir })
  assert.match(path.basename(dir), /^[0-9a-f]{16}$/)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})

test('finalizeStaging writes the alias and moves the staging dir into accounts/<uuid>', () => {
  const base = root('finalize')
  const secretsDir = path.join(base, '.secrets')
  const stagingDir = path.join(secretsDir, 'staging')
  const accountsDir = path.join(secretsDir, 'accounts')
  const stage = createStagingDir({ stagingDir })
  writeProfile(stage, { uuid: A, name: 'GlowSquidye' })
  fs.writeFileSync(path.join(stage, 'live-cache.json'), '{}')

  const result = finalizeStaging({
    stagingDir: stage,
    accountsDir,
    secretsDir,
    profile: { uuid: A, name: 'GlowSquidye' },
    alias: 'main',
  })
  assert.equal(result.ok, true)
  assert.equal(result.dir, path.join(accountsDir, A))
  assert.equal(fs.existsSync(stage), false)
  const profile = readProfile(result.dir)
  assert.equal(profile.uuid, A)
  assert.equal(profile.alias, 'main')
  assert.equal(result.account.alias, 'main')
  assert.equal(fs.statSync(result.dir).mode & 0o777, 0o700)
})

test('finalizeStaging refuses alias collisions, existing targets, and bad aliases', () => {
  const base = root('finalize-refuse')
  const secretsDir = path.join(base, '.secrets')
  const stagingDir = path.join(secretsDir, 'staging')
  const accountsDir = path.join(secretsDir, 'accounts')
  makeAccount(accountsDir, A, { name: 'First', alias: 'main' })

  const collision = createStagingDir({ stagingDir })
  writeProfile(collision, { uuid: B, name: 'Second' })
  const aliasTaken = finalizeStaging({ stagingDir: collision, accountsDir, secretsDir, profile: { uuid: B, name: 'Second' }, alias: 'main' })
  assert.equal(aliasTaken.ok, false)
  assert.equal(aliasTaken.reason, 'alias_taken')
  assert.equal(fs.existsSync(collision), true, 'staging survives a refusal')

  const invalid = createStagingDir({ stagingDir })
  writeProfile(invalid, { uuid: B, name: 'Second' })
  assert.equal(
    finalizeStaging({ stagingDir: invalid, accountsDir, secretsDir, profile: { uuid: B, name: 'Second' }, alias: 'Bad Alias' }).reason,
    'invalid_alias'
  )
  assert.equal(
    finalizeStaging({ stagingDir: invalid, accountsDir, secretsDir, profile: { uuid: B, name: 'Second' }, alias: B }).reason,
    'invalid_alias'
  )

  const occupied = createStagingDir({ stagingDir })
  writeProfile(occupied, { uuid: C, name: 'Third' })
  fs.mkdirSync(path.join(accountsDir, C), { recursive: true })
  const targetExists = finalizeStaging({ stagingDir: occupied, accountsDir, secretsDir, profile: { uuid: C, name: 'Third' }, alias: 'third' })
  assert.equal(targetExists.ok, false)
  assert.equal(targetExists.reason, 'target_exists')
})

test('per-account writer locks are independent', () => {
  const accountsDir = path.join(root('locks'), 'accounts')
  const a = createTokenCustody({ account: 'one', dir: path.join(accountsDir, A) })
  const b = createTokenCustody({ account: 'two', dir: path.join(accountsDir, B) })
  assert.equal(a.writerLock.acquire().ok, true)
  assert.equal(a.writerLock.isHeld(), true)
  assert.equal(b.writerLock.acquire().ok, true, 'account B lock must not be blocked by A')
  assert.equal(b.writerLock.isHeld(), true)
  a.writerLock.release()
  b.writerLock.release()
})

test('detectLegacyLayout reports a pre-migration directory read-only', () => {
  const base = root('legacy')
  const secretsDir = path.join(base, '.secrets')
  const legacy = path.join(secretsDir, 'puppet')
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(legacy, 'identity.meta.json'), JSON.stringify({ uuid: A, name: 'GlowSquidye', account: 'puppet' }))
  fs.writeFileSync(path.join(legacy, '980a04_live-cache.json'), '{}')

  const detected = detectLegacyLayout({ secretsDir, accountsDir: path.join(secretsDir, 'accounts') })
  assert.equal(detected.found, true)
  assert.equal(detected.profile.uuid, A)
  assert.equal(detected.profile.alias, 'puppet')
  assert.equal(detected.files.length, 1)
  assert.equal(detected.target, path.join(secretsDir, 'accounts', A))
  assert.equal(detected.targetExists, false)
})

test('withAccountsLock holds and releases the structure lock', async () => {
  const secretsDir = path.join(root('structure'), '.secrets')
  let held = false
  const result = await withAccountsLock({ secretsDir }, async () => {
    held = fs.existsSync(path.join(secretsDir, '.accounts.lock'))
    return 42
  })
  assert.equal(result, 42)
  assert.equal(held, true)
  assert.equal(fs.existsSync(path.join(secretsDir, '.accounts.lock')), false)
})

test('DEFAULT_ACCOUNTS_DIR is the documented location', () => {
  assert.equal(DEFAULT_ACCOUNTS_DIR, '.secrets/accounts')
})

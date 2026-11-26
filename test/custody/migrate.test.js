// Legacy-to-account-tree migration tests. Synthetic token strings only; temp
// directories only. The strongest assertions: bytes are identical after the
// move, modes are 0600/0700, and no token value ever reaches the report JSON.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempRoot } from '../support/temp.js'

import { planMigration, applyMigration } from '../../src/custody/migrate.js'
import { cacheIdHash, PROFILE_FILE, LEGACY_PROFILE_FILE } from '../../src/custody/cache.js'
import { resolveAccount } from '../../src/custody/accounts.js'

const UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const NAME = 'GlowSquidye'
const ALIAS = 'puppet'
const SENTINEL = 'SENTINEL_REFRESH_TOKEN_0123456789abcdef_DO_NOT_PRINT'

function buildLegacyTree (label) {
  const base = tempRoot(`auth-migrate-${label}-`)
  const secretsDir = path.join(base, '.secrets')
  const accountsDir = path.join(secretsDir, 'accounts')
  const retiredDir = path.join(secretsDir, 'retired')
  const legacy = path.join(secretsDir, 'puppet')
  const quarantined = path.join(secretsDir, 'puppet-java-403')
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 })
  fs.chmodSync(legacy, 0o700)
  fs.mkdirSync(quarantined, { recursive: true, mode: 0o700 })

  fs.writeFileSync(path.join(legacy, LEGACY_PROFILE_FILE), JSON.stringify({
    uuid: UUID,
    name: NAME,
    authTitle: '00000000441cc96b',
    deviceType: 'Nintendo',
    account: ALIAS,
    updatedAt: '2026-11-07T13:05:33.264Z',
  }), { mode: 0o600 })

  const hash = cacheIdHash(ALIAS)
  const contents = {
    live: JSON.stringify({ token: { access_token: 'synthetic-access', refresh_token: SENTINEL, obtainedOn: 1, expires_in: 3600 } }),
    xbl: JSON.stringify({ token: { userToken: 'synthetic-user' } }),
    mca: JSON.stringify({ mca: { access_token: 'synthetic-mca' } }),
  }
  const originals = {}
  for (const [family, body] of Object.entries(contents)) {
    const file = path.join(legacy, `${hash}_${family}-cache.json`)
    fs.writeFileSync(file, body, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    originals[family] = Buffer.from(body)
  }

  // Failed bootstrap: a cache but no identity metadata.
  fs.writeFileSync(path.join(quarantined, `${hash}_live-cache.json`), '{}', { mode: 0o600 })

  return { base, secretsDir, accountsDir, retiredDir, legacy, quarantined, originals, hash }
}

test('dry-run reports the plan and changes nothing', () => {
  const tree = buildLegacyTree('dry')
  const plan = planMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir })

  assert.equal(plan.ok, true)
  assert.equal(plan.reason, null)
  assert.equal(plan.uuid, UUID)
  assert.equal(plan.name, NAME)
  assert.equal(plan.alias, ALIAS)
  assert.equal(plan.legacy.exists, true)
  assert.equal(plan.legacy.files.length, 3)
  assert.deepEqual(plan.legacy.files.map(file => file.family).sort(), ['live', 'mca', 'xbl'])
  assert.equal(plan.target, path.join(tree.accountsDir, UUID))
  assert.equal(plan.targetExists, false)
  assert.equal(plan.sameFilesystem, true)
  assert.equal(plan.legacy.writerLock.present, false)
  assert.equal(plan.quarantine.present, true)
  assert.equal(plan.quarantine.hasIdentity, false)

  assert.equal(fs.existsSync(tree.accountsDir), false)
  assert.equal(fs.existsSync(tree.legacy), true)
  assert.equal(fs.existsSync(tree.quarantined), true)
  assert.equal(fs.existsSync(path.join(tree.legacy, `${tree.hash}_live-cache.json`)), true)
  assert.equal(JSON.stringify(plan).includes(SENTINEL), false, 'plan JSON must not carry token values')
})

test('apply moves the tree, renames cache files, writes the profile, and preserves bytes/modes', () => {
  const tree = buildLegacyTree('apply')
  const report = applyMigration({
    secretsDir: tree.secretsDir,
    accountsDir: tree.accountsDir,
    retiredDir: tree.retiredDir,
    apply: true,
  })

  assert.equal(report.ok, true)
  assert.equal(report.applied, true)
  assert.equal(report.alreadyMigrated, false)
  assert.equal(report.reason, null)
  assert.equal(report.profile.uuid, UUID)
  assert.equal(report.profile.name, NAME)
  assert.equal(report.profile.alias, ALIAS)

  const target = path.join(tree.accountsDir, UUID)
  assert.equal(fs.existsSync(tree.legacy), false, 'legacy directory is gone')
  assert.equal(fs.existsSync(target), true)

  for (const [family, original] of Object.entries(tree.originals)) {
    const file = path.join(target, `${family}-cache.json`)
    assert.equal(fs.existsSync(file), true, `${family} cache is readable`)
    assert.deepEqual(fs.readFileSync(file), original, `${family} bytes are identical`)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${family} file is 0600`)
    assert.equal(fs.existsSync(path.join(target, `${tree.hash}_${family}-cache.json`)), false, `${family} hashed name is gone`)
  }

  assert.equal(fs.statSync(target).mode & 0o777, 0o700, 'account dir is 0700')
  assert.equal(fs.statSync(tree.accountsDir).mode & 0o777, 0o700, 'accounts dir is 0700')
  assert.equal(fs.statSync(tree.retiredDir).mode & 0o777, 0o700, 'retired dir is 0700')

  const profile = JSON.parse(fs.readFileSync(path.join(target, PROFILE_FILE), 'utf8'))
  assert.equal(profile.version, 1)
  assert.equal(profile.uuid, UUID)
  assert.equal(profile.name, NAME)
  assert.equal(profile.alias, ALIAS)
  assert.equal(profile.authTitle, '00000000441cc96b')
  assert.equal(profile.deviceType, 'Nintendo')
  assert.match(profile.migratedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(profile.migratedFrom, tree.legacy)
  assert.equal(fs.existsSync(path.join(target, LEGACY_PROFILE_FILE)), false, 'identity.meta.json is removed')
  assert.equal(fs.existsSync(path.join(target, 'writer.lock')), false, 'stale writer.lock is removed')

  // Failed bootstrap is quarantined, not promoted.
  assert.equal(fs.existsSync(tree.quarantined), false)
  const retired = fs.readdirSync(tree.retiredDir)
  assert.equal(retired.length, 1)
  assert.match(retired[0], /^puppet-java-403-/)
  assert.equal(report.quarantined.from, tree.quarantined)
  assert.equal(fs.existsSync(report.quarantined.to), true)

  // Selectable by alias after migration.
  const resolved = resolveAccount({ accountsDir: tree.accountsDir, selector: ALIAS })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.account.uuid, UUID)
  assert.equal(resolved.account.alias, ALIAS)

  const reportJson = JSON.stringify(report)
  assert.equal(reportJson.includes(SENTINEL), false, 'report JSON must not carry token values')
  assert.equal(reportJson.includes('synthetic-access'), false)
  assert.equal(reportJson.includes('synthetic-user'), false)
})

test('a second apply is alreadyMigrated and changes nothing', () => {
  const tree = buildLegacyTree('twice')
  const first = applyMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir, apply: true })
  assert.equal(first.applied, true)

  const target = path.join(tree.accountsDir, UUID)
  const profileBytes = fs.readFileSync(path.join(target, PROFILE_FILE))
  const liveBytes = fs.readFileSync(path.join(target, 'live-cache.json'))

  const second = applyMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir, apply: true })
  assert.equal(second.ok, true)
  assert.equal(second.alreadyMigrated, true)
  assert.equal(second.applied, false)
  assert.equal(second.target, target)
  assert.deepEqual(fs.readFileSync(path.join(target, PROFILE_FILE)), profileBytes)
  assert.deepEqual(fs.readFileSync(path.join(target, 'live-cache.json')), liveBytes)
})

test('apply refuses while the legacy writer lock is held by a live pid', () => {
  const tree = buildLegacyTree('locked')
  fs.writeFileSync(path.join(tree.legacy, 'writer.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })

  const plan = planMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir })
  assert.equal(plan.legacy.writerLock.present, true)
  assert.equal(plan.legacy.writerLock.pid, process.pid)
  assert.equal(plan.legacy.writerLock.alive, true)

  const report = applyMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir, apply: true })
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'legacy_writer_lock_held')
  assert.equal(report.holder.pid, process.pid)
  assert.equal(fs.existsSync(path.join(tree.accountsDir, UUID)), false)
  assert.equal(fs.existsSync(tree.legacy), true)
  assert.equal(fs.existsSync(path.join(tree.legacy, `${tree.hash}_live-cache.json`)), true)
})

test('apply refuses a conflicting target and never mixes token sets', () => {
  const tree = buildLegacyTree('conflict')
  const target = path.join(tree.accountsDir, UUID)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, PROFILE_FILE), JSON.stringify({
    version: 1,
    uuid: '11111111-2222-4333-8444-555555555555',
    name: 'SomeoneElse',
    alias: 'other',
  }), { mode: 0o600 })

  const report = applyMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir, apply: true })
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'target_conflict')
  assert.equal(fs.existsSync(tree.legacy), true, 'legacy tokens stay put')
  assert.equal(fs.existsSync(path.join(tree.legacy, `${tree.hash}_live-cache.json`)), true)
})

test('plan reports missing live cache as a refusal reason', () => {
  const tree = buildLegacyTree('nolive')
  fs.rmSync(path.join(tree.legacy, `${tree.hash}_live-cache.json`))
  const plan = planMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'missing_live_cache')
  const report = applyMigration({ secretsDir: tree.secretsDir, accountsDir: tree.accountsDir, retiredDir: tree.retiredDir, apply: true })
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'missing_live_cache')
  assert.equal(fs.existsSync(tree.legacy), true)
})

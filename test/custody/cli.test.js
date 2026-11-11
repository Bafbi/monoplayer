// The custody CLI is the operator's entry point: they list accounts, rotate a
// token, add a player, migrate the old layout. Nothing imported it and nothing
// spawned it, so the one thing it promises — that a selector names one account
// and only that account — was never run. This file spawns it the way an
// operator's shell does, against a temporary custody root, and asserts what
// separates rotating the right token from the wrong one: the resolved
// directory, the exit status, and which stream carries what.
//
// Socket-free by construction. `device-code` login and `status --refresh` are
// absent: both reach Microsoft. Their refusals are here, because a refusal
// happens before a request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeProfile } from '../../src/custody/cache.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(ROOT, 'src', 'custody', 'cli.js')

const A = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const B = '11111111-2222-4333-8444-555555555555'
const C = '99999999-8888-4777-8666-555555555555'
const D = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const E = 'abcdefab-1234-4567-89ab-cdefabcdefab'
const LEGACY_UUID = '0f0f0f0f-1111-4222-8333-444444444444'
const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'

// Values a real cache holds. They must never reach stdout.
const REFRESH_TOKEN = 'refresh-value-that-must-not-be-printed'
const ACCESS_TOKEN = 'access-value-that-must-not-be-printed'
const OBTAINED_ON = 1_700_000_000_000

function harness (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-custody-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const secretsDir = path.join(root, '.secrets')
  const accountsDir = path.join(secretsDir, 'accounts')
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })

  // A fresh environment, filtered rather than blanked: the CLI reads
  // GATEB_ACCOUNTS_DIR, GATEB_AUTH_ACCOUNT, and GATEB_AUTH_DIR with ??, so an
  // inherited empty string is a value. HOME and TMPDIR point into the fixture
  // so no dependency can reach the operator's real profile.
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    LANG: 'C',
  }
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    cwd: root,
    env,
    timeout: 60_000,
  })
  // Every command that could read or write custody names the fixture root, so
  // no case can reach the checkout's own .secrets by forgetting a flag.
  const runIn = (...argv) => run(...argv, '--accounts-dir', accountsDir, '--secrets-dir', secretsDir)
  return { root, secretsDir, accountsDir, run, runIn }
}

// The product's own profile writer builds the fixture, so the CLI and the tree
// model cannot drift on the profile shape.
function seedAccounts (accountsDir) {
  writeProfile(path.join(accountsDir, A), { uuid: A, name: 'GlowSquidye', alias: 'main' })
  writeProfile(path.join(accountsDir, B), { uuid: B, name: 'AltOne', alias: 'alt' })
  // Two accounts claiming one alias: the state a restored backup produces.
  writeProfile(path.join(accountsDir, C), { uuid: C, name: 'TwinLeft', alias: 'twin' })
  writeProfile(path.join(accountsDir, D), { uuid: D, name: 'TwinRight', alias: 'twin' })
  // No alias, and a profile name that is another account's alias. The alias
  // pass wins by contract, so 'main' must resolve to A and never to E.
  writeProfile(path.join(accountsDir, E), { uuid: E, name: 'main' })

  const live = path.join(accountsDir, A, 'live-cache.json')
  fs.writeFileSync(live, JSON.stringify({
    token: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, obtainedOn: OBTAINED_ON, expires_in: 3600 }
  }))

  // One directory that cannot be selected, and one that was never migrated.
  fs.mkdirSync(path.join(accountsDir, LEGACY_UUID), { recursive: true, mode: 0o700 })
  const pending = path.join(accountsDir, 'notauuid')
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(pending, 'a1b2c3_live-cache.json'), '{}')
}

function seedLegacy (secretsDir) {
  const dir = path.join(secretsDir, 'puppet')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'identity.meta.json'), JSON.stringify({ uuid: LEGACY_UUID, name: 'GlowSquidye' }))
  fs.writeFileSync(path.join(dir, 'a1b2c3_live-cache.json'), JSON.stringify({ token: { refresh_token: REFRESH_TOKEN } }))
  return dir
}

const parse = text => JSON.parse(text)

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

test('accounts --json reports the usable, broken, pending, and legacy entries of the tree it was given', (t) => {
  const h = harness(t)
  // The account tree is not the one the custody root implies, so the report has
  // to take the legacy target from the flag and not from the root.
  const accountsDir = path.join(h.root, 'trees', 'accounts')
  seedAccounts(accountsDir)
  seedLegacy(h.secretsDir)

  const result = h.run('accounts', '--accounts-dir', accountsDir, '--secrets-dir', h.secretsDir, '--json')
  assert.equal(result.status, 0, result.stderr)
  const listing = parse(result.stdout)

  assert.equal(listing.accountsDir, accountsDir)
  assert.deepEqual(
    listing.accounts.map(account => [account.uuid, account.name, account.alias]).sort(),
    [[A, 'GlowSquidye', 'main'], [B, 'AltOne', 'alt'], [C, 'TwinLeft', 'twin'], [D, 'TwinRight', 'twin'], [E, 'main', null]].sort()
  )
  for (const account of listing.accounts) {
    assert.equal(account.dir, path.join(accountsDir, account.uuid))
  }

  // A broken account and an unmigrated directory are visible before an operator
  // picks a selector, because neither is selectable.
  assert.deepEqual(listing.broken.map(entry => [entry.uuid, entry.reason]), [[LEGACY_UUID, 'missing_profile']])
  assert.deepEqual(listing.pending.map(entry => [entry.name, entry.reason]), [['notauuid', 'not_a_uuid_dir']])

  assert.equal(listing.legacy.found, true)
  assert.equal(listing.legacy.dir, path.join(h.secretsDir, 'puppet'))
  assert.equal(listing.legacy.target, path.join(accountsDir, LEGACY_UUID))

  // Nothing in the answer names this checkout's own custody directory.
  assert.ok(!result.stdout.includes(path.join(ROOT, '.secrets')), result.stdout)
})

test('--secrets-dir alone decides the account tree and the whitelist file', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const listing = parse(h.run('accounts', '--secrets-dir', h.secretsDir, '--json').stdout)
  assert.equal(listing.accountsDir, h.accountsDir)
  assert.equal(listing.accounts.length, 5)

  // No --file either: the attach whitelist is this root's file.
  const added = h.run('whitelist', 'attach', 'add', PLAYER, '--secrets-dir', h.secretsDir)
  assert.equal(added.status, 0, added.stderr)
  const file = path.join(h.secretsDir, 'attach-whitelist.json')
  assert.deepEqual(parse(fs.readFileSync(file, 'utf8')).players.map(entry => entry.uuid), [PLAYER])
})

test('accounts reads a directory that does not exist and creates nothing', (t) => {
  const h = harness(t)
  const missing = path.join(h.root, 'no-such-tree')

  const result = h.run('accounts', '--accounts-dir', missing, '--secrets-dir', h.secretsDir)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('accounts: 0 in ' + missing), result.stdout)
  assert.match(result.stdout, /^legacy: none/m)
  assert.equal(fs.existsSync(missing), false)
})

test('accounts names a broken account in the text listing', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('accounts')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^accounts: 5 in /m)
  assert.match(result.stdout, new RegExp('^uuid=' + A + ' name=GlowSquidye alias=main dir=', 'm'))
  assert.match(result.stdout, new RegExp('^broken: uuid=' + LEGACY_UUID + ' .* reason=missing_profile$', 'm'))
  assert.match(result.stdout, /^pending: name=notauuid /m)
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status --json resolves every selector form to one account and its own directory', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)
  const listing = parse(h.runIn('accounts', '--json').stdout)
  const dirOf = uuid => listing.accounts.find(account => account.uuid === uuid).dir

  // A selector must land on one account, and the report must name that
  // account's own directory. An answer with the right exit status and the wrong
  // directory is the bug this file exists for.
  const cases = [
    [A, A],                                  // canonical uuid
    [A.replace(/-/g, ''), A],                // undashed uuid
    [A.toUpperCase(), A],                    // uppercase uuid
    ['main', A],                             // alias, shadowed by E's name below
    ['MAIN', A],                             // case-insensitive alias
    ['glowsquidye', A],                      // profile name
    ['alt', B],                              // second account's alias
    ['altone', B],                           // second account's name
    ['twinleft', C]                          // name inside a duplicated alias
  ]
  for (const [selector, uuid] of cases) {
    const result = h.runIn('status', '--account', selector, '--json')
    assert.equal(result.status, 0, selector + ': ' + result.stderr)
    const report = parse(result.stdout)
    assert.equal(report.account.uuid, uuid, selector)
    assert.equal(report.dir, dirOf(uuid), selector)
  }

  // The alias pass outranks the name pass: E carries the profile name 'main',
  // and 'main' still means the account whose alias is 'main'.
  const shadowed = parse(h.runIn('status', '--account', 'main', '--json').stdout)
  assert.equal(shadowed.account.uuid, A)
})

test('status --json reports presence of tokens and never their values', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('status', '--account', 'main', '--json')
  assert.equal(result.status, 0, result.stderr)
  const report = parse(result.stdout)

  assert.equal(report.account.alias, 'main')
  assert.equal(report.account.name, 'GlowSquidye')
  assert.equal(report.live.hasRefreshToken, true)
  assert.equal(report.live.hasAccessToken, true)
  assert.equal(report.live.accessTokenExpiresAt, OBTAINED_ON + 3600 * 1000)
  assert.equal(report.live.tokensExpired, true)
  assert.equal(report.writerLock.held, false)
  assert.equal(report.identity.uuid, A)

  assert.ok(!result.stdout.includes(REFRESH_TOKEN), result.stdout)
  assert.ok(!result.stdout.includes(ACCESS_TOKEN), result.stdout)
})

test('status prints a one-line-per-fact summary without --json', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('status', '--account', 'alt')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp('^account=' + B + ' name=AltOne alias=alt dir=', 'm'))
  assert.match(result.stdout, /^live-cache: refresh-token-presence=absent /m)
  assert.match(result.stdout, /^writer-lock: free$/m)
  assert.ok(!result.stdout.includes(REFRESH_TOKEN), result.stdout)
})

// ---------------------------------------------------------------------------
// refusals: exit 2, a message that names the problem
// ---------------------------------------------------------------------------

test('an ambiguous selector refuses and names exactly the accounts that matched', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('status', '--account', 'twin')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /cannot resolve a puppet account: ambiguous/)
  assert.match(result.stderr, new RegExp('uuid=' + C + ' '))
  assert.match(result.stderr, new RegExp('uuid=' + D + ' '))
  // The untouched accounts are not candidates: an operator reading this must not
  // be able to pick one by accident.
  assert.ok(!result.stderr.includes(A), result.stderr)
  assert.ok(!result.stderr.includes(B), result.stderr)
  assert.match(result.stderr, /hint: list accounts: node src\/custody\/cli\.js accounts/)
})

test('an unknown selector refuses and points at the account listing', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('status', '--account', 'glowsquidy')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /cannot resolve a puppet account: not_found/)
  assert.match(result.stderr, /^ {2}uuid=/m)
  assert.match(result.stderr, /hint: list accounts:/)
})

test('more than one account and no selector refuses instead of picking one', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('status')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /cannot resolve a puppet account: account_required/)
})

test('--dir and --account together refuse, and --dir needs a profile', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)
  const plain = path.join(h.root, 'plain')
  fs.mkdirSync(plain, { recursive: true })

  const both = h.runIn('status', '--dir', plain, '--account', 'main')
  assert.equal(both.status, 2, both.stderr)
  assert.match(both.stderr, /refused: --dir and --account are mutually exclusive/)

  const noProfile = h.runIn('status', '--dir', plain)
  assert.equal(noProfile.status, 2, noProfile.stderr)
  assert.match(noProfile.stderr, /it is not an account directory/)
})

test('usage errors exit 2 with the usage text', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const badFlag = h.run('accounts', '--accounts-dir', h.accountsDir, '--nope')
  assert.equal(badFlag.status, 2, badFlag.stderr)
  assert.match(badFlag.stderr, /^refused: unknown option: --nope$/m)
  assert.match(badFlag.stderr, /usage:\n {2}node src\/custody\/cli\.js accounts/)

  // The flag keeps its missing value ahead of the fixture flags, which follow.
  const noValue = h.run('--secrets-dir', h.secretsDir, 'status', '--account')
  assert.equal(noValue.status, 2, noValue.stderr)
  assert.match(noValue.stderr, /--account needs a value/)

  const noCommand = h.run()
  assert.equal(noCommand.status, 2, noCommand.stderr)
  assert.match(noCommand.stderr, /unknown command ''/)
  assert.match(noCommand.stderr, /usage:/)

  const badScope = h.runIn('whitelist', 'nope', 'add', 'Bafbi', '--file', path.join(h.root, 'w.json'))
  assert.equal(badScope.status, 2, badScope.stderr)
  assert.match(badScope.stderr, /whitelist scope must be attach or backend/)
})

test('device-code refuses a text selector it does not know, before any request', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const typo = h.runIn('device-code', '--account', 'glowsquidy')
  assert.equal(typo.status, 2, typo.stderr)
  assert.match(typo.stderr, /cannot resolve a puppet account: not_found/)

  const noProfile = h.runIn('device-code', '--dir', h.root)
  assert.equal(noProfile.status, 2, noProfile.stderr)
  assert.match(noProfile.stderr, /it is not an account directory/)
})

// ---------------------------------------------------------------------------
// whitelist attach
// ---------------------------------------------------------------------------

test('whitelist attach adds and removes one player by uuid, in the file it was given', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)
  const file = path.join(h.root, 'attach-whitelist.json')

  // A UUID never reaches the name resolver, which is the only path here that
  // would open a socket.
  const added = h.runIn('whitelist', 'attach', 'add', PLAYER, '--file', file)
  assert.equal(added.status, 0, added.stderr)
  assert.equal(added.stdout.trim(), 'added ' + PLAYER)
  assert.deepEqual(parse(fs.readFileSync(file, 'utf8')).players.map(entry => entry.uuid), [PLAYER])

  const removed = h.runIn('whitelist', 'attach', 'remove', PLAYER, '--file', file)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(removed.stdout.trim(), 'removed ' + PLAYER)
  assert.deepEqual(parse(fs.readFileSync(file, 'utf8')).players, [])

  // Removing twice is a failed operation, not a refusal: exit 1.
  const again = h.runIn('whitelist', 'attach', 'remove', PLAYER, '--file', file)
  assert.equal(again.status, 1, again.stderr)
  assert.match(again.stderr, /whitelist remove failed: not_present/)
})

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

test('migrate --dry-run plans the legacy move inside the tree it was given and touches nothing', (t) => {
  const h = harness(t)
  const legacyDir = seedLegacy(h.secretsDir)
  const before = fs.readdirSync(legacyDir).sort()
  // A quarantined old-layout directory moves into this root's retired/.
  fs.mkdirSync(path.join(h.secretsDir, 'puppet-java-403'), { recursive: true, mode: 0o700 })

  const result = h.runIn('migrate', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^migrate: dry-run \(ok\)$/m)
  assert.match(result.stdout, new RegExp('^uuid: ' + LEGACY_UUID + '$', 'm'))
  assert.match(result.stdout, new RegExp('^target: ' + path.join(h.accountsDir, LEGACY_UUID) + '$', 'm'))
  assert.match(result.stdout, /^  live: \d+ bytes -> live-cache\.json$/m)
  assert.match(result.stdout, /^targetExists: false$/m)
  assert.match(result.stdout, new RegExp('quarantine: present=true dir=' + path.join(h.secretsDir, 'puppet-java-403') + ' target=' + path.join(h.secretsDir, 'retired') + '/puppet-java-403-'))
  assert.ok(!/^applied: /m.test(result.stdout), 'a dry-run report must not claim a move')

  assert.deepEqual(fs.readdirSync(legacyDir).sort(), before)
  assert.equal(fs.existsSync(path.join(h.accountsDir, LEGACY_UUID)), false)
  assert.equal(fs.existsSync(path.join(h.secretsDir, 'retired')), false)
})

test('migrate --dry-run on a tree with no legacy directory says so and still exits 0', (t) => {
  const h = harness(t)
  seedAccounts(h.accountsDir)

  const result = h.runIn('migrate', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^migrate: dry-run \(not ok: not_found\)$/m)
})

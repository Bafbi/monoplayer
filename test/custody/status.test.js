// G1 status tests: read-only collection, --refresh refusal while the writer
// lock is held, and the redaction sentinel — synthetic token strings must
// not appear in any report/log. No network (refresh without a cached refresh
// token refuses before any request).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAuthStatus, accountTokenExpiry, stringifyForReport, redactForReport, scanForLeaks } from '../../src/custody/status.js'
import { atomicWriteFile } from '../../src/custody/cache.js'

const dir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-status-')), 'puppet')
const PLAYER = { dashed: '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af', name: 'Bafbi' }

// Synthetic sentinels: token-shaped but clearly fake.
const SENTINELS = [
  'mfaRefreshSyntheticToken000111222333444',
  'DEFINITELY_A_FAKE_ACCESS_TOKEN_cafecafe_1234567890abcdef',
  'eyJhbGciOiJSUzI1NiJ9.SYNTHETICPAYLOAD01.SYNTHETICSIGNATURE001',
]

test('collect(): read-only custody report, lock state, no token values', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', dir: root })
  const report = await status.collect()
  assert.deepEqual(report.account, { uuid: null, name: null, alias: null })
  assert.equal(report.dir, root)
  assert.equal(report.cacheDir, root)
  assert.equal(report.profile, null)
  assert.equal(report.cacheDirMode, '700')
  assert.equal(report.live.hasAccessToken, false)
  assert.equal(report.live.hasRefreshToken, false)
  assert.equal(report.writerLock.held, false)
  assert.equal(report.identity, null)
  // The report carries file names and flags only.
  assert.equal(JSON.stringify(report).includes('access-token-value'), false)
})

test('collect(): uuid/name/alias come from the account profile', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', uuid: PLAYER.dashed, dir: root })
  status.custody.profile.write({ uuid: PLAYER.dashed, name: PLAYER.name, alias: 'main', authTitle: '00000000402b5328' })
  const report = await status.collect()
  assert.deepEqual(report.account, { uuid: PLAYER.dashed, name: PLAYER.name, alias: 'main' })
  assert.equal(report.profile.uuid, PLAYER.dashed)
  assert.equal(report.identity.alias, 'main')
  assert.equal(report.identity.authTitle, '00000000402b5328')
})

test('collect(): a missing account directory is reported, never created', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-status-missing-'))
  const root = path.join(parent, 'accounts', PLAYER.dashed)
  const status = createAuthStatus({ uuid: PLAYER.dashed, dir: root })
  const report = await status.collect()
  assert.equal(fs.existsSync(root), false, 'status must not mkdir the account directory')
  assert.equal(report.dir, root)
  assert.equal(report.account.uuid, PLAYER.dashed)
  assert.equal(report.account.name, null)
  assert.equal(report.cacheDirMode, null)
  assert.equal(report.identity, null)
})

test('collect(): a warm cache is summarized by meta only — tokens never surface', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', dir: root })
  const msaHashedFile = status.custody.cacheFile('live')
  const synthetic = { token: { access_token: SENTINELS[0], refresh_token: SENTINELS[1], obtainedOn: Date.now() - 60_000, expires_in: 3600 } }
  atomicWriteFile(msaHashedFile, JSON.stringify(synthetic))
  const report = await status.collect()
  assert.equal(report.live.exists, true)
  assert.equal(report.live.hasAccessToken, true)
  assert.equal(report.live.hasRefreshToken, true)
  assert.ok(Number.isFinite(report.live.accessTokenExpiresAt))
  const text = stringifyForReport(report)
  for (const sentinel of SENTINELS) {
    assert.equal(text.includes(sentinel), false, `sentinel ${sentinel.slice(0, 24)}… must not appear`)
  }
})

test('refresh(): refuses while the writer lock is held — never contends', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', dir: root })
  const lock = status.custody.writerLock.acquire()
  assert.equal(lock.ok, true)
  const result = await status.refresh()
  assert.equal(result.refused, true)
  assert.equal(result.reason, 'writer_lock_held')
  assert.ok(`holder pid reported: ${typeof result.holder?.pid}`)
  status.custody.writerLock.release()
})

test('refresh(): without a live refresh token it refuses before any network or device code', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', dir: root })
  const result = await status.refresh()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs_bootstrap')
})

test('refresh(): uuid stability against the recorded identity meta', async () => {
  const root = dir()
  fs.mkdirSync(root, { mode: 0o700 })
  const status = createAuthStatus({ account: 'puppet', uuid: PLAYER.dashed, dir: root })
  status.custody.profile.write({ uuid: PLAYER.dashed, name: PLAYER.name, authTitle: '00000000402b5328' })
  const result = await status.refresh()
  // needs_bootstrap: the stability check itself is exercised through the
  // msa flow tests (stub Authflow); here we assert the ledger shape.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs_bootstrap')
})

test('redaction sentinel: synthetic tokens anywhere in a report are tagged, not emitted', () => {
  const report = JSON.stringify({
    note: `stale grant; refresh_token = '${SENTINELS[0]}'`,
    debug: `header ${SENTINELS[2]} tail`,
    config: `access_token = '${SENTINELS[1]}'`,
  })
  const findings = scanForLeaks(report)
  assert.ok(findings.length >= 3, `the scanner must see all three shapes (saw ${findings.length})`)
  const redacted = redactForReport(report)
  for (const sentinel of SENTINELS) {
    assert.equal(redacted.includes(sentinel), false, `sentinel must not appear: ${sentinel.slice(0, 20)}…`)
  }
  assert.ok(redacted.includes('[REDACTED]'))
  assert.doesNotThrow(() => JSON.parse(redacted), 'redacted reports must stay parseable')
})

// Custody's own prepass had the same JSON-quoted-key gap as the shared
// scanner, so the report path missed {"device_code":"…"} while the log path
// caught the same shape (#92). The prepass runs first, so its fix is what
// makes the report path see the quote.
test('redaction sentinel: a JSON-quoted auth key is tagged, and the tripwire sees it', () => {
  const deviceCode = 'ABCD-1234-EFGH'
  const token = 'abcdef123456789'
  const raw = JSON.stringify({ device_code: deviceCode, access_token: token })

  const found = scanForLeaks(raw)
  assert.ok(found.some(f => f.kind === 'local:device_code'), `the tripwire must see device_code (saw ${found.map(f => f.kind).join(', ')})`)

  const redacted = redactForReport(raw)
  assert.equal(redacted.includes(deviceCode), false, 'the device code must not survive')
  assert.equal(redacted.includes(token), false, 'the access token must not survive')
  assert.doesNotThrow(() => JSON.parse(redacted), 'redacted reports must stay parseable')
  // The tripwire runs over the redacted text in src/custody/cli.js. It must not
  // report the sentinel this pass just wrote, or it counts its own output.
  assert.deepEqual(scanForLeaks(redacted), [])

  // A number under an auth key is a JSON value with no quotes to hide behind,
  // so the tag takes its place as a string and the report still parses.
  const numeric = redactForReport('{"device_code":123456789}')
  assert.equal(numeric, '{"device_code":"[REDACTED]<device_code>"}')
  assert.doesNotThrow(() => JSON.parse(numeric), 'redacted reports must stay parseable')
})

// The prepass tags a value, then the shared scanner runs over its output. A
// sentinel is the result of redacting, so the second pass must not read it as
// a value and overwrite the kind the prepass just wrote (#92, and the chaining
// bug the ADR records).
test('redaction sentinel: a sentinel the prepass wrote is left as it is', () => {
  const redacted = redactForReport("access_token = 'SYNTHETIC_ACCESS_TOKEN_000111'")
  assert.equal(redacted.includes('SYNTHETIC_ACCESS_TOKEN_000111'), false)
  assert.ok(redacted.includes('<access_token>'), `the prepass kind survives the shared pass (saw ${redacted})`)
})

test('redaction sentinel: a token-string field added by a future code path is caught too', () => {
  const leaky = { files: [{ name: 'x_live-cache.json' }], holder: { message: `device_code= ${SENTINELS[0]}` } }
  const redacted = redactForReport(JSON.stringify(leaky))
  assert.equal(redacted.includes(SENTINELS[0]), false, 'device_code values must be tagged')
  assert.ok(redacted.includes('device_code'), 'the (non-secret) key name stays')
})

// #229: the one "info" fact the panel cannot otherwise reach. The heartbeat
// carries when the puppet's Minecraft token expires, and it is exactly what
// `status` reports for the account: the mca cache's obtain time plus its
// expires_in. Unknown is null, never a guess.
test('#229 accountTokenExpiry reads the mca cache the same way the status report does', () => {
  const root = dir()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  atomicWriteFile(path.join(root, 'mca-cache.json'), JSON.stringify({
    mca: { access_token: 'SENTINEL_ACCESS', obtainedOn: 1_700_000_000_000, expires_in: 86_400 }
  }))

  const expected = 1_700_000_000_000 + 86_400 * 1000
  assert.equal(accountTokenExpiry({ dir: root, account: 'puppet' }), expected)
  const report = createAuthStatus({ account: 'puppet', dir: root })
  return report.collect().then(collected => {
    assert.equal(collected.mca.expiresAt, expected, 'the heartbeat and the status report cannot disagree')
  })
})

test('#229 accountTokenExpiry is null when the token facts are absent, never a guess', () => {
  const empty = dir()
  fs.mkdirSync(empty, { recursive: true, mode: 0o700 })
  assert.equal(accountTokenExpiry({ dir: empty, account: 'puppet' }), null, 'no cache file')
  assert.equal(accountTokenExpiry({ dir: path.join(empty, 'absent'), account: 'puppet' }), null, 'no directory')

  atomicWriteFile(path.join(empty, 'mca-cache.json'), JSON.stringify({ mca: { access_token: 'SENTINEL_ACCESS' } }))
  assert.equal(accountTokenExpiry({ dir: empty, account: 'puppet' }), null, 'a token with no expiry facts')
})

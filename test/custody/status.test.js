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

// The report path reads one key list now, the log path's. It used to run its own
// auth-specific prepass with a second list, and that list lacked its own
// `device_code_pairing` sibling (#181). A JSON-quoted key is matched, and the
// tripwire sees what the redactor rewrites.
test('redaction sentinel: a JSON-quoted auth key is tagged, and the tripwire sees it', () => {
  const deviceCode = 'ABCD-1234-EFGH'
  const pairing = 'PAIR-1234-5678'
  const token = 'abcdef123456789'
  const raw = JSON.stringify({ device_code: deviceCode, device_code_pairing: pairing, access_token: token })

  const found = scanForLeaks(raw)
  assert.equal(found.length, 3, `one finding per secret, not two for one (saw ${found.map(f => f.kind).join(', ')})`)
  assert.ok(found.every(f => f.kind === 'assignment'), 'the scanner kinds them, and names no prepass')

  const redacted = redactForReport(raw)
  for (const value of [deviceCode, pairing, token]) {
    assert.equal(redacted.includes(value), false, 'the value must not survive')
  }
  assert.doesNotThrow(() => JSON.parse(redacted), 'redacted reports must stay parseable')
  // The tripwire runs over the redacted text in src/custody/cli.js. It must not
  // report the sentinel the redactor just wrote, or it counts its own output.
  assert.deepEqual(scanForLeaks(redacted), [])

  // A number under an auth key is a JSON value with no quotes to hide behind,
  // so the tag takes its place as a string and the report still parses.
  const numeric = redactForReport('{"device_code":123456789}')
  assert.equal(numeric, '{"device_code":"[REDACTED]<assignment>"}')
  assert.doesNotThrow(() => JSON.parse(numeric), 'redacted reports must stay parseable')
})

// A sentinel is the result of redacting, so no pass reads it as a value and
// overwrites the kind beside it (the chaining bug the ADR records). One pass
// cannot chain, so what this pins is that a report already carrying a sentinel is
// left byte-identical rather than re-tagged.
test('redaction sentinel: a sentinel already in the report is left as it is', () => {
  const already = "access_token = '[REDACTED]<assignment>'"
  assert.equal(redactForReport(already), already)
  assert.deepEqual(scanForLeaks(already), [])
})

test('redaction sentinel: a token-string field added by a future code path is caught too', () => {
  const leaky = { files: [{ name: 'x_live-cache.json' }], holder: { message: `device_code= ${SENTINELS[0]}` } }
  const redacted = redactForReport(JSON.stringify(leaky))
  assert.equal(redacted.includes(SENTINELS[0]), false, 'device_code values must be tagged')
  assert.ok(redacted.includes('device_code'), 'the (non-secret) key name stays')
})


// #181: three field names the log path redacted and the report path did not. The
// report path was two rules — the scanner's key list and custody's own prepass —
// and neither named these. They are one list now, so a name the log path knows is
// a name the report path knows.
test('redaction sentinel: user_code, device_code_pairing and cookie are tagged (#181)', () => {
  const value = 'abcdef123456789'
  for (const key of ['user_code', 'device_code_pairing', 'cookie']) {
    const raw = JSON.stringify({ [key]: value })
    const found = scanForLeaks(raw)
    assert.equal(found.length, 1, `one finding for ${key}, not ${found.length}: ${found.map(f => f.kind).join(', ')}`)
    const redacted = redactForReport(raw)
    assert.equal(redacted.includes(value), false, `${key} must not survive the report path`)
    assert.doesNotThrow(() => JSON.parse(redacted), 'a redacted report must still parse')
  }

  // The form shape takes the same three names.
  const form = redactForReport('user_code=abcdef123456789 device_code_pairing=zyxwvu987654321')
  assert.equal(form.includes('abcdef123456789'), false)
  assert.equal(form.includes('zyxwvu987654321'), false)
})


// #182: a Basic credential is a base64 pair of a name and a password, and it is the
// shape an operator pastes into a bug report. Neither rule set knew a scheme but
// Bearer, so the report printed it whole and the tripwire stayed silent.
test('redaction sentinel: an Authorization credential is tagged whatever its scheme (#182)', () => {
  const credential = 'dXNlcjpwYXNzd29yZA=='
  for (const scheme of ['Basic', 'Digest', 'Negotiate', 'Bearer']) {
    const raw = `Authorization: ${scheme} ${credential}`
    assert.ok(scanForLeaks(raw).length >= 1, `the tripwire must see a ${scheme} credential`)
    assert.equal(redactForReport(raw).includes(credential), false, `${scheme} must not survive`)
  }
  // The report path writes JSON, and a redacted report must still parse.
  const json = JSON.stringify({ note: `proxy said: Authorization: Basic ${credential}` })
  const redacted = redactForReport(json)
  assert.equal(redacted.includes(credential), false)
  assert.doesNotThrow(() => JSON.parse(redacted), 'a redacted report must still parse')
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

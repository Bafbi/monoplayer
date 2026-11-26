// The secret scanner: assignments, JWTs, long hex, and the reports that carry
// them. These cases moved here with the module when it left the driver lane
// (#38). The assertions are the ones that lived in test/driver/checks.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { scanSecrets, redactSecrets } from '../../src/observability/secrets.js'

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

test('redaction finds token/password-shaped assignments and does not leak values', () => {
  const input = 'config: {token: hunter2hunter2, password = "correct horse"} ok'
  const { text, findings } = redactSecrets(input)
  assert.equal(findings.length, 2)
  assert.equal(text.includes('hunter2hunter2'), false)
  assert.equal(text.includes('correct horse'), false)
  assert.ok(text.includes('[REDACTED]<assignment>') && text.includes('token'))
})

test('redaction catches JWTs and long hex without a key', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c6'
  const input = `header ${'a'.repeat(64)} jwt ${jwt} end`
  const findings = scanSecrets(input)
  const kinds = findings.map(f => f.kind).sort()
  assert.deepEqual(kinds, ['jwt', 'long-hex'])
  const { text } = redactSecrets(input)
  assert.equal(text.includes(jwt), false)
})

test('redaction handles a JWT before a password assignment without leaking', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c6'
  const secret = 'opensesame123'
  const input = JSON.stringify({ header: jwt, note: `password=${secret}`, tail: 'end' })
  const { text } = redactSecrets(input)
  assert.equal(text.includes(jwt), false, 'JWT must not survive redaction')
  assert.equal(text.includes(secret), false, 'password must not survive redaction')
  assert.doesNotThrow(() => JSON.parse(text), 'redacted JSON must still parse')
})

test('redaction leaves ordinary text untouched, report-safe', () => {
  const input = '{"run":1,"passed":true,"name":"Bafbi","pos":{"x":96.5}}'
  const { text, findings } = redactSecrets(input)
  assert.equal(findings.length, 0)
  assert.equal(text, input)
})

// JSON puts a quote between the key and the colon. The assignment rule wanted
// ':' or '=' right after the key name, so the report path missed a shape the
// log path caught (#92). Only the value span is replaced, so the redacted
// document still parses.
test('a JSON-quoted key is scanned, and its value rewritten, without breaking the JSON', () => {
  const token = 'abcdef123456789'
  const input = JSON.stringify({ access_token: token, note: 'ordinary' })
  const findings = scanSecrets(input)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'assignment')
  assert.ok(findings[0].key.endsWith('token'), `the key names the field (saw ${findings[0].key})`)
  const { text } = redactSecrets(input)
  assert.equal(text.includes(token), false, 'the value must not survive')
  assert.doesNotThrow(() => JSON.parse(text), 'redacted JSON must still parse')

  // A bare value under a guarded key is a JSON value too. The tag takes its
  // place as a string, and a number must not leave the brace or the type behind.
  const numeric = redactSecrets('{"token":12345678}')
  assert.equal(numeric.text, '{"token":"[REDACTED]<assignment>"}')
  assert.doesNotThrow(() => JSON.parse(numeric.text), 'redacted JSON must still parse')
})

// The assignment rule read the word after the key as the value. "Bearer" is
// six characters and the rule's minimum is eight, so the token after it was
// never scanned, and the tripwire stayed silent (#92).
test('an opaque bearer value is found and tagged as its own kind', () => {
  const token = 'opaqueTokenValue123'
  const input = `Authorization: Bearer ${token}`
  const findings = scanSecrets(input)
  assert.deepEqual(findings.map(f => f.kind), ['bearer'])
  assert.equal(findings[0].value, token)
  const { text } = redactSecrets(input)
  assert.equal(text.includes(token), false, 'the token must not survive')
  assert.equal(text, 'Authorization: Bearer [REDACTED]<bearer>', 'the scheme stays as the label')
})

test('a bearer value that is also a JWT keeps both kinds in one span', () => {
  // The synthetic JWT the custody tests already use. A real sample token in a
  // test file is a finding for every secret scanner that reads the diff.
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.SYNTHETICPAYLOAD01.SYNTHETICSIGNATURE001'
  const { text, findings } = redactSecrets(`Authorization: Bearer ${jwt}`)
  assert.deepEqual(findings.map(f => f.kind), ['bearer', 'jwt'])
  assert.equal(text.includes(jwt), false)
})


// #182: the report path had a Bearer rule and no other scheme. The kind names the
// scheme, so a report still says which shape leaked: <bearer> stays what it was,
// and <basic> is new.
test('an Authorization credential is tagged with its scheme (#182)', () => {
  const credential = 'dXNlcjpwYXNzd29yZA=='
  const { text, findings } = redactSecrets(`Authorization: Basic ${credential}`)
  assert.deepEqual(findings.map(f => f.kind), ['basic'])
  assert.equal(findings[0].value, credential)
  assert.equal(text.includes(credential), false)
  assert.equal(text, 'Authorization: Basic [REDACTED]<basic>', 'the scheme stays as the label')

  // The pinned Bearer shape does not move.
  const bearer = redactSecrets('Authorization: Bearer opaqueTokenValue123')
  assert.deepEqual(bearer.findings.map(f => f.kind), ['bearer'])
  assert.equal(bearer.text, 'Authorization: Bearer [REDACTED]<bearer>')

  // A header with no scheme word is a credential too, and the tag names the
  // header. The scheme group is greedy over a credential's own letters, so it
  // needs a space to separate it from the value: without one it ate all but the
  // last character and called the credential the scheme.
  for (const value of ['opaqueTokenValue123', 'dXNlcjpwYXNzd29yZA==', 'PMT-1-abcdef123456789']) {
    const schemeless = redactSecrets(`Authorization: ${value}`)
    assert.deepEqual(schemeless.findings.map(f => f.kind), ['authorization'], `no scheme word in ${value}`)
    assert.equal(schemeless.text, 'Authorization: [REDACTED]<authorization>', `the whole value goes: ${value}`)
  }
})

// Redaction is a rewrite, not a map over the original: a sentinel already in
// the text is the result of redacting, never a value to redact again. Without
// this, a second pass eats the tag it just wrote and the report loses the kind.
test('an existing sentinel is not treated as a value', () => {
  const already = "access_token = '[REDACTED]<access_token>'"
  const { text, findings } = redactSecrets(already)
  assert.deepEqual(findings, [])
  assert.equal(text, already)
})


// #181: the log path named these three keys and the report path's two rules named
// none of them, so a device-code pairing value or a stored cookie reached stdout
// while the tripwire stayed silent.
test('the scanner knows the names the log path knows (#181)', () => {
  const value = 'abcdef123456789'
  for (const key of ['user_code', 'device_code_pairing', 'cookie']) {
    const input = JSON.stringify({ [key]: value })
    const findings = scanSecrets(input)
    assert.equal(findings.length, 1, `one finding for ${key} (saw ${findings.length})`)
    assert.equal(findings[0].kind, 'assignment')
    const { text } = redactSecrets(input)
    assert.equal(text.includes(value), false, `${key} must not survive`)
    assert.doesNotThrow(() => JSON.parse(text), 'redacted JSON must still parse')
  }
})

test('a realistic report blob containing a leaked token gets redacted end to end', () => {
  const leaked = 'rconOp: {"kind":"probe","output":"... password=opensesame123 ..."}'
  const { text, findings } = redactSecrets(leaked)
  assert.equal(findings.length, 1)
  assert.equal(text.includes('opensesame123'), false)
})

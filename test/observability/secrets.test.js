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

test('a realistic report blob containing a leaked token gets redacted end to end', () => {
  const leaked = 'rconOp: {"kind":"probe","output":"... password=opensesame123 ..."}'
  const { text, findings } = redactSecrets(leaked)
  assert.equal(findings.length, 1)
  assert.equal(text.includes('opensesame123'), false)
})

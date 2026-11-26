// The redaction sentinel is fixed, and the option that pretended to set it is
// gone (#103).
//
// `redact()` destructured `{ sentinel = SENTINEL }` and never read it, so a
// caller that passed its own sentinel was silently ignored. Removing every
// secret shape from the output is what the function promises; choosing the
// sentinel was never part of it. The removal changes no output, so the shape of
// the declaration is what there is to test, beside the behaviour it delivers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { redact, SENTINEL } from '../../src/observability/redact.js'

const SOURCE = fs.readFileSync(new URL('../../src/observability/redact.js', import.meta.url), 'utf8')

test('redact() declares no sentinel option', () => {
  // Either declaration form counts: what the test refuses is a sentinel in the
  // parameter list, not the syntax the function is written in.
  const signature = SOURCE.match(/^export (?:function|const) redact[^\n]*/m)?.[0]

  assert.ok(signature, 'redact() is exported as a named declaration')
  assert.doesNotMatch(
    signature,
    /sentinel/,
    'redact() takes the text, not a sentinel: a parameter it does not read is how the sentinel got ignored'
  )
})

test('a caller cannot choose the sentinel, and nothing survives the fixed one', () => {
  assert.equal(SENTINEL, '[REDACTED]')
  assert.equal(redact('password=hunter2'), 'password=' + SENTINEL)
  // The option this change removed: a caller that still passes it gets the fixed
  // sentinel, not a surprise. That is the no-behaviour-change claim for them.
  assert.equal(redact('password=hunter2', { sentinel: '[GONE]' }), 'password=' + SENTINEL)
  // The quoted field name survives as a bare label, so a redacted line still
  // says which shape leaked.
  assert.equal(redact('{"access_token":"abc123"}'), '{access_token=' + SENTINEL + '}')
  assert.equal(redact('nothing secret here'), 'nothing secret here')
  assert.equal(redact(null), null)
})

// The field rule read the word after the colon as the value, so an
// Authorization header redacted the scheme and left the token beside it (#92).
// The scheme word is not the secret: the header redacts to its label.
test('an Authorization header redacts the bearer value, not the word Bearer', () => {
  assert.equal(redact('Authorization: Bearer opaqueTokenValue123'), 'Authorization=' + SENTINEL)
  assert.equal(redact('authorization: Bearer opaqueTokenValue123').includes('opaqueTokenValue123'), false)

  // A bearer value with no field name keeps its scheme as a label, which is
  // what the journal and telemetry paths rely on.
  assert.equal(redact('sent Bearer opaqueTokenValue123 upstream'), 'sent Bearer ' + SENTINEL + ' upstream')

  // Prose that names the scheme and nothing else is left alone.
  assert.equal(redact('the Bearer header is required'), 'the Bearer header is required')
})

// A redacted line can be logged twice, and the second pass must not eat the
// brace around the label it left. A sentinel is the result of redacting, never
// a value to redact again (#92).
test('redact() leaves a line it already redacted alone', () => {
  const once = redact('{"access_token":"abc123"}')
  assert.equal(redact(once), once)
  assert.equal(redact('{access_token=' + SENTINEL + '}'), '{access_token=' + SENTINEL + '}')
  assert.equal(redact('Authorization=' + SENTINEL), 'Authorization=' + SENTINEL)
})


// #183: the log path has no bare token, secret or bearer key. The report path has
// all three, and `redact()` is the last stop before a journal line or a telemetry
// attribute, so a value pasted as `secret=…` survived into the JSONL record.
test('a bare token, secret or bearer key is redacted on the log path (#183)', () => {
  const value = 'abcdef123456789'
  for (const key of ['token', 'secret', 'bearer']) {
    assert.equal(redact(JSON.stringify({ [key]: value })), `{${key}=${SENTINEL}}`, `JSON form, ${key}`)
    assert.equal(redact(`${key}=${value}`), `${key}=${SENTINEL}`, `form, ${key}`)
  }
})

// #182: the field rule took the scheme word as the value and stopped at the space,
// so the credential survived beside a label that said REDACTED. Worst on `Basic`,
// because `SCHEME` knew only `bearer`: a line that looks redacted is worse than a
// line that shows a gap.
test('an Authorization credential is redacted whatever its scheme (#182)', () => {
  const credential = 'dXNlcjpwYXNzd29yZA=='
  for (const scheme of ['Basic', 'Digest', 'Negotiate', 'Bearer', 'Arkose']) {
    const line = redact(`Authorization: ${scheme} ${credential}`)
    assert.equal(line, 'Authorization=' + SENTINEL, `${scheme} must not survive`)
    assert.equal(line.includes(credential), false)
  }
  assert.equal(redact('Proxy-Authorization: Basic ' + credential).includes(credential), false, 'the proxy header is the same shape')

  // Prose that names a scheme and carries no credential is left alone. "Basic
  // authentication" is the trap: the word after the scheme is long enough to pass
  // any bare length floor, so the floor alone is not the guard.
  for (const prose of ['the Bearer header is required', 'the Basic auth header is required', 'Basic authentication is required', 'Digest authentication is required']) {
    assert.equal(redact(prose), prose)
  }
})

// A bare value stops at the punctuation that ends it. A JSON number under a
// guarded key must not eat the brace after it, and a form value that holds a
// comma must not lose its tail to it.
test('a bare value stops at the brace, and a comma does not stop it', () => {
  assert.equal(redact('{"password":123456789012}'), '{password=' + SENTINEL + '}')
  assert.equal(redact('password=abc,def,ghi,jkl'), 'password=' + SENTINEL)
})

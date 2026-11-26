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
  assert.equal(redact('{"access_token":"abc123"}'), '{"access_token":"' + SENTINEL + '"}')
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
  assert.equal(JSON.parse(once).access_token, SENTINEL, 'the quoted label and a JSON string are what a document keeps')
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
    // #553: a JSON line is rewritten as a document, so the member keeps its quotes.
    assert.equal(redact(JSON.stringify({ [key]: value })), `{"${key}":"${SENTINEL}"}`, `JSON form, ${key}`)
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

// The label is the key, never part of the value. A base64 credential ends in =
// padding, and the label group was greedy over = as well as over letters, so it
// republished the tail of the credential beside the sentinel — a line that says
// REDACTED and still carries the secret (#182, #183).
test('a value that ends in = padding does not leak into the label', () => {
  for (const [line, key] of [
    ['secret=YWJjZA==', 'secret'],
    ['token=YWJjZA==', 'token'],
    ['bearer=YWJjZA==', 'bearer'],
    ['Authorization=dXNlcjpwYXNzd29yZA==', 'Authorization'],
    ['password=YWJjZA==', 'password']
  ]) {
    const out = redact(line)
    assert.equal(out, key + '=' + SENTINEL, `the label is the key: ${line}`)
  }
})

// A bare value stops at the punctuation that ends it. A JSON number under a
// guarded key must not eat the brace after it, and a form value that holds a
// comma must not lose its tail to it.
test('a bare value stops at the brace, and a comma does not stop it', () => {
  // #553: a JSON document is read as a document now, so the brace stays where it
  // belongs and the sentinel is a JSON string.
  assert.equal(redact('{"password":123456789012}'), '{"password":"' + SENTINEL + '"}')
  assert.equal(redact('password=abc,def,ghi,jkl'), 'password=' + SENTINEL)
})

// #553: #438 made a map keyed by an open string the norm, and the heartbeat writes
// those maps into one JSON line. The field rule matched a key that names a secret
// field over the whole line and rewrote it as a field, so the line stopped being
// JSON. That is the one line an operator reads to find those counts. A redacted line
// is a JSON document, and a secret in the same line is still redacted: a fix that
// stops redacting to keep the line parseable is worse than the bug.
test('a map key that names a secret field leaves the line parseable (#553)', () => {
  const secret = 'hunter2hunter2'
  const token = 'abc123def456ghi789'
  const line = JSON.stringify({
    event: 'heartbeat',
    metrics: { serverboundByName: { token: 5, cookie_request: 2, secret: 1, chat: 9 } },
    password: secret,
    access_token: token
  })

  const out = redact(line)
  const parsed = JSON.parse(out) // the claim: redaction never breaks the line

  assert.equal(out.includes(secret), false, 'a real secret value is gone')
  assert.equal(out.includes(token), false, 'so is the other one')
  assert.equal(parsed.password, SENTINEL)
  assert.equal(parsed.access_token, SENTINEL)
  assert.equal(parsed.metrics.serverboundByName.cookie_request, 2, 'a count with an ordinary name survives')
  assert.equal(parsed.metrics.serverboundByName.chat, 9)
  // The cost of reading a key by its shape: a count under a secret-shaped name
  // cannot be told from a secret, so it goes too. The safe direction is the one
  // that loses a number rather than a token.
  assert.equal(parsed.metrics.serverboundByName.token, SENTINEL)
  assert.equal(parsed.metrics.serverboundByName.secret, SENTINEL)
})

// The line parses because the redaction happens inside the document, so a secret
// pasted into a string value is redacted there and the quotes around it survive.
test('a secret-shaped string value is redacted without breaking the line (#553)', () => {
  const bearer = 'eyAbcDefG1234567890'
  const line = JSON.stringify({
    event: 'backendError',
    error: 'Authorization: Bearer ' + bearer,
    detail: 'refresh_token=' + bearer
  })

  const out = redact(line)
  assert.equal(out.includes(bearer), false, 'the bearer value is the secret')
  const parsed = JSON.parse(out)
  // The label survives inside the string, exactly as the text rule prints it: an
  // Authorization field takes its scheme word with the value it scopes.
  assert.equal(parsed.error, 'Authorization=' + SENTINEL)
  assert.equal(parsed.detail, 'refresh_token=' + SENTINEL)
})

// A key that merely carries a secret name is a name about tokens, not a token.
// Reading the key by its shape is what tells the two apart; the text rule cannot.
test('a key that only contains a secret name is not a secret field (#553)', () => {
  const line = JSON.stringify({ metrics: { tokensByName: { token_count: 5 } } })
  assert.equal(redact(line), line)
})

// A line with nothing to redact is evidence, and the redactor has no business
// reprinting it: a rebuild would reprint 1.0 as 1 and hoist an integer-like key.
test('a document with nothing to redact is returned byte-identical (#553)', () => {
  const line = '{"n":1.0,"m":1e3,"big":12345678901234567890,"5":"x","b":1,"note":"the token cache is warm"}'
  assert.equal(redact(line), line)
})

// A document is rebuilt from its own members, so a key no one writes by hand is
// still one: __proto__ is a member of the parsed document, not the prototype of the
// object the rebuild builds. The line carries a secret, so the rebuild happens.
test('a key named __proto__ survives the rebuild as a member (#553)', () => {
  const line = '{"event":"x","__proto__":{"x":1},"password":"abcdefghijkl"}'
  const parsed = JSON.parse(redact(line))
  assert.equal(Object.hasOwn(parsed, '__proto__'), true, 'the member is rebuilt, not swallowed by the prototype')
  assert.equal(parsed.password, SENTINEL)
})

// The key faces the text rules too. The old rule redacted a secret used as a key
// because it matched over the whole line; a walk has to ask, and the promise in the
// module header is that no secret-shaped string survives in any position.
test('a secret used as a key is redacted (#553)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'
  const out = redact(JSON.stringify({ [jwt]: 1 }))
  assert.equal(out.includes(jwt), false)
  assert.doesNotThrow(() => JSON.parse(out))
})

// The second pass is the test that the walk does not eat its own output: a
// redacted value is a sentinel string inside a document, never a thing to redact.
test('a redacted JSON line is byte-identical when it is redacted again (#553)', () => {
  const line = JSON.stringify({
    event: 'heartbeat',
    metrics: { serverboundByName: { token: 5 } },
    password: 'abcdefghijkl'
  })
  const once = redact(line)
  assert.doesNotThrow(() => JSON.parse(once))
  assert.equal(redact(once), once)
})

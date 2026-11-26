// The two redaction paths agree about what a secret is.
//
// Nothing read both paths before this file. `src/observability/redact.js` rewrites
// a log line and `src/observability/secrets.js` returns findings for a report, and
// each carried its own key list, so nine names were redacted on one path and not
// the other (#181, #183). Two lists that disagree is how that happens; one list
// cannot. This guard drives the one list through both paths, so a name added to it
// and wired into one renderer fails here rather than in a journal record.
//
// It asserts the property that matters, not an output shape: a value must not
// survive either path. The outputs stay apart on purpose — the log path keeps the
// field name and the report path keeps the kind (docs/adr/keep-the-log-redactor-
// and-the-report-scanner-apart.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redact, SENTINEL, SECRET_FIELDS, KNOWN_SCHEMES } from '../../src/observability/redact.js'
import { redactSecrets } from '../../src/observability/secrets.js'

const VALUE = 'abcdef123456789'

// A name in SECRET_FIELDS may be a small pattern (`api[-_]?key`), so the sample is
// the concrete spelling an operator would paste.
const sample = name => name.replace(/\[-_\]\?/g, '')

// The one name the credential rule owns on the report path instead of the key rule,
// because a header's value is a scheme word and a credential, and two rules reading
// it would count one secret twice.
const KEY_NAMES = SECRET_FIELDS.filter(name => name !== 'authorization')

test('every name in the one list is redacted by both paths (#181, #183)', () => {
  const survivors = []
  for (const name of KEY_NAMES) {
    const key = sample(name)
    for (const input of [JSON.stringify({ [key]: VALUE }), `${key}=${VALUE}`]) {
      if (redact(input).includes(VALUE)) survivors.push(`log: ${input}`)
      const { text } = redactSecrets(input)
      if (text.includes(VALUE)) survivors.push(`report: ${input}`)
    }
  }
  assert.deepEqual(survivors, [], 'a name both paths must read')
})

test('the report path leaves JSON it redacted parseable, for every name', () => {
  for (const name of KEY_NAMES) {
    const input = JSON.stringify({ [sample(name)]: VALUE })
    const { text } = redactSecrets(input)
    assert.doesNotThrow(() => JSON.parse(text), `${name} must leave a parsable report`)
  }
})

test('every name in the one list keeps the log path label that makes it greppable', () => {
  for (const name of KEY_NAMES) {
    const key = sample(name)
    const line = redact(`${key}=${VALUE}`)
    assert.equal(line.includes(SENTINEL), true, `${key} is redacted`)
    assert.equal(line.includes(VALUE), false, `${key} keeps no value`)
  }
})

// #182: a credential is one rule on each path, and neither may leave the value
// behind whatever the scheme is.
test('both paths redact a credential behind any scheme', () => {
  const credential = 'dXNlcjpwYXNzd29yZA=='
  for (const scheme of ['Basic', 'Digest', 'Negotiate', 'Bearer', 'Arkose', 'Random-Scheme']) {
    const header = `Authorization: ${scheme} ${credential}`
    assert.equal(redact(header).includes(credential), false, `log path, ${scheme}`)
    assert.equal(redactSecrets(header).text.includes(credential), false, `report path, ${scheme}`)
  }
  for (const scheme of KNOWN_SCHEMES.match(/[A-Za-z]+/g)) {
    assert.equal(redact(`sent ${scheme} ${credential} upstream`).includes(credential), false, `bare ${scheme}, log path`)
    assert.equal(redactSecrets(`sent ${scheme} ${credential} upstream`).text.includes(credential), false, `bare ${scheme}, report path`)
  }
})

// Neither path may rewrite a line that carries no secret. A tripwire nobody
// believes is a tripwire that hides the next leak.
test('neither path rewrites ordinary text', () => {
  const ordinary = [
    'the Bearer header is required',
    'Basic authentication is required',
    'loading something into memory',
    'the token cache is warm',
    '{"run":1,"passed":true,"name":"Bafbi","pos":{"x":96.5}}',
    'the password policy is documented in the runbook'
  ]
  for (const line of ordinary) {
    assert.equal(redact(line), line, `log path must leave it alone: ${line}`)
    assert.deepEqual(redactSecrets(line).findings, [], `report path must find nothing: ${line}`)
  }
})

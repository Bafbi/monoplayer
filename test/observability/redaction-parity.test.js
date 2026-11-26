// The two redaction paths agree about what a secret is.
//
// Nothing read both paths before this file. `src/observability/redact.js` rewrites
// a log line and `src/observability/secrets.js` returns findings for a report, and
// each carried its own key list, and the two disagreed about which names held a
// secret, in both directions (#181, #183). Two lists that disagree is how that
// happens; one list cannot. This guard drives the one list through both paths, so a
// name added to it
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

// Two shapes, because a value with base64 padding is where a greedy label group
// republishes the tail beside the sentinel. A plain alphanumeric value cannot see
// that (#182, #183).
const VALUES = ['abcdef123456789', 'YWJjZA==', 'dXNlcjpwYXNzd29yZA==']

// A name in SECRET_FIELDS may be a small pattern (`api[-_]?key`), so the sample is
// the shortest concrete spelling that pattern matches.
const sample = name => name.replace(/\[-_\]\?/g, '')

test('every name in the one list is redacted by both paths (#181, #183)', () => {
  // No filter over SECRET_FIELDS: one here would be a second copy of a production rule,
  // and this guard would then pass while production stopped honouring a name. The
  // credential rule covers `authorization` on the report path, so the list needs no
  // exception.
  const survivors = []
  for (const name of SECRET_FIELDS) {
    const key = sample(name)
    for (const value of VALUES) {
      for (const input of [JSON.stringify({ [key]: value }), `${key}=${value}`]) {
        if (redact(input).includes(value)) survivors.push(`log: ${input}`)
        const { text } = redactSecrets(input)
        if (text.includes(value)) survivors.push(`report: ${input}`)
      }
    }
  }
  assert.deepEqual(survivors, [], 'a name both paths must read')
})

test('the report path leaves JSON it redacted parseable, for every name', () => {
  for (const name of SECRET_FIELDS) {
    for (const value of VALUES) {
      const input = JSON.stringify({ [sample(name)]: value })
      const { text } = redactSecrets(input)
      assert.doesNotThrow(() => JSON.parse(text), `${name} must leave a parsable report`)
    }
  }
})

test('every name in the one list keeps the log path label that makes it greppable', () => {
  for (const name of SECRET_FIELDS) {
    const key = sample(name)
    for (const value of VALUES) {
      const line = redact(`${key}=${value}`)
      assert.equal(line.includes(SENTINEL), true, `${key} is redacted`)
      assert.equal(line.includes(value), false, `${key} keeps no value`)
    }
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

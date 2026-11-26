// Secret scanning and kind-tagged redaction for reports and logs.
//
// Custody (src/custody/status.js, msa.js, attach.js) and the driver lane
// (src/driver/run.js, scenario.js) import this module. The custody CLI reaches it
// through custody's own report helpers, because the CLI uses no scanner symbol
// directly. A report is scanned before it is written, and a leaked shape becomes
// [REDACTED]<kind> so the finding still says WHICH shape it was. This is a leak
// tripwire, not a scanning product, and false positives lean on the side of
// redacting more.
//
// This module is not the only pattern set in the tree, and that is on purpose.
// src/observability/redact.js rewrites a log line in place and keeps the field
// name (access_token=[REDACTED]). This scanner returns findings with their index
// and their kind, because report writers count them and name them. A log line
// needs the label that a report wants gone, so the two sets have different
// outputs and different readers.
//
// What the two sets share is the vocabulary, and only the vocabulary: the names in
// SECRET_FIELDS and the credential grammar around them both come from
// src/observability/redact.js. They used to be three hand-written key lists — this
// one, the log path's, and custody's prepass — and the three disagreed: user_code,
// device_code_pairing and cookie were redacted on one path and not the others
// (#181, #183). One list cannot disagree with itself.
//
// Two shapes this scanner used to miss closed in #92, and a third in #182. A
// JSON-quoted key is matched now: JSON puts a quote between the key and the
// separator, and the key rule accepts it. A credential is matched by its own rule,
// because the assignment rule reads the scheme word as a value and stops at the
// space after it, and the scheme is any RFC 7235 token. The key rule skips a value
// that already begins with the sentinel, and an authorization field is not a key
// this rule reads at all: the credential rule owns it, so one header is one
// finding rather than two.
// No I/O, no env access, and no network of any kind, so the unit tests stay fully
// offline.

import {
  SECRET_FIELDS,
  CREDENTIAL_SCHEME,
  KNOWN_SCHEMES,
  CREDENTIAL,
  CREDENTIAL_SHAPE
} from './redact.js'

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

// The Authorization field is not a key rule below: a header's value is a scheme
// word and a credential, and the credential rule owns every one of them. Reading it
// here as well would give one secret two findings and a warning that counts twice.
const KEY_FIELDS = SECRET_FIELDS.filter(name => name !== 'authorization')

// JSON puts a quote between the key and the separator, so the separator may
// sit behind a closing quote (#92).
const ASSIGNMENT = new RegExp(
  String.raw`(` + KEY_FIELDS.join('|') + String.raw`)"?\s*[:=]\s*(?:"((?!\[REDACTED\])[^"]{8,})"|'((?!\[REDACTED\])[^']{8,})'|((?!\[REDACTED\])[^\s"',;}\]]{8,}))`,
  'gi'
)

// One rule for every RFC 7235 credential, in two branches. The first is a field
// named authorization, where any scheme is safe because the field name scopes the
// match. The second is a bare credential, where the scheme list is closed and the
// value has to look unlike prose. The kind is the scheme, so a report says which
// shape leaked and <bearer> keeps the meaning #92 gave it (#182).
const CREDENTIAL_SPAN = new RegExp(
  "\\b(?:authorization)\"?\\s*[:=]\\s*\"?(" + CREDENTIAL_SCHEME + ")?\\s*" +
    "(?:\"((?!\\[REDACTED\\])[^\"]+)\"|'((?!\\[REDACTED\\])[^']+)'|((?!\\[REDACTED\\])[^\\s\"',;}\\]]+))" +
    "|\\b(" + KNOWN_SCHEMES + ")\\s+" + CREDENTIAL_SHAPE + "(" + CREDENTIAL + ")",
  'gi'
)

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g
const LONG_HEX = /\b[0-9a-f]{40,}\b/gi

export function scanSecrets (text) {
  const source = String(text ?? '')
  const findings = []
  for (const match of source.matchAll(ASSIGNMENT)) {
    const value = match[2] ?? match[3] ?? match[4]
    findings.push({
      kind: 'assignment',
      key: match[1].toLowerCase(),
      value,
      index: match.index,
    })
  }
  // Before the JWT rule, so a bearer value that is also a JWT is tagged
  // <bearer+jwt> rather than <jwt+bearer>.
  for (const match of source.matchAll(CREDENTIAL_SPAN)) {
    const scheme = match[1] ?? match[5]
    const value = match[2] ?? match[3] ?? match[4] ?? match[6]
    findings.push({
      kind: (scheme ?? 'authorization').toLowerCase(),
      value,
      index: match.index,
    })
  }
  for (const match of source.matchAll(JWT)) {
    findings.push({ kind: 'jwt', value: match[0], index: match.index })
  }
  for (const match of source.matchAll(LONG_HEX)) {
    findings.push({ kind: 'long-hex', value: match[0], index: match.index })
  }
  return findings
}

export const REDACTION_TAG = '[REDACTED]'

// Replace secret-shaped spans. Findings are grouped by kind, so they must be
// sorted by their actual span before merging; overlapping spans (for example a
// JWT that is also the value of a password assignment) are merged so the
// replacement offsets stay valid.
export function redactSecrets (text) {
  const source = String(text ?? '')
  const findings = scanSecrets(source)
  if (findings.length === 0) return { text: source, findings: [] }

  const spans = findings
    .map(finding => {
      const start = source.indexOf(finding.value, finding.index)
      return { start, end: start + finding.value.length, kind: finding.kind }
    })
    .filter(span => span.start !== -1)
    .sort((a, b) => a.start - b.start)

  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
      if (!last.kinds.includes(span.kind)) last.kinds.push(span.kind)
    } else {
      merged.push({ ...span, kinds: [span.kind] })
    }
  }

  let out = source
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i]
    out = out.slice(0, span.start) + tagForValue(source, span.start, span.kinds.join('+')) + out.slice(span.end)
  }
  return { text: out, findings }
}

// A tag takes the place of a value. A bare value after a colon sits in a JSON
// document, where the tag has to be a string: an unquoted tag stops the
// document parsing, and a report must still parse (#92).
export function tagForValue (source, start, kinds) {
  const tag = `${REDACTION_TAG}<${kinds}>`
  const before = String(source).slice(0, start).trimEnd()
  return before.endsWith(':') ? `"${tag}"` : tag
}

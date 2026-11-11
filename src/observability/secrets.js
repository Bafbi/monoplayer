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
// The custody report helpers run their own auth-specific prepass before this
// scanner (src/custody/status.js LOCAL_ASSIGNMENT), for the device-code and token
// keys this scanner does not know. A secret shape that is not auth-specific
// therefore has two homes, and an auth-specific one has three.
//
// Two shapes this scanner used to miss closed in #92. A JSON-quoted key is
// matched now: JSON puts a quote between the key and the separator, and the key
// rule accepts it. An RFC 7235 credential is matched by its own rule, because
// the assignment rule reads the scheme word "Bearer" as a value and stops at
// the space after it. The key rule skips a value that already begins with the
// sentinel: a redacted span is the result of redacting, never a value to redact
// again.
// No I/O and no env access of any kind, so the unit tests stay fully offline.

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

// JSON puts a quote between the key and the separator, so the separator may
// sit behind a closing quote (#92).
const ASSIGNMENT =
  /(token|password|passwd|secret|api[-_]?key|bearer|credential|authorization)"?\s*[:=]\s*(?:"((?!\[REDACTED\])[^"]{8,})"|'((?!\[REDACTED\])[^']{8,})'|((?!\[REDACTED\])[^\s"',;}\]]{8,}))/gi
// An RFC 7235 credential: the scheme word is a label, the value after it is
// the secret. The assignment rule reads the scheme as a value and stops at the
// space, and "Bearer" is under the 8-character floor, so this form needs its
// own rule (#92).
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi
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
  for (const match of source.matchAll(BEARER)) {
    findings.push({ kind: 'bearer', value: match[1], index: match.index })
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

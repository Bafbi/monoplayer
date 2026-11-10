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
// Known gaps, kept as they were when this module moved out of the driver lane
// (#38). Fixing them changes what redacted output looks like, so they need their
// own ticket and their own tests (#92):
//   - a JSON-quoted key is not matched here. The key group wants ':' or '=' right
//     after the name, and {"access_token":"x"} puts a quote there. The log
//     redactor catches that form, so only the report path leaks it.
//   - an opaque Bearer token is not matched when it follows an Authorization
//     field. This scanner reads the value after "authorization:" as the
//     6-character word "Bearer", which is under its 8-character minimum, and a
//     "bearer" key needs ':' or '=' that the space denies. The log redactor has
//     the same blind spot for that form, though it does redact a bare
//     "Bearer <value>".
// No I/O and no env access of any kind, so the unit tests stay fully offline.

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

const ASSIGNMENT =
  /(token|password|passwd|secret|api[-_]?key|bearer|credential|authorization)\s*[:=]\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"',;]{8,}))/gi
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
    out = out.slice(0, span.start) + `${REDACTION_TAG}<${span.kinds.join('+')}>` + out.slice(span.end)
  }
  return { text: out, findings }
}

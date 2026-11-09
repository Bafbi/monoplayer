// Pure evidence helpers for the driver lane: RCON output parsing,
// numeric comparisons with tolerances, client-status predicates, block-test
// parsing, and secret scanning. No I/O and no env access of any kind, so the
// unit tests stay fully offline.

export const TEST_PASSED = 'Test passed'
export const TEST_FAILED = 'Test failed'

// ---------------------------------------------------------------------------
// RCON output parsing
// ---------------------------------------------------------------------------

// `execute [unless] if block x y z <block>` answers "Test passed" or
// "Test failed". Anything else — quiet errors such as "Could not set the
// block", an empty output, or garbage — is `unknown` and must never be read
// as a pass. Positive assertions only.
export function parseBlockTest (output) {
  const text = String(output ?? '')
  if (text.includes(TEST_PASSED)) return 'passed'
  if (text.includes(TEST_FAILED)) return 'failed'
  return 'unknown'
}

// A recorded RCON result is `{ ok, output, ... }`; `ok` means the kubectl exec
// succeeded, the parsed verdict decides pass/fail.
export function blockTestResult (result, expected = 'passed') {
  return Boolean(result && result.ok) && parseBlockTest(result.output) === expected
}

// `data get entity <name> Pos` -> "Bafbi has the following entity data: [13.5d, -60.0d, -4.5d]"
// `data get entity <name> Rotation` -> "... [45.75f, 10.0f]"
export function parseEntityPath (output) {
  const match = String(output ?? '').match(/\[([^\]]+)\]/)
  if (!match) return null
  const values = []
  for (const part of match[1].split(',')) {
    const m = part.trim().match(/^(-?\d+(?:\.\d+)?)[df]?$/)
    if (!m) return null
    values.push(Number(m[1]))
  }
  return values
}

export function parseEntityPos (output) {
  const values = parseEntityPath(output)
  if (!values || values.length !== 3) return null
  return { x: values[0], y: values[1], z: values[2] }
}

export function parseEntityRotation (output) {
  const values = parseEntityPath(output)
  if (!values || values.length !== 2) return null
  return { yaw: values[0], pitch: values[1] }
}

// "There are 1 of a max of 4 players online: Bafbi"
// "There are 0 of a max of 20 players online:"
// Empty/missing output -> null (never an answer that "contains no Bafbi").
export function parsePlayerList (output) {
  const match = String(output ?? '').match(
    /There are (\d+) of a max of \d+ players online:?(.*)$/is
  )
  if (!match) return null
  const rest = match[2].trim()
  if (rest === '') return []
  return rest.split(',').map(name => name.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Numeric comparisons (tolerances, yaw wrap)
// ---------------------------------------------------------------------------

export function distance3D (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function positionsWithin (a, b, tolBlocks) {
  if (!a || !b) return false
  return distance3D(a, b) <= tolBlocks
}

// Wrap an angle in degrees into [-180, 360 -> (-180, 180]).
export function wrapAngle (deg) {
  const wrapped = (((Number(deg) % 360) + 540) % 360) - 180
  if (Object.is(wrapped, 180)) return -180
  return wrapped
}

// Smallest signed difference between two angles in degrees.
export function angleDelta (a, b) {
  return wrapAngle(Number(a) - Number(b))
}

export function anglesWithin (a, b, tolDeg) {
  return Math.abs(angleDelta(a, b)) <= tolDeg
}

// Compare [yaw, pitch] pairs; yaw wraps, pitch does not.
export function rotationsWithin (a, b, { tolYaw = 2, tolPitch = 2 } = {}) {
  if (!a || !b) return false
  return anglesWithin(a.yaw, b.yaw, tolYaw) && Math.abs(a.pitch - b.pitch) <= tolPitch
}

// ---------------------------------------------------------------------------
// Client-status predicates (driver `status` payload)
// ---------------------------------------------------------------------------

// status fields: screen ('none' or a screen class name), level (bool),
// player (bool), connected (bool), renderedSections (> 0 means terrain is
// actually drawn, not just downloaded).
export function isSettled (status) {
  return Boolean(
    status &&
    status.connected === true &&
    status.level === true &&
    status.player === true &&
    status.screen === 'none' &&
    Number(status.renderedSections) > 0
  )
}

export function isDisconnected (status) {
  return Boolean(status && status.connected === false)
}

export function describeStatus (status) {
  if (!status) return 'no status'
  const pos = status.pos ? `pos=${status.pos.x},${status.pos.y},${status.pos.z}` : 'pos=?'
  const held = status.held !== undefined ? ` held=${status.held}` : ''
  return `connected=${status.connected} screen=${status.screen} level=${status.level} player=${status.player} rendered=${status.renderedSections} ${pos}${held}`
}

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

// Scans arbitrary text for secret-shaped content. This is a leak tripwire for
// reports and logs, not a security-scanning product; false positives lean on
// the side of redacting more.
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

// Pure verifier for the G0 evidence bundle. The summary must describe one
// invocation that requested and executed exactly two runs; the two report
// paths it names must be the chronological run 1 and run 2 and both must have
// passed. This prevents two separate one-run invocations from looking like 2/2.
export function verifyG0Evidence (summary, reports, { now = Date.now(), maxAgeMs = Infinity } = {}) {
  if (!summary || typeof summary !== 'object') return { ok: false, reason: 'missing driver summary' }
  if (summary.runsRequested !== 2 || summary.runsExecuted !== 2 || summary.runsPassed !== 2 ||
      summary.allPassed !== true || !Array.isArray(summary.reports) || summary.reports.length !== 2) {
    return {
      ok: false,
      reason: `latest summary is not a clean 2-run invocation (requested=${summary.runsRequested}, executed=${summary.runsExecuted}, passed=${summary.runsPassed})`,
    }
  }
  if (!Array.isArray(reports) || reports.length !== 2) return { ok: false, reason: 'expected two driver reports' }
  for (const report of reports) {
    if (!report || report.lane !== 'driver' || report.passed !== true) {
      return { ok: false, reason: 'both driver reports must be lane=driver and passed=true' }
    }
  }
  const sorted = [...reports].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  if (!Number.isFinite(Date.parse(sorted[0].startedAt)) || !Number.isFinite(Date.parse(sorted[1].startedAt))) {
    return { ok: false, reason: 'driver reports need valid startedAt timestamps' }
  }
  if (sorted[0].run !== 1 || sorted[1].run !== 2) {
    return { ok: false, reason: `chronological runs must be 1 then 2 (got ${sorted[0].run} then ${sorted[1].run})` }
  }
  const generated = Date.parse(summary.generatedAt)
  if (Number.isFinite(generated) && Date.parse(sorted[1].startedAt) > generated) {
    return { ok: false, reason: 'driver summary is stale: a newer report exists' }
  }
  // A committed or hand-copied report set is not evidence of anything: it passes
  // whether or not anything ran today. Bound the age of the newest run, so the
  // gate can only be green on evidence this checkout produced recently.
  const finished = Date.parse(sorted[1].finishedAt ?? sorted[1].startedAt)
  if (Number.isFinite(maxAgeMs) && Number.isFinite(finished) && now - finished > maxAgeMs) {
    return {
      ok: false,
      reason: `driver evidence is stale: the newest run finished at ${new Date(finished).toISOString()}, outside the ${Math.round(maxAgeMs / 60000)}-minute window`,
    }
  }
  return { ok: true, reason: '2/2 consecutive driver runs' }
}

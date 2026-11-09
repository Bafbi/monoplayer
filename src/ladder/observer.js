// #12: the server-view report.
//
// The observer plugin writes one JSONL record per join, describing what the
// server knew about that client. The direct baseline and the puppet join the
// same server, so the two records compare field by field. One difference is
// accepted: the proxy's egress address. Everything else is unexplained, and an
// unexplained difference fails the run.
//
// The comparison is pure, so it is tested without a server. The CLI reads the
// two logs and prints the same verdict.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The fields the observer records and the report compares. Order is the report
// order: identity, then the client's own information, then the connection.
export const VIEW_FIELDS = Object.freeze([
  'player',
  'uuid',
  'address',
  'brand',
  'locale',
  'viewDistance',
  'mainHand',
  'skinParts',
  'chatSession',
  'transferred',
  'resourcePack'
])

// The differences the spec accepts, and why. Anything not listed here is a
// finding.
export const KNOWN_DIFFERENCES = Object.freeze({
  address: 'the proxy egress address is the one accepted difference, and reads as a client behind a VPN'
})

const absent = value => value === undefined || value === null
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function compareViews (baseline = {}, puppet = {}) {
  const fields = VIEW_FIELDS.map(field => {
    const left = baseline[field]
    const right = puppet[field]
    let verdict
    if (absent(left) && absent(right)) verdict = 'absent'
    else if (absent(left) || absent(right)) verdict = 'unexplained'
    else if (same(left, right)) verdict = 'same'
    else if (KNOWN_DIFFERENCES[field]) verdict = 'expected'
    else verdict = 'unexplained'
    return { field, baseline: left ?? null, puppet: right ?? null, verdict }
  })
  const unexplained = fields.filter(entry => entry.verdict === 'unexplained')
  return {
    ok: unexplained.length === 0,
    fields,
    unexplained,
    expected: fields.filter(entry => entry.verdict === 'expected'),
    absent: fields.filter(entry => entry.verdict === 'absent')
  }
}

// The last view record in a JSONL file. The plugin also logs lifecycle lines;
// anything that is not JSON, or not a client_view record, is skipped.
export function lastView (text) {
  let found = null
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record
    try { record = JSON.parse(trimmed) } catch { continue }
    if (record && record.event === 'client_view') found = record
  }
  return found
}

export function readView (file) {
  const text = fs.readFileSync(file, 'utf8')
  const record = lastView(text)
  if (record === null) throw new Error(`no client_view record in ${file}`)
  return record
}

export function formatReport (report) {
  const lines = report.fields.map(entry => {
    const mark = entry.verdict === 'unexplained' ? 'FAIL' : entry.verdict.toUpperCase()
    return `${mark.padEnd(12)} ${entry.field}: baseline=${JSON.stringify(entry.baseline)} puppet=${JSON.stringify(entry.puppet)}`
  })
  lines.push('')
  lines.push(report.ok
    ? `observer: PASS ${report.fields.length} fields, ${report.expected.length} expected, ${report.absent.length} absent`
    : `observer: FAIL ${report.unexplained.length} unexplained: ${report.unexplained.map(entry => entry.field).join(', ')}`)
  return lines.join('\n')
}

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const baselinePath = flag(argv, '--baseline')
  const puppetPath = flag(argv, '--puppet')
  if (!baselinePath || !puppetPath) {
    io.stderr.write('usage: node src/ladder/observer.js --baseline <views.jsonl> --puppet <views.jsonl> [--report <file>]\n')
    return 2
  }
  let report
  try {
    report = compareViews(readView(baselinePath), readView(puppetPath))
  } catch (error) {
    io.stderr.write(`observer: ${String(error?.message ?? error)}\n`)
    return 2
  }
  io.stdout.write(formatReport(report) + '\n')
  const reportPath = flag(argv, '--report') ?? '.reports/observer-report.json'
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ rung: 'observer', passed: report.ok, ...report }, null, 2) + '\n')
  return report.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}

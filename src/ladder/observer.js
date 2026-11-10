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
  'codeOfConduct',
  'codeOfConductAccepted',
  'resourcePack'
])

// The differences the spec accepts, and why. Anything not listed here is a
// finding.
export const KNOWN_DIFFERENCES = Object.freeze({
  address: 'the proxy egress address is the one accepted difference, and reads as a client behind a VPN'
})

// Why a field can be absent on both joins, and the server fact that has to hold
// for the reason to be true. The gate Paper reads these facts out of its own
// server.properties (`--server`), and a reason is attached only when the read
// agrees. That way a server that starts serving the gate or a resource pack stops
// excusing the field by itself, and an absence nobody can explain is printed as
// one instead of being explained away.
//
// Measured on the gate Paper (2026-11-09): turning enable-code-of-conduct on does
// not just add a gate, it stops the server. The start failure reads "Code of
// Conduct folder does not exist: codeofconduct", from
// DedicatedServer.readCodeOfConducts. So the G0 row keeps the gate off, and the
// observer measures `paper-conduct`, which carries the folder. Point the run back
// at a lane without it and these two reasons explain the fields again.
export const ABSENT_FACTS = Object.freeze({
  codeOfConduct: {
    setting: 'codeOfConduct',
    value: false,
    reason: 'the measured server reports enable-code-of-conduct=false, so it never sends the gate'
  },
  codeOfConductAccepted: {
    setting: 'codeOfConduct',
    value: false,
    reason: 'the measured server reports enable-code-of-conduct=false, so there is no gate to accept'
  },
  resourcePack: {
    setting: 'resourcePack',
    value: false,
    reason: 'the measured server reports no resource pack, so no status event ever fires'
  }
})

// The reason for an absent field, or null when the run has no fact to stand on.
function absentReason (field, server) {
  const fact = ABSENT_FACTS[field]
  if (!fact || !server) return null
  return server[fact.setting] === fact.value ? fact.reason : null
}

const absent = value => value === undefined || value === null
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function compareViews (baseline = {}, puppet = {}, { server = null } = {}) {
  const fields = VIEW_FIELDS.map(field => {
    const left = baseline[field]
    const right = puppet[field]
    let verdict
    if (absent(left) && absent(right)) verdict = 'absent'
    else if (absent(left) || absent(right)) verdict = 'unexplained'
    else if (same(left, right)) verdict = 'same'
    else if (KNOWN_DIFFERENCES[field]) verdict = 'expected'
    else verdict = 'unexplained'
    const entry = { field, baseline: left ?? null, puppet: right ?? null, verdict }
    // A reason explains an absence; it never stands in for a value. The moment a
    // join reports the field, the verdict is no longer 'absent' and the reason is
    // gone with it.
    if (verdict === 'absent') entry.reason = absentReason(field, server)
    return entry
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

// The raw client_view records in a JSONL file, in order. The plugin also logs
// lifecycle lines; anything that is not JSON, or not a client_view record, is
// skipped.
export function records (text) {
  const found = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record
    try { record = JSON.parse(trimmed) } catch { continue }
    if (record && record.event === 'client_view') found.push(record)
  }
  return found
}

// The observed fields of one record, with the unobserved ones dropped, so a later
// record can fill an earlier one without erasing what it already knew.
const observed = record => Object.fromEntries(
  Object.entries(record).filter(([, value]) => value !== null && value !== undefined)
)

// One view per connection. A connection is written more than once: the join
// record, then the session key, then the resource-pack status, because each of
// those can only be observed after the join. Two
// records that share an address describe the same connection, so the later one
// fills in the fields the earlier one could not see. A reconnect gets a new
// source port, so it starts a new view.
export function views (text) {
  const merged = []
  for (const record of records(text)) {
    const previous = merged.at(-1)
    if (previous && previous.address && previous.address === record.address) {
      Object.assign(previous, observed(record))
      continue
    }
    merged.push({ ...record })
  }
  return merged
}

// The last view record in a JSONL file.
export function lastView (text) {
  return views(text).at(-1) ?? null
}


export function readView (file) {
  const text = fs.readFileSync(file, 'utf8')
  const record = lastView(text)
  if (record === null) throw new Error(`no client_view record in ${file}`)
  return record
}

// The server facts the absence reasons stand on, or null when the run read none.
// A missing or unreadable file is not an error: it means no absence can be
// explained, which is the honest answer when the facts were not measured.
export function readServerFacts (file) {
  if (!file) return null
  try {
    const facts = JSON.parse(fs.readFileSync(file, 'utf8'))
    return facts && typeof facts === 'object' ? facts : null
  } catch {
    return null
  }
}

export function formatReport (report) {
  const lines = report.fields.map(entry => {
    const mark = entry.verdict === 'unexplained' ? 'FAIL' : entry.verdict.toUpperCase()
    const line = `${mark.padEnd(12)} ${entry.field}: baseline=${JSON.stringify(entry.baseline)} puppet=${JSON.stringify(entry.puppet)}`
    if (entry.verdict !== 'absent') return line
    return `${line} -- ${entry.reason ?? 'no reason recorded'}`
  })
  const bare = report.absent.filter(entry => entry.reason === null || entry.reason === undefined)
  lines.push('')
  lines.push(report.ok
    ? `observer: PASS ${report.fields.length} fields, ${report.expected.length} expected, ${report.absent.length} absent` +
      ` (${report.absent.length - bare.length} with a reason${bare.length > 0 ? `, ${bare.length} without: ${bare.map(entry => entry.field).join(', ')}` : ''})`
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
  const singlePath = flag(argv, '--single')
  if (!singlePath && (!baselinePath || !puppetPath)) {
    io.stderr.write('usage: node src/ladder/observer.js --baseline <views.jsonl> --puppet <views.jsonl> [--server <facts.json>] [--report <file>]\n' +
      '       node src/ladder/observer.js --single <views.jsonl> [--server <facts.json>] [--report <file>]\n')
    return 2
  }
  const server = readServerFacts(flag(argv, '--server'))
  let report
  try {
    if (singlePath) {
      // One log from one server, two joins: the direct baseline first, the
      // puppet last. A reconnect during the puppet run only adds puppet views,
      // so the last one is still the puppet's.
      const all = views(fs.readFileSync(singlePath, 'utf8'))
      if (all.length < 2) {
        throw new Error(`${singlePath} holds ${all.length} client_view records; a baseline and a puppet join need at least two`)
      }
      report = compareViews(all[0], all.at(-1), { server })
    } else {
      report = compareViews(readView(baselinePath), readView(puppetPath), { server })
    }
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

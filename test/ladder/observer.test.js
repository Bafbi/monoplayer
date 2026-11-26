// #12: the server-view report. Two observer records, one field-by-field diff.
//
// The observer writes one JSONL record per join. The direct baseline and the
// puppet join the same server, so their records describe what the server knew
// about each client. The diff separates the one accepted difference (the
// proxy's egress address) from everything unexplained.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import path from 'node:path'
import { tempRoot } from '../support/temp.js'

import {
  ABSENT_FACTS,
  compareViews,
  formatReport,
  lastView,
  main,
  records,
  VIEW_FIELDS,
  KNOWN_DIFFERENCES,
  views
} from '../../src/ladder/observer.js'

const base = (overrides = {}) => ({
  player: 'GlowSquidye',
  uuid: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed',
  address: '203.0.113.7:52001',
  brand: 'fabric',
  locale: 'en_us',
  viewDistance: 10,
  mainHand: 'right',
  skinParts: 127,
  chatSession: true,
  transferred: false,
  codeOfConduct: true,
  codeOfConductAccepted: true,
  resourcePack: 'accepted',
  ...overrides
})

test('identical views have no unexplained difference', () => {
  const report = compareViews(base(), base())
  assert.equal(report.ok, true)
  assert.equal(report.unexplained.length, 0)
  assert.equal(report.fields.every(entry => entry.verdict === 'same'), true)
})

test('the proxy egress address is expected, never unexplained', () => {
  const report = compareViews(base(), base({ address: '198.51.100.9:40000' }))
  assert.equal(report.ok, true, 'the accepted difference does not fail the run')
  const address = report.fields.find(entry => entry.field === 'address')
  assert.equal(address.verdict, 'expected')
  assert.match(KNOWN_DIFFERENCES.address, /egress/)
})

test('a different brand is unexplained and fails the run', () => {
  const report = compareViews(base(), base({ brand: 'vanilla' }))
  assert.equal(report.ok, false)
  assert.deepEqual(report.unexplained.map(entry => entry.field), ['brand'])
})

test('a field only one side reports is unexplained', () => {
  const puppet = base()
  delete puppet.chatSession
  const report = compareViews(base(), puppet)
  assert.equal(report.ok, false)
  assert.equal(report.fields.find(entry => entry.field === 'chatSession').verdict, 'unexplained')
})

test('a field neither side reports is absent, not a pass', () => {
  const without = base()
  delete without.resourcePack
  const other = base()
  delete other.resourcePack
  const report = compareViews(without, other)
  assert.equal(report.ok, true)
  assert.equal(report.fields.find(entry => entry.field === 'resourcePack').verdict, 'absent')
})

// #78: three fields cannot be observed on the gate Paper at all. Absent is the
// honest verdict, and a reason is what makes it a measurement rather than a hole.
// The reason is attached only when the run read the server fact it rests on.
const NO_GATE = { codeOfConduct: false, resourcePack: false }

test('an absent field carries the reason the server facts support', () => {
  const without = base()
  for (const field of ['codeOfConduct', 'codeOfConductAccepted', 'resourcePack']) delete without[field]
  const other = { ...without }
  const report = compareViews(without, other, { server: NO_GATE })
  assert.equal(report.ok, true)
  for (const entry of report.absent) {
    assert.equal(typeof entry.reason, 'string', entry.field + ' carries a reason')
    assert.equal(entry.reason, ABSENT_FACTS[entry.field].reason)
  }
  assert.match(report.absent.find(entry => entry.field === 'codeOfConduct').reason, /enable-code-of-conduct/)
  assert.match(report.absent.find(entry => entry.field === 'resourcePack').reason, /resource pack/)
})

test('a server that serves the gate does not get its absence explained away', () => {
  // The reason is a claim about the server, so the server gets to refute it. With
  // the gate on and the field still absent, the listener is the suspect, and the
  // report must say so rather than quote a fact that no longer holds.
  const without = base()
  delete without.codeOfConduct
  const report = compareViews(without, { ...without }, { server: { codeOfConduct: true, resourcePack: true } })
  const entry = report.fields.find(field => field.field === 'codeOfConduct')
  assert.equal(entry.verdict, 'absent')
  assert.equal(entry.reason, null)
  assert.match(formatReport(report), /no reason recorded/)
})

test('an absence with no server facts to read is not explained', () => {
  const without = base()
  delete without.resourcePack
  const report = compareViews(without, { ...without })
  assert.equal(report.fields.find(field => field.field === 'resourcePack').reason, null,
    'nothing was measured, so nothing is claimed')
})

test('an absence with no declared reason is named as unexplained, not excused', () => {
  const without = base()
  delete without.mainHand
  const other = { ...without }
  const report = compareViews(without, other)
  const entry = report.fields.find(field => field.field === 'mainHand')
  assert.equal(entry.verdict, 'absent')
  assert.equal(entry.reason, null)
  assert.match(formatReport(report), /mainHand: .* -- no reason recorded/)
  assert.match(formatReport(report), /0 with a reason, 1 without: mainHand/)
})

test('a reason never stands in for a value', () => {
  const report = compareViews(base(), base())
  for (const entry of report.fields) {
    assert.equal('reason' in entry, false, entry.field + ' carries a value, so it carries no reason')
  }
  assert.match(formatReport(report), /\nobserver: PASS 13 fields/)
})

test('every compared field is declared', () => {
  const report = compareViews(base(), base())
  assert.deepEqual(report.fields.map(entry => entry.field), VIEW_FIELDS)
})

// One command runs both joins against one server, so both views land in one
// log and the report splits it by position: baseline first, puppet last.
const log = (...records) => records
  .map(record => (typeof record === 'string' ? record : JSON.stringify({ event: 'client_view', ...record })))
  .join('\n') + '\n'

test('the log splits into a first view and a last view', () => {
  const text = log(
    '[11:00:00] MonoplayerObserver enabled',
    base({ address: '203.0.113.7:52001' }),
    'not json at all',
    base({ address: '198.51.100.9:40000' }),
    base({ address: '198.51.100.9:40001' })
  )
  assert.equal(views(text).length, 3)
  assert.equal(views(text)[0].address, '203.0.113.7:52001')
  assert.equal(lastView(text).address, '198.51.100.9:40001', 'a puppet reconnect keeps the last view')
  assert.deepEqual(views(log()), [])
  assert.equal(lastView(log()), null)
})

test('two records for one connection merge into one view', () => {
  // The plugin writes the join first and the resource-pack status after it,
  // because that status always arrives late. The report must compare the same
  // two connections, not the join of one against the pack status of the other.
  const text = log(
    base({ address: '203.0.113.7:52001', resourcePack: null }),
    base({ address: '203.0.113.7:52001', resourcePack: 'accepted' }),
    base({ address: '198.51.100.9:40000', resourcePack: null }),
    base({ address: '198.51.100.9:40000', resourcePack: 'accepted' })
  )
  assert.equal(records(text).length, 4)
  const merged = views(text)
  assert.equal(merged.length, 2, 'one view per connection')
  assert.equal(merged[0].address, '203.0.113.7:52001')
  assert.equal(merged[1].address, '198.51.100.9:40000')
  assert.equal(merged[1].resourcePack, 'accepted', 'the later record fills the field the join could not see')

  const report = compareViews(merged[0], merged[1])
  assert.equal(report.ok, true, 'the resource-pack field is compared, not absent')
  assert.equal(report.fields.find(entry => entry.field === 'resourcePack').verdict, 'same')
})

test('--single takes the server facts from the file it is given', () => {
  const dir = tempRoot('observer-')
  const file = path.join(dir, 'views.jsonl')
  const facts = path.join(dir, 'server.json')
  const reportPath = path.join(dir, 'report.json')
  const bare = base()
  delete bare.resourcePack
  fs.writeFileSync(file, log(bare, { ...bare, address: '198.51.100.9:40000' }))
  fs.writeFileSync(facts, JSON.stringify(NO_GATE))
  const out = []
  const code = main(['--single', file, '--server', facts, '--report', reportPath], {
    stdout: { write: text => out.push(text) },
    stderr: { write: text => out.push(text) }
  })
  assert.equal(code, 0, out.join(''))
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.match(report.absent.find(entry => entry.field === 'resourcePack').reason, /no resource pack/)
})

test('an unreadable server facts file leaves every absence unexplained', () => {
  const dir = tempRoot('observer-')
  const file = path.join(dir, 'views.jsonl')
  const bare = base()
  delete bare.codeOfConduct
  fs.writeFileSync(file, log(bare, { ...bare, address: '198.51.100.9:40000' }))
  const out = []
  const code = main(['--single', file, '--server', path.join(dir, 'missing.json'), '--report', path.join(dir, 'r.json')], {
    stdout: { write: text => out.push(text) },
    stderr: { write: text => out.push(text) }
  })
  assert.equal(code, 0, out.join(''))
  assert.match(out.join(''), /no reason recorded/)
})

test('--single reads one log and compares its first and last view', () => {
  const dir = tempRoot('observer-')
  const file = path.join(dir, 'views.jsonl')
  const reportPath = path.join(dir, 'report.json')
  fs.writeFileSync(file, log(base(), base({ address: '198.51.100.9:40000' })))

  const out = []
  const code = main(['--single', file, '--report', reportPath], {
    stdout: { write: text => out.push(text) },
    stderr: { write: text => out.push(text) }
  })
  assert.equal(code, 0, out.join(''))
  assert.match(out.join(''), /PASS 13 fields/)
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.fields.find(entry => entry.field === 'address').verdict, 'expected')
})

test('--single refuses a log that holds one view', () => {
  const dir = tempRoot('observer-')
  const file = path.join(dir, 'views.jsonl')
  fs.writeFileSync(file, log(base()))
  const out = []
  const code = main(['--single', file, '--report', path.join(dir, 'report.json')], {
    stdout: { write: text => out.push(text) },
    stderr: { write: text => out.push(text) }
  })
  assert.equal(code, 2)
  assert.match(out.join(''), /need at least two/)
})

// #12: the server-view report. Two observer records, one field-by-field diff.
//
// The observer writes one JSONL record per join. The direct baseline and the
// puppet join the same server, so their records describe what the server knew
// about each client. The diff separates the one accepted difference (the
// proxy's egress address) from everything unexplained.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  compareViews,
  lastView,
  main,
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

test('--single reads one log and compares its first and last view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'))
  const file = path.join(dir, 'views.jsonl')
  const reportPath = path.join(dir, 'report.json')
  fs.writeFileSync(file, log(base(), base({ address: '198.51.100.9:40000' })))

  const out = []
  const code = main(['--single', file, '--report', reportPath], {
    stdout: { write: text => out.push(text) },
    stderr: { write: text => out.push(text) }
  })
  assert.equal(code, 0, out.join(''))
  assert.match(out.join(''), /PASS 11 fields/)
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.fields.find(entry => entry.field === 'address').verdict, 'expected')
})

test('--single refuses a log that holds one view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'))
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

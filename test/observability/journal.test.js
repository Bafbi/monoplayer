// Exact packet journal: NDJSON round-trip, truncation, chat/secret skips,
// rotation, lifecycle events, and the inert default.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createJournal, journalFileOrder, readJournal, readNdjson } from '../../src/observability/journal.js'

const NOW = 1_700_000_000_000
const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-journal-'))
}

function readLines (file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function withJournal (t, options = {}) {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = createJournal({ dir, clock: () => NOW, ...options })
  return { dir, journal }
}

test('no directory means a no-op with no file', () => {
  const journal = createJournal({})
  assert.equal(journal.enabled, false)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'position', buffer: Buffer.from('x') }), false)
  journal.event('start', { name: 'Bafbi' })
  journal.close()
  journal.close()
  assert.equal(journal.stats().enabled, false)
})

test('frames round-trip: raw bytes as base64, ordered, with epoch timestamps', t => {
  const { dir, journal } = withJournal(t)
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f])

  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: payload }), true)
  assert.equal(journal.frame({ dir: 'c2s', state: 'play', name: 'position', buffer: Buffer.from('move') }), true)
  journal.close()

  const files = fs.readdirSync(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^session-.+-\d+\.ndjson$/)
  const records = readLines(path.join(dir, files[0]))

  assert.deepEqual(records[0], {
    t: NOW,
    dir: 's2c',
    state: 'play',
    name: 'map_chunk',
    len: 5,
    b64: payload.toString('base64')
  })
  assert.deepEqual(Buffer.from(records[0].b64, 'base64'), payload)
  assert.equal(records[1].dir, 'c2s')
  assert.equal(records[1].name, 'position')
  assert.equal(Buffer.from(records[1].b64, 'base64').toString(), 'move')
  assert.ok(records[0].t <= records[1].t)
})

test('frames longer than 8192 bytes are truncated without a payload', t => {
  const { dir, journal } = withJournal(t)
  const big = Buffer.alloc(8193, 0x41)
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: big })
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: Buffer.alloc(8192, 0x42) })
  journal.close()

  const records = readLines(path.join(dir, fs.readdirSync(dir)[0]))
  assert.deepEqual(records[0], {
    t: NOW,
    dir: 's2c',
    state: 'play',
    name: 'map_chunk',
    len: 8193,
    truncated: true
  })
  assert.equal('b64' in records[0], false)
  assert.equal(records[1].truncated, undefined)
  assert.equal(Buffer.from(records[1].b64, 'base64').length, 8192)
  assert.equal(journal.stats().truncated, 1)
})

test('chat frames and secret-shaped frame names are never journaled', t => {
  const { dir, journal } = withJournal(t)
  const names = [
    'chat_message',
    'system_chat',
    'player_chat',
    'profileless_chat',
    'chat_command',
    'cookie_response',
    'some_token_frame',
    'password_change'
  ]
  for (const name of names) journal.frame({ dir: 's2c', state: 'play', name, buffer: Buffer.from(name) })
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: Buffer.from('keep') })
  journal.close()

  const records = readLines(path.join(dir, fs.readdirSync(dir)[0]))
  assert.deepEqual(records.map(record => record.name), ['map_chunk'])
  assert.equal(journal.stats().skipped, names.length)
})

test('rotation renames the current file to .1 and continues in a new file', t => {
  const { dir, journal } = withJournal(t, { maxBytes: 300 })
  for (let i = 0; i < 4; i++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${i}`, buffer: Buffer.alloc(100, i) })
  }
  journal.close()

  const files = fs.readdirSync(dir).sort()
  const stats = journal.stats()
  assert.equal(stats.rotations, 3)
  assert.equal(files.length, 4)
  assert.ok(files.some(file => file.endsWith('.ndjson.1')), 'the first rotation archives as .1')

  const names = files.flatMap(file => readLines(path.join(dir, file)).map(record => record.name))
  assert.deepEqual(names.sort(), ['frame_0', 'frame_1', 'frame_2', 'frame_3'])
  for (const file of files) {
    assert.ok(fs.statSync(path.join(dir, file)).size <= 300, `${file} stays under maxBytes`)
  }
})

test('lifecycle events are one line with fields, and secret-shaped fields are dropped', t => {
  const { dir, journal } = withJournal(t)
  journal.event('attach', {
    name: 'Bafbi',
    uuid: PLAYER,
    replayed: 7,
    access_token: 'MUST_NOT_LEAK',
    note: 'Authorization: Bearer eyAbcDefG1234567890'
  })
  journal.close()

  const records = readLines(path.join(dir, fs.readdirSync(dir)[0]))
  assert.equal(records.length, 1)
  assert.equal(records[0].t, NOW)
  assert.equal(records[0].event, 'attach')
  assert.equal(records[0].name, 'Bafbi')
  assert.equal(records[0].uuid, PLAYER)
  assert.equal(records[0].replayed, 7)
  assert.equal('access_token' in records[0], false)
  assert.equal(JSON.stringify(records[0]).includes('MUST_NOT_LEAK'), false)
  assert.equal(JSON.stringify(records[0]).includes('eyAbcDefG1234567890'), false)
  assert.equal(journal.stats().events, 1)
})

test('close flushes, is idempotent, and a closed journal ignores new frames', t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('one') })
  journal.close()
  journal.close()
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('two') })
  journal.event('shutdown', { signal: 'SIGTERM' })

  const records = readLines(path.join(dir, fs.readdirSync(dir)[0]))
  assert.equal(records.length, 1)
})

// ---------------------------------------------------------------------------
// The reader: one place knows the file names, their order, and the line format.
// ---------------------------------------------------------------------------

test('journal files sort by session, process, segment, then archive before live', () => {
  assert.deepEqual(journalFileOrder([
    'session-2026-11-09T01-01-01-000Z-100.ndjson',
    'session-2026-11-09T01-01-01-000Z-100-2.ndjson',
    'session-2026-11-09T01-01-01-000Z-100.ndjson.1',
    'session-2026-11-09T01-01-01-000Z-100-2.ndjson.1',
    'session-2026-11-09T01-01-01-000Z-100-10.ndjson',
    'session-2026-11-08T23-00-00-000Z-99.ndjson',
    'notes.txt'
  ]), [
    'session-2026-11-08T23-00-00-000Z-99.ndjson',
    'session-2026-11-09T01-01-01-000Z-100.ndjson.1',
    'session-2026-11-09T01-01-01-000Z-100.ndjson',
    'session-2026-11-09T01-01-01-000Z-100-2.ndjson.1',
    'session-2026-11-09T01-01-01-000Z-100-2.ndjson',
    'session-2026-11-09T01-01-01-000Z-100-10.ndjson'
  ])
})

async function collect (records) {
  const entries = []
  for await (const entry of records) entries.push(entry)
  return entries
}

test('a journal written by createJournal reads back record for record', async t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: Buffer.from('chunk') })
  journal.event('liveReady', { warm: true })
  journal.close()

  const entries = await collect(readJournal(dir))
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0].record, {
    t: NOW,
    dir: 's2c',
    state: 'play',
    name: 'map_chunk',
    len: 5,
    b64: Buffer.from('chunk').toString('base64')
  })
  assert.equal(entries[1].record.event, 'liveReady')
  assert.equal(entries[1].record.warm, true)
  assert.match(entries[0].file, /session-.+\.ndjson$/)
  assert.equal(entries[0].line, 1)
})

test('a malformed line fails with path and line number', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session-x.ndjson')
  fs.writeFileSync(file, '{"t":1,"event":"start"}\nnot json\n')

  await assert.rejects(collect(readNdjson(file)), (error) => {
    assert.equal(error.message.startsWith(file + ':2: '), true, error.message)
    assert.match(error.message, /JSON/)
    return true
  })
})

test('an unterminated last line is skipped, because the service may still be writing it', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session-x.ndjson')
  fs.writeFileSync(file, '{"t":1,"event":"start"}\n{"t":2,"eve')

  const entries = await collect(readNdjson(file))
  assert.deepEqual(entries.map(entry => entry.record), [{ t: 1, event: 'start' }])
})

test('a file that rotates away mid-read is skipped, not fatal', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Two sessions, so the listing holds two files. The second rotates away
  // between the listing and its open, exactly as it would during a live read.
  const first = createJournal({ dir, clock: () => NOW })
  first.frame({ dir: 's2c', state: 'play', name: 'one', buffer: Buffer.from('1') })
  first.close()
  const second = createJournal({ dir, clock: () => NOW + 1000 })
  second.frame({ dir: 's2c', state: 'play', name: 'two', buffer: Buffer.from('2') })
  second.close()
  const newer = journalFileOrder(fs.readdirSync(dir)).map(name => path.join(dir, name)).at(-1)

  const records = readJournal(dir)
  const names = []
  names.push((await records.next()).value.record.name)
  fs.rmSync(newer)
  for await (const entry of records) names.push(entry.record.name)

  assert.deepEqual(names, ['one'])
})

test('a file that is not a journal name is ignored, however session-shaped', () => {
  assert.deepEqual(journalFileOrder(['session-backup.ndjson', 'session-2026-11-09T01-01-01-000Z-100.ndjson']), [
    'session-2026-11-09T01-01-01-000Z-100.ndjson'
  ])
})

test('a rotated journal reads back in write order', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // A small rotation threshold forces several segments and an archive; the
  // reader has to put them back in the order the writer wrote them.
  let clock = NOW
  const journal = createJournal({ dir, maxBytes: 200, clock: () => clock })
  for (let index = 0; index < 6; index++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${index}`, buffer: Buffer.alloc(60, index) })
    clock += 100
  }
  journal.close()
  assert.ok(fs.readdirSync(dir).length > 1, 'the journal rotated')

  const entries = await collect(readJournal(dir))
  assert.deepEqual(entries.map(entry => entry.record.name), ['frame_0', 'frame_1', 'frame_2', 'frame_3', 'frame_4', 'frame_5'])
})

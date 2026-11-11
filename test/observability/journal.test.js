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
// Retention (#96): the directory has a budget, not just a rotation size. The
// live lane wrote 4.07 MB/min and rotate() kept every segment, so two days of
// play filled a 1 GiB custody volume and the front CrashLooped on ENOSPC.
// ---------------------------------------------------------------------------

// The live CrashLoop: the custody volume filled, and the first write after
// start was the token cache, so the pod log blamed the backend with ENOSPC at
// stage: backend_connect. The journal's own failure names itself and the path.
test('#96 a volume with no room for the budget turns the journal off and names the path', t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const volume = blocks => ({ ...fs, statfsSync: () => ({ bsize: 4096, blocks, bfree: blocks, bavail: blocks }) })

  // The directory holds at most the budget plus one rotating file, so the
  // volume has to hold both: 4 KiB + 2 KiB.
  const caps = { maxBytes: 2048, maxTotalBytes: 4096 }
  const short = createJournal({ dir, fs: volume(1), ...caps })
  assert.equal(short.enabled, false, 'a volume that cannot hold the budget and one segment is full')
  const stats = short.stats()
  assert.equal(stats.disabledReason, 'journal_volume_full')
  assert.equal(stats.dir, dir)
  assert.equal(stats.freeBytes, 4096)
  assert.equal(stats.requiredBytes, 6144)
  assert.deepEqual(fs.readdirSync(dir), [], 'a journal on a full volume opens no file')

  const roomy = createJournal({ dir, fs: volume(2), ...caps })
  roomy.close()
  assert.equal(roomy.enabled, true, 'a volume that holds both keeps the journal on')
  assert.equal(roomy.stats().disabledReason, null)
})

test('#96 a directory that cannot be created for lack of space reports journal_volume_full', t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const noSpace = {
    ...fs,
    mkdirSync: () => {
      const error = new Error('ENOSPC: no space left on device, mkdir ' + dir)
      error.code = 'ENOSPC'
      throw error
    }
  }
  const journal = createJournal({ dir, fs: noSpace })
  assert.equal(journal.enabled, false)
  assert.equal(journal.stats().disabledReason, 'journal_volume_full')
  assert.equal(journal.stats().dir, dir)
})

test('#96 a write that fills the volume stops the journal instead of counting every frame', t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let writes = 0
  const fills = {
    ...fs,
    writeSync: (fd, line) => {
      if (++writes > 1) {
        const error = new Error('ENOSPC: no space left on device, write')
        error.code = 'ENOSPC'
        throw error
      }
      return fs.writeSync(fd, line)
    }
  }
  const journal = createJournal({ dir, fs: fills })
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'one', buffer: Buffer.from('1') }), true)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'two', buffer: Buffer.from('2') }), false)
  const stats = journal.stats()
  assert.equal(stats.disabledReason, 'journal_volume_full')
  assert.equal(stats.errors, 1)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'three', buffer: Buffer.from('3') }), false)
  assert.equal(journal.stats().errors, 1, 'a stopped journal stops counting failures')
  journal.close()
})

test('#96 a session older than the age cap is pruned, and an age cap of 0 turns the rule off', t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const day = 24 * 60 * 60 * 1000
  const age = file => fs.utimesSync(file, new Date(NOW - 8 * day), new Date(NOW - 8 * day))
  const stale = createJournal({ dir, clock: () => NOW - 8 * day })
  stale.event('startLive', { session: 'stale' })
  stale.close()
  age(stale.stats().file)
  const fresh = createJournal({ dir, clock: () => NOW - day })
  fresh.event('startLive', { session: 'fresh' })
  fresh.close()

  // Off: the byte budget is the only rule, and both sessions fit.
  const off = createJournal({ dir, clock: () => NOW, maxAgeMs: 0 })
  off.close()
  assert.equal(off.stats().pruned, 0)
  assert.equal(fs.existsSync(stale.stats().file), true)

  // A week: the eight-day-old session goes and the one-day-old session stays.
  const on = createJournal({ dir, clock: () => NOW, maxAgeMs: 7 * day })
  on.close()
  assert.equal(on.stats().pruned, 1)
  assert.equal(fs.existsSync(stale.stats().file), false)
  assert.equal(fs.existsSync(fresh.stats().file), true)
})

test('#96 rotation prunes the oldest segments and keeps the newest records', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const budget = 250
  const journal = createJournal({ dir, maxBytes: 200, maxTotalBytes: budget, clock: () => NOW })
  for (let index = 0; index < 6; index++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${index}`, buffer: Buffer.alloc(60, index) })
  }
  const stats = journal.stats()
  journal.close()

  assert.ok(stats.rotations >= 2, 'the run rotated: ' + stats.rotations)
  assert.ok(stats.pruned >= 1, 'rotation pruned an old segment: ' + stats.pruned)
  const live = path.basename(stats.file)
  const sizes = fs.readdirSync(dir).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
  assert.ok(sizes.some(entry => entry.name === live), 'the live segment survives')
  assert.equal(journalFileOrder(sizes.map(entry => entry.name)).at(-1), live, 'the live segment is newest')
  const archives = sizes.filter(entry => entry.name !== live).reduce((sum, entry) => sum + entry.size, 0)
  assert.ok(archives <= budget, 'the archives fit the budget: ' + archives + ' <= ' + budget)
  assert.ok(sizes.find(entry => entry.name === live).size <= 200, 'the live segment fits its rotation size')

  const names = (await collect(readJournal(dir))).map(entry => entry.record.name)
  assert.equal(names.at(-1), 'frame_5', 'the newest record is kept')
  assert.equal(names.includes('frame_0'), false, 'the oldest segment is gone')
  assert.deepEqual(names, [...names].sort((left, right) =>
    Number(left.slice('frame_'.length)) - Number(right.slice('frame_'.length))))
})

test('#96 the segment being written is never pruned, whatever the budget', t => {
  const { dir, journal } = withJournal(t, { maxBytes: 10_000, maxTotalBytes: 50 })
  for (let index = 0; index < 4; index++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${index}`, buffer: Buffer.alloc(100, index) })
  }
  const stats = journal.stats()
  journal.close()

  assert.equal(stats.pruned, 0)
  assert.ok(fs.statSync(stats.file).size > 50, 'the live segment outgrew the budget and stayed')
  const records = readLines(stats.file)
  assert.deepEqual(records.map(record => record.name), ['frame_0', 'frame_1', 'frame_2', 'frame_3'])
})

test('#96 a directory over its total byte budget drops the oldest sessions at start', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Three sessions, oldest first, each a few hundred bytes.
  for (let session = 0; session < 3; session++) {
    const earlier = createJournal({ dir, clock: () => NOW + session * 1000 })
    earlier.event('startLive', { session, pad: 'x'.repeat(200) })
    earlier.close()
  }
  const sizes = journalFileOrder(fs.readdirSync(dir)).map(name => fs.statSync(path.join(dir, name)).size)
  assert.equal(sizes.length, 3)
  // Room for the two newest sessions and no more, so the oldest must go.
  const budget = sizes[1] + sizes[2] + 10

  const journal = createJournal({ dir, clock: () => NOW + 9000, maxTotalBytes: budget })
  journal.close()

  assert.equal(journal.stats().pruned, 1, 'the oldest session was pruned')
  const kept = (await collect(readJournal(dir))).map(entry => entry.record.session).filter(session => session !== undefined)
  assert.deepEqual(kept, [1, 2], 'the two newest sessions survive')
  const total = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0)
  assert.ok(total <= budget, 'the directory fits its budget: ' + total + ' <= ' + budget)
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

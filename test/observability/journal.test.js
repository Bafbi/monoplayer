// The packet journal (#96, #217): one shard per hour and frame kind, the name
// policy table, the manifest, the seal, retention, and the reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createJournal,
  describeShard,
  framePolicy,
  hourOf,
  journalFileOrder,
  readJournal,
  readManifests,
  readNdjson
} from '../../src/observability/journal.js'

const NOW = 1_700_000_000_000
const HOUR = hourOf(NOW)
const HOUR_LATER = hourOf(NOW + 60 * 60 * 1000)
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

const names = dir => fs.readdirSync(dir).sort()

async function collect (records) {
  const entries = []
  for await (const entry of records) entries.push(entry)
  return entries
}

// ---------------------------------------------------------------------------
// The name policy table (#217)
// ---------------------------------------------------------------------------

test('the policy answers full, length, or drop for one name', () => {
  assert.equal(framePolicy('player_info'), 'full')
  assert.equal(framePolicy('spawn_entity'), 'full')
  assert.equal(framePolicy('login'), 'full')
  assert.equal(framePolicy('map_chunk'), 'length')
  assert.equal(framePolicy('update_light'), 'length')
  assert.equal(framePolicy('entity_metadata'), 'drop')
  assert.equal(framePolicy('rel_entity_move'), 'drop')
  // The protocol's names are lower case, and a caller's casing is not a policy.
  assert.equal(framePolicy('Entity_Metadata'), 'drop')
  assert.equal(framePolicy('MAP_CHUNK'), 'length')
})

test('no directory means a no-op with no file', () => {
  const journal = createJournal({})
  assert.equal(journal.enabled, false)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'position', buffer: Buffer.from('x') }), false)
  journal.event('start', { name: 'Bafbi' })
  journal.close()
  journal.close()
  const stats = journal.stats()
  assert.equal(stats.enabled, false)
  assert.equal(stats.dropped, 0)
  assert.equal(stats.sealed, 0)
})

// ---------------------------------------------------------------------------
// What a shard holds
// ---------------------------------------------------------------------------

test('a kept frame round-trips: raw bytes as base64, in an hour shard, with epoch timestamps', async t => {
  const { dir, journal } = withJournal(t)
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f])

  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: payload }), true)
  assert.equal(journal.frame({ dir: 'c2s', state: 'play', name: 'client_information', buffer: Buffer.from('mine') }), true)
  journal.close()

  assert.deepEqual(names(dir), [
    `journal-${HOUR}-frames-${process.pid}.manifest.json`,
    `journal-${HOUR}-frames-${process.pid}.ndjson.gz`
  ])
  const records = (await collect(readJournal(dir))).map(entry => entry.record)

  assert.deepEqual(records[0], {
    t: NOW,
    dir: 's2c',
    state: 'play',
    name: 'login',
    len: 5,
    b64: payload.toString('base64')
  })
  assert.deepEqual(Buffer.from(records[0].b64, 'base64'), payload)
  assert.equal(records[1].dir, 'c2s')
  assert.equal(Buffer.from(records[1].b64, 'base64').toString(), 'mine')
})

test('a kept frame longer than 8192 bytes keeps its header and loses its body', async t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.alloc(8193, 0x41) })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.alloc(8192, 0x42) })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.deepEqual(records[0], {
    t: NOW,
    dir: 's2c',
    state: 'play',
    name: 'login',
    len: 8193,
    truncated: true
  })
  assert.equal('b64' in records[0], false)
  assert.equal(records[1].truncated, undefined)
  assert.equal(Buffer.from(records[1].b64, 'base64').length, 8192)
  assert.equal(journal.stats().truncated, 1)
})

test('chunks and light are length-only at any size, in their own shard', async t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: Buffer.alloc(64) })
  journal.frame({ dir: 's2c', state: 'play', name: 'update_light', buffer: Buffer.alloc(4096) })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.alloc(64) })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  const chunk = records.find(record => record.name === 'map_chunk')
  assert.equal(chunk.len, 64)
  assert.equal(chunk.lengthOnly, true)
  assert.equal('b64' in chunk, false, 'a chunk body is never journaled, however small')
  assert.equal(journal.stats().truncated, 0, 'length-only is not a truncation')

  const bulk = names(dir).filter(name => name.includes('-bulk-'))
  assert.equal(bulk.length, 2, 'the chunk shard is sealed with a manifest: ' + bulk.join(', '))
  const login = names(dir).filter(name => name.includes('-frames-'))
  assert.equal(login.length, 2, 'the login record is in the frames shard: ' + login.join(', '))
})

test('the entity stream is dropped, and a spawn beside it is kept', async t => {
  const { dir, journal } = withJournal(t)
  for (const name of ['entity_metadata', 'rel_entity_move', 'sync_entity_position', 'entity_teleport']) {
    assert.equal(journal.frame({ dir: 's2c', state: 'play', name, buffer: Buffer.from(name) }), false, name)
  }
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'spawn_entity', buffer: Buffer.from('spawn') }), true)
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.deepEqual(records.map(record => record.name), ['spawn_entity'])
  assert.equal(journal.stats().dropped, 4)
  assert.equal(journal.stats().frames, 1)
})

test('chat frames and secret-shaped frame names are never journaled', async t => {
  const { dir, journal } = withJournal(t)
  const skipped = [
    'chat_message',
    'system_chat',
    'player_chat',
    'profileless_chat',
    'chat_command',
    'cookie_response',
    'some_token_frame',
    'password_change'
  ]
  for (const name of skipped) journal.frame({ dir: 's2c', state: 'play', name, buffer: Buffer.from(name) })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('keep') })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.deepEqual(records.map(record => record.name), ['login'])
  assert.equal(journal.stats().skipped, skipped.length)
  assert.equal(journal.stats().dropped, 0, 'a skip is not a policy drop')
})

test('lifecycle events are one line with fields, and secret-shaped fields are dropped', async t => {
  const { dir, journal } = withJournal(t)
  journal.event('attach', {
    name: 'Bafbi',
    uuid: PLAYER,
    replayed: 7,
    access_token: 'MUST_NOT_LEAK',
    note: 'Authorization: Bearer eyAbcDefG1234567890'
  })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
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
  assert.ok(names(dir).some(name => name.includes('-events-')))
})

// ---------------------------------------------------------------------------
// Sharding by hour (#217)
// ---------------------------------------------------------------------------

test('the hour comes from the record, so two hours are two shards', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = NOW
  const journal = createJournal({ dir, clock: () => clock })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('first') })
  clock = NOW + 60 * 60 * 1000
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('second') })

  // The first hour sealed when the second hour's first record arrived, so a
  // reader can read it while the process runs.
  assert.deepEqual(names(dir), [
    `journal-${HOUR}-frames-${process.pid}.manifest.json`,
    `journal-${HOUR}-frames-${process.pid}.ndjson.gz`,
    `journal-${HOUR_LATER}-frames-${process.pid}.ndjson`
  ])
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.deepEqual(records.map(record => Buffer.from(record.b64, 'base64').toString()), ['first', 'second'])
  assert.deepEqual(records.map(record => hourOf(record.t)), [HOUR, HOUR_LATER])
  assert.equal(journal.stats().sealed, 2)
})

test('a shard seals when the next record would pass maxBytes, and the next one takes -2', async t => {
  const { dir, journal } = withJournal(t, { maxBytes: 300 })
  for (let index = 0; index < 4; index++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${index}`, buffer: Buffer.alloc(100, index) })
  }
  journal.close()

  const sealed = names(dir).filter(name => name.endsWith('.ndjson.gz'))
  assert.equal(sealed.length, 4, names(dir).join(', '))
  const manifestOf = name => path.join(dir, name.replace(/\.ndjson\.gz$/, '.manifest.json'))
  assert.ok(sealed.includes(`journal-${HOUR}-frames-${process.pid}.ndjson.gz`))
  assert.ok(sealed.includes(`journal-${HOUR}-frames-${process.pid}-2.ndjson.gz`))
  assert.equal(journal.stats().sealed, 4)
  for (const name of sealed) {
    const body = readLines(manifestOf(name))[0]
    assert.ok(body.bytes <= 300, `${name} stayed under maxBytes: ${body.bytes}`)
  }

  const frames = (await collect(readJournal(dir))).map(entry => entry.record.name)
  assert.deepEqual(frames, ['frame_0', 'frame_1', 'frame_2', 'frame_3'])
})

test('a seal writes gzip and a manifest, and removes the plain shard', async t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('one') })
  journal.frame({ dir: 'c2s', state: 'play', name: 'chat_ack', buffer: Buffer.from('two') })
  journal.event('attach', { name: 'Bafbi' })
  journal.close()

  const gz = path.join(dir, `journal-${HOUR}-frames-${process.pid}.ndjson.gz`)
  assert.equal(fs.existsSync(gz), true)
  assert.equal(fs.existsSync(gz.replace(/\.gz$/, '')), false, 'the plain shard went')
  const head = fs.readFileSync(gz).subarray(0, 2)
  assert.deepEqual([...head], [0x1f, 0x8b], 'the shard is gzip')

  const manifest = JSON.parse(fs.readFileSync(gz.replace(/\.ndjson\.gz$/, '.manifest.json'), 'utf8'))
  assert.equal(manifest.shard, path.basename(gz))
  assert.equal(manifest.kind, 'frames')
  assert.equal(manifest.hour, HOUR)
  assert.equal(manifest.from, NOW)
  assert.equal(manifest.to, NOW)
  assert.equal(manifest.lines, 2)
  assert.deepEqual(manifest.names, { chat_ack: 1, login: 1 })
  assert.ok(manifest.bytes > 0)
  assert.equal(manifest.gzBytes, fs.statSync(gz).size)
  // The bytes each name costs on disk: the number the 48-hour budget rests on.
  assert.deepEqual(Object.keys(manifest.bytesByName), ['chat_ack', 'login'])
  assert.ok(manifest.bytesByName.login > 0)
  assert.ok(manifest.bytesByName.login < manifest.bytes)

  const events = JSON.parse(fs.readFileSync(path.join(dir, `journal-${HOUR}-events-${process.pid}.manifest.json`), 'utf8'))
  assert.equal(events.lines, 1)
  assert.deepEqual(events.names, { 'event:attach': 1 })
})

test('close flushes, is idempotent, and a closed journal ignores new frames', async t => {
  const { dir, journal } = withJournal(t)
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('one') })
  journal.close()
  journal.close()
  assert.equal(journal.stats().file, null, 'nothing is being written after close')
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('two') })
  journal.event('shutdown', { signal: 'SIGTERM' })

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.equal(records.length, 1)
})

// ---------------------------------------------------------------------------
// Retention (#96): the directory has a budget, not just a seal. The live lane
// wrote 4.07 MB/min and kept every segment, so two days of play filled a 1 GiB
// custody volume and the front CrashLooped on ENOSPC.
// ---------------------------------------------------------------------------

// The live CrashLoop: the custody volume filled, and the first write after
// start was the token cache, so the pod log blamed the backend with ENOSPC at
// stage: backend_connect. The journal's own failure names itself and the path.
test('#96 a volume with no room for the budget turns the journal off and names the path', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const volume = blocks => ({ ...fs, statfsSync: () => ({ bsize: 4096, blocks, bfree: blocks, bavail: blocks }) })

  // The directory holds at most the budget plus one shard per kind, so the
  // volume has to hold 4 KiB + 3 x 2 KiB.
  const caps = { maxBytes: 2048, maxTotalBytes: 4096 }
  const short = createJournal({ dir, fs: volume(1), ...caps })
  assert.equal(short.enabled, false, 'a volume that cannot hold the budget and one shard per kind is full')
  const stats = short.stats()
  assert.equal(stats.disabledReason, 'journal_volume_full')
  assert.equal(stats.dir, dir)
  assert.equal(stats.freeBytes, 4096)
  assert.equal(stats.requiredBytes, 10240)
  assert.deepEqual(fs.readdirSync(dir), [], 'a journal on a full volume opens no file')

  const roomy = createJournal({ dir, fs: volume(3), ...caps })
  roomy.close()
  assert.equal(roomy.enabled, true, 'a volume that holds both keeps the journal on')
  assert.equal(roomy.stats().disabledReason, null)
})

test('#96 a directory that cannot be created for lack of space reports journal_volume_full', async t => {
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

test('#96 a write that fills the volume stops the journal, keeps the shard readable, and counts one failure', async t => {
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
  const journal = createJournal({ dir, fs: fills, clock: () => NOW })
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'one', buffer: Buffer.from('1') }), true)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'two', buffer: Buffer.from('2') }), false)
  const stats = journal.stats()
  assert.equal(stats.disabledReason, 'journal_volume_full')
  assert.equal(stats.errors, 1)
  assert.equal(journal.frame({ dir: 's2c', state: 'play', name: 'three', buffer: Buffer.from('3') }), false)
  assert.equal(journal.stats().errors, 1, 'a stopped journal stops counting failures')
  journal.close()

  // Sealing needs room the volume does not have, so the last shard stays plain,
  // and the reader reads it as it stands.
  const plain = path.join(dir, `journal-${HOUR}-frames-${process.pid}.ndjson`)
  assert.equal(fs.existsSync(plain), true)
  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.deepEqual(records.map(record => record.name), ['one'])
})

test('#96 a shard past the age cap is pruned with its manifest, and an age cap of 0 turns the rule off', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const day = 24 * 60 * 60 * 1000
  const age = file => fs.utimesSync(file, new Date(NOW - 8 * day), new Date(NOW - 8 * day))
  const stale = createJournal({ dir, clock: () => NOW - 8 * day })
  stale.event('startLive', { session: 'stale' })
  stale.close()
  for (const name of fs.readdirSync(dir)) age(path.join(dir, name))
  // The age rule is off here, so the fresh journal's own prune cannot delete the
  // stale shard before this case looks at it.
  const fresh = createJournal({ dir, clock: () => NOW - day, maxAgeMs: 0 })
  fresh.event('startLive', { session: 'fresh' })
  fresh.close()

  // Off: the byte budget is the only rule, and both shards fit.
  const off = createJournal({ dir, clock: () => NOW, maxAgeMs: 0 })
  off.close()
  assert.equal(off.stats().pruned, 0)
  assert.equal(fs.readdirSync(dir).length, 4, 'two shards, two manifests')

  // A week: the eight-day-old shard goes with its manifest, and the one-day-old
  // shard stays.
  const on = createJournal({ dir, clock: () => NOW, maxAgeMs: 7 * day })
  on.close()
  assert.equal(on.stats().pruned, 1)
  const left = fs.readdirSync(dir).filter(name => !name.endsWith('-2.ndjson'))
  const sessions = (await collect(readJournal(dir))).map(entry => entry.record.session)
  assert.deepEqual(sessions, ['fresh'])
  assert.equal(left.some(name => name.includes(`journal-${hourOf(NOW - 8 * day)}-`)), false,
    'the stale shard and its manifest are gone: ' + left.join(', '))
})

test('#96 the directory budget drops the oldest hours, and the live shard is never dropped', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Four hours, oldest first, each one a sealed shard with a manifest.
  for (let hour = 0; hour < 4; hour++) {
    const journal = createJournal({ dir, clock: () => NOW + hour * 60 * 60 * 1000 })
    journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.alloc(200, 0x41) })
    journal.close()
  }
  const shards = journalFileOrder(fs.readdirSync(dir))
  assert.equal(shards.length, 4)
  const sizes = shards.map(name => fs.statSync(path.join(dir, name)).size +
    fs.statSync(path.join(dir, name.replace(/\.ndjson\.gz$/, '.manifest.json'))).size)
  // Room for the two newest hours and no more, so the two oldest must go.
  const budget = sizes[2] + sizes[3]

  const journal = createJournal({ dir, clock: () => NOW + 5 * 60 * 60 * 1000, maxTotalBytes: budget })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.alloc(200, 0x42) })
  const stats = journal.stats()
  // Read before close: sealing the live shard adds its manifest, which the next
  // prune counts, so the directory a running journal holds is the one to check.
  const kept = journalFileOrder(fs.readdirSync(dir))
  journal.close()

  assert.equal(stats.pruned, 2, 'the two oldest hours were pruned')
  const hours = kept.map(name => name.slice('journal-'.length, 'journal-'.length + 13))
  assert.deepEqual(hours.slice(0, 2), [hourOf(NOW + 2 * 60 * 60 * 1000), hourOf(NOW + 3 * 60 * 60 * 1000)],
    'the two newest hours survive: ' + kept.join(', '))
  assert.equal(kept.at(-1), `journal-${hourOf(NOW + 5 * 60 * 60 * 1000)}-frames-${process.pid}.ndjson`,
    'the live shard survives: ' + kept.join(', '))
})

test('#96 the shard being written is never pruned, whatever the budget', async t => {
  const { dir, journal } = withJournal(t, { maxBytes: 10_000, maxTotalBytes: 50 })
  for (let index = 0; index < 4; index++) {
    journal.frame({ dir: 's2c', state: 'play', name: `frame_${index}`, buffer: Buffer.alloc(100, index) })
  }
  const stats = journal.stats()
  assert.equal(stats.pruned, 0)
  const live = path.join(dir, `journal-${HOUR}-frames-${process.pid}.ndjson`)
  assert.ok(fs.statSync(live).size > 50, 'the live shard outgrew the budget and stayed')
  journal.close()
})

// ---------------------------------------------------------------------------
// The reader: one place knows the file names, their order, and the line format.
// ---------------------------------------------------------------------------

test('shard names sort by hour, then sequence, then kind, and a sealed shard wins over its plain file', () => {
  const pid = 100
  assert.deepEqual(journalFileOrder([
    `journal-${HOUR}-events-${pid}.ndjson`,
    `journal-${HOUR}-frames-${pid}-2.ndjson.gz`,
    `journal-${HOUR}-frames-${pid}.ndjson`,
    `journal-${HOUR}-frames-${pid}.ndjson.gz`,
    `journal-${HOUR}-bulk-${pid}.ndjson.gz`,
    `journal-${HOUR_LATER}-frames-${pid}.ndjson`,
    `journal-${HOUR}-frames-${pid}.manifest.json`,
    'session-backup.ndjson',
    'notes.txt'
  ]), [
    `journal-${HOUR}-bulk-${pid}.ndjson.gz`,
    `journal-${HOUR}-events-${pid}.ndjson`,
    `journal-${HOUR}-frames-${pid}.ndjson.gz`,
    `journal-${HOUR}-frames-${pid}-2.ndjson.gz`,
    `journal-${HOUR_LATER}-frames-${pid}.ndjson`
  ])
})

test('a journal written by createJournal reads back record for record, across garbled kinds and hours', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = NOW
  const journal = createJournal({ dir, clock: () => clock })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('chunk') })
  clock += 1000
  journal.frame({ dir: 's2c', state: 'play', name: 'map_chunk', buffer: Buffer.from('terrain') })
  clock += 1000
  journal.event('liveReady', { warm: true })
  clock = NOW + 60 * 60 * 1000
  journal.frame({ dir: 's2c', state: 'play', name: 'player_info', buffer: Buffer.from('skin') })
  journal.close()

  const entries = await collect(readJournal(dir))
  // Shards come out hour by hour and, inside an hour, kind by kind: the reader
  // orders a reconstruction by `t`, and this is that order.
  entries.sort((left, right) => left.record.t - right.record.t)
  assert.deepEqual(entries.map(entry => entry.record.name ?? entry.record.event),
    ['login', 'map_chunk', 'liveReady', 'player_info'])
  assert.equal(entries[0].record.b64, Buffer.from('chunk').toString('base64'))
  assert.equal(entries[1].record.lengthOnly, true)
  assert.equal(entries[2].record.warm, true)
  assert.match(entries[3].file, /\.ndjson\.gz$/, 'the second hour read from its sealed shard')
  assert.equal(entries[0].line, 1)
})

test('readManifests answers for a sealed shard from the writer and for a live one by reading it', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let clock = NOW
  const journal = createJournal({ dir, clock: () => clock })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('one') })
  clock = NOW + 60 * 60 * 1000
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('two') })
  journal.event('attach', { name: 'Bafbi' })

  const manifests = await readManifests(dir)
  assert.equal(manifests.length, 3, manifests.map(entry => entry.shard).join(', '))
  assert.equal(manifests[0].live, undefined, 'the sealed shard carries the manifest the writer wrote')
  assert.equal(manifests[0].hour, HOUR)
  assert.deepEqual(manifests[0].names, { login: 1 })
  const live = manifests.filter(entry => entry.live === true)
  assert.deepEqual(live.map(entry => entry.kind).sort(), ['events', 'frames'])
  assert.deepEqual(live.find(entry => entry.kind === 'frames').names, { login: 1 })
  assert.deepEqual(live.find(entry => entry.kind === 'events').names, { 'event:attach': 1 })
  journal.close()

  const derived = await describeShard(path.join(dir, `journal-${HOUR}-frames-${process.pid}.ndjson.gz`))
  assert.equal(derived.kind, 'frames')
  assert.equal(derived.lines, 1)
  assert.equal(derived.from, NOW)
})

test('a malformed line fails with path and line number', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, `journal-${HOUR}-frames-1.ndjson`)
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
  const file = path.join(dir, `journal-${HOUR}-frames-1.ndjson`)
  fs.writeFileSync(file, '{"t":1,"event":"start"}\n{"t":2,"eve')

  const entries = await collect(readNdjson(file))
  assert.deepEqual(entries.map(entry => entry.record), [{ t: 1, event: 'start' }])
})

test('a shard that is sealed away mid-read is skipped, not fatal', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Two hours, so the listing holds two hours. The second hour's shard is
  // removed between the listing and its open, exactly as a seal would do it.
  const first = createJournal({ dir, clock: () => NOW })
  first.frame({ dir: 's2c', state: 'play', name: 'one', buffer: Buffer.from('1') })
  first.close()
  const second = createJournal({ dir, clock: () => NOW + 60 * 60 * 1000 })
  second.frame({ dir: 's2c', state: 'play', name: 'two', buffer: Buffer.from('2') })
  second.close()
  const newer = journalFileOrder(fs.readdirSync(dir)).at(-1)

  const records = readJournal(dir)
  const kept = []
  kept.push((await records.next()).value.record.name)
  fs.rmSync(path.join(dir, newer))
  for await (const entry of records) kept.push(entry.record.name)

  assert.deepEqual(kept, ['one'])
})

test('a file that is not a journal name is ignored, however shard-shaped', () => {
  assert.deepEqual(journalFileOrder(['session-backup.ndjson', `journal-${HOUR}-frames-1.ndjson`]), [
    `journal-${HOUR}-frames-1.ndjson`
  ])
})

// #416: the journal is the one artifact a diagnosis reads, so every record names
// the account that serves the lane, and a frame names the body it crossed. A key
// that names nothing is absent, never null (#263 D2).
test('#416 a journal names the account on every record and the body a frame crossed', async t => {
  const { dir, journal } = withJournal(t, { account: 'sky' })
  const x = Buffer.from('x').toString('base64')
  const y = Buffer.from('y').toString('base64')

  journal.frame({ dir: 's2c', state: 'play', name: 'login', body: 'paper_25565', buffer: Buffer.from('x') })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('y') })
  journal.event('liveReady', { warm: true })
  journal.event('channels', { open: 0, channels: [], body: null })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  const framed = records.find(record => record.b64 === x)
  const bare = records.find(record => record.b64 === y)
  const ready = records.find(record => record.event === 'liveReady')
  const channels = records.find(record => record.event === 'channels')

  assert.equal(framed.account, 'sky', 'a frame names the account the lane serves')
  assert.equal(framed.body, 'paper_25565', 'and the body it crossed')
  assert.equal(bare.account, 'sky')
  assert.equal('body' in bare, false, 'a frame that names no body has no body key')
  assert.equal(ready.account, 'sky', 'an event names the account too')
  assert.equal('body' in ready, false, 'and no body, because it names none')
  assert.equal('channel' in ready, false)
  assert.equal('body' in channels, false, 'a null body on an event is absent, not null')
})

test('#416 a journal with no account writes no account key', async t => {
  const { dir, journal } = withJournal(t)
  journal.event('liveReady', { warm: true })
  journal.close()

  const records = (await collect(readJournal(dir))).map(entry => entry.record)
  assert.equal('account' in records[0], false, 'a lane with no account names none')
})

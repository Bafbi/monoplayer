// tools/journal.mjs answers one journal question per command. The fixture is
// the journal's own writer, so the CLI and the product cannot drift on the
// record layout: a change to the writer shows up here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJournal } from '../../src/observability/journal.js'

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'journal.mjs')
const NOW = 1_700_000_000_000

function harness (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-journal-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    run: (...args) => spawnSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, MONOPLAYER_JOURNAL_DIR: '', MONOPLAYER_LOG: '' }
    }),
    runWith: (env, ...args) => spawnSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, MONOPLAYER_JOURNAL_DIR: '', MONOPLAYER_LOG: '', ...env }
    })
  }
}

// A journal with one frame per name, one second apart, written by the product.
// The writer seals on close, so a fixture is read back through its gzipped
// shards, which is what the reader does on the deployed lane.
function writeJournal (dir, frames, { start = NOW } = {}) {
  let clock = start
  const journal = createJournal({ dir, clock: () => clock })
  for (const [name, direction = 's2c'] of frames) {
    journal.frame({ dir: direction, state: 'play', name, buffer: Buffer.from(name) })
    clock += 1000
  }
  journal.close()
}

const records = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

test('tail prints the last records of the newest session, one JSON per line', t => {
  const h = harness(t)
  writeJournal(h.dir, [['one'], ['two'], ['three']])

  const result = h.run('tail', '2', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['two', 'three'])
  assert.deepEqual(records(result.stdout)[1], {
    t: NOW + 2000,
    dir: 's2c',
    state: 'play',
    name: 'three',
    len: 5,
    b64: Buffer.from('three').toString('base64')
  })
})

test('tail defaults to the last ten records', t => {
  const h = harness(t)
  writeJournal(h.dir, Array.from({ length: 12 }, (_, index) => ['frame_' + index]))

  const result = h.run('tail', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(records(result.stdout).length, 10)
})

test('tail reads one sealed shard given directly', t => {
  const h = harness(t)
  writeJournal(h.dir, [['one'], ['two']])
  const file = path.join(h.dir, fs.readdirSync(h.dir).find(name => name.endsWith('.ndjson.gz')))

  const result = h.run('tail', '1', '--path', file)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['two'])
})

test('tail reads a chunk as length only, from the bulk shard', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk'], ['login']])

  const result = h.run('tail', '5', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  const byName = Object.fromEntries(records(result.stdout).map(record => [record.name, record]))
  assert.equal(byName.map_chunk.lengthOnly, true)
  assert.equal('b64' in byName.map_chunk, false)
  assert.equal(Buffer.from(byName.login.b64, 'base64').toString(), 'login')
})

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('manifest answers one line per shard, with the frames each one holds', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk'], ['login'], ['login']])

  const result = h.run('manifest', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  const shards = records(result.stdout)
  assert.equal(shards.length, 2, result.stdout)
  const frames = shards.find(row => row.kind === 'frames')
  const bulk = shards.find(row => row.kind === 'bulk')
  assert.deepEqual(frames.names, { login: 2 })
  assert.equal(frames.lines, 2)
  assert.equal(frames.from, NOW + 1000)
  assert.equal(frames.to, NOW + 2000)
  assert.ok(frames.bytes > 0)
  assert.ok(frames.gzBytes > 0)
  assert.deepEqual(bulk.names, { map_chunk: 1 })
  assert.equal(bulk.live, undefined, 'a sealed shard carries the manifest the writer wrote')
})

test('manifest derives one for the shard still being written', t => {
  const h = harness(t)
  // The writer is left open, so nothing sealed and no manifest exists on disk.
  const journal = createJournal({ dir: h.dir, clock: () => NOW })
  journal.frame({ dir: 's2c', state: 'play', name: 'login', buffer: Buffer.from('login') })
  t.after(() => journal.close())

  const result = h.run('manifest', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  const [row] = records(result.stdout)
  assert.equal(row.kind, 'frames')
  assert.equal(row.live, true)
  assert.equal(row.lines, 1)
  assert.deepEqual(row.names, { login: 1 })
})

test('manifest takes no argument, and a bad invocation exits 2', t => {
  const h = harness(t)
  writeJournal(h.dir, [['one']])
  const result = h.run('manifest', 'extra', '--path', h.dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /takes no argument/)
})


test('tail filters by frame name, so the last frame of one name is one command', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk'], ['map_chunk'], ['keep_alive']])

  const result = h.run('tail', '1', '--name', 'map_chunk', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['map_chunk'])
  assert.equal(records(result.stdout)[0].t, NOW + 1000)
})

// ---------------------------------------------------------------------------
// invocation errors
// ---------------------------------------------------------------------------

test('a bare or unknown invocation exits 2 with the usage on stderr', (t) => {
  const h = harness(t)
  for (const args of [[], ['nope'], ['window'], ['tail', '--dir']]) {
    const result = h.run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /usage: node tools\/journal\.mjs/, args.join(' '))
  }
})

test('no path and no environment exits 1 with the variable to set', t => {
  const h = harness(t)
  const result = h.run('tail')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /MONOPLAYER_JOURNAL_DIR/)
})

test('a path that does not exist exits 1', t => {
  const h = harness(t)
  const result = h.run('tail', '--path', path.join(h.dir, 'missing'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot read/)
})

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

test('names aggregates frames by name, direction, and state', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk'], ['map_chunk'], ['position', 'c2s']])

  const result = h.run('names', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [
    { name: 'map_chunk', dir: 's2c', state: 'play', count: 2, bytes: 18, first: NOW, last: NOW + 1000 },
    { name: 'position', dir: 'c2s', state: 'play', count: 1, bytes: 8, first: NOW + 2000, last: NOW + 2000 }
  ])
})

test('names narrows to a substring pattern', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk'], ['update_light'], ['map']])

  const result = h.run('names', 'map', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['map', 'map_chunk'])
})

test('names prints nothing and exits 0 when nothing matches', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('names', 'no_such_frame', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('--dir and --state filter the frames, and an unknown direction is a usage error', t => {
  const h = harness(t)
  writeJournal(h.dir, [['position', 'c2s'], ['position', 's2c']])

  const c2s = h.run('names', '--dir', 'c2s', '--path', h.dir)
  assert.equal(c2s.status, 0, c2s.stderr)
  assert.deepEqual(records(c2s.stdout).map(record => record.dir), ['c2s'])

  const wrong = h.run('names', '--dir', 'client', '--path', h.dir)
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /--dir must be s2c or c2s/)
})

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

test('window counts the frames in the last N seconds of the journal', t => {
  const h = harness(t)
  writeJournal(h.dir, [['old'], ['edge'], ['middle'], ['recent'], ['newest']])

  // The newest frame is at NOW + 4000, so a three second window starts at
  // NOW + 1000 and holds edge, middle, recent, and newest.
  const result = h.run('window', '3', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [
    { name: 'edge', dir: 's2c', state: 'play', count: 1, bytes: 4, first: NOW + 1000, last: NOW + 1000 },
    { name: 'middle', dir: 's2c', state: 'play', count: 1, bytes: 6, first: NOW + 2000, last: NOW + 2000 },
    { name: 'newest', dir: 's2c', state: 'play', count: 1, bytes: 6, first: NOW + 4000, last: NOW + 4000 },
    { name: 'recent', dir: 's2c', state: 'play', count: 1, bytes: 6, first: NOW + 3000, last: NOW + 3000 }
  ])
})

test('window needs a positive number of seconds', t => {
  const h = harness(t)
  writeJournal(h.dir, [['one']])
  for (const seconds of [[], ['0'], ['-1'], ['soon']]) {
    const result = h.run('window', ...seconds, '--path', h.dir)
    assert.equal(result.status, 2, seconds.join(' '))
    assert.match(result.stderr, /seconds/, seconds.join(' '))
  }
})

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

// The service writes { t: ISO timestamp, event, ...fields } to MONOPLAYER_LOG.
// Nothing else in the tree writes those lines, so the fixture writes them here.
function writeLog (file, events) {
  fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

test('heartbeat prints the last heartbeat record from the log', t => {
  const h = harness(t)
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const last = { t: '2026-11-09T01:01:00.000Z', event: 'heartbeat', attached: true, warm: true, backendLogins: 1 }
  writeLog(file, [
    { t: '2026-11-09T01:00:00.000Z', event: 'start', name: 'Bafbi' },
    { t: '2026-11-09T01:00:30.000Z', event: 'heartbeat', attached: false, warm: true, backendLogins: 1 },
    last
  ])

  const result = h.run('heartbeat', '--path', file)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [last])
})

test('heartbeat falls back to MONOPLAYER_LOG', t => {
  const h = harness(t)
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const line = { t: '2026-11-09T01:00:30.000Z', event: 'heartbeat', warm: false }
  writeLog(file, [line])

  const result = h.runWith({ MONOPLAYER_LOG: file }, 'heartbeat')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [line])
})

test('heartbeat against a journal directory says which file to pass', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('heartbeat', '--path', h.dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no heartbeat record/)
  assert.match(result.stderr, /MONOPLAYER_LOG/)
})

test('a misspelled --state exits 2 instead of answering empty', t => {
  const h = harness(t)
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('names', '--state', 'playy', '--path', h.dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--state must be one of handshaking, status, login, configuration, play/)
})

test('a path that is not a directory or a regular file exits 1', t => {
  const h = harness(t)
  const result = h.run('tail', '--path', '/dev/null')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a journal directory or a regular file/)
})

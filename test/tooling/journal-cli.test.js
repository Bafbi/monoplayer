// tools/journal.mjs answers one journal question per command. The fixture is
// the journal's own writer, so the CLI and the product cannot drift on the
// record layout: a change to the writer shows up here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempRoot } from '../support/temp.js'

import { createJournal } from '../../src/observability/journal.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOL = path.join(ROOT, 'tools', 'journal.mjs')
const NOW = 1_700_000_000_000

function harness () {
  const dir = tempRoot('monoplayer-journal-cli-')
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

test('tail prints the last records of the newest session, one JSON per line', () => {
  const h = harness()
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

test('tail defaults to the last ten records', () => {
  const h = harness()
  writeJournal(h.dir, Array.from({ length: 12 }, (_, index) => ['frame_' + index]))

  const result = h.run('tail', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(records(result.stdout).length, 10)
})

test('tail reads one sealed shard given directly', () => {
  const h = harness()
  writeJournal(h.dir, [['one'], ['two']])
  const file = path.join(h.dir, fs.readdirSync(h.dir).find(name => name.endsWith('.ndjson.gz')))

  const result = h.run('tail', '1', '--path', file)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['two'])
})

test('tail reads a chunk as length only, from the bulk shard', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk'], ['login']])

  const result = h.run('tail', '5', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  const byName = Object.fromEntries(records(result.stdout).map(record => [record.name, record]))
  assert.equal(byName.map_chunk.lengthOnly, true)
  assert.equal('b64' in byName.map_chunk, false)
  assert.equal(Buffer.from(byName.login.b64, 'base64').toString(), 'login')
})

// ---------------------------------------------------------------------------
// --event
// ---------------------------------------------------------------------------

// A lifecycle event is a JSONL-log record: `configurationEnded` is written by the
// front leg, which journals no event of its own, so the log is where the answer
// to "why was this client ended" lives (docs/telemetry.md, "The picker end
// record"). This fixture is the three records a reader would otherwise grep out
// of a log.
function writeEvents (file) {
  const written = {
    ended: { t: '2026-11-09T01:00:00.000Z', event: 'configurationEnded', reason: 'picker_empty', username: null },
    failed: { t: '2026-11-09T01:00:00.100Z', event: 'configurationDisconnectFailed', reason: 'picker_empty', error: 'socket closed' },
    beat: { t: '2026-11-09T01:00:30.000Z', event: 'heartbeat', warm: true }
  }
  writeLog(file, Object.values(written))
  return written
}

test('tail narrows to one event name, and the records under another stay out', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const { ended } = writeEvents(file)

  const result = h.run('tail', '20', '--event', 'configurationEnded', '--path', file)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [ended])
})

test('--event composes with the count, so the last end is one command', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const earlier = { t: '2026-11-09T00:59:00.000Z', event: 'configurationEnded', reason: 'picker_unavailable', username: 'Bafbi' }
  const later = { t: '2026-11-09T00:59:30.000Z', event: 'configurationEnded', reason: 'claim_refused', username: 'Bafbi' }
  const between = { t: '2026-11-09T00:59:20.000Z', event: 'spectateLanded', username: 'Bafbi' }
  writeLog(file, [earlier, between, later])

  const result = h.run('tail', '1', '--event', 'configurationEnded', '--path', file)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [later])
})

// An empty answer is an answer, not a failure: stdout holds nothing and the exit
// is 0. What the source does hold goes to stderr, because "nothing wrote this
// name" and "this source never held an event" are different answers, and a
// filter that printed the same nothing for both would be the silent one.
test('an event name nothing wrote prints nothing on stdout, exits 0, and names the events the source holds', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  writeEvents(file)

  const result = h.run('tail', '20', '--event', 'no_such_event', '--path', file)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no record with event no_such_event/)
  assert.match(result.stderr, /the source holds configurationDisconnectFailed, configurationEnded, heartbeat/)
})

test('the miss line counts the names it leaves out, so a source with many events still reads', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const events = Array.from({ length: 15 }, (_, index) => ({
    t: '2026-11-09T01:00:00.000Z',
    event: 'event_' + String(index).padStart(2, '0')
  }))
  writeLog(file, events)

  const result = h.run('tail', '20', '--event', 'no_such_event', '--path', file)
  assert.equal(result.status, 0)
  assert.match(result.stderr, /event_00, event_01, .*event_11, and 3 more/)
})

// The trap this sentence exists for: the front leg writes `configurationEnded` to
// the JSONL log, and the journal directory is the default path, so the two
// sources answer the same question with the same nothing.
test('an event asked of a source that holds no event says which source would hold it', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk'], ['login']])

  const result = h.run('tail', '20', '--event', 'configurationEnded', '--path', h.dir)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /holds no event at all/)
  assert.match(result.stderr, /MONOPLAYER_LOG/)
})

test('an empty --event is a usage error, not a filter that matches nothing', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  writeEvents(file)

  const result = h.run('tail', '--event', '', '--path', file)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--event needs an event name/)
})

// A lifecycle record carries no name, direction, or state, so a frame filter
// beside --event selects from a set the event filter has already excluded. The
// command line cannot be right, and a silent empty answer would say it was.
test('--event beside a frame filter is a usage error, not an empty answer', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const { ended } = writeEvents(file)

  for (const [option, value] of [['name', 'configurationEnded'], ['dir', 's2c'], ['state', 'play']]) {
    const result = h.run('tail', '20', '--event', 'configurationEnded', '--' + option, value, '--path', file)
    assert.equal(result.status, 2, option)
    assert.match(result.stderr, /--event and --/, option)
  }

  // The refused combination is never the only way in: the same event is one
  // command without the frame filter.
  const frames = h.run('tail', '20', '--event', 'configurationEnded', '--path', file)
  assert.deepEqual(records(frames.stdout), [ended])
})

// tail is the command that prints records, so it is the one command an event
// filter can narrow. The others answer a question of their own, and a flag they
// silently drop would read as an answer they gave.
test('--event on a command that prints no record it could narrow is a usage error', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  writeEvents(file)

  for (const args of [['heartbeat'], ['names'], ['window', '60'], ['manifest']]) {
    const result = h.run(...args, '--event', 'configurationEnded', '--path', file)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /--event narrows tail/, args.join(' '))
  }
})

// The page prints seven commands, and every one of them is a command this tool
// answers. The fixture is one JSONL log because that is what the page's example
// paths name; a command that needs a journal directory widens this case.
test('every command docs/telemetry.md prints is one this tool answers', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  writeEvents(file)

  const page = fs.readFileSync(path.join(ROOT, 'docs', 'telemetry.md'), 'utf8')
  const at = page.indexOf('## One command per question')
  assert.notEqual(at, -1, 'docs/telemetry.md still has its command section')
  const block = page.slice(at).match(/```bash\n([\s\S]*?)```/)
  assert.notEqual(block, null, 'the section prints the journal commands in a bash block')
  const examples = block[1].split('\n').map(line => line.trim()).filter(line => line.startsWith('node tools/journal.mjs '))
  assert.ok(examples.length >= 6, 'the section prints the journal commands it answers')

  for (const line of examples) {
    const argv = line.split(/\s+/).slice(2)
    const pathAt = argv.indexOf('--path')
    assert.notEqual(pathAt, -1, line + ' names the log it reads')
    argv.splice(pathAt + 1, 1, file)
    const result = h.run(...argv)
    assert.equal(result.status, 0, line + ' -> ' + result.stderr)
  }
})

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('manifest answers one line per shard, with the frames each one holds', () => {
  const h = harness()
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
  const h = harness()
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

test('manifest takes no argument, and a bad invocation exits 2', () => {
  const h = harness()
  writeJournal(h.dir, [['one']])
  const result = h.run('manifest', 'extra', '--path', h.dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /takes no argument/)
})


test('tail filters by frame name, so the last frame of one name is one command', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk'], ['map_chunk'], ['keep_alive']])

  const result = h.run('tail', '1', '--name', 'map_chunk', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['map_chunk'])
  assert.equal(records(result.stdout)[0].t, NOW + 1000)
})

// ---------------------------------------------------------------------------
// invocation errors
// ---------------------------------------------------------------------------

test('a bare or unknown invocation exits 2 with the usage on stderr', () => {
  const h = harness()
  for (const args of [[], ['nope'], ['window'], ['tail', '--dir']]) {
    const result = h.run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /usage: node tools\/journal\.mjs/, args.join(' '))
  }
})

// The usage block is the tool's contract with a reader and the parser is what
// honours it, so the two lists are held equal in both directions: an option the
// parser takes and the block omits is a flag no reader can find, and one the
// block names and the parser refuses is a command line that fails. The custody
// CLI is read the same way (test/custody/cli.test.js).
test('the usage block names exactly the options the parser takes', async () => {
  const { OPTIONS, USAGE } = await import(pathToFileURL(TOOL).href)
  const documented = [...new Set([...USAGE.matchAll(/--([a-z]+)/g)].map(match => match[1]))].sort()

  assert.deepEqual(documented, [...OPTIONS].sort(),
    'the usage block names ' + documented.join(', ') + ', and the parser takes ' + OPTIONS.join(', ') +
      ': list a new option in USAGE, and add it to OPTIONS')

  // Every one of them takes a value, so a documented flag the parser did not
  // know would answer "unknown option" instead of asking for its value.
  const h = harness()
  for (const name of documented) {
    const result = h.run('tail', '--' + name)
    assert.equal(result.status, 2, name)
    assert.match(result.stderr, new RegExp('--' + name + ' needs a value'), name)
  }
})

test('no path and no environment exits 1 with the variable to set', () => {
  const h = harness()
  const result = h.run('tail')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /MONOPLAYER_JOURNAL_DIR/)
})

test('a path that does not exist exits 1', () => {
  const h = harness()
  const result = h.run('tail', '--path', path.join(h.dir, 'missing'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot read/)
})

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

test('names aggregates frames by name, direction, and state', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk'], ['map_chunk'], ['position', 'c2s']])

  const result = h.run('names', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [
    { name: 'map_chunk', dir: 's2c', state: 'play', count: 2, bytes: 18, first: NOW, last: NOW + 1000 },
    { name: 'position', dir: 'c2s', state: 'play', count: 1, bytes: 8, first: NOW + 2000, last: NOW + 2000 }
  ])
})

test('names narrows to a substring pattern', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk'], ['update_light'], ['map']])

  const result = h.run('names', 'map', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout).map(record => record.name), ['map', 'map_chunk'])
})

test('names prints nothing and exits 0 when nothing matches', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('names', 'no_such_frame', '--path', h.dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('--dir and --state filter the frames, and an unknown direction is a usage error', () => {
  const h = harness()
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

test('window counts the frames in the last N seconds of the journal', () => {
  const h = harness()
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

test('window needs a positive number of seconds', () => {
  const h = harness()
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

test('heartbeat prints the last heartbeat record from the log', () => {
  const h = harness()
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

test('heartbeat falls back to MONOPLAYER_LOG', () => {
  const h = harness()
  const file = path.join(h.dir, 'monoplayer.jsonl')
  const line = { t: '2026-11-09T01:00:30.000Z', event: 'heartbeat', warm: false }
  writeLog(file, [line])

  const result = h.runWith({ MONOPLAYER_LOG: file }, 'heartbeat')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(records(result.stdout), [line])
})

test('heartbeat against a journal directory says which file to pass', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('heartbeat', '--path', h.dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no heartbeat record/)
  assert.match(result.stderr, /MONOPLAYER_LOG/)
})

test('a misspelled --state exits 2 instead of answering empty', () => {
  const h = harness()
  writeJournal(h.dir, [['map_chunk']])

  const result = h.run('names', '--state', 'playy', '--path', h.dir)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--state must be one of handshaking, status, login, configuration, play/)
})

test('a path that is not a directory or a regular file exits 1', () => {
  const h = harness()
  const result = h.run('tail', '--path', '/dev/null')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a journal directory or a regular file/)
})

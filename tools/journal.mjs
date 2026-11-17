#!/usr/bin/env node
// One journal question per command.
//
//   node tools/journal.mjs tail [n]
//   node tools/journal.mjs heartbeat
//   node tools/journal.mjs names [pattern]
//   node tools/journal.mjs window <seconds>
//   node tools/journal.mjs manifest
//
// The layout, the file names, and the shard order come from
// src/observability/journal.js; this file only picks records and prints them.
// Every command accepts --path, --dir, and --state.
//
// Records stream, so a full journal never sits in memory. Output is one JSON
// record per line, so a session pipes it or reads it.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import { describeShard, readJournal, readManifests, readNdjson } from '../src/observability/journal.js'

// The protocol states a journal frame can carry. A typo in --state is a usage
// error, not an empty answer.
const STATES = ['handshaking', 'status', 'login', 'configuration', 'play']

const USAGE = `usage: node tools/journal.mjs <command> [options]

  tail [n]           the last n records (default 10)
  heartbeat          the last heartbeat record from the JSONL log
  names [pattern]    frames per name: count, bytes, first and last time
                     (pattern is a substring of the frame name)
  window <seconds>   the same, for the N seconds before the newest frame
  manifest           one line per shard: hour, time range, line count, byte
                     count, and the frames it holds. Read this first: it is
                     how a reader skips the shards that hold nothing it wants.

  --path <file|dir>  a journal directory, a journal file, or the JSONL log.
                     Default: MONOPLAYER_JOURNAL_DIR, or MONOPLAYER_LOG for
                     heartbeat.
  --name <pattern>   only frames whose name contains the pattern
  --dir <s2c|c2s>    only frames in that direction
  --state <state>    only frames in that protocol state
`

class UsageError extends Error {}

function usage (message) {
  throw new UsageError(message)
}

function parseArgs (argv) {
  const [command, ...rest] = argv
  if (!command) usage('no command given')
  const options = { path: null, dir: null, state: null, name: null }
  const positional = []

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--path' || arg === '--dir' || arg === '--state' || arg === '--name') {
      const value = rest[index + 1]
      if (value === undefined) usage(`${arg} needs a value`)
      options[arg.slice(2)] = value
      index++
    } else if (arg.startsWith('--')) {
      usage(`unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (options.dir !== null && options.dir !== 's2c' && options.dir !== 'c2s') {
    usage(`--dir must be s2c or c2s, not ${options.dir}`)
  }
  if (options.state !== null && !STATES.includes(options.state)) {
    usage(`--state must be one of ${STATES.join(', ')}, not ${options.state}`)
  }
  return { command, options, positional }
}

// heartbeat reads the JSONL log the service writes; every other command reads
// the journal. Both are NDJSON.
//
// A missing path is an environment failure, not a usage error: the command line
// was right and the variable is unset, so it exits 1 like an unreadable path.
function sourcePath (command, options) {
  if (options.path) return options.path
  const variable = command === 'heartbeat' ? 'MONOPLAYER_LOG' : 'MONOPLAYER_JOURNAL_DIR'
  const value = process.env[variable]
  if (!value) throw new Error(`no path: pass --path or set ${variable}`)
  return value
}

function statSource (source) {
  try {
    return fs.statSync(source)
  } catch (error) {
    throw new Error(`cannot read ${source}: ${error.message}`)
  }
}

// A directory reads as every journal shard in the writer's order; a file reads
// as itself, which is how the JSONL log or one shard is inspected.
async function * readPath (source) {
  const stat = statSource(source)
  if (stat.isDirectory()) {
    yield * readJournal(source)
    return
  }
  if (!stat.isFile()) {
    throw new Error(`${source} is not a journal directory or a regular file`)
  }
  yield * readNdjson(source)
}

function passesFilters (record, options) {
  if (options.name && !String(record.name).includes(options.name)) return false
  if (options.dir && record.dir !== options.dir) return false
  if (options.state && record.state !== options.state) return false
  return true
}

// A frame record carries a direction and a name; a lifecycle event or a log
// line does not, so no counter below can mistake one for a frame.
function isFrame (record) {
  return Boolean(record) && typeof record.dir === 'string' && typeof record.name === 'string'
}

// One row per name, direction, and state: how many frames, how many bytes, and
// the span they cover. Biggest count first, then by name, so the busiest frame
// is the first line.
async function summarize (records, options = {}) {
  const { since = null } = options
  const buckets = new Map()
  for await (const { record } of records) {
    if (!isFrame(record)) continue
    if (!passesFilters(record, options)) continue
    if (since !== null && record.t < since) continue
    const key = [record.name, record.dir, record.state].join('\u0000')
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { name: record.name, dir: record.dir, state: record.state, count: 0, bytes: 0, first: record.t, last: record.t }
      buckets.set(key, bucket)
    }
    bucket.count++
    bucket.bytes += Number(record.len) || 0
    bucket.first = Math.min(bucket.first, record.t)
    bucket.last = Math.max(bucket.last, record.t)
  }
  return [...buckets.values()].sort((left, right) =>
    right.count - left.count || left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir)
  )
}

// The newest frame in the source. A window is measured from it, not from the
// wall clock, so a window over a recorded journal answers the same later.
async function newestFrame (records) {
  let newest = null
  for await (const { record } of records) {
    if (!isFrame(record)) continue
    if (newest === null || record.t > newest) newest = record.t
  }
  return newest
}

function positiveInteger (value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) usage(`${label} must be a whole number above zero, not ${value}`)
  return number
}

export async function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const write = line => io.stdout.write(line + '\n')

  try {
    const { command, options, positional } = parseArgs(argv)

    if (command === 'tail') {
      if (positional.length > 1) usage('tail takes at most one count')
      const limit = positional.length === 1 ? positiveInteger(positional[0], 'the count') : 10
      const kept = []
      for await (const entry of readPath(sourcePath(command, options))) {
        if (!passesFilters(entry.record, options)) continue
        kept.push(entry.record)
        if (kept.length > limit) kept.shift()
      }
      for (const record of kept) write(JSON.stringify(record))
      return 0
    }

    if (command === 'heartbeat') {
      if (positional.length > 0) usage('heartbeat takes no argument')
      const source = sourcePath(command, options)
      let last = null
      for await (const entry of readPath(source)) {
        if (entry.record?.event === 'heartbeat') last = entry.record
      }
      if (!last) {
        throw new Error(`no heartbeat record in ${source}; the journal holds no heartbeat, the JSONL log does (MONOPLAYER_LOG)`)
      }
      write(JSON.stringify(last))
      return 0
    }

    if (command === 'names') {
      if (positional.length > 1) usage('names takes at most one pattern')
      const rows = await summarize(readPath(sourcePath(command, options)), {
        ...options,
        name: positional[0] ?? options.name
      })
      for (const row of rows) write(JSON.stringify(row))
      return 0
    }

    if (command === 'window') {
      if (positional.length !== 1) usage('window needs a number of seconds')
      const seconds = Number(positional[0])
      if (!Number.isFinite(seconds) || seconds <= 0) {
        usage(`window needs a positive number of seconds, not ${positional[0]}`)
      }
      const source = sourcePath(command, options)
      const newest = await newestFrame(readPath(source))
      if (newest === null) return 0
      // A second pass: the window needs the newest frame before it can decide
      // what falls inside, and the source is a single-pass stream.
      const rows = await summarize(readPath(source), { ...options, since: newest - seconds * 1000 })
      for (const row of rows) write(JSON.stringify(row))
      return 0
    }

    if (command === 'manifest') {
      if (positional.length > 0) usage('manifest takes no argument')
      const source = sourcePath(command, options)
      const stat = statSource(source)
      const rows = stat.isDirectory() ? await readManifests(source) : [await describeShard(source)]
      for (const row of rows) write(JSON.stringify(row))
      return 0
    }

    usage(`unknown command: ${command}`)
  } catch (error) {
    io.stderr.write(`journal: ${String(error?.message ?? error)}\n`)
    if (error instanceof UsageError) io.stderr.write(USAGE)
    return error instanceof UsageError ? 2 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A reader that closes the pipe first (head, grep -m1) is not an error.
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
  process.exitCode = await main()
}

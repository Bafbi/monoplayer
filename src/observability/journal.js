// Exact packet journal: one NDJSON line per frame and per lifecycle event.
//
// Enabled only when a directory is configured. With no directory the journal
// opens no file and every call is a no-op.
//
// File layout: <dir>/session-<ISO>-<pid>.ndjson, then session-<ISO>-<pid>-2.ndjson,
// -3, ... after each rotation. Rotation renames the current file to
// <same>.ndjson.1 (replacing the previous .1) once the next line would pass
// maxBytes. A frame carries the raw bytes base64-encoded unless the frame is
// longer than 8192 bytes, in which case only its length is journaled.
//
// Writes are synchronous on purpose: a frame record must be on disk, in order,
// before the next frame is written. Chat frames and secret-shaped frame names
// are never journaled. Lifecycle events drop secret-shaped fields and run
// strings through the same redaction as the JSONL log sink.

import nodeFs from 'node:fs'
import path from 'node:path'

import { redact } from './redact.js'

const MAX_FRAME_BYTES = 8192
const DEFAULT_MAX_BYTES = 268435456
const MAX_STRING = 1024

const SKIP_FRAMES = new Set([
  'chat_message',
  'system_chat',
  'player_chat',
  'profileless_chat',
  // Commands can carry private message text, so they are skipped too.
  'chat_command',
  'chat_command_signed',
  // A cookie response payload is a credential, and so is a stored cookie.
  'cookie_response',
  'store_cookie'
])
const SECRET_NAME = /token|secret|password/i
const SECRET_KEY = /(token|secret|password|authorization|cookie|credential|device_code|user_code)/i

const clip = value => {
  const text = String(value)
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text
}

function noopJournal () {
  return {
    enabled: false,
    frame: () => false,
    event () {},
    close () {},
    stats: () => ({ enabled: false, file: null, frames: 0, events: 0, bytes: 0, rotations: 0, skipped: 0, truncated: 0, errors: 0 })
  }
}

// redact() keeps a field label when it rewrites "Authorization: Bearer X" to
// "authorization=[REDACTED]", which can strand the token after the label. Mask
// bearer values first so the token itself never reaches the record.
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const cleanText = value => clip(redact(String(value).replace(BEARER, 'Bearer [REDACTED]')))

function normalize (value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'bigint') return String(value)
  if (depth >= 3) {
    try {
      return cleanText(JSON.stringify(value))
    } catch {
      return '[unserializable]'
    }
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || SECRET_KEY.test(key)) continue
      out[key] = normalize(item, depth + 1)
    }
    return out
  }
  return String(value)
}

function toBuffer (buffer) {
  if (buffer == null) return null
  if (Buffer.isBuffer(buffer)) return buffer
  if (buffer instanceof Uint8Array) return Buffer.from(buffer)
  if (typeof buffer === 'string') return Buffer.from(buffer)
  return Buffer.from(String(buffer))
}

export function createJournal ({
  dir = null,
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => Date.now(),
  fs = nodeFs
} = {}) {
  const enabled = typeof dir === 'string' && dir.trim() !== ''
  if (!enabled) return noopJournal()

  const limit = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : DEFAULT_MAX_BYTES
  const root = path.resolve(dir)
  const stats = {
    enabled: true,
    file: null,
    frames: 0,
    events: 0,
    bytes: 0,
    rotations: 0,
    skipped: 0,
    truncated: 0,
    errors: 0
  }

  let closed = false
  let fd = null
  let currentPath = null
  let base = null
  let sequence = 1
  let fileBytes = 0

  try {
    fs.mkdirSync(root, { recursive: true })
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-')
    base = `session-${stamp}-${process.pid}`
    currentPath = path.join(root, `${base}.ndjson`)
    fd = fs.openSync(currentPath, 'a')
    stats.file = currentPath
  } catch (error) {
    stats.errors++
    closed = true
  }

  function reopen () {
    try {
      fd = fs.openSync(currentPath, 'a')
    } catch (error) {
      stats.errors++
      closed = true
    }
  }

  function rotate () {
    try { fs.closeSync(fd) } catch { /* the descriptor may already be gone */ }
    try {
      const archive = currentPath + '.1'
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true })
      fs.renameSync(currentPath, archive)
      sequence++
      currentPath = path.join(root, `${base}-${sequence}.ndjson`)
      stats.file = currentPath
      fileBytes = 0
      stats.rotations++
      reopen()
    } catch (error) {
      stats.errors++
      reopen()
    }
  }

  function write (record) {
    if (closed || fd === null) return
    try {
      const line = JSON.stringify(record) + '\n'
      const size = Buffer.byteLength(line)
      if (fileBytes > 0 && fileBytes + size > limit) rotate()
      if (closed || fd === null) return
      fs.writeSync(fd, line)
      fileBytes += size
      stats.bytes += size
    } catch (error) {
      stats.errors++
    }
  }

  function skipName (name) {
    if (typeof name !== 'string') return false
    if (SKIP_FRAMES.has(name.toLowerCase())) return true
    return SECRET_NAME.test(name)
  }

  return {
    enabled: true,

    frame ({ dir: direction = 's2c', state = null, name = null, buffer = null } = {}) {
      if (closed) return false
      const label = typeof name === 'string' ? name : String(name ?? 'unknown')
      if (skipName(label)) {
        stats.skipped++
        return false
      }
      const payload = toBuffer(buffer)
      const len = payload ? payload.length : 0
      const record = { t: clock(), dir: direction, state, name: label, len }
      if (len > MAX_FRAME_BYTES) {
        record.truncated = true
        stats.truncated++
      } else {
        record.b64 = payload ? payload.toString('base64') : ''
      }
      write(record)
      stats.frames++
      return true
    },

    event (name, fields = {}) {
      if (closed) return
      const record = { t: clock(), event: String(name ?? 'event') }
      if (fields && typeof fields === 'object') {
        for (const [key, value] of Object.entries(fields)) {
          if (key === 't' || key === 'event') continue
          if (value === undefined || SECRET_KEY.test(key)) continue
          record[key] = normalize(value)
        }
      }
      write(record)
      stats.events++
    },

    close () {
      if (closed) return
      closed = true
      try { fs.closeSync(fd) } catch { /* already closed */ }
      fd = null
    },

    stats () {
      return { ...stats, file: currentPath }
    }
  }
}

// --- reader ---
//
// The tools and the tests read a journal through here, so the file names, the
// order of the files, and the line format are known in one place. A second
// reader could disagree with the writer above.
//
// Rotation order: <base>.ndjson, then <base>-2.ndjson, -3, ... A segment that
// rotated keeps its own archive at <same>.ndjson.1, holding that segment's
// records up to the rotation, so a segment's archive comes before the segment.

// The stamp is the writer's, at second and millisecond precision. Anything else
// in the directory, such as session-backup.ndjson, is not a journal file.
const FILE_NAME = /^session-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)(?:-(\d+))?\.ndjson(\.1)?$/

// Rotation order for a directory listing: session, then process, then segment,
// then archive before live. Names that are not journal files are ignored.
export function journalFileOrder (names) {
  const parsed = []
  for (const name of names) {
    const match = FILE_NAME.exec(name)
    if (!match) continue
    parsed.push({
      name,
      stamp: match[1],
      pid: Number(match[2] ?? 0),
      segment: Number(match[3] ?? 1),
      archive: match[4] ? 0 : 1
    })
  }
  // The stamp is ISO-8601, so plain string order is chronological order.
  parsed.sort((left, right) =>
    (left.stamp < right.stamp ? -1 : left.stamp > right.stamp ? 1 : 0) ||
    left.pid - right.pid ||
    left.segment - right.segment ||
    left.archive - right.archive
  )
  return parsed.map(entry => entry.name)
}

export function journalFiles (dir) {
  return journalFileOrder(nodeFs.readdirSync(dir)).map(name => path.join(dir, name))
}

// One NDJSON file, record by record, with the file and line each came from.
// The lines stream, so a full 256 MiB journal never sits in memory at once.
//
// A blank line is skipped. A terminated line that is not JSON fails with path
// and line, so a torn record is visible instead of counted. A last line with no
// newline is a record the service is still writing: it is skipped, because the
// next read sees the whole line. The writer terminates every record it writes.
export async function * readNdjson (file) {
  const stream = nodeFs.createReadStream(file, { encoding: 'utf8' })
  let carry = ''
  let number = 0
  for await (const chunk of stream) {
    carry += chunk
    const lines = carry.split('\n')
    // The last piece has no newline yet, so it stays in the carry.
    carry = lines.pop()
    for (const line of lines) {
      number++
      if (line.trim() === '') continue
      try {
        yield { record: JSON.parse(line), file, line: number }
      } catch (error) {
        throw new Error(`${file}:${number}: ${error.message}`)
      }
    }
  }
}

// Every journal file in the directory, in rotation order. A directory holds a
// bounded number of files, so the generator walks them one at a time.
export async function * readJournal (dir) {
  for (const file of journalFiles(dir)) {
    try {
      yield * readNdjson(file)
    } catch (error) {
      // A rotation renames a file out from under the listing. Its records are
      // already in the archive or the next segment; the next read sees them.
      if (error.code !== 'ENOENT') throw error
    }
  }
}

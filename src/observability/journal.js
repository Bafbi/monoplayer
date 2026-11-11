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
// Retention (#96): a rotation size deletes nothing, so the directory also has a
// byte budget (maxTotalBytes) and an age cap (maxAgeMs), both applied on open
// and after every rotation. The oldest files go first, in the reader's order,
// and the segment being written is never pruned: maxBytes bounds it, so the
// directory holds at most the budget plus one rotating file. A journal on a
// volume with no room for its budget opens nothing and records why in
// stats().disabledReason, with the path, so a full volume is the journal's own
// reported failure instead of an ENOSPC under another stage.
//
// Writes are synchronous on purpose: a frame record must be on disk, in order,
// before the next frame is written. Chat frames and secret-shaped frame names
// are never journaled. Lifecycle events drop secret-shaped fields and run
// strings through the same redaction as the JSONL log sink.

import nodeFs from 'node:fs'
import path from 'node:path'

import { redact } from './redact.js'

const MAX_FRAME_BYTES = 8192
export const DEFAULT_MAX_BYTES = 268435456
// #96: the directory as a whole has a budget, because a rotation size alone
// never deletes anything.
export const DEFAULT_MAX_TOTAL_BYTES = 268435456
// A week is longer than any diagnosis needs, and an old session is worthless.
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_STRING = 1024

// The stamp is the writer's, at second and millisecond precision. Anything else
// in the directory, such as session-backup.ndjson, is not a journal file: the
// reader ignores it and retention never deletes it.
const FILE_NAME = /^session-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)(?:-(\d+))?\.ndjson(\.1)?$/

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

// A journal that opened nothing. `reason` is why, so the service can name the
// real failure instead of letting the next write on the volume report ENOSPC
// under another stage (#96).
function disabledJournal ({ reason, dir = null, freeBytes = null, requiredBytes = null }) {
  return {
    enabled: false,
    frame: () => false,
    event () {},
    close () {},
    stats: () => ({
      enabled: false,
      disabledReason: reason,
      dir,
      freeBytes,
      requiredBytes,
      file: null,
      frames: 0,
      events: 0,
      bytes: 0,
      dirBytes: 0,
      pruned: 0,
      prunedBytes: 0,
      rotations: 0,
      skipped: 0,
      truncated: 0,
      errors: 0
    })
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

const positive = (value, fallback) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
const nonNegative = (value, fallback) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

export function createJournal ({
  dir = null,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  clock = () => Date.now(),
  fs = nodeFs
} = {}) {
  const configured = typeof dir === 'string' && dir.trim() !== ''
  if (!configured) return disabledJournal({ reason: 'no_dir' })

  const limit = positive(maxBytes, DEFAULT_MAX_BYTES)
  const totalLimit = positive(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES)
  // A zero age cap turns the age rule off; the byte budget still holds.
  const ageLimit = nonNegative(maxAgeMs, DEFAULT_MAX_AGE_MS)
  const root = path.resolve(dir)
  const stats = {
    enabled: true,
    disabledReason: null,
    dir: root,
    file: null,
    frames: 0,
    events: 0,
    bytes: 0,
    pruned: 0,
    prunedBytes: 0,
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

  // The journal's own files, with the size and the age retention reads. A name
  // that is not a journal name is left alone: retention deletes what the reader
  // reads, and nothing else.
  function journalEntries () {
    const entries = []
    for (const name of fs.readdirSync(root)) {
      if (!FILE_NAME.test(name)) continue
      const file = path.join(root, name)
      const stat = fs.statSync(file)
      entries.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs })
    }
    return entries
  }

  // #96: keep the directory inside its byte budget and its age cap, oldest
  // first. The segment being written is never pruned: maxBytes bounds it, and
  // deleting it would lose the newest records and confuse the reader.
  function prune () {
    try {
      const entries = journalEntries()
      const byName = new Map(entries.map(entry => [entry.name, entry]))
      let total = entries.reduce((sum, entry) => sum + entry.size, 0)
      const now = clock()
      for (const name of journalFileOrder(entries.map(entry => entry.name))) {
        const entry = byName.get(name)
        if (entry === undefined || entry.file === currentPath) continue
        const tooOld = ageLimit > 0 && now - entry.mtimeMs > ageLimit
        if (!tooOld && total <= totalLimit) break
        fs.rmSync(entry.file, { force: true })
        total -= entry.size
        stats.pruned++
        stats.prunedBytes += entry.size
      }
    } catch (error) {
      // A directory that cannot be listed or pruned is not a reason to stop
      // journaling; the write path reports its own failures.
      stats.errors++
    }
  }

  // Free bytes on the journal's own filesystem, or null where the platform
  // cannot report them.
  function freeBytes () {
    if (typeof fs.statfsSync !== 'function') return null
    try {
      const stat = fs.statfsSync(root)
      return Number(stat.bavail) * Number(stat.bsize)
    } catch {
      return null
    }
  }

  const outOfSpace = error => error?.code === 'ENOSPC' || error?.code === 'EDQUOT'

  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    return disabledJournal({ reason: outOfSpace(error) ? 'journal_volume_full' : 'journal_open_failed', dir: root })
  }

  // The directory holds at most the budget plus one rotating file, so that is
  // what the volume has to hold before the journal opens.
  const requiredBytes = totalLimit + limit
  const free = freeBytes()
  if (free !== null && free < requiredBytes) {
    return disabledJournal({ reason: 'journal_volume_full', dir: root, freeBytes: free, requiredBytes })
  }

  try {
    prune()
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-')
    base = `session-${stamp}-${process.pid}`
    currentPath = path.join(root, `${base}.ndjson`)
    fd = fs.openSync(currentPath, 'a')
    stats.file = currentPath
  } catch (error) {
    stats.errors++
    closed = true
    if (outOfSpace(error)) {
      return disabledJournal({ reason: 'journal_volume_full', dir: root, freeBytes: free, requiredBytes })
    }
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
      prune()
    } catch (error) {
      stats.errors++
      reopen()
    }
  }

  // Returns whether the record reached the file: the caller's counter and the
  // `frame()` answer both mean "journaled", not "attempted".
  function write (record) {
    if (closed || fd === null) return false
    try {
      const line = JSON.stringify(record) + '\n'
      const size = Buffer.byteLength(line)
      if (fileBytes > 0 && fileBytes + size > limit) rotate()
      if (closed || fd === null) return false
      fs.writeSync(fd, line)
      fileBytes += size
      stats.bytes += size
      return true
    } catch (error) {
      stats.errors++
      // A full volume stops the journal instead of failing on every frame. The
      // pod log and the heartbeat keep the write path for the rest of the
      // process, and `disabledReason` names what happened (#96).
      if (outOfSpace(error)) {
        stats.disabledReason = 'journal_volume_full'
        stats.enabled = false
        closed = true
        try { fs.closeSync(fd) } catch { /* already closed */ }
        fd = null
      }
      return false
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
      const wrote = write(record)
      if (wrote) stats.frames++
      return wrote
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
      if (write(record)) stats.events++
    },

    close () {
      if (closed) return
      closed = true
      try { fs.closeSync(fd) } catch { /* already closed */ }
      fd = null
    },

    stats () {
      // The directory's footprint, so an operator reading a heartbeat cannot
      // mistake this process's bytes written for what is on the volume (#96).
      let dirBytes = null
      try {
        dirBytes = journalEntries().reduce((sum, entry) => sum + entry.size, 0)
      } catch { /* an unreadable directory reports nothing */ }
      return { ...stats, file: currentPath, dirBytes }
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

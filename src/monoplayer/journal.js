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
  // A cookie response payload is a credential.
  'cookie_response'
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

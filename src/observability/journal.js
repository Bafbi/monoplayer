// Exact packet journal: one NDJSON record per frame and per lifecycle event, in
// shards a reader can skip by name (#217).
//
// Enabled only when a directory is configured. With no directory the journal
// opens no file and every call is a no-op.
//
// Layout. One shard per hour and frame kind:
//
//   journal-<YYYY-MM-DDTHH>-<kind>-<pid>[-<n>].ndjson          being written
//   journal-<YYYY-MM-DDTHH>-<kind>-<pid>[-<n>].ndjson.gz       sealed, gzipped
//   journal-<YYYY-MM-DDTHH>-<kind>-<pid>[-<n>].manifest.json   what the shard holds
//
// <kind> is `frames` (a body a diagnosis reads), `bulk` (length only) or
// `events` (lifecycle). The hour is UTC and comes from the record's own `t`, so
// a shard never holds two hours however long the process idles. `-n` appears
// only when one hour and kind needed more than one shard, which the size cap
// below can force.
//
// The name policy is a table, not a decision spread through the write path:
// see DROPPED_FRAMES and LENGTH_ONLY_FRAMES. Frame names in the drop list are
// never recorded, and frame names in the length-only list never carry a body at
// any size. Every other kept frame carries its bytes base64-encoded unless it is
// longer than 8192 bytes.
//
// A shard seals when its hour turns, when the next record would pass maxBytes,
// or when the journal closes. Sealing gzips the shard from its plain file to
// `<same>.ndjson.gz`, writes the manifest, and then removes the plain file, so a
// crash mid-seal leaves the plain shard readable. The manifest carries the time
// range, the line count, the name histogram, and the byte counts, because the
// reader's first move is to skip shards by name and by size rather than stream
// 200 MB of NDJSON.
//
// Retention (#96): the directory has a byte budget (maxTotalBytes) and an age
// cap (maxAgeMs), both applied on open, after every seal, and at close. The
// oldest shards go first, in the reader's order, and the shard being written is
// never pruned: maxBytes bounds it, so the directory holds at most the budget
// plus one sealing shard. A journal on a volume with no room for its budget
// opens nothing and records why in stats().disabledReason, with the path, so a
// full volume is the journal's own reported failure instead of an ENOSPC under
// another stage.
//
// The journal does not survive a restart. On the deployed lane it is an
// emptyDir with a sizeLimit, so "48 hours" means 48 hours or since the last
// restart, whichever is shorter.
//
// Writes are synchronous on purpose: a frame record must be on disk, in order,
// before the next frame is written. The council voted 3-2 against buffering, and
// buffer only when a measurement shows a socket stalled by the journal. Chat
// frames and secret-shaped frame names are never journaled. Lifecycle events
// drop secret-shaped fields and run strings through the same redaction as the
// JSONL log sink.

import nodeFs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { RECORD_IDENTITY_FIELDS, stampIdentity } from '../core/channels.js'
import { redact } from './redact.js'

// A frame longer than this keeps its header and loses its body.
const MAX_FRAME_BYTES = 8192
// The seal reads and compresses one chunk at a time, so a 128 MiB shard never
// sits in memory as one buffer.
const SEAL_CHUNK_BYTES = 8 * 1024 * 1024
// Level 1: the seal runs inside the frame that crosses the hour, so its cost is
// latency on the write path. Base64 bodies compress by their alphabet, so a
// higher level buys a few bytes for several times the milliseconds.
const SEAL_LEVEL = 1
const MAX_STRING = 1024

// One shard's seal threshold. A full hour of everything the policy keeps is
// about two megabytes, so this only bites when the kept frames carry large
// bodies. It stays, because an hour is a bound on time and not on size.
export const DEFAULT_MAX_BYTES = 67108864
// The directory as a whole has a budget, because a seal alone never deletes
// anything.
export const DEFAULT_MAX_TOTAL_BYTES = 268435456
// The horizon the budget buys once the entity stream is dropped (#217): 48
// hours, or since the last restart, whichever is shorter.
export const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000

// #217: the table the council voted for, as data. framePolicy() answers for one
// name and nothing else in this file decides what a frame costs.
//
// `drop` is the entity stream: the per-tick position and rotation deltas plus
// `entity_metadata`. At 441 frames a second that stream is 98% of the frames and
// roughly none of the answers, because nobody replays a 25-byte delta. The
// honest cost is that the journal no longer records the domain #213 changed:
// entity behaviour is observable through client parity and the attach record
// (#218), not here. `spawn_entity` and the destroy frames stay, because a
// diagnosis of "present in the tab list, absent from the world" reads them.
export const DROPPED_FRAMES = Object.freeze([
  'entity_head_rotation',
  'entity_look',
  'entity_metadata',
  'entity_move_look',
  'entity_teleport',
  'rel_entity_move',
  'sync_entity_position'
])

// Length only at any size, for the four frames that carry terrain: a chunk is
// about 100 KB and terrain is gigabytes a day. `len` is what a diagnosis reads
// from one. This supersedes the verdict's "spend the freed budget on full chunk
// bodies": at 48 hours that is unaffordable. The batch markers keep their bodies,
// because `chunk_batch_finished` says how many chunks the batch carried.
export const LENGTH_ONLY_FRAMES = Object.freeze([
  'chunk_biomes',
  'map_chunk',
  'unload_chunk',
  'update_light'
])

const DROPPED = new Set(DROPPED_FRAMES)
const LENGTH_ONLY = new Set(LENGTH_ONLY_FRAMES)
// A frame's policy decides its shard, so a reader that wants bodies reads one
// file and a reader that wants terrain sizes reads another.
const KIND_OF_POLICY = Object.freeze({ full: 'frames', length: 'bulk' })

export const KINDS = Object.freeze(['frames', 'bulk', 'events'])

export function framePolicy (name) {
  const label = String(name ?? '').toLowerCase()
  if (DROPPED.has(label)) return 'drop'
  if (LENGTH_ONLY.has(label)) return 'length'
  return 'full'
}

// The stamp is the writer's, to the hour. Anything else in the directory, such
// as a stray backup, is not a journal file: the reader ignores it and retention
// never deletes it.
const SHARD_NAME = /^journal-(\d{4}-\d{2}-\d{2}T\d{2})-([a-z]+)-(\d+)(?:-(\d+))?\.(ndjson\.gz|ndjson)$/
const MANIFEST_NAME = /^journal-(\d{4}-\d{2}-\d{2}T\d{2})-([a-z]+)-(\d+)(?:-(\d+))?\.manifest\.json$/

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

// UTC hour from a record's own timestamp: 2026-11-17T14.
export function hourOf (t) {
  return new Date(t).toISOString().slice(0, 13)
}

function shardBase (hour, kind, pid, sequence) {
  const suffix = sequence > 1 ? '-' + sequence : ''
  return `journal-${hour}-${kind}-${pid}${suffix}`
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
      sealed: 0,
      skipped: 0,
      dropped: 0,
      truncated: 0,
      errors: 0
    })
  }
}

const cleanText = value => clip(redact(String(value)))

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
  fs = nodeFs,
  // #416: the account the lane speaks for, written on every record here. One
  // value for the life of the process, so it is stamped where the record is
  // built rather than at each of the seven call sites. Null is a lane with no
  // account, which writes none rather than a null (#263 D2).
  account = null
} = {}) {
  const configured = typeof dir === 'string' && dir.trim() !== ''
  if (!configured) return disabledJournal({ reason: 'no_dir' })

  const limit = positive(maxBytes, DEFAULT_MAX_BYTES)
  const totalLimit = positive(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES)
  // A zero age cap turns the age rule off; the byte budget still holds.
  const ageLimit = nonNegative(maxAgeMs, DEFAULT_MAX_AGE_MS)
  const root = path.resolve(dir)
  const pid = process.pid
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
    sealed: 0,
    skipped: 0,
    dropped: 0,
    truncated: 0,
    errors: 0
  }

  let closed = false
  // kind -> the shard being written for it. At most three, one per kind.
  const live = new Map()

  function entries (pattern, { manifest = false } = {}) {
    const found = []
    for (const name of fs.readdirSync(root)) {
      const match = pattern.exec(name)
      if (match === null) continue
      const file = path.join(root, name)
      const stat = fs.statSync(file)
      found.push({
        name,
        file,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hour: match[1],
        kind: match[2],
        pid: Number(match[3] ?? 0),
        sequence: Number(match[4] ?? 1),
        manifest,
        sealed: !manifest && name.endsWith('.ndjson.gz'),
        base: name.replace(/(\.ndjson\.gz|\.ndjson|\.manifest\.json)$/, '')
      })
    }
    return found
  }

  const shardEntries = () => entries(SHARD_NAME)
  const manifestEntries = () => entries(MANIFEST_NAME, { manifest: true })

  // #96: keep the directory inside its byte budget and its age cap, oldest
  // first. The shard being written is never pruned: maxBytes bounds it, and
  // deleting it would lose the newest records and confuse the reader. A shard's
  // manifest goes with the shard.
  function prune () {
    try {
      const shards = shardEntries()
      const manifestByBase = new Map(manifestEntries().map(entry => [entry.base, entry]))
      const liveFiles = new Set([...live.values()].map(shard => shard.file))
      let total = shards.reduce((sum, entry) => sum + entry.size, 0) +
        [...manifestByBase.values()].reduce((sum, entry) => sum + entry.size, 0)
      const now = clock()
      for (const entry of orderEntries(shards)) {
        if (liveFiles.has(entry.file)) continue
        const tooOld = ageLimit > 0 && now - entry.mtimeMs > ageLimit
        if (!tooOld && total <= totalLimit) break
        fs.rmSync(entry.file, { force: true })
        total -= entry.size
        stats.pruned++
        stats.prunedBytes += entry.size
        const manifest = manifestByBase.get(entry.base)
        if (manifest !== undefined) {
          manifestByBase.delete(entry.base)
          fs.rmSync(manifest.file, { force: true })
          total -= manifest.size
          stats.prunedBytes += manifest.size
        }
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

  // A full volume stops the journal instead of failing on every frame. The pod
  // log and the heartbeat keep the write path for the rest of the process, and
  // `disabledReason` names what happened (#96). The shard already on disk stays
  // plain rather than sealed: sealing a shard on a full volume needs the room
  // the volume does not have, and the plain shard is readable as it stands.
  function stop (reason) {
    stats.disabledReason = reason
    stats.enabled = false
    closed = true
    for (const shard of live.values()) {
      try { fs.closeSync(shard.fd) } catch { /* already closed */ }
      shard.fd = null
    }
    live.clear()
    stats.file = null
  }

  function sequenceInUse (hour, kind, sequence) {
    const base = path.join(root, shardBase(hour, kind, pid, sequence))
    return fs.existsSync(base + '.ndjson') || fs.existsSync(base + '.ndjson.gz')
  }

  function openShard (kind, hour, now) {
    let sequence = 1
    while (sequenceInUse(hour, kind, sequence)) sequence++
    const file = path.join(root, shardBase(hour, kind, pid, sequence) + '.ndjson')
    const shard = {
      kind,
      hour,
      sequence,
      file,
      fd: fs.openSync(file, 'a'),
      bytes: 0,
      lines: 0,
      // name -> { lines, bytes }, where bytes is what the records cost on disk.
      names: new Map(),
      from: now,
      to: now
    }
    live.set(kind, shard)
    stats.file = file
    return shard
  }

  // gzip one shard in bounded chunks. Several members in one file is legal
  // gzip, and Node's gunzip reads every member.
  function compress (plain, output) {
    const input = fs.openSync(plain, 'r')
    try {
      const out = fs.openSync(output, 'w')
      try {
        const buffer = Buffer.alloc(SEAL_CHUNK_BYTES)
        for (;;) {
          const read = fs.readSync(input, buffer, 0, buffer.length, null)
          if (read === 0) break
          fs.writeSync(out, zlib.gzipSync(buffer.subarray(0, read), { level: SEAL_LEVEL }))
        }
      } finally {
        fs.closeSync(out)
      }
    } finally {
      fs.closeSync(input)
    }
  }

  function writeManifest (shard, gz) {
    const names = {}
    const bytesByName = {}
    // Busiest first, so a reader sees what the shard is mostly made of.
    for (const name of [...shard.names.keys()].sort((left, right) =>
      shard.names.get(right).lines - shard.names.get(left).lines || left.localeCompare(right))) {
      names[name] = shard.names.get(name).lines
      bytesByName[name] = shard.names.get(name).bytes
    }
    const manifest = {
      shard: path.basename(gz),
      kind: shard.kind,
      hour: shard.hour,
      from: shard.from,
      to: shard.to,
      lines: shard.lines,
      bytes: shard.bytes,
      gzBytes: fs.statSync(gz).size,
      names,
      // What each name costs on disk. This is the number the 48-hour budget
      // rests on: a kept frame averages under about 120 bytes of body to fit.
      bytesByName
    }
    const file = path.join(root, path.basename(gz).replace(/\.ndjson\.gz$/, '.manifest.json'))
    const temp = file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(manifest) + '\n')
    fs.renameSync(temp, file)
  }

  function sealShard (shard) {
    live.delete(shard.kind)
    try { fs.closeSync(shard.fd) } catch { /* already closed */ }
    shard.fd = null
    if (shard.lines === 0) {
      // Nothing was written: an empty shard would give a reader a name and no
      // records, so it goes.
      try { fs.rmSync(shard.file, { force: true }) } catch { /* best effort */ }
      return
    }
    try {
      const gz = shard.file + '.gz'
      const temp = gz + '.tmp'
      compress(shard.file, temp)
      fs.renameSync(temp, gz)
      // The plain shard goes only once the gzipped one has a name, so a crash
      // here leaves a readable shard rather than half of one.
      fs.rmSync(shard.file, { force: true })
      writeManifest(shard, gz)
      stats.sealed++
      prune()
    } catch (error) {
      stats.errors++
      // A seal that failed leaves the plain shard, which the reader reads.
    }
  }

  // One record. Returns whether it reached a file: the caller's counter and the
  // `frame()` answer both mean "journaled", not "attempted".
  function append (kind, record, name) {
    if (closed) return false
    // Nothing here may reach the product: a journal failure is this process's
    // own problem, and it reports through stats() (#96).
    try {
      return writeRecord(kind, record, name)
    } catch (error) {
      stats.errors++
      if (outOfSpace(error)) stop('journal_volume_full')
      return false
    }
  }

  function writeRecord (kind, record, name) {
    const line = JSON.stringify(record) + '\n'
    const size = Buffer.byteLength(line)
    const hour = hourOf(record.t)
    let shard = live.get(kind)
    if (shard !== undefined && shard.hour !== hour) {
      sealShard(shard)
      shard = undefined
    }
    if (shard !== undefined && shard.bytes > 0 && shard.bytes + size > limit) {
      sealShard(shard)
      shard = undefined
    }
    if (shard === undefined) shard = openShard(kind, hour, record.t)
    fs.writeSync(shard.fd, line)
    shard.bytes += size
    shard.lines++
    shard.from = Math.min(shard.from, record.t)
    shard.to = Math.max(shard.to, record.t)
    const counted = shard.names.get(name)
    if (counted === undefined) shard.names.set(name, { lines: 1, bytes: size })
    else {
      counted.lines++
      counted.bytes += size
    }
    stats.bytes += size
    return true
  }

  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    return disabledJournal({ reason: outOfSpace(error) ? 'journal_volume_full' : 'journal_open_failed', dir: root })
  }

  // The directory holds at most the budget plus one shard per kind, because
  // retention never prunes a shard that is being written. That is what the
  // volume has to hold before the journal opens.
  const requiredBytes = totalLimit + KINDS.length * limit
  const free = freeBytes()
  if (free !== null && free < requiredBytes) {
    return disabledJournal({ reason: 'journal_volume_full', dir: root, freeBytes: free, requiredBytes })
  }

  prune()

  function skipName (name) {
    if (typeof name !== 'string') return false
    if (SKIP_FRAMES.has(name.toLowerCase())) return true
    return SECRET_NAME.test(name)
  }

  return {
    enabled: true,

    frame ({ dir: direction = 's2c', state = null, name = null, buffer = null, body = null } = {}) {
      if (closed) return false
      const label = typeof name === 'string' ? name : String(name ?? 'unknown')
      if (skipName(label)) {
        stats.skipped++
        return false
      }
      const policy = framePolicy(label)
      if (policy === 'drop') {
        stats.dropped++
        return false
      }
      const payload = toBuffer(buffer)
      const len = payload ? payload.length : 0
      // #416: the account, and the body this frame crossed. A frame is one body's
      // stream, so it names the body and never a channel: the same frame reaches
      // every channel on that body (src/core/channels.js).
      const record = stampIdentity(
        { t: clock(), dir: direction, state, name: label, len },
        { account, body })
      if (policy === 'length') {
        // The policy never keeps this body, whatever its size.
        record.lengthOnly = true
      } else if (len > MAX_FRAME_BYTES) {
        record.truncated = true
        stats.truncated++
      } else {
        record.b64 = payload ? payload.toString('base64') : ''
      }
      const wrote = append(KIND_OF_POLICY[policy], record, label)
      if (wrote) stats.frames++
      return wrote
    },

    event (name, fields = {}) {
      if (closed) return
      const identity = {}
      const record = { t: clock(), event: String(name ?? 'event') }
      if (fields && typeof fields === 'object') {
        for (const [key, value] of Object.entries(fields)) {
          if (key === 't' || key === 'event') continue
          if (value === undefined || SECRET_KEY.test(key)) continue
          if (RECORD_IDENTITY_FIELDS.includes(key)) identity[key] = normalize(value)
          else record[key] = normalize(value)
        }
      }
      // #416: the identity a caller passes is the record's own, and the account is
      // the lane's. An identity key the event leaves null is absent, not written.
      const stamped = stampIdentity(record, { ...identity, account })
      if (append('events', stamped, 'event:' + stamped.event)) stats.events++
    },

    close () {
      if (closed) return
      closed = true
      for (const shard of [...live.values()]) sealShard(shard)
      live.clear()
      stats.file = null
    },

    stats () {
      // The directory's footprint, so an operator reading a heartbeat cannot
      // mistake this process's bytes written for what is on the volume (#96).
      let dirBytes = null
      try {
        dirBytes = [...shardEntries(), ...manifestEntries()].reduce((sum, entry) => sum + entry.size, 0)
      } catch { /* an unreadable directory reports nothing */ }
      return { ...stats, dirBytes }
    }
  }
}

// --- reader ---
//
// The tools and the tests read a journal through here, so the file names, the
// order of the files, and the line format are known in one place. A second
// reader could disagree with the writer above.
//
// Order: by hour, then by sequence within the hour, then by kind, then by
// process. A shard that exists both plain and gzipped counts once, sealed, and
// the sealed name wins: the seal writes the gzipped shard under its final name
// before it removes the plain one.

function parseShardName (name) {
  const match = SHARD_NAME.exec(name)
  if (match === null) return null
  return {
    name,
    hour: match[1],
    kind: match[2],
    pid: Number(match[3] ?? 0),
    sequence: Number(match[4] ?? 1),
    sealed: match[5] === 'ndjson.gz',
    base: name.replace(/(\.ndjson\.gz|\.ndjson)$/, '')
  }
}

function orderEntries (entries) {
  const byBase = new Map()
  for (const entry of entries) {
    const kept = byBase.get(entry.base)
    if (kept === undefined || (!kept.sealed && entry.sealed)) byBase.set(entry.base, entry)
  }
  const unique = [...byBase.values()]
  // The hour is zero-padded and fixed-width, so plain string order is
  // chronological order.
  unique.sort((left, right) =>
    (left.hour < right.hour ? -1 : left.hour > right.hour ? 1 : 0) ||
    left.sequence - right.sequence ||
    (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
    left.pid - right.pid
  )
  return unique
}

// Rotation order for a directory listing: the shards a reader reads, in the
// order the writer covered the hours. Names that are not journal files are
// ignored.
export function journalFileOrder (names) {
  return orderEntries(names.map(parseShardName).filter(entry => entry !== null)).map(entry => entry.name)
}

export function journalFiles (dir) {
  return journalFileOrder(nodeFs.readdirSync(dir)).map(name => path.join(dir, name))
}

// One NDJSON file, record by record, with the file and line each came from.
// The lines stream, so a full shard never sits in memory at once, and a sealed
// shard is decompressed as it streams.
//
// A blank line is skipped. A terminated line that is not JSON fails with path
// and line, so a torn record is visible instead of counted. A last line with no
// newline is a record the service is still writing: it is skipped, because the
// next read sees the whole line. The writer terminates every record it writes.
export async function * readNdjson (file) {
  const raw = nodeFs.createReadStream(file)
  let stream = raw
  if (file.endsWith('.gz')) {
    // A pipe does not forward the source's error to its destination, so a shard
    // that a seal renamed away fails here instead of crashing the process.
    const gunzip = zlib.createGunzip()
    raw.on('error', error => gunzip.destroy(error))
    stream = raw.pipe(gunzip)
  }
  stream.setEncoding('utf8')
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

// One shard, tolerant of the seal that renames it out from under a listing: its
// records are in the gzipped shard, and the next read sees them.
async function * readShard (file) {
  try {
    yield * readNdjson(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

// The shards of one hour, in the order the writer wrote them. One hour is
// several shards, one per kind, and a shard is ordered internally, so this walks
// the hour by `t`. Without it a reader would get every bulk record, then every
// event, then every frame, and `tail` would answer with the last records of the
// last kind instead of the last records of the hour.
async function * mergeByTime (files) {
  const heads = []
  for (const file of files) {
    const source = readShard(file)
    const next = await source.next()
    heads.push({ source, value: next.done === true ? null : next.value })
  }
  for (;;) {
    let best = -1
    for (let index = 0; index < heads.length; index++) {
      const value = heads[index].value
      if (value === null) continue
      if (best === -1 || value.record.t < heads[best].value.record.t) best = index
    }
    if (best === -1) return
    yield heads[best].value
    const next = await heads[best].source.next()
    heads[best].value = next.done === true ? null : next.value
  }
}

// The hour a shard file belongs to, from its name, or null for a name that is
// not a journal shard.
function hourOfFile (file) {
  const parsed = parseShardName(path.basename(file))
  return parsed === null ? null : parsed.hour
}

// Every journal record in the directory, in the order the writer wrote it: hour
// by hour, and inside an hour merged by `t` across the kind shards. A directory
// holds a bounded number of files, so the generator walks them one hour at a
// time. A record's own `t` remains the order a reconstruction sorts by, because
// a clock that steps backwards reorders the merge.
export async function * readJournal (dir) {
  const files = journalFiles(dir)
  let hour = null
  let group = []
  for (const file of files) {
    const at = hourOfFile(file)
    if (at !== hour && group.length > 0) {
      yield * mergeByTime(group)
      group = []
    }
    hour = at
    group.push(file)
  }
  if (group.length > 0) yield * mergeByTime(group)
}

// The manifest of one shard, derived from its records. A sealed shard carries a
// manifest the writer wrote; a shard still being written does not, so a reader
// that wants the newest hour asks for this instead. The shape matches the
// writer's, with `live` naming the difference.
export async function describeShard (file) {
  const manifest = {
    shard: path.basename(file),
    kind: null,
    hour: null,
    from: null,
    to: null,
    lines: 0,
    bytes: 0,
    gzBytes: null,
    names: {},
    live: true
  }
  const parsed = parseShardName(path.basename(file))
  if (parsed !== null) {
    manifest.kind = parsed.kind
    manifest.hour = parsed.hour
  }
  for await (const entry of readNdjson(file)) {
    const record = entry.record
    manifest.lines++
    const name = typeof record.event === 'string' ? 'event:' + record.event : String(record.name)
    manifest.names[name] = (manifest.names[name] ?? 0) + 1
    if (typeof record.t === 'number') {
      manifest.from = manifest.from === null ? record.t : Math.min(manifest.from, record.t)
      manifest.to = manifest.to === null ? record.t : Math.max(manifest.to, record.t)
    }
  }
  // A derived manifest has no `bytesByName`: that is what the records cost on
  // disk, and a shard's own size is the honest answer for it.
  try {
    const size = nodeFs.statSync(file).size
    if (file.endsWith('.gz')) manifest.gzBytes = size
    else manifest.bytes = size
  } catch { /* a shard that went away reports no size */ }
  return manifest
}

// The manifests in the directory, in journal order: the writer's for a sealed
// shard, a derived one for a shard still being written. The reader's first move
// is this, so it skips 95% of the shards by name, hour, size, and name
// histogram instead of streaming them.
export async function readManifests (dir) {
  const stored = new Map()
  for (const name of nodeFs.readdirSync(dir)) {
    if (!MANIFEST_NAME.test(name)) continue
    try {
      const manifest = JSON.parse(nodeFs.readFileSync(path.join(dir, name), 'utf8'))
      stored.set(name.replace(/\.manifest\.json$/, ''), manifest)
    } catch {
      // A torn manifest is not a shard: the derived one answers instead.
    }
  }
  const out = []
  for (const file of journalFiles(dir)) {
    const base = path.basename(file).replace(/(\.ndjson\.gz|\.ndjson)$/, '')
    const manifest = stored.get(base)
    if (manifest !== undefined) {
      out.push(manifest)
      continue
    }
    try {
      out.push(await describeShard(file))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return out
}

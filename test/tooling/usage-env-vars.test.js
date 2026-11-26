// #407: the --help text is a second list of the environment.
//
// `node src/service/monoplayer.js` with no arguments prints USAGE, and its
// "Config (JSON via --config, then env, then defaults)" block is the list a
// reader sees first: one line per switch. A hand-written list of a fact the code
// owns drifts, so the list gets a guard rather than a paragraph.
//
// Two directions, because the block claims to be the complete list:
//
//   * a line that names a variable nothing reads teaches a retired switch, and
//     loadConfig drops the unknown name in silence, so the reader sets nothing
//     and the lane does nothing;
//   * a variable the overlay reads with no line is a switch the help text keeps
//     secret, which is the same failure seen from the other side.
//
// The two directions need different authorities, and the difference is the point.
//
// A line may name a variable read anywhere under src/. That is wider than the
// overlay on purpose, and wider than #407's wording: MONOPLAYER_LOG is read raw
// in startLive today (#177 adopts it), and the block also names the OTEL_ family
// that src/observability reads. Both help lines are true, so a guard compared
// against envOverlay alone would demand a lie. The read set is #402's: a code
// line, a comment filtered out, and nothing else.
//
// A missing line is measured against envOverlay and only envOverlay. It is the
// function that owns the config surface, so a name it reads is a name this block
// owes a line. Counting a name read somewhere else would turn the block into a
// list of everything the repository reads, which is not what it claims to be.
//
// Nothing here reaches a cluster or a network: every case reads a file and calls
// one pure function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envOverlay } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The file whose string literal is the --help text, the file that owns the config
// surface, and the tree whose code is the read set.
const USAGE_FILE = 'src/service/monoplayer.js'
const OVERLAY_FILE = 'src/service/start-live.js'
const SRC_DIR = 'src'

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

// A comment that names a variable is not a read: the header of start-live.js is
// itself a list of the switches, and a list cannot be its own authority. Only
// whole-line comments are dropped, so a value or a pattern carrying a "#" is left
// alone. This is #402's filter, and the two guards share nothing else: that one
// walks the pages, this one walks the code.
const withoutComments = text => text.split('\n')
  .filter(line => !/^\s*(\/\/|#|\*|\/\*)/.test(line))
  .join('\n')

// A read of an environment object: `env.NAME`, `process.env.NAME`, or
// `env['NAME']`. This cannot follow a name through a variable, which is why
// envOverlay's own reads are recorded by calling it instead (below).
const ENV_READ = /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g

function envReads (text) {
  const found = []
  for (const match of withoutComments(text).matchAll(ENV_READ)) found.push(match[1] ?? match[2])
  return found
}

function sources (dir = SRC_DIR, found = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const file = dir + '/' + entry.name
    if (entry.isDirectory()) sources(file, found)
    else if (/\.(?:js|mjs)$/.test(entry.name)) found.push(file)
  }
  return found
}

// Every variable the code reads.
function sourceReads () {
  const found = new Set()
  for (const file of sources()) {
    for (const name of envReads(read(file))) found.add(name)
  }
  return found
}

// Every variable envOverlay reads, recorded by calling it with an environment that
// answers every question and remembers being asked. A text scan cannot see the
// journal's three names, which arrive as `env[variable]` from an array literal,
// and a text scan does see the warning strings that name a variable without
// reading it. The call sees the reads and nothing else, so #177 can move a raw read
// into the overlay without moving this guard. The same probe maps a switch to the
// key it sets in test/tooling/glossary-control-document.test.js.
//
// Its one blind spot is a read that only happens when another variable is set: a
// spread of the whole environment, or a branch the empty probe never enters. The
// case after next holds that shut by comparing the body's own text with what the
// call saw.
function overlayReads () {
  const found = new Set()
  const env = new Proxy({}, {
    get (target, key) {
      if (typeof key === 'string') found.add(key)
      return undefined
    }
  })
  envOverlay({}, env)
  return found
}

// The body of envOverlay, for the reads a probe with an empty environment cannot
// reach.
function overlayBody () {
  const source = read(OVERLAY_FILE)
  const at = source.indexOf('export function envOverlay')
  assert.notEqual(at, -1, OVERLAY_FILE + ' has no envOverlay to read, so the guard reads nothing')
  const end = source.indexOf('\n}\n', at)
  assert.notEqual(end, -1, 'the envOverlay function has no closing brace at the left margin')
  return source.slice(at, end)
}

// The line of src/service/start-live.js that reads a name, for the message that
// sends a reader to the code. It is only a signpost, so the text scan the overlay
// itself is right to distrust is good enough here.
function overlayReadLine (name) {
  const lines = withoutComments(read(OVERLAY_FILE)).split('\n')
  const index = lines.findIndex(line => envReads(line).includes(name))
  return index === -1 ? OVERLAY_FILE : OVERLAY_FILE + ':' + (index + 1)
}

// The --help text, as the lines of its template literal and the file line the
// literal starts on. The block is one string a reader sees, so the parse is of that
// string: the marker must be found, or every case below would pass over nothing.
const MARKER = 'export const USAGE = ' + '`'

function literal (source) {
  const at = source.indexOf(MARKER)
  assert.notEqual(at, -1, USAGE_FILE + ' has no ' + MARKER + ' marker, so the guard reads nothing')
  const open = at + MARKER.length
  const close = source.indexOf('`', open)
  assert.notEqual(close, -1, 'the USAGE literal is not closed with a backtick')
  // A literal cut short here would parse as a shorter block that happens to pass,
  // so the character after the close has to end the statement.
  assert.match(source.slice(close + 1, close + 2), /[\n,]/,
    'the first backtick after the marker is not the end of the USAGE literal')
  return { lines: source.slice(open, close).split('\n'), first: source.slice(0, open).split('\n').length }
}

// One entry of the block: two spaces, the names column, two or more spaces, the
// description. A continuation line of a long description is indented past the
// column and carries no name, so it cannot match, which is what keeps a variable
// named in prose from counting as a listed switch.
const ENTRY = /^ {2}(\S.*?) {2,}\S/

// A token in the names column is a name when it is an identifier. The Usage lines
// above the block hold a command there, with spaces in it, so they are not names;
// MONOPLAYER_LEASE_* is a family, and no single variable can be compared with it.
const NAME = /^[A-Z][A-Z0-9_]*$/

// The names the block lists, and the file line each sits on.
function listing (lines, first) {
  const found = new Map()
  lines.forEach((line, index) => {
    const entry = ENTRY.exec(line)
    if (!entry) return
    for (const token of entry[1].split(/\s*\/\s*/)) {
      if (!NAME.test(token)) continue
      if (!found.has(token)) found.set(token, first + index)
    }
  })
  return found
}

// A listed name that nothing reads. The message is the product of this guard: a
// file, a line, a variable, and the change that fixes it.
function unread (listed, reads) {
  const found = []
  for (const [name, line] of listed) {
    if (reads.has(name)) continue
    found.push(USAGE_FILE + ':' + line + ' lists ' + name + ', and no code under ' + SRC_DIR +
      '/ reads it. loadConfig drops a name nothing reads in silence, so the line teaches a switch ' +
      'the lane ignores. Delete the line, or read the name where it belongs (' + OVERLAY_FILE + ').')
  }
  return found
}

// The Config block itself, without the usage lines above it or the prose below: the
// header, the entries, and the continuation lines that finish a long description.
// The message names this range, because "the help text is missing a line" is not an
// instruction a reader can act on.
function configRange (lines, first) {
  const header = lines.findIndex(line => /^Config \(/.test(line))
  if (header === -1) return null
  let last = header
  for (let index = header + 1; index < lines.length; index++) {
    if (ENTRY.test(lines[index]) || /^ {2,}\S/.test(lines[index])) last = index
    else break
  }
  return USAGE_FILE + ':' + (first + header) + '-' + (first + last)
}

// A variable the overlay reads with no line in the block. The reader who needs it
// is reading this block, and the block does not name it.
function unlisted (listed, overlay, range) {
  const found = []
  for (const name of overlay) {
    if (listed.has(name)) continue
    found.push(name + ' is read at ' + overlayReadLine(name) + ', and the Config block in ' +
      range + ' does not list it. Add a line for it to the block, or stop reading it in envOverlay.')
  }
  return found
}

const HELP = literal(read(USAGE_FILE))
const LISTED = listing(HELP.lines, HELP.first)
const SOURCE = sourceReads()
const OVERLAY = overlayReads()
const RANGE = configRange(HELP.lines, HELP.first)

test('the guard found the help text and the reads it compares', () => {
  // A parse that finds nothing passes every case below. The floor is the number of
  // switches the overlay reads, which is a fact of the tree rather than a count to
  // edit. The names after it are the shapes the guard has to survive: two variables
  // sharing a line, one whose entry wraps onto continuation lines, one whose read is
  // a journal name the overlay reaches through a variable, and one read outside the
  // service directory.
  assert.ok(LISTED.size >= OVERLAY.size,
    'the parse found ' + LISTED.size + ' names and the overlay reads ' + OVERLAY.size +
    ', so the block is not the complete list it claims to be')
  assert.ok(LISTED.has('MONOPLAYER_FRONT_HOST') && LISTED.has('MONOPLAYER_FRONT_PORT'),
    'the parse reads both names of a line that shares one description')
  assert.ok(LISTED.has('MONOPLAYER_JOURNAL_MAX_AGE_MS'),
    'the parse reads a name whose entry wraps onto continuation lines')
  assert.ok(LISTED.has('OTEL_SERVICE_NAME'),
    'the parse reads the shared line of the OTEL family beside the MONOPLAYER switches')
  assert.ok(OVERLAY.has('MONOPLAYER_JOURNAL_MAX_AGE_MS'),
    'the overlay reads its journal names through env[variable], so a text scan of it would miss ' +
    'MONOPLAYER_JOURNAL_MAX_AGE_MS, and calling it is the only authority for them')
  assert.ok(SOURCE.has('MONOPLAYER_LOG'),
    'MONOPLAYER_LOG is read raw in startLive (#177), so a guard that swept the overlay alone ' +
    'would fail the help line that documents it')
  assert.ok(SOURCE.has('MONOPLAYER_OTEL_ENDPOINT'),
    'MONOPLAYER_OTEL_ENDPOINT is read in src/observability, so the walk crosses directories')
  assert.match(RANGE ?? '', /^src\/service\/monoplayer\.js:\d+-\d+$/,
    'the Config block is found, so the message can name where a missing line goes: ' + RANGE)
})

test('every read in envOverlay is a read the probe saw', () => {
  // The probe answers undefined to every key, so a read the function performs only
  // when another variable is set never happens in it. The body's text sees that
  // read, and the two sets have to agree: a name only the text sees is a name this
  // guard would otherwise pass over.
  const missed = envReads(overlayBody()).filter(name => !OVERLAY.has(name))
  assert.deepEqual(missed, [],
    'envOverlay reads these names only on a branch the probe does not take, so the ' +
    'completeness case below cannot see them:\n  ' + missed.join('\n  '))
})

test('no --help line names a variable the code does not read', () => {
  const offenders = unread(LISTED, new Set([...SOURCE, ...OVERLAY]))
  assert.deepEqual(offenders, [],
    'the --help text names a variable nothing under src/ reads:\n  ' + offenders.join('\n  '))
})

test('every variable envOverlay reads has a --help line', () => {
  const offenders = unlisted(LISTED, OVERLAY, RANGE)
  assert.deepEqual(offenders, [],
    'the --help text omits a variable envOverlay reads:\n  ' + offenders.join('\n  '))
})

test('the message names the help line, the variable, and the change', () => {
  const lines = ['Config:', '  MONOPLAYER_RETIRED_SWITCH              nothing reads this']
  const [message] = unread(listing(lines, 100), new Set())
  assert.match(message, /^src\/service\/monoplayer\.js:101 lists MONOPLAYER_RETIRED_SWITCH/,
    'the message names the file and the line of the offending entry: ' + message)
  assert.match(message, /Delete the line/, 'and the change that fixes it: ' + message)
  assert.match(message, /start-live\.js/, 'and where the name would have to be read: ' + message)
})

test('the message names the read, the variable, and the block to add a line to', () => {
  const [message] = unlisted(new Map(), new Set(['MONOPLAYER_PICKER']), RANGE)
  assert.match(message, /^MONOPLAYER_PICKER is read at src\/service\/start-live\.js:\d+/,
    'the message names the variable and the line that reads it: ' + message)
  assert.match(message, new RegExp('Config block in ' + RANGE.replace(/[/.]/g, '\\$&')),
    'and the block that owes it a line: ' + message)
})

test('a description that names a variable is not a listed switch', () => {
  const lines = [
    '  MONOPLAYER_ONE                         the switch that replaced MONOPLAYER_TWO',
    '                                         and MONOPLAYER_THREE as well'
  ]
  assert.deepEqual([...listing(lines, 1).keys()], ['MONOPLAYER_ONE'],
    'the names column is the list; a name in a description or on a continuation line is prose')
})

test('a glob names a family, so the guard does not read it as a variable', () => {
  assert.deepEqual(unread(listing(['  MONOPLAYER_LEASE_*                     every lease variable'], 1), new Set()),
    [], 'MONOPLAYER_LEASE_* names a family at once, and no line owes a read for a family')
})

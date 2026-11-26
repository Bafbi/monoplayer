// #406: the service reads the environment in envOverlay, and in the readers this
// file names.
//
// AGENTS.md said the config surface is one function and nothing else read the
// environment. The reads below disprove it, and the ticket behind them has the
// count. startLive reads the JSONL sink and the dump paths straight off
// process.env, reads the backend host before any document exists, and hands the
// whole environment to telemetry; telemetry reads its own endpoint and the alias
// startLive stamps into it. #406 settled that they stay outside. A dump path names
// a file the process writes, a collector is a subsystem's own business, and
// telemetry's whole interface is the env object it is handed, so moving these into
// the document would either add a key whose only validation is 'is a string' or
// split a subsystem's environment between two homes.
//
// A decision that lives in one sentence drifts, and this one governs where a
// reader of the service looks. So the list lives here too:
//
//   * a read that no row declares is drift, and the guard fails on the file, the
//     line, and the variable that caused it;
//   * a hand-off of the whole environment is counted as well as named, because its
//     variable is the one thing the scan cannot see: a second subsystem handed every
//     name at once is a new exception, and nothing else would notice it;
//   * a row the code no longer reads is a retired exception, and the guard fails
//     on the row, so #177 moving a name into the overlay has to delete its row in
//     the same change;
// A row may name a variable envOverlay reads as well. MONOPLAYER_BACKEND_HOST is
// one: the overlay maps it to config.backend.host, and startLive reads it before
// any document exists, so it can refuse a purely default --start. The row says
// which read it declares.
//
// The read set is the service and the observability it owns: the two directories
// AGENTS.md's sentence is about. A rung, the driver, the testbed and the custody
// CLI are tools a human runs, not the service, and #406 says a rung reading its
// own is fine and is not what the sentence claimed. Widening this walk to src/
// would put six names in two homes for the right reason (a rung dials the host
// the overlay configures in another process), give the frozen src/spike/ tree a
// rule it may not edit its way out of, and make the table a list of every
// variable in the repository: the drift this guards against, not the fix for it.
//
// Nothing here reaches a cluster or a network: every case reads a file and calls
// one pure function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The two directories whose environment reads a reader of AGENTS.md is told
// about, the file that owns the config surface, the file that owns telemetry, the
// page that makes the claim, and this file, which the claim points at.
const DIRS = ['src/service', 'src/observability']
const OVERLAY_FILE = 'src/service/start-live.js'
const TELEMETRY_FILE = 'src/observability/telemetry.js'
const CLAIM_FILE = 'AGENTS.md'
const THIS_FILE = 'test/tooling/env-overlay-surface.test.js'

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

// The token for 'the whole environment', so a row can declare a spread or an
// argument. A row for it is only honest while the read is a hand-off: a read the
// guard cannot name the variables of would be the hole the row exists to close.
const WHOLE = 'process.env'

// A whole-object read the guard cannot follow, and therefore cannot let a row
// excuse. Destructuring and optional chaining both read a name the named scan never
// sees, so a guard that took the row's word for them would pass a new variable in
// silence, which is the drift it is here to stop.
const UNFOLLOWED = 'the environment object, in a shape this guard does not follow'

// The shapes a hand-off takes: a spread, an argument, a parenthesised object, a
// default parameter, or an argument on a line of its own, which is how the call in
// startLive is written. Anything else is UNFOLLOWED.
const HANDOFF = /\.\.\.\s*process\.env\b|[(,]\s*process\.env\b\s*[,)]|^\s*process\.env\b\s*[,)]|=\s*process\.env\b\s*[,)]/

// The service's environment reads that are deliberately outside the config
// document. One row per file and variable, and the reason is what makes the row an
// exception rather than a bug: the next reader either finds their read here and
// leaves it alone, or reads this list and moves the read into envOverlay.
//
// A row's variable is a name, or WHOLE when the read has no name because the whole
// environment is handed over. A whole-object row also counts its hand-offs: that
// variable is the one thing the scan cannot see, so the row has to say how many.
const EXCEPTIONS = [
  {
    file: OVERLAY_FILE,
    variable: 'MONOPLAYER_BACKEND_HOST',
    why: 'the one name here that is also a config key: startLive refuses a purely default --start ' +
      'before any document is resolved, so the guardrail has to read the name a config file ' +
      'would otherwise supply'
  },
  {
    file: OVERLAY_FILE,
    variable: 'MONOPLAYER_LOG',
    why: 'the JSONL sink names a file the process writes. A path that does not open costs the ' +
      'operator their log, which is not a reason to refuse to start the lane'
  },
  {
    file: OVERLAY_FILE,
    variable: 'MONOPLAYER_DEBUG_REPLAY',
    why: 'a forensics dump an operator asks for while chasing a desync, off by default. It names ' +
      'an artifact, not a value the relay branches on'
  },
  {
    file: OVERLAY_FILE,
    variable: 'MONOPLAYER_DEBUG_FRAMED',
    why: 'the framed-byte dump, for the same reason as the replay dump: a diagnostic file, not ' +
      'lane configuration'
  },
  {
    file: OVERLAY_FILE,
    variable: WHOLE,
    why: 'the whole environment is handed to envOverlay once and to createTelemetry once. ' +
      'envOverlay needs it because it is the overlay; telemetry is given it because the env ' +
      'object is its interface',
    count: 2
  },
  {
    file: TELEMETRY_FILE,
    variable: WHOLE,
    why: 'the default for the env object createTelemetry reads. startLive passes its own copy, so ' +
      'this default is what a caller that passes nothing gets: telemetry owns its environment',
    count: 1
  },
  {
    file: TELEMETRY_FILE,
    variable: 'MONOPLAYER_OTEL_ENDPOINT',
    why: 'the fallback for the standard OTEL_EXPORTER_OTLP_ENDPOINT, read where the OTLP ' +
      'exporter lives. Moving the fallback alone would leave the endpoint in two homes'
  },
  {
    file: TELEMETRY_FILE,
    variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    why: "the OTLP specification's own name for the collector. The config document cannot rename " +
      'a name a collector standard owns'
  },
  {
    file: TELEMETRY_FILE,
    variable: 'OTEL_SERVICE_NAME',
    why: 'the OTLP resource attribute every collector reads, from the same standard as the ' +
      'endpoint'
  },
  {
    file: TELEMETRY_FILE,
    variable: 'OTEL_SERVICE_VERSION',
    why: 'the second half of the OTLP service identity, from the same standard'
  },
  {
    file: TELEMETRY_FILE,
    variable: 'HOSTNAME',
    why: "the pod's own name, which the container runtime sets. It is the resource's instance id " +
      'and no lane behaviour depends on it'
  },
  {
    file: TELEMETRY_FILE,
    variable: 'MONOPLAYER_ACCOUNT_ALIAS',
    why: "not an operator setting: startLive stamps the resolved account's alias into the copy " +
      'of the environment it hands telemetry, so this name is an argument in disguise'
  }
]

// A comment that names a variable is not a read: the header of start-live.js is
// itself a list of the switches, and a list cannot be its own authority. Only
// whole-line comments are dropped. This is #402's filter, minus its '#' arm: this
// walk reads JavaScript only, where a line that starts with '#' is a private class
// field rather than a comment.
const isCode = line => !/^\s*(\/\/|\*|\/\*)/.test(line)

// A read of a name off an environment object: process.env.NAME, env.NAME, or the
// bracket form of either.
const NAMED = /(?:\bprocess\.env|\benv)(?:\.([A-Z][A-Z0-9_]*)|\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\])/g

// The environment object itself: a spread, or a default argument. The lookahead keeps
// a named read out, so one occurrence is counted once.
const EVERYTHING = /\bprocess\.env\b(?![.[])/g

// The lines of a file that run, with the number each sits on, so a finding can name
// the line a reader has to open.
function codeLines (text) {
  return text.split('\n')
    .map((line, number) => ({ line, number: number + 1 }))
    .filter(({ line }) => isCode(line))
}

// Every environment read in a file, as { variable, line }. A name the code computes
// (the overlay's journal names arrive as env[variable]) is not visible here. That is
// why this guard reads envOverlay's own lines as a range rather than as names: a
// read inside the function is a config key by position, and the --help guard owns
// which of those exist.
function reads (text) {
  const found = []
  for (const { line, number } of codeLines(text)) {
    for (const match of line.matchAll(NAMED)) {
      found.push({ variable: match[1] ?? match[2], line: number })
    }
    for (const whole of line.matchAll(EVERYTHING)) {
      found.push({ variable: HANDOFF.test(line) ? WHOLE : UNFOLLOWED, line: number })
    }
  }
  return found
}

// Every file under a directory, relative to the root.
function sources (dir, found = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const file = dir + '/' + entry.name
    if (entry.isDirectory()) sources(file, found)
    else if (/\.(?:js|mjs)$/.test(entry.name)) found.push(file)
  }
  return found
}

// The lines envOverlay itself occupies. A read on one of them is a config key, and
// the --help guard in usage-env-vars.test.js owns that list. The function is
// exported at the left margin and closes at it, which is the same brace the sibling
// guard trusts.
function overlayLines () {
  const lines = read(OVERLAY_FILE).split('\n')
  const start = lines.findIndex(line => line.startsWith('export function envOverlay'))
  assert.notEqual(start, -1, OVERLAY_FILE + ' has no envOverlay to read, so the guard reads nothing')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  assert.notEqual(end, -1, 'the envOverlay function has no closing brace at the left margin')
  return { first: start + 1, last: end + 1 }
}

// The environment's reads outside envOverlay, as { file, variable, line }.
function outside () {
  const range = overlayLines()
  const found = []
  for (const dir of DIRS) {
    for (const file of sources(dir)) {
      for (const item of reads(read(file))) {
        const inside = file === OVERLAY_FILE && item.line >= range.first && item.line <= range.last
        if (!inside) found.push({ file, variable: item.variable, line: item.line })
      }
    }
  }
  return found
}

// Read the tree once, so a case cannot pass on a tree a later case changed.
const READS = outside()

// A read no row declares. The message is the product of this guard: a file, a line,
// a variable, and the change that fixes it. The one reading no row may excuse is the
// whole object in a shape the guard cannot follow, and it gets its own sentence.
function undeclared (found, declared) {
  const offenders = []
  for (const { file, variable, line } of found) {
    if (variable === UNFOLLOWED) {
      offenders.push(file + ':' + line + ' reads ' + variable + '. A row cannot declare it, because ' +
        'the guard cannot see which name it reads. Name the variables (process.env.NAME), or hand ' +
        'the whole object over as ...process.env or as an argument, which a row can declare.')
      continue
    }
    if (declared.has(file + '|' + variable)) continue
    offenders.push(file + ':' + line + ' reads ' + variable + ', and no row in EXCEPTIONS declares ' +
      'it. ' + CLAIM_FILE + ' says the config surface is envOverlay (' + OVERLAY_FILE + '), so a ' +
      'read outside it is a decision: move it into envOverlay and give it a --help line, or add a ' +
      'row here that says why it stays out.')
  }
  return offenders
}

// A row the walk no longer finds: the read moved, or it moved into the overlay, and
// the reason for the exception left with it.
function retired (found, declared) {
  const seen = new Set(found.map(({ file, variable }) => file + '|' + variable))
  const offenders = []
  for (const row of declared) {
    if (seen.has(row.file + '|' + row.variable)) continue
    offenders.push('EXCEPTIONS declares ' + row.variable + ' in ' + row.file + ', and nothing there ' +
      'reads it. Delete the row, and correct the AGENTS.md bullet the row was there to explain: an ' +
      'exception the code does not need is a claim about the service that is already false.')
  }
  return offenders
}

// A hand-off a row counts wrong: the file hands the whole environment over more or
// fewer times than its row says. Only a whole-object row carries a count, because a
// named read is visible in the scan and a hand-off is not.
function miscounted (found, declared) {
  const offenders = []
  for (const row of declared) {
    if (row.count === undefined) continue
    const seen = found.filter(item => item.file === row.file && item.variable === row.variable).length
    if (seen === row.count) continue
    offenders.push(row.file + ' hands ' + row.variable + ' over ' + seen + ' time' +
      (seen === 1 ? '' : 's') + ', and its row declares ' + row.count + '. Either a subsystem was ' +
      'handed every name at once and needs a row of its own, or a hand-off went away and the count ' +
      'with it.')
  }
  return offenders
}

// The bullet of AGENTS.md that makes the claim, as its own text. A pointer a stray
// line satisfies is a pointer the reader who needs it never sees, so the case below
// reads the bullet and not the page.
function claim () {
  const text = read(CLAIM_FILE)
  const start = text.indexOf('- **The config surface is one function')
  assert.notEqual(start, -1, CLAIM_FILE + ' has no "The config surface is one function" bullet, ' +
    'so the guard holds a claim nothing makes')
  const next = text.indexOf('\n- **', start)
  return text.slice(start, next === -1 ? undefined : next)
}

const DECLARED_KEYS = new Set(EXCEPTIONS.map(row => row.file + '|' + row.variable))

test('the guard found the tree it reads', () => {
  // A walk that finds nothing passes every case below. The floor names the shapes
  // this guard has to survive rather than a count to edit: a raw read in the
  // service, a read a subsystem performs off the object it is handed, the token for
  // a hand-off of the whole environment, and the two directories.
  assert.ok(READS.some(r => r.variable === 'MONOPLAYER_LOG' && r.file === OVERLAY_FILE),
    'the walk found no raw read of MONOPLAYER_LOG in ' + OVERLAY_FILE + ', so DIRS or the comment ' +
    'filter is broken')
  assert.ok(READS.some(r => r.variable === 'MONOPLAYER_ACCOUNT_ALIAS' && r.file === TELEMETRY_FILE),
    'the walk found no read of MONOPLAYER_ACCOUNT_ALIAS in ' + TELEMETRY_FILE + ', so it is not ' +
    'reading the second directory')
  assert.ok(READS.some(r => r.variable === WHOLE),
    'the walk found no hand-off of the whole environment, so the spread into telemetry is invisible')
  assert.ok(!READS.some(r => r.file === OVERLAY_FILE && r.variable === 'MONOPLAYER_FRONT_HOST'),
    'the walk reported MONOPLAYER_FRONT_HOST as a read outside envOverlay, and envOverlay is where ' +
    'it is read, so the line range that excludes the function is broken')
})

test('no file outside envOverlay reads the environment undeclared', () => {
  const offenders = undeclared(READS, DECLARED_KEYS)
  assert.deepEqual(offenders, [],
    'the service reads the environment outside envOverlay, and the row that would excuse it is ' +
    'missing:\n  ' + offenders.join('\n  '))
})

test('the whole environment is handed over as many times as the table says', () => {
  const offenders = miscounted(READS, EXCEPTIONS)
  assert.deepEqual(offenders, [],
    'a row that counts a hand-off disagrees with the tree:\n  ' + offenders.join('\n  '))
})

test('every declared exception is a read the code still makes', () => {
  const offenders = retired(READS, EXCEPTIONS)
  assert.deepEqual(offenders, [],
    'a declared exception outlived its read:\n  ' + offenders.join('\n  '))
})

test('AGENTS.md names the readers that stay out, and points at this file', () => {
  const text = claim()
  // The names of the exceptions are in the table above and nowhere else: AGENTS.md
  // tells the reader that some reads stay outside, which files they live in, and why,
  // and then sends them here. It is a pointer, not a second copy of the list, because
  // a list AGENTS.md repeated would be the copy that drifts. AGENTS.md's own rule:
  // do not repeat an environment variable list in prose.
  assert.match(text, /envOverlay/, 'the bullet names the function that owns the config surface')
  assert.match(text, new RegExp(OVERLAY_FILE.replace(/[/.]/g, '\\$&')),
    'the bullet names the file envOverlay lives in')
  assert.match(text, new RegExp(TELEMETRY_FILE.replace(/[/.]/g, '\\$&')),
    'the bullet names the second file that reads its own environment')
  assert.match(text, new RegExp(THIS_FILE.replace(/[/.]/g, '\\$&')),
    'the bullet points at this guard, because the list is here and not in the page')
})

test('the message names the file, the line, the variable, and the change', () => {
  const [message] = undeclared(
    [{ file: 'src/service/start-live.js', variable: 'MONOPLAYER_PICKER', line: 41 }], new Set())
  assert.match(message, /^src\/service\/start-live\.js:41 reads MONOPLAYER_PICKER/,
    'the message names the file, the line, and the variable: ' + message)
  assert.match(message, /move it into envOverlay/, 'and the change that fixes it: ' + message)
  assert.match(message, /add a row here/, 'and the other change: ' + message)
})

test('the message names the row that outlived its read', () => {
  const [message] = retired([], [{ file: 'src/observability/telemetry.js', variable: 'MONOPLAYER_RETIRED' }])
  assert.match(message, /^EXCEPTIONS declares MONOPLAYER_RETIRED in src\/observability\/telemetry\.js/,
    'the message names the row: ' + message)
  assert.match(message, /Delete the row/, 'and the change that fixes it: ' + message)
})

test('a comment that names a variable is not a read', () => {
  assert.deepEqual(reads([
    '// MONOPLAYER_RETIRED is read here',
    '/*',
    ' * process.env.MONOPLAYER_ALSO_RETIRED',
    ' */',
    'const sink = process.env.MONOPLAYER_LOG'
  ].join('\n')), [{ variable: 'MONOPLAYER_LOG', line: 5 }],
  'the header comments of start-live.js and telemetry.js list the switches, and a list cannot be ' +
  'its own authority')
})

test('a whole-object read a row cannot excuse is reported, not swallowed', () => {
  // A row for process.env covers the two hand-offs that exist. A third shape would
  // let a new variable in under an old row, which is the failure this guard was
  // written for, so it fails whatever the table says.
  assert.deepEqual(reads('const env = process.env').map(item => item.variable), [UNFOLLOWED],
    'destructuring reads a name the named scan cannot see, so the guard cannot let a row excuse it')
  assert.deepEqual(reads('const port = process.env?.MONOPLAYER_PORT').map(item => item.variable),
    [UNFOLLOWED], 'an optional read hides the name behind a character the named scan does not expect')
  assert.deepEqual(reads('const e = { ...process.env }').map(item => item.variable), [WHOLE],
    'a spread is a hand-off, and a row declares it')
  assert.deepEqual(reads('envOverlay(doc, process.env, warn)').map(item => item.variable), [WHOLE],
    'an argument is a hand-off, and a row declares it')
})

test('a bracket read and a dotted read are the same surface', () => {
  assert.deepEqual(reads([
    "const a = env.MONOPLAYER_ONE || env['MONOPLAYER_TWO']",
    'const c = process.env.MONOPLAYER_THREE'
  ].join('\n')).map(item => item.variable),
  ['MONOPLAYER_ONE', 'MONOPLAYER_TWO', 'MONOPLAYER_THREE'],
  'the two spellings of a name, and the process-prefixed read, are three ways to reach the same ' +
  'surface, and each one has to be visible to the walk')
})

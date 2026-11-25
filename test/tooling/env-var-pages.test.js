// #402: a page may name only an environment variable the code reads.
//
// The prose of this repo names MONOPLAYER_* variables on nearly every page, and
// the service's half of that surface is one function: envOverlay in
// src/service/start-live.js. A page that lists a variable nothing reads teaches
// the next reader to set nothing: loadConfig ignores the name in silence, so the
// page reads as true and the lane does nothing. The repo's rule asks for a guard
// rather than a paragraph, because the list is useful in a runbook and the list
// is what drifts.
//
// The read set is any code line that names a variable, comments excepted. A
// help string counts as code: the USAGE block in src/service/monoplayer.js lists
// the switches, so a name it keeps after the switch retires would still pass this
// guard. That is the same rule one layer up, and #407 is the ticket for it.
//
// Nothing here reaches a cluster or a network: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The token a page carries, from MONOPLAYER_ to the last character that could
// belong to it. A name is not a token: MONOPLAYER_LEASE_* names a family of
// variables, and a family is not something the code can read, so a token a
// star follows is dropped rather than reported.
const TOKEN = /MONOPLAYER_[A-Z0-9_]*/g

function names (line) {
  const found = []
  for (const match of line.matchAll(TOKEN)) {
    const after = line.slice(match.index + match[0].length, match.index + match[0].length + 1)
    if (after === '*') continue
    // A prefix that ends on an underscore is a name nobody finished writing.
    if (!/[A-Z0-9]$/.test(match[0])) continue
    found.push(match[0])
  }
  return found
}

// The directories whose files run. A manifest under deploy/ sets a variable and a
// test sets one to drive code; neither is a reader, so neither belongs here.
const CODE_DIRS = ['src', 'tools', 'scripts']

// The authority for a service variable, and the two places a reader is sent when
// the guard fails. A deployment page that names nothing else is still useful, so
// the guard names where the name has to land rather than only what is wrong.
const OVERLAY = 'src/service/start-live.js'
const PRINT_CONFIG = 'node src/service/monoplayer.js --print-config'

// A verdict page records what was true when it was taken, so it may name a
// variable that retired after the run. It is evidence, not a runbook, and AGENTS.md
// says to leave its numbers alone.
const NOT_A_PAGE = new Set(['node_modules', '.git', '.scratch', '.reports', 'testdata'])

function walk (dir, keep, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (NOT_A_PAGE.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, found)
    else if (keep(entry.name)) found.push(full)
  }
  return found
}

// A comment that names a variable is not a read: a header listing the switches
// would keep a retired name alive for ever. Only whole-line comments are dropped,
// so a value or a pattern that carries a "#" is left alone.
const withoutComments = text => text.split('\n')
  .filter(line => !/^\s*(\/\/|#|\*|\/\*)/.test(line))
  .join('\n')

// Every name the code reads, and the file that reads it. envOverlay is one reader
// among them: a rung's variable is read by the script that uses it, and that
// script is code, so a page documenting a lane may still name it.
function readers () {
  const found = new Map()
  for (const dir of CODE_DIRS) {
    for (const file of walk(path.join(ROOT, dir), () => true)) {
      const bytes = fs.readFileSync(file)
      // A font or an archive reads no variable, and decoding one would be a guess
      // about an encoding this guard has no reason to hold.
      if (bytes.includes(0)) continue
      for (const line of withoutComments(bytes.toString('utf8')).split('\n')) {
        for (const name of names(line)) {
          if (!found.has(name)) found.set(name, new Set())
          found.get(name).add(path.relative(ROOT, file))
        }
      }
    }
  }
  return found
}

// What one page says that no file reads. The message is the whole product of this
// guard: a page, a line, a variable, and the two places it would have to be read,
// so the next reader fixes the page or wires the variable rather than guessing.
function unread (page, text, read) {
  const found = []
  text.split('\n').forEach((line, index) => {
    for (const name of names(line)) {
      if (read.has(name)) continue
      found.push(page + ':' + (index + 1) + ' names ' + name + ', and no file under ' +
        CODE_DIRS.join('/, ') + '/ reads it. A service variable would have to be read in ' +
        'envOverlay (' + OVERLAY + '); a lane\'s variable in the script that uses it. ' +
        'Delete the name from the page, or read it where it belongs.')
    }
  })
  return found
}

const READ = readers()
const PAGES = walk(ROOT, name => name.endsWith('.md')).map(file => path.relative(ROOT, file))

test('the guard found the code and the pages it reads', () => {
  // A walk that finds nothing passes every case below. Both halves of the surface
  // are named here: one variable the service reads in envOverlay, and one a rung
  // reads in a script, because a page may name either.
  assert.ok(READ.has('MONOPLAYER_BACKEND_HOST'),
    'the walk found no reader for MONOPLAYER_BACKEND_HOST, which envOverlay reads, so ' +
    'CODE_DIRS or the comment filter is broken')
  assert.ok(READ.has('MONOPLAYER_GATE_NAMESPACE'),
    'the walk found no reader for MONOPLAYER_GATE_NAMESPACE, which scripts/ reads, so a ' +
    'page documenting a lane would fail for a name the repo honours')
  assert.ok(PAGES.includes('docs/deployment.md'),
    'the walk found no docs/deployment.md, so it is not reading the pages it guards')
})

test('no page names a variable the code does not read', () => {
  const offenders = PAGES.flatMap(page => unread(page, fs.readFileSync(path.join(ROOT, page), 'utf8'), READ))
  assert.deepEqual(offenders, [],
    'a page names a variable nothing reads:\n  ' + offenders.join('\n  '))
})

test('the guard names the page, the variable, and where it would have to be read', () => {
  const [message] = unread('docs/deployment.md', '# Deployment\n\nSet \`MONOPLAYER_RETIRED_SWITCH=1\`.\n', READ)
  assert.match(message, /^docs\/deployment\.md:3 names MONOPLAYER_RETIRED_SWITCH/, message)
  assert.match(message, /envOverlay/, 'the message names the function that would have to read it: ' + message)
  assert.match(message, new RegExp(OVERLAY.replace(/[/.]/g, '\\$&')),
    'the message names the file envOverlay lives in: ' + message)
})

test('a glob names a family, so the guard does not read it as a variable', () => {
  assert.deepEqual(unread('docs/testing-ladder.md', 'The rest are \`MONOPLAYER_LEASE_*\`.\n', READ), [],
    'MONOPLAYER_LEASE_* names every lease variable at once, and no page owes a read for a family')
})

test('the deployment page points at the authority instead of restating it', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs/deployment.md'), 'utf8')
  // The section, not the page: a pointer a stray line satisfies is a pointer the
  // reader of that section never sees.
  const start = text.indexOf('## What the deployment must set')
  assert.notEqual(start, -1, 'the page has a "What the deployment must set" section')
  const named = text.slice(start, text.indexOf('\n## ', start))
  assert.match(named, /envOverlay/,
    'the section that names variables says where the names come from, so a reader checks the ' +
    'authority rather than trusting the page')
  assert.match(named, new RegExp(PRINT_CONFIG.replace(/[/.]/g, '\\$&')),
    'and the command that prints the resolved defaults, so the page need not restate them')
})

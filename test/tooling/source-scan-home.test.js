// A brace walk under test/ lives in test/support/source-scan.js, and nowhere else (#847).
//
// Seven guards found a block the same way: match a brace, walk to its partner. Each carried
// its own copy. A copy that stops matching the file it reads keeps passing, and two walks
// over one file disagree the day one of them learns a shape the other does not, with nothing
// red to say so. #710's rule is one step further back: a source scan proves a branch is
// mentioned and never that it runs, and a scan whose subject moved proves less than that.
//
// A copy is not greppable by name, which is what makes it cheap to add. So this reads the
// shape: an opening brace inside a string or a regex literal, and a depth counter moved
// beside it. Both halves are needed. The counter alone is a loop over a list — test/panel's
// FakeElement walks a stack of open tags that way — and the literal alone is a regex or a
// sentence that quotes a brace.
//
// The second case reads the shared module's own export list instead: a guard that declares a
// function the module already exports is the same copy under a name this cannot spell in
// advance, and a scan the module gains is covered here without an edit.
//
// The walk reads text, so it has two blind spots. A comment that explains the shape does not
// count against it, because the lines are filtered first. A copy that moves a counter this
// does not name is not read; test/support/source-scan.js is where it belongs anyway, and the
// case that reads the export list catches the half a name can catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = fileURLToPath(import.meta.url)
const TEST_DIR = path.join(ROOT, 'test')
const HOME = path.join(TEST_DIR, 'support', 'source-scan.js')

// Recursive, so a file added in a new area is covered without editing this one, and every
// .js rather than only the .test.js ones: a shared helper is exactly where a second walk
// would hide.
function sources (dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

// A comment that names the shape is not the shape. test/tooling/temp-root-teardown.test.js
// filters its lines the same way, and for the same reason: a sentence explaining a rule must
// not be the thing that fails it. Blanked rather than dropped, so a line number is still the
// line a reader opens.
const isCode = line => !/^\s*(\/\/|\*|\/\*)/.test(line)

// An opening brace inside a string or a regex literal, and a depth counter moved by one. The
// window crosses the comment a counter usually carries and stays inside one function.
const BRACE = /(['"`])[^'"`\n]*\{[^'"`\n]*\1|\\\{/
const COUNTER = /(?:depth|level|inner|nest)\s*(?:\+= 1|-= 1|\+\+|--)/
const WINDOW = 400

// Read the tree once, so a case cannot pass on a tree a later case changed.
const FILES = sources(TEST_DIR)

const relativeOf = file => path.relative(ROOT, file).split(path.sep).join('/')

function walks () {
  const found = []
  for (const file of FILES) {
    // Two exemptions, and both are the rule rather than an exception to it: this file names
    // the shape it forbids, and the home is where the walk belongs.
    if (file === SELF || file === HOME) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const code = lines.map(line => isCode(line) ? line : '').join('\n')
    // A fresh global regex per file: matchAll reads lastIndex off the pattern it is given,
    // so a shared one would start each file where the last case left it.
    for (const move of code.matchAll(new RegExp(COUNTER.source, 'g'))) {
      const near = code.slice(Math.max(0, move.index - WINDOW), move.index + WINDOW)
      if (!BRACE.test(near)) continue
      const line = code.slice(0, move.index).split('\n').length
      found.push(relativeOf(file) + ':' + line + ': ' + lines[line - 1].trim())
    }
  }
  return found
}

// The message is the product: it is what the next author acts on. It is built in one place so
// a case can render one without a tree that already offends.
const refusal = offenders =>
  'a file under test/ walks a block of its own, so two walks over one source file can disagree ' +
  'the day one of them learns a shape the other does not. Read it with test/support/source-scan.js, ' +
  'whose scans answer what a guard asks a source file:\n  ' + offenders.join('\n  ')

// A walk that finds nothing reports no offenders, which is the same answer as a clean tree.
// Naming the home and three areas is what separates the two.
test('the guard found the tree it reads', () => {
  assert.ok(FILES.includes(HOME), 'the walk missed test/support/source-scan.js, so the home is unread')
  for (const file of ['panel/record-doc', 'service/spectate', 'tooling/glossary-control-document']) {
    assert.ok(FILES.includes(path.join(TEST_DIR, file + '.test.js')),
      'the walk missed test/' + file + '.test.js, so its scan is unguarded')
  }
  assert.ok(FILES.length > 100, 'the walk read ' + FILES.length + ' files under test/, which is not the tree')
})

test('the home still holds the walk, so its exemption covers a walk and not a file', () => {
  const home = fs.readFileSync(HOME, 'utf8').split('\n').map(line => isCode(line) ? line : '').join('\n')
  assert.match(home, COUNTER, 'test/support/source-scan.js holds the depth counter every guard reads')
  assert.ok(BRACE.test(home), 'and the quoted brace it walks to a partner')
})

test('no file under test/ walks a block of its own', () => {
  const offenders = walks()
  assert.deepEqual(offenders, [], refusal(offenders))
})

test('the message names the file, the line, the counter, and the home to use', () => {
  const text = refusal(["test/tooling/x.test.js:4: if (source[i] === '{') depth += 1"])
  assert.match(text, /test\/tooling\/x\.test\.js:4/, 'the file and the line: ' + text)
  assert.match(text, /depth \+= 1/, 'the counter it found: ' + text)
  assert.match(text, /test\/support\/source-scan\.js/, 'the home to use instead: ' + text)
})

// The scans the shared module publishes, read from the module rather than written out here,
// the way test/tooling/product-core-map.test.js reads every name it holds a map for.
const SHARED = Object.keys(await import(pathToFileURL(HOME).href)).sort()

test('no guard declares, or renames, a scan the shared module already exports', () => {
  assert.ok(SHARED.length > 0, 'test/support/source-scan.js exports the scans a guard imports')

  const declared = []
  for (const file of FILES) {
    if (file === HOME) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const name of SHARED) {
      const shapes = ['function ' + name + ' \\(', 'const ' + name + ' =']
      if (!shapes.some(shape => new RegExp('^\\s*' + shape, 'm').test(text))) continue
      declared.push(relativeOf(file) + ' declares ' + name)
    }
  }
  assert.deepEqual(declared, [],
    'a copy under another name:\n  ' + declared.join('\n  ') +
    '\n' + relativeOf(HOME) + ' already exports these scans (' + SHARED.join(', ') +
    '). Import it, so a shape one copy learns is a shape every guard reads')
})


// A brace walk under test/ lives in test/support/source-scan.js, and nowhere else (#847).
//
// Guards across test/ found a block the same way: match a brace, walk to its partner. Each
// carried its own copy. A copy that stops matching the file it reads keeps passing, and two walks over
// one file disagree the day one of them learns a shape the other does not, with nothing red to
// say so. #710's rule is one step further back: a source scan proves a branch is mentioned and
// never that it runs, and a scan whose subject moved proves less than that.
//
// A copy is not greppable by name, which is what makes it cheap to add. So this reads the
// shape: a line that spells the brace it compares against, and a name moved by one beside it.
// The name is deliberately not read — a copy renames its counter first — and half a shape is
// not enough either way. A counter alone is a loop over a list, and a brace alone is a regex
// or a sentence that quotes one.
//
// The second case reads the shared module's own export list instead: a guard that declares a
// function the module already exports is the same copy under a name this cannot spell in
// advance, and a scan the module gains is covered here without an edit.
//
// Its own two helpers, the recursive file walk and the comment filter, are copies of
// test/tooling/temp-root-teardown.test.js's. They stay for now: hoisting them means editing a
// guard this ticket does not own, neither is a source scan, and #862 is the ticket that gives
// them one home.
//
// The walk reads text, so it has blind spots, and they are the price of a detector that reads
// a line at a time. A brace bound to a name before the comparison is read too. A walk is not
// read when its two halves sit on different lines, when it counts a block's depth some other
// way (a stack it pushes and pops), or when it reads a language whose braces are not the ones
// this spells. test/support/source-scan.js is where such a walk belongs anyway; this is the
// net, not the rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = fileURLToPath(import.meta.url)
const TEST_DIR = path.join(ROOT, 'test')
const HOME = path.join(TEST_DIR, 'support', 'source-scan.js')

// Recursive, so a file added in a new area is covered without editing this one, and every .js
// rather than only the .test.js ones: a shared helper is exactly where a second walk would
// hide.
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
// not be the thing that fails it.
const isCode = line => !/^\s*(\/\/|\*|\/\*)/.test(line)

// The brace a walk compares against, spelled three ways: alone in a string (`'{'`), as the
// bracket set a mixed walk tests (`'([{'`), and inside a regex (`/\{/g`, for the walk that
// counts one line's depth).
const BRACE = /(['"`])\{\1|(['"`])\(\[\{\2|\\\{/

// A name a file binds to an opening brace before it compares against it. A copy that hoists the
// brace into a constant is the same walk, and its comparison line no longer spells the brace.
const BINDS = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])\{\2/

// Any name moved by an assignment or an increment: the counter, whatever it is called, and
// however it is spelled — a depth counted per line is added to, not incremented by one.
const MOVES = /[A-Za-z_$][\w$]*\s*(?:\+=|-=)|\+\+|--/

// Read the tree once, so a case cannot pass on a tree a later case changed.
const FILES = sources(TEST_DIR)

const relativeOf = file => path.relative(ROOT, file).split(path.sep).join('/')

// The lines of one file that walk a block of their own, or none. Lifted out of the tree walk so
// a case can hand it a known copy and prove the detector is not vacuous.
function offendersIn (text) {
  const lines = text.split('\n')
  const bound = []
  for (const line of lines) {
    const bind = line.match(BINDS)
    if (bind !== null && !bound.includes(bind[1])) bound.push(bind[1])
  }
  const found = []
  lines.forEach((line, index) => {
    if (!isCode(line) || !MOVES.test(line)) return
    const compared = bound.some(name =>
      new RegExp('(?:===|!==|==|!=)\\s*' + name + '\\b|\\b' + name + '\\s*[=!]==?').test(line))
    if (!BRACE.test(line) && !compared) return
    found.push(index + 1)
  })
  return found
}

// The message is the product: it is what the next author acts on. It is built in one place so a
// case can render one without a tree that already offends.
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
  assert.deepEqual(offendersIn(fs.readFileSync(HOME, 'utf8')).length > 0, true,
    'test/support/source-scan.js holds the walk every guard reads, so its exemption covers a walk and not a file')
})

// The detector is a shape and not a name, so a case proves it fires on a copy that no longer
// says any of the words the tree used to spell.
test('the walk reads a brace walk whatever its counter is called', () => {
  const copy = [
    'function takeBody (text, at) {',
    '  let brace = 0',
    '  for (let i = at; i < text.length; i += 1) {',
    "    if (text[i] === '{') brace += 1",
    "    else if (text[i] === '}') { brace -= 1; if (brace === 0) return text.slice(at, i) }",
    '  }',
    '}'
  ].join('\n')
  assert.deepEqual(offendersIn(copy), [4], 'the counter named brace is read: ' + JSON.stringify(offendersIn(copy)))

  const mixed = "if ('([{'.includes(c)) level += 1"
  assert.deepEqual(offendersIn(mixed), [1], 'the bracket set a mixed walk tests is read')

  const counted = String.raw`inner += (line.match(/\{/g) ?? []).length`
  assert.deepEqual(offendersIn(counted), [1], 'a line whose depth comes from a regex is read')

  const hoisted = ["const OPEN = '{'", 'let n = 0', 'for (const c of text) if (c === OPEN) n += 1'].join('\n')
  assert.deepEqual(offendersIn(hoisted), [3], 'a brace bound to a name first is read at its comparison')

  const loop = 'for (let i = 0; i < 5; i++) out.push({ x: i })'
  assert.deepEqual(offendersIn(loop), [], 'a loop over a list is not a walk')

  const sentence = "// if (source[i] === '{') depth += 1"
  assert.deepEqual(offendersIn(sentence), [], 'a comment that explains the shape is not the shape')
})

test('no file under test/ walks a block of its own', () => {
  const offenders = []
  for (const file of FILES) {
    // Two exemptions, and both are the rule rather than an exception to it: this file names the
    // shape it forbids, and the home is where the walk belongs.
    if (file === SELF || file === HOME) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const line of offendersIn(lines.join('\n'))) {
      offenders.push(relativeOf(file) + ':' + line + ': ' + lines[line - 1].trim())
    }
  }
  assert.deepEqual(offenders, [], refusal(offenders))
})

test('the message names the file, the line, the counter, and the home to use', () => {
  const text = refusal(["test/tooling/x.test.js:4: if (source[i] === '{') depth += 1"])
  assert.match(text, /test\/tooling\/x\.test\.js:4/, 'the file and the line: ' + text)
  assert.match(text, /depth \+= 1/, 'the counter it found: ' + text)
  assert.match(text, /test\/support\/source-scan\.js/, 'the home to use instead: ' + text)
})

// The scans the shared module publishes, read from the module rather than written out here, the
// way test/tooling/product-core-map.test.js reads every name it holds a map for.
const SHARED = Object.keys(await import(pathToFileURL(HOME).href)).sort()

test('no guard redeclares a scan the shared module exports', () => {
  assert.ok(SHARED.length > 0, 'test/support/source-scan.js exports the scans a guard imports')

  const declared = []
  for (const file of FILES) {
    if (file === HOME) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const name of SHARED) {
      const shapes = ['(?:export\\s+)?(?:async\\s+)?function ' + name + '\\s*\\(',
        '(?:const|let|var) ' + name + '\\s*=']
      if (!shapes.some(shape => new RegExp('^\\s*' + shape, 'm').test(text))) continue
      declared.push(relativeOf(file) + ' declares ' + name)
    }
  }
  assert.deepEqual(declared, [],
    'a copy under another name:\n  ' + declared.join('\n  ') +
    '\n' + relativeOf(HOME) + ' already exports these scans (' + SHARED.join(', ') +
    '). Import it, so a shape one copy learns is a shape every guard reads')
})

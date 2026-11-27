// AGENTS.md and the deploy manifests point a reader at files in this tree, and no case
// read a pointer in either surface (#845). Both stale pointers that reached main were
// found by hand, and both were one shape: a sentence that still resolves to a file after
// the fact moved out of it. AGENTS.md said the header of src/service/monoplayer.js lists
// the leg interfaces, which #763 emptied, and deploy/dev/monoplayer.yaml named
// src/core/identity.js for a session step #721 deleted. #723 and #766 fixed those two
// sentences. Nothing made the next one fail, so this file is what fails.
//
// The cheap half of a pointer is its path, and that half is checkable. Every code span in
// both surfaces is split into tokens, and every path written as prose is read as well,
// because a backtick is not what makes a reader follow a path: #721's sentence wrote
// (src/core/identity.js) in plain parentheses. A token shaped like a pointer is asked for
// in the tree, and a renamed directory, a moved module and a deleted manifest all fail
// here, naming the file, the line and the token.
//
// A bare name is a pointer too, and a reader cannot resolve one alone. It resolves under a
// directory its own block names in backticks, or beside the manifest that names it, or it
// is a key in that manifest and never a file: deploy/manifests/configmap.yaml names its
// two committed seeds this way. A bare name none of those holds fails, so the fix is a
// path a reader can follow. Only a bare name in a code span is read: a sentence uses words
// with dots in them, and asking after each one would make this file a spell-checker.
//
// The expensive half is a name inside a file that exists, and two shapes of it are cheap
// to read. One is a backticked identifier with a path beside it, as 'x in path' or
// 'x (path)': the file has to declare the identifier. The other is a quoted section title
// beside a page, as '"title" in page': the page has to hold a heading with the title in
// it, which is the shape a section rename breaks. A sentence that names a module and no
// identifier is not read, and neither is an identifier with no path beside it, because
// deciding which sentence names the right module is a reviewer's call and not a parse.
// What is compared is names: a row that points at a file which exists and no longer holds
// the fact is stale in a way nothing here can see.
//
// A name with no extension is neither a path nor a bare name to this file: `Dockerfile` in a
// sentence is a word, and a rename of it stays green. That is the one shape it cannot
// reach, and it is why the two incidents above had to be found by hand.
//
// The counts are the coverage this file has. Run it with POINTER_COUNTS=1 to print them:
// the pointers it follows, the pointer-shaped tokens it does not, and the words it rejects.
//
// Nothing here opens a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The two surfaces. AGENTS.md is the document every agent reads first, and a manifest
// comment is where a fact gets restated beside the value it describes. The runbooks under
// deploy/ are other guards' business: dev-lane.test.js holds the whitelist section of
// deploy/dev/README.md, and driver-doc-lane.test.js holds the gate's.
const AGENTS = 'AGENTS.md'
const MANIFEST = /\.ya?ml$/
const surfaces = () => [AGENTS, ...fs.readdirSync(path.join(ROOT, 'deploy'), { recursive: true })
  .map(name => path.posix.join('deploy', name.split(path.sep).join('/')))
  .filter(name => MANIFEST.test(name)).sort()]

const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// A document is read in blocks, not in lines: a row of a table, an item of a list and a
// run of comment lines are each one claim, and a sentence that wraps still reads as one.
// A manifest's data is not prose, so a manifest's blocks are its comment runs alone.
const NEW_BLOCK = /^\s*(?:[-*]\s|\||\d+\.\s)/
function blocks (file) {
  const out = []
  let current = null
  const flush = () => { if (current !== null) out.push(current); current = null }
  // A block carries the source line of every character it holds, because a failure has to
  // name the line the pointer is on and a block may be a paragraph.
  const add = (index, text) => {
    if (current === null) current = { file, text: '', lineOf: [] }
    if (current.text !== '') { current.text += ' '; current.lineOf.push(index + 1) }
    current.text += text
    current.lineOf.push(...new Array(text.length).fill(index + 1))
  }
  for (const [index, line] of read(file).split('\n').entries()) {
    if (MANIFEST.test(file)) {
      if (!line.trimStart().startsWith('#')) { flush(); continue }
      const text = line.replace(/^\s*#\s?/, '')
      if (text.trim() === '') { flush(); continue }
      add(index, text)
      continue
    }
    if (line.trim() === '') { flush(); continue }
    if (NEW_BLOCK.test(line)) flush()
    add(index, line)
  }
  flush()
  return out
}

// Every code span's tokens. A span that holds a command line holds several pointers, and
// each is judged on its own, because a reader types them one at a time.
const SPAN = /`([^`\n]+)`/g
const spanTokens = block => [...block.text.matchAll(SPAN)].flatMap(match => {
  const [whole, span] = match
  const start = match.index + whole.indexOf(span)
  return [...span.matchAll(/\S+/g)].map(token => ({
    // A path between parentheses, or followed by a comma, is the same path: a reader
    // copies the same characters.
    token: token[0].replace(/^\((.*)\)$/, '$1').replace(/[,;]$/, ''),
    at: start + token.index,
    prose: false
  }))
})
const spanBases = block => [...block.text.matchAll(SPAN)].map(([, span]) => span)

// The text outside the code spans, for the tokens shaped like a path. A sentence's
// punctuation is not part of the pointer, and a path's own dots and slashes are: the strip
// stops at an ellipsis, because a shape is not a name.
const edge = raw => {
  let token = raw.replace(/^[("'[]+/, '')
  while (token.length > 3 && /[.,;:)"'\]]$/.test(token)) {
    const next = token.slice(0, -1)
    if (next.endsWith('..')) break
    token = next
  }
  return token
}
// A markdown link is two pointers, its text and its target, and a link to a file this tree
// does not have is the same stale pointer as a sentence. link() is the split that keeps both.
const link = raw => raw.replace(/^[("'[]+/, '').replace(/[,;:)"'\]]+$/, '').split('](')
const proseTokens = block => [...block.text.replace(SPAN, whole => ' '.repeat(whole.length)).matchAll(/\S+/g)]
  .flatMap(match => link(match[0]).map(half => ({ token: edge(half), at: match.index, prose: true })))

// Where the tree keeps something a document may not point at, and why a pointer there is
// not a stale pointer: a run's output, a throwaway script, the account custody, a package.
const GENERATED = {
  '.reports': 'a task run writes it, and git ignores it',
  '.scratch': 'a throwaway script or artifact lives there, and git ignores it',
  '.secrets': 'the operator links the account custody there, and git never holds it',
  node_modules: 'pnpm resolves a package name there, and a fresh checkout has none'
}

// A token shaped like a pointer: it names a path, or a file with an extension. A flag, a
// command word, a version and a name with no extension are not pointers, which is why
// `Dockerfile` in a sentence is a word to this file.
const EXTENSION = '\\.(?:js|mjs|cjs|md|yaml|yml|json|jsonl|sh|toml|txt)$'
const BARE_FILE = new RegExp('^[A-Za-z0-9_][\\w.-]*' + EXTENSION)
const BARE_DIR = /^[A-Za-z0-9_][\w.-]*\/$/
const shaped = token => token.includes('/') || BARE_FILE.test(token)

// A shape, not a path: a placeholder, an alternation of commands, an ellipsis.
const PATTERN = /[<>*|\u2026]|\.\.\./

// The directories at the repo root a path can start with, read from the tree so a new
// top-level directory needs no edit here. The generated four are excluded first, because
// a run may leave one behind and none of them is a reader's to follow. hasOwn and not `in`,
// because `in` reaches Object.prototype: a token named constructor is not a generated path.
const TOPS = new Set(fs.readdirSync(ROOT)
  .filter(name => !Object.hasOwn(GENERATED, name))
  .filter(name => { try { return fs.statSync(path.join(ROOT, name)).isDirectory() } catch { return false } }))

// A slash-bearing token that is not a path, and why. Each is a name the cluster or the
// tracker resolves and this tree does not hold. A new one fails until it says the same.
const NOT_PATHS = {
  'Bafbi/monoplayer': 'a tracker slug: the gh CLI reads owner/repo, and this tree holds no such path',
  'deploy/monoplayer': 'a Deployment the kubectl command in that comment names, as kind/name: the cluster ' +
    'resolves it and no file here holds it'
}

// A regex for a literal name, without the escaping pitfalls of a character class here.
const literal = name => name.split('').map(char => '.+*?^$()[]{}|\\'.includes(char) ? '\\' + char : char).join('')

// Where a bare name resolves: under a directory its own block names, or beside the file
// that names it. The repo root counts for AGENTS.md, whose block is at the root.
function under (token, block) {
  const bases = [path.posix.dirname(block.file), ...spanBases(block)
    .filter(span => span.endsWith('/') && !/\s/.test(span) && !PATTERN.test(span))]
  for (const base of bases) {
    const at = path.posix.normalize(path.posix.join(base === '.' ? '' : base, token))
    if (fs.existsSync(path.join(ROOT, at))) return at
  }
  return null
}

// A bare name that is a key in the manifest naming it is not a file, and it is still a
// pointer: the key is what the operator copies. A renamed key fails here.
const isKey = (block, token) => new RegExp('^\\s*"?' + literal(token) + '"?\\s*:', 'm').test(read(block.file))

// One token, one class. A class this file does not know is a failure, so a surface cannot
// narrow what is read without somebody writing down why.
function classify (block, token) {
  if (!shaped(token)) return { kind: 'word' }
  if (PATTERN.test(token)) return { kind: 'pattern' }
  if (token.startsWith('/')) return { kind: 'absolute' }
  const top = token.split('/')[0]
  if (Object.hasOwn(GENERATED, top)) return { kind: 'generated' }
  if (Object.hasOwn(NOT_PATHS, token)) return { kind: 'not-a-path' }
  // A colon is a container reference, a JVM property or a task name, and none of those is a
  // file. It is also how a document points at a line: the part before the last colon is a
  // path, and that is the part a rename has to reach.
  if (token.includes(':')) {
    const head = token.slice(0, token.lastIndexOf(':'))
    return shaped(head) && TOPS.has(head.split('/')[0]) ? { kind: 'path', at: head } : { kind: 'qualified' }
  }
  if (TOPS.has(top)) return { kind: 'path', at: token }
  if (BARE_FILE.test(token) || BARE_DIR.test(token)) {
    const at = under(token, block)
    if (at !== null) return { kind: 'beside', at }
    if (MANIFEST.test(block.file) && isKey(block, token)) return { kind: 'key' }
    return { kind: 'unresolved' }
  }
  return { kind: 'unclassified' }
}

// The line a pointer is on, from the block's own per-character map.
const where = (block, at = 0) => block.file + ':' + (block.lineOf[Math.min(at, block.lineOf.length - 1)] ?? 0)

// The identifier shape: a backticked name with a path beside it, in a parenthesis or after
// 'in'. Only a module is read, because a page declares no name and a shell function is a
// different shape.
const SYMBOL = /`([A-Za-z_$][\w$]*)`\s*(?:\(\s*`?([\w./-]+)`?\s*\)|\b(?:in|from)\s+`([\w./-]+)`)/g
const declares = (file, name) => new RegExp('(?:^|[^\\w$.])(?:export\\s+)?(?:async\\s+)?' +
  '(?:function|const|let|var|class)\\s+' + name + '\\b', 'm').test(read(file))

// The page shape: a quoted section title beside a page, as '"title" in docs/page.md'. The
// page has to hold a heading with the title in it, because the sentence sends a reader to a
// section and not to the page, and a heading may carry a parenthetical after the title.
const SECTION = /"([^"]{3,})"\s+(?:in|of|under)\s+`([^\s`]+\.md)`/g
const headlined = (page, title) => read(page).split('\n')
  .some(line => /^#{1,6}\s/.test(line) && line.includes(title))

function scan () {
  const counts = {
    path: 0, prose: 0, beside: 0, key: 0, symbol: 0, section: 0,
    pattern: 0, absolute: 0, generated: 0, qualified: 0, notPath: 0, word: 0
  }
  const missing = []
  const unresolved = []
  const unclassified = []
  const undeclared = []
  const sections = []
  const seen = new Set()
  for (const file of surfaces()) {
    for (const block of blocks(file)) {
      // Prose is read for the tokens shaped like a path, and a code span is read whole: a
      // backticked word is a pointer the writer chose, and a prose word is a word.
      const prose = proseTokens(block).filter(({ token }) => TOPS.has(token.split('/')[0]))
      const tokens = [...spanTokens(block), ...prose]
      for (const { token, at, prose } of tokens) {
        const { kind, at: names } = classify(block, token)
        if (kind === 'path') {
          counts.path += 1
          if (prose) counts.prose += 1
          if (!fs.existsSync(path.join(ROOT, names))) missing.push(where(block, at) + ' names ' + names)
        } else if (kind === 'beside' || kind === 'key') counts[kind] += 1
        else if (kind === 'unresolved') unresolved.push(where(block, at) + ' names ' + token)
        else if (kind === 'unclassified') unclassified.push(where(block, at) + ' names ' + token)
        else if (kind === 'not-a-path') { counts.notPath += 1; seen.add(token) }
        else if (kind !== 'word') counts[kind] += 1
        else counts.word += 1
      }
      for (const match of block.text.matchAll(SECTION)) {
        const [, title, page] = match
        if (!fs.existsSync(path.join(ROOT, page))) continue
        counts.section += 1
        if (!headlined(page, title)) sections.push(where(block, match.index) + ' names the section "' + title + '" of ' + page)
      }
      for (const match of block.text.matchAll(SYMBOL)) {
        const name = match[1]
        const target = match[2] ?? match[3]
        if (!/\.(?:js|mjs)$/.test(target) || !TOPS.has(target.split('/')[0])) continue
        if (!fs.existsSync(path.join(ROOT, target))) continue
        counts.symbol += 1
        if (!declares(target, name)) undeclared.push(where(block, match.index) + ' puts ' + name + ' in ' + target)
      }
    }
  }
  return { counts, missing, unresolved, unclassified, undeclared, sections, seen }
}

test('every path a surface names is in the tree', () => {
  const { missing } = scan()
  assert.deepEqual(missing, [], 'a document sends a reader to a file this tree does not have:\n- ' +
    missing.join('\n- ') +
    '\nName the path that exists, or move the sentence to where the work landed (#845)')
})

test('a bare name resolves where its block points, or is that manifest\'s key', () => {
  const { unresolved } = scan()
  assert.deepEqual(unresolved, [], 'a document names a file a reader cannot find:\n- ' +
    unresolved.join('\n- ') +
    '\nA bare name resolves under a directory its block names in backticks, or beside the file ' +
    'that names it. Name the directory, or name the key if that is what it is')
})

test('no slash-bearing token goes unclassified', () => {
  const { unclassified } = scan()
  assert.deepEqual(unclassified, [], 'a document names something this file cannot classify:\n- ' +
    unclassified.join('\n- ') +
    '\nName the path that exists, or add the token to NOT_PATHS in this file with the reason ' +
    'no file answers for it')
})

test('an identifier a surface puts beside a path is declared in that file', () => {
  const { undeclared } = scan()
  assert.deepEqual(undeclared, [], 'a document names a function beside a file that has no such declaration:\n- ' +
    undeclared.join('\n- ') +
    '\nThe sentence and the module move in one commit: name the function the file declares, or ' +
    'the file that declares this one')
})

test('a section a surface names is a heading in the page it names', () => {
  const { sections } = scan()
  assert.deepEqual(sections, [], 'a document sends a reader to a section a page does not have:\n- ' +
    sections.join('\n- ') +
    '\nName the heading that is there, or point at the file and let the page hold its own headings')
})

test('every entry in NOT_PATHS still names a token a surface writes', () => {
  const { seen } = scan()
  const orphaned = Object.keys(NOT_PATHS).filter(token => !seen.has(token))
  assert.deepEqual(orphaned, [], 'NOT_PATHS explains ' + orphaned.join(', ') + ', and no surface writes it. ' +
    'Drop the entry, or say which surface kept it')
})

// A failure has to land the reader on the pointer's own line, and a block may be a wrapped
// comment run: the map is per character, so a token in the middle of a block is not on the
// line the block starts at. Every token is held to the source line that holds it.
test('a failure names the source line its pointer is on', () => {
  const wrong = []
  let wrapped = 0
  let checked = 0
  for (const file of surfaces()) {
    const source = read(file).split('\n')
    for (const block of blocks(file)) {
      if (new Set(block.lineOf).size > 1) wrapped += 1
      const tokens = [...spanTokens(block), ...proseTokens(block).filter(({ token }) => TOPS.has(token.split('/')[0]))]
      for (const { token, at } of tokens) {
        const { kind, at: names } = classify(block, token)
        if (kind !== 'path') continue
        checked += 1
        if (!(source[block.lineOf[at] - 1] ?? '').includes(names)) {
          wrong.push(where(block, at) + ' for ' + names + ', and that line does not hold it')
        }
      }
    }
  }
  assert.deepEqual(wrong, [], 'a pointer is reported on a line that does not hold it, so a failure sends ' +
    'its reader to the wrong sentence:\n- ' + wrong.join('\n- '))
  assert.ok(wrapped > 10, 'only ' + wrapped + ' blocks of these surfaces span more than one line, so this ' +
    'case cannot show that a line is mapped rather than assumed')
  assert.ok(checked > 100, 'this case checked ' + checked + ' tokens, and the surfaces write more')
})

// A surface this file failed to read passes every case above without looking, so the read
// is proved: both documents, a path, a bare name, and one name the tree declares.
test('the guard reads both surfaces, a path, a bare name and a declared identifier', () => {
  const { counts } = scan()
  const named = surfaces()
  assert.ok(named.includes(AGENTS), AGENTS + ' is not one of the documents this file reads')
  assert.ok(named.length >= 30, 'the deploy manifests are read, and this file found ' + named.length +
    ' documents: a surface that is not read is a surface whose pointers are not checked')
  assert.ok(counts.path >= 60, 'this file read ' + counts.path + ' path tokens, and a document set this ' +
    'size names more: a rewrite that drops most of them is one this guard can no longer speak for')
  assert.ok(counts.prose >= 20, 'this file read ' + counts.prose + ' paths outside a code span, and the ' +
    'manifests write more: the #721 sentence wrote one in plain parentheses, and that is the shape ' +
    'this half reads')
  assert.ok(counts.beside + counts.key >= 5, 'no bare name was read under ' + (counts.beside + counts.key) + ', ' +
    'so nothing resolves one: the Repo map names a bare file beside the directory that holds it')
  assert.ok(counts.symbol >= 3, 'the surfaces name ' + counts.symbol + ' identifiers beside a path, and ' +
    'this file reads them: a sentence reworded to name no identifier is one the shape cannot follow, ' +
    'so name the identifier beside its path again')
  assert.ok(counts.section >= 1, 'the surfaces name ' + counts.section + ' sections beside a page, and this ' +
    'file reads them: "title" in a page is the shape a section rename breaks, so quote the heading')
  if (process.env.POINTER_COUNTS) {
    console.log('pointers: ' + JSON.stringify(counts))
    console.log('followed: ' + (counts.path + counts.beside + counts.key + counts.symbol + counts.section) +
      ', pointer-shaped and not followed: ' +
      (counts.pattern + counts.absolute + counts.generated + counts.qualified + counts.notPath))
    console.log('documents: ' + named.length + ' (' + AGENTS + ' and ' + (named.length - 1) + ' manifests)')
  }
})

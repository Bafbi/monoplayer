// Three surfaces point a reader at files in this tree, and no case read a pointer in the
// third (#878). AGENTS.md and the deploy manifests were #845's two, and both stale pointers
// that reached main were one shape: a sentence that still resolves to a file after the fact
// moved out of it. AGENTS.md said the header of src/service/monoplayer.js lists the leg
// interfaces, which #763 emptied, and deploy/dev/monoplayer.yaml named src/core/identity.js
// for a session step #721 deleted. The comment inside a src/ file is the third surface, and
// it is where the drift keeps landing: #758's capability, #763's interface list and #691's
// identifier were all a sentence in a source file, and each needed a hand-written guard of
// its own. Four guards over one shape is the defect #592 built tables to avoid, so this file
// is where the pointer grammar lives and the source comment is a third surface it reads. A
// per-subject case under test/tooling/ keeps the claim half, which is the fact no pointer can
// carry. The file walk and the comment-run reader here are a third copy of a shape #862 is
// the ticket to give one home; until then they live beside the two surfaces they serve.
//
// The cheap half of a pointer is its path, and that half is checkable. Every code span in
// every surface is split into tokens, and a path written as prose is read as well, because a
// backtick is not what makes a reader follow a path: #721's sentence wrote
// (src/core/identity.js) in plain parentheses. A prose token is asked for in the tree when it
// starts at a repo top-level directory, or when its last segment is a file name, because a
// source comment writes (custody/accounts.js) the same way and that is the #721 shape. A
// token shaped like a pointer is asked for here, and a renamed directory, a moved module and
// a deleted manifest all fail, naming the file, the line and the token.
//
// A bare name is a pointer too, and a reader cannot resolve one alone. In a document or a
// manifest it resolves under a directory its own block names in backticks, or beside the
// manifest that names it, or it is a key in that manifest and never a file:
// deploy/manifests/configmap.yaml names its two committed seeds this way. A bare name none
// of those holds fails, so the fix is a path a reader can follow.
//
// A source comment is the exception, and it is the subset this file reads there: **a token
// with no slash in a comment is a word, backticked or not.** src/ writes a runtime key, a
// custody directory on the volume, and a module the sentence has already scoped that way, and
// none of those is a file a reader can follow alone. A reader who needs one writes a slash.
// This is the one place the two halves of a surface are read differently, and it is why
// state-parity.js gets one sentence read and the next one word: 'core/join-synth.js' is
// resolved, 'clientbound-policy.js' beside it is not. #915 carries that gap.
//
// A path written inside a source file is often rooted at the folder the reader is standing
// in: a comment in src/ladder/state-parity.js says core/join-synth.js where the file is
// src/core/join-synth.js. Every directory between the file and the repo root is a base,
// nearest first, and the answer is pinned to the first that holds the token. A rename leaves
// the token resolving nowhere, so the sentence fails here and the fix is the path a reader
// can follow.
//
// The expensive half is a name inside a file that exists, and two shapes of it are cheap to
// read. One is a backticked identifier with a path beside it, as 'x in path' or 'x (path)':
// the file has to declare the identifier. The other is a quoted section title beside a page,
// as '"title" in page': the page has to hold a heading with the title in it, which is the
// shape a section rename breaks. A page named first, with its title after a comma or in a
// parenthesis, is the same claim the other way round, and it is read too (#965). A sentence
// that names a module and no identifier is not read, and neither is an identifier with no path
// beside it, because deciding which sentence names the right module is a reviewer's call and
// not a parse. What is compared is names: a row that points at a file which exists and no
// longer holds the fact is stale in a way nothing here can see.
//
// A name with no extension is neither a path nor a bare name to this file: `Dockerfile` in a
// sentence is a word, and a rename of it stays green. So does a path inside a package the
// tree installs, a directory the tree argues against having, and a file a run writes and git
// ignores: NOT_PATHS carries each with the reason no file answers for it, and a row whose path
// appears in the tree fails, so a counterfactual is dropped the day it is built.
//
// What no surface is read for at all, in the order the counts print it: a pointer to a
// concept rather than a symbol; a bare name in a source comment; a path at an absolute
// address, which is a URL or a served route rather than a file here; a token with a line
// number whose head is not rooted at a repo directory; a token holding a placeholder, an
// alternation or an ellipsis, because a shape is not a name; a name with no extension; and
// every file outside these three surfaces, because no guard reads a comment in one. That is a
// decision rather than a gap in the walk: #937 measured a test/ surface and declined it. Most of
// what a test/ surface lands names no file in this tree, because a test comment quotes a shape, a
// library's module or a route. The drift it does find is real, and that is the price the decision
// accepts: a test file a rename deleted is named in one header as a path the sweep follows, and in
// the next as a bare name it reads as a word. The UNREAD table below holds a row per tree that
// holds prose.
//
// The counts are the coverage this file has. Run it with POINTER_COUNTS=1 to print them: the
// comments swept, the pointers it follows, the pointer-shaped tokens it does not, and the
// words it rejects.
//
// Nothing here opens a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The three surfaces. AGENTS.md is the document every agent reads first, a manifest comment
// is where a fact gets restated beside the value it describes, and a source comment is the
// same restatement one module over. The runbooks under deploy/ are other guards' business:
// dev-lane.test.js holds the whitelist section of deploy/dev/README.md, and
// driver-doc-lane.test.js holds the gate's.
const AGENTS = 'AGENTS.md'
const MANIFEST = /\.ya?ml$/
const SOURCE = /\.js$/
const tree = directory => fs.readdirSync(path.join(ROOT, directory), { recursive: true })
  .map(name => path.posix.join(directory, name.split(path.sep).join('/')))
  .sort()
const surfaces = () => [
  { file: AGENTS, kind: 'document' },
  ...tree('deploy').filter(name => MANIFEST.test(name)).map(file => ({ file, kind: 'manifest' })),
  ...tree('src').filter(name => SOURCE.test(name)).map(file => ({ file, kind: 'comment' }))
]

const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// A document is read in blocks, not in lines: a row of a table, an item of a list and a run
// of comment lines are each one claim, and a sentence that wraps still reads as one. A
// manifest's data is not prose, so a manifest's blocks are its comment runs alone, and a
// source file's code is not prose either, so its blocks are the whole-line // and /* */ runs.
// A comment after code on the same line is not read, because the line's prefix is what
// decides, and nothing in this tree writes a pointer there that a whole-line comment does not.
const NEW_BLOCK = /^\s*(?:[-*]\s|\||\d+\.\s)/
// A wrap inside a path is not a space. Comments under src/ split a path at the hyphen
// (docs/adr/keep-relative-moves-out-of-the-entity- then ring.md) and at the slash
// (src/ladder/ then state-parity.js), and joining either with a space asks the tree for a
// file that was never named. So a line ending in - or / joins the next one. The slash needs a
// lookahead, because a sentence wraps there too: 'lands in public/' then 'is not served' is
// two words, and only a next word shaped like a file name is the rest of the path.
const firstWord = text => text.split(/[^\w.-]/)[0]
const SEPARATOR = (text, next) => {
  if (text === '') return ' '
  if (text.endsWith('-') && /^[a-z0-9]/.test(next)) return ''
  if (text.endsWith('/') && BARE_FILE.test(firstWord(next))) return ''
  return ' '
}
function blocks (surface) {
  const { file, kind } = surface
  const out = []
  let current = null
  const flush = () => { if (current !== null) out.push(current); current = null }
  // A block carries the source line of every character it holds, because a failure has to
  // name the line the pointer is on and a block may be a paragraph.
  const add = (index, text) => {
    if (current === null) current = { file, kind, text: '', lineOf: [] }
    if (current.text !== '') {
      const joiner = SEPARATOR(current.text, text)
      current.text += joiner
      current.lineOf.push(...new Array(joiner.length).fill(index + 1))
    }
    current.text += text
    current.lineOf.push(...new Array(text.length).fill(index + 1))
  }
  let inBlock = false
  for (const [index, line] of read(file).split('\n').entries()) {
    if (kind === 'comment') {
      const trimmed = line.trim()
      if (inBlock) {
        const end = trimmed.indexOf('*/')
        const body = end === -1 ? trimmed : trimmed.slice(0, end)
        const text = body.replace(/^\*\s?/, '')
        if (text.trim() === '') flush()
        else add(index, text)
        if (end !== -1) { inBlock = false; flush() }
        continue
      }
      if (trimmed.startsWith('//')) {
        const text = trimmed.replace(/^\/\/\s?/, '')
        if (text.trim() === '') flush()
        else add(index, text)
        continue
      }
      flush()
      if (trimmed.startsWith('/*')) {
        const end = trimmed.indexOf('*/', 2)
        const text = (end === -1 ? trimmed.slice(2) : trimmed.slice(2, end)).replace(/^\*\s?/, '')
        if (text.trim() === '') flush()
        else add(index, text)
        if (end === -1) inBlock = true
        else flush()
      }
      continue
    }
    if (kind === 'manifest') {
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
    token: possessive(token[0].replace(/^\((.*)\)$/, '$1').replace(/[,;]$/, '')),
    at: start + token.index,
    prose: false
  }))
})
const spanBases = block => [...block.text.matchAll(SPAN)].map(([, span]) => span)

// A path a comment owns: 'src/core/picker.js's header' is that path with a possessive on it,
// and a reader follows the same characters. A source comment writes this shape far more than
// a page does, so the strip lives here rather than in an escape entry per file.
const possessive = token => token.replace(/(?:'s|\u2019s)$/, '')
const edge = raw => {
  let token = raw.replace(/^[("'[]+/, '')
  while (token.length > 3 && /[.,;:)"'\]]$/.test(token)) {
    const next = token.slice(0, -1)
    if (next.endsWith('..')) break
    token = next
  }
  return possessive(token)
}
// A markdown link is two pointers, its text and its target, and a link to a file this tree
// does not have is the same stale pointer as a sentence. link() is the split that keeps both.
const link = raw => raw.replace(/^[("'[]+/, '').replace(/[,;:)"'\]]+$/, '').split('](')
const proseTokens = block => [...block.text.replace(SPAN, whole => ' '.repeat(whole.length)).matchAll(/\S+/g)]
  .flatMap(match => link(match[0]).map(half => ({ token: edge(half), at: match.index, prose: true })))

// Where the tree keeps something a surface may not point at, and why a pointer there is not
// a stale pointer: a run's output, a throwaway script, the account custody, a package.
const GENERATED = {
  '.reports': 'a task run writes it, and git ignores it',
  '.scratch': 'a throwaway script or artifact lives there, and git ignores it',
  '.git': 'the repository\'s own store, and a reader follows no pointer into it',
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

// A shape, not a path: a placeholder, an alternation of commands, an ellipsis, a character
// class, a shell substitution. A source comment writes a regex and a command beside its path
// often enough that each is its own class here: [a-z0-9/._-] is a range of characters,
// $(scripts/x.sh is the head of a command line, and neither is a file.
const PATTERN = /[<>*|[\]\u2026]|\$\(|\.\.\./

// The directories at the repo root a path can start with, read from the tree so a new
// top-level directory needs no edit here. The generated trees are excluded first, because a run
// may leave one behind and none of them is a reader's to follow. hasOwn and not `in`, because
// `in` reaches Object.prototype: a token named constructor is not a generated path.
const TOPS = new Set(fs.readdirSync(ROOT)
  .filter(name => !Object.hasOwn(GENERATED, name))
  .filter(name => { try { return fs.statSync(path.join(ROOT, name)).isDirectory() } catch { return false } }))

// A slash-bearing token that is not a path, and why. Each is a name a package, the cluster, the
// tracker or a directory this tree argues against resolves, and this tree does not hold it. A
// new one fails until it says the same, and an entry no surface writes fails too.
const NOT_PATHS = {
  'Bafbi/monoplayer': { why: 'a tracker slug: the gh CLI reads owner/repo, and this tree holds no such path' },
  'deploy/monoplayer': { why: 'a Deployment the kubectl command in that comment names, as kind/name: the ' +
    'cluster resolves it and no file here holds it' },
  'src/protocol/': { why: 'a directory this tree deliberately does not have: the comment argues why the ' +
    'work lives in src/core/ under a domain name instead (#15)' },
  'src/client.js': { why: 'a file inside the installed package: the span before it names ' +
    'minecraft-protocol, so the path is the library\'s and not this tree\'s (#820)' },
  'testdata/driver-summary.json': { output: true,
    why: 'a report a driver run writes, and git ignores testdata/*.json: the run creates it, so a ' +
      'checkout may hold it and no tree does' },
  'testdata/spike-report.json': { output: true,
    why: 'a report the spike runner writes, and git ignores testdata/*.json: the run creates it, so a ' +
      'checkout may hold it and no tree does' },
  'msa.js/status.js': { why: 'two modules written as one token, msa.js and status.js beside it, and a ' +
    'reader follows either name rather than the pair' },
  'datatypes/compiler-minecraft.js': { why: 'a path inside the installed package: a comment beside it ' +
    'names minecraft-data, and the directory is the library\'s, not this tree\'s' },
  'minecraft-protocol/src/server.js': { why: 'a path inside the installed package: the token starts with ' +
    'the library\'s own name, and this tree holds no such directory' },
  'state/name': { why: 'a protocol coordinate, the pair tools/protocol.mjs walks a frame by: the two ' +
    'words are a state and a packet name, and no file holds them' },
  'application/merge-patch+json': { why: 'a media type, not a path: RFC 7386 names the merge patch, and ' +
    'a comment quoting it names no file' },
  'text/plain': { why: 'a media type, not a path: the comment says what a browser safelists, and a ' +
    'comment quoting it names no file' }
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

// Where a path written inside a source file resolves when it is rooted at no repo top-level
// directory. A comment in src/ladder/state-parity.js says core/join-synth.js for what the tree
// holds at src/core/join-synth.js, because the reader is standing in src/. Every directory
// between the file and the repo root is a base, nearest first, and the answer is pinned to the
// first that holds the token: a rename leaves it resolving nowhere, so the sentence fails here.
function nearby (token, block) {
  if (block.kind !== 'comment') return null
  if (!token.includes('/') || token.endsWith('/')) return null
  if (TOPS.has(token.split('/')[0])) return null
  let base = path.posix.dirname(block.file)
  while (true) {
    const at = path.posix.normalize(path.posix.join(base === '.' ? '' : base, token))
    if (fs.existsSync(path.join(ROOT, at))) return at
    if (base === '.' || base === '') return null
    base = path.posix.dirname(base)
  }
}

// Which prose token a surface asks the tree about. A path rooted at a repo directory is one.
// So, in a source comment, is any token whose last segment is a file name: src/ writes a
// relative path in plain parentheses, and (custody/accounts.js) is a pointer a reader follows
// with nothing in front of it to say where. A prose word with a slash in it, and/or and 2/2
// and I/O, has no such segment and stays a word.
const askable = (token, block) => TOPS.has(token.split('/')[0]) ||
  (block.kind === 'comment' && token.includes('/') && !token.endsWith('/') &&
    BARE_FILE.test(token.split('/').pop()))

// A bare name that is a key in the manifest naming it is not a file, and it is still a
// pointer: the key is what the operator copies. A renamed key fails here.
const isKey = (block, token) => block.kind === 'manifest' &&
  new RegExp('^\\s*"?' + literal(token) + '"?\\s*:', 'm').test(read(block.file))

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
  // A source comment is the surface where a bare name is prose, so it is a word before it is
  // ever asked for in the tree: src/ writes a runtime key, a custody directory and a module
  // the sentence already scoped that way, and none of those is a file a reader can follow alone.
  if (block.kind === 'comment' && (!token.includes('/') || token.endsWith('/'))) return { kind: 'word' }
  const at = nearby(token, block)
  if (at !== null) return { kind: 'path', at, nearby: true }
  if (block.kind === 'comment' && token.includes('/')) return { kind: 'unresolved' }
  if (BARE_FILE.test(token) || BARE_DIR.test(token)) {
    const beside = under(token, block)
    if (beside !== null) return { kind: 'beside', at: beside }
    if (isKey(block, token)) return { kind: 'key' }
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

// A path beside a name, resolved the way a token is: from a repo top-level directory, or from
// the directory the source file stands in.
const resolve = (token, block) => {
  if (!shaped(token) || PATTERN.test(token)) return null
  if (TOPS.has(token.split('/')[0])) return fs.existsSync(path.join(ROOT, token)) ? token : null
  return nearby(token, block)
}

// The page shape: a quoted section title beside a page, in either order. The page has to hold a
// heading with the title in it, because the sentence sends a reader to a section and not to the
// page, and a heading may carry a parenthetical after the title.
//
// A comment that sends a reader to two sections of one page writes both titles before the one
// page: '"Backend matrix" and "Pins that matter" in `docs/driver-lane-plan.md`'. The run of titles
// is one claim about one page, so every title in it is asked for; reading only the last would
// leave the first heading free to be renamed (#957).
//
// A title after the page is the same claim the other way round, as '`docs/telemetry.md`, under
// "The per-body and per-channel groups"' or 'docs/driver-lane.md ("Reaching the dev lane")'.
// #957 rewrote the five sentences written that way and left the grammar that missed them, so the
// class stayed open (#965). The separator is a comma, an opening parenthesis, or a comma and the
// connector word the sentence keeps, as in '`page`, under "title"'. The page may stand as prose,
// because the shape this reads is the one a sentence writes. A page followed by prose and then a
// quotation is not a section pointer: the header of src/legs/live-front.js writes
// 'docs/telemetry.md says the reason is "..."', and no heading holds that sentence.
const PAGE = '[\\w][\\w./-]*\\.md'
const TITLES = '(?:"[^"]{3,}"(?:\\s*(?:,|and)\\s*)?)+'
const SECTION = new RegExp('(' + TITLES + ')\\s+(?:in|of|under)\\s+`(' + PAGE + ')`', 'g')
const SECTION_PAGE_FIRST = new RegExp('`?(' + PAGE + ')`?\\s*(?:,\\s*(?:(?:in|of|under)\\s+)?|\\(\\s*)(' + TITLES + ')', 'g')
const titlesOf = run => [...run.matchAll(/"([^"]{3,})"/g)].map(match => match[1])
const headlined = (page, title) => read(page).split('\n')
  .some(line => /^#{1,6}\s/.test(line) && line.includes(title))

// One block's page pointers: how many titles it asks a page for, and the ones the page does not
// hold. The case below drives this with a block it builds, because the tree writes one page-first
// pointer and one instance cannot hold the arm.
function sectionsOf (block) {
  const out = { followed: 0, wrong: [] }
  const claim = (page, run, at) => {
    if (!fs.existsSync(path.join(ROOT, page))) return
    for (const title of titlesOf(run)) {
      out.followed += 1
      if (!headlined(page, title)) out.wrong.push(where(block, at) + ' names the section "' + title + '" of ' + page)
    }
  }
  for (const match of block.text.matchAll(SECTION)) claim(match[2], match[1], match.index)
  for (const match of block.text.matchAll(SECTION_PAGE_FIRST)) claim(match[1], match[2], match.index)
  return out
}

function scan () {
  const counts = {
    path: 0, prose: 0, beside: 0, key: 0, symbol: 0, section: 0, nearby: 0,
    pattern: 0, absolute: 0, generated: 0, qualified: 0, notPath: 0, word: 0
  }
  const swept = { document: 0, manifest: 0, comment: 0 }
  const files = { document: 0, manifest: 0, comment: 0 }
  const missing = []
  const unresolved = []
  const unclassified = []
  const undeclared = []
  const sections = []
  const seen = new Set()
  for (const surface of surfaces()) {
    files[surface.kind] += 1
    for (const block of blocks(surface)) {
      swept[surface.kind] += 1
      // Prose is read for the tokens shaped like a path, and a code span is read whole: a
      // backticked word is a pointer the writer chose, and a prose word is a word.
      const prose = proseTokens(block).filter(({ token }) => askable(token, block))
      const tokens = [...spanTokens(block), ...prose]
      for (const { token, at, prose } of tokens) {
        const { kind, at: names, nearby: relative } = classify(block, token)
        if (kind === 'path') {
          counts.path += 1
          if (prose) counts.prose += 1
          if (relative) counts.nearby += 1
          if (!fs.existsSync(path.join(ROOT, names))) missing.push(where(block, at) + ' names ' + names)
        } else if (kind === 'beside' || kind === 'key') counts[kind] += 1
        else if (kind === 'unresolved') unresolved.push(where(block, at) + ' names ' + token)
        else if (kind === 'unclassified') unclassified.push(where(block, at) + ' names ' + token)
        else if (kind === 'not-a-path') { counts.notPath += 1; seen.add(token) }
        else if (kind !== 'word') counts[kind] += 1
        else counts.word += 1
      }
      const held = sectionsOf(block)
      counts.section += held.followed
      sections.push(...held.wrong)
      for (const match of block.text.matchAll(SYMBOL)) {
        const name = match[1]
        const at = resolve(match[2] ?? match[3], block)
        if (at === null || !/\.(?:js|mjs)$/.test(at)) continue
        counts.symbol += 1
        if (!declares(at, name)) undeclared.push(where(block, match.index) + ' puts ' + name + ' in ' + at)
      }
    }
  }
  return { counts, swept, files, missing, unresolved, unclassified, undeclared, sections, seen }
}


test('every path a surface names is in the tree', () => {
  const { missing } = scan()
  assert.deepEqual(missing, [], 'a surface sends a reader to a file this tree does not have:\n- ' +
    missing.join('\n- ') +
    '\nName the path that exists, or move the sentence to where the work landed (#845, #878)')
})

test('a bare name resolves where its block points, or is that manifest\'s key', () => {
  const { unresolved } = scan()
  assert.deepEqual(unresolved, [], 'a surface names a file a reader cannot find:\n- ' +
    unresolved.join('\n- ') +
    '\nA bare name resolves under a directory its block names in backticks, or beside the file ' +
    'that names it, and a path in a source comment resolves from a directory between that file ' +
    'and the repo root. Name the path a reader can follow')
})

test('no slash-bearing token goes unclassified', () => {
  const { unclassified } = scan()
  assert.deepEqual(unclassified, [], 'a surface names something this file cannot classify:\n- ' +
    unclassified.join('\n- ') +
    '\nName the path that exists, or add the token to NOT_PATHS in this file with the reason ' +
    'no file answers for it')
})

test('an identifier a surface puts beside a path is declared in that file', () => {
  const { undeclared } = scan()
  assert.deepEqual(undeclared, [], 'a surface names a function beside a file that has no such declaration:\n- ' +
    undeclared.join('\n- ') +
    '\nThe sentence and the module move in one commit: name the function the file declares, or ' +
    'the file that declares this one')
})

test('a section a surface names is a heading in the page it names', () => {
  const { sections } = scan()
  assert.deepEqual(sections, [], 'a surface sends a reader to a section a page does not have:\n- ' +
    sections.join('\n- ') +
    '\nName the heading that is there, or point at the file and let the page hold its own headings')
})

// A comment this file builds rather than reads. `headlined` opens the page itself, so the page is
// real and the title is one it holds or one it does not.
const blockOf = (file, text) => ({ file, kind: 'comment', text, lineOf: new Array(text.length + 1).fill(1) })

// The page-first arm is held here, not by the tree's one instance. Rewrite that sentence
// (src/service/start-live.js) and the arm is dead code no case reads, which is the coverage #965
// was filed for. Every title below is a heading of a real page, except the one the case asserts is
// missing, and the last two statements must not fire at all.
test('a page named first is read for its heading, in a parenthesis or after a comma', () => {
  const page = 'docs/telemetry.md'
  const title = 'The per-body and per-channel groups'
  const says = text => sectionsOf(blockOf('src/service/start-live.js', text))

  const comma = says('`' + page + '`, under "' + title + '", defines every field below')
  assert.equal(comma.followed, 1, 'a page named first with its title after a comma is one section ' +
    'pointer, and this file reads it: ' + JSON.stringify(comma))
  assert.deepEqual(comma.wrong, [], 'the page holds that heading, so the pointer is not a failure')

  const parenthesis = says(page + ' ("' + title + '")')
  assert.equal(parenthesis.followed, 1, 'a page named first with its title in a parenthesis is the ' +
    'same claim the other way round, and this file reads it: ' + JSON.stringify(parenthesis))

  const two = says('`' + page + '`, "' + title + '" and "The heartbeat record"')
  assert.equal(two.followed, 2, 'a run of titles after one page is one claim about that page, so ' +
    'both headings are asked for: ' + JSON.stringify(two))
  assert.deepEqual(two.wrong, [], 'both titles are headings of that page, so neither is a failure')

  const missing = says('`' + page + '`, "No heading in this page"')
  assert.equal(missing.wrong.length, 1, 'a page named first is read for the heading it names, so a ' +
    'title the page does not hold fails here: ' + JSON.stringify(missing))
  assert.match(missing.wrong[0], /names the section "No heading in this page" of docs\/telemetry\.md/,
    'the failure names the title and the page it is missing from')

  const noTitle = says('`' + page + '` is where those groups are defined')
  assert.equal(noTitle.followed, 0, 'a page with no title beside it is not a section pointer: ' +
    JSON.stringify(noTitle))

  const prose = says(page + ' says the reason is "the body\'s configuration replay wrote no frame"')
  assert.equal(prose.followed, 0, 'the words between a page and a quotation are not a separator: ' +
    JSON.stringify(prose))

  const aside = says(page + ', and the note "that number is not a measurement" is beside it')
  assert.equal(aside.followed, 0, 'a comma and prose before a quotation is not a separator either, ' +
    'unless that prose is the connector in, of or under: ' + JSON.stringify(aside))
})

// An entry that outlives the token it explains is the same stale pointer one table over, so the
// table is held the way shim-default.test.js holds its exemptions: every row is still written,
// every row still says why, and a row whose path has appeared fails. A reason short enough to be
// a restatement is no reason.
test('every entry in NOT_PATHS still names a token a surface writes, says why, and is not a file', () => {
  const { seen } = scan()
  const orphaned = Object.keys(NOT_PATHS).filter(token => !seen.has(token))
  assert.deepEqual(orphaned, [], 'NOT_PATHS explains ' + orphaned.join(', ') + ', and no surface writes it. ' +
    'Drop the entry, or say which surface kept it')
  const thin = Object.entries(NOT_PATHS).filter(([, row]) => row.why.length <= 40).map(([token]) => token)
  assert.deepEqual(thin, [], 'NOT_PATHS gives ' + thin.join(', ') + ' a reason too short to say why. ' +
    'A row without its reason is the drift this table exists to stop, so say what resolves the token instead')
  // A row still explains a token no file answers for. A path that appears in the tree makes the row a
  // lie and shadows the check that would catch a rename, so the row goes with the sentence that
  // argued for it. A run's own output is the exception: git ignores it, so a checkout may hold one.
  const built = Object.entries(NOT_PATHS)
    .filter(([, row]) => row.output !== true)
    .filter(([token]) => TOPS.has(token.split('/')[0]) && fs.existsSync(path.join(ROOT, token)))
    .map(([token]) => token)
  assert.deepEqual(built, [], 'NOT_PATHS says ' + built.join(', ') + ' is not a path, and the tree now holds ' +
    'it. This file asks the tree before an entry, so the row hides the pointer: drop the row and the ' +
    'sentence that argued for it, or move the row to the file the path now is')
})

// Every tree this file walks past that holds prose, and the reason no surface reads a comment in
// one (#937). It is a table with a case rather than a sentence, because a sentence about an
// absent reader is what the exclusion was, and it went false within two tickets of being written.
// A row is a directory the walk stops short of: a comment there is read by the person changing the
// file, or by the guard that reads that file for the one fact it owns, and by no sweep. The row
// for test/ carries the decision and the header above carries its reason. The arms below are what
// the table is for: a row whose tree is gone, a row a surface now walks, and a reason too short to
// be one.
const UNREAD = {
  test: { why: 'measured and declined (#937): most of what a surface there lands names no file in ' +
    'this tree, and the comment beside a test is read by whoever edits that test' },
  tools: { why: 'a tool is a program a person runs by hand. A guard that reads one reads a line of ' +
    'it as text for the fact it owns, and a comment there explains a flag to whoever typed the command' },
  scripts: { why: 'a shell script is run by a task, and its header is that task\'s runbook. A guard ' +
    'reads the one line it owns, and no sweep follows a pointer in a comment there' },
  docs: { why: 'a page is prose a person reads. The pages a guard reads are read whole for the fact ' +
    'they own (#870), and a pointer inside one is a reader\'s' },
  testdata: { why: 'a verdict page is dated evidence. The guards that read one read it whole, and ' +
    'what the page points at is the run that wrote it' },
  vendor: { why: 'the vendored 26.2 protocol tree belongs to the library, and this repo edits none of ' +
    'it. A path in its README is that package\'s' },
  '.github': { why: 'a workflow is asserted by the guard that reads its jobs, and CI reads the YAML. ' +
    'A comment in one is a note to whoever edits the workflow' }
}

test('every tree this file walks past says why no surface reads a comment in it', () => {
  const walked = new Set(surfaces().map(({ file }) => file.split('/')[0]))
  const rows = Object.keys(UNREAD).sort()
  const nowRead = rows.filter(dir => walked.has(dir))
  assert.deepEqual(nowRead, [], 'UNREAD says no surface reads a comment in ' + nowRead.join(', ') +
    ', and one walks it: the table and the surface set move in one commit (#937)')
  const gone = rows.filter(dir => !fs.existsSync(path.join(ROOT, dir)))
  assert.deepEqual(gone, [], 'UNREAD names ' + gone.join(', ') + ', and this tree holds no such ' +
    'directory. Drop the row, or name the tree that replaced it')
  // The extensions that carry a prose comment. A tree of .json, .jsonl or .toml holds data, so
  // .gate-b is a tree with no row: a run wrote its report there, and a reader follows nothing in it.
  const SILENT = /\.(?:js|mjs|cjs|md|ya?ml|sh)$/
  const trees = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !Object.hasOwn(GENERATED, entry.name) && !walked.has(entry.name))
    .filter(entry => tree(entry.name).some(name => SILENT.test(name)))
    .map(entry => entry.name)
  const silent = trees.filter(dir => !Object.hasOwn(UNREAD, dir))
  assert.deepEqual(silent, [], 'this file walks past ' + silent.join(', ') + ', and UNREAD says why for ' +
    'no such tree: say why no surface reads a comment there, or walk it (#937)')
  const thin = rows.filter(dir => UNREAD[dir].why.length <= 40)
  assert.deepEqual(thin, [], 'UNREAD gives ' + thin.join(', ') + ' a reason too short to say why. ' +
    'A row without its reason is the sentence this table replaced')
})

// A failure has to land the reader on the pointer's own line, and a block may be a wrapped
// comment run: the map is per character, so a token in the middle of a block is not on the
// line the block starts at. Every token is held to the source line that holds it.
test('a failure names the source line its pointer is on', () => {
  const wrong = []
  let wrapped = 0
  let checked = 0
  for (const surface of surfaces()) {
    const source = read(surface.file).split('\n')
    for (const block of blocks(surface)) {
      if (new Set(block.lineOf).size > 1) wrapped += 1
      const tokens = [...spanTokens(block), ...proseTokens(block).filter(({ token }) => askable(token, block))]
      for (const { token, at } of tokens) {
        const { kind, at: names } = classify(block, token)
        if (kind !== 'path') continue
        checked += 1
        const line = source[block.lineOf[at] - 1] ?? ''
        // A path a comment wrapped at a hyphen or a slash starts on the first of its lines, so
        // that line holds its head: everything up to and including the last slash. Only a
        // genuinely wrapped path gets that arm, so an unwrapped one still has to match whole.
        const wrapped = block.lineOf[at] !== block.lineOf[Math.min(at + token.length - 1, block.lineOf.length - 1)]
        // The line holds the token as the surface writes it, which is the resolved path only
        // when the path was rooted. A comment's own directory is a base the reader supplies.
        const held = line.includes(token) || line.includes(names) ||
          (wrapped && line.includes(names.slice(0, names.lastIndexOf('/') + 1)))
        if (!held) {
          wrong.push(where(block, at) + ' for ' + names + ', and that line does not hold it')
        }
      }
    }
  }
  assert.deepEqual(wrong, [], 'a pointer is reported on a line that does not hold it, so a failure sends ' +
    'its reader to the wrong sentence:\n- ' + wrong.join('\n- '))
  assert.ok(wrapped > 10, 'only ' + wrapped + ' blocks of these surfaces span more than one line, so this ' +
    'case cannot show that a line is mapped rather than assumed')
  assert.ok(checked > 300, 'this case checked ' + checked + ' tokens, and the surfaces write more')
})

// A surface this file failed to read passes every case above without looking, so the read is
// proved: three files of three kinds, a path, a bare name, a path a comment roots at src/, and
// one name the tree declares. The counts are what a rewrite that drops most of a surface costs
// here, and POINTER_COUNTS=1 prints them.
test('the guard reads all three surfaces, a path, a bare name, a nearby path and a declared identifier', () => {
  const { counts, swept, files } = scan()
  assert.ok(files.document === 1 && files.manifest >= 30 && files.comment >= 100,
    'this file reads ' + JSON.stringify(files) + ': one document, the deploy manifests and every .js under src/')
  assert.ok(swept.comment >= 2000, 'this file swept ' + swept.comment + ' comment runs under src/, and ' +
    'the tree writes more: a walk that reads code as prose or stops at the first blank line is what this floor ' +
    'is here to catch')
  assert.ok(counts.path >= 300, 'this file read ' + counts.path + ' path tokens, and three surfaces this ' +
    'size name more: a rewrite that drops most of them is one this guard can no longer speak for')
  assert.ok(counts.prose >= 200, 'this file read ' + counts.prose + ' paths outside a code span, and the ' +
    'surfaces write more: the #721 sentence wrote one in plain parentheses, and that is the shape ' +
    'this half reads')
  assert.ok(counts.beside + counts.key >= 5, 'no bare name was read under ' + (counts.beside + counts.key) + ', ' +
    'so nothing resolves one: the Repo map names a bare file beside the directory that holds it')
  assert.ok(counts.nearby >= 3, 'this file resolved ' + counts.nearby + ' paths from a directory a source ' +
    'comment stands in, and src/ writes more: core/join-synth.js in src/ladder/ is the shape, and a ' +
    'rewrite that stops resolving it turns those checks into words')
  assert.ok(counts.symbol >= 5, 'the surfaces name ' + counts.symbol + ' identifiers beside a path, and ' +
    'this file reads them: a sentence reworded to name no identifier is one the shape cannot follow, ' +
    'so name the identifier beside its path again')
  assert.ok(counts.section >= 5, 'the surfaces name ' + counts.section + ' sections beside a page, and this ' +
    'file reads them in either order: "title" in a page is the shape a section rename breaks, and so is ' +
    'a page with the title after it. Quote the heading, and raise this floor when you add one')
  if (process.env.POINTER_COUNTS) {
    console.log('pointers: ' + JSON.stringify(counts))
    console.log('followed: ' + (counts.path + counts.beside + counts.key + counts.symbol + counts.section) +
      ', pointer-shaped and not followed: ' +
      (counts.pattern + counts.absolute + counts.generated + counts.qualified + counts.notPath))
    console.log('surfaces: ' + JSON.stringify(files) + ', comment runs swept: ' + JSON.stringify(swept))
  }
})

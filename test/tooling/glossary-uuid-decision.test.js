// #747: "verdict" names one thing in this glossary, and two readers borrowed it.
//
// GLOSSARY.md defines Verdict as the pass or fail result of one scenario, with the
// evidence that produced it, and lists result, status, and report as words to avoid.
// Two readers arrived after that entry and used the same word for a different thing:
// a whitelist entry's answer to whether a Mojang session can ever authenticate its
// uuid. scripts/dev-lane.sh reported "a verdict per entry", and src/panel/ rendered
// one per row. Neither is a scenario's pass or fail: no scenario ran, and the answer
// carries no evidence, only a rule about a uuid's shape.
//
// Verdict keeps the word. Its definition is the one a written rule stands behind, and
// the answer both readers wanted is a different concept, so it took its own name: a
// UUID decision, the answer the shape rule returns for one entry's uuid, named the way
// this glossary names the answer its clientbound policy returns for one frame
// (Clientbound decision). Two words that were tried and refused are on the entry's
// _Avoid_ line: "result" and "report" are the synonyms Verdict already bans, and
// "admission" is the pre-auth window's word for a connection (src/legs/live-front.js)
// and the verb this glossary uses for a player the lane lets in.
//
// Four facts have a home, and this guard reads all four:
//
//   the entry's shape    GLOSSARY.md's own entries: a heading, one line, _Avoid_
//   the rule's name      uuidRefusalReason, exported by src/custody/util.js
//   the two call sites   scripts/dev-lane.sh and src/panel/, the places that report it
//   the retired word     "verdict", which none of them writes any more
//
// What is compared is names and one word. The sentence "not a verdict" is not read,
// because a guard that read English would be a guard that lies about what it checked.
// What each call site means is driven by its own tests: test/tooling/dev-lane.test.js
// for the script, and test/panel/page.test.js for the row the page renders.
//
// The word is swept in the four files that report the decision, not in src/panel/ whole.
// "Verdict" is a term this glossary still defines, so a directory-wide ban would fail a
// future line about a real verdict and call it drift. A fifth file that reports the
// decision is a new call site, and the entry is where it gets named.
//
// Nothing here reaches a cluster or a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { uuidRefusalReason } from '../../src/custody/util.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const GLOSSARY = fs.readFileSync(path.join(ROOT, 'GLOSSARY.md'), 'utf8')

// The term, the rule it points at, and the word it replaced at the call sites.
const TERM = 'UUID decision'
const RULE = 'uuidRefusalReason'
const RETIRED = /\bverdicts?\b/i

// The two places #747 answers for. The entry has to name them: a reader who greps for
// the retired word needs to know where it went, and this guard has no other list to
// hold the entry against.
const CALL_SITES = ['scripts/dev-lane.sh', 'src/panel/']

// The class the page draws the decision with, built from the term, so the name travels
// with the entry: a page that renamed the class, or a glossary that renamed the term,
// leaves the two disagreeing and this guard is where it shows.
const CLASS = TERM.toLowerCase().replace(/ /g, '-')

// The files that report the decision, so the word is swept where the claim lives.
// scripts/dev-lane.sh prints the block, the route builds the row, the view renders it,
// and the stylesheet source draws the fault class. The compiled app.css needs no sweep:
// tools/panel-css.mjs --check fails the lint rung when it disagrees with its source.
const SWEPT = [
  'scripts/dev-lane.sh',
  'src/panel/routes/whitelist.js',
  'src/panel/views/whitelist.js',
  'src/panel/public/app.css.in'
]

// A backticked name holding a separator, which is how this glossary writes a path. A
// bare word in backticks is a symbol or a term, and this guard has no claim about one.
const PATH_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/

const names = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

// An entry: one heading, one line of definition, one _Avoid_ list. It ends at the
// _Avoid_ line, so another entry's prose cannot satisfy a claim about this one.
function entry (glossary, term) {
  const lines = glossary.split('\n')
  const heading = lines.findIndex(line => line.startsWith('**' + term + '**:'))
  if (heading === -1) return null
  return { line: heading + 1, body: lines[heading + 1] ?? '', avoid: lines[heading + 2] ?? '' }
}

// The words an _Avoid_ line bans, one per comma. They are plain words, not backticked
// names, so they are read the way the list is written.
const avoidWords = line => line.replace(/^_Avoid_:\s*/, '').split(/[,.]/)
  .map(word => word.trim().toLowerCase()).filter(word => word !== '')

const message = {
  noEntry: 'GLOSSARY.md defines ' + TERM + '. It has no entry, so the answer both call ' +
    'sites report is named only by the places that use it.',
  shape: (where, term) => where + ' is not an entry: the ' + term + ' heading, one line, and ' +
    'its _Avoid_ list. GLOSSARY.md holds one shape for every term, and a term that reads ' +
    'differently is one a reader cannot scan.',
  unnamed: (where, name) => where + ' names no ' + name + '. That is where the answer is ' +
    'reported, and an entry that does not name it leaves a reader to grep for the word it ' +
    'retired with no pointer to where it went.',
  unruled: where => where + ' names no ' + RULE + '. That function is the rule both call sites ' +
    'ask (src/custody/util.js), so an entry that describes the answer without naming the rule ' +
    'leaves a reader to find it in code.',
  unheld: (where, name) => where + ' names ' + name + ', which the tree does not hold. A call ' +
    'site this guard cannot read is a call site it cannot vouch for.',
  banned: (where, word) => where + ' no longer lists "' + word + '" under _Avoid_. The word is ' +
    'what #747 retired at these call sites, and an entry that stops banning it invites the ' +
    'next reader to use it again.',
  retired: (where, name, line) => where + ' writes "' + line + '". ' + name + ' reports a ' +
    'whitelist entry\'s UUID decision, which is whether a Mojang session can authenticate it, ' +
    'and the glossary keeps Verdict for one scenario\'s pass or fail with its evidence (#747).'
}

// The entry's claims, one line per fact that does not hold. The tree is reached through
// readFile, so every case below can hand it a fixture instead of a checkout.
function drift (glossary, readFile) {
  const found = entry(glossary, TERM)
  if (found === null) return [message.noEntry]
  const where = 'GLOSSARY.md:' + found.line
  const problems = []
  if (!found.avoid.startsWith('_Avoid_:')) problems.push(message.shape(where, TERM))
  if (!avoidWords(found.avoid).includes('verdict')) problems.push(message.banned(where, 'verdict'))

  const named = names(found.body)
  const paths = named.filter(name => PATH_NAME.test(name))
  for (const name of CALL_SITES) {
    if (!paths.includes(name)) problems.push(message.unnamed(where, name))
  }
  if (!named.includes(RULE)) problems.push(message.unruled(where))

  for (const name of SWEPT) {
    const text = readFile(name)
    if (text === null) {
      problems.push(message.unheld(where, name))
      continue
    }
    text.split('\n').forEach((line, index) => {
      if (RETIRED.test(line)) problems.push(message.retired(name + ':' + (index + 1), name, line.trim()))
    })
  }
  return problems
}

const tree = name => {
  const full = path.join(ROOT, name)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
}

// One entry that holds every fact the guard reads, so each case below changes one fact
// and no other. A fixture copied from the tree would make a case about whatever the
// tree drifted to.
const BASE = '**' + TERM + '**:\n' +
  'Whether a Mojang session can ever authenticate one attach-whitelist entry\'s uuid, and the ' +
  'reason when none can. \u0060uuidRefusalReason\u0060 in \u0060src/custody/util.js\u0060 is ' +
  'the rule. \u0060scripts/dev-lane.sh\u0060 reports one per entry and \u0060src/panel/\u0060 ' +
  'prints one per row.\n' +
  '_Avoid_: result, status, report, verdict, admission\n'

// A read of a fixture tree, in the shape the tree read answers, so a case below never
// touches the checkout.
const fixture = files => name => (name in files ? files[name] : null)

const FILES = Object.fromEntries(SWEPT.map(name => [name,
  name.endsWith('dev-lane.sh')
    ? 'whitelist_report() {\n  whitelist_judge report "$1"\n}\n'
    : "const row = '<span class=\"uuid-decision\">can authenticate</span>'\n"]))

test('the guard found the entry, the rule it names, and the two places it names', () => {
  const found = entry(GLOSSARY, TERM)
  assert.notEqual(found, null, message.noEntry)
  const named = names(found.body)
  const paths = named.filter(name => PATH_NAME.test(name))
  for (const name of CALL_SITES) {
    assert.ok(paths.includes(name), message.unnamed('GLOSSARY.md:' + found.line, name))
  }
  // The rule the entry points at is the function the module exports, so the pointer
  // cannot rot into a name nothing holds.
  assert.equal(typeof uuidRefusalReason, 'function',
    'src/custody/util.js exports uuidRefusalReason, which is the rule both call sites ask')
  for (const name of SWEPT) {
    assert.notEqual(tree(name), null, message.unheld('GLOSSARY.md:' + found.line, name))
  }
})

test('the term is the name the page renders the answer under', () => {
  // The entry defines a word; the page is where a reader meets it. test/panel/page.test.js
  // asserts the row's markup, and this case is the other half: the class it carries is
  // the term, and the stylesheet that draws a fault on it is the same word.
  assert.match(tree('src/panel/views/whitelist.js'), new RegExp('class="' + CLASS),
    'the whitelist view renders the decision under the class the entry\'s term spells: ' + CLASS)
  assert.ok(tree('src/panel/public/app.css.in').includes('.' + CLASS),
    'the stylesheet source draws .' + CLASS + ', which is the term the entry defines')
})

test('the entry says what the code does, and no call site writes the word it retired', () => {
  const found = drift(GLOSSARY, tree)
  assert.deepEqual(found, [],
    'GLOSSARY.md and the places it names disagree:\n  ' + found.join('\n  '))
})

test('an entry that drops a call site, the rule, or the ban fails', () => {
  assert.deepEqual(drift(BASE, fixture(FILES)), [],
    'the fixture the cases below change drifts nothing itself')
  const dropped = BASE.replace(' and \u0060src/panel/\u0060 prints one per row.', '')
  assert.notEqual(dropped, BASE, 'the fixture dropped the second call site')
  assert.deepEqual(drift(dropped, fixture(FILES)), [message.unnamed('GLOSSARY.md:1', 'src/panel/')],
    'an entry that does not name where the answer is printed leaves the reader to guess')
  const unruled = BASE.replace('\u0060uuidRefusalReason\u0060 in ', '')
  assert.notEqual(unruled, BASE, 'the fixture dropped the rule')
  assert.deepEqual(drift(unruled, fixture(FILES)), [message.unruled('GLOSSARY.md:1')],
    'an entry that describes the answer without naming the rule leaves it to code')
  const unbanned = BASE.replace(', verdict, admission\n', ', admission\n')
  assert.notEqual(unbanned, BASE, 'the fixture dropped the ban')
  assert.deepEqual(drift(unbanned, fixture(FILES)), [message.banned('GLOSSARY.md:1', 'verdict')],
    'an entry that stops banning the word invites it back')
})

test('the word at a call site is the finding, with its line', () => {
  const files = { ...FILES, 'scripts/dev-lane.sh': 'whitelist_report() {\n  # The verdicts, one per entry.\n}\n' }
  assert.deepEqual(drift(BASE, fixture(files)), [
    message.retired('scripts/dev-lane.sh:2', 'scripts/dev-lane.sh', '# The verdicts, one per entry.')
  ], 'the script that calls an entry\'s answer a verdict is the drift this entry retires')
})

test('a swept file the tree does not hold is a finding, not an empty sweep', () => {
  const files = { ...FILES }
  delete files['src/panel/views/whitelist.js']
  assert.deepEqual(drift(BASE, fixture(files)), [
    message.unheld('GLOSSARY.md:1', 'src/panel/views/whitelist.js')
  ], 'a call site this guard cannot read is a call site it cannot vouch for')
})

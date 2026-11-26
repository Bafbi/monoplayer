// The README's command block (#429, #430). It is a reader's first contact with
// the repo: every line has to run as printed, and the sentence above it has to
// describe the list beneath it. Neither held.
//
// #429: the sentence promised "the bottom three rungs of the testing ladder" and
// the list under it carried commands from above those rungs too. The line it left
// out was `lint`, the gate's own first rung.
//
// #430: no test read the block, so a task renamed in mise.toml left the README
// pointing at nothing. A reader copies the line and the shell answers that no such
// task exists.
//
// Both halves compare the pages against the things that know: `mise.toml` through
// `readMiseTasks`, and the rung table in docs/testing-ladder.md through
// `loadLadder`, the reader that also writes each failing rung's hint. The gate's
// rungs are the `depends` of `check:rungs`, so the sentence, the list, and
// mise.toml are held to each other here.
//
// docs/testing-ladder.md is the second page, and it is covered as it stands: it is
// where a rung number comes from, and it names tasks of its own, so a rename breaks
// the hints this repo prints on a failure as well as the page.
//
// #403 asks for this guard on every prose line that names a task. It stays open.
// docs/architecture.md is a proposal that names tasks no build defines
// (`mise run ci`, `mise run smoke`), and testdata/*-verdict.md are dated records
// that keep the names they were taken under. What a proposal and a record may say
// is a decision this ticket does not make.
//
// Nothing here opens a socket or runs mise: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLadder } from '../../src/ladder/next-rung.js'
import { readMiseTasks } from './mise-toml.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const TASKS = readMiseTasks()

// A page this guard holds. README is the first contact; the ladder is the page the
// README's sentence leans on, and it is where a rung number comes from.
const PAGES = ['README.md', 'docs/testing-ladder.md']

// `mise run <task>`, and the characters a task name uses. A word starting with "-"
// is a flag of `mise run` itself, not a task, and docs/testing-ladder.md spells one
// out ("runs its rungs through `mise run --continue-on-error`"): the pattern
// requires a letter after `mise run `, so a flag is not read as a task.
const MENTION = /mise run ([a-z][a-z0-9:_-]*)/g

function mentioned (text) {
  return [...text.matchAll(MENTION)].map(match => match[1])
}

// The names one page gets wrong, as the one sentence a reader acts on: the page,
// every task it names that mise.toml does not define, and where tasks are defined.
// Null when the page agrees with the tree, so a case can say "nothing to report"
// without repeating the comparison.
function report (file, text) {
  const gone = [...new Set(mentioned(text))].filter(name => !TASKS.has(name))
  if (gone.length === 0) return null
  return file + ' names ' + gone.map(name => '`mise run ' + name + '`').join(', ') +
    ', and mise.toml defines no such task: it holds one [tasks.<name>] block per task. ' +
    'Rename the line to the task that exists, or define the task'
}

// The fenced bash block that names the gate, read by what it holds rather than by
// where it sits, so a second block above it cannot move the guard onto another
// list. Null when the block is gone, and the case below says so once.
function blockOf (text, marker) {
  for (const match of text.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
    if (match[1].includes(marker)) return { body: match[1], at: match.index }
  }
  return null
}

// The sentence that introduces the block: the lines directly above it, to the blank
// line. Joined, because the claim wraps: a reader reads it as one sentence, and a
// case looking for it should too.
function introBefore (text, at) {
  const lines = text.slice(0, at).split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  const sentence = []
  for (let index = lines.length - 1; index >= 0 && lines[index].trim() !== ''; index--) {
    sentence.unshift(lines[index].trim())
  }
  return sentence.join(' ')
}

// The line a reader copies, as README prints it. The task inside it is `check`;
// this is the whole command, and the messages below quote it as printed.
const GATE_LINE = 'mise run check'
const README = read('README.md')
const BLOCK = blockOf(README, GATE_LINE)
const INTRO = BLOCK ? introBefore(README, BLOCK.at) : ''

test('README still opens a command block that names the gate, with a sentence above it', () => {
  // The shapes below this case reads: a fenced bash block naming `mise run check`,
  // and a non-empty paragraph directly above it. A block that moved would leave the
  // claim unread and every case after this one comparing nothing.
  assert.notEqual(BLOCK, null,
    'README.md holds no fenced bash block naming `' + GATE_LINE + '`. The guard reads the ' +
    'block that names the gate and the sentence above it: restore the block, or move the ' +
    'guard with it')
  assert.notEqual(INTRO, '',
    'the command block in README.md has no sentence above it. A block with no sentence ' +
    'above it makes no claim to check, and a reader gets a list with no order to it')
})

test('every page here names only tasks mise.toml defines (#430)', () => {
  const pages = PAGES.map(file => ({ file, text: read(file) }))

  // A floor: a pattern that finds nothing passes every case here, and a page that
  // names no task at all is a page this guard stopped reading.
  for (const { file, text } of pages) {
    assert.ok(mentioned(text).length > 0, file + ' names no task mise can run: a read ' +
      'that finds nothing would pass this case on a page that names no task at all')
  }

  const reports = pages
    .map(({ file, text }) => report(file, text))
    .filter(Boolean)

  assert.deepEqual(reports, [],
    'a page names a task the tree does not define. A renamed task leaves every page ' +
    'that names it pointing at nothing, and nothing else notices')
})

test('the sentence above the block claims what the ladder says (#429)', () => {
  const gate = TASKS.get('check:rungs')
  const bottom = loadLadder().slice(0, 3).flatMap(rung => rung.tasks)

  assert.ok(gate, 'mise.toml defines check:rungs, the task that lists the gate\'s rungs')

  // The claim, in the two sources that can falsify it. The sentence says the gate
  // runs the bottom three rungs of the ladder; the ladder's own table and the gate's
  // depends are what "bottom three rungs" means. A rung inserted below the gate makes
  // the sentence wrong, and this is the case that says so.
  assert.deepEqual(bottom, gate.depends,
    'the bottom rungs of docs/testing-ladder.md and the rungs mise.toml\'s check:rungs ' +
    'composes disagree: the README sentence above the command block claims the gate runs ' +
    'the bottom three rungs of the ladder')
  assert.equal(bottom.length, 3,
    'the README sentence above the command block says the gate runs the bottom three rungs, ' +
    'and docs/testing-ladder.md now puts a different number below the gate: reword the ' +
    'sentence, or fix the ladder')

  assert.match(INTRO, /bottom three rungs/,
    'the sentence above the block no longer says what the block is: it claims the gate runs ' +
    'the bottom three rungs of the testing ladder, and this case holds the list to that claim: ' +
    'The sentence above the block is "' + INTRO + '"')
  assert.match(INTRO, /`mise run check`/,
    'the sentence above the block does not name the command it describes (' + GATE_LINE + '): ' +
    'the sentence above the block is "' + INTRO + '"')
})

test('the block names the gate and each rung it runs (#429)', () => {
  const commands = mentioned(BLOCK?.body ?? '')
  const gate = TASKS.get('check:rungs')

  // The list carries what the sentence says it does: the gate, then each rung of it
  // on its own line, so a reader can run one rung without the other two.
  for (const name of ['check', ...(gate?.depends ?? [])]) {
    assert.ok(commands.includes(name),
      'the command block in README.md does not name `mise run ' + name + '`, and ' +
      (name === 'check' ? 'the first line of the block is the gate' : 'it is one of the rungs the gate composes') +
      '. The sentence above the block says the list holds the gate and its three rungs')
  }
})

test('the comparison reports the page, the task, and where tasks are defined', () => {
  // Fixtures, not the tree: this case is about the report, so a real drift in a page
  // cannot make it about the drift instead.
  assert.deepEqual(mentioned('run `mise run check`, then `mise run gone:task`.'), ['check', 'gone:task'],
    'a mention is the task name, not the punctuation around it')
  assert.deepEqual(
    mentioned('through `mise run --continue-on-error`'),
    [],
    'a flag of mise run itself is not a task'
  )
  assert.equal(report('README.md', '`mise run check` and `mise run lint`'), null,
    'a page that names only tasks mise.toml defines reports nothing')
  assert.equal(
    report('README.md', 'run `mise run check`, or `mise run gone:task` twice: `mise run gone:task`.'),
    'README.md names `mise run gone:task`, and mise.toml defines no such task: it holds one ' +
    '[tasks.<name>] block per task. Rename the line to the task that exists, or define the task',
    'the report names the page, the task once, and where tasks are defined'
  )
})

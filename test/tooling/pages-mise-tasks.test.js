// The pages against mise.toml, and the README's command block against the ladder.
//
// #429: the sentence above the README's command block promised "the bottom three
// rungs of the testing ladder" and the list under it carried commands from above
// those rungs too. The line it left out was `lint`, the gate's own first rung.
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
// #403 asked for the task-name check on every prose line that names a task. #842
// answered it with a sweep over every Markdown page git owns, and landed that sweep in
// test/tooling/dev-lane-runbook.test.js, which is about the dev lane. This file kept a
// second copy over a hand-kept list of two pages. The copy had its own pattern and its
// own message.
//
// Two sweeps over one tree disagree the day one of them learns a shape the other does
// not, and neither can name the page it misses. At 98bc20d8 the hand-kept sweep read 2
// pages and #842's read all 48, and the 2 were read twice. A page outside them that
// named `mise run check_up` passed all 16 cases of both files. The hand-kept pattern
// caught `check_up` and never read the page. #842's read the page and caught `check`,
// a task the tree defines. That gap is the whole argument for one sweep (#875).
//
// So the sweep is here, once: one pattern, one message, one exemption table, and every
// Markdown page `git ls-files` resolves. The file is named for that subject, which is
// why #875 renamed it from readme-mise-tasks.test.js. A name that said README while the
// sweep read every page is the same defect one file over. The README's block and the
// ladder stay here, because they are prose held against mise.toml too.
// test/tooling/dev-lane-runbook.test.js keeps its own subject and has one sentence
// saying where the sweep went. test/tooling/source-scan-home.test.js is the same rule
// one layer down, for the walks a guard builds.
//
// What a proposal and a dated record may say instead of a task the tree defines is
// decided per page in UNDEFINED_BY_DESIGN, name by name. That decision used to sit
// in the other file, which is how a reader of either got half of it.
//
// Nothing here opens a socket or runs mise: every case reads a file, and the one
// command it runs is `git ls-files`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLadder } from '../../src/ladder/next-rung.js'
import { readMiseTasks } from './mise-toml.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const TASKS = readMiseTasks()

// A task named in prose, as a page spells it: `mise run <task>`, with or without the
// backtick a page wraps it in. A word starting with "-" is a flag of `mise run`
// itself, not a task, and docs/testing-ladder.md spells one out ("runs its rungs
// through `mise run --continue-on-error`"). A colon after the name is punctuation, as
// in "`mise run gate:up`: it wakes the rows", and one is dropped off the end.
//
// One pattern, because a second one captures a prefix of a name and calls it a task.
// At 98bc20d8 the copy in test/tooling/dev-lane-runbook.test.js captured `gate` from
// `gate_b:up` and `check` from `check_up`. The first is a name nothing defines. The
// second is a name the tree defines, which is the worse of the two (#875). A name holds
// every character a task name may: a letter or a digit, then letters, digits, "_", ":",
// and "-". That is the union of the two patterns the fold found, so no name either one
// could read is lost.
const MENTION = /`?mise run ([a-z0-9][a-z0-9:_-]*)/g

function mentioned (text) {
  return [...new Set([...text.matchAll(MENTION)].map(match => match[1].replace(/:$/, '')))]
}

// The name one page gets wrong, as the sentence a reader acts on: the page, the task,
// and the file that would define it. One sentence per name, so a rename that reached
// six pages lists six lines and each one is a page to open.
function wrongName (page, task) {
  return page + ' names "mise run ' + task + '", and mise.toml defines no such task: it holds one [tasks.<name>] block per task'
}

// An entry in UNDEFINED_BY_DESIGN that no longer describes its page. Two things cause
// it and there is one entry, so the message names the cause instead of guessing: the
// tree gained the task, or the page dropped the name.
function staleName (page, task, defined) {
  return page + ' is exempt for "mise run ' + task + '", and ' + (defined
    ? 'mise.toml defines it now: drop the entry'
    : 'the page no longer names it: drop the entry')
}

// What one page reports, from its own text and TASKS: the names it gets wrong, and the
// entries in UNDEFINED_BY_DESIGN it no longer needs. A fixture page can be handed to it,
// so the failure itself is held and not only the sentence it prints.
function sweepPage (page, text) {
  const names = mentioned(text)
  const gone = names.filter(task => !TASKS.has(task))
  const exempt = UNDEFINED_BY_DESIGN.get(page)?.tasks ?? []
  return {
    names,
    wrong: gone.filter(task => !exempt.includes(task)).map(task => wrongName(page, task)),
    stale: exempt.filter(task => !gone.includes(task)).map(task => staleName(page, task, TASKS.has(task)))
  }
}

// Every page git owns, resolved with the flags the lint stage resolves its files with
// since #846: the tracked files, plus the ones not committed yet, without the ignored
// ones. The glob is this guard's own, because that stage parses `*.js` and this one
// reads `*.md`. A page added in the commit that breaks it fails here, and no page is
// invisible because nobody remembered to put it on a list (#727, #743).
function ownedPages () {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, 'git lists the pages it owns: ' + listed.stderr)
  return listed.stdout.split('\0').filter(Boolean).sort()
}

// A page that names a task the tree does not define, and why the name is right
// anyway. The exempt names are spelled out one by one, so an exception covers the
// sentences written for it and never the whole page: a new `mise run` name on an
// exempt page still fails, and an exempt name the page dropped fails too.
const UNDEFINED_BY_DESIGN = new Map([
  ['docs/architecture.md', {
    reason: 'the architecture proposal is "proposed, not built": its command block lists the tasks the proposal would add',
    tasks: ['auth:status', 'ci', 'deploy', 'down', 'images:build', 'logs', 'metrics', 'secret:apply', 'secret:rotate', 'smoke', 'test:l2', 'whitelist:add']
  }],
  ['docs/driver-lane-plan.md', {
    reason: 'the driver lane plan is a dated record ("Historical plan, written for 26.1.2"), and keeps the bootstrap task it was written under',
    tasks: ['auth:device-code']
  }],
  ['testdata/driver-verdict.md', {
    reason: 'a verdict page is dated evidence, so it keeps the name the run was taken under, and says where it says the rename',
    tasks: ['gate-b:g0']
  }]
])

// 48 pages and 60 distinct task names in this tree when #842 landed, and the same two
// numbers at 98bc20d8 (#875). `git ls-files '*.md' | wc -l` prints the first. Both
// floors sit below, because deleting a page or trimming a doc is legitimate: a sweep
// narrowed back to a hand-kept list of two pages lands under both, and so does a
// mention pattern that stopped finding names.
const PAGES_FLOOR = 40
const NAMES_FLOOR = 50

test('every Markdown page in the tree names only tasks mise.toml defines (#403, #842)', () => {
  assert.ok(TASKS.has('check'), 'mise.toml parsed: it defines the gate')

  const pages = ownedPages()
  assert.ok(pages.length >= PAGES_FLOOR,
    'the sweep reads ' + pages.length + ' pages and every Markdown page git owns is one of them: a sweep under ' +
    PAGES_FLOOR + ' has narrowed back to a hand-kept list, which is the defect #727 and #743 closed')
  assert.ok(pages.includes('GLOSSARY.md'),
    'GLOSSARY.md is a page the sweep reads: it names the gate lane\'s two tasks, and a task renamed in mise.toml left it pointing at a command nobody can run (#842)')

  // The two pages #430 wrote its case for, read here too. A sweep that dropped them
  // would leave the README's block and the ladder unread, and a page that names no
  // task at all is a page this pattern stopped reading.
  for (const page of ['README.md', 'docs/testing-ladder.md']) {
    assert.ok(pages.includes(page), 'the sweep reads ' + page + ', one of the two pages #430 names')
    assert.ok(mentioned(read(page)).length > 0, page + ' names no task mise can run: a read that ' +
      'finds nothing would pass the sweep on the page it was written for')
  }

  const wrong = []
  const stale = []
  const seen = new Set()
  for (const page of pages) {
    const swept = sweepPage(page, read(page))
    for (const task of swept.names) seen.add(task)
    wrong.push(...swept.wrong)
    stale.push(...swept.stale)
  }
  // An entry naming a page the tree dropped reads as coverage it no longer is.
  for (const page of UNDEFINED_BY_DESIGN.keys()) {
    if (!pages.includes(page)) stale.push(page + ' is exempt from the sweep, and the tree holds no such page')
  }

  assert.deepEqual(wrong, [],
    'a page names a task mise.toml does not define. A task renamed in mise.toml leaves that page ' +
    'pointing at a command nobody can run, and nothing else notices. Rename the line to the task that ' +
    'exists, or define the task')
  assert.deepEqual(stale, [],
    'an entry in UNDEFINED_BY_DESIGN no longer describes the tree. An exception that outlives its ' +
    'reason hides the next task renamed on that page: drop the entry, or name the task the page holds now')
  assert.ok(seen.size >= NAMES_FLOOR,
    'the sweep finds ' + seen.size + ' distinct task names across those pages: a pattern under ' +
    NAMES_FLOOR + ' has stopped finding names, and every case above would pass on a tree it never read')
})

test('the sweep reports the page and the task mise.toml does not define (#842)', () => {
  // Fixtures, not the tree: this case is about the report, so a page drifting for
  // real cannot make it about the drift instead.
  assert.deepEqual(mentioned('Run `mise run check`, then `mise run gone:task`.'), ['check', 'gone:task'],
    'a mention is the task name, not the punctuation around it')
  assert.deepEqual(mentioned('through `mise run --continue-on-error`'), [],
    'a flag of mise run itself is not a task')
  assert.deepEqual(mentioned('`mise run gate:up`: it wakes the rows'), ['gate:up'],
    'punctuation after the name is not part of it')
  assert.deepEqual(mentioned('run `mise run gate_b:up` and `mise run check_up`'), ['gate_b:up', 'check_up'],
    'a name carrying "_" is read whole, and not as "gate" or "check" (#875)')
  assert.deepEqual(mentioned('run `mise run 2fa`'), ['2fa'],
    'a name starting with a digit is a name (#875)')
  assert.equal(wrongName('docs/panel.md', 'gone:task'),
    'docs/panel.md names "mise run gone:task", and mise.toml defines no such task: it holds one [tasks.<name>] block per task',
    'the report names the page, the task, and the file that defines tasks')
  assert.equal(staleName('docs/architecture.md', 'ci', true),
    'docs/architecture.md is exempt for "mise run ci", and mise.toml defines it now: drop the entry',
    'a stale entry whose task the tree gained says so, rather than blaming the page')
  assert.equal(staleName('docs/architecture.md', 'ci', false),
    'docs/architecture.md is exempt for "mise run ci", and the page no longer names it: drop the entry',
    'a stale entry the page dropped says so, so the reader is sent to the file that changed')

  // The failure itself, on a page handed to the sweep: the sweep reports the name,
  // and nothing else in this case would notice if it stopped reporting one.
  assert.deepEqual(sweepPage('docs/panel.md', 'Run `mise run check`, then `mise run gone:task`.'), {
    names: ['check', 'gone:task'],
    wrong: ['docs/panel.md names "mise run gone:task", and mise.toml defines no such task: it holds one [tasks.<name>] block per task'],
    stale: []
  },
  'a page naming a task the tree does not define fails, and the failure names the page and the task')
  assert.deepEqual(sweepPage('docs/panel.md', 'Run `mise run check`.').wrong, [],
    'a page naming only tasks the tree defines reports nothing')
  assert.deepEqual(sweepPage('docs/panel.md', 'Run `mise run check_up`.').wrong,
    ['docs/panel.md names "mise run check_up", and mise.toml defines no such task: it holds one [tasks.<name>] block per task'],
    'the page #875 measured: a name the pattern of the second sweep read as "check", and the only ' +
    'sweep now reports whole')

  // An exempt page, on the same fixture footing: the exception covers the names it was
  // written for and no others, and every name it covers is checked in both directions.
  const exemptPage = sweepPage('docs/architecture.md', 'Run `mise run ci`, then `mise run gone:task`.')
  assert.deepEqual(exemptPage.wrong.map(entry => entry.split(' names ')[0]), ['docs/architecture.md'],
    'the exemption covers its own names, and an unlisted name on that page still fails')
  assert.equal(exemptPage.stale.length, UNDEFINED_BY_DESIGN.get('docs/architecture.md').tasks.length - 1,
    'a name the fixture page does not carry reads as an entry the page dropped')
})

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

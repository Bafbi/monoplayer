// The dev lane runbook and the agent rule (#45). Three docs an agent reads
// before it touches a cluster: the rule in AGENTS.md, the lane each run belongs
// on in docs/testing-ladder.md, and the dev account in deploy/dev/README.md.
//
// The sweep at the end of this file reads every page git owns, not those three and
// not a fourth somebody remembered (#842).
//
// Nothing here reaches a cluster: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseLadder } from '../../src/ladder/next-rung.js'
import { STATES } from '../../src/core/session.js'
import { readMiseTasks } from './mise-toml.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const AGENTS = read('AGENTS.md')
const LADDER = read('docs/testing-ladder.md')
const DEV_README = read('deploy/dev/README.md')

// One section, from its heading to the next heading of the same or a higher
// level, so an assertion about the lanes cannot be satisfied by a stray line
// elsewhere in the file.
function section (text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^#+\s/.test(line) && line.replace(/^#+\s+/, '').trim() === heading)
  assert.notEqual(start, -1, 'the doc has a "' + heading + '" section')
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = lines[i].match(/^(#+)\s/)
    if (heading && heading[1].length <= level) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

// The table row that names a command, so a lane claim is read where it applies
// rather than anywhere in the section.
function row (text, needle) {
  const line = text.split('\n').find(entry => entry.startsWith('|') && entry.includes(needle))
  assert.ok(line, 'the table has a row naming ' + needle)
  return line
}

// The first line that runs a task. The lookahead keeps "dev:custody" from
// matching "dev:custody:up", so an order assertion means what it says.
function firstUse (text, task) {
  return text.search(new RegExp('^\\s*mise run ' + task + '(?=\\s|$)', 'm'))
}

// The lane table's answer to "may this run beside another agent?" (#319). #281
// added the column so each run answers that question once. No code read the answer,
// and an empty cell reads as "nobody asked", which is the drift the column exists
// to stop.
const LANE_SECTION = 'Which lane a run uses'
const CONCURRENCY = 'Beside another agent?'

// A markdown table as rows of cells. The outer pipes are not cells, and the |---|
// rule is a row like any other, so data rows start at index 2. This is the split
// src/ladder/next-rung.js cells() does. It stays local because that file reads the
// rungs table and owns no lane parser.
function table (text) {
  return text.split('\n')
    .filter(line => line.trimStart().startsWith('|'))
    .map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
}

// A run's first cell names its rung ids, as in "driver lane, rung 4" or "rungs 0,
// 1, 2". An id has to follow the word. A cell that mentions a number for another
// reason ("about 3 minutes") does not answer for that rung.
function rungIds (cell) {
  const tokens = cell.split(/[^A-Za-z0-9]+/)
  const ids = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^rungs?$/.test(tokens[i])) continue
    for (let j = i + 1; j < tokens.length && /^[0-9]+[a-z]?$/.test(tokens[j]); j += 1) ids.push(tokens[j])
  }
  return ids
}

// The lane table as data. The header names the column, so the guard reports a
// header that lost it once, rather than reading every row as one that answered
// nothing. parseLadder reads the rungs table. A rung it finds and the lane table
// never names has no lane answer at all.
function laneDrift (text) {
  const rows = table(section(text, LANE_SECTION))
  const header = rows[0] ?? []
  const column = header.indexOf(CONCURRENCY)
  const lanes = rows.slice(2).map(cells => ({
    run: cells[0] ?? '',
    rungs: rungIds(cells[0] ?? ''),
    answer: column < 0 ? '' : (cells[column] ?? '')
  }))
  const named = new Set(lanes.flatMap(lane => lane.rungs))
  return {
    column,
    lanes,
    blank: column < 0 ? [] : lanes.filter(lane => !lane.answer.trim()).map(lane => lane.run),
    unnamed: parseLadder(text).map(rung => rung.id).filter(id => !named.has(id))
  }
}

// One message per kind of drift. Each names the row and says what to write there,
// and a missing column is one finding, because one edit fixes every row.
function laneDisagreement ({ column, blank, unnamed }) {
  return [
    column < 0
      ? 'docs/testing-ladder.md has no "' + CONCURRENCY + '" column: add it to the lane ' +
        'table, so every run answers whether it can run beside another agent'
      : null,
    ...blank.map(run => 'the lane row "' + run + '" leaves "' + CONCURRENCY + '" empty: ' +
      'write "yes", "no", or the reason it cannot run beside another agent'),
    ...unnamed.map(id => 'rung ' + id + ' has no lane row: add one to "' + LANE_SECTION + '", ' +
      'and answer "' + CONCURRENCY + '" for it')
  ].filter(Boolean)
}

test('AGENTS.md carries the rule, because that is what an agent reads', () => {
  const lanes = section(AGENTS, 'Lanes')

  // The three lanes, by the namespace each manifest declares. The gate lane is one
  // per worktree, so its row names the shape and the task that lists them (#279).
  assert.match(lanes, /`monoplayer`/, 'the live namespace is named')
  assert.match(lanes, /monoplayer-dev/, 'the dev namespace is named')
  assert.match(lanes, /monoplayer-gate-<instance>/, 'the gate lane is named, and that it is one per worktree')
  assert.match(lanes, /mise run lanes/, 'with the task that lists every lane')

  // The rule itself.
  assert.match(lanes, /Never take the live lane down, scale it, patch it, or restart it for a test/,
    'the rule is stated, with the verbs that break it')
  assert.match(lanes, /No automated join runs against Excalia/,
    'no run joins the live servers on its own')

  // The commands that break the rule for you, and the way back.
  assert.match(lanes, /mise run testbed:up/, 'the run that scales the live deployment is named')
  assert.match(lanes, /mise run testbed:run/, 'and its one-shot form')
  assert.match(lanes, /online-cluster\.sh --rotate/, 'and the flag that writes the live chain')
  assert.match(lanes, /mise run testbed:down/, 'restoring an interrupted testbed run is allowed')
  // switch.js restores the Argo policy only from the run's restore record.
  assert.match(lanes, /restore record/, 'the way back says what it can restore')
  assert.match(lanes, /survives/, 'and that the Argo policy depends on the restore record')

  // What to run instead.
  assert.match(lanes, /mise run dev:up/, 'the dev lane is the answer for a real Paper and a real proxy')
  assert.match(lanes, /mise run online:cluster/, 'the online rung has a path that leaves the deployment serving')
  assert.match(lanes, /mise run observer:run/, 'the server-view report has one too')
  assert.match(lanes, /mise run parity:run/, 'the clientbound comparison runs here, not on a cluster')
  assert.match(lanes, /docs\/testing-ladder\.md/, 'the lane table points at the cost of each run')
})

test('the ladder maps every run to the lane it belongs on', () => {
  // A lane column on the rungs table would empty parseLadder (src/ladder/next-rung.js
  // reads rows of exactly six cells), so the map is its own table. Both halves of
  // that contract are asserted here: the rungs still parse, and the lane table
  // contributes no rung.
  const rungs = parseLadder(LADDER)
  assert.ok(rungs.length > 0, 'parseLadder still finds the rungs')
  assert.equal(new Set(rungs.map(rung => rung.id)).size, rungs.length, 'no rung id repeats')
  assert.equal(parseLadder(section(LADDER, 'Which lane a run uses')).length, 0,
    'the lane table is not read as a rung table')

  const lanes = section(LADDER, 'Which lane a run uses')
  for (const task of ['check', 'parity:run', 'observer:run', 'testbed:run', 'online', 'online:cluster', 'driver:scenario', 'dev:up']) {
    assert.match(lanes, new RegExp('mise run ' + task + '(?=\\s|\\`)'), 'the lane table names mise run ' + task)
  }
  // The parity rung landed after the ticket was written (#13). It needs no
  // cluster, so it belongs beside the gate, not beside the dev lane.
  assert.match(row(lanes, 'mise run parity:run'), /this machine/, 'the parity rung runs here, against a fake backend')

  // The rows that can change what the live lane serves, each with its cost.
  assert.match(row(lanes, 'mise run testbed:run'), /offline/,
    'the testbed row says the live front goes offline for the run')
  const bare = row(lanes, 'mise run online`')
  assert.match(bare, /token chain/, 'the bare online row says whose chain it holds')
  assert.match(bare, /online:cluster/, 'and points at the form that leaves the deployment serving')
  assert.match(lanes, /agent never runs/, 'the section says which runs an agent does not make')

  // The observer restarts the gate Paper and runs its joins from pods in the
  // live namespace, so one namespace in that cell would name half the run.
  const observer = row(lanes, 'mise run observer:run')
  assert.match(observer, /this worktree's lane/,
    "the observer row names this worktree's lane, and not one that shipped (#282)")
  assert.match(observer, /in `monoplayer`/, 'and the live namespace its pods run in')

  // G0 joins the gate Paper directly. Velocity fronts paper-m4, a different one.
  assert.doesNotMatch(row(lanes, 'mise run driver:scenario'), /Velocity/i,
    'the driver row does not name a Velocity that G0 does not go through')
})

test('every lane row answers whether its run may go beside another agent', () => {
  const drifted = laneDrift(LADDER)

  // The guard reads both sides, so a reformat that matches nothing cannot pass.
  assert.ok(drifted.lanes.length > 0, 'the lane table has rows')
  assert.ok(parseLadder(LADDER).length > 0, 'the rungs table still parses')
  assert.notEqual(drifted.column, -1,
    'the lane table header carries "' + CONCURRENCY + '", the column #281 added')
  assert.equal(new Set(drifted.lanes.map(lane => lane.run)).size, drifted.lanes.length,
    'no lane row repeats, so one run holds one answer')

  assert.deepEqual(laneDisagreement(drifted), [], 'the lane table and the ladder disagree')
})

test('the lane guard names a row whose concurrency cell is empty', () => {
  // Fixtures, not the tree: this case tests the comparison, so a real drift
  // cannot make the case about the drift instead.
  const doc = [
    '## Rungs',
    '',
    '| Rung | Command | Cost | Prerequisites | Asserts | Cannot catch |',
    '|---|---|---|---|---|---|',
    '| 3 online bot | \`mise run online:cluster\` | minutes | a backend | the shape through the online leg | a vanilla client |',
    '| 4 real client | \`mise run driver:scenario\` | tens of minutes | a client | the client shows it | nothing cheaper |',
    '',
    '## Which lane a run uses',
    '',
    '| Run | Command | Lane | Cost | What it may change | Beside another agent? |',
    '|---|---|---|---|---|---|',
    '| online rung, 3, from a pod | \`mise run online:cluster\` | namespace \`monoplayer\` | minutes | nothing on the deployment | no, it takes the account lease |',
    '| driver lane, rung 4 | \`mise run driver:scenario\` | the gate Paper | tens of minutes | its world | no, the display host carries one client |',
    ''
  ].join('\n')

  assert.deepEqual(laneDrift(doc), {
    column: 5,
    lanes: [
      { run: 'online rung, 3, from a pod', rungs: ['3'], answer: 'no, it takes the account lease' },
      { run: 'driver lane, rung 4', rungs: ['4'], answer: 'no, the display host carries one client' }
    ],
    blank: [],
    unnamed: []
  }, 'the guard reads the header, the answer, and the rung ids, and nothing else')

  // The cell emptied. The row stays, so the answer reads as "nobody asked"
  // rather than absent. The message names the row and says what to write.
  const emptied = doc.replace('| no, the display host carries one client |', '|  |')
  assert.deepEqual(laneDrift(emptied).blank, ['driver lane, rung 4'],
    'the guard reports an empty cell against the row that holds it')
  assert.deepEqual(laneDisagreement(laneDrift(emptied)), [
    'the lane row "driver lane, rung 4" leaves "Beside another agent?" empty: ' +
      'write "yes", "no", or the reason it cannot run beside another agent'
  ], 'one failure names the row and what to write')

  // The column gone from the header: reported once, not once per row.
  const renamed = doc.replace(' | Beside another agent? |', ' |').replace('|---|---|---|---|---|---|', '|---|---|---|---|---|')
  assert.equal(laneDrift(renamed).column, -1, 'the guard reads a header that lost the column as missing')
  assert.deepEqual(laneDisagreement(laneDrift(renamed)), [
    'docs/testing-ladder.md has no "Beside another agent?" column: add it to the lane ' +
      'table, so every run answers whether it can run beside another agent'
  ], 'a missing column is one finding, not one per row')

  // A rung the lane table never names: the run exists and has no answer at all.
  const unnamed = doc.replace('| driver lane, rung 4 |', '| driver lane |')
  assert.deepEqual(laneDrift(unnamed).unnamed, ['4'], 'the guard reports a rung with no lane row')
  assert.deepEqual(laneDisagreement(laneDrift(unnamed)), [
    'rung 4 has no lane row: add one to "Which lane a run uses", ' +
      'and answer "Beside another agent?" for it'
  ], 'the message names the rung and the table to add it to')

  // A number the cell carries without naming a rung. Reading it as an answer
  // would let a count cover a rung, which is the drift again in a new shape.
  const counted = doc.replace('| online rung, 3, from a pod |', '| online rung serving 3 servers |')
  assert.deepEqual(laneDrift(counted).unnamed, ['3'], 'a stray number does not answer for a rung')
})

test('the dev runbook takes a reader from an empty volume to a joined bot', () => {
  // The bootstrap order, read inside the section that owns it, so a quickstart
  // elsewhere in the file cannot satisfy or break it.
  const first = section(DEV_README, 'The first run')
  const order = ['dev:custody:up', 'dev:custody', 'dev:custody:down', 'dev:up']
    .map(task => ({ task, at: firstUse(first, task) }))
  for (const { task, at } of order) assert.notEqual(at, -1, 'the first run runs mise run ' + task)
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i].at > order[i - 1].at,
      'mise run ' + order[i].task + ' comes after mise run ' + order[i - 1].task)
  }
  assert.match(first, /sign in as/i, 'the approval names who signs in')
  assert.match(first, /15 minutes/, 'the approval says how long the code lives')
  assert.match(first, /devpuppet/, 'the alias the deployment selects is named')

  // The last step of the path: the join has its own section and its own command.
  assert.notEqual(firstUse(section(DEV_README, 'Join it'), 'dev:join'), -1,
    'the join section runs mise run dev:join')
})

test('the runbook recovers a dev volume that holds no account', () => {
  const recovery = section(DEV_README, 'When the volume is empty')
  assert.match(recovery, /waiting-for-dev-custody/, 'the symptom is the init container line')
  const stop = firstUse(recovery, 'dev:down')
  const handle = firstUse(recovery, 'dev:custody:up')
  assert.notEqual(stop, -1, 'the recovery stops the proxy')
  assert.notEqual(handle, -1, 'the recovery creates the handle pod')
  assert.ok(handle > stop, 'the proxy is stopped first: it holds the volume dev:custody needs')
  assert.match(recovery, /dev:custody:down/, 'the handle pod hands the volume back')
  // The proxy declares two init containers, so this is the status kubectl shows.
  assert.match(recovery, /Init:0\/2/, 'the symptom is the status kubectl prints')
  assert.match(recovery, /terminating/, 'a pod still terminating keeps the claim')
  // The reasons the refresh actually reports (src/custody/msa.js).
  assert.match(recovery, /needs_bootstrap/, 'the missing-token reason is named')
  assert.match(recovery, /refresh_failed/, 'the consumed-chain reason is named')
})

test('the dev account section states the limit the lane honors', () => {
  const account = section(DEV_README, 'The dev account')
  assert.match(account, /one account, one writer, one replica/i, 'the limit is stated once, in one phrase')
  assert.match(account, /ReadWriteOnce/, 'the claim that enforces it is named')
  assert.match(account, /devpuppet/, 'the account is named by its alias')
})

test('the glossary defines every session stage the core exports', () => {
  // The glossary is the vocabulary an agent writes with, so a stage the core
  // exports and the glossary omits is a term a reader meets undefined (#122).
  const entry = read('GLOSSARY.md').match(/^\*\*Session state\*\*:\n(.+)$/m)
  assert.ok(entry, 'GLOSSARY.md defines Session state')
  for (const stage of Object.values(STATES)) {
    assert.match(entry[1], new RegExp('\\b' + stage + '\\b'), 'the Session state entry names ' + stage)
  }
})

test('the glossary names the lanes the docs use', () => {
  // One name per thing: the rule, the ladder, and the runbook all say "live
  // lane", "dev lane", and "gate Paper", so the glossary defines those three.
  const glossary = read('GLOSSARY.md')
  for (const term of ['Live lane', 'Dev lane', 'Gate Paper']) {
    assert.match(glossary, new RegExp('^\\*\\*' + term + '\\*\\*:$', 'm'), 'GLOSSARY.md defines ' + term)
  }
})

// A task named in prose, as a page spells it: `mise run <task>`. A word starting
// with "-" is a flag of `mise run` itself and not a task, and docs/testing-ladder.md
// spells one out ("runs its rungs through `mise run --continue-on-error`"). A colon
// after the name is punctuation, as in "`mise run gate:up`: it wakes the rows".
const MENTION = /`?mise run ([a-z0-9][a-z0-9:-]*)/g

function mentions (text) {
  return [...new Set([...text.matchAll(MENTION)].map(match => match[1].replace(/:$/, '')))]
}

// The name one page gets wrong, as the sentence a reader acts on: the page, the
// task, and the file that would define it. The sweep below and the fixture case at
// the end of this file both print this text, so a failing gate shows the sentence
// the case asserts.
function wrongName (page, task) {
  return page + ' names "mise run ' + task + '", and mise.toml defines no such task: it holds one [tasks.<name>] block per task'
}

// Every page git owns, resolved with the flags the lint stage resolves its files
// with since #846: the tracked files, plus the ones not committed yet, without the
// ignored ones. The glob is this guard's own, because that stage parses `*.js` and
// this one reads `*.md`. A page added in the commit that breaks it fails here, and
// no page is invisible because nobody remembered to put it on a list (#727, #743).
// What one page reports, from its own text and the tasks the tree defines: the names it
// gets wrong, and the entries in UNDEFINED_BY_DESIGN it no longer needs. A fixture page
// can be handed to it, so the failure itself is held and not only the sentence it prints.
function sweepPage (page, text, tasks) {
  const names = mentions(text)
  const gone = names.filter(task => !tasks.has(task))
  const exempt = UNDEFINED_BY_DESIGN.get(page)?.tasks ?? []
  return {
    names,
    wrong: gone.filter(task => !exempt.includes(task)).map(task => wrongName(page, task)),
    stale: exempt.filter(task => !gone.includes(task)).map(task => staleName(page, task, tasks.has(task)))
  }
}

// An entry in UNDEFINED_BY_DESIGN that no longer describes its page. Two things cause
// it and there is one entry, so the message names the cause instead of guessing: the
// tree gained the task, or the page dropped the name.
function staleName (page, task, defined) {
  return page + ' is exempt for "mise run ' + task + '", and ' + (defined
    ? 'mise.toml defines it now: drop the entry'
    : 'the page no longer names it: drop the entry')
}

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

// 48 pages and 60 distinct task names in this tree when #842 landed.
// `git ls-files '*.md' | wc -l` prints the first. Both floors sit below, because
// deleting a page or trimming a doc is legitimate: a sweep narrowed back to a
// hand-kept list of three lands under both, and so does a mention pattern that
// stopped finding names.
const PAGES_FLOOR = 40
const NAMES_FLOOR = 50

test('every page in the tree names only tasks mise.toml defines (#842)', () => {
  const tasks = readMiseTasks()
  assert.ok(tasks.has('check'), 'mise.toml parsed: it defines the gate')

  const pages = ownedPages()
  assert.ok(pages.length >= PAGES_FLOOR,
    'the sweep reads ' + pages.length + ' pages and every page git owns is one of them: a sweep under ' +
    PAGES_FLOOR + ' has narrowed back to a hand-kept list, which is the defect #727 and #743 closed')
  assert.ok(pages.includes('GLOSSARY.md'),
    'GLOSSARY.md is a page the sweep reads: it names the gate lane\'s two tasks, and a task renamed in mise.toml left it pointing at a command nobody can run (#842)')

  const wrong = []
  const stale = []
  const seen = new Set()
  for (const page of pages) {
    const swept = sweepPage(page, read(page), tasks)
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
  assert.deepEqual(mentions('Run `mise run check`, then `mise run gone:task`.'), ['check', 'gone:task'],
    'a mention is the task name, not the punctuation around it')
  assert.deepEqual(mentions('through `mise run --continue-on-error`'), [],
    'a flag of mise run itself is not a task')
  assert.deepEqual(mentions('`mise run gate:up`: it wakes the rows'), ['gate:up'],
    'punctuation after the name is not part of it')
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
  const defined = readMiseTasks()
  assert.deepEqual(sweepPage('docs/panel.md', 'Run `mise run check`, then `mise run gone:task`.', defined), {
    names: ['check', 'gone:task'],
    wrong: ['docs/panel.md names "mise run gone:task", and mise.toml defines no such task: it holds one [tasks.<name>] block per task'],
    stale: []
  },
  'a page naming a task the tree does not define fails, and the failure names the page and the task')
  assert.deepEqual(sweepPage('docs/panel.md', 'Run `mise run check`.', defined).wrong, [],
    'a page naming only tasks the tree defines reports nothing')

  // An exempt page, on the same fixture footing: the exception covers the names it was
  // written for and no others, and every name it covers is checked in both directions.
  const exemptPage = sweepPage('docs/architecture.md', 'Run `mise run ci`, then `mise run gone:task`.', defined)
  assert.deepEqual(exemptPage.wrong.map(entry => entry.split(' names ')[0]), ['docs/architecture.md'],
    'the exemption covers its own names, and an unlisted name on that page still fails')
  assert.equal(exemptPage.stale.length, UNDEFINED_BY_DESIGN.get('docs/architecture.md').tasks.length - 1,
    'a name the fixture page does not carry reads as an entry the page dropped')
})

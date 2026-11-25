// The dev lane runbook and the agent rule (#45). Three docs an agent reads
// before it touches a cluster: the rule in AGENTS.md, the lane each run belongs
// on in docs/testing-ladder.md, and the dev account in deploy/dev/README.md.
//
// Nothing here reaches a cluster: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseLadder } from '../../src/ladder/next-rung.js'
import { STATES } from '../../src/core/session.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const AGENTS = read('AGENTS.md')
const LADDER = read('docs/testing-ladder.md')
const DEV_README = read('deploy/dev/README.md')
const TOML = read('mise.toml')

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

test('every mise task these docs name exists', () => {
  const tasks = new Set([...TOML.matchAll(/^\[tasks\.(?:"([^"]+)"|([A-Za-z0-9:_-]+))\]$/gm)]
    .map(match => match[1] ?? match[2]))
  assert.ok(tasks.has('check'), 'mise.toml parsed')

  for (const [name, text] of [['AGENTS.md', AGENTS], ['docs/testing-ladder.md', LADDER], ['deploy/dev/README.md', DEV_README]]) {
    const named = new Set([...text.matchAll(/`?mise run ([a-z0-9][a-z0-9:-]*)/g)].map(match => match[1].replace(/:$/, '')))
    for (const task of named) {
      assert.ok(tasks.has(task), name + ' names "mise run ' + task + '", which mise.toml does not define')
    }
  }
})

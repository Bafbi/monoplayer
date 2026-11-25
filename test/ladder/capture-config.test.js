// #322: the config capture names the lane it ran in. The fixture is the evidence the
// offline picker is checkable against (docs/product-core.md), so a lane nobody captured
// points the next reader at the wrong Paper. src/driver/lane.js is the one Node reader of
// scripts/gate-lane.sh name (#282). This file pins that the capture takes its default
// from it, that --lane still speaks for a capture from somewhere else, and that a lane
// nobody can name is a refusal rather than a guess.
//
// Nothing here joins a server. The refusal case hands the capture a worktree that is not
// a git repository. That stops it before it resolves an account, and no case passes a
// host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { LaneError } from '../../src/driver/lane.js'
import { captureLane, captureProvenance } from '../../src/ladder/capture-config.js'
import { LANE, WORKTREE } from '../support/lane.js'

const CAPTURE = path.join(WORKTREE, 'src', 'ladder', 'capture-config.js')
const SOURCE = fs.readFileSync(CAPTURE, 'utf8')
const LADDER = fs.readFileSync(path.join(WORKTREE, 'docs', 'testing-ladder.md'), 'utf8')

// The two variables scripts/gate-lane.sh reads the name from. This machine's own lane
// answers for the derivation, so neither is passed on unless a case sets one.
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra }
  for (const name of ['MONOPLAYER_GATE_NAMESPACE', 'MONOPLAYER_GATE_WORKTREE']) {
    if (!Object.hasOwn(extra, name)) delete env[name]
  }
  return env
}

// The lane the module itself resolves, in a process of its own: the default resolver and
// the environment it reads are the two things a case in this one cannot stand in for.
function resolvedLane (extra = {}) {
  const asked = spawnSync(process.execPath, ['-e', 'import(' + JSON.stringify(pathToFileURL(CAPTURE).href) + ').then(m => console.log(m.captureLane()))'], {
    encoding: 'utf8',
    env: cleanEnv(extra),
    timeout: 30_000
  })
  assert.equal(asked.status, 0, 'the capture resolves a lane: ' + (asked.stderr || '').trim())
  return asked.stdout.trim()
}

// One section, from its heading to the next heading of the same or a higher level. A
// claim about the capture cannot then be satisfied by a stray line elsewhere.
function section (text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^#+\s/.test(line) && line.replace(/^#+\s+/, '').trim() === heading)
  assert.notEqual(start, -1, 'the doc has a "' + heading + '" section')
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const next = lines[i].match(/^(#+)\s/)
    if (next && next[1].length <= level) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

test('#322 the lane a capture records is the one this worktree derives', () => {
  assert.equal(resolvedLane(), LANE, 'the default is scripts/gate-lane.sh name, mirrored by test/support/lane.js')
})

// One rule, not two: scripts/gate-lane.sh answers a named lane, so the capture records
// what an operator named rather than deriving past it.
test('#322 a lane an operator names is the lane the capture records', () => {
  assert.equal(resolvedLane({ MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' }), 'monoplayer-gate-x')
})

// --lane is how a capture whose endpoint is not this worktree's lane says so: a
// port-forward to another lane, another cluster, a hand-started Paper. It wins, and the
// derivation is not consulted, so a capture from elsewhere cannot fail on a lane it
// never needed.
test('#322 --lane is what it is given, and the derivation is never asked', () => {
  assert.equal(
    captureLane({ lane: 'monoplayer-gate-x', resolve: () => { throw new LaneError('asked the script') } }),
    'monoplayer-gate-x'
  )
})

// The lane a capture was given is the lane the fixture carries, and the recorded command
// is the capture's own: a reader who repeats it reaches the same Paper.
test('#322 the fixture carries the lane and the command the capture used', () => {
  const provenance = captureProvenance({
    version: '26.2',
    lane: 'monoplayer-gate-x',
    paperBuild: '135',
    image: 'itzg/minecraft-server:2026.10.1-java25',
    host: '127.0.0.1',
    port: 25599,
    reachedVia: 'kubectl -n monoplayer-gate-x port-forward pod/capture-paper 25599:25565',
    note: null,
    at: '2026-11-25T00:00:00.000Z',
    command: 'node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --offline --out <fixture>'
  })
  // Through JSON, because the fixture on disk is what the next reader reads.
  const written = JSON.parse(JSON.stringify({ version: '26.2', capturedFrom: provenance, frames: [] }))
  assert.equal(written.capturedFrom.lane, 'monoplayer-gate-x', 'the lane that was given is the lane recorded')
  assert.equal(written.capturedFrom.command, 'node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --offline --out <fixture>')
  assert.equal(written.capturedFrom.kind, 'paper')
})

// A fixture that names the wrong Paper is worse than a capture that failed, so the
// refusal travels rather than becoming a default.
test('#322 a lane that cannot be derived is a refusal, not a guess', () => {
  assert.throws(
    () => captureLane({ resolve: () => { throw new LaneError('cannot derive this worktree\'s lane') } }),
    error => error instanceof LaneError && /cannot derive/.test(error.message)
  )
})

// The lane is a fact about the checkout, and this module reads it from the script that
// owns it. A second derivation here is the shape #282 removed from the driver.
test('#322 the capture owns no lane of its own', () => {
  assert.match(SOURCE, /resolveGateLane/, 'the lane comes from src/driver/lane.js')
  assert.doesNotMatch(SOURCE, /monoplayer-gate-[a-z0-9]/, 'no lane is spelled in the capture')
})

// Importing a module must not dial. The cases above exist only because the capture runs
// its main() behind the direct-run guard every other rung uses.
test('#322 importing the capture runs nothing', () => {
  const imported = spawnSync(process.execPath, ['-e', 'import(' + JSON.stringify(pathToFileURL(CAPTURE).href) + ')'], {
    encoding: 'utf8',
    env: cleanEnv({ MONOPLAYER_GATE_WORKTREE: WORKTREE }),
    timeout: 30_000
  })
  assert.equal(imported.status, 0, 'importing the module exits 0: ' + (imported.stderr || '').trim())
  assert.equal(imported.stdout.trim(), '', 'importing the module prints nothing')
  assert.equal(imported.stderr.trim(), '', 'importing the module reports nothing')
})

// The refusal is a setup failure, before the join and before the fixture: exit 2, the
// script's own sentence, and no file at --out.
test('#322 a capture that can name no lane writes no fixture', () => {
  const where = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-capture-lane-'))
  const out = path.join(where, 'config-baseline.json')
  const run = spawnSync(process.execPath, [CAPTURE, '--out', out], {
    encoding: 'utf8',
    cwd: WORKTREE,
    env: cleanEnv({ MONOPLAYER_GATE_WORKTREE: where }),
    timeout: 30_000
  })
  assert.equal(run.status, 2, 'a setup failure exits 2: ' + (run.stderr || '').trim())
  assert.match(run.stderr, /cannot derive this worktree's lane/, 'the refusal is gate-lane.sh\'s sentence')
  assert.match(run.stderr, /MONOPLAYER_GATE_NAMESPACE/, 'and it says how to name one by hand')
  assert.equal(fs.existsSync(out), false, 'no fixture is written for a lane nobody captured')
  assert.doesNotMatch(run.stdout, /joining/, 'the capture refuses before it joins anything')
})

// The rule the code follows is a sentence a reader can find, and the committed fixture
// stays as it is: it records where it was captured.
test('#322 the ladder says what the capture records', () => {
  const lane = section(LADDER, 'Which lane a run uses').replace(/\s+/g, ' ')
  assert.match(lane, /capture-config/, 'the lane section names the capture')
  assert.match(lane, /scripts\/gate-lane\.sh name/, 'and the script the default comes from')
  assert.match(lane, /--lane/, 'and how to attribute a capture from somewhere else')
  assert.match(lane, /MONOPLAYER_GATE_NAMESPACE/, 'and the variable that names a lane for a rung and a capture at once')
  assert.match(lane, /exit 2/, 'and that a capture with no lane stops instead of guessing')
})

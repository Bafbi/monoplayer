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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempRoot } from '../support/temp.js'

import { LaneError } from '../../src/driver/lane.js'
import {
  CaptureSetupError,
  captureBuild,
  captureImage,
  captureInputs,
  captureLane,
  captureProvenance
} from '../../src/ladder/capture-config.js'
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
    offline: true,
    reachedVia: 'kubectl -n monoplayer-gate-x port-forward pod/capture-paper 25599:25565',
    note: null,
    at: '2026-11-25T00:00:00.000Z'
  })
  // Through JSON, because the fixture on disk is what the next reader reads.
  const written = JSON.parse(JSON.stringify({ version: '26.2', capturedFrom: provenance, frames: [] }))
  assert.equal(written.capturedFrom.lane, 'monoplayer-gate-x', 'the lane that was given is the lane recorded')
  assert.equal(written.capturedFrom.command, 'node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --version 26.2 --offline --lane monoplayer-gate-x --paper-build 135 --image itzg/minecraft-server:2026.10.1-java25 --out <fixture>')
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
  const where = tempRoot('monoplayer-capture-lane-')
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

// ---- #367: the build and the image are provenance the capture had, or nothing ----

// The build is the one provenance field no socket fills: a status ping answers
// "Paper <version>" and the configuration phase carries registries and packs. So the
// flag is the only way the capture learns a build, and its absence stops the run.
test('#367 a capture with no build refuses to write one', () => {
  assert.throws(
    () => captureBuild({ paperBuild: null }),
    error => error instanceof CaptureSetupError && /--paper-build/.test(error.message),
    'a build nobody stated is a refusal, not the gate lane\'s build'
  )
  assert.equal(captureBuild({ paperBuild: '136' }), '136', 'a build an operator names is the build recorded')
})

// The refusal is a setup failure, before the join and before the fixture: exit 2, the
// module's own sentence, and no file at --out.
test('#367 a capture that names no build writes no fixture', () => {
  const where = tempRoot('monoplayer-capture-build-')
  const out = path.join(where, 'config-baseline.json')
  const run = spawnSync(process.execPath, [CAPTURE, '--lane', 'monoplayer-gate-x', '--out', out], {
    encoding: 'utf8',
    cwd: WORKTREE,
    env: cleanEnv({ MONOPLAYER_GATE_WORKTREE: WORKTREE }),
    timeout: 30_000
  })
  assert.equal(run.status, 2, 'a setup failure exits 2: ' + (run.stderr || '').trim())
  assert.match(run.stderr, /--paper-build/, 'the refusal names the flag')
  assert.match(run.stderr, /PAPER_BUILD in deploy\/driver\/paper\.yaml/, 'and where a build is written down')
  assert.equal(fs.existsSync(out), false, 'no fixture is written for a build nobody stated')
  assert.doesNotMatch(run.stdout, /joining/, 'the capture refuses before it joins anything')
})

// An image is packaging a client never sees. Unnamed, the fixture says so, because the
// gate lane's image in a fixture from another image is the claim this replaces.
test('#367 an image nobody named is recorded as unobserved, not as the gate image', () => {
  assert.equal(captureImage({ image: null }), null, 'no image is recorded for an image nobody named')
  const written = JSON.parse(JSON.stringify({
    capturedFrom: captureProvenance({
      version: '26.2',
      lane: 'monoplayer-gate-x',
      paperBuild: '136',
      image: captureImage({ image: null }),
      host: '127.0.0.1',
      port: 25599,
      offline: true,
      reachedVia: 'kubectl -n monoplayer-gate-x port-forward pod/capture-paper 25599:25565',
      note: null,
      at: '2026-11-25T00:00:00.000Z'
    }),
    frames: []
  }))
  assert.equal(written.capturedFrom.image, null, 'the fixture records that it read no image')
  assert.doesNotMatch(JSON.stringify(written), /minecraft-server/, 'and the gate lane\'s image does not stand in for it')
  assert.equal(
    captureImage({ image: 'itzg/minecraft-server:2026.10.1-java25' }),
    'itzg/minecraft-server:2026.10.1-java25',
    'an image an operator names is the image recorded'
  )
})

// The recorded command is the capture's own: every flag that decided what the fixture
// holds is in it, and the commentary flags are not.
test('#367 the recorded command carries the lane, the build and the image', () => {
  const inputs = captureInputs(
    ['--host', '127.0.0.1', '--port', '25599', '--paper-build', '136', '--image', 'itzg/minecraft-server:2026.10.1-java25', '--offline'],
    { env: {}, resolve: () => 'monoplayer-gate-x' }
  )
  const { command } = captureProvenance({ ...inputs, at: '2026-11-25T00:00:00.000Z' })
  assert.equal(
    command,
    'node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --version 26.2 --offline --lane monoplayer-gate-x --paper-build 136 --image itzg/minecraft-server:2026.10.1-java25 --out <fixture>',
    'the command is the capture that produced the fixture, not a shorter one'
  )
  assert.doesNotMatch(command, /--note|--account|--timeout|--reached-via/, 'commentary, identity and patience decide nothing the fixture holds')
})

// One token per value, so the recorded line is a command a shell can run as written.
const argvOf = command => {
  const entry = 'node src/ladder/capture-config.js '
  assert.ok(command.startsWith(entry), 'the recorded command is this module: ' + command)
  return command.slice(entry.length).split(' ')
}

// The point of the ticket: a reader who repeats the recorded command reaches the same
// fixture. The replay runs where the resolver cannot answer, so a command that dropped
// --lane records a lane nobody captured.
test('#367 a recorded command replays to the same provenance', () => {
  const capture = captureInputs(
    ['--host', '127.0.0.1', '--port', '25599', '--paper-build', '136', '--image', 'itzg/minecraft-server:2026.10.1-java25', '--offline'],
    { env: {}, resolve: () => 'monoplayer-gate-x' }
  )
  const recorded = captureProvenance({ ...capture, at: '2026-11-25T00:00:00.000Z' })
  // The replay runs where every default would answer differently: another version in the
  // environment, and a resolver that cannot name a lane. Only a command carrying those
  // flags records the fixture it describes.
  const replay = captureInputs(argvOf(recorded.command), {
    env: { MONOPLAYER_VERSION: '26.1', MONOPLAYER_BACKEND_HOST: '10.0.0.9' },
    resolve: () => { throw new LaneError('the replay asked this worktree for a lane') }
  })
  assert.deepEqual(captureProvenance({ ...replay, at: recorded.at }), recorded, 'the recorded command reproduces the fixture it describes')
})

// The same rule, on the evidence that ships: the committed fixture's own command
// reproduces the committed fixture, and its build and image keep the values they were
// captured with. A fixture is dated evidence, so nothing here recaptures it.
test('#367 the committed 26.2 fixture replays from its own recorded command', () => {
  const file = path.join(WORKTREE, 'src', 'legs', 'configuration-baseline', '26.2.json')
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  const replay = captureInputs(argvOf(fixture.capturedFrom.command), {
    env: { MONOPLAYER_VERSION: '26.1' },
    resolve: () => { throw new LaneError('a fixture names its own lane') }
  })
  const { note, ...replayed } = captureProvenance({ ...replay, at: fixture.capturedFrom.at })
  const { note: recordedNote, ...actual } = fixture.capturedFrom
  assert.deepEqual(replayed, actual, 'the fixture\'s command reproduces the fixture, apart from its note')
  assert.equal(actual.paperBuild, '135', 'the committed fixture keeps the build it was captured at')
  assert.equal(actual.image, 'itzg/minecraft-server:2026.10.1-java25', 'and the image it named')
  assert.match(recordedNote, /online-mode is off/, 'and the note that explains it')
})

// Every field this ticket is about comes from an operator or the socket. A second
// default here is the defect: it would record the gate lane's build for every server.
test('#367 the capture defaults neither the build nor the image', () => {
  assert.doesNotMatch(SOURCE, /DEFAULT_PAPER_BUILD|DEFAULT_IMAGE/, 'no build and no image are spelled as a default')
  assert.doesNotMatch(SOURCE, /'135'/, 'not even the gate lane\'s build')
  assert.match(SOURCE, /captureBuild\(/, 'the build is an operator\'s or the capture stops')
})

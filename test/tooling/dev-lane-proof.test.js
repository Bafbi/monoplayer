// The dev lane's two-client proof (#634) is a runbook section and one reader. Nothing here
// reaches a cluster: the cases read the files.
//
// The section tells an operator which counters and which events to read after they have
// driven two real clients. A counter renamed in the service, or an event renamed in a leg,
// would leave that instruction pointing at nothing, and the operator would read "0" as "the
// frame did not arrive". So the names the section uses are held to the files that write
// them, the way `opentelemetry` names are held in test/tooling/env-overlay-surface.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const DEV_README = read('deploy/dev/README.md')
const CORE = read('src/service/monoplayer.js')
const FRONT = read('src/legs/live-front.js')
const START = read('src/service/start-live.js')
const PROOF = read('src/driver/dev-proof.js')

const SECTION = 'The two-client proof'

// The section, from its heading to the next heading of the same or a higher level, so no
// assertion here can be satisfied by a line elsewhere in the file.
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

// The first line that runs a task, with the lookahead that keeps "dev:image" from matching
// "dev:image:something".
function firstUse (text, task) {
  return text.search(new RegExp('^\\s*mise run ' + task + '(?=\\s|$)', 'm'))
}

// The counters the checklist tells an operator to read. Each is a key of the core's metrics
// document, which every heartbeat copies into its record (`src/service/start-live.js`,
// `log('heartbeat', { metrics: { ...core.metrics } })`).
const COUNTERS = [
  'spectatorViews',
  'skinFramesWritten',
  'virtualPlayersAnnounced',
  'virtualPlayersSpawned',
  'virtualPlayersMoved',
  'virtualPlayersDespawned',
  'virtualPlayersRefused'
]

// The events, with the file that writes each. A log line is the only place a channel is
// named, so these are what tells a reader which socket a frame reached.
const EVENTS = [
  { name: 'spectateView', file: CORE },
  { name: 'spectateRefused', file: CORE },
  { name: 'spectateViewRefused', file: CORE },
  { name: 'puppetSkinSent', file: CORE },
  { name: 'virtualPlayerWritten', file: CORE },
  { name: 'virtualPlayerRefused', file: CORE },
  { name: 'virtualPlayerAnnounceRefused', file: CORE },
  { name: 'heartbeat', file: START },
  { name: 'pickerServed', file: FRONT },
  { name: 'pickerEmpty', file: FRONT }
]

test('the dev runbook carries the two-client proof, and the name of the command that reads it', () => {
  const proof = section(DEV_README, SECTION)

  // The lane under test, in the order the run takes it: the proxy on the branch image, then
  // its own status, then the two clients a person drives. `dev:join` is not a staging step: a
  // picker lane dials no backend at boot, so it reports no login until somebody claims.
  const order = ['dev:up', 'dev:image', 'dev:status'].map(task => ({ task, at: firstUse(proof, task) }))
  for (const { task, at } of order) assert.notEqual(at, -1, 'the proof runs mise run ' + task)
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i].at > order[i - 1].at, 'mise run ' + order[i].task + ' comes after mise run ' + order[i - 1].task)
  }

  // The reader, and the file behind it.
  assert.match(proof, /node src\/driver\/dev-proof\.js/, 'the proof names the command that reads the run')
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'driver', 'dev-proof.js')), 'the command it names exists')
  assert.match(proof, /kubectl[^\n]*-n monoplayer-dev logs/, 'the records it reads come from the dev lane only')
  assert.doesNotMatch(proof, /kubectl[^\n]*-n monoplayer /, 'and never from the live lane')

  // The sequence above is only true while a picker lane dials nothing at boot. The section
  // says so with the record that says so, and the record is held to the caller that writes it.
  assert.match(proof, /backendBootSkipped/, 'the proof says the lane dials nothing at boot')
  assert.match(START, /reason: 'picker'[\s\S]{0,40}/, 'src/service/start-live.js skips the boot dial')
  assert.match(START, /log\('backendBootSkipped', \{ reason: 'picker' \}\)/, 'and names the record the doc quotes')
})

test('the two-client proof requires two real accounts, because the front verifies each login', () => {
  const proof = section(DEV_README, SECTION)
  assert.match(proof, /two accounts/i, 'the precondition two clients share is stated')
  assert.match(proof, /attach whitelist/i, 'the document both must be in is named')
  assert.match(proof, /Mojang/, 'and why an entry that is not a real account\'s admits nobody')
})

test('every counter the proof tells an operator to read is one the service counts', () => {
  const proof = section(DEV_README, SECTION)
  for (const counter of COUNTERS) {
    assert.match(proof, new RegExp(counter), 'the proof tells the operator to read ' + counter)
    assert.match(CORE, new RegExp('^\\s+' + counter + ': 0,', 'm'), 'src/service/monoplayer.js counts ' + counter)
  }
})

test('every event the proof names is one a leg or the service writes', () => {
  const proof = section(DEV_README, SECTION)
  for (const { name, file } of EVENTS) {
    assert.match(proof, new RegExp(name), 'the proof names the ' + name + ' record')
    const owner = file === CORE ? 'src/service/monoplayer.js' : (file === FRONT ? 'src/legs/live-front.js' : 'src/service/start-live.js')
    assert.match(file, new RegExp("log\\('" + name + "'|\\n\\s+log\\('" + name + "'"),
      owner + ' writes ' + name)
  }
})

test('the proof says which half no counter can answer, and never claims it', () => {
  const proof = section(DEV_README, SECTION)
  assert.match(proof, /witness/i, 'the half that needs eyes is named as a witness')
  assert.match(proof, /cannot|does not|not a proof/i, 'and says what a count does not show')
  // The reader's own rows: the answerable ones, and the one nobody's log answers.
  assert.match(PROOF, /WITNESS/, 'the reader prints the unproven row')
  assert.match(PROOF, /nobody has looked yet/, 'and says in its own output that nobody has')
})

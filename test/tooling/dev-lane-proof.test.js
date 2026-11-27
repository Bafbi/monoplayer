// The dev lane's two-client proof (#634) is a runbook section, one reader, and a witness the
// operator completes. Nothing here reaches a cluster: the cases read the files.
//
// The section tells an operator which counters to read and which claims only eyes can answer.
// A counter renamed in the service, or a provenance claim the code no longer holds, would leave
// that instruction pointing at nothing, and the operator would read "0" as "the frame did not
// arrive". So the names the section uses are held to the files that write them, the way
// `test/tooling/env-overlay-surface.test.js` holds the environment names.
//
// What is *not* here: the records the reader reads. `RECORDS` in src/driver/dev-proof.js owns
// that list, and test/driver/dev-proof.test.js holds the runbook's table to it in one place.
//
// The two helpers below are copies of test/tooling/dev-lane-runbook.test.js's, and they stay
// local for the reason that file gives: a guard that shares a helper with the guard it is
// modelled on fails when that one is edited, and a false red costs more than six lines.
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
const ATTACH = read('src/custody/attach.js')

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

test('the dev runbook carries the two-client proof, and the command that reads it', () => {
  const proof = section(DEV_README, SECTION)

  // The lane under test, in the order the run takes it: the proxy on the branch image, then
  // its own status, then the two clients a person drives. `dev:join` is not a staging step: a
  // picker lane dials no backend at boot, so it reports no login until somebody claims.
  const order = ['dev:up', 'dev:image', 'dev:status'].map(task => ({ task, at: firstUse(proof, task) }))
  for (const { task, at } of order) assert.notEqual(at, -1, 'the proof runs mise run ' + task)
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i].at > order[i - 1].at, 'mise run ' + order[i].task + ' comes after mise run ' + order[i - 1].task)
  }

  // The reader, and the two files it names: the one it writes, and the one a completed record
  // lives in.
  assert.match(proof, /node src\/driver\/dev-proof\.js/, 'the proof names the command that reads the run')
  assert.match(proof, /\.reports\/dev-two-client-witness\.json/, 'the witness it writes is named')
  assert.match(proof, /testdata\/dev-two-client-witness\.json/, 'and where a completed one lives')
  assert.match(proof, /dev-proof\.js --verify/, 'and the command that reads the witness back')

  // The records come from the dev lane, never the live one.
  assert.match(proof, /kubectl[^\n]*-n monoplayer-dev logs/, 'the records it reads come from the dev lane only')
  assert.doesNotMatch(proof, /kubectl[^\n]*-n monoplayer /, 'and never from the live lane')

  // The sequence above is only true while a picker lane dials nothing at boot. The section says
  // so with the record that says so, and the record is held to the caller that writes it.
  assert.match(proof, /backendBootSkipped/, 'the proof says the lane dials nothing at boot')
  assert.match(START, /log\('backendBootSkipped', \{ reason: 'picker' \}\)/, 'src/service/start-live.js names the record and the reason')
})

test('the two-client proof requires two real accounts, because the front verifies each login', () => {
  const proof = section(DEV_README, SECTION)
  assert.match(proof, /two accounts/i, 'the precondition two clients share is stated')
  assert.match(proof, /attach whitelist/i, 'the document both must be in is named')
  assert.match(proof, /monoplayer-dev-config/, 'the section names the ConfigMap that holds it')
  assert.match(proof, /not_whitelisted/, 'and the refusal a missing entry earns')
  assert.match(proof, /Mojang/, 'and why an entry that is not a real account\'s admits nobody')
})

test('every counter the proof tells an operator to read is one the service counts', () => {
  const proof = section(DEV_README, SECTION)
  for (const counter of COUNTERS) {
    assert.match(proof, new RegExp(counter), 'the proof tells the operator to read ' + counter)
    assert.match(CORE, new RegExp('^\\s+' + counter + ': 0,', 'm'), 'src/service/monoplayer.js counts ' + counter)
  }
})

test('the proof says which half no counter can answer, and never claims it', () => {
  const proof = section(DEV_README, SECTION)
  assert.match(proof, /witness/i, 'the half that needs eyes is named as a witness')
  assert.match(proof, /not-seen/, 'and the state a gap is recorded in')
  assert.match(proof, /#647/, 'the step expected to fail today names its ticket')

  // The reader's own half: the steps it never answers, and the verification that refuses them.
  assert.match(PROOF, /OPERATOR_STEPS/, 'the reader carries the steps no log answers')
  assert.match(PROOF, /verifyWitness/, 'and the check that refuses an unrecorded one')
  assert.match(PROOF, /NOT COMPLETE/, 'whose message says what is missing')
  // The polarity is the driver lane's unmodded witness: one exit code 1 for "not recorded".
  const run = read('src/driver/run.js')
  assert.match(run, /NOT COMPLETE: the unmodded witness file is missing or not marked completed/,
    'src/driver/run.js keeps the same message shape')
})

test('a login is verified and whitelisted before the picker, which is what makes the account list the gate', () => {
  // The section turns on this: an entry whose UUID nobody owns can never reach a picker. Two
  // gates hold it, in two places. The whitelist is the core's (src/core/identity.js), called
  // from the composition root's login path.
  //
  // #691: the sessionserver's hasJoined is the leg's, not the core's. This case used to read
  // `await identity.verifySession(payload)` in CORE for that half, and that line lived in
  // `processVerifySession`, which no lane called: a guard matching a function nothing runs
  // proves nothing about a join. So it reads each fact the claim stands on, in the file that
  // holds it.
  assert.match(CORE, /identity\.reviewLoginStart\(payload\)/, 'the whitelist reviews the login')
  assert.match(FRONT, /'online-mode': onlineMode/, 'on a front leg running its configured mode')
  assert.match(ATTACH, /function checkVerified[\s\S]*?store\.has\(uuid\)/, 'and its attach check decides on the uuid the client carries')
  // #756: the core's review is the one review a login gets, so the leg's own check
  // answers only a lane whose core wired no login-start handler. The count itself is
  // proven by a run, in test/legs/whitelist-reviewed-once.test.js, not by this text.
  assert.match(FRONT, /check\.checkVerified\(\{ client, store \}\)/, 'which the leg runs over its own beforeLogin when the core answered nothing')
})

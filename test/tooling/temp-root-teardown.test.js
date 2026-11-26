// Every temp root a test makes is removed when that file's tests finish, so one
// gate run leaves nothing for the next to trip over (#558). Before this rule a
// gate run left hundreds of roots in the OS temp directory, /tmp on the
// development machine ran out of inodes, and the gate then failed for a reason
// unrelated to the change under test.
//
// The rule is one seam: tempRoot in test/support/temp.js. That file is the only
// place allowed to create a directory, and the rest of the tree asks it. Two
// cases hold the rule up:
//
//   1. No file under test/ calls a mkdtemp itself. That is this file's walk.
//   2. The seam really removes what it makes, on the passing path and the
//      failing path. A walk cannot show that, so the second case runs a real
//      test file and looks at the directory afterwards.
//
// The walk reads text, so it cannot see a temp directory made some other way: a
// shell script a test runs, or a dependency. It reads every .js file under test/,
// not only the .test.js ones, because a shared helper is exactly where a second
// way to make a root would hide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempRoot } from '../support/temp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = fileURLToPath(import.meta.url)
const SEAM = path.join(ROOT, 'test', 'support', 'temp.js')
const TEST_DIR = path.join(ROOT, 'test')

// Recursive, so a file added in a new area is covered without editing this one.
function sources (dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

// A comment that names the call is not a call. test/tooling/env-overlay-surface.test.js
// filters its lines the same way, and for the same reason: a sentence explaining
// the rule must not be the thing that fails it.
const isCode = line => !/^\s*(\/\/|\*|\/\*)/.test(line)

// A call, not a mention: the parenthesis is what separates the two.
const MAKES_A_ROOT = /\bmkdtemp(?:Sync)?\s*\(/

// Read the tree once, so a case cannot pass on a tree a later case changed.
const FILES = sources(TEST_DIR)

function callSites () {
  const sites = []
  for (const file of FILES) {
    // Two exemptions, and both are the rule rather than an exception to it: this
    // file names the call it forbids, and the seam is where the call belongs.
    if (file === SELF || file === SEAM) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (isCode(line) && MAKES_A_ROOT.test(line)) {
        sites.push(path.relative(ROOT, file) + ':' + (index + 1) + ': ' + line.trim())
      }
    })
  }
  return sites
}

// A walk that finds nothing reports no offenders, which is the same answer as a
// clean tree. Naming files in three areas is what separates the two.
test('the guard found the tree it reads', () => {
  for (const file of ['tooling/gate-lane', 'testbed/switch', 'custody/msa']) {
    assert.ok(FILES.includes(path.join(TEST_DIR, file + '.test.js')),
      'the walk missed test/' + file + '.test.js, so its roots are unguarded')
  }
  assert.ok(FILES.includes(SEAM), 'the walk missed the seam itself, so it reads no tree')
})

// The message is the product: it is what the next author acts on. It is built in one
// place so a case can render one without a tree that already offends.
const refusal = offenders =>
  'a file under test/ calls a mkdtemp itself, so nothing removes its root. Use tempRoot ' +
  'from test/support/temp.js, whose import registers the removal:\n  ' + offenders.join('\n  ')

test('no file under test/ makes a temp root outside the seam that removes it', () => {
  const offenders = callSites()
  assert.deepEqual(offenders, [], refusal(offenders))
})

test('the message names the file, the line, the call, and the seam to use', () => {
  const text = refusal(['test/tooling/x.test.js:4: const dir = fs.mkdtempSync(path.join(os.tmpdir(), \'x-\'))'])
  assert.match(text, /test\/tooling\/x\.test\.js:4/, 'the file and the line: ' + text)
  assert.match(text, /fs\.mkdtempSync/, 'the call it found: ' + text)
  assert.match(text, /test\/support\/temp\.js/, 'the seam to use instead: ' + text)
})

// The guard above proves the seam is used, not that it works: delete the hook in
// test/support/temp.js and every case here still passes while the leak returns.
// This case runs a real test file, with one passing case and one failing case, and
// looks at the directory afterwards. It is also the only case that shows the
// failing path, which is the path a leaking test takes in CI.
test('the seam removes its roots on the passing path and the failing path', () => {
  const prefix = 'monoplayer-teardown-probe-'
  const space = tempRoot('monoplayer-teardown-fixture-')
  const log = path.join(space, 'ran.log')
  // .mjs, because a .js file outside a package with "type": "module" is CommonJS,
  // so the fixture's own imports would fail to load and it would make no root.
  const fixture = path.join(space, 'probe.test.mjs')
  const seam = JSON.stringify(pathToFileURL(SEAM).href)

  // The log is the proof the fixture ran. Without it a fixture that failed to load
  // would leave no roots and read as a pass, which is the one way this case can
  // lie.
  fs.writeFileSync(fixture, [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import fs from 'node:fs'",
    'const { tempRoot } = await import(' + seam + ')',
    'const log = process.env.MONOPLAYER_PROBE_LOG',
    'const note = line => fs.appendFileSync(log, line + "\\n")',
    'const prefix = ' + JSON.stringify(prefix),
    '',
    "test('passes and makes a root', () => {",
    "  const root = tempRoot(prefix + 'pass-')",
    '  note(\'pass \' + root)',
    '  assert.ok(fs.existsSync(root))',
    '})',
    '',
    "test('fails after making a root', () => {",
    "  const root = tempRoot(prefix + 'fail-')",
    '  note(\'fail \' + root)',
    '  assert.ok(fs.existsSync(root))',
    "  assert.fail('the root this case made must still be removed')",
    '})',
    ''
  ].join('\n'))

  // Node marks every test child with these two. A `node --test` that inherits them
  // refuses to run any file ("run() is being called recursively"), which leaves the
  // fixture unrun and this case reading as a pass. They have to be dropped by hand.
  const env = { ...process.env, MONOPLAYER_PROBE_LOG: log }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID

  const result = spawnSync(process.execPath, ['--test', fixture], { encoding: 'utf8', env })

  const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  assert.deepEqual(ran.map(line => line.split(' ')[0]), ['pass', 'fail'],
    'the fixture did not run both of its cases, so this case proves nothing: ' + result.stdout + result.stderr)

  const made = ran.map(line => line.split(' ')[1])
  assert.equal(made.every(dir => !fs.existsSync(dir)), true,
    'the seam left a root behind, so every test file that uses it leaks: ' + made.join(', '))
})

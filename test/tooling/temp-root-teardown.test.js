// Every temp root a test makes is removed when that file's tests finish, so one
// gate run leaves nothing for the next to trip over (#558). Before this rule a
// gate run left hundreds of roots in the OS temp directory, /tmp on the
// development machine ran out of inodes, and the gate then failed for a reason
// unrelated to the change under test.
//
// The rule is one seam: `tempRoot` in test/support/temp.js. A file that calls
// `fs.mkdtempSync` itself gets no removal, because the hook that removes these
// roots is registered by that helper's import. An author who skips the helper
// skips the hook, and the root stays until a human notices the disk. This guard
// fails instead.
//
// The scan reads every test file in the tree, not only test/tooling/, because the
// roots that filled /tmp came from every area: `monoplayer-switch` from
// test/testbed, `auth-*` from test/custody. A scan confined to this directory
// would pass while the disk filled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = fileURLToPath(import.meta.url)

// Recursive, so a test added in a new area is covered without editing this file.
function testFiles (dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(full))
    else if (entry.name.endsWith('.test.js')) found.push(full)
  }
  return found
}

// A comment that names the call is not a call. test/tooling/env-overlay-surface.test.js
// filters its lines the same way, and for the same reason: a sentence explaining the
// rule must not be the thing that fails it.
const isCode = line => !/^\s*(\/\/|\*|\/\*)/.test(line)

// Read the tree once, so a case cannot pass on a tree a later case changed.
const FILES = testFiles(path.join(ROOT, 'test'))

function callSites () {
  const sites = []
  for (const file of FILES) {
    // This file names the call it forbids, so it is the one exemption.
    if (file === SELF) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (isCode(line) && line.includes('mkdtempSync')) {
        sites.push(path.relative(ROOT, file) + ':' + (index + 1) + ': ' + line.trim())
      }
    })
  }
  return sites
}

// A walk that finds nothing reports no offenders, which is the same answer as a
// clean tree. This case is what separates the two.
test('the guard found the test tree it reads', () => {
  assert.ok(FILES.length > 20, 'the walk found ' + FILES.length + ' test files, so it is not reading test/')
  assert.ok(FILES.includes(path.join(ROOT, 'test', 'tooling', 'gate-lane.test.js')),
    'the walk missed test/tooling/gate-lane.test.js, so its roots are unguarded')
  assert.ok(FILES.includes(path.join(ROOT, 'test', 'testbed', 'switch.test.js')),
    'the walk missed test/testbed/switch.test.js, which made the monoplayer-switch roots')
})

test('no test file makes a temp root outside the seam that removes it', () => {
  const offenders = callSites()
  assert.deepEqual(offenders, [],
    'a test file calls fs.mkdtempSync and nothing removes its root. Use tempRoot from ' +
    'test/support/temp.js, whose import registers the removal:\n  ' + offenders.join('\n  '))
})

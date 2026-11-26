// A temp root for one test file, removed when that file's tests finish, passing
// or failing (#558). Without this, every gate run left its roots under the OS
// temp directory, /tmp on the development machine ran out of inodes, and the gate
// then failed for a reason unrelated to the change under test.
//
// The hook is registered here, at import time, and not inside a test. `t.after`
// cannot reach a root made inside a module-level factory such as `space()` or
// `workspace()`, and that is where most of these roots are made. An `after()`
// called from inside a test attaches to that one test: measured, it removed one
// root of three. An `after()` at this module's top level attaches to the
// importing file's suite, which runs once, after every test in that file, whether
// they passed or failed.
//
// One limit, measured: a file that throws while it is still being evaluated never
// collects its hooks, so roots it made would stay. No file in this tree makes one
// at module scope, so nothing reaches that path today.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs
// on its own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

const roots = []

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true })
  roots.length = 0
})

// A new directory under the OS temp directory, named with the caller's prefix, so
// a root seen during a run names the test file that made it.
//
// A test that has to read its root after the run keeps it under `.reports/` or
// `.scratch/` instead: both are gitignored and are the repo's places for output a
// human reads later. A root that must sit outside any git work tree stays on the
// OS temp directory, which four cases in this tree need in order to prove a
// refusal outside one.
export function tempRoot (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

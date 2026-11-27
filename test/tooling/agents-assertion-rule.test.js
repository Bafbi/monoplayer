// AGENTS.md's loopback assertion bullet (#622). The bullet told an agent adding an
// assertion to add the `check` call and the doc bullet, and named neither the
// declaration the contract guard reads (`LOOPBACK_ASSERTION_IDS`) nor its order, so
// an agent learned about the third home from a red run.
//
// This is the repo's claim about itself, held where every other one is
// (test/tooling/mise-tasks.test.js holds the gate bullet, test/tooling/
// env-overlay-surface.test.js the config surface's). It reads one line of prose and
// asserts the names an agent needs: the declaration, the mark the next id is numbered
// above (#681), the file, and the guard. What it cannot hold is the wording around
// them, so it says which names, not which sentence.
//
// No case opens a socket: it reads AGENTS.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')

const bullet = AGENTS.split('\n').find(line => line.includes('A loopback assertion is numbered'))

test('the loopback assertion bullet names the homes an agent has to edit', () => {
  assert.ok(bullet, 'AGENTS.md carries the loopback assertion bullet')

  for (const home of ['LOOPBACK_ASSERTION_IDS', 'LOOPBACK_ASSERTION_HIGH_WATER', 'src/ladder/loopback.js', 'test/ladder/loopback-contract.test.js']) {
    assert.ok(bullet.includes(home),
      'the bullet names ' + home + ': an agent that reads only this line still learns the declaration, the mark, the file it lives in, and the guard')
  }
})

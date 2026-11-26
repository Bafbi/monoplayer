// The loopback assertion contract (#49, #593). `src/ladder/loopback.js` exports
// LOOPBACK_ASSERTION_IDS, and `docs/testing-ladder.md` documents each id as a
// bullet. This file holds the two together in both directions: a declared id
// without a bullet fails, and a bullet without a declared id fails.
//
// It reads the declaration, not the rung's source text (#593). The mechanism was
// a regex over the source, and it made an assertion fail the guard the moment it
// moved into a helper module: the helper's check() call is not in the rung's
// text, while the declaration and the bullet are both still there. The same
// regex is what forbade extracting an assertion in the first place.
//
// The other half of the contract is the run's own, and since #623 it is about
// order: the list is the run order, so the nth check must name the nth id. An id
// appended to the end of the list and checked in the middle of the run fails there,
// which is what two sets could not see (#594 did exactly that). A file that reads
// the list cannot see the calls, so this half is checked where the calls are: the
// cases below pin the rule, and `mise run loopback` walks it. `mise run check` runs
// both.
//
// The declaration's own claim is here too, because the rule cannot make it: no id
// twice, since a position and a duplicated id agree at both sites. AGENTS.md's
// sentence about the list is guarded in test/tooling/agents-assertion-rule.test.js,
// where the repo keeps the claims it makes about itself.
//
// No case opens a socket: they import the rung's declaration and read the doc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOOPBACK_ASSERTION_IDS, orderDrift } from '../../src/ladder/loopback.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LADDER = fs.readFileSync(path.join(ROOT, 'docs/testing-ladder.md'), 'utf8')

// One section, from its heading to the next heading of the same or a higher
// level, so an id bullet elsewhere in the file cannot satisfy the contract.
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

// The ids the doc documents: a bullet that opens with the id in code. An id
// mentioned mid-sentence is a cross-reference, not documentation.
function docIds (text) {
  return [...section(text, 'Loopback assertion contract').matchAll(/^- `([^`]+)`/gm)]
    .map(match => match[1])
}

const missingFrom = (ids, other) => ids.filter(id => !other.includes(id))

function drift (declared, doc) {
  const documented = docIds(doc)
  return {
    declared,
    documented,
    undocumented: missingFrom(declared, documented),
    undeclared: missingFrom(documented, declared)
  }
}

// Both directions in one message: a rename in the source drifts twice, and only
// a report of both tells a reader what to fix on each side.
function disagreement ({ undocumented, undeclared }) {
  return [
    undocumented.length === 0
      ? null
      : 'docs/testing-ladder.md does not document ' + undocumented.join(', ') +
        ', which src/ladder/loopback.js declares: add a bullet for ' +
        (undocumented.length === 1 ? 'it' : 'each') + ' under "Loopback assertion contract"',
    undeclared.length === 0
      ? null
      : 'src/ladder/loopback.js declares no ' + undeclared.join(', ') +
        ', which docs/testing-ladder.md documents: add the check and its id to ' +
        'LOOPBACK_ASSERTION_IDS, at the position the run makes the check, or remove the bullet'
  ].filter(Boolean)
}

test('every assertion the loopback declares is documented, and the reverse', () => {
  const declared = [...LOOPBACK_ASSERTION_IDS]
  const drifted = drift(declared, LADDER)

  // Both sides have to be read, or a reformat that matches nothing would pass.
  assert.ok(drifted.declared.length > 0, 'src/ladder/loopback.js declares its assertions with LOOPBACK_ASSERTION_IDS')
  assert.ok(drifted.documented.length > 0, 'docs/testing-ladder.md documents the contract as bullets')
  // The repeated id, not the whole list: the repair is to remove one, and a message
  // that printed the whole list would not say which.
  const repeated = ids => ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(repeated(drifted.declared), [], 'no assertion id is declared twice')
  assert.deepEqual(repeated(drifted.documented), [], 'no assertion id is documented twice')

  assert.deepEqual(disagreement(drifted), [], 'the run and its document disagree')
})

test('the guard notices an id that only one side holds', () => {
  // Fixtures, not the tree: this case tests the comparison, so a real drift
  // cannot make the case about the drift instead.
  const declared = ['O1', 'O2']
  const doc = [
    '### Loopback assertion contract',
    '',
    '- `O1` the first check.',
    '- `O2` the second check.',
    '',
    '## The next rung',
    '',
    '- `O3` a bullet outside the contract, which does not document it.',
    ''
  ].join('\n')
  const inSection = bullet => doc.replace('## The next rung', bullet + '\n\n## The next rung')

  assert.deepEqual(drift(declared, doc), {
    declared: ['O1', 'O2'],
    documented: ['O1', 'O2'],
    undocumented: [],
    undeclared: []
  }, 'the guard reads the declaration and the contract bullets, and nothing else')

  const renamed = drift(['O1b', 'O2'], doc)
  assert.deepEqual(renamed.undocumented, ['O1b'], 'a declared id the doc does not document is reported')
  assert.deepEqual(renamed.undeclared, ['O1'], 'and the id the doc documents but the declaration dropped is reported')
  assert.deepEqual(disagreement(renamed), [
    'docs/testing-ladder.md does not document O1b, which src/ladder/loopback.js declares: ' +
      'add a bullet for it under "Loopback assertion contract"',
    'src/ladder/loopback.js declares no O1, which docs/testing-ladder.md documents: ' +
      'add the check and its id to LOOPBACK_ASSERTION_IDS, at the position the run makes the check, or remove the bullet'
  ], 'one failure names both sides')

  assert.deepEqual(drift(declared, doc.replace(/^- `O2`.*\n/m, '')).undocumented, ['O2'],
    'a bullet removed from the doc is reported')
  assert.deepEqual(drift(declared, inSection('- `O99` an assertion nobody runs.')).undeclared, ['O99'],
    'a bullet the declaration does not hold is reported')
})

test('the run order is the list, and each disagreement names its own repair', () => {
  // Fixtures again: the run's half of the contract, which the guard's own cases
  // cannot reach because they read the list and not the calls.
  const ids = ['R0', 'O1', 'O2']

  assert.equal(orderDrift(ids, ['R0', 'O1', 'O2']), null,
    'a run that walked the list in order has nothing to report')

  // The four disagreements, told apart, because the repair differs: a missing check
  // and an unlisted id are fixed on opposite sides, and a swap is the order.
  assert.deepEqual(orderDrift(ids, ['R0', 'O2', 'O1']),
    { kind: 'order', at: 1, declared: 'O1', ran: 'O2' },
    'a list out of order with the run is reported at the first position that disagrees')
  assert.deepEqual(orderDrift(ids, ['R0', 'O1']),
    { kind: 'unrun', ids: ['O2'] },
    'a run that stopped short names the id no check reached, and says the check is missing')
  assert.deepEqual(orderDrift(ids, ['R0', 'O1', 'O2', 'O9']),
    { kind: 'undeclared', ids: ['O9'] },
    'a check the list does not declare is reported as unlisted, not as a swap')
  assert.deepEqual(orderDrift(ids, ['R0', 'O1', 'O2', 'O2']),
    { kind: 'repeated', ids: ['O2'] },
    'an id the run made twice is the one sequence broken')
  // A mixed run reports the missing check before the order, so the repair a reader
  // reads first is the one that puts the claim back.
  assert.deepEqual(orderDrift(ids, ['R0', 'O2', 'O9']),
    { kind: 'unrun', ids: ['O1'] },
    'a run that deleted a check and added another is reported as the deletion')
})



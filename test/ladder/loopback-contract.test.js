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
// #681: the numbering rule had no reader either. "A loopback assertion is numbered
// above the current highest" needs a number to read, because the list is the run order
// and says nothing about which numbers are taken. LOOPBACK_ASSERTION_HIGH_WATER is that
// number, and EVER below is every id this repository has ever declared, retired ones
// included. A deletion that leaves no retirement is the one edit that used to pass
// every guard in this file, and a retirement is what keeps the number from being handed
// out a second time.
//
// No case opens a socket: they import the rung's declaration and read the doc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOOPBACK_ASSERTION_HIGH_WATER, LOOPBACK_ASSERTION_IDS, orderDrift } from '../../src/ladder/loopback.js'

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

// Every id this repository has ever declared, in number order, the retired ones
// included (#681). This list only grows. A new assertion adds its id here in the same
// commit as its check, its declaration and its bullet. An id that leaves
// LOOPBACK_ASSERTION_IDS lands in RETIRED below, because its number is burned either
// way. The record cannot be derived from the declaration: a deletion would take its own
// record with it, and nothing would be left to notice the number coming back.
const EVER = [
  'R0', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10', 'O11',
  'O11b', 'O12', 'O13', 'O14', 'O15', 'O16', 'O17', 'O18', 'O19', 'O20',
  'O21', 'O22', 'O23', 'O24', 'O24b', 'O25', 'O26', 'O27', 'O28', 'O29',
  'O30', 'O31', 'O32', 'O33', 'O34', 'O35', 'O36', 'O37', 'O38', 'O39',
  'O40', 'O41', 'O41b', 'O42', 'O43', 'O44', 'O45', 'O46', 'O47', 'O48',
  'O49', 'O50', 'O51', 'O52', 'O53', 'O54', 'O54b', 'O55', 'O55b', 'O56',
  'O56b', 'O56c', 'O57', 'O58', 'O59', 'O60', 'O60b', 'O61', 'O62', 'O63',
  'O64', 'O65', 'O66', 'O67', 'O68', 'O69', 'O70', 'O71', 'O72', 'O73',
  'O74', 'O75', 'O76'
]

// The ids this repository has retired, by id, with the claim the number used to name.
// An entry is the edit that retires an assertion, and the value says what was lost, so a
// reader meets the claim the number may not name again. Retiring is allowed. Reusing the
// number is not: the bullet that described the retired claim is gone. The id that came
// back would document a claim it never made.
const RETIRED = {
  O54: "an operator's move kept the client's connection and landed it in the second backend's " +
    'configuration and play state (#233), retired with the backend move in 82e188e',
  O54b: "a target that never answered left the client on the backend it was on, connected (#233), " +
    'retired with O54'
}

// The number an id carries. The letter is the family and the number is the place in the
// one sequence, so R0 is number 0 and O54b is number 54.
const ASSERTION_ID = /^[A-Z](\d+)[a-z]*$/

function numberOf (id) {
  const found = ASSERTION_ID.exec(id)
  return found === null ? null : Number(found[1])
}

const idNumbers = ids => ids.map(numberOf).filter(number => number !== null)

// The ids at or below the mark are every number from 0 to it, because a number is what
// an id takes and a skipped one is a number nobody can account for. A case builds a
// record that wide with this, so the fixture reads as a numbering and not as a list.
const sequence = last => ['R0', ...Array.from({ length: last }, (_, at) => 'O' + (at + 1))]

// "O3 is" and "O3, O4 are": a message that says "O3, O4 is" reads as a bug in the guard.
const oneOf = (ids, one, many) => (ids.length === 1 ? one : many)

// The numbering rule, as sentences, one repair each. `declared` is the run's list,
// `ever` the record above, `retired` the retired ids, and `highWater` the mark beside
// the list. An empty answer is the good one, and the order is the order a reader meets
// the edits: the id's own number, then the mark, then the record.
function numberingDrift ({ declared, ever, retired, highWater }) {
  const problems = []
  const next = 'O' + (highWater + 1)
  const unreadable = [...new Set([...declared, ...ever, ...retired])].filter(id => numberOf(id) === null)
  if (unreadable.length > 0) {
    problems.push(unreadable.join(', ') + ' ' + oneOf(unreadable, 'is', 'are') +
      ' not an id this guard can number: an id is one capital letter, one number, and a lowercase ' +
      'suffix at most')
    return problems
  }

  const above = declared.filter(id => numberOf(id) > highWater)
  if (above.length > 0) {
    problems.push(above.join(', ') + ' ' + oneOf(above, 'is', 'are') +
      ' numbered above LOOPBACK_ASSERTION_HIGH_WATER, ' + highWater + ': a new assertion takes ' +
      next + ' and raises the mark to it in the same commit')
  }

  // The mark is a fact about an id, not a number a reader picks, so it is exactly the
  // highest number the record holds.
  const highest = Math.max(...idNumbers(ever))
  if (highest !== highWater) {
    problems.push('LOOPBACK_ASSERTION_HIGH_WATER is ' + highWater + ' and the highest number the ' +
      'record holds is ' + highest + ': the mark is the highest number ever used, so it moves with ' +
      'an id and never on its own')
  } else {
    // The skip is a number no id used, so the mark above it is a number nothing reached.
    const used = new Set(idNumbers(ever))
    const missing = Array.from({ length: highWater + 1 }, (_, number) => number)
      .filter(number => !used.has(number))
    if (missing.length > 0) {
      const at = missing.map(number => 'O' + number)
      const many = missing.length > 1
      problems.push('the record has no id at ' + (many ? 'numbers ' + missing.join(', ') : 'number ' + missing[0]) +
        ', and every number up to LOOPBACK_ASSERTION_HIGH_WATER is one an id used: ' +
        (many ? 'the ids that used them come back with their rows' : 'the id that used it comes back with its row') +
        ', or the new assertion takes ' + at.join(' and ') + ' if no retirement burned ' +
        (many ? 'them' : 'it') + ', because a retirement keeps its row')
    }
  }

  // A number a retirement burned stays burned, and a lettered sibling joins the same
  // number, so declaring one at it is the same act as declaring the retired id.
  const burned = new Map()
  for (const id of retired) {
    const number = numberOf(id)
    burned.set(number, [...(burned.get(number) ?? []), id])
  }
  for (const [number, ids] of burned) {
    const again = declared.filter(id => numberOf(id) === number)
    if (again.length > 0) {
      problems.push(again.join(', ') + ' ' + oneOf(again, 'is', 'are') + ' numbered ' + number +
        ', which this record retired (' + ids.join(', ') + '): a burned number is not one a new ' +
        'assertion may take, so the next one is ' + next)
    }
  }

  // The record and the tree account for the same ids: every id ever declared is either
  // on the run's list or retired, and nothing is on either side the record never held.
  const unaccounted = ever.filter(id => !declared.includes(id) && !retired.includes(id))
  if (unaccounted.length > 0) {
    problems.push(unaccounted.join(', ') + ' ' + oneOf(unaccounted, 'is', 'are') +
      ' in the record and neither declared nor retired: restore the check, or retire ' +
      oneOf(unaccounted, 'it', 'each of them') + ', because the number is burned either way')
  }
  const unrecorded = declared.filter(id => !ever.includes(id))
  if (unrecorded.length > 0) {
    problems.push(unrecorded.join(', ') + ' ' + oneOf(unrecorded, 'is', 'are') +
      ' declared and not in the record: add ' + oneOf(unrecorded, 'it', 'them') + ' in the same ' +
      'commit as the check, the bullet, and the mark')
  }
  const unrecordedRetired = retired.filter(id => !ever.includes(id))
  if (unrecordedRetired.length > 0) {
    problems.push(unrecordedRetired.join(', ') + ' ' + oneOf(unrecordedRetired, 'is', 'are') +
      ' retired and not in the record: the record holds every id ever declared, the retired ones ' +
      'included')
  }

  return problems
}

// The rule asked about this tree, unless a case hands it its own answer.
const numbering = (changes = {}) => numberingDrift({
  declared: [...LOOPBACK_ASSERTION_IDS],
  ever: EVER,
  retired: Object.keys(RETIRED),
  highWater: LOOPBACK_ASSERTION_HIGH_WATER,
  ...changes
})

test('every assertion id sits at or below the mark, and a retired one stays retired', () => {
  // A floor on each side, because a record that lost its rows would pass every rule
  // above in silence.
  assert.ok(LOOPBACK_ASSERTION_IDS.length > 0,
    'src/ladder/loopback.js declares its assertions with LOOPBACK_ASSERTION_IDS')
  assert.ok(EVER.length > LOOPBACK_ASSERTION_IDS.length,
    'the record holds the retired ids beside the declared ones, so it is longer than the declaration')
  assert.ok(Object.keys(RETIRED).length > 0, 'the record keeps O54 and O54b, the two ids this repository retired')

  assert.deepEqual(numbering(), [], 'the declaration and the numbering record disagree')
})

test('a new id above the mark fails until the mark moves with it', () => {
  const ever = sequence(2)
  const taken = { declared: [...ever, 'O3'], ever, retired: [], highWater: 2 }

  // The rule #681's sentence states and nothing read: one above the highest, and the
  // mark did not move.
  assert.deepEqual(numberingDrift(taken), [
    'O3 is numbered above LOOPBACK_ASSERTION_HIGH_WATER, 2: a new assertion takes O3 and raises the ' +
      'mark to it in the same commit',
    'O3 is declared and not in the record: add it in the same commit as the check, the bullet, and the mark'
  ], 'an id above the mark is reported twice, because the id and the mark are two edits')

  assert.deepEqual(numberingDrift({ ...taken, ever: [...ever, 'O3'], highWater: 3 }), [],
    'the id, the record row and the mark, in one commit, are the rule kept')

  // A mark raised with no id behind it is a number nothing used, and it would let the
  // next assertion land under it.
  assert.deepEqual(numberingDrift({ declared: ever, ever, retired: [], highWater: 3 }), [
    'LOOPBACK_ASSERTION_HIGH_WATER is 3 and the highest number the record holds is 2: the mark is the ' +
      'highest number ever used, so it moves with an id and never on its own'
  ], 'the mark is a fact about an id, not a number a reader picks')

  // A number skipped under the mark is one no id used, and the rule says the next number
  // is the only one a new assertion may take.
  assert.deepEqual(numberingDrift({ declared: [...ever, 'O4'], ever: [...ever, 'O4'], retired: [], highWater: 4 }), [
    'the record has no id at number 3, and every number up to LOOPBACK_ASSERTION_HIGH_WATER is one an ' +
      'id used: the id that used it comes back with its row, or the new assertion takes O3 if no ' +
      'retirement burned it, because a retirement keeps its row'
  ], 'a lost row shows as a gap in the numbering, not as a quiet pass')

  assert.deepEqual(numberingDrift({ declared: ['O7B'], ever: ['O7B'], retired: [], highWater: 7 }), [
    'O7B is not an id this guard can number: an id is one capital letter, one number, and a lowercase ' +
      'suffix at most'
  ], 'an id the guard cannot read is named rather than skipped')
})

test('an id that leaves the list without a retirement fails, and a retired one cannot come back', () => {
  // O54's own shape: it was retired in 82e188e, and it is the id this case is about.
  const ever = [...sequence(54), 'O54b']
  const retired = ['O54', 'O54b']
  const live = sequence(53)
  const highWater = 54

  assert.deepEqual(numberingDrift({ declared: live, ever, retired, highWater }), [],
    'a list, a record and a retirement that agree have nothing to report')

  // The deletion #681 names: the check, the list entry and the bullet go, and nothing
  // records that the number was used.
  assert.deepEqual(numberingDrift({ declared: live, ever, retired: [], highWater }), [
    'O54, O54b are in the record and neither declared nor retired: restore the check, or retire each ' +
      'of them, because the number is burned either way'
  ], 'a deleted id with no retirement is reported, naming the ids the record keeps')

  // The deletion of the highest id with its record row as well: the mark is now above every
  // number the record holds, which names the number the deletion took.
  assert.deepEqual(numberingDrift({ declared: live, ever: sequence(53), retired: [], highWater }), [
    'LOOPBACK_ASSERTION_HIGH_WATER is 54 and the highest number the record holds is 53: the mark is ' +
      'the highest number ever used, so it moves with an id and never on its own'
  ], 'a deletion that takes its row leaves the mark above the record, naming the number it took')

  // The same deletion in the middle of the sequence is a gap, because the mark above it
  // still holds, and a gap is one trace a deletion cannot take with it.
  assert.deepEqual(numberingDrift({
    declared: ['R0', 'O1', 'O3'],
    ever: ['R0', 'O1', 'O3'],
    retired: [],
    highWater: 3
  }), [
    'the record has no id at number 2, and every number up to LOOPBACK_ASSERTION_HIGH_WATER is one ' +
      'an id used: the id that used it comes back with its row, or the new assertion takes O2 if no ' +
      'retirement burned it, because a retirement keeps its row'
  ], 'a deleted row under the mark is a gap, and the gap names the number')

  // The reuse: the number comes back on a claim it never named.
  assert.deepEqual(numberingDrift({ declared: [...live, 'O54'], ever, retired, highWater }), [
    'O54 is numbered 54, which this record retired (O54, O54b): a burned number is not one a new ' +
      'assertion may take, so the next one is O55'
  ], 'a retired id that is declared again fails, and the message names the id to take instead')

  // The same number under a new letter is the same number, and a seventh sibling is not a
  // way around a retirement.
  assert.deepEqual(numberingDrift({ declared: [...live, 'O54c'], ever: [...ever, 'O54c'], retired, highWater }), [
    'O54c is numbered 54, which this record retired (O54, O54b): a burned number is not one a new ' +
      'assertion may take, so the next one is O55'
  ], 'a lettered sibling at a burned number is refused, because the number is what burned')

  // A sibling at a live number is what six of the seven already are, and the rule allows it.
  assert.deepEqual(numberingDrift({ declared: [...sequence(3), 'O2b'], ever: [...sequence(3), 'O2b'], retired: [], highWater: 3 }), [],
    'a lettered sibling joins the number its base holds, which is how O11b and O24b arrived')

  // A retirement the record never held cannot burn a number.
  assert.deepEqual(numberingDrift({ declared: sequence(2), ever: sequence(2), retired: ['O3'], highWater: 2 }), [
    'O3 is retired and not in the record: the record holds every id ever declared, the retired ones included'
  ], 'a retirement with no record row is reported')
})

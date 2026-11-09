// The rung that runs next, read from docs/testing-ladder.md.
//
// The ticket (#4) promises that a failing rung names the next one in its own
// output. That output is built here, from the doc's rungs table, so a doc edit
// and a gate edit cannot disagree.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { failureHint, loadLadder, main, parseLadder } from '../../src/ladder/next-rung.js'

const FIXTURE = [
  '| Rung | Command | Cost | Prerequisites | Asserts | Cannot catch |',
  '|---|---|---|---|---|---|',
  '| 0 static | `mise run lint` | under a second | `pnpm install` | every file parses | runtime behavior |',
  '| 1 unit | `mise run test` | a few seconds | `pnpm install` | pure core | socket framing |',
  '| 4 real client | `mise run driver:scenario` then `mise run driver:g0` | tens of minutes | a display host | vanilla acceptance | nothing |'
].join('\n')

test('parseLadder reads the doc table in ladder order', () => {
  const ladder = loadLadder()

  assert.deepEqual(ladder.map(rung => rung.id), ['0', '1', '2', '2a', '2b', '3', '4'])
  assert.deepEqual(ladder[0].tasks, ['lint'])
  assert.deepEqual(ladder[6].tasks, ['driver:scenario', 'driver:g0'])
  for (const rung of ladder) {
    assert.ok(rung.label.length > 0, `rung ${rung.id} has a label`)
    assert.ok(rung.tasks.length > 0, `rung ${rung.id} names a task`)
    assert.ok(rung.cost.length > 0, `rung ${rung.id} has a cost`)
    assert.ok(rung.prerequisites.length > 0, `rung ${rung.id} has prerequisites`)
    assert.ok(rung.catches.length > 0, `rung ${rung.id} has an asserts sentence`)
    assert.ok(rung.cannotCatch.length > 0, `rung ${rung.id} has a cannot-catch sentence`)
  }
})

test('parseLadder skips the header, the separator, and the area table', () => {
  const areaTable = [
    '',
    '| Task | Composes | Use after touching |',
    '|---|---|---|',
    '| \`mise run verify:relay\` | \`check\` | the relay |'
  ].join('\n')
  const ladder = parseLadder(`${FIXTURE}\n${areaTable}\n`)

  assert.deepEqual(ladder.map(rung => rung.id), ['0', '1', '4'])
  assert.deepEqual(ladder[2].tasks, ['driver:scenario', 'driver:g0'])
  assert.equal(ladder[0].catches, 'every file parses')
})

test('failureHint names the next rung, what it catches, and what it needs', () => {
  const ladder = loadLadder()
  const next = ladder[1]
  const hint = failureHint('lint', ladder)

  assert.equal(hint.split('\n')[0], 'mise run lint failed (rung 0, static).')
  assert.ok(hint.includes(`Next rung: mise run test (rung 1, unit) — ${next.cost}`), hint)
  assert.ok(hint.includes(`catches: ${next.catches}`), hint)
  assert.ok(hint.includes(`needs: ${next.prerequisites}`), hint)
})

test('failureHint from the loopback rung points at client parity', () => {
  const hint = failureHint('loopback')

  assert.match(hint, /Next rung: mise run parity:run \(rung 2a, /)
})

test('failureHint from the client parity rung points at the transfer testbed', () => {
  const hint = failureHint('parity:run')

  assert.match(hint, /Next rung: mise run testbed:run \(rung 2b, /)
})

test('failureHint names every command of a rung that takes two', () => {
  const hint = failureHint('online')

  assert.match(hint, /Next rung: mise run driver:scenario then mise run driver:g0 \(rung 4, real client\)/)
})

test('failureHint from the top rung says there is no rung above it', () => {
  const hint = failureHint('driver:g0')

  assert.equal(hint.split('\n')[0], 'mise run driver:g0 failed (rung 4, real client).')
  assert.doesNotMatch(hint, /Next rung:/)
  assert.match(hint, /top of the ladder/)
})

test('failureHint rejects a task no rung runs', () => {
  assert.throws(() => failureHint('nope'), /no ladder rung runs "mise run nope"/)
})

test('main writes the hint to stderr and exits non-zero', () => {
  const written = []
  const io = { stdout: { write: text => written.push(text) }, stderr: { write: text => written.push(text) } }

  assert.equal(main(['lint'], io), 1)
  assert.match(written.join(''), /Next rung: mise run test/)
})

test('main passes a setup failure through without a ladder hint', () => {
  const written = []
  const io = { stdout: { write: text => written.push(text) }, stderr: { write: text => written.push(text) } }

  assert.equal(main(['loopback', '2'], io), 2)
  assert.equal(main(['driver:scenario', '130'], io), 130)
  assert.deepEqual(written, [])
})

test('main treats an unreadable exit code as a failure', () => {
  const written = []
  const io = { stdout: { write: text => written.push(text) }, stderr: { write: text => written.push(text) } }

  assert.equal(main(['lint', ''], io), 1)
  assert.match(written.join(''), /Next rung: mise run test/)
})

test('main reports the usage when it has no task', () => {
  const written = []
  const io = { stdout: { write: text => written.push(text) }, stderr: { write: text => written.push(text) } }

  assert.equal(main([], io), 1)
  assert.match(written.join(''), /usage: node src\/ladder\/next-rung\.js <task> \[<exit code>\]/)
})

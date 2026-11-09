// Pure unit tests for the driver lane: checks (RCON parsing, tolerances, predicates,
// block-test parsing, redaction) and plan (run-scoped coordinates, safety,
// run isolation). No network, no env, no child processes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBlockTest, blockTestResult, parseEntityPos, parseEntityRotation,
  parsePlayerList, distance3D, positionsWithin, wrapAngle, angleDelta,
  anglesWithin, rotationsWithin, isSettled, isDisconnected, scanSecrets,
  redactSecrets, verifyG0Evidence,
} from '../../src/driver/checks.js'
import { buildRunPlan, runCenter, planSafetyIssues, ARENA } from '../../src/driver/plan.js'

// ---------------------------------------------------------------------------
// RCON output parsing
// ---------------------------------------------------------------------------

test('block test: positive commands parse their verdicts', () => {
  assert.equal(parseBlockTest('Test passed'), 'passed')
  assert.equal(parseBlockTest('Test failed'), 'failed')
  assert.equal(parseBlockTest(''), 'unknown')
  assert.equal(parseBlockTest('Could not set the block'), 'unknown')
  assert.equal(parseBlockTest('Bafbi has the following entity data: []'), 'unknown')
})

test('block test: a negative error string must never read as a pass', () => {
  // Council correction #2: "Could not set" is NOT a pass; unknown only.
  assert.notEqual(parseBlockTest('Could not set the block'), 'passed')
  assert.equal(blockTestResult({ ok: true, output: 'Could not set the block' }, 'passed'), false)
  assert.equal(blockTestResult({ ok: true, output: 'Test passed' }), true)
  assert.equal(blockTestResult({ ok: false, output: 'Test passed' }), false,
    'failed kubectl exec cannot be a pass even when the text looks positive')
})

test('entity data paths parse Pos and Rotation', () => {
  const pos = parseEntityPos('Bafbi has the following entity data: [13.5d, -60.0d, -4.5d]')
  assert.deepEqual(pos, { x: 13.5, y: -60, z: -4.5 })
  const rot = parseEntityRotation('Bafbi has the following entity data: [45.75f, 10.0f]')
  assert.deepEqual(rot, { yaw: 45.75, pitch: 10 })
  assert.equal(parseEntityPos('Found no elements matching path'), null)
  assert.equal(parseEntityRotation(''), null)
})

test('player list parsing handles empty and populated lines', () => {
  assert.deepEqual(parsePlayerList('There are 1 of a max of 4 players online: Bafbi'), ['Bafbi'])
  assert.deepEqual(parsePlayerList('There are 2 of a max of 4 players online: Bafbi, GlowSquidye'), ['Bafbi', 'GlowSquidye'])
  assert.deepEqual(parsePlayerList('There are 0 of a max of 20 players online:'), [])
  assert.equal(parsePlayerList('Server ran that command'), null)
})

// ---------------------------------------------------------------------------
// Tolerances and yaw wrap
// ---------------------------------------------------------------------------

test('distance and position tolerance', () => {
  assert.ok(distance3D({ x: 0, y: -60, z: 0 }, { x: 3, y: -60, z: 4 }) === 5)
  assert.equal(positionsWithin({ x: 0, y: 0, z: 0 }, { x: 0.9, y: 0, z: 0 }, 1.0), true)
  assert.equal(positionsWithin({ x: 0, y: 0, z: 0 }, { x: 1.1, y: 0, z: 0 }, 1.0), false)
  assert.equal(positionsWithin(null, { x: 0, y: 0, z: 0 }, 10), false)
})

test('yaw wrap: -170 and 170 are 20 degrees apart', () => {
  assert.equal(angleDelta(-170, 170), 20)
  assert.equal(angleDelta(170, -170), -20)
  assert.equal(anglesWithin(-170, 170, 21), true)
  assert.equal(anglesWithin(-170, 170, 19), false)
})

test('yaw wrap handles full-turn detours and boundaries', () => {
  assert.equal(wrapAngle(450), 90)
  assert.equal(wrapAngle(-450), -90)
  assert.equal(wrapAngle(180), -180)
  assert.equal(anglesWithin(90, 90, 2), true)
  assert.equal(anglesWithin(90, -90, 2), false)
})

test('rotation comparison wraps yaw but not pitch', () => {
  assert.equal(rotationsWithin({ yaw: 91, pitch: 10 }, { yaw: -267, pitch: 10 }, {}), true)
  assert.equal(rotationsWithin({ yaw: 0, pitch: 10 }, { yaw: 0, pitch: 14 }, {}), false)
  assert.equal(rotationsWithin(null, { yaw: 0, pitch: 0 }, {}), false)
})

// ---------------------------------------------------------------------------
// Client-status predicates
// ---------------------------------------------------------------------------

test('settled means: connected, level+player, screen none, rendered sections', () => {
  assert.equal(isSettled({
    connected: true, level: true, player: true, screen: 'none', renderedSections: 17,
  }), true)
  assert.equal(isSettled({
    connected: true, level: true, player: true, screen: 'net.minecraft.client.gui.screens.WaitingForTickingChunksScreen',
    renderedSections: 0,
  }), false)
  assert.equal(isSettled({ connected: true, level: true, player: true, screen: 'none', renderedSections: 0 }), false)
  assert.equal(isSettled({ connected: false, level: false, player: false, screen: 'none', renderedSections: 5 }), false)
  assert.equal(isSettled(null), false)
})

test('disconnected predicate and never a settled-disconnect confusion', () => {
  assert.equal(isDisconnected({ connected: false }), true)
  assert.equal(isDisconnected({ connected: true }), false)
  assert.equal(isDisconnected(null), false)
})

// ---------------------------------------------------------------------------
// Secret scanning / redaction
// ---------------------------------------------------------------------------

test('redaction finds token/password-shaped assignments and does not leak values', () => {
  const input = 'config: {token: hunter2hunter2, password = "correct horse"} ok'
  const { text, findings } = redactSecrets(input)
  assert.equal(findings.length, 2)
  assert.equal(text.includes('hunter2hunter2'), false)
  assert.equal(text.includes('correct horse'), false)
  assert.ok(text.includes('[REDACTED]<assignment>') && text.includes('token'))
})

test('redaction catches JWTs and long hex without a key', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c6'
  const input = `header ${'a'.repeat(64)} jwt ${jwt} end`
  const findings = scanSecrets(input)
  const kinds = findings.map(f => f.kind).sort()
  assert.deepEqual(kinds, ['jwt', 'long-hex'])
  const { text } = redactSecrets(input)
  assert.equal(text.includes(jwt), false)
})

test('redaction handles a JWT before a password assignment without leaking', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c6'
  const secret = 'opensesame123'
  const input = JSON.stringify({ header: jwt, note: `password=${secret}`, tail: 'end' })
  const { text } = redactSecrets(input)
  assert.equal(text.includes(jwt), false, 'JWT must not survive redaction')
  assert.equal(text.includes(secret), false, 'password must not survive redaction')
  assert.doesNotThrow(() => JSON.parse(text), 'redacted JSON must still parse')
})

test('redaction leaves ordinary text untouched, report-safe', () => {
  const input = '{"run":1,"passed":true,"name":"Bafbi","pos":{"x":96.5}}'
  const { text, findings } = redactSecrets(input)
  assert.equal(findings.length, 0)
  assert.equal(text, input)
})

test('a realistic report blob containing a leaked token gets redacted end to end', () => {
  const leaked = 'rconOp: {"kind":"probe","output":"... password=opensesame123 ..."}'
  const { text, findings } = redactSecrets(leaked)
  assert.equal(findings.length, 1)
  assert.equal(text.includes('opensesame123'), false)
})

// ---------------------------------------------------------------------------
// Plan: run-scoped coordinates, safety, isolation
// ---------------------------------------------------------------------------

test('run centers are distinct, run-scoped, and far from the spawn platform', () => {
  const first = runCenter(1)
  const second = runCenter(2)
  assert.notDeepEqual(first, second)
  assert.ok(Math.abs(second.x - first.x) >= ARENA.radiusInt * 2 + 1, 'consecutive arenas never overlap')
  for (const center of [first, second]) {
    const far = Math.hypot(center.x - ARENA.spawnPlatform.x, center.z - ARENA.spawnPlatform.z)
    assert.ok(far > 3 * ARENA.radiusInt, 'arena far from the pre-existing platform')
  }
})

test('plans for different runs never share edit coordinates', () => {
  const plans = [1, 2].map(runIndex => buildRunPlan({ runIndex, nonce: `n${runIndex}` }))
  const key = block => `${block.x},${block.y},${block.z}`
  for (const first of plans) {
    for (const second of plans) {
      if (first === second) continue
      assert.notEqual(key(first.edits.break.target), key(second.edits.break.target))
      assert.notEqual(key(first.edits.place.target), key(second.edits.place.target))
    }
    for (const a of [first.edits.break.target, first.edits.place.target, first.edits.place.support]) {
      assert.notEqual(key(a), key(first.blockUnderPlayer))
    }
  }
})

test('plans carry distinct nonces and are unsafe-free by construction', () => {
  const plan1 = buildRunPlan({ runIndex: 1, nonce: 'abc' })
  const plan2 = buildRunPlan({ runIndex: 2, nonce: 'def' })
  assert.notEqual(plan1.nonce, plan2.nonce)
  assert.deepEqual(planSafetyIssues(plan1), [])
  assert.deepEqual(planSafetyIssues(plan2), [])
})

test('plan safety: targeting the block under the player is flagged', () => {
  const plan = buildRunPlan({ runIndex: 1, nonce: 'x' })
  plan.edits.break.target = { ...plan.blockUnderPlayer }
  const issues = planSafetyIssues(plan)
  assert.ok(issues.some(issue => issue.includes('block under the player')))
})

test('plan safety: a target too close to the player is flagged', () => {
  const plan = buildRunPlan({ runIndex: 1, nonce: 'x' })
  plan.edits.break.target = { x: plan.teleport.x, y: -60, z: plan.teleport.z }
  const issues = planSafetyIssues(plan)
  assert.ok(issues.some(issue => issue.includes('only')))
})

test('plan preflight expects air before seeding and a solid floor under the player', () => {
  const plan = buildRunPlan({ runIndex: 1, nonce: 'x' })
  const breakPreflight = plan.preflight.find(p => p.at.x === plan.edits.break.target.x && p.at.z === plan.edits.break.target.z)
  assert.equal(breakPreflight.expect, 'air')
  assert.equal(breakPreflight.kind, 'assertion')
  assert.ok(plan.preflight.some(p => p.expect === 'stone' && p.at.x === plan.blockUnderPlayer.x))
})

// ---------------------------------------------------------------------------
// Run isolation is structural: fresh coordinates, fresh nonce, fresh process
// handled by the scenario (quit + relaunch), not by shared mutable state.
// ---------------------------------------------------------------------------

test('run isolation: two builds of the same run index with non-distinct nonces differ only by nonce', () => {
  const a = buildRunPlan({ runIndex: 1, nonce: 't1' })
  const b = buildRunPlan({ runIndex: 1, nonce: 't2' })
  assert.equal(a.center.x, b.center.x) // same coords is fine: fresh world state
  assert.notEqual(a.nonce, b.nonce) // but the runs are labelled apart
})

test('plan for out-of-range run indices still clamps to a sane center', () => {
  assert.deepEqual(runCenter(0), runCenter(1))
  assert.deepEqual(runCenter(-3), runCenter(1))
})

test('plan safety: an x/y/z mismatch for the block under the player is flagged', () => {
  const plan = buildRunPlan({ runIndex: 1, nonce: 'x' })
  plan.blockUnderPlayer = { ...plan.blockUnderPlayer, y: plan.blockUnderPlayer.y + 1 }
  assert.ok(planSafetyIssues(plan).some(issue => issue.includes('under the teleport position')))
})

// ---------------------------------------------------------------------------
// G0 evidence verification: one clean 2-run invocation, not two run-1s
// ---------------------------------------------------------------------------

const driverReport = (run, startedAt, passed = true) => ({
  lane: 'driver', run, startedAt, passed,
})

test('verify g0: a clean one-invocation 2-run summary passes', () => {
  const summary = {
    runsRequested: 2, runsExecuted: 2, runsPassed: 2, allPassed: true,
    generatedAt: '2026-11-06T14:02:00.000Z',
    reports: ['a.json', 'b.json'],
  }
  const reports = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(2, '2026-11-06T14:01:00.000Z'),
  ]
  assert.equal(verifyG0Evidence(summary, reports).ok, true)
})

test('verify g0: two separate one-run invocations cannot pass as 2/2', () => {
  const summary = {
    runsRequested: 1, runsExecuted: 1, runsPassed: 1, allPassed: true,
    generatedAt: '2026-11-06T14:02:00.000Z',
    reports: ['a.json'],
  }
  const reports = [driverReport(1, '2026-11-06T14:00:00.000Z')]
  assert.equal(verifyG0Evidence(summary, reports).ok, false)
  const twoRunOnes = {
    runsRequested: 2, runsExecuted: 2, runsPassed: 2, allPassed: true,
    generatedAt: '2026-11-06T14:02:00.000Z',
    reports: ['a.json', 'b.json'],
  }
  const runOnes = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(1, '2026-11-06T14:01:00.000Z'),
  ]
  assert.equal(verifyG0Evidence(twoRunOnes, runOnes).ok, false)
})

test('verify g0: a stale summary cannot outvote a newer report', () => {
  const summary = {
    runsRequested: 2, runsExecuted: 2, runsPassed: 2, allPassed: true,
    generatedAt: '2026-11-06T13:59:00.000Z',
    reports: ['a.json', 'b.json'],
  }
  const reports = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(2, '2026-11-06T14:01:00.000Z'),
  ]
  assert.equal(verifyG0Evidence(summary, reports).ok, false)
})

// Pure unit tests for the driver lane: checks (RCON parsing, tolerances, predicates,
// block-test parsing) and plan (run-scoped coordinates, safety,
// run isolation). No network, no env, no child processes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBlockTest, blockTestResult, parseEntityPos, parseEntityRotation,
  parsePlayerList, distance3D, positionsWithin, wrapAngle, angleDelta,
  anglesWithin, rotationsWithin, isSettled, isDisconnected, verifyG0Evidence,
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

// #939: the summary names the gate lane its runs measured, and that name is what binds the unmodded
// witness to the report set. A lane here is a fake: no case resolves the worktree's.
const LANE = 'monoplayer-gate-1a2c3e5'

test('verify g0: a clean one-invocation 2-run summary passes', () => {
  const summary = {
    runsRequested: 2, runsExecuted: 2, runsPassed: 2, allPassed: true,
    gateLane: LANE,
    generatedAt: '2026-11-06T14:02:00.000Z',
    reports: ['a.json', 'b.json'],
  }
  const reports = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(2, '2026-11-06T14:01:00.000Z'),
  ]
  assert.equal(verifyG0Evidence(summary, reports).ok, true)
})

// #939: the summary is the report set's identity, and the lane it names is what the unmodded witness
// is bound to. A summary from a runner that recorded no lane can bound nothing, so it is refused here
// rather than compared against a witness that would then pass on any lane.
test('verify g0: a report set that names no lane is refused', () => {
  const reports = finishedReports('2026-11-06T14:25:00.000Z')
  assert.equal(verifyG0Evidence(cleanSummary, reports).ok, true, 'the summary names its lane and the two runs hold')
  const { gateLane, ...nameless } = cleanSummary
  const verdict = verifyG0Evidence(nameless, reports)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /^the report set names no lane:/)
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
    gateLane: LANE,
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
    gateLane: LANE,
    generatedAt: '2026-11-06T13:59:00.000Z',
    reports: ['a.json', 'b.json'],
  }
  const reports = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(2, '2026-11-06T14:01:00.000Z'),
  ]
  assert.equal(verifyG0Evidence(summary, reports).ok, false)
})

// A report set sitting in the checkout is not evidence that anything ran today:
// the gate must be green only on runs this checkout produced inside the window.
const finishedReports = (latestFinishedAt) => [
  { lane: 'driver', run: 1, passed: true, startedAt: '2026-11-06T14:00:00.000Z', finishedAt: '2026-11-06T14:01:00.000Z' },
  { lane: 'driver', run: 2, passed: true, startedAt: '2026-11-06T14:20:00.000Z', finishedAt: latestFinishedAt },
]

const cleanSummary = {
  runsRequested: 2, runsExecuted: 2, runsPassed: 2, allPassed: true,
  gateLane: LANE,
  generatedAt: '2026-11-06T14:30:00.000Z',
  reports: ['a.json', 'b.json'],
}

test('verify g0: a run inside the age window passes', () => {
  const now = Date.parse('2026-11-06T15:00:00.000Z')
  const verdict = verifyG0Evidence(cleanSummary, finishedReports('2026-11-06T14:25:00.000Z'), {
    now, maxAgeMs: 24 * 60 * 60 * 1000,
  })

  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, '2/2 consecutive driver runs')
})

test('verify g0: a run older than the window fails however clean it reads', () => {
  const now = Date.parse('2026-11-08T15:00:00.000Z')
  const verdict = verifyG0Evidence(cleanSummary, finishedReports('2026-11-06T14:25:00.000Z'), {
    now, maxAgeMs: 24 * 60 * 60 * 1000,
  })

  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /stale/)
  assert.match(verdict.reason, /1440-minute window/)
})

test('verify g0: without a window, the age of the evidence is not checked', () => {
  const verdict = verifyG0Evidence(cleanSummary, finishedReports('2026-11-06T14:25:00.000Z'))

  assert.equal(verdict.ok, true)
})

test('verify g0: a report whose finishedAt nobody can read is refused, not skipped', () => {
  // The age rule is one function for both halves of a pass (#939), and it refuses a time that does
  // not parse: a document whose date cannot be read passes every window there is. Read without a
  // window too, because an unreadable date is not an age question, and both halves answer the same
  // way: the witness refuses one whether or not a window was named.
  const now = Date.parse('2026-11-06T15:00:00.000Z')
  const reports = finishedReports('2026-11-06T14:25:00.000Z')
  reports[1].finishedAt = 'whenever the run ended'
  assert.equal(verifyG0Evidence(cleanSummary, reports, { now, maxAgeMs: 24 * 60 * 60 * 1000 }).reason,
    'driver evidence carries no readable finishedAt, so its age cannot be read')
  assert.equal(verifyG0Evidence(cleanSummary, reports).reason,
    'driver evidence carries no readable finishedAt, so its age cannot be read',
    'no window is no window question, not no date question')
})

test('verify g0: a report with no finishedAt is dated by its start, and the refusal says started', () => {
  // The sentence names the field the report actually held, so a refusal cannot claim a finish nobody
  // recorded (#939) — the fallback is in the code that dates it, and the wording follows it.
  const now = Date.parse('2026-11-09T15:00:00.000Z')
  const reports = [
    driverReport(1, '2026-11-06T14:00:00.000Z'),
    driverReport(2, '2026-11-06T14:20:00.000Z'),
  ]
  const verdict = verifyG0Evidence(cleanSummary, reports, { now, maxAgeMs: 24 * 60 * 60 * 1000 })
  assert.equal(verdict.reason,
    'driver evidence is stale: the newest run started at 2026-11-06T14:20:00.000Z, outside the 1440-minute window')
})

test('verify g0: a run dated after the check is refused, because no clock wrote it', () => {
  const now = Date.parse('2026-11-06T15:00:00.000Z')
  const verdict = verifyG0Evidence(cleanSummary, finishedReports('2062-11-06T14:25:00.000Z'), {
    now, maxAgeMs: 24 * 60 * 60 * 1000,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /^driver evidence is dated in the future: it says 2062-11-06T14:25:00.000Z, and this check is reading it at 2026-11-06T15:00:00.000Z$/)
})

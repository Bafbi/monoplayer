// The driver names its gate lane in one place (#282): src/driver/lane.js, which asks
// scripts/gate-lane.sh. These cases stay offline — the resolver runs that script,
// which reads git and cksum and touches no cluster — and no case invents one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { LaneError, laneTargets, paperAddress, resolveGateLane, tailnetHost } from '../../src/driver/lane.js'
import { createRcon } from '../../src/driver/rcon.js'
import { LANE, WORKTREE } from '../support/lane.js'

const DRIVER = path.join(WORKTREE, 'src', 'driver')

// This machine's own lane would answer for the derivation, so it is not passed on.
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra }
  if (!Object.hasOwn(extra, 'MONOPLAYER_GATE_NAMESPACE')) delete env.MONOPLAYER_GATE_NAMESPACE
  return env
}

test("the lane is the one this worktree derives", () => {
  assert.equal(resolveGateLane({ env: cleanEnv() }), LANE)
})

// gate-lane.sh honours the variable, so the derived path and the named path are one
// line and this module adds no second rule.
test('a lane named by hand is the lane, because one name is the point', () => {
  assert.equal(resolveGateLane({ env: cleanEnv({ MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' }) }), 'monoplayer-gate-x')
})

test("a lane that cannot be derived is a refusal, with the sentence that says how", () => {
  const notGit = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-not-git-'))
  assert.throws(
    () => resolveGateLane({ env: cleanEnv({ MONOPLAYER_GATE_WORKTREE: notGit }) }),
    error => error instanceof LaneError &&
      /cannot derive this worktree's lane/.test(error.message) &&
      /Set MONOPLAYER_GATE_NAMESPACE to name one by hand/.test(error.message),
    'the refusal is gate-lane.sh\'s own sentence, not a second one'
  )
})

test('the live and dev lanes are refused as a gate lane', () => {
  for (const name of ['monoplayer', 'monoplayer-dev']) {
    assert.throws(
      () => resolveGateLane({ env: cleanEnv({ MONOPLAYER_GATE_NAMESPACE: name }) }),
      error => error instanceof LaneError && error.message.includes('refusing "' + name + '"'),
      'gate-lane.sh refuses ' + name
    )
  }
})

// The tailnet name is the lane's, not a constant: the tree renders
// monoplayer-gate-__instance__-paper on the Service that publishes it.
test('the tailnet address a client joins follows the lane', () => {
  assert.equal(tailnetHost('monoplayer-gate-x', 'paper'), 'monoplayer-gate-x-paper.tail41e568.ts.net')
  assert.equal(tailnetHost('monoplayer-gate-x', 'velocity'), 'monoplayer-gate-x-velocity.tail41e568.ts.net')
  assert.equal(paperAddress('monoplayer-gate-x'), 'monoplayer-gate-x-paper.tail41e568.ts.net:25565')
})

test('the RCON client defaults to the one lane, and an override still wins', () => {
  // #282: this default was the literal lane monoplayer-gate-b, so a renamed lane's
  // run administered the lane that shipped.
  const saved = process.env.GATEB_RCON_NAMESPACE
  delete process.env.GATEB_RCON_NAMESPACE
  try {
    const rcon = createRcon({ exec: async () => ({ stdout: '', stderr: '' }) })
    assert.equal(rcon.namespace, LANE, "the default is this worktree's lane")
  } finally {
    if (saved === undefined) delete process.env.GATEB_RCON_NAMESPACE
    else process.env.GATEB_RCON_NAMESPACE = saved
  }
  const named = createRcon({ namespace: 'monoplayer-gate-x', exec: async () => ({ stdout: '', stderr: '' }) })
  assert.equal(named.namespace, 'monoplayer-gate-x', 'the caller still names a lane when it has one')
})

// --- the pair one run fills from the one name (#282) ---

test("a run that names neither target takes both from this worktree's lane", () => {
  const targets = laneTargets('monoplayer-gate-x', {})
  assert.equal(targets.refused, undefined)
  assert.equal(targets.server, 'monoplayer-gate-x-paper.tail41e568.ts.net:25565')
  assert.equal(targets.rconNamespace, 'monoplayer-gate-x')
})

test('a run whose RCON namespace names another lane refuses instead of splitting', () => {
  // MONOPLAYER_GATE_NAMESPACE names the lane the client joins, and
  // GATEB_RCON_NAMESPACE names the Deployments RCON administers. A default run would
  // take both from the lane; this one names two, so it stops rather than pick one.
  const targets = laneTargets('monoplayer-gate-x', { rconNamespace: 'monoplayer-gate-y' })
  assert.match(targets.refused ?? '', /monoplayer-gate-y/, 'the refusal names the lane the environment gave')
  assert.match(targets.refused ?? '', /monoplayer-gate-x/, "and this worktree's")
  assert.equal(targets.server, undefined, 'and nothing is filled to dial')
})

test('a run handed both targets goes where it was told', () => {
  // The caller owns the pair once it names the address, which is what #301 kept for
  // --backend-host: an explicit address is not a second lane.
  const targets = laneTargets('monoplayer-gate-x', { server: '127.0.0.1:25565', rconNamespace: 'monoplayer-gate-y' })
  assert.equal(targets.refused, undefined)
  assert.equal(targets.server, '127.0.0.1:25565')
  assert.equal(targets.rconNamespace, 'monoplayer-gate-y')
})

// One place means one place: a file that spells a lane is a second owner, and that is
// how the driver came to administer the lane that shipped (#282).
test('no file under src/driver spells a lane of its own', () => {
  const files = fs.readdirSync(DRIVER).filter(name => name.endsWith('.js'))
  assert.ok(files.length > 0, 'the driver has sources')
  for (const name of files) {
    const text = fs.readFileSync(path.join(DRIVER, name), 'utf8')
    // The placeholder is the shape, not a lane: only a spelled instance is one.
    assert.doesNotMatch(text, /monoplayer-gate-(?!<instance>)/,
      name + ' spells a lane of its own; the lane comes from gate-lane.sh through lane.js and nowhere else')
  }
})

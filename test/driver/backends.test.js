// M4 slice: the backend row registry must agree with the manifests in
// deploy/driver/ and the plan pins, without any cluster or env access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAMESPACE, BACKENDS, PROXY_PLAN, FAULT_PLAN, M5_FAULT_ROW,
  getBackend, activeBackends, rconTarget,
} from '../../src/driver/backends.js'
import { DEFAULT_PINS } from '../../src/driver/scenario.js'

test('each backend row has a unique id, deployment and lane', () => {
  const ids = new Set(BACKENDS.map(b => b.id))
  const lanes = new Set(BACKENDS.map(b => b.lane))
  const deployments = new Set(BACKENDS.map(b => b.deployment))
  assert.equal(BACKENDS.length, ids.size, 'ids unique')
  assert.equal(BACKENDS.length, lanes.size, 'lanes unique')
  assert.equal(BACKENDS.length, deployments.size, 'deployments unique')
})

test('rows namespace to monoplayer-gate-b and rcon targets match the registry', () => {
  for (const backend of BACKENDS) {
    assert.equal(backend.rcon.namespace, NAMESPACE)
    assert.equal(backend.rcon.deployment, backend.deployment)
    assert.equal(rconTarget(backend.id).deployment, backend.deployment)
    assert.equal(backend.endpoints.clusterService, `${backend.deployment}:${backend.endpoints.port}`)
  }
  assert.equal(rconTarget('paper').deployment, 'paper',
    'the M2 row must keep working through the existing src/driver/rcon.js default')
  assert.equal(rconTarget('nonexistent'), null)
})

test('only G0 paper is marked running; planned rows are honest about it', () => {
  assert.deepEqual(activeBackends().map(b => b.id), ['paper'])
  assert.equal(getBackend('paper-m4').status, 'planned',
    'M4 is manifest plumbing in this slice; the running claim flips when the pods are live')
})

test('the G0 paper row describes the lane rung 4 drives', () => {
  // The row says "do not touch" because it describes the server that exists. When
  // that server moves, this row moves with it, or it describes a lane that is gone.
  const paper = getBackend('paper')
  assert.equal(paper.pins.version, DEFAULT_PINS.minecraftVersion)
  assert.equal(String(paper.pins.paperBuild), String(DEFAULT_PINS.paperBuild).match(/(\d+)$/)[1])
})

test('M4 pins carry the plan pins: Paper b74, Velocity 4.3.1 b45 with sha256, modern forwarding', () => {
  const m4 = getBackend('paper-m4')
  assert.equal(m4.pins.paperBuild, 74)
  // Paper 26.1.2 build 74 is what testdata/m4-verdict.md recorded for this row,
  // and test/driver/pin.test.js holds deploy/driver/paper-m4.yaml to these two
  // values, so the row needs an absolute anchor of its own (#117).
  assert.equal(m4.pins.version, '26.1.2')
  assert.equal(m4.pins.velocity, '4.3.1 build 45')
  assert.match(m4.pins.velocitySha256, /^[0-9a-f]{64}$/,
    'velocity jar pin must be a full sha256 (fill-data object id)')
  assert.equal(m4.pins.forwarding, 'modern (PAPER_VELOCITY_SECRET env; partial paper-global.yml pre-seed)')
  assert.match(m4.pins.image, /:2026\./, 'itzg image pinned to a dated tag, not latest')
})

test('M1 vanilla row pins the plan sha-1 and stays out of this slice', () => {
  const m1 = getBackend('vanilla')
  assert.equal(m1.status, 'planned')
  assert.equal(m1.pins.serverSha1, '97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51')
})

test('proxy plan: unique names/ports; only the M4 velocity listener enabled at bring-up', () => {
  const names = new Set(PROXY_PLAN.map(p => p.name))
  const ports = new Set(PROXY_PLAN.map(p => p.listenPort))
  assert.equal(PROXY_PLAN.length, names.size, 'listener names unique')
  assert.equal(PROXY_PLAN.length, ports.size, 'listen ports unique')
  const velocity = PROXY_PLAN.find(p => p.name === 'puppet-velocity')
  assert.deepEqual(velocity, {
    name: 'puppet-velocity',
    listenPort: 25570,
    upstreamHost: 'velocity',
    upstreamPort: 25566,
    row: 'M4',
    enabled: true,
  }, 'the M4 slice pins puppet-velocity on :25570 -> velocity:25566')
  assert.ok(PROXY_PLAN.every(p => ['puppet-vanilla', 'puppet-fabric', 'puppet-paper-m4', 'puppet-velocity'].includes(p.name)))
  assert.ok(PROXY_PLAN.filter(p => p.enabled === false).length >= 2,
    'vanilla/fabric listeners start disabled until their rows and backends exist')
})

test('registry and proxy plan agree on upstreams: velocity service for M4, rows for the others', () => {
  for (const listener of PROXY_PLAN) {
    if (listener.upstreamHost === 'velocity') {
      assert.equal(listener.row, 'M4', 'the velocity listener belongs to the M4 row; rows upstream of it are vanilla/fabric/paper-m4')
    } else {
      const backend = getBackend(listener.upstreamHost)
      assert.ok(backend, `listener ${listener.name} upstream ${listener.upstreamHost} must match a registry id`)
      assert.equal(backend.lane, listener.row)
    }
  }
})

test('M5 is paper-m4 through toxiproxy carrying the full F1-F6 fault plan', () => {
  assert.equal(M5_FAULT_ROW.backend, 'paper-m4')
  assert.equal(M5_FAULT_ROW.route.listener, 'puppet-velocity')
  assert.deepEqual(M5_FAULT_ROW.faults.map(f => f.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])
  assert.deepEqual(
    new Set(M5_FAULT_ROW.faults.map(f => f.id)).size, 6,
    'each fault appears once with a distinct shape'
  )
})

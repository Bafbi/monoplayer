// Pure unit tests for the driver parity lane (#62): the field policy, the
// comparison, the report, the endpoint refusals, and the run orchestration with
// fake adapters. No socket, no client, no host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LIVE_FLEET_HOST, LIVE_FRONT_HOST, PARITY_FIELDS, PARITY_LIMITATIONS,
  compareParity, formatParityReport, observeClient, parseParityEndpoint, runParity, sameEndpoint
} from '../../src/driver/parity.js'
import { versionRefusal } from '../../src/driver/checks.js'
import { DriverError } from '../../src/driver/client-driver.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// One driver status payload, in the shape DriverServer.status() returns.
const status = (overrides = {}) => ({
  screen: 'none',
  screenTitle: null,
  screenNarration: null,
  level: true,
  player: true,
  connected: true,
  fps: 60,
  name: 'Bafbi',
  health: 20,
  yaw: 0,
  pitch: 0,
  selectedSlot: 0,
  pos: { x: 5.5, y: -60, z: -3.5 },
  held: 'minecraft:stone',
  dimension: 'ResourceKey[minecraft:dimension / minecraft:overworld]',
  loadedChunks: 144,
  renderedSections: 37,
  ...overrides
})

const screen = (overrides = {}) => ({ screen: 'none', title: null, narration: null, buttons: [], ...overrides })

// ---------------------------------------------------------------------------
// The policy table
// ---------------------------------------------------------------------------

test('the policy table covers every observed field and explains every expected one', () => {
  const observed = Object.keys(observeClient(status(), screen()))
  assert.deepEqual(PARITY_FIELDS.map(entry => entry.field), observed,
    'the policy table is the report order, and an unclassified field would be a silent pass')
  for (const entry of PARITY_FIELDS) {
    assert.ok(['same', 'expected'].includes(entry.policy), entry.field + ' needs a policy')
    if (entry.policy === 'expected') {
      assert.ok(entry.reason && entry.reason.length > 20, entry.field + ' needs the mechanism that explains it')
    }
  }
})

test('the report records that no packet observer was used', () => {
  // AC4: an observer is allowed only if a run with it off gives the same
  // verdict. There is none, so the choice is written down instead of implied.
  assert.ok(PARITY_LIMITATIONS.some(line => line.startsWith('No packet observer')))
})

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

test('observation reduces the status to the compared fields', () => {
  const view = observeClient(status(), screen({ screen: 'none' }))
  assert.equal(view.connected, true)
  assert.equal(view.health, 20)
  assert.deepEqual(view.pos, { x: 5.5, y: -60, z: -3.5 })
  assert.equal(view.fps, undefined, 'fps measures the host, not the connection')
  assert.equal(view.totalSections, undefined, 'the 26.2 client no longer reports a section total')
  assert.deepEqual(view.screen, { screen: 'none', title: null, narration: null, reason: null })
})

test('observation rounds positions and keeps a disconnect reason', () => {
  const view = observeClient(status({ pos: { x: 5.123456, y: -60.0009, z: -3.4999 } }), screen({
    screen: 'net.minecraft.client.gui.screens.DisconnectedScreen',
    title: 'Connection Lost',
    narration: 'Connection Lost. Timed out',
    reason: 'Connection Lost. Timed out'
  }))
  assert.deepEqual(view.pos, { x: 5.12, y: -60, z: -3.5 })
  assert.equal(view.screen.screen, 'net.minecraft.client.gui.screens.DisconnectedScreen')
  assert.equal(view.screen.reason, 'Connection Lost. Timed out')
})

test('a status payload is required', () => {
  assert.throws(() => observeClient(null), TypeError)
})

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const view = (overrides = {}) => observeClient(status(overrides), screen())

test('two settled clients that agree are all same', () => {
  const comparison = compareParity({ direct: view(), proxied: view() })
  assert.equal(comparison.ok, true)
  assert.equal(comparison.counts.same, PARITY_FIELDS.length)
  assert.deepEqual(comparison.unexplained, [])
})

test('state the attach replay owns is expected, and names its mechanism', () => {
  const comparison = compareParity({
    direct: view(),
    proxied: view({
      pos: { x: 10.5, y: -60, z: 4.5 }, held: 'empty', selectedSlot: 3, loadedChunks: 120, renderedSections: 21
    })
  })
  assert.equal(comparison.ok, true)
  const expected = comparison.fields.filter(row => row.verdict === 'expected').map(row => row.field)
  assert.deepEqual(expected, ['pos', 'held', 'selectedSlot', 'loadedChunks', 'renderedSections'])
  for (const row of comparison.fields.filter(entry => entry.verdict === 'expected')) {
    assert.match(row.reason, /replay|session|chunk|render/i)
  }
})

test('a difference the proxy does not explain fails the run', () => {
  const comparison = compareParity({
    direct: view(),
    proxied: view({ health: 4, dimension: 'ResourceKey[minecraft:dimension / minecraft:the_nether]' })
  })
  assert.equal(comparison.ok, false)
  assert.deepEqual(comparison.unexplained.map(row => row.field), ['health', 'dimension'])
  assert.match(comparison.unexplained[0].reason, /direct client saw 20 and the proxied client saw 4/)
})

test('a screen only one client showed is a finding, not an expected row', () => {
  // A dialog or a transfer screen that only the proxied client saw is the
  // symptom #20 and #22 describe, so it fails the run rather than being excused
  // by a table that would then go stale when those tickets land.
  const comparison = compareParity({
    direct: view(),
    proxied: observeClient(status(), screen({ screen: 'net.minecraft.client.gui.screens.dialog.DialogScreen', title: 'A dialog' }))
  })
  assert.equal(comparison.ok, false)
  assert.deepEqual(comparison.unexplained.map(row => row.field), ['screen'])
})

test('a field only one side reported is a finding', () => {
  const comparison = compareParity({
    direct: view(),
    proxied: observeClient(status({ held: undefined }), screen())
  })
  assert.equal(comparison.ok, false)
  assert.deepEqual(comparison.unexplained.map(row => row.field), ['held'])
})

test('two observations are required', () => {
  assert.throws(() => compareParity({ direct: view() }), TypeError)
})

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test('the report prints one line per field and a PASS summary', () => {
  const comparison = compareParity({ direct: view(), proxied: view({ pos: { x: 1, y: -60, z: 1 } }) })
  const text = formatParityReport({
    observer: 'none', passed: comparison.ok, sides: {
      direct: { endpoint: '127.0.0.1:25565', settleMs: 21_000 },
      proxied: { endpoint: '127.0.0.1:25566', settleMs: 19_400 }
    }, ...comparison
  })
  assert.match(text, /direct 127\.0\.0\.1:25565: settled in 21s, observer none/)
  assert.match(text, /EXPECTED +pos: direct=\{"x":5\.5,"y":-60,"z":-3\.5\} proxied=\{"x":1,"y":-60,"z":1\}/)
  assert.match(text, /driver-parity: PASS 12 fields, 11 same, 1 expected, 0 unexplained/)
})

test('the report names the unexplained fields on failure', () => {
  const comparison = compareParity({ direct: view(), proxied: view({ health: 0 }) })
  const text = formatParityReport({
    observer: 'none', passed: comparison.ok,
    sides: {
      direct: { endpoint: '127.0.0.1:25565', settleMs: 1000 },
      proxied: { endpoint: '127.0.0.1:25566', settleMs: 1000 }
    }, ...comparison
  })
  assert.match(text, /FAIL +health: direct=20 proxied=0/)
  assert.match(text, /driver-parity: FAIL 1 unexplained: health/)
})

test('a lane that never settled is reported as such, not as a comparison', () => {
  const comparison = { ok: false, fields: [], counts: { same: 0, expected: 0, unexplained: 0 }, unexplained: [] }
  const text = formatParityReport({
    observer: 'none', passed: false,
    sides: {
      direct: { endpoint: '127.0.0.1:25565', settleMs: null, error: 'the client did not settle' },
      proxied: { endpoint: '127.0.0.1:25566', settleMs: 1000 }
    }, ...comparison
  })
  assert.match(text, /direct 127\.0\.0\.1:25565: did not settle — the client did not settle/)
})

// ---------------------------------------------------------------------------
// Endpoint refusals
// ---------------------------------------------------------------------------

test('a parity endpoint is HOST:PORT with a real port', () => {
  assert.deepEqual(parseParityEndpoint('127.0.0.1:25565', '--direct'),
    { host: '127.0.0.1', port: 25565, endpoint: '127.0.0.1:25565' })
  assert.throws(() => parseParityEndpoint('127.0.0.1', '--direct'), /must be HOST:PORT/)
  assert.throws(() => parseParityEndpoint('127.0.0.1:0', '--direct'), /port in 1\.\.65535/)
  assert.throws(() => parseParityEndpoint('', '--direct'), /must be HOST:PORT/)
})

test('the live Excalia fleet and its front are never a parity target', () => {
  for (const host of ['excalia.fr', 'EXCALIA.FR', 'play.excalia.fr', 'sky-2.excalia.fr']) {
    assert.throws(() => parseParityEndpoint(host + ':25565', '--direct'), /live Excalia fleet/, host)
  }
  for (const host of [LIVE_FRONT_HOST, LIVE_FRONT_HOST.toUpperCase()]) {
    assert.throws(() => parseParityEndpoint(host + ':25565', '--proxied'), /live deployment/, host)
  }
})

test('the refused hosts are the ones the sources name', () => {
  // Two copies of one rule, so the copies are pinned to their sources: the
  // fleet from src/ladder/client-parity.js, the front from the deployment's
  // Service annotation.
  const paritySource = readFileSync(path.join(root, 'src/ladder/client-parity.js'), 'utf8')
  assert.match(paritySource, new RegExp("const LIVE_HOST = '" + LIVE_FLEET_HOST.replace(/\./g, '\\.') + "'"))

  const service = readFileSync(path.join(root, 'deploy/manifests/service.yaml'), 'utf8')
  assert.match(service, /tailscale\.com\/hostname: glowsquidye/)
  assert.equal(LIVE_FRONT_HOST, 'glowsquidye.tail41e568.ts.net')
})

// ---------------------------------------------------------------------------
// Version agreement
// ---------------------------------------------------------------------------

test('a driver built for another Minecraft version is refused before a launch', () => {
  assert.equal(versionRefusal({ driverVersion: '26.2', targetVersion: '26.2' }), null)
  assert.equal(versionRefusal({ driverVersion: null, targetVersion: '26.2' }), null)
  const refusal = versionRefusal({ driverVersion: '26.2', targetVersion: '26.1.2' })
  assert.match(refusal, /built for Minecraft 26\.2/)
  assert.match(refusal, /serves 26\.1\.2/)
})

// ---------------------------------------------------------------------------
// The lane body
// ---------------------------------------------------------------------------

// A fake driver socket. One observation per endpoint, so the two lanes differ
// exactly where the test says they should. After quit the socket throws a
// connect error, which is what "the client is gone" looks like through the
// tunnel.
function createFakeDriver ({ views, settled = true, reportServer = null }) {
  const state = { dead: false, endpoint: null, calls: [], events: [] }
  const driver = {
    state,
    request: async (op) => {
      state.calls.push(op)
      if (state.dead) throw new DriverError('connection closed before a response', 'connect')
      if (op === 'status') {
        const view = views[state.endpoint]
        if (!view || !settled) {
          return { ok: true, data: { connected: false, level: false, player: false, screen: 'none', renderedSections: 0 } }
        }
        return { ok: true, data: { ...view.status, server: reportServer ?? state.endpoint } }
      }
      if (op === 'screen') return { ok: true, data: view0(views, state.endpoint).screenPayload }
      if (op === 'quit') { state.dead = true; state.quitting = true; return { ok: true, data: { quitting: true } } }
      return { ok: false, error: 'unknown op: ' + op }
    }
  }
  return driver
}

function view0 (views, endpoint) {
  return views[endpoint] ?? { status: status(), screenPayload: screen() }
}

function fakeClock (step = 250) {
  let ticks = 0
  return () => (ticks += step)
}

const laneViews = () => ({
  '127.0.0.1:25565': { status: status(), screenPayload: screen() },
  '127.0.0.1:25566': {
    status: status({ pos: { x: 10.25, y: -60, z: 4.5 }, held: 'empty', selectedSlot: 2 }),
    screenPayload: screen()
  }
})

async function runFakeLane ({ views = laneViews(), settled = true, reportServer = null } = {}) {
  const driver = createFakeDriver({ views, settled, reportServer })
  const launches = []
  const relaunch = async endpoint => {
    driver.state.dead = false
    driver.state.endpoint = endpoint
    driver.state.events.push('relaunch ' + endpoint)
    launches.push(endpoint)
    return { detail: 'fake relaunch' }
  }
  const report = await runParity({
    driver, relaunch, view: undefined,
    direct: { endpoint: '127.0.0.1:25565' },
    proxied: { endpoint: '127.0.0.1:25566' },
    version: '26.2',
    timeoutMs: 4000,
    pollMs: 250,
    portCloseTimeoutMs: 2000,
    now: fakeClock(),
    sleep: async () => {},
    log: () => {}
  })
  return { report, driver, launches }
}

test('the endpoint guard compares the port and, for a literal address, the host', () => {
  assert.equal(sameEndpoint('127.0.0.1:25565', '127.0.0.1:25565'), true)
  assert.equal(sameEndpoint('127.0.0.1:25566', '127.0.0.1:25565'), false)
  assert.equal(sameEndpoint('10.244.1.173:25565', 'monoplayer-testbed.tail41e568.ts.net:25565'), true,
    'a hostname endpoint resolves to an address the client reports, so only the port compares')
  assert.equal(sameEndpoint(null, '127.0.0.1:25565'), null, 'an older driver jar reports no address')
  assert.equal(sameEndpoint('nonsense', '127.0.0.1:25565'), false)
})

test('a client that joined another server fails the lane instead of being measured', async () => {
  const { report } = await runFakeLane({ reportServer: '127.0.0.1:25566' })
  assert.equal(report.passed, false)
  assert.equal(report.setupFailed, true)
  assert.match(report.sides.direct.error, /joined 127\.0\.0\.1:25566, not 127\.0\.0\.1:25565/)
})

test('the lane joins directly first, then through the proxy, and quits between them', async () => {
  const { report, launches } = await runFakeLane()
  assert.deepEqual(launches, ['127.0.0.1:25565', '127.0.0.1:25566'])
  assert.equal(report.rung, 'driver-parity')
  assert.equal(report.issue, 62)
  assert.equal(report.observer, 'none')
  assert.equal(report.version, '26.2')
  assert.equal(report.passed, true)
  assert.equal(report.setupFailed, false)
  assert.deepEqual(report.sides.direct.observed.pos, { x: 5.5, y: -60, z: -3.5 })
  assert.deepEqual(report.sides.proxied.observed.pos, { x: 10.25, y: -60, z: 4.5 })
  assert.equal(report.counts.unexplained, 0)
  assert.equal(report.sides.direct.server, '127.0.0.1:25565')
  assert.equal(report.sides.proxied.server, '127.0.0.1:25566')
  assert.equal(report.sides.direct.joinMatches, true)
})

test('a quit before each relaunch is what keeps one account to one session', async () => {
  const { driver, launches } = await runFakeLane()
  assert.equal(launches.length, 2)
  // The lane must never leave one client alive while the next joins: a server
  // kicks the first session when one account opens two.
  const sequence = driver.state.events.join(' | ')
  assert.match(sequence, /^relaunch 127\.0\.0\.1:25565 \| relaunch 127\.0\.0\.1:25566$/)
  assert.ok(driver.state.calls.filter(op => op === 'quit').length >= 2,
    'each lane quits its client, and the first lane also parks the socket it found')
})

test('a lane that never settles is a setup failure, not a comparison', async () => {
  const { report } = await runFakeLane({ settled: false })
  assert.equal(report.passed, false)
  assert.equal(report.setupFailed, true)
  assert.match(report.sides.direct.error, /did not settle/)
  assert.deepEqual(report.fields, [])
})

test('the run requires a driver and a relaunch adapter', async () => {
  await assert.rejects(() => runParity({ relaunch: async () => {}, direct: { endpoint: 'a:1' }, proxied: { endpoint: 'a:2' } }), TypeError)
  await assert.rejects(() => runParity({ driver: {}, direct: { endpoint: 'a:1' }, proxied: { endpoint: 'a:2' } }), TypeError)
  await assert.rejects(() => runParity({ driver: {}, relaunch: async () => {}, direct: { endpoint: 'a:1' } }), TypeError)
})

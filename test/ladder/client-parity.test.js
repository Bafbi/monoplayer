// The client-parity comparison (#13). The rung itself opens real sockets and
// stays out of the unit gate; the verdicts, the live-host guard, and the report
// shape do not need a socket, so they are pinned here.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PENDING,
  assertDeployableTarget,
  classifyFrame,
  compareRuns,
  compareState,
  formatReport,
  main,
  parseEndpoint
} from '../../src/ladder/client-parity.js'

const PENDING_ROWS = PENDING.reduce((total, entry) => total + entry.names.length, 0)
const sink = () => {
  const out = []
  return { out, stdout: { write: text => out.push(text) }, stderr: { write: text => out.push(text) } }
}
const frame = (name, state = 'play') => ({ state, name })
const decoded = (name, data) => ({ name, data })
const run = (label, frames, playFrames = []) => ({ label, endpoint: label + ':25565', frames, playFrames })
const pose = { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 }

test('the live Excalia fleet is never a target', () => {
  for (const host of ['play.excalia.fr', 'play2.excalia.fr', 'sky-2.excalia.fr', 'EXCALIA.FR']) {
    assert.throws(() => assertDeployableTarget(host), /live Excalia fleet/, host)
  }
  for (const host of ['127.0.0.1', 'localhost', 'paper.monoplayer-gate-b.svc.cluster.local']) {
    assert.equal(assertDeployableTarget(host), host)
  }
  assert.throws(() => assertDeployableTarget(''), /host is required/)
})

test('parseEndpoint reads HOST:PORT and applies the guard', () => {
  assert.deepEqual(parseEndpoint('127.0.0.1:25565'), { host: '127.0.0.1', port: 25565 })
  assert.equal(parseEndpoint(undefined), null)
  assert.throws(() => parseEndpoint('127.0.0.1'), /must be HOST:PORT/)
  assert.throws(() => parseEndpoint('127.0.0.1:0'), /port in 1\.\.65535/)
  assert.throws(() => parseEndpoint('play2.excalia.fr:25565'), /live Excalia fleet/)
})

test('a pending capability is a declared row with its issue, never a failure', () => {
  const row = classifyFrame({ state: 'play', name: 'player_chat', direct: 1, proxied: 0 })

  assert.equal(row.verdict, 'absent')
  assert.equal(row.issue, '#19')
  assert.match(row.reason, /read-only chat mode/)
  assert.equal(classifyFrame({ state: 'play', name: 'show_dialog', direct: 0, proxied: 0 }).verdict, 'absent')
  assert.equal(classifyFrame({ state: 'configuration', name: 'code_of_conduct', direct: 0, proxied: 0 }).verdict, 'absent')
})

test('presence decides the verdict, so a count difference stays evidence', () => {
  assert.equal(classifyFrame({ state: 'play', name: 'map_chunk', direct: 81, proxied: 80 }).verdict, 'same')
  assert.equal(classifyFrame({ state: 'play', name: 'position', direct: 4, proxied: 1 }).verdict, 'same')
})

test('the proxy policy is what makes a one-sided frame expected', () => {
  // per_leg: each connection owns it.
  assert.equal(classifyFrame({ state: 'play', name: 'position', direct: 1, proxied: 0 }).verdict, 'expected')
  // block, outside the pending tickets.
  assert.equal(classifyFrame({ state: 'play', name: 'kick_disconnect', direct: 1, proxied: 0 }).verdict, 'expected')
  // live_only: relayed live, never cached, so two runs catch different traffic.
  assert.equal(classifyFrame({ state: 'play', name: 'system_chat', direct: 2, proxied: 0 }).verdict, 'expected')
  // cache_only: the login the client sees is the session the proxy holds.
  assert.equal(classifyFrame({ state: 'play', name: 'login', direct: 1, proxied: 0 }).verdict, 'expected')
})

test('ordinary state only the direct client saw is a finding', () => {
  const ordinary = classifyFrame({ state: 'play', name: 'map_chunk', direct: 1, proxied: 0 })
  assert.equal(ordinary.verdict, 'unexplained')
  assert.match(ordinary.reason, /ordinary state/)

  const replay = classifyFrame({ state: 'play', name: 'map_chunk', direct: 0, proxied: 1 })
  assert.equal(replay.verdict, 'expected')
  assert.match(replay.reason, /attach replay carries the cached state/)

  const unknown = classifyFrame({ state: 'play', name: 'no_such_frame', direct: 1, proxied: 0 })
  assert.equal(unknown.verdict, 'unexplained')
  assert.match(unknown.reason, /no clientbound policy entry/)
})

test('compareRuns passes when both clients saw the same frames', () => {
  const frames = [frame('login'), frame('success', 'login'), frame('map_chunk'), frame('system_chat')]
  const report = compareRuns({
    direct: run('direct', frames, [decoded('position', pose)]),
    proxied: run('proxied', frames, [decoded('position', pose)])
  })

  assert.equal(report.ok, true)
  assert.equal(report.counts.unexplained, 0)
  assert.equal(report.counts.same, frames.length)
  assert.ok(report.state.domains.every(row => row.verdict === 'same'))
  assert.equal(report.counts.absent, PENDING_ROWS, 'every pending row is in the report')
  assert.equal(report.state.ok, true)
})

test('compareRuns fails on a frame only one client saw', () => {
  const report = compareRuns({
    direct: run('direct', [frame('login'), frame('map_chunk')], [decoded('position', pose)]),
    proxied: run('proxied', [frame('login')], [decoded('position', pose)])
  })

  assert.equal(report.ok, false)
  assert.deepEqual(report.unexplained.map(row => row.name), ['map_chunk'])
  assert.equal(report.counts.unexplained, 1)
})

test('the pose and entity domains are expected to differ; the rest are not', () => {
  const moved = compareState([decoded('position', pose)], [decoded('position', { ...pose, x: 4 })])
  assert.equal(moved.ok, true)
  assert.equal(moved.domains.find(row => row.domain === 'pose').verdict, 'expected')

  const entities = compareState(
    [decoded('entity_teleport', { entityId: 1, x: 0, y: 0, z: 0 })],
    [decoded('entity_teleport', { entityId: 2, x: 0, y: 0, z: 0 })]
  )
  assert.equal(entities.ok, true)
  assert.equal(entities.domains.find(row => row.domain === 'entities').verdict, 'expected')

  const block = location => ({ location, type: 1 })
  const blocks = compareState(
    [decoded('block_change', block({ x: 1, y: 0, z: 1 }))],
    [decoded('block_change', block({ x: 2, y: 0, z: 1 }))]
  )
  assert.equal(blocks.ok, false)
  const blocksRow = blocks.domains.find(row => row.domain === 'blocks')
  assert.equal(blocksRow.verdict, 'unexplained')
  assert.ok(blocksRow.diff, 'an unexplained domain carries its diff')
})

test('formatReport names the counts and the unexplained rows', () => {
  const pass = compareRuns({
    direct: run('direct', [frame('login')], [decoded('position', pose)]),
    proxied: run('proxied', [frame('login')], [decoded('position', pose)])
  })
  const passing = formatReport({
    sides: {
      direct: { endpoint: 'a:1', auth: 'offline', username: 'Parity', frames: { login: 1, configuration: 0, play: 1 } },
      proxied: { endpoint: 'b:2', auth: 'offline', username: 'Parity', frames: { login: 1, configuration: 0, play: 1 } }
    },
    ...pass
  })
  assert.match(passing, /parity: PASS/)
  assert.match(passing, /0 unexplained/)

  const fail = compareRuns({
    direct: run('direct', [frame('map_chunk')], []),
    proxied: run('proxied', [], [])
  })
  const failing = formatReport({ sides: {}, ...fail })
  assert.match(failing, /parity: FAIL 1 unexplained: play:map_chunk/)
})

test('main refuses a target that has no proxy, and the live fleet', async () => {
  const oneEndpoint = sink()
  assert.equal(await main(['--backend', '127.0.0.1:25565'], oneEndpoint), 2)
  assert.match(oneEndpoint.out.join(''), /give both --backend and --front/)

  const live = sink()
  assert.equal(await main(['--backend', 'play2.excalia.fr:25565', '--front', '127.0.0.1:25566'], live), 2)
  assert.match(live.out.join(''), /live Excalia fleet/)

  const badPort = sink()
  assert.equal(await main(['--backend', '127.0.0.1:0', '--front', '127.0.0.1:25566'], badPort), 2)
  assert.match(badPort.out.join(''), /port in 1\.\.65535/)
})

test('main needs a real account for a real target', async () => {
  const io = sink()
  const code = await main([
    '--backend', '127.0.0.1:25565', '--front', '127.0.0.1:25566',
    '--auth', 'microsoft', '--account', 'nobody', '--accounts', '/nonexistent'
  ], io)
  assert.equal(code, 2)
  assert.match(io.out.join(''), /cannot resolve the account/)
})

test('main prints its usage', async () => {
  const io = sink()
  assert.equal(await main(['--help'], io), 0)
  assert.match(io.out.join(''), /usage: node src\/ladder\/client-parity\.js/)
})

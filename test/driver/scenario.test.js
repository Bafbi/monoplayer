// Driver-lane scenario dry-run: exercise runDriverLane fully in-memory with fake
// adapter implementations (no network, no child processes, no fs beyond
// nothing). Proves the orchestration, the setup/assertion/probe
// classification, paired client+server evidence, and that a negative RCON
// error string can never count as a pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDriverLane } from '../../src/driver/scenario.js'
import { DriverError } from '../../src/driver/client-driver.js'

function createFakeRcon ({ state, brokenBlockCommands = false }) {
  const key = block => `${block.x},${block.y},${block.z}`
  const ops = []
  const matches = (command, prefix) => command.startsWith(prefix)

  const run = async (command, { label = '', kind = 'probe' } = {}) => {
    ops.push({ command, kind })
    const ok = (output) => ({ ok: true, output, stderr: '', command, label, kind, durationMs: 1 })
    if (matches(command, 'list')) {
      return ok(state.players.length === 0
        ? 'There are 0 of a max of 4 players online:'
        : `There are ${state.players.length} of a max of 4 players online: ${state.players.join(', ')}`)
    }
    if (matches(command, 'execute if block ')) {
      const [, x, y, z, block] = command.match(/execute if block (-?\d+) (-?\d+) (-?\d+) (\S+)/)
      const actual = state.blocks.get(`${x},${y},${z}`)
      if (brokenBlockCommands) return ok('Could not set the block')
      return ok(state.players.length === 0 && false // unreachable guard
        ? 'x' : (actual === block ? 'Test passed' : 'Test failed'))
    }
    if (matches(command, 'execute unless block ')) {
      const [, x, y, z, block] = command.match(/execute unless block (-?\d+) (-?\d+) (-?\d+) (\S+)/)
      const actual = state.blocks.get(`${x},${y},${z}`)
      if (brokenBlockCommands) return ok('Could not set the block')
      return ok(actual !== block ? 'Test passed' : 'Test failed')
    }
    if (matches(command, 'forceload ')) {
      const [, x, z] = command.match(/forceload add (-?\d+) (-?\d+)/)
      state.forceLoaded = state.forceLoaded || new Set()
      state.forceLoaded.add(`${x},${z}`)
      return ok(`Marked chunk [${Math.floor(x / 16)}, ${Math.floor(z / 16)}] in minecraft:overworld to be force loaded`)
    }
    if (matches(command, 'setblock ')) {
      const [, x, y, z, block] = command.match(/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/)
      state.blocks.set(`${x},${y},${z}`, block)
      return ok(`Changed the block at ${x}, ${y}, ${z}`)
    }
    if (matches(command, 'fill ')) {
      const [, x1, y1, z1, x2, y2, z2, block] =
        command.match(/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)/)
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
            state.blocks.set(`${x},${y},${z}`, block)
          }
        }
      }
      return ok(`Successfully filled ${Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1))} block(s)`)
    }
    if (matches(command, 'tp ')) {
      const [, , x, y, z] = command.match(/^tp (\S+) (\S+) (\S+) (\S+)$/)
      state.pos = { x: Number(x), y: Number(y), z: Number(z) }
      return ok('Teleported')
    }
    if (matches(command, 'give ')) {
      const [, , item] = command.match(/^give (\S+) (\S+) 64$/)
      state.held = item
      return ok(`Gave 64 ${item}`)
    }
    if (matches(command, 'data get entity Bafbi Pos')) {
      const p = state.pos
      return ok(`Bafbi has the following entity data: [${p.x}d, ${p.y}d, ${p.z}d]`)
    }
    if (matches(command, 'data get entity Bafbi Rotation')) {
      return ok(`Bafbi has the following entity data: [${state.yaw}f, ${state.pitch}f]`)
    }
    if (matches(command, 'data get entity Bafbi Dimension')) {
      return ok('Bafbi has the following entity data: "minecraft:overworld"')
    }
    throw new Error(`fake rcon does not implement: ${command}`)
  }
  return {
    run,
    _ops: ops,
    _state: state,
    list: () => run('list', { kind: 'probe', label: 'list' }),
    getEntityPos: () => run('data get entity Bafbi Pos', { kind: 'probe', label: 'pos' }),
    getEntityRotation: () => run('data get entity Bafbi Rotation', { kind: 'probe', label: 'rotation' }),
    getEntityDimension: () => run('data get entity Bafbi Dimension', { kind: 'probe', label: 'dimension' }),
    give: (name, item, count) => run(`give ${name} ${item} ${count}`, { kind: 'setup', label: 'give' }),
  }
}

function createFakeDriver ({ state }) {
  const settledStatus = () => ({
    screen: 'none', level: true, player: true, connected: true, fps: 60,
    name: 'Bafbi', yaw: state.yaw, pitch: state.pitch, pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
    held: state.held, dimension: 'overworld', loadedChunks: 100, renderedSections: 20,
  })
  const request = async (op, params = {}) => {
    if (state.dead) throw new DriverError('connection closed before a response', 'connect')
    switch (op) {
      case 'status':
        return state.disconnected
          ? { ok: true, data: { screen: 'net.minecraft.client.gui.screens.JoinMultiplayerScreen', level: false, player: false, connected: false } }
          : { ok: true, data: settledStatus() }
      case 'move': {
        state.pos = { ...state.pos, z: state.pos.z + 2.5 } // walk "forward"
        return { ok: true, data: { movingMs: params.ms } }
      }
      case 'look':
        state.yaw = params.yaw
        state.pitch = params.pitch
        return { ok: true, data: { yaw: params.yaw, pitch: params.pitch } }
      case 'break': {
        const at = `${params.x},${params.y},${params.z}`
        const before = state.blocks.get(at)
        state.blocks.set(at, 'minecraft:air')
        return { ok: true, data: { x: params.x, y: params.y, z: params.z, before: `Block{${before}}`, after: 'minecraft:air', broke: true } }
      }
      case 'place': {
        const target = `${params.x},${params.y + 1},${params.z}`
        state.blocks.set(target, state.held)
        return { ok: true, data: { baseX: params.x, baseY: params.y, baseZ: params.z, baseSource: 'explicit', placed: true, held: state.held } }
      }
      case 'screenshot':
        return { ok: true, data: { path: '/fake/host/screenshots/driver-1.png' } }
      case 'disconnect':
        state.disconnected = true
        state.players = state.players.filter(name => name !== 'Bafbi')
        return { ok: true, data: {} }
      case 'quit':
        state.dead = true
        return { ok: true, data: { quitting: true } }
      default:
        return { ok: false, error: `unknown op: ${op}` }
    }
  }
  return { request }
}

function createFakeRelaunch ({ state }) {
  return async () => {
    state.disconnected = false
    state.dead = false
    state.players = ['Bafbi']
    return { detail: 'fake relaunch' }
  }
}

const fakeAdapters = ({ state, brokenBlockCommands = false } = {}) => {
  state = state ?? {
    blocks: new Map([['13.0,-61.0,-5.0', 'minecraft:stone']]), // spawn platform block
    players: ['Bafbi'],
    pos: { x: 13.5, y: -60, z: -4.5 },
    yaw: 45.75, pitch: 0,
    held: 'minecraft:stone',
    disconnected: false, dead: false,
  }
  return {
    state,
    driver: createFakeDriver({ state }),
    rcon: createFakeRcon({ state, brokenBlockCommands }),
    relaunch: createFakeRelaunch({ state }),
    screenshotFetch: async remotePath => ({ localPath: `/tmp/fake-${remotePath.split('/').pop()}`, bytes: 1024, format: 'png' }),
    sleep: async () => {},
  }
}

test('dry run: happy path passes with classified setup/assertion/probe ops', async () => {
  const { state, driver, rcon, relaunch, screenshotFetch, sleep } = fakeAdapters()
  const report = await runDriverLane({
    runIndex: 1, nonce: 'dry-1', driver, rcon, relaunch, screenshotFetch, sleep,
    logStream: null,
  })

  assert.equal(report.passed, true, `failure: ${report.failure}`)
  assert.equal(report.assertions.every(a => a.ok), true)
  assert.equal(report.lane, 'driver')

  // Paired evidence: every pass claim carries a source.
  assert.ok(report.assertions.some(a => a.ok && a.source === 'server'))
  assert.ok(report.assertions.some(a => a.ok && a.source === 'client'))
  assert.ok(report.assertions.some(a => a.ok && a.source === 'artifact'))

  // RCON op classification.
  const counts = report.metrics.rconOpCounts
  assert.ok(counts.setup > 0, 'arena/tp/give ops are classified setup')
  assert.ok(counts.assertion > 0, 'block assertions are classified assertion')
  assert.ok(counts.probe > 0, 'data get/list reads are classified probe')

  // Driver ops include the actions and the probes; no reconnect op anywhere.
  const driverOpNames = report.driverOps.map(op => op.op)
  for (const requiredOp of ['move', 'look', 'break', 'place', 'screenshot', 'disconnect', 'quit']) {
    assert.ok(driverOpNames.includes(requiredOp), `driverOps include ${requiredOp}`)
  }
  assert.ok(!driverOpNames.includes('reconnect'), 'no driver reconnect op (council correction #1)')

  // Run isolation: relaunch happened twice (fresh process before baseline and
  // for the rejoin), artifacts exist, rejoin metric recorded.
  assert.equal(report.artifacts.length, 1)
  assert.ok(report.metrics.settleMs !== null)
  assert.ok(report.metrics.rejoinSettleMs !== null)
  assert.ok(report.metrics.moveDeltaBlocks >= 1.5)
  assert.ok(report.assertions.some(a => a.ok && a.name.includes('RCON list no longer contains Bafbi')))
  assert.ok(report.assertions.some(a => a.ok && a.name.includes('RCON list contains Bafbi')))
  assert.ok(report.limitations.some(line => line.includes('unmodded')))
})

test('dry run: broken block command output can never count as a pass', async () => {
  // RCON adapter returns "Could not set the block" instead of a verdict for
  // `execute if block` — the negative text must fail the run, not pass it
  // (council correction #2).
  const fake = fakeAdapters({ brokenBlockCommands: true })
  const report = await runDriverLane({ runIndex: 1, nonce: 'dry-2', ...fake, logStream: null })
  assert.equal(report.passed, false)
  assert.ok(String(report.failure).includes('preflight'))
  const brokenVerdicts = report.assertions.filter(a => a.ok === false &&
    String(a.detail?.verdict) === 'unknown')
  assert.ok(brokenVerdicts.length >= 1, 'the unknown verdict was recorded honestly as a failed assertion')
})

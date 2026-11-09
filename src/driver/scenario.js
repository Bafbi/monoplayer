// One-run driver-lane (G0) scenario orchestrator.
//
// All side effects arrive through injected adapters, so the orchestration
// logic is testable without a network:
//
//   driver          -> NDJSON client for 127.0.0.1:25599 (src/driver/client-driver.js)
//   rcon            -> kubectl exec rcon-cli adapter (src/driver/rcon.js)
//   relaunch        -> async fn: starts a FRESH Prism client on the display
//                      host via `ssh` + prismlauncher; the caller is expected
//                      to have quit the previous one (council correction #1:
//                      there is no driver reconnect op).
//   screenshotFetch -> async fn(remotePath): scp the on-host PNG back and
//                      return { localPath, bytes, format }.
//   sleep, now      -> timing injection.
//
// Evidence rules honored here (council corrections):
//  * every pass claim pairs a client-state read with an independent
//    server-side RCON assertion (positive `execute [unless] if block` — the
//    "Test passed" verdict — never a negative "Could not set" parse);
//  * every RCON op is classified setup | assertion | probe;
//  * run isolation: fresh client process per run, run-scoped arena/edit
//    coordinates, preflight expected block states, explicit limitations.
import { buildRunPlan, planSafetyIssues, ARENA, runCenter } from './plan.js'
import {
  isSettled, isDisconnected, describeStatus, parseEntityPos, parseEntityRotation,
  parsePlayerList, positionsWithin, rotationsWithin, parseBlockTest, redactSecrets,
} from './checks.js'
import { DriverError } from './client-driver.js'

const SETTLE_POLL_MS = 1000
const OP_PAUSE_MS = 300

export const DEFAULT_PINS = {
  gate: 'B',
  row: 'G0 — host readiness, direct Paper',
  clientLane: 'driver',
  minecraftVersion: '26.1.2',
  protocolVersion: 775,
  paperBuild: '26.1.2 build 74',
  fabricLoader: '0.20.1',
  javaRuntime: '25.0.1 (epsilon)',
  launcher: 'Prism 11.0.3',
  backend: 'direct Paper 26.1.2 (M2 row); Monoplayer and Velocity are not involved in G0',
}

const LIMITATIONS = [
  'Client gamemode is creative; survival-rate break/place holds are not exercised by this lane.',
  'No driver reconnect op exists by design (council correction #1): rejoin = driver quit + host-side relaunch through the injected relaunch adapter.',
  'The unmodded Prism witness run is a separate, still-pending manual lane; no anti-masking evidence yet.',
  'The driver does not select hotbar slots; the scenario relies on /give filling the first empty (selected) slot and verifies the held item client-side.',
  'The backend world is an emptyDir flat void map: restarts wipe edits; all coordinates are run-scoped.',
  'Generated report files are scanned for token/password-shaped content before writing; long hex-like strings may be over-redacted.',
]

function iso (timestamp) {
  return new Date(timestamp).toISOString()
}

async function defaultSleep (ms) {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

export async function runDriverLane ({
  runIndex,
  nonce = Date.now().toString(36) + '-' + runIndex,
  plan = buildRunPlan({ runIndex, nonce }),
  driver,
  rcon,
  relaunch,
  screenshotFetch,
  sleep = defaultSleep,
  now = Date.now,
  player = 'Bafbi',
  moveMs = 700,
  settleTimeoutMs = 120000,
  rejoinTimeoutMs = 180000,
  portCloseTimeoutMs = 45000,
  clientHost = 'nath',
  logStream = process.stderr,
} = {}) {
  const startedAt = iso(now())
  const started = now()
  const assertions = []
  const rconOps = []
  const driverOps = []
  const artifacts = []
  const limitations = [...LIMITATIONS]
  const metrics = {
    statusPolls: 0,
    settleMs: null,
    rejoinSettleMs: null,
    moveDeltaBlocks: null,
    rconOpCounts: { setup: 0, assertion: 0, probe: 0 },
    driverOpCounts: { action: 0, probe: 0 },
  }
  let phase = 'init'
  let failure = null

  const check = (name, ok, detail = {}, { source = 'client', kind = 'assertion' } = {}) => {
    assertions.push({ name, ok: Boolean(ok), detail, source, kind })
    return Boolean(ok)
  }

  const log = message => {
    if (logStream) logStream.write(`[driver run ${runIndex} / ${phase}] ${message}\n`)
  }

  // Wrap a phase: any throw becomes an honest recorded failure before the
  // run aborts, so the report always explains where it stopped.
  const step = async (label, fn) => {
    phase = label
    log('→ ' + label)
    try {
      return await fn()
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      failure = `${label}: ${message}`
      check(`step failed: ${label}`, false, { error: message, phase }, { source: 'artifact' })
      throw error
    }
  }

  const recordRcon = result => {
    if (!['setup', 'assertion', 'probe'].includes(result.kind)) {
      throw new Error(`unclassified RCON operation kind: ${result.kind}`)
    }
    const { text: output } = redactSecrets(result.output)
    const { text: stderr } = redactSecrets(result.stderr || '')
    rconOps.push({
      at: iso(now()), kind: result.kind, label: result.label, command: result.command,
      ok: result.ok, output, stderr, durationMs: result.durationMs,
    })
    metrics.rconOpCounts[result.kind] = (metrics.rconOpCounts[result.kind] || 0) + 1
    return result
  }

  const rconRun = async (label, kind, command, { require = null } = {}) => {
    const result = recordRcon(await rcon.run(command, { label, kind }))
    if (!result.ok) throw new Error(`rcon ${kind} failed [${command}]: ${result.stderr || result.output || 'no output'}`)
    // RCON "ok" only means kubectl worked; the command may still have failed
    // quietly (e.g. fill in a never-generated chunk answers "That position is
    // not loaded"). Guard on error-shaped text and optionally require a
    // specific success shape.
    if (/(that position is not loaded|could not|unknown or incomplete command)/i.test(result.output)) {
      throw new Error(`rcon ${kind} command rejected [${command}]: ${result.output}`)
    }
    if (require && !require.test(result.output)) {
      throw new Error(`rcon ${kind} unexpected output [${command}]: ${result.output}`)
    }
    return result
  }

  // Positive block assertion: `execute [unless] if block ...` must answer
  // "Test passed". Anything else is a failure, never a pass.
  const assertBlock = async (name, at, block, { negate = false } = {}) => {
    const command = negate
      ? `execute unless block ${at.x} ${at.y} ${at.z} ${block}`
      : `execute if block ${at.x} ${at.y} ${at.z} ${block}`
    const result = recordRcon(await rcon.run(command, { label: name, kind: 'assertion' }))
    if (!result.ok) {
      throw new Error(`rcon assertion failed [${command}]: ${result.stderr || 'kubectl exec failed'}`)
    }
    const verdict = parseBlockTest(result.output)
    check(name, verdict === 'passed', { command, verdict, output: result.output }, { source: 'server' })
    if (verdict !== 'passed') throw new Error(`${name} (verdict ${verdict})`)
    return result
  }

  const recordDriverOp = (op, params, envelope, kind) => {
    driverOps.push({
      at: iso(now()), op, params, ok: Boolean(envelope && envelope.ok),
      error: envelope && envelope.error ? envelope.error : null,
      data: envelope && envelope.ok ? envelope.data : null,
      kind,
    })
    metrics.driverOpCounts[kind] = (metrics.driverOpCounts[kind] || 0) + 1
    return envelope
  }

  const driverRequest = async (op, params = {}, kind = 'action', { timeoutMs = 20000 } = {}) => {
    const envelope = await driver.request(op, params, { timeoutMs })
    return recordDriverOp(op, params, envelope, kind)
  }

  // Poll driver status until settled. Used for join, rejoin, and readiness.
  const waitSettled = async ({ timeoutMs, label }) => {
    const deadline = now() + timeoutMs
    let lastStatus = null
    let lastError = null
    while (now() < deadline) {
      metrics.statusPolls++
      try {
        const envelope = await driver.request('status', {}, { timeoutMs: 5000 })
        recordDriverOp('status', {}, envelope, 'probe')
        lastError = null
        lastStatus = envelope.ok ? envelope.data : { error: envelope.error, connected: null }
        if (isSettled(lastStatus)) return { status: lastStatus, attempts: metrics.statusPolls }
      } catch (error) {
        lastError = error.message
        lastStatus = null
      }
      await sleep(SETTLE_POLL_MS)
    }
    const where = lastStatus ? describeStatus(lastStatus) : `last error: ${lastError}`
    throw new Error(`${label}: client did not settle within ${timeoutMs} ms (${where})`)
  }

  // Wait until the driver port stops answering. The tunnel forwards the port
  // locally, so "closed" = connects fail or drop without a response. Only
  // trusted after at least one successful request this run.
  const waitPortClosed = async ({ timeoutMs }) => {
    const deadline = now() + timeoutMs
    let lastError = null
    while (now() < deadline) {
      try {
        await driver.request('status', {}, { timeoutMs: 4000 })
        await sleep(500)
      } catch (error) {
        lastError = error
        // Only a connect failure proves the client/port is gone. A timeout or
        // protocol error means something is still there (or the tunnel is
        // sick); do not count it as a clean quit.
        if (error && error.code === 'connect') {
          return { closed: true, error: error.message }
        }
        await sleep(500)
      }
    }
    return {
      closed: false,
      error: lastError ? `last error: ${lastError.message}` : `port still answering after ${timeoutMs} ms`,
    }
  }

  const waitServerCondition = async ({ timeoutMs, poll, describe }) => {
    const deadline = now() + timeoutMs
    let last = null
    while (now() < deadline) {
      last = await poll()
      if (last.ok && last.match) return last
      await sleep(600)
    }
    throw new Error(`${describe(last)} (waited ${timeoutMs} ms)`)
  }

  try {
    // ------------------------------------------------------------------
    // 0. Preconditions: RCON works, driver reachable, fresh client process.
    // ------------------------------------------------------------------
    await step('preconditions: server-side reachability', async () => {
      const listResult = recordRcon(await rcon.run('list', { kind: 'probe', label: 'list' }))
      if (!listResult.ok) throw new Error(`RCON unreachable: ${listResult.stderr || 'no output'}`)
      const players = parsePlayerList(listResult.output)
      check('precondition: RCON reachable and lists players', players !== null,
        { output: listResult.output, players }, { source: 'server' })
      if (players === null) throw new Error(`unparseable /list output: ${listResult.output}`)
    })

    await step('preconditions: driver socket + fresh client process', async () => {
      let initial = null
      try {
        initial = await driver.request('status', {}, { timeoutMs: 4000 })
        recordDriverOp('status', {}, initial, 'probe')
      } catch (error) {
        limitations.push('pre-run client was not reachable through the driver tunnel; going straight to a host-side relaunch')
      }
      if (initial && initial.ok) {
        check('precondition: driver socket answered status', true, { status: initial.data }, { source: 'client' })
        // Run isolation (council correction #3): quit whatever client this
        // socket belongs to and relaunch a fresh process below.
        const quitEnvelope = await driverRequest('quit', {}, 'action')
        if (!quitEnvelope.ok) throw new Error(`driver quit failed: ${quitEnvelope.error}`)
        const closed = await waitPortClosed({ timeoutMs: portCloseTimeoutMs })
        check('precondition: previous client quit before relaunch', closed.closed,
          { timeoutMs: portCloseTimeoutMs, detail: closed.error }, { source: 'artifact' })
        if (!closed.closed) throw new Error('previous client did not quit before relaunch')
      }
    })

    // ------------------------------------------------------------------
    // 1. Launch a fresh client and wait for a settled world.
    // ------------------------------------------------------------------
    await step('launch: fresh client via host-side relaunch', async () => {
      const launchStarted = now()
      let result
      try {
        result = await relaunch()
      } catch (error) {
        throw new Error(`relaunch adapter failed: ${error.message}`)
      }
      check('launch: host-side relaunch accepted', result !== null && result !== undefined,
        { preview: result && result.detail }, { source: 'artifact' })
      const settled = await waitSettled({ timeoutMs: settleTimeoutMs, label: 'launch' })
      metrics.settleMs = now() - launchStarted
      check('launch: client settles into the world (screen none, level, rendered sections)',
        true, { status: settled.status, settleMs: metrics.settleMs }, { source: 'client' })
    })

    // ------------------------------------------------------------------
    // 2. Baseline: client state paired with independent server state.
    // ------------------------------------------------------------------
    let baselineServerPos = null
    await step('baseline: client paired with server state', async () => {
      const posResult = recordRcon(await rcon.getEntityPos(player))
      baselineServerPos = parseEntityPos(posResult.output)
      if (!baselineServerPos) throw new Error(`cannot parse server position: ${posResult.output}`)
      const dimension = recordRcon(await rcon.getEntityDimension(player))
      check('baseline: server sees the player in the overworld',
        dimension.output.includes('minecraft:overworld'),
        { pos: baselineServerPos, output: dimension.output }, { source: 'server' })
      const envelope = await driverRequest('status', {}, 'probe')
      if (!envelope.ok) throw new Error(`status failed: ${envelope.error}`)
      check('baseline: client connected with a player', isSettled(envelope.data),
        { status: envelope.data }, { source: 'client' })
      check('baseline: client name matches the driven account', envelope.data.name === player,
        { name: envelope.data.name, expected: player }, { source: 'client' })
      check('baseline: client and server positions agree',
        positionsWithin(envelope.data.pos, baselineServerPos, 1.5),
        { client: envelope.data.pos, server: baselineServerPos, toleranceBlocks: 1.5 },
        { source: 'server' })
      metrics.baselineServerPos = baselineServerPos
    })

    // ------------------------------------------------------------------
    // 3. Give the hotbar item (server-side, then verified client-side).
    // ------------------------------------------------------------------
    let heldItem = null
    await step('setup: give stone and confirm the client holds it', async () => {
      const result = recordRcon(await rcon.give(player, 'minecraft:stone', 64))
      check('setup: /give accepted for item hand', result.ok && /^Gave \d+/.test(result.output),
        { output: result.output }, { source: 'server' })
      if (!result.ok || !/^Gave \d+/.test(result.output)) throw new Error(`give failed: ${result.output}`)
      await sleep(OP_PAUSE_MS)
      const envelope = await driverRequest('status', {}, 'probe')
      if (!envelope.ok) throw new Error(`status failed: ${envelope.error}`)
      heldItem = envelope.data.held
      check('setup: client reports a non-empty held item (driver places from the selected slot)',
        heldItem !== undefined && heldItem !== null && heldItem !== 'empty',
        { held: heldItem }, { source: 'client' })
    })

    // ------------------------------------------------------------------
    // 4. Build/clear the run-scoped arena (safe by construction).
    //
    // Chunk-loading order matters on Paper: /fill into chunks no player has
    // ever visited answers "That position is not loaded". Force-load the
    // arena's chunks first, build, and only then teleport the player in.
    // ------------------------------------------------------------------
    await step('setup: force-load the arena chunks and build the arena', async () => {
      const issues = planSafetyIssues(plan)
      check('setup: plan safety invariants hold', issues.length === 0,
        { issues, plan: { center: plan.center, run: plan.runIndex, nonce: plan.nonce } },
        { source: 'artifact' })
      if (issues.length > 0) throw new Error(`plan is unsafe: ${issues.join('; ')}`)

      const box = plan.arena.clearBox
      const floorY = plan.arena.floorY
      // Force-load the four corner chunks of the arena footprint.
      for (const [x, z] of [[box.minX, box.minZ], [box.maxX, box.minZ], [box.minX, box.maxZ], [box.maxX, box.maxZ]]) {
        await rconRun(`force-load chunk at ${x},${z}`, 'setup', `forceload add ${x} ${z}`)
      }
      for (const layer of [...plan.arena.clearedLayers].reverse()) {
        await rconRun(`arena clear y=${layer}`, 'setup',
          `fill ${box.minX} ${layer} ${box.minZ} ${box.maxX} ${layer} ${box.maxZ} minecraft:air`,
          { require: /^(Successfully filled \d+ block|No blocks were filled)/ })
      }
      await rconRun('arena floor fill', 'setup',
        `fill ${box.minX} ${floorY} ${box.minZ} ${box.maxX} ${floorY} ${box.maxZ} ${plan.arena.floorBlock}`,
        { require: /^(Successfully filled \d+ block|No blocks were filled)/ })
    })

    await step('setup: teleport to the arena centre; preflight block states', async () => {
      const target = plan.teleport
      await rconRun('teleport to arena centre', 'setup',
        `tp ${player} ${target.x} ${target.y} ${target.z}`,
        { require: /^Teleported/ })
      await sleep(OP_PAUSE_MS * 2)
      const posResult = recordRcon(await rcon.getEntityPos(player))
      const serverPos = parseEntityPos(posResult.output)
      if (!serverPos) throw new Error(`cannot parse server position after tp: ${posResult.output}`)
      metrics.centerServerPos = serverPos
      check('setup: server position matches the teleport target',
        positionsWithin(serverPos, target, 1.0),
        { server: serverPos, target, toleranceBlocks: 1.0 }, { source: 'server' })
      if (!positionsWithin(serverPos, target, 1.0)) throw new Error('teleport did not land on target')

      // Preflight expected block states (council correction #3): positive
      // assertions before any edit.
      for (const preflight of plan.preflight) {
        await assertBlock(preflight.name, preflight.at, blockForState(preflight.expect))
      }

      const envelope = await driverRequest('status', {}, 'probe')
      if (!envelope.ok) throw new Error(`status failed: ${envelope.error}`)
      check('setup: client position tracks the teleport target',
        positionsWithin(envelope.data.pos, target, 1.5),
        { client: envelope.data.pos, target, toleranceBlocks: 1.5 }, { source: 'client' })
    })

    // ------------------------------------------------------------------
    // 5. Movement, verified server-side.
    // ------------------------------------------------------------------
    let afterMovePos = null
    await step('move and assert server-side position delta', async () => {
      const beforePos = metrics.centerServerPos || baselineServerPos
      const envelope = await driverRequest('move', { ms: moveMs }, 'action')
      if (!envelope.ok) throw new Error(`driver move failed: ${envelope.error}`)
      await sleep(moveMs + OP_PAUSE_MS)
      const posResult = recordRcon(await rcon.getEntityPos(player))
      afterMovePos = parseEntityPos(posResult.output)
      if (!afterMovePos) throw new Error(`cannot parse server position after move: ${posResult.output}`)
      const delta = Math.hypot(afterMovePos.x - beforePos.x, afterMovePos.z - beforePos.z)
      metrics.moveDeltaBlocks = delta
      check(`move: server position changed by >= 1.5 blocks after ${moveMs} ms`,
        delta >= 1.5, { baseline: beforePos, after: afterMovePos, deltaBlocks: round(delta) },
        { source: 'server' })
      if (delta < 1.5) throw new Error(`server-side movement delta too small: ${delta}`)
      const box = plan.arena.clearBox
      check('move: player stayed on the arena footprint',
        afterMovePos.x >= box.minX - 1 && afterMovePos.x <= box.maxX + 1 &&
        afterMovePos.z >= box.minZ - 1 && afterMovePos.z <= box.maxZ + 1,
        { after: afterMovePos, arena: box }, { source: 'server' })
      const status = await driverRequest('status', {}, 'probe')
      if (!status.ok) throw new Error(`status failed: ${status.error}`)
      check('move: client and server positions agree after moving',
        positionsWithin(status.data.pos, afterMovePos, 1.5),
        { client: status.data.pos, server: afterMovePos, toleranceBlocks: 1.5 }, { source: 'server' })
    })

    // ------------------------------------------------------------------
    // 6. Look, verified server-side.
    // ------------------------------------------------------------------
    const LOOK = { yaw: 90, pitch: 10, tolYaw: 2, tolPitch: 2 }
    await step('look and assert server-side rotation', async () => {
      await rconRun('teleport to arena centre', 'setup',
        `tp ${player} ${plan.teleport.x} ${plan.teleport.y} ${plan.teleport.z}`)
      await sleep(OP_PAUSE_MS)
      const envelope = await driverRequest('look', { yaw: LOOK.yaw, pitch: LOOK.pitch }, 'action')
      if (!envelope.ok) throw new Error(`driver look failed: ${envelope.error}`)
      await sleep(OP_PAUSE_MS)
      const rotResult = recordRcon(await rcon.getEntityRotation(player))
      const serverRot = parseEntityRotation(rotResult.output)
      if (!serverRot) throw new Error(`cannot parse server rotation: ${rotResult.output}`)
      check('look: server rotation matches the requested yaw/pitch',
        rotationsWithin(serverRot, { yaw: LOOK.yaw, pitch: LOOK.pitch }, { tolYaw: LOOK.tolYaw, tolPitch: LOOK.tolPitch }),
        { requested: LOOK, server: serverRot, toleranceDeg: { yaw: LOOK.tolYaw, pitch: LOOK.tolPitch } },
        { source: 'server' })
      if (!rotationsWithin(serverRot, { yaw: LOOK.yaw, pitch: LOOK.pitch }, { tolYaw: LOOK.tolYaw, tolPitch: LOOK.tolPitch })) {
        throw new Error(`server rotation ${JSON.stringify(serverRot)} does not match requested yaw ${LOOK.yaw} pitch ${LOOK.pitch}`)
      }
      const status = await driverRequest('status', {}, 'probe')
      if (!status.ok) throw new Error(`status failed: ${status.error}`)
      check('look: client rotation agrees with the request too',
        rotationsWithin({ yaw: status.data.yaw, pitch: status.data.pitch }, LOOK, { tolYaw: LOOK.tolYaw, tolPitch: LOOK.tolPitch }),
        { client: { yaw: status.data.yaw, pitch: status.data.pitch } }, { source: 'client' })
    })

    // ------------------------------------------------------------------
    // 7. Seed a target block, then break it at explicit coordinates.
    // ------------------------------------------------------------------
    await step('break: seed + break + server-side air assertion', async () => {
      const target = plan.edits.break.target
      await rconRun('seed break target with stone', 'setup',
        `setblock ${target.x} ${target.y} ${target.z} minecraft:stone`,
        { require: /^(Changed|Set) the block/ })
      await assertBlock('seed: server target block is stone', target, 'minecraft:stone')
      await sleep(OP_PAUSE_MS + 500) // let the client receive the block update

      const envelope = await driverRequest('break', { x: target.x, y: target.y, z: target.z }, 'action')
      if (!envelope.ok) throw new Error(`driver break failed: ${envelope.error}`)
      const data = envelope.data
      check('break: client aimed at the seeded stone (client perceived it before breaking)',
        typeof data.before === 'string' && data.before.includes('stone'),
        { before: data.before, x: data.x, y: data.y, z: data.z }, { source: 'client' })
      check('break: client reports the block broke', data.broke === true,
        { broke: data.broke, after: data.after }, { source: 'client' })
      await sleep(OP_PAUSE_MS)
      await assertBlock('break: server block is air after the break', target, 'minecraft:air')
      metrics.editTarget = target
    })

    // ------------------------------------------------------------------
    // 8. Place on the explicit support block; assert server-side non-air.
    // ------------------------------------------------------------------
    await step('place: place on the support + server-side non-air assertion', async () => {
      const support = plan.edits.place.support
      const target = plan.edits.place.target
      const envelope = await driverRequest('place', { x: support.x, y: support.y, z: support.z }, 'action')
      if (!envelope.ok) throw new Error(`driver place failed: ${envelope.error}`)
      const data = envelope.data
      check('place: client reports a placed item on the support', data.placed === true,
        { placed: data.placed, base: `${data.baseX},${data.baseY},${data.baseZ}`, held: data.held },
        { source: 'client' })
      await sleep(OP_PAUSE_MS + 200)
      await assertBlock('place: server target block is not air', target, 'minecraft:air', { negate: true })
      await assertBlock('place: server target block is stone', target, 'minecraft:stone')
      metrics.placeTarget = target
    })

    // ------------------------------------------------------------------
    // 9. Screenshot artifact, copied back from the display host.
    // ------------------------------------------------------------------
    await step('screenshot: capture and copy back', async () => {
      const envelope = await driverRequest('screenshot', {}, 'action')
      if (!envelope.ok) throw new Error(`driver screenshot failed: ${envelope.error}`)
      const remotePath = envelope.data.path
      const artifact = await screenshotFetch(remotePath)
      artifacts.push({ kind: 'screenshot', remotePath, localPath: artifact.localPath, bytes: artifact.bytes })
      check('screenshot: PNG copied back from the display host',
        artifact.format === 'png' && artifact.bytes > 0,
        { remotePath, localPath: artifact.localPath, bytes: artifact.bytes }, { source: 'artifact' })
      if (!(artifact.format === 'png' && artifact.bytes > 0)) throw new Error('screenshot artifact missing or not a PNG')
    })

    // ------------------------------------------------------------------
    // 10. Disconnect: client leaves the world; server drops the player.
    // ------------------------------------------------------------------
    await step('disconnect: client hangs up, server confirms', async () => {
      const envelope = await driverRequest('disconnect', {}, 'action')
      if (!envelope.ok) throw new Error(`driver disconnect failed: ${envelope.error}`)
      // Client side.
      let finalStatus = null
      const deadline = now() + 20000
      while (now() < deadline) {
        metrics.statusPolls++
        try {
          const result = await driver.request('status', {}, { timeoutMs: 5000 })
          recordDriverOp('status', {}, result, 'probe')
          if (result.ok && isDisconnected(result.data)) {
            finalStatus = result.data
            break
          }
          finalStatus = result.ok ? result.data : finalStatus
        } catch (error) {
          // keep polling; the socket may hiccup as the connection drops
        }
        await sleep(500)
      }
      check('disconnect: client reports connected=false', finalStatus !== null &&
        finalStatus.connected === false, { status: finalStatus }, { source: 'client' })
      if (!(finalStatus !== null && finalStatus.connected === false)) {
        throw new Error('client never reported connected=false after disconnect')
      }
      // Server side (independent evidence).
      const drop = await waitServerCondition({
        timeoutMs: 10000,
        poll: async () => {
          const listResult = recordRcon(await rcon.list())
          const players = listResult.ok ? parsePlayerList(listResult.output) : null
          return { ok: listResult.ok && players !== null, match: players !== null && !players.includes(player), players, output: listResult.output }
        },
        describe: last => `server still lists ${player}: ${(last.players || []).join(', ') || 'no list'} (${last.output || 'no output'})`,
      })
      check(`disconnect: RCON list no longer contains ${player}`, true,
        { players: drop.players }, { source: 'server' })
    })

    // ------------------------------------------------------------------
    // 11. Quit: client process exits; driver port closes.
    // ------------------------------------------------------------------
    await step('quit: process exit closes the driver port', async () => {
      const envelope = await driverRequest('quit', {}, 'action')
      if (!envelope.ok) throw new Error(`driver quit failed: ${envelope.error}`)
      const closed = await waitPortClosed({ timeoutMs: portCloseTimeoutMs })
      check('quit: driver port closed after client quit', closed.closed,
        { detail: closed.error, timeoutMs: portCloseTimeoutMs }, { source: 'artifact' })
      if (!closed.closed) throw new Error('driver port still answering after quit')
      const listResult = recordRcon(await rcon.list())
      check(`quit: server still does not list ${player}`, listResult.ok &&
        (parsePlayerList(listResult.output) || []).includes(player) === false,
        { output: listResult.output }, { source: 'server' })
    })

    // ------------------------------------------------------------------
    // 12. Relaunch (host-side, no reconnect op) and rejoin.
    // ------------------------------------------------------------------
    await step('rejoin: relaunch and reattach without a reconnect op', async () => {
      const joinStarted = now()
      try {
        await relaunch()
      } catch (error) {
        throw new Error(`relaunch adapter failed: ${error.message}`)
      }
      const settled = await waitSettled({ timeoutMs: rejoinTimeoutMs, label: 'rejoin' })
      metrics.rejoinSettleMs = now() - joinStarted
      check('rejoin: client settles into the world again', true,
        { status: settled.status, settleMs: metrics.rejoinSettleMs }, { source: 'client' })
      const join = await waitServerCondition({
        timeoutMs: 15000,
        poll: async () => {
          const listResult = recordRcon(await rcon.list())
          const players = listResult.ok ? parsePlayerList(listResult.output) : null
          return { ok: listResult.ok && players !== null, match: players !== null && players.includes(player), players, output: listResult.output }
        },
        describe: last => `server does not list ${player} after relaunch: ${(last.players || []).join(', ') || 'no list'} (${last.output || 'no output'})`,
      })
      check(`rejoin: RCON list contains ${player} after host-side relaunch (no driver reconnect op)`, true,
        { players: join.players }, { source: 'server' })
      const posResult = recordRcon(await rcon.getEntityPos(player))
      const rejoinPos = parseEntityPos(posResult.output)
      check('rejoin: player rejoined at the last known position (near the arena centre)',
        rejoinPos && positionsWithin(rejoinPos, plan.teleport, 12),
        { rejoin: rejoinPos, lastTeleport: plan.teleport, toleranceBlocks: 12 },
        { source: 'server' })
    })
  } catch {
    // The failing step already recorded the assertion; fall through to the
    // report below. The runner stops after a failing run unless --force.
  }

  const finishedAt = iso(now())
  const passed = failure === null && assertions.length > 0 && assertions.every(a => a.ok)
  return {
    gate: 'B', row: 'G0-host-readiness', lane: 'driver', clientLane: 'driver',
    run: runIndex, nonce,
    startedAt, finishedAt, durationMs: now() - started,
    passed, failure, phase,
    assertions,
    rconOps, driverOps, artifacts,
    metrics, limitations,
    pins: { ...DEFAULT_PINS, displayHost: clientHost, backendRow: 'M2 — Paper 26.1.2 direct (G0)' },
    plan: {
      runIndex: plan.runIndex,
      center: plan.center,
      teleport: plan.teleport,
      blockUnderPlayer: plan.blockUnderPlayer,
      edits: plan.edits,
      arena: { side: plan.arena.side, floorY: plan.arena.floorY, clearBox: plan.arena.clearBox },
      preflight: plan.preflight,
      safety: { minTargetDistanceBlocks: 3 },
    },
  }
}

// 'air' / 'stone' expected-state names used by the plan's preflight entries.
export function blockForState (state) {
  if (state === 'air') return 'minecraft:air'
  if (state === 'stone') return 'minecraft:stone'
  return state
}

function round (value) {
  return Math.round(value * 100) / 100
}

export { ARENA, runCenter }
export { DriverError }

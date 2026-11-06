#!/usr/bin/env node
// Gate B G0 runner — the repeatable driver-lane scenario controller.
//
//   node src/gate-b.js --runs 2          # two consecutive fresh runs, reports + summary
//   node src/gate-b.js --runs 1 --force  # keep going after a failing run
//   node src/gate-b.js --tunnel          # spawn/clean the SSH driver tunnel for you
//   node src/gate-b.js --lane unmodded   # write the manual witness checklist (exits 1)
//   node src/gate-b.js --verify-g0       # verify 2/2 reports + completed witness
//   node src/gate-b.js --help
//
// Writes testdata/gate-b-driver-run<N>-<timestamp>.json per run plus
// testdata/gate-b-driver-summary.json. Exit 0 only when every requested run
// passed (2/2 by default). After a failing run the runner stops unless
// --force. Nothing here claims 2/2 unless it actually ran.
//
// Secrets: RCON lives inside the pod (rcon-cli), the driver token comes from
// GATEB_DRIVER_TOKEN, and every report body is scanned with
// checks.redactSecrets before it is written.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriverClient, DriverError } from './gate-b/driver.js'
import { createRcon } from './gate-b/rcon.js'
import { runDriverLane } from './gate-b/scenario.js'
import { redactSecrets, verifyG0Evidence } from './gate-b/checks.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTDATA = path.join(root, 'testdata')

const HELP = `
Gate B G0 driver-lane runner

Usage:
  node src/gate-b.js [--runs N] [--force] [--lane driver|unmodded] [--tunnel]
                     [--host <user@display-host>] [--instance <prism instance>]
                     [--server <join address>] [--account <name>]
                     [--driver-host h] [--driver-port p]
                     [--rcon-namespace ns] [--rcon-deployment deploy]

Options:
  --runs N           Run the driver-lane scenario N consecutive times (default 2).
  --force            Keep running after a failed run instead of stopping.
  --lane <lane>      driver (default): automated G0 driver-lane runs.
                     unmodded: write a manual witness checklist; exits 1
                     until the operator completes the witness.
  --tunnel           Spawn 'ssh -N -L <driver-port>:127.0.0.1:25599 <host>'
                     for the driver socket and clean it up on exit. Unit tests
                     never need this; the default is an operator-managed tunnel.
  --verify-g0        Do not run anything: verify 2 consecutive PASSED driver
                     reports exist and the unmodded witness is completed;
                     exits 0 only when both hold.
  --host             Display host for relaunch/screenshot/tunnel
                     (default: bafbi@nath.tail41e568.ts.net).
  --instance         Prism instance to launch (default: gate-b-player-fabric).
  --server           Join address (default: monoplayer-gate-b-paper.tail41e568.ts.net:25565).
  --account          Account name (default: Bafbi).
  --driver-host h    Override GATEB_DRIVER_HOST (default 127.0.0.1).
  --driver-port p    Override GATEB_DRIVER_PORT (default 25599).
  -h, --help         This text.

Environment:
  GATEB_DRIVER_HOST / GATEB_DRIVER_PORT / GATEB_DRIVER_TOKEN — driver socket
  GATEB_RCON_NAMESPACE / GATEB_RCON_DEPLOYMENT — kubectl exec target (defaults:
                     monoplayer-gate-b / paper)
  GATEB_DISPLAY / GATEB_XDG_RUNTIME_DIR / GATEB_WAYLAND_DISPLAY — display-host
                     launch environment (defaults :0, /run/user/1000, wayland-1)

Evidence: testdata/gate-b-driver-run<N>-<timestamp>.json (per run),
testdata/gate-b-driver-summary.json, and the runbook at docs/gate-b-g0.md.
`

const DEFAULTS = {
  runs: 2,
  force: false,
  lane: 'driver',
  host: 'bafbi@nath.tail41e568.ts.net',
  instance: 'gate-b-player-fabric',
  server: 'monoplayer-gate-b-paper.tail41e568.ts.net:25565',
  account: 'Bafbi',
  rconNamespace: process.env.GATEB_RCON_NAMESPACE || 'monoplayer-gate-b',
  rconDeployment: process.env.GATEB_RCON_DEPLOYMENT || 'paper',
}

// Module-level tunnel handle so any exit path (success, error, unhandled)
// can kill the child; without this a crash keeps an idle node + ssh pair.
let tunnel = null
function cleanupTunnel () {
  if (tunnel) { try { tunnel.kill('SIGKILL') } catch {} ; tunnel = null }
}

function parseArgs (argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--runs': opts.runs = Number(argv[++i]); break
      case '--force': opts.force = true; break
      case '--lane': opts.lane = argv[++i]; break
      case '--tunnel': opts.tunnel = true; break
      case '--verify-g0': opts.verifyG0 = true; break
      case '--host': opts.host = argv[++i]; break
      case '--instance': opts.instance = argv[++i]; break
      case '--server': opts.server = argv[++i]; break
      case '--account': opts.account = argv[++i]; break
      case '--driver-host': opts.driverHost = argv[++i]; break
      case '--driver-port': opts.driverPort = Number(argv[++i]); break
      case '--rcon-namespace': opts.rconNamespace = argv[++i]; break
      case '--rcon-deployment': opts.rconDeployment = argv[++i]; break
      case '-h': case '--help': opts.help = true; break
      default: throw new Error(`unknown argument: ${arg} (see --help)`)
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    throw new Error(`--runs must be a positive integer (got ${opts.runs})`)
  }
  if (opts.lane !== 'driver' && opts.lane !== 'unmodded') {
    throw new Error(`--lane must be 'driver' or 'unmodded' (got ${opts.lane})`)
  }
  return opts
}

function writeJsonRedacted (data) {
  return redactSecrets(JSON.stringify(data, null, 2) + '\n')
}

function execCommand (command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '')
        error.stdout = String(stdout || '')
        reject(error)
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      }
    })
  })
}

// Host-side relaunch = SSH to the display host and start a fresh Prism
// instance (nohup, detached). The caller must have quit the previous client —
// council correction #1: no driver reconnect op, only quit + relaunch.
function createSshRelaunch ({ host, instance, server, account }) {
  return async () => {
    // Minecraft's GLFW still needs the XWayland display even on a Wayland
    // session. Without DISPLAY the client crashes during init and Prism opens
    // its error console, which is exactly the pop-up the gate must not create.
    const display = process.env.GATEB_DISPLAY || ':0'
    const runtime = process.env.GATEB_XDG_RUNTIME_DIR || '/run/user/1000'
    const wayland = process.env.GATEB_WAYLAND_DISPLAY || 'wayland-1'
    const remote =
      `DISPLAY=${display} XDG_RUNTIME_DIR=${runtime} WAYLAND_DISPLAY=${wayland} ` +
      `XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Hyprland ` +
      `setsid nohup prismlauncher -l ${instance} -s ${server} -a ${account} ` +
      `</dev/null >/dev/null 2>&1 &`
    try {
      const { stderr } = await execCommand('ssh', ['-o', 'BatchMode=yes', host, remote], 30000)
      return { detail: stderr ? `ssh: ${stderr}` : 'prismlauncher launched via ssh' }
    } catch (error) {
      throw new Error(`ssh relaunch failed: ${error.message} ${error.stderr}`)
    }
  }
}

// scp the on-host screenshot back into testdata/ and verify it is a PNG.
function createScpFetch ({ host }) {
  return async remotePath => {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const localPath = path.join(TESTDATA, `gate-b-screenshot-${stamp}-${path.basename(remotePath)}`)
    try {
      await execCommand('scp', ['-q', `${host}:${remotePath}`, localPath], 60000)
    } catch (error) {
      return { localPath: null, bytes: 0, format: null, error: `scp failed: ${error.message}` }
    }
    const bytes = (await stat(localPath)).size
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const buffer = await readFile(localPath)
    const isPng = bytes >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    return { localPath, bytes, format: isPng ? 'png' : null }
  }
}

const WITNESS_FILE = 'gate-b-unmodded-witness.json'

// The unmodded Prism witness cannot be automated by this lane; it is the
// anti-masking check (council correction: the driver is a mod and can mask
// vanilla bugs). Produce an honest checklist with manual placeholders.
async function writeUnmoddedChecklist ({ laneReportPath }) {
  const nowIso = new Date().toISOString()
  const checklist = {
    gate: 'B', row: 'B5-unmodded-witness (G0 manual lane)', lane: 'unmodded',
    clientLane: 'unmodded',
    generatedAt: nowIso,
    completed: false,
    status: 'NOT COMPLETE — exits nonzero until the operator records the manual run',
    how: [
      'Launch the UNMODDED Prism 26.1.2 instance (no gate-b-driver mod installed) where you normally play Minecraft.',
      'Join the G0 Paper backend directly (monoplayer-gate-b-paper.tail41e568.ts.net:25565).',
      'For each step below, do the action by hand, capture a grim screenshot, and record ok/pending.',
    ],
    steps: [
      { name: 'join: official unmodded client reaches the world in <= 120 s', state: 'pending', evidence: '[MANUAL: grim screenshot + notes]' },
      { name: 'render: chunks visible (not stuck on Loading terrain)', state: 'pending', evidence: '[MANUAL]' },
      { name: 'move: walk a few blocks; server-side position changed (RCON data get entity Pos)', state: 'pending', evidence: '[MANUAL: RCON output]' },
      { name: 'break: mine a block at an explicit coordinate; server-side air (execute if block)', state: 'pending', evidence: '[MANUAL: RCON output]' },
      { name: 'place: place a block on a support; server-side non-air', state: 'pending', evidence: '[MANUAL: RCON output]' },
      { name: 'screenshot: at least one artifact preserved alongside this checklist', state: 'pending', evidence: '[MANUAL: file path]' },
      { name: 'disconnect: leave the world; RCON list no longer shows the player', state: 'pending', evidence: '[MANUAL]' },
      { name: 'rejoin: relaunch the instance, reattach at the current position', state: 'pending', evidence: '[MANUAL]' },
    ],
    limitations: [
      'Manual lane: no driver. Evidence quality relies on coupled client observation + RCON checks, honestly labelled.',
      'When every step is recorded, copy this file to testdata/gate-b-unmodded-witness.json with completed: true.',
    ],
  }
  const { text } = writeJsonRedacted(checklist)
  await writeFile(laneReportPath, text)
  return checklist
}

async function verifyG0 () {
  const summaryPath = path.join(TESTDATA, 'gate-b-driver-summary.json')
  let summary = null
  try { summary = JSON.parse(await readFile(summaryPath, 'utf8')) } catch {}
  const reports = []
  if (summary && Array.isArray(summary.reports)) {
    for (const reportPath of summary.reports) {
      const absolute = path.isAbsolute(reportPath) ? reportPath : path.resolve(root, reportPath)
      try { reports.push(JSON.parse(await readFile(absolute, 'utf8'))) } catch {}
    }
  }
  const verdict = verifyG0Evidence(summary, reports)
  if (!verdict.ok) {
    console.error(`NOT 2/2: ${verdict.reason}`)
    console.error('Run: node src/gate-b.js --runs 2  (the scenario itself, not just the checks)')
    return 1
  }
  console.log(`driver reports: ${reports.length} from one 2-run invocation, both passed`)

  const witnessPath = path.join(TESTDATA, WITNESS_FILE)
  let witness = null
  try { witness = JSON.parse(await readFile(witnessPath, 'utf8')) } catch {}
  if (!witness || witness.completed !== true || witness.lane !== 'unmodded') {
    console.error('NOT COMPLETE: the unmodded witness file is missing or not marked completed.')
    console.error(`Expected ${TESTDATA}/${WITNESS_FILE} with lane '"unmodded"' and completed true.`)
    console.error('Generate a checklist first: node src/gate-b.js --lane unmodded')
    return 1
  }
  console.log('G0 VERIFIED: 2/2 consecutive driver-lane reports passed and the unmodded witness is completed.')
  return 0
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`gate-b: ${error.message}`)
    console.error('Try: node src/gate-b.js --help')
    process.exitCode = 1
    return
  }

  await mkdir(TESTDATA, { recursive: true })

  if (opts.help) {
    console.log(HELP)
    return
  }
  if (opts.verifyG0) {
    process.exitCode = await verifyG0()
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (opts.lane === 'unmodded') {
    const laneReportPath = path.join(TESTDATA, `gate-b-unmodded-checklist-${stamp}.json`)
    await writeUnmoddedChecklist({ laneReportPath })
    console.log(`unmodded witness checklist written: ${path.relative(root, laneReportPath)}`)
    console.log('Complete the manual steps there, then record the result as')
    console.log(`testdata/${WITNESS_FILE} (completed: true). Exiting 1 until the witness is done.`)
    process.exitCode = 1
    return
  }

  // Driver lane.
  const driver = createDriverClient({
    host: opts.driverHost || process.env.GATEB_DRIVER_HOST || '127.0.0.1',
    port: opts.driverPort || Number(process.env.GATEB_DRIVER_PORT || 25599),
    token: process.env.GATEB_DRIVER_TOKEN || '',
  })
  const rcon = createRcon({ namespace: opts.rconNamespace, deployment: opts.rconDeployment })
  const relaunch = createSshRelaunch({
    host: opts.host, instance: opts.instance, server: opts.server, account: opts.account,
  })
  const screenshotFetch = createScpFetch({ host: opts.host })

  process.on('SIGINT', () => { cleanupTunnel(); process.exit(130) })
  process.on('SIGTERM', () => { cleanupTunnel(); process.exit(143) })

  if (opts.tunnel) {
    const localPort = opts.driverPort || Number(process.env.GATEB_DRIVER_PORT || 25599)
    tunnel = spawn('ssh', ['-N', '-L', `${localPort}:127.0.0.1:25599`, opts.host], { stdio: 'ignore' })
    tunnel.on('error', error => { console.error(`tunnel spawn failed: ${error.message}`); tunnel = null })
  }

  const reports = []
  for (let runIndex = 1; runIndex <= opts.runs; runIndex++) {
    console.log(`\n=== Gate B G0 driver-lane run ${runIndex}/${opts.runs} ===`)
    const report = await runDriverLane({
      runIndex, driver, rcon, relaunch, screenshotFetch,
      player: opts.account,
    })
    const reportPath = path.join(TESTDATA, `gate-b-driver-run${runIndex}-${stamp}.json`)
    const { text, findings } = writeJsonRedacted(report)
    if (findings.length > 0) {
      console.error(`warning: ${findings.length} secret-shaped string(s) redacted from the run ${runIndex} report`)
    }
    await writeFile(reportPath, text)
    reports.push({ reportPath: path.relative(root, reportPath), ...report })

    const passed = report.assertions.filter(a => a.ok).length
    const total = report.assertions.length
    console.log(`\nrun ${runIndex}: ${report.passed ? 'PASS' : 'FAIL'}`)
    console.log(`  assertions: ${passed}/${total} passed`)
    console.log(`  rcon ops: ${JSON.stringify(report.metrics.rconOpCounts)}`)
    console.log(`  settle/rejoin: ${report.metrics.settleMs ?? 'n/a'} ms / ${report.metrics.rejoinSettleMs ?? 'n/a'} ms`)
    console.log(`  report: ${path.relative(root, reportPath)}`)
    if (report.failure) console.error(`  failure: ${report.failure}`)
    for (const artifact of report.artifacts) {
      console.log(`  artifact: ${path.relative(root, artifact.localPath)} (${artifact.bytes} bytes)`)
    }

    if (!report.passed && !opts.force) {
      console.error(`\nstopping after the failed run (use --force to continue)`)
      break
    }
  }

  const passedRuns = reports.filter(r => r.passed).length
  const summary = {
    gate: 'B', row: 'G0-host-readiness', lane: 'driver',
    generatedAt: new Date().toISOString(),
    runsRequested: opts.runs, runsExecuted: reports.length,
    runsPassed: passedRuns,
    allPassed: reports.length > 0 && passedRuns === reports.length && passedRuns === opts.runs,
    stopReason: reports.length < opts.runs ? 'stopped after a failed run (use --force to continue)' : null,
    reports: reports.map(r => r.reportPath),
  }
  const summaryPath = path.join(TESTDATA, 'gate-b-driver-summary.json')
  const { text, findings } = writeJsonRedacted(summary)
  if (findings.length > 0) {
    console.error(`warning: ${findings.length} secret-shaped string(s) redacted from the summary`)
  }
  await writeFile(summaryPath, text)

  console.log(`\nsummary: ${path.relative(root, summaryPath)}`)
  console.log(`${passedRuns}/${summary.runsExecuted} run(s) passed (requested ${summary.runsRequested})`)

  const ok = passedRuns === opts.runs && reports.length === opts.runs
  if (!ok) console.error(`gate-b driver lane: ${passedRuns}/${opts.runs} runs passed — G0 is NOT satisfied`)
  cleanupTunnel()
  process.exitCode = ok ? 0 : 1
  // Always terminate for real (including the spawned tunnel child).
  process.exit(process.exitCode)
}

main().catch(error => {
  cleanupTunnel()
  if (error instanceof DriverError) {
    console.error(`gate-b driver error: ${error.message}`)
  } else {
    console.error(`gate-b fatal: ${error.stack || error.message || error}`)
  }
  process.exit(1)
})

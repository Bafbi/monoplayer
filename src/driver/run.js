#!/usr/bin/env node
// Driver-lane G0 runner — the repeatable scenario controller.
//
//   node src/driver/run.js --runs 2          # two consecutive fresh runs, reports + summary
//   node src/driver/run.js --runs 1 --force  # keep going after a failing run
//   node src/driver/run.js --tunnel          # spawn/clean the SSH driver tunnel for you
//   node src/driver/run.js --lane unmodded   # write the manual witness checklist (exits 1)
//   node src/driver/run.js --verify-g0       # verify a fresh 2/2 + the completed witness
//   node src/driver/run.js --help
//
// Writes testdata/driver-run<N>-<timestamp>.json per run plus
// testdata/driver-summary.json. Exit 0 only when every requested run
// passed (2/2 by default). After a failing run the runner stops unless
// --force. Nothing here claims 2/2 unless it actually ran.
//
// Secrets: RCON lives inside the pod (rcon-cli), the driver token comes from
// GATEB_DRIVER_TOKEN, and every report body is scanned with
// observability/secrets.redactSecrets before it is written.
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriverClient, DriverError } from './client-driver.js'
import { formatParityReport, parseParityEndpoint, runParity } from './parity.js'
import { formatSkinReport, runSkinLane, SKIN_CASES } from './skin.js'
import { paperAddress, resolveGateLane } from './lane.js'
import { createRcon } from './rcon.js'
import { DEFAULT_PINS, runDriverLane } from './scenario.js'
import { verifyG0Evidence, versionRefusal } from './checks.js'
import { redactSecrets } from '../observability/secrets.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TESTDATA = path.join(root, 'testdata')
const MOD_METADATA = path.join(root, 'tools', 'driver', 'src', 'main', 'resources', 'fabric.mod.json')

const HELP = `
Driver lane: the G0 scenario, the unmodded witness checklist, and the client
parity lane (#62).

Usage:
  node src/driver/run.js [--runs N] [--force] [--lane driver|unmodded|parity] [--tunnel]
                     [--host <user@display-host>] [--instance <prism instance>]
                     [--server <join address>] [--account <name>]
                     [--direct <host:port>] [--proxied <host:port>] [--report <path>]
                     [--driver-host h] [--driver-port p]
                     [--rcon-namespace ns] [--rcon-deployment deploy]

Options:
  --runs N           Run the driver-lane scenario N consecutive times (default 2).
  --force            Keep running after a failed run instead of stopping.
  --lane <lane>      driver (default): automated G0 driver-lane runs.
                     unmodded: write a manual witness checklist; exits 1
                     until the operator completes the witness.
                     parity: join the backend directly, then the same backend
                     through the proxy, and compare the two clients' state
                     (#62). One command, two runs, no RCON.
                     skin: run the skin cases on the client joined through the
                     proxy (#99): control, signed, unsigned, one fresh client
                     each, with the texture the client resolved and a
                     third-person screenshot per case.
  --direct HOST:PORT The backend the first parity run joins, as the client
                     reaches it (default 127.0.0.1:25565, the dev-lane tunnel).
  --proxied HOST:PORT The proxy front the second parity run joins, as the client
                     reaches it (default 127.0.0.1:25566). Both parity endpoints
                     are refused when they name the live Excalia fleet, the live
                     deployment in front of it, or a playit.gg tunnel to it.
  --report PATH      Where the parity or skin report goes
                     (default .reports/driver-parity-report.json, or
                     .reports/skin-report.json for --lane skin).
  --case NAME        The skin case to run: control, signed, unsigned, or all
                     (default all). --lane skin only.
  --verbose          Log every lane event to stderr.
  --tunnel           Spawn 'ssh -N -L <driver-port>:127.0.0.1:25599 <host>'
                     for the driver socket and clean it up on exit. Unit tests
                     never need this; the default is an operator-managed tunnel.
  --verify-g0        Do not run anything: verify this checkout holds two
                     consecutive PASSED driver reports and a completed unmodded
                     witness; exits 0 only when both hold.
  --max-age-hours N  Reject driver evidence whose newest run finished more than
                     N hours ago, so a copied report set cannot pass (default 24).
  --host             Display host for relaunch/screenshot/tunnel
                     (default: bafbi@nath.tail41e568.ts.net).
  --instance         Prism instance to launch (default: gate-b-player-262-fabric).
  --server           Join address (default: the Paper of this worktree's gate lane,
                     monoplayer-gate-<instance>-paper.tail41e568.ts.net:25565).
  --account          Account name (default: Bafbi).
  --driver-host h    Override GATEB_DRIVER_HOST (default 127.0.0.1).
  --driver-port p    Override GATEB_DRIVER_PORT (default 25599).
  -h, --help         This text.

Environment:
  GATEB_DRIVER_HOST / GATEB_DRIVER_PORT / GATEB_DRIVER_TOKEN — driver socket
  GATEB_RCON_NAMESPACE / GATEB_RCON_DEPLOYMENT — kubectl exec target (defaults:
                     this worktree's gate lane / paper). The lane comes from
                     scripts/gate-lane.sh name, so MONOPLAYER_GATE_NAMESPACE names
                     one by hand. Naming this and not --server is refused: one run
                     names one lane (#282)
  GATEB_DISPLAY / GATEB_XDG_RUNTIME_DIR / GATEB_WAYLAND_DISPLAY — display-host
                     launch environment (defaults :0, /run/user/1000, wayland-1)

Evidence: testdata/driver-run<N>-<timestamp>.json (per run),
testdata/driver-summary.json, and the runbook at docs/driver-lane.md.
`

const DEFAULTS = {
  runs: 2,
  force: false,
  lane: 'driver',
  host: 'bafbi@nath.tail41e568.ts.net',
  // The Fabric instance built from the 26.2 vanilla instance. The older
  // gate-b-player-fabric pair stays on disk as the 26.1.2 record (#71).
  instance: 'gate-b-player-262-fabric',
  // Empty means the lane this worktree derives: main fills both from
  // src/driver/lane.js, so the address a client joins and the RCON target a run
  // administers are one name and cannot disagree (#282).
  server: '',
  account: 'Bafbi',
  rconNamespace: process.env.GATEB_RCON_NAMESPACE || '',
  rconDeployment: process.env.GATEB_RCON_DEPLOYMENT || 'paper',
  maxAgeHours: 24,
  // The dev lane as the display host reaches it: two loopback ports the operator
  // forwards (docs/driver-lane.md, "Reaching the dev lane"). They are not cluster
  // addresses on purpose; the client runs on the display host, not in the cluster.
  direct: '127.0.0.1:25565',
  proxied: '127.0.0.1:25566',
  parityReport: '.reports/driver-parity-report.json',
  skinReport: '.reports/skin-report.json',
  skinCase: 'all',
}

// Module-level tunnel handle so any exit path (success, error, unhandled)
// can kill the child; without this a crash keeps an idle node + ssh pair.
let tunnel = null
function cleanupTunnel () {
  if (tunnel) { try { tunnel.kill('SIGKILL') } catch {} ; tunnel = null }
}

function installSignalHandlers () {
  process.on('SIGINT', () => { cleanupTunnel(); process.exit(130) })
  process.on('SIGTERM', () => { cleanupTunnel(); process.exit(143) })
}

// --tunnel spawns the driver socket forward and cleans it up on exit. Both lanes
// need it, and unit tests never do: the default is an operator-managed tunnel.
function startTunnel (opts) {
  if (!opts.tunnel) return null
  const localPort = opts.driverPort || Number(process.env.GATEB_DRIVER_PORT || 25599)
  tunnel = spawn('ssh', ['-N', '-L', `${localPort}:127.0.0.1:25599`, opts.host], { stdio: 'ignore' })
  tunnel.on('error', error => { console.error(`tunnel spawn failed: ${error.message}`); tunnel = null })
  return tunnel
}

function createDriverFromOptions (opts) {
  return createDriverClient({
    host: opts.driverHost || process.env.GATEB_DRIVER_HOST || '127.0.0.1',
    port: opts.driverPort || Number(process.env.GATEB_DRIVER_PORT || 25599),
    token: process.env.GATEB_DRIVER_TOKEN || '',
  })
}

// The Minecraft version the driver source declares. It reads the resource file
// rather than the installed jar: a jar older than the source is caught by the
// lane refusing to settle on the wrong client, and this refusal is the cheap case.
function driverMinecraftVersion () {
  try {
    return JSON.parse(readFileSync(MOD_METADATA, 'utf8'))?.depends?.minecraft ?? null
  } catch {
    return null
  }
}

// #62's lane: the real client joins the backend directly, then the same client
// joins the same backend through the proxy, and the report separates the state
// differences the proxy explains from the ones it does not. One command, two
// runs, no RCON: the driver state is the evidence on both sides.
async function runParityLane (opts) {
  let direct
  let proxied
  try {
    direct = parseParityEndpoint(opts.direct, '--direct')
    proxied = parseParityEndpoint(opts.proxied, '--proxied')
  } catch (error) {
    console.error('driver parity: ' + String(error?.message ?? error))
    return 2
  }

  installSignalHandlers()
  startTunnel(opts)

  const driver = createDriverFromOptions(opts)
  const relaunch = createSshRelaunch({
    host: opts.host, instance: opts.instance, server: direct.endpoint, account: opts.account,
  })
  const verbose = Boolean(opts.verbose)
  const log = verbose ? (event, fields = {}) => console.error('[driver-parity] ' + event + ' ' + JSON.stringify(fields)) : () => {}

  const report = await runParity({
    driver, relaunch, direct, proxied,
    version: driverMinecraftVersion(),
    log
  })
  console.log(formatParityReport(report))
  console.log('driver parity: ' + (report.sides.direct.endpoint) + ' direct, ' + report.sides.proxied.endpoint + ' proxied')

  try {
    await mkdir(path.dirname(path.resolve(root, opts.parityReport)), { recursive: true })
    const { text, findings } = writeJsonRedacted(report)
    if (findings.length > 0) {
      console.error(`warning: ${findings.length} secret-shaped string(s) redacted from the parity report`)
    }
    await writeFile(path.resolve(root, opts.parityReport), text)
    console.log('driver parity: report written to ' + opts.parityReport)
  } catch (error) {
    console.error('driver parity: could not write ' + opts.parityReport + ': ' + String(error?.message ?? error))
    return 2
  }

  cleanupTunnel()
  if (report.passed) return 0
  return report.setupFailed ? 2 : 1
}

// #99's lane: what the client resolves for the body it controls, with no
// injection, with the puppet's signed property, and with that property unsigned.
// The client joins the proxy (--proxied), because the puppet's property is what
// the client sees only through a backend session.
async function runSkinLaneCli (opts) {
  let proxied
  try {
    proxied = parseParityEndpoint(opts.proxied, '--proxied')
  } catch (error) {
    console.error('driver skin: ' + String(error?.message ?? error))
    return 2
  }

  installSignalHandlers()
  startTunnel(opts)

  const driver = createDriverFromOptions(opts)
  const relaunch = createSshRelaunch({
    host: opts.host, instance: opts.instance, server: proxied.endpoint, account: opts.account,
  })
  const screenshotFetch = createScpFetch({ host: opts.host })
  const verbose = Boolean(opts.verbose)
  const log = verbose ? (event, fields = {}) => console.error('[driver-skin] ' + event + ' ' + JSON.stringify(fields)) : () => {}

  let report
  try {
    report = await runSkinLane({
      driver, relaunch, screenshotFetch,
      endpoint: proxied.endpoint,
      cases: opts.skinCase === 'all' ? SKIN_CASES : [opts.skinCase],
      version: driverMinecraftVersion(),
      log
    })
  } catch (error) {
    console.error('driver skin: ' + (error instanceof DriverError ? error.message : String(error?.stack ?? error)))
    cleanupTunnel()
    return 2
  }
  console.log(formatSkinReport(report))

  try {
    await mkdir(path.dirname(path.resolve(root, opts.skinReport)), { recursive: true })
    const { text, findings } = writeJsonRedacted(report)
    if (findings.length > 0) {
      console.error(`warning: ${findings.length} secret-shaped string(s) redacted from the skin report`)
    }
    await writeFile(path.resolve(root, opts.skinReport), text)
    console.log('driver skin: report written to ' + opts.skinReport)
  } catch (error) {
    console.error('driver skin: could not write ' + opts.skinReport + ': ' + String(error?.message ?? error))
    cleanupTunnel()
    return 2
  }

  cleanupTunnel()
  return report.passed ? 0 : 1
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
      case '--verbose': opts.verbose = true; break
      case '--verify-g0': opts.verifyG0 = true; break
      case '--max-age-hours': opts.maxAgeHours = Number(argv[++i]); break
      case '--host': opts.host = argv[++i]; break
      case '--instance': opts.instance = argv[++i]; break
      case '--server': opts.server = argv[++i]; break
      case '--account': opts.account = argv[++i]; break
      case '--driver-host': opts.driverHost = argv[++i]; break
      case '--direct': opts.direct = argv[++i]; break
      case '--proxied': opts.proxied = argv[++i]; break
      case '--report': opts.parityReport = argv[++i]; opts.skinReport = argv[i]; break
      case '--case': opts.skinCase = argv[++i]; break
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
  if (!['driver', 'unmodded', 'parity', 'skin'].includes(opts.lane)) {
    throw new Error(`--lane must be 'driver', 'unmodded', 'parity', or 'skin' (got ${opts.lane})`)
  }
  if (![...SKIN_CASES, 'all'].includes(opts.skinCase)) {
    throw new Error(`--case must be control, signed, unsigned, or all (got ${opts.skinCase})`)
  }
  if (!(opts.maxAgeHours > 0)) {
    throw new Error(`--max-age-hours must be a positive number (got ${opts.maxAgeHours})`)
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
  return async (endpoint = server) => {
    // Minecraft's GLFW still needs the XWayland display even on a Wayland
    // session. Without DISPLAY the client crashes during init and Prism opens
    // its error console, which is exactly the pop-up the gate must not create.
    const display = process.env.GATEB_DISPLAY || ':0'
    const runtime = process.env.GATEB_XDG_RUNTIME_DIR || '/run/user/1000'
    const wayland = process.env.GATEB_WAYLAND_DISPLAY || 'wayland-1'
    const remote =
      `DISPLAY=${display} XDG_RUNTIME_DIR=${runtime} WAYLAND_DISPLAY=${wayland} ` +
      `XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Hyprland ` +
      `setsid nohup prismlauncher -l ${instance} -s ${endpoint} -a ${account} ` +
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
    const localPath = path.join(TESTDATA, `screenshot-${stamp}-${path.basename(remotePath)}`)
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

const WITNESS_FILE = 'driver-unmodded-witness.json'

// The unmodded Prism witness cannot be automated by this lane; it is the
// anti-masking check (council correction: the driver is a mod and can mask
// vanilla bugs). Produce an honest checklist with manual placeholders.
async function writeUnmoddedChecklist ({ laneReportPath, server }) {
  const nowIso = new Date().toISOString()
  const checklist = {
    gate: 'B', row: 'B5-unmodded-witness (G0 manual lane)', lane: 'unmodded',
    clientLane: 'unmodded',
    generatedAt: nowIso,
    completed: false,
    status: 'NOT COMPLETE — exits nonzero until the operator records the manual run',
    how: [
      'Launch the UNMODDED Prism 26.2 instance (no monoplayer-driver mod installed) where you normally play Minecraft.',
      'Join the G0 Paper backend directly (' + server + ').',
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
      'When every step is recorded, copy this file to testdata/driver-unmodded-witness.json with completed: true.',
    ],
  }
  const { text } = writeJsonRedacted(checklist)
  await writeFile(laneReportPath, text)
  return checklist
}

async function verifyG0 (opts) {
  const summaryPath = path.join(TESTDATA, 'driver-summary.json')
  let summary = null
  try { summary = JSON.parse(await readFile(summaryPath, 'utf8')) } catch {}
  const reports = []
  if (summary && Array.isArray(summary.reports)) {
    for (const reportPath of summary.reports) {
      const absolute = path.isAbsolute(reportPath) ? reportPath : path.resolve(root, reportPath)
      try { reports.push(JSON.parse(await readFile(absolute, 'utf8'))) } catch {}
    }
  }
  const verdict = verifyG0Evidence(summary, reports, { maxAgeMs: opts.maxAgeHours * 60 * 60 * 1000 })
  if (!verdict.ok) {
    console.error(`NOT 2/2: ${verdict.reason}`)
    console.error('Run: mise run driver:scenario  (two fresh runs), then this check again')
    return 1
  }
  console.log(`driver reports: ${reports.length} from one 2-run invocation, both passed`)

  const witnessPath = path.join(TESTDATA, WITNESS_FILE)
  let witness = null
  try { witness = JSON.parse(await readFile(witnessPath, 'utf8')) } catch {}
  if (!witness || witness.completed !== true || witness.lane !== 'unmodded') {
    console.error('NOT COMPLETE: the unmodded witness file is missing or not marked completed.')
    console.error(`Expected ${TESTDATA}/${WITNESS_FILE} with lane '"unmodded"' and completed true.`)
    console.error('Generate a checklist first: node src/driver/run.js --lane unmodded')
    return 1
  }
  console.log('G0 VERIFIED: 2/2 consecutive driver-lane reports passed and the unmodded witness is completed.')
  return 0
}

// --- the one lane this run names (#282) --------------------------------------
//
// src/driver/lane.js asks scripts/gate-lane.sh name, which derives this worktree's
// lane or honours MONOPLAYER_GATE_NAMESPACE. The RCON target and the address the
// client joins are filled from the one value, so a renamed lane's run cannot
// administer the lane that shipped while it joins its own.
//
// --server and --rcon-namespace stay the caller's override, not a second lane: a run
// handed both goes where it was told, which is what #301 kept for --backend-host. A
// run handed only the RCON namespace, and whose join address would be this lane's,
// names two lanes, so it stops here instead.

// The two targets, or the sentence that stops the run. Pure, and given the lane, so
// a test can name one without a checkout.
export function laneTargets (opts, lane) {
  if (opts.rconNamespace !== '' && opts.server === '' && opts.rconNamespace !== lane) {
    return {
      refused: `GATEB_RCON_NAMESPACE names "${opts.rconNamespace}" and this worktree's lane is "${lane}". One run names one lane: pass --server too if the client should join the other one`,
    }
  }
  return { server: opts.server || paperAddress(lane), rconNamespace: opts.rconNamespace || lane }
}

// Fill the run's two targets from the lane, or report why it cannot. A lane that
// cannot be named stops the run before anything reaches a client or a Deployment.
function applyLaneToOptions (opts) {
  let lane
  try {
    lane = resolveGateLane()
  } catch (error) {
    console.error('driver: ' + String(error?.message ?? error))
    process.exitCode = 2
    return false
  }
  const targets = laneTargets(opts, lane)
  if (targets.refused) {
    console.error('driver: ' + targets.refused)
    process.exitCode = 2
    return false
  }
  opts.server = targets.server
  opts.rconNamespace = targets.rconNamespace
  return true
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`driver: ${error.message}`)
    console.error('Try: node src/driver/run.js --help')
    process.exitCode = 1
    return
  }

  await mkdir(TESTDATA, { recursive: true })

  if (opts.help) {
    console.log(HELP)
    return
  }
  if (opts.verifyG0) {
    process.exitCode = await verifyG0(opts)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (opts.lane === 'unmodded') {
    // The checklist sends a reader to this worktree's Paper, so it names the lane too.
    if (!applyLaneToOptions(opts)) return
    const laneReportPath = path.join(TESTDATA, `driver-unmodded-checklist-${stamp}.json`)
    await writeUnmoddedChecklist({ laneReportPath, server: opts.server })
    console.log(`unmodded witness checklist written: ${path.relative(root, laneReportPath)}`)
    console.log('Complete the manual steps there, then record the result as')
    console.log(`testdata/${WITNESS_FILE} (completed: true). Exiting 1 until the witness is done.`)
    process.exitCode = 1
    return
  }

  if (opts.lane === 'parity') {
    process.exitCode = await runParityLane(opts)
    return
  }

  if (opts.lane === 'skin') {
    process.exitCode = await runSkinLaneCli(opts)
    return
  }

  // The lane is named before the address is validated, because the address's own
  // default is this lane's Paper.
  if (!applyLaneToOptions(opts)) return

  // The live fleet and the live deployment in front of it are refused for the
  // G0 join too, not only for the parity lanes.
  try {
    parseParityEndpoint(opts.server, '--server')
  } catch (error) {
    console.error('driver: ' + String(error?.message ?? error))
    process.exitCode = 2
    return
  }

  // The driver jar speaks one Minecraft version and the G0 target serves
  // another, so the run would spend two client launches to reach an
  // "Incompatible client" screen. Refuse before the first one.
  const refusal = versionRefusal({
    driverVersion: driverMinecraftVersion(), targetVersion: DEFAULT_PINS.minecraftVersion,
  })
  if (refusal !== null) {
    console.error('driver: ' + refusal)
    process.exitCode = 2
    return
  }

  // Driver lane.
  const driver = createDriverFromOptions(opts)
  const rcon = createRcon({ namespace: opts.rconNamespace, deployment: opts.rconDeployment })
  const relaunch = createSshRelaunch({
    host: opts.host, instance: opts.instance, server: opts.server, account: opts.account,
  })
  const screenshotFetch = createScpFetch({ host: opts.host })

  installSignalHandlers()
  startTunnel(opts)

  const reports = []
  for (let runIndex = 1; runIndex <= opts.runs; runIndex++) {
    console.log(`\n=== Driver-lane G0 run ${runIndex}/${opts.runs} ===`)
    const report = await runDriverLane({
      runIndex, driver, rcon, relaunch, screenshotFetch,
      player: opts.account,
    })
    const reportPath = path.join(TESTDATA, `driver-run${runIndex}-${stamp}.json`)
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
  const summaryPath = path.join(TESTDATA, 'driver-summary.json')
  const { text, findings } = writeJsonRedacted(summary)
  if (findings.length > 0) {
    console.error(`warning: ${findings.length} secret-shaped string(s) redacted from the summary`)
  }
  await writeFile(summaryPath, text)

  console.log(`\nsummary: ${path.relative(root, summaryPath)}`)
  console.log(`${passedRuns}/${summary.runsExecuted} run(s) passed (requested ${summary.runsRequested})`)

  const ok = passedRuns === opts.runs && reports.length === opts.runs
  if (!ok) console.error(`driver lane: ${passedRuns}/${opts.runs} runs passed — G0 is NOT satisfied`)
  cleanupTunnel()
  process.exitCode = ok ? 0 : 1
  // Always terminate for real (including the spawned tunnel child).
  process.exit(process.exitCode)
}

// Only when this file is the program. A test imports laneTargets above, and an
// import that launched a client would be the last thing a test wanted.
const invoked = process.argv[1] === undefined
  ? null
  : realpathSync(process.argv[1])
if (invoked !== null && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    cleanupTunnel()
    if (error instanceof DriverError) {
      console.error(`driver error: ${error.message}`)
    } else {
      console.error(`driver fatal: ${error.stack || error.message || error}`)
    }
    process.exit(1)
  })
}

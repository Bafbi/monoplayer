// The controlled transfer testbed orchestrator.
//
//   node src/testbed/switch.js up        apply the testbed, join the puppet to
//                                        paper-hub, leave it running
//   node src/testbed/switch.js transfer  RCON: transfer the puppet to paper-sky
//   node src/testbed/switch.js down      stop the testbed, restore the live app,
//                                        then delete its front Service
//   node src/testbed/switch.js run       up + transfer + down, always restoring
//   node src/testbed/switch.js status    what is running now
//
// The live Monoplayer and the testbed cannot run together: they share the
// GlowSquidye custody PVC and the token has one writer. `up` disables Argo's
// automated sync for the live Application, scales the live deployment to
// zero, then starts the testbed. `down` (and the finally of `run`) restores
// the deployment and the sync policy.
//
// Paper runs in monoplayer-gate-b. The testbed Monoplayer runs in the
// monoplayer namespace on the custody PVC and exposes
// monoplayer-testbed.tail41e568.ts.net:25565.
//
// The published front is the testbed's front Service, not its deployment: a
// deployment scaled to zero leaves that Service published with no endpoints and
// its tailnet device registered. So `down` deletes it, and `up` recreates it
// from deploy/testbed, whose tailscale.com/hostname annotation brings the same
// name back. `up` also records the digest it ran, because the manifest pulls the
// moving :main tag: without it two runs cannot be compared.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LIVE_NS = 'monoplayer'
const LIVE_DEPLOY = 'monoplayer'
const TEST_NS = 'monoplayer'
const TEST_DEPLOY = 'monoplayer-testbed'
const PAPER_NS = 'monoplayer-gate-b'
const PAPER_HUB = 'paper-hub'
const PAPER_SKY = 'paper-sky'
const ARGO_APP = 'monoplayer'
const ARGO_NS = 'argocd'
const FRONT_HOST = 'monoplayer-testbed.tail41e568.ts.net'
const SKY_HOST = 'paper-sky.monoplayer-gate-b.svc.cluster.local'
const TAILSCALE_NS = 'tailscale'
// The operator runs one proxy pod per Service, names it after that Service, and
// labels it with the Service it came from. That label is how `status` finds the
// pod, and one pod is one registered tailnet device.
const TAILNET_PROXY_LABEL = `tailscale.com/parent-resource=${TEST_DEPLOY}`
// The recovery record: what `up` removed, for `down` to put back. It is the
// only way the Argo policy comes back (AGENTS.md), so a test points it at its
// own file instead of overwriting a live run's record.
const STATE_FILE = process.env.MONOPLAYER_TESTBED_STATE || '/tmp/opencode/monoplayer-testbed.json'
// `down` clears the record once it has restored what it owes, so a run's digest
// would go with it. One line per `up` here is what makes two finished runs
// comparable. MONOPLAYER_TESTBED_DIGESTS moves it, so a test never writes the
// operator's file.
const DIGESTS_FILE = process.env.MONOPLAYER_TESTBED_DIGESTS || '.reports/testbed-digests.jsonl'

// How long the two port-forwards get before the registry probe reads them. A
// test answers the probe from a shim and sets this to 0, so the unit rung does
// not pay a settle it cannot use. An empty or nonsense value is the default, not
// an immediate probe: `Number('')` is 0, and a real run's probe needs the wait.
const SETTLE_MS = Number(process.env.MONOPLAYER_TESTBED_REGISTRY_SETTLE_MS ?? 5000)
const REGISTRY_SETTLE_MS = Number.isFinite(SETTLE_MS) && SETTLE_MS >= 0 ? SETTLE_MS : 5000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function kubectl (args, { allowFail = false } = {}) {
  try {
    return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (allowFail) return null
    const stderr = error.stderr?.toString().trim() ?? ''
    throw new Error(`kubectl ${args.join(' ')} failed: ${stderr || error.message}`)
  }
}

function log (message, fields = undefined) {
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  process.stdout.write(`[testbed] ${message}${suffix}\n`)
}

async function waitFor (label, fn, { timeoutMs = 180_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  const detail = last ? ` (last error: ${last.message})` : ''
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${detail}`)
}

function scale (namespace, deploy, replicas) {
  kubectl(['-n', namespace, 'scale', `deploy/${deploy}`, `--replicas=${replicas}`])
  log(`scale ${namespace}/${deploy} -> ${replicas}`)
}

function readJSON (args) {
  const raw = kubectl(args, { allowFail: true })
  return raw === null ? null : JSON.parse(raw)
}

function deployment (namespace, deploy) {
  return readJSON(['-n', namespace, 'get', 'deploy', deploy, '-o', 'json'])
}

async function waitDeployReady (namespace, deploy, timeoutMs = 240_000) {
  return waitFor(`${namespace}/${deploy} ready`, () => {
    const d = deployment(namespace, deploy)
    if (!d) return null
    const ready = d.status?.readyReplicas ?? 0
    const spec = d.spec?.replicas ?? 0
    return ready >= 1 && ready === spec ? d : null
  }, { timeoutMs, intervalMs: 3000 })
}

async function waitDeployGone (namespace, deploy, timeoutMs = 180_000) {
  return waitFor(`${namespace}/${deploy} pods gone`, () => {
    const pods = JSON.parse(kubectl(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${deploy}`, '-o', 'json']))
    return pods.items.length === 0 ? true : null
  }, { timeoutMs, intervalMs: 3000 })
}

function pods (namespace, deploy) {
  return JSON.parse(kubectl(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${deploy}`, '-o', 'json'])).items
}

// The digest the deployment actually ran. Its status carries no imageID, but its
// pod does, and the manifest's :main tag makes the tag name useless for a
// comparison between runs. Index 0 is the monoplayer container. The two init
// containers only wait for the custody file and clear a stale lock, so this is
// the image that decides what the run executed.
//
// A pod that is still terminating belongs to the last run and can be listed
// first, so the pod that is not going away is the one to read.
function testbedImage () {
  const statuses = pods(TEST_NS, TEST_DEPLOY)
    .filter(entry => !entry.metadata?.deletionTimestamp)
    .map(entry => entry.status?.containerStatuses?.[0])
  const imageID = statuses.find(status => status?.imageID)?.imageID ?? null
  if (!imageID) throw new Error(`${TEST_NS}/${TEST_DEPLOY} reports no containerStatuses[0].imageID, so this run cannot name the build it ran`)
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(imageID)?.[1] ?? null
  if (!digest) throw new Error(`${TEST_NS}/${TEST_DEPLOY} reports an imageID without a digest: ${imageID}`)
  return { imageID, digest }
}

function recordDigest (image) {
  fs.mkdirSync(path.dirname(DIGESTS_FILE), { recursive: true })
  fs.appendFileSync(DIGESTS_FILE, JSON.stringify({ at: new Date().toISOString(), ...image }) + '\n')
}

// A Service that is gone answers with an empty list. A read that failed answers
// with nothing. `status` is how the operator proves the front is gone, so the
// two must not look alike: null is unreadable, false is gone.
function frontService () {
  const list = readJSON(['-n', TEST_NS, 'get', 'svc', '-l', `app.kubernetes.io/name=${TEST_DEPLOY}`, '-o', 'json'])
  return list === null ? null : list.items?.[0] ?? false
}

function frontLine (svc) {
  if (svc === null) return { unreadable: true }
  if (svc === false) return { missing: true }
  return { hostname: frontHostname(svc) ?? '(pending)' }
}

function frontHostname (svc) {
  return svc?.status?.loadBalancer?.ingress?.[0]?.hostname ?? null
}

function proxyPods () {
  return readJSON(['-n', TAILSCALE_NS, 'get', 'pods', '-l', TAILNET_PROXY_LABEL, '-o', 'json'])?.items ?? null
}

function podLogs (namespace, deploy, tail = 400) {
  return kubectl(['-n', namespace, 'logs', `deploy/${deploy}`, `--tail=${tail}`], { allowFail: true }) ?? ''
}

async function waitLog (namespace, deploy, pattern, timeoutMs = 120_000) {
  return waitFor(`${namespace}/${deploy} log ${pattern}`, () => {
    const text = podLogs(namespace, deploy)
    return text.split('\n').some(line => line.includes(pattern)) ? text : null
  }, { timeoutMs, intervalMs: 3000 })
}

function rcon (namespace, deploy, command) {
  return kubectl(['-n', namespace, 'exec', `deploy/${deploy}`, '--', 'rcon-cli', ...command.split(' ')])
}

async function waitRcon (namespace, deploy, timeoutMs = 240_000) {
  return waitFor(`${namespace}/${deploy} RCON`, () => {
    try { return rcon(namespace, deploy, 'list') } catch { return null }
  }, { timeoutMs, intervalMs: 3000 })
}

// The sync policy, read as the object it is and kept as JSON: `jsonpath`
// prints a map as `map[prune:true selfHeal:true]`, which cannot be patched back
// into the Application when `down` restores it.
function appAutomated () {
  const raw = kubectl(['-n', ARGO_NS, 'get', 'app', ARGO_APP, '-o', 'json'], { allowFail: true })
  if (!raw) return null
  let automated
  try { automated = JSON.parse(raw).spec?.syncPolicy?.automated } catch { return null }
  return automated ? JSON.stringify(automated) : null
}

function disableAutoSync () {
  const automated = appAutomated()
  if (automated === null) {
    log('Argo auto-sync already disabled')
    return { automated: null, disabledByUs: false }
  }
  kubectl([
    '-n', ARGO_NS, 'patch', 'app', ARGO_APP, '--type=json',
    '-p', '[{"op":"remove","path":"/spec/syncPolicy/automated"}]'
  ])
  log('Argo auto-sync disabled for the live app')
  return { automated, disabledByUs: true }
}

function restoreAutoSync (saved) {
  if (!saved?.disabledByUs || !saved.automated) return
  kubectl([
    '-n', ARGO_NS, 'patch', 'app', ARGO_APP, '--type=merge',
    '-p', `{"spec":{"syncPolicy":{"automated":${saved.automated}}}}`
  ])
  log('Argo auto-sync restored')
}

function writeState (state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state) + '\n')
}

// A second `up` before a `down` must not forget the policy the first one
// removed. `disableAutoSync` reports `disabledByUs: false` when Argo already has
// no `automated` block, and that record restores nothing, so it must not
// replace one that does. What this `up` removed wins: that is what is missing
// now, and `down` puts back what is missing, not what was.
function savePolicyState (state) {
  const previous = readState()
  const kept = state.disabledByUs && state.automated ? state : previous ?? state
  if (kept === previous) log('kept the Argo record an earlier up wrote', { automated: previous.automated })
  writeState(kept)
}

function readState () {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

// `up` records the Argo policy first and the digest later, so a write must merge
// into what is already there: `down` restores the policy from this file. It goes
// straight to the file, not through savePolicyState: that keep rule belongs to
// the policy, and it would drop a digest recorded beside a policy there is none of.
function mergeState (patch) {
  writeState({ ...(readState() ?? {}), ...patch })
}

function clearState () {
  try { fs.unlinkSync(STATE_FILE) } catch { /* no state */ }
}

function liveScale () {
  const d = deployment(LIVE_NS, LIVE_DEPLOY)
  return d?.spec?.replicas ?? null
}

function probeRegistry (host, intent, port) {
  const out = execFileSync('node', ['src/testbed/registry.js', host, String(intent), String(port)], {
    encoding: 'utf8',
    timeout: 90_000
  })
  const line = out.split('\n').find(entry => entry.startsWith('REGISTRIES '))
  if (!line) throw new Error(`no registry line from ${host}:${port}`)
  return JSON.parse(line.slice('REGISTRIES '.length))
}

// The target's registry must differ from the hub's, or the seamless switch
// would be a respawn with identical registries and prove nothing.
async function registry () {
  const skyPf = spawn('kubectl', ['-n', PAPER_NS, 'port-forward', 'svc/paper-sky', '25765:25565'], { stdio: 'ignore' })
  const hubPf = spawn('kubectl', ['-n', PAPER_NS, 'port-forward', 'svc/paper-hub', '25766:25565'], { stdio: 'ignore' })
  try {
    await sleep(REGISTRY_SETTLE_MS)
    const sky = probeRegistry('127.0.0.1', 3, 25765)
    const hub = probeRegistry('127.0.0.1', 2, 25766)
    const pick = list => list.find(entry => entry.id === 'minecraft:dimension_type') ?? null
    const skyDim = pick(sky)
    const hubDim = pick(hub)
    const same = skyDim?.hash === hubDim?.hash
    log('registry diff', { hub: hubDim, sky: skyDim, same })
    if (same) throw new Error('the target dimension_type matches the hub; the testbed is not exercising a registry swap')
    return { hub: hubDim, sky: skyDim }
  } finally {
    skyPf.kill('SIGTERM')
    hubPf.kill('SIGTERM')
  }
}

async function up () {
  log(`live front ${FRONT_HOST}`, { liveReplicas: liveScale() })
  // Disable Argo self-heal before scaling the live deployment; otherwise it
  // scales back to one and fights the testbed for the RWO custody PVC.
  savePolicyState(disableAutoSync())
  scale(LIVE_NS, LIVE_DEPLOY, 0)
  await waitDeployGone(LIVE_NS, LIVE_DEPLOY)

  kubectl(['apply', '-k', 'deploy/testbed'])
  log('testbed manifests applied')

  await waitDeployReady(PAPER_NS, PAPER_HUB)
  await waitDeployReady(PAPER_NS, PAPER_SKY)
  const hubList = await waitRcon(PAPER_NS, PAPER_HUB)
  const skyList = await waitRcon(PAPER_NS, PAPER_SKY)
  log('paper ready', { hub: hubList.replace(/\n/g, ' | '), sky: skyList.replace(/\n/g, ' | ') })
  const packs = rcon(PAPER_NS, PAPER_SKY, 'datapack list')
  log('sky datapacks', { packs: packs.replace(/\n/g, ' | ') })
  await registry()

  scale(TEST_NS, TEST_DEPLOY, 1)
  await waitDeployReady(TEST_NS, TEST_DEPLOY)
  await waitLog(TEST_NS, TEST_DEPLOY, '"event":"liveReady"', 180_000)
  const hello = podLogs(TEST_NS, TEST_DEPLOY).split('\n').filter(line => line.includes('"event":"startLive"')).at(-1)
  log('testbed Monoplayer ready', { startLive: hello })

  // Record the build this run executed. The manifest pulls :main, so the digest
  // is the only thing a later run can be compared against.
  const image = testbedImage()
  mergeState(image)
  recordDigest(image)
  log('testbed image', { ...image, recorded: DIGESTS_FILE })

  const svc = frontService()
  log('testbed front', { hostname: svc ? frontHostname(svc) ?? '(pending)' : '(pending)', port: 25565 })
  log(`attach the client to ${FRONT_HOST}:25565, then run: node src/testbed/switch.js transfer`)
}

async function transfer () {
  const before = await rcon(PAPER_NS, PAPER_HUB, 'list')
  if (!before.includes('GlowSquidye')) {
    throw new Error(`the puppet is not on the hub: ${before.replace(/\n/g, ' | ')}`)
  }
  log('hub before', { list: before.replace(/\n/g, ' | ') })

  const out = rcon(PAPER_NS, PAPER_HUB, `transfer ${SKY_HOST} 25565 GlowSquidye`)
  log('transfer issued', { result: out.replace(/\n/g, ' | ') })

  // Core log records are nested inside `{"event":"core","line":"..."}`, so
  // their quotes are escaped. Match the event name, not the JSON fragment.
  await waitLog(TEST_NS, TEST_DEPLOY, 'transferFollow', 60_000)
  const follow = podLogs(TEST_NS, TEST_DEPLOY).split('\n').filter(line => line.includes('transferFollow')).at(-1)
  log('follow decided', { follow })

  await waitLog(TEST_NS, TEST_DEPLOY, '"event":"backendReconnect"', 120_000)
  const reconnect = podLogs(TEST_NS, TEST_DEPLOY).split('\n').filter(line => line.includes('"event":"backendReconnect"')).at(-1)
  log('follow connected', { reconnect })

  await waitFor('puppet listed on paper-sky', () => {
    const list = rcon(PAPER_NS, PAPER_SKY, 'list')
    return list.includes('GlowSquidye') ? list : null
  }, { timeoutMs: 60_000 })
  const sky = await rcon(PAPER_NS, PAPER_SKY, 'list')
  const hub = await rcon(PAPER_NS, PAPER_HUB, 'list')
  if (hub.includes('GlowSquidye')) {
    throw new Error(`the puppet is still on the hub: ${hub.replace(/\n/g, ' | ')}`)
  }
  log('transfer verified', { hub: hub.replace(/\n/g, ' | '), sky: sky.replace(/\n/g, ' | ') })

  const heartbeat = podLogs(TEST_NS, TEST_DEPLOY).split('\n')
    .filter(line => line.includes('"event":"heartbeat"')).at(-1)
  log('testbed heartbeat', { heartbeat })
}

// Deleting the front Service is what unpublishes the front. The tailnet device
// and its proxy pod belong to that Service, so they go with it. The next
// `apply -k` recreates it from the manifest's tailscale.com/hostname annotation.
// A failed delete is logged and reported as a failed command, never thrown. The
// live deployment is already back by then, and `status` shows what is left.
function removeFront () {
  try {
    const result = kubectl(['-n', TEST_NS, 'delete', 'svc', TEST_DEPLOY, '--ignore-not-found', '--timeout=120s'])
    log(`delete svc ${TEST_NS}/${TEST_DEPLOY}`, { result: result.replace(/\n/g, ' | ') })
    return true
  } catch (error) {
    log(`delete svc ${TEST_NS}/${TEST_DEPLOY} failed`, { error: error.message })
    return false
  }
}

async function down () {
  const saved = readState()
  // Any step here can fail: a scale, the ready wait, the policy patch. The front
  // Service has to go either way, or the leak this change closes survives the
  // failure path.
  let frontRemoved = true
  let restored = false
  try {
    scale(TEST_NS, TEST_DEPLOY, 0)
    await waitDeployGone(TEST_NS, TEST_DEPLOY)
    scale(PAPER_NS, PAPER_HUB, 0)
    scale(PAPER_NS, PAPER_SKY, 0)
    scale(LIVE_NS, LIVE_DEPLOY, 1)
    await waitDeployReady(LIVE_NS, LIVE_DEPLOY)
    restoreAutoSync(saved)
    restored = true
  } finally {
    frontRemoved = removeFront()
    // The record is spent once the policy is back. A restore that failed has not
    // spent it, and the next `down` still needs it.
    if (restored) clearState()
  }
  log('live deployment restored')
  // The live lane is back either way, but a front Service that is still published
  // is the defect this change exists to fix, so the command reports a failure.
  if (!frontRemoved) {
    log('the testbed front is still published')
    process.exitCode = 1
  }
}

async function status () {
  for (const [ns, deploy] of [[LIVE_NS, LIVE_DEPLOY], [TEST_NS, TEST_DEPLOY], [PAPER_NS, PAPER_HUB], [PAPER_NS, PAPER_SKY]]) {
    const d = deployment(ns, deploy)
    log(`${ns}/${deploy}`, d ? { replicas: d.spec?.replicas ?? null, ready: d.status?.readyReplicas ?? 0 } : { missing: true })
  }
  log('argo automated', { automated: appAutomated() })
  log(`front ${TEST_NS}/${TEST_DEPLOY}`, frontLine(frontService()))
  const proxies = proxyPods()
  log('tailnet devices', proxies === null
    ? { unreadable: true }
    : { count: proxies.length, names: proxies.map(pod => pod.metadata?.name) })
  log('run state', readState() ?? { missing: true })
}

async function run () {
  let failure = null
  try {
    await up()
    await transfer()
  } catch (error) {
    failure = error
    log(`FAILED: ${error.message}`)
  } finally {
    try {
      await down()
    } catch (error) {
      log(`RESTORE FAILED: ${error.message}`)
      failure = failure ?? error
    }
  }
  if (failure) process.exitCode = 1
}

const command = process.argv[2] ?? 'status'
try {
  if (command === 'up') await up()
  else if (command === 'transfer') await transfer()
  else if (command === 'down') await down()
  else if (command === 'run') await run()
  else if (command === 'registry') await registry()
  else if (command === 'status') await status()
  else {
    process.stderr.write('usage: node src/testbed/switch.js up|transfer|down|run|registry|status\n')
    process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(`[testbed] ${error.message}\n`)
  process.exitCode = 1
}

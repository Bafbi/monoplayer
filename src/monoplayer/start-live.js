// --start orchestration: bring the live B1 legs up with the simplest path.
//
//   node src/monoplayer.js --start [--config file.json]
//
// Config priority: --config JSON < env overlay < defaults
//
//   MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind
//   MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
//   MONOPLAYER_PUPPET_USERNAME                          puppet profile name (cache key stays the custody account)
//   MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
//   MONOPLAYER_PUPPET_CACHE_DIR / MONOPLAYER_PUPPET_CACHE_ACCOUNT
//   MONOPLAYER_VERSION                                  protocol pin (default 26.1)
//   MONOPLAYER_LOG                                      JSONL log file (default: stdout)
//
// Sequence (simplicity rules; one client, one backend leg, direct Paper):
//   1. resolve config (JSON + env), load the attach whitelist (UUIDs only)
//   2. build the core with the live legs, core.start()
//   3. backend leg connect (Microsoft auth through the G1 token custody; the
//      writer lock is taken by the leg, so auth CLI refreshes refuse meanwhile)
//   4. readiness: wait until the core cache has the backend configuration
//      frames AND the join prefix — the warm marker (chunk_batch_finished)
//      or a bounded grace window
//   5. front leg listen, readiness log (no secrets), process stays alive
import fs from 'node:fs'

import { createMonoplayer, loadConfig } from '../monoplayer.js'
import { redact } from './redact.js'
import { createWhitelistStore } from '../auth/store.js'
import { createLiveBackendLeg } from './live-backend.js'
import { createLiveFrontLeg } from './live-front.js'
import { cacheStatsLine } from './live-readiness.js'

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (argv, name) => argv.includes(name)

function envOverlay (doc, env = process.env) {
  const out = { ...doc }
  const front = { ...doc.front }
  if (env.MONOPLAYER_FRONT_HOST) front.host = env.MONOPLAYER_FRONT_HOST
  if (env.MONOPLAYER_FRONT_PORT) front.port = Number(env.MONOPLAYER_FRONT_PORT)
  if (Object.keys(front).length) out.front = front
  const backend = { ...doc.backend }
  if (env.MONOPLAYER_BACKEND_HOST) backend.host = env.MONOPLAYER_BACKEND_HOST
  if (env.MONOPLAYER_BACKEND_PORT) backend.port = Number(env.MONOPLAYER_BACKEND_PORT)
  out.backend = backend
  const puppet = { ...doc.puppet }
  if (env.MONOPLAYER_PUPPET_USERNAME) puppet.username = env.MONOPLAYER_PUPPET_USERNAME
  if (env.MONOPLAYER_PUPPET_CACHE_DIR) puppet.cacheDir = env.MONOPLAYER_PUPPET_CACHE_DIR
  if (env.MONOPLAYER_PUPPET_CACHE_ACCOUNT) puppet.cacheAccount = env.MONOPLAYER_PUPPET_CACHE_ACCOUNT
  out.puppet = puppet
  if (env.MONOPLAYER_ATTACH_WHITELIST) out.attachWhitelistFile = env.MONOPLAYER_ATTACH_WHITELIST
  if (env.MONOPLAYER_VERSION) out.version = env.MONOPLAYER_VERSION
  return out
}

export async function startLive ({ argv = [], io = process } = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  // Guardrail: --start opens sockets and touches token custody — it must be
  // an explicit act. Refuse a purely-default invocation (no backend host and
  // no config document) so `main(['--start'])` stays inert.
  const explicitBackend = process.env.MONOPLAYER_BACKEND_HOST ||
    flag(argv, '--config') ||
    process.env.MONOPLAYER_CONFIG
  if (!explicitBackend) {
    stderr.write(
      'monoplayer --start: refusing the default config. Set MONOPLAYER_BACKEND_HOST ' +
      '(and friends) or pass a --config JSON file describing the live legs. ' +
      'See docs/gate-b-b1.md.\n'
    )
    return 2
  }

  // --- 1. config ---
  let doc = {}
  const docPath = flag(argv, '--config')
  if (docPath) {
    doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  }
  const cfg = loadConfig(envOverlay(doc))
  if (!Array.isArray(cfg.attachWhitelist) || cfg.attachWhitelist.length === 0) {
    const store = createWhitelistStore({ file: cfg.attachWhitelistFile })
    cfg.attachWhitelist = store.list().map(player => player.uuid)
  }
  if (cfg.attachWhitelist.length === 0) {
    stderr.write(`monoplayer --start: attach whitelist empty at ${cfg.attachWhitelistFile}\n`)
    return 2
  }

  // --- logging sink (JSONL; every line redacted) ---
  let sink = stdout
  if (process.env.MONOPLAYER_LOG) {
    sink = fs.createWriteStream(process.env.MONOPLAYER_LOG, { flags: 'a' })
  }
  const log = (event, fields = {}) => {
    try {
      sink.write(redact(JSON.stringify({ t: new Date().toISOString(), event, ...fields })) + '\n')
    } catch { /* never let logging kill the legs */ }
  }

  // Attach-time raw byte dump (diagnostic; off by default).
  let dumpRaw = null
  if (process.env.MONOPLAYER_DEBUG_REPLAY) {
    const dumpFile = process.env.MONOPLAYER_DEBUG_REPLAY
    const fd = fs.openSync(dumpFile, 'w')
    let index = 0
    dumpRaw = ({ kind, buffer }) => {
      try {
        fs.writeSync(fd, JSON.stringify({ i: index++, kind, b64: buffer.toString('base64') }) + '\n')
      } catch { /* diagnostic sink is best effort */ }
    }
    log('debugReplayDump', { file: dumpFile })
  }
  // Exact wire-frame dump (config + play, pre-encryption): the client-facing
  // truth for decode-desync forensics (off by default).
  let dumpWire = null
  if (process.env.MONOPLAYER_DEBUG_WIRE) {
    const wireFile = process.env.MONOPLAYER_DEBUG_WIRE
    const fd = fs.openSync(wireFile, 'w')
    let index = 0
    dumpWire = buffer => {
      try {
        fs.writeSync(fd, JSON.stringify({ i: index++, b64: buffer.toString('base64') }) + '\n')
      } catch { /* diagnostic sink is best effort */ }
    }
    log('debugWireDump', { file: wireFile })
  }

  // --- 2. legs + core ---
  const backend = createLiveBackendLeg({
    host: cfg.backend.host,
    port: cfg.backend.port,
    version: cfg.version,
    cacheDir: cfg.puppet.cacheDir,
    cacheAccount: cfg.puppet.cacheAccount,
    log
  })
  const front = createLiveFrontLeg({
    host: cfg.front.host,
    port: cfg.front.port,
    version: cfg.version,
    attachWhitelistFile: cfg.attachWhitelistFile,
    getSnapshotConfig: () => core.cache.snapshot().config,
    log,
    dumpRaw,
    dumpWire
  })
  let core = null // assigned before any configured usage below

  core = createMonoplayer({
    config: cfg,
    backendLeg: backend,
    frontLeg: front,
    logStream: { write: line => log('core', { line }) }
  })

  front.setCoreAttach(({ name, uuid }) =>
    core.attachPlayer({ name, uuid, includeConfig: false })
  )
  core.start()

  log('startLive', {
    version: cfg.version,
    front: `${cfg.front.host}:${cfg.front.port}`,
    backend: `${cfg.backend.host}:${cfg.backend.port}`,
    puppet: cfg.puppet.username,
    attachWhitelist: cfg.attachWhitelistFile,
    whitelistCount: cfg.attachWhitelist.length
  })

  // --- 3. backend connect ---
  const connectTimeoutMs = 240_000
  try {
    await withTimeout(backend.connect(), connectTimeoutMs, 'backend_leg_connect')
  } catch (error) {
    log('startLiveFailed', { stage: 'backend_connect', error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }

  // --- 4. readiness: cached config + join prefix (warm preferred) ---
  const readiness = await waitReady({ core, log, maxWarmMs: 20_000 })
  if (!readiness.hasConfig || !readiness.hasPrefix) {
    log('startLiveFailed', { stage: 'cache_readiness', ...readiness })
    return 1
  }
  // Warm fallback for unbatched backends: after the grace window the marker
  // never arrived, so the join prefix is declared pinned at its current edge
  // (counted, logged; the marker path stays untouched for backends that do
  // batch). Attach readiness without this would never clear and the growing
  // prefix would eventually evict the login frame.
  if (!readiness.warm) {
    const forced = core.cache.forceWarm()
    core.session.warmComplete({ marker: forced.forced ? 'warm_fallback_join_settled' : 'chunk_batch_finished' })
    log('warmFallback', { forced: forced.forced, prefixFrames: readiness.prefixFrames, configFrames: readiness.configFrames })
  }
  log('readiness', readiness)

  // --- 5. front listen + readiness log ---
  try {
    front.listen()
  } catch (error) {
    log('startLiveFailed', { stage: 'front_listen', error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }
  log('liveReady', {
    front: `${cfg.front.host}:${cfg.front.port}`,
    backendConnected: !backend.ended,
    configFrames: readiness.configFrames,
    prefixFrames: readiness.prefixFrames,
    warm: readiness.warm
  })

  await runForever({ core, backend, front, log, sink })
  return 0
}

function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

async function waitReady ({ core, log, maxWarmMs = 60_000, maxTotalMs = 240_000 }) {
  const startedAt = Date.now()
  let warmMs = null
  for (;;) {
    const stats = core.cache.stats()
    const hasConfig = stats.sizes.config > 0
    const hasPrefix = stats.sizes.prefix > 0
    const elapsed = Date.now() - startedAt
    if (stats.warm && warmMs === null) {
      warmMs = elapsed
      log('warmComplete', { afterMs: warmMs, ...stats.sizes })
    }
    log('cacheStats', cacheStatsLine(stats, elapsed))
    const readyEnough = hasConfig && hasPrefix && ((warmMs !== null) || elapsed >= maxWarmMs)
    if (readyEnough || elapsed >= maxTotalMs) {
      return {
        hasConfig,
        hasPrefix,
        warm: warmMs !== null,
        warmMs,
        elapsedMs: elapsed,
        configFrames: stats.sizes.config,
        prefixFrames: stats.sizes.prefix
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function runForever ({ core, backend, front, log, sink }) {
  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    log('shutdown', { signal })
    try { await core.stop({ reason: `signal:${signal}` }) } catch { /* ignore */ }
    front.close()
    backend.close()
    sink.end?.()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.off(signal, stop)
    process.on(signal, () => { void stop(signal) })
  }
  const heartbeat = setInterval(() => {
    const stats = core.cache.stats()
    const forwarder = backend.forwarderStats()
    log('heartbeat', {
      attached: core.attached,
      backendLogins: core.session.backendLogins,
      warm: stats.warm,
      metrics: { ...core.metrics },
      backendFrames: forwarder ? { ...forwarder.counters, names: forwarder.names } : null
    })
  }, 30_000)
  heartbeat.unref?.()
  // The process stays up: the backend leg's end handler routes through the core.
  return new Promise(() => { /* outlive the event loop on purpose */ })
}

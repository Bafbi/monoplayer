// --start orchestration: bring the live B1 legs up with the simplest path.
//
//   node src/monoplayer.js --start [--config file.json]
//
// Config priority: --config JSON < env overlay < defaults
//
//   MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind
//   MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
//   MONOPLAYER_PUPPET_ACCOUNT                           selector: uuid, alias, or name
//   MONOPLAYER_PUPPET_ACCOUNTS_DIR                      account tree (default .secrets/accounts)
//   MONOPLAYER_PUPPET_UUID                              assertion: resolved uuid must match
//   MONOPLAYER_PUPPET_USERNAME                          assertion: resolved name must match
//   MONOPLAYER_PUPPET_CACHE_DIR                         raw custody dir override (deprecated)
//   MONOPLAYER_PUPPET_CACHE_ACCOUNT                     legacy selector (deprecated; ignored)
//   MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
//   MONOPLAYER_VERSION                                  protocol pin (default 26.1)
//   MONOPLAYER_LOG                                      JSONL log file (default: stdout)
//
// Sequence (simplicity rules; one client, one backend leg, direct Paper):
//   1. resolve config (JSON + env), resolve the puppet account, load the
//      attach whitelist (UUIDs only)
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
import { resolveAccount } from '../auth/accounts.js'
import { normalizeUuid } from '../auth/util.js'
import { createLiveBackendLeg } from './live-backend.js'
import { createLiveFrontLeg } from './live-front.js'
import { waitForReady } from './live-readiness.js'
import { createWireChecker } from './wire-check.js'

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (argv, name) => argv.includes(name)

export function envOverlay (doc, env = process.env, warn = () => {}) {
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
  if (env.MONOPLAYER_PUPPET_ACCOUNT) puppet.account = env.MONOPLAYER_PUPPET_ACCOUNT
  if (env.MONOPLAYER_PUPPET_ACCOUNTS_DIR) puppet.accountsDir = env.MONOPLAYER_PUPPET_ACCOUNTS_DIR
  if (env.MONOPLAYER_PUPPET_UUID) puppet.uuid = env.MONOPLAYER_PUPPET_UUID
  if (env.MONOPLAYER_PUPPET_USERNAME) puppet.username = env.MONOPLAYER_PUPPET_USERNAME
  if (env.MONOPLAYER_PUPPET_CACHE_DIR) puppet.cacheDir = env.MONOPLAYER_PUPPET_CACHE_DIR
  if (env.MONOPLAYER_PUPPET_CACHE_ACCOUNT) {
    warn('MONOPLAYER_PUPPET_CACHE_ACCOUNT is deprecated and ignored; use MONOPLAYER_PUPPET_ACCOUNT')
  }
  out.puppet = puppet
  if (env.MONOPLAYER_ATTACH_WHITELIST) out.attachWhitelistFile = env.MONOPLAYER_ATTACH_WHITELIST
  if (env.MONOPLAYER_VERSION) out.version = env.MONOPLAYER_VERSION
  return out
}

function candidateLines (candidates = []) {
  if (candidates.length === 0) return '  candidates: (none)'
  return candidates
    .map(candidate =>
      `  uuid=${candidate.uuid} name=${candidate.name ?? '?'} alias=${candidate.alias ?? '-'} dir=${candidate.dir}`)
    .join('\n')
}

function accountHint () {
  return [
    '  bootstrap a new account: node src/auth/cli.js device-code',
    '  migrate the single-account layout: node src/auth/cli.js migrate --apply',
    '  list accounts: node src/auth/cli.js accounts'
  ].join('\n')
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
  const cfg = loadConfig(envOverlay(
    doc,
    process.env,
    message => stderr.write(`monoplayer --start: warning: ${message}\n`)
  ))

  // --- 1b. puppet account (before any leg exists) ---
  // Raw cacheDir override: use the directory as given. It cannot be combined
  // with an account selector, because the selector would have nothing to
  // resolve against.
  let resolved = null
  if (cfg.puppet.cacheDir) {
    if (cfg.puppet.account) {
      stderr.write(
        'monoplayer --start: config_conflict: puppet.cacheDir (raw dir override) ' +
        'cannot be combined with puppet.account\n')
      return 2
    }
  } else {
    resolved = resolveAccount({
      accountsDir: cfg.puppet.accountsDir,
      selector: cfg.puppet.account ?? cfg.puppet.uuid
    })
    if (!resolved.ok) {
      stderr.write(
        `monoplayer --start: cannot resolve a puppet account in ${cfg.puppet.accountsDir}: ${resolved.reason}\n` +
        `${candidateLines(resolved.candidates)}\n${accountHint()}\n`)
      return 2
    }
    const account = resolved.account
    if (cfg.puppet.uuid) {
      const asserted = normalizeUuid(cfg.puppet.uuid)
      if (asserted === null || asserted !== account.uuid) {
        stderr.write(
          `monoplayer --start: puppet_uuid_mismatch: config asserts ${cfg.puppet.uuid}, ` +
          `resolved account is ${account.uuid}\n`)
        return 2
      }
    }
    if (cfg.puppet.username) {
      const profileName = account.profile?.name ?? null
      if (typeof profileName !== 'string' ||
          profileName.toLowerCase() !== String(cfg.puppet.username).toLowerCase()) {
        stderr.write(
          `monoplayer --start: puppet_name_mismatch: config asserts ${cfg.puppet.username}, ` +
          `resolved profile name is ${profileName ?? '(none)'}\n`)
        return 2
      }
    }
    cfg.puppet.uuid = account.uuid
    cfg.puppet.username = account.profile?.name ?? cfg.puppet.username ?? null
  }

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
  // Framed-byte dump (config + play): the client.framer output is framed and
  // possibly compressed, not plaintext. This is the client-facing truth for
  // decode-desync forensics (off by default).
  let dumpFramed = null
  if (process.env.MONOPLAYER_DEBUG_FRAMED) {
    const framedFile = process.env.MONOPLAYER_DEBUG_FRAMED
    const fd = fs.openSync(framedFile, 'w')
    let index = 0
    dumpFramed = buffer => {
      try {
        fs.writeSync(fd, JSON.stringify({ i: index++, b64: buffer.toString('base64') }) + '\n')
      } catch { /* diagnostic sink is best effort */ }
    }
    log('debugFramedDump', { file: framedFile })
  }

  // --- 2. legs + core ---
  const backend = resolved
    ? createLiveBackendLeg({
        host: cfg.backend.host,
        port: cfg.backend.port,
        version: cfg.version,
        accountDir: resolved.account.dir,
        account: resolved.account.alias ?? resolved.account.name ?? resolved.account.uuid,
        uuid: resolved.account.uuid,
        authTitle: resolved.account.profile?.authTitle ?? null,
        deviceType: resolved.account.profile?.deviceType ?? null,
        log
      })
    : createLiveBackendLeg({
        host: cfg.backend.host,
        port: cfg.backend.port,
        version: cfg.version,
        cacheDir: cfg.puppet.cacheDir,
        cacheAccount: cfg.puppet.cacheAccount,
        log
      })
  // Strict frame check on every client-facing raw replay/relay. The live path
  // runs it in warn mode first: a checker bug must not kick a real player, but
  // every failure is logged and counted in front.wireStats.
  const wire = createWireChecker({ version: cfg.version })
  const front = createLiveFrontLeg({
    host: cfg.front.host,
    port: cfg.front.port,
    version: cfg.version,
    attachWhitelistFile: cfg.attachWhitelistFile,
    getSnapshotConfig: () => core.cache.snapshot().config,
    wireCheck: payload => wire.check(payload),
    wireMode: 'warn',
    log,
    dumpRaw,
    dumpFramed
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

  // Every failure after this point owns a live backend client and (online) the
  // token-custody writer lock. Release both before returning, or the process
  // hangs with the lock held.
  async function stopAfterFailure (stage, fields = {}) {
    log('startLiveFailed', { stage, ...fields })
    try { await core.stop({ reason: `startup_failed:${stage}` }) } catch { /* best effort */ }
    try { await front.close() } catch { /* best effort */ }
    try { await backend.close() } catch { /* best effort */ }
    if (sink !== stdout) sink.end?.()
  }

  const accountLogFields = resolved
    ? {
        accountUuid: resolved.account.uuid,
        accountName: resolved.account.profile?.name ?? null,
        accountAlias: resolved.account.alias ?? null,
        accountDir: resolved.account.dir
      }
    : {
        accountUuid: cfg.puppet.uuid,
        accountName: cfg.puppet.username,
        accountAlias: null,
        accountDir: cfg.puppet.cacheDir
      }
  log('startLive', {
    version: cfg.version,
    front: `${cfg.front.host}:${cfg.front.port}`,
    backend: `${cfg.backend.host}:${cfg.backend.port}`,
    ...accountLogFields,
    attachWhitelist: cfg.attachWhitelistFile,
    whitelistCount: cfg.attachWhitelist.length
  })

  // --- 3. backend connect ---
  const connectTimeoutMs = 240_000
  try {
    await withTimeout(backend.connect(), connectTimeoutMs, 'backend_leg_connect')
  } catch (error) {
    await stopAfterFailure('backend_connect', { error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }

  // --- 4. readiness: cached config + join prefix (warm preferred) ---
  const readiness = await waitForReady({ core, log, maxWarmMs: 20_000 })
  if (!readiness.hasConfig || !readiness.hasPrefix) {
    await stopAfterFailure('cache_readiness', readiness)
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
  let bound = null
  try {
    bound = await front.listen()
  } catch (error) {
    await stopAfterFailure('front_listen', { error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }
  log('liveReady', {
    front: `${bound.host}:${bound.port}`,
    ...accountLogFields,
    backendConnected: !backend.ended,
    configFrames: readiness.configFrames,
    prefixFrames: readiness.prefixFrames,
    warm: readiness.warm,
    wire: front.wireStats
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
      wire: front.wireStats,
      backendFrames: forwarder ? { ...forwarder.counters, names: forwarder.names } : null
    })
  }, 30_000)
  heartbeat.unref?.()
  // The process stays up: the backend leg's end handler routes through the core.
  return new Promise(() => { /* outlive the event loop on purpose */ })
}

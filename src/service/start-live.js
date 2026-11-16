// --start orchestration: bring the live B1 legs up with the simplest path.
//
//   node src/service/monoplayer.js --start [--config file.json]
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
//   MONOPLAYER_PREAUTH_MAX_CONNECTIONS                  total concurrent
//                                                       connections in the pre-auth
//                                                       window (default 16, #201)
//   MONOPLAYER_PREAUTH_DEADLINE_MS                      how long one connection may
//                                                       stay in that window before
//                                                       its socket is destroyed
//                                                       (default 30000, #205)
//   MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
//   MONOPLAYER_VERSION                                  protocol pin (default 26.1)
//   MONOPLAYER_CHAT                                     read-only (default),
//                                                       commands, full, or off
//   MONOPLAYER_TRANSFER_KEEP_CONNECTION                 1 keeps the client's
//                                                       connection through a
//                                                       transfer (#22); off by default
//   MONOPLAYER_LOG                                      JSONL log file (default: stdout)
//   OTEL_EXPORTER_OTLP_ENDPOINT                         OTLP/HTTP collector base URL
//   OTEL_SERVICE_NAME / OTEL_SERVICE_VERSION            telemetry service identity
//   MONOPLAYER_JOURNAL_DIR                              exact packet journal directory
//   MONOPLAYER_JOURNAL_MAX_BYTES                        journal rotation size (default 256 MiB)
//   MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES                  journal directory budget, pruned on
//                                                       start and on rotate (default 256 MiB)
//   MONOPLAYER_JOURNAL_MAX_AGE_MS                       journal age cap; 0 keeps the byte
//                                                       budget alone (default 7 days)
//   MONOPLAYER_RECONNECT_ATTEMPTS                       backend reconnect attempts
//                                                       (0 = unlimited; unset keeps the
//                                                       config file's value, else unlimited)
//   MONOPLAYER_RECONNECT_MAX_DELAY_MS                   backoff cap (default 60000)
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

import { createMonoplayer, loadConfig } from './monoplayer.js'
import { candidateLines, flag, withTimeout } from './cli.js'
import { redact } from '../observability/redact.js'
import { createWhitelistStore } from '../custody/store.js'
import { resolveAccount } from '../custody/accounts.js'
import { normalizeUuid } from '../custody/util.js'
import { createLiveBackendLeg } from '../legs/live-backend.js'
import { createLiveFrontLeg } from '../legs/live-front.js'
import { shouldForceWarm, waitForReady } from './readiness.js'
import { createWireChecker } from '../core/wire-check.js'
import { createTelemetry } from '../observability/telemetry.js'
import { createJournal } from '../observability/journal.js'
import { createTransferFollowController } from '../core/transfer-follow.js'
import { MAX_DEADLINE_MS, PREAUTH_REFUSAL } from '../core/preauth-window.js'

// #134: the skin frame names the puppet's own `player_info` entry, so a lane that
// cannot name the puppet's UUID writes no frame. The raw cacheDir override
// resolves no account and reaches this with no UUID unless the operator supplied
// one.
// #96: the fields of the journal_volume_full report, or null when the journal
// opened. A journal volume with no room is the journal's own failure, and it is
// named with its path here instead of letting the first unrelated write on that
// volume fail with ENOSPC under another stage. Apart from startLive so the
// report is observable without a live backend.
export function journalVolumeFull ({ disabledReason = null, dir = null, freeBytes = null, requiredBytes = null } = {}) {
  if (disabledReason !== 'journal_volume_full') return null
  return { reason: 'journal_volume_full', dir, freeBytes, requiredBytes }
}

export function unidentifiedSkinWarning ({ skin, puppet } = {}) {
  if (skin?.showPuppetSkin !== true) return null
  if ((puppet?.uuid ?? null) !== null) return null
  return 'skin.showPuppetSkin is on and no puppet UUID is known, so no skin frame is written ' +
    'and the human keeps a default skin. Prefer selecting the account with ' +
    'MONOPLAYER_PUPPET_ACCOUNT, which resolves the UUID. On the raw cacheDir override there is ' +
    'no account to check against, and MONOPLAYER_PUPPET_UUID is taken as given.'
}

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
  if (env.MONOPLAYER_DIALOG_ACTION) out.dialogAction = env.MONOPLAYER_DIALOG_ACTION
  if (env.MONOPLAYER_VERSION) out.version = env.MONOPLAYER_VERSION
  if (env.MONOPLAYER_CHAT) out.chat = env.MONOPLAYER_CHAT
  // The kept connection (#22) is on in the defaults; this switch lets a lane
  // turn it off without moving that default. Only "1" and "0" are read, so a
  // typo cannot silently change what a deployed lane does with a transfer.
  const keepRaw = env.MONOPLAYER_TRANSFER_KEEP_CONNECTION
  if (keepRaw === '1' || keepRaw === '0') {
    out.transfer = { ...doc.transfer, keepConnection: keepRaw === '1' }
  } else if (keepRaw !== undefined && keepRaw !== '') {
    warn('MONOPLAYER_TRANSFER_KEEP_CONNECTION must be 1 or 0; ignoring ' + keepRaw)
  }
  // #99: the human's own player wears the puppet's skin. On in the defaults;
  // this switch turns it off for a lane without moving that default. Only "1" and
  // "0" are read, so a typo cannot silently change what a lane shows the human.
  const skinRaw = env.MONOPLAYER_SKIN_SHOW_PUPPET
  if (skinRaw === '1' || skinRaw === '0') {
    out.skin = { ...doc.skin, showPuppetSkin: skinRaw === '1' }
  } else if (skinRaw !== undefined && skinRaw !== '') {
    warn('MONOPLAYER_SKIN_SHOW_PUPPET must be 1 or 0; ignoring ' + skinRaw)
  }
  // A deployed puppet keeps reconnecting by default: the backend can restart,
  // and giving up after one attempt leaves the front alive with no session. A
  // config document may set a budget, and this env var may override it. Either
  // way, 0 or unset means unlimited, and the delay caps at
  // MONOPLAYER_RECONNECT_MAX_DELAY_MS.
  const reconnect = { ...doc.reconnect, attempts: doc.reconnect?.attempts ?? Infinity }
  const attemptsRaw = env.MONOPLAYER_RECONNECT_ATTEMPTS
  if (attemptsRaw !== undefined && attemptsRaw !== '') {
    const parsed = Number(attemptsRaw)
    reconnect.attempts = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity
  }
  if (env.MONOPLAYER_RECONNECT_MAX_DELAY_MS) {
    const parsed = Number(env.MONOPLAYER_RECONNECT_MAX_DELAY_MS)
    if (Number.isFinite(parsed) && parsed > 0) reconnect.maxDelayMs = Math.floor(parsed)
  }
  out.reconnect = reconnect
  // A number an operator can set: read once, and a value that cannot mean
  // anything is named rather than silently clamped. The defaults are bounded, so
  // a typo costs the operator the value they meant, not the bound.
  const cap = (raw, variable, floor, ceiling = Infinity) => {
    if (raw === undefined || raw === '') return undefined
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= floor && parsed <= ceiling) return Math.floor(parsed)
    warn(variable + ' must be a number of at least ' + floor +
      (ceiling === Infinity ? '' : ' and at most ' + ceiling) + '; ignoring ' + raw)
    return undefined
  }
  // #201: the total connection cap on the pre-auth window. The window runs from
  // an accepted socket to the attach whitelist's accept, so the cap holds while a
  // tunnel hides the client's address. A value below 1 cannot bound the window:
  // loadConfig refuses it. Here it is named and ignored like every other number,
  // which leaves the document's cap in force when it sets one, and the compiled
  // cap when it does not.
  const preAuthMax = cap(env.MONOPLAYER_PREAUTH_MAX_CONNECTIONS, 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS', 1)
  if (preAuthMax !== undefined) out.preAuth = { ...doc.preAuth, maxConnections: preAuthMax }
  // #205: the deadline on the same window, read the same way. A silent socket
  // that never leaves the window is what closes it against every real join, so
  // the bound is a validated number and never an off switch. A delay above
  // MAX_DEADLINE_MS is named and ignored like any other number the overlay cannot
  // use: Node would fire it at 1 ms and destroy every connection at once.
  const preAuthDeadline = cap(env.MONOPLAYER_PREAUTH_DEADLINE_MS,
    'MONOPLAYER_PREAUTH_DEADLINE_MS', 1, MAX_DEADLINE_MS)
  if (preAuthDeadline !== undefined) out.preAuth = { ...(out.preAuth ?? doc.preAuth), deadlineMs: preAuthDeadline }

  // #96: the packet journal's directory and its retention budget. A rotation
  // size alone deletes nothing, so the directory has a byte budget and an age
  // cap. A cap the overlay cannot read is named in a warning and left at the
  // default, the same as every other number in this function: the defaults are
  // bounded, so a typo costs the operator the value they meant, not the bound.
  const journal = { ...doc.journal }
  if (env.MONOPLAYER_JOURNAL_DIR) journal.dir = env.MONOPLAYER_JOURNAL_DIR
  for (const [variable, key, floor] of [
    ['MONOPLAYER_JOURNAL_MAX_BYTES', 'maxBytes', 1],
    ['MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES', 'maxTotalBytes', 1],
    // 0 turns the age rule off; the byte budget still bounds the directory.
    ['MONOPLAYER_JOURNAL_MAX_AGE_MS', 'maxAgeMs', 0]
  ]) {
    const value = cap(env[variable], variable, floor)
    if (value !== undefined) journal[key] = value
  }
  if (Object.keys(journal).length) out.journal = journal
  return out
}

function accountHint () {
  return [
    '  bootstrap a new account: node src/custody/cli.js device-code',
    '  migrate the single-account layout: node src/custody/cli.js migrate --apply',
    '  list accounts: node src/custody/cli.js accounts'
  ].join('\n')
}

export async function startLive ({ argv = [], io = process } = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  // Guardrail: --start opens sockets and touches token custody — it must be
  // an explicit act. Refuse a purely-default invocation (no backend host and
  // no config document) so `main(['--start'])` stays inert.
  const explicitBackend = process.env.MONOPLAYER_BACKEND_HOST ||
    flag(argv, '--config')
  if (!explicitBackend) {
    stderr.write(
      'monoplayer --start: refusing the default config. Set MONOPLAYER_BACKEND_HOST ' +
      '(and friends) or pass a --config JSON file describing the live legs. ' +
      'See docs/product-core.md.\n'
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

  const skinWarning = unidentifiedSkinWarning(cfg)
  if (skinWarning !== null) stderr.write(`monoplayer --start: warning: ${skinWarning}\n`)

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

  // --- telemetry + journal (both inert unless their env is set) ---
  // Telemetry carries the puppet alias as a resource attribute; the alias and
  // account UUID are not secrets.
  const accountAlias = resolved?.account.alias ?? null
  const telemetryEnv = { ...process.env }
  if (accountAlias) telemetryEnv.MONOPLAYER_ACCOUNT_ALIAS = accountAlias
  const telemetry = createTelemetry({ env: telemetryEnv, log })
  const journal = createJournal(cfg.journal)
  // #96: a journal volume with no room for its budget is reported here, with
  // the path, before any leg opens. The journal stays off; a diagnostic
  // artifact does not take the front down with it.
  const journalFull = journalVolumeFull(journal.stats())
  if (journalFull !== null) log('journalVolumeFull', journalFull)

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
      dialogAction: cfg.dialogAction,
      // #16/#20: the auto-click covers a configuration gate only, and it stands
      // down as soon as a player can answer. A play dialog is never the
      // puppet's, attached or not.
      isHumanAttached: () => core.attached === true,
      // #16: an auto-answered dialog is not the next client's question.
      onDialogAnswered: ({ state }) => core.notePuppetDialogAnswer({ state }),
      log
    })
    : createLiveBackendLeg({
      host: cfg.backend.host,
      port: cfg.backend.port,
      version: cfg.version,
      cacheDir: cfg.puppet.cacheDir,
      cacheAccount: cfg.puppet.cacheAccount,
      // #16/#21: the same answerer split as the account branch. Without these,
      // this branch fails open: the puppet would answer a gate a human is
      // looking at, and the core would hold a gate the server already closed.
      isHumanAttached: () => core.attached === true,
      onDialogAnswered: ({ state }) => core.notePuppetDialogAnswer({ state }),
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
    // #201: the total cap on the sockets inside the pre-auth window.
    preAuth: cfg.preAuth,
    getSnapshotConfig: () => core.cache.snapshot().config,
    wireCheck: payload => wire.check(payload),
    wireMode: 'warn',
    chat: cfg.chat,
    log,
    dumpRaw,
    dumpFramed
  })
  let core = null // assigned before any configured usage below

  // Real timers for the session's reconnect delay. The core stays pure: it
  // announces reconnect_due, this orchestrator performs the backend connect.
  const clock = {
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout
  }

  core = createMonoplayer({
    config: cfg,
    backendLeg: backend,
    frontLeg: front,
    clock,
    logStream: { write: line => log('core', { line }) },
    telemetry,
    journal
  })

  front.setCoreAttach(({ name, uuid }) =>
    core.attachPlayer({ name, uuid, includeConfig: false })
  )
  // #16: a client may attach while the puppet is still configuring, and a
  // configuration gate the backend asked before it arrived is delivered when
  // the client enters its own configuration phase.
  front.setCoreAttachConfiguring(({ name, uuid }) => core.attachConfiguringPlayer({ name, uuid }))
  front.setConfiguringHandler(({ name }) => core.configuringReady({ name }))
  // #22: the reconfiguration call-in is wired by the core's start(), which owns
  // the front-leg handler set; the front leg reports the client's return to
  // play there.
  // #18: the human's client information is the source of the fields the
  // server sees; the core merges it with the backend's view distance cap.
  front.setClientSettingsHandler(settings => core.noteClientSettings(settings))
  core.start()

  // Readiness after a connect: the backend configuration and join prefix must
  // be in the cache, and a backend that streams chunks unbatched needs the
  // same bounded warm fallback the first connect uses. Without this a
  // reconnect (or a followed transfer) sits attach-denied forever.
  async function settleWarm ({ stage, maxWarmMs }) {
    const readiness = await waitForReady({ core, log, maxWarmMs })
    if (!readiness.hasConfig || !readiness.hasPrefix) return readiness
    if (!readiness.warm) {
      // #87: the transfer stage's fallback releases a client onto this cache, so
      // a target that has sent no chunk frame yet is not warm, however many join
      // frames it queued. Startup and reconnect release nobody and keep the old
      // behaviour. A refusal is a failed dial for the caller below: the follow
      // budget retries it and then reverts.
      if (!shouldForceWarm(readiness, { requireChunks: stage === 'transfer' })) {
        log('warmFallbackRefused', {
          stage,
          reason: 'no_chunks',
          chunkFrames: readiness.chunkFrames,
          prefixFrames: readiness.prefixFrames,
          configFrames: readiness.configFrames
        })
        return { ...readiness, warmRefused: true }
      }
      const forced = core.cache.forceWarm()
      core.session.warmComplete({ marker: forced.forced ? 'warm_fallback_join_settled' : 'chunk_batch_finished' })
      log('warmFallback', {
        stage,
        forced: forced.forced,
        prefixFrames: readiness.prefixFrames,
        configFrames: readiness.configFrames,
        chunkFrames: readiness.chunkFrames
      })
    }
    log('readiness', { stage, ...readiness })
    return readiness
  }

  const baseTarget = { host: cfg.backend.host, port: cfg.backend.port }
  const follow = createTransferFollowController()
  // The server the puppet is on now. A plain backend fault reconnects here,
  // not always to the configured base.
  let currentTarget = { ...baseTarget }
  // The server the session last warmed on, which is the one whose state a
  // restored client holds. A given-up target reverts here, not to the base: on a
  // chain A->B->C a failed C restores the client into B's world (#87).
  let settledTarget = { ...baseTarget }
  const isBase = target =>
    target.host === baseTarget.host && target.port === baseTarget.port

  // Point the next dial at the settled server and drop any followed target that
  // is still in the controller.
  function revertToSettled (reason) {
    const abandoned = follow.abort(reason).abandoned ?? null
    currentTarget = { ...settledTarget }
    try {
      backend.setTarget(settledTarget, { keepCookies: !isBase(settledTarget) })
    } catch (error) {
      log('transferFollowTargetRejected', { error: String(error?.message ?? error).slice(0, 200) })
    }
    return { abandoned }
  }

  // One backend.connect() per reconnect_due: the guard refuses a second
  // attempt while one is in flight, so the reconnect can never loop.
  let reconnecting = false
  core.on('reconnect_due', async ({ delayMs, attempt, target } = {}) => {
    if (reconnecting) return
    reconnecting = true
    core.session.backendConnecting({ initial: false })

    const due = follow.onDue({ target })
    const dialTarget = due.target ?? currentTarget
    try {
      backend.setTarget(dialTarget, {
        keepCookies: !isBase(dialTarget),
        transfer: !isBase(dialTarget)
      })
      if (due.target) {
        currentTarget = { ...due.target }
        log('transferFollowConnect', {
          host: due.target.host,
          port: due.target.port,
          attempt,
          failures: due.failures
        })
      }
    } catch (error) {
      log('transferFollowTargetRejected', { error: String(error?.message ?? error).slice(0, 200) })
      core.abortTransfer('invalid_target')
      revertToSettled('invalid_target')
    }

    try {
      await backend.connect()
      const readiness = await settleWarm({
        stage: due.target ? 'transfer' : 'reconnect',
        maxWarmMs: 5000
      })
      if (!readiness.hasConfig || !readiness.hasPrefix || readiness.warmRefused === true) {
        throw new Error(readiness.warmRefused === true
          ? 'backend reconnect produced no chunk frame, so no client can be released on it'
          : 'backend reconnect did not produce configuration and join frames')
      }
      const outcome = follow.onSuccess()
      settledTarget = { ...dialTarget }
      log('backendReconnect', {
        delayMs,
        attempt,
        target: `${dialTarget.host}:${dialTarget.port}`,
        followed: outcome.followed,
        warm: readiness.warm,
        backendLogins: core.session.backendLogins,
        state: core.session.state
      })
    } catch (error) {
      const failure = follow.onFailure()
      log('backendReconnectFailed', {
        delayMs,
        attempt,
        target: `${dialTarget.host}:${dialTarget.port}`,
        error: String(error?.message ?? error).slice(0, 300),
        failures: failure.failures,
        state: core.session.state
      })
      if (failure.reverted) {
        // The followed target is unreachable; the next reconnect goes back to
        // the server the client was restored onto so the puppet is never
        // stranded and never lands where the client is not.
        core.abortTransfer('target_unreachable')
        revertToSettled('target_unreachable')
        log('transferFollowReverted', {
          host: failure.abandoned?.host ?? null,
          port: failure.abandoned?.port ?? null
        })
      }
      const outcome = core.session.fail()
      log('backendReconnectFailedRetry', {
        scheduled: outcome?.scheduled === true,
        nextDelayMs: outcome?.scheduled === true ? outcome.delayMs : null
      })
    } finally {
      reconnecting = false
    }
  })

  // #87: a restored move sends the puppet back to the server the client was
  // restored onto. Without this the follow controller keeps a target the core
  // has already given up on, and the next dial lands the puppet on the server
  // the human was just moved off.
  core.on('transfer_restored', ({ reason = null, kind = null } = {}) => {
    // A reconfigure is the same server restarting its configuration phase, so
    // there is no target to abandon: the puppet stays where it is.
    if (kind !== 'transfer') {
      log('transferRestoreKeptTarget', { reason, kind })
      return
    }
    const { abandoned } = revertToSettled('restored')
    log('transferFollowAbandoned', {
      reason,
      host: abandoned?.host ?? null,
      port: abandoned?.port ?? null
    })
  })

  // Every failure after this point owns a live backend client and (online) the
  // token-custody writer lock. Release both before returning, or the process
  // hangs with the lock held.
  async function stopAfterFailure (stage, fields = {}) {
    log('startLiveFailed', { stage, ...fields })
    journal.event('startLiveFailed', { stage, ...fields })
    try { await core.stop({ reason: `startup_failed:${stage}` }) } catch { /* best effort */ }
    try { await front.close() } catch { /* best effort */ }
    try { await backend.close() } catch { /* best effort */ }
    try { await telemetry.flush() } catch { /* best effort */ }
    journal.close()
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
    chat: cfg.chat,
    transferFollow: cfg.transfer.follow,
    front: `${cfg.front.host}:${cfg.front.port}`,
    backend: `${cfg.backend.host}:${cfg.backend.port}`,
    ...accountLogFields,
    attachWhitelist: cfg.attachWhitelistFile,
    whitelistCount: cfg.attachWhitelist.length
  })
  journal.event('startLive', {
    version: cfg.version,
    chat: cfg.chat,
    transferFollow: cfg.transfer.follow,
    front: `${cfg.front.host}:${cfg.front.port}`,
    backend: `${cfg.backend.host}:${cfg.backend.port}`,
    ...accountLogFields,
    whitelistCount: cfg.attachWhitelist.length,
    reconnect: {
      // A config document's 0 is how an operator writes "unlimited", so the
      // record says what the lane will do, not what the document wrote. The
      // predicate is the session's own (src/core/session.js:74).
      attempts: Number.isFinite(cfg.reconnect.attempts) && cfg.reconnect.attempts > 0
        ? Math.floor(cfg.reconnect.attempts)
        : 'unlimited',
      maxDelayMs: cfg.reconnect.maxDelayMs
    }
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
  // Warm fallback for unbatched backends: after the grace window the marker
  // never arrived, so the join prefix is declared pinned at its current edge
  // (counted, logged; the marker path stays untouched for backends that do
  // batch). Attach readiness without this would never clear and the growing
  // prefix would eventually evict the login frame.
  const readiness = await settleWarm({ stage: 'startup', maxWarmMs: 20_000 })
  if (!readiness.hasConfig || !readiness.hasPrefix) {
    await stopAfterFailure('cache_readiness', readiness)
    return 1
  }

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
  journal.event('liveReady', {
    front: `${bound.host}:${bound.port}`,
    ...accountLogFields,
    configFrames: readiness.configFrames,
    prefixFrames: readiness.prefixFrames,
    warm: readiness.warm
  })

  await runForever({ core, backend, front, log, sink, telemetry, journal })
  return 0
}

async function runForever ({ core, backend, front, log, sink, telemetry, journal }) {
  let stopping = false
  let lastRejected = front.wireStats.rejected
  let lastPreAuthRefused = front.metrics.preAuthRefused
  let lastPreAuthExpired = front.metrics.preAuthExpired

  // Heartbeat gauges: the same values the JSONL heartbeat logs, as OTLP gauges.
  function emitGauges () {
    const stats = core.cache.stats()
    const cacheFrames = Object.values(stats.sizes).reduce((sum, count) => sum + count, 0)
    telemetry.metric('monoplayer.attached', core.attached ? 1 : 0, {}, 'gauge')
    telemetry.metric('monoplayer.warm', stats.warm ? 1 : 0, {}, 'gauge')
    telemetry.metric('monoplayer.backend.logins', core.session.backendLogins, {}, 'gauge')
    telemetry.metric('monoplayer.cache.frames', cacheFrames, {}, 'gauge')
    const rejected = front.wireStats.rejected
    if (rejected > lastRejected) {
      telemetry.metric('monoplayer.wire.rejected', rejected - lastRejected, {})
      lastRejected = rejected
    }
    // #201: a refused pre-auth connection, sampled at each heartbeat like the
    // wire rejections: the front leg owns the socket, so the core never sees the
    // connection that was turned away. The leg counts one reason today, so the
    // attribute repeats the constant. #204's per-source reasons will turn the
    // leg's count into a map, and this sampling will read it.
    const preAuthRefused = front.metrics.preAuthRefused
    if (preAuthRefused > lastPreAuthRefused) {
      telemetry.metric('monoplayer.preauth.refused', preAuthRefused - lastPreAuthRefused,
        { reason: PREAUTH_REFUSAL.CONNECTION_CAP })
      lastPreAuthRefused = preAuthRefused
    }
    // #205: a connection the deadline destroyed. It was admitted, so this is not
    // a full window: a socket sat in it and never left. Kept apart from the
    // refusal sum because the two ask different questions of an operator.
    const preAuthExpired = front.metrics.preAuthExpired
    if (preAuthExpired > lastPreAuthExpired) {
      telemetry.metric('monoplayer.preauth.expired', preAuthExpired - lastPreAuthExpired,
        { reason: PREAUTH_REFUSAL.DEADLINE })
      lastPreAuthExpired = preAuthExpired
    }
  }

  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    log('shutdown', { signal })
    journal.event('shutdown', { signal })
    try { await core.stop({ reason: `signal:${signal}` }) } catch { /* ignore */ }
    front.close()
    backend.close()
    try { await telemetry.flush() } catch { /* telemetry never blocks shutdown */ }
    journal.close()
    sink.end?.()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.off(signal, stop)
    process.on(signal, () => { stop(signal).catch(() => {}) })
  }
  emitGauges()
  const heartbeat = setInterval(() => {
    const stats = core.cache.stats()
    const forwarder = backend.forwarderStats()
    emitGauges()
    log('heartbeat', {
      attached: core.attached,
      backendLogins: core.session.backendLogins,
      warm: stats.warm,
      metrics: { ...core.metrics },
      // #201: the front leg's own counters, which the core cannot hold: the
      // accepted sockets, the logins allowed and denied, and the pre-auth
      // refusals this heartbeat is the place to watch.
      front: front.metrics,
      wire: front.wireStats,
      backendFrames: forwarder ? { ...forwarder.counters, names: forwarder.names } : null,
      // Export health: a silent OTLP or journal failure must be visible from
      // the pod log alone, without querying the collector.
      telemetry: telemetry.stats(),
      journal: journal.stats()
    })
  }, 30_000)
  heartbeat.unref?.()
  // The process stays up: the backend leg's end handler routes through the core.
  return new Promise(() => { /* outlive the event loop on purpose */ })
}

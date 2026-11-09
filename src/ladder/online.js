// The product online bot rung: the real stack (GlowSquidye puppet against the
// live backend, online front with hasJoined) plus a real Microsoft-authenticated
// Bafbi bot attached through the front. No Prism, no display host.
//
//   node src/ladder/online.js [--backend-host <h>] [--backend-port <n>]
//                             [--report <file>] [--verbose]
//
// Backend defaults come from MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT,
// then 127.0.0.1:25565. The front always binds 127.0.0.1 on an ephemeral port.
//
// Exit codes: 0 all assertions pass (or are honestly not_observed), 1 an
// assertion/timeout failed, 2 setup failed (accounts, whitelist, legs). The
// report is written in finally, even on failure.
//
// Assertions N1-N13 are the contract (docs/testing-ladder.md). A FAIL is a
// real finding; do not weaken a check to get a green run. A check the real
// backend cannot expose is recorded as not_observed, never as a pass.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMonoplayer, loadConfig } from '../service/monoplayer.js'
import { createTokenCustody } from '../custody/cache.js'
import { DEFAULT_ACCOUNTS_DIR, listAccounts, resolveAccount } from '../custody/accounts.js'
import { createWhitelistStore } from '../custody/store.js'
import { sameName, sameUuid } from '../custody/util.js'
import { createLiveBackendLeg } from '../legs/live-backend.js'
import { createLiveFrontLeg } from '../legs/live-front.js'
import { waitForReady } from '../service/readiness.js'
import { createWireChecker } from '../core/wire-check.js'
import { createBot } from './bot.js'
import { PARITY_FRAME_NAMES, attachParity, parityReplayNames } from './state-parity.js'

const VERSION = process.env.MONOPLAYER_VERSION ?? '26.1'
const DEFAULT_REPORT = '.reports/online-report.json'
const WHITELIST_FILE = '.secrets/attach-whitelist.json'
const PUPPET_SELECTOR = 'glowsquidye'
const ATTACH_SELECTOR = 'bafbi'

const LOGIN_STATE_FRAMES = Object.freeze(['encryption_begin', 'compress', 'success'])

// N13 waits, bounded, for the attach replay's parity frames to land. The
// expectation is the cache snapshot taken when the replay was built, and the
// client side is cut at the replay's frame count, so a live frame that arrives
// later is ignored on both sides (issue #24).
const PARITY_REPLAY_TIMEOUT_MS = 30_000

export const ONLINE_ASSERTION_IDS = Object.freeze([
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13'
])

function flag (argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

function waitFor (pred, label, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms
    const tick = () => {
      let ok = false
      try { ok = pred() } catch { /* treat a throwing predicate as not ready */ }
      if (ok) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`timed out after ${ms} ms waiting for ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function detail (value) {
  if (value === undefined) return ''
  const json = JSON.stringify(value, (key, inner) => typeof inner === 'bigint' ? String(inner) : inner)
  return json === undefined ? String(value) : json
}

function candidateLines (candidates = []) {
  if (candidates.length === 0) return '  candidates: (none)'
  return candidates
    .map(candidate =>
      `  uuid=${candidate.uuid} name=${candidate.name ?? '?'} alias=${candidate.alias ?? '-'} dir=${candidate.dir}`)
    .join('\n')
}

// The report is metadata only. Keep custody and whitelist paths out of it;
// stderr keeps the full setup message for the operator.
function redactPaths (text, accountsDir = DEFAULT_ACCOUNTS_DIR) {
  return String(text)
    .split(String(accountsDir)).join('<accounts-dir>')
    .split(WHITELIST_FILE).join('<attach-whitelist>')
    .split('.secrets').join('<secrets>')
}

// Resolve the two real custodians the online rung needs. Pure filesystem work
// (no sockets, no auth), so the unit tests can build fixture trees.
export function resolveOnlineAccounts ({ accountsDir = DEFAULT_ACCOUNTS_DIR } = {}) {
  const puppet = resolveAccount({ accountsDir, selector: PUPPET_SELECTOR })
  const attach = resolveAccount({ accountsDir, selector: ATTACH_SELECTOR })

  const missing = []
  if (!puppet.ok) {
    missing.push({
      role: 'puppet',
      selector: PUPPET_SELECTOR,
      reason: puppet.reason,
      candidates: puppet.candidates
    })
  }
  if (!attach.ok) {
    missing.push({
      role: 'attach',
      selector: ATTACH_SELECTOR,
      reason: attach.reason,
      candidates: attach.candidates
    })
  }

  if (missing.length > 0) {
    return {
      ok: false,
      puppet: null,
      attach: null,
      missing,
      reason: missing.map(entry => `${entry.role}:${entry.reason}`).join(',')
    }
  }
  return { ok: true, puppet: puppet.account, attach: attach.account, missing: [], reason: null }
}

function record (id, name, status, info = null) {
  return {
    id,
    name,
    status,
    ok: status === 'pass' ? true : status === 'fail' ? false : null,
    detail: info
  }
}

// Trim the captured-versus-replayed name comparison for the run report. A
// mismatch keeps where it starts and the first names of each side; a match
// keeps only the counts.
export function parityNameEvidence (names) {
  if (!names) return null
  if (names.ok === true) {
    return { ok: true, expectedFrames: names.expected.length, actualFrames: names.actual.length }
  }
  return {
    ok: false,
    expectedFrames: names.expected.length,
    actualFrames: names.actual.length,
    mismatchAt: names.expected.findIndex((name, index) => name !== names.actual[index]),
    expected: names.expected.slice(0, 12),
    actual: names.actual.slice(0, 12)
  }
}

// Trim the parity report for the run report. A domain with a diff keeps the
// changed entries; a passing domain keeps only its verdict. A scalar domain has
// no diff, so keep expected/actual as the only record of the mismatch.
export function parityEvidence (domains) {
  const out = {}
  for (const [name, result] of Object.entries(domains ?? {})) {
    if (result?.ok === true) {
      out[name] = { ok: true }
    } else if (result?.diff) {
      out[name] = { ok: false, diff: result.diff }
    } else {
      out[name] = {
        ok: result?.ok ?? null,
        expected: result?.expected ?? null,
        actual: result?.actual ?? null
      }
    }
  }
  return out
}

// Pure assertion evaluator: takes the evidence the run collected and returns
// the N1-N13 records. Keeping this out of the socket code makes the contract
// testable and the report reproducible.
export function evaluateOnlineAssertions (evidence = {}) {
  const e = evidence ?? {}
  const front = e.front ?? {}
  const core = e.core ?? {}
  const bot = e.bot ?? {}
  const reattach = e.reattach ?? {}
  const wire = front.wire ?? {}
  const serverbound = e.serverbound ?? {}
  const denial = e.denial ?? {}
  const accounts = e.accounts ?? {}
  const attachAccount = accounts.attach ?? {}
  const custody = e.custody ?? {}
  const results = []

  results.push(record(
    'N1',
    'the Microsoft-authenticated attach succeeds',
    bot.ready === true && front.attaches === 1 && core.attached === true ? 'pass' : 'fail',
    {
      botReady: bot.ready === true,
      frontAttaches: front.attaches ?? null,
      coreAttached: core.attached ?? null
    }
  ))

  results.push(record(
    'N2',
    'one online attach allowed, no denials',
    front.kind === 'live-front-leg' && front.allowed === 1 && front.denied === 0 ? 'pass' : 'fail',
    { kind: front.kind ?? null, allowed: front.allowed ?? null, denied: front.denied ?? null }
  ))

  results.push(record(
    'N3',
    'configuration replay came from the cache',
    front.configReplayMode === 'cached_replay' ? 'pass' : 'fail',
    { lastConfigMode: front.configReplayMode ?? null }
  ))

  const playPrefix = Array.isArray(bot.playPrefix) ? bot.playPrefix : []
  // The real backend's prefix is not the loopback's six-frame shape: Paper
  // behind Velocity may send playerlist_header first and may not batch chunks
  // (the warm fallback covers that). Assert the join essentials in order.
  const shape = bot.joinShape ?? {}
  const joinShapeOk = shape.loginIndex >= 0 &&
    shape.positionIndex > shape.loginIndex &&
    shape.chunkIndex > shape.loginIndex
  results.push(record(
    'N4',
    'play login, position, and a chunk appear in order',
    joinShapeOk ? 'pass' : 'fail',
    { firstSix: playPrefix.slice(0, 6), ...shape }
  ))

  const leaks = Array.isArray(bot.loginStateLeaks) ? bot.loginStateLeaks : null
  const playFramesChecked = Number.isInteger(bot.playFrameCount) && bot.playFrameCount > 0
  results.push(record(
    'N5',
    'no login-state frames replayed into play',
    playFramesChecked && leaks !== null && leaks.length === 0 ? 'pass' : 'fail',
    { leaks: leaks ?? null, playFrameCount: bot.playFrameCount ?? null }
  ))

  results.push(record(
    'N6',
    'one backend login',
    core.backendLoginsFirst === 1 ? 'pass' : 'fail',
    { backendLogins: core.backendLoginsFirst ?? null }
  ))

  results.push(record(
    'N7',
    'wire checker inspected frames and rejected none',
    Number(wire.checked) > 0 && wire.rejected === 0 ? 'pass' : 'fail',
    { checked: wire.checked ?? null, rejected: wire.rejected ?? null, byState: wire.byState ?? null }
  ))

  results.push(record(
    'N8',
    'the online bot saw no leftover bytes and no errors',
    bot.leftovers === 0 && bot.errors === 0 ? 'pass' : 'fail',
    { leftovers: bot.leftovers ?? null, errors: bot.errors ?? null }
  ))

  const forwarded = Number(serverbound.forwarded)
  const backendObserved = serverbound.backendObserved === true
  const backendNames = Array.isArray(serverbound.backendNames) ? serverbound.backendNames : []
  const required = ['position', 'block_dig', 'block_place']
  const coreRelayOk = Number.isFinite(forwarded) && forwarded >= 3
  const backendRelayOk = backendObserved
    ? required.every(name => backendNames.includes(name))
    : true
  results.push(record(
    'N9',
    'serverbound move/dig/place reach the backend',
    coreRelayOk && backendRelayOk ? 'pass' : 'fail',
    {
      forwarded: Number.isFinite(forwarded) ? forwarded : null,
      backendObservation: backendObserved ? 'backend-leg writeRaw' : 'not_observed',
      backendNames: backendObserved ? backendNames : null,
      reason: backendObserved ? null : 'the live backend leg exposes no serverbound observation; asserted the core counter only'
    }
  ))

  results.push(record(
    'N10',
    'detach and reattach keep one backend login',
    reattach.attaches === 2 && reattach.backendLogins === 1 ? 'pass' : 'fail',
    { attaches: reattach.attaches ?? null, backendLogins: reattach.backendLogins ?? null }
  ))

  if (denial.observed !== true) {
    results.push(record(
      'N11',
      'non-whitelisted attach denied before play',
      'not_observed',
      {
        reason: denial.reason ??
          'no unwhitelisted Microsoft account is configured; the online front needs a real login'
      }
    ))
  } else {
    results.push(record(
      'N11',
      'non-whitelisted attach denied before play',
      denial.denied === 1 && denial.playFrames === 0 && denial.errors === 0 ? 'pass' : 'fail',
      {
        denied: denial.denied ?? null,
        playFrames: denial.playFrames ?? null,
        errors: denial.errors ?? null
      }
    ))
  }

  const identityOk = front.kind === 'live-front-leg' &&
    sameUuid(bot.uuid, attachAccount.uuid) &&
    sameName(bot.name, attachAccount.name)
  const lockOk = custody.puppetLockReleased === true
  results.push(record(
    'N12',
    'online attach identity is the Bafbi profile and the puppet token lock is released',
    identityOk && lockOk ? 'pass' : 'fail',
    {
      botUuid: bot.uuid ?? null,
      botName: bot.name ?? null,
      expectedUuid: attachAccount.uuid ?? null,
      expectedName: attachAccount.name ?? null,
      puppetLockReleased: custody.puppetLockReleased ?? null
    }
  ))

  // N13 fails closed: no parity evidence, a thrown check, a replay that never
  // finished, or any mismatch is a fail. The expectations come from the cache
  // as it stood at attach time, so a live frame after the attach cannot make a
  // correct replay fail. A live backend misreading a replayed frame is a real
  // finding, never a not_observed gap.
  const parity = e.parity ?? {}
  results.push(record(
    'N13',
    'attached client state matches the replay',
    parity.ok === true && parity.settled === true ? 'pass' : 'fail',
    {
      ok: parity.ok ?? null,
      settled: parity.settled ?? null,
      expectedFrames: parity.expectedFrames ?? null,
      capturedFrames: parity.capturedFrames ?? null,
      names: parity.names ?? null,
      domains: parity.domains ?? null,
      error: parity.error ?? null
    }
  ))

  return results
}

export function summarizeAssertions (assertions = []) {
  const counts = { pass: 0, fail: 0, not_observed: 0 }
  for (const assertion of assertions) {
    counts[assertion.status] = (counts[assertion.status] ?? 0) + 1
  }
  return { ...counts, total: assertions.length }
}

export async function runOnline (argv = process.argv.slice(2)) {
  const verbose = argv.includes('--verbose')
  const reportPath = flag(argv, '--report') ?? DEFAULT_REPORT
  const backendHost = flag(argv, '--backend-host') ??
    process.env.MONOPLAYER_BACKEND_HOST ??
    '127.0.0.1'
  const backendPort = Number(flag(argv, '--backend-port') ??
    process.env.MONOPLAYER_BACKEND_PORT ??
    25565)
  const accountsDir = DEFAULT_ACCOUNTS_DIR
  const startedAt = Date.now()

  const logs = []
  const evidence = {
    accounts: null,
    readiness: null,
    front: null,
    core: null,
    backend: null,
    bot: null,
    serverbound: null,
    reattach: null,
    denial: null,
    parity: null,
    custody: { puppetLockReleased: null }
  }

  let phase = 'setup'
  let exitCode = 0
  let runError = null
  let puppet = null
  let backend = null
  let front = null
  let core = null
  let bot = null
  let bot2 = null
  let assertions = []
  let summary = { pass: 0, fail: 0, not_observed: 0, total: 0 }

  const log = (event, fields = {}) => {
    // Metadata only. Never frame bytes, profile tokens, or account material.
    logs.push({ event, fields })
    if (verbose) process.stderr.write(`[log] ${event} ${detail(fields)}\n`)
  }

  try {
    if (typeof backendHost !== 'string' || backendHost.length === 0) {
      throw new Error('backend host must be a non-empty string')
    }
    if (!Number.isInteger(backendPort) || backendPort <= 0 || backendPort > 65535) {
      throw new Error(`backend port must be an integer in 1..65535, got ${JSON.stringify(backendPort)}`)
    }

    // --- setup: the two real custodians ---
    const accounts = resolveOnlineAccounts({ accountsDir })
    if (!accounts.ok) {
      const lines = accounts.missing.flatMap(entry => [
        `cannot resolve the ${entry.role} account (selector ${JSON.stringify(entry.selector)}): ${entry.reason}`,
        candidateLines(entry.candidates)
      ])
      throw new Error([
        `the online rung needs both custodians in ${accountsDir}`,
        ...lines,
        '  bootstrap: node src/custody/cli.js device-code',
        '  list: node src/custody/cli.js accounts'
      ].join('\n'))
    }
    puppet = accounts.puppet
    const attach = accounts.attach
    evidence.accounts = {
      puppet: {
        uuid: puppet.uuid,
        name: puppet.profile?.name ?? null,
        alias: puppet.alias ?? null
      },
      attach: {
        uuid: attach.uuid,
        name: attach.profile?.name ?? null,
        alias: attach.alias ?? null
      }
    }
    log('onlineStart', {
      backend: `${backendHost}:${backendPort}`,
      puppet: puppet.alias ?? puppet.uuid,
      attach: attach.alias ?? attach.uuid
    })

    // --- setup: attach whitelist (UUID-keyed, never the puppet) ---
    const whitelistStore = createWhitelistStore({ file: WHITELIST_FILE })
    const whitelist = whitelistStore.list().map(player => player.uuid)
    if (whitelist.length === 0) {
      throw new Error(`the attach whitelist is empty at ${WHITELIST_FILE}`)
    }
    if (!whitelist.includes(attach.uuid)) {
      throw new Error(
        `attach account ${attach.alias ?? attach.uuid} is not on the attach whitelist at ${WHITELIST_FILE}`)
    }
    if (whitelist.includes(puppet.uuid)) {
      throw new Error(
        `the puppet account must not be on the attach whitelist (${WHITELIST_FILE})`)
    }

    const config = loadConfig({
      version: VERSION,
      attachWhitelist: whitelist,
      front: { host: '127.0.0.1', port: 0 },
      backend: { host: backendHost, port: backendPort },
      puppet: { username: puppet.profile?.name ?? null, uuid: puppet.uuid }
    })

    // --- setup: real legs + core ---
    backend = createLiveBackendLeg({
      host: backendHost,
      port: backendPort,
      version: VERSION,
      accountDir: puppet.dir,
      account: puppet.alias,
      uuid: puppet.uuid,
      authTitle: puppet.profile?.authTitle ?? null,
      deviceType: puppet.profile?.deviceType ?? null,
      // #16/#21: while the rung's bot is attached it owns a control gate, and
      // an answer the puppet gives itself is not the next client's question.
      isHumanAttached: () => core.attached === true,
      onDialogAnswered: ({ state }) => core.notePuppetDialogAnswer({ state }),
      log
    })
    evidence.backend = {
      kind: backend.kind,
      host: backendHost,
      port: backendPort,
      connected: false
    }

    // Backend-leg serverbound observation. The live leg exposes no serverbound
    // counters, so wrap its public writeRaw: every frame the core forwards to
    // the backend passes through here. This is observation only, never a
    // second write path.
    const serverboundNames = []
    const originalWriteRaw = backend.writeRaw.bind(backend)
    backend.writeRaw = (buffer, meta) => {
      if (typeof meta?.name === 'string') serverboundNames.push(meta.name)
      return originalWriteRaw(buffer, meta)
    }

    const wire = createWireChecker({ version: VERSION })
    front = createLiveFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      attachWhitelistFile: WHITELIST_FILE,
      getSnapshotConfig: () => core.cache.snapshot().config,
      wireCheck: payload => wire.check(payload),
      wireMode: 'throw',
      log
    })

    core = createMonoplayer({
      config,
      backendLeg: backend,
      frontLeg: front,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('core', { line }) }
    })
    // N13 needs the cache as it stood when the replay was built, not the cache
    // later: the rings are bounded FIFOs, and live traffic can evict a frame
    // this client already received. The snapshot, the pose, and the attach run
    // in one synchronous turn, so they describe exactly the stream replayed.
    let attachCut = null
    front.setCoreAttach(({ name, uuid }) => {
      const attachSnapshot = core.cache.snapshot()
      const attachPose = core.session.currentPose
      const outcome = core.attachPlayer({ name, uuid, includeConfig: false })
      // N13 checks the first attach. A later reattach must not replace the cut:
      // the captured frames it would compare against belong to the first.
      if (outcome.attached && attachCut === null) {
        attachCut = {
          snapshot: { ...attachSnapshot, pose: attachPose },
          replayFrames: outcome.frames ?? []
        }
      }
      return outcome
    })
    core.start()

    // --- run: backend connect, readiness, front listen ---
    // Reconnect is another stream's slice. A backend drop here fails the run;
    // this rung never reconnects silently.
    phase = 'run'
    await withTimeout(backend.connect(), 240_000, 'backend_leg_connect')
    evidence.backend.connected = true

    const readiness = await waitForReady({ core, log, maxWarmMs: 30_000 })
    evidence.readiness = {
      hasConfig: readiness.hasConfig,
      hasPrefix: readiness.hasPrefix,
      warm: readiness.warm,
      warmFallback: false,
      configFrames: readiness.configFrames,
      prefixFrames: readiness.prefixFrames,
      elapsedMs: readiness.elapsedMs
    }
    if (!readiness.hasConfig || !readiness.hasPrefix) {
      throw new Error(
        `readiness failed (config=${readiness.hasConfig}, prefix=${readiness.hasPrefix}) ` +
        `after ${readiness.elapsedMs} ms`)
    }
    if (!readiness.warm) {
      // Same fallback as start-live: after the grace window the join prefix is
      // pinned at its current edge, and the marker path stays untouched for
      // backends that do batch.
      const forced = core.cache.forceWarm()
      core.session.warmComplete({
        marker: forced.forced ? 'warm_fallback_join_settled' : 'chunk_batch_finished'
      })
      evidence.readiness.warmFallback = true
      log('warmFallback', {
        forced: forced.forced,
        prefixFrames: readiness.prefixFrames,
        configFrames: readiness.configFrames
      })
    }

    const bound = await front.listen()
    const frontPort = bound.port ?? front.port
    evidence.frontPort = frontPort

    // --- the real Microsoft-authenticated Bafbi bot ---
    const attachCustody = createTokenCustody({
      account: attach.alias,
      uuid: attach.uuid,
      dir: attach.dir,
      create: false
    })
    const botOptions = () => ({
      host: '127.0.0.1',
      port: frontPort,
      username: attach.uuid,
      auth: 'microsoft',
      profilesFolder: attachCustody.cacheFactory, // a function, never a path
      authTitle: attach.profile?.authTitle ?? null,
      deviceType: attach.profile?.deviceType ?? null
    })

    bot = createBot(botOptions())
    // Capture the decoded frames before ready(): the cache replay happens at
    // attach time, so a listener installed after ready would miss the stream
    // the parity check must compare.
    const parityFrames = []
    let parityCapture = true
    bot.client.on('packet', (data, meta) => {
      if (!parityCapture || meta?.state !== 'play') return
      if (!PARITY_FRAME_NAMES.has(meta.name)) return
      parityFrames.push({ name: meta.name, data })
    })
    await withTimeout(bot.ready(120_000), 125_000, 'online bot ready')

    // --- N13: the attach replay matches the state the client decoded ---
    // Wait, bounded, for the replay's parity frames to land. The bot captures
    // from before ready(), and the replay happens inside the attach, so the
    // first K captured frames are the replay's. Anything after them is live
    // traffic, and the cut ignores it.
    const expectedParityFrames = attachCut ? parityReplayNames(attachCut.replayFrames).length : 0
    const replayDeadline = Date.now() + PARITY_REPLAY_TIMEOUT_MS
    while (parityFrames.length < expectedParityFrames && Date.now() < replayDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const paritySettled = expectedParityFrames > 0 && parityFrames.length >= expectedParityFrames
    parityCapture = false

    let parity
    if (attachCut === null) {
      parity = {
        ok: false,
        settled: false,
        expectedFrames: 0,
        capturedFrames: parityFrames.length,
        names: { ok: false, expected: [], actual: [] },
        domains: {},
        error: 'no attach replay was recorded'
      }
    } else {
      parity = attachParity({
        attachSnapshot: attachCut.snapshot,
        replayFrames: attachCut.replayFrames,
        clientFrames: parityFrames,
        settled: paritySettled
      })
    }
    // Keep the verdict and the changed entries, not the full replayed state: a
    // warm cache can hold thousands of block, entity, and replayed frames.
    evidence.parity = {
      ...parity,
      domains: parityEvidence(parity.domains),
      names: parityNameEvidence(parity.names)
    }

    const playFrames = bot.playNames()
    const firstPosition = bot.received.positions[0]
    evidence.front = {
      kind: front.kind,
      // createLiveFrontLeg owns online-mode=true and the real hasJoined gate;
      // the live constructor is the structural proof, not a fake flag.
      verifier: front.kind === 'live-front-leg' ? 'online-mode_hasjoined' : null,
      port: frontPort,
      allowed: front.metrics.allowed,
      denied: front.metrics.denied,
      attaches: front.metrics.attaches,
      configReplayMode: front.lastConfigMode,
      wire: {
        checked: front.wireStats.checked,
        rejected: front.wireStats.rejected,
        byState: front.wireStats.byState
      }
    }
    evidence.core = {
      attached: core.attached,
      attaches: core.metrics.attaches,
      backendLoginsFirst: core.session.backendLogins,
      serverboundForwarded: core.metrics.serverboundForwarded,
      serverboundDropped: core.metrics.serverboundDropped,
      sessionState: core.session.state
    }
    evidence.bot = {
      ready: true,
      uuid: bot.client?.uuid ?? null,
      name: bot.client?.username ?? null,
      playPrefix: playFrames.slice(0, 6),
      joinShape: {
        loginIndex: playFrames.indexOf('login'),
        positionIndex: playFrames.indexOf('position'),
        chunkIndex: playFrames.indexOf('map_chunk')
      },
      playFrameCount: playFrames.length,
      loginStateLeaks: playFrames.filter(name => LOGIN_STATE_FRAMES.includes(name)),
      leftovers: bot.received.leftovers.length,
      errors: bot.received.errors.length,
      success: bot.received.success !== null,
      firstPosition: firstPosition
        ? { x: firstPosition.x, y: firstPosition.y, z: firstPosition.z }
        : null
    }

    // --- N9: serverbound relay through the real stack ---
    bot.sendPosition({ x: 2.5, y: 1.62, z: 2.5 })
    bot.sendDig({ x: 1, y: 0, z: 1 })
    bot.sendPlace({ x: 2, y: 0, z: 2 })
    await withTimeout(
      bot.waitFor(() => core.metrics.serverboundForwarded >= 3, 'three serverbound frames forwarded', 15_000),
      20_000,
      'serverbound relay'
    )
    evidence.serverbound = {
      forwarded: core.metrics.serverboundForwarded,
      dropped: core.metrics.serverboundDropped,
      backendObserved: serverboundNames.length > 0,
      backendNames: [...serverboundNames],
      backendObservation: serverboundNames.length > 0 ? 'backend-leg writeRaw' : 'not_observed'
    }
    // The core snapshot was taken at attach time; refresh the relay counters
    // after the interaction so the report shows the observed traffic.
    evidence.core.serverboundForwarded = core.metrics.serverboundForwarded
    evidence.core.serverboundDropped = core.metrics.serverboundDropped

    // --- N10: detach then reattach with a second real login ---
    await bot.close()
    await waitFor(
      () => core.attached === false && core.session.state === 'detached',
      'detach',
      15_000
    )
    const detachPose = { ...core.session.currentPose }

    bot2 = createBot(botOptions())
    await withTimeout(bot2.ready(120_000), 125_000, 'reattach bot ready')
    await waitFor(
      () => core.attached === true && core.metrics.attaches === 2,
      'reattach',
      15_000
    )
    evidence.reattach = {
      attaches: core.metrics.attaches,
      backendLogins: core.session.backendLogins,
      botReady: true,
      playPrefix: bot2.playNames().slice(0, 6),
      leftovers: bot2.received.leftovers.length,
      errors: bot2.received.errors.length,
      detachPose
    }

    // --- N11: denial is only observed with a real unwhitelisted account ---
    // The online front needs a real Microsoft login, and no such account is
    // configured for this rung. Record the gap; never fake a denial.
    const stranger = listAccounts({ accountsDir }).accounts.find(account =>
      account.uuid !== puppet.uuid && !whitelist.includes(account.uuid))
    evidence.denial = {
      observed: false,
      reason: stranger
        ? `an unwhitelisted account (${stranger.alias ?? stranger.name ?? stranger.uuid}) exists, ` +
          'but the online front needs a real Microsoft login; the denial check is skipped'
        : 'no unwhitelisted Microsoft account is configured; the online front needs a real login'
    }
  } catch (error) {
    runError = error
    exitCode = phase === 'setup' ? 2 : 1
    process.stderr.write(`online: ${phase} failed: ${String(error?.message ?? error)}\n`)
  } finally {
    for (const candidate of [bot2, bot]) {
      try { await candidate?.close?.() } catch { /* best effort */ }
    }
    try { await core?.stop?.({ reason: 'online_rung_done' }) } catch { /* best effort */ }
    try { await front?.close?.() } catch { /* best effort */ }
    try {
      await withTimeout(backend?.close?.() ?? Promise.resolve(), 20_000, 'backend close')
    } catch (error) {
      log('closeTimeout', { error: String(error?.message ?? error).slice(0, 200) })
      try { backend?.end?.() } catch { /* releases the token lock */ }
    }

    // The puppet leg owns the G1 writer lock for its lifetime. A leaked lock
    // would block the next auth refresh; surface it as evidence (N12).
    if (puppet?.dir) {
      try {
        evidence.custody.puppetLockReleased = !fs.existsSync(path.join(puppet.dir, 'writer.lock'))
      } catch {
        evidence.custody.puppetLockReleased = null
      }
    }

    assertions = evaluateOnlineAssertions(evidence)
    // A setup failure means no rung check ever ran. Report the contract as
    // not_observed (with the setup reason), not as a pile of false FAILs.
    if (exitCode === 2 && runError) {
      const reason = `setup failed before the run: ${
        redactPaths(String(runError?.message ?? runError).split('\n')[0], accountsDir).slice(0, 200)
      }`
      assertions = assertions.map(assertion =>
        record(assertion.id, assertion.name, 'not_observed', { reason }))
    }
    summary = summarizeAssertions(assertions)
    if (summary.fail > 0 && exitCode === 0) exitCode = 1
    if (runError && exitCode === 0) exitCode = 1

    for (const assertion of assertions) {
      const label = assertion.status === 'pass'
        ? 'PASS'
        : assertion.status === 'fail' ? 'FAIL' : 'SKIP'
      process.stdout.write(
        `${label} ${assertion.id} ${assertion.name}` +
        `${assertion.detail === null ? '' : ` — ${detail(assertion.detail)}`}\n`)
    }

    const report = {
      rung: 'online',
      mode: 'online',
      auth: 'microsoft',
      version: VERSION,
      backend: { host: backendHost, port: backendPort, kind: 'live-backend-leg' },
      front: {
        host: '127.0.0.1',
        port: evidence.frontPort ?? null,
        kind: 'live-front-leg'
      },
      passed: exitCode === 0 && summary.fail === 0,
      durationMs: Date.now() - startedAt,
      assertions,
      notObserved: assertions
        .filter(assertion => assertion.status === 'not_observed')
        .map(assertion => assertion.id),
      evidence
    }
    if (runError) {
      report.error = redactPaths(String(runError?.message ?? runError), accountsDir).slice(0, 600)
    }

    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      process.stderr.write(
        `online: could not write report ${reportPath}: ${String(error?.message ?? error)}\n`)
      exitCode = 2
    }

    process.stdout.write(
      `online: ${report.passed ? 'PASS' : 'FAIL'} ` +
      `${summary.pass}/${assertions.length} assertions passed, ` +
      `${summary.not_observed} not observed in ${report.durationMs} ms ` +
      `(report: ${reportPath})\n`)
  }

  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnline().then(code => { process.exitCode = code })
}

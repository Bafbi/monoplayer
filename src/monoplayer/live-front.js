// The Monoplayer front leg: one authenticated player attaches through a
// minecraft-protocol server while the puppet holds the backend session.
//
// Two constructors share one body, and the offline path is a separate
// constructor, never a config flag:
//   createLiveFrontLeg    online-mode=true, real sessionserver hasJoined,
//                         UUID-keyed attach whitelist file (.secrets).
//   createOfflineFrontLeg online-mode=false, loopback only, local offline
//                         UUID whitelist, no .secrets read.
//
// Flow per connection:
//   1. library login. Online: encryption + real sessionserver hasJoined (real
//      client.uuid / client.username / client.profile are set by the library
//      BEFORE our synchronous beforeLogin hook runs). Offline: the library
//      sets client.uuid to the vanilla offline UUID (MD5 of
//      "OfflinePlayer:<name>").
//   2. beforeLogin (synchronous; createServer option): deny a second attach
//      before any verification, then run the core login decision (fail closed)
//      and the mode's gate. Deny = client.end('attach denied (...)'): the
//      Server.end override writes the login-state disconnect then ends the
//      serializer chain, so the library's follow-up compress/success writes in
//      loginClient are mechanically dropped (client.write no-ops on an ended
//      serializer).
//   3. allow — cached configuration replay path: the library's automatic
//      configuration (segmented registry_data from its own built-in codec,
//      then finish_configuration) is intercepted via beforeLogin write
//      wrapping: registry_data is suppressed, the library's
//      finish_configuration write is deferred, and the deferred write instead
//      replays the core's cached backend configuration frames (writeRaw,
//      state configuration, excluding finish_configuration) before letting
//      the library-authored finish_configuration through. With no cached
//      configuration frames (backend not warm when the client arrives), the
//      stashed library registry_data is re-emitted instead (fallback path —
//      recorded limitation, see docs/gate-b-b1.md).
//   4. server event 'playerJoin' (client finished configuration): call the
//      core attachPlayer({ name, uuid, includeConfig:false }) — the core
//      replays the play join prefix + warm state; the configuration phase
//      belongs to the front leg (omitted via the join-synth option).
//   5. serverbound play frames (raw buffer + decoded data) go to the core's
//      setServerboundHandler pipeline; client end/error go to the core detach.
//
// Identity: the attaching client is whitelisted as itself (real hasJoined
// profile online, vanilla offline UUID offline). The replayed play stream
// still describes the puppet's session (backend entity id and state).
import mc from 'minecraft-protocol'

import { createAttachGate, DENY_REASONS } from '../auth/attach.js'
import { createWhitelistStore } from '../auth/store.js'
import { normalizeUuid } from '../auth/util.js'
import { isLoopbackHost } from './offline-identity.js'

const WIRE_MODES = new Set(['throw', 'warn', 'off'])

// Pure configuration-phase interceptor (unit-testable without sockets):
// wraps a client write so the library's generated configuration resolves to
// the cached-replay contract. `isConfigurationState` reports the client's
// protocol state at write time; `cachedConfigFrames` are { name, buffer }
// frames captured from the backend (core cache snapshot `.config`).
export function createConfigPathInterceptor ({
  write: originalWrite,
  writeRaw,
  isConfigurationState,
  cachedConfigFrames,
  finishName = 'finish_configuration'
}) {
  if (typeof originalWrite !== 'function') throw new TypeError('write is required')
  if (typeof writeRaw !== 'function') throw new TypeError('writeRaw is required')
  if (typeof isConfigurationState !== 'function') throw new TypeError('isConfigurationState is required')
  if (!Array.isArray(cachedConfigFrames)) throw new TypeError('cachedConfigFrames must be an array')

  let resolved = false
  const stashed = [] // library-authored registry_data params (fallback only)
  const stats = { suppressedRegistryData: 0, replayedConfigFrames: 0 }

  function resolveConfigPath () {
    if (resolved) return
    resolved = true
    if (cachedConfigFrames.length > 0) {
      for (const frame of cachedConfigFrames) {
        if (frame.name === finishName) continue // finish goes out exactly once, from the call site below
        writeRaw(frame.buffer, { state: 'configuration', name: frame.name })
        stats.replayedConfigFrames++
      }
    } else {
      for (const entry of stashed) {
        originalWrite('registry_data', entry.params)
        stats.replayedConfigFrames++
      }
    }
    originalWrite('finish_configuration', {}) // the library call, now ordered after the replay
  }

  function wrappedWrite (name, params) {
    if (!isConfigurationState()) {
      return originalWrite(name, params)
    }
    if (name === 'registry_data' && !resolved) {
      stashed.push({ name, params })
      stats.suppressedRegistryData++
      return
    }
    if (name === finishName && !resolved) {
      resolveConfigPath()
      return
    }
    return originalWrite(name, params)
  }

  return {
    write: wrappedWrite,
    get resolved () { return resolved },
    get replayMode () { return resolved && cachedConfigFrames.length > 0 ? 'cached_replay' : resolved ? 'library_fallback' : 'pending' },
    stats
  }
}

// One client-facing raw frame, with the optional strict wire check applied.
// `wireCheck` is ({ state, name, buffer }) => { ok, code, ... }. Returns true
// when the frame reached writeRaw, false when mode 'throw' suppressed it.
// `stats` is the front leg's wireStats body: checked/rejected/lastFailure.
export function emitCheckedRaw ({
  client,
  buffer,
  meta = null,
  wireCheck = null,
  wireMode = 'warn',
  stats = { checked: 0, rejected: 0, lastFailure: null, byState: {} },
  log = () => {}
} = {}) {
  const state = meta?.state ?? null
  const name = meta?.name ?? null

  if (wireCheck && wireMode !== 'off') {
    stats.checked++
    if (!stats.byState) stats.byState = {}
    const stateKey = state ?? 'unknown'
    stats.byState[stateKey] = (stats.byState[stateKey] ?? 0) + 1
    let result
    try {
      result = wireCheck({ state, name, buffer })
    } catch {
      result = { ok: false, code: 'wire_check_error' }
    }
    if (!result || result.ok !== true) {
      stats.rejected++
      const failure = {
        state,
        name,
        code: result?.code ?? 'wire_check_failed',
        parsedName: result?.parsedName ?? null,
        consumed: result?.consumed ?? null,
        total: result?.total ?? null,
        leftover: result?.leftover ?? null
      }
      stats.lastFailure = failure
      // Never log frame bytes; the failure report is metadata only.
      log('wireReject', failure)
      if (wireMode === 'throw') {
        try { client?.end('wire_reject') } catch { /* client already gone */ }
        return false
      }
    }
  }

  client?.writeRaw(buffer)
  return true
}

// The attach slot holds one client. A second connection must be denied before
// verification, not kicked after configuration.
export function shouldDenySecondAttach (attached, client) {
  return Boolean(attached && attached !== client)
}

// Core loginStart decisions fail closed: an exception, a missing decision from
// a handler that ran, or any decision that is not allowed === true denies.
function evaluateCoreDecision (coreDecision) {
  if (coreDecision === null || coreDecision === undefined) return { ok: true, reason: null }

  let decision = coreDecision
  if (typeof coreDecision === 'function') {
    try {
      decision = coreDecision()
    } catch (error) {
      return { ok: false, reason: 'core_decision_error', detail: String(error?.message ?? error).slice(0, 200) }
    }
  }
  if (decision === null || decision === undefined) {
    return { ok: false, reason: 'core_decision_invalid' }
  }
  if (decision.allowed !== true) {
    return { ok: false, reason: decision.reason ?? 'core_denied' }
  }
  return { ok: true, reason: null }
}

function decideViaGate ({ client, store = null, gate, coreDecision = null } = {}) {
  const core = evaluateCoreDecision(coreDecision)
  if (!core.ok) return core
  if (!gate || typeof gate.gateVerified !== 'function') {
    return { ok: false, reason: 'gate_unavailable' }
  }

  let decision
  try {
    decision = gate.gateVerified({ client, store })
  } catch (error) {
    return { ok: false, reason: 'gate_error', detail: String(error?.message ?? error).slice(0, 200) }
  }
  if (!decision || decision.ok !== true) {
    return { ok: false, reason: decision?.reason ?? 'gate_denied' }
  }
  return { ok: true, reason: null, uuid: decision.uuid ?? null, username: decision.username ?? null }
}

// Pure online attach decision: core loginStart (fail closed), then the real
// hasJoined-backed whitelist gate. Exported for socket-free tests.
export function decideOnlineAttach (input = {}) {
  return decideViaGate(input)
}

// Offline gate: username and uuid must be strings; the normalized uuid must be
// on the offline whitelist. No name matching, no wildcard.
function createOfflineAttachGate ({ whitelist }) {
  return {
    gateVerified ({ client } = {}) {
      const username = typeof client?.username === 'string' && client.username.length > 0
        ? client.username
        : null
      if (!username) {
        return { ok: false, reason: DENY_REASONS.MISSING_USERNAME, stage: 'login', username: null, uuid: null }
      }
      if (typeof client?.uuid !== 'string') {
        return { ok: false, reason: DENY_REASONS.PROFILE_INVALID, stage: 'login', username, uuid: null }
      }
      const uuid = normalizeUuid(client.uuid)
      if (!uuid) {
        return { ok: false, reason: DENY_REASONS.PROFILE_INVALID, stage: 'login', username, uuid: null }
      }
      if (!whitelist.includes(uuid)) {
        return { ok: false, reason: DENY_REASONS.NOT_WHITELISTED, stage: 'login', username, uuid }
      }
      return { ok: true, reason: null, stage: 'login', username, uuid }
    }
  }
}

// Shared body. The constructors below own the mode-specific pieces (gate,
// store, loopback checks); this body never decides the mode itself.
function createFrontLeg ({
  kind,
  onlineMode,
  verifier,
  host,
  port,
  version,
  gate,
  store,
  getSnapshotConfig,
  log,
  wireCheck,
  wireMode,
  dumpRaw,
  dumpFramed
}) {
  if (!WIRE_MODES.has(wireMode)) {
    throw new TypeError(`wireMode must be one of ${[...WIRE_MODES].join(', ')}, got ${JSON.stringify(wireMode)}`)
  }
  if (wireMode !== 'off' && typeof wireCheck !== 'function') {
    throw new TypeError('wireCheck is required unless wireMode is off')
  }
  if (dumpRaw !== null && typeof dumpRaw !== 'function') throw new TypeError('dumpRaw must be null or a function')
  if (dumpFramed !== null && typeof dumpFramed !== 'function') throw new TypeError('dumpFramed must be null or a function')

  let loginStartHandler = null // core gate 1 call-in (processLoginStart)
  let serverboundHandler = null // core serverbound pipeline
  let detachHandler = null // core detach
  let errorHandler = null
  let attached = null // the one client through the pipeline (gate pass or attached)

  const wireStats = { checked: 0, rejected: 0, lastFailure: null }

  let server = null
  let listenPromise = null
  let closePromise = null
  let lastInterceptor = null

  const metrics = { denied: 0, allowed: 0, attaches: 0 }
  const clients = new Map() // Client -> { interceptor }

  function actualPort () {
    return server?.socketServer?.address()?.port ?? null
  }

  // Start listening. Handlers must be set first. Safe to call once: repeat
  // calls return the same promise.
  function listen () {
    if (closePromise) return Promise.reject(new Error('front leg is closed'))
    if (listenPromise) return listenPromise

    listenPromise = new Promise((resolve, reject) => {
      let settled = false

      server = mc.createServer({
        host,
        port,
        version,
        'online-mode': onlineMode,
        keepAlive: true, // the library answers per-connection keep-alives for the client
        hideErrors: true, // errors surface through our own server/client error log lines
        versionChecking: false,
        beforeLogin: client => { handleBeforeLogin(client) }
      })

      server.on('error', err => {
        log('frontServerError', { error: String(err?.message ?? err).slice(0, 200) })
        errorHandler?.({ error: err })
        if (!settled) { settled = true; reject(err) }
      })
      server.on('listening', () => {
        log('frontListening', { host, port: actualPort() })
        if (!settled) { settled = true; resolve({ host, port: actualPort() }) }
      })

      server.on('connection', client => {
        wireClient(client)
        if (dumpFramed) {
          // Diagnostic: framer output is framed (and compressed) bytes.
          client.framer.on('data', buf => { try { dumpFramed(buf) } catch { /* best effort */ } })
        }
      })

      // configuration done: resolve the per-client interceptor + hand the
      // attach to the core (playerJoin is a server-level event in
      // minecraft-protocol; per-client state lives in the ctx map).
      server.on('playerJoin', client => {
        const ctx = clients.get(client)
        if (ctx) {
          log('configResolved', { mode: ctx.interceptor.replayMode, ...ctx.interceptor.stats })
        }
        onClientJoined(client)
      })
    })

    return listenPromise
  }

  function coreDecisionFor (client) {
    if (typeof loginStartHandler !== 'function') return null
    const claimed = { uuid: client.uuid, name: client.username, username: client.username }
    return () => {
      const decision = loginStartHandler(claimed)
      // A handler that ran but produced no decision is not an allow.
      return decision == null ? { allowed: false, reason: 'core_decision_invalid' } : decision
    }
  }

  // beforeLogin: synchronous, called by loginClient AFTER the library's
  // hasJoined (online) or offline UUID assignment (offline) and BEFORE
  // compress + success writes.
  function handleBeforeLogin (client) {
    const username = client.username
    const uuid = client.uuid
    log('frontLoginReview', { username, uuid: uuid ?? null, onlineMode, verifier })

    // Early second-attach deny: before any verification or configuration.
    if (shouldDenySecondAttach(attached, client)) {
      metrics.denied++
      log('attachDenied', { username, uuid: uuid ?? null, reason: 'already_attached' })
      denyConnection(client, 'already_attached')
      return
    }

    const decision = decideViaGate({
      client,
      store,
      gate,
      coreDecision: coreDecisionFor(client)
    })
    if (!decision.ok) {
      metrics.denied++
      log('attachDenied', { username, uuid: uuid ?? null, reason: decision.reason })
      denyConnection(client, decision.reason)
      return
    }

    metrics.allowed++
    log('attachAllowed', {
      username: decision.username ?? username,
      uuid: decision.uuid ?? uuid,
      verifier,
      whitelist: store?.file ?? null
    })

    // Install the cached-config interceptor BEFORE loginClient's subsequent
    // writes/completion (we are inside the synchronous beforeLogin window).
    installConfigInterceptor(client)

    // Own the client slot: a second connection is denied at the next gate.
    attachCandidate(client)
  }

  function denyConnection (client, reason) {
    const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
    if (originalWrite) {
      client.write = (name, ...args) =>
        (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
    }
    try { client.end(`attach denied (${reason})`) } catch { /* client already gone */ }
  }

  // The attach slot is claimed at gate-pass time so a second racing client
  // is denied up-front rather than kicked at playerJoin.
  function attachCandidate (client) {
    if (attached && attached !== client) return // first client still holds the slot
    attached = client
  }

  function installConfigInterceptor (client) {
    // Read the snapshot per connection: a backend cache reset must never be
    // masked by a stale per-listen memo.
    const cachedConfigFrames = getSnapshotConfig().filter(
      frame => typeof frame?.name === 'string' && Buffer.isBuffer(frame.buffer)
    )

    const interceptor = createConfigPathInterceptor({
      write: client.write.bind(client),
      // Every clientbound raw byte we push to the attaching client, in order.
      writeRaw: (buffer, meta) => {
        if (dumpRaw) {
          dumpRaw({ kind: 'raw', buffer, state: meta?.state ?? null, name: meta?.name ?? null })
        }
        return emitCheckedRaw({ client, buffer, meta, wireCheck, wireMode, stats: wireStats, log })
      },
      isConfigurationState: () => client.state === 'configuration',
      cachedConfigFrames
    })
    client.write = interceptor.write
    clients.set(client, { interceptor })
    lastInterceptor = interceptor
  }

  // The client reached play. Hand the attach to the core: replay the join
  // prefix + warm state (configuration frames are omitted — the front leg
  // owns the configuration phase).
  function onClientJoined (client) {
    if (shouldDenySecondAttach(attached, client)) {
      log('frontRejected', { reason: 'already_attached', username: client.username })
      client.end('attach denied (already attached)')
      return
    }
    const outcome = coreAttach({ name: client.username, uuid: client.uuid })

    if (!outcome.attached) {
      log('attachFailed', { username: client.username, uuid: client.uuid, reason: outcome.reason })
      client.end(`attach denied (${outcome.reason})`)
      return
    }
    metrics.attaches++
    log('attached', { username: client.username, uuid: client.uuid, replayed: outcome.replayed })

    // Play serverbound frames from here on: pipeline to the core.
    wireServerbound(client)
  }

  let coreAttach = ({ name, uuid, includeConfig = false } = {}) => ({ attached: false, reason: 'no_core_attached' })
  // The orchestrator injects the single core attach call (keeps this module
  // free of core imports; the core drives the pipeline through the handlers).
  function setCoreAttach (fn) { coreAttach = fn }

  function wireServerbound (client) {
    const decoded = { state: null, byName: {} }
    client.on('packet', (data, meta) => {
      decoded.byName[meta.name] = data
      decoded.state = meta.state
    })
    client.on('raw', (buffer, meta) => {
      if (meta.state !== 'play') return // configuration-phase serverbound frames are per-leg (acknowledgements to the replay), never forwarded
      const same = decoded.state === meta.state && decoded.byName[meta.name] !== undefined
      const data = same ? decoded.byName[meta.name] : {}
      decoded.byName[meta.name] = undefined
      serverboundHandler?.({ state: meta.state, name: meta.name, buffer, data })
    })
  }

  function wireClient (client) {
    // Detach bookkeeping from connection time: an attached client that ends
    // clears the slot and notifies the core; a pre-attach client (denied or
    // failed during configuration) just clears its claim.
    client.on('end', reason => {
      if (attached === client) {
        attached = null
        log('frontDetach', { reason: String(reason).slice(0, 160), attached: true })
        detachHandler?.({ reason: String(reason) })
      } else if (clients.has(client)) {
        log('frontClientEnd', { reason: String(reason).slice(0, 160), attached: false })
      }
    })
    client.on('error', err => {
      log('frontClientError', { error: String(err.message).slice(0, 200) })
      errorHandler?.({ error: err })
    })
  }

  return {
    kind,
    listen,

    // --- frontLeg interface (docs/gate-b-b1.md) ---
    setLoginStartHandler (fn) { loginStartHandler = fn },
    setServerboundHandler (fn) { serverboundHandler = fn },
    setDetachHandler (fn) { detachHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    setCoreAttach,
    write (name, packet) {
      // Library-serialized packet (the synthesized position). The wire checker
      // guards raw replayed/relayed frames in writeRaw; a packet object cannot
      // carry trailing bytes.
      attached?.write(name, packet)
    },
    writeRaw (buffer, meta = null) {
      if (!attached) return false
      if (dumpRaw) {
        dumpRaw({ kind: 'raw', buffer, state: meta?.state ?? null, name: meta?.name ?? null })
      }
      return emitCheckedRaw({ client: attached, buffer, meta, wireCheck, wireMode, stats: wireStats, log })
    },
    end (reason) {
      try { attached?.end(reason) } catch { /* client already gone */ }
    },
    get listening () { return Boolean(server) },
    get attached () { return attached ?? null },
    get metrics () { return { ...metrics } },
    get gateStoreFile () { return store?.file ?? null },
    get port () { return actualPort() },
    get wireStats () {
      return {
        checked: wireStats.checked,
        rejected: wireStats.rejected,
        byState: { ...wireStats.byState },
        lastFailure: wireStats.lastFailure ? { ...wireStats.lastFailure } : null
      }
    },
    get lastConfigMode () { return lastInterceptor?.replayMode ?? 'pending' },
    close () {
      if (closePromise) return closePromise
      closePromise = new Promise(resolve => {
        const current = server
        if (!current) { resolve(); return }
        for (const client of Object.values(current.clients ?? {})) {
          try { client.socket?.destroy() } catch { /* already gone */ }
        }
        const socketServer = current.socketServer
        if (!socketServer) { server = null; resolve(); return }
        try {
          socketServer.close(() => { server = null; resolve() })
        } catch {
          server = null
          resolve()
        }
      })
      return closePromise
    }
  }
}

export function createLiveFrontLeg (options = {}) {
  const {
    host = '127.0.0.1',
    port = 25565,
    version = '26.1',
    attachWhitelistFile,
    getSnapshotConfig,
    log = () => {},
    wireCheck = null,
    wireMode = 'off',
    dumpRaw = null,
    dumpFramed = null
  } = options

  if (options.offlineWhitelist !== undefined) {
    throw new TypeError('createLiveFrontLeg does not accept offlineWhitelist; use createOfflineFrontLeg')
  }
  if (!attachWhitelistFile) throw new TypeError('attachWhitelistFile is required')
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')

  return createFrontLeg({
    kind: 'live-front-leg',
    onlineMode: true,
    verifier: 'online-mode_hasjoined',
    host,
    port,
    version,
    gate: createAttachGate({ log: () => {} }),
    store: createWhitelistStore({ file: attachWhitelistFile }),
    getSnapshotConfig,
    log,
    wireCheck,
    wireMode,
    dumpRaw,
    dumpFramed
  })
}

export function createOfflineFrontLeg (options = {}) {
  const {
    host = '127.0.0.1',
    port = 0,
    version = '26.1',
    offlineWhitelist,
    getSnapshotConfig,
    log = () => {},
    wireCheck = null,
    wireMode = 'throw',
    dumpRaw = null,
    dumpFramed = null
  } = options

  if (options.attachWhitelistFile !== undefined) {
    throw new TypeError('createOfflineFrontLeg does not accept attachWhitelistFile; use createLiveFrontLeg')
  }
  if (!isLoopbackHost(host)) {
    throw new TypeError(`offline front leg host must be 127.0.0.1 or ::1, got ${JSON.stringify(host)}`)
  }
  if (!Array.isArray(offlineWhitelist) || offlineWhitelist.length === 0) {
    throw new TypeError('offlineWhitelist must be a non-empty array of UUID strings')
  }

  const whitelist = []
  for (const entry of offlineWhitelist) {
    if (typeof entry !== 'string') {
      throw new TypeError('offlineWhitelist entries must be UUID strings')
    }
    const uuid = normalizeUuid(entry)
    if (!uuid) {
      throw new TypeError(`offlineWhitelist entry is not a UUID: ${JSON.stringify(entry)}`)
    }
    whitelist.push(uuid)
  }
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')

  return createFrontLeg({
    kind: 'offline-front-leg',
    onlineMode: false,
    verifier: 'offline_uuid',
    host,
    port,
    version,
    gate: createOfflineAttachGate({ whitelist }),
    store: null,
    getSnapshotConfig,
    log,
    wireCheck,
    wireMode,
    dumpRaw,
    dumpFramed
  })
}

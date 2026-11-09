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
//      and the mode's check. Deny = client.end('attach denied (...)'): the
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
//      recorded limitation, see docs/product-core.md).
//   4. server event 'playerJoin' (client finished configuration): call the
//      core attachPlayer({ name, uuid, includeConfig:false }) — the core
//      replays the play join prefix + warm state; the configuration phase
//      belongs to the front leg (omitted via the join-synth option).
//   5. serverbound play frames (raw buffer + decoded data) go to the core's
//      setServerboundHandler pipeline; client end/error go to the core detach.
//   6. the client's Client Information (`settings`) is reported to the core as
//      it arrives, in configuration or play (#18). The core owns what the
//      backend sees: the human's fields with the backend's view distance cap.
//   7. #22: the core may ask the attached client to re-enter configuration on
//      the same connection (`startReconfiguration`). The leg writes the
//      play-state `start_configuration` and holds the core's configuration
//      frames until the client answers with the play-state
//      `configuration_acknowledged` (the packet id exists in play only). It
//      then flips its own client to the configuration state, flushes the held
//      frames, and reports the client's `finish_configuration` back as
//      `reconfigured` once the client is in play again. The client is never
//      told to reconnect.
//
// Identity: the attaching client is whitelisted as itself (real hasJoined
// profile online, vanilla offline UUID offline). The replayed play stream
// still describes the puppet's session (backend entity id and state).
import mc from 'minecraft-protocol'

import { createAttachCheck, DENY_REASONS } from '../custody/attach.js'
import { createWhitelistStore } from '../custody/store.js'
import { normalizeUuid } from '../custody/util.js'
import { isLoopbackHost } from './offline-identity.js'
import { clientboundPolicy, mayCrossToFront } from '../core/clientbound-policy.js'

const WIRE_MODES = new Set(['throw', 'warn', 'off'])
// The configuration prefix the cache holds is bounded at 1024 frames, so a
// reconfiguration cannot need more. The bound exists only so a client that
// never acknowledges cannot grow the leg's memory without limit.
const MAX_PENDING_RECONFIGURATION_FRAMES = 1024
const CHAT_MODES = new Set(['full', 'read-only', 'off'])

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
  finishName = 'finish_configuration',
  // The library's generated registry_data is a fallback for fakes and the
  // offline rung. The live path must never serve it: it carries no registry
  // tags, so a 26.2 client fails registry loading and crashes. Set false to
  // let onUnavailable close the client with a clear message instead.
  allowLibraryFallback = true,
  // #16: the puppet is still in its own configuration phase, so there is
  // nothing cached to replay. Hold the library's finish_configuration and let
  // the core stream the puppet's frames; finishFromCore() ends the phase when
  // the backend's own finish arrives.
  live = false,
  onUnavailable = null,
  // #16: fired once, when the library hands the client to its configuration
  // phase. This is the first moment a configuration frame can reach the client
  // in a state it parses; the attach call-in runs during login, before the
  // library writes Login Success.
  onConfiguring = null
}) {
  if (typeof originalWrite !== 'function') throw new TypeError('write is required')
  if (typeof writeRaw !== 'function') throw new TypeError('writeRaw is required')
  if (typeof isConfigurationState !== 'function') throw new TypeError('isConfigurationState is required')
  if (!Array.isArray(cachedConfigFrames)) throw new TypeError('cachedConfigFrames must be an array')

  let resolved = false
  let notified = false
  const stashed = [] // library-authored registry_data params (fallback only)
  const stats = { suppressedRegistryData: 0, replayedConfigFrames: 0, unavailable: 0, finishedByCore: 0 }

  // #16: the client is in its configuration phase now. One notification per
  // connection, whichever path resolves first.
  function notifyConfiguring () {
    if (notified) return
    notified = true
    onConfiguring?.()
  }

  function resolveConfigPath () {
    if (resolved) return
    notifyConfiguring()
    // Live: the core owns every configuration frame, including the finish, so
    // the library's finish write is dropped and the phase stays open.
    if (live) return
    resolved = true
    if (cachedConfigFrames.length > 0) {
      for (const frame of cachedConfigFrames) {
        if (frame.name === finishName) continue // finish goes out exactly once, from the call site below
        writeRaw(frame.buffer, { state: 'configuration', name: frame.name })
        stats.replayedConfigFrames++
      }
    } else if (allowLibraryFallback) {
      for (const entry of stashed) {
        originalWrite('registry_data', entry.params)
        stats.replayedConfigFrames++
      }
    } else {
      // No backend configuration to replay and the library fallback is off:
      // close instead of handing the client an incomplete registry set.
      stats.unavailable++
      if (onUnavailable) onUnavailable()
      return
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

  // The core relayed the backend's finish_configuration to the client. The
  // client already has that frame on the wire, so the library's deferred write
  // must never follow it.
  function finishFromCore () {
    if (resolved) return false
    resolved = true
    stats.finishedByCore++
    return true
  }

  return {
    write: wrappedWrite,
    finishFromCore,
    get live () { return live },
    get resolved () { return resolved },
    get replayMode () {
      if (live) return 'live_stream'
      return resolved && cachedConfigFrames.length > 0 ? 'cached_replay' : resolved ? 'library_fallback' : 'pending'
    },
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

// Which client information frames the core hears about. Two rules:
//   - only the client that holds the attach slot, so a racing or denied
//     connection can never overwrite the playing human's fields;
//   - only outside play, because a play-state change travels the normal
//     serverbound pipeline, where the core rewrites it with the view distance
//     cap. Reporting it here too would write the packet to the backend twice.
export function shouldReportClientSettings ({ attached, client, state = null }) {
  if (!attached || attached !== client) return false
  return state !== 'play'
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

function decideViaCheck ({ client, store = null, check, coreDecision = null } = {}) {
  const core = evaluateCoreDecision(coreDecision)
  if (!core.ok) return core
  if (!check || typeof check.checkVerified !== 'function') {
    return { ok: false, reason: 'check_unavailable' }
  }

  let decision
  try {
    decision = check.checkVerified({ client, store })
  } catch (error) {
    return { ok: false, reason: 'check_error', detail: String(error?.message ?? error).slice(0, 200) }
  }
  if (!decision || decision.ok !== true) {
    return { ok: false, reason: decision?.reason ?? 'check_denied' }
  }
  return { ok: true, reason: null, uuid: decision.uuid ?? null, username: decision.username ?? null }
}

// Pure online attach decision: core loginStart (fail closed), then the real
// hasJoined-backed whitelist check. Exported for socket-free tests.
export function decideOnlineAttach (input = {}) {
  return decideViaCheck(input)
}

// Offline check: username and uuid must be strings; the normalized uuid must be
// on the offline whitelist. No name matching, no wildcard.
function createOfflineAttachCheck ({ whitelist }) {
  return {
    checkVerified ({ client } = {}) {
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

// Shared body. The constructors below own the mode-specific pieces (check,
// store, loopback checks); this body never decides the mode itself.
function createFrontLeg ({
  kind,
  onlineMode,
  verifier,
  host,
  port,
  version,
  check,
  store,
  getSnapshotConfig,
  log,
  wireCheck,
  wireMode,
  chat = 'read-only',
  dumpRaw,
  dumpFramed
}) {
  const chatMode = chat
  if (!CHAT_MODES.has(chatMode)) {
    throw new TypeError(`chat must be one of ${[...CHAT_MODES].join(', ')}, got ${JSON.stringify(chatMode)}`)
  }
  if (!WIRE_MODES.has(wireMode)) {
    throw new TypeError(`wireMode must be one of ${[...WIRE_MODES].join(', ')}, got ${JSON.stringify(wireMode)}`)
  }
  if (wireMode !== 'off' && typeof wireCheck !== 'function') {
    throw new TypeError('wireCheck is required unless wireMode is off')
  }
  if (dumpRaw !== null && typeof dumpRaw !== 'function') throw new TypeError('dumpRaw must be null or a function')
  if (dumpFramed !== null && typeof dumpFramed !== 'function') throw new TypeError('dumpFramed must be null or a function')

  let loginStartHandler = null // core check 1 call-in (processLoginStart)
  let serverboundHandler = null // core serverbound pipeline
  let detachHandler = null // core detach
  let clientSettingsHandler = null // core client-information capture (#18)
  let configuringHandler = null // core call-in: the client entered configuration (#16)
  let reconfiguredHandler = null // core call-in: the client re-entered play (#22)
  let errorHandler = null
  let attached = null // the one client through the pipeline (check pass or attached)

  const wireStats = { checked: 0, rejected: 0, lastFailure: null }

  let server = null
  let listenPromise = null
  let closePromise = null
  let lastInterceptor = null

  const metrics = { denied: 0, allowed: 0, attaches: 0, policyRefused: 0, stateRefused: 0, reconfigurations: 0, reconfigured: 0, reconfigurationFramesFlushed: 0, reconfigurationFramesDropped: 0 }
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

    const decision = decideViaCheck({
      client,
      store,
      check,
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
    const interceptor = installConfigInterceptor(client)

    // Own the client slot first: the core's early attach streams the cached
    // configuration frames straight back through writeRaw, and a second
    // connection is denied at the next check.
    attachCandidate(client)

    // #16: no cached configuration means the puppet is still configuring. The
    // client attaches early and follows the live stream; the core refuses when
    // no backend configuration is open, and a refusal denies the client.
    if (interceptor.live) {
      const outcome = coreAttachConfiguring({ name: client.username, uuid: client.uuid })
      if (!outcome || outcome.attached !== true) {
        metrics.denied++
        log('attachConfiguringFailed', {
          username: client.username ?? null,
          reason: outcome?.reason ?? 'backend_not_ready'
        })
        denyConnection(client, outcome?.reason ?? 'backend_not_ready')
        return
      }
      log('attachConfiguring', { username: client.username, uuid: client.uuid })
    }
  }

  function denyConnection (client, reason) {
    const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
    if (originalWrite) {
      client.write = (name, ...args) =>
        (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
    }
    try { client.end(`attach denied (${reason})`) } catch { /* client already gone */ }
  }

  // The attach slot is claimed at check-pass time so a second racing client
  // is denied up-front rather than kicked at playerJoin.
  function attachCandidate (client) {
    if (attached && attached !== client) return // first client still holds the slot
    attached = client
  }

  function installConfigInterceptor (client) {
    // Read the snapshot per connection: a backend cache reset must never be
    // masked by a stale per-listen memo. Connection-control frames (a config
    // transfer, a cookie, a dialog, the code of conduct) never replay.
    const cachedConfigFrames = getSnapshotConfig().filter(
      frame => typeof frame?.name === 'string' &&
        Buffer.isBuffer(frame.buffer) &&
        clientboundPolicy('configuration', frame.name).decision !== 'block'
    )

    const live = cachedConfigFrames.length === 0
    const interceptor = createConfigPathInterceptor({
      live,
      write: client.write.bind(client),
      // Every clientbound raw byte we push to the attaching client, in order.
      writeRaw: (buffer, meta) => {
        if (dumpRaw) {
          dumpRaw({ kind: 'raw', buffer, state: meta?.state ?? null, name: meta?.name ?? null })
        }
        return emitCheckedRaw({ client, buffer, meta, wireCheck, wireMode, stats: wireStats, log })
      },
      isConfigurationState: () => client.state === 'configuration',
      cachedConfigFrames,
      // #16: the client can parse a configuration frame from here on. The core
      // delivers a held configuration gate at this moment, not at the attach
      // call-in, which runs before Login Success.
      onConfiguring: () => {
        try {
          configuringHandler?.({ name: client.username ?? null, uuid: client.uuid ?? null })
        } catch (error) {
          log('configuringHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
        }
      },
      // Live only: an empty snapshot means the puppet has no backend session
      // right now. Serving the library's registry_data would crash a 26.2
      // client on missing registry tags, so deny and let the player retry.
      allowLibraryFallback: false,
      onUnavailable: () => {
        log('configUnavailable', { username: client.username ?? null, reason: 'no_cached_backend_config' })
        denyConnection(client, 'backend_not_ready')
      }
    })
    client.write = interceptor.write
    clients.set(client, { interceptor })
    lastInterceptor = interceptor
    return interceptor
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
  }

  let coreAttach = ({ name, uuid, includeConfig = false } = {}) => ({ attached: false, reason: 'no_core_attached' })
  // The orchestrator injects the core attach calls (keeps this module free of
  // core imports; the core drives the pipeline through the handlers).
  // \`coreAttach\` runs at playerJoin: the client is in play and wants its
  // replay. \`coreAttachConfiguring\` runs at beforeLogin, for a client that
  // attaches while the puppet is still in configuration (#16).
  let coreAttachConfiguring = () => ({ attached: false, reason: 'no_core_attached' })
  function setCoreAttach (fn) { coreAttach = fn }
  function setCoreAttachConfiguring (fn) { coreAttachConfiguring = fn }

  function wireServerbound (client) {
    const decoded = { state: null, byName: {} }
    client.on('packet', (data, meta) => {
      decoded.byName[meta.name] = data
      decoded.state = meta.state
    })
    client.on('raw', (buffer, meta) => {
      // #16: a configuration-phase frame reaches the core as well. The human's
      // dialog answers belong to the puppet's session, and the core's own drop
      // rules (classifyServerbound) keep this connection's handshake per-leg.
      if (meta.state !== 'play' && meta.state !== 'configuration') return
      const same = decoded.state === meta.state && decoded.byName[meta.name] !== undefined
      const data = same ? decoded.byName[meta.name] : {}
      decoded.byName[meta.name] = undefined
      // #22: the client's own finish_configuration ends a reconfiguration it
      // was asked to enter. The frame is still offered to the core, which
      // drops it like every other front handshake frame; the state flip and
      // the play-ready call-in happen after that.
      // #22: the client answered the play-state start_configuration; only now
      // can its connection parse configuration frames.
      const acknowledgesReconfiguration = meta.state === 'play' && meta.name === 'configuration_acknowledged' &&
        clients.get(client)?.pendingReconfiguration !== undefined &&
        clients.get(client)?.pendingReconfiguration !== null
      const finishesReconfiguration = clients.get(client)?.reconfiguring === true &&
        meta.state === 'configuration' && meta.name === 'finish_configuration'
      serverboundHandler?.({ state: meta.state, name: meta.name, buffer, data })
      if (acknowledgesReconfiguration) acknowledgeReconfiguration(client)
      if (finishesReconfiguration) finishReconfiguration(client)
    })
  }

  // #22: the client answered the reconfiguration's finish frame, so it is in
  // play again on the same connection. Flip the leg's own state back and tell
  // the core, which replays the target's play login and join state.
  function finishReconfiguration (client) {
    const ctx = clients.get(client)
    if (!ctx?.reconfiguring) return { reconfigured: false }
    ctx.reconfiguring = false
    try {
      client.state = 'play'
    } catch (error) {
      log('frontReconfigureStateFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { reconfigured: false }
    }
    metrics.reconfigured++
    log('frontReconfigured', { username: client.username ?? null, uuid: client.uuid ?? null })
    try {
      reconfiguredHandler?.({ name: client.username ?? null, uuid: client.uuid ?? null })
    } catch (error) {
      log('reconfiguredHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    return { reconfigured: true }
  }

  function wireClient (client) {
    // #16: the serverbound pipeline is wired at connection time, not at
    // playerJoin: a client that attaches during the puppet's configuration has
    // configuration answers to send before it ever reaches play.
    wireServerbound(client)
    // #22: the library's keep-alive plugin starts a new interval on every
    // 'play' state transition and holds only the newest handle, so a
    // same-connection reconfiguration would leak one interval per move. One
    // interval per connection is all this leg needs: it keeps running through
    // the configuration phase (where keep_alive exists too), and the library
    // clears it on 'end'. Drop the listener after the first play transition.
    client.on('state', state => {
      if (state !== 'play') return
      client.removeAllListeners('state')
    })
    // Detach bookkeeping from connection time: an attached client that ends
    // clears the slot and notifies the core; a pre-attach client (denied or
    // failed during configuration) just clears its claim.
    client.on('end', reason => {
      const ctx = clients.get(client)
      if (ctx) {
        ctx.pendingReconfiguration = null
        ctx.reconfiguring = false
      }
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
    // #18: the human's Client Information, as it arrives. A joining client
    // sends it in the configuration phase; a later settings change sends it in
    // play. This is a read-only observation: the configuration handshake, the
    // replay interceptor, and the raw serverbound filter are untouched. The
    // core decides what the backend sees.
    client.on('settings', (data, meta) => {
      const state = meta?.state ?? client.state ?? null
      if (!shouldReportClientSettings({ attached, client, state })) {
        log('clientInformationNotReported', { username: client.username ?? null, state })
        return
      }
      try {
        clientSettingsHandler?.({ ...data })
      } catch (error) {
        log('clientSettingsHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
      }
    })
  }

  // #22: ask the attached client to re-enter configuration on the connection
  // it already holds. The proxy writes its own start_configuration (the backend
  // frame of the same name never crosses: it would move the human as their own
  // account).
  //
  // The client answers with `configuration_acknowledged`, which exists in the
  // play packet table only (26.1 play toServer 0x10). The leg therefore holds
  // the configuration frames it is given until that answer arrives, then flips
  // its client to the configuration state and flushes them in order. Flipping
  // first would read the answer through the configuration table as an unknown
  // packet.
  function startReconfiguration ({ reason = 'transfer' } = {}) {
    if (!attached) return { started: false, reason: 'no_client' }
    const ctx = clients.get(attached)
    if (ctx?.pendingReconfiguration) {
      log('frontReconfigureRefused', { reason: 'already_reconfiguring' })
      return { started: false, reason: 'already_reconfiguring' }
    }
    if (attached.state !== 'play') {
      log('frontReconfigureRefused', { reason: 'client_not_in_play', state: attached.state })
      return { started: false, reason: 'client_not_in_play', state: attached.state }
    }
    try {
      attached.write('start_configuration', {})
    } catch (error) {
      log('frontReconfigureWriteFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { started: false, reason: 'write_failed' }
    }
    if (ctx) {
      ctx.pendingReconfiguration = { frames: [], dropped: 0 }
      ctx.reconfiguring = false
    }
    metrics.reconfigurations++
    log('frontReconfiguration', { reason, username: attached.username ?? null })
    return { started: true, reason }
  }

  // The client acknowledged the play-state start_configuration, so the
  // configuration table is the one its connection now speaks.
  function acknowledgeReconfiguration (client) {
    const ctx = clients.get(client)
    if (!ctx?.pendingReconfiguration) return { acknowledged: false }
    const pending = ctx.pendingReconfiguration
    ctx.pendingReconfiguration = null
    try {
      client.state = 'configuration'
    } catch (error) {
      log('frontReconfigureStateFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { acknowledged: false }
    }
    ctx.reconfiguring = true
    for (const frame of pending.frames) {
      emitCheckedRaw({ client, buffer: frame.buffer, meta: frame.meta, wireCheck, wireMode, stats: wireStats, log })
    }
    metrics.reconfigurationFramesFlushed += pending.frames.length
    log('frontReconfigurationAcknowledged', {
      username: client.username ?? null,
      flushedFrames: pending.frames.length,
      droppedFrames: pending.dropped
    })
    return { acknowledged: true, flushed: pending.frames.length }
  }

  return {
    kind,
    listen,

    // --- frontLeg interface (docs/product-core.md) ---
    setLoginStartHandler (fn) { loginStartHandler = fn },
    setServerboundHandler (fn) { serverboundHandler = fn },
    setDetachHandler (fn) { detachHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    setClientSettingsHandler (fn) { clientSettingsHandler = fn },
    setConfiguringHandler (fn) { configuringHandler = fn },
    setReconfiguredHandler (fn) { reconfiguredHandler = fn },
    startReconfiguration,
    setCoreAttach,
    setCoreAttachConfiguring,
    write (name, packet) {
      // Library-serialized packet (the synthesized position). The wire checker
      // guards raw replayed/relayed frames in writeRaw; a packet object cannot
      // carry trailing bytes.
      attached?.write(name, packet)
    },
    writeRaw (buffer, meta = null) {
      if (!attached) return false
      // Last-write check: even if the core router regresses, a frame the
      // clientbound policy blocks never reaches the client. The cache and
      // router already drop these; this is the independent backstop. It takes
      // the chat mode so it refuses what the router refuses (#19).
      if (meta && (meta.state === 'play' || meta.state === 'configuration')) {
        if (!mayCrossToFront(meta.state, meta.name, { chat: chatMode })) {
          const policy = clientboundPolicy(meta.state, meta.name)
          metrics.policyRefused++
          log('clientboundRefused', {
            state: meta.state,
            name: meta.name,
            unknown: policy.unknown === true
          })
          return false
        }
      }
      // #22: the reconfiguration is waiting for the client's play-state
      // configuration_acknowledged. The client cannot parse a configuration
      // frame before that, so hold them in order and flush them on the ack.
      const pending = clients.get(attached)?.pendingReconfiguration
      if (pending && attached.state === 'play' && meta?.state === 'configuration') {
        pending.frames.push({ buffer, meta })
        while (pending.frames.length > MAX_PENDING_RECONFIGURATION_FRAMES) {
          pending.frames.shift()
          pending.dropped++
          metrics.reconfigurationFramesDropped++
        }
        if (pending.dropped > 0 && !pending.overflowLogged) {
          pending.overflowLogged = true
          log('frontReconfigurationOverflow', { dropped: pending.dropped })
        }
        return true
      }
      // #16: a relayed frame must reach the client in a state it can parse. A
      // configuration frame written while the client is still in login is read
      // as a login packet, which kills the connection. Refuse and log instead.
      if (meta?.state && attached?.state && meta.state !== attached.state) {
        metrics.stateRefused++
        log('clientboundStateMismatch', {
          name: meta.name,
          frameState: meta.state,
          clientState: attached.state
        })
        return false
      }
      if (dumpRaw) {
        dumpRaw({ kind: 'raw', buffer, state: meta?.state ?? null, name: meta?.name ?? null })
      }
      // #16: the core's own finish_configuration ends the client's
      // configuration phase. The interceptor must drop the library's deferred
      // finish so the client never sees two of them.
      if (meta?.state === 'configuration' && meta?.name === 'finish_configuration') {
        const ctx = clients.get(attached)
        if (ctx?.interceptor?.finishFromCore()) {
          log('configFinishedByCore', { username: attached.username ?? null })
        }
      }
      return emitCheckedRaw({ client: attached, buffer, meta, wireCheck, wireMode, stats: wireStats, log })
    },
    end (reason) {
      try { attached?.end(reason) } catch { /* client already gone */ }
    },
    get listening () { return Boolean(server) },
    get attached () { return attached ?? null },
    get metrics () { return { ...metrics } },
    get checkStoreFile () { return store?.file ?? null },
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
          socketServer.closeAllConnections?.()
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
    chat = 'read-only',
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
    check: createAttachCheck({ log: () => {} }),
    store: createWhitelistStore({ file: attachWhitelistFile }),
    getSnapshotConfig,
    log,
    wireCheck,
    wireMode,
    chat,
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
    chat = 'read-only',
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
    check: createOfflineAttachCheck({ whitelist }),
    store: null,
    getSnapshotConfig,
    log,
    wireCheck,
    wireMode,
    dumpRaw,
    dumpFramed
  })
}

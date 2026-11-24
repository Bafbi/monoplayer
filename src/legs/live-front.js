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
//   0. #201 the pre-auth window. A socket is counted from the moment it is
//      accepted until the whitelist accepts its resolved UUID. Over the cap the
//      socket is closed here, before any of the steps below: no login review, no
//      interceptor, no attach slot. An accepted, authenticated session has left
//      the window, so the cap can never refuse one. #205: the same window has a
//      deadline. A connection still in it when its timer fires is destroyed, so
//      a socket that never speaks cannot hold a slot until its peer closes.
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
import { CHAT_MODES, clientboundPolicy, mayCrossToFront } from '../core/clientbound-policy.js'
import { createPreAuthWindow } from '../core/preauth-window.js'
import {
  PICK_VERBS,
  pickRefusalText,
  pickUnknownText,
  pickerDialogParams,
  pickerRows,
  readPickAction,
  readServerAction,
  serverActionProblemText,
  serverDialogParams,
  verbIdFor,
  verbRefusalText
} from '../core/picker.js'
import { baselineFramesFor } from './configuration-baseline.js'

const WIRE_MODES = new Set(['throw', 'warn', 'off'])
// The configuration prefix the cache holds is bounded at 1024 frames, so a
// reconfiguration cannot need more. The bound exists only so a client that
// never acknowledges cannot grow the leg's memory without limit.
const MAX_PENDING_RECONFIGURATION_FRAMES = 1024

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
  // #257: the configuration phase to serve when there is no backend at all,
  // which is the picker. `baselineConfigFrames` is a recording of a real server's phase
  // (src/legs/configuration-baseline.js), and it is served instead of the cached
  // one, in the state that has no backend to replay: the picker's. The phase is
  // deliberately left open: `onBaselineFrames` runs once the frames are on the
  // wire, and the caller sends the dialog there. No finish frame goes out,
  // because the dialog is the phase.
  baselineConfigFrames = [],
  onBaselineFrames = null,
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
  if (!Array.isArray(baselineConfigFrames)) throw new TypeError('baselineConfigFrames must be an array')
  if (onBaselineFrames !== null && typeof onBaselineFrames !== 'function') {
    throw new TypeError('onBaselineFrames must be null or a function')
  }

  let resolved = false
  let notified = false
  const stashed = [] // library-authored registry_data params (fallback only)
  const stats = { suppressedRegistryData: 0, replayedConfigFrames: 0, baselineFrames: 0, unavailable: 0, finishedByCore: 0 }

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
    if (baselineConfigFrames.length > 0) {
      // #257: the picker. The recording is the phase, in its recorded order and
      // as recorded bytes. The finish stays unwritten, so the client remains in
      // configuration with the dialog on screen.
      for (const frame of baselineConfigFrames) {
        // The recording carries the server's finish. The picker never sends one.
        if (frame.name === finishName) continue
        writeRaw(frame.buffer, { state: 'configuration', name: frame.name })
        stats.baselineFrames++
      }
      onBaselineFrames?.()
      return
    }
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
      if (!resolved) return 'pending'
      if (baselineConfigFrames.length > 0) return 'baseline'
      if (cachedConfigFrames.length > 0) return 'cached_replay'
      return 'library_fallback'
    },
    stats
  }
}

// #87: the front client's error policy. minecraft-protocol's default handler
// ends the connection with the Error object itself, and in play that writes
// `kick_disconnect`, whose reason is an NBT string: the serializer fails
// ("SizeOf error for undefined ... Received an instance of Error"), its failure
// becomes the end reason, and the socket is destroyed 30 s later
// (`closeTimeout`) with that TypeError. The connection still ends — an error on
// the attaching client's connection is not survivable — but with one line of
// text, so nothing carries an Error into a packet field.
export function frontErrorKickReason (error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? error)
  return `front_error: ${message}`.slice(0, 200)
}

export function createFrontErrorHandler ({ log = () => {} } = {}) {
  return function frontErrorHandler (client, error) {
    const reason = frontErrorKickReason(error)
    log('frontError', {
      reason,
      username: client?.username ?? null,
      state: client?.state ?? null
    })
    try { client.end(reason) } catch { /* the client is already gone */ }
  }
}

// #87: the configuration round's end frame, as the wire carries it. A restore
// with no cached finish_configuration still has to end the phase the client is
// in. Written as a packet object it would be serialized against whatever state
// the client holds at that moment — play, before it answers the round's
// acknowledgement, where finish_configuration has no packet id at all — so the
// leg builds the bytes and the core writes them through writeRaw with the
// configuration state, like every other configuration frame.
export function configurationFinishFrame ({ version = '26.1' } = {}) {
  const serializer = mc.createSerializer({ state: 'configuration', isServer: true, version })
  return serializer.createPacketBuffer({ name: 'finish_configuration', params: {} })
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
  // #257: the core may allow a login that has no backend to attach to, and say so
  // with `picker: true`. The flag is carried, not inferred: the front serves the
  // picker only where the core decided it may.
  return { ok: true, reason: null, picker: decision.picker === true, phase: decision.phase ?? null }
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
  return {
    ok: true,
    reason: null,
    uuid: decision.uuid ?? null,
    username: decision.username ?? null,
    picker: core.picker === true
  }
}

// Pure online attach decision: core loginStart (fail closed), then the real
// hasJoined-backed whitelist check. Exported for socket-free tests.
export function decideOnlineAttach (input = {}) {
  return decideViaCheck(input)
}

// Offline check: username and uuid must be strings; the normalized uuid must be
// on the offline whitelist. No name matching, no wildcard.
//
// #229: a leg handed a whitelist store reads the store instead. The store is
// what reloads a control document at each login, and this keeps the offline
// rung on the same whitelist code the deployed lane runs.
function createOfflineAttachCheck ({ whitelist = null }) {
  return {
    checkVerified ({ client, store = null } = {}) {
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
      const listed = store !== null && typeof store.has === 'function'
        ? store.has(uuid)
        : (whitelist ?? []).includes(uuid)
      if (!listed) {
        return { ok: false, reason: DENY_REASONS.NOT_WHITELISTED, stage: 'login', username, uuid }
      }
      return { ok: true, reason: null, stage: 'login', username, uuid }
    }
  }
}

// #200: the status answer, written by the leg and never inherited from
// minecraft-protocol, so an upgrade cannot change what a stranger reads. The
// decision behind the empty fields is docs/adr/the-status-ping-says-only-the-
// server-is-up.md.
//
// Pure: takes the library's own answer and returns the reply that replaces it.
export function statusPingAnswer (libraryResponse) {
  return {
    version: { name: '', protocol: libraryResponse?.version?.protocol },
    players: { max: 0, online: 0 },
    description: { text: '' }
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
  // #257: the picker. `configurationBaseline` is a parsed recording of a real
  // server's configuration phase (src/legs/configuration-baseline.js), and
  // `pickerServers` is the allowed list this leg offers when the core says there
  // is no backend to attach to. Both absent means the lane behaves exactly as it
  // did: a join with no backend is refused. `onPickerPick` reports a pick and
  // `onPickerVerb` the answer to the chosen server's dialog (#266); the leg answers
  // the client itself either way, because a configuration phase has nowhere to hand
  // a client until #267 lands.
  configurationBaseline = null,
  pickerServers = null,
  onPickerPick = null,
  // #266: the answer to a chosen server's own dialog — claim, spectate or
  // disconnect, with the server it names.
  onPickerVerb = null,
  // #201: the total connection cap on the pre-auth window.
  preAuth: preAuthOptions = {},
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
  if (pickerServers !== null && typeof pickerServers !== 'function') {
    throw new TypeError('pickerServers must be null or a function returning rows')
  }
  if (onPickerPick !== null && typeof onPickerPick !== 'function') {
    throw new TypeError('onPickerPick must be null or a function')
  }
  // #257: the frames this leg can serve a picker with, resolved once, because the
  // recording and this leg's protocol version are both fixed at construction. A
  // null here is not an error: it is a lane that has no picker, and its joins are
  // refused exactly as they were before.
  const pickerFrames = configurationBaseline === null
    ? null
    : baselineFramesFor(configurationBaseline, { version })
  // #266: `onPickerVerb` reports the answer to a chosen server's own dialog, the
  // way `onPickerPick` reports the pick. Neither connects anything: the dialog
  // layer reads the choice, and #267 is the ticket that acts on one.
  if (onPickerVerb !== null && typeof onPickerVerb !== 'function') {
    throw new TypeError('onPickerVerb must be null or a function')
  }

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

  const metrics = { denied: 0, allowed: 0, attaches: 0, pickers: 0, pickerPicks: 0, pickerServerDialogs: 0, pickerVerbs: 0, pickerRefusals: 0, policyRefused: 0, stateRefused: 0, reconfigurations: 0, reconfigured: 0, reconfigurationFramesFlushed: 0, reconfigurationFramesDropped: 0, preAuthRefused: 0 }
  const clients = new Map() // Client -> { interceptor }

  // #201: the total connection cap, and #205: the deadline on the same window.
  // The window is the one the spec bounds: from the accepted socket to the attach
  // whitelist's accept. The count and the timer are the leg's, because the leg is
  // the only place a socket exists.
  const preAuthWindow = createPreAuthWindow({
    maxConnections: preAuthOptions.maxConnections,
    deadlineMs: preAuthOptions.deadlineMs
  })
  const preAuthOpen = new WeakSet()
  // The window validated the deadline and owns it; the leg reads the effective
  // value back rather than resolving the default a second time.
  const preAuthDeadlineMs = preAuthWindow.stats().deadlineMs
  // One timer per admitted connection. minecraft-protocol sets no idle timeout on
  // its client and closeTimeout starts only after end(), so this is the only bound
  // a socket that never speaks ever meets. Every entry leaves the map either in
  // closePreAuthWindow or in the timer itself, so it cannot outgrow the window.
  const preAuthTimers = new Map()

  // Leave the window, at most once per connection. Two ways out: the whitelist
  // accepted it, or its socket ended. A denial is not a way out, because a denied
  // connection never reached the accept the window is defined by. Its socket
  // stays open until the library's close timeout, and counting it keeps the cap
  // honest about the sockets the process is holding. #205: leaving the window
  // also disarms the deadline, so a slow but real login that reached the
  // whitelist is never cut after its window ended.
  function closePreAuthWindow (client) {
    clearPreAuthDeadline(client)
    if (!preAuthOpen.delete(client)) return
    preAuthWindow.release()
  }

  function armPreAuthDeadline (client) {
    const timer = setTimeout(() => {
      preAuthTimers.delete(client)
      expirePreAuthWindow(client)
    }, preAuthDeadlineMs)
    // A pending deadline must never hold the process open: a shutdown with a
    // silent socket in the window would otherwise wait for the timer.
    timer.unref?.()
    preAuthTimers.set(client, timer)
  }

  function clearPreAuthDeadline (client) {
    const timer = preAuthTimers.get(client)
    if (timer === undefined) return
    preAuthTimers.delete(client)
    clearTimeout(timer)
  }

  // Drop a socket this leg is done with. The library emits 'error' on a client
  // whose socket dies and an unlistened 'error' ends the process, so every
  // listener is replaced with one that knows nothing is coming: a connection on
  // its way out has nothing left to say. Destroyed rather than ended, because
  // ending waits on the library's 30 s close timeout and would hold the socket
  // for another 30 s.
  function destroyQuietly (client) {
    client.removeAllListeners('error')
    client.on('error', () => {})
    try { client.socket?.destroy() } catch { /* already gone */ }
  }

  // #205: the deadline fired. The connection did not reach the whitelist's accept
  // in the time a real login needs, so its socket goes. Its 'end' listener still
  // runs and releases the slot.
  function expirePreAuthWindow (client) {
    const expiry = preAuthWindow.expire()
    // One line per expiry. The window admits at most maxConnections connections
    // at once, so a deadline period cannot write more lines than that, and a
    // sustained attack is exactly the case where a reader needs to see them.
    log('preAuthExpired', {
      reason: expiry.reason,
      deadlineMs: preAuthDeadlineMs,
      expired: expiry.expired
    })
    destroyQuietly(client)
    closePreAuthWindow(client)
  }

  // A connection arrived. Over the cap it is refused with its own reason, and
  // the refusal is counted every time but logged once per saturated window. An
  // admitted connection starts its deadline here, so the slot and the timer are
  // armed and disarmed in the same two places.
  function admitPreAuthWindow (client) {
    const admission = preAuthWindow.admit()
    if (admission.admitted) {
      preAuthOpen.add(client)
      armPreAuthDeadline(client)
      return admission
    }
    metrics.preAuthRefused++
    if (admission.shouldLog) {
      log('preAuthRefused', {
        reason: admission.reason,
        maxConnections: admission.maxConnections,
        inWindow: admission.inWindow,
        refused: admission.refused
      })
    }
    return admission
  }

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
        // #200: nothing the status answer says comes from a library default.
        // `beforePing` replaces the modern answer whole. The pre-1.7 legacy
        // ping is answered from `motd` and `maxPlayers`, and the login
        // `server_data` from `motd`; none of the three has a hook.
        motd: '',
        maxPlayers: 0,
        beforePing: statusPingAnswer,
        keepAlive: true, // the library answers per-connection keep-alives for the client
        hideErrors: true, // errors surface through our own server/client error log lines
        versionChecking: false,
        // #87: without this the library kicks the client with the Error object
        // and the kick fails to serialize. The leg's own handler puts a string
        // in that field.
        errorHandler: createFrontErrorHandler({ log }),
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
        // #201: the cap is checked first. A refused connection never reaches the
        // login review below, so nothing of this leg is allocated for it: no
        // interceptor, no attach slot, no serverbound pipeline. The socket is
        // destroyed rather than ended, because ending it waits on the library's
        // 30 s close timeout and a flood would sit in that wait.
        const admission = admitPreAuthWindow(client)
        if (!admission.admitted) {
          destroyQuietly(client)
          return
        }
        // A socket that ends inside the window leaves it here, which covers every
        // denial before the accept. The library emits this from the socket's own
        // close, so a destroyed socket arrives here too.
        client.on('end', () => closePreAuthWindow(client))
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
    // #201: the window ends here, at the reason the ticket names: the UUID is
    // resolved and the whitelist accepted it. Everything after this is a
    // session, and a session is never refused by the cap.
    closePreAuthWindow(client)
    log('attachAllowed', {
      username: decision.username ?? username,
      uuid: decision.uuid ?? uuid,
      verifier,
      whitelist: store?.file ?? null
    })

    // #257: the core's decision said this join has no backend to attach to, and
    // this leg holds the picker. The picker is not an attach: it takes no slot,
    // so two clients may read it at once, and it never reaches the core's
    // session. Its interceptor is installed here, inside the synchronous
    // beforeLogin window and before any of the library's configuration writes.
    if (decision.picker === true) {
      servePicker(client)
      return
    }

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
    // #201: a denial before the whitelist accepted — a second attach, or a UUID
    // that is not on the list — stays counted until its socket ends, which the
    // library's close timeout bounds. A denial after the accept, such as a
    // backend that is not ready, lands on a connection that has already left the
    // window, so there is nothing to release.
    //
    // #205: the deadline is disarmed here. The denial is this connection's
    // decision, and the close timeout bounds the socket from the end() below. A
    // deadline left armed would fire first for a peer that ignores the disconnect,
    // and the expiry line would report a refused stranger as a stuck socket.
    clearPreAuthDeadline(client)
    const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
    if (originalWrite) {
      client.write = (name, ...args) =>
        (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
    }
    try {
      client.end(`attach denied (${reason})`)
    } catch {
      // The library's end failed, so its close timeout was never armed and no
      // close would ever take this connection out of the window. The socket has
      // to go.
      destroyQuietly(client)
    }
  }

  // The attach slot is claimed at check-pass time so a second racing client
  // is denied up-front rather than kicked at playerJoin.
  function attachCandidate (client) {
    if (attached && attached !== client) return // first client still holds the slot
    attached = client
  }

  function installConfigInterceptor (client, { picker = null } = {}) {
    // Read the snapshot per connection: a backend cache reset must never be
    // masked by a stale per-listen memo. Connection-control frames (a config
    // transfer, a cookie, a dialog, the code of conduct) never replay.
    //
    // #257: a picker client gets the baseline and nothing else. Its cached
    // frames, if the cache holds any, belong to a body nobody claimed, and
    // serving them would put the client in that body's world without a claim.
    const cachedConfigFrames = picker !== null ? [] : getSnapshotConfig().filter(
      frame => typeof frame?.name === 'string' &&
        Buffer.isBuffer(frame.buffer) &&
        clientboundPolicy('configuration', frame.name).decision !== 'block'
    )

    const live = picker === null && cachedConfigFrames.length === 0
    const interceptor = createConfigPathInterceptor({
      live,
      baselineConfigFrames: picker ?? [],
      onBaselineFrames: picker === null ? null : () => sendPickerDialog(client),
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
    clients.set(client, { interceptor, picker: picker !== null })
    lastInterceptor = interceptor
    return interceptor
  }

  // #257: the picker's own rows, from the caller's list. A throw there is a bug
  // in the lane's configuration, not a reason to leave a client in the dark: the
  // leg reports an empty list, and an empty picker closes the connection with a
  // reason instead of showing a dialog with no buttons.
  function pickerServerRows () {
    try {
      return pickerRows(pickerServers() ?? [])
    } catch (error) {
      log('pickerServersError', { error: String(error?.message ?? error).slice(0, 200) })
      return []
    }
  }

  // #257: a join with no backend, on a leg that holds a baseline. The client is
  // held in configuration and shown the picker; nothing is attached, so the
  // second-attach slot stays free and the core's session is untouched.
  function servePicker (client) {
    if (pickerFrames === null || pickerServers === null) {
      metrics.denied++
      log('attachDenied', { username: client.username ?? null, reason: 'picker_unavailable' })
      denyConnection(client, 'picker_unavailable')
      return
    }
    // Installed before any of the library's configuration writes, and before the
    // dialog: the frames go out from the library's finish hook, and the dialog
    // goes out right after them.
    installConfigInterceptor(client, { picker: pickerFrames })
    metrics.pickers++
    log('pickerServed', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      frames: pickerFrames.length,
      servers: pickerServerRows().length
    })
  }

  // The frames are on the wire and the client can parse a dialog now. The dialog
  // is the phase: no finish_configuration follows it.
  function sendPickerDialog (client) {
    const rows = pickerServerRows()
    if (rows.length === 0) {
      log('pickerEmpty', { username: client.username ?? null })
      endConfiguration(client, 'picker_empty', pickRefusalText({ server: null }))
      return
    }
    let written = false
    try {
      // A configuration-phase show_dialog carries the dialog inline
      // (CONTEXT_FREE_STREAM_CODEC in the 26.2 client), so no registry entry is
      // involved and this leg can author one.
      client.write('show_dialog', pickerDialogParams({ rows }))
      written = true
    } catch (error) {
      log('pickerDialogFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    log('pickerDialog', {
      username: client.username ?? null,
      servers: rows.length,
      actions: rows.map(row => row.id)
    })
    if (!written) endConfiguration(client, 'picker_unavailable', pickRefusalText({ server: null }))
  }

  // #266: one click on a dialog this leg authored, at either level. The level is
  // the id's namespace, not a connection's memory: a pick names a server, a verb
  // names a verb and a server, so the frame alone decides which dialog the answer
  // came from. Nothing has to be kept in step, which is what lets two clients hold
  // the picker at once (O55b).
  function handlePickerClick (client, buffer) {
    const pick = readPickAction(buffer)
    if (pick !== null) {
      handlePickerPick(client, pick)
      return
    }
    const action = readServerAction(buffer)
    if (action.ok === true) {
      handlePickerVerb(client, action)
      return
    }
    if (action.reason === 'not_a_click') {
      // Not a click this leg can read at all: another packet's bytes, or a frame
      // that is not a configuration click. The dialog stays on screen, so the
      // client can still choose (#257).
      log('pickerPickIgnored', { username: client.username ?? null, reason: 'not_a_pick' })
      return
    }
    // Ours to read and it did not read. A click that names nothing the dialog
    // offered is refused with the sentence that says what was wrong, and the
    // client is answered: a client left in a dialog nobody will read is worse off
    // than one that is told why.
    metrics.pickerRefusals++
    const text = serverActionProblemText(action)
    log('pickerVerbRefused', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      id: action.id,
      verb: action.verb,
      slug: action.slug,
      reason: action.reason,
      text
    })
    endConfiguration(client, 'picker_refused', text)
  }

  // The client picked a server. It is reported to the caller, and the same client
  // gets that server's own dialog: a pick is the first half of a choice, not the
  // end of the connection (#266).
  function sendServerDialog (client, server) {
    let written = false
    try {
      client.write('show_dialog', serverDialogParams({ server }))
      written = true
    } catch (error) {
      log('pickerServerDialogFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    if (written) metrics.pickerServerDialogs++
    log('pickerServerDialog', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      server: server.name,
      slug: server.slug,
      verbs: PICK_VERBS.map(verb => verbIdFor(verb, server.name))
    })
    if (!written) {
      metrics.pickerRefusals++
      endConfiguration(client, 'picker_unavailable', pickRefusalText({ server: server.name }))
    }
  }

  // #266: the answer to a server's own dialog. The verb and the server both ride in
  // the frame, so the server named here is the one the client clicked, not one this
  // leg remembered.
  function handlePickerVerb (client, action) {
    const server = pickerServerRows().find(row => row.slug === action.slug) ?? null
    const fields = {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      id: action.id,
      verb: action.verb,
      slug: action.slug,
      server: server === null ? null : server.name
    }
    if (server === null) {
      metrics.pickerRefusals++
      const text = pickUnknownText({ id: action.id })
      log('pickerVerbRefused', { ...fields, reason: 'unknown_server', text })
      endConfiguration(client, 'verb_refused', text)
      return
    }
    metrics.pickerVerbs++
    log('pickerVerb', fields)
    try {
      onPickerVerb?.({
        id: action.id,
        verb: action.verb,
        slug: action.slug,
        server: { ...server },
        uuid: client.uuid ?? null,
        name: client.username ?? null
      })
    } catch (error) {
      log('pickerVerbHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    if (action.verb === 'disconnect') {
      // The one verb the dialog layer can carry out itself: the client asked to
      // leave, and there is no body to leave from. It goes, and the frame that
      // ends its configuration says which server it left.
      endConfiguration(client, 'verb_disconnect', 'Monoplayer: you left ' + server.name + '.')
      return
    }
    // Claim and spectate act on a body. No body is connected from this phase until
    // #267 wires a pick to one, so the verb is read, reported, and refused in words
    // that name it. Nothing is invented here.
    endConfiguration(client, 'verb_' + action.verb + '_unbuilt', verbRefusalText({ verb: action.verb, server: server.name }))
  }

  function handlePickerPick (client, action) {
    const rows = pickerServerRows()
    const picked = rows.find(row => row.slug === action.slug) ?? null
    metrics.pickerPicks++
    log('pickerPick', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      id: action.id,
      slug: action.slug,
      server: picked === null ? null : picked.name,
      known: picked !== null
    })
    try {
      onPickerPick?.({
        id: action.id,
        slug: action.slug,
        server: picked === null ? null : { ...picked },
        uuid: client.uuid ?? null,
        name: client.username ?? null
      })
    } catch (error) {
      log('pickerPickHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    if (picked === null) {
      // The dialog on screen is older than the list it came from.
      metrics.pickerRefusals++
      const text = pickUnknownText({ id: action.id })
      log('pickerPickRefused', { username: client.username ?? null, id: action.id, slug: action.slug, text })
      endConfiguration(client, 'pick_refused', text)
      return
    }
    sendServerDialog(client, picked)
  }

  // Leave configuration with a message. The library's own end() writes nothing in
  // this state (its override covers login and play only), so the frame is
  // written here and the socket is ended after it. A client that is told why it
  // is leaving is the whole difference between a refusal and a hang.
  function endConfiguration (client, reason, text) {
    try {
      client.write('disconnect', { reason: { type: 'string', value: text } })
    } catch (error) {
      log('configurationDisconnectFailed', { reason, error: String(error?.message ?? error).slice(0, 200) })
    }
    log('configurationEnded', { reason, username: client.username ?? null })
    try {
      client.end('picker: ' + reason)
    } catch {
      destroyQuietly(client)
    }
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
      // #257: a picker client has no backend. Nothing it says can be relayed, and
      // the one frame this leg wants from it is the click on the dialog.
      if (clients.get(client)?.picker === true) {
        if (meta.state === 'configuration' && meta.name === 'custom_click_action') {
          handlePickerClick(client, buffer)
        }
        return
      }
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
    // #87: the frame bytes that end a configuration round, for a restore whose
    // snapshot carries no cached finish frame.
    finishConfigurationFrame () { return configurationFinishFrame({ version }) },
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
          // Drop the newest: the earliest frames carry the registries the rest
          // of the round depends on. A queue this deep means the client never
          // acknowledged, and the core's configuration deadline ends the round.
          pending.frames.pop()
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
    // The window's own numbers are read live, so the leg keeps no copy of a count
    // the policy already holds.
    get metrics () {
      const window = preAuthWindow.stats()
      return { ...metrics, preAuthInWindow: window.inWindow, preAuthExpired: window.expired }
    },
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
        for (const timer of preAuthTimers.values()) clearTimeout(timer)
        preAuthTimers.clear()
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
    // #229: the control document's store. One instance for the process, so this
    // leg's whitelist check and the core's gate read the same file at each
    // login. Null keeps the one startup read every other lane has always done.
    whitelistStore = null,
    getSnapshotConfig,
    // #257: the picker's configuration baseline and its allowed list. Neither is
    // defaulted here: a lane that sets no baseline keeps refusing a join that has
    // no backend, exactly as before. #266: `onPickerVerb` reports the answer to a
    // chosen server's own dialog.
    configurationBaseline = null,
    pickerServers = null,
    onPickerPick = null,
    onPickerVerb = null,
    // #201: the total connection cap on the pre-auth window.
    preAuth = {},
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
  if (whitelistStore !== null && typeof whitelistStore.has !== 'function') {
    throw new TypeError('whitelistStore must expose has(uuid)')
  }
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')

  return createFrontLeg({
    kind: 'live-front-leg',
    onlineMode: true,
    verifier: 'online-mode_hasjoined',
    host,
    port,
    version,
    check: createAttachCheck({ log: () => {} }),
    store: whitelistStore ?? createWhitelistStore({ file: attachWhitelistFile }),
    getSnapshotConfig,
    configurationBaseline,
    pickerServers,
    onPickerPick,
    onPickerVerb,
    preAuth,
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
    offlineWhitelist = null,
    // #229: the same store option the live leg takes. A store wins over the
    // array, because it is the file that reloads at each login.
    whitelistStore = null,
    getSnapshotConfig,
    // #257: the picker's configuration baseline and its allowed list, forwarded
    // like every other option so the offline rig proves the same code the lane
    // runs. #266: `onPickerVerb` is forwarded with them.
    configurationBaseline = null,
    pickerServers = null,
    onPickerPick = null,
    onPickerVerb = null,
    // #201: the total connection cap on the pre-auth window.
    preAuth = {},
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
  if (whitelistStore !== null && typeof whitelistStore.has !== 'function') {
    throw new TypeError('whitelistStore must expose has(uuid)')
  }
  if (whitelistStore === null && (!Array.isArray(offlineWhitelist) || offlineWhitelist.length === 0)) {
    throw new TypeError('offlineWhitelist must be a non-empty array of UUID strings')
  }

  const whitelist = []
  for (const entry of offlineWhitelist ?? []) {
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
    store: whitelistStore,
    getSnapshotConfig,
    configurationBaseline,
    pickerServers,
    onPickerPick,
    onPickerVerb,
    preAuth,
    log,
    wireCheck,
    wireMode,
    dumpRaw,
    dumpFramed
  })
}

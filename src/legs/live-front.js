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
//      interceptor, no channel. An accepted, authenticated session has left
//      the window, so the cap can never refuse one. #205: the same window has a
//      deadline. A connection still in it when its timer fires is destroyed, so
//      a socket that never speaks cannot hold a slot until its peer closes.
//   1. library login. Online: encryption + real sessionserver hasJoined (real
//      client.uuid / client.username / client.profile are set by the library
//      BEFORE our synchronous beforeLogin hook runs). Offline: the library
//      sets client.uuid to the vanilla offline UUID (MD5 of
//      "OfflinePlayer:<name>").
//   2. beforeLogin (synchronous; createServer option): run the core login decision
//      (fail closed) and the mode's check. A second client is not denied here: a lane
//      that offers a picker sends it to the picker, where the claim refuses it, and a
//      lane with no picker lets the session answer `already_attached` at the attach
//      (#269). Deny = client.end('attach denied (...)'): the
//      Server.end override writes the login-state disconnect then ends the
//      serializer chain, so the library's follow-up compress/success writes in
//      loginClient are mechanically dropped (client.write no-ops on an ended
//      serializer).
//   2b. #257/#267: a login the core allowed with no backend to attach to
//      (`picker: true`) is served the recorded configuration baseline and the
//      picker dialog. The click that claims a body is recorded here (#267), at that
//      click and not at login; the claim is held by the connection and released when
//      the connection ends.
//   2c. #269: delivery is a channel's, not a slot's. A channel is one
//      connection's delivery of one body: its role, what it has been sent, and its
//      own client information (src/core/channels.js). A body's driver and its
//      spectators are channels on that body, and every frame this leg writes goes to
//      all of them. A second claim on a driven body is refused by the claim, and a
//      spectator's frames never reach the core.
//
//   2d. #258: a granted claim is the one thing that lands a client. The leg asks
//      the caller for the body the frame named, and only after the click. A body
//      that answers continues the client's open configuration phase with its own
//      frames and ends it with one finish frame. The client then reaches
//      playerJoin, where the core replays that body's play state on the socket the
//      client already holds. A body that refuses the dial offers the list again,
//      instead of leaving the client in a dialog nobody will read.
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
//   6. a client's Client Information (`settings`) is recorded on its own channel as
//      it arrives (#269). Only the driver's is reported to the core, and only outside
//      play (#18): a play-state change travels the serverbound pipeline, and a
//      spectator's settings reach nothing. The core owns what the backend sees: the
//      driver's fields with the backend's view distance cap.
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
import { CLAIM_REFUSAL, claimRefusalText, createClaims } from '../core/claims.js'
import { CHANNEL_ROLES, createChannels } from '../core/channels.js'
import { CHAT_MODES, clientboundPolicy, mayCrossToFront } from '../core/clientbound-policy.js'
import { createPreAuthWindow } from '../core/preauth-window.js'
import {
  PICK_VERBS,
  claimFailureText,
  claimRestoreTitle,
  pickRefusalText,
  pickUnknownText,
  pickerDialogParams,
  pickerRowForBody,
  pickerRows,
  readPickAction,
  pickTarget,
  readServerAction,
  serverActionProblemText,
  serverDialogParams,
  spectateRefusalText,
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

// #269: which channel's client information the core hears about. Two rules, and
// they are the whole decision:
//   - only the driver's, because the fields the puppet sends are the driving
//     client's. A spectator's information is its own and is recorded on its own
//     channel, so one client can never overwrite another's;
//   - only outside play, because a play-state change travels the normal
//     serverbound pipeline, where the core rewrites it with the view distance
//     cap. Reporting it here too would write the packet to the backend twice.
export function reportsClientInformation ({ role = null, state = null } = {}) {
  if (role !== CHANNEL_ROLES.DRIVER) return false
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
  // did: a join with no backend is refused. `onPickerPick` reports a pick, and
  // `onPickerVerb` reports the answer to the chosen server's dialog (#266), and a
  // claim on that server's body is recorded here (#267), and a granted claim is
  // what dials that body and lands the client in it (#258).
  configurationBaseline = null,
  pickerServers = null,
  onPickerPick = null,
  // #266: the answer to a chosen server's own dialog, which is claim, spectate or
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
  // layer reads the choice, and #267 records a claim from it.
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
  // #269: a spectator's two call-ins. `spectateBody` answers whether a row names a
  // body this lane can watch, and `spectatorAttach` hands that body's play state to
  // the spectator's own channel. Both absent is a lane with no spectator, and its
  // Spectate verb is refused in words.
  let spectateBodyHandler = null
  let spectatorAttachHandler = null
  // #259: the body this lane serves, and whether it has one up, so a row can say
  // `unclaimed` rather than `down` about a body a spectator could join. Absent is a
  // leg with no core, and every row then reads what the list says.
  let bodyServedHandler = null
  let spectatorLeftHandler = null

  const wireStats = { checked: 0, rejected: 0, lastFailure: null }

  let server = null
  let listenPromise = null
  let closePromise = null
  let lastInterceptor = null

  const metrics = { denied: 0, allowed: 0, attaches: 0, pickers: 0, pickerPicks: 0, pickerServerDialogs: 0, pickerVerbs: 0, pickerClaims: 0, pickerRefusals: 0, claimLandings: 0, claimLanded: 0, claimRestored: 0, policyRefused: 0, stateRefused: 0, reconfigurations: 0, reconfigured: 0, reconfigurationFramesFlushed: 0, reconfigurationFramesDropped: 0, preAuthRefused: 0, channelRefused: 0, spectateLandings: 0, spectatorJoins: 0, spectatorFramesDropped: 0, spectatorSettings: 0, spectatorModeWithheld: 0 }
  const clients = new Map() // Client -> { interceptor, channel }
  // #269: the channels this leg delivers through (src/core/channels.js). A channel
  // is one connection's delivery of one body: its role, what it has been sent, and
  // its own client information. The claim decides who may drive a body
  // (src/core/claims.js); a channel is what each connection is handed, and the
  // attach slot is gone with the one pointer that used to be all three.
  const channels = createChannels()
  const clientByChannel = new Map() // channel id -> the socket that holds it
  // #267: the claims this leg holds, one per body. A claim is recorded where a
  // client answers a body's own dialog, and released when its connection ends. The
  // holder is an id this leg gives a connection, so the board holds no socket and
  // two connections from one account are two holders.
  const claims = createClaims()
  const holderIds = new WeakMap()
  let holderSeq = 0
  function holderFor (client) {
    let id = holderIds.get(client)
    if (id === undefined) {
      holderSeq += 1
      id = 'holder-' + holderSeq
      holderIds.set(client, id)
    }
    return id
  }

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
        // interceptor, no channel, no serverbound pipeline. The socket is
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

    // #269: own the channel first, because the core's early attach streams the
    // cached configuration frames straight back through writeRaw and this client's
    // configuration information is reported on the channel it holds. A lane that
    // already has a driver opens nothing here: the session answers the second
    // client at the attach, which is the one authority such a lane has.
    openChannel(client, { role: CHANNEL_ROLES.DRIVER })

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

  // --- #269: the channels, and the sockets they belong to ---

  // Open a channel for a connection. The claim has already refused a rival, so a
  // second driver here is a programming error rather than a second authority: it is
  // counted and refused with the channel that holds the body.
  function openChannel (client, { role, body = null, name = null } = {}) {
    const outcome = channels.open({
      id: holderFor(client),
      body,
      role,
      name: name ?? client.username ?? null,
      at: Date.now()
    })
    if (!outcome.ok) {
      metrics.channelRefused++
      log('channelRefused', {
        username: client.username ?? null,
        uuid: client.uuid ?? null,
        role,
        body,
        reason: outcome.reason,
        heldBy: outcome.channel?.name ?? null
      })
      return null
    }
    clientByChannel.set(outcome.channel.id, client)
    const ctx = clients.get(client)
    if (ctx) ctx.channel = outcome.channel.id
    log('channelOpen', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      channel: outcome.channel.id,
      role: outcome.channel.role,
      body: outcome.channel.body
    })
    return outcome.channel
  }

  // The channel a connection holds, or null. Read from the holder id, so a channel
  // that closed is a connection holding nothing.
  function channelFor (client) {
    const id = holderIds.get(client)
    return id === undefined ? null : channels.of(id)
  }

  function closeChannel (client) {
    const id = holderIds.get(client)
    if (id === undefined) return null
    const closed = channels.close(id)
    if (closed === null) return null
    clientByChannel.delete(id)
    log('channelClosed', {
      username: client.username ?? null,
      channel: closed.id,
      role: closed.role,
      body: closed.body,
      frames: closed.delivered.frames
    })
    return closed
  }

  function clientOfChannel (id) {
    return typeof id === 'string' ? clientByChannel.get(id) ?? null : null
  }

  // One clientbound write, to every channel on the body or to one of them. The two
  // callers differ only in what they hand a client, so the addressing and the count of
  // deliveries live here (#269).
  //
  // #259: the body's stream goes to its driver and its spectators, with one exception.
  // `game_state_change` and `abilities` say what the *body* is doing — its game mode
  // and the flags that go with it — and a spectator already carries the body's own
  // copies from its replay. What a spectator's client should hold is the spectator mode
  // the core wrote to that channel when it landed, so a later body frame must not be
  // broadcast over it. A write that names one channel is the lane deciding for that
  // client and always passes: that is how the core tells a spectator what it is.
  function deliverEach (channel, deliver, { name = null } = {}) {
    if (channel !== null) return deliver(clientOfChannel(channel)) ? 1 : 0
    let sent = 0
    for (const target of deliveryTargets()) {
      if (bodyFrameWithheld({ role: target.channel.role, name })) continue
      if (deliver(target.client)) sent++
    }
    return sent
  }

  // The body's own player-mode frames, which belong to whoever is driving it.
  const DRIVER_ONLY_FRAMES = new Set(['game_state_change', 'abilities'])

  function bodyFrameWithheld ({ role = null, name = null } = {}) {
    if (role !== CHANNEL_ROLES.SPECTATOR) return false
    if (typeof name !== 'string' || !DRIVER_ONLY_FRAMES.has(name)) return false
    metrics.spectatorModeWithheld++
    return true
  }

  // The socket that drives the body this leg serves. A reconfiguration and the
  // wire's one-start-per-round are the driver's; a spectator is handed the result
  // like any other body stream.
  function driverClient () {
    const driver = channels.driverChannel()
    return driver === null ? null : clientOfChannel(driver.id)
  }

  // The body a spectator names, for a body nobody drives: one body at a time is this
  // leg's limit, so the first channel that names one names it (#259).
  function watchedBody () {
    for (const channel of channels.snapshot()) {
      if (channel.body !== null) return channel.body
    }
    return null
  }

  // The sockets one clientbound frame goes to: the body's driver, and every
  // spectator watching that body. The driver's channel names the body; a driver
  // channel that names none is a client this lane admitted without a claim, and
  // `null` is then the lane's own body rather than no body at all. With no driver,
  // a spectator's channel names the body, which is the ordinary state of a body whose
  // player left (#259). A leg per body is #261.
  function deliveryTargets () {
    const driver = channels.driverChannel()
    const body = driver !== null ? driver.body : watchedBody()
    if (driver === null && body === null) return []
    const targets = []
    for (const channel of channels.on(body)) {
      const client = clientByChannel.get(channel.id)
      if (client !== undefined) targets.push({ client, channel })
    }
    return targets
  }

  // One frame reached one channel. The counter is the channel's, so a spectator
  // that arrived mid-stream is never reported as having seen what the driver saw.
  function noteDelivered (client, meta, { replay = false } = {}) {
    const channel = channelFor(client)
    if (channel === null) return
    channels.noteDelivery({
      id: channel.id,
      state: meta?.state === 'configuration' ? 'configuration' : 'play',
      name: typeof meta?.name === 'string' ? meta.name : null
    })
    if (replay) channels.markReplay(channel.id)
  }

  // The body's configuration frames as this leg may send them: the cache's own
  // configuration snapshot, minus anything the clientbound policy refuses and
  // minus anything that is not a frame. Both the cached replay at login and the
  // landing after a claim (#258) read it, so the two phases a client can receive
  // carry the same set.
  function replayableConfigFrames () {
    return getSnapshotConfig().filter(
      frame => typeof frame?.name === 'string' &&
        Buffer.isBuffer(frame.buffer) &&
        clientboundPolicy('configuration', frame.name).decision !== 'block'
    )
  }

  function installConfigInterceptor (client, { picker = null } = {}) {
    // Read the snapshot per connection: a backend cache reset must never be
    // masked by a stale per-listen memo. Connection-control frames (a config
    // transfer, a cookie, a dialog, the code of conduct) never replay.
    //
    // #257: a picker client gets the baseline and nothing else. Its cached
    // frames, if the cache holds any, belong to a body nobody claimed, and
    // serving them would put the client in that body's world without a claim.
    const cachedConfigFrames = picker !== null ? [] : replayableConfigFrames()

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
    let offered = []
    try {
      offered = pickerRows(pickerServers() ?? [])
    } catch (error) {
      log('pickerServersError', { error: String(error?.message ?? error).slice(0, 200) })
      return []
    }
    // #259: what each body on a row is doing, read where the rows are handed out,
    // so every dialog a client reads is as old as the click that asked for it. The
    // claim names the driver, the channels name the spectators, and whether the body
    // is up at all is the core's answer, because the session owns the body. What the
    // three facts make of a row is the picker's own vocabulary
    // (src/core/picker.js, `pickerRowForBody`).
    //
    // A body this lane serves and has up with nobody holding it is `unclaimed`,
    // and that is a body a client may watch. Everything else is `down`, including
    // a body whose claim is still held: a row is what this lane can offer, not what
    // it has dialled.
    const served = bodyServedHandler === null ? null : bodyServedHandler()
    return offered.map(row => {
      const claim = claims.claimOn(row.slug)
      const spectators = channels.on(row.slug)
        .filter(channel => channel.role === CHANNEL_ROLES.SPECTATOR).length
      const up = served !== null && served.body === row.slug && served.up === true
      return pickerRowForBody(row, { up, driver: claim === null ? null : claim.name, spectators })
    })
  }

  // #257: a join with no backend, on a leg that holds a baseline. The client is
  // held in configuration and shown the picker; nothing is attached, so the
  // body stays with its driver: a picker client holds no channel and the core's
  // session is untouched.
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
  function sendPickerDialog (client, { title = 'Choose a server' } = {}) {
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
      client.write('show_dialog', pickerDialogParams({ rows, title }))
      written = true
    } catch (error) {
      log('pickerDialogFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    log('pickerDialog', {
      username: client.username ?? null,
      servers: rows.length,
      title,
      actions: rows.map(row => row.id)
    })
    if (!written) endConfiguration(client, 'picker_unavailable', pickRefusalText({ server: null }))
  }

  // #266: one click on a dialog this leg authored, at either level. The level is
  // the id's namespace, not a connection's memory. A pick names a server, and a verb
  // names a verb and a server, so the frame alone says which dialog it answers.
  // Nothing has to be kept in step, which is what lets two clients hold the picker
  // at once (O55b).
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
    // Ours to read and it did not read. The click is refused with the sentence
    // that says what was wrong, and the client is answered. A client left in a
    // dialog nobody will read is worse off than one that is told why.
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

  // The client picked a server. The pick is reported to the caller, and the same
  // client gets that server's own dialog. A pick is the first half of a choice, not
  // the end of the connection (#266).
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
  // the frame. This is therefore the server the client clicked, not one the leg
  // remembered.
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
    // #267: the claim is recorded here, where the client answers a body's own
    // dialog, and not at login. The frame names the body, so the contention is over
    // that body and not over who logged in first.
    const claimed = action.verb === 'claim' ? recordClaim(client, server) : null
    try {
      onPickerVerb?.({
        id: action.id,
        verb: action.verb,
        slug: action.slug,
        server: { ...server },
        uuid: client.uuid ?? null,
        name: client.username ?? null,
        claim: claimed === null ? null : claimReport(claimed)
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
    if (claimed !== null) {
      // #258: a granted claim is the landing. The body the frame named is dialled
      // now and the client is put into it; a refused one is answered with the
      // sentence naming what stands in the way.
      if (claimed.ok) {
        // The claim as recorded, not the outcome that carries it: the landing
        // names the body and the server the view holds.
        landClaimedBody(client, server, claimed.claim)
        return
      }
      endConfiguration(client, 'claim_refused', claimed.text)
      return
    }
    if (action.verb === 'spectate') {
      // #259: the click is the landing. A spectator enters the body the way a driver
      // does — that body's configuration continues this client's phase — and then
      // its own play state arrives on the connection it already holds. A refusal is
      // answered in the sentence that names its reason, because a client left in a
      // dialog nobody will read is worse off than one that is told why.
      const landing = landSpectator(client, { body: server.slug, server: server.name })
      if (landing.watching === true) return
      endConfiguration(client, 'spectate_refused', landing.text)
      return
    }
    // Any other verb is one no lane offers yet.
    endConfiguration(client, 'verb_' + action.verb + '_unbuilt', verbRefusalText({ verb: action.verb, server: server.name }))
  }

// --- #258: the claim lands the client ---

  // A granted claim is the one thing that dials a body. The click closed the
  // client's dialog and left the phase open, so the client is parked while the
  // address the row named is dialled. Nothing else is on screen. Nothing was
  // connected before this click either, which is why the picker serves its own
  // configuration phase rather than warming a body eagerly (Q6).
  function landClaimedBody (client, server, claim) {
    const target = pickTarget(server.name)
    metrics.claimLandings++
    log('pickerClaimLanding', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: claim.body,
      server: claim.server,
      target: target === null ? null : target.host + ':' + target.port
    })
    if (target === null) {
      // A row this lane offers but cannot read as an address.
      restoreClaimedPicker(client, claim, 'no_address')
      return
    }
    let pending = null
    try {
      pending = connectClaimedBody === null
        ? { connected: false, reason: 'no_lander' }
        : connectClaimedBody({
          body: claim.body,
          server: claim.server,
          target,
          name: client.username ?? null
        })
    } catch (error) {
      pending = { connected: false, reason: 'landing_threw', detail: String(error?.message ?? error).slice(0, 200) }
    }
    Promise.resolve(pending).then(
      outcome => settleClaimedBody(client, claim, outcome ?? { connected: false, reason: 'no_answer' }),
      error => settleClaimedBody(client, claim, {
        connected: false,
        reason: 'landing_rejected',
        detail: String(error?.message ?? error).slice(0, 200)
      })
    )
  }

  // The body did not let the client in, in any of the three ways that happens: an
  // address its row cannot give, a dial refused or never warmed, and a warm body
  // with nothing cached. One place answers all three, so the count, the log line
  // and the sentence cannot drift apart. The client reads the list again, titled
  // with the body that did not answer, and its claim stands (#267), so it may click
  // Claim again.
  function restoreClaimedPicker (client, claim, reason, detail = null) {
    metrics.claimRestored++
    log('pickerClaimRestored', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: claim.body,
      server: claim.server,
      reason,
      detail
    })
    sendPickerDialog(client, { title: claimRestoreTitle({ server: claim.server }) })
  }

  // The dial answered. A body that is up continues the client's own phase; one
  // that is not offers the list again. A client that left while the body dialled
  // holds nothing, and its claim went with the connection, so there is nothing to
  // answer.
  function settleClaimedBody (client, claim, outcome) {
    if (clients.get(client)?.ended === true) {
      log('pickerClaimAbandoned', {
        username: client.username ?? null,
        body: claim.body,
        server: claim.server,
        reason: outcome?.reason ?? null
      })
      return
    }
    if (outcome.connected !== true) {
      restoreClaimedPicker(client, claim, outcome.reason ?? 'body_unreachable', outcome.detail ?? null)
      return
    }
    landClaimedClient(client, claim, outcome)
  }

  // The body is up and its configuration is cached. The client's phase, which the
  // baseline opened and the dialog held, continues with that body's own frames and
  // ends with the one finish frame a client reads once. The client's answer to it
  // is what reaches playerJoin, where the core replays this body's play state on
  // the connection the client already holds.
  function landClaimedClient (client, claim, outcome) {
    // The channel opens before the body's frames go out, so every one of them is
    // counted on the channel that received it: a landing that fails half way must
    // leave a record of what the client was sent (#269).
    const channel = openChannel(client, { role: CHANNEL_ROLES.DRIVER, body: claim.body })
    const sent = sendBodyConfiguration(client)
    if (sent.frames === 0) {
      // A body the core reports warm with nothing cached is a body no client can
      // be put into, and it is answered like an unreachable one.
      if (channel !== null) closeChannel(client)
      restoreClaimedPicker(client, claim, 'no_cached_configuration')
      return
    }
    const written = sent.written
    leavePicker(client)
    metrics.claimLanded++
    log('pickerClaimLanded', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: claim.body,
      server: claim.server,
      target: outcome.target ?? null,
      frames: written,
      warm: outcome.warm ?? null
    })
    try {
      client.write('finish_configuration', {})
    } catch (error) {
      log('pickerClaimFinishFailed', {
        body: claim.body,
        server: claim.server,
        error: String(error?.message ?? error).slice(0, 200)
      })
      endConfiguration(client, 'claim_failed', claimFailureText({ server: claim.server }))
    }
  }

  // #269: the dialog is over. Once a client is landed in a body it is a channel on
  // that body and not a picker client, so its frames take the serverbound path: the
  // driver's to the core, a spectator's dropped as a spectator's. A picker client's
  // frames are dialog clicks and nothing else, which is why a landing that kept the
  // flag would leave its driver unable to drive.
  function leavePicker (client) {
    const ctx = clients.get(client)
    if (ctx) ctx.picker = false
  }

  // #269: land a client this leg holds in a body as that body's spectator. The core
  // owns the body, so it answers whether the body this call names is the one it
  // serves; the leg then opens the client's spectator channel and continues its own
  // configuration phase with that body's frames, exactly as a landing does. Nothing
  // is asked of the client and nothing is sent to it on a refusal: the call answers
  // with the sentence to give it, and the caller that asked (the picker's Spectate,
  // #259) decides how to say it. Three reasons have three sentences, because "claim
  // it first", "wait" and "this lane is not serving it" ask for different things.
  function landSpectator (client, { body = null, server = null } = {}) {
    const named = server ?? body
    const answer = spectateBodyHandler === null
      ? { watching: false, reason: 'no_spectator_sink' }
      : spectateBodyHandler({ body, server: named, name: client.username ?? null })
    const refused = reason => ({
      watching: false,
      reason,
      text: spectateRefusalText({ server: named, reason })
    })
    if (answer?.watching !== true) {
      metrics.pickerRefusals++
      const outcome = refused(answer?.reason ?? 'unwatchable')
      log('spectateRefused', {
        username: client.username ?? null,
        body,
        server: named,
        reason: outcome.reason,
        text: outcome.text
      })
      return outcome
    }
    const channel = openChannel(client, {
      role: CHANNEL_ROLES.SPECTATOR,
      body: typeof answer.body === 'string' ? answer.body : body
    })
    if (channel === null) return refused('channel_refused')
    const sent = sendBodyConfiguration(client)
    if (sent.frames === 0) {
      closeChannel(client)
      return refused('no_cached_configuration')
    }
    leavePicker(client)
    metrics.spectateLandings++
    log('spectateLanded', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      channel: channel.id,
      body: channel.body,
      server: named,
      frames: sent.written
    })
    try {
      client.write('finish_configuration', {})
    } catch (error) {
      log('spectateFinishFailed', {
        body: channel.body,
        server: named,
        error: String(error?.message ?? error).slice(0, 200)
      })
      return refused('finish_failed')
    }
    return { watching: true, reason: null, text: null, channel: channel.id, body: channel.body, frames: sent.written }
  }

  // #269: a body's own configuration frames, in the phase the baseline opened and
  // the dialog held. The cache holds the body's finish frame and the phase ends
  // with exactly one, so it is dropped here: a second finish arrives after the
  // client is in play, where its id is another packet's, and the client reads it
  // as one. A claim and a spectator both enter a body this way, which is why it is
  // one function: a client's configuration must not depend on its role. Its play
  // state differs in one way only, and the core writes that: the two frames that
  // tell a spectator what it is (#259).
  function sendBodyConfiguration (client) {
    const frames = replayableConfigFrames().filter(frame => frame.name !== 'finish_configuration')
    let written = 0
    for (const frame of frames) {
      const sent = emitCheckedRaw({
        client,
        buffer: frame.buffer,
        meta: { state: 'configuration', name: frame.name },
        wireCheck,
        wireMode,
        stats: wireStats,
        log
      })
      if (sent) {
        written++
        noteDelivered(client, { state: 'configuration', name: frame.name })
      }
    }
    return { frames: frames.length, written }
  }

  // #267: the claim as the callback and the log both read it. One mapper, so the
  // report a caller receives and the line an operator reads cannot drift apart.
  function claimReport (outcome) {
    return {
      granted: outcome.ok,
      repeated: outcome.repeated === true,
      reason: outcome.reason,
      claimedBy: outcome.claim?.name ?? null
    }
  }

  // #267: one claim, recorded where the client answers. The refusal carries the
  // claim that stands in the way, and the sentence for it, so the caller answers
  // the client and this stays the one place a claim is recorded.
  function recordClaim (client, server) {
    const outcome = claims.claim({
      body: server.slug,
      server: server.name,
      holder: holderFor(client),
      name: client.username ?? null,
      at: Date.now()
    })
    const fields = {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: server.slug,
      server: server.name,
      ...claimReport(outcome)
    }
    if (outcome.ok) {
      if (outcome.repeated !== true) metrics.pickerClaims++
      log('pickerClaim', fields)
      return { ...outcome, text: null }
    }
    metrics.pickerRefusals++
    const text = claimRefusalText({
      reason: outcome.reason,
      server: server.name,
      holder: outcome.claim?.name ?? null,
      claimed: outcome.reason === CLAIM_REFUSAL.HELD ? outcome.claim?.server ?? null : null
    })
    log('pickerClaimRefused', { ...fields, text })
    return { ...outcome, text }
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
    const channel = channelFor(client)
    // #269: a spectator is not an attach. The body is already delivered to its
    // driver, so the client is handed that body's play state on its own channel and
    // the session is not touched: watching is not driving, and a second attach would
    // make it one.
    if (channel !== null && channel.role === CHANNEL_ROLES.SPECTATOR) {
      const watched = spectatorAttachHandler === null
        ? { watching: false, reason: 'no_spectator_sink' }
        : spectatorAttachHandler({
          name: client.username ?? null,
          uuid: client.uuid ?? null,
          channel: channel.id
        })
      if (watched?.watching !== true) {
        log('spectateFailed', {
          username: client.username ?? null,
          uuid: client.uuid ?? null,
          body: channel.body,
          reason: watched?.reason ?? 'no_answer'
        })
        try { client.end(`spectate refused (${watched?.reason ?? 'no_answer'})`) } catch { /* already gone */ }
        return
      }
      channels.markReplay(channel.id)
      metrics.spectatorJoins++
      log('spectated', {
        username: client.username ?? null,
        uuid: client.uuid ?? null,
        channel: channel.id,
        body: channel.body,
        frames: watched.frames ?? null,
        replayed: watched.replayed ?? null
      })
      return
    }
    // The driver, and a client this lane admitted without one. The core's session is
    // the one authority left: it answers `already_attached` when a driver already
    // holds the body, and a lane that refuses its client is a lane whose session said
    // no (#269: the claim refuses a rival in a picker lane, and the session does it
    // where there is no claim to make).
    // The channel has to exist before the core replays: the replay is written
    // synchronously, and it goes to the channels this leg holds. A client the session
    // accepts without one — its login was admitted while another connection still held
    // the body, and that connection failed before the core answered this one — gets its
    // channel here, or its replay would be written to no socket at all.
    const held = channelFor(client) ?? openChannel(client, { role: CHANNEL_ROLES.DRIVER })
    const outcome = coreAttach({ name: client.username, uuid: client.uuid })

    if (!outcome.attached) {
      log('attachFailed', { username: client.username, uuid: client.uuid, reason: outcome.reason })
      client.end(`attach denied (${outcome.reason})`)
      return
    }
    // The core just replayed the body's play state on this socket, so this channel has
    // been handed its one replay.
    if (held !== null) channels.markReplay(held.id)
    metrics.attaches++
    log('attached', { username: client.username, uuid: client.uuid, replayed: outcome.replayed })
  }

  // #258: the body a claim dials. Set by the core when the lane can serve a
  // picker, so a role that never wired it refuses the landing in words rather than
  // waiting for an answer nobody sends.
  let connectClaimedBody = null

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
      // #269: a spectator changes nothing. Its frames never reach the core's
      // pipeline, so nothing it sends can drive the body, speak as the puppet, or
      // answer a dialog on the body's behalf. Counted, because a client whose input
      // is refused should be able to say so.
      const channel = channelFor(client)
      if (channel !== null && channel.role === CHANNEL_ROLES.SPECTATOR) {
        metrics.spectatorFramesDropped++
        log('spectatorFrameDropped', { username: client.username ?? null, state: meta.state, name: meta.name })
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
        // #258: a landing that is still dialling when the client leaves writes to
        // nothing. The claim ends with the connection (#267), so the mark is all
        // the answer a late dial needs.
        ctx.ended = true
      }
      // #267: the claim is held by the connection that made it, so it ends with the
      // connection. A client that never claimed releases nothing.
      const released = claims.release(holderIds.get(client))
      if (released !== null) {
        log('pickerClaimReleased', {
          username: client.username ?? null,
          uuid: client.uuid ?? null,
          body: released.body,
          server: released.server,
          claimedBy: released.name,
          reason: String(reason).slice(0, 160)
        })
      }
      // #269: the channel ends with its connection. The driver's channel closing is a
      // detach, because the body outlives the player. A spectator's channel closing
      // ends a spectator and nothing else, because the body was never theirs.
      const closed = closeChannel(client)
      if (closed !== null && closed.role === CHANNEL_ROLES.DRIVER) {
        log('frontDetach', { reason: String(reason).slice(0, 160), attached: true, channels: channels.size })
        detachHandler?.({ reason: String(reason) })
      } else if (closed !== null && closed.role === CHANNEL_ROLES.SPECTATOR) {
        // #259: a spectator leaving is the end of a spectator and nothing else. The
        // body was never theirs, so the core is told only so it can stop relaying
        // when nobody is left to receive.
        log('frontClientEnd', {
          reason: String(reason).slice(0, 160),
          attached: false,
          role: closed.role,
          channels: channels.size
        })
        spectatorLeftHandler?.({ channel: closed.id, name: closed.name })
      } else if (closed !== null || clients.has(client)) {
        log('frontClientEnd', {
          reason: String(reason).slice(0, 160),
          attached: false,
          role: closed === null ? null : closed.role,
          channels: channels.size
        })
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
      const channel = channelFor(client)
      // #269: every channel records its own information, so two clients on one body
      // hold two records and neither can overwrite the other. Only the driver's
      // reaches the core, and only outside play (#18): a play-state change travels
      // the serverbound pipeline, where the core rewrites it with the backend's cap.
      if (channel === null) {
        log('clientInformationNoChannel', { username: client.username ?? null, state })
        return
      }
      channels.settings(channel.id, data, { at: Date.now() })
      if (channel.role !== CHANNEL_ROLES.DRIVER) {
        metrics.spectatorSettings++
        log('spectatorClientInformation', {
          username: client.username ?? null,
          state,
          channel: channel.id,
          locale: data?.locale ?? null
        })
        return
      }
      if (!reportsClientInformation({ role: channel.role, state })) {
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
    // A reconfiguration is the driver's: it is the body's own connection, and a
    // spectator is handed the restored state like any other body stream (#269).
    const driver = driverClient()
    if (!driver) return { started: false, reason: 'no_client' }
    const ctx = clients.get(driver)
    if (ctx?.pendingReconfiguration) {
      log('frontReconfigureRefused', { reason: 'already_reconfiguring' })
      return { started: false, reason: 'already_reconfiguring' }
    }
    if (driver.state !== 'play') {
      log('frontReconfigureRefused', { reason: 'client_not_in_play', state: driver.state })
      return { started: false, reason: 'client_not_in_play', state: driver.state }
    }
    try {
      driver.write('start_configuration', {})
    } catch (error) {
      log('frontReconfigureWriteFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { started: false, reason: 'write_failed' }
    }
    if (ctx) {
      ctx.pendingReconfiguration = { frames: [], dropped: 0 }
      ctx.reconfiguring = false
    }
    metrics.reconfigurations++
    log('frontReconfiguration', { reason, username: driver.username ?? null })
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
      const sent = emitCheckedRaw({ client, buffer: frame.buffer, meta: frame.meta, wireCheck, wireMode, stats: wireStats, log })
      if (sent) noteDelivered(client, frame.meta)
    }
    metrics.reconfigurationFramesFlushed += pending.frames.length
    log('frontReconfigurationAcknowledged', {
      username: client.username ?? null,
      flushedFrames: pending.frames.length,
      droppedFrames: pending.dropped
    })
    return { acknowledged: true, flushed: pending.frames.length }
  }

  // --- #269: delivery, one channel at a time ---

  // The library-serialized packet path (the synthesized position, the skin, a
  // notice). The wire checker guards raw frames in writeRawTo; a packet object
  // cannot carry trailing bytes.
  function writePacketTo (client, name, packet) {
    if (!client || typeof client.write !== 'function') return false
    client.write(name, packet)
    noteDelivered(client, { state: client.state === 'configuration' ? 'configuration' : 'play', name })
    return true
  }

  // One frame, to one client. Everything on this path is per socket — the
  // clientbound policy backstop, the reconfiguration hold, the state check, the wire
  // check — so a body with two channels does the work twice, and neither client can
  // be handed a frame in a state it cannot parse.
  function writeRawTo (client, buffer, meta = null) {
    if (!client) return false
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
    const pending = clients.get(client)?.pendingReconfiguration
    if (pending && client.state === 'play' && meta?.state === 'configuration') {
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
    if (meta?.state && client.state && meta.state !== client.state) {
      metrics.stateRefused++
      log('clientboundStateMismatch', {
        name: meta.name,
        frameState: meta.state,
        clientState: client.state
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
      const ctx = clients.get(client)
      if (ctx?.interceptor?.finishFromCore()) {
        log('configFinishedByCore', { username: client.username ?? null })
      }
    }
    const sent = emitCheckedRaw({ client, buffer, meta, wireCheck, wireMode, stats: wireStats, log })
    if (sent) noteDelivered(client, meta)
    return sent
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
    // #258: the body a claim dials. The core wires this when it starts, so a leg
    // built without a core refuses every landing instead of waiting for an answer
    // nobody sends.
    setConnectClaimedBody (fn) { connectClaimedBody = typeof fn === 'function' ? fn : null },
    // #269: the spectator's two call-ins. The core wires them in its own start(), so
    // a leg built without a core refuses the Spectate verb in words instead of
    // waiting for an answer nobody sends.
    setSpectateBody (fn) { spectateBodyHandler = typeof fn === 'function' ? fn : null },
    setSpectatorAttach (fn) { spectatorAttachHandler = typeof fn === 'function' ? fn : null },
    // #259: the body this lane serves and whether it is up, for the picker's rows.
    setBodyServed (fn) { bodyServedHandler = typeof fn === 'function' ? fn : null },
    // #259: a spectator's channel ended, so the core can stop relaying a body that
    // nobody is in play on.
    setSpectatorLeft (fn) { spectatorLeftHandler = typeof fn === 'function' ? fn : null },
    // #269: land one of this leg's connections in a body as its spectator, and answer
    // with what happened. The player is named rather than the socket because the
    // caller is the lane's, not the socket's: #259 wires the picker's Spectate to
    // this, and a rung stands in for it until then. A refusal carries the sentence for
    // the client, so the surface that shows it stays the caller's to decide.
    spectate ({ username = null, body = null, server = null } = {}) {
      const client = typeof username === 'string'
        ? [...clients.keys()].find(entry => entry.username === username) ?? null
        : null
      if (client === null) {
        return {
          watching: false,
          reason: 'no_client',
          text: spectateRefusalText({ server: server ?? body })
        }
      }
      return landSpectator(client, { body, server })
    },
    // #269: a clientbound write goes to the body's channels: its driver, and every
    // spectator watching that body. `channel` addresses one of them, which is what a
    // spectator's own replay uses so the driver is never handed it twice.
    write (name, packet, { channel = null } = {}) {
      return deliverEach(channel, client => writePacketTo(client, name, packet), { name }) > 0
    },
    writeRaw (buffer, meta = null, { channel = null } = {}) {
      return deliverEach(channel, client => writeRawTo(client, buffer, meta), { name: meta?.name ?? null }) > 0
    },
    end (reason) {
      // A body that ends ends every channel watching it: the driver and its
      // spectators hold connections to a body that is gone.
      for (const channel of channels.snapshot()) {
        const client = clientOfChannel(channel.id)
        try { client?.end(reason) } catch { /* client already gone */ }
      }
    },
    get listening () { return Boolean(server) },
    // #269: the channels this leg holds, one record per connection delivered a
    // body: its role, what it has been sent, and its own client information. A lane
    // that never lands a client keeps this empty.
    get channels () { return channels.snapshot() },
    // The socket the body is delivered to. A caller that needs the connection rather
    // than its delivery record reads this; it is the driver's channel's client, and
    // null when nobody holds the body.
    get driver () { return driverClient() },
    // #267: the claims this leg holds, one per body. A lane that never serves a
    // picker never records one, so this stays empty there.
    get claims () { return claims.snapshot() },
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

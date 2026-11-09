// B1 monoplayer core: product-shaped composition root.
//
// The protocol spike (src/spike/proxy.js) is frozen; this module is where the product
// lives. Everything real-scoped is injected: the front-leg and backend-leg
// adapters (interface below, fakes in src/legs/fake-legs.js) and the
// clock. With no --start flag the CLI never opens a socket and no Microsoft
// auth is touched — B1 is the pure core plus fake integration only.
//
// Adapter interfaces (real legs, built in G1/M4, implement these):
//
//   backendLeg = {
//     connect(): Promise                          // starts the puppet session
//     setFrameHandler(({ state, name, buffer, data }): void)
//     setEndHandler(({ reason }): void)           // backend hangup/fault
//     setErrorHandler(({ error }): void)
//     write(name, packet)                         // serverbound, packet level
//     writeRaw(buffer, meta)                      // serverbound, frame level
//     chat(text): void                            // sign and send as the puppet
//     end(reason)                                 // deliberate close
//   }
//
// `chat` is optional: a leg without it drops the human's chat and counts it.
// The leg owns the signing, because the signature needs the puppet's profile
// keys and the puppet connection's own last-seen window, and neither belongs to
// the core.
//
//   frontLeg = {                                  // one attaching client
//     setLoginStartHandler(({ uuid, name }): decision[])   // -> whitelist review
//     setServerboundHandler(({ state, name, buffer, data }): void)
//     setDetachHandler(({ reason }): void)
//     write(name, packet, { synth })              // clientbound, packet level
//     writeRaw(buffer, meta)                      // clientbound, frame level
//     end(reason)                                 // kick/deny the client
//   }

import { createStateCache, WARM_MARKER } from '../core/state-cache.js'
import {
  FABRIC_BRAND,
  brandFrame,
  capFromLogin,
  chunkBoundFor,
  mergeClientSettings,
  normalizeClientSettings
} from '../core/client-settings.js'
import { createFrontIdentity } from '../core/identity.js'
import { synthAttach } from '../core/join-synth.js'
import { noticeFrames, noticeId, systemChatFrame } from '../core/notice.js'
import { classifyServerbound, capturePose, chatText } from '../core/relay.js'
import { CHAT_FRAMES, chatRelayAllowed, clientboundPolicy, DECISION } from '../core/clientbound-policy.js'
import { createPendingDialog } from '../core/pending-dialog.js'
import { createSession, STATES } from '../core/session.js'
import { redact, SENTINEL } from '../observability/redact.js'
import { pathToFileURL } from 'node:url'

// --- config ---

export const DEFAULT_CONFIG = Object.freeze({
  version: '26.1',
  // 'read-only': relay clientbound chat to the attached client, drop the
  // client's own text.
  // 'full' (#19): also speak the client's chat and commands on the backend leg
  // as the puppet, with the puppet's own profile keys and window, and relay the
  // server's signed player chat back. Not the default: the signed path needs a
  // live run on the deployed backend to prove it, because a leg without profile
  // keys sends an unsigned frame that a secure-profile server rejects by
  // closing the connection. `chatCapability` in the log answers that question.
  // 'off': drop clientbound chat as well.
  chat: 'read-only',
  front: Object.freeze({ host: '127.0.0.1', port: 25565 }),
  backend: Object.freeze({ host: '127.0.0.1', port: 25565 }),
  puppet: Object.freeze({
    // Assertions, not selectors: when set, the resolved account must match.
    username: null,
    uuid: null,
    // Account selector: UUID, alias, or profile name.
    account: null,
    // G1 token custody (field names only; tokens never appear in config):
    accountsDir: '.secrets/accounts',
    // Raw directory override (deprecated) and its legacy selector.
    cacheDir: null,
    cacheAccount: null
  }),
  // Configuration-phase gate answer: first, last, or a label substring (#21).
  // It never answers a play dialog, which belongs to the human (#20). Null
  // leaves the gate unanswered and a headless leg waits.
  dialogAction: null,
  attachWhitelist: Object.freeze([]),
  attachWhitelistFile: '.secrets/attach-whitelist.json',
  bounds: Object.freeze({
    maxPrefix: 8192,
    maxConfig: 1024,
    maxChunks: 1024,
    maxBlocks: 2048,
    maxEntities: 2048,
    maxInventories: 32,
    maxGeneric: 512
  }),
  reconnect: Object.freeze({ delayMs: 1000, attempts: 1, maxDelayMs: 60_000 }),
  transfer: Object.freeze({
    // Follow a backend transfer on the puppet leg. The front client is always
    // detached; it rejoins the proxy after the puppet is warm on the target.
    follow: true,
    // A chain deeper than this, or a repeated target, is refused.
    chainLimit: 8,
    // After this long on one server, the chain history resets, so a later
    // transfer to a previously visited server is allowed again.
    chainResetMs: 120_000
  }),
  redaction: Object.freeze({ sentinel: SENTINEL })
})

const CHAT_MODES = new Set(['full', 'read-only', 'off'])

export function loadConfig (doc = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...doc,
    bounds: { ...DEFAULT_CONFIG.bounds, ...(doc.bounds ?? {}) },
    reconnect: { ...DEFAULT_CONFIG.reconnect, ...(doc.reconnect ?? {}) },
    transfer: { ...DEFAULT_CONFIG.transfer, ...(doc.transfer ?? {}) },
    front: { ...DEFAULT_CONFIG.front, ...(doc.front ?? {}) },
    backend: { ...DEFAULT_CONFIG.backend, ...(doc.backend ?? {}) },
    puppet: { ...DEFAULT_CONFIG.puppet, ...(doc.puppet ?? {}) }
  }
  if (!Array.isArray(merged.attachWhitelist)) {
    throw new TypeError('config.attachWhitelist must be an array of UUIDs')
  }
  if (!CHAT_MODES.has(merged.chat)) {
    throw new TypeError("config.chat must be 'full', 'read-only', or 'off'")
  }
  if (typeof merged.transfer.follow !== 'boolean') {
    throw new TypeError('config.transfer.follow must be a boolean')
  }
  if (!Number.isInteger(merged.transfer.chainLimit) || merged.transfer.chainLimit < 1) {
    throw new TypeError('config.transfer.chainLimit must be a positive integer')
  }
  if (!Number.isFinite(merged.transfer.chainResetMs) || merged.transfer.chainResetMs < 0) {
    throw new TypeError('config.transfer.chainResetMs must be a non-negative number')
  }
  return merged
}

// --- core ---

// Telemetry and journal defaults: inert objects, so a core built without them
// behaves exactly as before (no timers, no sockets, no files).
const NOOP_TELEMETRY = Object.freeze({
  enabled: false,
  log () {},
  metric () {},
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
  stats: () => ({ enabled: false })
})
const NOOP_JOURNAL = Object.freeze({
  enabled: false,
  frame () {},
  event () {},
  close () {},
  stats: () => ({ enabled: false })
})

export function createMonoplayer ({
  config = loadConfig(),
  backendLeg,
  frontLeg,
  clock,
  logStream = null,
  telemetry = NOOP_TELEMETRY,
  journal = NOOP_JOURNAL
} = {}) {
  if (!backendLeg) throw new TypeError('backendLeg adapter is required')
  if (!frontLeg) throw new TypeError('frontLeg adapter is required')

  const cfg = config

  const cache = createStateCache(cfg.bounds)
  const identity = createFrontIdentity({
    attachWhitelist: cfg.attachWhitelist,
    puppetProfile: cfg.puppet
  })
  const session = createSession({
    clock,
    reconnectDelayMs: cfg.reconnect.delayMs,
    reconnectPolicy: {
      attempts: cfg.reconnect.attempts ?? 1,
      maxDelayMs: cfg.reconnect.maxDelayMs ?? 60_000
    },
    // The core announces the due reconnect; the adapter/orchestrator owns the
    // actual backend connect (the core never touches the backend leg here).
    onReconnect: ({ delayMs, attempt }) => {
      const target = pendingTransfer
      pendingTransfer = null
      emit('reconnect_due', { delayMs, attempt, target })
    }
  })

  const metrics = {
    backendFrames: 0,
    configFrames: 0,
    framesCached: 0,
    framesReplayed: 0,
    positionsSynthesized: 0,
    serverboundForwarded: 0,
    serverboundDropped: 0,
    serverboundNotAttached: 0,
    serverboundByName: {},
    serverboundDroppedByName: {},
    chatBlocked: 0,
    chatRelayed: 0,
    chatSent: 0,
    clientboundBlocked: 0,
    clientboundBlockedByName: {},
    clientboundUnclassified: 0,
    transfersBlocked: 0,
    transfersFollowed: 0,
    transfersRefused: 0,
    noticesSent: 0,
    noticeFallbacks: 0,
    noticeGhosts: 0,
    bundleDelimitersDropped: 0,
    nonPlayFramesIgnored: 0,
    resourcePackAcks: 0,
    resourcePackAckFailures: 0,
    brandAnnounced: 0,
    attachesConfiguring: 0,
    configFramesRelayed: 0,
    controlDialogsShown: 0,
    controlDialogsCleared: 0,
    controlDialogsRelayed: 0,
    controlDialogsHeld: 0,
    controlDialogsResent: 0,
    controlDialogsAnswered: 0,
    controlDialogsPuppetAnswered: 0,
    clientSettingsSent: 0,
    clientSettingsRewritten: 0,
    clientSettingsFailed: 0,
    attaches: 0,
    denials: 0,
    frontKicks: 0
  }

  // Bounded per-name counters. Packet names are a fixed protocol vocabulary,
  // so the cap only guards against a client sending nonsense names.
  const MAX_NAMES = 128
  function bumpName (map, name) {
    const key = name ?? 'unknown'
    if (map[key] !== undefined) { map[key]++; return }
    if (Object.keys(map).length >= MAX_NAMES) { map.other = (map.other ?? 0) + 1; return }
    map[key] = 1
  }
  // Interactions are rare and are the ones that fail silently on a real
  // backend, so each one gets its own log line (name only, no payload).
  const ACTION_SERVERBOUND = new Set([
    'use_item', 'block_place', 'block_dig', 'use_entity', 'attack',
    'held_item_slot', 'window_click', 'close_window', 'set_creative_slot',
    'set_slot_state', 'select_bundle_item', 'pick_item_from_block',
    'pick_item_from_entity', 'arm_animation', 'player_loaded', 'player_input'
  ])

  // Connection-control frames that are worth one log line each. Chat stays
  // out: a blocked signed chat frame is counted, not logged per message.
  const LOGGED_BLOCKS = new Set([
    'start_configuration',
    'kick_disconnect',
    'cookie_request',
    'store_cookie',
    'disconnect'
  ])
  const TRANSFER_REFUSED_NOTICE =
    '[Monoplayer] The server asked to move this session elsewhere. ' +
    'The proxy could not follow it, so you stay on the current server.'
  const TRANSFER_FOLLOW_REASON =
    'This session is moving. Reconnect in a few seconds to continue.'
  const RECONFIGURE_REASON =
    'The server reconfigured this session. Reconnect in a few seconds.'

  const logs = [] // redacted JSON lines, bounded
  const listeners = new Map() // type -> Set<fn>
  const unclassifiedLogged = new Set()
  let started = false
  let attached = false // a client holds the attach slot (configuring or attached)
  // #16: the pre-warm early attach. `backendConfiguring` is true from the
  // backend's first configuration frame until its play login. `earlyAttach`
  // holds the client that attached during that window; `pendingEarlyReplay`
  // holds the replay it still needs. `frontPlayReady` says the attached
  // client itself finished its configuration and can take play frames.
  let backendConfiguring = false
  let earlyAttach = null
  let pendingEarlyReplay = null
  let frontPlayReady = false
  let brandAnnounced = false // #17: one brand per backend connection
  let backendViewDistance = null // #18: the backend's advertised cap, this connection
  // #18: the last human's client information. It survives a detach, like a
  // real client's options survive a reconnect; only a fresh process starts from
  // the defaults.
  let humanClientSettings = null
  let frontTeleportSeq = 0 // proxy-owned teleport IDs
  let transferNoticeSent = false // one refusal notice per attach
  let noticeSeq = 0 // one advancing id per notice, so a removal names its own
  let reconfigureRequested = false // this backend end is a server reconfiguration
  let pendingTransfer = null // target for the next reconnect_due
  // #16: the last control dialog the human has not answered. It survives a
  // detach and is re-sent on attach. A control dialog is neither cached nor
  // replayed, so this is the one copy and a replay cannot deliver a stale one.
  const pendingDialog = createPendingDialog()
  // #16: the state of a dialog the puppet answered itself (the configuration
  // gate click, #21) on this connection. The leg answers the frame before the
  // core sees it, so the core consumes this marker instead of holding a
  // question that is already closed.
  let puppetAnsweredDialog = null
  const transferChain = { visited: new Set(), depth: 0, resetTimer: null }

  function log (event, fields = {}) {
    const line = redact(JSON.stringify({ t: clock?.now?.() ?? Date.now(), event, ...fields }))
    logs.push(line)
    if (logs.length > 4096) logs.shift()
    if (logStream) logStream.write(line + '\n')
    emit('log', { line })
    // Lifecycle records only: one OTLP log per core log call, never per frame.
    telemetry.log({ event, fields })
  }

  function emit (type, payload) {
    const set = listeners.get(type)
    if (set) for (const fn of set) fn(payload)
  }

  function on (type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  }

  function isAttached () {
    return attached && (session.state === STATES.ATTACHED || session.state === STATES.CONFIGURING)
  }

  // Live play frames only go to a front client that is in play. A pre-warm
  // early attach is still finishing its configuration; a play frame sent
  // before that would be parsed as a configuration frame by the client.
  function canRelayPlay () {
    return attached && session.state === STATES.ATTACHED && frontPlayReady
  }

  // --- front-leg login pipeline (pure decisions; adapter owns kick/close IO) ---

  // Whitelist review: Login Start. Denied here, i.e. strictly before
  // Login Success can ever be sent for that connection. The backend readiness
  // gate sits here too: a client that logs in while the puppet has no backend
  // session would be handed an incomplete configuration and crash in registry
  // loading, so deny early with a reason the front turns into a clear kick.
  function processLoginStart (payload = {}) {
    const decision = identity.reviewLoginStart(payload)
    if (!decision.allowed) {
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: decision.reason, phase: decision.phase })
      log('attachDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid })
      emit('attach_denied', decision)
      return decision
    }
    // Warm/WARM-or-DETACHED is the attach-ready set. A second login while
    // already attached still passes here so attachPlayer can answer
    // 'already_attached' with the reason the caller expects.
    // #16: a client may also attach while the backend connection is still in
    // its configuration phase. It follows the puppet's configuration stream
    // and lands in play when the backend logs in.
    const canAttachConfiguring = backendConfiguring && session.state === STATES.BOOT
    if (!session.isAttachReady() && session.state !== STATES.ATTACHED && !canAttachConfiguring) {
      const denied = {
        allowed: false,
        reason: 'backend_not_ready',
        phase: decision.phase,
        uuid: payload.uuid,
        name: payload.name
      }
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: denied.reason, phase: denied.phase })
      log('attachDenied', { reason: denied.reason, phase: denied.phase, uuid: payload.uuid })
      emit('attach_denied', denied)
      return denied
    }
    return canAttachConfiguring ? { ...decision, phase: 'configuring' } : decision
  }

  // Session verification (only when a verifier was injected): hasJoined.
  async function processVerifySession (payload = {}) {
    const decision = await identity.verifySession(payload)
    if (!decision.allowed) {
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: decision.reason, phase: decision.phase })
      log('verifyDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid, name: payload.name })
      emit('verify_denied', decision)
      return decision
    }
    if (!session.isAttachReady() && session.state !== STATES.ATTACHED) {
      const denied = {
        allowed: false,
        reason: 'backend_not_ready',
        phase: decision.phase,
        uuid: decision.uuid ?? payload.uuid,
        name: decision.name ?? payload.name
      }
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: denied.reason, phase: denied.phase })
      log('verifyDenied', { reason: denied.reason, phase: denied.phase, uuid: denied.uuid, name: denied.name })
      emit('verify_denied', denied)
      return denied
    }
    return decision
  }

  // The puppet never renders a resource pack, but the backend keeps a
  // per-player pack status, and server logic that ships a custom UI inside the
  // pack can read it. Answer as a client that accepted the pack and finished
  // loading it (3 = accepted, 0 = successfully loaded). The attaching client
  // gets the same request in the replay and downloads the pack for real.
  function answerResourcePack (data = {}) {
    metrics.resourcePackAcks++
    const uuid = data.uuid ?? data.id
    try {
      backendLeg.write('resource_pack_receive', { uuid, result: 3 })
      backendLeg.write('resource_pack_receive', { uuid, result: 0 })
      log('resourcePackAck', { uuid, result: 'accepted+loaded' })
    } catch (error) {
      metrics.resourcePackAckFailures++
      log('resourcePackAckFailed', { error: String(error?.message ?? error) })
    }
  }

  // #17: servers record the client brand in the configuration phase, and a
  // missing brand is one of the tells that the connection is not a normal
  // client. Announce Fabric Loader on the first configuration frame of every
  // backend connection. The human's brand never replaces it: the front client's
  // brand belongs to a different connection and never crosses.
  function announceBrand () {
    if (brandAnnounced) return { announced: false, reason: 'already_announced' }
    brandAnnounced = true
    const frame = brandFrame()
    try {
      backendLeg.write(frame.name, frame.packet)
      metrics.brandAnnounced++
      log('brandAnnounced', { channel: frame.packet.channel, brand: FABRIC_BRAND })
      return { announced: true }
    } catch (error) {
      // A dead leg during teardown must not consume this connection's one
      // announcement: retry on the next configuration frame.
      brandAnnounced = false
      log('brandAnnounceFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { announced: false, reason: 'write_failed' }
    }
  }

  // #18: write the client's information with the backend's view distance. The
  // human's locale, skin parts, main hand, and chat settings pass through; the
  // view distance is always the cap, so the server never shrinks the chunk send
  // to the human's local render distance.
  function sendClientSettings (reason) {
    if (backendViewDistance === null) return { sent: false, reason: 'no_backend_view_distance' }
    const packet = mergeClientSettings(humanClientSettings, backendViewDistance)
    try {
      backendLeg.write('settings', packet)
      metrics.clientSettingsSent++
      log('clientSettingsSent', {
        reason,
        attached: isAttached(),
        viewDistance: packet.viewDistance,
        locale: packet.locale,
        skinParts: packet.skinParts,
        mainHand: packet.mainHand
      })
      return { sent: true, packet }
    } catch (error) {
      metrics.clientSettingsFailed++
      log('clientSettingsFailed', { reason, error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false, reason: 'write_failed' }
    }
  }

  // The backend's play login carries the view distance it will use. Raise the
  // cache to hold that view, then ask for it: a client that requests less makes
  // the server send less, so the human's local render distance must never be
  // the value the server sees.
  function applyBackendViewDistance (loginPacket) {
    const cap = capFromLogin(loginPacket)
    backendViewDistance = cap
    if (cap === null) {
      log('backendViewDistanceMissing', {})
      return null
    }
    const chunkBound = cache.raiseChunkBound(chunkBoundFor(cap))
    log('backendViewDistance', {
      viewDistance: cap,
      chunkBound,
      chunkBytes: cache.stats().chunkBytes
    })
    sendClientSettings('backend_login')
    return cap
  }

  // The front leg reports the human client's Client Information as it arrives
  // (configuration for a joining client, play for a later change). Record it,
  // and while a human is attached send it to the backend with the cap. Before
  // an attach it is only recorded; attachPlayer sends it once the human plays.
  function noteClientSettings (data = {}) {
    const normalized = normalizeClientSettings(data)
    if (normalized === null) {
      log('clientInformationIgnored', { reason: 'no_usable_fields' })
      return { noted: false, reason: 'no_usable_fields' }
    }
    humanClientSettings = normalized
    log('clientInformation', {
      attached: isAttached(),
      locale: normalized.locale,
      requestedViewDistance: normalized.viewDistance,
      skinParts: normalized.skinParts,
      mainHand: normalized.mainHand
    })
    if (!isAttached()) return { noted: true, sent: false, reason: 'not_attached' }
    return { noted: true, ...sendClientSettings('client_information') }
  }

  // Every clientbound frame that must not cross to the front goes through
  // here: count, log the rare ones. A transfer is handled separately because
  // it has a follow decision (and a refused transfer gets the local notice).
  // The cache and join-synth consult the same policy, so this is the visible
  // half of one decision, not a separate rule.
  function blockClientbound (state, name, policy = {}) {
    metrics.clientboundBlocked++
    bumpName(metrics.clientboundBlockedByName, name)
    if (policy.unknown) {
      metrics.clientboundUnclassified++
      if (!unclassifiedLogged.has(name)) {
        unclassifiedLogged.add(name)
        log('clientboundUnclassified', { state, name })
      }
      return
    }
    if (LOGGED_BLOCKS.has(name)) log('clientboundBlocked', { state, name })
  }

  // #16: the client that can take a control dialog of `state` right now. A play
  // dialog needs a client in play; a configuration gate needs the client that
  // is still following the puppet's configuration. Sent into the wrong phase,
  // the client parses the frame as the wrong packet.
  function canReceiveControl (state) {
    if (state === 'play') return canRelayPlay()
    if (state === 'configuration') return attached && session.state === STATES.CONFIGURING
    return false
  }

  // #16: the backend leg answered a dialog itself with the configured action,
  // before the frame reached the core. The next show in that state is not a
  // question for the human.
  function notePuppetDialogAnswer ({ state = null } = {}) {
    if (state !== 'play' && state !== 'configuration') return { noted: false }
    puppetAnsweredDialog = state
    log('puppetDialogAnswer', { state })
    return { noted: true, state }
  }

  // One path for every control dialog, in play and in configuration: hold the
  // last unanswered one, relay it to the human who can answer it, and let the
  // serverbound forwarder carry the answer back as the puppet's own frame. No
  // timeout and no auto-click here: a dialog with no client waits. Which dialog
  // the human answers is decided by the leg's policy: a play dialog is always
  // the human's (#20), a configuration gate is #21's.
  function handleControlDialog ({ state, name, buffer, data = {} }) {
    // The puppet answered this one itself before the core heard about it, so
    // there is nothing to hold and no human to ask. The marker is spent here
    // either way: it belongs to exactly one show.
    const answeredByPuppet = name !== 'clear_dialog' && puppetAnsweredDialog === state
    puppetAnsweredDialog = null
    if (answeredByPuppet) {
      metrics.controlDialogsPuppetAnswered++
      log('controlDialogPuppetAnswered', { state, name })
      return { relayed: false }
    }
    if (name === 'clear_dialog') {
      // The server withdrew its question. The client showing it must see that
      // too, or the screen stays open on a dead dialog.
      const outcome = pendingDialog.clear()
      metrics.controlDialogsCleared++
      log('controlDialogCleared', { state, hadPending: outcome.dropped })
    } else {
      const outcome = pendingDialog.show({ state, name, buffer, data })
      metrics.controlDialogsShown++
      log('controlDialogShown', { state, name, attached: isAttached(), replaced: outcome.replaced })
    }

    if (!canReceiveControl(state)) {
      // Nothing to relay to. A shown dialog waits for a client that can answer
      // it; a withdrawal has nothing to withdraw on a client that is not there.
      if (name !== 'clear_dialog') metrics.controlDialogsHeld++
      log('controlDialogNotRelayed', { state, name, attached: isAttached() })
      return { relayed: false }
    }
    frontLeg.writeRaw(buffer, { state, name })
    metrics.controlDialogsRelayed++
    log('controlDialogRelayed', { state, name })
    emit('control_dialog', { state, name })
    return { relayed: true }
  }

  // #16: a client that just arrived in `state` receives the dialog it was not
  // there to answer. Nothing else re-delivers it, because a control dialog is
  // never cached and never replayed.
  function resendPendingDialog (state) {
    const frame = pendingDialog.forAttach(state)
    if (frame === null) {
      if (pendingDialog.held) {
        // A configuration gate and a play attach are not a delivery: the client
        // would parse the frame in its play phase. The dialog keeps waiting.
        log('controlDialogWithheld', { wanted: state, held: pendingDialog.peek()?.state ?? null })
      }
      return { sent: false }
    }
    if (!canReceiveControl(state)) {
      // The client is in the dialog's state but the puppet is not: a gate the
      // backend asked before it moved on is answered by the backend's own
      // session, not by the human (#21 owns that answer).
      log('controlDialogWithheld', {
        wanted: state,
        held: frame.state,
        reason: 'puppet_state',
        backendConfiguring
      })
      return { sent: false }
    }
    try {
      frontLeg.writeRaw(frame.buffer, { state: frame.state, name: frame.name })
    } catch (error) {
      log('controlDialogResendFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false }
    }
    metrics.controlDialogsResent++
    log('controlDialogResent', { state: frame.state, name: frame.name })
    return { sent: true }
  }

  // One accounting for every chat frame the backend never receives, whether it
  // was dropped by policy, carried no text, or the leg could not send it. Kept
  // in one place so the counters and the event cannot diverge.
  function dropChat (name, reason, fields = {}) {
    metrics.serverboundDropped++
    bumpName(metrics.serverboundDroppedByName, name)
    metrics.chatBlocked++
    log('chatBlocked', { name, reason, ...fields })
    emit('chat_blocked', { name, reason })
  }

  // A proxy notice is local proxy speech, not server speech: it never carries
  // the target address, and it is never cached, so no later attach replays it.
  //
  // The notice rides one synthetic advancement toast (#15), added and removed in
  // the same call: the add queues the toast, and the removal leaves the client's
  // advancement map as the server left it. A toast the front leg cannot write
  // falls back to a local system chat line, so a client in play always gets the
  // notice.
  //
  // The path runs in either state. With no client in play the front leg drops
  // the writes, so the call reports that it wrote nothing rather than claiming a
  // delivery nobody saw, and a caller (#22) can queue the notice for the next
  // attach.
  function sendProxyNotice (text, { reason = 'notice' } = {}) {
    // A notice with no text is a caller bug. Say so in the log instead of
    // throwing into a frame handler.
    if (typeof text !== 'string' || text.length === 0) {
      log('proxyNoticeRejected', { reason, error: 'text_required' })
      return { sent: false, kind: null, id: null }
    }
    const id = noticeId(++noticeSeq)
    if (!canRelayPlay()) {
      log('proxyNoticeUndelivered', { reason, id, error: 'no_client_in_play' })
      return { sent: false, kind: null, id }
    }
    const [add, removal] = noticeFrames({ text, id })
    let failed = null
    try {
      frontLeg.write(add.name, add.packet, { synth: true })
      frontLeg.write(removal.name, removal.packet, { synth: true })
    } catch (error) {
      failed = error
      metrics.noticeFallbacks++
      log('proxyNoticeFailed', { reason, id, error: String(error?.message ?? error) })
      // The add may have landed before the removal failed. A removal is
      // idempotent, because it deletes an id the client may never have held, so
      // a retry is the only way back to a clean advancement state.
      try {
        frontLeg.write(removal.name, removal.packet, { synth: true })
      } catch (cleanupError) {
        // Both writes failed after the add landed, so the client keeps this one
        // advancement until its state is rebuilt. The id is never reused, so no
        // later notice names it.
        metrics.noticeGhosts++
        log('proxyNoticeGhost', { reason, id, error: String(cleanupError?.message ?? cleanupError) })
      }
    }
    if (failed === null) {
      metrics.noticesSent++
      log('proxyNotice', { reason, kind: 'toast', id })
      return { sent: true, kind: 'toast', id }
    }
    try {
      const fallback = systemChatFrame(text)
      frontLeg.write(fallback.name, fallback.packet, { synth: true })
      metrics.noticesSent++
      log('proxyNotice', { reason, kind: 'chat', id })
      return { sent: true, kind: 'chat', id }
    } catch (error) {
      log('proxyNoticeLost', { reason, id, error: String(error?.message ?? error) })
      return { sent: false, kind: null, id }
    }
  }

  // The refusal notice is local proxy speech, not server speech. It never
  // carries the target address.
  function sendTransferNotice () {
    transferNoticeSent = true
    return sendProxyNotice(TRANSFER_REFUSED_NOTICE, { reason: 'transfer_refused' })
  }

  // Shared teardown for a session that cannot continue: a backend fault, a
  // server reconfiguration, or a followed transfer. The transfer branch calls
  // this synchronously before ending the leg, because a socket end event can
  // be skipped when the next connect replaces the client first.
  function teardownBackend ({ reason, kickReason = 'backend_disconnected', reconfiguring = false } = {}) {
    // Per-connection client identity (#17/#18): the next connection announces
    // its own brand and learns its own view distance. The human's client
    // information survives, because the human is still the one playing.
    brandAnnounced = false
    backendViewDistance = null
    backendConfiguring = false
    earlyAttach = null
    pendingEarlyReplay = null
    // A dialog belongs to the backend session that asked it; the next session
    // asks its own.
    pendingDialog.clear()
    puppetAnsweredDialog = null
    if (session.state === STATES.RECONNECTING) {
      const outcome = session.backendDown({ reason })
      log('backendDown', { reason, frontEnded: false, outcome, repeated: true })
      return outcome
    }
    cache.reset()
    log('cacheReset', { reason: 'backend_down', backendLogins: session.backendLogins, reconfiguring })
    if (isAttached()) {
      // Session invariant: the attaching client cannot survive the backend.
      detachedHandoff()
      session.detach({ reason: `backend_down:${reason}` })
      const outcome = session.backendDown({ reason })
      log('backendDown', { reason, frontEnded: true, outcome, reconfiguring })
      frontLeg.end(kickReason)
      emit('backend_down', { reason, target: pendingTransfer })
      return outcome
    }
    const outcome = session.backendDown({ reason })
    log('backendDown', { reason, frontEnded: false, outcome, reconfiguring })
    emit('backend_down', { reason, target: pendingTransfer })
    return outcome
  }

  function clearTransferChain (reason) {
    const had = transferChain.depth > 0
    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    transferChain.visited.clear()
    transferChain.depth = 0
    if (had) log('transferChainReset', { reason })
  }

  // A server we stay on for a while is no longer part of a redirect chain.
  // Without this, returning to a previously visited server later in the same
  // process would look like a loop.
  function scheduleTransferChainReset () {
    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    if (!clock?.setTimeout || !cfg.transfer.chainResetMs) return
    transferChain.resetTimer = clock.setTimeout(() => {
      transferChain.resetTimer = null
      clearTransferChain('dwell')
    }, cfg.transfer.chainResetMs)
    transferChain.resetTimer?.unref?.()
  }

  function refuseTransfer (reason, host, port, valid) {
    metrics.transfersRefused++
    log('transferRefused', {
      reason,
      host: valid ? host : null,
      port: valid ? port : null,
      depth: transferChain.depth
    })
    // Only a client in play can display a notice: a configuring client would
    // parse a play frame as configuration, and writing one would hand it a
    // frame it cannot read. A refusal in that window is dropped rather than
    // queued, because the queue belongs to the pending-notice work in #22.
    if (canRelayPlay() && !transferNoticeSent) sendTransferNotice()
    else if (isAttached() && !transferNoticeSent) {
      log('transferNoticeSkipped', { reason: 'client_not_in_play' })
    }
  }

  // A backend transfer. The frame never crosses to the front; the decision is
  // whether the puppet follows it. Following means: end this session, dial the
  // target on the next reconnect, reset the cache, detach the front client.
  function handleTransfer (data = {}) {
    metrics.clientboundBlocked++
    metrics.transfersBlocked++
    bumpName(metrics.clientboundBlockedByName, 'transfer')

    const host = typeof data.host === 'string' ? data.host.trim() : ''
    const port = Number(data.port)
    const valid = host.length > 0 && Number.isInteger(port) && port > 0 && port <= 65535
    if (!cfg.transfer.follow) return refuseTransfer('disabled', host, port, valid)
    if (!valid) return refuseTransfer('invalid_target', host, port, valid)
    const key = `${host}:${port}`
    if (transferChain.visited.has(key)) return refuseTransfer('loop', host, port, true)
    if (transferChain.depth >= cfg.transfer.chainLimit) return refuseTransfer('chain_limit', host, port, true)

    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    transferChain.visited.add(key)
    transferChain.depth++
    pendingTransfer = { host, port }
    metrics.transfersFollowed++
    log('transferFollow', { host, port, depth: transferChain.depth })

    teardownBackend({ reason: 'backend_transfer', kickReason: TRANSFER_FOLLOW_REASON })
    try {
      backendLeg.end('backend_transfer')
    } catch (error) {
      log('transferFollowEndFailed', { error: String(error?.message ?? error) })
    }
  }

  // The orchestrator calls this when a followed target cannot be reached; the
  // next reconnect must use the configured base backend.
  function abortTransfer (reason = 'aborted') {
    const abandoned = pendingTransfer
    pendingTransfer = null
    clearTransferChain(reason)
    log('transferAborted', {
      reason,
      host: abandoned?.host ?? null,
      port: abandoned?.port ?? null
    })
    return { abandoned }
  }

  // Called by the front-leg adapter after gates 1+2 pass and Login Success
  // (forged puppet profile) has been sent. Replay via join-synth.
  // `includeConfig: false` omits the cached configuration replay prefix —
  // the live front leg owns the configuration phase and has already replayed
  // it (see docs/product-core.md); fakes keep the default (config included).
  // #16: the client attached while the backend connection was still in its
  // configuration phase. The front streams the puppet's configuration frames
  // to it; at the play login the session becomes attached; this is the
  // front's report that the client itself is in play and wants its replay.
  function attachConfiguringPlayer ({ name, uuid } = {}) {
    if (!backendConfiguring) {
      log('attachFailed', { reason: 'not_ready', uuid, name, configuring: true })
      emit('attach_failed', { username: name, reason: 'not_ready', phase: 'configuring' })
      return { attached: false, reason: 'not_ready' }
    }
    const attempt = session.attachAttempt({ uuid, name, configuring: true })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name, configuring: true })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    frontPlayReady = false
    earlyAttach = { name, uuid }
    transferNoticeSent = false
    metrics.attaches++
    metrics.attachesConfiguring++
    telemetry.metric('monoplayer.attaches', 1, { player: name, phase: 'configuring' })
    log('attachConfiguring', { name, backendLogins: session.backendLogins })
    emit('attach_configuring', { name })
    // The client arrived in the middle of the puppet's configuration: frames
    // the backend already sent (the registry, the known packs) are only in the
    // cache, so replay them first and let the live stream carry the rest. The
    // finish frame stays with the core: it is the front's signal that the
    // client may leave configuration.
    for (const frame of cache.snapshot().config) {
      if (frame.name === 'finish_configuration') continue
      if (!clientboundPolicy('configuration', frame.name).relay) continue
      // Count only what actually reached the client: the front refuses a frame
      // whose state is not the client's own.
      if (frontLeg.writeRaw(frame.buffer, { state: 'configuration', name: frame.name }) !== false) {
        metrics.configFramesRelayed++
      }
    }
    // #16: a held configuration gate is not sent here. This call-in runs during
    // the client's login phase, before the library writes Login Success, so a
    // configuration frame written now is read as a login packet. The front
    // reports the configuration phase through configuringReady, and the gate
    // goes out there.
    return { attached: true, configuring: true, replayed: metrics.configFramesRelayed }
  }

  // The replay half of an attach: the join prefix and the warm state as they
  // stand now. Shared by the warm attach and the early attach, which has
  // already followed the live stream into play.
  function replaySnapshot ({ name, includeConfig = true, reason = 'attach' } = {}) {
    const snapshot = cache.snapshot()
    const synthesized = synthAttach({
      snapshot,
      pose: session.currentPose,
      teleportId: frontTeleportSeq,
      includeConfig
    })
    frontTeleportSeq = synthesized.teleportId

    for (const frame of synthesized.frames) {
      if (frame.synth === 'position') frontLeg.write(frame.name, frame.packet, { synth: true })
      else frontLeg.writeRaw(frame.buffer, { state: 'play', name: frame.name })
    }
    metrics.framesReplayed += synthesized.counts.replayed
    metrics.positionsSynthesized += synthesized.counts.synthesized
    telemetry.metric('monoplayer.replay.frames', synthesized.counts.replayed, { player: name })

    // #18: the human is now the one playing, so their client information goes
    // to the server with the backend cap this session already learned.
    sendClientSettings(reason === 'attach' ? 'attach' : 'early_attach')

    // #16: a dialog that was waiting for a client goes after the replay, so the
    // client is in play when the screen opens.
    resendPendingDialog('play')

    log('attach', {
      name,
      reason,
      replayed: synthesized.counts.replayed,
      synthesizedPositions: synthesized.counts.synthesized,
      skippedLegOwned: synthesized.counts.skipped,
      includeConfig,
      backendLogins: session.backendLogins,
      pose: session.currentPose
    })
    emit('attach', { name, replayed: synthesized.counts.replayed })
    return { attached: true, replayed: synthesized.counts.replayed, frames: synthesized.frames }
  }

  function attachPlayer ({ name, uuid, includeConfig = true } = {}) {
    // #16: the front reports play-ready for a client that attached during the
    // puppet's configuration. It is already attached, so it must not go
    // through the warm attach gate again.
    if (earlyAttach !== null) {
      earlyAttach = null
      if (session.warmReady) {
        frontPlayReady = true
        return replaySnapshot({ name, includeConfig, reason: 'early_attach' })
      }
      // The backend has not finished its own warm yet: hold the replay until
      // the join prefix is complete, so the client gets one coherent world.
      // Live play frames stay withheld until then, or the replay would arrive
      // after state the client already has.
      frontPlayReady = false
      pendingEarlyReplay = { name, includeConfig }
      log('earlyAttachWaitingWarm', { name, backendLogins: session.backendLogins })
      return { attached: true, pending: true, replayed: 0 }
    }
    const attempt = session.attachAttempt({ uuid, name })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    frontPlayReady = true
    transferNoticeSent = false
    metrics.attaches++
    telemetry.metric('monoplayer.attaches', 1, { player: name })
    return replaySnapshot({ name, includeConfig, reason: 'attach' })
  }

  function detachPlayer ({ reason = 'client_disconnect' } = {}) {
    if (!isAttached()) return { detached: false, state: session.state }
    detachedHandoff()
    const result = session.detach({ reason })
    log('detach', { reason, pose: result.pose })
    emit('detach', { reason, pose: result.pose })
    return result
  }

  function detachedHandoff () {
    attached = false
    frontPlayReady = false
    earlyAttach = null
    pendingEarlyReplay = null
  }

  // --- wiring ---

  function start () {
    if (started) return
    started = true

    backendLeg.setEndHandler(({ reason = 'backend_end' } = {}) => {
      const reconfiguring = reconfigureRequested
      reconfigureRequested = false
      // A transfer already tore the session down synchronously; the late
      // socket end is recorded, not replayed.
      if (session.state === STATES.RECONNECTING) {
        const outcome = session.backendDown({ reason })
        log('backendEndLate', { reason, outcome })
        return
      }
      // A normal fault resets the redirect chain; a followed transfer keeps it.
      if (pendingTransfer === null) clearTransferChain('backend_end')
      teardownBackend({
        reason,
        reconfiguring,
        kickReason: reconfiguring ? RECONFIGURE_REASON : 'backend_disconnected'
      })
    })

    backendLeg.setErrorHandler(({ error } = {}) => {
      log('backendError', { error: String(error?.message ?? error) })
    })

    backendLeg.setFrameHandler(frame => {
      const { state, name, buffer, data = {} } = frame
      // Exact packet journal + one frame counter per backend frame. Lifecycle
      // log records come only from the log() funnel, never one per frame.
      journal.frame({ dir: 's2c', state, name, buffer })
      const metricPolicy = state === 'play' || state === 'configuration'
        ? clientboundPolicy(state, name)
        : null
      telemetry.metric('monoplayer.frames', 1, {
        direction: 's2c',
        state,
        name,
        result: !metricPolicy
          ? 'ignored'
          : metricPolicy.decision === DECISION.BLOCK
            ? 'blocked'
            : metricPolicy.decision === DECISION.CONTROL ? 'control' : 'forwarded'
      })
      if (state === 'configuration') {
        metrics.configFrames++
        announceBrand()
        const policy = clientboundPolicy('configuration', name)
        if (name === 'add_resource_pack') answerResourcePack(data)
        if (name === 'ping') {
          // Per-leg latency ping: answer on the puppet leg, never replay.
          backendLeg.write('pong', { id: data.id })
          return
        }
        if (name === 'transfer') {
          // A configuration-phase transfer happens before the play login, when
          // the session has no warm state to move. v1 blocks it (counted) and
          // leaves the session where it is; the play-state follow path is the
          // product behavior.
          metrics.transfersBlocked++
          log('transferBlocked', {
            state: 'configuration',
            host: typeof data.host === 'string' ? data.host : null,
            port: Number.isInteger(data.port) ? data.port : null
          })
          return
        }
        // #16: the backend is in its configuration phase, whatever this frame
        // turns out to be. Record it first, so a client may attach now and
        // follow this stream live — a gate can be the first frame of the phase.
        if (!backendConfiguring) {
          backendConfiguring = true
          log('backendConfiguring', { state: session.state })
        }
        if (policy.decision === DECISION.CONTROL) {
          // #16: a configuration gate is the human's to answer. The holder keeps
          // it while no client follows this stream.
          handleControlDialog({ state: 'configuration', name, buffer, data })
          return
        }
        if (policy.decision === DECISION.BLOCK) {
          blockClientbound('configuration', name, policy, data)
          return
        }
        if (!policy.cache) return
        const pushed = cache.push('configuration', name, buffer, data)
        if (pushed.cached && policy.relay && session.state === STATES.CONFIGURING) {
          if (frontLeg.writeRaw(buffer, { state: 'configuration', name }) !== false) {
            metrics.configFramesRelayed++
          }
        }
        return
      }
      if (state !== 'play') {
        // Handshake/login frames (encryption_begin, compress, login success)
        // belong to the puppeted backend connection only. Replaying them in
        // the front's play state makes the client read packet id 0x01 as
        // add_entity and reject the joining client.
        metrics.nonPlayFramesIgnored++
        return
      }
      backendPlayFrame({ name, buffer, data })
    })

    frontLeg.setLoginStartHandler(payload => {
      const decision = processLoginStart(payload)
      // The core cannot send Login Success; it only decides. A denial
      // returning to the adapter happens before any Login Success packet.
      return decision
    })

    frontLeg.setServerboundHandler(serverbound => {
      const name = serverbound.name
      const state = serverbound.state ?? 'play'
      const attachedNow = isAttached()
      // Classify before recording so the frame counter carries the outcome.
      const decision = attachedNow
        ? classifyServerbound(name, serverbound.data, { mode: cfg.chat, state })
        : { action: 'drop', chat: false }
      journal.frame({ dir: 'c2s', state, name, buffer: serverbound.buffer })
      telemetry.metric('monoplayer.frames', 1, {
        direction: 'c2s',
        state,
        name,
        result: decision.action === 'forward' ? 'forwarded' : 'dropped'
      })
      if (!attachedNow) {
        metrics.serverboundNotAttached++
        log('serverboundIgnored', { name: serverbound.name, reason: 'not_attached' })
        return
      }
      if (decision.action === 'rewrite') {
        // #18: the human's client information reaches the backend only in the
        // form the proxy owns. noteClientSettings records it and writes the
        // merged packet, so the client's own view distance never crosses.
        const outcome = noteClientSettings(serverbound.data ?? {})
        if (outcome.sent) {
          metrics.clientSettingsRewritten++
          metrics.serverboundForwarded++
          bumpName(metrics.serverboundByName, serverbound.name)
        } else {
          // No usable fields, no learned cap, or a failed write: the frame did
          // not reach the backend, so the ledger says dropped, not forwarded.
          metrics.serverboundDropped++
          bumpName(metrics.serverboundDroppedByName, serverbound.name)
        }
        log('serverboundRewrite', {
          name: serverbound.name,
          noted: outcome.noted === true,
          sent: outcome.sent === true,
          reason: outcome.reason ?? null
        })
        return
      }
      if (decision.action === 'speak') {
        // #19: the human's text is spoken by the puppet leg, never forwarded.
        // The frame carried the human's signature and offset, which the backend
        // cannot use; the leg signs the text again as the puppet.
        const spoken = chatText(name, serverbound.data)
        if (!spoken || typeof backendLeg.chat !== 'function') {
          dropChat(name, spoken ? 'leg_has_no_chat' : 'no_text')
          return
        }
        try {
          backendLeg.chat(spoken.text)
          metrics.chatSent++
          log('chatSent', { name, command: spoken.command, chars: spoken.text.length })
          emit('chat_sent', { name, command: spoken.command })
        } catch (error) {
          dropChat(name, 'send_failed', { error: String(error?.message ?? error).slice(0, 200) })
        }
        return
      }
      if (decision.action === 'drop') {
        if (decision.chat) {
          dropChat(name, decision.reason)
          return
        }
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, serverbound.name)
        return
      }
      // #16: the packet id is state-scoped, so the frame must be written into
      // the state it was sent in. A configuration answer that arrives after the
      // play login, or a play frame while the puppet is still configuring, is
      // the wrong packet id and would end the backend session.
      if ((state === 'configuration') !== backendConfiguring) {
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, name)
        log('serverboundDropped', { name, state, reason: 'puppet_state_mismatch' })
        return
      }
      if (state === 'play') {
        session.setPose(
          capturePose(session.currentPose, serverbound.name, serverbound.data)
        )
      }
      // #16: the frame carries its own state. A configuration answer reaches a
      // puppet that is still in configuration, where a play-state write would
      // be a different packet id.
      backendLeg.writeRaw(serverbound.buffer, { state, name: serverbound.name })
      // The human answered a control dialog: the held copy is no longer
      // pending, so a later attach is not shown a question already answered.
      const answered = pendingDialog.answer({ state, name: serverbound.name })
      if (answered.answered) {
        metrics.controlDialogsAnswered++
        log('controlDialogAnswered', { name: serverbound.name, state: answered.state, dialog: answered.name })
      }
      metrics.serverboundForwarded++
      bumpName(metrics.serverboundByName, serverbound.name)
      if (ACTION_SERVERBOUND.has(serverbound.name)) {
        log('serverboundAction', { name: serverbound.name, attached: true })
      }
    })

    frontLeg.setDetachHandler(({ reason = 'player_quit' } = {}) => {
      detachPlayer({ reason })
    })

    // #16: the client entered its own configuration phase; a gate the backend
    // asked before the client arrived is delivered there.
    frontLeg.setConfiguringHandler(({ name } = {}) => {
      configuringReady({ name })
    })

    log('start', { whitelist: identity.whoAmI().whitelist, puppet: cfg.puppet, started: true })
    emit('start')
  }

  // Backend play frame routing (per-leg keep-alive/pong answering, pose
  // teleports, cache, live forwarding).
  // #16: the front reports that the attached client entered its own
  // configuration phase. This is the first moment a configuration frame reaches
  // it in a state it parses, so a held configuration gate goes out here.
  function configuringReady ({ name = null } = {}) {
    if (!attached || session.state !== STATES.CONFIGURING) {
      log('configuringReadyIgnored', { reason: 'not_configuring', state: session.state })
      return { attached: false, sent: false }
    }
    const outcome = resendPendingDialog('configuration')
    log('configuringReady', { name, sent: outcome.sent === true })
    return { attached: true, sent: outcome.sent === true }
  }

  // The replay a pre-warm client still owes: sent once, when the join prefix
  // is warm, whether the warm came from the marker or the readiness fallback.
  function replayPendingEarly () {
    if (pendingEarlyReplay === null || !cache.warm) return null
    const pending = pendingEarlyReplay
    pendingEarlyReplay = null
    frontPlayReady = true
    return replaySnapshot({ name: pending.name, includeConfig: pending.includeConfig, reason: 'early_attach' })
  }

  function backendPlayFrame ({ name, buffer, data }) {
    metrics.backendFrames++

    // #16: an early-attach client gets its replay as soon as the join prefix is
    // warm. The live path warms on the readiness fallback as well as on the
    // marker, so this is checked per frame as well as at the marker below.
    replayPendingEarly()

    if (name === 'bundle_delimiter') {
      // Bundle delimiters are a transport grouping, not state. Replaying them
      // alongside individually cached packets makes the client parse the
      // bundle's concatenated payload as one oversized packet. Drop the
      // delimiter and relay the enclosed packets individually.
      metrics.bundleDelimitersDropped++
      return
    }

    if (name === 'login') {
      // The real backend login event backendLogins counts. Attach/detach never
      // touches this. Only counted when the leg is (re)booting — a doubled
      // replayed login frame during an already-warm session is not a login.
      // A pre-warm configuring attach is attached but not warm; its backend
      // login is still the play login that ends the configuration phase.
      if (session.state === STATES.BOOT || session.state === STATES.CONFIGURING) {
        const login = session.backendLogin({ entityId: data.entityId })
        backendConfiguring = false
        scheduleTransferChainReset()
        applyBackendViewDistance(data)
        log('backendLogin', {
          entityId: data.entityId,
          backendLogins: session.backendLogins,
          fromConfiguring: login.wasConfiguring === true
        })
        emit('backend_login', { entityId: data.entityId })
      }
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      // Cache-only: a login frame is replayed to an attach, never relayed
      // into an already-playing client's connection.
      return
    }

    if (name === 'keep_alive') {
      // Backend leg answers its own keep-alives; never relayed to the front.
      backendLeg.write('keep_alive', { keepAliveId: data.keepAliveId })
      return
    }
    if (name === 'ping') {
      backendLeg.write('pong', { id: data.id })
      return
    }
    if (name === WARM_MARKER) {
      // P1#2: every backend chunk batch finish is answered with
      // chunk_batch_received on the backend leg — warm or not. The first
      // (unwarm) batch also completes the warm pin; after warm the marker is
      // ordinary cacheable/relayed state.
      const wasWarm = cache.warm
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      backendLeg.write('chunk_batch_received', { chunksPerTick: 32 })
      if (!wasWarm) {
        session.warmComplete({ marker: name })
        replayPendingEarly()
      } else if (canRelayPlay()) {
        frontLeg.writeRaw(buffer, { state: 'play', name })
      }
      return
    }

    if (name === 'position') {
      // Position is per-leg owned: confirm on the backend leg, follow the
      // backend teleport in the session pose, and (only when someone is
      // attached) synthesize a fresh position with a proxy-owned teleportId.
      // Never cached, never replayed.
      session.setPose(capturePose(session.currentPose, 'position', data, { backend: true }))
      backendLeg.write('teleport_confirm', { teleportId: data.teleportId })
      if (canRelayPlay()) {
        frontTeleportSeq++
        frontLeg.write('position', {
          teleportId: frontTeleportSeq,
          x: data.x,
          y: data.y,
          z: data.z,
          yaw: data.yaw,
          pitch: data.pitch,
          dx: 0,
          dy: 0,
          dz: 0,
          flags: 0
        }, { synth: true })
        metrics.positionsSynthesized++
      }
      if (cache.push('play', name, buffer, data).cached) metrics.framesCached++
      return
    }
    if (name === 'add_resource_pack') answerResourcePack(data)

    if (name === 'transfer') {
      handleTransfer(data)
      return
    }

    if (name === 'start_configuration') {
      // The server wants this connection to re-enter configuration. The front
      // client cannot follow that on its own connection (the proxy would have
      // to serve a configuration phase it does not own), so block the frame
      // and end the puppet leg on purpose. The end handler resets the cache,
      // detaches the client with a clear reason, and schedules a fresh login.
      blockClientbound('play', name, clientboundPolicy('play', name), data)
      log('backendReconfigure', { name })
      reconfigureRequested = true
      try {
        backendLeg.end('backend_reconfigure')
      } catch (error) {
        log('backendReconfigureFailed', { error: String(error?.message ?? error) })
      }
      return
    }

    const policy = clientboundPolicy('play', name)
    if (policy.decision === DECISION.CONTROL) {
      handleControlDialog({ state: 'play', name, buffer, data })
      return
    }
    if (policy.decision === DECISION.BLOCK) {
      blockClientbound('play', name, policy, data)
      return
    }
    if (policy.decision === DECISION.PER_LEG) return // handled above; defensive
    if (policy.decision === DECISION.LIVE_ONLY) {
      const chatFrame = CHAT_FRAMES.has(name)
      if (chatFrame && !chatRelayAllowed(name, cfg.chat)) return
      if (chatFrame) metrics.chatRelayed++
      if (canRelayPlay()) frontLeg.writeRaw(buffer, { state: 'play', name })
      return
    }
    if (policy.decision === DECISION.CACHE_ONLY) {
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      return
    }

    const pushed = cache.push('play', name, buffer, data)
    if (pushed.cached) metrics.framesCached++
    if (canRelayPlay()) frontLeg.writeRaw(buffer, { state: 'play', name })
  }

  async function stop ({ reason = 'stopped' } = {}) {
    if (isAttached()) detachPlayer({ reason: `stopping:${reason}` })
    try { backendLeg.end(reason) } catch {}
    log('stop', { reason })
  }

  const handle = {
    version: cfg.version,
    config: cfg,
    cache,
    identity,
    session,
    metrics,
    on,
    log,
    logs: () => [...logs],
    // front pipeline call-ins (real front-leg adapter drives these):
    processLoginStart,
    attachConfiguringPlayer,
    configuringReady,
    notePuppetDialogAnswer,
    noteClientSettings,
    processVerifySession,
    attachPlayer,
    detachPlayer,
    abortTransfer,
    notice: sendProxyNotice,
    // lifecycle:
    start,
    stop,
    get started () { return started },
    get attached () { return isAttached() },
    get backendViewDistance () { return backendViewDistance },
    get backendConfiguring () { return backendConfiguring },
    get pendingDialog () { return pendingDialog },
    get frontPlayReady () { return frontPlayReady },
    get backendLeg () { return backendLeg },
    get frontLeg () { return frontLeg }
  }

  return handle
}

// --- CLI (no sockets; see docs/product-core.md for the --start plan) ---

export const USAGE = `monoplayer — one Minecraft account, one backend, many clients

Usage:
  node src/service/monoplayer.js --print-config     print the resolved config and exit
  node src/service/monoplayer.js --config <file>    load a JSON config
  node src/service/monoplayer.js --start            start the live legs (G1 + B1 lane)

Config (JSON via --config, then env, then defaults):
  MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind address
  MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
  MONOPLAYER_PUPPET_ACCOUNT                           account selector: uuid, alias, or name
  MONOPLAYER_PUPPET_ACCOUNTS_DIR                      account tree (default .secrets/accounts)
  MONOPLAYER_PUPPET_UUID                              assertion: resolved account uuid must match
  MONOPLAYER_PUPPET_USERNAME                          assertion: resolved profile name must match
  MONOPLAYER_PUPPET_CACHE_DIR                         raw custody dir override (deprecated)
  MONOPLAYER_PUPPET_CACHE_ACCOUNT                     legacy selector (deprecated; ignored)
  MONOPLAYER_DIALOG_ACTION                            configuration-gate answer: first|last|<label substring>
  MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
  MONOPLAYER_VERSION                                  protocol pin (default 26.1)
  MONOPLAYER_CHAT                                     read-only (default), full, or off
  MONOPLAYER_LOG                                      JSONL log file (default stdout)
  OTEL_EXPORTER_OTLP_ENDPOINT                         OTLP/HTTP collector base URL (telemetry off when unset)
  OTEL_SERVICE_NAME / OTEL_SERVICE_VERSION            telemetry service identity
  MONOPLAYER_JOURNAL_DIR                              exact packet journal directory (journal off when unset)
  MONOPLAYER_JOURNAL_MAX_BYTES                        journal rotation size (default 268435456)

--start brings up the live backend leg (authenticated puppet via the G1 token
custody in .secrets/accounts/<uuid>/), waits until the state cache holds the
backend configuration frames + join prefix (warm marker preferred), then
starts the front leg for whitelisted attaching players. See
docs/product-core.md and docs/custody.md.`

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (argv, name) => argv.includes(name)

export async function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  if (has(argv, '--help') || (argv.length === 0)) {
    io.stdout.write(USAGE + '\n')
    return 0
  }
  if (has(argv, '--print-config')) {
    const docPath = flag(argv, '--config')
    const doc = docPath ? JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(docPath, 'utf8'))) : {}
    io.stdout.write(JSON.stringify(loadConfig(doc), null, 2) + '\n')
    return 0
  }
  if (has(argv, '--start')) {
    // Live legs live behind a dynamic import: with no --start the CLI keeps
    // the pure-core property (no sockets, no minecraft-protocol load).
    const { startLive } = await import('./start-live.js')
    return startLive({ argv })
  }
  io.stdout.write(USAGE + '\n')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}

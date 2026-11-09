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
//     end(reason)                                 // deliberate close
//   }
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
import { createFrontIdentity } from '../core/identity.js'
import { synthAttach } from '../core/join-synth.js'
import { classifyServerbound, capturePose } from '../core/relay.js'
import { clientboundPolicy, DECISION } from '../core/clientbound-policy.js'
import { createSession, STATES } from '../core/session.js'
import { redact, SENTINEL } from '../observability/redact.js'
import { pathToFileURL } from 'node:url'

// --- config ---

export const DEFAULT_CONFIG = Object.freeze({
  version: '26.1',
  // Read-only chat: relay clientbound chat to the attached client, never
  // forward the client's own chat. 'off' restores the fully blocked behavior.
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
  // Backend onboarding dialog: first, last, or a label substring. Null leaves
  // the dialog unanswered and a headless leg waits.
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
  if (merged.chat !== 'read-only' && merged.chat !== 'off') {
    throw new TypeError("config.chat must be 'read-only' or 'off'")
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
    clientboundBlocked: 0,
    clientboundBlockedByName: {},
    clientboundUnclassified: 0,
    transfersBlocked: 0,
    transfersFollowed: 0,
    transfersRefused: 0,
    bundleDelimitersDropped: 0,
    nonPlayFramesIgnored: 0,
    resourcePackAcks: 0,
    resourcePackAckFailures: 0,
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
    'show_dialog',
    'clear_dialog',
    'disconnect',
    'code_of_conduct'
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
  let attached = false // mirrors session state === ATTACHED
  let frontTeleportSeq = 0 // proxy-owned teleport IDs
  let transferNoticeSent = false // one refusal notice per attach
  let reconfigureRequested = false // this backend end is a server reconfiguration
  let pendingTransfer = null // target for the next reconnect_due
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
    return attached && session.state === STATES.ATTACHED
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
    if (!session.isAttachReady() && session.state !== STATES.ATTACHED) {
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
    return decision
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

  // The refusal notice is local proxy speech, not server speech. It never
  // carries the target address.
  function sendTransferNotice () {
    transferNoticeSent = true
    try {
      frontLeg.write('system_chat', {
        content: {
          type: 'compound',
          value: { text: { type: 'string', value: TRANSFER_REFUSED_NOTICE } }
        },
        isActionBar: false
      })
    } catch (error) {
      log('transferNoticeFailed', { error: String(error?.message ?? error) })
    }
  }

  // Shared teardown for a session that cannot continue: a backend fault, a
  // server reconfiguration, or a followed transfer. The transfer branch calls
  // this synchronously before ending the leg, because a socket end event can
  // be skipped when the next connect replaces the client first.
  function teardownBackend ({ reason, kickReason = 'backend_disconnected', reconfiguring = false } = {}) {
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
    if (isAttached() && !transferNoticeSent) sendTransferNotice()
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
  function attachPlayer ({ name, uuid, includeConfig = true } = {}) {
    const attempt = session.attachAttempt({ uuid, name })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    transferNoticeSent = false
    metrics.attaches++
    telemetry.metric('monoplayer.attaches', 1, { player: name })

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

    log('attach', {
      name,
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
          : metricPolicy.decision === DECISION.BLOCK ? 'blocked' : 'forwarded'
      })
      if (state === 'configuration') {
        metrics.configFrames++
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
        if (policy.decision === DECISION.BLOCK) {
          blockClientbound('configuration', name, policy, data)
          return
        }
        if (!policy.cache) return
        cache.push('configuration', name, buffer, data)
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
      const decision = attachedNow ? classifyServerbound(name) : { action: 'drop', chat: false }
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
      if (decision.action === 'drop') {
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, serverbound.name)
        if (decision.chat) {
          metrics.chatBlocked++
          log('chatBlocked', { name: serverbound.name })
          emit('chat_blocked', { name: serverbound.name })
        }
        return
      }
      session.setPose(
        capturePose(session.currentPose, serverbound.name, serverbound.data)
      )
      backendLeg.writeRaw(serverbound.buffer, { state: 'play', name: serverbound.name })
      metrics.serverboundForwarded++
      bumpName(metrics.serverboundByName, serverbound.name)
      if (ACTION_SERVERBOUND.has(serverbound.name)) {
        log('serverboundAction', { name: serverbound.name, attached: true })
      }
    })

    frontLeg.setDetachHandler(({ reason = 'player_quit' } = {}) => {
      detachPlayer({ reason })
    })

    log('start', { whitelist: identity.whoAmI().whitelist, puppet: cfg.puppet, started: true })
    emit('start')
  }

  // Backend play frame routing (per-leg keep-alive/pong answering, pose
  // teleports, cache, live forwarding).
  function backendPlayFrame ({ name, buffer, data }) {
    metrics.backendFrames++

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
      if (session.state === STATES.BOOT) {
        session.backendLogin({ entityId: data.entityId })
        scheduleTransferChainReset()
        log('backendLogin', { entityId: data.entityId, backendLogins: session.backendLogins })
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
      } else if (isAttached()) {
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
      if (isAttached()) {
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
    if (policy.decision === DECISION.BLOCK) {
      blockClientbound('play', name, policy, data)
      return
    }
    if (policy.decision === DECISION.PER_LEG) return // handled above; defensive
    if (policy.decision === DECISION.LIVE_ONLY) {
      const chatFrame = name === 'system_chat' || name === 'profileless_chat'
      if (chatFrame && cfg.chat !== 'read-only') return
      if (chatFrame) metrics.chatRelayed++
      if (isAttached()) frontLeg.writeRaw(buffer, { state: 'play', name })
      return
    }
    if (policy.decision === DECISION.CACHE_ONLY) {
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      return
    }

    const pushed = cache.push('play', name, buffer, data)
    if (pushed.cached) metrics.framesCached++
    if (isAttached()) frontLeg.writeRaw(buffer, { state: 'play', name })
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
    processVerifySession,
    attachPlayer,
    detachPlayer,
    abortTransfer,
    // lifecycle:
    start,
    stop,
    get started () { return started },
    get attached () { return isAttached() },
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
  MONOPLAYER_DIALOG_ACTION                            first|last|<label substring>
  MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
  MONOPLAYER_VERSION                                  protocol pin (default 26.1)
  MONOPLAYER_CHAT                                     read-only (default) or off
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

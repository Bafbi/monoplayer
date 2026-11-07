// B1 monoplayer core: product-shaped composition root.
//
// The Gate A spike (src/proxy.js) is frozen; this module is where the product
// lives. Everything real-scoped is injected: the front-leg and backend-leg
// adapters (interface below, fakes in src/monoplayer/fake-legs.js) and the
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
//     setLoginStartHandler(({ uuid, name }): decision[])   // -> gate 1
//     setServerboundHandler(({ state, name, buffer, data }): void)
//     setDetachHandler(({ reason }): void)
//     write(name, packet, { synth })              // clientbound, packet level
//     writeRaw(buffer, meta)                      // clientbound, frame level
//     end(reason)                                 // kick/deny the client
//   }

import { createStateCache, WARM_MARKER } from './monoplayer/state-cache.js'
import { createFrontIdentity, DENY_REASONS } from './monoplayer/identity.js'
import { synthAttach, LEG_OWNED } from './monoplayer/join-synth.js'
import { classifyServerbound, capturePose, CHAT_SERVERBOUND } from './monoplayer/relay.js'
import { createSession, STATES } from './monoplayer/session.js'
import { redact, SENTINEL } from './monoplayer/redact.js'

// --- config ---

export const DEFAULT_CONFIG = Object.freeze({
  version: '26.1',
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
  reconnect: Object.freeze({ delayMs: 1000 }),
  redaction: Object.freeze({ sentinel: SENTINEL })
})

export function loadConfig (doc = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...doc,
    bounds: { ...DEFAULT_CONFIG.bounds, ...(doc.bounds ?? {}) },
    reconnect: { ...DEFAULT_CONFIG.reconnect, ...(doc.reconnect ?? {}) },
    front: { ...DEFAULT_CONFIG.front, ...(doc.front ?? {}) },
    backend: { ...DEFAULT_CONFIG.backend, ...(doc.backend ?? {}) },
    puppet: { ...DEFAULT_CONFIG.puppet, ...(doc.puppet ?? {}) }
  }
  if (!Array.isArray(merged.attachWhitelist)) {
    throw new TypeError('config.attachWhitelist must be an array of UUIDs')
  }
  return merged
}

// --- core ---

export function createMonoplayer ({
  config = loadConfig(),
  backendLeg,
  frontLeg,
  clock,
  logStream = null
} = {}) {
  if (!backendLeg) throw new TypeError('backendLeg adapter is required')
  if (!frontLeg) throw new TypeError('frontLeg adapter is required')

  const cfg = config

  const cache = createStateCache(cfg.bounds)
  const identity = createFrontIdentity({
    attachWhitelist: cfg.attachWhitelist,
    puppetProfile: cfg.puppet
  })
  const session = createSession({ clock, reconnectDelayMs: cfg.reconnect.delayMs })

  const metrics = {
    backendFrames: 0,
    configFrames: 0,
    framesCached: 0,
    framesReplayed: 0,
    positionsSynthesized: 0,
    serverboundForwarded: 0,
    serverboundDropped: 0,
    chatBlocked: 0,
    bundleDelimitersDropped: 0,
    nonPlayFramesIgnored: 0,
    attaches: 0,
    denials: 0,
    frontKicks: 0
  }

  const logs = [] // redacted JSON lines, bounded
  const listeners = new Map() // type -> Set<fn>
  let started = false
  let attached = false // mirrors session state === ATTACHED
  let frontTeleportSeq = 0 // proxy-owned teleport IDs

  function log (event, fields = {}) {
    const line = redact(JSON.stringify({ t: clock?.now?.() ?? Date.now(), event, ...fields }))
    logs.push(line)
    if (logs.length > 4096) logs.shift()
    if (logStream) logStream.write(line + '\n')
    emit('log', { line })
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

  // Gate 1: Login Start whitelist review. Denied here, i.e. strictly before
  // Login Success can ever be sent for that connection.
  function processLoginStart (payload = {}) {
    const decision = identity.reviewLoginStart(payload)
    if (!decision.allowed) {
      metrics.denials++
      log('attachDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid })
      emit('attach_denied', decision)
    }
    return decision
  }

  // Gate 2 (only when a verifier was injected): online-mode hasJoined check.
  async function processVerifySession (payload = {}) {
    const decision = await identity.verifySession(payload)
    if (!decision.allowed) {
      metrics.denials++
      log('verifyDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid, name: payload.name })
      emit('verify_denied', decision)
    }
    return decision
  }

  // Called by the front-leg adapter after gates 1+2 pass and Login Success
  // (forged puppet profile) has been sent. Replay via join-synth.
  // `includeConfig: false` omits the cached configuration replay prefix —
  // the live front leg owns the configuration phase and has already replayed
  // it (see docs/gate-b-b1.md); fakes keep the default (config included).
  function attachPlayer ({ name, uuid, includeConfig = true } = {}) {
    const attempt = session.attachAttempt({ uuid, name })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    metrics.attaches++

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
      // P1#1: a backend end invalidates the whole state cache. Frames pinned
      // from the dead session (config prefix, join prefix, warm-state
      // domains) must never replay onto an attaching client after a
      // reconnect + fresh login. The fresh session's own configuration and
      // join prefix re-pin the cache from scratch (warm recompletes at its
      // first chunk_batch_finished), so a reattach replays exactly one
      // login and the new prefix — never the dead session's state mid-play.
      cache.reset()
      log('cacheReset', { reason: 'backend_down', backendLogins: session.backendLogins })
      if (isAttached()) {
        // Session invariant: the attaching client cannot survive the backend.
        detachedHandoff()
        session.detach({ reason: `backend_down:${reason}` })
        const outcome = session.backendDown({ reason })
        log('backendDown', { reason, frontEnded: true, outcome })
        frontLeg.end('backend_disconnected')
      } else {
        const outcome = session.backendDown({ reason })
        log('backendDown', { reason, frontEnded: false, outcome })
      }
      emit('backend_down', { reason })
    })

    backendLeg.setErrorHandler(({ error } = {}) => {
      log('backendError', { error: String(error?.message ?? error) })
    })

    backendLeg.setFrameHandler(frame => {
      const { state, name, buffer, data = {} } = frame
      if (state === 'configuration') {
        metrics.configFrames++
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
      if (!isAttached()) {
        log('serverboundIgnored', { name: serverbound.name, reason: 'not_attached' })
        return
      }
      const decision = classifyServerbound(serverbound.name)
      if (decision.action === 'drop') {
        metrics.serverboundDropped++
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
        log('backendLogin', { entityId: data.entityId, backendLogins: session.backendLogins })
        emit('backend_login', { entityId: data.entityId })
      }
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      if (isAttached()) frontLeg.writeRaw(buffer, { state: 'play', name })
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
    if (LEG_OWNED.has(name)) {
      // Defensive: chat/per-leg frames are not cached and not replayed; they
      // are not relayed live either (chat block, per-leg handshake frames).
      cache.push('play', name, buffer, data)
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

// --- CLI (no sockets; see docs/gate-b-b1.md for the --start plan) ---

export const USAGE = `monoplayer — one Minecraft account, one backend, many clients

Usage:
  node src/monoplayer.js --print-config     print the resolved config and exit
  node src/monoplayer.js --config <file>    load a JSON config
  node src/monoplayer.js --start            start the live legs (G1 + B1 lane)

Config (JSON via --config, then env, then defaults):
  MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind address
  MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
  MONOPLAYER_PUPPET_ACCOUNT                           account selector: uuid, alias, or name
  MONOPLAYER_PUPPET_ACCOUNTS_DIR                      account tree (default .secrets/accounts)
  MONOPLAYER_PUPPET_UUID                              assertion: resolved account uuid must match
  MONOPLAYER_PUPPET_USERNAME                          assertion: resolved profile name must match
  MONOPLAYER_PUPPET_CACHE_DIR                         raw custody dir override (deprecated)
  MONOPLAYER_PUPPET_CACHE_ACCOUNT                     legacy selector (deprecated; ignored)
  MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
  MONOPLAYER_VERSION                                  protocol pin (default 26.1)
  MONOPLAYER_LOG                                      JSONL log file (default stdout)

--start brings up the live backend leg (authenticated puppet via the G1 token
custody in .secrets/accounts/<uuid>/), waits until the state cache holds the
backend configuration frames + join prefix (warm marker preferred), then
starts the front leg for whitelisted attaching players. See
docs/gate-b-b1.md and docs/gate-b-g1.md.`

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
    const { startLive } = await import('./monoplayer/start-live.js')
    return startLive({ argv })
  }
  io.stdout.write(USAGE + '\n')
  return 0
}

import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}

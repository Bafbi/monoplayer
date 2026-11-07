// The live front leg: mc.createServer online-mode=true, one attaching client
// (Bafbi, the whitelisted attach account) — the frontLeg adapter for the B1
// core.
//
// Flow per connection:
//   1. library login: encryption + real sessionserver hasJoined (real
//      client.uuid / client.username / client.profile are set by the library
//      BEFORE our synchronous beforeLogin hook runs).
//   2. beforeLogin (synchronous; createServer option): attach gate —
//      src/auth/attach.js createAttachGate().gateVerified with the attach
//      whitelist store (.secrets/attach-whitelist.json, UUID-keyed).
//      Deny = client.end('attach denied (...)'): Server.end override writes
//      the login-state disconnect then ends the serializer chain, so the
//      library's follow-up compress/success writes in loginClient are
//      mechanically dropped (client.write no-ops on an ended serializer).
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
// Identity: deliberately NOT forged in this slice. The attaching client is
// whitelisted as itself (real hasJoined profile); the replayed play stream
// still describes the puppet's session (backend entity id and state). Profile
// forging is the B4 identity-separation row's question.
import mc from 'minecraft-protocol'

import { createAttachGate } from '../auth/attach.js'
import { createWhitelistStore } from '../auth/store.js'

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
        writeRaw(frame.buffer)
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

export function createLiveFrontLeg ({
  host = '127.0.0.1',
  port = 25565,
  version = '26.1',
  attachWhitelistFile,
  getSnapshotConfig, // () => [{ name, buffer }] — the core's cached configuration frames
  log = () => {},
  dumpRaw = null, // ({ kind, buffer }) => — optional diagnostic hook, never logs content by default
  dumpWire = null // (buffer) => — exact plaintext wire frames, diagnostic only
} = {}) {
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')
  if (!attachWhitelistFile) throw new TypeError('attachWhitelistFile is required')
  if (dumpRaw !== null && typeof dumpRaw !== 'function') throw new TypeError('dumpRaw must be null or a function')
  if (dumpWire !== null && typeof dumpWire !== 'function') throw new TypeError('dumpWire must be null or a function')

  let loginStartHandler = null // core gate 1 call-in (processLoginStart)
  let serverboundHandler = null // core serverbound pipeline
  let detachHandler = null // core detach
  let errorHandler = null
  let attached = null // the one client through the pipeline (gate pass or attached)

  const gate = createAttachGate({
    log: () => {} // decision reasons are logged by the core / front leg lines below
  })
  const store = createWhitelistStore({ file: attachWhitelistFile })

  let server = null

  // Defensive snapshot materialization: cache the core's cached-config frames
  // once per listen() round. Buffers are opaque and safe to hold.
  let snapshotConfig = null
  function configFrames () {
    if (snapshotConfig === null) {
      snapshotConfig = getSnapshotConfig().filter(
        frame => typeof frame?.name === 'string' && Buffer.isBuffer(frame.buffer)
      )
    }
    return snapshotConfig
  }

  // Start listening. Handlers must be set first.
  function listen () {
    if (server) throw new Error('front leg already listening')

    server = mc.createServer({
      host,
      port,
      version,
      'online-mode': true, // real hasJoined by the library before beforeLogin
      keepAlive: true, // the library answers per-connection keep-alives for the client
      hideErrors: true, // errors surface through our own server/client error log lines
      versionChecking: false,
      beforeLogin: client => { handleBeforeLogin(client) }
    })

    server.on('error', err => {
      log('frontServerError', { error: String(err.message).slice(0, 200) })
      errorHandler?.({ error: err })
    })
    server.on('listening', () => {
      log('frontListening', { host, port })
    })

    server.on('connection', client => {
      wireClient(client)
      if (dumpWire) {
        // Diagnostic: framer output = exact plaintext wire frames piped to
        // the client (pre-encryption; the cipher pipes after the framer).
        client.framer.on('data', buf => { try { dumpWire(buf) } catch { /* best effort */ } })
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
  }

  // beforeLogin: synchronous, called by loginClient AFTER the library's
  // online-mode hasJoined resolved (real uuid/profile on the client) and
  // BEFORE compress + success writes.
  function handleBeforeLogin (client) {
    const username = client.username
    const uuid = client.uuid
    log('frontLoginReview', { username, uuid: uuid ?? null, onlineMode: true })

    // Core gate 1 (whitelist review + metrics emission) — the config's
    // attachWhitelist is loaded from the same file this store reads, so the
    // two agree; the store is the source of truth.
    const claimed = { uuid, name: username, username }
    let coreDecision = null
    try {
      coreDecision = loginStartHandler?.(claimed) ?? null
    } catch { /* the core decision is advisory here; gateVerified leads */ }

    const decision = gate.gateVerified({ client, store })
    if (!decision.ok ||
        (coreDecision && coreDecision.allowed === false)) {
      const reason = !decision.ok ? decision.reason : coreDecision.reason
      metrics.denied++
      log('attachDenied', { username, uuid: uuid ?? null, reason })
      const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
      if (originalWrite) {
        client.write = (name, ...args) =>
          (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
      }
      client.end(`attach denied (${reason})`)
      return
    }

    metrics.allowed++
    log('attachAllowed', { username, uuid, verifier: 'online-mode_hasjoined', whitelist: attachWhitelistFile })

    // Install the cached-config interceptor BEFORE loginClient's subsequent
    // writes/completion (we are inside the synchronous beforeLogin window).
    installConfigInterceptor(client)

    // Own the client slot: a second connection is denied at the next gate.
    attachCandidate(client)
  }

  // The attach slot is claimed at gate-pass time so a second racing client
  // is denied up-front rather than kicked at playerJoin.
  function attachCandidate (client) {
    if (attached && attached !== client) return // first client still holds the slot
    attached = client
  }

  function installConfigInterceptor (client) {
    const interceptor = createConfigPathInterceptor({
      write: client.write.bind(client),
      // Optional raw-dump hook (MONOPLAYER_DEBUG_REPLAY): every clientbound
      // raw byte we push to the attaching client, in order — diagnostic only.
      writeRaw: buffer => {
        if (dumpRaw) dumpRaw({ kind: 'raw', buffer })
        client.writeRaw(buffer)
      },
      isConfigurationState: () => client.state === 'configuration',
      cachedConfigFrames: configFrames()
    })
    client.write = interceptor.write
    clients.set(client, { interceptor })
  }

  // The client reached play. Hand the attach to the core: replay the join
  // prefix + warm state (configuration frames are omitted — the front leg
  // owns the configuration phase).
  function onClientJoined (client) {
    if (attached && attached !== client) {
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
      const wasAttached = attached === client
      if (attached === client) {
        attached = null
        log('frontDetach', { reason: String(reason).slice(0, 160), attached: true })
        detachHandler?.({ reason: String(reason) })
      } else if (clients.has(client)) {
        attached = attached ?? null // never revive another client's claim
        log('frontClientEnd', { reason: String(reason).slice(0, 160), attached: false })
      }
    })
    client.on('error', err => {
      log('frontClientError', { error: String(err.message).slice(0, 200) })
      errorHandler?.({ error: err })
    })
  }

  const metrics = { denied: 0, allowed: 0, attaches: 0 }
  const clients = new Map() // Client -> { interceptor }

  return {
    kind: 'live-front-leg',
    listen,

    // --- frontLeg interface (docs/gate-b-b1.md) ---
    setLoginStartHandler (fn) { loginStartHandler = fn },
    setServerboundHandler (fn) { serverboundHandler = fn },
    setDetachHandler (fn) { detachHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    setCoreAttach,
    write (name, packet) {
      if (dumpRaw) dumpRaw({ kind: `write:${name}`, buffer: Buffer.alloc(0) })
      attached?.write(name, packet)
    },
    writeRaw (buffer) {
      if (dumpRaw) dumpRaw({ kind: 'raw', buffer })
      attached?.writeRaw(buffer)
    },
    end (reason) {
      try { attached?.end(reason) } catch { /* client already gone */ }
    },
    get listening () { return Boolean(server) },
    get attached () { return attached ?? null },
    get metrics () { return { ...metrics } },
    get gateStoreFile () { return store.file },
    close () {
      try { server?.close() } catch { /* not open */ }
      for (const client of Object.values(server?.clients ?? {})) {
        try { client.socket?.destroy() } catch { /* ignore */ }
      }
    }
  }
}

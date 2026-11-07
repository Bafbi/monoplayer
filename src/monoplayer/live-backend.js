// The Monoplayer backend leg: one session as the puppet against the backend.
//
// Two constructors share one body, and the offline path is a separate
// constructor, never a config flag:
//   createLiveBackendLeg    Microsoft auth through the G1 token custody,
//                           cache-key = cacheAccount, writer lock held.
//   createOfflineBackendLeg auth 'offline', fixed username, loopback only,
//                           no custody, no lock, no .secrets read.
//
// This is the backendLeg adapter for the B1 core (see docs/gate-b-b1.md):
// it opens ONE session as the puppet against the backend and forwards every
// clientbound configuration + login + play frame to the core frame handler as
//   { state, name, buffer, data }
// where `buffer` is the minecraft-protocol `raw` frame (packet ID + body,
// re-frameable with writeRaw on any leg) and `data` is the decoded packet
// (for cache keys and pose capture; may be omitted for untracked frames).
//
// Per-leg ownership decisions INSIDE this adapter:
//   - keep_alive frames are swallowed: the library keep-alive plugin answers
//     both config-state and play-state keep-alives on this leg (play.js sets
//     no config keep-alive responder in the core, and keepAlive:false would
//     hang Paper's configuration phase). The core's own keep-alive answering
//     path stays covered by the fake-leg tests.
//   - teleport_confirm / chunk_batch_received / pong answering stays in the
//     core router (backendLeg.write).
//
// Token custody (live only): the Microsoft auth MUST reuse the G1 custody
// caches in `.secrets/puppet/` (prismarine-auth `<sha1(cacheAccount).slice(0,6)>_*-cache.json`)
// — never mint new refresh tokens. G1's public API (src/auth/cache.js
// createTokenCustody) provides the atomic prismarine-compatible cache
// factory; the flow `username` is set to the cache account so prismarine-auth
// hashes to exactly the G1-managed file names. The custody writer lock is
// held for the process life so `auth status --refresh` refuses while the
// proxy runs (G1 rule: one writer, never double-rotate the rolling token).
//
// Token values never leave this module: no logging of token fields, the cache
// objects, or session secrets. Errors are logged name-only.
import mc from 'minecraft-protocol'

import { createTokenCustody } from '../auth/cache.js'
import { isLoopbackHost } from './offline-identity.js'

// Frames consumed by the library keep-alive plugin, never delivered to the
// core (the core router would answer them a second time).
export const LEG_SWALLOWED = new Set(['keep_alive'])

// Decoded data capture: minecraft-protocol emits, synchronously and in order,
// `packet` (decoded) then the named event then `raw` (frame buffer) for every
// parsed clientbound frame. This forwarder pairs them up: each raw frame is
// delivered to the core together with the decoded data of the same frame.
export function createBackendFrameForwarder ({ deliver, swallowed = LEG_SWALLOWED } = {}) {
  if (typeof deliver !== 'function') throw new TypeError('deliver is required')
  const counters = { frames: 0, swallowed: 0, bundledFramesRelayed: 0, bundledDelimiters: 0 }
  let decoded = { state: null, byName: {} }
  let inBundle = false

  function onPacket (data, meta) {
    decoded.byName[meta.name] = data
    decoded.state = meta.state
  }

  const nameCounts = {}

  function onRaw (buffer, meta) {
    // Same parsed frame as the 'packet' event consumed above (raw fires after
    // packet in client.js emitPacket).
    const sameFrame = decoded.state === meta.state && decoded.byName[meta.name] !== undefined
    const data = sameFrame ? decoded.byName[meta.name] : {}
    decoded.byName[meta.name] = undefined
    nameCounts[`${meta.state}/${meta.name}`] = (nameCounts[`${meta.state}/${meta.name}`] ?? 0) + 1

    // Delimiters group packets for client-side batching; they are not state.
    // Drop the delimiter and relay the enclosed packets as normal frames, so
    // cached chunk/entity data replays without the bundle wrapper.
    if (meta.name === 'bundle_delimiter') {
      inBundle = !inBundle
      counters.bundledDelimiters++
      return
    }
    if (inBundle) counters.bundledFramesRelayed++
    if (swallowed.has(meta.name)) {
      counters.swallowed++
      return
    }
    counters.frames++
    deliver({ state: meta.state ?? decoded.state, name: meta.name, buffer, data })
  }

  function reset () {
    decoded = { state: null, byName: {} }
    inBundle = false
  }

  return { onPacket, onRaw, reset, counters, nameCounts }
}

// Shared body. The constructors own the mode-specific pieces (token custody
// or the offline auth), and this body never chooses the auth path itself.
function createBackendLeg ({
  kind,
  host,
  port,
  version,
  log,
  connectTimeoutMs,
  prepareConnection,
  releaseTokens,
  connectLogFields
}) {
  let frameHandler = null
  let endHandler = null
  let errorHandler = null
  let client = null
  let ended = false
  let forwarder = null
  let closePromise = null

  function onError ({ error } = {}) {
    const message = String(error?.message ?? error).slice(0, 200)
    // Token/auth internals can appear in some library error messages; the
    // core log line passes through redact() but we keep the surface minimal.
    log('backendError', { error: message })
    errorHandler?.({ error })
  }

  function connect () {
    if (client) return Promise.resolve()

    // May throw synchronously (the live writer-lock refusal keeps that shape).
    const connection = prepareConnection()
    log('backendConnect', connectLogFields(connection))

    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null

      const settleResolve = value => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      const settleReject = error => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(error)
      }

      if (connectTimeoutMs > 0) {
        timer = setTimeout(() => {
          settleReject(new Error(`backend connect timed out after ${connectTimeoutMs} ms`))
          releaseTokens()
          try { client?.end('connect_timeout') } catch { /* already down */ }
        }, connectTimeoutMs)
        timer.unref?.()
      }

      try {
        const options = {
          host,
          port,
          version,
          username: connection.username,
          auth: connection.auth,
          keepAlive: true // the plugin answers keep-alives on this leg (both states)
        }
        if (connection.profilesFolder !== undefined) {
          options.profilesFolder = connection.profilesFolder // a function => Authflow uses it as its cache factory
        }
        client = mc.createClient(options)
      } catch (error) {
        releaseTokens()
        log('backendConnectFailed', { error: error.message })
        onError({ error })
        settleReject(error)
        return
      }

      client.on('error', error => {
        onError({ error })
        if (!settled) {
          releaseTokens() // do not hold the token lock after a pre-join failure
          settleReject(error)
        }
      })
      client.on('end', reason => {
        log('backendEnd', { reason: String(reason).slice(0, 120) })
        ended = true
        releaseTokens()
        endHandler?.({ reason: String(reason) })
        // An end before playerJoin is a dead leg: reject instead of handing a
        // half-connected client to the runner (which would then wait out its
        // readiness timeout). After settlement this is a no-op.
        settleReject(new Error(`backend ended before join: ${String(reason).slice(0, 120)}`))
        settleResolve(client)
      })
      client.on('session', session => {
        log('backendSession', { name: session?.selectedProfile?.name ?? null, uuid: session?.selectedProfile?.id ?? null })
      })
      // One backend login = the play-state Login packet (26.x protocol).
      client.on('login', packet => {
        log('backendLegLogin', { entityId: packet.entityId })
      })
      client.on('playerJoin', () => {
        log('backendLegJoin', { joined: true })
        // 26.1 vanilla clients tell the server the level loaded before chunk
        // batching starts (ServerboundPlayerLoaded, empty packet). A leg that
        // skips this may sit in Paper's unbatched fallback — send it once on
        // play entry like the vanilla client does.
        try {
          client.write('player_loaded', {})
          log('backendLegPlayerLoaded', {})
        } catch { /* the leg may already be down */ }
        settleResolve(client)
      })

      forwarder = createBackendFrameForwarder({ deliver: frame => frameHandler?.(frame) })
      client.on('packet', forwarder.onPacket)
      client.on('raw', forwarder.onRaw)
    })
  }

  // --- backendLeg interface (docs/gate-b-b1.md) ---
  return {
    kind,
    connect,
    setFrameHandler (fn) { frameHandler = fn },
    setEndHandler (fn) { endHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    write (name, packet) {
      if (!client) throw new Error('backend leg not connected')
      client.write(name, packet)
    },
    writeRaw (buffer) {
      if (!client) throw new Error('backend leg not connected')
      client.writeRaw(buffer)
    },
    end () {
      ended = true
      try { client?.end('proxy_stopped') } catch { /* already down */ }
      releaseTokens()
    },
    get client () { return client },
    get ended () { return ended },
    forwarderStats () { return forwarder ? { ...forwarder.counters, names: { ...forwarder.nameCounts } } : null },
    close () {
      if (closePromise) return closePromise
      closePromise = new Promise(resolve => {
        const current = client
        if (!current || ended) {
          releaseTokens()
          resolve()
          return
        }
        let done = false
        const finish = () => {
          if (done) return
          done = true
          releaseTokens()
          resolve()
        }
        current.once('end', finish)
        try {
          if (typeof current._end === 'function') current._end('proxy_stopped')
          else current.end('proxy_stopped')
        } catch {
          finish()
        }
      })
      return closePromise
    }
  }
}

export function createLiveBackendLeg (options = {}) {
  const {
    host,
    port,
    version = '26.1',
    cacheDir,
    cacheAccount,
    log = () => {}
  } = options

  if (!host) throw new TypeError('host is required')
  if (!port) throw new TypeError('port is required')
  if (!cacheDir) throw new TypeError('cacheDir is required')
  if (!cacheAccount) throw new TypeError('cacheAccount is required')

  let custody = null
  let lockHeld = false

  function acquireTokens () {
    custody = createTokenCustody({ account: cacheAccount, dir: cacheDir })
    const acquired = custody.writerLock.acquire()
    if (!acquired.ok) {
      const holder = acquired.holder?.pid
      throw new Error(`puppet token custody writer lock held (refusing to touch tokens; holder pid ${holder ?? '?'})`)
    }
    lockHeld = true
    return {
      username: cacheAccount, // cache-key = the G1 custody account
      auth: 'microsoft',
      profilesFolder: custody.cacheFactory
    }
  }

  function releaseTokens () {
    if (lockHeld) { // ONLY this process's lock instance may release
      try { custody?.writerLock.release() } catch { /* best effort on shutdown */ }
      lockHeld = false
    }
  }

  return createBackendLeg({
    kind: 'live-backend-leg',
    host,
    port,
    version,
    log,
    connectTimeoutMs: 0, // live connect behavior is unchanged
    prepareConnection: acquireTokens,
    releaseTokens,
    connectLogFields: () => ({ host, port, cacheAccount, cacheDir, auth: 'microsoft' }) // custody paths only — no token material
  })
}

export function createOfflineBackendLeg (options = {}) {
  const {
    host,
    port,
    version = '26.1',
    username = 'GlowSquidye',
    log = () => {},
    connectTimeoutMs = 15000
  } = options

  if (options.cacheDir !== undefined) {
    throw new TypeError('createOfflineBackendLeg does not accept cacheDir; the offline leg has no token custody')
  }
  if (options.cacheAccount !== undefined) {
    throw new TypeError('createOfflineBackendLeg does not accept cacheAccount; the offline leg has no token custody')
  }
  if (!host) throw new TypeError('host is required')
  if (!port) throw new TypeError('port is required')
  if (!isLoopbackHost(host)) {
    throw new TypeError(`offline backend leg host must be 127.0.0.1 or ::1, got ${JSON.stringify(host)}`)
  }
  if (typeof username !== 'string' || username.length === 0) {
    throw new TypeError('username must be a non-empty string')
  }
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
    throw new TypeError('connectTimeoutMs must be a non-negative number')
  }

  return createBackendLeg({
    kind: 'offline-backend-leg',
    host,
    port,
    version,
    log,
    connectTimeoutMs,
    prepareConnection: () => ({ username, auth: 'offline' }),
    releaseTokens: () => {},
    connectLogFields: () => ({ host, port, username, auth: 'offline' })
  })
}

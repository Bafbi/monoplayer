// The live backend leg (M4/G1 lane): mc.createClient with Microsoft auth.
//
// This is the backendLeg adapter for the B1 core (see docs/gate-b-b1.md):
// it opens ONE authenticated session as the puppet (GlowSquidye) against the
// real backend (Paper G0 direct in B1) and forwards every clientbound
// configuration + login + play frame to the core frame handler as
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
// Token custody: the Microsoft auth MUST reuse the G1 custody caches in
// `.secrets/puppet/` (prismarine-auth `<sha1(cacheAccount).slice(0,6)>_*-cache.json`)
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

// Frames consumed by the library keep-alive plugin, never delivered to the
// core (the core router would answer them a second time).
const LEG_SWALLOWED = new Set(['keep_alive'])

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

  const nameCounts = {}

  function reset () {
    decoded = { state: null, byName: {} }
    inBundle = false
  }

  return { onPacket, onRaw, reset, counters, nameCounts }
}

export function createLiveBackendLeg ({
  host,
  port,
  version = '26.1',
  cacheDir = '.secrets/puppet',
  cacheAccount = 'puppet',
  log = () => {}
} = {}) {
  if (!host) throw new TypeError('host is required')
  if (!port) throw new TypeError('port is required')
  if (!cacheDir) throw new TypeError('cacheDir is required')

  let frameHandler = null
  let endHandler = null
  let errorHandler = null
  let client = null
  let custody = null
  let lockHeldLock = false
  let ended = false

  function lockTokens () {
    custody = createTokenCustody({ account: cacheAccount, dir: cacheDir })
    const acquired = custody.writerLock.acquire()
    if (!acquired.ok) {
      const holder = acquired.holder?.pid
      throw new Error(`puppet token custody writer lock held (refusing to touch tokens; holder pid ${holder ?? '?'})`)
    }
    lockHeldLock = true
  }

  function releaseTokens () {
    if (lockHeldLock) { // ONLY this process's lock instance may release
      try { custody?.writerLock.release() } catch { /* best effort on shutdown */ }
      lockHeldLock = false
    }
  }

  function connect () {
    if (client) return Promise.resolve()
    lockTokens()
    log('backendConnect', { host, port, cacheAccount, cacheDir, auth: 'microsoft' }) // custody paths only — no token material
    return new Promise((resolve, reject) => {
      let settled = false
      try {
        client = mc.createClient({
          host,
          port,
          version,
          // cache-key = the G1 custody account, so prismarine-auth reads/writes
          // the exact cache files G1 created (sha1('puppet') prefix). The real
          // profile (name/uuid) always comes from the fetched session profile.
          username: cacheAccount,
          auth: 'microsoft',
          profilesFolder: custody.cacheFactory, // a function => Authflow uses it as its cache factory
          keepAlive: true // the plugin answers keep-alives on this leg (both states)
        })
      } catch (error) {
        releaseTokens()
        log('backendConnectFailed', { error: error.message })
        onError({ error })
        reject(error)
        return
      }

      client.on('error', error => {
        onError({ error })
        if (!settled) { settled = true; reject(error) }
      })
      client.on('end', reason => {
        if (!settled) { settled = true; resolve(client) /* connected then dropped: leg lifecycle continues via endHandler */ }
        log('backendEnd', { reason: String(reason).slice(0, 120) })
        ended = true
        releaseTokens()
        endHandler?.({ reason: String(reason) })
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
        if (!settled) { settled = true; resolve(client) }
      })

      forwarder = createBackendFrameForwarder({ deliver: frame => frameHandler?.(frame) })
      client.on('packet', forwarder.onPacket)
      client.on('raw', forwarder.onRaw)
    })
  }

  function onError ({ error } = {}) {
    const message = String(error?.message ?? error).slice(0, 200)
    // Token/auth internals can appear in some library error messages; the
    // core log line passes through redact() but we keep the surface minimal.
    log('backendError', { error: message })
    errorHandler?.({ error })
  }

  let forwarder = null

  // --- backendLeg interface (docs/gate-b-b1.md) ---
  return {
    kind: 'live-backend-leg',
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
    close () { // process exit
      try { client?._end?.('proxy_stopped') } catch { /* ignore */ }
      releaseTokens()
    }
  }
}

// The Monoplayer backend leg: one session as the puppet against the backend.
//
// Two constructors share one body, and the offline path is a separate
// constructor, never a config flag:
//   createLiveBackendLeg    Microsoft auth through the G1 token custody,
//                           account directory = .secrets/accounts/<uuid>,
//                           writer lock held.
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
// caches in the account's directory (`.secrets/accounts/<uuid>/`), never mint
// new refresh tokens. G1's public API (src/custody/cache.js createTokenCustody)
// provides the atomic prismarine-compatible cache factory; the factory owns
// the file paths (`<family>-cache.json`). The custody writer lock is held for
// the process life so `auth status --refresh` refuses while the proxy runs
// (G1 rule: one writer, never double-rotate the rolling token).
//
// Token values never leave this module: no logging of token fields, the cache
// objects, or session secrets. Errors are logged name-only.
import mc from 'minecraft-protocol'

import nbt from 'prismarine-nbt'

import { createTokenCustody } from '../custody/cache.js'
import { isLoopbackHost } from './offline-identity.js'

// Frames consumed by the library keep-alive plugin, never delivered to the
// core (the core router would answer them a second time).
export const LEG_SWALLOWED = new Set(['keep_alive'])

// Text component reader for a dialog label. The library decodes the dialog NBT
// into { type, value } wrappers; a label is a compound whose `text` and `extra`
// fields carry the visible string.
function dialogText (node) {
  const value = node?.value ?? node
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(dialogText).join('')
  if (value && typeof value === 'object') {
    const text = typeof value.text?.value === 'string'
      ? value.text.value
      : (typeof value.text === 'string' ? value.text : '')
    const extra = value.extra?.value ?? value.extra
    return `${text}${Array.isArray(extra) ? extra.map(dialogText).join('') : ''}`
  }
  return ''
}

// Choose one action from a `show_dialog` packet. `policy` is `first`, `last`,
// or a case-insensitive label substring. Default is the last action, which is
// the current season on the Excalia selection dialog. Exported for tests; the
// backend leg sends the matching `custom_click_action`.
export function chooseDialogAction (data, policy = 'last') {
  const dialog = data?.dialog?.value ?? data?.dialog ?? data
  const entries = dialog?.actions?.value?.value
  if (!Array.isArray(entries) || entries.length === 0) return null

  const actions = entries.map((entry, index) => {
    const action = entry?.action?.value ?? entry?.action ?? {}
    return {
      index,
      id: action.id?.value ?? action.id ?? null,
      additions: action.additions ?? null,
      type: action.type?.value ?? action.type ?? null,
      label: dialogText(entry?.label)
    }
  }).filter(action => typeof action.id === 'string')

  if (actions.length === 0) return null

  let index = actions.length - 1
  const wanted = String(policy ?? '').toLowerCase()
  if (wanted === 'first') {
    index = 0
  } else if (wanted !== '' && wanted !== 'last') {
    const found = actions.findIndex(action => action.label.toLowerCase().includes(wanted))
    if (found >= 0) index = found
  }

  return {
    ...actions[index],
    total: actions.length,
    dialogType: dialog?.type?.value ?? dialog?.type ?? null
  }
}

// VarInt encoder for the packet id, identifier length, and the payload length.
function varint (value) {
  const out = []
  let n = value
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

// The vanilla `ServerboundCustomClickActionPacket` codec is
//   Identifier id, lengthPrefixed(optional anonymous NBT) payload
// (see the 26.1.2 client: UNTRUSTED_TAG_CODEC = optionalTagCodec.apply(
// lengthPrefixed(65536))). minecraft-data's packet shape omits the length
// prefix, so the library's `write` produces a frame the server rejects. Build
// the body from the dialog's action and send it with writeRaw.
export function buildCustomClickAction ({ state, id, additions }) {
  const packetId = state === 'play' ? 0x44 : state === 'configuration' ? 0x08 : null
  if (packetId === null) return null
  if (typeof id !== 'string' || id.length === 0) return null

  const identifier = Buffer.from(id, 'utf8')
  const tag = additions && additions.value
    ? Buffer.concat([Buffer.from([1]), nbt.writeUncompressed({ type: 'compound', name: '', value: additions.value })])
    : Buffer.from([0])

  return Buffer.concat([
    Buffer.from([packetId]),
    varint(identifier.length),
    identifier,
    varint(tag.length),
    tag
  ])
}

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

// Wrap the library's handshake writer so a followed transfer advertises
// intent 3. minecraft-protocol's setProtocol.js hardcodes nextState 2.
export function withTransferIntent (originalWrite, transfer = true) {
  if (typeof originalWrite !== 'function') throw new TypeError('write is required')
  return (name, params, ...rest) => {
    if (transfer && name === 'set_protocol' && params && typeof params === 'object') {
      return originalWrite(name, { ...params, nextState: 3 }, ...rest)
    }
    return originalWrite(name, params, ...rest)
  }
}

function textReason (reason) {
  if (typeof reason === 'string') return reason.slice(0, 300)
  try { return JSON.stringify(reason).slice(0, 300) } catch { return null }
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
  dialogAction,
  prepareConnection,
  releaseTokens,
  connectLogFields,
  validateTarget = () => true
}) {
  let frameHandler = null
  let endHandler = null
  let errorHandler = null
  let client = null
  let ended = false
  let forwarder = null
  let closePromise = null
  // Cookies are per backend chain: a transfer target is another front of the
  // same network and may need the cookie the previous front stored. The jar
  // clears only when the orchestrator returns to the configured base target.
  const cookies = new Map()
  let target = { host, port }
  // A client that follows a transfer handshakes with intent 3 (TRANSFER), not
  // 2 (LOGIN). Direct-login-only targets reject intent 2 with a custom message
  // (sky-2: "Vous ne pouvez pas vous connecter ... par cette méthode!").
  let nextTransferIntent = false

  function onError ({ error } = {}) {
    const message = String(error?.message ?? error).slice(0, 200)
    // Token/auth internals can appear in some library error messages; the
    // core log line passes through redact() but we keep the surface minimal.
    log('backendError', { error: message })
    errorHandler?.({ error })
  }

  function connect () {
    // A live client that has not ended is already connected. An ended client
    // is cleared by its end handler, so a reconnect creates a fresh one.
    if (client && !ended) return Promise.resolve()

    // May throw synchronously (the live writer-lock refusal keeps that shape).
    // A reconnect re-acquires the custody lock the ended connection released.
    const connection = prepareConnection()
    log('backendConnect', connectLogFields(connection, target))
    ended = false

    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      let socketClient = null

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
          try { socketClient?.end('connect_timeout') } catch { /* already down */ }
        }, connectTimeoutMs)
        timer.unref?.()
      }

      try {
        const options = {
          host: target.host,
          port: target.port,
          version,
          username: connection.username,
          auth: connection.auth,
          keepAlive: true // the plugin answers keep-alives on this leg (both states)
        }
        if (connection.profilesFolder !== undefined) {
          options.profilesFolder = connection.profilesFolder // a function => Authflow uses it as its cache factory
        }
        socketClient = mc.createClient(options)
        client = socketClient
        if (nextTransferIntent) socketClient.write = withTransferIntent(socketClient.write.bind(socketClient), true)
      } catch (error) {
        releaseTokens()
        log('backendConnectFailed', { error: error.message })
        onError({ error })
        settleReject(error)
        return
      }

      socketClient.on('error', error => {
        onError({ error })
        if (!settled) {
          releaseTokens() // do not hold the token lock after a pre-join failure
          settleReject(error)
        }
      })
      // The target's rejection reason is otherwise invisible: the leg only
      // sees the socket close. Log it (text only, no secrets).
      socketClient.on('disconnect', data => {
        log('backendDisconnect', { state: socketClient.state, reason: textReason(data?.reason) })
      })
      socketClient.on('kick_disconnect', data => {
        log('backendKick', { reason: textReason(data?.reason) })
      })
      socketClient.on('end', reason => {
        log('backendEnd', { reason: String(reason).slice(0, 120) })
        // Only the current connection owns the teardown: a late end from a
        // client this leg already replaced must not release the fresh lock or
        // clear the fresh client.
        if (client === socketClient) {
          ended = true
          releaseTokens()
          endHandler?.({ reason: String(reason) })
          client = null // connect() may now create a new client
        }
        // An end before playerJoin is a dead leg: reject instead of handing a
        // half-connected client to the runner (which would then wait out its
        // readiness timeout). After settlement this is a no-op.
        settleReject(new Error(`backend ended before join: ${String(reason).slice(0, 120)}`))
        settleResolve(socketClient)
      })
      socketClient.on('session', session => {
        log('backendSession', { name: session?.selectedProfile?.name ?? null, uuid: session?.selectedProfile?.id ?? null })
      })
      // One backend login = the play-state Login packet (26.x protocol).
      socketClient.on('login', packet => {
        log('backendLegLogin', { entityId: packet.entityId })
      })
      socketClient.on('playerJoin', () => {
        log('backendLegJoin', { joined: true })
        // 26.1 vanilla clients tell the server the level loaded before chunk
        // batching starts (ServerboundPlayerLoaded, empty packet). A leg that
        // skips this may sit in Paper's unbatched fallback — send it once on
        // play entry like the vanilla client does.
        try {
          socketClient.write('player_loaded', {})
          log('backendLegPlayerLoaded', {})
        } catch { /* the leg may already be down */ }
        settleResolve(socketClient)
      })

      // A public server may present a configuration or play dialog (season
      // selection, rules, queue). A headless puppet cannot click it; answer
      // with the configured action. Only `custom_click_action` dialogs are
      // handled; anything else is logged and left alone.
      let dialogResponses = 0
      socketClient.on('show_dialog', data => {
        if (!dialogAction) {
          log('dialogUnhandled', { reason: 'no_policy' })
          return
        }
        if (dialogResponses >= 5) {
          log('dialogUnhandled', { reason: 'too_many' })
          return
        }
        const choice = chooseDialogAction(data, dialogAction)
        if (!choice) {
          log('dialogUnhandled', { reason: 'no_action' })
          return
        }
        const body = buildCustomClickAction({
          state: socketClient.state,
          id: choice.id,
          additions: choice.additions
        })
        if (!body) {
          log('dialogUnhandled', { reason: 'unsupported_state', state: socketClient.state })
          return
        }
        dialogResponses++
        try {
          socketClient.writeRaw(body)
          log('dialogClicked', {
            dialogType: choice.dialogType,
            index: choice.index,
            total: choice.total,
            label: choice.label,
            bytes: body.length
          })
        } catch (error) {
          log('dialogClickFailed', { error: String(error?.message ?? error).slice(0, 200) })
        }
      })

      // One forwarder per connection: counters and pairing state never leak
      // across a reconnect. Cookies are answered on this leg; the core blocks
      // them from the front.
      forwarder = createBackendFrameForwarder({
        deliver: frame => {
          if (frame.name === 'store_cookie' && typeof frame.data?.key === 'string') {
            cookies.set(frame.data.key, frame.data.value)
          } else if (frame.name === 'cookie_request' && typeof frame.data?.cookie === 'string') {
            try {
              socketClient.write('cookie_response', {
                key: frame.data.cookie,
                value: cookies.get(frame.data.cookie) ?? undefined
              })
            } catch (error) {
              log('cookieResponseFailed', { error: String(error?.message ?? error).slice(0, 200) })
            }
          }
          frameHandler?.(frame)
        }
      })
      socketClient.on('packet', forwarder.onPacket)
      socketClient.on('raw', forwarder.onRaw)
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
    // Point the next connect at another backend. The caller must have ended
    // the current connection first. `keepCookies` carries the session cookie
    // across a transfer chain; a return to the base target clears it.
    // `transfer` makes the next handshake use intent 3.
    setTarget (next = {}, { keepCookies = false, transfer = false } = {}) {
      if (client && !ended) throw new Error('cannot change the backend target while connected')
      const nextHost = typeof next.host === 'string' ? next.host.trim() : ''
      const nextPort = Number(next.port)
      if (!nextHost || !Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
        throw new TypeError('invalid backend target')
      }
      if (!validateTarget({ host: nextHost, port: nextPort })) {
        throw new TypeError(`backend target rejected: ${nextHost}:${nextPort}`)
      }
      target = { host: nextHost, port: nextPort }
      nextTransferIntent = transfer === true
      if (!keepCookies) cookies.clear()
      return { ...target }
    },
    get target () { return { ...target } },
    get cookieCount () { return cookies.size },
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
    accountDir = null,
    account = null,
    uuid = null,
    authTitle = null,
    deviceType = null,
    cacheDir = null,
    cacheAccount = null,
    dialogAction = null,
    log = () => {}
  } = options

  if (!host) throw new TypeError('host is required')
  if (!port) throw new TypeError('port is required')
  if (accountDir && cacheDir) {
    // The raw directory override is deprecated; the account directory wins.
    try {
      log('deprecation', {
        message: 'cacheDir is deprecated and ignored when accountDir is set',
        accountDir,
        cacheDir
      })
    } catch { /* logging must not break construction */ }
  }
  const dir = accountDir ?? cacheDir
  if (!dir) throw new TypeError('accountDir is required (cacheDir is deprecated)')

  let custody = null
  let lockHeld = false

  function acquireTokens () {
    custody = createTokenCustody({
      account: account ?? cacheAccount ?? null,
      dir,
      uuid,
      create: false,
      legacyAccount: cacheAccount ?? account ?? null
    })
    if (typeof custody.cacheFactory !== 'function') {
      throw new TypeError('token custody did not provide a cache factory')
    }
    const acquired = custody.writerLock.acquire()
    if (!acquired.ok) {
      const holder = acquired.holder?.pid
      throw new Error(`puppet token custody writer lock held (refusing to touch tokens; holder pid ${holder ?? '?'})`)
    }
    lockHeld = true
    const connection = {
      username: uuid ?? account ?? cacheAccount,
      auth: 'microsoft',
      profilesFolder: custody.cacheFactory
    }
    // Only override the library defaults when the profile recorded a working
    // title/device pair; otherwise let minecraft-protocol pick its default.
    if (authTitle !== null) connection.authTitle = authTitle
    if (deviceType !== null) connection.deviceType = deviceType
    // Passing authTitle disables the library's defaulting, so set the flow and
    // device type explicitly. 'live' is the Java flow.
    connection.flow = 'live'
    return connection
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
    // A followed target that accepts TCP and then stalls must not leave the
    // connect promise pending forever; the timeout releases the token lock.
    connectTimeoutMs: 60_000,
    dialogAction,
    prepareConnection: acquireTokens,
    releaseTokens,
    // Custody paths and identity labels only — no token material. cacheAccount
    // is a legacy selector, never an identity label.
    connectLogFields: (connection, currentTarget) => ({
      host: currentTarget.host,
      port: currentTarget.port,
      accountUuid: uuid ?? custody?.uuid ?? null,
      accountAlias: account ?? null,
      dir,
      auth: 'microsoft'
    })
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
  if (options.accountDir !== undefined) {
    throw new TypeError('createOfflineBackendLeg does not accept accountDir; the offline leg has no token custody')
  }
  if (options.account !== undefined) {
    throw new TypeError('createOfflineBackendLeg does not accept account; the offline leg has no token custody')
  }
  if (options.uuid !== undefined) {
    throw new TypeError('createOfflineBackendLeg does not accept uuid; the offline leg has no token custody')
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
    dialogAction: null,
    prepareConnection: () => ({ username, auth: 'offline' }),
    releaseTokens: () => {},
    connectLogFields: (connection, currentTarget) => ({
      host: currentTarget.host,
      port: currentTarget.port,
      username,
      auth: 'offline'
    }),
    validateTarget: next => isLoopbackHost(next.host)
  })
}

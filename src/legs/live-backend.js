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
// This is the backendLeg adapter for the B1 core (see docs/product-core.md):
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
//   - the library's own code-of-conduct accept is a leg decision, not a library
//     one: `withCodeOfConductGate` holds it while a client is attached and sends
//     it with a log line when none is (#21).
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
// backend leg sends the matching `custom_click_action`. Which dialogs this
// runs for is `decideDialogAutoAnswer`'s decision, not this function's.
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

// #16/#20: who answers a control dialog.
//
// A play dialog is the human's, always: the attached client answers it, or it
// waits in the core's pending holder until one attaches. The puppet never
// clicks one, attached or not, so `MONOPLAYER_DIALOG_ACTION` covers the
// configuration phase only (#20). What a headless puppet does with a
// configuration gate is #21's decision; this function keeps the fallback that
// ticket needs.
//
// One decision, consulted per dialog, so a client that attaches mid-session
// changes the answer without rebuilding the leg.
export function decideDialogAutoAnswer ({ dialogAction, humanAttached, state }) {
  // The phase is checked first, so a play dialog always reports the same reason
  // whether or not a policy is configured. An allow-list, so a state nobody
  // named fails closed and waits for a human instead of clicking.
  if (state !== 'configuration') {
    return { auto: false, reason: state === 'play' ? 'play_dialog_waits' : 'unsupported_state' }
  }
  if (!dialogAction) return { auto: false, reason: 'no_policy' }
  if (humanAttached) return { auto: false, reason: 'human_attached' }
  return { auto: true, reason: null }
}

// The most dialog answers one backend connection may attempt. A server that
// keeps asking is a loop, not a gate.
const DIALOG_ATTEMPT_LIMIT = 5

// Answer one `show_dialog` the backend asked, on the puppet's own connection.
//
// `state` is the puppet's phase, not the client's: it decides whether the
// puppet may answer at all. Exported with its IO injected, like
// `emitCheckedRaw` in the front leg, so a test can prove that no click happens
// without standing up a socket.
export function answerBackendDialog ({
  state = null,
  data = null,
  dialogAction = null,
  humanAttached = false,
  responses = 0,
  writeRaw = () => {},
  onAnswered = null,
  log = () => {}
} = {}) {
  const decision = decideDialogAutoAnswer({ dialogAction, humanAttached, state })
  if (!decision.auto) {
    log('dialogUnhandled', { state, reason: decision.reason })
    return { answered: false, reason: decision.reason, responses }
  }
  if (responses >= DIALOG_ATTEMPT_LIMIT) {
    log('dialogUnhandled', { state, reason: 'too_many' })
    return { answered: false, reason: 'too_many', responses }
  }
  const choice = chooseDialogAction(data, dialogAction)
  if (!choice) {
    log('dialogUnhandled', { state, reason: 'no_action' })
    return { answered: false, reason: 'no_action', responses }
  }
  const body = buildCustomClickAction({ state, id: choice.id, additions: choice.additions })
  if (!body) {
    // The state is known to be configuration here, so a null body means the
    // chosen action carried no usable id.
    log('dialogUnhandled', { state, reason: 'no_id' })
    return { answered: false, reason: 'no_id', responses }
  }
  const next = responses + 1
  try {
    writeRaw(body)
    log('dialogClicked', {
      state,
      dialogType: choice.dialogType,
      index: choice.index,
      total: choice.total,
      label: choice.label,
      bytes: body.length
    })
    // This frame answers the dialog before the core sees it, so the core must
    // not hold it as the human's question.
    onAnswered?.({ state, name: 'show_dialog' })
    return { answered: true, responses: next }
  } catch (error) {
    log('dialogClickFailed', { error: String(error?.message ?? error).slice(0, 200) })
    return { answered: false, reason: 'write_failed', responses: next }
  }
}

// #21: who answers a configuration gate. The protocol library answers the code
// of conduct itself, inside its own configuration handler, before any frame
// reaches the core (docs/transparency.md). Wrap the connection's writer so that
// accept becomes this leg's decision:
//   - a client is attached: the library's frame is swallowed and the gate stays
//     open. The human receives it through the core's control path (#16) and
//     their answer travels back as the puppet's own frame. No timeout: an
//     attached client keeps the gate as long as it takes.
//   - no client is attached: the frame goes out and is logged, so a headless
//     session is not left at a gate.
// The accept leaves before the core sees the gate frame, so the leg reports it
// through `onDialogAnswered` and the holder never offers a closed gate to the
// next client. A configuration click (#20) and this accept are the two frame
// writes the leg makes on its own, and both report the answer the same way.
//
// Every other frame passes through untouched. The wrapper is installed on every
// connection, so a reconnect cannot slip past it.
export function withCodeOfConductGate (originalWrite, {
  isHumanAttached = () => false,
  onDialogAnswered = null,
  log = () => {}
} = {}) {
  if (typeof originalWrite !== 'function') throw new TypeError('write is required')
  if (typeof isHumanAttached !== 'function') throw new TypeError('isHumanAttached must be a function')

  return (name, params, ...rest) => {
    if (name !== 'accept_code_of_conduct') return originalWrite(name, params, ...rest)
    if (isHumanAttached() === true) {
      log('codeOfConductHeld', { reason: 'human_attached' })
      return false
    }
    try {
      originalWrite(name, params, ...rest)
    } catch (error) {
      // A failed accept is not an answer: leave the gate for a human.
      log('codeOfConductAcceptFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return false
    }
    log('codeOfConductAccepted', { reason: 'no_client' })
    onDialogAnswered?.({ state: 'configuration', name: 'code_of_conduct' })
    return true
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
  // Consulted per dialog, so a leg built before any client exists still
  // answers correctly once one attaches. The orchestrator reads the core.
  isHumanAttached = () => false,
  // Reported after the leg answers a dialog itself, so the core's pending
  // holder does not offer an answered question to the next client (#16).
  onDialogAnswered = null,
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
        let write = socketClient.write.bind(socketClient)
        if (nextTransferIntent) write = withTransferIntent(write, true)
        // #21: the library's own code-of-conduct accept passes through this one
        // choke point, on every connection. Only `write` is wrapped: the human's
        // answer travels through `writeRaw` below, so the gate never holds it.
        socketClient.write = withCodeOfConductGate(write, { isHumanAttached, onDialogAnswered, log })
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
        // Once per backend connection, and before any chat: whether this
        // session can sign what it says. The library signs only with both the
        // profile keys and the session that registered them
        // (`canSign = client.profileKeys && client._session`), and sends an
        // unsigned frame otherwise rather than failing, so a live run reads
        // this line instead of inferring it from a server-side rejection.
        log('chatCapability', {
          signed: Boolean(socketClient.profileKeys && socketClient._session)
        })
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

      // A play dialog is never answered here (#20): it waits for a human in the
      // core's pending holder. A configuration-phase gate may be answered with
      // the configured action while no human can answer it (#21). Only
      // `custom_click_action` dialogs are handled; anything else is logged and
      // left alone.
      let dialogResponses = 0
      socketClient.on('show_dialog', data => {
        const outcome = answerBackendDialog({
          state: socketClient.state,
          data,
          dialogAction,
          humanAttached: isHumanAttached() === true,
          responses: dialogResponses,
          writeRaw: body => socketClient.writeRaw(body),
          onAnswered: onDialogAnswered,
          log
        })
        dialogResponses = outcome.responses
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

  // --- backendLeg interface (docs/product-core.md) ---
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
    // #19: speak the human's text as the puppet. The library's signed-chat
    // path signs with this connection's profile keys, fills the acknowledgement
    // bitset and checksum from this connection's last-seen window, and picks
    // `chat_command_signed` or `chat_command`. Building that by hand would
    // duplicate the window tracking the library already does here, so the leg
    // calls it.
    chat (text) {
      if (!client || ended) throw new Error('backend leg not connected')
      if (typeof text !== 'string' || text.length === 0) throw new TypeError('chat text is required')
      // The public alias is assigned when the client reaches play; the private
      // signer is the same function under its own name. Prefer the public one
      // and fall back, so one rename in a library bump does not break chat.
      const speak = typeof client.chat === 'function' ? client.chat : client._signedChat
      if (typeof speak !== 'function') {
        throw new Error('minecraft-protocol has no chat path')
      }
      speak.call(client, text)
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
    isHumanAttached: options.isHumanAttached ?? (() => false),
    onDialogAnswered: options.onDialogAnswered ?? null,
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
    connectTimeoutMs = 15000,
    // The configuration-gate policy, so a rung can run one and prove it does
    // not reach play (#20). Off by default: an offline leg answers nothing.
    dialogAction = null,
    // #21: the offline rung answers a code-of-conduct gate the same way the
    // live leg does, so the loopback can prove the fallback end to end.
    isHumanAttached = () => false,
    onDialogAnswered = null
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
    dialogAction,
    isHumanAttached,
    onDialogAnswered,
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

// The Monoplayer backend leg: one session as the puppet against the backend.
//
// Two constructors share one body, and the offline path is a separate
// constructor, never a config flag:
//   createLiveBackendLeg    Microsoft auth through the G1 token custody,
//                           account directory = .secrets/accounts/<uuid>,
//                           writer lock held.
//   createOfflineBackendLeg auth 'offline', fixed username, loopback only unless
//                         allowNonLoopback,
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
//   - `answerBackendDialog` and `answerHeldGate` decide WHO answers a
//     configuration gate and when, which is this adapter's business. What the
//     answer is and how the click is framed is a codec shared with the protocol
//     bot, so it lives in src/core/dialog-codec.js (#105).
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

import { bumpBounded } from '../core/bounded-counter.js'
import { buildCustomClickAction, chooseDialogAction, decideDialogAutoAnswer } from '../core/dialog-codec.js'
import { stampIdentity } from '../core/channels.js'
import { pickSlug } from '../core/picker.js'
import { createTokenCustody } from '../custody/cache.js'
import { isLoopbackHost } from './offline-identity.js'

// Frames consumed by the library keep-alive plugin, never delivered to the
// core (the core router would answer them a second time).
export const LEG_SWALLOWED = new Set(['keep_alive'])

// The most dialog answers one backend connection may attempt. A server that
// keeps asking is a loop, not a gate.
const DIALOG_ATTEMPT_LIMIT = 5

// How long close() waits for the socket it ended to report its own end (#662).
// The event comes back from the kernel, so the wait is the socket's, not a number
// of turns. The bound is the leg's, not each caller's: a wedged peer must not hold
// a shutdown, and the library's own close timeout bounds the same wait at 30 s,
// which is a shutdown an operator ends by hand.
//
// The number repeats the bot's bound (src/ladder/bot.js:239-243) rather than
// importing it, because the legs sit below the ladder: a rung imports a leg, never
// the reverse.
const END_TIMEOUT_MS = 2000

// How long a close waits, after destroying the socket it gave up on, for the end
// that destroy reports. A destroyed socket reports its close on a later turn, and
// the leg's end handler runs on that event, so a close that destroyed and returned
// would answer ahead of the fault this leg reports. This bound covers only a client
// whose socket never attached, where a destroy reaches nothing to report.
const AFTER_DESTROY_MS = 250

// #432: the body a target derives, the slug a claim names it with
// (src/core/picker.js). A target that names no address is no body, so no record
// names one for it (#263 D2). The port is read as the config document spells it,
// a number or the quoted string a JSON file can hold, because `pickSlug` reads
// either and a leg that dials one should name the body a claim names.
export function bodySlugFor (target) {
  const host = target?.host
  const port = target?.port
  const namedHost = typeof host === 'string' && host.length > 0
  const namedPort = (typeof port === 'number' && Number.isFinite(port)) ||
    (typeof port === 'string' && port.length > 0)
  return namedHost && namedPort ? pickSlug(host + ':' + port) : null
}

// A log that names the body of the target it reads at each call. The target is a
// function because a claim moves it, and each record belongs to the connection or
// the constructor that wrote it.
function recordsFor (sinkLog, targetOf) {
  return (event, fields = {}) =>
    sinkLog(event, stampIdentity(fields, { body: bodySlugFor(targetOf()) }))
}

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

// #73: who answers a configuration gate the last player left open.
//
// A detach is "no player is attached" becoming true, which is exactly the
// condition the gate fallback names (#21), so the core asks for that answer once
// its last client is gone. The core holds the frame, because a dialog with no
// client waits in its pending holder (#16); this decides what to send.
//
// The code of conduct is the accept the protocol library wrote and this leg
// swallowed, so the answer goes back through the same write wrapper: it leaves
// only while no player is attached, the wrapper logs it, and a player who
// attached in the meantime keeps the gate as theirs. A gate with buttons takes
// the configured action, the same policy a headless session uses (#20).
//
// IO is injected, like `answerBackendDialog`, so a test can prove the answer
// without standing up a socket. Every answer is reported through `onAnswered`,
// the way the wrapper reports an accept, so the core learns the gate is closed
// through one call whatever the gate was. The core spends that marker: the
// show it belongs to has already happened.
export function answerHeldGate ({
  state = null,
  name = null,
  data = null,
  connectionState = null,
  dialogAction = null,
  // The answers this connection already made, so a detach cannot reset the
  // click cap a looping server is held to.
  responses = 0,
  write = null,
  writeRaw = null,
  onAnswered = null,
  log = () => {}
} = {}) {
  // Only a configuration gate is the fallback's: a play dialog is the human's
  // (#20), answered by the client or held for the next one.
  if (state !== 'configuration') return { answered: false, reason: 'not_a_gate', name, responses }
  // The packet id is state-scoped, so an answer written into the wrong phase is
  // a different packet, and the backend ends the session for it.
  if (connectionState !== 'configuration') return { answered: false, reason: 'not_configuring', name, responses }
  if (typeof write !== 'function') return { answered: false, reason: 'no_connection', name, responses }
  if (name === 'code_of_conduct') {
    // The wrapper holds a gate a client attached for, and reports a failed
    // write, both as false. Its own log line says which, so this only reports
    // that nothing was written.
    return write('accept_code_of_conduct', {}) === false
      ? { answered: false, reason: 'not_written', name, responses }
      : { answered: true, reason: null, name, responses }
  }
  const outcome = answerBackendDialog({
    state,
    data,
    dialogAction,
    humanAttached: false,
    responses,
    writeRaw,
    onAnswered,
    log
  })
  return { answered: outcome.answered === true, reason: outcome.reason ?? null, name, responses: outcome.responses }
}

// The library's reader for the `topBitSetTerminatedArray` protocol type clears
// the high bit of every slot byte in the frame it decodes, in place
// (minecraft-protocol datatypes/compiler-minecraft.js:
// `buffer[cursor] = buffer[cursor] & 127`; the interpreter reader does the same).
// That bit is the array's terminator flag, so decoding a multi-entry
// `entity_equipment` frame rewrites the bytes the leg is about to relay: the
// client reads one entry and disconnects on the rest as trailing bytes (#82).
//
// Parse a throwaway copy and report the caller's own bytes, so `buffer` stays
// the frame the backend sent. The library builds a fresh deserializer on every
// state change (`set state` calls `setSerializer`), so the guard covers the
// current one and every later one.
export function keepWireBytes (client) {
  if (!client || typeof client !== 'object') throw new TypeError('client is required')

  function guard (deserializer) {
    if (!deserializer || typeof deserializer.parsePacketBuffer !== 'function') return deserializer
    if (deserializer.keepsWireBytes) return deserializer
    const parse = deserializer.parsePacketBuffer.bind(deserializer)
    deserializer.parsePacketBuffer = (buffer, offset = 0) => {
      const parsed = parse(Buffer.from(buffer), offset)
      // The parse ran on the copy; report the frame the caller handed us.
      parsed.buffer = buffer.subarray(offset, offset + parsed.metadata.size)
      parsed.fullBuffer = buffer
      return parsed
    }
    deserializer.keepsWireBytes = true
    return deserializer
  }

  guard(client.deserializer)
  // The library keeps the deserializer it builds for each state. Guarding the
  // builder covers login, configuration, and play.
  if (typeof client.setSerializer === 'function') {
    const setSerializer = client.setSerializer.bind(client)
    client.setSerializer = (...args) => {
      setSerializer(...args)
      guard(client.deserializer)
    }
  }
  return client
}

// #554: how many distinct clientbound frames this leg's name map holds. The 26.1 and
// 26.2 clientbound vocabulary is 167 `state/name` pairs — login 6, configuration 20,
// play 141, one line each from `node tools/protocol.mjs packets <version> <state>
// toClient` — so the cap is that vocabulary plus room for a version to add frames
// before anyone looks again. The map is copied into every heartbeat line, so its size
// is a log line's size: past the cap it holds one bucket more and grows no further.
export const MAX_BACKEND_FRAME_NAMES = 256

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
    bumpBounded(nameCounts, `${meta.state}/${meta.name}`, MAX_BACKEND_FRAME_NAMES)

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
  log: sinkLog,
  connectTimeoutMs,
  endTimeoutMs = END_TIMEOUT_MS,
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
  // #824: a call-in is one slot, filled once. The core fills every slot its table
  // declares when it starts (src/service/wire-leg-to-core.js), so a registration a lane
  // makes before that start is replaced by the core's, and one made after it replaces the
  // core's. Both were a plain assignment, and the wiring report could see neither: it
  // measures the leg's shape at the call, so a name present was a name carried whether or
  // not the handler installed there was the one the core built. The front leg keeps the
  // same rule for its own slots (src/legs/live-front.js).
  //
  // A repeat of the same function is refused too. A registration is a write, not a call,
  // and a leg that answers the second write with silence is the leg #824 found.
  const filled = new Set()
  function fillSlot (name, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(name + ' takes the function a call-in is answered with (#824)')
    }
    if (filled.has(name)) {
      throw new TypeError(name + ' is already filled on this leg, and a call-in is one slot (#824): ' +
        'the core fills the slots its table declares in its start(), so the first registration stands ' +
        'and the second is refused rather than replacing a handler nobody could then name')
    }
    filled.add(name)
    return fn
  }

  let frameHandler = null
  let endHandler = null
  let errorHandler = null
  let client = null
  let ended = false
  let forwarder = null
  let closePromise = null
  // Dialog answers this connection made, against DIALOG_ATTEMPT_LIMIT. Per
  // connection, and shared with the detach answer (#73) so that path cannot
  // reset the cap a looping server is held to.
  let dialogResponses = 0
  // Cookies are per backend chain: a transfer target is another front of the
  // same network and may need the cookie the previous front stored. The jar
  // clears only when the orchestrator returns to the configured base target.
  const cookies = new Map()
  let target = { host, port }
  // A client that follows a transfer handshakes with intent 3 (TRANSFER), not
  // 2 (LOGIN). Direct-login-only targets reject intent 2 with a custom message
  // (sky-2: "Vous ne pouvez pas vous connecter ... par cette méthode!").
  let nextTransferIntent = false

  function connect () {
    // A live client that has not ended is already connected. An ended client
    // is cleared by its end handler, so a reconnect creates a fresh one.
    if (client && !ended) return Promise.resolve()

    // May throw synchronously (the live writer-lock refusal keeps that shape).
    // A reconnect re-acquires the custody lock the ended connection released.
    const connection = prepareConnection()
    // #432: every record this connection writes names the body it dialled, not
    // only the address. The body is captured here rather than read from the leg,
    // because an event can arrive after a claim has moved the leg to another
    // body, and a record about this socket names the body this socket dialled.
    const dialled = { ...target }
    const log = recordsFor(sinkLog, () => dialled)
    log('backendConnect', connectLogFields(connection, dialled))
    ended = false
    // A dial is a new socket, so the teardown a caller waits on is this
    // connection's (#662): a close() after a reconnect must answer for the
    // socket that reconnect opened, not for the one it replaced.
    closePromise = null

    function onError ({ error } = {}) {
      const message = String(error?.message ?? error).slice(0, 200)
      // Token/auth internals can appear in some library error messages; the
      // core log line passes through redact() but we keep the surface minimal.
      log('backendError', { error: message })
      errorHandler?.({ error })
    }

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
        socketClient = keepWireBytes(mc.createClient(options))
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
      dialogResponses = 0
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
    setFrameHandler (fn) { frameHandler = fillSlot('setFrameHandler', fn) },
    setEndHandler (fn) { endHandler = fillSlot('setEndHandler', fn) },
    setErrorHandler (fn) { errorHandler = fillSlot('setErrorHandler', fn) },
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
    // #73: the last client left while a configuration gate was held. The core
    // holds the frame, so it asks for the answer the gate fallback would have
    // given had nobody been attached when the gate arrived. Answers through the
    // same write wrapper, so who answers a code of conduct is decided in one
    // place. The exported helper above, with this connection's IO.
    answerHeldGate ({ state = null, name = null, data = null } = {}) {
      if (!client || ended) return { answered: false, reason: 'no_connection', name }
      const outcome = answerHeldGate({
        state,
        name,
        data,
        connectionState: client.state,
        dialogAction,
        responses: dialogResponses,
        write: (packetName, params) => client.write(packetName, params),
        writeRaw: body => client.writeRaw(body),
        onAnswered: onDialogAnswered,
        // #432: no connection owns this answer, so the leg's current target is
        // the body it is about.
        log: recordsFor(sinkLog, () => target)
      })
      dialogResponses = outcome.responses
      return outcome
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
    // Resolves once the socket this leg ended has reported its own end (#662),
    // not once the decision to end it was taken. `end()` sets `ended` and asks the
    // socket to close; the event comes back from the kernel, and the handler
    // connect() installed for it is where the fault the core schedules a
    // reconnect on is reported (src/core/session.js:232). A caller that awaits this
    // and then reads a ledger reads a socket that has ended — or, on the bound
    // below, one this leg destroyed, whose end handler runs the turn after.
    //
    // Teardown order here: the socket, then the tokens, then the caller. The
    // custody writer lock is what keeps a token rotation from signing out the
    // session this socket still holds (the custody rule in this file's header), so
    // a close that ends the socket itself releases it only once the socket is gone.
    // `end()` releases at its own call instead, before the socket ends, because a
    // stop that never reaches close() must not hold the lock behind a socket that
    // may never report; on that path the release here is a no-op (`lockHeld` in
    // the live constructor's releaseTokens).
    close () {
      if (closePromise) return closePromise
      closePromise = new Promise(resolve => {
        const current = client
        let done = false
        let bound = null
        const settle = () => {
          if (done) return
          done = true
          clearTimeout(bound)
          current?.removeListener('end', settle)
          // Only the connection this close ended may release the tokens. A dial that
          // landed while this waited took the writer lock for its own socket, and
          // freeing it here would hand the account to a second writer while the leg
          // is still using it. The end handler reads the same identity, and drops the
          // client to null on its way out.
          if (client === current || client === null) releaseTokens()
          resolve()
        }
        // Nothing live to wait for: the leg never dialled, or the socket has
        // already ended and its handler dropped the client it held. The second
        // reading is the library's own flag, which is true only after its end
        // event fired, so a listener added now would wait out the bound instead.
        if (!current || current.ended === true) {
          releaseTokens()
          resolve()
          return
        }
        // A peer that never closes must not hold the caller. The bound destroys the
        // socket it gave up on, as the bot's close does (src/ladder/bot.js:239-243),
        // so a close that resolved without the event leaves no connection behind it.
        bound = setTimeout(() => {
          try { current.socket?.destroy() } catch { /* already gone */ }
          bound = setTimeout(settle, AFTER_DESTROY_MS)
          bound.unref?.()
        }, endTimeoutMs)
        bound.unref?.()
        current.once('end', settle)
        // `end()` asked already: a second ask re-runs a close that is in flight, so
        // this close waits for the socket and asks for nothing.
        if (ended) return
        // No `_end` branch (#713): the library assigns `_end` only to a client its
        // own server accepted (minecraft-protocol/src/server.js), and this leg only
        // ever holds one from `mc.createClient`, where it is undefined.
        try {
          current.end('proxy_stopped')
        } catch {
          settle()
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
      // #432: this record is written before the leg exists, so it reads the target
      // the constructor was given rather than the one the leg would hold.
      const record = recordsFor(log, () => ({ host, port }))
      record('deprecation', {
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

// #391: the name an offline body speaks as when the lane names none. Exported
// because the composition root derives the body's UUID from it, and two copies
// of a default are two identities.
export const OFFLINE_PUPPET_USERNAME = 'GlowSquidye'

export function createOfflineBackendLeg (options = {}) {
  const {
    host,
    port,
    version = '26.1',
    username = OFFLINE_PUPPET_USERNAME,
    log = () => {},
    connectTimeoutMs = 15000,
    // How long close() waits for a socket that has not reported its end (#662).
    // A rung that needs the bound reached says so; unset takes the leg's default.
    endTimeoutMs,
    // The configuration-gate policy, so a rung can run one and prove it does
    // not reach play (#20). Off by default: an offline leg answers nothing.
    dialogAction = null,
    // #21: the offline rung answers a code-of-conduct gate the same way the
    // live leg does, so the loopback can prove the fallback end to end.
    isHumanAttached = () => false,
    onDialogAnswered = null,
    // #391: the loopback fence below is what keeps an offline body inside a
    // test rig. A deployed lane whose job is a test double dials a Paper in
    // another pod, so the composition root lifts the fence with this option and
    // nothing else does. The live lane cannot reach it: the service passes it
    // only with MONOPLAYER_OFFLINE_LEGS on, and that key is barred from
    // deploy/manifests (test/tooling/live-manifests.test.js).
    allowNonLoopback = false
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
  // A truthy string would lift the fence as surely as true, so the option is a
  // boolean or it is refused.
  if (typeof allowNonLoopback !== 'boolean') {
    throw new TypeError('allowNonLoopback must be a boolean')
  }
  if (!allowNonLoopback && !isLoopbackHost(host)) {
    throw new TypeError(`offline backend leg host must be 127.0.0.1 or ::1, got ${JSON.stringify(host)}`)
  }
  if (typeof username !== 'string' || username.length === 0) {
    throw new TypeError('username must be a non-empty string')
  }
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
    throw new TypeError('connectTimeoutMs must be a non-negative number')
  }
  if (endTimeoutMs !== undefined && (!Number.isFinite(endTimeoutMs) || endTimeoutMs < 0)) {
    throw new TypeError('endTimeoutMs must be a non-negative number')
  }

  return createBackendLeg({
    kind: 'offline-backend-leg',
    host,
    port,
    version,
    log,
    connectTimeoutMs,
    endTimeoutMs,
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
    validateTarget: allowNonLoopback ? () => true : next => isLoopbackHost(next.host)
  })
}

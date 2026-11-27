// B1 fakes: scripted backend/front leg adapters with no sockets and no auth.
// Used by test/service/monoplayer.test.js. The real legs (minecraft-protocol)
// implement the same interfaces — see docs/product-core.md — and are built in G1/M4.

import { CHANNEL_ROLES } from '../core/channels.js'
import { createClaims } from '../core/claims.js'
import { createCallInHandlers } from './call-in-handler.js'

// #886: each double keeps one handler per call-in through the guard the real legs import
// (src/legs/call-in-handler.js), not a copy of it. Plain assignment let a service test plant
// a registration on top of the core's and read a whole wiring off a leg whose real
// counterpart throws. That is #631's general form: a double that answers more than the thing
// it stands for is a test that passes on a lane that would not boot.
//
// A double keeps its holes: it carries neither setCoreAttach nor setCoreAttachConfiguring,
// and test/service/wire-leg-to-core.test.js declares the rest of them.

// Backend leg adapter (fake): implements the interface createMonoplayer wires
// against. Frames are {state: 'configuration'|'play', name, buffer?, data?};
// `buffer` is opaque to the core. Records everything written back to the
// backend, counts logins, and records the text the proxy spoke as the puppet
// (#19). The real leg signs that text; the fake only records it.
export function createFakeBackendLeg () {
  const written = { raw: [], packets: [], spoken: [] }
  // #73: the gate answers this leg gave on its own, one per detach.
  const gateAnswers = []
  let frameHandler = null
  let endHandler = null
  let errorHandler = null
  let connected = false
  let ended = 0
  let target = null
  const targets = []
  const fillCallIn = createCallInHandlers()

  const leg = {
    kind: 'fake-backend-leg',

    // Interface used by createMonoplayer:
    connect () {
      connected = true
      return Promise.resolve()
    },
    setFrameHandler (fn) { frameHandler = fillCallIn('setFrameHandler', fn) },
    setEndHandler (fn) { endHandler = fillCallIn('setEndHandler', fn) },
    setErrorHandler (fn) { errorHandler = fillCallIn('setErrorHandler', fn) },
    writeRaw (buffer, meta) { written.raw.push({ buffer, meta }) },
    write (name, packet, meta) { written.packets.push({ name, packet, meta }) },
    // #258: the target the core hands over for the next connect. The real leg
    // refuses a change while connected; the fake records the ask, which is what a
    // test reads to know which body a claim dialled.
    setTarget (next = {}, intent = {}) {
      target = { host: next.host, port: next.port }
      targets.push({ host: target.host, port: target.port, ...intent })
      return { ...target }
    },
    // #73: the core asks for the answer a configuration gate the last client
    // left would have had from a headless session. The fake records the ask;
    // the real leg's policy is what decides, and the leg unit tests cover it.
    answerHeldGate ({ state = null, name = null } = {}) {
      if (state !== 'configuration') return { answered: false, reason: 'not_a_gate', name }
      gateAnswers.push({ state, name })
      return { answered: true, reason: null, name }
    },
    chat (text) {
      if (typeof text !== 'string' || text.length === 0) throw new TypeError('chat text is required')
      written.spoken.push({ text, command: text.startsWith('/') })
    },
    end (reason) { ended++; connected = false },

    // Test helpers (not part of the real-leg contract):
    get connected () { return connected },
    get ended () { return ended },
    get written () { return written },
    get target () { return target === null ? null : { ...target } },
    dialledTargets: () => [...targets],
    rawWrites: () => [...written.raw],
    packetWrites: () => [...written.packets],
    spoken: () => [...written.spoken],
    heldGateAnswers: () => [...gateAnswers],

    // Scripted delivery: pretend the backend sent this frame.
    deliver ({ state = 'play', name, buffer, data = {} }) {
      if (!frameHandler) throw new Error('createMonoplayer().start() not called')
      frameHandler({ state, name, buffer: buffer ?? Buffer.from(`fake:${name}`), data })
    },
    // Scripted backend lifecycle events.
    deliverEnd ({ reason = 'test_end' } = {}) {
      if (!endHandler) throw new Error('no end handler')
      endHandler({ reason })
    },
    deliverError ({ error } = {}) {
      if (!errorHandler) throw new Error('no error handler')
      errorHandler({ error })
    }
  }

  return leg
}

// Front leg recorder (fake): implements the interface createMonoplayer wires
// against. Records everything the core sends this client, exposes the
// login-start / attach / detach call-ins for the core to drive.
export function createFakeFrontLeg () {
  const sent = [] // {kind:'raw'|'packet'|'synth', name, buffer?, packet?, reason?}
  const ended = [] // {reason, text?} — text is the words a denial names (#365)
  const reconfiguredCalls = [] // {reason} per startReconfiguration (#22)
  // #261: the claims this leg holds, one board keyed by body. #631: the board is the
  // real leg's (`createClaims` in src/core/claims.js), so the record a reader sees is
  // `claimView`'s, whether it asked `claimOn` or holds what `claim` returned. A field
  // added there reaches this double and the real board together. The board's two rules
  // come with it: a test cannot plant a claim production refused.
  const claims = createClaims()
  // #636: the channels this leg holds, as the real leg's registry reports them. The fake
  // opens none of its own — a test lands a channel through the core — so a case that needs
  // to see the driver's channel says so with `channelRecord`.
  const channelRecords = []
  let loginStartHandler = null
  let serverboundHandler = null
  let detachHandler = null
  let clientSettingsHandler = null
  let spectatorPoseHandler = null
  let configuringHandler = null
  let reconfiguredHandler = null
  const fillCallIn = createCallInHandlers()

  const client = {
    username: 'Bafbi',
    uuid: 'not-verified-yet'
  }

  const leg = {
    kind: 'fake-front-leg',

    // Interface used by createMonoplayer:
    setLoginStartHandler (fn) { loginStartHandler = fillCallIn('setLoginStartHandler', fn) },
    setServerboundHandler (fn) { serverboundHandler = fillCallIn('setServerboundHandler', fn) },
    setDetachHandler (fn) { detachHandler = fillCallIn('setDetachHandler', fn) },
    setClientSettingsHandler (fn) { clientSettingsHandler = fillCallIn('setClientSettingsHandler', fn) },
    // #636: where a spectator's own client says it is. The fake records the registration;
    // a test drives the core's method instead of a socket.
    setSpectatorPose (fn) { spectatorPoseHandler = fillCallIn('setSpectatorPose', fn) },
    setConfiguringHandler (fn) { configuringHandler = fillCallIn('setConfiguringHandler', fn) },
    setReconfiguredHandler (fn) { reconfiguredHandler = fillCallIn('setReconfiguredHandler', fn) },
    // #22: the core asks the client to re-enter configuration on the same
    // connection. The fake records the request; the core drives the state.
    startReconfiguration ({ reason = 'transfer' } = {}) {
      reconfiguredCalls.push({ reason })
      return { started: true, reason }
    },
    // #87: the frame bytes that end a configuration round, for a restore with
    // no cached finish. The fake records it as a raw frame like the real leg.
    finishConfigurationFrame () { return Buffer.from('fake:finish_configuration') },
    // #269: a write names one channel, or none for every channel on the body.
    // The fake records which, so a test can prove a spectator's replay went to
    // that spectator and no other socket.
    writeRaw (buffer, meta, { channel = null } = {}) {
      sent.push({ kind: 'raw', name: meta?.name, buffer, meta, channel })
    },
    write (name, packet, { synth = false, meta, channel = null } = {}) {
      sent.push({ kind: synth ? 'synth' : 'packet', name, packet, meta, channel })
    },
    end (reason) { ended.push({ reason }) },
    // #261: the claim on one body, or null. The real leg records a claim where a
    // client answers a body's dialog and releases it when that connection ends; the
    // fake holds whatever a test puts on it, so a fault can be driven with a claim
    // held and with none. The core reads this instead of keeping a copy. #631: the
    // board answers with a copy, as the real leg's `claimOn` does, so a reader cannot
    // write into the claim it read.
    claimOn (body) { return claims.claimOn(body) },
    // #636: the channels this leg holds. The real leg publishes its registry; the fake has
    // no sockets, so a test names the channels it wants the core to see.
    get channels () { return channelRecords.map(record => ({ ...record })) },
    channelRecord ({ id, role = CHANNEL_ROLES.DRIVER, body = null }) {
      const record = { id, role, body, name: null, at: 0, delivered: null, settings: null, settingsAt: null }
      channelRecords.push(record)
      return { ...record }
    },
    forgetChannelRecord (id) {
      const index = channelRecords.findIndex(record => record.id === id)
      if (index === -1) return null
      const [removed] = channelRecords.splice(index, 1)
      return { ...removed }
    },
    setClient ({ username, uuid }) {
      client.username = username
      client.uuid = uuid
    },

    // Test helpers:
    frames: () => [...sent],
    namesOf: () => sent.map(f => f.name),
    endReasons: () => [...ended],
    get client () { return client },

    // Simulate the client's login start; the core's decision comes back
    // synchronously (identity gate). Like the real front leg, a denied login
    // start is ended with the deny reason BEFORE Login Success is sent, and the
    // record below stands for that end.
    //
    // #365: a denial also carries `decision.text`, the sentence the player reads,
    // and the real leg writes it into the login-state disconnect (#312). The record
    // of the end keeps those words beside the `denied:` slug the assertions match,
    // so a service test reads the sentence with no socket.
    //
    // It is recorded here rather than through `end(reason)`: that method is the
    // adapter's kick, and the core never hands it a sentence. A denial that names no
    // words records none, rather than a null a reader would take to mean the player
    // read nothing: the fallback `attach denied (<reason>)` is the front leg's own
    // policy, and this double does not speak it.
    loginStart ({ name = 'Bafbi', uuid }) {
      if (!loginStartHandler) throw new Error('createMonoplayer().start() not called')
      client.uuid = uuid
      client.name = name
      const decision = loginStartHandler({ name, uuid, username: name })
      if (!decision.allowed) {
        const record = { reason: `denied:${decision.reason}` }
        if (decision.text != null) record.text = decision.text
        ended.push(record)
      }
      return decision
    },
    // #636: simulate a spectator's own movement frame, which the real leg reads and then
    // drops. The call-in is what the core is told; the frame reaches no pipeline.
    spectatorMoved ({ channel, name = 'position_look', data = {} } = {}) {
      if (!spectatorPoseHandler) throw new Error('no spectator pose handler')
      return spectatorPoseHandler({ channel, name, data })
    },
    // Simulate a serverbound frame from the attached client, in the phase it
    // was sent in: a configuration answer is not a play frame (#16).
    serverbound ({ state = 'play', name, buffer, data = {} }) {
      if (!serverboundHandler) throw new Error('no serverbound handler')
      serverboundHandler({ state, name, buffer: buffer ?? Buffer.from(`client:${name}`), data })
    },
    // Simulate the client entering its own configuration phase (#16).
    clientConfiguring ({ name = 'Bafbi', uuid = client.uuid } = {}) {
      if (!configuringHandler) throw new Error('no configuring handler')
      configuringHandler({ name, uuid })
    },
    // Simulate the client's Client Information frame (configuration or play).
    clientSettings ({ data = {} } = {}) {
      if (!clientSettingsHandler) throw new Error('no client settings handler')
      clientSettingsHandler(data)
    },
    // Simulate the client going away.
    clientDisconnect ({ reason = 'player_quit' } = {}) {
      if (!detachHandler) throw new Error('no detach handler')
      detachHandler({ reason })
    },
    // #22: the client answered the reconfiguration's finish frame and is in
    // play again on its own connection.
    clientReconfigured ({ name = client.username, uuid = client.uuid } = {}) {
      if (!reconfiguredHandler) throw new Error('no reconfigured handler')
      return reconfiguredHandler({ name, uuid })
    },
    reconfigurations: () => [...reconfiguredCalls],

    // A claim on a body, the way the real leg's board holds one, through that board.
    // #631: the moment it was recorded arrives through the board's own seam (`at`), so
    // a planted claim is the same row on every run. The other fields are this helper's
    // parameters, so an input added to the board's `claim` is a parameter added here.
    // A refusal is thrown, not dropped: a double that kept a claim the board refused
    // would fail its case three assertions from the cause.
    claim (body, { name = 'Bafbi', holder = 'holder-1', at = 0 } = {}) {
      const outcome = claims.claim({ body, server: body, holder, name, at })
      if (!outcome.ok) throw new Error('fake front leg: claim refused: ' + outcome.reason)
      return outcome.claim
    },
    // #631: the board releases by holder and a test knows a body, so the claim is
    // read first. Answers whether there was a claim to release, as the map did.
    releaseClaim (body) {
      const held = claims.claimOn(body)
      if (held === null) return false
      claims.release(held.holder)
      return true
    },
  }

  return leg
}

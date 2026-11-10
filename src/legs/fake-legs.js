// B1 fakes: scripted backend/front leg adapters with no sockets and no auth.
// Used by test/service/monoplayer.test.js. The real legs (minecraft-protocol)
// implement the same interfaces — see docs/product-core.md — and are built in G1/M4.

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

  const leg = {
    kind: 'fake-backend-leg',

    // Interface used by createMonoplayer:
    connect () {
      connected = true
      return Promise.resolve()
    },
    setFrameHandler (fn) { frameHandler = fn },
    setEndHandler (fn) { endHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    writeRaw (buffer, meta) { written.raw.push({ buffer, meta }) },
    write (name, packet, meta) { written.packets.push({ name, packet, meta }) },
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
  const ended = [] // {reason}
  const reconfiguredCalls = [] // {reason} per startReconfiguration (#22)
  let loginStartHandler = null
  let serverboundHandler = null
  let detachHandler = null
  let clientSettingsHandler = null
  let configuringHandler = null
  let reconfiguredHandler = null

  const client = {
    username: 'Bafbi',
    uuid: 'not-verified-yet'
  }

  const leg = {
    kind: 'fake-front-leg',

    // Interface used by createMonoplayer:
    setLoginStartHandler (fn) { loginStartHandler = fn },
    setServerboundHandler (fn) { serverboundHandler = fn },
    setDetachHandler (fn) { detachHandler = fn },
    setClientSettingsHandler (fn) { clientSettingsHandler = fn },
    setConfiguringHandler (fn) { configuringHandler = fn },
    setReconfiguredHandler (fn) { reconfiguredHandler = fn },
    // #22: the core asks the client to re-enter configuration on the same
    // connection. The fake records the request; the core drives the state.
    startReconfiguration ({ reason = 'transfer' } = {}) {
      reconfiguredCalls.push({ reason })
      return { started: true, reason }
    },
    // #87: the frame bytes that end a configuration round, for a restore with
    // no cached finish. The fake records it as a raw frame like the real leg.
    finishConfigurationFrame () { return Buffer.from('fake:finish_configuration') },
    writeRaw (buffer, meta) { sent.push({ kind: 'raw', name: meta?.name, buffer, meta }) },
    write (name, packet, { synth = false, meta } = {}) {
      sent.push({ kind: synth ? 'synth' : 'packet', name, packet, meta })
    },
    end (reason) { ended.push({ reason }) },
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
    // start is ended with the deny reason BEFORE Login Success is sent.
    loginStart ({ name = 'Bafbi', uuid }) {
      if (!loginStartHandler) throw new Error('createMonoplayer().start() not called')
      client.uuid = uuid
      client.name = name
      const decision = loginStartHandler({ name, uuid, username: name })
      if (!decision.allowed) leg.end(`denied:${decision.reason}`)
      return decision
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
  }

  return leg
}

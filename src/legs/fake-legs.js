// B1 fakes: scripted backend/front leg adapters with no sockets and no auth.
// Used by test/monoplayer-integration.test.js. The real legs (minecraft-protocol)
// implement the same interfaces — see docs/product-core.md — and are built in G1/M4.

// Backend leg adapter (fake): implements the interface createMonoplayer wires
// against. Frames are {state: 'configuration'|'play', name, buffer?, data?};
// `buffer` is opaque to the core. Records everything written back to the
// backend, counts logins.
export function createFakeBackendLeg () {
  const written = { raw: [], packets: [] }
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
    end (reason) { ended++; connected = false },

    // Test helpers (not part of the real-leg contract):
    get connected () { return connected },
    get ended () { return ended },
    get written () { return written },
    rawWrites: () => [...written.raw],
    packetWrites: () => [...written.packets],

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
  let loginStartHandler = null
  let serverboundHandler = null
  let detachHandler = null

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
    // Simulate a serverbound play frame from the attached client.
    serverbound ({ name, buffer, data = {} }) {
      if (!serverboundHandler) throw new Error('no serverbound handler')
      serverboundHandler({ name, buffer: buffer ?? Buffer.from(`client:${name}`), data })
    },
    // Simulate the client going away.
    clientDisconnect ({ reason = 'player_quit' } = {}) {
      if (!detachHandler) throw new Error('no detach handler')
      detachHandler({ reason })
    }
  }

  return leg
}

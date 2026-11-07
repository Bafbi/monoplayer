// Optional minimal online-mode server fixture that embeds the G1 attach
// gate. NOT run by unit tests (no live login), and NOT the product front
// leg: it is the smallest server a real client can join so the gate can be
// exercised against a genuine login before Monoplayer integration lands.
//
//   const fixture = createAttachFixture({ store, verify })
//   // verify: ({ client, username }) => { ok, allowed, profile }
//   //   for a pure stub or hasJoined.verifyFromHasJoined(...) for real
//
// The deny path closes the connection from beforeLogin, i.e. BEFORE Login
// Success, so a non-whitelisted account never reaches play state.
import mc from 'minecraft-protocol'

import { createHasJoined } from './hasjoined.js'

// Standard verify for a fixture pointed at real Minecraft sessions. The
// fixture is offline-mode towards the client (no encryption handshake of its
// own), so there is no shared-secret material to build a real serverId from;
// callers that exercise the real flow pass `serverId` explicitly.
export function verifyFromHasJoined ({ hasJoined = null } = {}) {
  return ({ client, username }) => {
    if (!hasJoined) {
      hasJoined = createHasJoined()
    }
    return hasJoined.check({ username, serverId: client?.serverId })
  }
}

// Embeddable: createServer + beforeLogin wiring only; the gate (./attach.js)
// owns all decisions.
export function createAttachFixture ({ host = '127.0.0.1', port = 0, version = '26.1', store, verify, gate, onlineMode = false } = {}) {
  if (!gate || typeof gate.gate !== 'function') {
    throw new Error('createAttachFixture needs the gate from createAttachGate()')
  }
  const server = mc.createServer({
    host,
    port,
    version,
    'online-mode': onlineMode,
    // Deny before Login Success: the gate decides inside beforeLogin and the
    // client is dropped with a login-stage disconnect reason. minecraft-protocol
    // calls this hook synchronously and has already completed online-mode
    // hasJoined, so use the synchronous verified-identity gate.
    beforeLogin: (client) => {
      const result = typeof gate.gateVerified === 'function'
        ? gate.gateVerified({ client, store })
        : gate.gate({ client, store, verify })
      if (result && result.then) {
        throw new Error('fixture gate must be synchronous (use gateVerified or online-mode hasJoined)')
      }
      if (!result.ok) {
        // minecraft-protocol writes Login Success immediately after
        // beforeLogin and does not await async gates. Drop those two login
        // packets so a denied client cannot receive Login Success, then close
        // with the login-stage reason. Mark the client so the fixture's
        // 'login' observer does not report the library's post-denial artifact.
        client.monoplayerDenied = true
        const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
        if (originalWrite) {
          client.write = (name, ...args) => {
            if (name === 'compress' || name === 'success') return false
            return originalWrite(name, ...args)
          }
        }
        // Reason string is intentionally coarse: the structured denial event
        // already carries the sanitized reason.
        client.end(`attach denied (${result.reason})`)
      }
      return client
    },
  })
  server.on('error', error => { gate.events.emit('fixtureError', error) })
  return { server, gate, port: () => server.socketServer?.address()?.port ?? null }
}

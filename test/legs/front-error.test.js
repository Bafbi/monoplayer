// The front leg's error policy (#87).
//
// minecraft-protocol calls `client.end(err)` with the Error object when a
// server-side client errors and no `errorHandler` is given. In play that write
// is `kick_disconnect`, whose reason is an NBT string: the serializer fails
// ("SizeOf error for undefined ... Received an instance of Error"), the failure
// becomes the end reason, and the socket is destroyed 30 s later (`closeTimeout`)
// with that TypeError — so the human is disconnected by a serialization bug
// instead of a reason.
//
// These tests drive the real library over a loopback socket: no auth, no
// cluster, about a second.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mc from 'minecraft-protocol'

import { createFrontErrorHandler, frontErrorKickReason } from '../../src/legs/live-front.js'

const VERSION = '26.1'

function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

// One bare server and one offline client, both from the library, until the
// server-side client is in play. `errorHandler` is whatever the caller wires,
// which is the whole point: the default is the defect.
async function playRig ({ errorHandler } = {}) {
  const options = {
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    'online-mode': false,
    hideErrors: true,
    keepAlive: false,
    versionChecking: false
  }
  if (errorHandler) options.errorHandler = errorHandler
  const server = mc.createServer(options)

  const joined = new Promise(resolve => server.once('playerJoin', resolve))
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.socketServer.address().port

  const client = mc.createClient({
    host: '127.0.0.1',
    port,
    username: 'Attach',
    version: VERSION,
    auth: 'offline',
    hideErrors: true,
    keepAlive: false
  })
  const serverClient = await withTimeout(joined, 15_000, 'playerJoin')

  // end() arms the library's 30 s socket-destroy timer, and a second end can
  // arm it again after the test has closed the rig. These tests assert the end
  // reason, not that timer, so each end drops it. The socket is destroyed in
  // close() either way.
  const realEnd = serverClient.end.bind(serverClient)
  serverClient.end = reason => {
    const outcome = realEnd(reason)
    clearTimeout(serverClient.closeTimer)
    serverClient.closeTimer = null
    return outcome
  }

  const errors = []
  serverClient.on('error', error => errors.push(String(error?.message ?? error)))
  const ended = new Promise(resolve => serverClient.once('end', reason => resolve(reason)))
  const kicked = []
  client.on('kick_disconnect', packet => kicked.push(packet))

  return {
    server,
    serverClient,
    client,
    errors,
    ended,
    kicked,
    close () {
      // end() arms the library's 30 s socket-destroy timer; the test must not
      // wait for it.
      clearTimeout(serverClient.closeTimer)
      try { client.socket?.destroy() } catch { /* already gone */ }
      try { client.end() } catch { /* already gone */ }
      clearTimeout(client.closeTimer)
      try { server.socketServer?.closeAllConnections?.() } catch { /* already gone */ }
      for (const other of Object.values(server.clients ?? {})) {
        try { clearTimeout(other.closeTimer); other.socket?.destroy() } catch { /* already gone */ }
      }
      try { server.close() } catch { /* already gone */ }
    }
  }
}

test('the library\'s default handler ends a play client with its Error, and the kick fails to serialize', async () => {
  const rig = await playRig()
  try {
    assert.equal(rig.serverClient.state, 'play')
    rig.serverClient.emit('error', new Error('read ECONNRESET'))

    // The failed kick is reported, and it is the serialization failure from the
    // live log. This is the defect the leg now prevents.
    await withTimeout(new Promise(resolve => {
      const tick = () => rig.errors.some(m => m.startsWith('Serialization error'))
        ? resolve()
        : setTimeout(tick, 10)
      tick()
    }), 5000, 'the serialization error')
    assert.ok(
      rig.errors.some(message => message.startsWith('Serialization error for play.toClient')),
      `a failed kick is reported as a serialization error: ${rig.errors.join(' | ')}`
    )
    assert.match(String(rig.serverClient._endReason?.message ?? rig.serverClient._endReason),
      /Serialization error/, 'the end reason is that failure, not a message a human can read')
  } finally {
    rig.close()
  }
})

test('the leg\'s handler ends the same client with a string reason and no serializer error', async () => {
  const logs = []
  const rig = await playRig({ errorHandler: createFrontErrorHandler({ log: (event, fields) => logs.push({ event, fields }) }) })
  try {
    assert.equal(rig.serverClient.state, 'play')
    rig.serverClient.emit('error', new Error('read ECONNRESET'))

    const reason = await withTimeout(rig.ended, 10_000, 'the front client end')
    assert.equal(typeof reason, 'string', 'the end reason is a string, never an Error')
    assert.match(reason, /front_error: read ECONNRESET/)
    assert.deepEqual(rig.errors.filter(message => message.startsWith('Serialization error')), [])
    assert.equal(rig.serverClient._endReason, reason, 'the leg, not the library, chose the reason')
    assert.equal(logs.at(-1).event, 'frontError')
    assert.equal(logs.at(-1).fields.reason, reason)
  } finally {
    rig.close()
  }
})

test('the kick reason is one line of text, whatever it was given', () => {
  assert.equal(frontErrorKickReason(new Error('read ECONNRESET')), 'front_error: read ECONNRESET')
  assert.equal(frontErrorKickReason('plain'), 'front_error: plain')
  assert.equal(frontErrorKickReason({ message: 'obj' }), 'front_error: obj')
  assert.equal(frontErrorKickReason(null), 'front_error: null')
  assert.equal(frontErrorKickReason(undefined), 'front_error: undefined')
  assert.ok(frontErrorKickReason(new Error('x'.repeat(500))).length <= 200, 'bounded')
  for (const value of [new Error('e'), null, undefined, { message: 'm' }, 'text']) {
    assert.equal(typeof frontErrorKickReason(value), 'string')
  }
})

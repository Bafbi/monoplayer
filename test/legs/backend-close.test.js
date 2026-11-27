// #662: the backend leg's close() resolves when the socket it ended has ended,
// not when the decision to end it was taken.
//
// `end()` sets the leg's flag and asks the socket to close; the socket's own `end`
// comes back from the kernel, and the handler the leg installed for it is what
// reports the fault the core turns into a scheduled reconnect
// (src/core/session.js:232). So a caller that awaited `close()` and then read a
// ledger was reading a socket that could still be open: #661 had to reach through
// `leg.client` for that event (src/ladder/loopback-lane.js endOfLeg).
//
// Seam: a loopback listener that ends its side on a turn this file chooses, and the
// offline backend leg dialling it. The listener owns the moment the socket ends, so
// a slow loopback cannot make a case pass by being slow. No auth, no custody, no
// .secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { createOfflineBackendLeg } from '../../src/legs/live-backend.js'

const VERSION = '26.1'

// A loopback listener that accepts a dial and answers nothing, on port 0 so no
// fixed port has to be assumed free. `endsAfterMs` is how long its side stays open
// after the leg's half-close, which is the late end close() has to wait for; null
// keeps it open for good, which is the peer the leg's own bound exists for.
//
// `allowHalfOpen` is the whole rig: a socket without it ends its own writable side
// the moment the peer's FIN arrives, so the leg's close would be waiting for an
// answer this file never chose to give. With it, the end comes when this file says.
function peer ({ endsAfterMs = null } = {}) {
  const sockets = new Set()
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    if (endsAfterMs === null) return
    // The leg half-closes when the stop calls end(), so 'end' here is its FIN, and
    // the leg's socket does not report its own end until this side answers.
    socket.on('end', () => {
      setTimeout(() => { try { socket.end() } catch { /* already gone */ } }, endsAfterMs)
    })
  })
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  return {
    port: listening,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
  }
}

// One leg that has dialled and been answered by nothing. `faults` is the leg's own
// end handler, which is where the core is told to schedule a reconnect, and the dial
// is caught because the end it settles with is what a case asserts on.
function stoppedLeg (port, { endTimeoutMs }) {
  const leg = createOfflineBackendLeg({ host: '127.0.0.1', port, version: VERSION, endTimeoutMs })
  const faults = []
  leg.setEndHandler(({ reason }) => faults.push({ reason, at: Date.now() }))
  const dialled = leg.connect().then(() => null, error => error)
  assert.ok(leg.client, 'the leg dialled before the stop')
  return { leg, faults, dialled }
}

test('#662 close() waits for the socket the stop ended', async (t) => {
  const backend = peer({ endsAfterMs: 60 })
  t.after(() => backend.close())
  const { leg, faults, dialled } = stoppedLeg(await backend.port, { endTimeoutMs: 5_000 })

  const stoppedAt = Date.now()
  leg.end() // the stop: src/service/monoplayer.js:3873
  await leg.close() // what rig.close() and start-live's failure path await
  const waited = Date.now() - stoppedAt

  assert.equal(faults.length, 1,
    'the leg reported its end before close() resolved, so the promise answers "the socket is gone"')
  assert.equal(faults[0].reason, 'proxy_stopped')
  assert.ok(waited >= 55, `close() waited for a socket that ended late, and returned in ${waited} ms`)
  assert.equal(leg.client, null, 'the end handler dropped the client before close() resolved')
  assert.ok(await dialled, 'the dial the socket end refused')
})

test('#662 a peer that never ends is bounded by the leg, not by the caller', async (t) => {
  const backend = peer()
  t.after(() => backend.close())
  const { leg, faults, dialled } = stoppedLeg(await backend.port, { endTimeoutMs: 80 })
  const dialledClient = leg.client

  const stoppedAt = Date.now()
  leg.end()
  await leg.close()
  const waited = Date.now() - stoppedAt

  assert.ok(waited >= 75, `the bound held, and answered in ${waited} ms`)
  assert.ok(waited < 4_000, `the leg's bound answered rather than the caller's patience, in ${waited} ms`)
  // The bound gives up on the socket by destroying it, as the bot's close does
  // (src/ladder/bot.js:239-243): a close that resolved without the event leaves no
  // connection open behind the caller. This side is the only one that can report
  // it: the leg's FIN is already out, and a peer holding its own side open never
  // sees a second one.
  assert.equal(dialledClient.socket.destroyed, true, 'the socket the bound gave up on was destroyed')
  // And the destroy is not the answer: the leg's own end handler runs on the close
  // the destroy reports, and that handler is what arms the core's reconnect. A bound
  // that resolved ahead of it would hand a rig a ledger with a timer still to be
  // armed, which is the #661 reading over again.
  assert.equal(leg.client, null, 'the end handler dropped the client before close() resolved')
  assert.deepEqual(faults.map(fault => fault.reason), ['proxy_stopped'], 'the end reached the leg first')
  await dialled
})

test('#662 a reconnect is another socket, and close() waits for that one', async (t) => {
  const first = peer({ endsAfterMs: 0 })
  const second = peer({ endsAfterMs: 60 })
  t.after(() => first.close())
  t.after(() => second.close())
  const { leg, faults, dialled } = stoppedLeg(await first.port, { endTimeoutMs: 5_000 })

  leg.end()
  await leg.close()

  // A transfer or a fault ends the first body and dials the next one on the same
  // leg (src/service/monoplayer.js:1609), so the promise a caller holds answers for
  // one connection and not for the leg's lifetime.
  leg.setTarget({ host: '127.0.0.1', port: await second.port })
  const redialled = leg.connect().then(() => null, error => error)
  assert.ok(leg.client, 'the leg dialled its second body')

  const stoppedAt = Date.now()
  leg.end()
  await leg.close()
  const waited = Date.now() - stoppedAt

  assert.equal(faults.length, 2, 'the second stop reported its own end')
  assert.ok(waited >= 55, `close() waited for the second socket, and returned in ${waited} ms`)
  assert.ok(await dialled)
  assert.ok(await redialled)
})

test('#662 a redial while a close waits is the new connection, not the old one', async (t) => {
  const first = peer()
  const second = peer({ endsAfterMs: 0 })
  t.after(() => first.close())
  t.after(() => second.close())
  const firstPort = await first.port
  const secondPort = await second.port
  const { leg, dialled } = stoppedLeg(firstPort, { endTimeoutMs: 200 })
  const firstClient = leg.client

  leg.end()
  const closing = leg.close()
  // A claim moves a leg to another body and dials it (#432), and this leg is ended, so
  // the move is allowed while the close is still waiting for the first socket.
  leg.setTarget({ host: '127.0.0.1', port: secondPort })
  const redialled = leg.connect().then(() => null, error => error)
  const secondClient = leg.client
  assert.notEqual(secondClient, firstClient, 'the leg dialled again')

  await closing
  assert.equal(firstClient.socket.destroyed, true, 'the bound destroyed the socket this close ended')
  assert.equal(secondClient.socket.destroyed, false, 'and left the socket the redial opened alone')
  assert.equal(leg.client, secondClient, 'the new connection kept its client')

  leg.end()
  await leg.close()
  await dialled
  await redialled
})

test('#662 a leg that never dialled has no socket to wait for', async () => {
  const leg = createOfflineBackendLeg({ host: '127.0.0.1', port: 25565, version: VERSION, endTimeoutMs: 5_000 })
  const started = Date.now()
  await leg.close()
  assert.ok(Date.now() - started < 1_000, 'close() did not wait out its bound for a socket that never existed')
})

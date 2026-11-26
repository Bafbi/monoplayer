// #432: every record the backend leg writes names the body it dialled.
//
// #416 put the account on every line the sink writes, the body on the core's
// records and on the front leg's, and left the backend leg out: it named a dialled
// target as `host` and `port`, so a reader who queries by `body` missed every
// connect, session and join record of a body.
//
// Seam: `createServiceLegs` composes the real offline backend leg with this
// file's recording log, and the leg's own `connect()` writes the records. The dial
// goes to a loopback listener that hangs up, so it fails the same way on any
// machine, and the file waits for that refusal rather than for a timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { createServiceLegs } from '../../src/service/start-live.js'
import { loadConfig } from '../../src/service/monoplayer.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

const lane = (port) => loadConfig({
  offlineLegs: true,
  attachWhitelist: [PLAYER],
  front: { host: '127.0.0.1', port: 0 },
  backend: { host: '127.0.0.1', port }
})

// A loopback listener that accepts and hangs up. The dial can only be refused, on
// any machine, and no privileged port has to be assumed free.
function refusedListener () {
  const server = net.createServer(socket => socket.destroy())
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  return {
    port: listening,
    close: () => new Promise(resolve => server.close(() => resolve()))
  }
}

function compose (port) {
  const lines = []
  const built = createServiceLegs({
    cfg: lane(port),
    resolved: null,
    control: null,
    getSnapshotConfig: () => [],
    log: (event, fields = {}) => lines.push({ event, fields })
  })
  return { ...built, lines }
}

// One dial that cannot succeed. The refusal settles the promise, and the records
// it wrote are the two this file reads.
async function dialAndSettle (leg) {
  const error = await leg.connect().then(() => null, refused => refused)
  assert.ok(error, 'the dial to a listener that hangs up is refused')
}

test('#432 a backend-leg record names the body its target derives', async (t) => {
  const refused = refusedListener()
  t.after(() => refused.close())
  const port = await refused.port
  const { backend, lines } = compose(port)

  await dialAndSettle(backend)

  const connect = lines.find(line => line.event === 'backendConnect')
  assert.ok(connect, 'the dial wrote its record')
  assert.equal(connect.fields.host, '127.0.0.1', 'the record still names the address it dialled')
  assert.equal(connect.fields.port, port)
  assert.equal(connect.fields.body, '127.0.0.1_' + port,
    'the record names the body the address derives, the slug a claim uses')

  // The failure the dial ends in is the same body: one query answers for the
  // connect and for what became of it.
  const failed = lines.find(line => line.event === 'backendError')
  assert.ok(failed, 'the refusal wrote its record')
  assert.equal(failed.fields.body, '127.0.0.1_' + port)
})

test('#432 the body is read at the record, so a moved target names the body it dials', async (t) => {
  const configured = refusedListener()
  const moved = refusedListener()
  t.after(() => configured.close())
  t.after(() => moved.close())
  const configuredPort = await configured.port
  const movedPort = await moved.port

  const { backend, lines } = compose(configuredPort)
  // A claim moves a leg to another body before it dials (backendLeg.setTarget),
  // so a body copied once at construction would name the wrong server.
  backend.setTarget({ host: '127.0.0.1', port: movedPort })
  await dialAndSettle(backend)

  const connect = lines.find(line => line.event === 'backendConnect')
  assert.equal(connect.fields.port, movedPort)
  assert.equal(connect.fields.body, '127.0.0.1_' + movedPort)
  assert.notEqual(connect.fields.body, '127.0.0.1_' + configuredPort,
    'the configured target is not the body this leg dialled')
})

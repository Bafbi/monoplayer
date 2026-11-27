// #435: a Spectate refusal is a refusal the map counts, whichever branch refuses.
//
// The picker's map by reason (`front.pickerRefusalsByReason`) is the number a cap
// is decided from (#417), so a refusal that reaches the record and not the map, or
// the map and not the record, makes a partial count read as a complete one. The
// branches this file drives refuse *after* the Spectate answer said yes: the
// channel that will not open, and a body whose configuration replay writes no
// frame.
//
// Seam: a loopback socket through the offline front leg and the leg's own
// `spectate({ username, body, server })` call, which is the call the picker's
// Spectate verb makes. Neither branch is reachable without a login and a channel,
// so nothing here can stand in for the socket. `leg.metrics.allowed` goes to 1
// in the same synchronous login window that registers the connection, which is
// what this file waits on rather than a packet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'

const VERSION = '26.1'
const NAME = 'Probe'
const BODY = 'sky'

// One configuration frame a body's cache can hold, so a spectator's replay has
// something to write, and a real one: the client decodes what the leg writes, and a
// made-up payload lands in the gate's output as a parser error. A body with no frame
// at all is the state the second refusal describes.
const ONE_CONFIG_FRAME = [{
  name: 'feature_flags',
  buffer: mc.createSerializer({ state: 'configuration', isServer: true, version: VERSION })
    .createPacketBuffer({ name: 'feature_flags', params: { features: ['minecraft:test'] } })
}]

// The phase a picker lane serves before the dialog, in this version. An empty list is
// not a lane with nothing to say: `resolveConfigPath` has no frame to write, the leg's
// fallback is off on this lane, and the client is closed at login (`configUnavailable`).
// The landing below then wrote into a chain the lane had already ended, and #820 read that
// as a delivery, which is why this fixture used to pass.
const PICKER_BASELINE = { version: VERSION, replayFrames: ONE_CONFIG_FRAME }

async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// One leg, one logged-in client, and the records the leg wrote. The client is
// closed before the leg, because a leg that closes first ends it from the far side.
async function withWatchingClient (config, run) {
  const lines = []
  const clientErrors = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    // A picker client: it holds no channel until its Spectate lands, which is the
    // state the picker's own verb runs from, on a lane whose phase is on the wire.
    configurationBaseline: PICKER_BASELINE,
    pickerServers: () => ({ source: 'allowed', reason: null, rows: [{ name: 'sky:25565' }] }),
    getSnapshotConfig: () => config,
    wireMode: 'off',
    log: (event, fields) => lines.push({ event, fields })
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    // The core's two answers: this login joins the picker, and the lane serves the
    // body the verb names and has it up.
    leg.setLoginStartHandler(() => ({ allowed: true, picker: true }))
    leg.setSpectateBody(({ server }) => ({ watching: true, body: server }))
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    // A connection the lane closed from its side would otherwise fail the run as an
    // unhandled error event, which names no test. Collected instead, so a test that
    // expects none can say so and a real one is read back rather than swallowed.
    bot.on('error', error => clientErrors.push(String(error?.message ?? error)))
    // The leg admits a login inside its own synchronous window, before it writes the
    // login success that moves the client into configuration. A Spectate called in
    // between hands the client a configuration frame it decodes as a login one, so
    // the wait is for both facts: the admit, and the client's own phase.
    const states = []
    bot.on('state', next => states.push(next))
    await settleUntil(
      () => leg.metrics.allowed === 1 && states.includes('configuration'),
      'the login the leg admitted in the client\'s configuration phase'
    )
    return await run({ leg, lines, clientErrors })
  } finally {
    // The socket goes first: the library's own end() waits out its close timeout for
    // an answer from a lane that has nothing left to say, and a test file is not the
    // place to spend thirty seconds of the gate on it.
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

const refusals = lines => lines
  .filter(line => line.event === 'spectateRefused')
  .map(line => line.fields)

test('#435 a body whose configuration replay writes no frame is refused, recorded and counted', async () => {
  await withWatchingClient([], async ({ leg, lines, clientErrors }) => {
    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })

    assert.equal(answer.watching, false)
    assert.equal(answer.reason, 'no_cached_configuration')
    assert.match(answer.text, /cannot be watched/, 'the client is told why it cannot watch')

    // The record a reader greps, carrying the word the sentence was built from.
    assert.deepEqual(refusals(lines).map(fields => fields.reason), ['no_cached_configuration'])
    assert.equal(refusals(lines)[0].server, BODY, 'the record names the body the client asked for')
    // And the count the cap is decided from: the total, and the same count by reason.
    assert.equal(leg.metrics.pickerRefusals, 1)
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { no_cached_configuration: 1 })
    // The channel was opened for a client it then could not deliver, so it is gone.
    assert.deepEqual(leg.channels, [], 'a refused spectator holds no channel')
    // A refused Spectate is not a landing, and the two numbers are read off the
    // same run so neither can be right while the other is wrong.
    assert.equal(leg.metrics.spectateLandings, 0)
    assert.deepEqual(clientErrors, [])
  })
})

test('#435 a Spectate the channel refuses is recorded and counted', async () => {
  await withWatchingClient(ONE_CONFIG_FRAME, async ({ leg, lines, clientErrors }) => {
    // One connection holds one channel, so the second Spectate from the same
    // connection is the channel refusing it.
    const first = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(first.watching, true, 'the fixture spectator lands')
    assert.equal(leg.metrics.spectateLandings, 1, 'a landing is counted, and counted once')
    assert.equal(lines.filter(line => line.event === 'spectateLanded').length, 1)

    const second = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(second.watching, false)
    assert.equal(second.reason, 'channel_refused')

    assert.deepEqual(refusals(lines).map(fields => fields.reason), ['channel_refused'])
    assert.equal(leg.metrics.pickerRefusals, 1, 'the landing is not a refusal')
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { channel_refused: 1 })
    // The channel's own counter is a different question, and it still answers it.
    assert.equal(leg.metrics.channelRefused, 1)
    assert.equal(leg.metrics.spectateLandings, 1, 'the refusal adds no landing')
    assert.deepEqual(clientErrors, [])
  })
})

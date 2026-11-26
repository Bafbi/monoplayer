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
// something to write. A body with none is the state the second refusal describes.
const ONE_CONFIG_FRAME = [{ name: 'registry_data', buffer: Buffer.from('config:registry_data') }]

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
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    // A picker client: it holds no channel until its Spectate lands, which is the
    // state the picker's own verb runs from.
    configurationBaseline: { version: VERSION, replayFrames: [] },
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
    // A connection the lane closed from its side must not fail the test run as an
    // unhandled error: every assertion here is about the record and the counter.
    bot.on('error', () => {})
    await settleUntil(() => leg.metrics.allowed === 1, 'the login the leg admitted')
    return await run({ leg, lines })
  } finally {
    try { bot?.end('done') } catch { /* the client was already gone */ }
    await leg.close()
  }
}

const refusals = lines => lines
  .filter(line => line.event === 'spectateRefused')
  .map(line => line.fields)

test('#435 a body whose configuration replay writes no frame is refused, recorded and counted', async () => {
  await withWatchingClient([], async ({ leg, lines }) => {
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
  })
})

test('#435 a Spectate the channel refuses is recorded and counted', async () => {
  await withWatchingClient(ONE_CONFIG_FRAME, async ({ leg, lines }) => {
    // One connection holds one channel, so the second Spectate from the same
    // connection is the channel refusing it.
    const first = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(first.watching, true, 'the fixture spectator lands')

    const second = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(second.watching, false)
    assert.equal(second.reason, 'channel_refused')

    assert.deepEqual(refusals(lines).map(fields => fields.reason), ['channel_refused'])
    assert.equal(leg.metrics.pickerRefusals, 1, 'the landing is not a refusal')
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { channel_refused: 1 })
    // The channel's own counter is a different question, and it still answers it.
    assert.equal(leg.metrics.channelRefused, 1)
  })
})

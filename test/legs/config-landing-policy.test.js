// #602 and #599: the landing is the funnel's business too.
//
// Two rules of the one funnel are read here because they need the same rig: the policy
// a landing asks before it writes a body's configuration (#602), and the rule against a
// configuration frame offered after the phase's finish (#599). The second is the window
// a landing leaves open, because the leg's own state has not caught up until the client
// answers.
//
// The front leg documents one funnel for a clientbound raw frame — writeRawTo in
// src/legs/live-front.js, which carries the clientbound policy backstop, the
// reconfiguration hold, the state check and the wire check. A landing replays a
// body's configuration into a client that is mid-configuration, and the snapshot it
// replays is a leg dependency: nothing upstream can promise the set is one the
// policy would let across. So the check that refuses a frame has to sit on the
// write, not only on the snapshot's reader.
//
// Seam: an offline front leg and the leg's own `spectate` call, which lands a client
// through the same `sendBodyConfiguration` a granted claim uses (#598's file lands
// through the same call for one earlier defect). Every frame the leg writes is read
// off the leg's own wire check, so this counts the bytes the leg wrote and not a
// decision it recorded about them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { readConfigurationBaseline } from '../../src/legs/configuration-baseline.js'

const VERSION = '26.2'
const NAME = 'Probe'
const BODY = 'sky:25565'

async function settleUntil (read, label, timeoutMs = 15_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// A body's configuration as one leg could be handed it: an ordinary frame the policy
// replays, and three it does not. The bytes are real frames of this version, built
// with the same serializer the leg's own writer uses, so nothing here is refused for
// being unreadable.
function bodyConfiguration () {
  const serializer = mc.createSerializer({ state: 'configuration', isServer: true, version: VERSION })
  const frame = (name, params) => ({ name, buffer: serializer.createPacketBuffer({ name, params }) })
  return [
    // CONFIG_ORDINARY: relayed, cached and replayed.
    frame('reset_chat', {}),
    // CONFIG_PER_LEG: this connection owns its own keep-alive, so a body's is not one
    // a second client may be handed (#541: 9 bytes read in play as another packet).
    frame('keep_alive', { keepAliveId: 7n }),
    // CONTROL: the human answers it, and a replay would deliver a stale dialog beside
    // the holder's one copy.
    frame('code_of_conduct', { contents: 'the rules' }),
    // CONFIG_BLOCK: connection control the puppet took, which the front never relays.
    frame('transfer', { host: 'example.invalid', port: 25565 })
  ]
}

// One leg, one real client held in the picker's configuration phase, and every
// configuration frame the leg wrote.
async function withPickerClient (run) {
  const body = bodyConfiguration()
  const written = []
  const records = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: readConfigurationBaseline(),
    pickerServers: () => ({ source: 'allowed', reason: null, rows: [{ name: BODY }] }),
    // The body a Spectate lands: its own configuration, with one of everything in it.
    getSnapshotConfig: () => body,
    wireMode: 'warn',
    wireCheck: payload => {
      if (payload.state === 'configuration') written.push({ name: payload.name, buffer: payload.buffer })
      return { ok: true }
    },
    log: (event, fields) => records.push({ event, fields })
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    leg.setLoginStartHandler(() => ({ allowed: true, picker: true }))
    leg.setSpectateBody(({ server }) => ({ watching: true, body: server }))
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    bot.on('error', () => {})
    // The picker's own phase is the recording's, and its last frame is the signal
    // that the phase the landing continues has opened.
    await settleUntil(
      () => leg.metrics.allowed === 1 && written.some(frame => frame.name === 'tags'),
      'the login the leg admitted and the baseline frames on the wire'
    )
    return await run({ leg, written, records, body })
  } finally {
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

test('#602 a landing writes a body\'s configuration through the policy, not around it', async () => {
  await withPickerClient(async ({ leg, written }) => {
    const mark = written.length
    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(answer.watching, true, 'the body lands the client it named: ' + JSON.stringify(answer))

    const landed = written.slice(mark).map(frame => frame.name)
    assert.deepEqual(landed, ['reset_chat'],
      'the landing writes the one frame the policy replays, and none of: a per-leg ' +
      'keep-alive, a control dialog, or connection control')
  })
})

// The two gates, and why this test drives the funnel itself. A landing cannot be handed a
// blocked frame: `replayableConfigFrames` strips it first, which the test above reads on
// the wire. What this one pins is the gate behind that reader, at the write a landing makes
// (`leg.writeRaw` is the leg's own entry to it), so a future landing that skipped the reader
// would still be refused here.
test('#602 the funnel a landing writes through refuses a frame the policy blocks', async () => {
  await withPickerClient(async ({ leg, written, body }) => {
    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(answer.watching, true, 'the body lands the client it named')

    const transfer = body.find(frame => frame.name === 'transfer')
    const before = leg.metrics.policyRefused
    const mark = written.length
    const sent = leg.writeRaw(transfer.buffer, { state: 'configuration', name: 'transfer' })
    assert.equal(sent, false, 'the funnel refuses a frame the clientbound policy blocks')
    assert.equal(leg.metrics.policyRefused, before + 1, 'and counts the refusal on the leg')
    assert.deepEqual(written.slice(mark).map(frame => frame.name), [],
      'not one byte of it reached the client')
  })
})

test('#599 a configuration frame offered after the phase finish is dropped, and named', async () => {
  await withPickerClient(async ({ leg, written, records }) => {
    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(answer.watching, true, 'the body lands the client it named')

    // The landing wrote the phase's finish, so the client is reading play from here.
    // The leg's own client state has not caught up, which is the window #541 was
    // about: a configuration frame written in it is read as another packet.
    const mark = written.length
    const markRecords = records.length
    const sent = leg.writeRaw(Buffer.from([0x06]), { state: 'configuration', name: 'reset_chat' })
    assert.equal(sent, false, 'a configuration frame after the finish never reaches the wire')
    assert.deepEqual(written.slice(mark), [], 'nothing was written')
    const dropped = records.slice(markRecords).filter(entry => entry.event === 'configFrameAfterFinish')
    assert.equal(dropped.length, 1, 'the drop is recorded, so an operator can see what was withheld')
    assert.equal(dropped[0].fields.name, 'reset_chat', 'and it names the frame')
  })
})

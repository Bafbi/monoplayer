// #600: the packet-object path takes the checks a packet object can take.
//
// Two writers carried a packet object to a front client. `writePacketTo` is the one the
// core's relay calls, for the synthesized position, the skin and a notice: a packet
// object with no bytes and a state. `sendServerDialog` was the picker's answer for one
// server, a packet object whose params are the leg's own — which is what makes its bytes
// the leg's to encode, so #600 moved it onto the raw funnel and the wire check reads it
// there. This file reads both: the writer that stayed a packet object, and the one that
// stopped being one.
//
// #600 found both believing a guarantee that belongs to the other path. The wire check
// guards raw frames, and "a packet object cannot carry trailing bytes" is true of the
// bytes and false of the failure class: the library serializes a packet object with
// whatever state the client holds, so a frame written in a state the client is not in
// carries an id the client reads as something else with the rest of the frame left over:
// #541 is that measurement, and writeRawTo in the leg names it.
//
// What this file proves, one test per writer: a packet object offered in a state the
// client cannot parse is refused by the leg, counted and named; and the server dialog
// reaches the leg's wire check, in the state it was written in. #599's half of the same
// rule — a configuration frame after the phase's finish — is
// `test/legs/config-landing-policy.test.js`, on the same seam.
//
// Seam: an offline front leg and one real protocol client. The two moments are the ones
// a packet object can be refused in and a test can reach: the window a landing opens
// (the phase's finish is on the wire and this leg's client state has not caught up), and
// the picker's own click, which is what writes a server's dialog.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { readConfigurationBaseline } from '../../src/legs/configuration-baseline.js'
import { buildCustomClickAction } from '../../src/core/dialog-codec.js'
import { pickIdFor, verbIdFor } from '../../src/core/picker.js'

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

// A position, as the core hands it over: the frame the play relay synthesizes, and the
// one packet object this file offers in a state the client cannot parse.
const POSITION = { teleportId: 1, x: 0, y: 64, z: 0, yaw: 0, pitch: 0, dx: 0, dy: 0, dz: 0, flags: 0 }

// The ids a dialog carries, read off the frame the client decoded: what the client was
// offered, not a constant this file composed.
function dialogIds (dialog) {
  return (dialog?.dialog?.value?.actions?.value?.value ?? [])
    .map(entry => entry?.action?.value?.id?.value ?? null)
}

// One lane, one real client, and every frame the leg's own wire check saw, with the
// state it saw it in.
async function withLane (run) {
  const baseline = readConfigurationBaseline()
  assert.notEqual(baseline, null, 'src/legs/configuration-baseline/26.2.json is committed')
  const checked = []
  const lines = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: baseline,
    pickerServers: () => ({ source: 'allowed', reason: null, rows: [{ name: BODY }] }),
    // The body a Spectate lands and a claim dials: the recording's own replay, so the
    // phase under test is the one this lane already serves.
    getSnapshotConfig: () => baseline.replayFrames,
    wireMode: 'warn',
    wireCheck: payload => {
      checked.push({ state: payload.state, name: payload.name, buffer: payload.buffer })
      return { ok: true }
    },
    log: (event, fields) => lines.push({ event, fields })
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    leg.setLoginStartHandler(() => ({ allowed: true, picker: true }))
    leg.setSpectateBody(({ body }) => ({ watching: true, body }))
    leg.setConnectClaimedBody(() => ({ connected: true, warm: true }))
    leg.setCoreAttach(() => ({ attached: true, replayed: 0 }))
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    // The client's own frame lists, so a test reads what reached the wire rather than a
    // decision the leg recorded about it.
    const dialogs = []
    const positions = []
    const clientErrors = []
    bot.on('show_dialog', packet => dialogs.push(packet))
    bot.on('position', packet => positions.push(packet))
    bot.on('error', error => clientErrors.push(String(error?.message ?? error)))
    await settleUntil(
      () => leg.metrics.allowed === 1 && dialogs.length === 1,
      'the picker dialog at the client'
    )
    const click = id => bot.writeRaw(buildCustomClickAction({ state: 'configuration', id }))
    return await run({ leg, bot, dialogs, positions, clientErrors, checked, lines, click })
  } finally {
    // The socket goes first, for the reason test/legs/spectate-refusal.test.js gives:
    // the library's own end() waits out its close timeout for an answer.
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

test('#600 a packet object offered in a state the client cannot parse is refused, counted and named', async () => {
  await withLane(async ({ leg, dialogs, positions, clientErrors, lines }) => {
    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(answer.watching, true, 'the body lands the client it named: ' + JSON.stringify(answer))

    // The landing wrote the phase's finish and this leg's client state has not caught
    // up with the client's, which is the window #541 was about. A play relayed here
    // would be serialized with the configuration table and the client would read a
    // configuration id: the class #600 found on the write path that had no state check.
    const before = leg.metrics.stateRefused
    const mark = lines.length
    const sent = leg.write('position', POSITION)
    assert.equal(sent, false, 'a play frame offered while the client reads configuration never reaches the wire')
    assert.equal(leg.metrics.stateRefused, before + 1, 'and the refusal is counted on the leg')
    const recorded = lines.slice(mark).filter(line => line.event === 'clientboundStateMismatch').map(line => line.fields)
    assert.equal(recorded.length, 1, 'so an operator can see what was withheld')
    assert.deepEqual(
      { name: recorded[0].name, frameState: recorded[0].frameState, clientState: recorded[0].clientState },
      { name: 'position', frameState: 'play', clientState: 'configuration' },
      'and it names the frame and the two states that disagreed'
    )
    const suppressed = lines.slice(mark).filter(line => line.event === 'configFrameAfterFinish')
    assert.deepEqual(suppressed, [],
      'and this leg refused it: the phase-finish rule is the library writer\'s answer, and ' +
      'leaving this frame to that writer is the hole #600 found')
    assert.deepEqual(positions, [], 'not one byte of it reached the client')
    assert.deepEqual(clientErrors, [], 'and the client was left connected, with nothing to misread')
    assert.equal(dialogs.length, 1, 'the phase it was held in is untouched')
  })
})

test('#600 the picker\'s server dialog is a raw frame the wire check sees, in the state it was written in', async () => {
  await withLane(async ({ leg, dialogs, checked, click }) => {
    const pick = dialogIds(dialogs[0])[0]
    assert.equal(pick, pickIdFor(BODY), 'the list offers the row the lane serves')
    const mark = checked.length
    click(pick)
    await settleUntil(() => dialogs.length === 2, "the chosen server's own dialog")

    // The dialog the client read is the server's: its buttons answer that server's
    // verbs, and the picker's own dialog answers a row.
    const offered = dialogIds(dialogs[1])
    assert.ok(offered.includes(verbIdFor('spectate', BODY)),
      'the second dialog is the server\'s, so the writer under test is the one that wrote it')

    // The wire check is the leg's own, and it saw this frame: a packet object the leg
    // authored has params the leg can encode, so its bytes are the leg's to check
    // (#600's first criterion, on the writer that could not be checked before).
    const seen = checked.slice(mark).filter(frame => frame.name === 'show_dialog')
    assert.equal(seen.length, 1, 'the server dialog reached the wire check once')
    assert.equal(seen[0].state, 'configuration', 'in the state it was written in')
    assert.ok(Buffer.isBuffer(seen[0].buffer) && seen[0].buffer.length > 0, 'with the bytes it wrote')
    assert.equal(leg.wireStats.byState.configuration > 0, true,
      'and the check counts it under its state, which is what byState is for')
    assert.equal(leg.metrics.pickerServerDialogs, 1, 'the leg still counts the dialog it served')
  })
})

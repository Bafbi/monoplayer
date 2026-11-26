// #598: one configuration phase, one registry set, counted off the bytes.
//
// The pure gate in config-stream.test.js composes the phase from the recording and
// the body's frames. This one does not compose anything: it runs the front leg the
// lane runs, with the committed baseline, and reads every configuration frame the
// leg actually writes to a real protocol client. The two failures it can catch that
// the pure one cannot are a wiring mistake in live-front.js (the leg handing the
// interceptor the recording whole) and a landing path that writes a frame no test
// expected.
//
// Seam: an offline front leg at 26.2 and the leg's own `spectate` call, which lands
// a client through the same `sendBodyConfiguration` a granted claim uses, plus the
// `wireCheck` the leg calls for every configuration frame it writes on either path.
// A granted claim needs a dialog clicked twice to reach the same function, and the
// landing it reaches is this one: the frame list here is the one a claim writes.
//
// The body is the worst case rather than a contrived one: its configuration is the
// recording's own replay, so its registry set is the baseline's. That equality is
// what made the live client die.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { readConfigurationBaseline, registryIdOf } from '../../src/legs/configuration-baseline.js'

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

// The ids a client was sent, in the order they arrived. Read off the bytes the leg
// handed the socket, never off the frame's name.
function registryIds (written) {
  return written
    .filter(frame => frame.name === 'registry_data')
    .map(frame => registryIdOf(frame.buffer))
}

function idsThatRepeat (ids) {
  const seen = new Set()
  const repeated = new Set()
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  return [...repeated]
}

// One leg, one real client in its configuration phase, and every configuration
// frame the leg wrote to it.
async function withPickerClient (run) {
  const baseline = readConfigurationBaseline()
  assert.notEqual(baseline, null, 'src/legs/configuration-baseline/26.2.json is committed')
  const written = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: baseline,
    pickerServers: () => ({ source: 'allowed', reason: null, rows: [{ name: BODY }] }),
    // The body a Spectate lands: its own configuration, which here is the
    // recording's replay, so its registry ids are the baseline's.
    getSnapshotConfig: () => baseline.replayFrames,
    wireMode: 'warn',
    wireCheck: payload => {
      if (payload.state === 'configuration') {
        written.push({ name: payload.name, buffer: payload.buffer })
      }
      return { ok: true }
    },
    log: () => {}
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
    const states = []
    bot.on('state', next => states.push(next))
    // The leg admits a login inside its own synchronous window, before it writes the
    // login success that moves the client into configuration. The baseline's frames
    // are written when the library's own finish arrives, so `tags` last is the whole
    // phase on the wire. The dialog that follows is written outside this check on
    // purpose (`sendPickerDialog`, which writes raw), so it is not in `written`.
    await settleUntil(
      () => leg.metrics.allowed === 1 && states.includes('configuration') &&
        written.some(frame => frame.name === 'tags'),
      'the login the leg admitted and the baseline frames on the wire'
    )
    return await run({ leg, written, baseline })
  } finally {
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

test('#598 a picker client is served no registry set, and a landed body one', async () => {
  await withPickerClient(async ({ leg, written, baseline }) => {
    const pickerPhase = written.slice()
    assert.deepEqual(registryIds(pickerPhase), [],
      'the picker\'s phase carries none of the recording\'s ' +
      baseline.replayFrames.filter(frame => frame.name === 'registry_data').length + ' registries')
    assert.deepEqual(pickerPhase.map(frame => frame.name), [
      'custom_payload',
      'feature_flags',
      'select_known_packs',
      'tags'
    ], 'the recording\'s other frames go out in recorded order, and the dialog is written over them')
    assert.equal(pickerPhase.some(frame => frame.name === 'finish_configuration'), false,
      'and the phase is still open, which is what the dialog needs')

    const answer = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(answer.watching, true, 'the body lands the client it named: ' + JSON.stringify(answer))

    const ids = registryIds(written)
    assert.deepEqual(idsThatRepeat(ids), [], 'no registry id reaches the client twice in one phase')
    assert.equal(ids.length, baseline.frames.filter(frame => frame.name === 'registry_data').length,
      'the phase carries the body\'s set once, and it is the recording\'s own: the worst case')
    // The finish is not asserted here: a landing writes it through the library's own
    // writer, which this check does not see. O58 counts it at the client, where the
    // phase's end is the client's own fact.
  })
})

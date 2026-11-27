// #820: a clientbound frame offered to a socket that can no longer take bytes.
//
// Both of the installed library's writers drop such a frame and answer nothing
// (`write` and `writeRaw` in `minecraft-protocol`'s `src/client.js`: `if (!stream.writable)
// { return }`). So this leg's `=== false` test could never fire for this cause, and the
// frame landed in #717's `replayed` and in `metrics.framesReplayed` while it reached
// nobody: a refusal counted as a delivery.
//
// The states below are what the pinned fork (a fork, 1.68.0) reports, read off it at both
// protocol trees the repo runs on 2026-11-27 and copied into the cases rather than assumed,
// because the two write paths do not answer alike. The one asymmetry they buy is the third test's subject: in the
// turn the lane ends a client itself, `serializer.writable` is false while `compressor` and
// `framer` are still true, and a `writeRaw` there still reaches the client. A leg that
// refused that frame would trade this ticket's under-count for an over-count.
//
// Seams: `closedSocketReason`, which both of the leg's write paths ask before the library
// is handed the frame, for the states a unit test can build; and one offline lane with one
// real protocol client for the two turns that need a socket to be closing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mc from 'minecraft-protocol'

import { CLOSED_SOCKET_REASONS, closedSocketReason, createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { readConfigurationBaseline } from '../../src/legs/configuration-baseline.js'

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'telemetry.md')

const VERSION = '26.2'
const NAME = 'Probe'
const BODY = 'sky:25565'

// The frame the play relay synthesizes, and the packet object the packet path writes.
const POSITION = { teleportId: 1, x: 0, y: 64, z: 0, yaw: 0, pitch: 0, dx: 0, dy: 0, dz: 0, flags: 0 }
const KEEP_ALIVE_ID = 42n

async function settleUntil (read, label, timeoutMs = 15_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// One play-state frame, as the wire carries it: the buffer a raw write takes, built by the
// library's own serializer so the client decodes what this file wrote.
function keepAliveFrame () {
  return mc.createSerializer({ state: 'play', isServer: true, version: VERSION })
    .createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: KEEP_ALIVE_ID } })
}

// The states a socket can be in, each the measured shape of one moment.
const OPEN = {
  ended: false,
  socket: { writable: true },
  serializer: { writable: true },
  compressor: { writable: true },
  framer: { writable: true }
}
// A socket this process destroyed, in the turn before the library's 'end' handler runs.
const SOCKET_DESTROYED = {
  ended: false,
  socket: { writable: false },
  serializer: { writable: true },
  compressor: { writable: true },
  framer: { writable: true }
}
// A peer's close: the library has given the connection up, and its streams are still
// writable until they are torn down.
const GIVEN_UP = {
  ended: true,
  socket: { writable: false },
  serializer: { writable: true },
  compressor: { writable: true },
  framer: { writable: true }
}
// The turn the lane ended the client itself: the serializer has flipped, the two streams a
// raw frame writes to have not.
const LANE_ENDED = {
  ended: false,
  socket: { writable: true },
  serializer: { writable: false },
  compressor: { writable: true },
  framer: { writable: true }
}
// A double that reports no socket at all.
const NO_SOCKET = { ended: false }

test('#820 a socket that can take no frame is refused, and the reason names which fact refused it', () => {
  // One row per state and path. The whole judgement of this ticket is in the three
  // refusals and the two acceptances.
  const cases = [
    // The control: an open socket takes the frame on both paths. Without it every refusal
    // below would hold for a predicate that refused unconditionally.
    [OPEN, 'raw', null],
    [OPEN, 'packet', null],
    // The socket under the library is unwritable. This is the state the issue is about.
    [SOCKET_DESTROYED, 'raw', 'socket_not_writable'],
    [SOCKET_DESTROYED, 'packet', 'socket_not_writable'],
    // The library has given the connection up, which its own flag says before the socket's.
    [GIVEN_UP, 'raw', 'socket_ended'],
    [GIVEN_UP, 'packet', 'socket_ended'],
    // The turn the lane ended the client: a packet object is refused, because the
    // library's packet writer tests the serializer and it has flipped. A raw frame is NOT,
    // because the raw writer tests the compressor and it has not: refusing it would refuse
    // a frame the client really gets.
    [LANE_ENDED, 'packet', 'stream_not_writable'],
    [LANE_ENDED, 'raw', null],
    // A double that reports no socket at all is evidence of nothing, so it is not refused.
    [NO_SOCKET, 'raw', null],
    [NO_SOCKET, 'packet', null]
  ]
  for (const [client, path, expected] of cases) {
    assert.equal(closedSocketReason(client, path), expected, path + ' on ' + JSON.stringify(client))
  }

  // A path word this function has never heard of is a refusal to answer, not a default.
  assert.throws(() => closedSocketReason(OPEN, 'both'), {
    name: 'TypeError',
    message: 'path must be raw or packet, got "both"'
  })
})

test('#820 the refusal reasons are a closed set, and docs/telemetry.md names every one', () => {
  const doc = fs.readFileSync(DOC, 'utf8')
  assert.deepEqual([...CLOSED_SOCKET_REASONS], ['socket_ended', 'socket_not_writable', 'stream_not_writable'],
    'the set is the three words the predicate answers with, and nothing else')
  for (const reason of CLOSED_SOCKET_REASONS) {
    assert.ok(doc.includes(`\`${reason}\``),
      'docs/telemetry.md does not name the reason ' + reason + ', so an operator cannot read what it means')
  }
  // The record and the counter the doc names are the two the leg writes, read out of the
  // source so a rename on either side fails here.
  const source = fs.readFileSync(path.join(path.dirname(DOC), '..', 'src', 'legs', 'live-front.js'), 'utf8')
  assert.ok(source.includes("record(client, 'clientboundSocketClosed'"), 'the leg writes the record the doc names')
  assert.ok(doc.includes('front.clientboundSocketClosed'), 'and the doc names the counter it writes')
})

test('#820 the packet path refuses on the turn the lane ended the client, and the channel counts no delivery', async () => {
  await withLane(async ({ leg, positions, lines }) => {
    // The control: the same packet object reaches the client while the socket is open.
    assert.equal(leg.write('position', POSITION), true, 'the open socket takes the frame')
    await settleUntil(() => positions.length === 1, 'the packet at the client')
    const delivered = leg.channels[0].delivered.frames

    // The lane ends the client, as it does on a policy refusal or a Disconnect verb, and
    // writes one more frame in that same turn: the window this ticket is about.
    leg.end('closing_socket_probe')
    const mark = lines.length
    assert.equal(leg.write('position', POSITION), false,
      'a frame written in the turn the lane ended the client never reaches the wire')

    const recorded = lines.slice(mark).filter(line => line.event === 'clientboundSocketClosed').map(line => line.fields)
    assert.equal(recorded.length, 1, 'and the leg says so, once, on its own record')
    assert.deepEqual(
      { name: recorded[0].name, state: recorded[0].state, path: recorded[0].path, reason: recorded[0].reason },
      { name: 'position', state: 'play', path: 'packet', reason: 'stream_not_writable' },
      'the line names the frame, the path that refused it and the cause'
    )

    // The channel's own count is the number #717 and #738 built the counter from: a frame
    // the channel was not delivered does not move it.
    assert.equal(leg.channels[0].delivered.frames, delivered,
      'the channel is told about no frame it did not receive')
    assert.equal(positions.length, 1, 'and the client received nothing behind the one control frame')
  })
})

test('#820 the raw path still writes on that same turn, because the library still writes it', async () => {
  await withLane(async ({ leg, keepAlives }) => {
    leg.end('closing_socket_probe')
    assert.equal(leg.writeRaw(keepAliveFrame(), { state: 'play', name: 'keep_alive' }), true,
      'the raw path is not refused on a stream that still writes')
    await settleUntil(() => keepAlives.length === 1, 'the raw frame at the client')
    assert.equal(String(keepAlives[0].keepAliveId), String(KEEP_ALIVE_ID),
      'the client decoded the frame the leg said it wrote')
  })
})

// One offline lane, one real client landed as a spectator of one body, so there is a
// channel to write to and a play state to write in.
async function withLane (run) {
  const baseline = readConfigurationBaseline()
  assert.notEqual(baseline, null, 'src/legs/configuration-baseline/26.2.json is committed')
  const lines = []
  const dialogs = []
  const positions = []
  const keepAlives = []
  const clientErrors = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: baseline,
    pickerServers: () => ({ source: 'allowed', reason: null, rows: [{ name: BODY }] }),
    getSnapshotConfig: () => baseline.replayFrames,
    wireMode: 'off',
    log: (event, fields) => lines.push({ event, fields })
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    leg.setLoginStartHandler(() => ({ allowed: true, picker: true }))
    leg.setSpectateBody(({ body }) => ({ watching: true, body }))
    // The call-in the core wires for a spectator whose phase has ended. A leg built without
    // one refuses the spectator in words and ends the client, which is not the state this
    // file is about.
    leg.setSpectatorAttach(() => ({ watching: true }))
    leg.setConnectClaimedBody(() => ({ connected: true, warm: true }))
    leg.setCoreAttach(() => ({ attached: true, replayed: 0 }))
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    bot.on('error', error => clientErrors.push(String(error?.message ?? error)))
    bot.on('show_dialog', packet => dialogs.push(packet))
    bot.on('position', packet => positions.push(packet))
    bot.on('keep_alive', packet => keepAlives.push(packet))
    // The wait is for both facts the landing needs: the admit, and the client's own
    // configuration phase, which the picker dialog is the first evidence of. A Spectate
    // called inside the login window hands the client a configuration frame it decodes as
    // a login one, and the landing refuses with `no_cached_configuration`.
    await settleUntil(
      () => leg.metrics.allowed === 1 && dialogs.length === 1,
      'the picker dialog at the client'
    )

    const landing = leg.spectate({ username: NAME, body: BODY, server: BODY })
    assert.equal(landing.watching, true, 'the body lands the client it named: ' + JSON.stringify(landing))
    // The landing's own phase ends with the client answering its finish, which is the
    // library's flip to play on this connection's own client object and the spectator
    // attach call-in that follows it. The wait is for that call-in and not for the client's
    // own state event: the client answers first, so a play frame offered on the client's
    // event is refused by the state rule and this file would read that refusal as its own.
    await settleUntil(
      () => leg.channels.length === 1 && leg.metrics.spectatorJoins === 1,
      'the channel the landing opened, in play'
    )
    assert.deepEqual(clientErrors, [], 'the landing wrote no frame the client could not read')

    return await run({ leg, bot, positions, keepAlives, clientErrors, lines })
  } finally {
    // The socket goes first, for the reason test/legs/spectate-refusal.test.js gives: the
    // library's own end() waits out its close timeout for an answer.
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

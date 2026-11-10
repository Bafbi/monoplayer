// #99: the human's own player wears the puppet's skin, behind a switch.
//
// Five properties of the change are asserted here, at the composition root:
//
//   off is today     with the switch off nothing is written, so the human sees
//                    what they see now
//   one frame        one `player_info` add_player entry for the human's UUID,
//                    carrying the property the backend sent for the puppet, and
//                    no update_listed action (the tab list does not grow)
//   from the server  a proxy that saw no property sends nothing, and the frame
//                    names the UUID the front verified
//   with the replay  the frame goes out with every replay of play state, because
//                    a reconfiguration builds a new player-info map (#134)
//   and it reports  the property log fires once per distinct value, a stranger's
//                    skin is never the frame, and a refusal no later frame repairs
//                    is named (#134)
//
// The packet shape itself is proved in test/core/skin.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, loadConfig, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const STRANGER = 'e9baf8e7-4a9a-27e4-ae35-2a9566110634'
const BUFFER = name => Buffer.from('backend:' + name)
const TEXTURES = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }
const STRANGER_TEXTURES = { name: 'textures', value: 'c3RyYW5nZXI=', signature: 'c2lnbmF0dXJl' }

function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) { const t = { fn, fires: now + ms }; timers.push(t); return t },
    clearTimeout (t) { timers = timers.filter(x => x !== t) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

function makeCore ({ skin, logLines = null, ...config } = {}) {
  const clock = fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'Wiriaw', uuid: PUPPET },
      attachWhitelist: [PLAYER],
      ...config,
      skin: { ...DEFAULT_CONFIG.skin, ...(skin ?? {}) },
      transfer: { ...DEFAULT_CONFIG.transfer, ...(config.transfer ?? {}) }
    },
    backendLeg,
    frontLeg,
    clock,
    logStream: logLines === null ? null : { write: line => logLines.push(JSON.parse(line)) }
  })
  core.start()
  return { clock, backendLeg, frontLeg, core }
}

function warmBackend ({ backendLeg, core }, { playerInfo = true } = {}) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  for (const frame of [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backendLeg.deliver({ state: 'play', ...frame })
  if (playerInfo) deliverPlayerInfo({ backendLeg })
  assert.equal(core.cache.warm, true)
}

// The backend's own frame for the puppet: one add_player entry carrying the
// account's textures property, exactly as Paper sends it.
function deliverPlayerInfo ({ backendLeg }, entries = null) {
  backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: BUFFER('player_info'),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: entries ?? [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [TEXTURES] } }]
    }
  })
}

function attach ({ frontLeg, core }) {
  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  const result = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(result.attached, true)
  return result
}

// The relay writes the backend's own player_info as a raw frame; the skin frame
// is the proxy's own, synthesized, so only that kind counts.
function skinFrames (frontLeg) {
  return frontLeg.frames().filter(frame => frame.name === 'player_info' && frame.kind === 'synth')
}

function transfer (host = 'sky-2.excalia.fr', port = 25565) {
  return { name: 'transfer', buffer: BUFFER('transfer'), data: { host, port } }
}

// The configuration round that follows a followable move or a restarted phase:
// the server's configuration, the client's finish, then its play login and join
// state. The client keeps the socket it had.
function landOnTarget ({ backendLeg, frontLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  backendLeg.deliver({ state: 'configuration', name: 'select_known_packs', data: {} })
  backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(core.clientReconfiguring, false, 'the client is back in play')
  backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 7 } })
  backendLeg.deliver({ state: 'play', name: 'game_state_change', data: { reason: 13, gameMode: 0 } })
  backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 0, z: 0 } })
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', data: {} })
  assert.equal(core.metrics.reconfigurationsCompleted, 1)
}

function eventsNamed (logLines, name) {
  return logLines.filter(line => line.event === name)
}

test('with the switch off, the attach writes no skin frame and says nothing', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: false }, logLines })
  warmBackend(rig)
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 0, 'off is today: nothing about the attach changes')
  assert.equal(rig.core.metrics.skinFramesWritten, 0)
  assert.equal(eventsNamed(logLines, 'puppetSkinWithheld').length, 0, 'a switch the operator turned off is not news')
})

test('with the switch on, one frame gives the human UUID the puppet property', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 1, 'exactly one entry per replay')
  const packet = frames[0].packet
  assert.equal(frames[0].kind, 'synth', 'the frame is the proxy\'s own, not a relay')
  assert.equal(packet.action.add_player, true)
  assert.equal(packet.action.update_listed, undefined, 'the tab list gains no entry for the human')
  assert.equal(packet.data.length, 1)
  assert.equal(packet.data[0].uuid, PLAYER, 'the entry is the human\'s UUID')
  assert.equal(packet.data[0].player.name, 'Bafbi')
  assert.deepEqual(packet.data[0].player.properties, [TEXTURES], 'the property is the backend\'s own, signature and all')
  assert.equal(rig.core.metrics.skinFramesWritten, 1)
})

test('a proxy that saw no player_info sends no skin frame', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig, { playerInfo: false })
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 0, 'the proxy holds no skin of its own to fall back on')
  assert.equal(rig.core.metrics.skinFramesWritten, 0)
})

test('a property that arrives after the attach still reaches the client in play', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  // Warm and attach first: the backend lists the puppet only afterwards, which
  // is the ordinary order on Paper.
  warmBackend(rig, { playerInfo: false })
  attach(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 0)

  deliverPlayerInfo(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 1, 'the attach that is already playing gets the frame')
  assert.equal(frames[0].packet.data[0].uuid, PLAYER)
  assert.equal(rig.core.metrics.skinFramesWritten, 1)
})

test('a second player_info frame does not write a second entry for the same play state', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  deliverPlayerInfo(rig)
  deliverPlayerInfo(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 1,
    'the client keeps the entry it holds, so a second add_player for the same UUID is a write nobody sees')
})

test('a later attach gets its own frame, because a fresh client holds no entry', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  rig.core.detachPlayer({ reason: 'test' })
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 2)
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
})

// #134: Excalia moved the puppet 37 s after the human attached. The client
// re-entered configuration on its own socket, and coming back to play it built a
// new ClientPacketListener, whose playerInfoMap starts empty: the entry the
// attach created was gone. The frame has to go out again, or the human's own
// body falls back to a default skin for the rest of the connection.
test('a reconfiguration re-sends the frame, because the round built a new player-info map', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 1)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  landOnTarget(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 2, 'the client that came back to play holds no entry for its own UUID')
  assert.equal(frames[1].packet.data[0].uuid, PLAYER)
  assert.deepEqual(frames[1].packet.data[0].player.properties, [TEXTURES])
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
})

test('a backend that restarts its configuration round gets the frame again too', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 1)

  rig.backendLeg.deliver({ state: 'play', name: 'start_configuration', buffer: BUFFER('start_configuration'), data: {} })
  rig.clock.tick(1000)
  landOnTarget(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 2, 'the same client-side rule, whatever moved the puppet')
})

test('a property that arrives after the attach is not reported as a withheld skin', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: true }, logLines })
  // The ordinary order on Paper: the attach replay finds no property yet, and
  // the backend lists the puppet a moment later.
  warmBackend(rig, { playerInfo: false })
  attach(rig)
  assert.equal(eventsNamed(logLines, 'puppetSkinWithheld').length, 0,
    'no property yet is the ordinary order, and property_arrived writes the frame')

  deliverPlayerInfo(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 1)
  assert.equal(eventsNamed(logLines, 'puppetSkinWithheld').length, 0)
})

test('a replay that cannot write the frame at all says why, because no later frame repairs it', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: true }, logLines })
  warmBackend(rig)
  // No UUID from the front: the frame has no profile to name, and no later
  // `player_info` can give it one.
  rig.frontLeg.loginStart({ name: 'Bafbi' })
  const result = rig.core.attachPlayer({ name: 'Bafbi' })
  assert.equal(result.attached, true)

  assert.equal(skinFrames(rig.frontLeg).length, 0)
  const withheld = eventsNamed(logLines, 'puppetSkinWithheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].reason, 'no_identity')
})

test('a front with no UUID is named in the ordinary order too, where the property lands later', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: true }, logLines })
  warmBackend(rig, { playerInfo: false })
  rig.frontLeg.loginStart({ name: 'Bafbi' })
  rig.core.attachPlayer({ name: 'Bafbi' })
  assert.equal(eventsNamed(logLines, 'puppetSkinWithheld').length, 0, 'no property yet is not news')

  deliverPlayerInfo(rig)
  const withheld = eventsNamed(logLines, 'puppetSkinWithheld')
  assert.equal(withheld.length, 1, 'the frame that arrives cannot be written either')
  assert.equal(withheld[0].reason, 'no_identity')
  assert.equal(skinFrames(rig.frontLeg).length, 0)
})

// #134: the live tab list arrived through the same frame, and the first entry
// that carried a property was a different player's in 79 of 81 frames. The
// frame the human gets is the puppet's skin, and the known-property log fires on
// the puppet's property only.
test('another player\'s skin is never the frame, and the known log fires once per distinct property', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: true }, logLines })
  warmBackend(rig, { playerInfo: false })
  attach(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 0)

  // A tab list frame whose first entry is somebody else, then the puppet's own.
  deliverPlayerInfo(rig, [{ uuid: STRANGER, player: { name: 'Tutoriel', properties: [STRANGER_TEXTURES] } }])
  assert.equal(skinFrames(rig.frontLeg).length, 0, 'a stranger\'s property is not the puppet\'s skin')
  assert.equal(eventsNamed(logLines, 'puppetSkinKnown').length, 0)

  deliverPlayerInfo(rig)
  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].packet.data[0].player.properties, [TEXTURES])
  const known = eventsNamed(logLines, 'puppetSkinKnown')
  assert.equal(known.length, 1)
  assert.equal(known[0].uuid, PUPPET, 'the property is the puppet\'s own entry')
  assert.equal(known[0].value, TEXTURES.value, 'and the log carries the value it saw')
  assert.equal(known[0].was, null, 'the first property has nothing behind it')

  // The backend keeps relisting the same property, and one of the frames leads
  // with another player: nothing new is known and nothing new is written.
  for (let i = 0; i < 5; i++) {
    deliverPlayerInfo(rig, [{ uuid: STRANGER, player: { name: 'Tutoriel', properties: [STRANGER_TEXTURES] } }])
    deliverPlayerInfo(rig)
  }
  assert.equal(eventsNamed(logLines, 'puppetSkinKnown').length, 1,
    'once per distinct property, not once per player_info frame')
  assert.equal(skinFrames(rig.frontLeg).length, 1)
})

test('a config that names no puppet UUID writes no frame, and says so once', () => {
  const logLines = []
  const rig = makeCore({ skin: { showPuppetSkin: true }, puppet: { username: 'Wiriaw', uuid: null }, logLines })
  warmBackend(rig)
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 0, 'a player the config cannot name takes no skin')
  assert.equal(rig.core.metrics.skinFramesWritten, 0)
  assert.equal(eventsNamed(logLines, 'puppetSkinUnidentified').length, 1, 'said once, not once per frame')
  deliverPlayerInfo(rig)
  assert.equal(eventsNamed(logLines, 'puppetSkinUnidentified').length, 1)
})

test('an unsigned property is carried as it arrived, with no invented signature', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig, { playerInfo: false })
  backendLegDeliverUnsigned(rig)
  attach(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].packet.data[0].player.properties, [{ name: 'textures', value: 'dGV4dHVyZXM=' }])
})

function backendLegDeliverUnsigned ({ backendLeg }) {
  backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: BUFFER('player_info'),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [{ name: 'textures', value: 'dGV4dHVyZXM=' }] } }]
    }
  })
}

test('the switch is a boolean, and a blob is refused at load', () => {
  assert.equal(DEFAULT_CONFIG.skin.showPuppetSkin, true, 'on: a real 26.2 client accepted the property (testdata/skin-verdict.md)')
  assert.throws(() => loadConfig({ attachWhitelist: [PLAYER], skin: { showPuppetSkin: 'yes' } }),
    /config.skin.showPuppetSkin must be a boolean/)
})

// #99/#614: the puppet's skin, on the players a body's clients draw.
//
// #614 gives every pass two entries, and they answer different questions: the body's
// entry names the puppet, and every channel of the body receives it, because a client
// draws a player only from that player's entry. The driver's own entry is #99's frame,
// naming the profile the front verified, because a client draws the body it controls
// from the entry naming that player. A spectator is owed the first and never the second.
//
// Five properties of the change are asserted here, at the composition root:
//
//   off is today     with the switch off nothing is written, so the human sees
//                    what they see now
//   two frames       the body's entry names the puppet, the driver's names the human
//                    whose body the client controls, both carry the property the
//                    backend sent for the puppet, and neither carries update_listed
//                    (the tab list does not grow)
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
import { loadConfig, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { makeCore as rig } from '../support/harness.js'

const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const STRANGER = 'e9baf8e7-4a9a-27e4-ae35-2a9566110634'
const BUFFER = name => Buffer.from('backend:' + name)
const TEXTURES = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }
const STRANGER_TEXTURES = { name: 'textures', value: 'c3RyYW5nZXI=', signature: 'c2lnbmF0dXJl' }

// The skin fixture names the puppet Wiriaw: the backend's player_info entry the
// frame under test carries is that account's. Everything else is the shared rig.
const makeCore = ({ skin, logLines = null, ...config } = {}) =>
  rig({ config: { puppet: { username: 'Wiriaw', uuid: PUPPET }, ...config, skin }, logLines })

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

// The player one entry names. A pass writes the body's entry first and the driver's own
// second, and a test that cares about one of them asks for it by the uuid it carries.
const namedIn = frame => frame.packet.data[0].uuid
const bodySkinFrames = frontLeg => skinFrames(frontLeg).filter(frame => namedIn(frame) === PUPPET)
const ownSkinFrames = frontLeg => skinFrames(frontLeg).filter(frame => namedIn(frame) === PLAYER)

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
  assert.equal(frames.length, 2, 'two entries per replay: the body\'s, then the driver\'s own')
  assert.deepEqual(frames.map(namedIn), [PUPPET, PLAYER], 'the body names the puppet, and the driver names the human')
  const packet = frames[1].packet
  assert.equal(frames[1].kind, 'synth', 'the frame is the proxy\'s own, not a relay')
  assert.equal(packet.action.add_player, true)
  assert.equal(packet.action.update_listed, undefined, 'the tab list gains no entry for the human')
  assert.equal(packet.data.length, 1)
  assert.equal(packet.data[0].uuid, PLAYER, 'the entry is the human\'s UUID')
  assert.equal(packet.data[0].player.name, 'Bafbi')
  assert.deepEqual(packet.data[0].player.properties, [TEXTURES], 'the property is the backend\'s own, signature and all')
  assert.deepEqual(frames[0].packet.data[0].player.properties, [TEXTURES], 'and the body\'s entry carries it too')
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
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
  assert.equal(frames.length, 2, 'the attach that is already playing gets both entries')
  assert.deepEqual(frames.map(namedIn), [PUPPET, PLAYER])
  assert.equal(rig.core.metrics.skinFramesWritten, 2)
})

test('a second player_info frame does not write a second entry for the same play state', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  deliverPlayerInfo(rig)
  deliverPlayerInfo(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 2,
    'the client keeps the entry it holds, so a second add_player for the same UUID is a write nobody sees')
})

test('a later attach gets its own frame, because a fresh client holds no entry', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  rig.core.detachPlayer({ reason: 'test' })
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 4, 'two entries per attach, and the second attach is a new client')
  assert.equal(ownSkinFrames(rig.frontLeg).length, 2)
  assert.equal(rig.core.metrics.skinFramesWritten, 4)
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
  assert.equal(skinFrames(rig.frontLeg).length, 2)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  landOnTarget(rig)

  const own = ownSkinFrames(rig.frontLeg)
  assert.equal(own.length, 2, 'the client that came back to play holds no entry for its own UUID')
  assert.equal(own[1].packet.data[0].uuid, PLAYER)
  assert.deepEqual(own[1].packet.data[0].player.properties, [TEXTURES])
  assert.equal(skinFrames(rig.frontLeg).length, 4, "and the body's entry went out with the same replay")
  assert.equal(rig.core.metrics.skinFramesWritten, 4)
})

test('a backend that restarts its configuration round gets the frame again too', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)
  assert.equal(skinFrames(rig.frontLeg).length, 2)

  rig.backendLeg.deliver({ state: 'play', name: 'start_configuration', buffer: BUFFER('start_configuration'), data: {} })
  rig.clock.tick(1000)
  landOnTarget(rig)

  assert.equal(ownSkinFrames(rig.frontLeg).length, 2, 'the same client-side rule, whatever moved the puppet')
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
  assert.equal(skinFrames(rig.frontLeg).length, 2)
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

  // #614: the body's entry needs no driver, because it names the puppet. Only the
  // driver's own entry has no profile to name here, and that is the line.
  assert.equal(skinFrames(rig.frontLeg).length, 1)
  assert.deepEqual(skinFrames(rig.frontLeg).map(namedIn), [PUPPET])
  const withheld = eventsNamed(logLines, 'puppetSkinWithheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].reason, 'no_identity')
  assert.equal(withheld[0].puppet, false, 'the entry that could not be written is the driver\'s own')
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
  assert.equal(withheld.length, 1, 'the entry that names the front\'s player cannot be written either')
  assert.equal(withheld[0].reason, 'no_identity')
  assert.deepEqual(skinFrames(rig.frontLeg).map(namedIn), [PUPPET], 'and the body\'s entry is written regardless')
})

// #134: the live tab list arrived through the same frame, and the first entry
// that carried a property was usually a different player's. The frame the human
// gets is the puppet's skin, and the known-property log fires on the puppet's
// property only.
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
  const frames = bodySkinFrames(rig.frontLeg)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].packet.data[0].player.properties, [TEXTURES])
  assert.equal(skinFrames(rig.frontLeg).length, 2, "and the driver's own entry went out beside it")
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
  assert.equal(skinFrames(rig.frontLeg).length, 2, 'nothing new is written: the driver holds its entry, and so does the body')

  // A property re-signed with a new value, then the first value again. The
  // comparison is by value, so each change logs, and the later frame carries a
  // value the proxy has seen before.
  const reSigned = { name: 'textures', value: 'cmVzaWduZWQ=', signature: 'c2lnbmF0dXJl' }
  deliverPlayerInfo(rig, [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [reSigned] } }])
  deliverPlayerInfo(rig)
  // #614: a new value rewrites the body's entry and not the driver's, because the
  // client keeps the entry it holds (#134), so one frame follows each change.
  assert.equal(skinFrames(rig.frontLeg).length, 4, 'two passes of change, one entry each')
  assert.equal(ownSkinFrames(rig.frontLeg).length, 1, "the driver's own entry is written once per play state")
  const changes = eventsNamed(logLines, 'puppetSkinKnown')
  assert.equal(changes.length, 3, 'a change logs each time, including back to a value it held before')
  assert.equal(changes[1].was, TEXTURES.value, 'the value it replaced')
  assert.equal(changes[1].value, reSigned.value)
  assert.equal(changes[2].was, reSigned.value)
  assert.equal(changes[2].value, TEXTURES.value)
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
  assert.equal(frames.length, 2)
  for (const frame of frames) {
    assert.deepEqual(frame.packet.data[0].player.properties, [{ name: 'textures', value: 'dGV4dHVyZXM=' }])
  }
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

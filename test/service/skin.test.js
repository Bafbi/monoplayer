// #99: the human's own player wears the puppet's skin, behind a switch.
//
// Three properties of the change are asserted here, at the composition root:
//
//   off is today     with the switch off nothing is written, so the human sees
//                    what they see now
//   one frame        one `player_info` add_player entry for the human's UUID,
//                    carrying the property the backend sent for the puppet, and
//                    no update_listed action (the tab list does not grow)
//   from the server  a proxy that saw no property sends nothing, and the frame
//                    names the UUID the front verified
//
// The packet shape itself is proved in test/core/skin.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, loadConfig, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const BUFFER = name => Buffer.from('backend:' + name)
const TEXTURES = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }

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

function makeCore ({ skin, ...config } = {}) {
  const clock = fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'Wiriaw', uuid: null },
      attachWhitelist: [PLAYER],
      ...config,
      skin: { ...DEFAULT_CONFIG.skin, ...(skin ?? {}) },
      transfer: { ...DEFAULT_CONFIG.transfer, ...(config.transfer ?? {}) }
    },
    backendLeg,
    frontLeg,
    clock
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
function deliverPlayerInfo ({ backendLeg }) {
  backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: BUFFER('player_info'),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [TEXTURES] } }]
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

test('with the switch off, the attach writes no skin frame', () => {
  const rig = makeCore({ skin: { showPuppetSkin: false } })
  warmBackend(rig)
  attach(rig)

  assert.equal(skinFrames(rig.frontLeg).length, 0, 'off is today: nothing about the attach changes')
  assert.equal(rig.core.metrics.skinFramesWritten, 0)
})

test('with the switch on, one frame gives the human UUID the puppet property', () => {
  const rig = makeCore({ skin: { showPuppetSkin: true } })
  warmBackend(rig)
  attach(rig)

  const frames = skinFrames(rig.frontLeg)
  assert.equal(frames.length, 1, 'exactly one entry per attach')
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

test('a second player_info frame does not write a second entry for the same attach', () => {
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

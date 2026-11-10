// Pure unit tests for the skin measurement lane (#99): the frame the run
// delivers, the reading it forms a verdict from, and the orchestration with fake
// adapters. No socket, no client, no host.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SKIN_BODY, PROPERTY_SKIN_BODY, SKIN_CASES, SKIN_LIMITATIONS,
  caseVerdict, formatSkinReport, isDefaultSkinBody, readSkinContext, runSkinCase,
  runSkinLane, skinBodyKind, skinFrame, splitPacketId
} from '../../src/driver/skin.js'
import { skinPlayerInfoPacket } from '../../src/core/skin.js'

const HUMAN = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const DEFAULT_BODY = 'minecraft:textures/entity/player/slim/noor.png'
const PROPERTY_BODY = 'minecraft:skins/6523b6e2352be77336c291a64a22cdc1f85ac2a8'

const property = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }

// One driver `skin` payload, in the shape DriverServer.skinInfo() returns.
const skinPayload = (selfBody, { puppet = true } = {}) => ({
  connected: true,
  camera: 'FIRST_PERSON',
  sessionName: 'Bafbi',
  sessionUuid: HUMAN,
  self: { uuid: HUMAN, name: 'Bafbi', skin: { body: selfBody, cape: null, model: 'slim', secure: true } },
  players: puppet
    ? [{ uuid: PUPPET, name: 'Wiriaw', listed: true, skin: { body: DEFAULT_BODY, cape: null, model: 'wide', secure: true }, textures: [property] }]
    : []
})

// A fake driver: one client that is running until it quits, its skin readings in
// order, and every op recorded. `quit` ends the client, so the socket refuses
// afterwards — that is what the lane's own quit path waits for.
function fakeDriver ({ readings = [], injection = { delivered: true, actions: ['ADD_PLAYER'], entries: [{ uuid: HUMAN, listed: false }] }, puppet = true } = {}) {
  const calls = []
  let running = true
  let reads = 0
  const driver = {
    calls,
    setRunning (value) { running = value },
    async request (op, params = {}) {
      if (!running && op !== 'quit') {
        const error = new Error('connect refused')
        error.code = 'connect'
        throw error
      }
      calls.push({ op, params })
      switch (op) {
        case 'status':
          return {
            ok: true,
            data: {
              connected: true, level: true, player: true, screen: 'none', renderedSections: 36,
              name: 'Bafbi', server: '127.0.0.1:25566', pos: { x: 8.5, y: -60, z: -4.5 }
            }
          }
        case 'skin': {
          const body = readings.length === 0 ? DEFAULT_BODY : readings[Math.min(reads++, readings.length - 1)]
          return { ok: true, data: skinPayload(body, { puppet }) }
        }
        case 'inject_player_info':
          return { ok: true, data: injection }
        case 'perspective':
          return { ok: true, data: { camera: 'THIRD_PERSON_BACK' } }
        case 'screenshot':
          return { ok: true, data: { path: '/screenshots/driver-1.png' } }
        case 'quit':
          running = false
          return { ok: true, data: { quitting: true } }
        default:
          return { ok: false, error: 'unexpected op ' + op }
      }
    }
  }
  return driver
}

// A clock that moves a second per call, so a wait loop's deadline is reachable.
function fakeClock (stepMs = 1000) {
  let value = 0
  return () => (value += stepMs)
}

const noSleep = async () => {}

function lane (driver, overrides = {}) {
  const relaunches = []
  const shots = []
  return {
    relaunches,
    shots,
    options: {
      driver,
      // The relaunch adapter is the host side: a fresh client answers again.
      relaunch: async endpoint => { relaunches.push(endpoint); driver.setRunning(true) },
      endpoint: '127.0.0.1:25566',
      version: '26.2',
      serialize: (version, params) => Buffer.concat([Buffer.from([0x46]), Buffer.from(JSON.stringify(params))]),
      sleep: noSleep,
      now: fakeClock(),
      ...overrides
    }
  }
}

// ---------------------------------------------------------------------------
// The frame the run delivers
// ---------------------------------------------------------------------------

test('the payload handed to the driver is the frame without its packet id', () => {
  const packet = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property })
  const frame = skinFrame({ version: '26.2', packet, serialize: (v, p) => Buffer.concat([Buffer.from([0x46]), Buffer.from(JSON.stringify(p))]) })
  assert.equal(frame.id, 0x46, 'player_info is 0x46 in 26.2 play toClient')
  assert.equal(frame.name, 'player_info')
  assert.deepEqual(splitPacketId(frame.full).payload, frame.payload)
})

test('a multi-byte packet id is split at its terminator, not at one byte', () => {
  const { id, payload } = splitPacketId(Buffer.from([0xac, 0x02, 0x11, 0x22]))
  assert.equal(id, 300)
  assert.deepEqual([...payload], [0x11, 0x22])
})

test('a frame with no packet id terminator is refused rather than delivered', () => {
  assert.throws(() => splitPacketId(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])), /terminator/)
})

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

test('a default skin and a downloaded skin are told apart by their path', () => {
  assert.equal(isDefaultSkinBody(DEFAULT_BODY), true)
  assert.equal(isDefaultSkinBody('minecraft:textures/entity/player/wide/steve.png'), true)
  assert.equal(isDefaultSkinBody(PROPERTY_BODY), false)
  assert.equal(isDefaultSkinBody(null), false)
  assert.ok(DEFAULT_SKIN_BODY.test(DEFAULT_BODY))
  assert.ok(PROPERTY_SKIN_BODY.test(PROPERTY_BODY))
})

test('the kind survives a report whose 40-hex texture name was redacted', () => {
  assert.equal(skinBodyKind(DEFAULT_BODY), 'default')
  assert.equal(skinBodyKind(PROPERTY_BODY), 'property')
  assert.equal(skinBodyKind('minecraft:textures/entity/creeper/creeper.png'), 'other')
  assert.equal(skinBodyKind(null), null)
})

test('the player the client controls is read from the client report, and the puppet found beside it', () => {
  const { self, puppet } = readSkinContext(skinPayload(DEFAULT_BODY))
  assert.equal(self.uuid, HUMAN)
  assert.equal(puppet.uuid, PUPPET)
  assert.equal(readSkinContext(skinPayload(DEFAULT_BODY, { puppet: false })).puppet, null)
  assert.throws(() => readSkinContext({ self: null }), /not in a world/)
})

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('control records what the client shows with no injection, and does not claim a pass on a default', () => {
  const row = caseVerdict({ caseName: 'control', before: skinPayload(DEFAULT_BODY), after: skinPayload(DEFAULT_BODY), injected: false })
  assert.equal(row.changed, false)
  assert.equal(row.accepted, false, 'a default skin is the gap, not an acceptance')
  assert.match(row.reason, /vanilla default skin/)
  assert.equal(row.beforeKind, 'default')
})

test('a signed property the client resolved is an acceptance', () => {
  const row = caseVerdict({ caseName: 'signed', before: skinPayload(DEFAULT_BODY), after: skinPayload(PROPERTY_BODY), injected: true })
  assert.equal(row.accepted, true)
  assert.equal(row.changed, true)
  assert.equal(row.afterKind, 'property')
})

test('a property that changes nothing is a rejection, named with what the client fell back to', () => {
  const row = caseVerdict({ caseName: 'signed', before: skinPayload(DEFAULT_BODY), after: skinPayload(DEFAULT_BODY), injected: true })
  assert.equal(row.accepted, false)
  assert.match(row.reason, /fell back to minecraft:textures\/entity\/player\/slim\/noor.png/)
})

test('a case whose frame was not delivered measures nothing and says so', () => {
  const row = caseVerdict({ caseName: 'unsigned', before: skinPayload(DEFAULT_BODY), after: skinPayload(PROPERTY_BODY), injected: false })
  assert.equal(row.accepted, false)
  assert.match(row.reason, /not delivered/)
})

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('the control case injects nothing, and still reads the skin and takes a screenshot', async () => {
  const driver = fakeDriver({ readings: [DEFAULT_BODY] })
  const shots = []
  const { options, relaunches } = lane(driver, {
    screenshotFetch: async remotePath => { shots.push(remotePath); return { localPath: '/tmp/a.png', bytes: 10, format: 'png' } }
  })
  const row = await runSkinCase({ caseName: 'control', ...options })
  assert.equal(row.injection, null, 'the control case must not inject')
  assert.equal(driver.calls.some(call => call.op === 'inject_player_info'), false)
  assert.equal(driver.calls.filter(call => call.op === 'skin').length, 2)
  assert.deepEqual(shots, ['/screenshots/driver-1.png'])
  assert.deepEqual(relaunches, ['127.0.0.1:25566'])
  assert.equal(row.screenshot.format, 'png')
  assert.equal(row.verdict.accepted, false)
})

test('the signed case injects the puppet property once, for the human UUID, with its signature', async () => {
  const driver = fakeDriver({ readings: [DEFAULT_BODY, PROPERTY_BODY] })
  const { options } = lane(driver)
  const row = await runSkinCase({ caseName: 'signed', ...options })
  const injections = driver.calls.filter(call => call.op === 'inject_player_info')
  assert.equal(injections.length, 1, 'one frame per attach, and a fresh client per case')
  const decoded = JSON.parse(Buffer.from(injections[0].params.hex, 'hex').toString('utf8'))
  assert.equal(decoded.data[0].uuid, HUMAN)
  assert.equal(decoded.data[0].player.properties[0].signature, property.signature)
  assert.equal(row.verdict.accepted, true)
  assert.equal(row.tabList.entryListed, false)
  assert.equal(row.tabList.humanUuid, HUMAN)
  assert.equal(row.injection.frame.id, 0x46)
})

test('the unsigned case strips the signature before it hands the frame over', async () => {
  const driver = fakeDriver({ readings: [DEFAULT_BODY, PROPERTY_BODY] })
  const { options } = lane(driver)
  await runSkinCase({ caseName: 'unsigned', ...options })
  const injection = driver.calls.find(call => call.op === 'inject_player_info')
  const decoded = JSON.parse(Buffer.from(injection.params.hex, 'hex').toString('utf8'))
  assert.equal(decoded.data[0].player.properties[0].signature, undefined)
  assert.equal(decoded.data[0].player.properties[0].value, property.value)
})

test('a client that holds no puppet property fails the case instead of injecting an invented skin', async () => {
  const driver = fakeDriver({ readings: [DEFAULT_BODY], puppet: false })
  const { options } = lane(driver)
  await assert.rejects(() => runSkinCase({ caseName: 'signed', ...options }), /no textures property for the puppet/)
  assert.equal(driver.calls.some(call => call.op === 'inject_player_info'), false)
})

test('the lane states the answer from the signed case only, and never from a case that did not run', async () => {
  const driver = fakeDriver({ readings: [DEFAULT_BODY, PROPERTY_BODY] })
  const { options } = lane(driver)
  const report = await runSkinLane({ ...options, cases: ['signed'] })
  assert.equal(report.answer, 'accepted')
  assert.equal(report.controlBody, null, 'a case that did not run has no control reading')
  assert.equal(report.unsignedAccepted, null)
  assert.equal(report.passed, true)
  assert.deepEqual(report.limitations, [...SKIN_LIMITATIONS])
  assert.match(formatSkinReport(report), /skin answer: accepted/)
})

test('the case list is the three the ticket names, in the order that tells the story', () => {
  assert.deepEqual([...SKIN_CASES], ['control', 'signed', 'unsigned'])
})

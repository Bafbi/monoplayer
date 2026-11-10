// The configuration round's end frame, as the wire carries it (#87).
//
// A restore that has no cached finish_configuration still has to end the phase
// the client is in. Written as a packet object, the frame is serialized against
// whatever state the client holds at that moment — play, before it answers the
// round's acknowledgement, where finish_configuration has no packet id at all.
// The leg builds the bytes instead, so the core writes them through writeRaw
// with the configuration state, exactly like every other configuration frame.
//
// Socket-free: the bytes are built and decoded here, nothing listens.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mc from 'minecraft-protocol'

import { createOfflineFrontLeg, configurationFinishFrame } from '../../src/legs/live-front.js'

const VERSION = '26.1'
const ATTACH_UUID = '06081639-2178-368a-abb3-3f762836f9a4'

test('the configuration finish frame is the configuration packet, not a play one', () => {
  const buffer = configurationFinishFrame({ version: VERSION })
  assert.ok(Buffer.isBuffer(buffer))
  // configuration toClient finish_configuration is packet 0x03 and carries no
  // fields: node tools/protocol.mjs frame 26.1 configuration toClient
  // finish_configuration
  assert.deepEqual([...buffer], [0x03])

  // It decodes with the configuration table, and has no play-state packet id.
  const parsed = mc.createDeserializer({ state: 'configuration', isServer: false, version: VERSION, noErrorLogging: true })
    .parsePacketBuffer(buffer)
  assert.equal(parsed.data.name, 'finish_configuration')
  // In play the same name is not that frame: the play table has no
  // finish_configuration, and the write resolves to packet 0x00
  // (bundle_delimiter). The client would read the end of its configuration
  // round as a bundle marker.
  const play = mc.createSerializer({ state: 'play', isServer: true, version: VERSION, noErrorLogging: true })
  const asPlayPacket = play.createPacketBuffer({ name: 'finish_configuration', params: {} })
  assert.deepEqual([...asPlayPacket], [0x00], 'in play the name is a different packet')
  assert.notDeepEqual([...asPlayPacket], [...buffer])
})

test('the offline front leg hands the core that frame', () => {
  const leg = createOfflineFrontLeg({
    offlineWhitelist: [ATTACH_UUID],
    getSnapshotConfig: () => [],
    wireMode: 'off',
    log: () => {}
  })
  assert.deepEqual([...leg.finishConfigurationFrame()], [0x03])
})

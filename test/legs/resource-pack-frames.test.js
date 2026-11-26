// #614: the resource-pack frame a spectator is offered, in the state its client is in.
//
// A pack arrives while the backend is in its own configuration phase, and a spectator
// stands in play. The holder keeps the frame with the state it arrived in
// (src/core/pending-resource-pack.js), and a packet id is state-scoped, so those bytes
// cannot be written to a play-state client. src/service/monoplayer.js re-encodes the
// frame from the fields it decoded instead, and this file pins the two facts that makes
// legal, read from the protocol data rather than from memory.
//
// Both versions this product carries, because the vendored tree and the npm tree are two
// sources: 26.1 from minecraft-data, 26.2 from vendor/minecraft-data-26.2.
//
// Socket-free: these are the serializers a leg builds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

const VERSIONS = ['26.1', '26.2']
const PACK = {
  uuid: '22222222-3333-4444-8555-666666666666',
  url: 'https://example.invalid/pack.zip',
  hash: '',
  forced: true,
  promptMessage: { type: 'string', value: 'this lane requires the pack' }
}

const serializer = (version, state) => mc.createSerializer({ state, isServer: true, version })
const deserializer = (version, state) => mc.createDeserializer({ state, isServer: false, version, noErrorLogging: true })

for (const version of VERSIONS) {
  test('#614 ' + version + ' carries add_resource_pack in play and configuration over one field layout', () => {
    const play = serializer(version, 'play').createPacketBuffer({ name: 'add_resource_pack', params: PACK })
    const config = serializer(version, 'configuration').createPacketBuffer({ name: 'add_resource_pack', params: PACK })

    assert.equal(play[0], 0x51, 'the id a client in play parses')
    assert.equal(config[0], 0x09, 'and the id a client in configuration parses')
    assert.ok(play.length > 1)
    assert.deepEqual(play.subarray(1), config.subarray(1),
      'past the id the bytes are the same frame, so a re-encode changes the id and nothing else')
  })

  test('#614 ' + version + ' re-encodes a configuration-state pack into play as the same pack', () => {
    // The route the core takes: the holder decoded the frame it was handed, so the
    // re-encode is built from that decode, not from the buffer.
    const configBytes = serializer(version, 'configuration').createPacketBuffer({ name: 'add_resource_pack', params: PACK })
    const decoded = deserializer(version, 'configuration').parsePacketBuffer(configBytes)
    assert.equal(decoded.data.name, 'add_resource_pack')

    const rewritten = serializer(version, 'play').createPacketBuffer({ name: 'add_resource_pack', params: decoded.data.params })
    assert.equal(rewritten[0], 0x51, 'the frame is written in the state the spectator is in')

    const read = deserializer(version, 'play').parsePacketBuffer(rewritten)
    assert.equal(read.data.name, 'add_resource_pack')
    assert.deepEqual(read.data.params, PACK, 'same uuid, url, hash, forced flag and prompt')
  })

  test('#614 ' + version + ' has a serverbound answer in both states', () => {
    // A play-offered pack is answered with a play-state frame. That answer is the
    // spectator's own connection's, and the front drops it (src/legs/live-front.js):
    // nothing a spectator says reaches the server or the puppet's session.
    const answer = { uuid: PACK.uuid, result: 1 }
    for (const state of ['play', 'configuration']) {
      const bytes = mc.createSerializer({ state, isServer: false, version })
        .createPacketBuffer({ name: 'resource_pack_receive', params: answer })
      const read = mc.createDeserializer({ state, isServer: true, version, noErrorLogging: true })
        .parsePacketBuffer(bytes)
      assert.equal(read.data.name, 'resource_pack_receive', 'the serverbound frame exists in ' + state)
      assert.deepEqual(read.data.params, answer)
    }
  })
}

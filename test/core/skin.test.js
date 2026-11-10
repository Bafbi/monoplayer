// #99: the puppet's skin on the human's own player.
//
// The frame this module builds is the whole product change: one `player_info`
// `add_player` entry for the human's UUID carrying the textures property the
// backend sent for the puppet. These assertions are on the packet object and on
// the bytes it serializes to, so a frame the client would reject cannot ship.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import {
  ADD_PLAYER_ONLY, TEXTURES_PROPERTY,
  pickTextures, skinPlayerInfoPacket, texturesPropertyOf, withoutSignature
} from '../../src/core/skin.js'

const HUMAN = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const PROPERTY = { name: TEXTURES_PROPERTY, value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }

// A relayed player_info frame in the shape minecraft-protocol decodes one to.
const relayed = (properties, uuid = PUPPET) => ({
  action: { _value: 14, add_player: true, update_listed: true },
  data: [{ uuid, player: { name: 'Wiriaw', properties } }]
})

test('the textures property comes out of a relayed player_info frame as it stated itself', () => {
  const picked = texturesPropertyOf(relayed([PROPERTY]))
  assert.deepEqual(picked, { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a property without a signature is picked up without one', () => {
  assert.deepEqual(texturesPropertyOf(relayed([{ name: TEXTURES_PROPERTY, value: 'v' }])), { value: 'v' })
})

test('a frame with no textures property yields nothing to inject', () => {
  assert.equal(texturesPropertyOf(relayed([])), null)
  assert.equal(texturesPropertyOf(relayed([{ name: 'other', value: 'v' }])), null)
  assert.equal(texturesPropertyOf({}), null)
  assert.equal(texturesPropertyOf(null), null)
})

test('an empty value is not a skin: it is reported as no property at all', () => {
  assert.equal(pickTextures([{ name: TEXTURES_PROPERTY, value: '' }]), null)
})

test('the frame is one add_player entry for the human, with no tab list action', () => {
  const packet = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: { value: 'v', signature: 's' } })
  assert.equal(packet.action.add_player, true)
  assert.equal(packet.action.update_listed, undefined, 'update_listed would add a tab list line')
  assert.deepEqual(Object.keys(packet.action).filter(key => key !== '_value').sort(), ['add_player'])
  assert.equal(packet.data.length, 1)
  assert.equal(packet.data[0].uuid, HUMAN, 'the entry is the human\'s UUID, not the puppet\'s')
  assert.equal(packet.data[0].player.name, 'Bafbi')
  assert.deepEqual(packet.data[0].player.properties, [{ name: TEXTURES_PROPERTY, value: 'v', signature: 's' }])
})

test('the frame carries no signature when the property has none', () => {
  const packet = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: withoutSignature(PROPERTY) })
  assert.deepEqual(packet.data[0].player.properties, [{ name: TEXTURES_PROPERTY, value: PROPERTY.value }])
})

test('the frame refuses an incomplete request instead of building a skinless entry', () => {
  assert.throws(() => skinPlayerInfoPacket({ name: 'Bafbi', property: { value: 'v' } }), TypeError)
  assert.throws(() => skinPlayerInfoPacket({ uuid: HUMAN, property: { value: 'v' } }), TypeError)
  assert.throws(() => skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi' }), TypeError)
  assert.throws(() => skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: {} }), TypeError)
  assert.throws(() => withoutSignature(null), TypeError)
})

test('the action flags are the byte the protocol carries for add_player', () => {
  assert.equal(ADD_PLAYER_ONLY.add_player, true)
  assert.equal(ADD_PLAYER_ONLY._value, 1)
})

// The wire half: the object above must serialize to a frame the 26.2 client
// reads back as one add_player entry, property intact. This is what the driver
// run decodes with the client's own codec.
test('the frame round-trips through the 26.2 protocol data', () => {
  const serializer = mc.createSerializer({ state: 'play', isServer: true, version: '26.2' })
  const deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '26.2', noErrorLogging: true })
  const packet = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: { value: 'v', signature: 's' } })
  const buffer = serializer.createPacketBuffer({ name: 'player_info', params: packet })
  const parsed = deserializer.parsePacketBuffer(buffer)
  assert.equal(parsed.data.name, 'player_info')
  assert.equal(parsed.metadata.size, buffer.length, 'the frame is exactly as long as its parse')
  const params = parsed.data.params
  assert.equal(params.action.add_player, true)
  assert.equal(params.action.update_listed, false)
  assert.equal(params.data.length, 1)
  assert.equal(params.data[0].uuid, HUMAN)
  assert.deepEqual(params.data[0].player.properties, [{ name: TEXTURES_PROPERTY, value: 'v', signature: 's' }])
})

test('an unsigned frame round-trips too, so the measured case is the shipped frame', () => {
  const serializer = mc.createSerializer({ state: 'play', isServer: true, version: '26.2' })
  const deserializer = mc.createDeserializer({ state: 'play', isServer: false, version: '26.2', noErrorLogging: true })
  const packet = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: withoutSignature(PROPERTY) })
  const buffer = serializer.createPacketBuffer({ name: 'player_info', params: packet })
  const parsed = deserializer.parsePacketBuffer(buffer)
  const property = parsed.data.params.data[0].player.properties[0]
  assert.equal(property.name, TEXTURES_PROPERTY)
  assert.equal(property.value, PROPERTY.value)
  assert.equal(property.signature, undefined, 'the signature bytes are not in the frame')

  const signedBuffer = serializer.createPacketBuffer({
    name: 'player_info',
    params: skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: { value: PROPERTY.value, signature: PROPERTY.signature } })
  })
  assert.ok(buffer.length < signedBuffer.length, 'the unsigned frame is smaller by the signature')
})

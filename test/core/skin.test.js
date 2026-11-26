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
  carriesTextures, pickTextures, skinEntriesFor, skinPlayerInfoPacket, texturesPropertyOf, withoutSignature
} from '../../src/core/skin.js'

const HUMAN = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const WATCHER = '11111111-2222-3333-4444-555555555555'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const PROPERTY = { name: TEXTURES_PROPERTY, value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }

// A relayed player_info frame in the shape minecraft-protocol decodes one to.
const relayed = (properties, uuid = PUPPET) => ({
  action: { _value: 14, add_player: true, update_listed: true },
  data: [{ uuid, player: { name: 'Wiriaw', properties } }]
})

test('the textures property comes out of a relayed player_info frame as it stated itself', () => {
  const picked = texturesPropertyOf(relayed([PROPERTY]), { uuid: PUPPET })
  assert.deepEqual(picked, { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a property without a signature is picked up without one', () => {
  assert.deepEqual(
    texturesPropertyOf(relayed([{ name: TEXTURES_PROPERTY, value: 'v' }]), { uuid: PUPPET }),
    { value: 'v' })
})

test('a frame with no textures property yields nothing to inject', () => {
  assert.equal(texturesPropertyOf(relayed([]), { uuid: PUPPET }), null)
  assert.equal(texturesPropertyOf(relayed([{ name: 'other', value: 'v' }]), { uuid: PUPPET }), null)
  assert.equal(texturesPropertyOf({}, { uuid: PUPPET }), null)
  assert.equal(texturesPropertyOf(null, { uuid: PUPPET }), null)
})

// #134: the live lane's tab list arrived through this frame, and the first entry
// that carried a property was usually a different player's (testdata/skin-verdict.md).
// The property the proxy holds is the puppet's, chosen by UUID.
test('the property is the one the named UUID carries, not the first one in the frame', () => {
  const frame = {
    action: { _value: 1, add_player: true },
    data: [
      { uuid: 'e9baf8e7-4a9a-27e4-ae35-2a9566110634', player: { name: 'Tutoriel', properties: [{ name: TEXTURES_PROPERTY, value: 'stranger', signature: 's' }] } },
      { uuid: PUPPET, player: { name: 'Wiriaw', properties: [PROPERTY] } }
    ]
  }
  assert.deepEqual(texturesPropertyOf(frame, { uuid: PUPPET }), { value: PROPERTY.value, signature: PROPERTY.signature })
  assert.equal(texturesPropertyOf(frame, { uuid: HUMAN }), null, 'a UUID the frame does not list has no property')
})

test('a frame that lists the UUID twice takes the property it carries', () => {
  const frame = {
    action: { _value: 14, add_player: true, update_latency: true },
    data: [
      { uuid: PUPPET, latency: 42 },
      { uuid: PUPPET, player: { name: 'Wiriaw', properties: [PROPERTY] } }
    ]
  }
  assert.deepEqual(texturesPropertyOf(frame, { uuid: PUPPET }), { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a UUID is compared without its hyphens or case', () => {
  assert.deepEqual(texturesPropertyOf(relayed([PROPERTY]), { uuid: PUPPET.replace(/-/g, '').toUpperCase() }),
    { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a frame says whether it carried a skin at all, for any player', () => {
  assert.equal(carriesTextures(relayed([PROPERTY])), true)
  assert.equal(carriesTextures(relayed([{ name: TEXTURES_PROPERTY, value: 'v' }])), true)
  assert.equal(carriesTextures(relayed([{ name: 'other', value: 'v' }])), false)
  assert.equal(carriesTextures(relayed([])), false)
  assert.equal(carriesTextures(null), false)
})

test('no UUID is no property: the frame never stands in for one', () => {
  assert.equal(texturesPropertyOf(relayed([PROPERTY])), null, 'an unnamed player takes no skin')
  assert.equal(texturesPropertyOf(relayed([PROPERTY]), { uuid: null }), null)
  assert.equal(texturesPropertyOf(relayed([PROPERTY]), { uuid: '' }), null)
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
// #516: the frame is a function of the channel it goes to. The entry names one
// player, and a body's two clients are two accounts: the driver's own body and a
// spectator's own body are both drawn from that client's entry, and one entry cannot
// name both. The builder answers one row per channel, in the caller's order, so the
// caller can mark what it wrote and the driver's row keeps the frame #99 proved.
test('the frame is one entry per channel, naming that channel\'s own player', () => {
  const entries = skinEntriesFor({
    property: PROPERTY,
    channels: [
      { channel: null, uuid: HUMAN, name: 'Bafbi' },
      { channel: 'spectator-1', uuid: WATCHER, name: 'Watcher' }
    ]
  })

  assert.equal(entries.length, 2, 'one row per channel, in the order the caller gave them')
  assert.deepEqual(entries.map(entry => entry.channel), [null, 'spectator-1'],
    'the driver keeps the frame with no channel, and a spectator\'s names its own')
  assert.deepEqual(entries.map(entry => entry.packet.data[0].uuid), [HUMAN, WATCHER],
    'each entry names the player of the channel it goes to')
  assert.deepEqual(entries.map(entry => entry.packet.data[0].player.name), ['Bafbi', 'Watcher'])
  for (const entry of entries) {
    assert.deepEqual(entry.packet.data[0].player.properties, [PROPERTY],
      'the property is the backend\'s own, signature and all, for either client')
    assert.equal(entry.packet.action.add_player, true)
    assert.equal(entry.packet.action.update_listed, undefined,
      'the tab list gains no line beside the puppet\'s, for either client')
  }
})

test('a channel that names no player gets no entry, and is reported', () => {
  const entries = skinEntriesFor({
    property: PROPERTY,
    channels: [
      { channel: null, uuid: null, name: 'Bafbi' },
      { channel: 'spectator-1', uuid: WATCHER, name: null },
      { channel: 'spectator-2', uuid: WATCHER, name: 'Watcher' }
    ]
  })

  assert.deepEqual(entries.map(entry => entry.packet === null), [true, true, false],
    'a profile the front did not name is a client left on a vanilla default, not a frame')
  assert.deepEqual(entries.slice(0, 2).map(entry => entry.name), ['Bafbi', null],
    'the report carries the name it had, so the line can say who it was')
  assert.equal(entries[2].packet.data[0].uuid, WATCHER)
  assert.deepEqual(skinEntriesFor({ property: PROPERTY }), [], 'no channel is nobody owed a frame')
  assert.throws(() => skinEntriesFor({ property: PROPERTY, channels: 'holder-1' }), TypeError,
    'a caller that hands a string instead of a list hears about it')
})


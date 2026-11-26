// #99/#614: the puppet's skin, and the profile a frame names.
//
// The frame this module builds is the whole product change: one `player_info`
// `add_player` entry carrying the textures property the backend sent for the puppet,
// for the player the caller names. A client draws a player's body from that player's
// entry, so the module answers the profile too: #614 writes the body's entry by naming
// the puppet, and #99 writes the driver's own entry by naming the driver. These
// assertions are on the packet object and on the bytes it serializes to, so a frame the
// client would reject cannot ship.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import {
  ADD_PLAYER_ONLY, TEXTURES_PROPERTY,
  carriesTextures, pickTextures, skinEntryOf, skinPlayerInfoPacket, withoutSignature
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
  const picked = skinEntryOf(relayed([PROPERTY]), { uuid: PUPPET })
  assert.deepEqual(picked.property, { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a property without a signature is picked up without one', () => {
  assert.deepEqual(
    skinEntryOf(relayed([{ name: TEXTURES_PROPERTY, value: 'v' }]), { uuid: PUPPET }).property,
    { value: 'v' })
})

test('a frame with no textures property yields nothing to inject', () => {
  assert.equal(skinEntryOf(relayed([]), { uuid: PUPPET }), null)
  assert.equal(skinEntryOf(relayed([{ name: 'other', value: 'v' }]), { uuid: PUPPET }), null)
  assert.equal(skinEntryOf({}, { uuid: PUPPET }), null)
  assert.equal(skinEntryOf(null, { uuid: PUPPET }), null)
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
  assert.deepEqual(skinEntryOf(frame, { uuid: PUPPET }).property, { value: PROPERTY.value, signature: PROPERTY.signature })
  assert.equal(skinEntryOf(frame, { uuid: HUMAN }), null, 'a UUID the frame does not list has no entry')
})

test('a frame that lists the UUID twice takes the property it carries', () => {
  const frame = {
    action: { _value: 14, add_player: true, update_latency: true },
    data: [
      { uuid: PUPPET, latency: 42 },
      { uuid: PUPPET, player: { name: 'Wiriaw', properties: [PROPERTY] } }
    ]
  }
  assert.deepEqual(skinEntryOf(frame, { uuid: PUPPET }).property, { value: PROPERTY.value, signature: PROPERTY.signature })
})

test('a UUID is compared without its hyphens or case', () => {
  assert.deepEqual(skinEntryOf(relayed([PROPERTY]), { uuid: PUPPET.replace(/-/g, '').toUpperCase() }).property,
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
  assert.equal(skinEntryOf(relayed([PROPERTY])), null, 'an unnamed player takes no skin')
  assert.equal(skinEntryOf(relayed([PROPERTY]), { uuid: null }), null)
  assert.equal(skinEntryOf(relayed([PROPERTY]), { uuid: '' }), null)
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
// #614: the puppet's own entry, as the backend stated it. The player is read from the
// entry the UUID selected and never from another one, because a busy backend lists the
// whole tab list through one frame and a name taken from the first entry would rename
// the puppet.
test('the puppet\'s entry carries its uuid, its name and its skin together', () => {
  const frame = {
    action: { _value: 1, add_player: true },
    data: [
      { uuid: 'e9baf8e7-4a9a-27e4-ae35-2a9566110634', player: { name: 'Tutoriel', properties: [PROPERTY] } },
      { uuid: PUPPET, player: { name: 'Wiriaw', properties: [PROPERTY] } }
    ]
  }
  assert.deepEqual(skinEntryOf(frame, { uuid: PUPPET }), {
    uuid: PUPPET,
    name: 'Wiriaw',
    property: { value: PROPERTY.value, signature: PROPERTY.signature }
  }, 'the name beside the property, and the entry the UUID named')
  assert.equal(skinEntryOf(frame, { uuid: HUMAN }), null, 'a UUID the frame does not list is no entry')
})

test('an entry with no skin is no entry, and a nameless one is no entry either', () => {
  assert.equal(skinEntryOf(relayed([]), { uuid: PUPPET }), null)
  assert.equal(skinEntryOf({ data: [{ uuid: PUPPET, player: { properties: [PROPERTY] } }] }, { uuid: PUPPET }), null,
    'a frame the proxy cannot name the player in is not a frame it writes')
  assert.equal(skinEntryOf({ data: [{ uuid: PUPPET, player: { name: '', properties: [PROPERTY] } }] }, { uuid: PUPPET }), null)
  assert.equal(skinEntryOf(relayed([PROPERTY])), null, 'no UUID is no answer, never the first entry')
})

// The player the frame names is the caller's, whoever that is: #99 names the driver's
// own and #614 names the puppet, and this module invents neither. It also names one
// player, because a client's entry map is keyed by UUID and one frame cannot dress two
// bodies.
test('the frame names the player it is given, and one player only', () => {
  const forPuppet = skinPlayerInfoPacket({ uuid: PUPPET, name: 'Wiriaw', property: PROPERTY })
  const forHuman = skinPlayerInfoPacket({ uuid: HUMAN, name: 'Bafbi', property: PROPERTY })
  assert.equal(forPuppet.data.length, 1)
  assert.equal(forPuppet.data[0].uuid, PUPPET)
  assert.equal(forPuppet.data[0].player.name, 'Wiriaw')
  assert.equal(forHuman.data[0].uuid, HUMAN)
  assert.deepEqual(forPuppet.data[0].player.properties, forHuman.data[0].player.properties,
    'the same property, because the proxy holds one skin: the puppet\'s')
})

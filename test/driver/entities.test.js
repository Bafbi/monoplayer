// Pure unit tests for the driver's world read (#675): the payload the entities op
// answers, and the claims a run builds from it. No client, no socket, no host.
//
// The gap this closes: skin reads the client's tab list, so it can report a
// player_info entry for a UUID whose body the client never draws. These cases pin the
// reading that answers the other question — is a body standing in that world — and
// the sentence a report quotes from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENTITY_LIMITS, describeEntity, entityClaim, findEntity, isVirtualEntityId, readEntityReading
} from '../../src/driver/entities.js'
import { FIRST_VIRTUAL_ENTITY_ID } from '../../src/core/virtual-players.js'

const HUMAN = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const MISSING = '00000000-0000-4000-8000-000000000000'
const DEFAULT_BODY = 'minecraft:textures/entity/player/wide/steve.png'
const PROPERTY_BODY = 'minecraft:skins/6523b6e2352be77336c291a64a22cdc1f85ac2a8'
const VIRTUAL_ID = FIRST_VIRTUAL_ENTITY_ID + 1

// One driver entities payload, in the shape DriverServer.entityInfo() returns: the
// local player at the centre, the puppet's virtual body beside it, and one cow.
const entitiesPayload = ({ radius = 64.0, inLevel = 3, truncated = false } = {}) => ({
  dimension: 'minecraft:overworld',
  radius,
  center: { x: 0.5, y: -60.0, z: -4.5 },
  inLevel,
  truncated,
  entities: [
    {
      id: 12, type: 'minecraft:player', uuid: HUMAN, name: 'Bafbi',
      pos: { x: 0.5, y: -60.0, z: -4.5 }, distance: 0.0, local: true, player: true,
      skin: { body: PROPERTY_BODY, cape: null, model: 'wide', secure: true }
    },
    {
      id: VIRTUAL_ID, type: 'minecraft:player', uuid: PUPPET, name: 'Wiriaw',
      pos: { x: 2.5, y: -60.0, z: -4.5 }, distance: 2.0, local: false, player: true,
      skin: { body: PROPERTY_BODY, cape: null, model: 'slim', secure: true }
    },
    {
      id: 41, type: 'minecraft:cow', uuid: '0d1c5a92-6a52-4f0e-9a1e-3a0f0c3a51b7', name: 'Cow',
      pos: { x: -3.0, y: -59.0, z: 1.5 }, distance: 6.4, local: false, player: false,
      skin: null
    }
  ]
})

test('the reading keeps every row the mod sent, in the mod\'s order', () => {
  const reading = readEntityReading(entitiesPayload())
  assert.deepEqual(reading.rows.map(row => row.id), [12, VIRTUAL_ID, 41])
  assert.equal(reading.inLevel, 3)
  assert.equal(reading.truncated, false)
  assert.equal(reading.dimension, 'minecraft:overworld')
  assert.deepEqual(reading.center, { x: 0.5, y: -60, z: -4.5 })
})

test('the radius is the mod\'s own, read back rather than assumed', () => {
  assert.equal(readEntityReading(entitiesPayload({ radius: 16.0 })).radius, 16)
  // A payload with no radius is not a reading of one: the mod always sends it.
  const payload = entitiesPayload()
  delete payload.radius
  assert.throws(() => readEntityReading(payload), /radius/)
})

test('a row says what it is: id, registry type, uuid, name, position, and whether it is me', () => {
  const [self, puppet, cow] = readEntityReading(entitiesPayload()).rows
  assert.equal(self.local, true)
  assert.equal(puppet.local, false)
  assert.equal(puppet.type, 'minecraft:player')
  assert.equal(puppet.uuid, PUPPET)
  assert.equal(puppet.name, 'Wiriaw')
  assert.deepEqual(puppet.pos, { x: 2.5, y: -60, z: -4.5 })
  assert.equal(cow.player, false)
  assert.equal(cow.name, 'Cow')
})

test('an entity is found by uuid or by the client\'s id, and neither is a guess', () => {
  const reading = readEntityReading(entitiesPayload())
  assert.equal(findEntity(reading, PUPPET).id, VIRTUAL_ID)
  assert.equal(findEntity(reading, PUPPET.toUpperCase()).id, VIRTUAL_ID)
  assert.equal(findEntity(reading, VIRTUAL_ID).uuid, PUPPET)
  assert.equal(findEntity(reading, MISSING), null)
  assert.equal(findEntity(reading, ''), null)
})

test('the puppet\'s row is the sentence a report quotes: it exists, it is a player, it is not me', () => {
  const reading = readEntityReading(entitiesPayload())
  const puppet = findEntity(reading, PUPPET)
  assert.notEqual(puppet, null)
  assert.equal(
    describeEntity(puppet),
    'entity ' + PUPPET + ' (Wiriaw) exists at (2.5, -60, -4.5), type minecraft:player, not me'
  )
  assert.equal(
    describeEntity(findEntity(reading, HUMAN)),
    'entity ' + HUMAN + ' (Bafbi) exists at (0.5, -60, -4.5), type minecraft:player, me'
  )
})

test('a uuid is answered present with its row spread, or absent with the frame it was answered in', () => {
  const reading = readEntityReading(entitiesPayload())
  const present = entityClaim(reading, { uuid: PUPPET })
  assert.equal(present.present, true)
  assert.equal(present.complete, true)
  assert.equal(present.local, false)
  assert.equal(present.type, 'minecraft:player')
  assert.equal(present.distance, 2)
  assert.equal(present.skinKind, 'property')
  assert.equal(present.sentence, describeEntity(findEntity(reading, PUPPET)))

  const missing = entityClaim(reading, { uuid: MISSING })
  assert.equal(missing.present, false)
  assert.equal(missing.id, null)
  assert.equal(
    missing.sentence,
    'no entity ' + MISSING + ' in the 3 row(s) within 64 blocks of the client, 3 in its level: ' +
      'an entry in the tab list is not a body here'
  )
})

test('absence is answered in the frame it was read in: the radius, and what the level held', () => {
  // 12 in the level, 2 inside the radius: the sentence must not claim a fact about the
  // whole level from a filtered read.
  const payload = entitiesPayload({ radius: 16.0, inLevel: 12 })
  payload.entities = payload.entities.slice(0, 2)
  const claim = entityClaim(readEntityReading(payload), { uuid: MISSING })
  assert.equal(claim.present, false)
  assert.match(claim.sentence, /in the 2 row\(s\) within 16 blocks of the client, 12 in its level/)
})

test('a capped read cannot answer absence, and says so instead of answering it', () => {
  const payload = entitiesPayload({ inLevel: 5000, truncated: true })
  const claim = entityClaim(readEntityReading(payload), { uuid: MISSING })
  assert.equal(claim.present, false)
  assert.equal(claim.complete, false)
  assert.match(claim.sentence, /the mod capped them out of 5000/)
  assert.match(claim.sentence, /a capped read cannot say a body is absent/)
})

test('an id the proxy minted reads as virtual, and one the server did is not', () => {
  const reading = readEntityReading(entitiesPayload())
  assert.equal(findEntity(reading, PUPPET).virtual, true)
  assert.equal(findEntity(reading, HUMAN).virtual, false)
  assert.equal(isVirtualEntityId(FIRST_VIRTUAL_ENTITY_ID), true)
  assert.equal(isVirtualEntityId(FIRST_VIRTUAL_ENTITY_ID - 1), false)
  assert.equal(isVirtualEntityId(null), false)
})

test('the skin the client resolved for a body is named by kind, and an entity with none is null', () => {
  const reading = readEntityReading(entitiesPayload())
  assert.equal(findEntity(reading, PUPPET).skinKind, 'property')
  assert.equal(findEntity(reading, 41).skin, null)
  assert.equal(findEntity(reading, 41).skinKind, null)

  const payload = entitiesPayload()
  payload.entities[1].skin.body = DEFAULT_BODY
  assert.equal(entityClaim(readEntityReading(payload), { uuid: PUPPET }).skinKind, 'default')
})

test('an empty world is a reading of zero rows, and a missing list is refused', () => {
  const empty = entitiesPayload({ inLevel: 0 })
  empty.entities = []
  const reading = readEntityReading(empty)
  assert.deepEqual(reading.rows, [])
  assert.match(entityClaim(reading, { uuid: PUPPET }).sentence, /in the 0 row\(s\)/)

  const broken = entitiesPayload()
  delete broken.entities
  assert.throws(() => readEntityReading(broken), /entities/)
  assert.throws(() => readEntityReading(null), /entities/)
})

test('the limits name both halves, so one op is never read as the other', () => {
  assert.ok(ENTITY_LIMITS.length >= 4)
  for (const limit of ENTITY_LIMITS) assert.equal(typeof limit, 'string')
  const text = ENTITY_LIMITS.join(' ')
  assert.match(text, /tab list/)
  assert.match(text, /body/)
  assert.match(text, /frustum|occlusion/)
})

// #222: the class, not the examples.
//
// A generic frame that carries a body's state replays after every entity-domain
// frame, whatever order it was captured in (issue #222). The fix admits such a
// frame into the entity section, so the question this file answers is: which
// frames, and how does a new one get noticed?
//
// The answer is derived, not remembered. Every clientbound play frame names its
// fields in the vendored protocol, so a frame that carries a top-level entityId
// or entityIds is one this tree has to place. It must be in the entity domain, in
// the replay's merge set, or in the table below with a reason it keeps its
// section's place. A 26.x frame added by a protocol bump fails here until
// somebody places it, which is the guard test/core/clientbound-policy.test.js
// already gives the frame policy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { classifyPlay } from '../../src/core/state-cache.js'
import { ENTITY_GENERIC_FRAMES } from '../../src/core/join-synth.js'
import { applyFrames, createClientState, stateSnapshot } from '../../src/ladder/client-state.js'

const protocol = JSON.parse(fs.readFileSync(
  new URL('../../vendor/minecraft-data-26.2/data/pc/26.2/protocol.json', import.meta.url)
))

// The frames that name a body and keep their section's place, each with the
// reason. An entry here is a decision, so it is written down once, beside the two
// lists it is not in.
const IN_PLACE = {
  login: "the join prefix replays verbatim and its entityId is the body the login creates, so it is the first body frame the client sees",
  block_break_animation: "the block domain: a dig stage is terrain progress the client draws once, not body state",
  animation: "a one-shot swing the client plays and does not store",
  hurt_animation: "a one-shot hurt flash the client plays and does not store",
  entity_status: "a one-shot status byte (death, totem, shield) the client plays and does not store",
  damage_event: "a one-shot damage flash; the health it leads to arrives as a latest-domain frame",
  face_player: "a camera hint for the client's own view, guarded by its isEntity flag",
  debug_entity_value: "a debug payload the client renders in the F3 overlay",
  open_horse_window: "it opens a window, so it must stay after the inventories base it fills, and it carries no body state",
  move_minecart: "ride interpolation for the vehicle the client sits in: a step list no body map holds, so it replays where it was captured and can sit one frame stale"
}

const types = protocol.play.toClient.types
const playNames = Object.values(types.packet[1][0].type[1].mappings)

// The decoded field names of one play frame. The packet type name follows the
// frame name; a frame whose type is a named container (spawn_position) has no
// inline field list, so this walk cannot place it and does not claim to.
function fieldsOf (name) {
  const type = types['packet_' + name]
  if (!Array.isArray(type) || type[0] !== 'container') return null
  return type[1].map(field => field?.name)
}

// A frame that carries a body's identity carries its state. `entityIds` is the
// removal list, which one frame may carry for several bodies.
function namesABody (name) {
  const fields = fieldsOf(name)
  return fields !== null && (fields.includes('entityId') || fields.includes('entityIds'))
}

const bodyFrames = playNames.filter(namesABody).sort()

test('every 26.2 play frame that names a body is placed: entity domain, merge set, or in place', () => {
  assert.ok(bodyFrames.length > 20, 'the walk found the body frames: ' + bodyFrames.length)
  for (const name of bodyFrames) {
    const domain = classifyPlay(name).domain
    const merged = ENTITY_GENERIC_FRAMES.has(name)
    const inPlace = Object.hasOwn(IN_PLACE, name)
    const placed = (domain === 'entity' ? 1 : 0) + (merged ? 1 : 0) + (inPlace ? 1 : 0)
    assert.equal(placed, 1, name + ' is placed once: domain ' + domain + ', merged ' + merged + ', in place ' + inPlace)
  }

  for (const name of Object.keys(IN_PLACE)) {
    assert.ok(bodyFrames.includes(name), name + ' still names a body')
  }
})

test('the merge set holds generic body frames only, and the model keeps their state', () => {
  // One run of frames per merged name, decoded the way the backend leg decodes
  // it. A name with no sample fails below, so a frame joins the merge with a
  // model rule or not at all. A relative move is measured after a spawn, because
  // a delta for a body the client cannot place is ignored by the client too.
  const spawn = { name: 'spawn_entity', data: { entityId: 9, x: 0, y: 64, z: 0, yaw: 0, pitch: 0 } }
  const samples = {
    rel_entity_move: [spawn, { name: 'rel_entity_move', data: { entityId: 9, dX: 4096, dY: 0, dZ: 0 } }],
    entity_move_look: [spawn, { name: 'entity_move_look', data: { entityId: 9, dX: 4096, dY: 0, dZ: 0, yaw: 0, pitch: 0 } }],
    entity_look: [spawn, { name: 'entity_look', data: { entityId: 9, yaw: 0, pitch: 0 } }],
    remove_entity_effect: [{ name: 'remove_entity_effect', data: { entityId: 9, effectId: 1 } }],
    entity_update_attributes: [{ name: 'entity_update_attributes', data: { entityId: 9, properties: [{ key: 'generic.max_health', value: 40, modifiers: [] }] } }],
    entity_equipment: [{ name: 'entity_equipment', data: { entityId: 9, equipments: [{ slot: 5, item: { itemCount: 1, itemId: 1 } }] } }],
    set_passengers: [{ name: 'set_passengers', data: { entityId: 9, passengers: [10] } }]
  }
  for (const name of ENTITY_GENERIC_FRAMES) {
    assert.equal(classifyPlay(name).domain, 'generic', name + ' still routes to generic, so the merge is what orders it')
    const frames = samples[name]
    assert.ok(frames !== undefined, name + ' needs a sample frame for the model check below')
    const state = applyFrames(createClientState(), frames)
    assert.ok(stateSnapshot(state).entities.length > 0, name + ' is body state the client-state model keeps')
  }
})

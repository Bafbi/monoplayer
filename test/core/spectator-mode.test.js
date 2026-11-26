// #633: the two frames that put a spectator's client in spectator game mode.
//
// A spectator's client is handed a body's whole play stream, and that stream says the
// client is the body: the same `login`, the same game mode, the same abilities. So the
// service writes its own answer onto that one channel, after the replay: `game_state_change`
// with reason `change_game_mode` and game mode 3, and `abilities` with the flags a
// spectator holds. What each frame makes a client do, and what it does not, is
// src/core/spectator-mode.js's header.
//
// This file holds the reason and the field names to the protocol data of every version the
// tree speaks, which is #635's lesson: the player entity type was hard-coded and drew
// 26.2's body on a 26.1 lane. The mode id, the flags and the two speeds are vanilla's, and
// no data here states the flags or a speed, so those are pinned with the reason instead.
// Nothing here opens a socket. The service proves the delivery in
// test/service/spectate.test.js, and O62 and O70 prove it over one.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import minecraftData from 'minecraft-data'

import {
  GAME_MODE_CHANGE_REASON,
  GAME_MODE_SPECTATOR,
  SPECTATOR_ABILITY_FLAGS,
  SPECTATOR_FLYING_SPEED,
  SPECTATOR_WALKING_SPEED,
  spectatorModeFrames
} from '../../src/core/spectator-mode.js'

// Every version this tree speaks: 26.1 is the installed data and the default pin, 26.2 is
// the vendored tree the patch script adds to it.
const VERSIONS = ['26.1', '26.2']

const toClient = version => minecraftData(version).protocol.play.toClient.types

// The value a mapper field assigns one of its names, read from the data rather than from
// this module, so a protocol whose mapper renumbered the reasons fails here.
function mappedValue (version, type, field, name) {
  const [, fields] = toClient(version)[type]
  const [, mapper] = fields.find(entry => entry.name === field).type
  const found = Object.entries(mapper.mappings).find(([, mapped]) => mapped === name)
  assert.ok(found, version + ' maps ' + type + '.' + field + ' to ' + name)
  return Number(found[0])
}

const fieldNames = (version, frame) => {
  const [, fields] = toClient(version)['packet_' + frame]
  return fields.map(entry => entry.name)
}

test('#633 the reason a game mode change carries is the protocol data\'s own', () => {
  for (const version of VERSIONS) {
    assert.equal(
      GAME_MODE_CHANGE_REASON,
      mappedValue(version, 'packet_game_state_change', 'reason', 'change_game_mode'),
      'the frame in ' + version + ' changes the game mode at the data\'s own reason'
    )
    assert.deepEqual(
      fieldNames(version, 'game_state_change'),
      ['reason', 'gameMode'],
      'and it carries the game mode in the field this module sets, in ' + version
    )
  }
})

test('#633 the spectator ordinal is the data\'s own, in the frame every session states it in', () => {
  // `game_state_change`'s own `gameMode` is an `f32` with no enum, so that frame cannot
  // say what a spectator is worth. `SpawnInfo.gamemode` can: it is the mapper `login` and
  // `respawn` carry, and it states `3: spectator` in both versions.
  for (const version of VERSIONS) {
    assert.equal(
      GAME_MODE_SPECTATOR,
      mappedValue(version, 'SpawnInfo', 'gamemode', 'spectator'),
      'the ordinal this module writes is the one ' + version + ' states'
    )
  }
})

test('#633 the abilities a spectator holds are the three fields the data states', () => {
  for (const version of VERSIONS) {
    assert.deepEqual(
      fieldNames(version, 'abilities'),
      ['flags', 'flyingSpeed', 'walkingSpeed'],
      'the frame this module writes has no field the data does not state, in ' + version
    )
  }
  // Vanilla's `GameType.SPECTATOR.updatePlayerAbilities`: invulnerable, flying, and flying
  // allowed, and never instant build. Those are the three low bits of the flags byte.
  assert.equal(SPECTATOR_ABILITY_FLAGS, 0b111)
  assert.equal(SPECTATOR_FLYING_SPEED, 0.05)
  assert.equal(SPECTATOR_WALKING_SPEED, 0.1)
})

test('#633 the pair says one thing in the order a client applies it', () => {
  const frames = spectatorModeFrames()
  assert.deepEqual(frames.map(frame => frame.name), ['game_state_change', 'abilities'],
    'the mode first, so the abilities are the ones that mode holds')
  assert.deepEqual(frames[0].packet, {
    reason: GAME_MODE_CHANGE_REASON,
    gameMode: GAME_MODE_SPECTATOR
  })
  assert.deepEqual(frames[1].packet, {
    flags: SPECTATOR_ABILITY_FLAGS,
    flyingSpeed: SPECTATOR_FLYING_SPEED,
    walkingSpeed: SPECTATOR_WALKING_SPEED
  })
  // A caller writes both, and a caller that mutated one would change what every later
  // spectator is told, so each call answers fresh packets.
  const again = spectatorModeFrames()
  assert.notEqual(again, frames)
  assert.notEqual(again[0].packet, frames[0].packet)
})

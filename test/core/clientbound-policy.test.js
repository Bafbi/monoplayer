// Clientbound policy: every protocol frame is classified, and connection
// control never crosses to the front.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  DECISION,
  clientboundPolicy,
  mayCrossToFront,
  PLAY_BLOCK,
  PLAY_LIVE_ONLY,
  PLAY_PER_LEG,
  PLAY_CACHE_ONLY,
  CONFIG_BLOCK,
  CONFIG_PER_LEG,
  NOT_REPLAYABLE
} from '../../src/core/clientbound-policy.js'

const protocol = JSON.parse(fs.readFileSync(
  new URL('../../vendor/minecraft-data-26.2/data/pc/26.2/protocol.json', import.meta.url)
))

const names = state =>
  Object.values(protocol[state].toClient.types.packet[1][0].type[1].mappings)

test('every 26.2 clientbound frame is classified (protocol bump guard)', () => {
  for (const state of ['play', 'configuration']) {
    for (const name of names(state)) {
      const policy = clientboundPolicy(state, name)
      assert.equal(policy.unknown, false, `${state}/${name} is unclassified`)
    }
  }
})

test('connection-control frames are blocked, uncached, and unreplayable', () => {
  const blocked = [
    ['play', 'transfer'],
    ['play', 'start_configuration'],
    ['play', 'kick_disconnect'],
    ['play', 'cookie_request'],
    ['play', 'store_cookie'],
    ['play', 'show_dialog'],
    ['play', 'clear_dialog'],
    ['play', 'hide_message'],
    ['configuration', 'transfer'],
    ['configuration', 'disconnect'],
    ['configuration', 'cookie_request'],
    ['configuration', 'store_cookie'],
    ['configuration', 'show_dialog'],
    ['configuration', 'clear_dialog'],
    ['configuration', 'code_of_conduct']
  ]
  for (const [state, name] of blocked) {
    const policy = clientboundPolicy(state, name)
    assert.equal(policy.decision, DECISION.BLOCK, `${state}/${name}`)
    assert.equal(policy.cache, false, `${state}/${name} cache`)
    assert.equal(policy.relay, false, `${state}/${name} relay`)
    assert.equal(policy.replay, false, `${state}/${name} replay`)
    assert.equal(mayCrossToFront(state, name), false, `${state}/${name} cross`)
  }
})

test('live-only frames relay but never cache or replay', () => {
  for (const name of ['system_chat', 'profileless_chat', 'player_chat', 'ping_response', 'nbt_query_response']) {
    const policy = clientboundPolicy('play', name)
    assert.equal(policy.decision, DECISION.LIVE_ONLY, name)
    assert.equal(policy.relay, true, name)
    assert.equal(policy.cache, false, name)
    assert.equal(mayCrossToFront('play', name), true, `${name} cross`)
    assert.equal(policy.replay, false, name)
  }
})

test('login is cache-only and per-leg frames never cross', () => {
  assert.equal(clientboundPolicy('play', 'login').decision, DECISION.CACHE_ONLY)
  assert.equal(clientboundPolicy('play', 'login').relay, false)
  assert.equal(clientboundPolicy('play', 'login').replay, true)
  for (const name of ['keep_alive', 'position', 'ping', 'bundle_delimiter']) {
    assert.equal(clientboundPolicy('play', name).decision, DECISION.PER_LEG, name)
  }
  assert.equal(clientboundPolicy('configuration', 'keep_alive').decision, DECISION.PER_LEG)
  assert.equal(clientboundPolicy('configuration', 'ping').decision, DECISION.PER_LEG)
})

test('ordinary state frames cache and relay', () => {
  for (const name of ['map_chunk', 'block_change', 'update_health', 'window_items', 'player_info']) {
    const policy = clientboundPolicy('play', name)
    assert.equal(policy.decision, DECISION.STATE, name)
    assert.equal(policy.cache, true, name)
    assert.equal(policy.relay, true, name)
    assert.equal(policy.replay, true, name)
  }
})

test('unknown names and unknown states fail closed', () => {
  for (const [state, name] of [['play', 'made_up_frame'], ['configuration', 'made_up_frame'], ['login', 'success']]) {
    const policy = clientboundPolicy(state, name)
    assert.equal(policy.decision, DECISION.BLOCK)
    assert.equal(policy.unknown, true)
    assert.equal(policy.cache, false)
    assert.equal(policy.relay, false)
    assert.equal(policy.replay, false)
  }
})

test('the derived replay set covers every blocked, live-only, and per-leg name', () => {
  for (const name of [...PLAY_BLOCK, ...PLAY_LIVE_ONLY, ...PLAY_PER_LEG, ...CONFIG_BLOCK, ...CONFIG_PER_LEG]) {
    assert.equal(NOT_REPLAYABLE.has(name), true, name)
  }
  for (const name of PLAY_CACHE_ONLY) {
    assert.equal(NOT_REPLAYABLE.has(name), false, name)
  }
})

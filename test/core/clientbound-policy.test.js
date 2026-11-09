// Clientbound policy: every protocol frame is classified, and connection
// control never crosses to the front.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  CHAT_FRAMES,
  chatRelayAllowed,
  DECISION,
  clientboundPolicy,
  mayCrossToFront,
  PLAY_BLOCK,
  PLAY_LIVE_ONLY,
  PLAY_PER_LEG,
  PLAY_CACHE_ONLY,
  CONFIG_BLOCK,
  CONFIG_PER_LEG,
  CONTROL_FRAMES,
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
    ['play', 'hide_message'],
    ['configuration', 'transfer'],
    ['configuration', 'disconnect'],
    ['configuration', 'cookie_request'],
    ['configuration', 'store_cookie']
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

test('control dialogs relay but are never cached or replayed (#16)', () => {
  const dialogs = [
    ['play', 'show_dialog'],
    ['play', 'clear_dialog'],
    ['configuration', 'show_dialog'],
    ['configuration', 'clear_dialog'],
    ['configuration', 'code_of_conduct']
  ]
  for (const [state, name] of dialogs) {
    const policy = clientboundPolicy(state, name)
    assert.equal(policy.decision, DECISION.CONTROL, `${state}/${name}`)
    assert.equal(policy.relay, true, `${state}/${name} relay`)
    assert.equal(policy.cache, false, `${state}/${name} cache`)
    assert.equal(policy.replay, false, `${state}/${name} replay`)
    assert.equal(policy.unknown, false, `${state}/${name} is a classified frame`)
    assert.equal(mayCrossToFront(state, name), true, `${state}/${name} cross`)
    // One copy lives in the pending holder, so a replay would deliver a stale
    // dialog beside it.
    assert.equal(NOT_REPLAYABLE.has(name), true, `${state}/${name} is never replayed`)
    assert.equal(CONTROL_FRAMES.has(name), true, `${state}/${name} is a control frame`)
  }
  // Control dialogs are not chat: a chat mode has no say about them.
  assert.equal(mayCrossToFront('play', 'show_dialog', { chat: 'off' }), true)
})

test('the chat mode decides which chat frames cross', () => {
  // Three modes, one decision function, so the router and the front-leg
  // backstop cannot disagree (#19).
  for (const name of CHAT_FRAMES) {
    assert.equal(chatRelayAllowed(name, 'full'), true, `full ${name}`)
    assert.equal(chatRelayAllowed(name, 'off'), false, `off ${name}`)
  }
  assert.equal(chatRelayAllowed('system_chat', 'read-only'), true)
  assert.equal(chatRelayAllowed('profileless_chat', 'read-only'), true)
  assert.equal(chatRelayAllowed('player_chat', 'read-only'), false)
  // Not a chat frame: the mode has no say.
  assert.equal(chatRelayAllowed('map_chunk', 'off'), true)
  assert.equal(chatRelayAllowed('player_chat', 'unknown-mode'), false, 'fails closed on the signed frame')
})

test('the last-write gate applies the chat mode when it is given one', () => {
  assert.equal(mayCrossToFront('play', 'player_chat'), true, 'structural answer without a mode')
  assert.equal(mayCrossToFront('play', 'player_chat', { chat: 'full' }), true)
  assert.equal(mayCrossToFront('play', 'player_chat', { chat: 'read-only' }), false)
  assert.equal(mayCrossToFront('play', 'system_chat', { chat: 'off' }), false)
  assert.equal(mayCrossToFront('play', 'system_chat', { chat: 'read-only' }), true)
  // Blocked frames stay blocked whatever the mode says.
  assert.equal(mayCrossToFront('play', 'hide_message', { chat: 'full' }), false)
  // The mode only speaks about play state.
  assert.equal(mayCrossToFront('configuration', 'registry_data', { chat: 'off' }), true)
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

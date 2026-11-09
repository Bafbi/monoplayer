// Clientbound policy: one decision table for every frame the puppet's backend
// connection can send.
//
// The front client is a separate connection authenticated as the attaching
// player. Some clientbound frames only make sense on the connection that
// received them: a `transfer` tells *that* client to reconnect elsewhere, a
// cookie belongs to *that* connection, a kick ends *that* session. Relaying
// one would move the human off the proxy as their own account (the
// 2026-11-08 Skyblock incident), store a server credential in the wrong
// cookie jar, or strand the client in a configuration phase the front does
// not serve.
//
// Five decisions:
//   state       cache it and relay/replay it (ordinary game state)
//   cache_only  keep it for an attach replay, never relay it live (`login`)
//   live_only   relay it while attached, never cache or replay it (chat,
//               per-request responses such as ping/nbt query answers)
//   per_leg     owned by each connection, never crosses (keep-alive, position,
//               ping, bundle delimiters)
//   block       never crosses, never cached, never replayed
//
// Anything not listed is `block` with `unknown: true`, so a protocol bump that
// introduces a frame fails closed and is logged instead of silently reaching
// the front. test/monoplayer-clientbound-policy.test.js walks the vendored
// 26.2 protocol and fails when a name is not classified here.

export const DECISION = Object.freeze({
  STATE: 'state',
  CACHE_ONLY: 'cache_only',
  LIVE_ONLY: 'live_only',
  PER_LEG: 'per_leg',
  BLOCK: 'block'
})

// Never relayed to the front client. `player_chat` and `hide_message` carry
// the puppet connection's message index; the read-only chat path relays only
// system/profileless chat.
export const PLAY_BLOCK = new Set([
  'transfer',
  'start_configuration',
  'kick_disconnect',
  'cookie_request',
  'store_cookie',
  'show_dialog',
  'clear_dialog',
  'player_chat',
  'hide_message'
])

// Relayed live, never cached: chat that carries no signature state, and
// answers to a request the *front* client made.
export const PLAY_LIVE_ONLY = new Set([
  'system_chat',
  'profileless_chat',
  'ping_response',
  'nbt_query_response'
])

// Owned by each connection.
export const PLAY_PER_LEG = new Set([
  'keep_alive',
  'position',
  'ping',
  'bundle_delimiter'
])

// Cached and replayed to a later attach, never relayed live.
export const PLAY_CACHE_ONLY = new Set(['login'])

// Everything else is ordinary state: cached and relayed. Kept explicit so the
// coverage test can prove the table is complete.
export const PLAY_ORDINARY = new Set([
  'abilities', 'acknowledge_player_digging', 'action_bar', 'add_resource_pack',
  'advancements', 'animation', 'attach_entity', 'block_action',
  'block_break_animation', 'block_change', 'boss_bar', 'camera',
  'chat_suggestions', 'chunk_batch_finished', 'chunk_batch_start',
  'chunk_biomes', 'clear_titles', 'close_window', 'collect',
  'craft_progress_bar', 'craft_recipe_response', 'custom_payload',
  'custom_report_details', 'damage_event', 'death_combat_event',
  'debug_block_value', 'debug_chunk_value', 'debug_entity_value', 'debug_event',
  'debug_sample', 'declare_commands', 'declare_recipes', 'difficulty',
  'end_combat_event', 'enter_combat_event', 'entity_destroy', 'entity_effect',
  'entity_equipment', 'entity_head_rotation', 'entity_look', 'entity_metadata',
  'entity_move_look', 'entity_sound_effect', 'entity_status', 'entity_teleport',
  'entity_update_attributes', 'entity_velocity', 'experience', 'explosion',
  'face_player', 'game_rule_values', 'game_state_change',
  'game_test_highlight_pos', 'held_item_slot', 'hurt_animation',
  'initialize_world_border', 'low_disk_space_warning', 'map', 'map_chunk',
  'move_minecart', 'multi_block_change', 'open_book', 'open_horse_window',
  'open_sign_entity', 'open_window', 'player_info', 'player_remove',
  'player_rotation', 'playerlist_header', 'recipe_book_add',
  'recipe_book_remove', 'recipe_book_settings', 'rel_entity_move',
  'remove_entity_effect', 'remove_resource_pack', 'reset_score', 'respawn',
  'scoreboard_display_objective', 'scoreboard_objective', 'scoreboard_score',
  'select_advancement_tab', 'server_data', 'server_links', 'set_cooldown',
  'set_cursor_item', 'set_passengers', 'set_player_inventory',
  'set_projectile_power', 'set_slot', 'set_ticking_state',
  'set_title_subtitle', 'set_title_text', 'set_title_time',
  'simulation_distance', 'sound_effect', 'spawn_entity', 'spawn_position',
  'statistics', 'step_tick', 'stop_sound', 'sync_entity_position',
  'tab_complete', 'tags', 'teams', 'test_instance_block_status',
  'tile_entity_data', 'tracked_waypoint', 'trade_list', 'unload_chunk',
  'update_health', 'update_light', 'update_time', 'update_view_distance',
  'update_view_position', 'vehicle_move', 'window_items',
  'world_border_center', 'world_border_lerp_size', 'world_border_size',
  'world_border_warning_delay', 'world_border_warning_reach', 'world_event',
  'world_particles',
  // Legacy spellings still used by the spike fakes and older fixtures.
  // The wire protocol for 26.1/26.2 uses update_health, spawn_entity,
  // entity_destroy, entity_teleport, block_change, and boss_bar; these are the
  // same state under their pre-rename names.
  'block_update',
  'bossbar',
  'health',
  'add_entity',
  'remove_entities',
  'entity_position'
])

// Configuration-phase frames. Cookies, dialogs, the code of conduct, a
// disconnect, and a transfer are connection control: the puppet took the
// action, the front client must not.
export const CONFIG_BLOCK = new Set([
  'cookie_request',
  'disconnect',
  'store_cookie',
  'transfer',
  'clear_dialog',
  'show_dialog',
  'code_of_conduct'
])

export const CONFIG_PER_LEG = new Set(['keep_alive', 'ping'])

export const CONFIG_ORDINARY = new Set([
  'add_resource_pack',
  'custom_payload',
  'custom_report_details',
  'feature_flags',
  'finish_configuration',
  'registry_data',
  'remove_resource_pack',
  'reset_chat',
  'select_known_packs',
  'server_links',
  'tags'
])

// Derived sets for the replay path. Names that may never be replayed, across
// both states; join-synth uses this defensively on every snapshot section.
export const NOT_REPLAYABLE = new Set([
  ...PLAY_BLOCK,
  ...PLAY_LIVE_ONLY,
  ...PLAY_PER_LEG,
  ...CONFIG_BLOCK,
  ...CONFIG_PER_LEG,
  'pong'
])

function buildTable (ordinary, cacheOnly, liveOnly, perLeg, block) {
  const table = new Map()
  for (const name of ordinary) table.set(name, DECISION.STATE)
  for (const name of cacheOnly) table.set(name, DECISION.CACHE_ONLY)
  for (const name of liveOnly) table.set(name, DECISION.LIVE_ONLY)
  for (const name of perLeg) table.set(name, DECISION.PER_LEG)
  for (const name of block) table.set(name, DECISION.BLOCK)
  return table
}

const TABLES = {
  play: buildTable(PLAY_ORDINARY, PLAY_CACHE_ONLY, PLAY_LIVE_ONLY, PLAY_PER_LEG, PLAY_BLOCK),
  configuration: buildTable(CONFIG_ORDINARY, [], [], CONFIG_PER_LEG, CONFIG_BLOCK)
}

const BLOCKED = Object.freeze({
  decision: DECISION.BLOCK, cache: false, relay: false, replay: false, unknown: false
})
const UNKNOWN = Object.freeze({
  decision: DECISION.BLOCK, cache: false, relay: false, replay: false, unknown: true
})

// state: 'play' | 'configuration'. Unknown states and unknown names fail
// closed (block) with `unknown: true` so the caller can log them.
export function clientboundPolicy (state, name) {
  const table = TABLES[state]
  if (!table) return UNKNOWN
  const decision = table.get(name)
  if (!decision) return UNKNOWN
  if (decision === DECISION.BLOCK) return BLOCKED
  return {
    decision,
    cache: decision === DECISION.STATE || decision === DECISION.CACHE_ONLY,
    relay: decision === DECISION.STATE || decision === DECISION.LIVE_ONLY,
    replay: decision === DECISION.STATE || decision === DECISION.CACHE_ONLY,
    unknown: false
  }
}

// True when a clientbound frame may be written to the front at all. Used by
// the front leg as a last-write gate, independent of the core router.
export function mayCrossToFront (state, name) {
  return clientboundPolicy(state, name).decision !== DECISION.BLOCK
}

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
// Six decisions:
//   state       cache it and relay/replay it (ordinary game state)
//   cache_only  keep it for an attach replay, never relay it live (`login`)
//   live_only   relay it while attached, never cache or replay it (chat,
//               per-request responses such as ping/nbt query answers)
//   control     relay it to the human that answers it, never cache or replay
//               it (control dialogs and the resource pack; a pending holder
//               keeps the one copy, #16, #98)
//   per_leg     owned by each connection, never crosses (keep-alive, position,
//               ping, bundle delimiters)
//   block       never crosses, never cached, never replayed
//
// Anything not listed is `block` with `unknown: true`, so a protocol bump that
// introduces a frame fails closed and is logged instead of silently reaching
// the front. test/core/clientbound-policy.test.js walks the vendored
// 26.2 protocol and fails when a name is not classified here.

export const DECISION = Object.freeze({
  STATE: 'state',
  CACHE_ONLY: 'cache_only',
  LIVE_ONLY: 'live_only',
  CONTROL: 'control',
  PER_LEG: 'per_leg',
  BLOCK: 'block'
})

// Control dialogs: the server asks the human a question (`show_dialog`) or
// withdraws it (`clear_dialog`), in play or in configuration. `code_of_conduct`
// is the configuration gate with the same shape.
//
// The human answers these, so a control frame is not connection control: it
// crosses to the client that answers it, and its answer goes back to the
// backend as the puppet's own frame. What a dialog with no client attached
// does is the pending holder's business (#16), and which dialog is the human's
// to answer is #20 and #21's. Never cached and never replayed: the holder keeps
// the one copy, so a replay would deliver a stale dialog beside it.
export const CONTROL_FRAMES = new Set([
  'show_dialog',
  'clear_dialog',
  'code_of_conduct'
])

// The resource pack is a control frame the human answers with
// `resource_pack_receive`, in play or in configuration (#98). The server sends
// the pack once and the puppet's own accept closes the round, so the copy the
// holder keeps is the only one a later client can receive. Ordinary state
// cannot carry it: a play-state pack lands in the 512-entry generic ring and is
// evicted about 90 s into a live session, which is the reported "no pack after
// a reattach". `remove_resource_pack` is the withdrawal, so it follows the same
// path and the two cannot disagree.
export const RESOURCE_PACK_FRAMES = new Set([
  'add_resource_pack',
  'remove_resource_pack'
])

// Every control frame, whichever holder owns it.
const CONTROL_ANY = [...CONTROL_FRAMES, ...RESOURCE_PACK_FRAMES]

// Never relayed to the front client. `hide_message` carries the puppet
// connection's message index, so relaying it would hide the wrong message.
export const PLAY_BLOCK = new Set([
  'transfer',
  'start_configuration',
  'kick_disconnect',
  'cookie_request',
  'store_cookie',
  'hide_message'
])

// Relayed live, never cached: chat, and answers to a request the *front*
// client made.
//
// `player_chat` is the server's signed chat. This table says it is a frame
// that may cross; the chat mode decides whether the session includes it, and
// the router applies that (#19). The split is deliberate: this table answers
// "what is this frame", and a mode is session configuration, not frame
// structure. The front leg's last-write gate therefore cannot see the mode, so
// the router is the one place that enforces it, and
// test/service/chat-send.test.js pins it there.
export const PLAY_LIVE_ONLY = new Set([
  'system_chat',
  'profileless_chat',
  'player_chat',
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
  'abilities', 'acknowledge_player_digging', 'action_bar',
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
  'remove_entity_effect', 'reset_score', 'respawn',
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

// Configuration-phase frames. Cookies, a disconnect, and a transfer are
// connection control: the puppet took the action, the front client must not. A
// configuration dialog and the code of conduct are `control` instead (see
// CONTROL_FRAMES): the human answers those.
export const CONFIG_BLOCK = new Set([
  'cookie_request',
  'disconnect',
  'store_cookie',
  'transfer'
])

export const CONFIG_PER_LEG = new Set(['keep_alive', 'ping'])

export const CONFIG_ORDINARY = new Set([
  'custom_payload',
  'custom_report_details',
  'feature_flags',
  'finish_configuration',
  'registry_data',
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
  ...CONTROL_ANY,
  ...CONFIG_BLOCK,
  ...CONFIG_PER_LEG,
  'pong'
])

// A control dialog and a resource pack exist in both states, so the control
// frames are added to each table rather than repeated per state.
function buildTable (ordinary, cacheOnly, liveOnly, perLeg, block) {
  const table = new Map()
  for (const name of ordinary) table.set(name, DECISION.STATE)
  for (const name of cacheOnly) table.set(name, DECISION.CACHE_ONLY)
  for (const name of liveOnly) table.set(name, DECISION.LIVE_ONLY)
  for (const name of perLeg) table.set(name, DECISION.PER_LEG)
  for (const name of block) table.set(name, DECISION.BLOCK)
  for (const name of CONTROL_ANY) table.set(name, DECISION.CONTROL)
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
    relay: decision === DECISION.STATE || decision === DECISION.LIVE_ONLY || decision === DECISION.CONTROL,
    replay: decision === DECISION.STATE || decision === DECISION.CACHE_ONLY,
    unknown: false
  }
}

// The chat modes `loadConfig` accepts. The config validator and the front leg's
// own check both read this set, so the service that hands the leg a mode and the
// leg that refuses an unknown one cannot disagree about which modes exist (#97,
// #103).
export const CHAT_MODES = new Set(['full', 'commands', 'read-only', 'off'])

// The three chat frames, and whether a chat mode relays each one. The chat mode
// is session configuration rather than frame structure, so it is not a table
// entry; this is the one function that turns a mode into a yes or no, so the
// router and the front leg's backstop cannot disagree about it.
export const CHAT_FRAMES = new Set(['system_chat', 'profileless_chat', 'player_chat'])

export function chatRelayAllowed (name, mode) {
  if (!CHAT_FRAMES.has(name)) return true
  // `full` relays all three. `read-only` and `commands` relay the server's chat
  // but not the signed player chat, which only makes sense beside a human
  // speaking in open chat as the account (#19, #97). `off` relays none of them.
  // A mode this function does not know answers like `read-only`, which keeps
  // the signed frame off.
  if (mode === 'full') return true
  if (mode === 'off') return false
  return name !== 'player_chat'
}

// True when a clientbound frame may be written to the front at all. Used by
// the front leg as a last-write gate, independent of the core router. Pass the
// chat mode so that gate answers the way the router does.
export function mayCrossToFront (state, name, { chat = null } = {}) {
  const policy = clientboundPolicy(state, name)
  if (policy.decision === DECISION.BLOCK) return false
  if (chat === null || state !== 'play') return true
  return chatRelayAllowed(name, chat)
}

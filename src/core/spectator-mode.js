// #633: the two frames that put a spectator's client in spectator game mode.
//
// A spectator's client is handed a body's whole play stream, and that stream says the
// client is the body. It carries the body's `login`, whose game mode the client adopts,
// the body's own `game_state_change`, and the body's `abilities`. So a client that
// watches a body stands in it, in the body's game mode, until something tells it
// otherwise.
//
// The owner asked the question that removes the whole class: *why am I not in spectator
// mode, wouldn't it be easier?* It is. A spectator's own channel carries two frames the
// body never sent, built here and written to that channel alone:
//
//   `game_state_change`  reason `change_game_mode` and game mode 3, so the client's own
//                        game mode is spectator.
//   `abilities`          the flags and speeds a spectator holds.
//
// What the mode frame does, read from the client's own code (26.2, the jar the driver
// lane builds against). `ClientPacketListener.handleGameEvent` hands the mode to
// `MultiPlayerGameMode.setLocalMode`, which runs `GameType.SPECTATOR.updatePlayerAbilities`:
// `mayfly`, `flying` and `invulnerable` true, `instabuild` false. From there the client
// flies, takes no damage, and refuses to place, use or attack. So the mode frame is what
// makes a spectator a spectator, and **flight comes from the mode, not from the abilities
// frame**.
//
// The abilities frame is the other half and it is not decoration. It pins the two speeds,
// and it is the only frame that can take flight away: an abilities frame with the bits
// clear sets `mayfly` false, and a client stops re-asserting `flying` when it is. That is
// why the front refuses a body's own `abilities` and `game_state_change` to a spectator
// channel (src/legs/live-front.js, `DRIVER_ONLY_FRAMES`): the body's pair would revoke the
// spectator's. Both frames, in this order, which is a server's order, and the flags are the
// three low bits of the byte: invulnerable 1, flying 2, mayfly 4.
//
// What these two frames do not do is hide the client's own body, and #633's ticket says
// they do. `Player.isSpectator()` is the gate on the body model, and on the client
// `AbstractClientPlayer.gameMode()` reads the *player-list entry for its own UUID*. #614
// sends no entry naming a spectator, so that entry is absent, `gameMode()` is null, and
// `isSpectator()` stays false: the body model is drawn in third person, the player still
// collides with blocks, and the spectator action bar and the scroll-for-speed control
// stay off. The entry that would fix it is a `player_info` with `add_player` and
// `update_game_mode` in one frame, game mode 3, for the spectator's own UUID, and it is
// #647. Until then, this module's two frames deliver flight, invulnerability and a client
// that cannot act, and nothing more.
//
// Field shapes come from the protocol data of both versions this tree speaks, which is
// #635's lesson (a hard-coded player entity type drew 26.2's body on a 26.1 lane):
//   node tools/protocol.mjs frame 26.2 play toClient game_state_change
//   node tools/protocol.mjs frame 26.2 play toClient abilities
// The reason is a mapper, so its value is the data's own and
// test/core/spectator-mode.test.js holds it there for 26.1 and 26.2. This frame's own
// `gameMode` field is an f32 with no enum, so the frame cannot say what a spectator is
// worth; `SpawnInfo.gamemode` can, because it is the mapper `login` and `respawn` carry and
// it states `3: spectator` in both versions. The test holds the ordinal there too.
//
// What this module is not: a delivery. It answers frames, and the caller writes them on
// the channel of the client that needs them (src/service/monoplayer.js, `writeSpectatorMode`).
// They are never written on every channel and never sent to the backend. A lane that put
// every channel in spectator mode would break the product, because a driver is a player in
// the world and its own client would lose its body and its controls.

// The reason a game mode change carries, as 26.1 and 26.2 state it: the mapper's entry for
// `change_game_mode`. Held to the data by test/core/spectator-mode.test.js.
export const GAME_MODE_CHANGE_REASON = 3

// Vanilla's game mode ordinals: survival 0, creative 1, adventure 2, spectator 3. The play
// `login` frame states the same value for the same reason, through `SpawnInfo.gamemode`, and
// test/core/spectator-mode.test.js holds this constant to that mapper in 26.1 and 26.2.
export const GAME_MODE_SPECTATOR = 3

// The abilities a spectator holds: invulnerable, flying, and flying allowed. Vanilla's
// `GameType.SPECTATOR` is where this set comes from, and instant build is not in it. The
// mode frame grants the same three, so this frame's job is to pin the speeds and to keep
// a body's own abilities from taking flight away.
export const SPECTATOR_ABILITY_FLAGS = 0b111

// Vanilla's two defaults, flying 0.05 and walking 0.1. No data in this tree states a
// speed, so nothing here can hold these two to a source.
export const SPECTATOR_FLYING_SPEED = 0.05
export const SPECTATOR_WALKING_SPEED = 0.1

// The frames a spectator's own channel is owed, in the order a client applies them: the
// mode first, so the abilities that follow are the ones that mode holds. Fresh packets on
// every call, because a caller that mutated one would change what every later spectator is
// told.
export function spectatorModeFrames () {
  return [
    {
      name: 'game_state_change',
      packet: { reason: GAME_MODE_CHANGE_REASON, gameMode: GAME_MODE_SPECTATOR }
    },
    {
      name: 'abilities',
      packet: {
        flags: SPECTATOR_ABILITY_FLAGS,
        flyingSpeed: SPECTATOR_FLYING_SPEED,
        walkingSpeed: SPECTATOR_WALKING_SPEED
      }
    }
  ]
}

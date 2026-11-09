// #16: the pending control dialog.
//
// The backend asks the human a question with `show_dialog` and withdraws it with
// `clear_dialog`. One dialog is outstanding at a time: a newer show replaces the
// held one, exactly as a screen replaces a screen.
//
// Nothing here answers, times out, or clicks. This module holds the frame that
// still needs an answer so a client that attaches later receives it, and it
// releases that frame when the backend clears it or the human answers. The
// policy on top — which dialog is the human's to answer, and what a headless
// puppet does instead — belongs to #20 and #21.
//
// The held frame is deliberately outside the state cache: the clientbound
// policy marks a control dialog as neither cacheable nor replayable, so this is
// the one copy, and a replay cannot deliver a stale dialog beside it.
//
// Pure: no timers, no sockets. The router drives it and the core counts what it
// does, so there is no second counter to drift.

// The serverbound frames that answer a held dialog: a dialog button
// (`custom_click_action`, in play and in configuration) and the code-of-conduct
// gate (`accept_code_of_conduct`, configuration only).
export const CONTROL_ANSWERS = new Set([
  'custom_click_action',
  'accept_code_of_conduct'
])

const STATES = new Set(['play', 'configuration'])

// Pure holder. `show` replaces, `clear` drops, `answer` releases on the human's
// frame, `forAttach` returns the held frame for a client that arrived in the
// frame's own state.
export function createPendingDialog () {
  let held = null // { state, name, buffer, data } | null

  function show ({ state, name, buffer, data = null } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('pending dialog show requires a frame name')
    }
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('pending dialog show requires the frame buffer')
    }
    if (!STATES.has(state)) {
      throw new TypeError(`pending dialog state must be play or configuration, got ${JSON.stringify(state)}`)
    }
    const replaced = held !== null
    held = { state, name, buffer, data }
    return { replaced }
  }

  function clear () {
    const dropped = held !== null
    held = null
    return { dropped }
  }

  // The human answered with `name`. Only a control answer releases a dialog.
  function answer ({ name } = {}) {
    if (held === null || !CONTROL_ANSWERS.has(name)) return { answered: false }
    const answered = held
    held = null
    return { answered: true, name: answered.name, state: answered.state }
  }

  // The frame to re-send to a client that just arrived in `state`, or null.
  // Re-sending is not answering: the dialog stays held until it is cleared or
  // answered, so a second attach gets it too.
  function forAttach (state) {
    if (held === null || held.state !== state) return null
    return { state: held.state, name: held.name, buffer: held.buffer, data: held.data }
  }

  function peek () {
    return held === null ? null : { state: held.state, name: held.name }
  }

  return {
    show,
    clear,
    answer,
    forAttach,
    peek,
    get held () { return held !== null }
  }
}

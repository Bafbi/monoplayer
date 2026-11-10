// #98: the resource packs the puppet's connection holds.
//
// The server sends `add_resource_pack` once per connection and withdraws it
// with `remove_resource_pack`. The puppet's own accept closes the round, so
// nothing re-sends the pack, and the copy that reaches a later client is the
// only copy. The clientbound policy therefore keeps a pack out of the state
// cache: a play-state pack would land in the 512-entry generic ring and be
// evicted in about 90 s of live traffic, which is a reattach with no pack.
//
// This module is that copy. One entry per pack UUID, in send order, holding
// the frame verbatim and whether the server has been told an answer for it.
// Nothing here writes a frame: the router relays, resends, and answers, so the
// counters and the writes stay in one place.
//
// A pack is not a question with one answer. It stays in effect until the server
// removes it, so an answer marks the entry answered and leaves it held: a client
// that attaches later still needs the pack, whether or not an earlier client
// answered for it.
//
// Pure: no timers, no sockets.

const STATES = new Set(['play', 'configuration'])

// The results that end a pack round: successfully loaded (0), declined (1),
// failed download (2), invalid URL (5), failed reload (6), discarded (7). A
// client sends accepted (3) or downloaded (4) on the way there, and a session
// that stops at either has left the server mid-round: the client never said the
// pack is in place, so the answer a detach sends is still owed.
export const TERMINAL_RESULTS = new Set([0, 1, 2, 5, 6, 7])

// The pack a frame speaks about. A leg that decodes neither field leaves the
// entry unkeyed, so it is never replaced and only `clear` drops it.
function packId (data) {
  const id = data?.uuid ?? data?.id ?? null
  return id === null || id === undefined ? null : String(id)
}

export function createPendingResourcePacks () {
  let held = [] // [{ state, name, buffer, data, uuid, answered }]

  function add ({ state, name = 'add_resource_pack', buffer, data = {} } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('pending resource pack requires a frame name')
    }
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('pending resource pack requires the frame buffer')
    }
    if (!STATES.has(state)) {
      throw new TypeError(`pending resource pack state must be play or configuration, got ${JSON.stringify(state)}`)
    }
    const uuid = packId(data)
    const entry = { state, name, buffer, data, uuid, answered: false, lastResult: null }
    const at = uuid === null ? -1 : held.findIndex(item => item.uuid === uuid)
    if (at >= 0) {
      held = held.map((item, index) => index === at ? entry : item)
      return { replaced: true, uuid }
    }
    held = [...held, entry]
    return { replaced: false, uuid }
  }

  // The server withdrew a pack. Entries with no UUID are left alone: a frame the
  // leg could not decode cannot prove which pack it withdraws.
  function remove ({ uuid = null } = {}) {
    const id = uuid === null || uuid === undefined ? null : String(uuid)
    if (id === null) return { dropped: false }
    const before = held.length
    held = held.filter(entry => entry.uuid !== id)
    return { dropped: held.length !== before }
  }

  // The server has been told a result for this pack. Only a terminal one ends
  // the round: accepted and downloaded are the middle of it, so a client that
  // leaves there still owes the server an answer.
  function answered ({ uuid = null, result = null } = {}) {
    const id = uuid === null || uuid === undefined ? null : String(uuid)
    if (id === null) return { answered: false }
    const terminal = TERMINAL_RESULTS.has(Number(result))
    let found = false
    held = held.map(entry => {
      if (entry.uuid !== id) return entry
      found = true
      return { ...entry, answered: terminal, lastResult: result }
    })
    return { answered: found, terminal }
  }

  // The frames a client that just arrived in `state` still needs, in send order.
  function list (state) {
    return held.filter(entry => entry.state === state)
  }

  // Packs the server has heard nothing about, in send order.
  function unanswered (state = null) {
    return held.filter(entry => entry.answered === false && (state === null || entry.state === state))
  }

  function clear () {
    const dropped = held.length
    held = []
    return { dropped }
  }

  return {
    add,
    remove,
    answered,
    list,
    unanswered,
    clear,
    get size () { return held.length },
    get held () { return held.length > 0 },
    peek: () => held.map(entry => ({
      state: entry.state,
      name: entry.name,
      uuid: entry.uuid,
      answered: entry.answered,
      lastResult: entry.lastResult
    }))
  }
}

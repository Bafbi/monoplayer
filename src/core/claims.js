// #267: the claim. One attaching player's exclusive control of a body, held by
// the connection that made it and released when that connection ends
// (GLOSSARY.md). The picker records it where a client answers a body's own
// dialog, not at login, so two clients may read the picker at once and only the
// claim contends.
//
// Two rules, and they are the whole module:
//   1. a body holds one claim, and a second claim on it is refused with the claim
//      that holds it, so the client can be told who is driving it;
//   2. a connection holds one claim, so a client that already drives a body cannot
//      take a second one. That is the attach slot's exclusivity, moved: the claim
//      now decides who may drive a body, and the slot still decides who is
//      delivered one until #269 gives the claim a channel to deliver through.
//
// The holder is the id the front leg gives a connection, never the socket and
// never the player's UUID: two connections from one account are two holders.
// Nothing here reads a clock, logs, or touches a socket. The caller passes the
// moment it recorded, and writes the sentence a refusal gets.
export const CLAIM_REFUSAL = {
  // The body is claimed by another connection.
  TAKEN: 'body_claimed',
  // This connection already drives a body, so it cannot take a second.
  HELD: 'already_driving'
}

// A refusal, as one sentence a log and a client can both carry. It names the
// server the client asked for, and the part of the contention it hit. It says
// "claimed", never "driven": a claim is recorded, and no body is delivered to it
// until #269.
export function claimRefusalText ({ reason = null, server = null, holder = null, driving = null } = {}) {
  const named = server === null ? 'that server' : server
  switch (reason) {
    case CLAIM_REFUSAL.TAKEN:
      return 'Monoplayer: ' + named + ' is already claimed by ' + (holder ?? 'another player') +
        '. A body has one claim.'
    case CLAIM_REFUSAL.HELD:
      return 'Monoplayer: you already hold a claim on ' + (driving ?? 'another body') +
        '. Leave it before you claim ' + named + '.'
    default:
      return 'Monoplayer: ' + named + ' cannot be claimed.'
  }
}

function requiredString (value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(field + ' must be a non-empty string')
  }
  return value
}

// A claim as a caller sees it: its own field map, so a reader cannot write into
// the record the leg holds.
function claimView (record) {
  return {
    body: record.body,
    server: record.server,
    holder: record.holder,
    name: record.name,
    at: record.at
  }
}

export function createClaims () {
  const byBody = new Map() // body slug -> claim
  const byHolder = new Map() // holder id -> the one claim it holds

  // Take a claim on a body, or answer with the claim that refused it. Granted:
  // { ok: true, reason: null, repeated, claim }. Refused: { ok: false, reason,
  // claim }, where the claim is the one that stands in the way: the incumbent's
  // for TAKEN, this connection's own for HELD.
  function claim ({ body, server = null, holder, name = null, at = null } = {}) {
    requiredString(body, 'body')
    requiredString(holder, 'holder')

    const onBody = byBody.get(body)
    if (onBody !== undefined) {
      // The holder clicking again is one driver, not a second one.
      if (onBody.holder === holder) {
        return { ok: true, reason: null, repeated: true, claim: claimView(onBody) }
      }
      return { ok: false, reason: CLAIM_REFUSAL.TAKEN, claim: claimView(onBody) }
    }

    const holding = byHolder.get(holder)
    if (holding !== undefined) {
      return { ok: false, reason: CLAIM_REFUSAL.HELD, claim: claimView(holding) }
    }

    const record = { body, server, holder, name, at }
    byBody.set(body, record)
    byHolder.set(holder, record)
    return { ok: true, reason: null, repeated: false, claim: claimView(record) }
  }

  // The connection that made a claim ended, or the player left the body. One
  // holder releases the one claim it holds, and holding nothing releases nothing.
  function release (holder) {
    if (typeof holder !== 'string') return null
    const record = byHolder.get(holder)
    if (record === undefined) return null
    byHolder.delete(holder)
    byBody.delete(record.body)
    return claimView(record)
  }

  return {
    claim,
    release,
    claimOn: body => {
      const record = byBody.get(body)
      return record === undefined ? null : claimView(record)
    },
    claimOf: holder => {
      const record = byHolder.get(holder)
      return record === undefined ? null : claimView(record)
    },
    isClaimed: body => byBody.has(body),
    snapshot: () => [...byBody.values()].map(claimView),
    get size () { return byBody.size }
  }
}

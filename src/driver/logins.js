// Backend-login evidence parsing for the driver lane. kubectl logs from the backend
// pods (Paper / Vanilla / Fabric) are the server-side journal of who logged
// in and when. Pure text helpers here: no kube, no env, no network — the M4
// unit tests feed canned log text directly.
//
// Two independent backend line shapes are recognised (one per real join,
// printed by the backend itself):
//   [12:04:12 INFO]: GlowSquidye[/10.42.0.5:54321] logged in with entity id 1 at ([...])
//   [12:04:12 INFO]: GlowSquidye joined the game
// and the matching leave shape:
//   [12:04:12 INFO]: GlowSquidye left the game
//
// On the M4/M5 lane the "backendLogins=1" invariant is checked with these
// counts per phase, never averaged or carried across phases. A repeated
// "joined the game" line or a second "logged in with entity id" inside a
// no-fault phase is exactly the duplicate-login anomaly the gate exists to
// catch.

// A real backend console line looks like
//   [12:04:12 INFO]: <text>     (kubectl logs, single-source)
//   2026-11-06 12:04:12 [12:04:12 INFO]: <text>   (piped + bracked log formats)
function normalizeLines (text) {
  const source = Array.isArray(text) ? text : String(text ?? '').split(/\r?\n/)
  return source.map(line => line.replace(/^\S+\s\S+\s(?=\[)/, ''))
}

// Every tracked player name; null/empty means accept any name.
function trackedPlayers ({ players } = {}) {
  if (!players || players.length === 0) return null
  return new Set(players.map(name => name.toLowerCase()))
}

function extractName (line, markerSuffix, tracked) {
  const at = line.indexOf(markerSuffix)
  if (at < 0) return null
  const head = line.slice(0, at)
  // "<Name>[/x.x.x.x:port]" for the logged-in shape, plain "<Name>" elsewhere.
  const match = head.match(/([A-Za-z0-9_]{1,16})\s*(?:\[[^\]]*\])?\s*$/)
  if (!match) return null
  if (tracked && !tracked.has(match[1].toLowerCase())) return null
  return match[1]
}

// Join announcements can be logged raw (`GlowSquidye joined the game`) or
// marshalled (`{"text":"GlowSquidye joined the game"}`); both end the line
// with the phrase (up to closing quote/bracket), which distinguishes them
// from unrelated chatter like "joined the gamer clan".
function endsWithMarker (line, marker) {
  const tail = line.trimEnd().replace(/["\}]{1,2}\s*$/, '')
  return tail.endsWith(marker)
}

// Parse one log array into events: the stricter "logged in with entity id"
// server line plus the joined/left chat announcements. Order follows the log;
// each backend login normally produces one login line and one join line.
export function parseBackendLogins (text, { players = null } = {}) {
  const lines = normalizeLines(text)
  const tracked = trackedPlayers({ players })
  const events = []
  lines.forEach((line, index) => {
    if (line.includes(' logged in with entity id')) {
      const name = extractName(line, ' logged in with entity id', tracked)
      // A marker that survives in a marshalled component line still counts
      // (name stays null); a filter can only exclude when the name is known.
      if (name || !tracked) events.push({ kind: 'login', name, index, line })
    }
    if (endsWithMarker(line, ' joined the game')) {
      const name = extractName(line, ' joined the game', tracked)
      // Chat announcements require a name: a bare "joined the game" is noise.
      if (name) events.push({ kind: 'joined', name, index, line })
    }
    if (endsWithMarker(line, ' left the game')) {
      const name = extractName(line, ' left the game', tracked)
      if (name) events.push({ kind: 'left', name, index, line })
    }
  })
  return { events, linesCount: lines.length }
}

// Count backend logins per phase. `phases` is [{ id, from, to }] over the line
// indexes of the same log text; `to` defaults to the end of the log, `from`
// defaults to 0. Events land in every inclusive [from, to] span that contains
// their line index.
export function loginsPerPhase (text, phases, { players = null } = {}) {
  const { events } = parseBackendLogins(text, { players })
  return {
    events,
    phases: (phases ?? []).map(phase => {
      const from = phase.from ?? 0
      const to = phase.to ?? Number.POSITIVE_INFINITY
      const inside = events.filter(event => event.index >= from && event.index <= to)
      return {
        id: phase.id,
        logins: inside.filter(event => event.kind === 'login').length,
        joins: inside.filter(event => event.kind === 'joined').length,
        leaves: inside.filter(event => event.kind === 'left').length,
      }
    }),
  }
}

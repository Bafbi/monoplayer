// The live region: everything on a puppet's card that can change, rendered as one
// HTML fragment.
//
// This function is the page's only answer to "what is it doing". GET / renders it
// inside the card, and GET /api/puppets/<name>/stream writes it again every tick,
// so a number on the first page and a number five seconds later come from the same
// place. The stream swaps the innerHTML of the element that holds this fragment,
// which is why the forms live outside it: a tick must not overwrite a half-typed
// move.
//
// Every number sits under the timestamp of the record it came from, and a record
// older than three heartbeats is its own state so it is never coloured as live
// (#231).
//
// #248 split the one renderer in src/panel/page.js into these views, and made this
// function the fragment the stream writes: the first render and every tick after it
// are the same code, so a number on the page and a number five seconds later cannot
// disagree.
import {
  bytes, count, dayWord, entryTally, env, escape, group, heading, list, present, row,
  sourced, span, uuidDecision, yesno
} from './html.js'
import { renderStage } from './stage.js'

// The whitelist read of this instant, as one clause of the card's footer. A
// resourceVersion orders writes. It is not a clock, and a reader who took it for one
// would date the list from a number that means nothing outside the API server.
function whitelistRead (attach) {
  if (attach === null || attach === undefined) return ''
  if (present(attach.failure)) return ', and the attach whitelist could not be read'
  if (!present(attach.observedAt)) return ''
  const version = present(attach.resourceVersion)
    ? ' at ConfigMap resourceVersion ' + attach.resourceVersion + ' (a version, not a time)'
    : ', and the ConfigMap named no resourceVersion'
  return ', and the attach whitelist read at ' + attach.observedAt + version
}

// The allowed servers' read of this instant, as the second clause of the footer. Same
// shape and same reason as the whitelist's: a version orders writes and is not a clock.
function allowedRead (allowed) {
  if (allowed === null || allowed === undefined) return ''
  if (present(allowed.failure)) return ', and the allowed servers could not be read'
  if (!present(allowed.observedAt)) return ''
  const version = present(allowed.resourceVersion)
    ? ' at ConfigMap resourceVersion ' + allowed.resourceVersion + ' (a version, not a time)'
    : ', and the ConfigMap named no resourceVersion'
  return ', and the allowed servers read at ' + allowed.observedAt + version
}

// A duration, in the unit a reader compares to the heartbeat interval: seconds under
// a minute, minutes under an hour, and then the units the cap rows use. A claim held
// for 45000 ms is "45 s", not a number of milliseconds to divide in the head.
function duration (ms) {
  if (!present(ms)) return null
  // The unit is chosen from the rounded count, so 59 500 ms reads "1 min" and not
  // "60 s": a unit that has just overflowed is the next unit's zero.
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + ' s'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return minutes + ' min'
  const hours = Math.round((ms / 3_600_000) * 10) / 10
  if (hours < 24) return hours + (hours === 1 ? ' hour' : ' hours')
  const days = Math.round((ms / 86_400_000) * 10) / 10
  return days + ' ' + dayWord(days)
}

// One group the heartbeat carries as a list of records (#419). Null is a record that
// does not carry it at all, which is a lane older than the groups, and the page then
// says nothing: not a heading with nothing under it, and not a zero. An empty list is
// a lane that holds none, which is a fact and gets its own sentence. `rowsFor` draws
// the group when there is something to draw.
function renderRows (rows, title, empty, rowsFor) {
  if (rows === null || rows === undefined) return []
  if (rows.length === 0) return [group(title, [row('none', empty)])]
  return rowsFor(rows)
}

// The per-body group #415 added to the heartbeat. One row set per body, so a lane
// that holds several names which one a number belongs to. A body nobody claimed says
// so rather than printing a claim age of zero, because absent is the fact and zero
// would read as a claim held for no time (#263 D2).
function renderBodies (bodies) {
  return bodies.map(body => group('Body ' + (body.body ?? 'with no slug'), [
    row('active', yesno(body.active)),
    row('warm', yesno(body.warm)),
    row('frames', count(body.frames)),
    row('chunk bytes', bytes(body.chunkBytes)),
    row('frames cached', count(body.framesCached)),
    row('frames dropped', count(body.framesDropped)),
    row('claim held', duration(body.claimMs) ?? 'no claim stands')
  ]))
}

// The per-channel group. `claim held` is the claim on the channel's body and
// `spectator channels` is the audience of that body, which is what the doc's two rows
// say. A spectator holds no claim, so its row says that in words. A connection the
// lane admitted with no claim names no body, and the row says which case that is.
function renderChannels (channels) {
  return channels.map(channel => group('Channel ' + (channel.channel ?? 'with no id'), [
    row('body', present(channel.body) ? channel.body : 'no claim: the lane admitted this connection itself'),
    // `role` is always written (docs/telemetry.md), so a null here is a record the
    // page cannot explain, and it says that rather than printing no line at all.
    row('role', channel.role ?? 'the record carries no role'),
    row('open for', duration(channel.ageMs) ?? 'the front stamped no open'),
    row('frames', count(channel.frames)),
    row('play frames', count(channel.play)),
    row('configuration frames', count(channel.configuration)),
    row('bytes', bytes(channel.bytes)),
    row('replays', count(channel.replays)),
    row('spectator channels', count(channel.spectators)),
    // The doc says a spectator's row is the only one with no claim age, so a driver's
    // row without one says that about the record and not about the lane.
    row('claim held', duration(channel.claimMs) ??
      (channel.role === 'spectator' ? 'a spectator holds no claim' : 'the record carries no claim age'))
  ]))
}

// The words the front group's rows are drawn under, where a field's own name is not
// one a reader reads: "pre-auth refused" is not `preAuthRefused`, and the sessionserver
// refusal is the one refusal the page must name by the hand that made it (#743).
//
// A field with no entry here is still drawn, under its own name spaced out. That is
// what makes this a lookup and not a whitelist: a lookup that falls back costs a
// reader words, and a field list that filters costs a number, which is the defect
// #743 was filed for. So only the words the fallback cannot get right are here: where
// the hyphen goes, and which hand refused the login.
const FRONT_LABELS = {
  preAuthRefused: 'pre-auth refused',
  preAuthExpired: 'pre-auth expired',
  preAuthInWindow: 'pre-auth in window',
  sessionVerificationRefused: 'sessionserver refused the login'
}

// camelCase as words: `pickerPicks` reads "picker picks". No rule can put the hyphen
// in "pre-auth", which is why the words a reader must read exactly are in the lookup
// above and this is only the fallback.
const spaced = name => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase()

const frontLabel = name => FRONT_LABELS[name] ?? spaced(name)

// The words the core's counters are drawn under, under the same rule: only the ones
// the fallback gets wrong. The core counts a client the proxy kicked, and "front kicks"
// read as though the front were the thing kicked; it counts ghost states answered, and
// "notice ghosts" read as notices that do not exist. Every other core counter reads as
// its own name spaced out, which is why this lookup has two entries and no more.
const CORE_LABELS = {
  frontKicks: 'clients kicked',
  noticeGhosts: 'ghost states answered'
}

const coreLabel = name => CORE_LABELS[name] ?? spaced(name)

// One counter group, whole and in the record's own order (#743, #833). The order is
// the declaration's and the page has no second opinion about it, so a counter the
// writer adds lands where it put it.
//
// A counter the group holds as a map of counts — the picker's refusals by reason
// (#417), the relay's frames by name (#833) — is one row per key under a heading of
// its own, because the keys are what the operator is reading for. The keys are drawn
// as the writer wrote them: a reason and a packet name are machine's words and not
// ones this file improves.
//
// The two groups this draws are the leg's and the core's, and neither is a field list:
// the projection kept every counter the record carried, so this draws every one of them.
// The two differ in nothing but the title they are drawn under and the words their rows
// use.
function renderCounters (counters, title, label) {
  if (counters === null || counters === undefined) return []
  const rows = []
  const maps = []
  for (const [name, value] of Object.entries(counters)) {
    if (value !== null && typeof value === 'object') {
      // A keyed group is named by the record's own word for it, and each key is a row.
      maps.push(group(label(name), Object.entries(value).map(([key, entry]) => row(key, count(entry)))))
      continue
    }
    rows.push(row(label(name), count(value)))
  }
  // group() answers '' for a group with no rows, and '' is what the caller joins.
  return [group(title, rows), ...maps]
}

function renderHeartbeat (facts) {
  const heartbeat = facts.heartbeat
  if (heartbeat === null) return ''
  const age = heartbeat.ageSeconds === null ? null : heartbeat.ageSeconds + ' s before this read'
  const lines = [heading('Heartbeat', heartbeat.at, age)]

  lines.push(group('Session', [
    row('attached', yesno(heartbeat.attached)),
    row('warm', yesno(heartbeat.warm)),
    row('backend logins', count(heartbeat.backendLogins))
  ]))

  lines.push(...renderCounters(heartbeat.front, 'Front', frontLabel))
  // #833: the core's counters, beside the front leg's and not under them. They answer
  // the other half of the same question: what this process has done since it started.
  // Before this line the card drew none of them.
  lines.push(...renderCounters(heartbeat.metrics, 'Core', coreLabel))

  const sizes = heartbeat.sizes ?? {}
  const domains = Object.keys(sizes)
    .filter(key => count(sizes[key]) !== null)
    .map(key => key + ' ' + sizes[key])
    .join(', ')
  lines.push(group('Cache', [
    row('domains', domains === '' ? null : domains),
    row('chunk bytes', bytes(heartbeat.chunkBytes))
  ]))

  lines.push(...renderRows(heartbeat.bodies, 'Bodies', 'the process holds no cache for a body', renderBodies))
  lines.push(...renderRows(heartbeat.channels, 'Channels', 'the front holds no channel open', renderChannels))

  const journal = heartbeat.journal ?? {}
  const caps = facts.caps ?? {}
  const capsRows = [
    row('shard cap', env(bytes(caps.journalMaxBytes))),
    row('directory cap', env(bytes(caps.journalMaxTotalBytes))),
    row('age cap', env(span(caps.journalMaxAgeMs)))
  ]
  if (capsRows.every(line => line === '')) {
    capsRows.push(row('caps', 'not in the Deployment env; the compiled defaults apply and the panel cannot see them'))
  }
  lines.push(group('Journal', [
    row('enabled', yesno(journal.enabled)),
    row('disabled', journal.disabledReason),
    row('bytes written', bytes(journal.bytes)),
    row('seals', count(journal.sealed)),
    row('pruned', count(journal.pruned)),
    row('pruned bytes', bytes(journal.prunedBytes)),
    row('directory bytes', bytes(journal.dirBytes)),
    // Present only on a journal that a full volume stopped before it wrote: the
    // bytes free and the budget it needed.
    row('free bytes when it stopped', bytes(journal.freeBytes)),
    row('required bytes', bytes(journal.requiredBytes)),
    row('shard', journal.file),
    ...capsRows
  ]))

  const wire = heartbeat.wire ?? {}
  lines.push(group('Wire', [
    row('checked', count(wire.checked)),
    row('rejected', count(wire.rejected))
  ]))

  const telemetry = heartbeat.telemetry ?? {}
  lines.push(group('Telemetry', [
    row('enabled', yesno(telemetry.enabled)),
    // The documented oddity: this is the number of distinct series, not a queue.
    row('queued series', count(telemetry.queuedSeries)),
    row('queued log records', count(telemetry.queuedLogRecords)),
    row('dropped log records', count(telemetry.droppedLogs)),
    row('dropped metric points', count(telemetry.droppedMetrics)),
    row('failed exports', count(telemetry.failures)),
    row('last error', telemetry.lastError)
  ]))

  const account = heartbeat.account ?? {}
  const expiry = account.expiresAt === null || account.expiresAt === undefined
    ? 'unknown (the custody cache does not say)'
    : account.expiresAtDate + (count(account.expiresInDays) === null
        ? ''
        : account.expired === true
          ? ' (expired ' + Math.abs(account.expiresInDays) + ' ' + dayWord(account.expiresInDays) + ' ago)'
          : ' (in ' + account.expiresInDays + ' ' + dayWord(account.expiresInDays) + ')')
  lines.push(group('Account', [
    row('alias', account.alias),
    row('token expires', expiry)
  ]))
  if (present(account.warning)) {
    lines.push('    <p class="warn">' + escape(account.warning) + '</p>\n')
  }
  return lines.join('')
}

// The count and the fault that follows it, from the same list (#677, #748). A list of
// three where one entry admits nobody must not read as healthy: one bad row of three is
// easy to read past. A list whose answers could not be read carries no ratio, because
// unknown is not a fault.
function whitelistTally (whitelist) {
  const usable = Array.isArray(whitelist.entries)
    ? whitelist.entries.filter(entry => !present(entry.refusalReason)).length
    : null
  return entryTally(whitelist.count, usable)
}

// The entries the count counted (#748): one row each, under the uuid the lane started
// with and the UUID decision the same read wrote (#705). The answer travels with its
// entry, so the two lists cannot fall out of step by position, and this file judges
// nothing: the lane asked `uuidRefusalReason` once, when it wrote the record, and
// src/custody/util.js stays that rule's one home (#703).
//
// A row per entry, not a disclosure: the stream replaces this region's innerHTML every
// 5 s, so anything the operator opens here closes under their hand. A lane with twenty
// entries gets twenty rows, which is a list the card can carry and a number is not.
function renderWhitelistEntries (whitelist) {
  if (whitelist === null || !Array.isArray(whitelist.entries) || whitelist.entries.length === 0) return ''
  return group('Whitelist entries at start', whitelist.entries.map(entry => row(
    present(entry.uuid) ? entry.uuid : 'no uuid recorded',
    uuidDecision(entry.refusalReason)
  )))
}

function renderStart (facts) {
  const start = facts.start ?? {}
  const control = start.control ?? {}
  const whitelist = facts.whitelist
  const dial = facts.backend.lastDial
  const lines = [heading('Start', start.at ?? null)]

  // The whitelist as the lane started with it: the count, the entries under it, and the
  // timestamp of the read they came from. #229 re-reads the whitelist at each login, so
  // an edit after start is invisible here, and both the label and the timestamp say so.
  // A record that names no entry says where the per-entry answer is instead.
  const whitelistText = whitelist === null
    ? 'unknown, and no start record is in the tail'
    : whitelistTally(whitelist) + ' (' + whitelist.source +
      (present(whitelist.at) ? ', ' + whitelist.at : '') + ')' +
      (Array.isArray(whitelist.entries)
        ? ''
        : '; the record carries no per-entry answer, and the attach whitelist block below answers for the file as it stands') +
      (control.whitelistReload === true ? '; re-read at each login' : '')

  lines.push(group('Puppet', [
    row('version', start.version),
    row('front listening', start.front),
    row('serving on', sourced(facts.backend.effective) ?? 'unknown: no start record and no successful reconnect in the tail'),
    row('last dial', dial === null
      ? null
      : dial.value + ' (' + (dial.connected ? 'connected' : 'failed') + ', ' + (present(dial.at) ? dial.at : 'no timestamp') + ')'),
    row('configured backend', sourced(facts.backend.configured) ?? 'unknown, and no start record is in the tail'),
    row('registry backend', sourced(facts.backend.registry)),
    row('attach whitelist at start', whitelistText),
    row('whitelist reload', yesno(control.whitelistReload))
  ]))
  lines.push(renderWhitelistEntries(whitelist))
  return lines.join('')
}

function renderPreAuth (facts) {
  const preAuth = facts.preAuth ?? {}
  const caps = facts.caps ?? {}
  // The line the window writes is the observation; the Deployment's env is the
  // configuration. Both are shown, and each says which it is, because a healthy
  // lane never writes the line.
  const connections = present(preAuth.maxConnections)
    ? preAuth.maxConnections + ' (last refused connection, ' + (present(preAuth.maxConnectionsAt) ? preAuth.maxConnectionsAt : 'no timestamp') + ')'
    : env(caps.preAuthMaxConnections)
  const deadline = present(preAuth.deadlineMs)
    ? preAuth.deadlineMs + ' ms (last expired connection, ' + (present(preAuth.deadlineMsAt) ? preAuth.deadlineMsAt : 'no timestamp') + ')'
    : env(caps.preAuthDeadlineMs === null || caps.preAuthDeadlineMs === undefined ? null : caps.preAuthDeadlineMs + ' ms')
  const lines = [heading('Pre-auth window', null)]
  lines.push(group('Caps', [
    row('connections', connections ?? 'unknown: no refusal line in the tail, and the Deployment does not set it'),
    row('deadline', deadline ?? 'unknown: no expiry line in the tail, and the Deployment does not set it')
  ]))
  return lines.join('')
}

function renderAttach (attach) {
  if (attach === null) return ''
  const domains = attach.domains === null
    ? null
    : Object.keys(attach.domains).map(key => key + ' ' + attach.domains[key]).join(', ')
  // #834: the counts the attach stream carries beside its delivery numbers, read off the
  // record's own groups. #213's defect is measured on the first of them, and a count of
  // bodies without a spawn with no count of bodies beside it is a fault of unknown size,
  // which is why the pair is one row set. A group the record does not carry is null, and
  // the row set then draws no heading rather than a row of zeros: a lane older than #218
  // writes neither of the next two.
  const entities = attach.entities
  const lines = [heading('Last attach', attach.at)]
  lines.push(group('Attach', [
    row('player', attach.name),
    row('reason', attach.reason),
    row('took', count(attach.tookMs) === null ? null : attach.tookMs + ' ms'),
    row('replayed', count(attach.replayed)),
    // #735: the other half of the delivery #717 split out, under the record's own word for
    // it. A replay count with no second number reads as a total, which is the half-fact
    // this row ends. A refusal is not a fault, so the row names the gap and never asks for
    // a repair (docs/adr/a-refused-replay-frame-is-not-retried.md).
    //
    // The row claims no delivery. The number mixes a frame the leg answered false with one
    // whose write threw, and a throw may have reached an earlier channel
    // (docs/telemetry.md).
    //
    // A record written before the field existed counted a refused frame as a replay, so it
    // says which half it cannot answer rather than printing a zero it never measured.
    row('refused', count(attach.refused) === null
      ? (count(attach.replayed) === null
          ? null
          : 'unknown: the record carries no refusal count, so a frame the leg refused is not separated from the ones it wrote')
      : attach.refused + (attach.refused === 0
          ? ''
          : ' (a frame the front leg refused or threw on, and the attach stream is written once, so the client keeps the gap until it attaches again)')),
    // #834: the third number of the delivery. `replayed` never counts the position the
    // replay invents and `refused` counts one the leg refused, so without this row the two
    // numbers above cannot be placed against each other. The label carries "join" because
    // the Core group draws the process's cumulative `positionsSynthesized` under the words
    // this row would otherwise repeat, and one card is one vocabulary.
    row('join positions synthesized', count(attach.synthesizedPositions)),
    row('domains', domains)
  ]))
  lines.push(group('Entities', [
    row('bodies given a spawn', count(entities?.replayed)),
    row('bodies without a spawn', count(entities?.withoutSpawn) === null
      ? null
      : entities.withoutSpawn + (entities.withoutSpawn === 0 ? '' : ' (a client was told about a body it never saw appear)'))
  ]))
  // #218's shape is the pair: the tab list this client is handed, and the bodies the stream
  // gave one of its players. A listed player the stream gave no body is a player the client
  // cannot see, which is the question the attach record exists to answer.
  lines.push(group('Players', [
    row('players listed', count(attach.players?.info)),
    row('listed players with a body', count(attach.players?.bodies))
  ]))
  // What the two holders offered beside the stream. A dialog holder keeps one dialog at a
  // time, so its pair is 0 or 1, and a pack the holder kept is written to a client that
  // arrived later.
  lines.push(group('Held and resent', [
    row('dialogs held', count(attach.dialogs?.held)),
    row('dialogs resent', count(attach.dialogs?.resent)),
    row('packs held', count(attach.packs?.held)),
    row('packs resent', count(attach.packs?.resent))
  ]))
  return lines.join('')
}

// The pod's rows under the group heading, not under a second heading with the same
// word in it: "Pod" twice in a row was a wart the first render carried, and a page
// that is the operator's only view of the lane should not repeat itself.
function renderPod (facts) {
  const pod = facts.pod
  const lines = [heading('Pod', null)]
  lines.push(list([
    row('name', pod === null ? null : pod.name),
    row('phase', pod === null ? null : pod.phase),
    row('ready', pod === null ? null : yesno(pod.ready)),
    row('started', pod === null ? null : (pod.startedAt ?? 'unknown') + (count(pod.ageSeconds) === null ? '' : ' (' + pod.ageSeconds + ' s ago)')),
    row('restarts', pod === null ? null : count(pod.restarts))
  ]))
  return lines.join('')
}

// The state sentence, in words, with the chip beside it. The chip is the colour
// the scene's top face uses; the sentence is what a reader acts on.
function renderState (facts) {
  return '  <p class="state-line"><span class="state ' + escape(facts.state.state) + '">' +
    escape(facts.state.state) + '</span> <span class="reason">' + escape(facts.state.reason) + '</span></p>\n'
}

// One puppet's live region. No closing wrapper: the caller owns the element whose
// innerHTML this becomes, because the same markup is the server's first render and
// the stream's every later one.
//
// `attach` is the attach whitelist read of this same instant, and `allowed` is the
// allowed servers', and the footer names both beside the log read. They are here and
// not in the lists, because a list is only redrawn when it changes: a time printed
// there would be the time of the last change, which a reader would take for the time of
// the read (#248, #309).
export function renderLive (facts, attach = null, allowed = null) {
  return [
    renderStage(facts),
    renderState(facts),
    renderHeartbeat(facts),
    renderStart(facts),
    renderPreAuth(facts),
    renderAttach(facts.attach),
    renderPod(facts),
    '  <p class="read">read at ' + escape(facts.observedAt) +
      (facts.tail === null
        ? ', and no log was read'
        // Escaped like every other value on the page. These are numbers today, and
        // a fixture can hand in anything, which is the case this covers.
        : ' from ' + escape(facts.tail.lines) + ' log lines (' + escape(facts.tail.heartbeats) + ' heartbeats' +
          (facts.tail.unreadable === 0 ? '' : ', ' + escape(facts.tail.unreadable) + ' unreadable') + ')') +
      whitelistRead(attach) + allowedRead(allowed) + '</p>',
    ''
  ].join('\n')
}

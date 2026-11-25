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
  bytes, count, dayWord, env, escape, group, heading, list, present, row, sourced, span, yesno
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

  const front = heartbeat.front ?? {}
  lines.push(group('Front', [
    row('allowed', count(front.allowed)),
    row('attaches', count(front.attaches)),
    row('denied', count(front.denied)),
    row('pre-auth refused', count(front.preAuthRefused)),
    row('pre-auth expired', count(front.preAuthExpired)),
    row('pre-auth in window', count(front.preAuthInWindow)),
    row('policy refused', count(front.policyRefused)),
    row('state refused', count(front.stateRefused))
  ]))

  const sizes = heartbeat.sizes ?? {}
  const domains = Object.keys(sizes)
    .filter(key => count(sizes[key]) !== null)
    .map(key => key + ' ' + sizes[key])
    .join(', ')
  lines.push(group('Cache', [
    row('domains', domains === '' ? null : domains),
    row('chunk bytes', bytes(heartbeat.chunkBytes))
  ]))

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

function renderStart (facts) {
  const start = facts.start ?? {}
  const control = start.control ?? {}
  const whitelist = facts.whitelist
  const dial = facts.backend.lastDial
  const lines = [heading('Start', start.at ?? null)]

  // The whitelist count is the one the lane resolved at startup. #229 re-reads the
  // whitelist at each login, so an edit after start is invisible here, and both
  // the label and the timestamp say so.
  const whitelistText = whitelist === null
    ? 'unknown, and no start record is in the tail'
    : whitelist.count + (whitelist.count === 1 ? ' entry' : ' entries') + ' (' + whitelist.source +
      (present(whitelist.at) ? ', ' + whitelist.at : '') + ')' +
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
  const lines = [heading('Last attach', attach.at)]
  lines.push(group('Attach', [
    row('player', attach.name),
    row('reason', attach.reason),
    row('took', count(attach.tookMs) === null ? null : attach.tookMs + ' ms'),
    row('replayed', count(attach.replayed)),
    row('domains', domains),
    // Non-zero is #213's defect, measured, so it is named as such rather than
    // left as a number a reader has to interpret.
    row('bodies without a spawn', count(attach.withoutSpawn) === null
      ? null
      : attach.withoutSpawn + (attach.withoutSpawn === 0 ? '' : ' (a client was told about a body it never saw appear)'))
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

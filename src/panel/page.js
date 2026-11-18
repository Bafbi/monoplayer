// The panel's page: one document, one inline stylesheet, and one card per puppet.
//
// Every number sits under the `t` of the record it came from, and a record older
// than three heartbeats is its own state so it is never coloured as live. The page
// loads no asset the browser has to fetch: the tailnet Service is the only thing
// answering on that name, so a stylesheet or a script would be a request that
// fails. It is read on a phone, which is why the row grid is one column below
// 30 rem and two above it.

const escape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const present = value => value !== null && value !== undefined && value !== ''
const yesno = value => (value === true ? 'yes' : value === false ? 'no' : null)
const dayWord = days => (Math.abs(days) === 1 ? 'day' : 'days')
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// A value that came with a record says which record and when. A cap read from the
// Deployment says so too, because the Deployment has no timestamp and the reader
// needs to know that.
function sourced (fact) {
  if (fact === null || fact === undefined) return null
  const where = present(fact.at) ? fact.source + ', ' + fact.at : fact.source
  return fact.value + ' (' + where + ')'
}

function bytes (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return unit === 0 ? value + ' B' : value + ' (' + (Math.round(size * 10) / 10) + ' ' + units[unit] + ')'
}

// The Deployment env is a value nobody rewrote at a known instant, so it carries
// the source and no timestamp.
const env = value => (present(value) ? value + ' (Deployment env, no timestamp)' : null)

// A millisecond cap in the unit an operator reads it in.
function span (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value >= 86_400_000) return value + ' ms (' + Math.round((value / 86_400_000) * 10) / 10 + ' days)'
  if (value >= 3_600_000) return value + ' ms (' + Math.round((value / 3_600_000) * 10) / 10 + ' hours)'
  return value + ' ms'
}

function row (label, value) {
  if (!present(value)) return ''
  return '      <div><dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd></div>\n'
}

function list (rows) {
  const body = rows.filter(line => line !== '').join('')
  return body === '' ? '' : '    <dl>\n' + body + '    </dl>\n'
}

function group (title, rows) {
  const body = list(rows)
  return body === '' ? '' : '    <h4>' + escape(title) + '</h4>\n' + body
}

function heading (title, at, note = null) {
  return '    <h3>' + escape(title) +
    (present(at) ? ' <time>' + escape(at) + '</time>' : '') +
    (present(note) ? ' <span class="note">' + escape(note) + '</span>' : '') +
    '</h3>\n'
}

function renderHeartbeat (facts) {
  const heartbeat = facts.heartbeat
  if (heartbeat === null) return ''
  const age = heartbeat.ageSeconds === null ? null : heartbeat.ageSeconds + ' s before this page'
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
    row('control file', control.file),
    row('backend switch', yesno(control.allowBackendSwitch)),
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

function renderPod (facts) {
  const pod = facts.pod
  const lines = [heading('Pod', null)]
  lines.push(group('Pod', [
    row('name', pod === null ? null : pod.name),
    row('phase', pod === null ? null : pod.phase),
    row('ready', pod === null ? null : yesno(pod.ready)),
    row('started', pod === null ? null : (pod.startedAt ?? 'unknown') + (count(pod.ageSeconds) === null ? '' : ' (' + pod.ageSeconds + ' s ago)')),
    row('restarts', pod === null ? null : count(pod.restarts))
  ]))
  return lines.join('')
}

function renderCard (facts) {
  const lines = []
  lines.push('<article class="puppet">\n')
  lines.push('  <h2>' + escape(facts.name) + ' <span class="state ' + escape(facts.state.state) + '">' +
    escape(facts.state.state) + '</span></h2>\n')
  lines.push('  <p class="reason">' + escape(facts.state.reason) + '</p>\n')
  lines.push(heading('Registry', null, 'this panel\'s own document, no timestamp'))
  lines.push(list([
    row('namespace', facts.namespace),
    row('deployment', facts.deployment),
    row('front', facts.frontHostname),
    row('control ConfigMap', facts.controlConfigMap)
  ]))
  lines.push(renderHeartbeat(facts))
  lines.push(renderStart(facts))
  lines.push(renderPreAuth(facts))
  lines.push(renderAttach(facts.attach))
  lines.push(renderPod(facts))
  lines.push('  <p class="read">read at ' + escape(facts.observedAt) +
    (facts.tail === null
      ? ', and no log was read'
      : ' from ' + facts.tail.lines + ' log lines (' + facts.tail.heartbeats + ' heartbeats' +
        (facts.tail.unreadable === 0 ? '' : ', ' + facts.tail.unreadable + ' unreadable') + ')') + '</p>\n')
  lines.push('</article>')
  return lines.join('')
}

// One page, no asset the browser has to fetch, and one column on a phone.
export function renderPage ({ version, puppets }, activities) {
  const byName = new Map(activities.map(facts => [facts.name, facts]))
  const cards = puppets.map(puppet => {
    const facts = byName.get(puppet.name)
    return facts === undefined ? '' : renderCard(facts)
  }).filter(card => card !== '')
  const total = puppets.length === 1 ? '1 puppet' : puppets.length + ' puppets'
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Monoplayer panel</title>',
    '  <style>',
    '    :root { color-scheme: light dark; --muted: 0.7 }',
    '    body { margin: 1rem auto; max-width: 46rem; padding: 0 0.75rem;',
    '      font: 16px/1.5 system-ui, sans-serif }',
    '    h1 { font-size: 1.4rem; margin-bottom: 0.25rem }',
    '    p.count { margin-top: 0; opacity: var(--muted); font-size: 0.9rem }',
    '    article { border: 1px solid; border-color: color-mix(in srgb, currentColor 25%, transparent);',
    '      border-radius: 0.5rem; padding: 0.75rem 0.9rem; margin: 1rem 0 }',
    '    article h2 { margin: 0; font-size: 1.2rem }',
    '    .state { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;',
    '      border: 1px solid; border-radius: 999px; padding: 0.05rem 0.45rem; vertical-align: 0.15rem }',
    '    .state.serving { color: #15803d }',
    '    .state:not(.serving) { color: #b45309 }',
    '    p.reason { margin: 0.4rem 0 0; font-size: 0.95rem }',
    '    h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: var(--muted);',
    '      margin: 1.1rem 0 0.3rem }',
    '    h3 time, h3 .note { text-transform: none; letter-spacing: 0; font-family: ui-monospace, monospace;',
    '      font-size: 0.8rem }',
    '    h4 { font-size: 0.8rem; margin: 0.6rem 0 0.2rem }',
    '    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.1rem 0.75rem; margin: 0 }',
    '    dt { opacity: var(--muted) }',
    '    dd { margin: 0; font-family: ui-monospace, monospace; overflow-wrap: anywhere }',
    '    p.warn, p.read { border-left: 3px solid currentColor; padding-left: 0.5rem; font-size: 0.9rem }',
    '    p.read { border-left-color: transparent; opacity: var(--muted) }',
    '    @media (max-width: 30rem) {',
    '      dl { grid-template-columns: 1fr; gap: 0 0 }',
    '      dt { margin-top: 0.4rem; font-size: 0.85rem }',
    '    }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>Monoplayer panel</h1>',
    '  <p class="count">' + escape(total) + ' in the registry (document version ' + escape(version) +
      '). Each number carries the timestamp of the log line it came from; nothing is rendered as "now".</p>',
    cards.join('\n'),
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

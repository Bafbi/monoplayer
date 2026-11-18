// The puppet screens: GET / for a human, GET /api/puppets/<name> for an agent.
//
// Both read the same facts, through the same function, so a number on the page and
// a number in the JSON cannot disagree. The facts come from src/panel/activity.js,
// which never touches a socket; this module does the three reads, hands them over,
// and writes what comes back.
//
// The page is one document with one inline stylesheet and no asset the browser
// fetches: the tailnet Service is the only thing answering on that name, so a
// stylesheet or a script would be a request that fails. It is read on a phone,
// which is why the row grid is one column on a narrow screen and two above it.
//
// Every number sits under the `t` of the record it came from, and a record that is
// older than three heartbeats says so in words. A stale heartbeat rendered as live
// is the failure this page exists to prevent.
import { activity } from '../activity.js'
import { labelSelector } from '../kube.js'

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

// The pod to read, out of the pods the Deployment's selector matched: a ready one
// first, then the newest. A Deployment with two replicas during a rollout has one
// pod worth showing, and showing the one that is serving is the choice an operator
// would make.
export function choosePod (items) {
  const pods = Array.isArray(items) ? items.filter(pod => typeof pod?.metadata?.name === 'string') : []
  if (pods.length === 0) return null
  const ready = pod => (Array.isArray(pod.status?.conditions) &&
    pod.status.conditions.some(condition => condition?.type === 'Ready' && condition.status === 'True') ? 1 : 0)
  const created = pod => Date.parse(pod.metadata?.creationTimestamp ?? '') || 0
  return pods.slice().sort((left, right) => (ready(right) - ready(left)) || (created(right) - created(left)))[0]
}

// One puppet's facts: its Deployment, its pods, and the log of the pod that is
// serving. A read that fails becomes a fact about the read, not an exception, so
// the card can say which one failed.
export async function readPuppet ({ kubernetes, puppet, now = Date.now(), log = () => {} }) {
  if (kubernetes === null || kubernetes === undefined) {
    return activity({ puppet, failure: new Error('the panel was started without a Kubernetes client'), now })
  }
  let pods
  try {
    const deployment = await kubernetes.deployment(puppet.namespace, puppet.deployment)
    const selector = labelSelector(deployment)
    if (selector === null) {
      throw new Error('Deployment ' + puppet.namespace + '/' + puppet.deployment + ' has no spec.selector.matchLabels')
    }
    pods = await kubernetes.pods(puppet.namespace, selector)
  } catch (error) {
    log('puppetReadFailed', { puppet: puppet.name, reason: String(error?.message ?? error) })
    return activity({ puppet, failure: error, now })
  }

  const pod = choosePod(pods?.items)
  if (pod === null) return activity({ puppet, pod: null, now })
  try {
    const text = await kubernetes.podLog(puppet.namespace, pod.metadata.name)
    return activity({ puppet, pod, log: { text }, now })
  } catch (error) {
    log('puppetReadFailed', { puppet: puppet.name, pod: pod.metadata.name, reason: String(error?.message ?? error) })
    return activity({ puppet, pod, log: { error }, now })
  }
}

// `read` is the panel's registry thunk, wrapped: it returns the document or the
// reason it could not be read, so a broken registry is the same 500 here as on
// /api/puppets. `send` is the panel's one response writer, injected so this module
// cannot disagree with the rest of the surface about headers.
export function createInfoRoutes ({ read, kubernetes = null, log = () => {}, send, now = () => Date.now() } = {}) {
  if (typeof read !== 'function') throw new TypeError('createInfoRoutes: read must be a function returning the registry or its failure')
  if (typeof send !== 'function') throw new TypeError('createInfoRoutes: send must be the panel response writer')

  return async function route (req, res) {
    try {
      const path = (req.url ?? '/').split('?')[0]

      if (path === '/') {
        const { document, failure } = read()
        if (failure) {
          send(res, 500, TEXT, failure + '\n')
          return true
        }
        const at = now()
        const activities = await Promise.all(
          document.puppets.map(puppet => readPuppet({ kubernetes, puppet, now: at, log }))
        )
        send(res, 200, HTML, renderPage(document, activities))
        return true
      }

      const match = /^\/api\/puppets\/([^/]+)$/.exec(path)
      if (match === null) return false

      let name
      try {
        name = decodeURIComponent(match[1])
      } catch {
        send(res, 404, TEXT, 'no such puppet\n')
        return true
      }
      const { document, failure } = read()
      if (failure) {
        send(res, 500, TEXT, failure + '\n')
        return true
      }
      const puppet = document.puppets.find(entry => entry.name === name)
      if (puppet === undefined) {
        send(res, 404, TEXT, 'no such puppet: ' + name + '\n')
        return true
      }
      const facts = await readPuppet({ kubernetes, puppet, now: now(), log })
      send(res, 200, JSON_TYPE, JSON.stringify(facts, null, 2) + '\n')
      return true
    } catch (error) {
      const reason = String(error?.message ?? error)
      log('infoRouteFailed', { route: req.url ?? null, reason })
      send(res, 500, TEXT, reason + '\n')
      return true
    }
  }
}

const escape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const present = value => value !== null && value !== undefined && value !== ''

// A value that came with a record says which record and when. A value from the
// registry says so too, because the registry has no timestamp and a reader needs
// to know that.
function sourced (fact) {
  if (fact === null || fact === undefined) return null
  const where = fact.at === null || fact.at === undefined ? fact.source : fact.source + ', ' + fact.at
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

const yesno = value => (value === true ? 'yes' : value === false ? 'no' : null)
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

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

function renderHeartbeat (heartbeat) {
  if (heartbeat === null) return ''
  const age = heartbeat.ageSeconds === null
    ? null
    : heartbeat.ageSeconds + ' s before this page'
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
  lines.push(group('Journal', [
    row('enabled', yesno(journal.enabled)),
    row('disabled', journal.disabledReason),
    row('bytes written', bytes(journal.bytes)),
    row('seals', count(journal.sealed)),
    row('pruned', count(journal.pruned)),
    row('pruned bytes', bytes(journal.prunedBytes)),
    row('directory bytes', bytes(journal.dirBytes)),
    row('shard', journal.file)
  ]))

  const wire = heartbeat.wire ?? {}
  lines.push(group('Wire', [
    row('checked', count(wire.checked)),
    row('rejected', count(wire.rejected))
  ]))

  const telemetry = heartbeat.telemetry ?? {}
  lines.push(group('Telemetry', [
    row('enabled', yesno(telemetry.enabled)),
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
        : ' (in ' + account.expiresInDays + ' days)')
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
  const lines = [heading('Start', facts.start?.at ?? null)]
  const start = facts.start ?? {}
  const control = start.control ?? {}
  const whitelist = facts.whitelist
  lines.push(group('Puppet', [
    row('version', start.version),
    row('front listening', start.front),
    row('serving on', sourced(facts.backend.effective) ?? 'unknown, and no start or reconnect record is in the tail'),
    row('configured backend', sourced(facts.backend.configured) ?? 'unknown, and no start record is in the tail'),
    row('registry backend', sourced(facts.backend.registry)),
    row('attach whitelist', whitelist === null
      ? 'unknown, and no start record is in the tail'
      : whitelist.count + ' entries (' + whitelist.source + ', ' + whitelist.at + ')'),
    row('control file', control.file),
    row('backend switch', yesno(control.allowBackendSwitch)),
    row('whitelist reload', yesno(control.whitelistReload))
  ]))
  return lines.join('')
}

function renderPreAuth (preAuth) {
  const cap = present(preAuth.maxConnections)
    ? preAuth.maxConnections + ' (last refused connection, ' + (preAuth.maxConnectionsAt ?? 'no timestamp') + ')'
    : null
  const deadline = present(preAuth.deadlineMs)
    ? preAuth.deadlineMs + ' ms (last expired connection, ' + (preAuth.deadlineMsAt ?? 'no timestamp') + ')'
    : null
  const lines = [heading('Pre-auth window', null)]
  lines.push(group('Caps', [
    row('connections', cap ?? 'unknown, and no refusal line is in the tail'),
    row('deadline', deadline ?? 'unknown, and no expiry line is in the tail')
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
  lines.push(renderHeartbeat(facts.heartbeat))
  lines.push(renderStart(facts))
  lines.push(renderPreAuth(facts.preAuth))
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

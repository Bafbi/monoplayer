// What one puppet is doing, read from the records it already writes.
//
// The input is the puppet's JSONL log tail and the pod the registry's Deployment
// names. The output is one object, and every number in it is copied from a record
// and carries that record's own `t`. Nothing here reads the clock for a fact: the
// clock is used only to say how old a record is, and the page says "old" in words.
//
// The projection is a whitelist, field by field. A key the tail carries and this
// file does not name never reaches the page, which is what keeps a secret out of
// it even if a future log line grows one: the JSONL is redacted where it is
// written (src/observability/redact.js), and this file decides what the page may
// see on top of that. `redact` runs over every string anyway, so a token-shaped
// value inside a field the panel does display is cleaned twice rather than shown.
//
// Read-only: nothing here writes a record, a file, or a ConfigMap.
import { redact } from '../observability/redact.js'

// The heartbeat's interval, and the age at which the page stops calling a record
// current. Three intervals: one missed heartbeat is a slow tick, three is a lane
// that is not writing.
export const HEARTBEAT_MS = 30_000
export const STALE_MS = 3 * HEARTBEAT_MS
// A token inside this window is a puppet that stops serving at its next refresh.
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000
// The documented fields of each group. A field outside a list is not rendered.
const SIZES = ['prefix', 'config', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic']
const FRONT = ['allowed', 'attaches', 'denied', 'preAuthRefused', 'preAuthExpired', 'preAuthInWindow', 'policyRefused', 'stateRefused']
const JOURNAL = ['enabled', 'disabledReason', 'dir', 'file', 'frames', 'events', 'bytes', 'sealed',
  'pruned', 'prunedBytes', 'skipped', 'dropped', 'truncated', 'errors', 'dirBytes', 'freeBytes', 'requiredBytes']
const WIRE = ['checked', 'rejected']
const DOMAINS = ['config', 'prefix', 'chunks', 'blocks', 'entities', 'inventories', 'latest', 'generic']
// #419: the two groups #415 added, from the two tables under "The per-body and
// per-channel groups" in docs/telemetry.md. That page is still their home:
// test/panel/groups.test.js compares these lists to its Field column in both
// directions, so a documented field with no entry here is a red gate and not a
// number the page silently drops.
const BODIES = ['body', 'active', 'warm', 'frames', 'chunkBytes', 'framesCached', 'framesDropped', 'claimMs']
const CHANNELS = ['channel', 'body', 'role', 'ageMs', 'frames', 'play', 'configuration', 'bytes',
  'replays', 'spectators', 'claimMs']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clean = value => (typeof value === 'string' ? redact(value) : value)
const reason = error => String(error?.message ?? error)

// A record's own timestamp, from either shape: the JSONL log writes an ISO
// string, the journal writes epoch milliseconds. `at` is what the page prints;
// `ms` is what an age is measured from.
export function time (value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { at: new Date(value).toISOString(), ms: value }
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return { at: new Date(ms).toISOString(), ms }
  }
  return { at: null, ms: null }
}

// One line per record, and the count of lines this module could not read. A torn
// last line is counted, not dropped silently: the page shows the count, so a
// half-written record is visible instead of vanishing.
export function parseTail (text) {
  const records = []
  let lines = 0
  let unreadable = 0
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      unreadable += 1
      continue
    }
    if (!isObject(record)) {
      unreadable += 1
      continue
    }
    records.push(record)
  }
  return { records, lines, unreadable }
}

// The last record with this event name. The tail is in write order, so the last
// one is the newest.
export function newest (records, event) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].event === event) return records[index]
  }
  return null
}

export function countEvent (records, event) {
  return records.filter(record => record.event === event).length
}

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const dayWord = days => (Math.abs(days) === 1 ? 'day' : 'days')
const counter = (source, name) => (isObject(source) ? finite(source[name]) : null)

// The named fields of one group, as numbers, booleans, strings, or null. A value
// of another shape (an object, a list) is dropped rather than stringified: the
// panel shows the documented fields, and an undocumented object is not one.
function pick (source, keys) {
  if (!isObject(source)) return null
  const out = {}
  let any = false
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = clean(value)
    } else if (value === null) {
      out[key] = null
    } else {
      continue
    }
    any = true
  }
  return any ? out : null
}

// Every row of a group, projected by the same rule. A group the record does not
// carry is null, which is a lane older than the groups; an empty list is a lane that
// holds none. The page says different things for the two, so this does not merge
// them.
//
// A row that is not an object, or that carries none of the named fields, is dropped
// rather than rendered as a heading with nothing under it. When a list carried rows
// and none of them could be read the answer is null and not an empty list: the page
// reads an empty list as "the lane holds none", and that is a measurement the record
// just contradicted.
function picks (source, keys) {
  if (!Array.isArray(source)) return null
  const rows = source
    .filter(isObject)
    .map(row => pick(row, keys))
    .filter(row => row !== null)
  if (rows.length === 0 && source.length > 0) return null
  return rows
}

// What the API server said about the pod: the name, whether it is ready, when it
// started, and how many times a container restarted. All of it from the pod
// object, none of it inferred.
function podFacts (pod, now) {
  if (!isObject(pod)) return null
  const status = isObject(pod.status) ? pod.status : {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  const ready = conditions.find(condition => condition?.type === 'Ready') ?? null
  const started = time(status.startTime ?? pod.metadata?.creationTimestamp ?? null)
  const statuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : []
  return {
    name: typeof pod.metadata?.name === 'string' ? clean(pod.metadata.name) : null,
    phase: typeof status.phase === 'string' ? clean(status.phase) : null,
    ready: ready?.status === 'True',
    readyReason: typeof ready?.reason === 'string' ? clean(ready.reason) : null,
    readyMessage: typeof ready?.message === 'string' ? clean(ready.message) : null,
    startedAt: started.at,
    ageSeconds: started.ms === null ? null : Math.max(0, Math.round((now - started.ms) / 1000)),
    restarts: statuses.reduce((sum, entry) => sum + (finite(entry?.restartCount) ?? 0), 0)
  }
}

// The effective backend is the one the last successful dial used. A puppet that
// followed a transfer shows where it is now, not where it started. `configured` is
// the target the config document asks for, which is the one the lane started on.
// `registry` is this panel's own copy. Those three facts stay apart, each labelled
// with the record it came from.
// #331: `effective` and `configured` read the same start record field, because the
// lane starts on its configured backend. They diverge the moment a reconnect moves
// `effective`, which is the only time they are different answers. `lastDial` is the
// newest dial of either outcome, because a reconnect that failed in the tail is
// the difference between "on play2" and "on play2 until three minutes ago".
function backendFacts ({ puppet, start, reconnect, failed }) {
  const started = time(start?.t ?? null)
  const effective = (reconnect !== null && typeof reconnect.target === 'string')
    ? { value: clean(reconnect.target), source: 'reconnect', at: time(reconnect.t).at }
    : (start !== null && typeof start.backend === 'string')
        ? { value: clean(start.backend), source: 'start', at: started.at }
        : null

  const dials = [reconnect, failed]
    .filter(record => record !== null && typeof record.target === 'string')
    .map(record => ({ record, at: time(record.t) }))
  const newest = dials.sort((left, right) => (left.at.ms ?? 0) - (right.at.ms ?? 0)).at(-1) ?? null
  return {
    effective,
    lastDial: newest === null
      ? null
      : {
          value: clean(newest.record.target),
          at: newest.at.at,
          connected: newest.record.event === 'backendReconnect'
        },
    configured: start !== null && typeof start.backend === 'string'
      ? { value: clean(start.backend), source: 'start', at: started.at }
      : null,
    registry: { value: puppet.backend, source: 'registry', at: null }
  }
}

// The attach whitelist's size. `startLive.whitelistCount` is the count the live
// service resolved; the core's `start` record carries the list itself, and its
// length is the same fact on a lane that never wrote a startLive line.
function whitelistFacts (start, coreStart) {
  if (start !== null && typeof start.whitelistCount === 'number') {
    return { count: start.whitelistCount, at: time(start.t).at, source: 'startLive' }
  }
  if (coreStart !== null && Array.isArray(coreStart.whitelist)) {
    return { count: coreStart.whitelist.length, at: time(coreStart.t).at, source: 'start' }
  }
  return null
}

// The pre-auth window's two caps are not in the heartbeat: they are in the lines
// the window writes when it bites. A refusal carries `maxConnections`, an expiry
// carries `deadlineMs`, so each cap is shown with the timestamp of the last line
// that stated it, and is absent when no line has.
function preAuthFacts (refusal, expiry) {
  return {
    maxConnections: counter(refusal, 'maxConnections'),
    maxConnectionsAt: refusal === null ? null : time(refusal.t).at,
    deadlineMs: counter(expiry, 'deadlineMs'),
    deadlineMsAt: expiry === null ? null : time(expiry.t).at
  }
}

function telemetryFacts (source) {
  if (!isObject(source)) return null
  const logs = isObject(source.logs) ? source.logs : {}
  const metrics = isObject(source.metrics) ? source.metrics : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    requests: finite(source.requests),
    retries: finite(source.retries),
    failures: finite(source.failures),
    // The documented oddity: `metrics.queued` is the number of distinct series,
    // not a queue depth, and it only grows.
    queuedSeries: finite(metrics.queued),
    queuedLogRecords: finite(logs.queued),
    droppedLogs: finite(logs.dropped),
    droppedMetrics: finite(metrics.dropped),
    lastError: typeof source.lastError === 'string' ? clean(source.lastError) : null
  }
}

function accountFacts (source, now) {
  if (!isObject(source)) return null
  const alias = typeof source.alias === 'string' ? clean(source.alias) : null
  const at = finite(source.expiresAt)
  if (at === null) {
    // null is "the custody cache does not say", which is not "no expiry".
    return { alias, expiresAt: null, expiresAtDate: null, expiresInDays: null, expired: false, warning: null }
  }
  const remaining = at - now
  const days = Math.round((remaining / 86_400_000) * 10) / 10
  const expired = remaining <= 0
  return {
    alias,
    expiresAt: at,
    expiresAtDate: time(at).at,
    expiresInDays: days,
    expired,
    // An expired token is the case this line exists for, so it reads as expired
    // rather than as a negative forecast.
    warning: expired
      ? 'the Minecraft token expired ' + Math.abs(days) + ' ' + dayWord(days) +
        ' ago; the puppet serves until its next refresh fails'
      : remaining <= EXPIRY_WARNING_MS
        ? 'the Minecraft token expires in ' + days + ' ' + dayWord(days) +
          '; a refresh that fails is a front that stops serving'
        : null
  }
}

function heartbeatFacts (record, now) {
  if (record === null) return null
  const at = time(record.t)
  const age = at.ms === null ? null : Math.max(0, now - at.ms)
  return {
    at: at.at,
    ageSeconds: age === null ? null : Math.round(age / 1000),
    stale: age !== null && age > STALE_MS,
    intervalSeconds: HEARTBEAT_MS / 1000,
    attached: typeof record.attached === 'boolean' ? record.attached : null,
    warm: typeof record.warm === 'boolean' ? record.warm : null,
    backendLogins: counter(record, 'backendLogins'),
    front: pick(record.front, FRONT),
    sizes: pick(record.sizes, SIZES),
    chunkBytes: counter(record, 'chunkBytes'),
    journal: pick(record.journal, JOURNAL),
    wire: pick(record.wire, WIRE),
    // #419: one row per body the process holds a cache for, and one per channel the
    // front holds open. Neither group exists on a lane older than #415.
    bodies: picks(record.bodies, BODIES),
    channels: picks(record.channels, CHANNELS),
    telemetry: telemetryFacts(record.telemetry),
    account: accountFacts(record.account, now)
  }
}

function attachFacts (record) {
  if (record === null) return null
  return {
    at: time(record.t).at,
    name: typeof record.name === 'string' ? clean(record.name) : null,
    reason: typeof record.reason === 'string' ? clean(record.reason) : null,
    replayed: counter(record, 'replayed'),
    tookMs: counter(record, 'tookMs'),
    domains: pick(record.domains, DOMAINS),
    // Non-zero is #213's defect, measured: a body the client was told about and
    // never saw appear.
    withoutSpawn: counter(record.entities, 'withoutSpawn')
  }
}

function startFacts (start) {
  if (start === null) return null
  return {
    at: time(start.t).at,
    version: typeof start.version === 'string' ? clean(start.version) : null,
    front: typeof start.front === 'string' ? clean(start.front) : null,
    control: pick(start.control, ['whitelistReload'])
  }
}

// The sentence a card shows instead of its numbers. Seven states, seven sentences:
// a puppet that is not serving says which fact is missing, never a spinner and
// never a chip without words.
function stateOf ({ failure, pod, log, heartbeat, tail, records, puppet, now }) {
  if (failure !== null) {
    return { state: 'read-refused', reason: 'read refused: ' + reason(failure) }
  }
  if (pod === null) {
    return {
      state: 'no-pod',
      reason: 'no pod: Deployment ' + puppet.namespace + '/' + puppet.deployment +
        ' has no pod, so nothing is running'
    }
  }
  if (pod.ready !== true) {
    return {
      state: 'not-ready',
      reason: 'pod not ready: ' + pod.name + ' is not Ready' +
        (pod.readyReason === null ? '' : ' (' + pod.readyReason + ')') +
        ', so the front serves nothing yet'
    }
  }
  if (log === null || log.error !== undefined) {
    return {
      state: 'log-refused',
      reason: 'log fetch refused: ' + (log === null ? 'the panel read no log' : reason(log.error))
    }
  }
  if (heartbeat === null) {
    const newestRecord = records.length === 0 ? null : time(records[records.length - 1].t)
    return {
      state: 'no-heartbeat',
      reason: 'no heartbeat in the last ' + tail.lines + ' lines of ' + pod.name +
        (newestRecord?.at === null || newestRecord === null
          ? ': the tail holds no timestamped record'
          : ': the newest line is ' + newestRecord.at + ', ' + Math.round(Math.max(0, now - newestRecord.ms) / 1000) + ' s old') +
        ', and a heartbeat is written every ' + Math.round(HEARTBEAT_MS / 1000) + ' s'
    }
  }
  const age = heartbeat.ageSeconds
  if (heartbeat.stale === true) {
    // The record answered and is old. That is neither "serving" nor "no
    // heartbeat", and it is the state the page exists to keep out of the live
    // colour: three intervals with nothing written is a lane that stopped.
    return {
      state: 'stale',
      reason: 'stale: the newest heartbeat was written ' + age + ' s ago, and the interval is ' +
        Math.round(HEARTBEAT_MS / 1000) + ' s; read every number below as old'
    }
  }
  return {
    state: 'serving',
    reason: age === null
      ? 'serving, and the newest heartbeat carries no readable timestamp'
      : 'serving: the newest heartbeat was written ' + age + ' s ago, and the interval is ' +
        Math.round(HEARTBEAT_MS / 1000) + ' s'
  }
}

export function activity ({ puppet, pod = null, log = null, failure = null, caps = null, now = Date.now() } = {}) {
  const tail = log !== null && typeof log.text === 'string' ? parseTail(log.text) : null
  const records = tail?.records ?? []
  const start = newest(records, 'startLive')
  const heartbeat = heartbeatFacts(newest(records, 'heartbeat'), now)
  const podView = podFacts(pod, now)
  return {
    name: puppet.name,
    namespace: puppet.namespace,
    deployment: puppet.deployment,
    controlConfigMap: puppet.controlConfigMap,
    frontHostname: puppet.frontHostname,
    // When the panel made these reads. Not a fact from the lane: every number
    // below carries the timestamp of the line it came from, and an age is
    // measured from this instant.
    observedAt: new Date(now).toISOString(),
    pod: podView,
    state: stateOf({ failure, pod: podView, log, heartbeat, tail, records, puppet, now }),
    backend: backendFacts({
      puppet,
      start,
      reconnect: newest(records, 'backendReconnect'),
      failed: newest(records, 'backendReconnectFailed')
    }),
    // The caps the Deployment's own environment sets, read from the object the
    // panel already fetches. A variable the Deployment does not set is null: the
    // compiled default applies and the panel cannot see it.
    caps: caps === null ? null : { ...caps, source: 'Deployment env', at: null },
    start: startFacts(start),
    whitelist: whitelistFacts(start, newest(records, 'start')),
    preAuth: preAuthFacts(newest(records, 'preAuthRefused'), newest(records, 'preAuthExpired')),
    heartbeat,
    attach: attachFacts(newest(records, 'attach')),
    tail: tail === null
      ? null
      : { lines: tail.lines, unreadable: tail.unreadable, heartbeats: countEvent(records, 'heartbeat') }
  }
}

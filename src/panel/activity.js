// What one puppet is doing, read from the records it already writes.
//
// The input is the puppet's JSONL log tail and the pod the registry's Deployment
// names. The output is one object, and every number in it is copied from a record
// and carries that record's own `t`. Nothing here reads the clock for a fact: the
// clock is used only to say how old a record is, and the page says "old" in words.
//
// The projection decides what the page may see, and it does that two ways.
//
// A named group is a whitelist, field by field: the list below holds the fields
// docs/telemetry.md documents for the group, and a key none of them names never
// reaches the page. `redact` runs over every string it does admit
// (src/observability/redact.js), so a token-shaped value inside a displayed field is
// cleaned rather than shown.
//
// A counter group is projected by shape (#743). `front` is the front leg's counters
// and `sizes` is the cache's: a counter is a number, so that is the rule, and a
// counter the leg grows reaches the page without this file being edited for it. The
// whitelist that used to stand there named the counters somebody had written into it,
// so the rest reached the pod log, the journal and OTLP and stopped: a field list that
// must be edited for every new counter is a list numbers die behind. What the whitelist
// also guarded — that a secret cannot ride a name this file has never heard of — is
// now a rule about the group and not about the field: a counter is a number, and a
// counter group admits no string at all, which is the one place a secret lives.
//
// The attach record is neither of those two cases, because one record holds a label, a
// duration, a flag, a position, and five groups of counts. Its five groups are projected by
// shape, its scalars are picked by name, and the four fields the card declines are declared
// in ATTACH_DECLINED with the reason each one is not a row. That declaration is what lets
// docs/telemetry.md's field list and this file's be compared (#834): the doc cannot see a
// projection, and a projection cannot see its own omissions.
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
// The named groups' fields: the documented ones, field by field. A field outside a
// list is not rendered. These two keep a list where `front` and `sizes` do not,
// because their rows are not one per field: the journal group draws three caps the
// heartbeat does not carry and the shard's name, and the wire group has two documented
// fields that are not counters, a map and a sentence, which this list drops. #782 is
// the ticket that says which fields of those two never reach the page.
// The attach record's fields the card does not draw, each with the reason it is not a
// row (#834). The projection picks its fields by name, so a field the doc documents and
// this file never picks is a number the page silently drops, which is what #735 was for
// `refused`: documented, written, counted, and no row. So the file declares the half it
// declines, in one place, and test/panel/attach-doc.test.js holds this declaration and
// docs/telemetry.md's own field list together: a documented field with no row and no line
// here is a red gate, and a line here for a field the doc does not name is red too.
//
// The rule #743 gave `front` and `metrics` — a counter is a number, so every counter is a
// row — cannot be this record's rule, because an attach record is not one shape: a label
// (name, reason), a duration (tookMs), a flag (includeConfig), a position (pose), and five
// groups of counts. A shape rule would admit all of those and the card would then print a
// position as a count. The five groups are projected by shape, which is where the rule
// holds; the rest are picked by name, and the four this card has no row for are here.
export const ATTACH_DECLINED = {
  pose: 'A position is three coordinates and a look angle, and every other row on the card is a count or a duration. The record carries it for the log and for the parity rung, which compares one client\'s landing against another\'s, so it has a reader: it just has no neighbour here to be compared with.',
  includeConfig: '`domains.config` answers it, as a number: docs/telemetry.md says that count is 0 when the attach leaves the configuration prefix out, which is the same fact in a shape a reader can compare with the other domains.',
  backendLogins: 'The heartbeat draws this counter already, in its own row set. A second copy under "Last attach" would be one number at a second instant, which reads as a second measurement of it.',
  skippedLegOwned: 'These are the frames a leg writes itself, so the replay skipped them rather than losing them. Beside `replayed` and `refused` a third count would read as a third loss, and this one is not a loss at all.'
}

const JOURNAL = ['enabled', 'disabledReason', 'dir', 'file', 'frames', 'events', 'bytes', 'sealed',
  'pruned', 'prunedBytes', 'skipped', 'dropped', 'truncated', 'errors', 'dirBytes', 'freeBytes', 'requiredBytes']
const WIRE = ['checked', 'rejected']
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

// A counter, by shape: a finite number. A string is refused, because a counter is not
// one and a string is where a secret lives: this is what keeps a secret out of a
// counter group whose field names this file has never heard of. A boolean is refused
// for a smaller reason: neither group holds a flag, and a flag a view cannot tell from
// a count is a shape the page would print wrongly rather than drop (#743).
const isCounter = value => typeof value === 'number' && Number.isFinite(value)

// The one map a counter group holds: a count per key, which is the front leg's
// `pickerRefusalsByReason` (#417). The page draws one row per entry, so the entries
// are kept; a map that is empty, or whose entries are not counters, is a value the
// page cannot draw and is not one it invents a number for. An empty map is the case
// the page says nothing about, and it loses nothing by that: the total this map breaks
// down is a counter beside it, and the total is drawn whatever the map holds.
function countMap (value) {
  if (!isObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0) return null
  const out = {}
  for (const [key, entry] of entries) {
    if (!isCounter(entry)) return null
    out[key] = entry
  }
  return out
}

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

// One counter group, whole: every field the record carries, in the record's own
// order, plus the one map of counts it can hold. Null means the record carries no such
// group, which is a lane older than the group, and the page then says nothing about
// it. A field of another shape is dropped rather than stringified, which for a group
// of counters means a string never reaches the page.
function pickCounters (source) {
  if (!isObject(source)) return null
  const out = {}
  let any = false
  for (const [key, value] of Object.entries(source)) {
    if (isCounter(value)) {
      out[key] = value
    } else {
      const counts = countMap(value)
      if (counts === null) continue
      out[key] = counts
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
function pickRows (source, keys) {
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

// The entries the record names, with the UUID decision the lane wrote for each (#705). A
// list that carries a uuid and no decision is not one this page can read. Printing such an
// entry as usable would turn an absent answer into a positive one, and that is the failure
// #748 is about. Such a record answers nothing, so the row keeps the count and points at
// the block.
function whitelistEntries (start) {
  const rows = pickRows(start.whitelistEntries, ['uuid', 'refusalReason'])
  if (rows === null) return null
  return rows.every(row => 'refusalReason' in row) ? rows : null
}

// The attach whitelist as the lane started with it: the count, and the entries that same
// read named (#748). `startLive.whitelistCount` is the number the live service resolved,
// and `startLive.whitelistEntries` is the read's own list, one object per entry carrying
// the UUID decision the lane's `uuidRefusalReason` gave it (#705). This file prints that
// decision rather than asking the rule again: the answer and the count are one read, so a
// row cannot say 3 and judge 2, and src/custody/util.js stays the one home of the rule
// (#703). The list holds uuids and no names, which is the half of the rule a startup read
// can ask: only a login tells a uuid nobody owns apart from a real entry.
//
// The core's `start` record carries the list as uuids and no answer, and its length is the
// count on a lane that never wrote a startLive line. It is the count's source and never the
// row's: the panel prints the decision the lane wrote, and never one it invented, so those
// rows name nothing and the view says where the per-entry answer is.
function whitelistFacts (start, coreStart) {
  if (start !== null && typeof start.whitelistCount === 'number') {
    const entries = whitelistEntries(start)
    return {
      // One read, so the number and the rows below it cannot disagree. A record that
      // carries no list is a lane older than #705, and its own count is the fact.
      count: entries === null ? start.whitelistCount : entries.length,
      at: time(start.t).at,
      source: 'startLive',
      entries
    }
  }
  if (coreStart !== null && Array.isArray(coreStart.whitelist)) {
    return { count: coreStart.whitelist.length, at: time(coreStart.t).at, source: 'start', entries: null }
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
    // #743: the two counter groups, whole. A counter the leg adds is a row the page
    // draws, and the label it draws it under is the view's business, not this file's.
    front: pickCounters(record.front),
    sizes: pickCounters(record.sizes),
    // #833: the core's own group, by the same rule. #743 generalised `front` and
    // `sizes` and left this one, which is where every counter the process keeps stops
    // in. Its shape is the one `pickCounters` reads, numbers and one level of map from
    // a name to a count, so the helper is reused and not widened.
    metrics: pickCounters(record.metrics),
    chunkBytes: counter(record, 'chunkBytes'),
    journal: pick(record.journal, JOURNAL),
    wire: pick(record.wire, WIRE),
    // #419: one row per body the process holds a cache for, and one per channel the
    // front holds open. Neither group exists on a lane older than #415.
    bodies: pickRows(record.bodies, BODIES),
    channels: pickRows(record.channels, CHANNELS),
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
    // #735: the other half of the delivery #717 split out, which is every frame the leg
    // refused or threw on. The two stay apart and are never added: `replayed` excludes
    // the synthesized position and this includes a position the leg refused, so a sum or
    // a ratio would print a frame count that is not one (docs/telemetry.md).
    refused: counter(record, 'refused'),
    tookMs: counter(record, 'tookMs'),
    // #834: the third number of the delivery, beside the two #717 split it into. `replayed`
    // excludes the position the replay invents and `refused` includes one the leg refused,
    // so a reader comparing those two needs this count to place the difference.
    synthesizedPositions: counter(record, 'synthesizedPositions'),
    // #834: the five groups of counts, whole and projected by shape, which is the rule
    // #743 gave `front` and `metrics`. The list that stood here named `domains`'s eight keys
    // and one key of `entities`, so a domain the cache grew and a body count the summary
    // added stopped at the pod log. `entities.withoutSpawn` is #213's defect measured: a
    // body the client was told about and never saw appear, and the view says so in words.
    domains: pickCounters(record.domains),
    entities: pickCounters(record.entities),
    players: pickCounters(record.players),
    dialogs: pickCounters(record.dialogs),
    packs: pickCounters(record.packs)
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

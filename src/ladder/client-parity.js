// Client parity: one protocol bot joins a server directly, another joins the
// same server through the proxy, and one report separates expected differences
// from unexplained ones (issue #13).
//
// This is not the #2 check. #2 (closed by PR #25) compares one client's decode
// against what the cache replayed on that same connection, and src/ladder/
// state-parity.js is its module. This report reuses it: #13 asks a different
// question, which is what a client that joined directly sees that a client
// behind the proxy does not.
//
// The pieces it reuses, and why:
//
//   src/ladder/bot.js                  records every clientbound { state, name }
//   src/ladder/client-state.js         decodes the play stream into client state
//   src/ladder/state-parity.js         the six domains and their comparators
//   src/core/clientbound-policy.js     what the proxy does with each frame, which
//                                     is what makes a difference expected rather
//                                     than a second hand-written name list
//
// Two lanes, one comparison:
//
//   fake      (default) the repo's own fake backend plus an in-process
//             Monoplayer, the same shape as the loopback rung. No auth, no
//             cluster, no .secrets. Section 2a of the ladder, and the lane a
//             laptop or CI can run without one.
//   endpoint  --backend and --front given: the harness only runs the two joins
//             against endpoints an operator stood up — the dev lane, the
//             transfer testbed, or a local port-forward. The harness never
//             builds a proxy with live legs, so it never holds custody and
//             cannot disturb the live deployment.
//
// The harness never joins the live Excalia fleet. assertDeployableTarget()
// refuses any *.excalia.fr host, so a mistyped endpoint stops the run instead
// of measuring a server this repo does not own.
//
// Exit codes: 0 every difference explained, 1 an unexplained difference, 2
// setup refused or an endpoint that never joined. The report is written on both
// 0 and 1, because a red report is the finding.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { DECISION, clientboundPolicy } from '../core/clientbound-policy.js'
import { createFakeBackend, emptySlot, itemStack } from '../legs/fake-backend.js'
import { offlineUuid } from '../legs/offline-identity.js'
import { createOfflineBackendLeg } from '../legs/live-backend.js'
import { createOfflineFrontLeg } from '../legs/live-front.js'
import { createMonoplayer, loadConfig } from '../service/monoplayer.js'
import { waitForReady } from '../service/readiness.js'
import { createBot } from './bot.js'
import { compareSnapshots, decodeState } from './state-parity.js'
import { resolveBotIdentity } from './observer-baseline.js'

// The fake backend speaks 26.1 and nothing else, so the default lane pins it.
// A real target passes its own version.
const DEFAULT_VERSION = '26.1'
const FAKE_LANE_VERSION = '26.1'
const DEFAULT_REPORT = '.reports/client-parity-report.json'
const DEFAULT_USERNAME = 'Parity'
const DEFAULT_TIMEOUT_MS = 60_000
// A join is settled when no frame arrived for quietMs, or when maxCollectMs is
// up. The quiet window is what catches trailing state (chunk batches, the
// player list) without pinning a frame count that a real server would vary.
const DEFAULT_QUIET_MS = 500
const DEFAULT_MAX_COLLECT_MS = 5000
// The vanilla player inventory window: 46 slots, the same shape the fake backend
// fills. The churn sends a full window so the inventory domain has content.
const INVENTORY_SLOTS = 46
// The live fleet. Not ours, never measured by an automated join.
const LIVE_HOST = 'excalia.fr'

function flag (argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function detail (value) {
  const json = JSON.stringify(value, (key, inner) => typeof inner === 'bigint' ? String(inner) : inner)
  return json === undefined ? String(value) : json
}

// The live Excalia fleet is the one target no automated join may touch: this
// repo does not deploy it, so a difference there is not ours to explain.
export function assertDeployableTarget (host) {
  const name = String(host ?? '').trim().toLowerCase()
  if (name.length === 0) throw new TypeError('host is required')
  if (name === LIVE_HOST || name.endsWith('.' + LIVE_HOST)) {
    throw new Error(
      host + ' is the live Excalia fleet. This harness only runs against servers ' +
      'this repo deploys: the gate Paper, the transfer testbed, and the dev lane.'
    )
  }
  return name
}

// HOST:PORT, or null when the operator gave neither. The port is validated here
// so a typo is a setup error, not a join that times out.
export function parseEndpoint (text, label = 'endpoint') {
  if (text === undefined || text === null || text === '') return null
  const separator = String(text).lastIndexOf(':')
  if (separator < 0) throw new Error(label + ' must be HOST:PORT, got ' + JSON.stringify(String(text)))
  const host = String(text).slice(0, separator)
  const port = Number(String(text).slice(separator + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' needs a port in 1..65535, got ' + JSON.stringify(String(text).slice(separator + 1)))
  }
  return { host: assertDeployableTarget(host), port }
}

function joinEndpoint (host, port) {
  return host && port ? host + ':' + port : undefined
}

// The differences that are not findings yet, because the ticket that makes the
// human own them has not landed. Every row here is reported as absent and never
// fails the run, and the issue and the reason are in the row.
export const PENDING = Object.freeze([
  Object.freeze({
    issue: '#19',
    capability: "the human's signed chat",
    state: 'play',
    names: Object.freeze(['player_chat']),
    reason: 'the read-only chat mode drops the signed player chat until #19 flips it to full'
  }),
  Object.freeze({
    issue: '#21',
    capability: 'configuration gates',
    state: 'configuration',
    names: Object.freeze(['show_dialog', 'clear_dialog', 'code_of_conduct']),
    reason: 'configuration gates are answered on the puppet leg until #21 attaches the human to them'
  }),
  Object.freeze({
    issue: '#22',
    capability: 'the seamless transfer',
    state: 'play',
    names: Object.freeze(['transfer', 'start_configuration']),
    reason: "a followed transfer ends the client's connection until #22 keeps it and shows the reconfiguration screen"
  })
])

// What each clientbound decision predicts about which clients see the frame.
//
// The policy table is the code under test, so these are predictions to check,
// not reasons to accept: an observation that does not match its prediction is a
// finding, in either direction. A table that mislabels a frame therefore shows
// up as a failed run rather than as a free pass for the frame it mislabels.
const PREDICTIONS = Object.freeze({
  // Cached and relayed: the direct client sees the live state, and the proxied
  // client sees that state live or replayed, so the direct side is contained in
  // the proxied one.
  [DECISION.STATE]: 'direct_within_proxied',
  // Cached and replayed, never relayed: both clients end up with one login.
  [DECISION.CACHE_ONLY]: 'both',
  // Owned by each connection: each client has its own, from its own leg.
  [DECISION.PER_LEG]: 'both',
  // Relayed while attached and never cached: both clients see the traffic that
  // happened while they were attached.
  [DECISION.LIVE_ONLY]: 'both',
  // The proxy takes the action on its own connection and never relays it, so
  // only the direct client sees the frame.
  [DECISION.BLOCK]: 'direct'
})

// The one blocked frame whose client-visible effect is the end of the session.
// The product ends the front client's socket instead of relaying the frame
// (monoplayer.js teardownBackend), so a kick the proxied client never received
// as a frame is the difference the harness exists to surface, not an expected
// one. It is predicted on both sides.
const KICK_FRAME = 'kick_disconnect'

// An ordinary state frame only the proxied client saw. The cache holds the
// puppeted session's state, so the attach replay can carry state a fresh direct
// join never produced. Under the STATE prediction that is the one allowed
// one-sided case: the direct side must always be contained in the proxied one.
const REPLAY_INSERT =
  'the attach replay carries the cached state of the puppeted session, and a fresh direct join never had that state'

// An ordinary state frame only the direct client saw. The relay lost it.
const RELAY_LOST = 'so the relay lost a frame the server sent'

// The decoded-state domains that may differ between two connections.
const STATE_REASONS = Object.freeze({
  pose: 'the attach replay lands the client at the pose the puppeted session holds; a direct join lands where the server spawns it',
  entities: 'entity ids and lifetimes belong to a connection, so two sessions number the same world differently'
})

function pendingFor (state, name) {
  return PENDING.find(entry => entry.state === state && entry.names.includes(name)) ?? null
}

function frameKey (state, name) {
  return state + ':' + name
}

function countFrames (frames) {
  const counts = new Map()
  for (const frame of frames) {
    const key = frameKey(frame.state, frame.name)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

// One row per frame kind either side saw, plus one row per pending frame kind
// whether or not anyone saw it: a row that measures nothing today still belongs
// in the report, with its issue.
function frameRows (directFrames, proxiedFrames, deterministic) {
  const direct = countFrames(directFrames)
  const proxied = countFrames(proxiedFrames)
  const keys = new Set([...direct.keys(), ...proxied.keys()])
  for (const entry of PENDING) {
    for (const name of entry.names) keys.add(frameKey(entry.state, name))
  }

  const rows = []
  for (const key of [...keys].sort()) {
    const separator = key.indexOf(':')
    const state = key.slice(0, separator)
    const name = key.slice(separator + 1)
    const row = { state, name, direct: direct.get(key) ?? 0, proxied: proxied.get(key) ?? 0 }
    rows.push({ ...row, ...classifyFrame({ ...row, deterministic }) })
  }
  return rows
}

function observeSides (direct, proxied) {
  if (direct > 0 && proxied > 0) return 'both'
  if (direct > 0) return 'direct'
  if (proxied > 0) return 'proxied'
  return 'neither'
}

// What the proxy's own rules predict about this frame, or null when nothing in
// the repo classifies it. The prediction is the thing under test, never the
// verdict.
export function predictionFor (state, name) {
  // The login handshake belongs to each connection: the front answers the
  // attaching client's own handshake and never replays the puppet's. The policy
  // table covers play and configuration only, so this state is predicted here
  // instead of reading as an unknown frame.
  if (state === 'login') return { predicted: 'both', decision: 'per_connection' }

  const policy = clientboundPolicy(state, name)
  if (policy.unknown) return null
  if (state === 'play' && name === KICK_FRAME) return { predicted: 'both', decision: policy.decision }
  return { predicted: PREDICTIONS[policy.decision], decision: policy.decision }
}

// Why an observation that contradicts its prediction is a finding. The sentence
// names what the table predicted and what the two clients actually saw, so a
// reader can judge the table itself, not only the relay.
function mismatchReason (key, predicted, observed, decision) {
  const saw = observed === 'direct' ? 'the direct client saw it and the proxied client did not'
    : observed === 'proxied' ? 'the proxied client saw it and the direct client did not'
      : 'both clients saw it'
  if (predicted === 'both') {
    return key + ' is ' + decision + ', so both clients should have it, and ' + saw
  }
  if (predicted === 'direct') {
    return key + ' is ' + decision + ', so only the direct client may see it, and ' + saw
  }
  return key + ' is ordinary state (' + decision + '), so the proxied side must contain the direct side, and ' + saw + ', ' + RELAY_LOST
}

// The verdict for one frame kind.
//
// The policy table decides what to *predict* about which clients see a frame,
// and the observation decides the verdict: a prediction that does not match is a
// finding in either direction. A classification is never a reason on its own,
// because the table is the code under test.
//
// Counts are a finding only where they can be. The offline lane is
// deterministic, so a count difference there is a lost or duplicated frame. A
// real server's counts drift with time, so there they stay evidence in the row.
export function classifyFrame ({ state, name, direct, proxied, deterministic = false }) {
  const pending = pendingFor(state, name)
  if (pending) {
    return { verdict: 'absent', issue: pending.issue, capability: pending.capability, reason: pending.reason }
  }

  const key = frameKey(state, name)
  const observed = observeSides(direct, proxied)
  const prediction = predictionFor(state, name)
  if (prediction === null) {
    return {
      verdict: 'unexplained',
      predicted: 'none',
      observed,
      reason: 'no clientbound policy entry for ' + key + ', so the proxy decides it by failing closed'
    }
  }

  const { predicted, decision } = prediction
  const evidence = { predicted, observed, decision }

  if (observed === 'both') {
    // A frame the table says must never cross, or a kick both clients saw when
    // only one connection was kicked. The prediction decides, not the count.
    if (predicted === 'direct') {
      return {
        verdict: 'unexplained',
        ...evidence,
        reason: mismatchReason(key, predicted, observed, decision)
      }
    }
    if (direct === proxied) return { verdict: 'same', ...evidence }
    if (deterministic) {
      return {
        verdict: 'unexplained',
        ...evidence,
        reason: key + ': ' + direct + ' direct against ' + proxied + ' proxied on a lane that is deterministic, so a frame was lost or repeated'
      }
    }
    return {
      verdict: 'same',
      ...evidence,
      reason: key + ': ' + direct + ' direct against ' + proxied + ' proxied, which is timing, so the count stays evidence'
    }
  }

  if (observed === 'neither') return { verdict: 'same', ...evidence }

  if (predicted === observed) {
    return {
      verdict: 'expected',
      ...evidence,
      reason: key + ' is ' + decision + ', and only the ' + observed + ' client sees it, which is what the table predicts'
    }
  }

  if (predicted === 'direct_within_proxied' && observed === 'proxied') {
    return { verdict: 'expected', ...evidence, reason: REPLAY_INSERT }
  }

  if (predicted === 'both' && decision === DECISION.LIVE_ONLY && !deterministic) {
    return {
      verdict: 'expected',
      ...evidence,
      reason: key + ' is relayed live and never cached, so on a lane that is not deterministic the two runs caught different live traffic'
    }
  }

  return { verdict: 'unexplained', ...evidence, reason: mismatchReason(key, predicted, observed, decision) }
}

// A compact read of a decoded client state. The full snapshot holds every block
// and entity. The report needs the shape, and the domain diffs carry the detail.
function summarizeState (snapshot) {
  const slots = snapshot.windows.reduce((total, window) => total + window.slots.length, 0)
  return {
    windows: snapshot.windows.length,
    slots,
    chunks: snapshot.chunks.length,
    blocks: snapshot.blocks.length,
    entities: snapshot.entities.length,
    pose: snapshot.pose,
    selectedSlot: snapshot.selectedSlot
  }
}

// The decoded-state comparison, in the report's vocabulary. pose and entities
// are the two domains two connections cannot share. The rest are state the
// replay must reproduce.
export function compareState (directFrames, proxiedFrames, domains) {
  const expected = decodeState(directFrames)
  const actual = decodeState(proxiedFrames)
  const comparison = compareSnapshots(expected, actual, domains)
  const rows = Object.entries(comparison.domains).map(([domain, result]) => {
    if (result.ok) return { domain, verdict: 'same' }
    const reason = STATE_REASONS[domain]
    return {
      domain,
      verdict: reason ? 'expected' : 'unexplained',
      reason: reason ?? 'the replay must reproduce this domain, and the two clients decoded it differently',
      diff: result.diff ?? { expected: result.expected, actual: result.actual }
    }
  })
  return {
    ok: rows.every(row => row.verdict !== 'unexplained'),
    direct: summarizeState(expected),
    proxied: summarizeState(actual),
    domains: rows
  }
}

function tally (list) {
  const counts = { same: 0, expected: 0, absent: 0, unexplained: 0 }
  for (const entry of list) counts[entry.verdict]++
  return counts
}

// The comparison body. Both sides are run records: { frames, playFrames }, where
// frames carry { state, name } and playFrames carry { name, data } for the
// client-state decode.
export function compareRuns ({ direct, proxied, domains, deterministic = false } = {}) {
  if (!direct || !proxied) throw new TypeError('two run records are required')
  for (const run of [direct, proxied]) {
    if (!Array.isArray(run.frames)) throw new TypeError('each run record needs a frames array')
    if (!Array.isArray(run.playFrames)) throw new TypeError('each run record needs a playFrames array')
  }

  const frames = frameRows(direct.frames, proxied.frames, deterministic === true)
  const state = compareState(direct.playFrames, proxied.playFrames, domains)
  const unexplained = [
    ...frames.filter(row => row.verdict === 'unexplained'),
    ...state.domains
      .filter(row => row.verdict === 'unexplained')
      .map(row => ({ state: 'decoded', name: row.domain, ...row }))
  ]

  return {
    ok: unexplained.length === 0,
    deterministic: deterministic === true,
    frames,
    state,
    unexplained,
    // Frame rows only: the printed PASS line counts frame kinds, and the decoded
    // domains are reported one per line beside them.
    counts: tally(frames)
  }
}

export function formatReport (report) {
  const lines = []
  // Which lane ran decides whether a count difference is a finding, so the
  // report says it before the rows.
  if (report.lane) {
    lines.push('lane ' + report.lane + (report.deterministic
      ? ' (deterministic: a count difference is a finding)'
      : ' (timing allowed: a count difference is evidence)'))
  }
  for (const side of ['direct', 'proxied']) {
    const run = report.sides?.[side]
    if (!run) continue
    lines.push(side + ' ' + run.endpoint + ' (' + run.auth + ' ' + run.username + '): ' +
      run.frames.login + ' login, ' + run.frames.configuration + ' configuration, ' +
      run.frames.play + ' play frames' + (run.error ? ' — ' + run.error : ''))
  }
  lines.push('')
  for (const row of report.frames) {
    const mark = row.verdict === 'unexplained' ? 'FAIL' : row.verdict.toUpperCase()
    const issue = row.issue ? ' ' + row.issue : ''
    const reason = row.reason ? ' — ' + row.reason : ''
    lines.push(mark.padEnd(11) + ' ' + frameLabel(row) + issue + ' direct=' + row.direct +
      ' proxied=' + row.proxied + reason)
  }
  for (const row of report.state.domains) {
    const mark = row.verdict === 'unexplained' ? 'FAIL' : row.verdict.toUpperCase()
    const reason = row.reason ? ' — ' + row.reason : ''
    lines.push(mark.padEnd(11) + ' state:' + row.domain + reason)
  }
  lines.push('')
  const counts = report.counts
  lines.push(
    report.ok
      ? 'parity: PASS ' + report.frames.length + ' frame kinds, ' + counts.same + ' same, ' +
        counts.expected + ' expected, ' + counts.absent + ' absent, 0 unexplained'
      : 'parity: FAIL ' + report.unexplained.length + ' unexplained: ' +
        report.unexplained.map(row => (row.state ?? '') + ':' + row.name).join(', ')
  )
  return lines.join('\n')
}

function frameLabel (row) {
  return row.state + ':' + row.name
}

// --- the joins ---

function settled (frames, { quietMs, maxMs }) {
  return new Promise(resolve => {
    const start = Date.now()
    let seen = frames.length
    let quietSince = Date.now()
    const timer = setInterval(() => {
      if (frames.length !== seen) {
        seen = frames.length
        quietSince = Date.now()
      }
      if (Date.now() - quietSince >= quietMs || Date.now() - start >= maxMs) {
        clearInterval(timer)
        resolve()
      }
    }, 25)
    timer.unref?.()
  })
}

// One join, opened. The packet listener goes on before ready() because the
// attach replay lands during the join, and the decoded play frames are what the
// client-state model reads.
export function startJoin ({
  label,
  host,
  port,
  version = DEFAULT_VERSION,
  identity = { auth: 'offline', username: DEFAULT_USERNAME },
  log = () => {}
} = {}) {
  if (typeof host !== 'string' || host.length === 0) throw new TypeError('host is required')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be an integer in 1..65535')

  const bot = createBot({
    host,
    port,
    version,
    auth: identity.auth,
    username: identity.username,
    profilesFolder: identity.profilesFolder ?? null,
    authTitle: identity.authTitle ?? null,
    deviceType: identity.deviceType ?? null,
    logStream: null
  })

  const frames = []
  const playFrames = []
  bot.client.on('packet', (data, meta) => {
    const state = meta?.state ?? null
    const name = meta?.name ?? null
    if (state === null || name === null) return
    frames.push({ state, name })
    if (state === 'play') playFrames.push({ name, data })
  })

  return {
    label,
    endpoint: host + ':' + port,
    version,
    identity,
    bot,
    frames,
    playFrames,
    ready: timeoutMs => bot.ready(timeoutMs),
    close: () => bot.close()
  }
}

// The run record the comparison reads. A join that never reached play carries
// its error, so the report can say why instead of reporting an empty side.
function summarizeRun (join, error) {
  const byState = { login: 0, configuration: 0, play: 0 }
  for (const frame of join.frames) byState[frame.state] = (byState[frame.state] ?? 0) + 1
  return {
    label: join.label,
    endpoint: join.endpoint,
    version: join.version,
    auth: join.identity.auth,
    username: join.identity.username,
    frames: join.frames,
    playFrames: join.playFrames,
    byState,
    errors: join.bot.received.errors,
    leftovers: join.bot.received.leftovers.length,
    ended: join.bot.received.ended,
    error: error ?? null
  }
}

// One join, recorded, then closed: the endpoint lane's shape. Two connections of
// one Microsoft account must not be open at once, because the server kicks the
// first one, so a real target is measured one join at a time.
export async function recordJoin ({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  quietMs = DEFAULT_QUIET_MS,
  maxCollectMs = DEFAULT_MAX_COLLECT_MS,
  log = () => {},
  ...options
} = {}) {
  const join = startJoin({ ...options, log })
  let error = null
  try {
    await join.ready(timeoutMs)
    await settled(join.frames, { quietMs, maxMs: maxCollectMs })
  } catch (failure) {
    error = String(failure?.message ?? failure).slice(0, 300)
  } finally {
    try { await join.close() } catch { /* the recording is what mattered */ }
  }
  const run = summarizeRun(join, error)
  log(join.label + 'Recorded', { endpoint: join.endpoint, frames: join.frames.length, error })
  return run
}

// The fake lane's shape: both clients attached at once, so a churn frame reaches
// each of them through its own path — the direct client from the backend, the
// proxied client through the relay. A sequential pair would let the proxy replay
// the churn instead, and the report would be comparing a cache with a server.
async function recordTogether ({
  lanes,
  version,
  identity,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  quietMs = DEFAULT_QUIET_MS,
  maxCollectMs = DEFAULT_MAX_COLLECT_MS,
  log = () => {}
}) {
  const direct = startJoin({ label: 'direct', host: lanes.backend.host, port: lanes.backend.port, version, identity, log })
  const proxied = startJoin({ label: 'proxied', host: lanes.front.host, port: lanes.front.port, version, identity, log })

  let error = null
  try {
    await Promise.all([direct.ready(timeoutMs), proxied.ready(timeoutMs)])
    await lanes.churn({ log })
    await Promise.all([
      settled(direct.frames, { quietMs, maxMs: maxCollectMs }),
      settled(proxied.frames, { quietMs, maxMs: maxCollectMs })
    ])
  } catch (failure) {
    error = String(failure?.message ?? failure).slice(0, 300)
  } finally {
    try { await direct.close() } catch { /* best effort */ }
    try { await proxied.close() } catch { /* best effort */ }
  }
  return [summarizeRun(direct, error), summarizeRun(proxied, error)]
}

// The state the fake lane sends to both clients after they are attached. Every
// frame is one the client-state model decodes, so the churn moves the decoded
// state as well as the frame list: a block, a full window, one slot, an entity
// that spawns and moves, server chat, and signed player chat.
const CHURN = Object.freeze({
  block: Object.freeze({ x: 3, y: 0, z: 3 }),
  entityId: 99,
  frames: Object.freeze([
    'play:block_change',
    'play:window_items',
    'play:set_slot',
    'play:spawn_entity',
    'play:rel_entity_move',
    'play:system_chat',
    'play:player_chat'
  ])
})

// The default lane: the repo's own fake backend, and a Monoplayer in front of
// it with the offline legs. Same construction as src/ladder/loopback.js, with
// one churn round instead of that rung's scenario.
async function startFakeLane ({ version, username, log = () => {} } = {}) {
  if (version !== FAKE_LANE_VERSION) {
    throw new Error(
      'the fake lane serves ' + FAKE_LANE_VERSION + ' only, got ' + version +
      '. Pass --backend and --front to measure a real server.'
    )
  }

  let fake = null
  let backendLeg = null
  let front = null
  let core = null

  // Close in the reverse order of construction, and always: every one of these
  // holds a listening socket, so a failed setup that leaks one hangs the run.
  const close = async () => {
    try { await front?.close?.() } catch { /* best effort */ }
    try { await backendLeg?.close?.() } catch { /* best effort */ }
    try { fake?.close?.() } catch { /* best effort */ }
  }

  try {
    fake = await createFakeBackend({ port: 0, logStream: null })
    const whitelist = [offlineUuid(username)]
    const config = loadConfig({
      version,
      attachWhitelist: whitelist,
      front: { host: '127.0.0.1', port: 0 },
      backend: { host: '127.0.0.1', port: fake.port },
      puppet: { username: 'GlowSquidye', uuid: offlineUuid('GlowSquidye') }
    })

    backendLeg = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: fake.port,
      version,
      username: 'GlowSquidye',
      log
    })
    // The wire checker is the loopback rung's business: this lane measures which
    // frame kinds reach each client, not whether the bytes parse.
    front = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version,
      offlineWhitelist: whitelist,
      wireMode: 'off',
      getSnapshotConfig: () => core.cache.snapshot().config
    })
    core = createMonoplayer({
      config,
      backendLeg,
      frontLeg: front,
      clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout }
    })

    front.setCoreAttachConfiguring(({ name, uuid }) => core.attachConfiguringPlayer({ name, uuid }))
    front.setClientSettingsHandler(settings => core.noteClientSettings(settings))
    front.setCoreAttach(({ name, uuid }) => core.attachPlayer({ name, uuid, includeConfig: false }))

    core.start()
    await backendLeg.connect()
    const readiness = await waitForReady({ core, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!readiness.warm) throw new Error('the puppet never reached the warm marker from chunk_batch_finished')
    const bound = await front.listen()
    const lane = {
      backend: { host: '127.0.0.1', port: fake.port },
      front: { host: '127.0.0.1', port: bound.port ?? front.port },
      chat: config.chat,
      churnFrames: null,
      // One round of state both clients must see. It never sends a transfer: the
      // proxy follows a transfer, and the one the fake backend names is the live
      // Excalia fleet, which no automated join may touch.
      churn: async ({ log: laneLog = log } = {}) => {
        const items = Array.from({ length: INVENTORY_SLOTS }, emptySlot)
        items[36] = itemStack(1, 1)
        fake.sendBlockChange(CHURN.block)
        fake.sendWindowItems({ windowId: 0, stateId: 1, items })
        fake.sendSetSlot({ windowId: 0, stateId: 1, slot: 40, item: itemStack(2, 3) })
        fake.sendSpawnEntity({ entityId: CHURN.entityId, x: 0, y: 64, z: 0 })
        fake.sendRelEntityMove({ entityId: CHURN.entityId, dx: 1 })
        fake.sendSystemChat('parity: server chat')
        fake.sendPlayerChat('parity: signed player chat')
        lane.churnFrames = CHURN.frames
        laneLog('churn', { frames: CHURN.frames })
        return CHURN.frames
      },
      close
    }
    return lane
  } catch (failure) {
    await close()
    throw failure
  }
}

// --- the command ---

export async function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(
      'usage: node src/ladder/client-parity.js [--backend HOST:PORT] [--front HOST:PORT]\n' +
      '                                       [--version V] [--auth offline|microsoft]\n' +
      '                                       [--username NAME] [--account SELECTOR]\n' +
      '                                       [--accounts DIR] [--report PATH]\n' +
      '                                       [--timeout MS] [--quiet MS] [--verbose]\n' +
      '\n' +
      'No endpoints: the repo\'s fake backend plus an in-process Monoplayer (offline).\n' +
      'Both given: the two joins only, against endpoints you stood up (dev lane,\n' +
      'transfer testbed, or a local port-forward). One of the two alone is a setup\n' +
      'error: a real backend needs a real proxy in front of it.\n'
    )
    return 0
  }

  const verbose = argv.includes('--verbose')
  const reportPath = flag(argv, '--report') ?? DEFAULT_REPORT
  const version = flag(argv, '--version') ?? process.env.MONOPLAYER_VERSION ?? DEFAULT_VERSION
  const auth = flag(argv, '--auth') ?? 'offline'
  const username = flag(argv, '--username') ?? DEFAULT_USERNAME
  const account = flag(argv, '--account') ?? process.env.MONOPLAYER_ATTACH_ACCOUNT ?? 'bafbi'
  const accountsDir = flag(argv, '--accounts') ?? process.env.MONOPLAYER_PUPPET_ACCOUNTS_DIR ?? '.secrets/accounts'
  const timeoutMs = Number(flag(argv, '--timeout') ?? DEFAULT_TIMEOUT_MS)
  const quietMs = Number(flag(argv, '--quiet') ?? DEFAULT_QUIET_MS)
  const log = verbose ? (event, fields = {}) => io.stderr.write('[parity] ' + event + ' ' + detail(fields) + '\n') : () => {}

  let backend = null
  let front = null
  try {
    backend = parseEndpoint(flag(argv, '--backend') ??
      joinEndpoint(process.env.MONOPLAYER_BACKEND_HOST, process.env.MONOPLAYER_BACKEND_PORT), '--backend')
    front = parseEndpoint(flag(argv, '--front') ??
      joinEndpoint(process.env.MONOPLAYER_FRONT_HOST, process.env.MONOPLAYER_FRONT_PORT), '--front')
    if ((backend === null) !== (front === null)) {
      throw new Error(
        'give both --backend and --front, or neither. One alone has no answer: a real ' +
        'backend needs a real proxy in front of it, and this harness never builds one ' +
        'with live legs.'
      )
    }
  } catch (failure) {
    io.stderr.write('parity: ' + String(failure?.message ?? failure) + '\n')
    return 2
  }

  let identity
  try {
    identity = auth === 'offline'
      ? { auth, username }
      : { auth, ...resolveBotIdentity({ accountsDir, selector: account }) }
  } catch (failure) {
    io.stderr.write('parity: ' + String(failure?.message ?? failure) + '\n')
    return 2
  }

  const startedAt = Date.now()
  let lanes = { backend, front, chat: null, close: async () => {} }
  if (backend === null) {
    if (identity.auth !== 'offline') {
      io.stderr.write('parity: the fake lane takes no account; use --auth offline, or give both endpoints\n')
      return 2
    }
    try {
      lanes = await startFakeLane({ version, username: identity.username, log })
    } catch (failure) {
      io.stderr.write('parity: ' + String(failure?.message ?? failure) + '\n')
      return 2
    }
  }

  try {
    const runs = lanes.churn
      ? await recordTogether({ lanes, version, identity, timeoutMs, quietMs, log })
      : [
          await recordJoin({
            label: 'direct', host: lanes.backend.host, port: lanes.backend.port,
            version, identity, timeoutMs, quietMs, log
          }),
          await recordJoin({
            label: 'proxied', host: lanes.front.host, port: lanes.front.port,
            version, identity, timeoutMs, quietMs, log
          })
        ]
    const [direct, proxied] = runs
    if (direct.error || proxied.error) {
      io.stderr.write('parity: a join did not complete: ' +
        [direct, proxied].filter(run => run.error).map(run => run.label + ': ' + run.error).join('; ') + '\n')
      return 2
    }

    // The fake lane is deterministic: the same backend script answers both
    // joins, so a count difference there is a frame lost or repeated. A real
    // server's counts drift with time, so there a count is evidence only.
    const deterministic = backend === null
    const comparison = compareRuns({ direct, proxied, deterministic })
    const report = {
      rung: 'client-parity',
      issue: 13,
      lane: deterministic ? 'fake' : 'endpoint',
      version,
      chat: lanes.chat,
      churn: lanes.churnFrames ?? null,
      passed: comparison.ok,
      durationMs: Date.now() - startedAt,
      sides: { direct: sideOf(direct), proxied: sideOf(proxied) },
      ...comparison
    }

    io.stdout.write(formatReport(report) + '\n')
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
      io.stdout.write('parity: report written to ' + reportPath + '\n')
    } catch (failure) {
      io.stderr.write('parity: could not write ' + reportPath + ': ' + String(failure?.message ?? failure) + '\n')
      return 2
    }
    return report.ok ? 0 : 1
  } finally {
    await lanes.close()
  }
}

function sideOf (run) {
  return {
    endpoint: run.endpoint,
    version: run.version,
    auth: run.auth,
    username: run.username,
    frames: run.byState,
    leftovers: run.leftovers,
    errors: run.errors,
    ended: run.ended
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}

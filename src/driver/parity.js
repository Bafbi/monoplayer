// Driver parity: the real client joins a backend directly, then the same client
// joins the same backend through the proxy, and one report separates the state
// differences the proxy explains from the ones it does not (issue #62).
//
// This is the client half of #13. `src/ladder/client-parity.js` measures which
// frames reach two protocol bots; this measures what two real vanilla clients
// ended up showing, which is the one thing a protocol bot cannot prove
// (docs/testing-ladder.md, rung 4). The report keeps #13's vocabulary and its
// exit codes, so one reader can read both.
//
// The comparison is field-shaped, not frame-shaped: the driver exposes client
// state through its `status` and `screen` ops and no packet stream, so there is
// no frame to key a row on. `src/ladder/observer.js` solved the same shape for
// the server view, and this module follows it: a fixed field list, a policy table
// of the differences the proxy explains, and everything else unexplained.
//
// No packet observer is used. The mod bans mixins into Connection, login/play
// handlers, codecs, and Netty (tools/driver/README.md), and #62 allows an
// observer only if a run with it off produces the same verdict. The report says
// `observer: 'none'` so that choice is visible rather than implied.
//
// Both runs are sequential on one account: a server kicks the first session when
// one account opens two, and the driver has no reconnect op, so a lane is a quit
// plus a host-side relaunch.
import { DriverError } from './client-driver.js'
import { describeStatus, isSettled } from './checks.js'

const DEFAULT_POLL_MS = 1000
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000
const DEFAULT_PORT_CLOSE_TIMEOUT_MS = 45_000

// The state fields the driver reports, in report order, with what the proxy
// predicts about each one. The policy is the code under test: a field marked
// `expected` carries the mechanism that explains a difference, and a field
// marked `same` fails the run when the two clients disagree.
//
// Two differences this lane accepts, both per-connection state that the attach
// replay takes from the puppeted session:
//
//   pose        the replay lands the client at the pose the session holds, and a
//               direct join lands where the server spawns it
//   inventory   the replay carries the puppeted inventory, so the held item and
//               the selected slot are the session's, not a fresh join's
//
// Render and chunk counts drift with timing on any lane that is not
// deterministic, so they are recorded as numbers and never compared for equality.
// `fps` is not a field at all: it measures the host, not the connection.
export const PARITY_FIELDS = Object.freeze([
  Object.freeze({ field: 'connected', policy: 'same' }),
  Object.freeze({ field: 'level', policy: 'same' }),
  Object.freeze({ field: 'player', policy: 'same' }),
  Object.freeze({ field: 'name', policy: 'same' }),
  Object.freeze({ field: 'health', policy: 'same' }),
  Object.freeze({ field: 'dimension', policy: 'same' }),
  Object.freeze({ field: 'screen', policy: 'same' }),
  Object.freeze({
    field: 'pos',
    policy: 'expected',
    reason: 'the attach replay lands the client at the pose the puppeted session holds, and a direct join lands where the server spawns it (src/ladder/client-parity.js STATE_REASONS.pose)'
  }),
  Object.freeze({
    field: 'held',
    policy: 'expected',
    reason: 'the attach replay serves the puppeted session inventory, so the held item is the session\'s rather than a fresh join\'s'
  }),
  Object.freeze({
    field: 'selectedSlot',
    policy: 'expected',
    reason: 'the same replay carries the puppeted session\'s selected hotbar slot'
  }),
  Object.freeze({
    field: 'loadedChunks',
    policy: 'expected',
    reason: 'the attach replay serves the chunk set the puppeted session already holds, and a direct join streams its own: the two counts measure two different joins, not one server (the observed run read 40 direct against 213 proxied)'
  }),
  Object.freeze({
    field: 'renderedSections',
    policy: 'expected',
    reason: 'rendered sections follow that chunk set and the client\'s own culling, and the settle predicate already requires a nonzero count'
  })
])

// The report's limitations, recorded in every run so a reader knows what the
// lane did not measure.
export const PARITY_LIMITATIONS = Object.freeze([
  'No packet observer: the driver reads client state and no frame stream, and tools/driver/README.md bans mixins into the packet path. Frame rows are rung 2a (mise run parity:run).',
  'Both runs use one account and run one after the other: two sessions of one account are kicked, and the driver has no reconnect op.',
  'Chat, dialogs, and the transfer loading screen are compared only as far as they change the current screen; the driver reads no chat history.',
  'No churn is applied: the lane compares two fresh joins. State the backend sends only on change, such as health after damage or inventory contents beyond the held slot, can only agree by default, so agreement here is not evidence that the relay carries later state. Rung 2a sends that churn.',
  'The client gamemode and world are the target\'s, so a survival target and a creative target are not comparable runs.'
])

// The targets this lane refuses, and why:
//
//   excalia.fr        the live fleet. This repo does not deploy it, so a
//                     difference there is not ours to explain
//                     (src/ladder/client-parity.js assertDeployableTarget).
//   the live front    deploy/manifests/service.yaml publishes the deployment at
//                     this Tailscale hostname, and joining it lands the client
//                     on the live fleet. Refusing the fleet and not its front
//                     would only hide the join one hop away.
//   a public tunnel   deploy/manifests/playit-agent.yaml carries a raw TCP port
//                     from playit.gg's edge to that same front (#202), so its
//                     address is a third route to the live fleet. The address is
//                     allocated at link time and no file here names it, so the
//                     rule is the provider's domain: any name under playit.gg.
//                     A paid tunnel can carry a custom domain, which no suffix
//                     can catch; AGENTS.md's rule covers that one.
//
// The rule is restated here instead of imported: src/ladder/client-parity.js
// pulls the whole service graph in at import time, and this module's tests are
// offline. test/driver/parity.test.js pins both rules against the two source
// files, so the copies cannot drift apart silently.
export const LIVE_FLEET_HOST = 'excalia.fr'
export const LIVE_FRONT_HOST = 'glowsquidye.tail41e568.ts.net'
export const LIVE_TUNNEL_DOMAIN = 'playit.gg'

function refused (host) {
  const name = String(host ?? '').trim().toLowerCase()
  if (name === LIVE_FLEET_HOST || name.endsWith('.' + LIVE_FLEET_HOST)) {
    return host + ' is the live Excalia fleet. This lane only runs against servers this repo deploys: ' +
      'the dev lane and the transfer testbed.'
  }
  if (name === LIVE_FRONT_HOST || name.endsWith('.' + LIVE_FRONT_HOST)) {
    return host + ' is the live deployment\'s front (deploy/manifests/service.yaml). Joining it lands the ' +
      'client on the live Excalia fleet, which no automated join may touch.'
  }
  if (name === LIVE_TUNNEL_DOMAIN || name.endsWith('.' + LIVE_TUNNEL_DOMAIN)) {
    return host + ' is a public tunnel (deploy/manifests/playit-agent.yaml). Its far end is the live ' +
      'deployment, so joining it lands the client on the live Excalia fleet, which no automated join may touch.'
  }
  return null
}

// HOST:PORT for one parity lane, refused when it names a server this repo does
// not deploy. The port is validated here so a typo is a setup error (exit 2), not
// a join that times out.
export function parseParityEndpoint (text, label = 'endpoint') {
  if (text === undefined || text === null || text === '') {
    throw new Error(label + ' must be HOST:PORT, got ' + JSON.stringify(String(text)))
  }
  const separator = String(text).lastIndexOf(':')
  if (separator < 0) throw new Error(label + ' must be HOST:PORT, got ' + JSON.stringify(String(text)))
  const host = String(text).slice(0, separator)
  const port = Number(String(text).slice(separator + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' needs a port in 1..65535, got ' + JSON.stringify(String(text).slice(separator + 1)))
  }
  const refusal = refused(host)
  if (refusal !== null) throw new Error(refusal)
  return { host: host.trim().toLowerCase(), port, endpoint: host.trim().toLowerCase() + ':' + port }
}

const absent = value => value === undefined || value === null
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

// Does the address the client reports match the endpoint the lane asked for?
//
// A hostname endpoint resolves to an address the client reports, so the host is
// only compared when the caller gave a literal address. The port is always
// compared: it is what tells the direct lane from the proxied one behind two
// tunnels on loopback.
//
// `null` means "not reported", which is what an older driver jar answers.
export function sameEndpoint (reported, requested) {
  if (!reported) return null
  const split = text => {
    const at = String(text).lastIndexOf(':')
    if (at < 0) return null
    const port = Number(String(text).slice(at + 1))
    if (!Number.isInteger(port)) return null
    return { host: String(text).slice(0, at).trim().toLowerCase(), port }
  }
  const left = split(reported)
  const right = split(requested)
  if (!left || !right) return false
  if (left.port !== right.port) return false
  return IPV4.test(right.host) ? left.host === right.host : true
}

// One observation per lane, in the report's own vocabulary. The screen is
// reduced to the parts a reader can judge: which screen, its title, and the
// reason a disconnect screen shows.
export function observeClient (status, screen = null) {
  if (!status || typeof status !== 'object') throw new TypeError('a driver status payload is required')
  const pos = status.pos && typeof status.pos === 'object'
    ? { x: round(status.pos.x), y: round(status.pos.y), z: round(status.pos.z) }
    : null
  const active = screen && typeof screen === 'object' ? screen : null
  return {
    connected: status.connected === true,
    level: status.level === true,
    player: status.player === true,
    name: status.name ?? null,
    health: absent(status.health) ? null : status.health,
    dimension: status.dimension ?? null,
    screen: active === null
      ? null
      : {
          screen: active.screen ?? 'none',
          title: active.title ?? null,
          narration: active.narration ?? null,
          reason: active.reason ?? null
        },
    pos,
    held: status.held ?? null,
    selectedSlot: absent(status.selectedSlot) ? null : status.selectedSlot,
    loadedChunks: absent(status.loadedChunks) ? null : status.loadedChunks,
    renderedSections: absent(status.renderedSections) ? null : status.renderedSections
  }
}

// Positions move in hundredths of a block, and a report full of float noise hides
// the difference a reader is looking for.
function round (value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null
}

const POLICY = new Map(PARITY_FIELDS.map(entry => [entry.field, entry]))

// Why a `same` field disagrees. It names both observations, so a reader can
// judge the finding without opening the raw report.
function mismatchReason (field, left, right) {
  return field + ' is state the proxy does not explain: the direct client saw ' +
    JSON.stringify(left) + ' and the proxied client saw ' + JSON.stringify(right)
}

// The comparison. `direct` and `proxied` are two observeClient() records.
export function compareParity ({ direct, proxied } = {}) {
  if (!direct || !proxied) throw new TypeError('two client observations are required')
  const fields = PARITY_FIELDS.map(({ field, policy, reason }) => {
    const left = direct[field]
    const right = proxied[field]
    let verdict
    if (absent(left) && absent(right)) verdict = 'same'
    else if (absent(left) || absent(right)) verdict = 'unexplained'
    else if (same(left, right)) verdict = 'same'
    else if (policy === 'expected') verdict = 'expected'
    else verdict = 'unexplained'
    const row = { field, direct: left ?? null, proxied: right ?? null, verdict }
    if (verdict === 'expected') row.reason = reason
    if (verdict === 'unexplained') row.reason = mismatchReason(field, left ?? null, right ?? null)
    return row
  })

  const counts = { same: 0, expected: 0, unexplained: 0 }
  for (const row of fields) counts[row.verdict]++
  const unexplained = fields.filter(row => row.verdict === 'unexplained')
  return { ok: unexplained.length === 0, fields, counts, unexplained }
}

export function formatParityReport (report) {
  const lines = []
  for (const side of ['direct', 'proxied']) {
    const run = report.sides?.[side]
    if (!run) continue
    lines.push(side + ' ' + run.endpoint + ': ' +
      (run.error ? 'did not settle — ' + run.error
        : 'settled in ' + Math.round((run.settleMs ?? 0) / 1000) + 's, observer ' + (report.observer ?? 'none')))
  }
  lines.push('')
  for (const row of report.fields) {
    const mark = row.verdict === 'unexplained' ? 'FAIL' : row.verdict.toUpperCase()
    const reason = row.reason ? ' — ' + row.reason : ''
    lines.push(mark.padEnd(12) + ' ' + row.field + ': direct=' + JSON.stringify(row.direct) +
      ' proxied=' + JSON.stringify(row.proxied) + reason)
  }
  lines.push('')
  const counts = report.counts
  lines.push(report.passed
    ? 'driver-parity: PASS ' + report.fields.length + ' fields, ' + counts.same + ' same, ' +
      counts.expected + ' expected, 0 unexplained'
    : 'driver-parity: FAIL ' + report.unexplained.length + ' unexplained: ' +
      report.unexplained.map(row => row.field).join(', '))
  return lines.join('\n')
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Poll the driver until the client is in the world. A join that lands on a
// disconnect or error screen never settles, so the loop returns the status it
// last saw and the caller records the screen as evidence.
async function waitSettled ({ driver, timeoutMs, pollMs, now, sleep, log }) {
  const deadline = now() + timeoutMs
  let last = null
  let lastError = null
  let polls = 0
  while (now() < deadline) {
    polls++
    try {
      const envelope = await driver.request('status', {}, { timeoutMs: 5000 })
      lastError = null
      last = envelope.ok ? envelope.data : { error: envelope.error, connected: null }
      if (isSettled(last)) return { status: last, polls, screen: null }
    } catch (error) {
      lastError = error
      last = null
    }
    await sleep(pollMs)
  }
  const where = last ? describeStatus(last) : 'last error: ' + (lastError?.message ?? 'none')
  // The screen on the last poll is what explains a refusal or a kick; without it
  // the lane reports a bare timeout and the operator relaunches to find out.
  let shown = ''
  try {
    const envelope = await driver.request('screen', {}, { timeoutMs: 5000 })
    if (envelope.ok && envelope.data?.screen && envelope.data.screen !== 'none') {
      const title = envelope.data.title ? ' "' + envelope.data.title + '"' : ''
      const reason = envelope.data.reason ? ': ' + envelope.data.reason : ''
      shown = '; screen ' + envelope.data.screen + title + reason
    }
  } catch { /* the timeout is the finding; a screen read is a bonus */ }
  throw new Error('the client did not settle within ' + timeoutMs + ' ms (' + where + shown + ')')
}

// Wait until the driver port stops answering. The tunnel keeps the local port
// accepting even when the client is gone, so "closed" is a connect failure, and
// only a connect failure counts: a timeout means something is still there.
async function waitPortClosed ({ driver, timeoutMs, sleep, now }) {
  const deadline = now() + timeoutMs
  let lastError = null
  while (now() < deadline) {
    try {
      await driver.request('status', {}, { timeoutMs: 4000 })
      await sleep(500)
    } catch (error) {
      lastError = error
      if (error?.code === 'connect') return { closed: true }
      await sleep(500)
    }
  }
  return { closed: false, error: lastError?.message ?? 'the port still answered after ' + timeoutMs + ' ms' }
}

// Quit whatever client holds the driver socket, so every lane starts from a fresh
// process. An unreachable socket means no client is running, which is the
// ordinary case between lanes.
async function quitExisting ({ driver, timeoutMs, sleep, now, log, graceMs = 10_000 }) {
  const deadline = now() + graceMs
  let lastError = null
  while (now() < deadline) {
    try {
      const status = await driver.request('status', {}, { timeoutMs: 4000 })
      if (!status.ok) return { quit: false, detail: 'the driver refused status: ' + status.error }
      const envelope = await driver.request('quit', {}, { timeoutMs: 10_000 })
      if (!envelope.ok) throw new Error('driver quit failed: ' + envelope.error)
      const closed = await waitPortClosed({ driver, timeoutMs, sleep, now })
      if (!closed.closed) {
        // A second client cannot bind the driver port, so launching over a live
        // one would measure the old client and crash the new one.
        throw new Error('a client answered the socket and did not quit: ' + closed.error)
      }
      return { quit: true, detail: 'previous client quit' }
    } catch (error) {
      lastError = error
      // The tunnel takes a moment to bind, so "nothing listening" is not an
      // answer yet. Any other failure means a socket answered and broke, which
      // must not be mistaken for an empty lane.
      if (error?.code === 'connect') { await sleep(500); continue }
      throw new Error('the driver socket answered and then failed: ' + (error?.message ?? error))
    }
  }
  return { quit: false, detail: 'no client answered the driver socket (' + (lastError?.message ?? 'no attempt') + ')' }
}

// One lane: fresh client joined to the endpoint, wait for it to settle, read its
// state, then put the socket back to rest.
async function runLane ({ label, endpoint, driver, relaunch, now, sleep, log, timeoutMs, pollMs, portCloseTimeoutMs }) {
  const started = now()
  const quit = await quitExisting({ driver, timeoutMs: portCloseTimeoutMs, sleep, now, log })
  log(label + ': ' + quit.detail)
  await relaunch(endpoint)
  const settled = await waitSettled({ driver, timeoutMs, pollMs, now, sleep, log })
  const server = settled.status.server ?? null
  const joinMatches = sameEndpoint(server, endpoint)
  if (joinMatches === false) {
    throw new Error('the client joined ' + server + ', not ' + endpoint +
      ': the run would compare state measured on another server')
  }
  const screenEnvelope = await driver.request('screen', {}, { timeoutMs: 10_000 })
  const screen = screenEnvelope.ok ? screenEnvelope.data : null
  const observed = observeClient(settled.status, screen)
  const quitAfter = await driver.request('quit', {}, { timeoutMs: 10_000 })
  if (!quitAfter.ok) throw new Error('driver quit failed: ' + quitAfter.error)
  const closed = await waitPortClosed({ driver, timeoutMs: portCloseTimeoutMs, sleep, now })
  if (!closed.closed) log(label + ': the port still answered after quit: ' + closed.error)
  return { endpoint, server, joinMatches, observed, settleMs: now() - started, polls: settled.polls, screen }
}

// The lane body. Adapters are injected so the orchestration is testable without a
// socket, a host, or a client:
//
//   driver    the NDJSON client for 127.0.0.1:25599 (src/driver/client-driver.js)
//   relaunch  async endpoint => starts a fresh client joined to that endpoint
//   sleep, now  timing
export async function runParity ({
  driver,
  relaunch,
  direct,
  proxied,
  version = null,
  timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  portCloseTimeoutMs = DEFAULT_PORT_CLOSE_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {}
} = {}) {
  if (!driver) throw new TypeError('a driver client is required')
  if (typeof relaunch !== 'function') throw new TypeError('a relaunch adapter is required')
  for (const [label, target] of [['direct', direct], ['proxied', proxied]]) {
    if (!target || typeof target.endpoint !== 'string') throw new TypeError(label + ' needs an endpoint')
  }

  const started = now()
  const sides = {}
  for (const [label, target] of [['direct', direct], ['proxied', proxied]]) {
    try {
      sides[label] = await runLane({
        label, endpoint: target.endpoint, driver, relaunch, now, sleep, log,
        timeoutMs, pollMs, portCloseTimeoutMs
      })
      log(label + 'Settled', { endpoint: target.endpoint, observed: sides[label].observed })
    } catch (error) {
      const message = error instanceof DriverError ? error.message : String(error?.message ?? error)
      sides[label] = { endpoint: target.endpoint, observed: null, settleMs: null, error: message.slice(0, 300) }
      log(label + 'Failed', { error: message })
    }
  }

  const bothSettled = sides.direct.observed !== null && sides.proxied.observed !== null
  const comparison = bothSettled
    ? compareParity({ direct: sides.direct.observed, proxied: sides.proxied.observed })
    : { ok: false, fields: [], counts: { same: 0, expected: 0, unexplained: 0 }, unexplained: [] }

  return {
    rung: 'driver-parity',
    issue: 62,
    lane: 'driver',
    // The choice AC4 conditions on: no observer was built, so there is nothing
    // to disable and no verdict to double-check.
    observer: 'none',
    version,
    passed: bothSettled && comparison.ok,
    setupFailed: !bothSettled,
    durationMs: now() - started,
    sides,
    limitations: [...PARITY_LIMITATIONS],
    ...comparison
  }
}

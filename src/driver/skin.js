// The skin three-case measurement (#99), run on the dev lane with a real 26.2
// client.
//
// The question the ticket had to answer before any code: does a 26.x client
// accept a `textures` property Mojang signed for a *different* profile UUID,
// when the proxy attaches it to the human's own UUID? Three cases, one fresh
// client each:
//
//   control    no injection. What the human's own body renders today.
//   signed     the puppet's texture property, signature included, for the
//              human's UUID.
//   unsigned   the same property with the signature removed.
//
// The verdict is the texture the client resolved for the player it controls.
// A skin the client accepted resolves to `minecraft:skins/<hash>`; one it
// rejected resolves to a vanilla default, `minecraft:textures/entity/player/
// (wide|slim)/<name>.png`. Both are read through the driver's `skin` op, and a
// third-person screenshot is kept as the human-visible half of the evidence.
//
// The injected frame is the frame the product would write: `skinPlayerInfoPacket`
// from src/core/skin.js, serialized with the same protocol data the proxy
// serializes with. The driver decodes it with the client's own codec and hands it
// to the client's own packet listener, so the client validates it exactly as it
// validates a frame from a server.
import mc from 'minecraft-protocol'
import { pickTextures, skinPlayerInfoPacket, withoutSignature } from '../core/skin.js'
import { describeStatus, isSettled } from './checks.js'
import { DriverError } from './client-driver.js'

export const SKIN_CASES = Object.freeze(['control', 'signed', 'unsigned'])

const DEFAULT_POLL_MS = 1000
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000
const DEFAULT_PORT_CLOSE_TIMEOUT_MS = 45_000

// A vanilla default skin, which is what the client draws when it accepted no
// property. Named as a shape rather than a list, so a 26.x default added later
// still reads as a default.
export const DEFAULT_SKIN_BODY = /^minecraft:textures\/entity\/player\/(?:wide|slim)\/[a-z0-9_]+\.png$/

// The skin the client downloaded from a textures property.
export const PROPERTY_SKIN_BODY = /^minecraft:skins\/[0-9a-f]{40}$/

export function isDefaultSkinBody (path) {
  return typeof path === 'string' && DEFAULT_SKIN_BODY.test(path)
}

// One frame, as the client receives it: the payload without its packet id,
// because the driver decodes with the packet's own stream codec. The id and the
// name are read back off the full frame first, so a frame this repo cannot parse
// never reaches a client.
export function skinFrame ({ version = '26.2', packet, serialize = defaultSerialize } = {}) {
  const full = serialize(version, packet)
  const { id, payload } = splitPacketId(full)
  return { id, name: 'player_info', payload, full }
}

function defaultSerialize (version, params) {
  const serializer = mc.createSerializer({ state: 'play', isServer: true, version })
  return serializer.createPacketBuffer({ name: 'player_info', params })
}

// A varint packet id, then the body.
export function splitPacketId (buffer) {
  let value = 0
  let shift = 0
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { id: value, payload: buffer.subarray(i + 1) }
    shift += 7
    if (shift > 35) break
  }
  throw new Error('frame has no packet id terminator')
}

// The player the client controls, and the puppet beside it, out of one `skin`
// payload. Named by the client's own report rather than assumed: the human's
// UUID is whichever entry the client says it controls.
export function readSkinContext (payload) {
  const self = payload?.self ?? null
  if (self === null) throw new Error('the driver reported no player: not in a world')
  const players = Array.isArray(payload.players) ? payload.players : []
  const puppet = players.find(player => player.uuid !== self.uuid) ?? null
  return { self, puppet, players }
}

// Which kind of skin a texture path is: the default the client falls back to,
// or one it downloaded from a textures property. Recorded beside the path so a
// report survives redaction of the 40-hex texture name.
export function skinBodyKind (path) {
  if (isDefaultSkinBody(path)) return 'default'
  if (PROPERTY_SKIN_BODY.test(path)) return 'property'
  return path === null ? null : 'other'
}

// What one case proved, from the two skin readings.
export function caseVerdict ({ caseName, before, after, injected }) {
  const beforeBody = before?.self?.skin?.body ?? null
  const afterBody = after?.self?.skin?.body ?? null
  const row = {
    case: caseName,
    before: beforeBody,
    after: afterBody,
    beforeKind: skinBodyKind(beforeBody),
    afterKind: skinBodyKind(afterBody),
    beforeModel: before?.self?.skin?.model ?? null,
    afterModel: after?.self?.skin?.model ?? null,
    afterSecure: after?.self?.skin?.secure ?? null,
    changed: beforeBody !== afterBody,
    accepted: false,
    reason: null
  }
  if (caseName === 'control') {
    // The control says what the client shows when this run injects nothing. It
    // is the baseline for the ticket's question, and with the product switch on
    // it is also the product's own reading: the proxy wrote the entry, not us.
    row.reason = isDefaultSkinBody(afterBody)
      ? 'no injection: the client draws a vanilla default skin on the body it controls'
      : 'no injection: the client resolved ' + afterBody +
        ' for the body it controls, so something other than this run gave it an entry (skin.showPuppetSkin is on)'
    row.accepted = !isDefaultSkinBody(afterBody)
    return row
  }
  if (injected !== true) {
    row.reason = 'the injection was not delivered, so this case measured the control'
    return row
  }
  if (PROPERTY_SKIN_BODY.test(afterBody)) {
    row.accepted = true
    row.reason = 'the client resolved the injected property: ' + afterBody
    return row
  }
  row.reason = 'the client fell back to ' + afterBody + ' after the injection'
  row.accepted = false
  return row
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Poll until the client is in the world, so a case never reads a loading screen
// as a skin.
async function waitSettled ({ driver, timeoutMs, pollMs, now, sleep }) {
  const deadline = now() + timeoutMs
  let last = null
  while (now() < deadline) {
    try {
      const envelope = await driver.request('status', {}, { timeoutMs: 5000 })
      last = envelope.ok ? envelope.data : null
      if (last !== null && isSettled(last)) return last
    } catch { /* the client is still starting; keep waiting */ }
    await sleep(pollMs)
  }
  throw new Error('the client did not settle within ' + timeoutMs + ' ms (' +
    (last === null ? 'no status' : describeStatus(last)) + ')')
}

async function quitExisting ({ driver, timeoutMs, sleep, now }) {
  const deadline = now() + 10_000
  while (now() < deadline) {
    try {
      const status = await driver.request('status', {}, { timeoutMs: 4000 })
      if (!status.ok) return { quit: false, detail: 'the driver refused status: ' + status.error }
      const envelope = await driver.request('quit', {}, { timeoutMs: 10_000 })
      if (!envelope.ok) throw new Error('driver quit failed: ' + envelope.error)
      const closed = await waitPortClosed({ driver, timeoutMs, sleep, now })
      if (!closed.closed) throw new Error('a client answered the socket and did not quit: ' + closed.error)
      return { quit: true, detail: 'previous client quit' }
    } catch (error) {
      if (error?.code === 'connect') { await sleep(500); continue }
      throw error
    }
  }
  return { quit: false, detail: 'no client answered the driver socket' }
}

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

// One case: a fresh client joined to `endpoint`, the skin it starts with, the
// injection the case calls for, the skin it ends with, and a third-person
// screenshot. Nothing is reused between cases: an entry the client already holds
// wins over an injected one, so a second injection on one client would measure
// the first.
export async function runSkinCase ({
  caseName,
  driver,
  relaunch,
  screenshotFetch = null,
  endpoint,
  version = '26.2',
  serialize = defaultSerialize,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  portCloseTimeoutMs = DEFAULT_PORT_CLOSE_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {}
} = {}) {
  if (!SKIN_CASES.includes(caseName)) throw new TypeError('unknown skin case: ' + caseName)
  if (!driver) throw new TypeError('a driver client is required')
  if (typeof relaunch !== 'function') throw new TypeError('a relaunch adapter is required')
  if (!endpoint) throw new TypeError('an endpoint is required')

  const quit = await quitExisting({ driver, timeoutMs: portCloseTimeoutMs, sleep, now })
  log(caseName + ': ' + quit.detail)
  await relaunch(endpoint)
  const settled = await waitSettled({ driver, timeoutMs: settleTimeoutMs, pollMs, now, sleep })

  const beforeEnvelope = await driver.request('skin', {}, { timeoutMs: 15_000 })
  if (!beforeEnvelope.ok) throw new DriverError('driver skin failed: ' + beforeEnvelope.error)
  const before = beforeEnvelope.data
  const { self, puppet } = readSkinContext(before)

  let injection = null
  let injected = false
  if (caseName !== 'control') {
    const property = pickTextures(puppet === null ? [] : puppet.textures)
    if (property === null) {
      throw new Error('the client holds no textures property for the puppet, so there is nothing to inject')
    }
    const sent = caseName === 'unsigned' ? withoutSignature(property) : property
    const packet = skinPlayerInfoPacket({ uuid: self.uuid, name: self.name, property: sent })
    const frame = skinFrame({ version, packet, serialize })
    const envelope = await driver.request('inject_player_info', { hex: frame.payload.toString('hex') }, { timeoutMs: 15_000 })
    if (!envelope.ok) throw new DriverError('driver inject_player_info failed: ' + envelope.error)
    injection = { ...envelope.data, frame: { id: frame.id, name: frame.name, bytes: frame.full.length, payloadBytes: frame.payload.length } }
    injected = injection.delivered === true
    log(caseName + ': injected', { actions: injection.actions, entries: injection.entries })
    // The client resolves a new entry's skin on the next frame it draws, and a
    // texture it has not cached is downloaded first.
    await sleep(2000)
  }

  const afterEnvelope = await driver.request('skin', {}, { timeoutMs: 15_000 })
  if (!afterEnvelope.ok) throw new DriverError('driver skin failed: ' + afterEnvelope.error)
  const after = afterEnvelope.data

  // Third person, so the screenshot shows the body rather than a hand.
  await driver.request('perspective', { mode: 'third_back' }, { timeoutMs: 10_000 })
  await sleep(1500)
  let screenshot = null
  if (screenshotFetch !== null) {
    const shot = await driver.request('screenshot', {}, { timeoutMs: 20_000 })
    if (!shot.ok) throw new DriverError('driver screenshot failed: ' + shot.error)
    const artifact = await screenshotFetch(shot.data.path)
    screenshot = { remotePath: shot.data.path, ...artifact }
  }

  const verdict = caseVerdict({ caseName, before, after, injected })
  const listed = injection === null
    ? null
    : (injection.entries ?? []).some(entry => entry.listed === true)
  return {
    case: caseName,
    endpoint,
    settled: { server: settled.server ?? null, name: settled.name ?? null },
    before: { self: before.self, players: before.players },
    injection,
    after: { self: after.self, players: after.players },
    verdict,
    tabList: { entryListed: listed, humanUuid: self.uuid },
    screenshot
  }
}

// The three cases, in the order that tells the story: what the client shows with
// no injection, then the two properties.
export const SKIN_LIMITATIONS = Object.freeze([
  'One real client and one account: the human is whoever the display host is signed in as, and the cases run one after the other because a second client of the same account is kicked.',
  'The measurement is the client resolving a skin, not a person recognizing one: the texture path the client reports is the verdict, and the third-person screenshot is the human-visible half.',
  'The injected frame is built by the runner with the same protocol data and the same packet shape the proxy uses, and delivered through the client\'s own codec and listener. It is not the proxy: only a dev-lane run measures the product path.'
])

export async function runSkinLane ({
  driver,
  relaunch,
  screenshotFetch = null,
  endpoint,
  cases = SKIN_CASES,
  version = '26.2',
  serialize = defaultSerialize,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  portCloseTimeoutMs = DEFAULT_PORT_CLOSE_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {}
} = {}) {
  const started = now()
  const rows = []
  for (const caseName of cases) {
    rows.push(await runSkinCase({
      caseName, driver, relaunch, screenshotFetch, endpoint, version, serialize,
      settleTimeoutMs, pollMs, portCloseTimeoutMs, sleep, now, log
    }))
  }
  const byName = new Map(rows.map(row => [row.case, row]))
  const signed = byName.get('signed') ?? null
  const unsigned = byName.get('unsigned') ?? null
  const control = byName.get('control') ?? null
  // The answer the ticket asked for, stated from the measurement and only when
  // the case that answers it actually ran.
  const answer = signed === null
    ? 'not measured'
    : signed.verdict.accepted ? 'accepted' : 'rejected'
  return {
    rung: 'driver-skin',
    issue: 99,
    lane: 'dev',
    version,
    endpoint,
    passed: signed === null ? false : signed.verdict.accepted === true,
    durationMs: now() - started,
    answer,
    unsignedAccepted: unsigned === null ? null : unsigned.verdict.accepted === true,
    controlBody: control === null ? null : control.verdict.after,
    cases: rows,
    limitations: [...SKIN_LIMITATIONS]
  }
}

export function formatSkinReport (report) {
  const lines = []
  lines.push('skin answer: ' + report.answer +
    (report.unsignedAccepted === null ? '' : ', unsigned ' + (report.unsignedAccepted ? 'accepted' : 'rejected')))
  if (report.controlBody !== null) lines.push('control (no injection): ' + report.controlBody)
  for (const row of report.cases) {
    lines.push((row.verdict.accepted || row.case === 'control' ? 'PASS' : 'FAIL').padEnd(5) + ' ' +
      row.case.padEnd(9) + ' ' + row.verdict.before + ' -> ' + row.verdict.after + ' — ' + row.verdict.reason)
    if (row.screenshot !== null) lines.push('      screenshot: ' + (row.screenshot.localPath ?? row.screenshot.remotePath))
  }
  lines.push(report.passed ? 'driver-skin: PASS (' + report.cases.length + ' cases)' : 'driver-skin: FAIL')
  return lines.join('\n')
}

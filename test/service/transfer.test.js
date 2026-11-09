// Transfer handling. The transfer frame never crosses to the front. With a
// client attached, the client keeps its connection and re-enters configuration
// with the target's state (#22); with nobody attached the puppet moves alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const BUFFER = name => Buffer.from(`backend:${name}`)

function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) { const t = { fn, fires: now + ms }; timers.push(t); return t },
    clearTimeout (t) { timers = timers.filter(x => x !== t) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

function makeCore (config = {}) {
  const clock = fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER],
      ...config,
      transfer: { ...DEFAULT_CONFIG.transfer, ...(config.transfer ?? {}) }
    },
    backendLeg,
    frontLeg,
    clock
  })
  core.start()
  const events = []
  core.on('reconnect_due', event => events.push(event))
  return { clock, backendLeg, frontLeg, core, events }
}

// The kept-connection path (#22) is opt-in, so the seamless tests turn it on.
function makeSeamless (config = {}) {
  return makeCore({
    ...config,
    transfer: { ...(config.transfer ?? {}), keepConnection: true }
  })
}

function warmBackend ({ backendLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  for (const frame of [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backendLeg.deliver({ state: 'play', ...frame })
  assert.equal(core.cache.warm, true)
}

function attach ({ frontLeg, core }) {
  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  const result = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(result.attached, true)
  return result
}

function transfer (host = 'sky-2.excalia.fr', port = 25565) {
  return { name: 'transfer', buffer: BUFFER('transfer'), data: { host, port } }
}

// The target answered: its configuration phase, the client's finish, then its
// play login and join state. The client keeps the connection it had.
function landOnTarget ({ backendLeg, frontLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.equal(core.clientReconfiguring, true, 'the client re-entered configuration')
  backendLeg.deliver({ state: 'configuration', name: 'select_known_packs', data: {} })
  backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(core.clientReconfiguring, false, 'the client is back in play')
  backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 7 } })
  backendLeg.deliver({ state: 'play', name: 'game_state_change', data: { reason: 13, gameMode: 0 } })
  backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 0, z: 0 } })
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', data: {} })
  assert.equal(core.session.state, 'attached')
}

// The refusal notice reaches the client as an advancement toast (#15): the add
// carries the text, and the removal names the id it added. The toast's own
// shape is proved in test/core/notice.test.js.
function assertNotice (frontLeg, pattern) {
  const frames = frontLeg.frames()
  const add = frames.at(-2)
  const remove = frames.at(-1)
  assert.equal(add.name, 'advancements')
  assert.equal(remove.name, 'advancements')
  const display = add.packet.advancementMapping[0].value.displayData
  assert.match(display.description.value.text.value, pattern)
  assert.deepEqual(remove.packet.identifiers, [add.packet.advancementMapping[0].key])
}

test('a followed transfer keeps the client and waits for the target before any loading screen', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  const framesBefore = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', ...transfer() })

  assert.equal(rig.frontLeg.frames().length, framesBefore, 'the transfer frame never crosses')
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.core.metrics.transfersSeamless, 1)
  assert.equal(rig.backendLeg.ended, 1, 'the old backend leg is ended')
  assert.equal(rig.core.session.state, 'transferring')
  assert.equal(rig.core.attached, true, 'the client keeps its connection')
  assert.deepEqual(rig.frontLeg.endReasons(), [], 'no kick for a move the client can follow')
  assert.equal(rig.core.cache.warm, false, 'the old session cache is gone')
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect')

  rig.clock.tick(1000)
  assert.equal(rig.events.length, 1)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
  assert.deepEqual(rig.frontLeg.reconfigurations(), [], 'no configuration before the target answers')

  // The target's first configuration frame is what starts the loading screen:
  // the client re-enters configuration on its own connection and the frame is
  // relayed in that state.
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.deepEqual(rig.frontLeg.reconfigurations(), [{ reason: 'transfer' }])
  assert.equal(rig.core.metrics.reconfigurationsStarted, 1)
  const relayed = rig.frontLeg.frames().slice(framesBefore)
  assert.deepEqual(relayed.map(frame => frame.name), ['registry_data'])
  assert.equal(relayed[0].meta.state, 'configuration')
})

test('the same connection lands on the target: configuration, finish, login, state', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const mark = rig.frontLeg.frames().length

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  landOnTarget(rig)

  const crossed = rig.frontLeg.frames().slice(mark)
  const names = crossed.map(frame => frame.name)
  // The client's own start_configuration is the front leg's write, not a
  // relayed frame, so the first crossed frame is the target's configuration.
  assert.deepEqual(names.slice(0, 3), ['registry_data', 'select_known_packs', 'finish_configuration'])
  assert.ok(names.includes('login'), 'the target play login reaches the client')
  assert.ok(names.includes('game_state_change'))
  assert.ok(names.includes('map_chunk'))
  assert.equal(crossed.filter(frame => frame.name === 'transfer').length, 0)
  assert.equal(crossed.filter(frame => frame.name === 'login').length, 1, 'one play login')
  assert.equal(rig.core.metrics.reconfigurationsCompleted, 1)
  assert.equal(rig.core.metrics.reconfigurationsRestored, 0)
  assert.equal(rig.core.moveKind, null, 'the move is committed')
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.session.backendLogins, 2)
  assert.equal(rig.core.session.detachCount, 0, 'the client never detached')
  assert.deepEqual(rig.frontLeg.endReasons(), [])
})

test('a target that never answers restores the client without a loading screen', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const before = rig.core.cache.snapshot()

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  const outcome = rig.core.abortTransfer('target_unreachable')

  assert.equal(outcome.restored, true)
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.attached, true)
  assert.deepEqual(rig.frontLeg.reconfigurations(), [], 'the client never left play')
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)

  // The pre-transfer state is back in the cache, and the notice explains why.
  assert.deepEqual(
    rig.core.cache.snapshot().prefix.map(frame => frame.name),
    before.prefix.map(frame => frame.name)
  )
  assert.equal(rig.core.cache.warm, true)
  assertNotice(rig.frontLeg, /could not be reached/i)
  assert.equal(rig.core.metrics.noticesSent, 1)
})

test('a target that dies mid-reconfiguration restores the previous configuration and state', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const mark = rig.frontLeg.frames().length

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  // The target answers once, so the client is already in configuration.
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.equal(rig.core.clientReconfiguring, true)
  rig.backendLeg.deliverEnd({ reason: 'target_lost' })

  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.attached, true, 'the connection survived the failed target')
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
  assert.equal(rig.core.restoring, true, 'the old configuration round is being finished')

  // The aborted round is completed from the pre-transfer snapshot: the old
  // server's configuration frames, then the finish the client answers.
  const duringRestore = rig.frontLeg.frames().slice(mark).map(frame => frame.name)
  assert.ok(duringRestore.includes('registry_data'))
  assert.equal(duringRestore.at(-1), 'finish_configuration')

  // The client answers the finish, so it is in play on the restored state.
  rig.frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(rig.core.restoring, false)
  assert.equal(rig.core.clientReconfiguring, false)
  assert.equal(rig.core.cache.warm, true, 'the pre-transfer cache is back')
  assertNotice(rig.frontLeg, /could not be reached/i)
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
})

test('start_configuration re-enters configuration on the same connection', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const mark = rig.frontLeg.frames().length

  rig.backendLeg.deliver({ state: 'play', name: 'start_configuration', buffer: BUFFER('start_configuration'), data: {} })
  assert.equal(rig.backendLeg.ended, 0, 'the puppet leg is not ended')
  assert.equal(rig.core.session.state, 'transferring')
  assert.equal(rig.core.moveKind, 'reconfigure')
  assert.equal(rig.core.attached, true)
  assert.equal(rig.core.cache.warm, false, 'the restarted phase is a new session state')
  assert.deepEqual(rig.frontLeg.endReasons(), [])

  // The restarted phase arrives on the same leg; the client follows it.
  landOnTarget(rig)
  assert.equal(rig.core.metrics.reconfigurationsCompleted, 1)
  assert.deepEqual(rig.frontLeg.reconfigurations(), [{ reason: 'reconfigure' }])
  const names = rig.frontLeg.frames().slice(mark).map(frame => frame.name)
  assert.ok(names.includes('registry_data'))
  assert.ok(names.includes('login'))
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.session.detachCount, 0)
})

test('a followed transfer while detached still moves the puppet and sends no notice', () => {
  const rig = makeSeamless()
  warmBackend(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.frontLeg.frames().length, 0)
  assert.equal(rig.frontLeg.endReasons().length, 0)
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersSeamless, 0)
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.cache.snapshot().generic.some(frame => frame.name === 'transfer'), false)

  rig.clock.tick(1000)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
})

test('follow disabled keeps the session and sends the refusal notice', () => {
  const rig = makeSeamless({ transfer: { follow: false } })
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.core.metrics.transfersFollowed, 0)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 0)
  assert.equal(rig.core.session.state, 'attached')
  assertNotice(rig.frontLeg, /could not follow/i)
})

test('an invalid target is refused without ending the session', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', name: 'transfer', buffer: BUFFER('transfer'), data: { host: '', port: 0 } })
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 0)
  assertNotice(rig.frontLeg, /could not follow/i)
})

test('a repeated target is refused as a loop after a completed move', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('sky-2.excalia.fr', 25565) })
  rig.clock.tick(1000)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
  landOnTarget(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('sky-2.excalia.fr', 25565) })
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.backendLeg.ended, 1, 'the refused transfer does not end the leg again')
  assertNotice(rig.frontLeg, /could not follow/i)
})

test('the chain limit refuses the hop beyond it', () => {
  const rig = makeSeamless({ transfer: { chainLimit: 1 } })
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('a.excalia.fr', 25565) })
  rig.clock.tick(1000)
  landOnTarget(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer('b.excalia.fr', 25565) })
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assertNotice(rig.frontLeg, /could not follow/i)
})

test('connection-control frames are blocked in both states', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  for (const name of ['kick_disconnect', 'cookie_request', 'store_cookie', 'hide_message']) {
    rig.backendLeg.deliver({ state: 'play', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)

  for (const name of ['disconnect', 'cookie_request', 'store_cookie']) {
    rig.backendLeg.deliver({ state: 'configuration', name, buffer: BUFFER(name), data: {} })
  }
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.cache.snapshot().config.length, 1, 'only registry_data was cacheable')
  assert.equal(rig.core.cache.snapshot().generic.some(f => ['show_dialog', 'store_cookie'].includes(f.name)), false)
})

test('#16 a control dialog crosses while connection control stays contained', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const before = rig.frontLeg.frames().length

  // Play dialogs reach the human (#16). A configuration gate does not: this
  // client is in play, so the gate waits for a client in configuration.
  for (const name of ['show_dialog', 'clear_dialog']) {
    rig.backendLeg.deliver({ state: 'play', name, buffer: BUFFER(name), data: {} })
  }
  rig.backendLeg.deliver({ state: 'configuration', name: 'code_of_conduct', buffer: BUFFER('coc'), data: {} })

  const crossed = rig.frontLeg.frames().slice(before).map(frame => frame.name)
  assert.deepEqual(crossed, ['show_dialog', 'clear_dialog'])
  // A dialog is neither ordinary state nor an attach replay: the pending
  // holder keeps the one copy, so a replay can never deliver a stale one.
  const snapshot = rig.core.cache.snapshot()
  const cachedNames = [
    ...snapshot.config, ...snapshot.generic, ...snapshot.latest
  ].map(frame => frame.name)
  assert.equal(cachedNames.some(name => ['show_dialog', 'clear_dialog', 'code_of_conduct'].includes(name)), false)
  assert.equal(rig.core.pendingDialog.peek().name, 'code_of_conduct', 'the withheld gate is still pending')
})

test('login is cached for replay but never relayed into a live session', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', name: 'login', buffer: BUFFER('login'), data: { entityId: 42 } })
  assert.equal(rig.frontLeg.frames().length, before)
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'login'), true)
})

test('ping_response is relayed live but never cached', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  const before = rig.frontLeg.frames().length
  rig.backendLeg.deliver({ state: 'play', name: 'ping_response', buffer: BUFFER('ping_response'), data: { id: 7n } })
  const live = rig.frontLeg.frames().slice(before)
  assert.deepEqual(live.map(f => f.name), ['ping_response'])
  assert.equal(rig.core.cache.snapshot().generic.some(f => f.name === 'ping_response'), false)
})

test('configuration transfer is blocked and configuration ping is answered per-leg', () => {
  const rig = makeSeamless()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })

  rig.backendLeg.deliver({ state: 'configuration', name: 'transfer', buffer: BUFFER('transfer'), data: { host: 'x.invalid', port: 1 } })
  assert.equal(rig.core.metrics.transfersBlocked, 1)
  assert.equal(rig.core.metrics.transfersFollowed, 0, 'v1 does not follow configuration transfers')
  assert.equal(rig.frontLeg.frames().length, 0)
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'transfer'), false)

  rig.backendLeg.deliver({ state: 'configuration', name: 'ping', buffer: BUFFER('ping'), data: { id: 7 } })
  const pong = rig.backendLeg.packetWrites().find(p => p.name === 'pong' && p.packet.id === 7)
  assert.ok(pong, 'the puppet leg answers its own configuration ping')
  assert.equal(rig.core.cache.snapshot().config.some(f => f.name === 'ping'), false)
})

test('a target that dies after its play login still restores the configuration round', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)
  const mark = rig.frontLeg.frames().length

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  // The target's play login lands while the client is still finishing the
  // configuration round, so the move is not committed yet; the target dies in
  // that window.
  rig.backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 7 } })
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.moveKind, 'transfer', 'the move is not committed yet')
  assert.equal(rig.core.clientReconfiguring, true)
  rig.backendLeg.deliverEnd({ reason: 'target_lost_after_login' })

  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
  assert.equal(rig.core.attached, true, 'the client keeps its connection')
  assert.equal(rig.core.session.detachCount, 0)
  // The round is still open on the client, so the restore finishes it from the
  // snapshot instead of opening a second one.
  assert.equal(rig.frontLeg.reconfigurations().length, 1)
  assert.equal(rig.core.restoring, true)
  const names = rig.frontLeg.frames().slice(mark).map(frame => frame.name)
  assert.equal(names.at(-1), 'finish_configuration')
  rig.frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(rig.core.restoring, false)
  assertNotice(rig.frontLeg, /could not be reached/i)
})

test('a target that dies after the client finished is restored through a new round', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig.backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  rig.frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(rig.core.clientReconfiguring, false)

  rig.backendLeg.deliverEnd({ reason: 'target_lost' })
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
  assert.equal(rig.core.attached, true)
  assert.equal(rig.frontLeg.reconfigurations().length, 2, 'one more configuration round')
  assert.equal(rig.core.restoring, true)
  rig.frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(rig.core.restoring, false)
  assert.equal(rig.core.session.state, 'attached')
  assertNotice(rig.frontLeg, /could not be reached/i)
})

test('a stalled reconfiguration is restored when its deadline passes', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  // The target sends its first configuration frame and then nothing.
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.equal(rig.core.clientReconfiguring, true)
  assert.equal(rig.clock.pending, 1, 'the configuration round has a deadline')

  rig.clock.tick(30_000)
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.attached, true)
  assert.equal(rig.core.restoring, true, 'the aborted round is served from the snapshot')
})

test('a transfer during the client\'s own configuration is refused, not half-served', () => {
  const rig = makeSeamless()
  // An early attach: the puppet logs in while the client is still configuring,
  // so the session is attached but no play frame may reach the client yet.
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  const attached = rig.core.attachConfiguringPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(attached.attached, true)
  rig.backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  assert.equal(rig.core.frontPlayReady, false)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.core.metrics.transfersRefused, 1)
  assert.equal(rig.core.metrics.transfersSeamless, 0)
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.moveKind, null)
})

test('the reconfiguration deadline is configurable and validated', () => {
  assert.equal(loadConfig().transfer.reconfigureTimeoutMs, 30_000)
  assert.equal(loadConfig({ transfer: { reconfigureTimeoutMs: 0 } }).transfer.reconfigureTimeoutMs, 0)
  assert.equal(loadConfig({ transfer: { reconfigureTimeoutMs: 5000 } }).transfer.reconfigureTimeoutMs, 5000)
  assert.throws(() => loadConfig({ transfer: { reconfigureTimeoutMs: -1 } }), /reconfigureTimeoutMs/)
  assert.throws(() => loadConfig({ transfer: { reconfigureTimeoutMs: 'soon' } }), /reconfigureTimeoutMs/)
})

test('a restore round the client never finishes detaches it at the deadline', () => {
  const rig = makeSeamless()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  rig.clock.tick(1000)
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  // The target dies, so the restore round starts and the client never answers.
  rig.backendLeg.deliverEnd({ reason: 'target_lost' })
  assert.equal(rig.core.restoring, true)
  assert.ok(rig.clock.pending >= 1, 'the restore round has a deadline')

  rig.clock.tick(30_000)
  assert.equal(rig.core.restoring, false)
  assert.equal(rig.core.attached, false)
  assert.equal(rig.core.session.state, 'detached')
  assert.match(String(rig.frontLeg.endReasons().at(-1)?.reason), /transfer_restore_timeout/)
})

test('the default keeps the detach-and-rejoin transfer', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', ...transfer() })
  assert.equal(rig.core.metrics.transfersFollowed, 1)
  assert.equal(rig.core.metrics.transfersSeamless, 0)
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.attached, false)
  assert.match(String(rig.frontLeg.endReasons().at(-1)?.reason), /moving/i)
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect')

  rig.clock.tick(1000)
  assert.deepEqual(rig.events[0].target, { host: 'sky-2.excalia.fr', port: 25565 })
  assert.deepEqual(rig.frontLeg.reconfigurations(), [])
})

test('the default keeps the detach-and-reconnect reconfiguration', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({ state: 'play', name: 'start_configuration', buffer: BUFFER('start_configuration'), data: {} })
  assert.equal(rig.core.metrics.reconfigurationsStarted, 0)
  assert.equal(rig.backendLeg.ended, 1, 'the puppet leg is ended on purpose')
  assert.equal(rig.core.session.state, 'attached', 'the end handler has not fired yet')

  rig.backendLeg.deliverEnd({ reason: 'backend_reconfigure' })
  assert.equal(rig.core.cache.warm, false, 'the dead session cache is reset')
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect')
  assert.match(String(rig.frontLeg.endReasons().at(-1)?.reason), /reconfigured this session/i)
})

test('the kept connection is off by default and validated', () => {
  assert.equal(loadConfig().transfer.keepConnection, false)
  assert.equal(loadConfig({ transfer: { keepConnection: true } }).transfer.keepConnection, true)
  assert.throws(() => loadConfig({ transfer: { keepConnection: 'yes' } }), /keepConnection/)
})

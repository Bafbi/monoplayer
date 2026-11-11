// B1 target: fake integration. Printed frames, no sockets, no Microsoft auth.
// Proves: attach/replay order, detach + backend mutation + reattach pose,
// backendLogins === 1 across the whole cycle, deny-before-Login-Success,
// one backend login across attach/detach, and the redaction sentinel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SENTINEL, redact } from '../../src/observability/redact.js'
import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const OTHER = '3f7f2c60-5fd1-4b3c-94b7-000000000042'
const BLANK = name => Buffer.from(`backend:${name}`)

// Scripted warmup: configuration prefix, then the play join prefix that ends
// at chunk_batch_finished (the cache warm marker).
function warmBackend ({ backendLeg, core }) {
  const config = [
    { state: 'configuration', name: 'registry_data', data: {} },
    { state: 'configuration', name: 'select_known_packs', data: {} },
    { state: 'configuration', name: 'keep_alive', data: { keepAliveId: 'cfg-1' } } // never cached/replayed
  ]
  for (const f of config) backendLeg.deliver(f)

  const join = [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]
  for (const f of join) backendLeg.deliver({ state: 'play', ...f })

  assert.equal(core.session.state, 'warm')
  assert.equal(core.session.warmReady, true)
  assert.equal(core.session.backendLogins, 1, 'exactly one backend login after warmup')
  assert.equal(core.cache.warm, true)
}

function attach ({ frontLeg, core }, uuid = PLAYER) {
  const decision = frontLeg.loginStart({ name: 'Bafbi', uuid })
  if (!decision.allowed) return { denied: true, decision }
  return { denied: false, ...core.attachPlayer({ name: 'Bafbi', uuid }) }
}

const PACK = uuid => ({
  state: 'play',
  name: 'add_resource_pack',
  data: { uuid, url: `https://example.invalid/${uuid}.zip`, hash: '', forced: false, prompt: null }
})

// #98: the pack is the human's answer, and the held copy is what a later client
// receives. Nothing about the pack goes through the state cache.
test('a resource pack reaches an attached client and the puppet does not answer it', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver(PACK(PLAYER))

  assert.equal(rig.frontLeg.namesOf().includes('add_resource_pack'), true, 'the client got the pack')
  const acks = rig.backendLeg.packetWrites().filter(p => p.name === 'resource_pack_receive')
  assert.equal(acks.length, 0, 'the puppet said nothing: one answer, from the human')
  assert.equal(rig.core.metrics.resourcePackAcks, 0)
  assert.equal(rig.core.metrics.resourcePacksRelayed, 1)
  assert.equal(rig.core.pendingPacks.held, true, 'held for the next client')
  assert.equal(
    rig.core.cache.snapshot().generic.some(f => f.name === 'add_resource_pack'),
    false,
    'a control frame is never cached'
  )

  // The human's own result crosses as the puppet's frame: declined here, so a
  // proxy that turned it into an accept would be visible.
  rig.frontLeg.serverbound({ state: 'play', name: 'resource_pack_receive', data: { uuid: PLAYER, result: 1 } })
  const forwarded = rig.backendLeg.rawWrites().filter(w => w.meta?.name === 'resource_pack_receive')
  assert.equal(forwarded.length, 1, 'exactly one answer reached the backend')
  assert.equal(forwarded[0].buffer.toString(), 'client:resource_pack_receive')
  assert.equal(rig.core.metrics.resourcePacksAnswered, 1)
  assert.equal(rig.core.pendingPacks.held, true, 'the pack stays installed for the next client')
})

test('a resource pack with nobody attached is accepted by the puppet and delivered to the next client', () => {
  const rig = makeCore()
  warmBackend(rig)

  rig.backendLeg.deliver(PACK(PLAYER))
  const acks = rig.backendLeg.packetWrites().filter(p => p.name === 'resource_pack_receive')
  assert.equal(acks.length, 2, 'accepted then loaded, headless')
  assert.deepEqual(acks.map(p => p.packet.result), [3, 0])
  assert.equal(acks[0].packet.uuid, PLAYER)
  assert.equal(rig.core.metrics.resourcePackAcks, 1)

  attach(rig)
  assert.equal(rig.frontLeg.namesOf().includes('add_resource_pack'), true, 'the held pack reaches the next client')
  assert.equal(rig.core.metrics.resourcePacksResent, 1)

  rig.frontLeg.serverbound({ state: 'play', name: 'resource_pack_receive', data: { uuid: PLAYER, result: 3 } })
  assert.equal(rig.core.metrics.resourcePacksAnswered, 1)
})

// The reported symptom: the pack is not in the replay any more. Ordinary state
// would put it in the 512-entry generic ring, where a live session evicts it in
// about 90 seconds. The held copy does not care how much traffic went by.
test('a resource pack survives 600 generic frames and still reaches a later client', () => {
  const rig = makeCore()
  warmBackend(rig)
  rig.backendLeg.deliver(PACK(PLAYER))
  for (let i = 0; i < 600; i++) {
    rig.backendLeg.deliver({ state: 'play', name: 'sound_effect', data: { soundId: i } })
  }
  assert.equal(
    rig.core.cache.snapshot().generic.some(f => f.name === 'add_resource_pack'),
    false,
    'the cache ring no longer holds it, which is why the holder exists'
  )

  attach(rig)
  assert.equal(rig.frontLeg.namesOf().includes('add_resource_pack'), true, 'the held pack still reaches the client')
})

test('a configuration-phase pack is delivered in the client configuration phase, and remove withdraws it', () => {
  const rig = makeCore()
  warmBackend(rig)

  rig.backendLeg.deliver({ ...PACK(OTHER), state: 'configuration' })
  assert.equal(rig.core.pendingPacks.held, true)
  // A client in play cannot parse a configuration frame, so the pack waits.
  assert.equal(rig.core.metrics.resourcePacksRelayed, 0)

  // The live leg's order: the client's own configuration phase comes first
  // (configuringReady), the play attach at playerJoin after it. A configuration
  // pack reaches the client in that phase and nowhere else.
  rig.core.configuringReady({ name: 'Bafbi' })
  const delivered = rig.frontLeg.frames().filter(f => f.name === 'add_resource_pack')
  assert.equal(delivered.length, 1, 'delivered in the client configuration phase')
  assert.deepEqual(delivered[0].meta, { state: 'configuration', name: 'add_resource_pack' })

  attach(rig)
  assert.equal(
    rig.frontLeg.frames().filter(f => f.name === 'add_resource_pack').length,
    1,
    'a configuration pack is not written into the play replay'
  )

  rig.backendLeg.deliver({ state: 'configuration', name: 'remove_resource_pack', data: { uuid: OTHER } })
  assert.equal(rig.core.pendingPacks.held, false, 'remove drops the held copy')
  assert.equal(rig.core.metrics.resourcePacksRemoved, 1)
})

// #98: a client that is attached but cannot take the frame yet is still a client.
// An early-attach client is in its own configuration when a play-state pack
// arrives; it is offered the pack at its replay, so the puppet must not invent
// an answer beside the human's.
test('a pack that arrives while a client is attached but not in play waits, unanswered', () => {
  // #16's early attach: the client follows the puppet's configuration, so the
  // core is attached while the client is still in its own configuration round.
  // A play-state pack now cannot be written to the client yet; it is offered at
  // the play replay, and the puppet must not answer in the meantime.
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  const decision = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(decision.allowed, true)
  const early = rig.core.attachConfiguringPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(early.attached, true)

  rig.backendLeg.deliver({ ...PACK(PLAYER), state: 'play' })
  assert.equal(
    rig.backendLeg.packetWrites().filter(p => p.name === 'resource_pack_receive').length,
    0,
    'the puppet said nothing: a client is attached'
  )
  assert.equal(rig.core.metrics.resourcePacksWithheld, 1)
  assert.equal(rig.core.pendingPacks.held, true)
  assert.equal(rig.core.metrics.resourcePacksRelayed, 0, 'the client is not in play yet, so nothing was written')
})

test('a pack a client never answered becomes the puppet answer on detach', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver(PACK(PLAYER))
  assert.equal(rig.backendLeg.packetWrites().filter(p => p.name === 'resource_pack_receive').length, 0)

  rig.frontLeg.clientDisconnect({ reason: 'player_quit' })
  const acks = rig.backendLeg.packetWrites().filter(p => p.name === 'resource_pack_receive')
  assert.deepEqual(acks.map(p => p.packet.result), [3, 0], 'the server hears an answer for its required pack')
  assert.equal(rig.core.metrics.resourcePacksAnsweredOnDetach, 1)
  assert.equal(rig.core.pendingPacks.held, true, 'the held copy stays for the next client')
})

test('an attach before the backend is ready is denied before configuration', () => {
  const rig = makeCore()

  const denied = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'backend_not_ready')
  assert.deepEqual(rig.frontLeg.endReasons(), [{ reason: 'denied:backend_not_ready' }])
  assert.equal(rig.core.metrics.denials, 1)

  warmBackend(rig)
  const allowed = rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(allowed.allowed, true, JSON.stringify(allowed))
})

test('login-phase frames never enter the join cache or the replay', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({ state: 'login', name: 'encryption_begin', data: {} })
  rig.backendLeg.deliver({ state: 'login', name: 'compress', data: {} })
  rig.backendLeg.deliver({ state: 'login', name: 'success', data: {} })
  warmBackend(rig)

  assert.equal(rig.core.metrics.nonPlayFramesIgnored, 3)
  const snapshot = rig.core.cache.snapshot()
  const cached = [...snapshot.config, ...snapshot.prefix].map(f => f.name)
  assert.equal(cached.includes('encryption_begin'), false)
  assert.equal(cached.includes('compress'), false)
  assert.equal(cached.includes('success'), false)

  attach(rig)
  const replayed = rig.frontLeg.frames().map(f => f.name)
  assert.equal(replayed.includes('encryption_begin'), false)
  assert.equal(replayed[0], 'registry_data')
})

test('AC1-shape: attach replays config prefix, join prefix, one synthesized position', () => {
  const rig = makeCore()
  warmBackend(rig)

  const result = attach(rig)
  assert.equal(result.denied, false)
  assert.equal(result.attached, true)

  const frames = rig.frontLeg.frames()
  const names = frames.map(f => f.name)
  assert.deepEqual(names, [
    // configuration replay prefix, ordered; per-leg keep_alive NOT replayed
    'registry_data',
    'select_known_packs',
    // join prefix, verbatim; backend position NOT replayed
    'login',
    'game_state_change',
    // exactly one synthesized position before the chunk batch
    'position',
    'chunk_batch_start',
    'map_chunk',
    'chunk_batch_finished'
  ])

  const pos = frames.find(f => f.name === 'position')
  assert.equal(pos.kind, 'synth')
  assert.equal(pos.packet.teleportId, 1, 'fresh proxy-owned teleportId')
  assert.deepEqual(
    { x: pos.packet.x, y: pos.packet.y, z: pos.packet.z },
    { x: 0.5, y: 1.62, z: 0.5 },
    'lands at the start pose'
  )
  assert.equal(rig.core.metrics.framesReplayed, 7)
  assert.equal(rig.core.metrics.positionsSynthesized, 1)
})

test('AC3/AC5-shape: client input forwards, pose updates, backend mutation while detached, reattach on current pose, backendLogins === 1', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  // AC2-shape: client movement forwards to the backend and updates pose.
  rig.frontLeg.serverbound({ name: 'position', data: { x: 2.5, y: 1.62, z: 3.5 } })
  assert.equal(rig.core.session.currentPose.x, 2.5)
  assert.ok(rig.backendLeg.rawWrites().some(w => w.buffer.toString() === 'client:position'))

  // Detach; puppet stays logged in; backendLogins unchanged.
  rig.frontLeg.clientDisconnect({ reason: 'test_reattach' })
  assert.equal(rig.core.attached, false)
  assert.equal(rig.core.session.state, 'detached')
  assert.equal(rig.core.session.backendLogins, 1)

  // Backend mutation while detached: positioned teleport + block + inventory.
  rig.backendLeg.deliver({ state: 'play', name: 'position', data: { teleportId: 10, x: 8.5, y: 1.62, z: 8.5, yaw: 0, pitch: 0 } })
  assert.ok(rig.backendLeg.packetWrites().some(p => p.name === 'teleport_confirm' && p.packet.teleportId === 10),
    'puppet leg confirms its own teleport')
  rig.backendLeg.deliver({ state: 'play', name: 'block_update', data: { x: 3, y: 0, z: 3 } })
  rig.backendLeg.deliver({ state: 'play', name: 'window_items', data: { windowId: 0 } })

  // Reattach: config + join prefix + synth position (at the detached pose) + warm domains.
  const result = attach(rig)
  assert.equal(result.attached, true)
  const names = rig.frontLeg.frames().map(f => f.name) // only third-attach frames are new... all frames cumulative
  // Count only what this second attach replayed (frames list is per-leg cumulative):
  const secondBatch = rig.frontLeg.frames().slice(-10)
  assert.deepEqual(secondBatch.map(f => f.name), [
    'registry_data',
    'select_known_packs',
    'login',
    'game_state_change',
    'position',
    'chunk_batch_start',
    'map_chunk',
    'chunk_batch_finished',
    'block_update',
    'window_items'
  ])
  const pos2 = secondBatch.find(f => f.name === 'position')
  assert.equal(pos2.packet.teleportId, 2, 'teleportId monotonic across attaches; only sent positions consume IDs')
  assert.equal(pos2.packet.x, 8.5, 'reattach lands on the pose current at detach time')
  assert.equal(pos2.packet.z, 8.5)

  // The mutation the backend made while detached is visible in the replay
  // (block frames persist), and the whole cycle stayed at ONE backend login.
  assert.ok(secondBatch.some(f => f.name === 'block_update'))
  assert.equal(rig.core.session.backendLogins, 1)
  assert.ok(names.filter(n => n === 'block_update').length === 1)
})

test('B4-shape: non-whitelisted account is denied before Login Success', () => {
  const rig = makeCore()
  warmBackend(rig)

  const result = attach(rig, OTHER)
  assert.equal(result.denied, true)
  assert.equal(result.decision.allowed, false)
  assert.equal(result.decision.reason, 'not_whitelisted')
  assert.equal(result.decision.phase, 'login_start')

  // deny-before-Login-Success: kick recorded, zero replay frames sent
  assert.deepEqual(rig.frontLeg.endReasons().map(e => e.reason), ['denied:not_whitelisted'])
  assert.deepEqual(rig.frontLeg.frames(), [])
  assert.equal(rig.core.metrics.denials, 1)
  assert.equal(rig.core.session.state, 'warm', 'denial does not disturb the warm session')

  // The legit player still attaches cleanly after a denial.
  const ok = attach(rig)
  assert.equal(ok.attached, true)
  assert.equal(rig.core.session.backendLogins, 1)
})

test('legal-but-attached: second account is rejected with already_attached (single attach invariant)', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig, PLAYER)

  const second = rig.frontLeg.loginStart({ name: 'Second', uuid: PLAYER })
  assert.equal(second.allowed, true) // whitelisted UUID passes the identity gate

  const attempt = rig.core.attachPlayer({ name: 'Second', uuid: PLAYER })
  assert.equal(attempt.attached, false)
  assert.equal(attempt.reason, 'already_attached')
  assert.equal(rig.core.session.attachCount, 1)
  assert.deepEqual(rig.frontLeg.endReasons(), []) // no kick; the adapter owns this decision
})

test('F4-shape: backend death while attached -> front ended, one reconnect, backendLogins === 2 after recovery, attach during gap rejected', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)
  rig.frontLeg.serverbound({ name: 'position', data: { x: 4.5, y: 1.62, z: 4.5 } })

  rig.backendLeg.deliverEnd({ reason: 'pod_SIGKILL' })
  assert.deepEqual(rig.frontLeg.endReasons().map(e => e.reason).at(-1), 'backend_disconnected')
  assert.equal(rig.core.session.backendLogins, 1, 'no login yet; reconnect not finished')
  assert.ok(rig.frontLeg.frames().length > 0) // previous attach replayed before the fault

  // Deliberate reconnect window: attach is a clear failure here.
  const duringGap = rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(duringGap.attached, false)
  assert.equal(duringGap.reason, 'backend_down')
  assert.equal(rig.clock.pending, 1, 'exactly one reconnect timer')

  // Nobody else may arm a second reconnect in the gap.
  rig.backendLeg.deliverEnd({ reason: 'still_down' })
  assert.equal(rig.clock.pending, 1)

  // The single reconnect fires, backend comes back, one fresh login. The
  // cache was reset with the dead session, so the fresh session must warm
  // before an attach can replay it (the old attach-before-warm acceptance was
  // the bug that handed a client an empty configuration).
  rig.clock.tick(1000)
  rig.backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  assert.equal(rig.core.session.backendLogins, 2)
  assert.equal(rig.core.session.warmReady, false)
  rig.backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', data: { batchSize: 1 } })
  assert.equal(rig.core.session.warmReady, true)

  // Reattach after recovery: exactly one reconnect event, no loop.
  const ok = attach(rig)
  assert.equal(ok.attached, true)
  assert.equal(rig.core.metrics.attaches, 2)
  const events = rig.core.session.events()
  assert.equal(events.filter(e => e.type === 'reconnect_scheduled').length, 1)
})

test('P1#1: reconnect -> fresh login -> reattach replays exactly one login and the NEW join prefix, never the dead session\'s', () => {
  const rig = makeCore()
  warmBackend(rig) // login #1; the first join prefix pins and warms
  attach(rig)
  rig.frontLeg.serverbound({ name: 'position', data: { x: 4.5, y: 1.62, z: 4.5 } })

  // Backend dies while attached: the entire cache is invalidated with the
  // dead session (no leftover prefix/config/warm state).
  rig.backendLeg.deliverEnd({ reason: 'pod_SIGKILL' })
  assert.equal(rig.frontLeg.endReasons().at(-1).reason, 'backend_disconnected')
  assert.equal(rig.core.cache.warm, false, 'cache reset on backend end')
  assert.deepEqual(rig.core.cache.stats().sizes, {
    prefix: 0, config: 0, chunks: 0, blocks: 0, entities: 0,
    inventories: 0, latest: 0, generic: 0
  })

  // The single reconnect fires; the backend returns as a FULL fresh session:
  // configuration phase first, then a JOIN PREFIX THAT DIFFERS from the dead
  // session's (entityId 43, gameMode 1, different chunks, an unload).
  rig.clock.tick(1000)
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig.backendLeg.deliver({ state: 'configuration', name: 'select_known_packs', data: {} })

  const freshJoin = [
    { name: 'login', data: { entityId: 43 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 1 } },
    { name: 'position', data: { teleportId: 99, x: 2.5, y: 1.62, z: 2.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 7, z: 9 } },
    { name: 'unload_chunk', data: { x: 7, z: 9 } },
    { name: 'chunk_batch_finished', data: {} }
  ]
  for (const f of freshJoin) rig.backendLeg.deliver({ state: 'play', ...f })

  assert.equal(rig.core.session.backendLogins, 2, 'exactly one fresh backend login after reconnect')
  assert.equal(rig.core.cache.warm, true, 'the new prefix warms the cache again')
  assert.deepEqual(rig.core.cache.snapshot().prefix.map(f => f.name), [
    'login', 'game_state_change', 'chunk_batch_start', 'map_chunk', 'unload_chunk', 'chunk_batch_finished'
  ])

  // Reattach replay: exactly one login, the new prefix, in order.
  const result = attach(rig)
  assert.equal(result.attached, true)
  const names = result.frames.map(f => f.name)
  assert.deepEqual(names, [
    // new session's configuration prefix, ordered
    'registry_data',
    'select_known_packs',
    // the NEW join prefix, verbatim (dead-session frames absent)
    'login',
    'game_state_change',
    // exactly one synthesized position before the first chunk frame
    'position',
    'chunk_batch_start',
    'map_chunk',
    'unload_chunk',
    'chunk_batch_finished'
  ])
  assert.equal(names.filter(n => n === 'login').length, 1, 'exactly one login in the replay')
  assert.equal(names.filter(n => n === 'map_chunk').length, 1, 'no dead-session chunk replayed alongside the new one')
  const pos = result.frames.find(f => f.synth === 'position')
  assert.equal(pos.packet.teleportId, 2, 'teleportId stays monotonic across sessions')
  assert.deepEqual({ x: pos.packet.x, z: pos.packet.z }, { x: 2.5, z: 2.5 }, 'lands on the fresh backend teleport (authoritative)')
})

test('P1#2: every backend chunk_batch_finished is acked with chunk_batch_received, warm or not', () => {
  const rig = makeCore()
  const acks = () => rig.backendLeg.packetWrites().filter(p => p.name === 'chunk_batch_received')

  warmBackend(rig) // batch cycle 1 ends at chunk_batch_finished => ack #1
  assert.equal(acks().length, 1, 'the warm marker batch is acked')

  attach(rig)
  // Batch cycle 2 strictly AFTER warm: still acked.
  rig.backendLeg.deliver({ state: 'play', name: 'chunk_batch_start', data: {} })
  rig.backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 5, z: 5 } })
  rig.backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', data: {} })
  assert.equal(acks().length, 2, 'a batch finish after warm is still acked')

  // Batch cycle 3 while detached: still acked.
  rig.frontLeg.clientDisconnect({ reason: 'ack_cycle_3' })
  rig.backendLeg.deliver({ state: 'play', name: 'chunk_batch_start', data: {} })
  rig.backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', data: {} })
  assert.equal(acks().length, 3, '2+ batch cycles => 2+ acks')
})

test('redaction sentinel: secret-shaped log content never survives', () => {
  const rig = makeCore()
  warmBackend(rig)
  rig.core.log('diagnostic', {
    access_token: 'SUPERSECRET',
    note: 'Authorization: Bearer eyAbcDefG1234567890, plus refresh_token=hunter2'
  })
  const lines = rig.core.logs().join('\n')
  assert.ok(lines.includes(SENTINEL), 'sentinel present')
  assert.equal(lines.includes('SUPERSECRET'), false)
  assert.equal(lines.includes('hunter2'), false)
  assert.equal(lines.includes('eyAbcDefG1234567890'), false, 'the bearer value is the secret, not the word Bearer')
  assert.ok(lines.includes('refresh_token='), 'shape stays greppable')

  // P2: a JSON-quoted secret field keeps its field-name label too.
  const quoted = redact(JSON.stringify({ access_token: 'SUPERSECRET_QUOTED' }))
  assert.ok(quoted.includes('access_token='), 'quoted field name keeps the label')
  assert.equal(quoted.includes('SUPERSECRET_QUOTED'), false)
})

test('CLI guardrails: default is inert (no sockets), --start needs explicit live config', async () => {
  let out = ''
  const io = { stdout: { write (s) { out += s } }, stderr: { write (s) { out += s } } }

  // (main() with no args prints usage)
  const { main } = await import('../../src/service/monoplayer.js')
  const codeHelp = await main([], io)
  assert.equal(codeHelp, 0)
  assert.ok(out.includes('--print-config'))

  // --start is wired now, but stays inert without an explicit live config:
  // no backend host env / no --config means sockets and token custody are
  // never opened.
  const codeStart = await main(['--start'], io)
  assert.equal(codeStart, 2)
  assert.ok(out.includes('MONOPLAYER_BACKEND_HOST'))
})

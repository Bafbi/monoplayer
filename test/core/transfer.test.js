// #22 slice 1: the transfer of an attached session, and the pre-transfer
// snapshot that restores the client when the target fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, STATES } from '../../src/core/session.js'
import { createStateCache } from '../../src/core/state-cache.js'
import { createTransfer, TRANSFER_KINDS } from '../../src/core/transfer.js'
import { fakeClock } from '../support/harness.js'

const PLAYER = 'player-uuid'
const buf = label => Buffer.from(`cache:${label}`)

// A session with the one client attached and warm on the hub.
function attachedSession (clock) {
  const session = createSession({ clock, reconnectDelayMs: 1000 })
  session.backendLogin({ entityId: 42 })
  session.warmComplete({ marker: 'chunk_batch_finished' })
  session.attachAttempt({ uuid: PLAYER, name: 'Bafbi' })
  session.setPose({ x: 4.5, y: 1.62, z: 4.5, yaw: 0, pitch: 0 })
  return session
}

// The hub's cached state: a join prefix, a chunk, a cached block edit, and an
// inventory base plus a later slot update.
function hubCache () {
  const cache = createStateCache()
  cache.push('play', 'login', buf('login'), { entityId: 42 })
  cache.push('play', 'chunk_batch_finished', buf('marker'), {})
  // After the marker the warm domains take over: a chunk, a block edit, and an
  // inventory base plus a later slot update.
  cache.push('play', 'map_chunk', buf('chunk'), { x: 0, z: 0 })
  cache.push('play', 'block_update', buf('block'), { location: { x: 1, y: 0, z: 1 } })
  cache.push('play', 'window_items', buf('window'), { windowId: 0 })
  cache.push('play', 'set_slot', buf('slot'), { windowId: 0, slot: 40 })
  return cache
}

function rig () {
  const clock = fakeClock()
  const session = attachedSession(clock)
  const cache = hubCache()
  const transfer = createTransfer({ session, cache })
  return { clock, session, cache, transfer }
}

test('begin keeps the client attached and captures the pre-transfer state', () => {
  const { session, cache, transfer } = rig()
  const before = cache.snapshot()
  const outcome = transfer.begin({ target: { host: 'sky-2.excalia.fr', port: 25565 } })

  assert.equal(outcome.began, true)
  assert.equal(transfer.inFlight, true)
  assert.equal(session.state, STATES.TRANSFERRING)
  assert.equal(session.transferring, true)
  // The client still holds the slot: no second attach, and not attach-ready.
  assert.equal(session.attachAttempt({ uuid: 'other', name: 'Other' }).reason, 'already_attached')
  assert.equal(session.isAttachReady(), false)
  // The snapshot is the cache as it stood before any target frame.
  assert.deepEqual(outcome.snapshot.prefix.map(frame => frame.name), before.prefix.map(frame => frame.name))
  assert.deepEqual(outcome.pose, session.currentPose)
  assert.deepEqual(transfer.target, { host: 'sky-2.excalia.fr', port: 25565 })
})

test('begin without a client does not transfer: the puppet moves alone', () => {
  const clock = fakeClock()
  const session = createSession({ clock })
  session.backendLogin({})
  session.warmComplete({})
  const cache = hubCache()
  const transfer = createTransfer({ session, cache })

  const outcome = transfer.begin({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  assert.equal(outcome.began, false)
  assert.equal(outcome.reason, 'no_client')
  assert.equal(session.state, STATES.WARM)
  assert.equal(transfer.inFlight, false)
})

test('a failed target restores the pre-transfer state and the session', () => {
  const { clock, session, cache, transfer } = rig()
  const before = cache.snapshot()
  transfer.begin({ target: { host: 'sky-2.excalia.fr', port: 25565 } })

  // The move resets the cache and the target's own session starts filling it;
  // the snapshot is the only copy of what the client had.
  cache.reset()
  cache.push('configuration', 'registry_data', buf('target_registry'), {})
  cache.push('play', 'login', buf('target_login'), { entityId: 7 })

  const outcome = transfer.fail({ reason: 'target_unreachable' })
  assert.equal(outcome.failed, true)
  assert.equal(outcome.restored, true)
  assert.equal(session.state, STATES.ATTACHED)
  assert.equal(session.attachCount, 1, 'the client never detached')
  assert.deepEqual(session.currentPose, { x: 4.5, y: 1.62, z: 4.5, yaw: 0, pitch: 0 })

  // The cache is the hub again, not the dead target's session.
  const restored = cache.snapshot()
  assert.deepEqual(restored.prefix.map(frame => frame.name), before.prefix.map(frame => frame.name))
  assert.deepEqual(restored.blocks.map(frame => frame.name), ['block_update'])
  assert.deepEqual(restored.chunks.map(frame => frame.data.x), [0])
  assert.equal(restored.warm, true)
  assert.equal(transfer.inFlight, false)
  assert.equal(transfer.restored, true)

  // One reconnect goes back to the configured backend.
  assert.equal(clock.pending, 1)
  clock.tick(1000)
  assert.equal(session.state, STATES.ATTACHED, 'the retained client keeps the session attached')
})

test('a restored session accepts the returning backend login without losing the client', () => {
  const { session, cache, transfer } = rig()
  transfer.begin({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  cache.reset()
  transfer.fail({ reason: 'target_unreachable' })

  session.backendConnecting({ initial: false })
  assert.equal(session.state, STATES.ATTACHED)
  const login = session.backendLogin({ entityId: 42 })
  assert.equal(login.restored, true)
  assert.equal(session.state, STATES.ATTACHED)
  assert.equal(session.backendLogins, 2)
  // The client is still the one holding the slot.
  assert.equal(session.attachAttempt({ uuid: 'other', name: 'Other' }).reason, 'already_attached')
})

test('the restored cache stays warm, so new frames keep their domains', () => {
  const { cache, transfer } = rig()
  const before = cache.stats().sizes.prefix
  transfer.begin({})
  cache.reset()
  cache.push('play', 'login', buf('target_login'), {})
  transfer.fail({ reason: 'target_unreachable' })

  assert.equal(cache.warm, true)
  assert.equal(cache.stats().sizes.prefix, before, 'the join prefix did not grow')
  cache.push('play', 'block_update', buf('block2'), { location: { x: 2, y: 0, z: 2 } })
  assert.equal(cache.snapshot().blocks.length, 2)
  assert.equal(cache.stats().sizes.prefix, before, 'a warm frame still leaves the prefix alone')
})

test('the restored inventory replays its base before the later slot', () => {
  const { cache, transfer } = rig()
  transfer.begin({})
  cache.reset()
  transfer.fail({ reason: 'target_unreachable' })

  // join-synth orders inventory frames by capture sequence; a restore that
  // renumbered them would replay the slot before the base it belongs to.
  const names = cache.snapshot().inventories.map(entry => entry.name)
  assert.deepEqual(names, ['window_items', 'set_slot'])
  const seqs = cache.snapshot().inventories.map(entry => entry.seq)
  assert.ok(seqs[0] < seqs[1], `base seq must precede the slot seq, got ${seqs.join(',')}`)
})

test('commit lands the session in the target and drops the snapshot', () => {
  const { session, transfer } = rig()
  transfer.begin({ target: { host: 'sky-2.excalia.fr', port: 25565 } })
  session.backendConnecting({ initial: false })
  const login = session.backendLogin({ entityId: 7 })
  assert.equal(login.fromTransfer, true)

  const outcome = transfer.commit()
  assert.equal(outcome.committed, true)
  assert.equal(session.state, STATES.ATTACHED)
  assert.equal(transfer.snapshot, null)
  assert.equal(transfer.inFlight, false)
  // A failed target after a commit has nothing to restore.
  assert.equal(transfer.fail({ reason: 'late' }).failed, false)
})

test('a second begin while in flight is refused, and discard releases the snapshot', () => {
  const { transfer } = rig()
  transfer.begin({ target: { host: 'a.excalia.fr', port: 25565 } })
  const second = transfer.begin({ target: { host: 'b.excalia.fr', port: 25565 } })
  assert.equal(second.began, false)
  assert.equal(second.reason, 'already_in_flight')
  assert.deepEqual(transfer.target, { host: 'a.excalia.fr', port: 25565 })

  assert.equal(transfer.discard().dropped, true)
  assert.equal(transfer.snapshot, null)
  assert.equal(transfer.inFlight, false)
})

test('a server reconfiguration uses the same state, with no target', () => {
  const { session, cache, transfer } = rig()
  const outcome = transfer.begin({ kind: TRANSFER_KINDS.RECONFIGURE })
  assert.equal(outcome.began, true)
  assert.equal(transfer.kind, TRANSFER_KINDS.RECONFIGURE)
  assert.equal(transfer.target, null)
  assert.equal(session.state, STATES.TRANSFERRING)

  cache.reset()
  const failed = transfer.fail({ reason: 'backend_reconfigure_failed' })
  assert.equal(failed.restored, true)
  assert.equal(cache.warm, true)
})

// #264: the operator move is retired, and the machine keeps the two kinds a packet
// can name. A third kind left in the frozen set is a value no caller can produce,
// read by every line that logs a move.
test('#264 the machine has two kinds, and neither is an operator', () => {
  assert.deepEqual(Object.keys(TRANSFER_KINDS).sort(), ['RECONFIGURE', 'TRANSFER'])
})


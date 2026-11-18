// #233: the operator's move. No packet is behind it: the control document names
// a different backend, the service's heartbeat reads it, and this is the entry
// point that drives the #22 reconfiguration machine from that intent.
//
// The rig is the fake legs, so the cases here answer what the machine does with a
// move that has no transfer frame: the kind it runs under, the dial the
// orchestrator is handed, the failure that puts the client back, and the fact
// that the transfer counters never move. The real front leg, a real client, and
// two real fake backends are the loopback's O54.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const TARGET = { host: '10.0.0.7', port: 25566 }

function makeRig ({ config = {} } = {}) {
  const rig = makeCore({ config: { transfer: { keepConnection: true, ...(config.transfer ?? {}) }, ...config } })
  warmBackend(rig)
  return rig
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
  assert.equal(core.attachPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)
}

// The target answered: its configuration, the client's finish, then its play
// login and join state, on the connection the client never left.
function landOnTarget ({ backendLeg, frontLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  backendLeg.deliver({ state: 'configuration', name: 'finish_configuration', data: {} })
  frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })
  backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 7 } })
  backendLeg.deliver({ state: 'play', name: 'game_state_change', data: { reason: 13, gameMode: 0 } })
  backendLeg.deliver({ state: 'play', name: 'map_chunk', data: { x: 0, z: 0 } })
}

test('#233 an operator move runs as its own kind, keeps the client, and hands one dial', () => {
  const rig = makeRig()
  attach(rig)
  const before = {
    followed: rig.core.metrics.transfersFollowed,
    seamless: rig.core.metrics.transfersSeamless,
    blocked: rig.core.metrics.transfersBlocked,
    refused: rig.core.metrics.transfersRefused
  }

  const outcome = rig.core.startBackendMove({ target: TARGET, reason: 'heartbeat' })
  assert.deepEqual(outcome, { started: true, target: TARGET, kind: 'operator' })

  assert.equal(rig.core.moveKind, 'operator', 'the machine names the operator\'s act, not a transfer')
  assert.equal(rig.core.clientReconfiguring, true, 'the client is in its own configuration round')
  assert.equal(rig.core.frontPlayReady, false)
  assert.deepEqual(rig.frontLeg.reconfigurations(), [{ reason: 'operator' }],
    'the round starts on the intent, with the move\'s own name')
  assert.deepEqual(rig.frontLeg.endReasons(), [], 'the client is never kicked')
  assert.equal(rig.core.cache.warm, false, 'the cache is reset for the target\'s session')
  assert.equal(rig.core.session.state, 'transferring')
  assert.equal(rig.core.session.detachCount, 0)
  assert.equal(rig.backendLeg.ended, 1, 'the old session is ended at once, not at the socket\'s leisure')

  // The counters a transfer owns are untouched: an operator's document is not a
  // server instruction (docs/telemetry.md).
  assert.deepEqual({
    followed: rig.core.metrics.transfersFollowed,
    seamless: rig.core.metrics.transfersSeamless,
    blocked: rig.core.metrics.transfersBlocked,
    refused: rig.core.metrics.transfersRefused
  }, before, 'no transfer counter moves: an operator\'s document is not a server instruction')

  // One handover, on the next reconnect, and the orchestrator can tell the two
  // dials apart: moveTarget is not target.
  rig.clock.tick(1000)
  assert.equal(rig.events.length, 1)
  assert.deepEqual(rig.events[0].moveTarget, TARGET)
  assert.equal(rig.events[0].target, null, 'a transfer slot is not borrowed for an operator\'s move')
})

test('#233 the client lands in the target state on the connection it kept', () => {
  const logLines = []
  const rig = makeCore({ config: { transfer: { keepConnection: true } }, logLines })
  warmBackend(rig)
  attach(rig)
  const attaches = rig.core.metrics.attaches
  const mark = rig.frontLeg.frames().length

  rig.core.startBackendMove({ target: TARGET })
  rig.clock.tick(1000)
  landOnTarget(rig)

  const names = rig.frontLeg.frames().slice(mark).map(frame => frame.name)
  assert.ok(names.includes('finish_configuration'), 'the target\'s configuration round reached the client')
  assert.equal(names.filter(name => name === 'login').length, 1, 'one play login, on the same socket')
  assert.equal(rig.core.metrics.reconfigurationsCompleted, 1)
  assert.equal(rig.core.metrics.reconfigurationsRestored, 0)
  assert.equal(rig.core.moveKind, null, 'the move is committed')
  assert.equal(rig.core.session.state, 'attached')
  assert.equal(rig.core.session.backendLogins, 2)
  assert.equal(rig.core.metrics.attaches, attaches, 'the human reattached nothing')

  // #218: the record the reattach leaves names the operator's move, and it is
  // written against the target's session, because the cache was reset at the move.
  // The counts themselves are replay-summary's invariant and its own test's.
  const record = logLines.filter(line => line.event === 'attach').at(-1)
  assert.equal(record.reason, 'operator')
  assert.equal(record.backendLogins, 2, 'the record describes the target\'s session, not the first one')
})

test('#233 a target the budget gives up on puts the client back on the address it came from', () => {
  const logLines = []
  const rig = makeCore({ config: { transfer: { keepConnection: true } }, logLines })
  warmBackend(rig)
  attach(rig)
  const mark = rig.frontLeg.frames().length

  rig.core.startBackendMove({ target: TARGET })
  rig.clock.tick(1000)
  // The dial is refused: nothing listens there. The service gives up on the
  // target, which is the one path that ends an operator move badly.
  rig.core.abortTransfer('target_unreachable')

  // The restore is the #22 one: the snapshot's configuration and finish stream
  // into the round the client already opened, and the client's own answer ends
  // it, after which the previous join state is replayed on the same socket.
  const round = rig.frontLeg.frames().slice(mark)
  assert.ok(round.some(frame => frame.name === 'finish_configuration' && frame.meta?.state === 'configuration'),
    'the previous server\'s configuration round is served to the client already in one')
  rig.frontLeg.clientReconfigured({ name: 'Bafbi', uuid: PLAYER })

  const crossed = rig.frontLeg.frames().slice(mark)
  assert.equal(rig.core.metrics.reconfigurationsRestored, 1)
  assert.equal(rig.core.moveKind, null)
  assert.equal(rig.core.session.state, 'attached', 'the client keeps its connection and its session')
  assert.deepEqual(rig.frontLeg.endReasons(), [], 'a failed move never kicks the human')
  assert.ok(crossed.some(frame => frame.name === 'login'), 'the previous join state is replayed')
  assert.ok(logLines.some(line => line.event === 'backendMoveRestored'),
    'the failure is named for the operator who has to act on it')
})

test('#233 a move that cannot start says why, and spends nothing', () => {
  const rig = makeRig()
  attach(rig)

  assert.deepEqual(rig.core.startBackendMove({ target: { host: '', port: 25566 } }),
    { started: false, reason: 'invalid_target' })
  assert.deepEqual(rig.core.startBackendMove({ target: { host: 'a', port: 0 } }),
    { started: false, reason: 'invalid_target' })

  assert.equal(rig.core.startBackendMove({ target: TARGET }).started, true)
  assert.deepEqual(rig.core.startBackendMove({ target: { host: '10.0.0.8', port: 25565 } }),
    { started: false, reason: 'in_flight' },
    'a second move would tear down the connection the first is holding')
  assert.equal(rig.core.moveKind, 'operator', 'the first move is untouched by the refusal')
})

test('#233 with nobody attached the puppet moves alone, and the client path is not involved', () => {
  const rig = makeRig()
  const attaches = rig.core.metrics.attaches

  assert.equal(rig.core.startBackendMove({ target: TARGET }).started, true)
  assert.equal(rig.core.moveKind, null, 'there is no connection to keep, so no move is in flight')
  assert.deepEqual(rig.frontLeg.reconfigurations(), [], 'no client, no configuration round')
  assert.equal(rig.core.session.state, 'reconnecting')
  assert.equal(rig.core.cache.warm, false)

  rig.clock.tick(1000)
  assert.equal(rig.events.length, 1)
  assert.deepEqual(rig.events[0].moveTarget, TARGET, 'the next dial goes to the operator\'s backend')
  assert.equal(rig.core.metrics.attaches, attaches)
})

test('#233 the move is refused while the client is still finishing its own configuration', () => {
  // Not warmed on purpose: the puppet is in its own configuration phase and the
  // client attached into it (#16), so it has not reached play.
  const rig = makeCore({ config: { transfer: { keepConnection: true } } })
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig.frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(rig.core.attachConfiguringPlayer({ name: 'Bafbi', uuid: PLAYER }).attached, true)
  assert.equal(rig.core.attached, true)
  assert.equal(rig.core.frontPlayReady, false)

  assert.deepEqual(rig.core.startBackendMove({ target: TARGET }),
    { started: false, reason: 'client_not_in_play' })
  assert.deepEqual(rig.events, [], 'nothing was armed')
  assert.equal(rig.core.session.state, 'configuring')
})

test('#233 a frame from the leg a headless move ended belongs to the dead session', () => {
  // Nobody attached: an operator's move is the dial itself, so its target waits for
  // the next reconnect. The old leg is ended on purpose, and a transfer it sends
  // on the way out is not the new session's: the core drops it as a late frame
  // rather than letting it take the dial the operator's target already owns.
  const rig = makeCore({ config: { transfer: { keepConnection: true } } })
  warmBackend(rig)
  assert.equal(rig.core.startBackendMove({ target: TARGET }).started, true)

  rig.backendLeg.deliver({ state: 'play', name: 'transfer', data: { host: '10.0.0.9', port: 25565 } })
  assert.equal(rig.core.metrics.lateFramesAfterHandover, 1)
  assert.equal(rig.core.metrics.transfersFollowed, 0)

  rig.clock.tick(1000)
  assert.equal(rig.events.length, 1)
  assert.deepEqual(rig.events[0].moveTarget, TARGET, "the operator's target keeps the dial")
  assert.equal(rig.events[0].target, null)
})

test('#233 a move needs a live session to move from', () => {
  // The window this closes: a failed move is restored, the redial to the backend
  // the client holds is still in flight, and a heartbeat move arrives. The cache
  // was reset at the restore, so a move started here would hold an empty snapshot
  // for a client that is playing, and its dial would race the one already out.
  const rig = makeRig()
  attach(rig)
  rig.core.startBackendMove({ target: TARGET })
  rig.clock.tick(1000)
  rig.core.abortTransfer('target_unreachable')
  assert.equal(rig.core.session.state, 'attached', 'the client is back on its snapshot')
  assert.equal(rig.core.backendSessionOpen, false, 'and the puppet has no session behind it yet')

  assert.deepEqual(rig.core.startBackendMove({ target: { host: '10.0.0.9', port: 25565 } }),
    { started: false, reason: 'backend_not_open' })
  assert.equal(rig.events.length, 1, 'no second dial was armed by the refusal')
})

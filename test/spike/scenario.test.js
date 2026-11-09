// Gate A protocol test: the full scenario under node:test.
// Run via `mise run spike`. The default `mise run test` is socket-free.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSpikeScenario } from '../../src/spike/scenario.js'
import { PUPPET_PROFILE } from '../../src/spike/proxy.js'

test('Gate A: relay, synthesized join, detach survival, reattach current state', async () => {
  // silence proxy/backend/fake-client JSON logs during the test run
  const report = await runSpikeScenario({ logStream: null })

  // No scenario assertion may fail.
  assert.deepEqual(
    report.failedAssertions,
    [],
    `scenario assertions failed: ${report.failedAssertions.join(', ')}`
  )
  assert.equal(report.passed, true)

  const { metrics, backend, client1, client2 } = report

  // Invariant 1: exactly one backend login for the whole run, despite two attaches.
  assert.equal(metrics.backendLogins, 1)
  assert.equal(backend.logins, 1)
  assert.equal(metrics.attachTotal, 2)
  assert.equal(metrics.detachTotal, 1)

  // Invariant 2: the attaching client sees the forged puppet profile.
  assert.equal(client1.profile.username, PUPPET_PROFILE.username)
  assert.equal(client1.profile.uuid, PUPPET_PROFILE.uuid)

  // Invariant 3: the synthesized join carried the backend's entity id and the
  // loading-screen release (game_state_change 13) plus position and chunk.
  assert.equal(client1.names.includes('login'), true)
  assert.equal(client1.names.includes('position'), true)
  assert.equal(client1.names.includes('map_chunk'), true)
  assert.equal(client1.names.includes('chunk_batch_start'), true)
  assert.equal(client1.names.includes('chunk_batch_finished'), true)
  assert.equal(client1.positions.length > 0, true)

  // Invariant 4: serverbound movement/dig/place reached the backend.
  assert.ok(backend.positions >= 1, 'backend saw at least one position')
  assert.ok(backend.digs >= 1, 'backend saw at least one block_dig')
  assert.ok(backend.places >= 1, 'backend saw at least one block_place')
  assert.ok(metrics.serverboundForwarded >= 3, 'relay counted serverbound frames')

  // Invariant 5: the reattach saw current (post-detach) state.
  const firstReattachPos = client2.positions[0]
  assert.equal(firstReattachPos.x, 2.5, 'reattach lands on the client pose, not the old backend teleport')
  assert.equal(firstReattachPos.y, 1.62)
  assert.equal(firstReattachPos.z, 2.5)
  const lastPos = client2.positions.at(-1)
  assert.equal(lastPos.x, 8.5, 'live backend teleport reaches the attached client')
  assert.equal(lastPos.y, 1.62)
  assert.equal(lastPos.z, 8.5)
  assert.ok(
    client2.blockChanges.some(b => b.location.x === 3 && b.location.z === 3),
    'client2 saw the block_change sent while detached'
  )

  // Invariant 6: per-leg ownership never bridges client sentinels.
  assert.ok(backend.teleportConfirms.includes(1))
  assert.ok(backend.teleportConfirms.includes(2))
  assert.equal(backend.teleportConfirms.includes(777), false)
  assert.ok(backend.chunkBatchAcks.includes(32))
  assert.equal(backend.chunkBatchAcks.includes(1), false)
  assert.equal(backend.keepAlives.includes('424242'), false)
  assert.ok(metrics.positionsSynthesized >= 2)

  // Invariant 7: liveness, not just join success.
  assert.equal(client1.ended, 'socketClosed') // intentional detach, not a kick during soak
  assert.deepEqual(client1.errors, [])
  assert.equal(client2.ended, null)
  assert.deepEqual(client2.errors, [])

  // Invariant 8: chat is blocked in both directions, backend saw none.
  assert.equal(metrics.chatBlocked, 1)
  assert.equal(backend.chats, 0)
  assert.equal(backend.chatCommands, 0)
  assert.equal(backend.chatAcks, 0)
  assert.equal(backend.chatSessionUpdates, 0)
  assert.equal(client2.names.includes('player_chat'), false)
  assert.equal(client2.names.includes('system_chat'), false)

  // Boundedness: the cache stayed within its cap.
  assert.ok(metrics.framesCached <= 512 + 16, 'cache stayed bounded')
  assert.equal(metrics.cacheOverflow, 0)
  assert.equal(metrics.frontRejected, 0)
})

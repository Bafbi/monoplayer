// Protocol spike scenario, shared by the CLI runner (src/spike/run.js) and the
// test wrapper (test/spike/scenario.test.js). Proves, on loopback:
//
//  1. the proxy relays login/config/play from backend to an attaching client
//  2. the synthesized play join (login, game_state_change, position, chunk batch)
//  3. serverbound movement/dig/place reach the backend exactly once
//  4. client disconnect detaches only the front leg; the backend leg survives
//  5. a reattach after detached-state mutations sees current state
//  6. the backend never sees a second login
//  7. (stretch) chat from the attaching client is blocked at the proxy
import { createFakeBackend } from '../legs/fake-backend.js'
import { createProxy, PUPPET_PROFILE } from './proxy.js'
import { createFakeClient } from './fake-client.js'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

// Resolve a dependency's own package.json version even when its package
// does not export the ./package.json subpath (pnpm-friendly).
const pkgVersion = name => {
  let dir = path.dirname(require.resolve(name))
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
    } catch {}
    dir = path.dirname(dir)
  }
  return 'unknown'
}

const waitUntil = (pred, label, ms = 10000) => new Promise((resolve, reject) => {
  const started = Date.now()
  const tick = () => {
    let ok = false
    try { ok = pred() } catch {}
    if (ok) return resolve()
    if (Date.now() - started > ms) return reject(new Error(`timeout waiting for ${label}`))
    setTimeout(tick, 10)
  }
  tick()
})

export async function runSpikeScenario ({ logStream = process.stdout, soakMs = Number(process.env.SPIKE_SOAK_MS ?? 5000) } = {}) {
  const started = new Date().toISOString()
  const assertions = []
  const check = (name, ok, detail = {}) => {
    assertions.push({ name, ok, detail })
    return ok
  }

  let backend
  let proxy
  let client1
  let client2
  let snapshot = null
  const closeFns = []

  try {
    // ---- Phase 1: start backend, start proxy, warm the cache ----
    backend = await createFakeBackend({ logStream: null })
    closeFns.push(() => backend.close())
    proxy = createProxy({ backendHost: '127.0.0.1', backendPort: backend.port, logStream })
    closeFns.push(() => proxy.close())

    await waitUntil(() => proxy.frontPort !== null, 'proxy front leg listening')
    await waitUntil(() => proxy.cacheNames().includes('chunk_batch_finished'), 'cache warm')

    const CACHED_JOIN = ['login', 'game_state_change', 'chunk_batch_start', 'map_chunk', 'chunk_batch_finished']
    check('cache holds the join sequence',
      CACHED_JOIN.every(n => proxy.cacheNames().includes(n)) &&
      !proxy.cacheNames().includes('position'), // synthesized fresh per attach
      { cacheNames: proxy.cacheNames() })

    // ---- Phase 2: attach client 1, verify the synthesized join ----
    client1 = createFakeClient({ port: proxy.frontPort, username: 'Attacher', logStream: null })
    closeFns.push(() => client1.close())
    await client1.ready()

    const expectedJoin = ['login', 'game_state_change', 'position', 'chunk_batch_start', 'map_chunk', 'chunk_batch_finished']
    check('client1 join order is exact',
      JSON.stringify(client1.received.names.slice(0, expectedJoin.length)) === JSON.stringify(expectedJoin),
      { names: client1.received.names.slice(0, expectedJoin.length) })
    check('client1 receives play login', client1.received.login?.entityId === 42,
      { entityId: client1.received.login?.entityId })
    check('client1 receives position',
      client1.received.positions[0]?.x === 0.5 &&
      client1.received.positions[0]?.y === 1.62 &&
      client1.received.positions[0]?.z === 0.5,
      { first: client1.received.positions[0] })
    check('client1 receives map_chunk',
      client1.received.mapChunks[0]?.x === 0 &&
      client1.received.mapChunks[0]?.z === 0 &&
      client1.received.mapChunks[0]?.chunkData?.length > 0,
      { mapChunk: client1.received.mapChunks[0] && {
        x: client1.received.mapChunks[0].x,
        z: client1.received.mapChunks[0].z,
        bytes: client1.received.mapChunks[0].chunkData?.length
      } })
    check('client1 receives game_state_change 13',
      client1.received.gameStateChanges.some(g => g.reason === 'level_chunks_load_start'))
    check('client1 sees the puppet profile',
      client1.received.profile?.username === PUPPET_PROFILE.username &&
      client1.received.profile?.uuid === PUPPET_PROFILE.uuid,
      { profile: client1.received.profile })
    check('attach replayed cached frames plus a synthesized position',
      proxy.metrics.framesReplayed >= expectedJoin.length - 1 &&
      proxy.metrics.positionsSynthesized >= 1,
      { framesReplayed: proxy.metrics.framesReplayed, positionsSynthesized: proxy.metrics.positionsSynthesized })

    // ---- Phase 3: movement and block actions relay to the backend ----
    client1.sendPosition({ x: 2.5, y: 1.62, z: 2.5 })
    client1.sendDig({ x: 1, y: 0, z: 1 }, 2) // status 2 = finished digging
    client1.sendPlace({ x: 2, y: 0, z: 2 })
    // Sentinels that must never cross the proxy.
    client1.sendTeleportConfirm(777)
    client1.sendChunkBatchReceived(1)
    client1.sendKeepAlive(424242)
    await waitUntil(
      () => backend.received.positions.length >= 1 &&
        backend.received.digs.length >= 1 &&
        backend.received.places.length >= 1,
      'backend receives movement + dig + place')

    check('backend receives client1 position',
      backend.received.positions.length === 1 &&
      backend.received.positions[0].x === 2.5 &&
      backend.received.positions[0].y === 1.62 &&
      backend.received.positions[0].z === 2.5,
      { positions: backend.received.positions })
    check('backend receives block_dig exactly once',
      backend.received.digs.length === 1 &&
      backend.received.digs[0].location.x === 1 &&
      backend.received.digs[0].location.z === 1,
      { digs: backend.received.digs })
    check('backend receives block_place exactly once',
      backend.received.places.length === 1 &&
      backend.received.places[0].location.x === 2 &&
      backend.received.places[0].location.z === 2,
      { places: backend.received.places })
    check('serverbound relay counted', proxy.metrics.serverboundForwarded >= 3,
      { serverboundForwarded: proxy.metrics.serverboundForwarded })
    check('client teleport confirm sentinel did not reach backend',
      !backend.received.teleportConfirms.includes(777),
      { teleportConfirms: backend.received.teleportConfirms })
    check('client chunk-batch ack sentinel did not reach backend',
      !backend.received.chunkBatchAcks.includes(1),
      { chunkBatchAcks: backend.received.chunkBatchAcks })
    check('client keep-alive sentinel did not reach backend',
      !backend.received.keepAlives.map(String).includes('424242'),
      { keepAlives: backend.received.keepAlives.map(String) })

    // ---- Phase 4: attach liveness/soak ----
    await new Promise(resolve => setTimeout(resolve, soakMs))
    check('client1 stayed connected through the soak',
      client1.received.ended === null && client1.received.errors.length === 0,
      { ended: client1.received.ended, errors: client1.received.errors })
    check('front keep-alive observed',
      client1.received.names.includes('keep_alive'),
      { names: client1.received.names.slice(-8) })
    check('proxy still considers client1 attached',
      proxy.attachedClient !== null &&
      proxy.attachedClient.username === PUPPET_PROFILE.username,
      { attached: Boolean(proxy.attachedClient) })
    check('backend leg still in play',
      proxy.backend.state === 'play',
      { backendState: proxy.backend.state })
    check('backend keep-alive observed while attached',
      backend.received.keepAlives.length >= 1,
      { keepAlives: backend.received.keepAlives.map(String) })

    // ---- Phase 5: detach survival ----
    await client1.close()
    await waitUntil(() => proxy.metrics.detachTotal === 1, 'client1 detach recorded')
    await new Promise(resolve => setTimeout(resolve, soakMs))
    check('detach recorded', proxy.metrics.detachTotal === 1)
    check('backend still has exactly one login', backend.received.logins === 1,
      { logins: backend.received.logins })
    check('proxy backendLogins is 1', proxy.metrics.backendLogins === 1)
    check('backend leg still in play after detach',
      proxy.backend.state === 'play',
      { backendState: proxy.backend.state })
    check('backend keep-alive observed while detached',
      backend.received.keepAlives.length >= 2,
      { keepAlives: backend.received.keepAlives.map(String) })

    // ---- Phase 6: state changes while detached, then reattach ----
    const stoneState = require('minecraft-data')('26.1').blocksByName.stone.defaultState
    const baselineCached = proxy.metrics.framesCached
    backend.sendBlockChange({ x: 3, y: 0, z: 3 }, stoneState)
    backend.sendPlayerChat('detached chat must not replay')
    await waitUntil(() => proxy.metrics.framesCached >= baselineCached + 1,
      'cache absorbs detached block_change')

    client2 = createFakeClient({ port: proxy.frontPort, username: 'Attacher', logStream: null })
    closeFns.push(() => client2.close())
    await client2.ready()
    await client2.waitFor(() => client2.received.blockChanges.length > 0, 'client2 block_change')

    check('client2 receives the current block_change',
      client2.received.blockChanges.some(b =>
        b.location.x === 3 && b.location.y === 0 && b.location.z === 3 && b.type === stoneState),
      { blockChanges: client2.received.blockChanges })
    const reattachPos = client2.received.positions.at(-1)
    check('client2 lands on client1 current pose, not the stale backend teleport',
      reattachPos && reattachPos.x === 2.5 && reattachPos.y === 1.62 && reattachPos.z === 2.5,
      { lastPos: reattachPos })
    check('client2 sees the puppet profile',
      client2.received.profile?.username === PUPPET_PROFILE.username &&
      client2.received.profile?.uuid === PUPPET_PROFILE.uuid,
      { profile: client2.received.profile })
    check('clientbound player_chat was not cached or replayed',
      !client2.received.names.includes('player_chat') &&
      !proxy.cacheNames().includes('player_chat'),
      { clientNames: client2.received.names, cacheNames: proxy.cacheNames() })

    // Backend teleport while attached is synthesized with a proxy-owned ID.
    backend.sendPosition({ x: 8.5, y: 1.62, z: 8.5 })
    await client2.waitFor(
      () => client2.received.positions.some(p => p.x === 8.5 && p.y === 1.62 && p.z === 8.5),
      'client2 current backend teleport')
    const lastPos = client2.received.positions.at(-1)
    check('client2 receives the live backend teleport',
      lastPos && lastPos.x === 8.5 && lastPos.y === 1.62 && lastPos.z === 8.5,
      { lastPos })
    check('backend saw proxy-owned teleport confirms',
      backend.received.teleportConfirms.includes(1) &&
      backend.received.teleportConfirms.includes(2) &&
      !backend.received.teleportConfirms.includes(777),
      { teleportConfirms: backend.received.teleportConfirms })
    check('backend saw the proxy chunk-batch ack',
      backend.received.chunkBatchAcks.includes(32) &&
      !backend.received.chunkBatchAcks.includes(1),
      { chunkBatchAcks: backend.received.chunkBatchAcks })
    check('second attach counted', proxy.metrics.attachTotal === 2,
      { attachTotal: proxy.metrics.attachTotal })

    // ---- Phase 7: backend logins remain exactly 1 ----
    check('backend logins exactly 1 after reattach',
      backend.received.logins === 1 && proxy.metrics.backendLogins === 1,
      { backendLogins: backend.received.logins, proxyBackendLogins: proxy.metrics.backendLogins })

    // ---- Phase 8 (stretch): chat is blocked in both directions ----
    client2.sendChat('hello from the attaching client')
    await waitUntil(() => proxy.metrics.chatBlocked === 1, 'chat blocked at proxy')
    check('serverbound chat blocked at proxy', proxy.metrics.chatBlocked === 1,
      { chatBlocked: proxy.metrics.chatBlocked })
    check('serverbound chat never reached the backend',
      backend.received.chats.length === 0 &&
      backend.received.chatCommands.length === 0 &&
      backend.received.chatAcks.length === 0 &&
      backend.received.chatSessionUpdates.length === 0,
      {
        chats: backend.received.chats.length,
        commands: backend.received.chatCommands.length,
        acks: backend.received.chatAcks.length,
        sessions: backend.received.chatSessionUpdates.length
      })
    check('clientbound chat never reached the client',
      !client2.received.names.includes('system_chat') &&
      !client2.received.names.includes('player_chat'),
      { names: client2.received.names })

    // Snapshot before teardown: closing client2 must not change the report.
    snapshot = {
      timestamp: new Date().toISOString(),
      started,
      passed: assertions.every(a => a.ok),
      assertionCount: assertions.length,
      failedAssertions: assertions.filter(a => !a.ok).map(a => a.name),
      assertions: [...assertions],
      metrics: { ...proxy.metrics },
      cache: {
        size: proxy.cacheSize,
        names: proxy.cacheNames()
      },
      backend: {
        port: backend.port,
        logins: backend.received.logins,
        positions: backend.received.positions.length,
        digs: backend.received.digs.length,
        places: backend.received.places.length,
        chats: backend.received.chats.length,
        chatCommands: backend.received.chatCommands.length,
        chatAcks: backend.received.chatAcks.length,
        chatSessionUpdates: backend.received.chatSessionUpdates.length,
        teleportConfirms: [...backend.received.teleportConfirms],
        keepAlives: backend.received.keepAlives.map(String),
        chunkBatchAcks: [...backend.received.chunkBatchAcks]
      },
      client1: {
        profile: client1.received.profile,
        names: [...client1.received.names],
        positions: [...client1.received.positions],
        errors: [...client1.received.errors],
        ended: client1.received.ended
      },
      client2: {
        profile: client2.received.profile,
        names: [...client2.received.names],
        positions: [...client2.received.positions],
        blockChanges: [...client2.received.blockChanges],
        errors: [...client2.received.errors],
        ended: client2.received.ended
      },
      versions: {
        minecraftVersion: '26.1',
        protocol: 775,
        node: process.version,
        minecraftProtocol: pkgVersion('minecraft-protocol'),
        minecraftData: pkgVersion('minecraft-data'),
        prismarineChunk: pkgVersion('prismarine-chunk'),
        vec3: pkgVersion('vec3')
      },
      notes: [
        'Spike uses library auto-config on the front leg; config-phase replay is not exercised.',
        'Fake client is a protocol client, not the official vanilla client.',
        'Both legs are offline; encryption and online-mode hasJoined are not exercised.',
        'Chat is blocked in both directions; clientbound player_chat is not cached or replayed.',
        'The attach pose is reconstructed from the attaching client movement, with a proxy-owned teleport id.',
        `Attach/detach liveness soak is ${soakMs} ms, not the architecture's 5-minute window.`,
        'One backend login for the whole scenario (no reconnect on attach).'
      ]
    }
  } finally {
    for (const fn of closeFns.reverse()) {
      try { await fn() } catch {}
    }
  }

  return snapshot
}

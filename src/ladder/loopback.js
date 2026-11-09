// The product offline loopback rung: real front/backend legs, the fake node
// backend, and a real 26.1 protocol bot. No auth, no .secrets, loopback only.
//
//   node src/ladder/loopback.js [--report <file>] [--verbose]
//
// Exit codes: 0 all assertions pass, 1 assertion/timeout failure, 2 setup
// failure. The report is written in finally, even on failure.
//
// Assertions R0, O32, O33-O35, and O1-O31 (including O11b and O24b) are the
// contract
// (docs/testing-ladder.md). A FAIL is a real finding; do not weaken a check to
// get a green run.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFakeBackend, emptySlot, itemStack } from '../legs/fake-backend.js'
import { createMonoplayer, loadConfig } from '../service/monoplayer.js'
import { createOfflineBackendLeg } from '../legs/live-backend.js'
import { createOfflineFrontLeg } from '../legs/live-front.js'
import { waitForReady } from '../service/readiness.js'
import { offlineUuid } from '../legs/offline-identity.js'
import { createWireChecker } from '../core/wire-check.js'
import { createBot } from './bot.js'
import { createHandshakeProxy } from './handshake-proxy.js'
import { advancementComplete, applyAdvancementFrames } from './client-state.js'
import { PARITY_FRAME_NAMES, attachParity, parityReplayNames } from './state-parity.js'

const VERSION = '26.1'
const DEFAULT_REPORT = '.reports/loopback-report.json'

function flag (argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

function waitFor (pred, label, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms
    const tick = () => {
      let ok = false
      try { ok = pred() } catch { /* treat a throwing predicate as not ready */ }
      if (ok) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`timed out after ${ms} ms waiting for ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function detail (value) {
  if (value === undefined) return ''
  const json = JSON.stringify(value, (key, inner) => typeof inner === 'bigint' ? String(inner) : inner)
  return json === undefined ? String(value) : json
}

export async function runLoopback (argv = process.argv.slice(2)) {
  const verbose = argv.includes('--verbose')
  const reportPath = flag(argv, '--report') ?? DEFAULT_REPORT
  const startedAt = Date.now()

  const assertions = []
  const logs = []
  // Bounded wait for a check that must report what arrived instead of throwing.
  const settleUntil = async (pred, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { if (pred()) return true } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return false
  }
  let stopping = false
  let failed = false
  let phase = 'setup'
  let exitCode = 0
  let runError = null

  let fake = null
  let fake2 = null
  let handshakeProxy = null
  let front = null
  let backend = null
  let core = null
  let bot1 = null
  let bot2 = null
  let bot3 = null
  let bot4 = null
  let bot5 = null
  let stranger = null
  let seamlessFront = null
  let seamlessBackend = null
  let seamlessCore = null

  const evidence = {
    frontPort: null,
    backendPort: null,
    configReplayMode: null,
    wire: null,
    backendLogins: null,
    attaches: null,
    denials: null,
    serverbound: { positions: null, digs: null, places: null },
    bot: { playPrefix: [], leftovers: null, errors: null }
  }

  const log = (event, fields = {}) => {
    logs.push({ event, fields })
    if (verbose) process.stderr.write(`[log] ${event} ${detail(fields)}\n`)
  }

  function check (id, name, ok, info = null) {
    const record = { id, name, ok: ok === true, detail: info }
    assertions.push(record)
    if (!record.ok) failed = true
    process.stdout.write(`${record.ok ? 'PASS' : 'FAIL'} ${id} ${name}${info === null ? '' : ` — ${detail(info)}`}\n`)
    return record.ok
  }

  try {
    // --- setup: fake backend, config, real legs, core ---
    // A cap the protocol library never sends by default (10), so O26 proves the
    // puppet replaced its own value instead of matching it by accident.
    // #21: this backend also has the code of conduct enabled, so the puppet's
    // first configuration phase carries a gate that the protocol library
    // answers itself. Nothing is attached yet, so this is the no-client
    // fallback: the leg accepts it and says so (O32).
    fake = await createFakeBackend({ port: 0, logStream: null, viewDistance: 6, codeOfConduct: true })
    evidence.backendPort = fake.port
    // A second backend is the target of the followed transfers (O21-O24, the
    // default detach path, and O33-O35, the kept connection).
    fake2 = await createFakeBackend({ port: 0, logStream: null })
    evidence.backend2Port = fake2.port
    // The nmp fake server predates intent 3. The proxy records the real
    // intent on the wire and rewrites it for the fake target; without this,
    // the loopback cannot catch the sky-2 "not by this method" failure.
    handshakeProxy = await createHandshakeProxy({ targetPort: fake2.port, log })
    evidence.handshakeProxyPort = handshakeProxy.port
    const baseTarget = { host: '127.0.0.1', port: fake.port }

    const offlineWhitelist = [offlineUuid('Attach'), offlineUuid('Second')]
    const puppetUuid = offlineUuid('GlowSquidye')
    if (offlineWhitelist.includes(puppetUuid)) {
      throw new Error('the puppet offline UUID must not be whitelisted')
    }

    const config = loadConfig({
      version: VERSION,
      attachWhitelist: offlineWhitelist,
      front: { host: '127.0.0.1', port: 0 },
      backend: { host: '127.0.0.1', port: fake.port },
      puppet: { username: 'GlowSquidye', uuid: null },
      // O29 needs the speaking path. The default is read-only, and this rung is
      // the only place a real client-side frame meets the relay.
      chat: 'full',
      // The default is the kept connection (#22). O21-O24 pin the detach path,
      // which is still reachable and is what a kept connection restores to, so
      // this rung states it rather than inheriting it.
      transfer: { keepConnection: false }
    })

    backend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: fake.port,
      version: VERSION,
      username: 'GlowSquidye',
      // The deployed lanes set this, and O30 proves it never reaches a play
      // dialog: the dialog waits for the human instead of being clicked (#20).
      dialogAction: 'last',
      // #21: a gate is the human's while they are attached, and the puppet's
      // own accept is reported to the core so nothing waits for a client.
      isHumanAttached: () => core.attached === true,
      onDialogAnswered: ({ state }) => core.notePuppetDialogAnswer({ state }),
      log
    })
    const wire = createWireChecker({ version: VERSION })

    front = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist,
      getSnapshotConfig: () => core.cache.snapshot().config,
      wireCheck: payload => wire.check(payload),
      wireMode: 'throw',
      chat: 'full',
      log
    })

    core = createMonoplayer({
      config,
      backendLeg: backend,
      frontLeg: front,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('core', { line }) }
    })
    front.setCoreAttachConfiguring(({ name, uuid }) => core.attachConfiguringPlayer({ name, uuid }))
    front.setConfiguringHandler(({ name }) => core.configuringReady({ name }))
    front.setClientSettingsHandler(settings => core.noteClientSettings(settings))
    // Every successful attach records the cache as it stood when its replay was
    // built, so O27 below can check the N13 frame cut against the real client's
    // decode.
    const attachCuts = []
    front.setCoreAttach(({ name, uuid }) => {
      const attachSnapshot = core.cache.snapshot()
      const attachPose = core.session.currentPose
      const outcome = core.attachPlayer({ name, uuid, includeConfig: false })
      if (outcome.attached) {
        attachCuts.push({ snapshot: { ...attachSnapshot, pose: attachPose }, replayFrames: outcome.frames ?? [] })
      }
      return outcome
    })
    core.start()

    // One backend.connect() per reconnect_due. The guard makes a loop
    // impossible even if two dues were ever emitted close together.
    let reconnecting = false
    core.on('reconnect_due', async ({ delayMs, target } = {}) => {
      if (stopping || reconnecting) return
      reconnecting = true
      core.session.backendConnecting({ initial: false })
      try {
        backend.setTarget(target ?? baseTarget, {
          keepCookies: target !== undefined && target !== null,
          transfer: target !== undefined && target !== null
        })
        await backend.connect()
        log('backendReconnect', {
          delayMs,
          target: target ? `${target.host}:${target.port}` : null,
          backendLogins: core.session.backendLogins
        })
      } catch (error) {
        core.session.fail()
        log('backendReconnectFailed', { delayMs, error: String(error?.message ?? error).slice(0, 300) })
      } finally {
        reconnecting = false
      }
    })

    // --- run: connect, readiness, listen ---
    phase = 'run'
    await backend.connect()
    // #21: the gate is answered before this promise resolves, because the fake
    // backend withholds finish_configuration until the accept arrives.
    const gateAtConnect = {
      sends: fake.received.codeOfConductSends,
      accepts: fake.received.codeOfConductAccepts,
      logged: logs.some(entry => entry.event === 'codeOfConductAccepted'),
      heldLogged: logs.some(entry => entry.event === 'codeOfConductHeld'),
      queued: core.pendingDialog.held,
      answeredByPuppet: core.metrics.controlDialogsPuppetAnswered
    }
    evidence.gate = gateAtConnect
    const readiness = await waitForReady({ core, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    check('R0', 'readiness warm from chunk_batch_finished', readiness.warm === true, {
      warm: readiness.warm,
      configFrames: readiness.configFrames,
      prefixFrames: readiness.prefixFrames,
      elapsedMs: readiness.elapsedMs
    })
    if (!readiness.warm) throw new Error('readiness did not reach the warm marker')

    const bound = await front.listen()
    evidence.frontPort = bound.port ?? front.port

    // --- late-attach churn: mutate cached state before the first attach ---
    // Production attaches minutes after the puppet joined, so the replay must
    // carry the newest inventory base, every slot update after it, and the
    // detached block edit. The base fills every other slot empty so a join
    // frame that survived would show up as a stale slot.
    const LATE_BLOCK = { x: 4, y: 0, z: 4 }
    const LATE_POSE = { x: 4.5, y: 1.62, z: 4.5 }
    const lateItems = Array.from({ length: 46 }, emptySlot)
    lateItems[36] = itemStack(1, 1)
    fake.sendWindowItems({ windowId: 0, stateId: 1, items: lateItems })
    fake.sendSetSlot({ windowId: 0, stateId: 1, slot: 40, item: itemStack(2, 3) })
    fake.sendSetSlot({ windowId: 0, stateId: 1, slot: 41, item: itemStack(5, 2) })
    fake.sendBlockChange(LATE_BLOCK)
    await waitFor(() => {
      const snapshot = core.cache.snapshot()
      const base = snapshot.inventories.find(entry =>
        entry.name === 'window_items' && entry.data?.windowId === 0)
      const slots = snapshot.inventories.filter(entry =>
        entry.name === 'set_slot' && entry.data?.windowId === 0)
      const block = snapshot.blocks.some(entry =>
        entry.data?.location?.x === LATE_BLOCK.x &&
        entry.data?.location?.y === LATE_BLOCK.y &&
        entry.data?.location?.z === LATE_BLOCK.z)
      return base?.data?.items?.[36]?.itemId === 1 &&
        slots.some(entry => entry.data.slot === 40 && entry.data.item?.itemId === 2) &&
        slots.some(entry => entry.data.slot === 41 && entry.data.item?.itemId === 5) &&
        block
    }, 'late-attach inventory, slots, and block in the cache')

    // Entity churn: an absolute spawn, three relative moves, then an absolute
    // correction. A delta only means something after the frame before it, and
    // the cache routes absolutes and deltas to different rings, so this is the
    // sequence whose replay order decides where the attaching client puts the
    // entity (issue #35).
    const ENTITY_ID = 99
    const ENTITY_TRACK = { spawn: 0, moves: 3, corrected: 10 }
    fake.sendSpawnEntity({ entityId: ENTITY_ID, x: ENTITY_TRACK.spawn, y: 64, z: 0 })
    for (let i = 0; i < ENTITY_TRACK.moves; i++) {
      fake.sendRelEntityMove({ entityId: ENTITY_ID, dx: 1 })
    }
    fake.sendSyncEntityPosition({ entityId: ENTITY_ID, x: ENTITY_TRACK.corrected, y: 64, z: 0 })
    await waitFor(() => {
      const snapshot = core.cache.snapshot()
      const spawn = snapshot.entities.some(entry =>
        entry.name === 'spawn_entity' && entry.data?.entityId === ENTITY_ID)
      const moves = snapshot.generic.filter(entry =>
        entry.name === 'rel_entity_move' && entry.data?.entityId === ENTITY_ID).length
      const correction = snapshot.entities.some(entry =>
        entry.name === 'sync_entity_position' && entry.data?.entityId === ENTITY_ID)
      return spawn && moves === ENTITY_TRACK.moves && correction
    }, 'the entity spawn, moves, and correction in the cache')

    // --- O1-O9: first attach and replay ---
    // A human whose client information differs from the vanilla defaults: the
    // server's view must show these fields, and must not take the client's
    // own render distance for the chunk send (#18).
    bot1 = createBot({
      port: evidence.frontPort,
      username: 'Attach',
      clientSettings: {
        locale: 'fr_fr',
        viewDistance: 2,
        chatFlags: 0,
        chatColors: true,
        skinParts: 96,
        mainHand: 0
      }
    })
    // Capture the decoded frames the parity model needs before ready(): the
    // replay happens at attach time, so a listener installed after would miss
    // the stream O28 compares.
    const parityFrames = []
    bot1.client.on('packet', (data, meta) => {
      if (meta?.state !== 'play' || !PARITY_FRAME_NAMES.has(meta.name)) return
      parityFrames.push({ name: meta.name, data })
    })
    await bot1.ready()
    const b1 = bot1.received
    // The replay streams the warm domains after the join prefix; wait for the
    // late-attach frames before O1 snapshots the play-name list.
    await bot1.waitFor(
      () => b1.windowItems.some(packet => packet.windowId === 0) &&
        b1.setSlots.some(packet => packet.slot === 40) &&
        b1.setSlots.some(packet => packet.slot === 41) &&
        b1.blockChanges.some(change => change.location?.x === LATE_BLOCK.x &&
          change.location?.y === LATE_BLOCK.y && change.location?.z === LATE_BLOCK.z),
      'late-attach replay'
    )
    const playNames = bot1.playNames()

    evidence.configReplayMode = front.lastConfigMode
    evidence.wire = { checked: front.wireStats.checked, rejected: front.wireStats.rejected, byState: front.wireStats.byState }
    evidence.backendLogins = core.session.backendLogins
    evidence.attaches = core.metrics.attaches
    evidence.denials = front.metrics.denied
    evidence.bot = {
      playPrefix: playNames.slice(0, 6),
      leftovers: b1.leftovers.length,
      errors: b1.errors.length
    }

    check(
      'O1',
      'first attach allowed, no denials, offline front leg',
      front.metrics.allowed === 1 && front.metrics.denied === 0 &&
        front.kind === 'offline-front-leg' && front.checkStoreFile === null,
      { allowed: front.metrics.allowed, denied: front.metrics.denied, kind: front.kind }
    )
    check(
      'O2',
      'one backend login',
      fake.received.logins === 1 && core.session.backendLogins === 1,
      { fakeLogins: fake.received.logins, backendLogins: core.session.backendLogins }
    )
    const loginStateLeaks = playNames.filter(name => name === 'encryption_begin' || name === 'compress' || name === 'success')
    check(
      'O3',
      'no login-state frames replayed into play; core ignored them',
      loginStateLeaks.length === 0 && core.metrics.nonPlayFramesIgnored >= 2,
      { leaks: loginStateLeaks, nonPlayFramesIgnored: core.metrics.nonPlayFramesIgnored }
    )
    check(
      'O4',
      'configuration replay came from the cache',
      front.lastConfigMode === 'cached_replay',
      { lastConfigMode: front.lastConfigMode }
    )

    const expectedPrefix = ['login', 'game_state_change', 'position', 'chunk_batch_start', 'map_chunk', 'chunk_batch_finished']
    const prefixOk = expectedPrefix.every((name, i) => playNames[i] === name)
    const gameStateIndexes = playNames.map((name, i) => name === 'game_state_change' ? i : -1).filter(i => i >= 0)
    const firstMapIndex = playNames.indexOf('map_chunk')
    const extraGameStatesOk = gameStateIndexes.slice(1).every(i => i > firstMapIndex)
    check(
      'O5',
      'first six play frames are the join sequence',
      prefixOk && extraGameStatesOk,
      { firstSix: playNames.slice(0, 6) }
    )
    check(
      'O6',
      'login entityId 42, pose 0.5/1.62/0.5, chunk 0,0',
      b1.login?.entityId === 42 &&
        b1.positions[0]?.x === 0.5 && b1.positions[0]?.y === 1.62 && b1.positions[0]?.z === 0.5 &&
        b1.mapChunks[0]?.x === 0 && b1.mapChunks[0]?.z === 0,
      {
        entityId: b1.login?.entityId ?? null,
        firstPosition: b1.positions[0] ? { x: b1.positions[0].x, y: b1.positions[0].y, z: b1.positions[0].z } : null,
        firstChunk: b1.mapChunks[0] ? { x: b1.mapChunks[0].x, z: b1.mapChunks[0].z } : null
      }
    )
    // The replay carries the entity the fake spawned, never a spawn for the
    // player's own entity: that one comes from the join login frame.
    const spawnedIds = parityFrames
      .filter(frame => frame.name === 'spawn_entity')
      .map(frame => frame.data?.entityId ?? null)
    check(
      'O7',
      'the replay carries no spawn for the player entity',
      !spawnedIds.includes(42),
      { spawnEntityIds: spawnedIds }
    )
    const wire1 = front.wireStats
    check(
      'O8',
      'wire checker accepted both configuration and play frames',
      wire1.checked >= 5 && wire1.rejected === 0 &&
        (wire1.byState.configuration ?? 0) > 0 && (wire1.byState.play ?? 0) > 0,
      { checked: wire1.checked, rejected: wire1.rejected, byState: wire1.byState }
    )
    check(
      'O9',
      'first bot saw no leftover bytes and no errors',
      b1.leftovers.length === 0 && b1.errors.length === 0,
      { leftovers: b1.leftovers.length, errors: b1.errors.length }
    )

    // --- O36: a bundled equipment frame reaches the client with its own bytes ---
    // Paper batches equipment updates in a bundle, and the frame's array type
    // carries its terminator flag in the high bit of each slot byte. A relay
    // that hands the client bytes a decoder has already rewritten sends one
    // entry plus trailing bytes, and the client disconnects (#82). Two frames,
    // two and three entries: one entry would not need the flags at all.
    const LIVE_BUNDLE = [
      { entityId: 501, slots: [0, 1] },
      { entityId: 502, slots: [0, 1, 2] }
    ]
    fake.sendEquipmentBundle({ updates: LIVE_BUNDLE })
    // A relay that corrupts the frame makes the client fail the frame rather
    // than delivering it, so the wait is bounded and the check reports what
    // arrived. A bare wait would report a timeout and hide the evidence.
    await settleUntil(
      () => LIVE_BUNDLE.every(update => b1.equipment.some(frame => frame.entityId === update.entityId)),
      3_000
    )
    const liveEquipment = LIVE_BUNDLE.map(update =>
      b1.equipment.find(frame => frame.entityId === update.entityId)?.equipments?.length ?? 0)
    check(
      'O36',
      'a bundled equipment frame keeps every entry when it is relayed live',
      liveEquipment.every((count, i) => count === LIVE_BUNDLE[i].slots.length) &&
        b1.leftovers.every(entry => entry.name !== 'entity_equipment'),
      {
        entries: liveEquipment,
        expected: LIVE_BUNDLE.map(update => update.slots.length),
        equipmentLeftovers: b1.leftovers.filter(entry => entry.name === 'entity_equipment').length
      }
    )

    // --- O27: the N13 frame cut is aligned on a real client ---
    // N13 compares the attach snapshot with the FIRST K captured play frames,
    // where K is the number of parity frames the replay sent. The assumption is
    // that the client decodes exactly the replay, in replay order; a real
    // protocol bot is the only place to observe it.
    const firstCut = attachCuts[0] ?? null
    const replayedParityNames = firstCut ? parityReplayNames(firstCut.replayFrames) : []
    const capturedParityNamesSoFar = () => bot1.playNames()
      .filter(name => PARITY_FRAME_NAMES.has(name))
      .slice(0, replayedParityNames.length)
    if (replayedParityNames.length > 0) {
      await bot1.waitFor(
        () => capturedParityNamesSoFar().length >= replayedParityNames.length,
        'the replayed parity frames'
      )
    }
    // Read the names after the wait: playNames() grows for the life of the bot.
    const capturedParityNames = capturedParityNamesSoFar()
    check(
      'O27',
      'the N13 frame cut matches the replay the client decoded',
      replayedParityNames.length > 0 &&
        JSON.stringify(capturedParityNames) === JSON.stringify(replayedParityNames),
      {
        expectedFrames: replayedParityNames.length,
        expected: replayedParityNames.slice(0, 12),
        captured: capturedParityNames.slice(0, 12)
      }
    )

    // --- O28: the replay lands a moved entity where the backend put it ---
    // The cache holds spawn x=0, three +1 deltas, then a correction to x=10. A
    // replay that puts every absolute before every delta applies the deltas on
    // top of the correction and lands at 13 (issue #35).
    const firstAttach = attachCuts[0] ?? null
    const replayedNames = firstAttach ? parityReplayNames(firstAttach.replayFrames) : []
    if (replayedNames.length > 0) {
      await bot1.waitFor(
        () => parityFrames.length >= replayedNames.length,
        'the replayed parity frames for the entity check'
      )
    }
    const attachEvidence = firstAttach
      ? attachParity({
        attachSnapshot: firstAttach.snapshot,
        replayFrames: firstAttach.replayFrames,
        clientFrames: parityFrames,
        settled: replayedNames.length > 0 && parityFrames.length >= replayedNames.length
      })
      : { ok: false, domains: {} }
    const decodedEntity = (attachEvidence.domains?.entities?.actual ?? [])
      .find(entry => entry.entityId === ENTITY_ID) ?? null
    const decodedX = decodedEntity?.fields?.find(field => field.key === 'x')?.value ?? null
    check(
      'O28',
      'the replay lands a moved entity where the backend put it',
      attachEvidence.ok === true && decodedX === ENTITY_TRACK.corrected,
      {
        entityX: decodedX,
        backendX: ENTITY_TRACK.corrected,
        sectionOrderX: ENTITY_TRACK.corrected + ENTITY_TRACK.moves,
        parity: attachEvidence.ok === true
      }
    )

    // Position churn lands after O6 has read the synthesized join pose: the
    // first position in the replay must stay 0.5/1.62/0.5, so this mutation is
    // applied live and asserted as O19. It is also what a late session sees.
    fake.sendPosition(LATE_POSE)
    await bot1.waitFor(
      () => b1.positions.some(p => p.x === LATE_POSE.x && p.z === LATE_POSE.z),
      'post-attach pose'
    )

    // --- O10: serverbound relay (position, dig, place) ---
    bot1.sendPosition({ x: 2.5, y: 1.62, z: 2.5 })
    await bot1.waitFor(() => fake.received.positions.length === 1, 'backend position')
    bot1.sendDig({ x: 1, y: 0, z: 1 })
    bot1.sendPlace({ x: 2, y: 0, z: 2 })
    await bot1.waitFor(
      () => fake.received.digs.length === 1 && fake.received.places.length === 1,
      'backend dig + place'
    )
    evidence.serverbound = {
      positions: fake.received.positions.length,
      digs: fake.received.digs.length,
      places: fake.received.places.length
    }
    check(
      'O10',
      'exactly one position, dig, and place reached the backend',
      fake.received.positions.length === 1 && fake.received.digs.length === 1 &&
        fake.received.places.length === 1 && core.metrics.serverboundForwarded >= 3,
      { ...evidence.serverbound, forwarded: core.metrics.serverboundForwarded }
    )

    // --- O11: per-leg serverbound sentinels are dropped, never relayed ---
    const droppedBefore = core.metrics.serverboundDropped
    bot1.sendTeleportConfirm(777)
    bot1.sendChunkBatchReceived(1)
    bot1.sendKeepAlive(424242)
    await waitFor(
      () => core.metrics.serverboundDropped >= droppedBefore + 3,
      'core dropped the three serverbound sentinels',
      5000
    )
    const teleportIds = fake.received.teleportConfirms.map(value => String(value))
    const batchAcks = fake.received.chunkBatchAcks.map(value => Number(value))
    const keepAliveIds = fake.received.keepAlives.map(value => String(value))
    check(
      'O11',
      'sentinel teleport/chunk-ack/keep-alive frames were dropped by the core',
      !teleportIds.includes('777') && !batchAcks.includes(1) && !keepAliveIds.includes('424242'),
      {
        teleportConfirms: teleportIds,
        chunkBatchAcks: batchAcks,
        keepAlives: keepAliveIds,
        dropped: core.metrics.serverboundDropped - droppedBefore
      }
    )

    // --- O29: the human's chat is spoken by the puppet leg (#19) ---
    // The bot writes chat the way a client does: signed when it has profile
    // keys, always with an offset into its own last-seen window. The backend
    // must receive the text from the puppet's connection instead, so the
    // message arrives as the account rather than as the human's signature.
    const chatBefore = {
      chats: fake.received.chats.length,
      commands: fake.received.chatCommands.length,
      sent: core.metrics.chatSent,
      forwarded: core.metrics.serverboundForwarded
    }
    bot1.sendChat('hello from the human')
    bot1.sendCommand('list')
    bot1.sendMessageAck(3)
    await bot1.waitFor(
      () => fake.received.chats.length === chatBefore.chats + 1 &&
        fake.received.chatCommands.length === chatBefore.commands + 1,
      'backend chat and command as the puppet'
    )
    const spokenChat = fake.received.chats.at(-1)
    const spokenCommand = fake.received.chatCommands.at(-1)
    evidence.chat = {
      message: spokenChat?.message ?? null,
      command: spokenCommand?.command ?? null,
      chatSent: core.metrics.chatSent,
      forwarded: core.metrics.serverboundForwarded - chatBefore.forwarded,
      messageAcks: fake.received.messageAcknowledgements.length,
      chatSessionUpdates: fake.received.chatSessionUpdates.length
    }
    check(
      'O29',
      'the human chat and command reached the backend as the puppet, and their acks did not',
      spokenChat?.message === 'hello from the human' &&
        spokenCommand?.command === 'list' &&
        core.metrics.chatSent === chatBefore.sent + 2 &&
        core.metrics.serverboundForwarded === chatBefore.forwarded &&
        fake.received.messageAcknowledgements.length === 0,
      evidence.chat
    )

    // --- O12: detach keeps the backend session and the pose ---
    // The front denies a second connection before the whitelist gate while a
    // client holds the attach slot. Detach first so the next check exercises
    // the whitelist denial (reason not_whitelisted), not already_attached.
    await bot1.close()
    await waitFor(() => core.attached === false && core.session.state === 'detached', 'detach')
    check(
      'O12',
      'detach keeps one backend login, no fault, pose retained',
      core.attached === false && core.session.state === 'detached' &&
        core.session.lastFault === null && core.session.backendLogins === 1 &&
        core.session.currentPose.x === 2.5 && core.session.currentPose.z === 2.5,
      {
        attached: core.attached,
        state: core.session.state,
        backendLogins: core.session.backendLogins,
        pose: core.session.currentPose
      }
    )

    // --- non-whitelisted attach is denied before play ---
    stranger = createBot({ port: evidence.frontPort, username: 'Stranger' })
    await withTimeout(stranger.ended, 10_000, 'stranger end')
    const strangerPlayNames = stranger.playNames()
    const deniedLog = logs.some(entry =>
      entry.event === 'attachDenied' && entry.fields?.reason === 'not_whitelisted'
    )
    evidence.denials = front.metrics.denied
    check(
      'O11b',
      'non-whitelisted attach denied before play',
      stranger.received.success === null && strangerPlayNames.length === 0 &&
        stranger.received.errors.length === 0 &&
        front.metrics.denied === 1 && deniedLog,
      {
        success: stranger.received.success !== null,
        playFrames: strangerPlayNames.length,
        errors: stranger.received.errors.length,
        denied: front.metrics.denied,
        deniedLog
      }
    )

    // --- a bundled equipment frame cached while detached (replayed at O37) ---
    // The bundle is the trigger, not the cause: whatever put the frame in the
    // cache, the replay writes the same bytes (#82).
    const DETACHED_BUNDLE = [
      { entityId: 503, slots: [0, 1, 2, 3] },
      { entityId: 504, slots: [0, 1] }
    ]
    fake.sendEquipmentBundle({ updates: DETACHED_BUNDLE })
    await waitFor(
      () => core.cache.snapshot().generic.filter(entry => entry.name === 'entity_equipment').length >= 2,
      'the detached bundled equipment frames in the cache'
    )

    // --- detached block mutation is cached for the next attach ---
    fake.sendBlockChange({ x: 3, y: 0, z: 3 })
    await waitFor(() => core.cache.snapshot().blocks.length >= 1, 'cached block change')

    // --- O30-O31: a control dialog waits for a client and is answered through it ---
    // Nobody is attached: the pending holder keeps the last dialog, the
    // reattaching client receives it, and its answer reaches the backend as the
    // puppet's own frame (#16).
    const DIALOG_ID = 'monoplayer:loopback_dialog'
    fake.sendShowDialog({ id: DIALOG_ID })
    await waitFor(() => core.pendingDialog.held === true, 'the dialog held while detached')

    // --- O13-O14: reattach replays the new pose + cached block ---
    bot2 = createBot({ port: evidence.frontPort, username: 'Second' })
    await bot2.ready()
    const b2 = bot2.received
    await bot2.waitFor(
      () => b2.blockChanges.some(change =>
        change.location?.x === 3 && change.location?.y === 0 && change.location?.z === 3),
      'replayed block change'
    )
    const firstPosition = b2.positions[0]
    const blockReplayed = b2.blockChanges.some(change =>
      change.location?.x === 3 && change.location?.y === 0 && change.location?.z === 3)
    evidence.attaches = core.metrics.attaches
    evidence.backendLogins = core.session.backendLogins
    evidence.wire = { checked: front.wireStats.checked, rejected: front.wireStats.rejected, byState: front.wireStats.byState }
    check(
      'O13',
      'reattach lands at the last pose and replays the detached block edit',
      core.metrics.attaches === 2 && core.session.backendLogins === 1 &&
        firstPosition?.x === 2.5 && firstPosition?.z === 2.5 && blockReplayed,
      {
        attaches: core.metrics.attaches,
        backendLogins: core.session.backendLogins,
        firstPosition: firstPosition ? { x: firstPosition.x, z: firstPosition.z } : null,
        blockReplayed
      }
    )
    check(
      'O14',
      'second bot saw no leftover bytes and the wire stayed clean',
      b2.leftovers.length === 0 && front.wireStats.rejected === 0,
      { leftovers: b2.leftovers.length, rejected: front.wireStats.rejected }
    )

    // --- O37: the replay writes a bundled equipment frame's own bytes ---
    await settleUntil(
      () => DETACHED_BUNDLE.every(update => b2.equipment.some(frame => frame.entityId === update.entityId)),
      3_000
    )
    const replayedEquipment = DETACHED_BUNDLE.map(update =>
      b2.equipment.find(frame => frame.entityId === update.entityId)?.equipments?.length ?? 0)
    check(
      'O37',
      'a bundled equipment frame replayed from the cache keeps every entry',
      replayedEquipment.every((count, i) => count === DETACHED_BUNDLE[i].slots.length) &&
        b2.leftovers.every(entry => entry.name !== 'entity_equipment') &&
        front.wireStats.rejected === 0,
      {
        entries: replayedEquipment,
        expected: DETACHED_BUNDLE.map(update => update.slots.length),
        equipmentLeftovers: b2.leftovers.filter(entry => entry.name === 'entity_equipment').length,
        rejected: front.wireStats.rejected
      }
    )

    // --- O30-O31: the held dialog reaches the client, and its answer reaches the backend ---
    await bot2.waitFor(() => b2.dialogs.length > 0, 'the held dialog re-sent on attach')
    // The backend leg runs MONOPLAYER_DIALOG_ACTION=last, and it must not have
    // clicked: a play dialog is the human's, so the leg logged the wait and the
    // backend saw no click of its own (#20).
    const puppetClicks = fake.received.customClickActions.length
    const waited = logs.some(entry =>
      entry.event === 'dialogUnhandled' && entry.fields?.reason === 'play_dialog_waits'
    )
    check(
      'O30',
      'a dialog sent with no client attached waits, unclicked by the puppet, and is delivered to the reattaching client',
      b2.dialogs.length === 1 && core.metrics.controlDialogsHeld === 1 &&
        core.metrics.controlDialogsResent === 1 && puppetClicks === 0 && waited &&
        core.logs().some(line => line.includes('"event":"controlDialogResent"')),
      {
        dialogs: b2.dialogs.length,
        held: core.metrics.controlDialogsHeld,
        resent: core.metrics.controlDialogsResent,
        puppetClicks,
        waited
      }
    )

    bot2.answerDialog(DIALOG_ID)
    await waitFor(() => fake.received.customClickActions.length > 0, 'the dialog answer on the backend leg')
    check(
      'O31',
      'the client answer reaches the backend as the puppet dialog click',
      fake.received.customClickActions.length === 1 &&
        fake.received.customClickActions[0].id === DIALOG_ID &&
        core.metrics.controlDialogsAnswered === 1 &&
        core.pendingDialog.held === false,
      {
        clicks: fake.received.customClickActions.map(click => click.id),
        answered: core.metrics.controlDialogsAnswered,
        pending: core.pendingDialog.held
      }
    )

    // --- O32: the code-of-conduct gate, answered by the puppet while nobody was
    // attached ---
    // The library writes the accept itself, before the core sees the gate. The
    // leg's write wrapper lets it out only because no client holds the slot,
    // logs it, and tells the core, so the gate never becomes the next client's
    // question. The bot never answered it: O30's one resent dialog is the play
    // dialog, and the gate's accept is the one the backend counted at connect.
    check(
      'O32',
      'a configuration gate with no client attached is accepted by the puppet, logged, and not held for the next client',
      gateAtConnect.sends === 1 && gateAtConnect.accepts === 1 &&
        gateAtConnect.logged === true && gateAtConnect.heldLogged === false &&
        gateAtConnect.queued === false && gateAtConnect.answeredByPuppet === 1 &&
        core.metrics.controlDialogsResent === 1,
      {
        ...gateAtConnect,
        resent: core.metrics.controlDialogsResent,
        held: core.metrics.controlDialogsHeld
      }
    )

    // --- O15-O16: one backend fault, one reconnect, one fresh login ---
    // Destroying the backend leg's socket is the same path a dropped Paper
    // connection takes: client 'end' -> core backend_down -> one timer ->
    // reconnect_due -> one backend.connect().
    const loginsBeforeFault = fake.received.logins
    backend.client.socket.destroy()
    await waitFor(() => core.session.state === 'reconnecting', 'session reconnecting', 10_000)
    await waitFor(
      () => core.session.backendLogins === 2 && core.cache.stats().warm,
      'second backend login and warm cache',
      10_000
    )

    // The attached client cannot survive the backend fault; let its end land
    // before the fresh attach claims the slot.
    await withTimeout(bot2.ended, 10_000, 'bot2 end after backend fault')

    bot3 = createBot({ port: evidence.frontPort, username: 'Attach' })
    await bot3.ready()
    const b3 = bot3.received
    const play3 = bot3.playNames()
    const prefix3Ok = expectedPrefix.every((name, i) => play3[i] === name)

    // Bounded observation: a reconnect loop would add a third login here.
    await new Promise(resolve => setTimeout(resolve, 1000))
    evidence.reconnect = {
      loginsBeforeFault,
      fakeLogins: fake.received.logins,
      backendLogins: core.session.backendLogins,
      attaches: core.metrics.attaches
    }
    check(
      'O15',
      'one reconnect: two backend logins, no loop',
      loginsBeforeFault === 1 && fake.received.logins === 2 &&
        core.session.backendLogins === 2 && core.session.state === 'attached',
      evidence.reconnect
    )
    check(
      'O16',
      'post-reconnect attach replays the join prefix and a chunk',
      core.metrics.attaches === 3 && prefix3Ok && b3.login?.entityId === 42 &&
        b3.mapChunks.length > 0 && b3.leftovers.length === 0 && b3.errors.length === 0,
      {
        attaches: core.metrics.attaches,
        prefix: play3.slice(0, 6),
        entityId: b3.login?.entityId ?? null,
        chunks: b3.mapChunks.length,
        leftovers: b3.leftovers.length,
        errors: b3.errors.length
      }
    )

    // --- O17-O20: the late-attach replay kept the mutated state ---
    // The first attach replayed the inventory base captured after the join,
    // every later slot update, and the block edit. The second attach must not
    // fall back to the join snapshot.
    const b1PlayNames = b1.names.filter(frame => frame.state === 'play').map(frame => frame.name)
    const baseIndex = b1PlayNames.indexOf('window_items')
    const slotIndexes = b1PlayNames.map((name, i) => name === 'set_slot' ? i : -1).filter(i => i >= 0)
    const baseFrame = b1.windowItems.find(packet => packet.windowId === 0)
    const baseFilledSlots = (baseFrame?.items ?? [])
      .map((item, slot) => item.itemCount > 0 ? slot : -1)
      .filter(slot => slot >= 0)
    check(
      'O17',
      'late-attach replay sends the window 0 base before every later set_slot',
      baseFrame?.windowId === 0 && baseIndex >= 0 &&
        slotIndexes.length >= 2 && slotIndexes.every(index => index > baseIndex),
      { baseIndex, slotIndexes, windowItems: b1.windowItems.length, setSlots: b1.setSlots.length }
    )
    check(
      'O18',
      'first bot applied both items and no stale slot from the join frame',
      baseFrame?.items?.[36]?.itemId === 1 &&
        baseFilledSlots.length === 1 && baseFilledSlots[0] === 36 &&
        b1.setSlots.some(packet => packet.slot === 40 && packet.item?.itemId === 2 && packet.item?.itemCount === 3) &&
        b1.setSlots.some(packet => packet.slot === 41 && packet.item?.itemId === 5),
      {
        slot36: baseFrame?.items?.[36]?.itemId ?? null,
        filledSlots: baseFilledSlots,
        setSlots: b1.setSlots.map(packet => ({ slot: packet.slot, itemId: packet.item?.itemId ?? null }))
      }
    )
    const latestPosition = b1.positions.at(-1)
    const lateBlockReplayed = b1.blockChanges.some(change =>
      change.location?.x === LATE_BLOCK.x &&
      change.location?.y === LATE_BLOCK.y &&
      change.location?.z === LATE_BLOCK.z)
    check(
      'O19',
      'late block edit is replayed and the last pose is the post-mutation pose',
      lateBlockReplayed &&
        latestPosition?.x === LATE_POSE.x &&
        latestPosition?.y === LATE_POSE.y &&
        latestPosition?.z === LATE_POSE.z,
      {
        blockReplayed: lateBlockReplayed,
        lastPosition: latestPosition ? { x: latestPosition.x, y: latestPosition.y, z: latestPosition.z } : null
      }
    )
    const baseFrame2 = b2.windowItems.find(packet => packet.windowId === 0)
    const baseFilledSlots2 = (baseFrame2?.items ?? [])
      .map((item, slot) => item.itemCount > 0 ? slot : -1)
      .filter(slot => slot >= 0)
    check(
      'O20',
      'reattach replays the mutated inventory, not the join snapshot',
      baseFrame2?.items?.[36]?.itemId === 1 &&
        baseFilledSlots2.length === 1 && baseFilledSlots2[0] === 36 &&
        b2.setSlots.some(packet => packet.slot === 40 && packet.item?.itemId === 2),
      {
        slot36: baseFrame2?.items?.[36]?.itemId ?? null,
        filledSlots: baseFilledSlots2,
        setSlots: b2.setSlots.map(packet => ({ slot: packet.slot, itemId: packet.item?.itemId ?? null }))
      }
    )

    // --- O21-O24: follow a transfer on the puppet leg ---
    // The transfer frame never reaches the attached client (that is the
    // 2026-11-08 bypass). The puppet moves to the second fake backend, warms
    // there, and the bot is detached with a clear reason; a fresh bot then
    // attaches and sees the new server's state.
    const transferMark = b3.names.length
    const loginsBeforeTransfer = core.session.backendLogins
    const target = { host: '127.0.0.1', port: handshakeProxy.port }
    fake.sendTransfer(target.host, target.port)
    await waitFor(() => core.metrics.transfersFollowed === 1, 'transfer follow decided')
    await waitFor(() => fake2.received.logins === 1, 'puppet login on the target')
    await waitFor(
      () => core.session.backendLogins === loginsBeforeTransfer + 1 && core.session.warmReady === true,
      'target warm after the move',
      15_000
    )
    await withTimeout(bot3.ended, 10_000, 'bot3 end after transfer')

    const afterTransfer = b3.names.slice(transferMark).map(frame => frame.name)
    const kickText = JSON.stringify(b3.kick ?? '')
    check(
      'O21',
      'a followed transfer never reaches the client and detaches it with a moving reason',
      !afterTransfer.includes('transfer') &&
        core.metrics.transfersBlocked === 1 &&
        core.metrics.transfersFollowed === 1 &&
        /moving/i.test(kickText),
      {
        frames: afterTransfer,
        kick: kickText,
        ended: b3.ended,
        blocked: core.metrics.transfersBlocked,
        followed: core.metrics.transfersFollowed
      }
    )
    check(
      'O22',
      'the puppet follows the target and re-warms there',
      fake2.received.logins === 1 &&
        handshakeProxy.nextStates.includes(3) &&
        core.session.backendLogins === loginsBeforeTransfer + 1 &&
        core.session.warmReady === true &&
        core.session.state === 'warm',
      {
        loginsBeforeTransfer,
        fake2Logins: fake2.received.logins,
        handshakeIntents: handshakeProxy.nextStates,
        backendLogins: core.session.backendLogins,
        warmReady: core.session.warmReady,
        state: core.session.state
      }
    )

    // Target-specific state, cached before the fresh client attaches.
    const TARGET_BLOCK = { x: 9, y: 0, z: 9 }
    fake2.sendBlockChange(TARGET_BLOCK)
    await waitFor(
      () => core.cache.snapshot().blocks.some(entry =>
        entry.data?.location?.x === 9 &&
        entry.data?.location?.y === 0 &&
        entry.data?.location?.z === 9),
      'target block cached'
    )

    // Cookies on the puppet leg: store_cookie is answered on the next request.
    fake2.sendStoreCookie('session', 'abc')
    fake2.sendCookieRequest('session')
    await waitFor(
      () => fake2.received.cookieResponses.some(packet =>
        packet.key === 'session' && Buffer.from(packet.value ?? []).toString() === 'abc'),
      'cookie response on the puppet leg'
    )

    await waitFor(() => front.attached === null, 'front attach slot cleared after the kick')
    bot4 = createBot({ port: evidence.frontPort, username: 'Attach' })
    await bot4.ready()
    const b4 = bot4.received
    check(
      'O23',
      'a fresh attach after the move replays the target server state',
      b4.login?.entityId === 42 &&
        b4.blockChanges.some(change =>
          change.location?.x === 9 && change.location?.y === 0 && change.location?.z === 9) &&
        b4.leftovers.length === 0 &&
        b4.errors.length === 0,
      {
        entityId: b4.login?.entityId ?? null,
        blocks: b4.blockChanges.map(change => change.location),
        leftovers: b4.leftovers.length,
        errors: b4.errors.length
      }
    )
    check(
      'O24',
      'the puppet leg answers a stored cookie request',
      fake2.received.cookieResponses.some(packet =>
        packet.key === 'session' && Buffer.from(packet.value ?? []).toString() === 'abc'),
      {
        responses: fake2.received.cookieResponses.map(packet => ({
          key: packet.key,
          value: Buffer.from(packet.value ?? []).toString()
        }))
      }
    )
    // --- O24b: a proxy notice reaches the client as a toast (#15) ---
    // A refusal is the notice path #15 builds: one synthetic advancement with a
    // visible toast, then the removal that leaves the client's advancement
    // state as the server left it. The bot decodes both frames off the real
    // front leg, so this asserts what a client received.
    const noticesBefore = core.metrics.noticesSent
    fake2.sendTransfer('', 0)
    await waitFor(() => b4.advancements.length === 2, 'the notice toast and its removal')
    const [toast, removal] = b4.advancements
    const noticeKey = toast?.advancementMapping?.[0]?.key ?? null
    // The client held the notice after the add, complete and asking for a toast;
    // after the removal it holds nothing of ours.
    const completed = advancementComplete(applyAdvancementFrames([toast]).get(noticeKey))
    const held = applyAdvancementFrames(b4.advancements)
    check(
      'O24b',
      'a proxy notice reaches the client complete as a toast and leaves no advancement behind',
      core.metrics.noticesSent === noticesBefore + 1 &&
        /^monoplayer:notice\//.test(String(noticeKey)) &&
        toast?.showAdvancements === true &&
        toast?.advancementMapping?.[0]?.value?.displayData?.flags?.show_toast === 1 &&
        completed === true &&
        removal?.reset === false &&
        Array.isArray(removal?.identifiers) &&
        removal.identifiers.includes(noticeKey) &&
        held.size === 0 &&
        b4.errors.length === 0,
      {
        notice: noticeKey,
        frames: b4.advancements.length,
        showToast: toast?.advancementMapping?.[0]?.value?.displayData?.flags?.show_toast ?? null,
        complete: completed,
        removed: removal?.identifiers ?? null,
        held: [...held.keys()],
        errors: b4.errors.length
      }
    )

    // --- O25-O26: the server's view of the puppet's client identity (#17/#18) ---
    const brandFrames = backend =>
      backend.received.customPayloads.filter(entry => entry.channel === 'minecraft:brand')
    const hubBrands = brandFrames(fake)
    const targetBrands = brandFrames(fake2)
    check(
      'O25',
      'the puppet announced the Fabric brand once per backend connection',
      hubBrands.length === fake.received.logins &&
        targetBrands.length === fake2.received.logins &&
        [...hubBrands, ...targetBrands].every(entry => entry.brand === 'fabric'),
      {
        hubBrands: hubBrands.length,
        hubLogins: fake.received.logins,
        targetBrands: targetBrands.length,
        targetLogins: fake2.received.logins,
        brands: [...new Set([...hubBrands, ...targetBrands].map(entry => entry.brand))]
      }
    )
    // The play-state writes are the proxy's: the backend's cap, not the
    // library's pre-login default and not the human's render distance. The
    // configuration-phase write is the protocol library's own and still carries
    // its default 10, which the play login then supersedes (documented limit).
    const settings = fake.received.settings
    const playSettings = settings.filter(entry => entry.state === 'play')
    const configSettings = settings.filter(entry => entry.state !== 'play')
    const humanSettings = playSettings.find(entry => entry.locale === 'fr_fr')
    check(
      'O26',
      'the server sees the human client information with the backend view distance',
      fake.join.viewDistance !== 10 &&
        Boolean(humanSettings) &&
        humanSettings.viewDistance === fake.join.viewDistance &&
        humanSettings.mainHand === 0 &&
        humanSettings.skinParts === 96 &&
        playSettings.length >= 2 &&
        playSettings.every(entry => entry.viewDistance === fake.join.viewDistance) &&
        configSettings.every(entry => entry.viewDistance === 10),
      {
        cap: fake.join.viewDistance,
        play: playSettings.map(entry => ({ locale: entry.locale, viewDistance: entry.viewDistance })),
        config: configSettings.map(entry => ({ locale: entry.locale, viewDistance: entry.viewDistance }))
      }
    )

    // --- O33-O35: the kept connection (#22), opt-in through
    // `transfer.keepConnection` ---
    // A second, independent puppet and front against the same fake backends,
    // with the key on. The client follows the move on its own connection.
    seamlessFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist,
      getSnapshotConfig: () => seamlessCore?.cache.snapshot().config ?? [],
      wireCheck: payload => wire.check(payload),
      wireMode: 'throw',
      chat: 'full',
      log
    })
    seamlessBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: fake.port,
      version: VERSION,
      username: 'GlowSquidye',
      dialogAction: 'last',
      isHumanAttached: () => seamlessCore?.attached === true,
      onDialogAnswered: ({ state }) => seamlessCore?.notePuppetDialogAnswer({ state }),
      log
    })
    seamlessCore = createMonoplayer({
      config: loadConfig({
        ...config,
        transfer: { ...config.transfer, keepConnection: true }
      }),
      backendLeg: seamlessBackend,
      frontLeg: seamlessFront,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('seamlessCore', { line }) }
    })
    seamlessFront.setCoreAttachConfiguring(({ name, uuid }) => seamlessCore.attachConfiguringPlayer({ name, uuid }))
    seamlessFront.setConfiguringHandler(({ name }) => seamlessCore.configuringReady({ name }))
    seamlessFront.setClientSettingsHandler(settings => seamlessCore.noteClientSettings(settings))
    seamlessFront.setCoreAttach(({ name, uuid }) =>
      seamlessCore.attachPlayer({ name, uuid, includeConfig: false })
    )
    seamlessCore.start()
    let seamlessReconnecting = false
    seamlessCore.on('reconnect_due', async ({ delayMs, target: dueTarget } = {}) => {
      if (stopping || seamlessReconnecting) return
      seamlessReconnecting = true
      seamlessCore.session.backendConnecting({ initial: false })
      try {
        seamlessBackend.setTarget(dueTarget ?? { host: '127.0.0.1', port: fake.port }, {
          keepCookies: dueTarget !== undefined && dueTarget !== null,
          transfer: dueTarget !== undefined && dueTarget !== null
        })
        await seamlessBackend.connect()
      } catch (error) {
        seamlessCore.session.fail()
        log('seamlessBackendReconnectFailed', { error: String(error?.message ?? error).slice(0, 300) })
      } finally {
        seamlessReconnecting = false
      }
    })

    await seamlessBackend.connect()
    const seamlessReadiness = await waitForReady({ core: seamlessCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!seamlessReadiness.warm) throw new Error('the kept-connection rig did not warm')
    const seamlessBound = await seamlessFront.listen()
    bot5 = createBot({ port: seamlessBound.port ?? seamlessFront.port, username: 'Attach' })
    await bot5.ready()
    const b5 = bot5.received
    if (seamlessCore.metrics.attaches !== 1) {
      throw new Error(`the kept-connection rig attached ${seamlessCore.metrics.attaches} times, expected 1`)
    }

    const seamlessMark = b5.names.length
    const seamlessLogMark = logs.length
    fake.sendTransfer(target.host, target.port)
    await waitFor(
      () => seamlessCore.metrics.reconfigurationsCompleted === 1,
      'the kept connection lands on the target',
      20_000
    )
    await bot5.waitFor(
      () => b5.names.slice(seamlessMark).some(frame => frame.name === 'login'),
      'the target play login on the kept connection'
    )
    await waitFor(
      () => seamlessCore.session.state === 'attached' && seamlessCore.session.warmReady === true,
      'the kept connection warm on the target',
      15_000
    )

    const seamlessFrames = b5.names.slice(seamlessMark).map(frame => ({ state: frame.state, name: frame.name }))
    const seamlessNames = seamlessFrames.map(frame => frame.name)
    const seamlessConfig = seamlessFrames.filter(frame => frame.state === 'configuration').map(frame => frame.name)
    const seamlessLogs = logs.slice(seamlessLogMark)
    const seamlessClientErrors = seamlessLogs.filter(entry => entry.event === 'frontClientError')
    const seamlessAcks = seamlessLogs.filter(entry => entry.event === 'frontReconfigurationAcknowledged')
    evidence.seamless = {
      target,
      reconfigurations: seamlessCore.metrics.reconfigurationsCompleted,
      attaches: seamlessCore.metrics.attaches,
      configuration: seamlessConfig.length,
      frontClientErrors: seamlessClientErrors.length,
      acknowledged: seamlessAcks.map(entry => entry.fields)
    }
    check(
      'O33',
      'with transfer.keepConnection on, a followed transfer keeps the client\'s connection',
      !seamlessNames.includes('transfer') &&
        seamlessCore.metrics.transfersSeamless === 1 &&
        seamlessNames.includes('start_configuration') &&
        b5.ended === null && b5.kick === null &&
        seamlessClientErrors.length === 0 &&
        seamlessAcks.length === 1 &&
        seamlessAcks[0].fields?.flushedFrames > 0,
      {
        frames: seamlessNames.slice(0, 10),
        ended: b5.ended,
        kick: b5.kick,
        seamless: seamlessCore.metrics.transfersSeamless,
        frontClientErrors: seamlessClientErrors.length,
        acks: seamlessAcks.map(entry => entry.fields)
      }
    )
    check(
      'O34',
      'the kept connection carries the target configuration and its play login',
      seamlessConfig.includes('registry_data') &&
        seamlessConfig.includes('finish_configuration') &&
        seamlessNames.includes('login') &&
        seamlessCore.metrics.reconfigurationsCompleted === 1 &&
        seamlessCore.metrics.reconfigurationsRestored === 0 &&
        seamlessCore.session.state === 'attached',
      {
        configuration: seamlessConfig.length,
        names: seamlessNames.slice(-6),
        reconfigurations: seamlessCore.metrics.reconfigurationsCompleted,
        state: seamlessCore.session.state
      }
    )
    const SEAMLESS_BLOCK = { x: 11, y: 0, z: 11 }
    fake2.sendBlockChange(SEAMLESS_BLOCK)
    await bot5.waitFor(
      () => b5.blockChanges.some(change =>
        change.location?.x === SEAMLESS_BLOCK.x &&
        change.location?.y === SEAMLESS_BLOCK.y &&
        change.location?.z === SEAMLESS_BLOCK.z),
      'the target block on the kept connection'
    )
    check(
      'O35',
      'the client on the kept connection is in the target state without rejoining',
      b5.login?.entityId === 42 &&
        seamlessCore.metrics.attaches === 1 &&
        b5.leftovers.length === 0 &&
        b5.errors.length === 0,
      {
        entityId: b5.login?.entityId ?? null,
        attaches: seamlessCore.metrics.attaches,
        blocks: b5.blockChanges.map(change => change.location),
        leftovers: b5.leftovers.length,
        errors: b5.errors.length
      }
    )

  } catch (error) {
    runError = error
    exitCode = phase === 'setup' ? 2 : 1
    process.stderr.write(`loopback: ${phase} failed: ${String(error?.message ?? error)}\n`)
  } finally {
    stopping = true
    for (const bot of [bot5, bot4, bot3, bot2, bot1, stranger]) {
      try { await bot?.close?.() } catch { /* best effort */ }
    }
    try { await front?.close?.() } catch { /* best effort */ }
    try { await seamlessFront?.close?.() } catch { /* best effort */ }
    try { await backend?.close?.() } catch { /* best effort */ }
    try { await seamlessBackend?.close?.() } catch { /* best effort */ }
    try { fake?.close?.() } catch { /* best effort */ }
    try { handshakeProxy?.close?.() } catch { /* best effort */ }
    try { fake2?.close?.() } catch { /* best effort */ }

    if (failed && exitCode === 0) exitCode = 1
    if (runError && exitCode === 0) exitCode = 1

    const report = {
      rung: 'loopback',
      mode: 'offline',
      auth: 'none',
      backend: 'node-fake',
      version: VERSION,
      passed: exitCode === 0 && !failed,
      durationMs: Date.now() - startedAt,
      assertions,
      evidence
    }
    if (runError) report.error = String(runError?.message ?? runError).slice(0, 300)

    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      process.stderr.write(`loopback: could not write report ${reportPath}: ${String(error?.message ?? error)}\n`)
      exitCode = 2
    }

    const passedCount = assertions.filter(entry => entry.ok).length
    process.stdout.write(
      `loopback: ${report.passed ? 'PASS' : 'FAIL'} ` +
      `${passedCount}/${assertions.length} assertions in ${report.durationMs} ms ` +
      `(report: ${reportPath})\n`
    )
  }

  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLoopback().then(code => { process.exitCode = code })
}

// The product offline loopback rung: real front/backend legs, the fake node
// backend, and a real 26.1 protocol bot. No auth, no .secrets, loopback only.
//
//   node src/ladder/loopback.js [--report <file>] [--verbose]
//
// Exit codes: 0 all assertions pass, 1 assertion/timeout failure, 2 setup
// failure. The report is written in finally, even on failure.
//
// Assertions R0 and O1-O59 (including O11b, O24b, O41b, O54b, O55b, O56b and O56c) are the contract
// (docs/testing-ladder.md). A FAIL is a real finding; do not weaken a check to
// get a green run.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFakeBackend, emptySlot, itemStack } from '../legs/fake-backend.js'
import { createMonoplayer, loadConfig } from '../service/monoplayer.js'
import { detail, flag, waitFor, withTimeout } from '../service/cli.js'
import { createOfflineBackendLeg } from '../legs/live-backend.js'
import { createBodyCaches } from '../core/body-caches.js'
import { replayFrames } from '../core/join-synth.js'
import { createOfflineFrontLeg } from '../legs/live-front.js'
import { waitForReady } from '../service/readiness.js'
import { offlineUuid } from '../legs/offline-identity.js'
import { createWireChecker } from '../core/wire-check.js'
import { createJournal, readJournal, readManifests } from '../observability/journal.js'
import { REPLAY_DOMAINS } from '../core/replay-summary.js'
import { createBot } from './bot.js'
import { createBackendMoveTick, createControlDocument, dialIntent, dialTargetFor } from '../service/control.js'
import { createTransferFollowController } from '../core/transfer-follow.js'
import { createHandshakeProxy } from './handshake-proxy.js'
import { advancementComplete, applyAdvancementFrames } from './client-state.js'
import { PARITY_FRAME_NAMES, attachParity, parityReplayNames } from './state-parity.js'
import { baselineRegistryNames, readConfigurationBaseline } from '../legs/configuration-baseline.js'
import { chooseDialogAction } from '../core/dialog-codec.js'
import { pickIdFor, pickSlug, verbIdFor } from '../core/picker.js'

const VERSION = '26.1'
const DEFAULT_REPORT = '.reports/loopback-report.json'

// A port nothing listens on: the cheapest dial a target refuses. The socket is
// bound and closed again, so the number is real and the refusal is the kernel's.
async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
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
  // #87: the kept-connection rig gets its own backend as the configured base.
  // The hub fake runs a code-of-conduct gate, and a restored client sits in play
  // where nobody can answer it, so the base reconnect would stall on a gate this
  // rung is not about.
  let seamlessBase = null
  let fakeCold = null
  let coldProxy = null
  // #73: a third backend that gates its configuration, for the detach answer.
  let gatedFake = null
  let gatedProxy = null
  let handshakeProxy = null
  let front = null
  let backend = null
  let core = null
  let bot1 = null
  let bot2 = null
  let bot3 = null
  let bot4 = null
  let bot5 = null
  let bot6 = null
  let bot7 = null
  let bot8 = null
  // #97: the commands-mode rig, its own puppet, front, and backend.
  let bot9 = null
  // #201: the pre-auth window rig needs a window of its own, so its front leg,
  // the socket that holds the only slot, and the client that follows it are
  // named apart from the main rig's.
  let capFront = null
  let capSocket = null
  let capBot = null
  let capRefusedBot = null
  // #205: the pre-auth deadline's own rig, for the same reason the cap has one.
  let deadlineFront = null
  let deadlineSocket = null
  let deadlineBot = null
  let deadlineStranger = null
  // #218: the attach-record rig. It is the smallest rig that attaches twice, so
  // "no metadata frame without a spawn" is a claim about a stream this run can
  // reconstruct. Its core logs as `attachCore`, which is what `coreLogEvents`
  // reads to reach the `attach` record.
  let attachBase = null
  let attachFront = null
  let attachBackend = null
  let attachCore = null
  let attachBot1 = null
  let attachBot2 = null
  let commandsFront = null
  let commandsBackend = null
  let commandsBase = null
  let commandsCore = null
  let stranger = null
  let seamlessFront = null
  let seamlessBackend = null
  let seamlessCore = null
  // #87: the kept-connection rig's dial bookkeeping. A failed dial under a move
  // leaves the move in flight; the rung records that state and decides when the
  // follow budget runs out.
  let dialFailureState = null
  let giveUpOnFailedDial = false
  // #217: the packet journal O52 reads, in its own temporary directory.
  let journalDir = null
  let journal = null
  // #229: the control document's rig. Its own directory, its own front,
  // backend and core, because the assertion changes a file mid-run and the
  // main rig's whitelist is a frozen array.
  let controlDir = null
  let controlBase = null
  let controlFront = null
  let controlBackend = null
  let controlCore = null
  let controlBot1 = null
  let controlBot2 = null
  // #233: the operator-move rig. Its own two backends, because the assertion is
  // that a client attached to the first one ends in the second one's state, and
  // the run has to be able to say which login landed where.
  let operatorBase = null
  let operatorTargetFake = null
  let operatorProxy = null
  let operatorFront = null
  let operatorBackend = null
  let operatorCore = null
  let operatorBot = null
  // #257: the picker rig. No backend, no cluster, and its own 26.2 wire checker,
  // because the baseline is a recording of a Paper 26.2 configuration phase.
  let pickerFront = null
  let pickerBackend = null
  let pickerCore = null
  let pickerBot = null
  let pickerBot2 = null
  let pickerBot3 = null
  let pickerBot4 = null
  // #258: the picker rig's own body, and the client that claims it.
  let pickerBodyFake = null
  let pickerBot5 = null
  // #260: two bodies of one account at once, each with its own real backend leg,
  // for the cache-ownership assertion. Nothing is delivered to a client here.
  let bodyFakeA = null
  let bodyFakeB = null
  let bodyLegA = null
  let bodyLegB = null

  const evidence = {
    frontPort: null,
    backendPort: null,
    configReplayMode: null,
    wire: null,
    backendLogins: null,
    attaches: null,
    denials: null,
    serverbound: { positions: null, digs: null, places: null },
    bot: { playPrefix: [], leftovers: null, errors: null },
    preAuthWindow: null,
    preAuthDeadline: null,
    attachRecord: null,
    controlDocument: null,
    backendMove: null,
    bodyCaches: null
  }

  const log = (event, fields = {}) => {
    logs.push({ event, fields })
    if (verbose) process.stderr.write(`[log] ${event} ${detail(fields)}\n`)
  }

  // The core's lifecycle records arrive as one JSON line inside a
  // `seamlessCore` entry, because the rig hands it a logStream. This reads
  // them back so a check can assert on what the core decided. `stream` is the
  // event name that rig's logStream writes, so a check that builds its own core
  // can read its lines instead of the seamless rig's.
  const coreLogEvents = (from = 0, stream = 'seamlessCore') => logs.slice(from)
    .filter(entry => entry.event === stream)
    .map(entry => {
      try { return JSON.parse(entry.fields?.line ?? '') } catch { return null }
    })
    .filter(entry => entry !== null)

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
    // detach path with the key off, and O33-O35, the kept connection).
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
      puppet: { username: 'GlowSquidye', uuid: puppetUuid },
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

    // #217: a real writer, into a temporary directory. This rig is the only
    // place an offline run produces the stream a diagnosis reads, so O52 reads
    // what this one wrote. The caps are small on purpose: the journal opens only
    // when the volume holds its budget plus one shard per kind, and a runner has
    // less room than the deployed emptyDir. A journal that did not open is a
    // setup failure, not a passing check.
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-loopback-journal-'))
    journal = createJournal({
      dir: journalDir,
      maxBytes: 4 * 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024
    })
    if (!journal.enabled) {
      throw new Error('the loopback journal did not open: ' + journal.stats().disabledReason)
    }

    core = createMonoplayer({
      config,
      backendLeg: backend,
      frontLeg: front,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('core', { line }) },
      journal
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

    // #217, for O52: one `player_info`, which the fake has no sender for. The
    // proxy's own skin frame is a `player_info` the front leg writes, and the
    // journal never sees a front-leg write, so the backend-to-core direction is
    // the one to prove. It is written through the fake's own server, as O50
    // writes its orphan metadata: the frame is encoded and decoded like any
    // other, and the core journals it on its way past.
    const journalFramesBefore = journal.stats().frames
    for (const client of Object.values(fake.server.clients)) {
      client.write('player_info', {
        action: 'add_player',
        data: [{
          uuid: offlineUuid('Watcher'),
          player: { name: 'Watcher', properties: [] }
        }]
      })
    }
    await waitFor(() => journal.stats().frames > journalFramesBefore, 'the player_info frame in the journal')

    // --- O46: while a client is attached, the pack is the human's answer (#98) ---
    // The backend sends one pack and never repeats it. The puppet's own accept
    // would close the round before the human saw anything, so the proxy must
    // relay the frame and say nothing on the backend leg; the status the client
    // sends is the answer the server hears, with the human's own results.
    const LIVE_PACK = '11111111-1111-4111-8111-111111111111'
    // Counters, not totals: any earlier rig that touched a pack would otherwise
    // break this check for a reason that has nothing to do with it.
    const answeredBefore = core.metrics.resourcePacksAnswered
    const acksBefore = core.metrics.resourcePackAcks
    const livePackStatuses = fake.received.resourcePackResponses.length
    fake.sendResourcePack({
      uuid: LIVE_PACK,
      url: 'https://example.invalid/loopback-live.zip',
      hash: '',
      forced: true
    })
    await settleUntil(() => b1.resourcePacks.length === 1, 5_000)
    const puppetAnsweredWhileAttached = fake.received.resourcePackResponses.length - livePackStatuses
    bot1.sendResourcePackStatus(LIVE_PACK, 3)
    bot1.sendResourcePackStatus(LIVE_PACK, 4)
    bot1.sendResourcePackStatus(LIVE_PACK, 0)
    await settleUntil(
      () => fake.received.resourcePackResponses.length >= livePackStatuses + 3,
      5_000
    )
    const liveStatuses = fake.received.resourcePackResponses.slice(livePackStatuses)
    check(
      'O46',
      'a pack reaches the attached client, the puppet stays silent, and the human status is the answer the backend hears',
      b1.resourcePacks.length === 1 &&
        b1.resourcePacks[0]?.uuid === LIVE_PACK &&
        puppetAnsweredWhileAttached === 0 &&
        liveStatuses.length === 3 &&
        liveStatuses.every(entry => entry.uuid === LIVE_PACK) &&
        JSON.stringify(liveStatuses.map(entry => Number(entry.result))) === JSON.stringify([3, 4, 0]) &&
        core.metrics.resourcePacksAnswered === answeredBefore + 3 &&
        core.metrics.resourcePackAcks === acksBefore &&
        b1.leftovers.every(entry => entry.name !== 'add_resource_pack'),
      {
        onClient: b1.resourcePacks.map(pack => pack.uuid),
        puppetAcks: puppetAnsweredWhileAttached,
        statuses: liveStatuses.map(entry => Number(entry.result)),
        answered: core.metrics.resourcePacksAnswered - answeredBefore
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

    // --- O45: the commands mode speaks the command and keeps open chat off (#97) ---
    // A rig of its own, in `commands`, for the reason the kept-connection rig
    // has one: the main rig runs `full` for O29 and cannot be in two modes at
    // once. It also has to be a separate client. O29 sends an acknowledgement
    // the front leg's library rejects, so its client is ended a few
    // milliseconds later (`chat_validation_failed`); a check that reused that
    // client would race the end of its connection. This bot sends no
    // acknowledgement, so nothing ends it before the two frames are read.
    //
    // The puppet leg here has no profile keys, so the command reaches the fake
    // backend as `chat_command`, not `chat_command_signed`. The signed name is
    // pinned by test/core/relay.test.js and test/service/chat-send.test.js; what
    // this check proves is the mode decision on a protocol bot's frame.
    commandsBase = await createFakeBackend({ port: 0, logStream: null })
    commandsFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist,
      getSnapshotConfig: () => commandsCore?.cache.snapshot().config ?? [],
      wireCheck: payload => wire.check(payload),
      wireMode: 'throw',
      // No `chat` here: `createOfflineFrontLeg` does not forward it (#100), so
      // passing it would claim the front leg backstop runs this mode. It does
      // not, and `commands` relays clientbound as `read-only` does anyway.
      log
    })
    commandsBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: commandsBase.port,
      version: VERSION,
      username: 'GlowSquidye',
      dialogAction: 'last',
      isHumanAttached: () => commandsCore?.attached === true,
      onDialogAnswered: ({ state }) => commandsCore?.notePuppetDialogAnswer({ state }),
      log
    })
    commandsCore = createMonoplayer({
      config: loadConfig({ ...config, chat: 'commands' }),
      backendLeg: commandsBackend,
      frontLeg: commandsFront,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('commandsCore', { line }) }
    })
    commandsFront.setCoreAttachConfiguring(({ name, uuid }) => commandsCore.attachConfiguringPlayer({ name, uuid }))
    commandsFront.setConfiguringHandler(({ name }) => commandsCore.configuringReady({ name }))
    commandsFront.setClientSettingsHandler(settings => commandsCore.noteClientSettings(settings))
    commandsFront.setCoreAttach(({ name, uuid }) =>
      commandsCore.attachPlayer({ name, uuid, includeConfig: false })
    )
    commandsCore.start()
    // One backend.connect() per reconnect_due, as the main rig does it, so a
    // backend that ends fails as a dial rather than as a bot wait that blames
    // the command.
    let commandsReconnecting = false
    commandsCore.on('reconnect_due', async ({ delayMs } = {}) => {
      if (stopping || commandsReconnecting) return
      commandsReconnecting = true
      commandsCore.session.backendConnecting({ initial: false })
      try {
        await commandsBackend.connect()
        log('commandsBackendReconnect', { delayMs, backendLogins: commandsCore.session.backendLogins })
      } catch (error) {
        commandsCore.session.fail()
        log('commandsBackendReconnectFailed', {
          delayMs,
          error: String(error?.message ?? error).slice(0, 300)
        })
      } finally {
        commandsReconnecting = false
      }
    })
    await commandsBackend.connect()
    const commandsReadiness = await waitForReady({ core: commandsCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!commandsReadiness.warm) throw new Error('the commands-mode rig did not warm')
    const commandsBound = await commandsFront.listen()
    bot9 = createBot({
      port: commandsBound.port ?? commandsFront.port,
      username: 'Second'
    })
    await bot9.ready()
    if (commandsCore.metrics.attaches !== 1) {
      throw new Error(`the commands-mode rig attached ${commandsCore.metrics.attaches} times, expected 1`)
    }

    const forwardedBefore = commandsCore.metrics.serverboundForwarded
    bot9.sendCommand('profil')
    bot9.sendChat('the account must not say this')
    await bot9.waitFor(
      () => commandsBase.received.chatCommands.length === 1 &&
        commandsCore.metrics.chatBlocked === 1,
      'the backend command, and no chat, in commands mode'
    )
    const spokenInCommands = commandsBase.received.chatCommands.at(-1)
    evidence.commandsMode = {
      command: spokenInCommands?.command ?? null,
      commands: commandsBase.received.chatCommands.length,
      messages: commandsBase.received.chats.length,
      chatSent: commandsCore.metrics.chatSent,
      chatBlocked: commandsCore.metrics.chatBlocked,
      forwarded: commandsCore.metrics.serverboundForwarded - forwardedBefore,
      attaches: commandsCore.metrics.attaches
    }
    check(
      'O45',
      'in commands mode the human command reached the backend as the puppet and the chat message did not',
      spokenInCommands?.command === 'profil' &&
        commandsBase.received.chats.length === 0 &&
        commandsCore.metrics.chatSent === 1 &&
        commandsCore.metrics.chatBlocked === 1 &&
        commandsCore.metrics.serverboundForwarded === forwardedBefore &&
        commandsCore.metrics.attaches === 1,
      evidence.commandsMode
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

    // --- O47, headless half: a pack nobody can answer is the puppet's ---
    // A required pack the server hears nothing about can end the session, so a
    // headless lane accepts and loads it. The copy stays held, because the next
    // client still needs the pack installed on its own client.
    const HELD_PACK = '22222222-2222-4222-8222-222222222222'
    const heldPackStatuses = fake.received.resourcePackResponses.length
    const packsResentBefore = core.metrics.resourcePacksResent
    fake.sendResourcePack({
      uuid: HELD_PACK,
      url: 'https://example.invalid/loopback-held.zip',
      hash: '',
      forced: true
    })
    await waitFor(
      () => fake.received.resourcePackResponses.length >= heldPackStatuses + 2,
      'the puppet pack accept while nobody is attached'
    )
    const headlessStatuses = fake.received.resourcePackResponses.slice(heldPackStatuses)

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

    // --- O47, attached half: the held pack reaches the next client, and its
    // answer reaches the backend ---
    // The reattaching client was not there when the backend sent the pack, so it
    // has no copy but the held one (#98). The eviction that made this the defect
    // needs 512 generic frames, which this rung does not push: the unit lane
    // pins that half ("600 generic frames" in test/service/monoplayer.test.js),
    // and this check pins that the frame comes from the holder rather than from
    // the cache, which never held it.
    await settleUntil(() => b2.resourcePacks.length >= 1, 5_000)
    const heldBeforeAnswer = fake.received.resourcePackResponses.slice(heldPackStatuses + 2)
    bot2.sendResourcePackStatus(HELD_PACK, 3)
    bot2.sendResourcePackStatus(HELD_PACK, 4)
    bot2.sendResourcePackStatus(HELD_PACK, 0)
    await settleUntil(
      () => fake.received.resourcePackResponses.length >= heldPackStatuses + 5,
      5_000
    )
    const humanStatuses = fake.received.resourcePackResponses.slice(heldPackStatuses + 2)
    check(
      'O47',
      'a pack sent while nobody was attached is accepted by the puppet, delivered to the next client, and its answer reaches the backend',
      headlessStatuses.length === 2 &&
        JSON.stringify(headlessStatuses.map(entry => [entry.uuid, Number(entry.result)])) ===
          JSON.stringify([[HELD_PACK, 3], [HELD_PACK, 0]]) &&
        // The holder keeps one copy per pack, so the next client receives both
        // this one and the one O46's client already answered: a pack stays
        // installed on the puppet's connection until the server withdraws it.
        JSON.stringify(b2.resourcePacks.map(pack => pack.uuid)) === JSON.stringify([LIVE_PACK, HELD_PACK]) &&
        humanStatuses.length === 3 &&
        humanStatuses.every(entry => entry.uuid === HELD_PACK) &&
        JSON.stringify(humanStatuses.map(entry => Number(entry.result))) === JSON.stringify([3, 4, 0]) &&
        heldBeforeAnswer.length === 0 &&
        core.metrics.resourcePacksResent === packsResentBefore + 2 &&
        core.metrics.resourcePackAcks === acksBefore + 1,
      {
        headless: headlessStatuses.map(entry => [entry.uuid, Number(entry.result)]),
        onClient: b2.resourcePacks.map(pack => pack.uuid),
        human: humanStatuses.map(entry => Number(entry.result)),
        resent: core.metrics.resourcePacksResent - packsResentBefore,
        acks: core.metrics.resourcePackAcks - acksBefore
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

    // --- O33-O35: the kept connection (#22), on by default through
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
    seamlessBase = await createFakeBackend({ port: 0, logStream: null })
    seamlessBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: seamlessBase.port,
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
        seamlessBackend.setTarget(dueTarget ?? { host: '127.0.0.1', port: seamlessBase.port }, {
          keepCookies: dueTarget !== undefined && dueTarget !== null,
          transfer: dueTarget !== undefined && dueTarget !== null
        })
        await seamlessBackend.connect()
      } catch (error) {
        log('seamlessBackendReconnectFailed', {
          error: String(error?.message ?? error).slice(0, 300),
          state: seamlessCore.session.state
        })
        // #87: a dial the target refused is not the target dying. The move is
        // still in flight; the rung records that, then decides whether to
        // retry (the rig has one dial per reconnect) or to spend the follow
        // budget on it, which is what start-live does after its failures.
        dialFailureState = {
          moveKind: seamlessCore.moveKind,
          state: seamlessCore.session.state,
          clientReconfiguring: seamlessCore.clientReconfiguring,
          restored: seamlessCore.metrics.reconfigurationsRestored
        }
        if (giveUpOnFailedDial) {
          giveUpOnFailedDial = false
          seamlessCore.abortTransfer('target_unreachable')
          seamlessBackend.setTarget({ host: '127.0.0.1', port: seamlessBase.port }, { keepCookies: false })
          return
        }
        seamlessCore.session.fail()
      } finally {
        seamlessReconnecting = false
      }
    })

    await seamlessBackend.connect()
    const seamlessReadiness = await waitForReady({ core: seamlessCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!seamlessReadiness.warm) throw new Error('the kept-connection rig did not warm')
    const seamlessBound = await seamlessFront.listen()
    // #73: the library accepts the code of conduct on its own; O43 needs a
    // client that leaves the gate to the puppet, so this one does not answer.
    bot5 = createBot({
      port: seamlessBound.port ?? seamlessFront.port,
      username: 'Attach',
      answerCodeOfConduct: false
    })
    await bot5.ready()
    const b5 = bot5.received
    if (seamlessCore.metrics.attaches !== 1) {
      throw new Error(`the kept-connection rig attached ${seamlessCore.metrics.attaches} times, expected 1`)
    }
    // The puppet is settled on its base and no move is in flight: every check
    // below starts a move from here.
    const waitForBaseWarm = label => waitFor(
      () => !seamlessReconnecting &&
        seamlessCore.session.state === 'attached' &&
        seamlessCore.session.warmReady === true &&
        seamlessCore.moveKind === null,
      label,
      20_000
    )

    // --- O38-O41: the cases the testbed cannot produce (#87) ---
    // `mise run testbed:run` passes because its transfer succeeds on the first
    // dial and its target warms in five seconds. A cold target, a refused dial,
    // and a restore never happen there, so they are proved here first, on a real
    // front leg and a real client, before the happy path below.
    //
    // O38: the round starts on the intent.
    // O39: a refused dial leaves the move in flight instead of failing it.
    // O40: the follow budget's give-up restores the previous state.
    // O41: a target that sent no chunk frame never releases the client.
    const roundsBeforeCold = seamlessCore.metrics.reconfigurationsStarted
    fakeCold = await createFakeBackend({ port: 0, logStream: null, chunks: false })
    coldProxy = await createHandshakeProxy({ targetPort: fakeCold.port, log })
    const coldMark = b5.names.length
    const coldLogMark = logs.length
    seamlessBase.sendTransfer('127.0.0.1', coldProxy.port)
    // The frame crosses asynchronously; the round is due before the puppet's
    // dial to the cold target has produced anything.
    await waitFor(
      () => seamlessCore.session.state === 'transferring',
      'the cold target transfer intent',
      10_000
    )
    const coldIntent = {
      rounds: seamlessCore.metrics.reconfigurationsStarted - roundsBeforeCold,
      clientReconfiguring: seamlessCore.clientReconfiguring,
      state: seamlessCore.session.state,
      targetLogins: fakeCold.received.logins
    }
    await waitFor(
      () => seamlessCore.targetLoginReady === true && seamlessCore.clientReconfiguring === false,
      'the cold target configuration and its play login',
      25_000
    )
    const coldCoreEvents = coreLogEvents(coldLogMark)
    await settleUntil(
      () => coreLogEvents(coldLogMark).some(entry => entry.event === 'reconfigurationWaitingWorld'),
      5_000
    )
    const coldFrames = b5.names.slice(coldMark).map(frame => ({ state: frame.state, name: frame.name }))
    check(
      'O38',
      "a followed transfer starts the client's configuration on the intent",
      coldIntent.rounds === 1 &&
        coldIntent.clientReconfiguring === true &&
        coldIntent.state === 'transferring' &&
        coldIntent.targetLogins === 0 &&
        coldFrames.some(frame => frame.name === 'start_configuration'),
      { ...coldIntent, firstFrames: coldFrames.slice(0, 4).map(frame => frame.name) }
    )
    check(
      'O41',
      'a target whose cache holds no chunk never releases the client',
      seamlessCore.metrics.reconfigurationsCompleted === 0 &&
        seamlessCore.moveKind === 'transfer' &&
        coldFrames.every(frame => frame.name !== 'login') &&
        b5.ended === null,
      {
        completed: seamlessCore.metrics.reconfigurationsCompleted,
        moveKind: seamlessCore.moveKind,
        chunkFrames: seamlessCore.cache.stats().chunkFrames,
        frames: coldFrames.map(frame => frame.name).slice(-6),
        waitingWorld: coldCoreEvents.some(entry => entry.event === 'reconfigurationWaitingWorld'),
        ended: b5.ended
      }
    )
    check(
      'O41b',
      'the held release is the chunk gate, not a stalled client',
      coldCoreEvents.some(entry => entry.event === 'reconfigurationWaitingWorld') &&
        seamlessCore.cache.stats().chunkFrames === 0,
      {
        waitingWorld: coldCoreEvents.filter(entry => entry.event === 'reconfigurationWaitingWorld'),
        chunkFrames: seamlessCore.cache.stats().chunkFrames
      }
    )
    // The client finished the cold target's round, so giving the target up opens
    // one more round and serves the previous server's configuration through it.
    const coldRestoreMark = b5.names.length
    seamlessCore.abortTransfer('target_unreachable')
    await bot5.waitFor(
      () => b5.names.slice(coldRestoreMark).filter(frame => frame.name === 'login').length >= 1,
      'the restored play state after the cold target',
      20_000
    )
    await waitForBaseWarm('the puppet back on the configured backend')

    // --- O39-O40: a refused dial, and the give-up that restores the session ---
    // A port that nothing listens on: the dial is refused as surely as a target
    // that closes a transfer intent from the same account.
    const deadPort = await freePort()
    const dialMark = b5.names.length
    const dialLogMark = logs.length
    giveUpOnFailedDial = true
    seamlessBase.sendTransfer('127.0.0.1', deadPort)
    await waitFor(
      () => dialFailureState !== null,
      'the refused dial on the followed target',
      20_000
    )
    check(
      'O39',
      'a dial the target refuses before its first frame leaves the move in flight',
      dialFailureState.moveKind === 'transfer' &&
        dialFailureState.state === 'transferring' &&
        dialFailureState.clientReconfiguring === true &&
        dialFailureState.restored === 1,
      dialFailureState
    )
    await bot5.waitFor(
      () => b5.names.slice(dialMark).filter(frame => frame.name === 'login').length >= 1,
      'the restored play state on the kept connection',
      20_000
    )
    await waitFor(
      () => seamlessCore.metrics.reconfigurationsRestored === 2 &&
        seamlessCore.session.state === 'attached',
      'the restore to settle on the kept connection',
      20_000
    )
    const restoreLogs = logs.slice(dialLogMark)
    const restoreFrames = b5.names.slice(dialMark).map(frame => ({ state: frame.state, name: frame.name }))
    check(
      'O40',
      'a target given up on restores the previous state on the connection the client kept',
      seamlessCore.metrics.reconfigurationsRestored === 2 &&
        b5.ended === null &&
        b5.kick === null &&
        restoreFrames.some(frame => frame.state === 'configuration' && frame.name === 'finish_configuration') &&
        restoreFrames.some(frame => frame.name === 'login') &&
        restoreLogs.filter(entry => entry.event === 'frontClientError').length === 0,
      {
        restored: seamlessCore.metrics.reconfigurationsRestored,
        ended: b5.ended,
        kick: b5.kick,
        configuration: restoreFrames.filter(frame => frame.state === 'configuration').map(frame => frame.name),
        play: restoreFrames.filter(frame => frame.state === 'play').map(frame => frame.name).slice(0, 6),
        frontClientErrors: restoreLogs
          .filter(entry => entry.event === 'frontClientError')
          .map(entry => entry.fields)
      }
    )
    await waitForBaseWarm('the puppet warm on the configured backend again')

    // --- O33-O35: the kept connection survives a real followed transfer ---
    // The counts below are this hop's, so the rung's earlier moves do not count.
    const baseline = {
      seamless: seamlessCore.metrics.transfersSeamless,
      completed: seamlessCore.metrics.reconfigurationsCompleted,
      restored: seamlessCore.metrics.reconfigurationsRestored
    }
    const seamlessMark = b5.names.length
    const seamlessLogMark = logs.length
    seamlessBase.sendTransfer(target.host, target.port)
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
      moves: seamlessCore.metrics.reconfigurationsCompleted,
      restores: seamlessCore.metrics.reconfigurationsRestored,
      attaches: seamlessCore.metrics.attaches,
      configuration: seamlessConfig.length,
      frontClientErrors: seamlessClientErrors.length,
      acknowledged: seamlessAcks.map(entry => entry.fields)
    }
    check(
      'O33',
      'with transfer.keepConnection on, a followed transfer keeps the client\'s connection',
      !seamlessNames.includes('transfer') &&
        seamlessCore.metrics.transfersSeamless - baseline.seamless === 1 &&
        seamlessNames.includes('start_configuration') &&
        b5.ended === null && b5.kick === null &&
        seamlessClientErrors.length === 0 &&
        seamlessAcks.length === 1 &&
        // #87: the round starts on the intent, so it is on the client's wire
        // before the target's configuration is relayed (the round's own ordering
        // against the dial is O38's check).
        seamlessNames.includes('start_configuration') &&
        seamlessNames.indexOf('start_configuration') < seamlessNames.indexOf('registry_data'),
      {
        frames: seamlessNames.slice(0, 10),
        ended: b5.ended,
        kick: b5.kick,
        seamless: seamlessCore.metrics.transfersSeamless - baseline.seamless,
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
        seamlessCore.metrics.reconfigurationsCompleted - baseline.completed === 1 &&
        seamlessCore.metrics.reconfigurationsRestored - baseline.restored === 0 &&
        seamlessCore.session.state === 'attached',
      {
        configuration: seamlessConfig.length,
        names: seamlessNames.slice(-6),
        reconfigurations: seamlessCore.metrics.reconfigurationsCompleted - baseline.completed,
        restored: seamlessCore.metrics.reconfigurationsRestored - baseline.restored,
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
    // --- O42: an error on the client's connection ends it with a reason (#87) ---
    // The library's default handler ended the client with the Error object, and
    // the failed kick became the end reason 30 s later. The leg owns that policy
    // now, so the same error produces one line of text and no serialization
    // failure. This runs last because it ends the client.
    const probeMark = logs.length
    const errorClient = seamlessFront.attached
    errorClient?.emit('error', new Error('loopback_probe'))
    await waitFor(
      () => b5.ended !== null || b5.kick !== null,
      'the client to be ended by the leg error policy',
      10_000
    )
    const probeLogs = logs.slice(probeMark)
    const probeSerialization = probeLogs.filter(entry =>
      entry.event === 'frontClientError' && String(entry.fields?.error ?? '').startsWith('Serialization error'))
    // The kick's reason is an anonymous NBT compound carrying one text string
    // (`node tools/protocol.mjs frame 26.1 play toClient kick_disconnect`).
    const probeKickText = b5.kick?.reason?.value?.text?.value ?? null
    check(
      'O42',
      "an error on the client's connection ends it with a reason, not a serialization failure",
      Boolean(errorClient) &&
        probeKickText === 'front_error: loopback_probe' &&
        probeSerialization.length === 0,
      {
        kickText: probeKickText,
        ended: b5.ended,
        serializationErrors: probeSerialization.map(entry => entry.fields),
        frontClientErrors: probeLogs.filter(entry => entry.event === 'frontClientError').map(entry => entry.fields)
      }
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

    // --- O43-O44: a dialog the last client left (#73) ---
    // A third backend gates its configuration, so a followed transfer to it puts
    // the puppet at a gate with the client still attached on its kept
    // connection: the leg holds the accept, the core holds the gate, and the
    // client then leaves without answering. "No client attached" is exactly the
    // condition the gate fallback names (#21), so the gate is the puppet's.
    //
    // O42 ended the client it probed, so this starts with a client of its own:
    // a detach is the trigger, and there has to be something to detach.
    gatedFake = await createFakeBackend({ port: 0, logStream: null, codeOfConduct: true })
    gatedProxy = await createHandshakeProxy({ targetPort: gatedFake.port, log })
    bot6 = createBot({
      port: seamlessBound.port ?? seamlessFront.port,
      username: 'Second',
      answerCodeOfConduct: false
    })
    await bot6.ready()
    const b6 = bot6.received
    const settledMark = logs.length
    const detachAnswers = seamlessCore.metrics.controlDialogsAnsweredOnDetach
    fake2.sendTransfer('127.0.0.1', gatedProxy.port)
    await bot6.waitFor(
      () => b6.names.some(frame => frame.state === 'configuration' && frame.name === 'code_of_conduct'),
      'the gated target code of conduct on the kept connection',
      20_000
    )
    await waitFor(() => seamlessCore.pendingDialog.held === true, 'the gate held for the attached client', 20_000)
    // The bot was built not to answer, so the gate it holds is the client's
    // refusal rather than an inference.
    const gatesHeld = b6.gatesHeld
    await bot6.close()
    await waitFor(
      () => seamlessCore.metrics.controlDialogsAnsweredOnDetach === detachAnswers + 1,
      'the detach answered the held gate',
      20_000
    )
    // The client is gone, so the session is detached: what proves the accept
    // arrived is that the puppet is warm on a backend that withholds
    // finish_configuration until it does. No wait on the gated backend's own
    // accept count: a followed transfer moves both rigs' puppets, so that count
    // is shared.
    await waitFor(() => seamlessCore.session.warmReady === true,
      'the gated target warm with nobody attached', 20_000)
    const gateLogs = logs.slice(settledMark)
    const gateHeldLogged = gateLogs.some(entry => entry.event === 'codeOfConductHeld')
    const gateAcceptedLogged = gateLogs.some(entry => entry.event === 'codeOfConductAccepted')
    // The gated backend counts every puppet that reaches it, and the transfer
    // moves both rigs' puppets, so the counts are shared and are evidence, not
    // the assertion. What proves this rig's gate is closed is that the gated
    // backend withholds finish_configuration until it receives the accept: this
    // puppet is warm on it, so its own accept arrived.
    evidence.gateOnDetach = {
      sends: gatedFake.received.codeOfConductSends,
      accepts: gatedFake.received.codeOfConductAccepts,
      gateHeldLogged,
      gateAcceptedLogged,
      answeredOnDetach: seamlessCore.metrics.controlDialogsAnsweredOnDetach - detachAnswers,
      held: seamlessCore.pendingDialog.held,
      warm: seamlessCore.session.warmReady,
      gatesHeld,
      backendLogins: seamlessCore.session.backendLogins
    }
    check(
      'O43',
      'a configuration gate the last client left is answered as the puppet, and logged',
      gatedFake.received.codeOfConductAccepts >= 1 &&
        gatesHeld >= 1 &&
        gateHeldLogged &&
        gateAcceptedLogged &&
        seamlessCore.metrics.controlDialogsAnsweredOnDetach === detachAnswers + 1 &&
        seamlessCore.pendingDialog.held === false &&
        seamlessCore.session.warmReady === true &&
        seamlessCore.logs().some(line => line.includes('"event":"controlDialogAnsweredOnDetach"')),
      evidence.gateOnDetach
    )

    // --- O44: a play dialog the last client left stays held (#20) ---
    bot7 = createBot({ port: seamlessBound.port ?? seamlessFront.port, username: 'Attach' })
    await bot7.ready()
    const b7 = bot7.received
    const PLAY_ID = 'monoplayer:left_behind'
    const playMark = logs.length
    gatedFake.sendShowDialog({ id: PLAY_ID })
    await bot7.waitFor(() => b7.dialogs.length === 1, 'the play dialog at the attached client')
    await waitFor(() => seamlessCore.pendingDialog.held === true, 'the play dialog held')
    await bot7.close()

    const clicksBefore = gatedFake.received.customClickActions.length
    const answersBefore = seamlessCore.metrics.controlDialogsAnsweredOnDetach
    const resentBefore = seamlessCore.metrics.controlDialogsResent
    bot8 = createBot({ port: seamlessBound.port ?? seamlessFront.port, username: 'Second' })
    await bot8.ready()
    const b8 = bot8.received
    await bot8.waitFor(() => b8.dialogs.length === 1, 'the held play dialog re-sent to the reattaching client')
    evidence.playHeldOnDetach = {
      heldAfterDetach: seamlessCore.pendingDialog.held,
      puppetClicks: gatedFake.received.customClickActions.length - clicksBefore,
      answeredOnDetach: seamlessCore.metrics.controlDialogsAnsweredOnDetach - answersBefore,
      resent: seamlessCore.metrics.controlDialogsResent - resentBefore,
      waited: logs.slice(playMark).some(entry =>
        entry.event === 'dialogUnhandled' && entry.fields?.reason === 'play_dialog_waits')
    }
    check(
      'O44',
      'a play dialog the last client left stays held, unclicked, and is re-sent on reattach',
      evidence.playHeldOnDetach.heldAfterDetach === true &&
        evidence.playHeldOnDetach.puppetClicks === 0 &&
        evidence.playHeldOnDetach.answeredOnDetach === 0 &&
        evidence.playHeldOnDetach.resent === 1 &&
        b8.dialogs.length === 1 &&
        evidence.playHeldOnDetach.waited,
      evidence.playHeldOnDetach
    )

    // --- O48: the total cap on the pre-auth window (#201) ---
    // The window runs from the accepted socket to the attach whitelist's accept,
    // and it is the one limit that still counts when a tunnel presents its own
    // address instead of the client's. The rig is its own because the assertion
    // needs a window of one: a second socket may not fit anywhere else on this
    // rung while the over-cap connection arrives. No core and no backend are
    // built: a refused connection must never reach a login, so there is nothing
    // for either to decide.
    const attachUuid = offlineUuid('Attach')
    capFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist: [attachUuid],
      preAuth: { maxConnections: 1 },
      getSnapshotConfig: () => [],
      wireMode: 'off',
      log
    })
    // A login that reached the whitelist would be allowed: this leg's core
    // attaches whatever arrives, so nothing but the cap can refuse the client.
    capFront.setCoreAttachConfiguring(() => ({ attached: true, configuring: true, replayed: 0 }))
    const capBound = await capFront.listen()
    const capPort = capBound.port ?? capFront.port

    // The hold: a socket that says nothing. It has been accepted and its login
    // review has not run, which is the window the cap counts.
    capSocket = net.connect({ host: '127.0.0.1', port: capPort })
    await new Promise((resolve, reject) => {
      capSocket.once('connect', resolve)
      capSocket.once('error', reject)
    })
    await waitFor(() => capFront.metrics.preAuthInWindow === 1, 'the idle socket inside the pre-auth window')

    const capMark = logs.length
    capRefusedBot = createBot({ port: capPort, username: 'Attach' })
    await withTimeout(capRefusedBot.ended, 10_000, 'the over-cap connection ended')
    const refusedFrames = capRefusedBot.received.names.slice()
    const refusedLogs = logs.slice(capMark)
    const capRefusal = refusedLogs.filter(entry => entry.event === 'preAuthRefused')

    // The socket leaves, and the slot it held leaves with it: the next client is
    // admitted, is allowed (its UUID is the whitelist's), and then holds no slot
    // at all, which is what keeps an established session outside the cap.
    capSocket.destroy()
    await waitFor(() => capFront.metrics.preAuthInWindow === 0, 'the released pre-auth slot')
    capBot = createBot({ port: capPort, username: 'Attach' })
    // This client stops at the whitelist's accept: the rig has no backend, so
    // its configuration round never finishes. That is where the window ends,
    // which is the point.
    await waitFor(() => capFront.metrics.allowed === 1, 'the connection past the whitelist')
    const windowAfterAccept = capFront.metrics.preAuthInWindow
    // A third socket while the accepted client is still connected: a window that
    // still held it could not admit this one.
    capSocket = net.connect({ host: '127.0.0.1', port: capPort })
    await new Promise((resolve, reject) => {
      capSocket.once('connect', resolve)
      capSocket.once('error', reject)
    })
    await waitFor(() => capFront.metrics.preAuthInWindow === 1, 'a second socket admitted beside an accepted one')
    const windowWithAcceptedClient = capFront.metrics.preAuthInWindow
    capSocket.destroy()

    evidence.preAuthWindow = {
      maxConnections: 1,
      overCapFrames: refusedFrames.length,
      overCapSuccess: capRefusedBot.received.success !== null,
      refused: capFront.metrics.preAuthRefused,
      whitelistDenials: capFront.metrics.denied,
      inWindowWithIdleSocket: 1,
      inWindowAfterAccept: windowAfterAccept,
      inWindowWithAcceptedClient: windowWithAcceptedClient,
      logLines: capRefusal.map(entry => entry.fields),
      loginReviewed: refusedLogs.some(entry => entry.event === 'frontLoginReview'),
      // The rig above ran every other assertion through a front leg on the
      // default cap, so a default that tripped on this rung would have answered
      // here.
      defaultCapRefused: front.metrics.preAuthRefused
    }
    check(
      'O48',
      'a connection over the pre-auth cap is refused before login, and a connection past the whitelist holds no slot',
      refusedFrames.length === 0 &&
        capRefusedBot.received.success === null &&
        capFront.metrics.preAuthRefused === 1 &&
        capFront.metrics.denied === 0 &&
        capRefusal.length === 1 &&
        capRefusal[0].fields?.reason === 'preauth_connection_cap' &&
        !evidence.preAuthWindow.loginReviewed &&
        windowAfterAccept === 0 &&
        windowWithAcceptedClient === 1 &&
        front.metrics.preAuthRefused === 0,
      evidence.preAuthWindow
    )

    // --- O49: the deadline on the pre-auth window (#205) ---
    // #201's cap bounds how many sockets sit in the window and nothing bounded
    // how long one stayed, so a stranger could hold the window closed with
    // sockets that never speak. This rig is the cap's with a millisecond deadline
    // instead of a cap of one: the same silent socket, and a real attach beside
    // it that the deadline must not cut.
    const deadlineMs = 1000
    deadlineFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist: [attachUuid],
      preAuth: { maxConnections: 1, deadlineMs },
      getSnapshotConfig: () => [],
      wireMode: 'off',
      log
    })
    // As in O48: this leg's core attaches whatever reaches the whitelist, so
    // nothing but the deadline can take the silent socket's slot back.
    deadlineFront.setCoreAttachConfiguring(() => ({ attached: true, configuring: true, replayed: 0 }))
    const deadlineBound = await deadlineFront.listen()
    const deadlinePort = deadlineBound.port ?? deadlineFront.port

    // The hold: a socket that says nothing, exactly as in O48. Nothing writes to
    // it, so a close here can only be the leg's.
    deadlineSocket = net.connect({ host: '127.0.0.1', port: deadlinePort })
    await new Promise((resolve, reject) => {
      deadlineSocket.once('connect', resolve)
      deadlineSocket.once('error', reject)
    })
    await waitFor(() => deadlineFront.metrics.preAuthInWindow === 1, 'the silent socket inside the pre-auth window')
    const socketClosed = new Promise(resolve => deadlineSocket.once('close', () => resolve(true)))
    const deadlineMark = logs.length
    const destroyed = await withTimeout(socketClosed, deadlineMs + 10_000, 'the silent socket destroyed by its deadline')
    await waitFor(() => deadlineFront.metrics.preAuthInWindow === 0, 'the slot the deadline freed')
    const deadlineLogs = logs.slice(deadlineMark)
    const deadlineExpiry = deadlineLogs.filter(entry => entry.event === 'preAuthExpired')

    // A stranger whose UUID is not on the list is refused, not expired: the
    // denial is that connection's decision, so the deadline is disarmed and the
    // expiry line stays the silent socket's alone.
    deadlineStranger = createBot({ port: deadlinePort, username: 'Stranger' })
    await withTimeout(deadlineStranger.ended, 10_000, 'the refused stranger ended')
    await waitFor(() => deadlineFront.metrics.preAuthInWindow === 0, 'the slot the refusal freed')

    // A real attach on the same rig, and then past the deadline. The window ends
    // at the whitelist's accept, so the timer has to be disarmed there: a slow
    // login that reached the accept is never cut by a bound it already met.
    deadlineBot = createBot({ port: deadlinePort, username: 'Attach' })
    await waitFor(() => deadlineFront.metrics.allowed === 1, 'the connection past the whitelist')
    const expiredAfterAccept = deadlineFront.metrics.preAuthExpired
    await new Promise(resolve => setTimeout(resolve, deadlineMs + 250))
    const survivedPastDeadline =
      deadlineBot.received.ended === null &&
      deadlineBot.client?.socket?.destroyed !== true &&
      deadlineFront.metrics.allowed === 1
    const expiryLines = logs.slice(deadlineMark).filter(entry => entry.event === 'preAuthExpired')

    evidence.preAuthDeadline = {
      deadlineMs,
      socketDestroyed: destroyed,
      expired: deadlineFront.metrics.preAuthExpired,
      inWindowAfterExpiry: deadlineFront.metrics.preAuthInWindow,
      logLines: deadlineExpiry.map(entry => entry.fields),
      expiredAfterAccept,
      survivedPastDeadline,
      attachedAfterExpiry: deadlineFront.metrics.allowed,
      refused: deadlineFront.metrics.denied,
      expiryLinesTotal: expiryLines.length,
      // The rig above ran every other assertion through a front leg on the
      // default deadline, so a default that tripped on this rung would have
      // destroyed a connection here.
      defaultExpired: front.metrics.preAuthExpired
    }
    check(
      'O49',
      'a silent socket is destroyed by the pre-auth deadline, a refusal is counted as a refusal, and an accepted connection is never cut by it',
      destroyed === true &&
        deadlineFront.metrics.preAuthExpired === 1 &&
        deadlineFront.metrics.preAuthInWindow === 0 &&
        deadlineExpiry.length === 1 &&
        deadlineExpiry[0].fields?.reason === 'preauth_deadline' &&
        deadlineExpiry[0].fields?.deadlineMs === deadlineMs &&
        expiredAfterAccept === 1 &&
        deadlineFront.metrics.denied === 1 &&
        expiryLines.length === 1 &&
        survivedPastDeadline === true &&
        deadlineFront.metrics.allowed === 1 &&
        front.metrics.preAuthExpired === 0,
      evidence.preAuthDeadline
    )

    // --- O50: what an attach says its attach stream contained (#218) ---
    // A report said a player could not see another player after attaching. The
    // state cache's entity domain keeps a bounded window (#213), so a body that
    // spawned earlier has no `spawn_entity` left to send, while `player_info` is
    // a keyed domain and behaves. Nothing recorded what an attach stream
    // actually carried, so the prediction could not be checked against
    // production.
    //
    // Its own rig, for the reason O48 and O49 have one. The main rig has been
    // through nine attaches, two transfers, and three other backends, so a count
    // taken there would describe a stream nobody can reconstruct. This rig is
    // the smallest one that attaches twice.
    //
    // The defect's shape comes from sending metadata for an id the backend never
    // spawned. The cache cannot tell that apart from a window that evicted the
    // spawn, because both leave a metadata entry with no spawn beside it.
    attachBase = await createFakeBackend({ port: 0, logStream: null })
    attachFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist,
      getSnapshotConfig: () => attachCore?.cache.snapshot().config ?? [],
      wireCheck: payload => wire.check(payload),
      wireMode: 'throw',
      log
    })
    attachBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: attachBase.port,
      version: VERSION,
      username: 'GlowSquidye',
      dialogAction: 'last',
      isHumanAttached: () => attachCore?.attached === true,
      onDialogAnswered: ({ state }) => attachCore?.notePuppetDialogAnswer({ state }),
      log
    })
    attachCore = createMonoplayer({
      config: loadConfig({ ...config, backend: { ...config.backend, port: attachBase.port } }),
      backendLeg: attachBackend,
      frontLeg: attachFront,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('attachCore', { line }) }
    })
    attachFront.setCoreAttachConfiguring(({ name, uuid }) => attachCore.attachConfiguringPlayer({ name, uuid }))
    attachFront.setConfiguringHandler(({ name }) => attachCore.configuringReady({ name }))
    attachFront.setClientSettingsHandler(settings => attachCore.noteClientSettings(settings))
    attachFront.setCoreAttach(({ name, uuid }) => attachCore.attachPlayer({ name, uuid, includeConfig: false }))
    attachCore.start()
    await attachBackend.connect()
    const attachReadiness = await waitForReady({ core: attachCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!attachReadiness.warm) throw new Error('the attach-record rig did not warm')
    const attachBound = await attachFront.listen()
    const attachPort = attachBound.port ?? attachFront.port

    // One body, and no metadata for it, so the ordinary attach's stream is a
    // spawn and nothing else. That is the shape a healthy attach has.
    attachBase.sendSpawnEntity({ entityId: 99, x: 0, y: 64, z: 0 })
    await waitFor(() => attachCore.cache.snapshot().entities.some(entry =>
      entry.name === 'spawn_entity' && entry.data?.entityId === 99), 'the rig body in the cache')

    // The attach records the core wrote, oldest first. Reading the core's own
    // log line is the point: the record under test is the one the product
    // emitted, not a value this rig rebuilt from the same snapshot.
    const attachRecords = from => coreLogEvents(from, 'attachCore').filter(entry => entry.event === 'attach')

    const ordinaryMark = logs.length
    attachBot1 = createBot({ port: attachPort, username: 'Attach' })
    await attachBot1.ready()
    await waitFor(() => attachRecords(ordinaryMark).length === 1, 'the ordinary attach record')
    const ordinaryAttach = attachRecords(ordinaryMark)[0]

    // The client leaves, so the metadata written next cannot be relayed live to
    // it. It is cache state, and the next client's attach stream is what the
    // record describes.
    await attachBot1.close()
    attachBot1 = null
    await waitFor(() => attachCore.attached === false, 'the first client detached')

    // One entity_metadata for an id nothing spawned. It is written through the
    // fake's own server, so the frame that reaches the cache is encoded and
    // decoded like every other. The fake offers no sender for it, because
    // nothing before this ticket needed a body that was never spawned, and
    // src/legs/fake-backend.js is outside this ticket's fence.
    const orphanEntityId = 55
    for (const client of Object.values(attachBase.server.clients)) {
      client.write('entity_metadata', { entityId: orphanEntityId, metadata: [{ key: 0, type: 'byte', value: 0 }] })
    }
    await waitFor(() => attachCore.cache.snapshot().entities.some(entry =>
      entry.name === 'entity_metadata' && entry.data?.entityId === orphanEntityId),
      'the orphan metadata frame in the cache')

    const orphanMark = logs.length
    attachBot2 = createBot({ port: attachPort, username: 'Attach' })
    await attachBot2.ready()
    await waitFor(() => attachRecords(orphanMark).length === 1, 'the second attach record')
    const orphanAttach = attachRecords(orphanMark)[0]

    evidence.attachRecord = { ordinary: ordinaryAttach ?? null, orphan: orphanAttach ?? null }

    // Every field the record calls a count is a count, and the domains add up
    // to the frames the attach stream wrote on this snapshot. A field the record
    // gained without a meaning would show up here as a number that is not one.
    const counted = value => Number.isInteger(value) && value >= 0
    const describesTheAttachRecord = record =>
      record !== undefined &&
      record.reason === 'attach' &&
      counted(record.replayed) &&
      counted(record.entities?.replayed) &&
      counted(record.entities?.withoutSpawn) &&
      counted(record.players?.info) &&
      counted(record.players?.bodies) &&
      counted(record.dialogs?.held) &&
      counted(record.dialogs?.resent) &&
      counted(record.packs?.held) &&
      counted(record.packs?.resent) &&
      Number.isFinite(record.tookMs) &&
      REPLAY_DOMAINS.every(domain => counted(record.domains?.[domain])) &&
      REPLAY_DOMAINS.reduce((sum, domain) => sum + record.domains[domain], 0) === record.replayed

    check(
      'O50',
      'the attach record counts what the attach stream contained, and a metadata frame with no spawn is visible in it',
      describesTheAttachRecord(ordinaryAttach) &&
        describesTheAttachRecord(orphanAttach) &&
        ordinaryAttach.entities.withoutSpawn === 0 &&
        ordinaryAttach.entities.replayed >= 1 &&
        orphanAttach.entities.withoutSpawn === 1 &&
        orphanAttach.entities.replayed === ordinaryAttach.entities.replayed &&
        orphanAttach.domains.entities > ordinaryAttach.domains.entities,
      evidence.attachRecord
    )
    // --- O51: the entity domain is keyed by entity, not by arrival order (#213) ---
    // A rig of its own, because the assertion needs a small entity bound: the main
    // rig runs on the default 2048 entities, and proving the bound on it would mean
    // sending 2049 of them. Four entities here, and the churn is five frames, so an
    // arrival-ordered ring of four loses the first entity's spawn while this one
    // keeps every entity. Nothing above this line changes.
    let entityFake = null
    let entityBackend = null
    let entityFront = null
    let entityCore = null
    let entityBot = null
    try {
      entityFake = await createFakeBackend({ port: 0, logStream: null })
      const entityWhitelist = [offlineUuid('Attach')]
      const entityConfig = loadConfig({
        version: VERSION,
        attachWhitelist: entityWhitelist,
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: entityFake.port },
        puppet: { username: 'GlowSquidye', uuid: offlineUuid('GlowSquidye') },
        bounds: { maxEntities: 4 }
      })
      entityBackend = createOfflineBackendLeg({
        host: '127.0.0.1',
        port: entityFake.port,
        version: VERSION,
        username: 'GlowSquidye',
        log
      })
      const entityWire = createWireChecker({ version: VERSION })
      entityFront = createOfflineFrontLeg({
        host: '127.0.0.1',
        port: 0,
        version: VERSION,
        offlineWhitelist: entityWhitelist,
        getSnapshotConfig: () => entityCore.cache.snapshot().config,
        wireCheck: payload => entityWire.check(payload),
        wireMode: 'throw',
        log
      })
      entityCore = createMonoplayer({
        config: entityConfig,
        backendLeg: entityBackend,
        frontLeg: entityFront,
        clock: {
          now: Date.now,
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout
        },
        logStream: { write: line => log('core', { line }) }
      })
      const entityAttaches = []
      entityFront.setCoreAttachConfiguring(({ name, uuid }) => entityCore.attachConfiguringPlayer({ name, uuid }))
      entityFront.setConfiguringHandler(({ name }) => entityCore.configuringReady({ name }))
      entityFront.setClientSettingsHandler(settings => entityCore.noteClientSettings(settings))
      entityFront.setCoreAttach(({ name, uuid }) => {
        const outcome = entityCore.attachPlayer({ name, uuid, includeConfig: false })
        if (outcome.attached) entityAttaches.push(outcome.frames ?? [])
        return outcome
      })
      entityCore.start()
      const entityBound = await entityFront.listen()
      const entityPort = entityBound.port ?? entityFront.port
      await entityBackend.connect()
      await waitForReady({ core: entityCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })

      // Entity 9's body, then its correction, then three more entities: four
      // entities and five frames. Under the old ring these five frames were a FIFO
      // of four, so entity 9's spawn was the one that went, and the replay carried a
      // correction for a body the client never spawned.
      entityFake.sendSpawnEntity({ entityId: 9, x: 1 })
      entityFake.sendSyncEntityPosition({ entityId: 9, x: 2 })
      for (let entityId = 10; entityId <= 12; entityId++) {
        entityFake.sendSpawnEntity({ entityId, x: 3 })
      }
      await waitFor(
        () => entityCore.cache.snapshot().entities.length === 5,
        'the five entity frames in the keyed entity domain'
      )

      const entitySnapshot = entityCore.cache.snapshot()
      entityBot = createBot({ port: entityPort, username: 'Attach' })
      await entityBot.ready()
      await entityBot.waitFor(
        () => entityAttaches.length === 1 &&
          entityBot.playNames().filter(name => name === 'spawn_entity' || name === 'sync_entity_position').length >= 5,
        'the entity frames the replay carried'
      )
      const replayedEntityFrames = (entityAttaches[0] ?? [])
        .map(frame => frame.name)
        .filter(name => name === 'spawn_entity' || name === 'sync_entity_position')
      const receivedEntityFrames = entityBot.playNames()
        .filter(name => name === 'spawn_entity' || name === 'sync_entity_position')
      const entityStats = entityCore.cache.stats()

      evidence.entityDomain = {
        bound: 4,
        entities: entityStats.sizes.entities,
        frames: entitySnapshot.entities.length,
        replayed: replayedEntityFrames,
        received: receivedEntityFrames,
        overflows: entityStats.metrics.overflows.entity,
        frameOverflows: entityStats.metrics.overflows.entityFrames,
        slots: entityStats.entitySlots
      }
      check(
        'O51',
        'the entity domain keeps every entity the bound allows, so a replayed body always carries its spawn',
        entityStats.sizes.entities === 4 &&
          entitySnapshot.entities.length === 5 &&
          replayedEntityFrames.join(',') ===
            'spawn_entity,sync_entity_position,spawn_entity,spawn_entity,spawn_entity' &&
          receivedEntityFrames.join(',') === replayedEntityFrames.join(',') &&
          entityStats.entitySlots === 5 &&
          entityStats.metrics.overflows.entity === 0 &&
          entityStats.metrics.overflows.entityDepth === 0 &&
          entityStats.metrics.overflows.entityFrames === 0,
        evidence.entityDomain
      )
    } finally {
      try { await entityBot?.close?.() } catch { /* best effort */ }
      try { await entityFront?.close?.() } catch { /* best effort */ }
      try { await entityBackend?.close?.() } catch { /* best effort */ }
      try { await entityFake?.close?.() } catch { /* best effort */ }
    }

    // --- O52: the journal still records the frames a diagnosis reads (#217) ---
    // #217 drops the entity stream from the journal and makes chunks
    // length-only, and that filter's promise — "what a diagnosis reads is still
    // there" — is the council's own blind spot. It is a check here or it is an
    // opinion.
    //
    // The rig is the main one, because it is the only one that writes the names
    // a diagnosis reads: a join with terrain, two dialogs, three resource packs,
    // two transfers, and traffic in both directions. A rig built for this check
    // alone would prove the writer on a stream nobody diagnoses.
    //
    // The rig's own `player_info` was written above, while a client was attached:
    // the fake has no sender for it, and the journal never sees the front leg's
    // own skin frame.
    //
    // The third kind, `events`: the service writes lifecycle events from
    // src/service/start-live.js, and this rung does not run start-live, so the
    // rig writes the record start-live writes on a healthy start. Without it the
    // events shard and its manifest would be untested by the one rung that owns a
    // real writer. `rig` marks the record as this rung's, not a live lane's.
    journal.event('liveReady', { warm: true, rig: 'loopback' })

    // The seal is the writer's, not the rig's: close() gzips every live shard and
    // writes its manifest, exactly as the service does when it shuts down. A
    // loopback run never crosses an hour, so this is the only seal the check has.
    journal.close()
    const journalStats = journal.stats()

    const journalEntries = []
    for await (const entry of readJournal(journalDir)) journalEntries.push(entry)
    const frameRecords = journalEntries
      .map(entry => entry.record)
      .filter(record => typeof record.dir === 'string' && typeof record.name === 'string')
    const shardFiles = fs.readdirSync(journalDir).sort()
    const sealedShards = shardFiles.filter(name => name.endsWith('.ndjson.gz'))
    const storedManifests = await readManifests(journalDir)

    // The names a diagnosis reads, and the seven the policy drops. Both lists are
    // the writer's own, so this check fails when the table changes and the
    // promise does not.
    const readsNames = ['login', 'position', 'map_chunk', 'player_info', 'show_dialog', 'add_resource_pack', 'transfer']
    const droppedNames = [
      'entity_head_rotation',
      'entity_look',
      'entity_metadata',
      'entity_move_look',
      'entity_teleport',
      'rel_entity_move',
      'sync_entity_position'
    ]
    const carriesBody = name => frameRecords.some(record =>
      record.name === name && typeof record.b64 === 'string' && record.b64.length > 0)
    const present = name => frameRecords.some(record => record.name === name)
    const chunk = frameRecords.find(record => record.name === 'map_chunk')
    const clientFrame = frameRecords.find(record =>
      record.dir === 'c2s' && typeof record.b64 === 'string' && record.b64.length > 0)
    const liveEvent = journalEntries.map(entry => entry.record).find(record => record.event === 'liveReady')

    // One manifest per sealed shard, and each one's line count and histogram are
    // what the shard holds. `bytesByName` is what each name costs on disk, which
    // is the number the 48-hour budget rests on.
    const histogram = list => {
      const out = {}
      for (const entry of list) {
        const name = typeof entry.record.event === 'string' ? 'event:' + entry.record.event : String(entry.record.name)
        out[name] = (out[name] ?? 0) + 1
      }
      return out
    }
    const sameHistogram = (left, right) => {
      const keys = Object.keys(left).sort()
      if (keys.join(',') !== Object.keys(right).sort().join(',')) return false
      return keys.every(key => left[key] === right[key])
    }
    const describedShards = sealedShards.filter(name => {
      const manifest = storedManifests.find(entry => entry.shard === name)
      if (manifest === undefined) return false
      const own = journalEntries.filter(entry => path.basename(entry.file) === name)
      return manifest.lines === own.length &&
        sameHistogram(manifest.names, histogram(own)) &&
        manifest.kind !== null &&
        manifest.hour !== null &&
        Number.isFinite(manifest.bytes) &&
        manifest.gzBytes > 0 &&
        Number.isFinite(manifest.from) &&
        Number.isFinite(manifest.to) &&
        Object.keys(manifest.bytesByName ?? {}).length >= 1
    })

    evidence.journal = {
      dir: journalDir,
      shards: shardFiles,
      kept: readsNames.filter(present),
      dropped: droppedNames.filter(present),
      clientFrame: clientFrame?.name ?? null,
      chunk: chunk === undefined ? null : { len: chunk.len, lengthOnly: chunk.lengthOnly === true, hasBody: 'b64' in chunk },
      events: journalEntries.map(entry => entry.record.event).filter(name => typeof name === 'string'),
      described: describedShards,
      manifests: storedManifests.map(manifest => ({ shard: manifest.shard, hour: manifest.hour, lines: manifest.lines })),
      skipped: journalStats.skipped,
      droppedCount: journalStats.dropped,
      sealed: journalStats.sealed
    }

    check(
      'O52',
      'the journal keeps the frames a diagnosis reads, drops the entity stream, and describes every shard it sealed',
      readsNames.every(present) &&
        carriesBody('player_info') &&
        carriesBody('login') &&
        carriesBody('show_dialog') &&
        carriesBody('add_resource_pack') &&
        carriesBody('transfer') &&
        clientFrame !== undefined &&
        chunk !== undefined &&
        chunk.lengthOnly === true &&
        'b64' in chunk === false &&
        chunk.len > 8192 &&
        droppedNames.every(name => !present(name)) &&
        journalStats.dropped > 0 &&
        journalStats.skipped > 0 &&
        liveEvent !== undefined &&
        sealedShards.length >= 3 &&
        describedShards.length === sealedShards.length,
      evidence.journal
    )

    // --- O53: the control document's whitelist reloads at each login (#229) ---
    // The point of the control document is an edit an operator can make without a
    // deploy and without a restart, and the whitelist is the half a refusal can
    // prove. Two gates decide a login: the core's login review and the front
    // leg's own store, so a unit test of either proves half. This rig writes the
    // file, refuses a real socket, adds that UUID to the file on disk, and joins
    // again on the same process, with no restart and no reconnect.
    controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-control-'))
    const controlWhitelistFile = path.join(controlDir, 'attach-whitelist.json')
    const controlDesiredFile = path.join(controlDir, 'desired.json')
    const firstUuid = offlineUuid('Attach')
    const lateUuid = offlineUuid('Second')
    const writeControlWhitelist = uuids => fs.writeFileSync(controlWhitelistFile, JSON.stringify({
      version: 1,
      players: uuids.map(uuid => ({ uuid, name: null, addedAt: new Date().toISOString() }))
    }, null, 2) + '\n')
    writeControlWhitelist([firstUuid])

    // The product's own reader, pointed at a temporary directory. The rig does not
    // reimplement the file: O53 is about the reload the service performs.
    const controlDocument = createControlDocument({
      file: controlDesiredFile,
      whitelistFile: controlWhitelistFile,
      allowBackendSwitch: true,
      log
    })
    controlBase = await createFakeBackend({ port: 0, logStream: null })
    controlBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: controlBase.port,
      version: VERSION,
      username: 'GlowSquidye',
      log
    })
    const controlWire = createWireChecker({ version: VERSION })
    controlFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      whitelistStore: controlDocument.whitelistStore,
      getSnapshotConfig: () => controlCore.cache.snapshot().config,
      wireCheck: payload => controlWire.check(payload),
      wireMode: 'throw',
      log
    })
    controlCore = createMonoplayer({
      config: loadConfig({
        version: VERSION,
        attachWhitelist: [],
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: controlBase.port },
        puppet: { username: 'GlowSquidye', uuid: offlineUuid('GlowSquidye') },
        control: { file: controlDesiredFile }
      }),
      backendLeg: controlBackend,
      frontLeg: controlFront,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('controlCore', { line }) },
      whitelistSource: controlDocument.attachWhitelist
    })
    controlFront.setCoreAttachConfiguring(({ name, uuid }) => controlCore.attachConfiguringPlayer({ name, uuid }))
    controlFront.setConfiguringHandler(({ name }) => controlCore.configuringReady({ name }))
    controlFront.setClientSettingsHandler(settings => controlCore.noteClientSettings(settings))
    controlFront.setCoreAttach(({ name, uuid }) => controlCore.attachPlayer({ name, uuid, includeConfig: false }))
    controlCore.start()
    await controlBackend.connect()
    const controlReadiness = await waitForReady({ core: controlCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!controlReadiness.warm) throw new Error('the control-document rig did not warm')
    const controlBound = await controlFront.listen()
    const controlPort = controlBound.port ?? controlFront.port

    // The login the whitelist refuses. A real socket: it reaches both gates, and
    // neither holds this UUID because it is not in the file.
    const deniedMark = logs.length
    controlBot1 = createBot({ port: controlPort, username: 'Second' })
    await withTimeout(controlBot1.ended, 10_000, 'the refused login ended')
    const deniedEvents = coreLogEvents(deniedMark, 'controlCore')
      .filter(entry => entry.event === 'attachDenied')
    const loginsBefore = controlCore.session.backendLogins

    // The operator's edit, and nothing else: no restart, no second core, no
    // reconnect. The file is the only thing that changes.
    writeControlWhitelist([firstUuid, lateUuid])
    const reloaded = controlDocument.attachWhitelist()

    controlBot2 = createBot({ port: controlPort, username: 'Second' })
    // Bounded, and recorded rather than thrown: if the second login fails on a
    // loaded machine, the report has to say which gate refused it. A throw here
    // would end the run with a reason nobody can read.
    const secondReady = await withTimeout(
      controlBot2.ready().then(() => true, () => false),
      20_000,
      'the second login'
    ).catch(() => false)
    const attachedAfterEdit = await settleUntil(() => controlCore.attached === true, 10_000)
    const secondDenials = coreLogEvents(deniedMark, 'controlCore')
      .filter(entry => entry.event === 'attachDenied')
      .map(entry => entry.reason)

    evidence.controlDocument = {
      file: controlWhitelistFile,
      deniedReason: deniedEvents.map(entry => entry.reason),
      deniedEnded: controlBot1.received.ended,
      deniedSuccess: controlBot1.received.success,
      deniedCount: controlFront.metrics.denied,
      reloaded,
      allowed: controlFront.metrics.allowed,
      attached: attachedAfterEdit,
      secondReady,
      secondDenials,
      secondEnded: controlBot2.received.ended,
      backendLogins: { before: loginsBefore, after: controlCore.session.backendLogins },
      allowedSuccess: controlBot2.received.success !== null
    }

    check(
      'O53',
      'a login the control whitelist refuses is allowed on the next attempt once the file gains its UUID, with no restart',
      deniedEvents.length === 1 &&
        deniedEvents[0].reason === 'not_whitelisted' &&
        controlBot1.received.ended !== null &&
        controlBot1.received.success === null &&
        controlFront.metrics.denied === 1 &&
        reloaded.includes(lateUuid) &&
        secondDenials.length === 1 &&
        secondDenials[0] === 'not_whitelisted' &&
        secondReady === true &&
        controlFront.metrics.allowed === 1 &&
        attachedAfterEdit === true &&
        controlBot2.received.success !== null &&
        controlCore.session.backendLogins === loginsBefore,
      evidence.controlDocument
    )

    // --- O54: an operator moves the puppet, and the human keeps the connection ---
    // The whole proof is two fake backends and one real client, because the
    // ticket forbids any of it running against Excalia, playit, or the live lane.
    // A rig of its own, because the assertion names which backend each login
    // landed on and the run's other rigs share their targets.
    //
    // The move is driven by the service's own tick (`createBackendMoveTick`), not
    // by a copy of it: the whole question is whether the document an operator
    // writes in the ConfigMap reaches the #22 machine, and a rig that decided for
    // itself would not answer it.
    operatorBase = await createFakeBackend({ port: 0, logStream: null })
    operatorTargetFake = await createFakeBackend({ port: 0, logStream: null })
    // The target's handshake intent is the one thing a fake backend cannot read
    // for itself, and an operator's move must be a fresh login (2), not a
    // transfer (3): intent 3 on a server that never sent a transfer is the
    // rejection sky-2 answers with.
    operatorProxy = await createHandshakeProxy({ targetPort: operatorTargetFake.port, log })
    const operatorWire = createWireChecker({ version: VERSION })
    operatorBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      port: operatorBase.port,
      version: VERSION,
      username: 'GlowSquidye',
      log
    })
    operatorFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: VERSION,
      offlineWhitelist,
      getSnapshotConfig: () => operatorCore?.cache.snapshot().config ?? [],
      wireCheck: payload => operatorWire.check(payload),
      wireMode: 'throw',
      log
    })
    operatorCore = createMonoplayer({
      config: loadConfig({
        version: VERSION,
        // The same two clients the seamless rig allows: this rig is about the
        // move, so its whitelist is the rung's ordinary one, on both gates.
        attachWhitelist: offlineWhitelist,
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: operatorBase.port },
        puppet: { username: 'GlowSquidye', uuid: puppetUuid },
        control: { file: controlDesiredFile, allowBackendSwitch: true }
      }),
      backendLeg: operatorBackend,
      frontLeg: operatorFront,
      clock: {
        now: Date.now,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout
      },
      logStream: { write: line => log('operatorCore', { line }) }
    })
    operatorFront.setCoreAttachConfiguring(({ name, uuid }) => operatorCore.attachConfiguringPlayer({ name, uuid }))
    operatorFront.setConfiguringHandler(({ name }) => operatorCore.configuringReady({ name }))
    operatorFront.setClientSettingsHandler(settings => operatorCore.noteClientSettings(settings))
    operatorFront.setCoreAttach(({ name, uuid }) => operatorCore.attachPlayer({ name, uuid, includeConfig: false }))

    // The service's dial, for one rig: the same controller, the same dial policy,
    // and the same revert. Nothing here is a copy of start-live's decision, which
    // is what lets O54 assert the handshake intent the *product* chose rather than
    // the one this rig handed it.
    const operatorFollow = createTransferFollowController()
    const operatorBaseTarget = { host: '127.0.0.1', port: operatorBase.port }
    let operatorDocument = null
    let operatorTarget = { ...operatorBaseTarget }
    let operatorReconnecting = false
    operatorCore.on('reconnect_due', async ({ target: dueTarget, moveTarget } = {}) => {
      if (stopping || operatorReconnecting) return
      operatorReconnecting = true
      operatorCore.session.backendConnecting({ initial: false })
      const handedMove = moveTarget ?? null
      const due = operatorFollow.onDue({
        target: handedMove ?? dueTarget,
        kind: handedMove !== null ? 'operator' : 'transfer'
      })
      const chosen = dialTargetFor({
        transfer: due.kind === 'transfer' ? due.target : null,
        operator: due.kind === 'operator' ? due.target : null,
        desired: operatorDocument === null ? null : operatorDocument.desiredTarget(),
        current: operatorTarget,
        attached: operatorCore.attached === true
      })
      const dialTarget = chosen.target
      try {
        operatorBackend.setTarget(dialTarget, dialIntent({
          transfer: chosen.source === 'transfer',
          target: dialTarget,
          base: operatorBaseTarget
        }))
        await operatorBackend.connect()
        operatorFollow.onSuccess()
        operatorTarget = { host: dialTarget.host, port: dialTarget.port }
      } catch (error) {
        log('operatorDialFailed', {
          error: String(error?.message ?? error).slice(0, 200),
          backend: dialTarget.host + ':' + dialTarget.port,
          source: chosen.source
        })
        // The budget, spent the way the service spends it: one failure is a retry,
        // and the last one gives up on the target. The retries are the rig's
        // reconnect backoff (1 s, then 2 s), which is why O54b's waits allow for
        // three dials rather than one.
        const failure = operatorFollow.onFailure()
        if (failure.reverted) {
          // As the service does on the give-up: the move is restored, and the next
          // dial reads the settled backend from the controller's cleared memory.
          operatorCore.abortTransfer('target_unreachable')
          operatorBackend.setTarget(operatorTarget, dialIntent({ target: operatorTarget, base: operatorBaseTarget }))
        }
        operatorCore.session.fail()
      } finally {
        operatorReconnecting = false
      }
    })

    operatorCore.start()
    await operatorBackend.connect()
    const operatorReadiness = await waitForReady({ core: operatorCore, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    if (!operatorReadiness.warm) throw new Error('the operator-move rig did not warm')
    const operatorBound = await operatorFront.listen()
    operatorBot = createBot({ port: operatorBound.port ?? operatorFront.port, username: 'Attach' })
    await operatorBot.ready()
    const bOperators = operatorBot.received

    // The control document, written the way the panel writes it: the version, the
    // backend, and the two fields that make a rewrite a new intent.
    const writeDesiredBackend = (host, port, changedAt) => fs.writeFileSync(controlDesiredFile, JSON.stringify({
      version: 1,
      backend: { host, port },
      changedAt,
      changedBy: 'loopback'
    }, null, 2) + '\n')
    operatorDocument = createControlDocument({
      file: controlDesiredFile,
      allowBackendSwitch: true,
      log: (event, fields) => log('operatorDocument', { event, ...fields })
    })
    const operatorTick = createBackendMoveTick({
      core: operatorCore,
      control: operatorDocument,
      log: (event, fields) => log('operatorMove', { event, ...fields }),
      current: () => operatorTarget
    })

    // The document names the proxy, which is the second backend's address as far
    // as the puppet is concerned: the proxy records the intent and forwards.
    const operatorTargetAddress = { host: '127.0.0.1', port: operatorProxy.port }
    writeDesiredBackend(operatorTargetAddress.host, operatorTargetAddress.port, '2026-11-18T00:00:00.000Z')
    const moveMark = bOperators.names.length
    const moveLogMark = logs.length
    const moveStarted = operatorTick.tick()
    const intentsBefore = operatorProxy.nextStates.length
    await operatorBot.waitFor(
      () => bOperators.names.slice(moveMark).some(frame => frame.name === 'login'),
      'the operator target play login on the kept connection',
      25_000
    )
    await waitFor(
      () => operatorCore.metrics.reconfigurationsCompleted === 1 &&
        operatorCore.session.state === 'attached' &&
        operatorCore.session.warmReady === true,
      'the operator move to land',
      20_000
    )
    await settleUntil(() => operatorProxy.nextStates.length > intentsBefore, 5_000)
    // A block only the target sends, so "the client is in the second backend's
    // world" is a frame the first backend could not have produced.
    const OPERATOR_BLOCK = { x: 21, y: 0, z: 21 }
    operatorTargetFake.sendBlockChange(OPERATOR_BLOCK)
    const operatorBlockSeen = await settleUntil(
      () => bOperators.blockChanges.some(change =>
        change.location?.x === OPERATOR_BLOCK.x &&
        change.location?.y === OPERATOR_BLOCK.y &&
        change.location?.z === OPERATOR_BLOCK.z),
      10_000
    )
    const movedFrames = bOperators.names.slice(moveMark).map(frame => ({ state: frame.state, name: frame.name }))
    const movedNames = movedFrames.map(frame => frame.name)
    const operatorEvents = coreLogEvents(moveLogMark, 'operatorCore')
    evidence.backendMove = {
      started: moveStarted,
      backend: operatorTargetAddress.host + ':' + operatorTargetAddress.port,
      fakeBackend: '127.0.0.1:' + operatorTargetFake.port,
      handshakeIntent: operatorProxy.nextStates.at(-1) ?? null,
      intents: operatorProxy.nextStates,
      logins: { first: operatorBase.received.logins, second: operatorTargetFake.received.logins },
      attaches: operatorCore.metrics.attaches,
      reconfigurations: {
        completed: operatorCore.metrics.reconfigurationsCompleted,
        restored: operatorCore.metrics.reconfigurationsRestored
      },
      transfers: {
        followed: operatorCore.metrics.transfersFollowed,
        seamless: operatorCore.metrics.transfersSeamless
      },
      startedFrames: movedNames.slice(0, 5),
      configuration: movedFrames.filter(frame => frame.state === 'configuration').map(frame => frame.name),
      loginsOnClient: movedNames.filter(name => name === 'login').length,
      blockSeen: operatorBlockSeen,
      ended: bOperators.ended,
      kick: bOperators.kick,
      clientErrors: logs.slice(moveLogMark).filter(entry => entry.event === 'frontClientError').length,
      moveLog: operatorEvents.filter(entry => entry.event === 'backendMove').map(entry => ({
        kind: entry.kind,
        frontKept: entry.frontKept
      })),
      cacheReset: operatorEvents.filter(entry => entry.event === 'cacheReset').map(entry => entry.reason),
      // The old session was ended by the core and its late end event was read as a
      // handover, not as the target faulting. Without that the first backend's
      // socket would still be open under the second backend's session.
      handedOver: operatorEvents.filter(entry => entry.event === 'backendEndHandedOver').length
    }
    check(
      'O54',
      "an operator's move keeps the client's connection and lands it in the second backend's configuration and play state",
      moveStarted?.started === true &&
        moveStarted.kind === 'operator' &&
        evidence.backendMove.handshakeIntent === 2 &&
        operatorTargetFake.received.logins === 1 &&
        operatorBase.received.logins === 1 &&
        operatorCore.metrics.attaches === 1 &&
        operatorCore.metrics.reconfigurationsCompleted === 1 &&
        operatorCore.metrics.reconfigurationsRestored === 0 &&
        operatorCore.metrics.transfersFollowed === 0 &&
        operatorCore.metrics.transfersSeamless === 0 &&
        movedNames.includes('start_configuration') &&
        evidence.backendMove.configuration.includes('registry_data') &&
        evidence.backendMove.configuration.includes('finish_configuration') &&
        evidence.backendMove.loginsOnClient === 1 &&
        operatorBlockSeen === true &&
        bOperators.ended === null && bOperators.kick === null &&
        evidence.backendMove.clientErrors === 0 &&
        operatorCore.moveKind === null &&
        evidence.backendMove.moveLog.some(entry => entry.kind === 'operator' && entry.frontKept === true) &&
        evidence.backendMove.cacheReset.includes('operator') &&
        evidence.backendMove.handedOver === 1,
      evidence.backendMove
    )

    // The failure half. The port is bound and closed again, so the refusal is the
    // kernel's and not a fake's opinion. The client is on the second backend now,
    // because O54 just landed it there, so that is the backend this half proves
    // it stays on.
    const deadOperatorPort = await freePort()
    writeDesiredBackend('127.0.0.1', deadOperatorPort, '2026-11-18T00:10:00.000Z')
    const restoreMark = bOperators.names.length
    const restoreLogMark = logs.length
    const restoresBefore = operatorCore.metrics.reconfigurationsRestored
    const deadStarted = operatorTick.tick()
    await waitFor(
      () => operatorCore.metrics.reconfigurationsRestored === restoresBefore + 1,
      'the give-up on the target that never answered',
      25_000
    )
    await operatorBot.waitFor(
      () => bOperators.names.slice(restoreMark).some(frame => frame.name === 'login'),
      'the restored play state on the kept connection',
      20_000
    )
    // The restore is half the answer: the other half is the puppet dialling the
    // backend the client is on again, which is the second login the target sees.
    // Waiting on the dial target alone would pass without a dial, because it never
    // stopped pointing there.
    await waitFor(
      () => operatorCore.session.state === 'attached' &&
        operatorTargetFake.received.logins === 2 &&
        operatorTarget.port === operatorTargetAddress.port,
      'the puppet back on the backend the client holds',
      20_000
    )
    const restoredFrames = bOperators.names.slice(restoreMark).map(frame => ({ state: frame.state, name: frame.name }))
    const restoredEvents = coreLogEvents(restoreLogMark, 'operatorCore')
    evidence.backendMoveFailed = {
      started: deadStarted,
      backend: '127.0.0.1:' + deadOperatorPort,
      restored: operatorCore.metrics.reconfigurationsRestored - restoresBefore,
      backOn: '127.0.0.1:' + operatorTarget.port,
      logins: operatorTargetFake.received.logins,
      configuration: restoredFrames.filter(frame => frame.state === 'configuration').map(frame => frame.name),
      plays: restoredFrames.filter(frame => frame.state === 'play').map(frame => frame.name).slice(0, 5),
      ended: bOperators.ended,
      kick: bOperators.kick,
      restoredLogged: restoredEvents.filter(entry => entry.event === 'backendMoveRestored').length,
      dialFailures: logs.slice(restoreLogMark).filter(entry => entry.event === 'operatorDialFailed').length,
      failures: operatorFollow.failures
    }
    check(
      'O54b',
      'a target that never answers leaves the client on the backend it was on, connected',
      deadStarted?.started === true &&
        deadStarted.kind === 'operator' &&
        evidence.backendMoveFailed.restored === 1 &&
        evidence.backendMoveFailed.restoredLogged === 1 &&
        evidence.backendMoveFailed.dialFailures === 3 &&
        evidence.backendMoveFailed.failures === 0 &&
        evidence.backendMoveFailed.configuration.includes('finish_configuration') &&
        evidence.backendMoveFailed.plays.includes('login') &&
        evidence.backendMoveFailed.backOn === operatorTargetAddress.host + ':' + operatorTargetAddress.port &&
        operatorTargetFake.received.logins === 2 &&
        bOperators.ended === null && bOperators.kick === null &&
        operatorCore.session.state === 'attached',
      evidence.backendMoveFailed
    )

    // --- O55: a join with no backend gets the picker, and a pick is recorded (#257) ---
    // The gate the whole epic rests on. No backend is connected, and this rig
    // never dials one, so the client must still reach a screen it can answer. The
    // configuration phase it gets is the committed recording of a real Paper 26.2
    // build 135 (src/legs/configuration-baseline/26.2.json), served byte for byte,
    // and the picker is the dialog the front authors and holds the phase open for.
    //
    // This is the rung's only 26.2 rig, so it builds its own wire checker: the
    // configuration packet ids are the same in 26.1 and 26.2, but the play login is
    // not, and one checker cannot read both.
    const pickerVersion = '26.2'
    const pickerBaseline = readConfigurationBaseline()
    if (pickerBaseline === null) throw new Error('the committed configuration baseline is missing')
    const pickerWire = createWireChecker({ version: pickerVersion })
    const pickerWireChecks = []
    // #258: two rows, and the difference between them is the whole rig. The first
    // names a port nothing listens on: claiming it is a dial the kernel refuses, so
    // the client is offered the list again and its claim stands. The second names a
    // real 26.2 fake, so claiming it lands the client inside that body.
    const pickerServerName = '127.0.0.1:' + await freePort()
    const pickerBodySpawn = { x: 42.5, y: 65, z: -42.5 }
    pickerBodyFake = await createFakeBackend({
      port: 0,
      version: pickerVersion,
      // prismarine-chunk has no 26.2 implementation: this body sends the batch's
      // start and finish with no terrain in it. The client's landing is proven by
      // this body's play join and its own spawn, never by what it stands on.
      chunks: 'empty',
      spawn: pickerBodySpawn,
      logStream: null
    })
    const pickerBodyName = '127.0.0.1:' + pickerBodyFake.port
    const pickerPicks = []
    // #266: the verbs the front reports from the chosen server's dialog. The
    // second level's answer is a claim here. #267: a claim is recorded against the
    // body the frame names; spectate is still read and refused.
    const pickerVerbs = []
    // Five clients, so this rig has its own whitelist: the other rigs take the
    // shared pair, and a name they do not know would change what they can refuse.
    // The fifth is the one that claims a body this lane can reach (#258).
    const pickerWhitelist = [
      offlineUuid('Attach'), offlineUuid('Second'), offlineUuid('Third'), offlineUuid('Fourth'), offlineUuid('Pilot')
    ]
    pickerBackend = createOfflineBackendLeg({
      host: '127.0.0.1',
      // The lane's configured backend, which nothing listens on: with no claim, the
      // service never dials, and this rig's whole property is a picker with no
      // session behind it (Q6). #258: the one dial this rig makes is the claim's,
      // and it goes to the row the frame named, never to this address.
      port: Number(pickerServerName.slice(pickerServerName.lastIndexOf(':') + 1)),
      version: pickerVersion,
      username: 'GlowSquidye',
      log
    })
    pickerFront = createOfflineFrontLeg({
      host: '127.0.0.1',
      port: 0,
      version: pickerVersion,
      offlineWhitelist: pickerWhitelist,
      // No cached backend configuration exists, and none is invented: the front's
      // cached replay path must find nothing here.
      getSnapshotConfig: () => pickerCore?.cache.snapshot().config ?? [],
      configurationBaseline: pickerBaseline,
      pickerServers: () => [
        { name: pickerServerName, state: 'down', driver: null },
        { name: pickerBodyName, state: 'down', driver: null }
      ],
      onPickerPick: pick => pickerPicks.push(pick),
      onPickerVerb: verb => pickerVerbs.push(verb),
      wireCheck: payload => {
        const outcome = pickerWire.check(payload)
        pickerWireChecks.push({ state: payload.state, name: payload.name, ok: outcome.ok === true })
        return outcome
      },
      wireMode: 'throw',
      log
    })
    pickerCore = createMonoplayer({
      config: loadConfig({
        version: pickerVersion,
        // The one switch that lets a login with no backend through, and the reason
        // the front may serve a picker at all.
        picker: true,
        attachWhitelist: pickerWhitelist,
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: pickerBackend.port ?? 1 },
        puppet: { username: 'GlowSquidye', uuid: puppetUuid }
      }),
      backendLeg: pickerBackend,
      frontLeg: pickerFront,
      clock: { now: Date.now, setTimeout, clearTimeout },
      logStream: { write: line => log('pickerCore', { line }) }
    })
    // Wires the front's login decision to the core. Without it the front would run
    // only its own whitelist check and never hear `picker: true`.
    pickerCore.start()
    // #258: the rig stands in for start-live, which is what wires the play-ready
    // call-in. Without it a landed client reaches playerJoin with no one to take
    // it, and the leg ends it with `no_core_attached` rather than pretending.
    pickerFront.setCoreAttach(({ name, uuid }) => pickerCore.attachPlayer({ name, uuid, includeConfig: false }))
    const pickerBound = await pickerFront.listen()
    // #258: the no-dial rule, read at the only moment it is about: a picker that
    // exists and nothing claimed. The backend leg has no connection and never
    // opened one, so the lane is not warming a body behind the dialog (Q6). O55
    // asserts this, before any bot has clicked anything.
    const pickerNoClaim = {
      connected: pickerBackend.client !== null,
      ended: pickerBackend.ended,
      target: pickerBackend.target,
      bodyLogins: pickerBodyFake.received.logins,
      dials: pickerCore.metrics.claimDials,
      claimedBody: pickerCore.claimedBody
    }
    evidence.picker = {
      version: pickerVersion,
      noClaim: pickerNoClaim,
      baseline: {
        frames: pickerBaseline.frames.length,
        replay: pickerBaseline.replayFrames.length,
        registries: baselineRegistryNames(pickerBaseline).length,
        capturedAt: pickerBaseline.capturedFrom.at ?? null,
        lane: pickerBaseline.capturedFrom.lane ?? null,
        paperBuild: pickerBaseline.capturedFrom.paperBuild ?? null
      },
      frontPort: pickerBound.port,
      server: pickerServerName
    }

    pickerBot = createBot({ port: pickerBound.port, username: 'Attach', version: pickerVersion })
    await pickerBot.waitFor(() => pickerBot.received.dialogs.length === 1, 'the picker dialog at the client', 15_000)
    // A second client reads the picker at the same time: the picker is not an
    // attach, so it takes no slot and the first client does not hold one.
    pickerBot2 = createBot({ port: pickerBound.port, username: 'Second', version: pickerVersion })
    await pickerBot2.waitFor(() => pickerBot2.received.dialogs.length === 1, 'the picker dialog at the second client', 15_000)

    // What the client actually read, out of the frame it received: the id the
    // dialog carried, not a constant this rung chose. That is the codec answer.
    const pickerAction = chooseDialogAction(pickerBot.received.dialogs[0], 'first')
    const pickerFrameNames = pickerBot.received.names
      .filter(frame => frame.state === 'configuration')
      .map(frame => frame.name)
    const pickerRead = {
      action: pickerAction === null ? null : { id: pickerAction.id, label: pickerAction.label },
      configuration: pickerFrameNames,
      registries: pickerFrameNames.filter(name => name === 'registry_data').length,
      tags: pickerFrameNames.includes('tags'),
      knownPacks: pickerFrameNames.includes('select_known_packs'),
      featureFlags: pickerFrameNames.includes('feature_flags'),
      finished: pickerFrameNames.includes('finish_configuration'),
      leftovers: pickerBot.received.leftovers.length,
      errors: [...pickerBot.received.errors],
      mode: pickerFront.lastConfigMode
    }
    if (pickerAction !== null) {
      // A click built from the frame the client received, in the phase the client
      // is in. The library's own writer omits the payload's length prefix, so the
      // bot's answer is the vanilla layout (src/core/picker.js).
      pickerBot.answerDialog(pickerAction.id, null, 'configuration')
    }
    await waitFor(() => pickerPicks.length === 1, 'the pick to reach the service', 10_000)
    // #266: the pick opens that server's own dialog, and the phase stays open for
    // it. Nothing is entered: the second dialog is the whole of what a pick does
    // until #269 gives a claim a channel to deliver a body through.
    await pickerBot.waitFor(
      () => pickerBot.received.dialogs.length === 2,
      'the chosen server\'s dialog after a pick',
      15_000
    )
    // Read the dialog as the client read it: the title, the three buttons and the
    // ids they would answer with. Nothing here is a constant this rung chose.
    const readServerDialog = data => {
      const dialog = data?.dialog?.value ?? data?.dialog ?? data
      const entries = dialog?.actions?.value?.value
      return {
        title: dialog?.title?.value ?? (typeof dialog?.title === 'string' ? dialog.title : null),
        escapes: dialog?.can_close_with_escape?.value ?? null,
        columns: dialog?.columns?.value ?? null,
        buttons: Array.isArray(entries)
          ? entries.map(entry => ({
              label: entry?.label?.value ?? null,
              id: entry?.action?.value?.id?.value ?? null,
              type: entry?.action?.value?.type?.value ?? null
            }))
          : []
      }
    }
    const serverRead = readServerDialog(pickerBot.received.dialogs[1])
    const claimAction = chooseDialogAction(pickerBot.received.dialogs[1], 'claim')
    // #258: nothing has been dialled up to this click. The reachable body counts
    // zero logins while the picker is read, and the claim is the only thing that
    // changes that.
    const pickerBodyLoginsBeforeClaim = pickerBodyFake.received.logins
    if (claimAction !== null) pickerBot.answerDialog(claimAction.id, null, 'configuration')
    // #267: the claim is recorded where the client answered. #258: it is also the
    // one thing that dials a body, and this row's port answers nothing, so the
    // kernel refuses the dial and the client is offered the list again.
    await waitFor(() => pickerFront.metrics.pickerClaims === 1, 'the claim to be recorded', 10_000)
    await waitFor(() => pickerVerbs.length === 1, 'the verb to reach the service', 10_000)
    await pickerBot.waitFor(
      () => pickerBot.received.dialogs.length === 3,
      'the picker again after a body that refused the dial',
      15_000
    )
    const restoreRead = readServerDialog(pickerBot.received.dialogs[2])
    // #266: an unknown verb is refused and named, and the client is answered
    // rather than left in a dialog. The second client is in the same phase with no
    // dialog of its own left to click, so it is the one that sends it.
    pickerBot2.answerDialog('monoplayer:teleport/' + pickSlug(pickerServerName), null, 'configuration')
    await pickerBot2.waitFor(
      () => pickerBot2.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the refusal an unknown verb gets',
      15_000
    )
    const verbRefusals = logs
      .filter(entry => entry.event === 'pickerVerbRefused')
      .map(entry => entry.fields)
    evidence.picker.pick = {
      ...pickerRead,
      reported: pickerPicks[0] ?? null,
      ended: pickerBot.received.ended === null ? null : String(pickerBot.received.ended).slice(0, 120),
      secondClient: {
        dialogs: pickerBot2.received.dialogs.length,
        configuration: pickerBot2.received.names
          .filter(frame => frame.state === 'configuration')
          .map(frame => frame.name)
          .slice(0, 3),
        leftovers: pickerBot2.received.leftovers.length,
        ended: pickerBot2.received.ended === null ? null : String(pickerBot2.received.ended).slice(0, 120)
      },
      wire: {
        frames: pickerWireChecks.length,
        rejected: pickerWireChecks.filter(result => !result.ok).length,
        registries: pickerWireChecks.filter(result => result.name === 'registry_data').length
      },
      metrics: {
        pickers: pickerFront.metrics.pickers,
        picks: pickerFront.metrics.pickerPicks,
        serverDialogs: pickerFront.metrics.pickerServerDialogs,
        verbs: pickerFront.metrics.pickerVerbs,
        attaches: pickerCore.metrics.attaches,
        denials: pickerCore.metrics.denials
      }
    }
    evidence.picker.serverDialog = {
      read: serverRead,
      chosen: claimAction === null ? null : { id: claimAction.id, label: claimAction.label, total: claimAction.total },
      reported: pickerVerbs[0] ?? null,
      ended: pickerBot.received.ended === null ? null : String(pickerBot.received.ended).slice(0, 120),
      // #258: the body the frame named answers nothing on its port, so the claim's
      // dial is refused and the client is back at the list with its claim standing.
      restore: {
        title: restoreRead.title,
        buttons: restoreRead.buttons.map(button => button.id),
        dialogs: pickerBot.received.dialogs.length,
        claims: pickerFront.claims,
        reached: pickerBodyFake.received.logins,
        landings: pickerFront.metrics.claimLandings,
        landed: pickerFront.metrics.claimLanded,
        restored: pickerFront.metrics.claimRestored,
        dials: pickerCore.metrics.claimDials,
        dialsFailed: pickerCore.metrics.claimDialsFailed
      },
      refused: verbRefusals,
      refusedEnded: pickerBot2.received.ended === null ? null : String(pickerBot2.received.ended).slice(0, 120)
    }
    check(
      'O55',
      'a join with no backend receives the recorded configuration baseline and the picker, and its pick is recorded',
      pickerRead.registries === evidence.picker.baseline.registries &&
        pickerRead.tags === true &&
        pickerRead.knownPacks === true &&
        pickerRead.featureFlags === true &&
        pickerRead.finished === false &&
        pickerRead.leftovers === 0 &&
        pickerRead.errors.length === 0 &&
        pickerRead.mode === 'baseline' &&
        pickerAction !== null &&
        pickerAction.id === pickIdFor(pickerServerName) &&
        pickerPicks.length === 1 &&
        pickerPicks[0].id === pickerAction.id &&
        pickerPicks[0].server?.name === pickerServerName &&
        evidence.picker.pick.wire.rejected === 0 &&
        evidence.picker.pick.metrics.picks === 1 &&
        evidence.picker.pick.metrics.attaches === 0 &&
        pickerCore.attached === false &&
        // #258: nobody has claimed yet, and the lane has dialled nothing: the
        // picker is read with the configured backend untouched.
        // Read as a snapshot, because this check runs after the claim O56 makes:
        // what it asserts is the moment a picker existed and nothing had claimed.
        pickerNoClaim.connected === false &&
        pickerNoClaim.ended === false &&
        pickerNoClaim.bodyLogins === 0 &&
        pickerNoClaim.dials === 0 &&
        pickerNoClaim.claimedBody === null,
      evidence.picker.pick
    )
    check(
      'O55b',
      'a second client reads the picker at the same time: the picker takes no attach slot',
      pickerBot2.received.dialogs.length === 1 &&
        pickerBot2.received.leftovers.length === 0 &&
        pickerFront.metrics.pickers === 2,
      evidence.picker.pick.secondClient
    )
    check(
      'O56',
      "a pick opens that server's own dialog, its answer is read back from the frame the client sent, and a body that refuses the dial gives the picker back",
      pickerAction !== null &&
        serverRead.title === pickerServerName + ' - down' &&
        serverRead.escapes === 0 &&
        serverRead.columns === 1 &&
        serverRead.buttons.length === 3 &&
        serverRead.buttons.map(button => button.id).join(',') === [
          verbIdFor('claim', pickerServerName),
          verbIdFor('spectate', pickerServerName),
          verbIdFor('disconnect', pickerServerName)
        ].join(',') &&
        serverRead.buttons.map(button => button.label).join(',') === 'Claim,Spectate,Disconnect' &&
        serverRead.buttons.every(button => button.type === 'minecraft:dynamic/custom') &&
        claimAction !== null &&
        pickerBot.received.leftovers.length === 0 &&
        pickerVerbs.length === 1 &&
        pickerVerbs[0].verb === 'claim' &&
        pickerVerbs[0].id === claimAction.id &&
        pickerVerbs[0].slug === pickSlug(pickerServerName) &&
        pickerVerbs[0].server?.name === pickerServerName &&
        pickerBot.received.ended === null &&
        pickerFront.metrics.pickerServerDialogs === 1 &&
        pickerFront.metrics.pickerVerbs === 1 &&
        pickerFront.metrics.pickerClaims === 1 &&
        // #258: the dial was made, it was refused, and the client is back at the
        // list with the claim it made still standing. A claim that lands nothing
        // is a picker, not a limbo.
        pickerFront.metrics.claimLandings === 1 &&
        pickerFront.metrics.claimLanded === 0 &&
        pickerFront.metrics.claimRestored === 1 &&
        pickerCore.metrics.claimDials === 1 &&
        pickerCore.metrics.claimDialsFailed === 1 &&
        pickerCore.claimedBody === null &&
        restoreRead.title === 'Choose a server - ' + pickerServerName + ' did not answer' &&
        restoreRead.buttons.length === 2 &&
        pickerBodyFake.received.logins === pickerBodyLoginsBeforeClaim &&
        pickerBot.received.dialogs.length === 3 &&
        pickerFront.claims.length === 1 &&
        pickerCore.attached === false,
      evidence.picker.serverDialog
    )
    check(
      'O56b',
      'an unknown verb is refused and named, and the client is answered instead of left in a dialog',
      verbRefusals.length === 1 &&
        verbRefusals[0].verb === 'teleport' &&
        verbRefusals[0].slug === pickSlug(pickerServerName) &&
        /teleport/.test(String(verbRefusals[0].text ?? '')) &&
        /claim, spectate and disconnect/.test(String(verbRefusals[0].text ?? '')) &&
        pickerVerbs.length === 1 &&
        pickerBot2.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      evidence.picker.serverDialog
    )

    // #266: the one verb the dialog layer can carry out. A third client picks, then
    // clicks Disconnect out of the frame it received, and its configuration ends
    // with the sentence naming the server it left.
    pickerBot3 = createBot({ port: pickerBound.port, username: 'Third', version: pickerVersion })
    await pickerBot3.waitFor(() => pickerBot3.received.dialogs.length === 1, 'the picker at the third client', 15_000)
    const thirdPick = chooseDialogAction(pickerBot3.received.dialogs[0], 'first')
    if (thirdPick !== null) pickerBot3.answerDialog(thirdPick.id, null, 'configuration')
    await pickerBot3.waitFor(
      () => pickerBot3.received.dialogs.length === 2,
      "the chosen server's dialog at the third client",
      15_000
    )
    const thirdLeave = chooseDialogAction(pickerBot3.received.dialogs[1], 'disconnect')
    if (thirdLeave !== null) pickerBot3.answerDialog(thirdLeave.id, null, 'configuration')
    await pickerBot3.waitFor(
      () => pickerBot3.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the goodbye a disconnect gets',
      15_000
    )
    await waitFor(() => pickerVerbs.length === 2, 'the disconnect verb to reach the service', 10_000)
    evidence.picker.disconnect = {
      pick: thirdPick === null ? null : { id: thirdPick.id, label: thirdPick.label },
      chosen: thirdLeave === null ? null : { id: thirdLeave.id, label: thirdLeave.label },
      reported: pickerVerbs[1] ?? null,
      ended: pickerBot3.received.ended === null ? null : String(pickerBot3.received.ended).slice(0, 120),
      metrics: {
        picks: pickerFront.metrics.pickerPicks,
        serverDialogs: pickerFront.metrics.pickerServerDialogs,
        verbs: pickerFront.metrics.pickerVerbs,
        pickers: pickerFront.metrics.pickers
      }
    }
    check(
      'O56c',
      'disconnect is carried out: the client leaves the server it named, and the front says which',
      thirdPick !== null &&
        thirdPick.id === pickIdFor(pickerServerName) &&
        thirdLeave !== null &&
        thirdLeave.id === verbIdFor('disconnect', pickerServerName) &&
        thirdLeave.label === 'Disconnect' &&
        pickerVerbs.length === 2 &&
        pickerVerbs[1].verb === 'disconnect' &&
        pickerVerbs[1].id === thirdLeave.id &&
        pickerVerbs[1].server?.name === pickerServerName &&
        pickerBot3.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect') &&
        pickerFront.metrics.pickerPicks === 2 &&
        pickerFront.metrics.pickerServerDialogs === 2 &&
        pickerFront.metrics.pickerVerbs === 2 &&
        pickerFront.metrics.pickers === 3 &&
        pickerCore.attached === false,
      evidence.picker.disconnect
    )

    // #267: the claim, and what it contends with. The first client claimed the body
    // in O56 and is still connected, so it holds it. A fourth client reads the picker
    // while that claim stands, which it may, because the picker is not a claim and
    // takes no attach slot. It picks the same body and clicks Claim. The refusal
    // names the player who holds it, and the claimant is untouched on its own
    // connection.
    //
    // #258: what this still does not prove is a landing. The body claimed here is
    // the row whose port answers nothing, so the claimant is back at the picker
    // holding a body that never came up, and the rival is refused by the claim and
    // not by a session. The landing is O58's.
    pickerBot4 = createBot({ port: pickerBound.port, username: 'Fourth', version: pickerVersion })
    await pickerBot4.waitFor(
      () => pickerBot4.received.dialogs.length === 1,
      'the picker at a fourth client while a claim stands',
      15_000
    )
    // A client that has read the picker and not claimed holds nothing: the claims are
    // still the first client's alone. Read here, before this client clicks anything.
    const claimsWhileReading = pickerFront.claims
    const fourthRead = {
      dialogs: pickerBot4.received.dialogs.length,
      configuration: pickerBot4.received.names
        .filter(frame => frame.state === 'configuration')
        .map(frame => frame.name)
        .slice(0, 3),
      leftovers: pickerBot4.received.leftovers.length
    }
    const fourthPick = chooseDialogAction(pickerBot4.received.dialogs[0], 'first')
    if (fourthPick !== null) pickerBot4.answerDialog(fourthPick.id, null, 'configuration')
    await pickerBot4.waitFor(
      () => pickerBot4.received.dialogs.length === 2,
      "the chosen server's dialog at the fourth client",
      15_000
    )
    // A pick opens a dialog and claims nothing, so the same holds one level down.
    const claimsAfterPick = pickerFront.claims
    const fourthClaim = chooseDialogAction(pickerBot4.received.dialogs[1], 'claim')
    if (fourthClaim !== null) pickerBot4.answerDialog(fourthClaim.id, null, 'configuration')
    await pickerBot4.waitFor(
      () => pickerBot4.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the refusal a second claim on a claimed body gets',
      15_000
    )
    const claimGrants = logs
      .filter(entry => entry.event === 'pickerClaim')
      .map(entry => entry.fields)
    const claimRefusals = logs
      .filter(entry => entry.event === 'pickerClaimRefused')
      .map(entry => entry.fields)
    const claimHeld = pickerFront.claims
    evidence.picker.claim = {
      held: claimHeld,
      whileReading: claimsWhileReading,
      afterPick: claimsAfterPick,
      granted: claimGrants,
      refused: claimRefusals,
      claimant: {
        dialogs: pickerBot.received.dialogs.length,
        ended: pickerBot.received.ended === null ? null : String(pickerBot.received.ended).slice(0, 160)
      },
      rival: {
        ...fourthRead,
        pick: fourthPick === null ? null : { id: fourthPick.id, label: fourthPick.label },
        chosen: fourthClaim === null ? null : { id: fourthClaim.id, label: fourthClaim.label },
        ended: pickerBot4.received.ended === null ? null : String(pickerBot4.received.ended).slice(0, 160)
      },
      metrics: {
        pickers: pickerFront.metrics.pickers,
        claims: pickerFront.metrics.pickerClaims,
        refusals: pickerFront.metrics.pickerRefusals,
        picks: pickerFront.metrics.pickerPicks,
        attaches: pickerCore.metrics.attaches
      }
    }
    check(
      'O57',
      'the pick records an exclusive claim: a second claim on a claimed body is refused by name, and the picker stays open',
      claimHeld.length === 1 &&
        claimsWhileReading.length === 1 &&
        claimsWhileReading[0].name === 'Attach' &&
        claimsAfterPick.length === 1 &&
        claimsAfterPick[0].name === 'Attach' &&
        claimHeld[0].body === pickSlug(pickerServerName) &&
        claimHeld[0].server === pickerServerName &&
        claimHeld[0].name === 'Attach' &&
        claimGrants.length === 1 &&
        claimGrants[0].granted === true &&
        claimGrants[0].claimedBy === 'Attach' &&
        claimRefusals.length === 1 &&
        claimRefusals[0].reason === 'body_claimed' &&
        claimRefusals[0].claimedBy === 'Attach' &&
        /already claimed by Attach/.test(String(claimRefusals[0].text ?? '')) &&
        fourthRead.dialogs === 1 &&
        fourthRead.leftovers === 0 &&
        fourthPick !== null &&
        fourthPick.id === pickIdFor(pickerServerName) &&
        fourthClaim !== null &&
        fourthClaim.id === verbIdFor('claim', pickerServerName) &&
        pickerBot4.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect') &&
        pickerBot.received.ended === null &&
        pickerFront.claims.length === 1 &&
        pickerFront.metrics.pickerClaims === 1 &&
        pickerFront.metrics.pickers === 4 &&
        pickerCore.attached === false,
      evidence.picker.claim
    )

    // --- O58: the claim lands the client in the body it claimed (#258) ---
    // A fifth client claims the OTHER row: the one with a real 26.2 fake behind it.
    // The evidence that this is a landing and not a warm body's replay is fourfold.
    // The fake counts zero logins until the click, so nothing was dialled before a
    // claim (Q6). It counts one after, and the leg's target is that body's port
    // rather than the configured backend the lane started with, so the claim chose
    // the body. The client's play login arrives on the socket it already held,
    // through the configuration phase the baseline opened. And the position it is
    // given is this body's own spawn, which no other body in this run sends.
    //
    // What it cannot prove: that a vanilla 26.2 client accepts a second registry
    // round inside one configuration phase. The body is a minecraft-protocol fake
    // whose configuration is the library's own, and prismarine-chunk has no 26.2
    // implementation, so this body sends a chunk batch with nothing in it. The
    // landing's terrain and the client's acceptance are rung 4's and #268's.
    const pickerBodyLoginsBeforeLanding = pickerBodyFake.received.logins
    pickerBot5 = createBot({ port: pickerBound.port, username: 'Pilot', version: pickerVersion })
    await pickerBot5.waitFor(
      () => pickerBot5.received.dialogs.length === 1,
      'the picker at the client that will claim a body it can reach',
      15_000
    )
    // The row that names the reachable body: the label carries its address.
    const landingPick = chooseDialogAction(pickerBot5.received.dialogs[0], pickerBodyName)
    if (landingPick !== null) pickerBot5.answerDialog(landingPick.id, null, 'configuration')
    await pickerBot5.waitFor(
      () => pickerBot5.received.dialogs.length === 2,
      "the claimed body's own dialog at the fifth client",
      15_000
    )
    const landingClaim = chooseDialogAction(pickerBot5.received.dialogs[1], 'claim')
    if (landingClaim !== null) pickerBot5.answerDialog(landingClaim.id, null, 'configuration')
    // The play login is the body's, and it is the frame that says the client was
    // put into it. Waiting on the fake's count as well ties the client's arrival to
    // the body it claimed instead of to the fact that some backend is warm.
    await pickerBot5.waitFor(
      () => pickerBot5.received.login !== null && pickerBot5.received.positions.length > 0,
      'the play login of the body the client claimed',
      30_000
    )
    await waitFor(
      () => pickerCore.attached === true && pickerFront.metrics.attaches === 1,
      'the core to attach the claiming client to its body',
      15_000
    )
    const landedPosition = pickerBot5.received.positions[pickerBot5.received.positions.length - 1] ?? null
    const landingConfiguration = pickerBot5.received.names
      .filter(frame => frame.state === 'configuration')
      .map(frame => frame.name)
    evidence.picker.landing = {
      body: pickerBodyName,
      claimedRow: pickerServerName,
      loginsBefore: pickerBodyLoginsBeforeLanding,
      bodyLogins: pickerBodyFake.received.logins,
      bodySpawn: pickerBodySpawn,
      dialTarget: pickerBackend.target,
      playLogin: pickerBot5.received.login === null
        ? null
        : { entityId: pickerBot5.received.login.entityId, worldNames: pickerBot5.received.login.worldNames ?? null },
      position: landedPosition === null ? null : { x: landedPosition.x, y: landedPosition.y, z: landedPosition.z },
      configuration: {
        frames: landingConfiguration.length,
        registries: landingConfiguration.filter(name => name === 'registry_data').length,
        finish: landingConfiguration.filter(name => name === 'finish_configuration').length
      },
      // Which path ran, as the client's own frames say it: the landing continued
      // the configuration phase the baseline opened, and no `start_configuration`
      // moved the client out of play and back. The other path (#268's) is the one
      // that would show that frame.
      path: {
        name: 'same_phase',
        startedConfiguration: pickerBot5.received.names
          .filter(frame => frame.name === 'start_configuration').length
      },
      pick: landingPick === null ? null : { id: landingPick.id, label: landingPick.label },
      chosen: landingClaim === null ? null : { id: landingClaim.id, label: landingClaim.label },
      claims: pickerFront.claims,
      claimedBody: pickerCore.claimedBody,
      session: pickerCore.session.state,
      ended: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 160),
      kick: pickerBot5.received.kick === null ? null : String(JSON.stringify(pickerBot5.received.kick)).slice(0, 160),
      leftovers: pickerBot5.received.leftovers.length,
      metrics: {
        pickers: pickerFront.metrics.pickers,
        landings: pickerFront.metrics.claimLandings,
        landed: pickerFront.metrics.claimLanded,
        restored: pickerFront.metrics.claimRestored,
        attaches: pickerFront.metrics.attaches,
        dials: pickerCore.metrics.claimDials,
        dialsFailed: pickerCore.metrics.claimDialsFailed,
        bodies: pickerCore.metrics.claimBodies
      }
    }
    check(
      'O58',
      'a claim lands the client in the body it named: the body is dialled only for that claim, and its play state arrives on the connection the client already held',
      landingPick !== null &&
        landingPick.id === pickIdFor(pickerBodyName) &&
        landingClaim !== null &&
        landingClaim.id === verbIdFor('claim', pickerBodyName) &&
        pickerBodyLoginsBeforeLanding === 0 &&
        pickerBodyFake.received.logins === 1 &&
        pickerBackend.target.port === pickerBodyFake.port &&
        pickerBot5.received.login !== null &&
        landedPosition !== null &&
        landedPosition.x === pickerBodySpawn.x &&
        landedPosition.y === pickerBodySpawn.y &&
        landedPosition.z === pickerBodySpawn.z &&
        evidence.picker.landing.configuration.finish === 1 &&
        pickerBot5.received.ended === null &&
        pickerBot5.received.kick === null &&
        pickerBot5.received.leftovers.length === 0 &&
        // The report says which path ran, and it is the same-phase one: one
        // finish and no reconfiguration round. #268 owns the other.
        evidence.picker.landing.path.name === 'same_phase' &&
        evidence.picker.landing.path.startedConfiguration === 0 &&
        pickerCore.claimedBody === pickSlug(pickerBodyName) &&
        pickerCore.session.state === 'attached' &&
        pickerCore.attached === true &&
        pickerFront.metrics.claimLanded === 1 &&
        pickerFront.metrics.claimRestored === 1 &&
        pickerFront.metrics.attaches === 1 &&
        pickerCore.metrics.claimDials === 2 &&
        pickerCore.metrics.claimDialsFailed === 1 &&
        pickerCore.metrics.claimBodies === 1 &&
        pickerFront.claims.length === 2 &&
        pickerBot.received.ended === null,
      evidence.picker.landing
    )

    // --- O59: a body owns its state cache, and one body's fault leaves the other intact (#260) ---
    // Two bodies of one account at once, with no client delivered to either:
    // per-channel delivery is #269, and one session per body is #261. This asserts
    // the cache's ownership, on real frames over real sockets. Two offline backend
    // legs hold the account, one per body. Each writes into its own body's cache
    // through the product's registry. Then one body's session ends. The other body's
    // cache must be the one it already had, byte for byte, and must still take
    // frames.
    const bodyCaches = createBodyCaches({ bounds: { maxBlocks: 8 } })
    bodyFakeA = await createFakeBackend({
      port: 0,
      version: VERSION,
      spawn: { x: 2.5, y: 70, z: 4.5 },
      chunks: 'empty',
      logStream: null
    })
    bodyFakeB = await createFakeBackend({
      port: 0,
      version: VERSION,
      spawn: { x: -6.5, y: 64, z: 8.5 },
      chunks: 'empty',
      logStream: null
    })
    const bodyNameA = '127.0.0.1:' + bodyFakeA.port
    const bodyNameB = '127.0.0.1:' + bodyFakeB.port
    const bodyA = pickSlug(bodyNameA)
    const bodyB = pickSlug(bodyNameB)
    const bodyFrames = { [bodyA]: 0, [bodyB]: 0 }
    bodyLegA = createOfflineBackendLeg({
      host: '127.0.0.1', port: bodyFakeA.port, version: VERSION, username: 'GlowSquidye', log
    })
    bodyLegB = createOfflineBackendLeg({
      host: '127.0.0.1', port: bodyFakeB.port, version: VERSION, username: 'GlowSquidye', log
    })
    for (const [body, leg] of [[bodyA, bodyLegA], [bodyB, bodyLegB]]) {
      // This is the wiring the composition root does for its one leg. The body's
      // cache is where that body's frames go. The body decides that, not whichever
      // reader happens to be looking.
      leg.setFrameHandler(frame => {
        bodyFrames[body]++
        bodyCaches.cacheFor(body).push(frame.state, frame.name, frame.buffer, frame.data)
      })
    }
    await Promise.all([bodyLegA.connect(), bodyLegB.connect()])
    await waitFor(
      () => bodyCaches.cacheFor(bodyA).warm && bodyCaches.cacheFor(bodyB).warm,
      'two bodies warm at once, one cache each',
      20_000
    )
    const cacheA = bodyCaches.cacheFor(bodyA)
    const cacheB = bodyCaches.cacheFor(bodyB)
    // One entity and one block each, and different ones: two caches cannot be one
    // cache by accident.
    bodyFakeA.sendSpawnEntity({ entityId: 21 })
    bodyFakeB.sendSpawnEntity({ entityId: 22 })
    bodyFakeA.sendBlockChange({ x: 1, y: 2, z: 3 })
    bodyFakeB.sendBlockChange({ x: 9, y: 8, z: 7 })
    await waitFor(
      () => cacheA.stats().sizes.entities === 1 && cacheB.stats().sizes.entities === 1 &&
        cacheA.stats().sizes.blocks === 1 && cacheB.stats().sizes.blocks === 1,
      "each body's own entity and block in its own cache",
      10_000
    )
    const snapshotA = cacheA.snapshot()
    const snapshotB = cacheB.snapshot()
    const replayA = replayFrames(snapshotA)
      .filter(frame => frame.name === 'spawn_entity')
      .map(frame => frame.data.entityId)
    const replayB = replayFrames(snapshotB)
      .filter(frame => frame.name === 'spawn_entity')
      .map(frame => frame.data.entityId)

    // The capture counter is the cache's own. A frame one body receives must not
    // advance the other's counter, or the entity/generic merge join-synth builds on
    // capture order would interleave two worlds.
    const seqBBefore = cacheB.snapshot().frameSeq
    bodyFakeA.sendBlockChange({ x: 4, y: 5, z: 6 })
    await waitFor(() => cacheA.stats().sizes.blocks === 2, 'the second block frame at the first body', 10_000)
    const seqBAfter = cacheB.snapshot().frameSeq

    // The fault. Body A's session ends. The composition root's rule is that the
    // cache of the body that ended is reset: reset, not discarded, and never
    // another body's.
    const bodyBBeforeFault = cacheB.snapshot()
    bodyLegA.end()
    await waitFor(() => bodyLegA.ended === true, "the first body's session to end", 10_000)
    cacheA.reset()
    const bodyBAfterFault = cacheB.snapshot()
    const bodyAAfterFault = cacheA.snapshot()
    // And the survivor is not merely unchanged: it still takes frames, in its own
    // domains, after the other body died.
    bodyFakeB.sendBlockChange({ x: 11, y: 12, z: 13 })
    await waitFor(
      () => cacheB.stats().sizes.blocks === 2,
      'the surviving body still taking frames after the other body ended',
      10_000
    )
    const bodyBAfterPush = cacheB.snapshot()

    // The product's own wiring, read on the picker core this run already landed a
    // claim on. The cache the client is served from is the claimed body's. Every
    // other body the core dialled kept a cache of its own, and the claim put no
    // frame into it. There are two of those here: the lane's configured backend,
    // which a picker lane never dials, and the row whose dial the kernel refused in
    // O56. Both were dialled and neither answered, so both caches are empty.
    const pickerBodies = pickerCore.bodies.stats()
    const pickerClaimed = pickerCore.claimedBody
    const pickerOther = pickerBodies.bodies
      .filter(body => body !== pickerClaimed)
      .map(body => {
        const other = pickerCore.bodies.get(body)
        return { body, warm: other.warm, prefix: other.snapshot().prefix.length }
      })
    const pickerLaneBody = pickSlug(pickerServerName)
    const pickerRefusedBody = pickerCore.bodies.get(pickerLaneBody)

    evidence.bodyCaches = {
      bodies: [bodyNameA, bodyNameB],
      logins: [bodyFakeA.received.logins, bodyFakeB.received.logins],
      distinctCaches: cacheA !== cacheB,
      sameBodySameCache: bodyCaches.cacheFor(bodyA) === cacheA && bodyCaches.cacheFor(bodyB) === cacheB,
      frames: { ...bodyFrames },
      first: {
        entities: snapshotA.entities.map(frame => frame.data.entityId),
        blocks: snapshotA.blocks.map(frame => frame.data.location),
        replayed: replayA,
        seq: snapshotA.frameSeq
      },
      second: {
        entities: snapshotB.entities.map(frame => frame.data.entityId),
        blocks: snapshotB.blocks.map(frame => frame.data.location),
        replayed: replayB,
        seq: snapshotB.frameSeq
      },
      seqIndependent: { before: seqBBefore, after: seqBAfter },
      fault: {
        ended: bodyLegA.ended,
        faulted: {
          warm: bodyAAfterFault.warm,
          prefix: bodyAAfterFault.prefix.length,
          entities: bodyAAfterFault.entities.length,
          blocks: bodyAAfterFault.blocks.length
        },
        survived: {
          warm: bodyBAfterFault.warm,
          // Deep equality through the wire shape: every entry keeps its buffer and
          // its sequence, so a byte that moved shows.
          unchanged: JSON.stringify(bodyBAfterFault) === JSON.stringify(bodyBBeforeFault),
          blocks: bodyBAfterFault.blocks.map(frame => frame.data.location),
          afterPush: bodyBAfterPush.blocks.map(frame => frame.data.location)
        }
      },
      core: {
        bodies: pickerBodies.bodies,
        count: pickerBodies.count,
        claimed: pickerClaimed,
        cacheIsClaimed: pickerCore.cache === pickerCore.bodies.cacheFor(pickerClaimed),
        refusedRow: pickerRefusedBody === null
          ? null
          : {
              warm: pickerRefusedBody.warm,
              prefix: pickerRefusedBody.snapshot().prefix.length
            },
        others: pickerOther
      }
    }
    check(
      'O59',
      "a body owns its state cache: two bodies of one account hold their own state at once, and one body's fault leaves the other body's cache and session intact",
      bodyFakeA.received.logins === 1 &&
        bodyFakeB.received.logins === 1 &&
        cacheA !== cacheB &&
        bodyCaches.cacheFor(bodyA) === cacheA &&
        bodyCaches.cacheFor(bodyB) === cacheB &&
        snapshotA.entities.length === 1 &&
        snapshotB.entities.length === 1 &&
        snapshotA.entities[0].data.entityId === 21 &&
        snapshotB.entities[0].data.entityId === 22 &&
        snapshotA.blocks.length === 1 &&
        snapshotB.blocks.length === 1 &&
        snapshotA.blocks[0].data.location.x === 1 &&
        snapshotB.blocks[0].data.location.x === 9 &&
        replayA.join(',') === '21' &&
        replayB.join(',') === '22' &&
        seqBBefore === seqBAfter &&
        bodyLegA.ended === true &&
        bodyAAfterFault.warm === false &&
        bodyAAfterFault.prefix.length === 0 &&
        bodyAAfterFault.entities.length === 0 &&
        bodyAAfterFault.blocks.length === 0 &&
        bodyBAfterFault.warm === true &&
        JSON.stringify(bodyBAfterFault) === JSON.stringify(bodyBBeforeFault) &&
        bodyBAfterPush.blocks.length === 2 &&
        bodyBAfterPush.blocks[1].data.location.x === 11 &&
        pickerClaimed === pickSlug(pickerBodyName) &&
        // The lane's configured body, the row O56 claimed and never reached, and
        // the body O58 landed: three caches, one per body, and only the landed one
        // holds state.
        pickerBodies.count === 3 &&
        pickerOther.length === 2 &&
        pickerOther.every(other => other.warm === false && other.prefix === 0) &&
        pickerRefusedBody !== null &&
        pickerRefusedBody.snapshot().config.length === 0 &&
        pickerCore.cache === pickerCore.bodies.cacheFor(pickerClaimed),
      evidence.bodyCaches
    )

  } catch (error) {
    runError = error
    exitCode = phase === 'setup' ? 2 : 1
    process.stderr.write(`loopback: ${phase} failed: ${String(error?.message ?? error)}\n`)
  } finally {
    stopping = true
    for (const bot of [attachBot2, attachBot1, bot9, bot8, bot7, bot6, bot5, bot4, bot3, bot2, bot1, stranger, capBot, capRefusedBot, deadlineBot, deadlineStranger, controlBot2, controlBot1, operatorBot, pickerBot, pickerBot2, pickerBot3, pickerBot4, pickerBot5]) {
      try { await bot?.close?.() } catch { /* best effort */ }
    }
    try { capSocket?.destroy?.() } catch { /* best effort */ }
    try { deadlineSocket?.destroy?.() } catch { /* best effort */ }
    try { await capFront?.close?.() } catch { /* best effort */ }
    try { await deadlineFront?.close?.() } catch { /* best effort */ }
    try { await attachFront?.close?.() } catch { /* best effort */ }
    try { await controlFront?.close?.() } catch { /* best effort */ }
    try { await controlBackend?.close?.() } catch { /* best effort */ }
    try { await controlBase?.close?.() } catch { /* best effort */ }
    try { await pickerFront?.close?.() } catch { /* best effort */ }
    try { await pickerBackend?.close?.() } catch { /* best effort */ }
    try { await pickerBodyFake?.close?.() } catch { /* best effort */ }
    try { bodyLegA?.end?.() } catch { /* best effort */ }
    try { bodyLegB?.end?.() } catch { /* best effort */ }
    try { await bodyFakeA?.close?.() } catch { /* best effort */ }
    try { await bodyFakeB?.close?.() } catch { /* best effort */ }
    try { await operatorFront?.close?.() } catch { /* best effort */ }
    try { await operatorBackend?.close?.() } catch { /* best effort */ }
    try { await operatorBase?.close?.() } catch { /* best effort */ }
    try { await operatorTargetFake?.close?.() } catch { /* best effort */ }
    try { await operatorProxy?.close?.() } catch { /* best effort */ }
    try { await attachBackend?.close?.() } catch { /* best effort */ }
    try { await attachBase?.close?.() } catch { /* best effort */ }
    try { await front?.close?.() } catch { /* best effort */ }
    try { await seamlessFront?.close?.() } catch { /* best effort */ }
    try { await commandsFront?.close?.() } catch { /* best effort */ }
    try { await commandsBackend?.close?.() } catch { /* best effort */ }
    try { await commandsBase?.close?.() } catch { /* best effort */ }
    try { await backend?.close?.() } catch { /* best effort */ }
    try { await seamlessBackend?.close?.() } catch { /* best effort */ }
    try { fake?.close?.() } catch { /* best effort */ }
    try { seamlessBase?.close?.() } catch { /* best effort */ }
    try { handshakeProxy?.close?.() } catch { /* best effort */ }
    try { fake2?.close?.() } catch { /* best effort */ }
    try { fakeCold?.close?.() } catch { /* best effort */ }
    try { coldProxy?.close?.() } catch { /* best effort */ }
    try { gatedFake?.close?.() } catch { /* best effort */ }
    try { gatedProxy?.close?.() } catch { /* best effort */ }
    // #217: the journal's own close, for a run that failed before O52 got to it.
    // A passing run's directory goes, so a loopback leaves no shards behind; a
    // failing run keeps it, because the report's `journal.dir` then names
    // evidence a human can open.
    try { journal?.close?.() } catch { /* best effort */ }
    if (!failed) {
      try { if (journalDir) fs.rmSync(journalDir, { recursive: true, force: true }) } catch { /* best effort */ }
      // The control directory holds the two files O53 edited. A passing run
      // leaves nothing behind; a failing one keeps them for the report.
      try { if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }

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

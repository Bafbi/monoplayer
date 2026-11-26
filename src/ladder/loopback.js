// The product offline loopback rung: real front/backend legs, the fake node
// backend, and a real 26.1 protocol bot. No auth, no .secrets, loopback only.
//
//   node src/ladder/loopback.js [--report <file>] [--verbose]
//
// Exit codes: 0 all assertions pass, 1 assertion/timeout failure, 2 setup
// failure. A check whose id LOOPBACK_ASSERTION_IDS does not hold, and a check
// that repeats an id, also exit 1: each throws where it is called. The report is
// written in finally, even on failure.
//
// Assertions are the contract (docs/testing-ladder.md). LOOPBACK_ASSERTION_IDS
// below declares every id, in the order this file runs them, and
// docs/testing-ladder.md documents each one. A FAIL is a real finding; do not
// weaken a check to get a green run.
//
// A check that needs a lane of its own builds one with createLoopbackLane
// (loopback-lane.js, #594) and adds it to `lanes`: the lane owns its client, its
// sockets and its timers, so the check adds no line to the teardown at the end of
// this file. O68 is the assertion that proves the lane does that.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFakeBackend, emptySlot, itemStack } from '../legs/fake-backend.js'
import { loadConfig } from '../service/monoplayer.js'
import { detail, flag, waitFor, withTimeout } from '../service/cli.js'
import { createOfflineBackendLeg } from '../legs/live-backend.js'
import { createBodyCaches } from '../core/body-caches.js'
import { replayFrames } from '../core/join-synth.js'
import { createOfflineFrontLeg } from '../legs/live-front.js'
import { createRig } from './rig.js'
import { createLoopbackLane } from './loopback-lane.js'
import { offlineUuid } from '../legs/offline-identity.js'
import { createWireChecker } from '../core/wire-check.js'
import { createJournal, readJournal, readManifests } from '../observability/journal.js'
import { REPLAY_DOMAINS } from '../core/replay-summary.js'
import { createBot } from './bot.js'
import { createControlDocument } from '../service/control.js'
import { createHandshakeProxy } from './handshake-proxy.js'
import { advancementComplete, applyAdvancementFrames } from './client-state.js'
import { PARITY_FRAME_NAMES, attachParity, parityReplayNames } from './state-parity.js'
import { baselineRegistryIds, readConfigurationBaseline } from '../legs/configuration-baseline.js'
import { chooseDialogAction } from '../core/dialog-codec.js'
import { pickIdFor, pickSlug, pickTarget, verbIdFor } from '../core/picker.js'
import { createPickerServerReader } from '../service/start-live.js'
import { FIRST_VIRTUAL_ENTITY_ID, MOVE_INTERVAL_MS } from '../core/virtual-players.js'
import minecraftData from 'minecraft-data'

const VERSION = '26.1'
// #635: the wait O69 takes before it moves the body. A virtual player's move is coalesced
// into one frame per MOVE_INTERVAL_MS on the core's own clock, which a rig binds to the wall
// clock, so the assertion waits one window plus a margin rather than racing a bound it cannot
// see. The margin is for the platform's timer, not for the product.
const MOVE_WINDOW_WAIT_MS = MOVE_INTERVAL_MS + 40
const DEFAULT_REPORT = '.reports/loopback-report.json'

// Every assertion this rung makes. This list is the declaration
// `test/ladder/loopback-contract.test.js` reads: a bullet in docs/testing-ladder.md
// with no id here fails the guard, and an id here that no check ran fails the run.
// A check() call that moves out of this file keeps its id here, because the guard
// reads the list and not the source (#593).
export const LOOPBACK_ASSERTION_IDS = Object.freeze([
  'R0', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9',
  'O36', 'O46', 'O27', 'O28', 'O10', 'O11', 'O29', 'O45', 'O12', 'O11b',
  'O13', 'O14', 'O67', 'O37', 'O30', 'O31', 'O47', 'O32', 'O15', 'O16',
  'O17', 'O18', 'O19', 'O20', 'O21', 'O22', 'O23', 'O24', 'O24b', 'O25',
  'O26', 'O38', 'O41', 'O41b', 'O39', 'O40', 'O33', 'O34', 'O42', 'O35',
  'O43', 'O44', 'O48', 'O49', 'O50', 'O51', 'O68', 'O69', 'O52', 'O53', 'O55', 'O55b',
  'O56', 'O56b', 'O56c', 'O57', 'O58', 'O59', 'O60', 'O60b', 'O61', 'O62', 'O70',
  'O63', 'O64', 'O65', 'O66'
])

// The ids this list declares that a run never ran. The guard reads the list and
// not the calls, so only the run can see a check that was deleted (#593).
export function declaredButNotRun (declared, ran) {
  const seen = new Set(ran)
  return declared.filter(id => !seen.has(id))
}

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
  // Every id the list declares, and every id a check ran, so the end of the run
  // can name the one that was declared and never ran (#593).
  const declaredIds = new Set(LOOPBACK_ASSERTION_IDS)
  const ranIds = []
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
  // reconstruct. Its core logs as `attachCore`, which is what `attach.events`
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
  // #312: the second client on the main rig's lane, which offers no picker, while
  // a driver holds it.
  let rivalBot = null
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
  // O68's journal, which belongs to that check and not to the run: O52 reads the
  // stream the main rig writes, and a lane writing into it would be the evidence
  // testifying for the thing under test.
  let laneJournalDir = null
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
  // #269: the client that watches the body O58's driver holds, the client that
  // asks to watch it through the picker's own verb, and the client that tries to
  // claim it while it is held.
  let pickerBot6 = null
  let pickerBot7 = null
  let pickerBot8 = null
  // #265: the picker's list rig. Its own directory, because the assertion edits the
  // live file mid-run, and the seed beside it is what answers when the live file
  // cannot.
  let pickerControlDir = null
  let pickerControl = null
  let pickerLiveFile = null
  let pickerSeedFile = null
  let pickerBot9 = null
  let pickerBot10 = null
  // #259: the client that clicks the picker's Spectate, the client that reads the
  // row a spectator is on, and the client that watches a body nobody drives.
  let pickerBot11 = null
  let pickerBot12 = null
  // #261: the client that claims the body O63 left standing, the client that ends
  // the body once that claim has gone, the client that reads the row it left, and
  // the client that claims that row back.
  let pickerBot13 = null
  let pickerBot15 = null
  let pickerBot16 = null
  let pickerBot17 = null
  // #261: the client that reads the row a body nobody claims leaves behind when
  // its backend faults, and claims it back.
  let pickerBot18 = null
  // #315: the client that joins a lane whose allowed-server list is empty.
  let pickerBot19 = null
  // #635: the client that lands on the driven body to look at the puppet.
  let pickerBot20 = null
  let pickerBot21 = null
  // #260: two bodies of one account at once, each with its own real backend leg,
  // for the cache-ownership assertion. Nothing is delivered to a client here.
  let bodyFakeA = null
  let bodyFakeB = null
  let bodyLegA = null
  let bodyLegB = null

  // Every lane a check builds, closed in the finally block before anything else.
  // One entry and one line here is what a conversion adds; the object a lane
  // opened leaves the 34-name list the longer this grows (#594).
  const lanes = []

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
    bodyCaches: null,
    channels: null
  }

  const log = (event, fields = {}) => {
    logs.push({ event, fields })
    if (verbose) process.stderr.write(`[log] ${event} ${detail(fields)}\n`)
  }

  // A rig's core lifecycle records arrive as one JSON line inside an entry
  // tagged with that rig's name. `rig.events(from)` reads them back, from the
  // stream of the rig it belongs to (#223): two rigs may share a tag, and none
  // reads another's lines.
  function check (id, name, ok, info = null) {
    // The list is the declaration, so a check cannot name an id it does not
    // hold: that is the half of the contract a reader of the list cannot see.
    if (!declaredIds.has(id)) {
      throw new Error(`assertion ${id} is not in LOOPBACK_ASSERTION_IDS: add it to the list, and document it`)
    }
    if (ranIds.includes(id)) {
      throw new Error(`assertion ${id} ran twice: the ids are one sequence, and each names one check`)
    }
    ranIds.push(id)
    const record = { id, name, ok: ok === true, detail: info }
    assertions.push(record)
    if (!record.ok) failed = true
    process.stdout.write(`${record.ok ? 'PASS' : 'FAIL'} ${id} ${name}${info === null ? '' : ` — ${detail(info)}`}\n`)
    return record.ok
  }

  try {
    // --- setup: the rig factory builds the fake, the legs, and the core ---
    // A second backend is the target of the followed transfers (O21-O24, the
    // detach path with the key off, and O33-O35, the kept connection).
    fake2 = await createFakeBackend({ port: 0, logStream: null })
    evidence.backend2Port = fake2.port
    // The nmp fake server predates intent 3. The proxy records the real
    // intent on the wire and rewrites it for the fake target; without this,
    // the loopback cannot catch the sky-2 "not by this method" failure.
    handshakeProxy = await createHandshakeProxy({ targetPort: fake2.port, log })
    evidence.handshakeProxyPort = handshakeProxy.port

    // #312: a third admitted name, so the rival of a driven body is refused by the
    // lane's shape rather than by the whitelist.
    const offlineWhitelist = [offlineUuid('Attach'), offlineUuid('Second'), offlineUuid('Rival')]
    const puppetUuid = offlineUuid('GlowSquidye')
    if (offlineWhitelist.includes(puppetUuid)) {
      throw new Error('the puppet offline UUID must not be whitelisted')
    }

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

    // Every successful attach records the cache as it stood when its replay was
    // built, so O27 below can check the N13 frame cut against the real client's
    // decode.
    const attachCuts = []
    // #21: the gate is answered before the dial resolves, because the fake
    // backend withholds finish_configuration until the accept arrives. It is read
    // at the step between the dial and the warm wait, which is where O32 wants it.
    let gateAtConnect = null
    // One backend.connect() per reconnect_due. The guard makes a loop
    // impossible even if two dues were ever emitted close together.
    let reconnecting = false
    const wire = createWireChecker({ version: VERSION })
    const main = await createRig({
      name: 'core',
      log,
      logs,
      // A cap the protocol library never sends by default (10), so O26 proves the
      // puppet replaced its own value instead of matching it by accident. And the
      // code of conduct on, so the puppet's first configuration phase carries a
      // gate that the protocol library answers itself, with nothing attached yet:
      // the no-client fallback (O32).
      fake: { viewDistance: 6, codeOfConduct: true },
      config: ({ base }) => loadConfig({
        version: VERSION,
        attachWhitelist: offlineWhitelist,
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: base.port },
        puppet: { username: 'GlowSquidye', uuid: puppetUuid },
        // O29 needs the speaking path. The default is read-only, and this rung is
        // the only place a real client-side frame meets the relay.
        chat: 'full',
        // The default is the kept connection (#22). O21-O24 pin the detach path,
        // which is still reachable and is what a kept connection restores to, so
        // this rung states it rather than inheriting it.
        transfer: { keepConnection: false }
      }),
      whitelist: offlineWhitelist,
      wire,
      front: { chat: 'full' },
      // The deployed lanes set this, and O30 proves it never reaches a play
      // dialog: the dialog waits for the human instead of being clicked (#20).
      backend: { dialogAction: 'last' },
      core: { journal },
      attach: ({ rig, player }) => {
        const attachSnapshot = rig.core.cache.snapshot()
        const attachPose = rig.core.session.currentPose
        const outcome = rig.core.attachPlayer({ ...player, includeConfig: false })
        if (outcome.attached) {
          attachCuts.push({ snapshot: { ...attachSnapshot, pose: attachPose }, replayFrames: outcome.frames ?? [] })
        }
        return outcome
      },
      reconnect: async ({ rig, delayMs, target } = {}) => {
        if (stopping || reconnecting) return
        reconnecting = true
        rig.core.session.backendConnecting({ initial: false })
        try {
          rig.backend.setTarget(target ?? { host: '127.0.0.1', port: rig.base.port }, {
            keepCookies: target !== undefined && target !== null,
            transfer: target !== undefined && target !== null
          })
          await rig.backend.connect()
          log('backendReconnect', {
            delayMs,
            target: target ? `${target.host}:${target.port}` : null,
            backendLogins: rig.core.session.backendLogins
          })
        } catch (error) {
          rig.core.session.fail()
          log('backendReconnectFailed', { delayMs, error: String(error?.message ?? error).slice(0, 300) })
        } finally {
          reconnecting = false
        }
      },
      onStep: ({ step, rig }) => {
        // The run phase starts at the dial, as it did when the dial was this
        // function's own line: a setup failure above it is exit 2, and anything
        // from here on is exit 1.
        if (step === 'connect') {
          phase = 'run'
          return
        }
        if (step !== 'ready') return
        gateAtConnect = {
          sends: rig.base.received.codeOfConductSends,
          accepts: rig.base.received.codeOfConductAccepts,
          logged: logs.some(entry => entry.event === 'codeOfConductAccepted'),
          heldLogged: logs.some(entry => entry.event === 'codeOfConductHeld'),
          queued: rig.core.pendingDialog.held,
          answeredByPuppet: rig.core.metrics.controlDialogsPuppetAnswered
        }
        evidence.gate = gateAtConnect
      }
    })
    fake = main.base
    front = main.front
    backend = main.backend
    core = main.core
    // The resolved document, read back from the core that runs it: every later
    // rig spreads this one and changes a key or two.
    const config = core.config
    evidence.backendPort = fake.port
    evidence.frontPort = main.port
    check('R0', 'readiness warm from chunk_batch_finished', main.readiness.warm === true, {
      warm: main.readiness.warm,
      configFrames: main.readiness.configFrames,
      prefixFrames: main.readiness.prefixFrames,
      elapsedMs: main.readiness.elapsedMs
    })
    if (!main.readiness.warm) throw new Error('readiness did not reach the warm marker')

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
    // No `chat` option on this rig's front: `createOfflineFrontLeg` does not
    // forward it (#100), so passing it would claim the front leg backstop runs
    // this mode. It does not, and `commands` relays clientbound as `read-only`
    // does anyway.
    //
    // One backend.connect() per reconnect_due, as the main rig does it, so a
    // backend that ends fails as a dial rather than as a bot wait that blames
    // the command.
    let commandsReconnecting = false
    const commands = await createRig({
      name: 'commandsCore',
      log,
      logs,
      config: loadConfig({ ...config, chat: 'commands' }),
      whitelist: offlineWhitelist,
      wire,
      backend: { dialogAction: 'last' },
      reconnect: async ({ rig, delayMs } = {}) => {
        if (stopping || commandsReconnecting) return
        commandsReconnecting = true
        rig.core.session.backendConnecting({ initial: false })
        try {
          await rig.backend.connect()
          log('commandsBackendReconnect', { delayMs, backendLogins: rig.core.session.backendLogins })
        } catch (error) {
          rig.core.session.fail()
          log('commandsBackendReconnectFailed', {
            delayMs,
            error: String(error?.message ?? error).slice(0, 300)
          })
        } finally {
          commandsReconnecting = false
        }
      }
    })
    commandsBase = commands.base
    commandsFront = commands.front
    commandsBackend = commands.backend
    commandsCore = commands.core
    if (!commands.readiness.warm) throw new Error('the commands-mode rig did not warm')
    bot9 = createBot({
      port: commands.port,
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
    // client drives this lane, and its session is what answers a second one now
    // (#269). Detach first so the next check exercises
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

    // --- O67: a second client on a lane with no picker reads no configuration (#312) ---
    // #269 deleted the front leg's attach slot, and that slot was also what refused a
    // second connection at beforeLogin. Without it the rival's login passed, and the
    // body's cached configuration frames were replayed to it. Only then did the session
    // answer `already_attached` at its attach. That is a kick read after a phase the
    // client should never have been shown. This lane offers no picker, so there is no
    // claim for the rival to make and no dialog to send it to. Its login is the door,
    // and the refusal lands there, before Login Success and before every configuration
    // frame.
    //
    // The rival is on the whitelist on purpose: what refuses it must be the lane's shape
    // and not the identity gate, which O11b already proves on its own.
    const rivalMark = logs.length
    const attachesBeforeRival = core.metrics.attaches
    const attachCountBeforeRival = core.session.attachCount
    const deniedBeforeRival = front.metrics.denied
    rivalBot = createBot({ port: evidence.frontPort, username: 'Rival' })
    await withTimeout(rivalBot.ended, 10_000, 'the rival ended')
    const rivalConfiguration = rivalBot.received.byState.configuration ?? []
    // The sentence the rival was actually given, off the disconnect frame it received
    // rather than off a log line: a wrong write would still log the right words.
    const rivalTold = rivalBot.received.disconnects.map(told => ({
      state: told.state,
      reason: JSON.stringify(told.packet?.reason ?? null)
    }))
    const rivalCoreDenials = core.logs()
      .filter(line => line.includes('"reason":"already_driven"'))
      .map(line => JSON.parse(line))
    const rivalFrontDenials = logs
      .slice(rivalMark)
      .filter(entry => entry.event === 'attachDenied' && entry.fields?.reason === 'already_driven')
      .map(entry => entry.fields)
    evidence.secondJoin = {
      attaches: core.metrics.attaches - attachesBeforeRival,
      attachCount: core.session.attachCount - attachCountBeforeRival,
      success: rivalBot.received.success !== null,
      configurationFrames: rivalConfiguration.length,
      told: rivalTold,
      ended: rivalBot.received.ended === null ? null : String(rivalBot.received.ended).slice(0, 160),
      denials: front.metrics.denied - deniedBeforeRival,
      coreDenials: rivalCoreDenials,
      frontDenials: rivalFrontDenials,
      driverStillAttached: core.attached === true && b2.ended === null
    }
    check(
      'O67',
      'a second client on a lane with no picker is refused at its login in words, before any configuration frame',
      // Refused before Login Success, so the configuration phase never opens.
      rivalBot.received.success === null &&
        rivalConfiguration.length === 0 &&
        rivalTold.length === 1 &&
        rivalTold[0].state === 'login' &&
        /another player is already driving this server/.test(rivalTold[0].reason) &&
        rivalBot.received.ended !== null &&
        // The session was never asked: one driver, one attach record, no kick from
        // `already_attached` after a replay.
        evidence.secondJoin.attaches === 0 &&
        evidence.secondJoin.attachCount === 0 &&
        evidence.secondJoin.denials === 1 &&
        // The refusal names its reason and the lane shape that produced it.
        rivalCoreDenials.length === 1 &&
        rivalCoreDenials[0].lane === 'no_picker' &&
        /another player is already driving this server/.test(String(rivalCoreDenials[0].text ?? '')) &&
        rivalFrontDenials.length === 1 &&
        rivalFrontDenials[0].text === 'Monoplayer: another player is already driving this server. Try again when they leave.' &&
        // The driver keeps the body: a refusal for the rival is nothing for them.
        evidence.secondJoin.driverStillAttached === true,
      evidence.secondJoin
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

    await waitFor(() => front.channels.length === 0, 'the front\'s channels cleared after the kick')
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
    let seamlessReconnecting = false
    const seamless = await createRig({
      name: 'seamlessCore',
      log,
      logs,
      config: loadConfig({
        ...config,
        transfer: { ...config.transfer, keepConnection: true }
      }),
      whitelist: offlineWhitelist,
      wire,
      front: { chat: 'full' },
      backend: { dialogAction: 'last' },
      reconnect: async ({ rig, delayMs, target: dueTarget } = {}) => {
        if (stopping || seamlessReconnecting) return
        seamlessReconnecting = true
        rig.core.session.backendConnecting({ initial: false })
        try {
          rig.backend.setTarget(dueTarget ?? { host: '127.0.0.1', port: rig.base.port }, {
            keepCookies: dueTarget !== undefined && dueTarget !== null,
            transfer: dueTarget !== undefined && dueTarget !== null
          })
          await rig.backend.connect()
        } catch (error) {
          log('seamlessBackendReconnectFailed', {
            error: String(error?.message ?? error).slice(0, 300),
            state: rig.core.session.state
          })
          // #87: a dial the target refused is not the target dying. The move is
          // still in flight; the rung records that, then decides whether to
          // retry (the rig has one dial per reconnect) or to spend the follow
          // budget on it, which is what start-live does after its failures.
          dialFailureState = {
            moveKind: rig.core.moveKind,
            state: rig.core.session.state,
            clientReconfiguring: rig.core.clientReconfiguring,
            restored: rig.core.metrics.reconfigurationsRestored
          }
          if (giveUpOnFailedDial) {
            giveUpOnFailedDial = false
            rig.core.abortTransfer('target_unreachable')
            rig.backend.setTarget({ host: '127.0.0.1', port: rig.base.port }, { keepCookies: false })
            return
          }
          rig.core.session.fail()
        } finally {
          seamlessReconnecting = false
        }
      }
    })
    seamlessBase = seamless.base
    seamlessFront = seamless.front
    seamlessBackend = seamless.backend
    seamlessCore = seamless.core
    if (!seamless.readiness.warm) throw new Error('the kept-connection rig did not warm')
    // #73: the library accepts the code of conduct on its own; O43 needs a
    // client that leaves the gate to the puppet, so this one does not answer.
    bot5 = createBot({
      port: seamless.port,
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
    const coldCoreEvents = seamless.events(coldLogMark)
    await settleUntil(
      () => seamless.events(coldLogMark).some(entry => entry.event === 'reconfigurationWaitingWorld'),
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
    const seamlessLeftoverMark = b5.leftovers.length
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
    const errorClient = seamlessFront.driver
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
        // Every round this connection went through counts, not only this hop: a
        // client whose decoder is one frame out of step stays out of step, so a
        // leftover anywhere on the connection is a frame it could not parse.
        // #541: `leftoversBeforeHop` below says which round it came from.
        b5.leftovers.length === 0 &&
        b5.errors.length === 0,
      {
        entityId: b5.login?.entityId ?? null,
        attaches: seamlessCore.metrics.attaches,
        blocks: b5.blockChanges.map(change => change.location),
        leftovers: b5.leftovers.length,
        // #541: a count alone cannot be read. The frames say what the client
        // could not parse, and the mark says whether they arrived on this hop or
        // on an earlier round the same connection went through.
        leftoverDetails: b5.leftovers.slice(),
        leftoversBeforeHop: seamlessLeftoverMark,
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
      port: seamless.port,
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
    bot7 = createBot({ port: seamless.port, username: 'Attach' })
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
    bot8 = createBot({ port: seamless.port, username: 'Second' })
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
    const attach = await createRig({
      name: 'attachCore',
      log,
      logs,
      config: ({ base }) => loadConfig({
        ...config,
        backend: { ...config.backend, port: base.port }
      }),
      whitelist: offlineWhitelist,
      wire,
      backend: { dialogAction: 'last' }
    })
    attachBase = attach.base
    attachFront = attach.front
    attachBackend = attach.backend
    attachCore = attach.core
    if (!attach.readiness.warm) throw new Error('the attach-record rig did not warm')
    const attachPort = attach.port

    // One body, and no metadata for it, so the ordinary attach's stream is a
    // spawn and nothing else. That is the shape a healthy attach has.
    attachBase.sendSpawnEntity({ entityId: 99, x: 0, y: 64, z: 0 })
    await waitFor(() => attachCore.cache.snapshot().entities.some(entry =>
      entry.name === 'spawn_entity' && entry.data?.entityId === 99), 'the rig body in the cache')

    // The attach records the core wrote, oldest first. Reading the core's own
    // log line is the point: the record under test is the one the product
    // emitted, not a value this rig rebuilt from the same snapshot.
    const attachRecords = from => attach.events(from).filter(entry => entry.event === 'attach')

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
    let entityRig = null
    let entityFake = null
    let entityBackend = null
    let entityFront = null
    let entityCore = null
    let entityBot = null
    try {
      const entityWhitelist = [offlineUuid('Attach')]
      const entityAttaches = []
      entityRig = await createRig({
        name: 'core',
        log,
        logs,
          config: ({ base }) => loadConfig({
          version: VERSION,
          attachWhitelist: entityWhitelist,
          front: { host: '127.0.0.1', port: 0 },
          backend: { host: '127.0.0.1', port: base.port },
          puppet: { username: 'GlowSquidye', uuid: offlineUuid('GlowSquidye') },
          bounds: { maxEntities: 4 }
        }),
        whitelist: entityWhitelist,
        wire: createWireChecker({ version: VERSION }),
        attach: ({ rig, player }) => {
          const outcome = rig.core.attachPlayer({ ...player, includeConfig: false })
          if (outcome.attached) entityAttaches.push(outcome.frames ?? [])
          return outcome
        },
        // This rig listened before it dialled, and still does: the port is what
        // its one client needs, and no assertion here reads the warm marker.
        order: ['listen', 'connect', 'ready']
      })
      entityFake = entityRig.base
      entityFront = entityRig.front
      entityBackend = entityRig.backend
      entityCore = entityRig.core
      const entityPort = entityRig.port

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
      // The rig closes what the factory opened, in the factory's order.
      try { await entityRig?.close?.() } catch { /* best effort */ }
    }

    // --- O68: a lane closes every socket and timer it opened (#594) ---
    // The rig factory (#223) ends the three sockets it opened and leaves every
    // client and every timer to the rung, which is why one rig's teardown is four
    // lines in the finally block and the file's teardown is one line per object.
    // createLoopbackLane is that owner, and this check is its receipt: every part it
    // was handed did something observable, and one close left nothing behind. The
    // timers are the half an eye misses, because ending the backend leg is a backend
    // fault and a fault schedules a retry (src/core/session.js:232).
    //
    // The second close returns the same record and does nothing, because the rung's
    // finally block calls it unconditionally. The journal is this check's own, never
    // the run's: O52 reads the main rig's stream, and a second writer there would be
    // the evidence testifying for the thing under test.
    const laneWhitelist = [offlineUuid('Attach'), offlineUuid('Second')]
    laneJournalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-loopback-lane-'))
    const laneJournal = createJournal({
      dir: laneJournalDir,
      maxBytes: 4 * 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024
    })
    if (!laneJournal.enabled) {
      throw new Error('the lane journal did not open: ' + laneJournal.stats().disabledReason)
    }
    const lane = await createLoopbackLane({
      name: 'laneCore',
      log,
      logs,
      version: VERSION,
      fake: {},
      whitelist: laneWhitelist,
      wire: createWireChecker({ version: VERSION }),
      journal: laneJournal
    })
    lanes.push(lane)
    const laneBot = lane.bot({ username: 'Attach' })
    const laneReady = await withTimeout(
      laneBot.ready().then(() => true, () => false),
      20_000,
      'the lane client'
    ).catch(() => false)
    const laneAttached = lane.core.attached === true
    // The leg's counters, not the checker's: a lane built with no gate runs the
    // front's checks off, so a zero here is the gate missing rather than a run that
    // happened to inspect nothing.
    const laneWire = { ...lane.front.wireStats }
    const laneClosure = await lane.close()
    const laneAgain = await lane.close()
    // The seal is the writer's, as O52's is: a shard is only readable once it is
    // written, and the lane never closes a journal it was handed.
    laneJournal.close()
    const laneRecords = []
    for await (const entry of readJournal(laneJournalDir)) laneRecords.push(entry.record)
    const laneNames = laneRecords
      .filter(record => typeof record.name === 'string')
      .map(record => record.name)
    evidence.lane = {
      whitelist: laneWhitelist.length,
      port: lane.port,
      bodyPort: lane.base === null || lane.base === undefined ? null : lane.base.port,
      ready: laneReady,
      attached: laneAttached,
      frames: laneBot.playNames().slice(0, 6),
      wire: laneWire,
      journal: { dir: laneJournalDir, names: laneNames },
      closure: laneClosure,
      sameOnSecondClose: laneAgain === laneClosure,
      botEnded: laneBot.received.ended !== null
    }
    check(
      'O68',
      'a lane built by createLoopbackLane serves a client with the parts it was handed, then ends its client, its sockets and its armed timers on one close',
      laneReady === true &&
        laneAttached === true &&
        laneBot.received.ended !== null &&
        laneWire.checked >= 5 &&
        laneWire.rejected === 0 &&
        laneNames.includes('login') &&
        laneNames.includes('map_chunk') &&
        laneClosure.bots.length === 1 &&
        laneClosure.bots[0].username === 'Attach' &&
        laneClosure.bots[0].ended === true &&
        laneClosure.sockets.length === 2 &&
        laneClosure.sockets.every(entry => entry.code === 'ECONNREFUSED') &&
        laneClosure.timersDropped.length >= 1 &&
        laneClosure.timersLeft.length === 0 &&
        laneAgain === laneClosure,
      evidence.lane
    )

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
      whitelistFile: controlWhitelistFile,
      log
    })
    const control = await createRig({
      name: 'controlCore',
      log,
      logs,
      // A fresh document, not a spread of `config`: this rig's whitelist is the
      // file the operator edits, so the array the main rig runs on is not its
      // starting point.
      config: ({ base }) => loadConfig({
        version: VERSION,
        attachWhitelist: [],
        front: { host: '127.0.0.1', port: 0 },
        backend: { host: '127.0.0.1', port: base.port },
        puppet: { username: 'GlowSquidye', uuid: offlineUuid('GlowSquidye') }
      }),
      // The store, not an array: the file is what reloads at each login, and that
      // reload is what O53 proves.
      front: { whitelistStore: controlDocument.whitelistStore },
      wire: createWireChecker({ version: VERSION }),
      core: { whitelistSource: controlDocument.attachWhitelist }
    })
    controlBase = control.base
    controlFront = control.front
    controlBackend = control.backend
    controlCore = control.core
    if (!control.readiness.warm) throw new Error('the control-document rig did not warm')
    const controlPort = control.port

    // The login the whitelist refuses. A real socket: it reaches both gates, and
    // neither holds this UUID because it is not in the file.
    const deniedMark = logs.length
    controlBot1 = createBot({ port: controlPort, username: 'Second' })
    await withTimeout(controlBot1.ended, 10_000, 'the refused login ended')
    const deniedEvents = control.events(deniedMark)
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
    const secondDenials = control.events(deniedMark)
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
    // #269: the sixth and seventh are the spectator and the rival claim.
    const pickerWhitelist = [
      offlineUuid('Attach'), offlineUuid('Second'), offlineUuid('Third'), offlineUuid('Fourth'), offlineUuid('Pilot'),
      offlineUuid('Watcher'), offlineUuid('Rival'), offlineUuid('Looker'),
      // #265: the two clients the list assertion joins with, one per edited list.
      offlineUuid('Seeded'), offlineUuid('Late'),
      // #259: the client that reads the watched row, and the client that watches a
      // body nobody drives.
      offlineUuid('Reader'), offlineUuid('LateWatch'),
      // #261: the client that claims the standing body, the client that ends it once
      // that claim has gone, the client that reads the row it left, and the client
      // that claims that row back.
      offlineUuid('Owner'), offlineUuid('Dropper'), offlineUuid('After'), offlineUuid('Back'),
      // #261: the client that reads the row a faulted unclaimed body leaves, and
      // claims it back.
      offlineUuid('Fault'),
      // #315: the client that joins a lane offering nothing. The whitelist is checked
      // before the picker, so this client has to be known to reach the refusal.
      offlineUuid('Empty'),
      // #635: the client that lands to look at the puppet's body.
      offlineUuid('Sightline'),
      // #633: the client that lands beside a driver to read the mode frames both of
      // their sockets are told, and the one they are not.
      offlineUuid('Onlooker')
    ]
    // #265: the list the lane offers comes from the allowed-server key (#262). So
    // the rig writes the two files the lane reads: the live list the panel edits,
    // and the seed Git commits behind it. It offers them through the product's own
    // reader (src/service/start-live.js). What this rung proves is therefore the
    // offer the service makes, not a list the rig chose.
    pickerControlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoplayer-picker-'))
    pickerLiveFile = path.join(pickerControlDir, 'allowed-servers.json')
    pickerSeedFile = path.join(pickerControlDir, 'seed-allowed-servers.json')
    // A seed address nothing listens on, so this row can only have come from the
    // seed: the live file never names it.
    const pickerSeedName = '127.0.0.1:' + await freePort()
    const writeAllowedServers = (file, names) => fs.writeFileSync(file, JSON.stringify({
      version: 1,
      servers: names.map(name => ({
        host: name.slice(0, name.lastIndexOf(':')),
        port: Number(name.slice(name.lastIndexOf(':') + 1))
      }))
    }, null, 2) + '\n')
    writeAllowedServers(pickerSeedFile, [pickerSeedName])
    writeAllowedServers(pickerLiveFile, [pickerServerName, pickerBodyName])
    pickerControl = createControlDocument({
      allowedServersFile: pickerLiveFile,
      allowedServersSeedFile: pickerSeedFile,
      log
    })
    // The lane's configured backend, which nothing listens on: with no claim, the
    // service never dials, and this rig's whole property is a picker with no
    // session behind it (Q6). #258: the one dial this rig makes is the claim's,
    // and it goes to the row the frame named, never to this address.
    const pickerBackendPort = Number(pickerServerName.slice(pickerServerName.lastIndexOf(':') + 1))
    const picker = await createRig({
      name: 'pickerCore',
      log,
      logs,
      // No fake server, because this rig's property is a lane with no body behind
      // the dialog. The one dial it makes is the claim's, and it goes to the row
      // the frame named.
      fake: null,
      config: loadConfig({
        version: pickerVersion,
        // The one switch that lets a login with no backend through, and the reason
        // the front may serve a picker at all.
        picker: true,
        attachWhitelist: pickerWhitelist,
        front: { host: '127.0.0.1', port: 0 },
        // The lane's own body, which is a dead address like the leg's: this rig
        // has always named port 1 here (the leg exposes no `port`, so the old
        // `pickerBackend.port ?? 1` fell back every time), and O59 counts the
        // three bodies that leaves the registry holding (#260).
        backend: { host: '127.0.0.1', port: 1 },
        puppet: { username: 'GlowSquidye', uuid: puppetUuid }
      }),
      whitelist: pickerWhitelist,
      backend: { port: pickerBackendPort },
      // The two steps this rig does not take are the assertion: it never dials and
      // never warms, which is O55's no-body-behind-the-dialog.
      order: ['listen'],
      // The front's login decision is wired to the core, which is what makes it
      // hear `picker: true`. #592: the core registers the configuration-phase
      // call-ins on every lane, and the two this rig used to skip cannot fire
      // here. A picker join leaves beforeLogin at the `decision.picker` branch in
      // src/legs/live-front.js, before `coreAttachConfiguring` runs, and
      // `servePicker` opens no channel, so the client-information report drops it
      // at its `channel === null` guard. The core registered the configuring
      // handler unconditionally before this change, and that one is untouched.
      front: {
        // No cached backend configuration exists, and none is invented: the front's
        // cached replay path must find nothing here.
        configurationBaseline: pickerBaseline,
        pickerServers: createPickerServerReader({ control: pickerControl, log }),
        onPickerPick: pick => pickerPicks.push(pick),
        onPickerVerb: verb => pickerVerbs.push(verb),
        // Every check is recorded, not only the one that throws: O57 reads what
        // the lane last accepted.
        wireCheck: payload => {
          const outcome = pickerWire.check(payload)
          pickerWireChecks.push({ state: payload.state, name: payload.name, ok: outcome.ok === true })
          return outcome
        },
        wireMode: 'throw'
      }
    })
    pickerBackend = picker.backend
    pickerFront = picker.front
    pickerCore = picker.core
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
        registries: baselineRegistryIds(pickerBaseline).length,
        capturedAt: pickerBaseline.capturedFrom.at ?? null,
        lane: pickerBaseline.capturedFrom.lane ?? null,
        paperBuild: pickerBaseline.capturedFrom.paperBuild ?? null
      },
      frontPort: picker.port,
      server: pickerServerName
    }

    pickerBot = createBot({ port: picker.port, username: 'Attach', version: pickerVersion })
    await pickerBot.waitFor(() => pickerBot.received.dialogs.length === 1, 'the picker dialog at the client', 15_000)
    // A second client reads the picker at the same time: the picker is not an
    // attach, so it takes no slot and the first client does not hold one.
    pickerBot2 = createBot({ port: picker.port, username: 'Second', version: pickerVersion })
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
      'a join with no backend receives the recorded configuration baseline without its registry set, and the picker, and its pick is recorded',
      // #598: the recording carries 29 registries and a picker join reads none of
      // them. A client loads a Minecraft registry once, at the frame that ends the
      // phase, and the body a claim lands the client in continues this same phase,
      // so the recording's set would be the first of two.
      pickerRead.registries === 0 &&
        evidence.picker.baseline.registries > 0 &&
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
      'a second client reads the picker at the same time: a picker join holds no channel',
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

    // #266 and #261: the verb that acts on a body. A third client picks, then clicks
    // Disconnect on the row the first client's claim stands on — a claim whose landing
    // failed (#295), which is a claim all the same. So the request is refused in one
    // sentence naming the driver, and the client is disconnected with it rather than
    // left in a dialog nobody will read. O64 is the half where a body is unclaimed and
    // does end.
    pickerBot3 = createBot({ port: picker.port, username: 'Third', version: pickerVersion })
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
      'the refusal a claimed disconnect gets',
      15_000
    )
    await waitFor(() => pickerVerbs.length === 2, 'the disconnect verb to reach the service', 10_000)
    const disconnectRefusals = logs
      .filter(entry => entry.event === 'pickerDisconnectRefused')
      .map(entry => entry.fields)
    const disconnectLines = logs
      .filter(entry => entry.event === 'pickerDisconnect')
      .map(entry => entry.fields)
    evidence.picker.disconnect = {
      pick: thirdPick === null ? null : { id: thirdPick.id, label: thirdPick.label },
      chosen: thirdLeave === null ? null : { id: thirdLeave.id, label: thirdLeave.label },
      reported: pickerVerbs[1] ?? null,
      refusals: disconnectRefusals,
      granted: disconnectLines,
      ended: pickerBot3.received.ended === null ? null : String(pickerBot3.received.ended).slice(0, 120),
      claims: pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name })),
      metrics: {
        picks: pickerFront.metrics.pickerPicks,
        serverDialogs: pickerFront.metrics.pickerServerDialogs,
        verbs: pickerFront.metrics.pickerVerbs,
        pickers: pickerFront.metrics.pickers,
        disconnects: pickerFront.metrics.pickerDisconnects,
        refused: pickerFront.metrics.pickerDisconnectsRefused
      }
    }
    check(
      'O56c',
      'disconnect is refused while a claim holds the body, in one sentence naming the driver',
      thirdPick !== null &&
        thirdPick.id === pickIdFor(pickerServerName) &&
        thirdLeave !== null &&
        thirdLeave.id === verbIdFor('disconnect', pickerServerName) &&
        thirdLeave.label === 'Disconnect' &&
        pickerVerbs.length === 2 &&
        pickerVerbs[1].verb === 'disconnect' &&
        pickerVerbs[1].id === thirdLeave.id &&
        pickerVerbs[1].server?.name === pickerServerName &&
        pickerVerbs[1].claim === null &&
        // Refused, by name, and nothing ended: the claim stands and no body closed.
        disconnectRefusals.length === 1 &&
        disconnectRefusals[0].driver === 'Attach' &&
        /claimed by Attach/.test(String(disconnectRefusals[0].text ?? '')) &&
        disconnectLines.length === 0 &&
        pickerFront.metrics.pickerDisconnects === 0 &&
        pickerFront.metrics.pickerDisconnectsRefused === 1 &&
        pickerFront.claims.length === 1 &&
        pickerFront.claims[0].name === 'Attach' &&
        // The client that asked is answered rather than left in a dialog.
        pickerBot3.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect') &&
        pickerBot3.received.ended !== null &&
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
    // holds no channel. It picks the same body and clicks Claim. The refusal
    // names the player who holds it, and the claimant is untouched on its own
    // connection.
    //
    // #258: what this still does not prove is a landing. The body claimed here is
    // the row whose port answers nothing, so the claimant is back at the picker
    // holding a body that never came up, and the rival is refused by the claim and
    // not by a session. The landing is O58's.
    pickerBot4 = createBot({ port: picker.port, username: 'Fourth', version: pickerVersion })
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
    pickerBot5 = createBot({ port: picker.port, username: 'Pilot', version: pickerVersion })
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
    // frame into it. Two of those are here. One is the lane's configured backend,
    // which a picker lane never dials. The other is the row whose dial the kernel
    // refused in O56. Both were dialled and neither answered, so both are empty.
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
        // Three caches, one per body: the lane's configured body, the row O56
        // claimed and never reached, and the body O58 landed. Only the landed one
        // holds state.
        pickerBodies.count === 3 &&
        pickerOther.length === 2 &&
        pickerOther.every(other => other.warm === false && other.prefix === 0) &&
        pickerRefusedBody !== null &&
        pickerRefusedBody.snapshot().config.length === 0 &&
        pickerCore.cache === pickerCore.bodies.cacheFor(pickerClaimed),
      evidence.bodyCaches
    )

    // --- O60: a body serves a driver and a spectator, each with its own delivery (#269) ---
    // O58's driver is still connected and still holds the body. A sixth client reads
    // the same picker while that claim stands and picks the row the driver is on. The
    // rig then lands it as that body's spectator through the leg's own call, the one
    // #259 wires the Spectate verb to: this rung stands in for that row rather than
    // deciding it. Nothing is dialled: the body already has a session, and a spectator
    // watches that one. The client continues the configuration phase the baseline
    // opened with that body's own frames, and its play state arrives on the connection
    // it already held.
    //
    // What this proves that no earlier assertion could: two channels on one body. The
    // driver has been handed everything since it landed, and the spectator only since
    // it was landed, so their delivery records differ. Each client's own client
    // information stays on its own channel: the driver's reaches the puppet through
    // the serverbound rewrite, and the spectator's reaches nothing. What a spectator
    // is shown, who may spectate, and what the picker offers stay #259's: the verb is
    // still refused in words, and this assertion reads that refusal too.
    pickerBot6 = createBot({ port: picker.port, username: 'Watcher', version: pickerVersion })
    await pickerBot6.waitFor(
      () => pickerBot6.received.dialogs.length === 1,
      'the picker at the client that will watch the body',
      15_000
    )
    // A live-only frame before the spectator exists. The driver receives it and no
    // replay ever carries it, so a spectator's own delivery record can be told from
    // one that was copied from the driver's.
    pickerBodyFake.sendSystemChat('before the spectator')
    await pickerBot5.waitFor(
      () => pickerBot5.received.systemChat.length === 1,
      'the live-only frame at the driver, before any spectator',
      10_000
    )
    const watchPick = chooseDialogAction(pickerBot6.received.dialogs[0], pickerBodyName)
    if (watchPick !== null) pickerBot6.answerDialog(watchPick.id, null, 'configuration')
    await pickerBot6.waitFor(
      () => pickerBot6.received.dialogs.length === 2,
      "the claimed body's dialog at the spectator",
      15_000
    )
    const bodyLoginsBeforeWatch = pickerBodyFake.received.logins
    const backendSettingsBeforeWatch = pickerBodyFake.received.settings.length
    const poseBeforeWatch = pickerCore.session.currentPose
    // The seam, driven by the rig. The verb that will call it is #259's.
    const watchLanding = pickerFront.spectate({
      username: 'Watcher',
      body: pickSlug(pickerBodyName),
      server: pickerBodyName
    })
    await pickerBot6.waitFor(
      () => pickerBot6.received.login !== null && pickerBot6.received.positions.length > 0,
      'the play state of the body the spectator watches',
      30_000
    )
    await waitFor(() => (pickerFront.channels ?? []).length === 2, 'two channels on one body', 15_000)
    const watchConfiguration = pickerBot6.received.names
      .filter(frame => frame.state === 'configuration')
      .map(frame => frame.name)
    const watchPosition = pickerBot6.received.positions[pickerBot6.received.positions.length - 1] ?? null

    // The body's live stream reaches both channels: one frame the body sends after
    // the spectator landed.
    const liveBlock = { x: 3, y: 64, z: -3 }
    pickerBodyFake.sendBlockChange(liveBlock)
    pickerBodyFake.sendSystemChat('after the spectator')
    await pickerBot6.waitFor(
      () => pickerBot6.received.systemChat.length === 1,
      'the live-only frame the spectator was present for',
      10_000
    )
    await pickerBot5.waitFor(
      () => pickerBot5.received.systemChat.length === 2,
      'the second live-only frame at the driver',
      10_000
    )
    await pickerBot6.waitFor(
      () => pickerBot6.received.blockChanges.some(change => change.location?.x === liveBlock.x),
      'the live frame at the spectator',
      10_000
    )
    await pickerBot5.waitFor(
      () => pickerBot5.received.blockChanges.some(change => change.location?.x === liveBlock.x),
      'the live frame at the driver',
      10_000
    )

    // Each client's own client information. Both are sent in play, which is the one
    // state where a driver's change travels the serverbound rewrite and neither is
    // reported to the core by the front's settings hook.
    const spectatorSettings = { locale: 'fr_fr', viewDistance: 6, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1 }
    const pilotSettings = { locale: 'en_gb', viewDistance: 5, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1 }
    pickerBot6.client.write('settings', spectatorSettings)
    pickerBot5.client.write('settings', pilotSettings)
    await waitFor(
      () => {
        const channelsNow = pickerFront.channels ?? []
        const spectator = channelsNow.find(channel => channel.role === 'spectator')
        const pilot = channelsNow.find(channel => channel.role === 'driver')
        return spectator?.settings?.locale === 'fr_fr' && pilot?.settings?.locale === 'en_gb'
      },
      'each channel holding its own client information',
      10_000
    )
    await waitFor(
      () => pickerBodyFake.received.settings.length > backendSettingsBeforeWatch,
      "the driver's information at the puppet",
      10_000
    )
    // Read after the driver's own rewrite, which is a forward: what the spectator
    // sends must add nothing to it.
    const forwardedBeforeWatch = pickerCore.metrics.serverboundForwarded
    // A spectator's own input changes nothing: the front drops it before the core's
    // pipeline, so the body does not move and nothing is forwarded.
    pickerBot6.sendPosition({ x: 1.5, y: 2.5, z: 3.5 })
    await waitFor(
      () => pickerFront.metrics.spectatorFramesDropped >= 1,
      'the spectator frame the front refused',
      10_000
    )
    // The surface #269 does not decide, and #259 does: another client reaches the
    // driven body's own dialog and reads its Spectate button, and this assertion
    // stops there. O62 clicks it and proves what the click does, so the seam above
    // and the verb below stay two facts with two numbers.
    pickerBot8 = createBot({ port: picker.port, username: 'Looker', version: pickerVersion })
    await pickerBot8.waitFor(
      () => pickerBot8.received.dialogs.length === 1,
      'the picker at the client that will ask to spectate',
      15_000
    )
    const lookerPick = chooseDialogAction(pickerBot8.received.dialogs[0], pickerBodyName)
    if (lookerPick !== null) pickerBot8.answerDialog(lookerPick.id, null, 'configuration')
    await pickerBot8.waitFor(
      () => pickerBot8.received.dialogs.length === 2,
      "the driven body's dialog at the client that asks to spectate",
      15_000
    )
    const lookerVerb = chooseDialogAction(pickerBot8.received.dialogs[1], 'spectate')

    const channelsRead = pickerFront.channels ?? []
    const driverChannel = channelsRead.find(channel => channel.role === 'driver') ?? null
    const spectatorChannel = channelsRead.find(channel => channel.role === 'spectator') ?? null
    const backendSettings = pickerBodyFake.received.settings.slice(backendSettingsBeforeWatch)
    const poseAfterWatch = pickerCore.session.currentPose
    evidence.channels = {
      body: pickerBodyName,
      dialTarget: pickerBackend.target,
      bodyLogins: { before: bodyLoginsBeforeWatch, after: pickerBodyFake.received.logins },
      spectator: {
        pick: watchPick === null ? null : { id: watchPick.id, label: watchPick.label },
        landing: {
          watching: watchLanding.watching === true,
          reason: watchLanding.reason ?? null,
          frames: watchLanding.frames ?? null,
          channel: watchLanding.channel ?? null
        },
        // #259: the button is on screen and not clicked here. O62 clicks it.
        verb: {
          pick: lookerPick === null ? null : { id: lookerPick.id, label: lookerPick.label },
          offered: lookerVerb === null ? null : { id: lookerVerb.id, label: lookerVerb.label },
          ended: pickerBot8.received.ended === null ? null : String(pickerBot8.received.ended).slice(0, 160)
        },
        login: pickerBot6.received.login === null ? null : { entityId: pickerBot6.received.login.entityId },
        position: watchPosition === null ? null : { x: watchPosition.x, y: watchPosition.y, z: watchPosition.z },
        bodySpawn: pickerBodySpawn,
        configuration: {
          frames: watchConfiguration.length,
          registries: watchConfiguration.filter(name => name === 'registry_data').length,
          finish: watchConfiguration.filter(name => name === 'finish_configuration').length
        },
        blockChange: pickerBot6.received.blockChanges.some(change => change.location?.x === liveBlock.x),
        liveOnly: pickerBot6.received.systemChat.length,
        ended: pickerBot6.received.ended === null ? null : String(pickerBot6.received.ended).slice(0, 160),
        leftovers: pickerBot6.received.leftovers.length
      },
      driver: {
        entityId: pickerBot5.received.login === null ? null : pickerBot5.received.login.entityId,
        blockChange: pickerBot5.received.blockChanges.some(change => change.location?.x === liveBlock.x),
        liveOnly: pickerBot5.received.systemChat.length,
        ended: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 160)
      },
      channels: channelsRead.map(channel => ({
        id: channel.id,
        role: channel.role,
        name: channel.name,
        body: channel.body,
        delivered: channel.delivered,
        settings: channel.settings
      })),
      settings: {
        driver: driverChannel?.settings ?? null,
        spectator: spectatorChannel?.settings ?? null,
        backend: backendSettings.map(packet => ({ locale: packet.locale, viewDistance: packet.viewDistance }))
      },
      input: {
        forwardedBefore: forwardedBeforeWatch,
        forwardedAfter: pickerCore.metrics.serverboundForwarded,
        dropped: pickerFront.metrics.spectatorFramesDropped,
        poseBefore: poseBeforeWatch,
        poseAfter: poseAfterWatch
      },
      metrics: {
        pickers: pickerFront.metrics.pickers,
        spectatorJoins: pickerFront.metrics.spectatorJoins,
        views: pickerCore.metrics.spectatorViews,
        attaches: pickerFront.metrics.attaches,
        attachesCore: pickerCore.metrics.attaches,
        sessionAttachCount: pickerCore.session.attachCount,
        dials: pickerCore.metrics.claimDials
      }
    }
    check(
      'O60',
      'a body serves a driver and a spectator: two channels on one body, each with its own delivery state and its own client settings',
      watchPick !== null &&
        watchPick.id === pickIdFor(pickerBodyName) &&
        watchLanding.watching === true &&
        watchLanding.reason === null &&
        pickerBot6.received.login !== null &&
        pickerBot6.received.login.entityId === pickerBot5.received.login?.entityId &&
        watchPosition !== null &&
        watchPosition.x === pickerBodySpawn.x &&
        watchPosition.y === pickerBodySpawn.y &&
        watchPosition.z === pickerBodySpawn.z &&
        watchConfiguration.filter(name => name === 'finish_configuration').length === 1 &&
        pickerBot6.received.leftovers.length === 0 &&
        pickerBot6.received.ended === null &&
        pickerBot5.received.ended === null &&
        // No second session: a spectator watches the body that is already up.
        bodyLoginsBeforeWatch === 1 &&
        pickerBodyFake.received.logins === 1 &&
        channelsRead.length === 2 &&
        driverChannel !== null &&
        driverChannel.role === 'driver' &&
        driverChannel.name === 'Pilot' &&
        spectatorChannel !== null &&
        spectatorChannel.role === 'spectator' &&
        spectatorChannel.name === 'Watcher' &&
        driverChannel.body === pickSlug(pickerBodyName) &&
        spectatorChannel.body === pickSlug(pickerBodyName) &&
        // Each has been handed its body's replay once, and they have not been handed
        // the same number of frames: one landed at O58, the other at O60.
        driverChannel.delivered.replays === 1 &&
        spectatorChannel.delivered.replays === 1 &&
        // One live-only frame was sent before the spectator existed, so its record
        // cannot be the driver's: the driver received it and the spectator did not,
        // and no replay carries it. #259 gives a spectator's record two frames of its
        // own, so the difference between the two records is that chat and not a count.
        pickerBot5.received.systemChat.length === 2 &&
        pickerBot6.received.systemChat.length === 1 &&
        driverChannel.delivered.frames > 0 &&
        spectatorChannel.delivered.frames > 0 &&
        spectatorChannel.delivered.play > 0 &&
        driverChannel.delivered.last !== null &&
        driverChannel.delivered.last.name === 'system_chat' &&
        spectatorChannel.delivered.last !== null &&
        spectatorChannel.delivered.last.name === 'system_chat' &&
        // Its own settings, and only the driver's reach the puppet.
        driverChannel.settings?.locale === 'en_gb' &&
        spectatorChannel.settings?.locale === 'fr_fr' &&
        backendSettings.length === 1 &&
        backendSettings[0].locale === 'en_gb' &&
        // A spectator changes nothing.
        pickerCore.metrics.serverboundForwarded === forwardedBeforeWatch &&
        pickerFront.metrics.spectatorFramesDropped >= 1 &&
        JSON.stringify(poseAfterWatch) === JSON.stringify(poseBeforeWatch) &&
        pickerFront.metrics.spectatorJoins === 1 &&
        pickerCore.metrics.spectatorViews === 1 &&
        // The seam is the delivery. The verb that calls it is O62's, so the client
        // that holds the button is still in the picker and still connected.
        lookerVerb !== null &&
        lookerVerb.id === verbIdFor('spectate', pickerBodyName) &&
        pickerBot8.received.ended === null &&
        pickerCore.session.attachCount === 1 &&
        pickerCore.attached === true &&
        pickerCore.session.state === 'attached' &&
        pickerCore.metrics.claimDials === 2,
      evidence.channels
    )

    // --- O60b: a second claim on a driven body is refused by the claim (#269) ---
    // O57 refused a rival claim on a body nothing was delivered to. Here the body is
    // driven: O58's driver holds it and O60's spectator watches it. The rival reaches
    // the picker while the body is driven, which is the login route #269 changes: a
    // lane that serves a body still serves the picker, because the second client's
    // answer is a claim on that body and the claim is what refuses it. No attach slot
    // denies it first, and it never reaches the core's attach.
    pickerBot7 = createBot({ port: picker.port, username: 'Rival', version: pickerVersion })
    await pickerBot7.waitFor(
      () => pickerBot7.received.dialogs.length === 1,
      'the picker at the rival, while the body is driven',
      15_000
    )
    const rivalPick = chooseDialogAction(pickerBot7.received.dialogs[0], pickerBodyName)
    if (rivalPick !== null) pickerBot7.answerDialog(rivalPick.id, null, 'configuration')
    await pickerBot7.waitFor(
      () => pickerBot7.received.dialogs.length === 2,
      "the driven body's dialog at the rival",
      15_000
    )
    const rivalClaim = chooseDialogAction(pickerBot7.received.dialogs[1], 'claim')
    if (rivalClaim !== null) pickerBot7.answerDialog(rivalClaim.id, null, 'configuration')
    await pickerBot7.waitFor(
      () => pickerBot7.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the refusal a second claim on a driven body gets',
      15_000
    )
    const drivenRefusals = logs
      .filter(entry => entry.event === 'pickerClaimRefused')
      .map(entry => entry.fields)
    const slotDenials = logs.filter(entry =>
      entry.event === 'attachDenied' && entry.fields?.reason === 'already_attached')
    const channelsAfterRival = pickerFront.channels ?? []
    evidence.channels.rival = {
      pick: rivalPick === null ? null : { id: rivalPick.id, label: rivalPick.label },
      chosen: rivalClaim === null ? null : { id: rivalClaim.id, label: rivalClaim.label },
      refusals: drivenRefusals,
      slotDenials: slotDenials.length,
      // #312: this lane offers a picker, so its login entrance must stay open. The
      // rival read a login success and a configuration phase. A lane-shaped refusal in
      // the core's login decision would have denied it before both.
      loginSuccess: pickerBot7.received.success !== null,
      ended: pickerBot7.received.ended === null ? null : String(pickerBot7.received.ended).slice(0, 160),
      channels: channelsAfterRival.map(channel => ({ role: channel.role, name: channel.name })),
      driverEnded: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 160),
      spectatorEnded: pickerBot6.received.ended === null ? null : String(pickerBot6.received.ended).slice(0, 160),
      metrics: {
        pickers: pickerFront.metrics.pickers,
        claims: pickerFront.metrics.pickerClaims,
        refusals: pickerFront.metrics.pickerRefusals,
        attaches: pickerFront.metrics.attaches,
        sessionAttachCount: pickerCore.session.attachCount
      }
    }
    check(
      'O60b',
      'a second claim on a body a driver already holds is refused by the claim, not by an attach slot',
      rivalPick !== null &&
        rivalPick.id === pickIdFor(pickerBodyName) &&
        rivalClaim !== null &&
        rivalClaim.id === verbIdFor('claim', pickerBodyName) &&
        drivenRefusals.length === 2 &&
        drivenRefusals[1].reason === 'body_claimed' &&
        drivenRefusals[1].claimedBy === 'Pilot' &&
        /already claimed by Pilot/.test(String(drivenRefusals[1].text ?? '')) &&
        pickerBot7.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect') &&
        // The slot is gone: nothing denied this client before the claim did. #312's
        // refusal is the same fact from the other side: it fires only where there is
        // no picker to offer, so a picker lane's second client still logs in.
        slotDenials.length === 0 &&
        pickerBot7.received.success !== null &&
        pickerCore.session.attachCount === 1 &&
        pickerCore.attached === true &&
        pickerBot5.received.ended === null &&
        pickerBot6.received.ended === null &&
        channelsAfterRival.length === 2 &&
        channelsAfterRival.filter(channel => channel.role === 'driver').length === 1 &&
        // Two claims were granted in this run, and neither is the rival's: O56's on
        // the row that never answered, and O58's on the body it landed in.
        pickerFront.metrics.pickerClaims === 2 &&
        pickerFront.metrics.pickers === 8,
      evidence.channels.rival
    )

    // --- O61: the picker offers the allowed-server list, under the address each row dials (#265) ---
    // The offer has been the live list since O55, because the rig offers rows through
    // the product's own reader. Two facts are left to prove. The read happens at each
    // offer and says which file answered. And a row's name is the address a claim
    // dials, so one server is one body id. Then the two edits an operator makes. A
    // list that cannot be parsed falls back to the seed. A server removed while a body
    // runs on it stops being offered, with that body untouched.
    const offeredBefore = logs
      .filter(entry => entry.event === 'pickerOffered')
      .map(entry => entry.fields)
    // The body O58's driver holds, in the fields the edit must leave alone. Read
    // twice, once before the list is edited and once after.
    const drivenSnapshot = () => ({
      claimed: pickerCore.claimedBody,
      cache: pickerCore.cache,
      logins: pickerBodyFake.received.logins,
      dials: pickerCore.metrics.claimDials,
      claims: pickerFront.claims.map(claim => ({ body: claim.body, server: claim.server, name: claim.name })),
      channels: (pickerFront.channels ?? []).map(channel => ({ role: channel.role, name: channel.name, body: channel.body }))
    })
    const drivenBefore = drivenSnapshot()

    // A live file that cannot be parsed is named and ignored, and the seed answers.
    // The client is offered the seed's list: not an empty dialog, and not the backend
    // this lane is configured with.
    fs.writeFileSync(pickerLiveFile, '{"version":1,"servers":[{"host":\n')
    pickerBot9 = createBot({ port: picker.port, username: 'Seeded', version: pickerVersion })
    await pickerBot9.waitFor(
      () => pickerBot9.received.dialogs.length === 1,
      'the picker at a client while the live list cannot be parsed',
      15_000
    )
    const seededRead = readServerDialog(pickerBot9.received.dialogs[0])

    // The edit the panel makes: the row of a server a body is running on is removed.
    // It stops being offered, and the body is not touched.
    writeAllowedServers(pickerLiveFile, [pickerServerName])
    pickerBot10 = createBot({ port: picker.port, username: 'Late', version: pickerVersion })
    await pickerBot10.waitFor(
      () => pickerBot10.received.dialogs.length === 1,
      'the picker at a client after a server was removed from the list',
      15_000
    )
    const lateRead = readServerDialog(pickerBot10.received.dialogs[0])
    const drivenAfter = drivenSnapshot()
    const offeredLines = logs
      .filter(entry => entry.event === 'pickerOffered')
      .map(entry => entry.fields)
    const rejectedLists = logs
      .filter(entry => entry.event === 'controlRejected')
      .map(entry => entry.fields)
    // The key the per-body cache is made under: the address the row names, parsed
    // the way the claim parses it. A row whose name spelled its address differently
    // would record one body id here and key another cache there.
    const cacheKeyFor = name => {
      const target = pickTarget(name)
      return target === null ? null : pickSlug(target.host + ':' + target.port)
    }
    const drivenClaim = drivenAfter.claims.find(claim => claim.name === 'Pilot') ?? null
    evidence.picker.list = {
      files: { live: pickerLiveFile, seed: pickerSeedFile },
      offeredBefore,
      offered: offeredLines,
      rejected: rejectedLists,
      rows: {
        seeded: seededRead.buttons.map(button => ({ id: button.id, label: button.label })),
        seededTitle: seededRead.title,
        afterRemoval: lateRead.buttons.map(button => ({ id: button.id, label: button.label }))
      },
      driven: { before: drivenBefore, after: drivenAfter, cacheKey: drivenClaim === null ? null : cacheKeyFor(drivenClaim.server) },
      clients: {
        seeded: pickerBot9.received.ended === null ? null : String(pickerBot9.received.ended).slice(0, 120),
        late: pickerBot10.received.ended === null ? null : String(pickerBot10.received.ended).slice(0, 120),
        driver: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 120),
        spectator: pickerBot6.received.ended === null ? null : String(pickerBot6.received.ended).slice(0, 120),
        driverKick: pickerBot5.received.kick === null ? null : JSON.stringify(pickerBot5.received.kick).slice(0, 120)
      }
    }
    check(
      'O61',
      'the picker offers the allowed-server list at each offer, falls back to the seed it names, and a row is one body id',
      // The offer at O55 came from the live file, and the lane said so once. A join
      // reads the list more than once, and the operator reads one line.
      offeredBefore.length === 1 &&
        offeredBefore[0].source === 'control' &&
        offeredBefore[0].servers === 2 &&
        // A live file that cannot be parsed is named, and the seed answers.
        offeredLines.some(line => line.source === 'seed' && line.servers === 1) &&
        rejectedLists.some(fields => fields.file === pickerLiveFile && fields.reason === 'not_json') &&
        seededRead.buttons.length === 1 &&
        seededRead.buttons[0].id === pickIdFor(pickerSeedName) &&
        seededRead.buttons[0].label === pickerSeedName + ' - down' &&
        // A server removed from the list stops being offered, and the row that
        // remains is still the live file's.
        lateRead.buttons.length === 1 &&
        lateRead.buttons[0].id === pickIdFor(pickerServerName) &&
        offeredLines.at(-1).source === 'control' &&
        offeredLines.at(-1).servers === 1 &&
        // One server, one body id: the claim's body is the key the dial's cache is
        // made under, read through the address the row names.
        drivenClaim !== null &&
        drivenClaim.body === pickSlug(pickerBodyName) &&
        drivenClaim.server === pickerBodyName &&
        cacheKeyFor(drivenClaim.server) === drivenClaim.body &&
        drivenAfter.claimed === drivenClaim.body &&
        // Removing the row left the body alone: its claim, its cache, its channels,
        // its client and its one dial are the ones the edit found.
        drivenAfter.claimed === drivenBefore.claimed &&
        drivenAfter.cache === drivenBefore.cache &&
        drivenAfter.logins === drivenBefore.logins &&
        drivenAfter.logins === 1 &&
        drivenAfter.dials === drivenBefore.dials &&
        JSON.stringify(drivenAfter.claims) === JSON.stringify(drivenBefore.claims) &&
        JSON.stringify(drivenAfter.channels) === JSON.stringify(drivenBefore.channels) &&
        drivenAfter.channels.length === 2 &&
        drivenAfter.channels.filter(channel => channel.body === drivenClaim.body).length === 2 &&
        pickerBot5.received.ended === null &&
        pickerBot6.received.ended === null &&
        pickerBot5.received.kick === null &&
        // Neither list a client read was empty, so neither join was refused.
        pickerBot9.received.ended === null &&
        pickerBot10.received.ended === null &&
        pickerCore.attached === true,
      evidence.picker.list
    )

    // --- O62: the Spectate verb lands a client in a body it does not drive (#259) ---
    // O60 landed a spectator through `frontLeg.spectate`, the seam #269 built and left to
    // this row. This is the click that call was waiting for. Looker (pickerBot8) has been
    // in the picker with the driven body's dialog on screen since O60 and has never
    // answered it. O61 removed the driven row from the live list, so the operator adds it
    // back first, which is the edit the panel makes and the same key O61 read.
    //
    // What this proves that no earlier assertion could: the dialog a client is looking at
    // is enough to watch a body. No claim, no second login, no dial. The client is told
    // what it is by its own two frames. What a spectator sends reaches no backend, and
    // that is read at the backend rather than in the front's own counter.
    writeAllowedServers(pickerLiveFile, [pickerServerName, pickerBodyName])
    const toldFrames = { gameModes: [], abilities: [] }
    pickerBot8.client.on('game_state_change', packet => toldFrames.gameModes.push(packet))
    pickerBot8.client.on('abilities', packet => toldFrames.abilities.push(packet))
    const claimsBeforeWatch = pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name }))
    const forwardedBeforeVerb = pickerCore.metrics.serverboundForwarded
    // The fake backend's own counters as one record, read before the click and after
    // the spectator's input. One reader, so the two reads cannot drift apart.
    const backendReceived = () => ({
      logins: pickerBodyFake.received.logins,
      positions: pickerBodyFake.received.positions.length,
      chats: pickerBodyFake.received.chats.length,
      commands: pickerBodyFake.received.chatCommands.length,
      digs: pickerBodyFake.received.digs.length,
      places: pickerBodyFake.received.places.length,
      settings: pickerBodyFake.received.settings.length
    })
    const backendReceivedBefore = backendReceived()
    const watchDroppedBefore = pickerFront.metrics.spectatorFramesDropped
    if (lookerVerb !== null) pickerBot8.answerDialog(lookerVerb.id, null, 'configuration')
    await pickerBot8.waitFor(
      () => pickerBot8.received.login !== null && pickerBot8.received.positions.length > 0,
      'the play state of the body the Spectate click watches',
      30_000
    )
    await waitFor(
      () => (pickerFront.channels ?? []).length === 3,
      'the third channel: one driver and two spectators',
      15_000
    )
    const clickVerbs = logs
      .filter(entry => entry.event === 'pickerVerb' && entry.fields?.verb === 'spectate')
      .map(entry => entry.fields)
    const clickLandings = logs
      .filter(entry => entry.event === 'spectateLanded')
      .map(entry => entry.fields)
    const clickRefusals = logs
      .filter(entry => entry.event === 'spectateRefused')
      .map(entry => entry.fields)
    const lookerConfiguration = pickerBot8.received.names
      .filter(frame => frame.state === 'configuration')
      .map(frame => frame.name)
    const lookerPosition = pickerBot8.received.positions[pickerBot8.received.positions.length - 1] ?? null
    // The body's stream reaches the newest spectator: one frame the body sends after the
    // click.
    const clickedBlock = { x: 5, y: 64, z: -5 }
    pickerBodyFake.sendBlockChange(clickedBlock)
    await pickerBot8.waitFor(
      () => pickerBot8.received.blockChanges.some(change => change.location?.x === clickedBlock.x),
      'the live frame at the client that clicked Spectate',
      10_000
    )
    // #259: a body's own game mode and abilities belong to its driver. The fake body
    // switches mode, and the spectator must not be put back into the driver's mode by a
    // frame it was never meant to keep.
    const toldBeforeBodyMode = toldFrames.gameModes.length
    const withheldBefore = pickerFront.metrics.spectatorModeWithheld
    pickerBodyFake.sendGameModeChange({ gameMode: 1, flags: 0x09 })
    await pickerBot5.waitFor(
      () => pickerBot5.received.names.filter(frame => frame.state === 'play' && frame.name === 'abilities').length >= 1,
      "the body's own mode frame at the driver",
      10_000
    )
    await waitFor(
      () => pickerFront.metrics.spectatorModeWithheld >= withheldBefore + 2,
      "the body's mode frames the front refused to a spectator",
      10_000
    )
    const toldAfterBodyMode = toldFrames.gameModes.length
    // A spectator's input changes nothing, and the proof is the backend: movement, chat,
    // a command and a dig, then the fake's own counters.
    const spectatorInput = { x: 9.5, y: 10.5, z: 11.5 }
    pickerBot8.sendPosition(spectatorInput)
    pickerBot8.sendChat('a spectator cannot speak')
    pickerBot8.sendCommand('/gamemode creative')
    pickerBot8.sendDig({ x: 5, y: 64, z: -5 })
    await waitFor(
      () => pickerFront.metrics.spectatorFramesDropped >= watchDroppedBefore + 4,
      'the four frames the front refused from the spectator',
      10_000
    )
    // A drop writes nothing, so the wait is for the absence of a frame rather than for
    // one: the socket needs a moment to prove nothing is coming.
    await new Promise(resolve => setTimeout(resolve, 300))
    const backendReceivedAfter = backendReceived()
    // The row a player reads before choosing. A fresh client reads the list while the
    // body is driven and watched, so the label carries both facts.
    pickerBot11 = createBot({ port: picker.port, username: 'Reader', version: pickerVersion })
    await pickerBot11.waitFor(
      () => pickerBot11.received.dialogs.length === 1,
      'the picker at the client that reads the watched row',
      15_000
    )
    const watchedRowRead = readServerDialog(pickerBot11.received.dialogs[0])
    const watchedRowButton = watchedRowRead.buttons.find(button => button.id === pickIdFor(pickerBodyName)) ?? null
    // A body this lane does not serve is refused in the words that name the reason. The
    // other row names a port nothing listens on. The claim on it is still held by the
    // connection whose dial failed (#295), so the row reads `down` rather than
    // `claimed`: the state is the body's answer, and the driver is a fact about a
    // body that is up.
    const unservedPick = chooseDialogAction(pickerBot11.received.dialogs[0], pickerServerName)
    if (unservedPick !== null) pickerBot11.answerDialog(unservedPick.id, null, 'configuration')
    await pickerBot11.waitFor(
      () => pickerBot11.received.dialogs.length === 2,
      "the unserved body's own dialog at the reader",
      15_000
    )
    const unservedVerb = chooseDialogAction(pickerBot11.received.dialogs[1], 'spectate')
    const refusedMark = logs.length
    if (unservedVerb !== null) pickerBot11.answerDialog(unservedVerb.id, null, 'configuration')
    await pickerBot11.waitFor(
      () => pickerBot11.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the sentence a refused Spectate gets',
      15_000
    )
    // The frame is what the client reads; the socket end is the leg's follow-up and
    // arrives a moment later, so it is waited for rather than read on arrival. A
    // refusal that stayed connected would be a client left in a dialog.
    await settleUntil(() => pickerBot11.received.ended !== null, 5_000)
    const refusedSpectates = logs.slice(refusedMark)
      .filter(entry => entry.event === 'configurationEnded' && entry.fields?.reason === 'spectate_refused')
      .map(entry => entry.fields)
    const refusedText = logs.slice(refusedMark)
      .filter(entry => entry.event === 'spectateRefused' && entry.fields?.reason === 'body_not_served')
      .map(entry => entry.fields)
    // A spectator leaving ends a spectator and nothing else: the body, its driver and the
    // other spectator are as they were.
    await pickerBot8.close()
    await waitFor(
      () => (pickerFront.channels ?? []).length === 2,
      'the spectator channel gone and the other two still there',
      15_000
    )
    const channelsAfterLeaving = pickerFront.channels ?? []
    const claimsAfterWatch = pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name }))
    const unservedRow = watchedRowRead.buttons.find(button => button.id === pickIdFor(pickerServerName)) ?? null
    evidence.watch = {
      body: pickerBodyName,
      verb: {
        clicked: lookerVerb === null ? null : { id: lookerVerb.id, label: lookerVerb.label },
        reported: clickVerbs.map(entry => ({ verb: entry.verb, server: entry.server })),
        landings: clickLandings.map(entry => ({ body: entry.body, server: entry.server, frames: entry.frames })),
        refusals: clickRefusals.map(entry => ({ server: entry.server, reason: entry.reason }))
      },
      told: {
        gameModes: toldFrames.gameModes.map(packet => ({ reason: packet.reason, gameMode: packet.gameMode })),
        abilities: toldFrames.abilities.map(packet => ({ flags: packet.flags, flyingSpeed: packet.flyingSpeed, walkingSpeed: packet.walkingSpeed })),
        afterBodyMode: toldAfterBodyMode - toldBeforeBodyMode,
        withheld: pickerFront.metrics.spectatorModeWithheld - withheldBefore
      },
      world: {
        configuration: {
          frames: lookerConfiguration.length,
          registries: lookerConfiguration.filter(name => name === 'registry_data').length,
          finish: lookerConfiguration.filter(name => name === 'finish_configuration').length
        },
        position: lookerPosition === null ? null : { x: lookerPosition.x, y: lookerPosition.y, z: lookerPosition.z },
        bodySpawn: pickerBodySpawn,
        blockChange: pickerBot8.received.blockChanges.some(change => change.location?.x === clickedBlock.x),
        ended: pickerBot8.received.ended === null ? null : String(pickerBot8.received.ended).slice(0, 160),
        leftovers: pickerBot8.received.leftovers.length
      },
      input: {
        sent: spectatorInput,
        forwardedBefore: forwardedBeforeVerb,
        forwardedAfter: pickerCore.metrics.serverboundForwarded,
        dropped: pickerFront.metrics.spectatorFramesDropped - watchDroppedBefore,
        backend: { before: backendReceivedBefore, after: backendReceivedAfter }
      },
      row: {
        label: watchedRowButton === null ? null : watchedRowButton.label,
        buttons: watchedRowRead.buttons.map(button => button.label)
      },
      refused: {
        server: pickerServerName,
        row: unservedRow === null ? null : unservedRow.label,
        clicked: unservedVerb === null ? null : unservedVerb.id,
        ended: refusedSpectates,
        sentences: refusedText.map(fields => ({ reason: fields.reason, text: fields.text })),
        client: pickerBot11.received.ended === null ? null : String(pickerBot11.received.ended).slice(0, 160)
      },
      claims: { before: claimsBeforeWatch, after: claimsAfterWatch },
      channels: channelsAfterLeaving.map(channel => ({ role: channel.role, name: channel.name, body: channel.body })),
      driverEnded: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 120),
      otherSpectatorEnded: pickerBot6.received.ended === null ? null : String(pickerBot6.received.ended).slice(0, 120)
    }
    check(
      'O62',
      "the picker's Spectate verb lands a client in a body it does not drive, tells it so, and sends nothing on to the backend",
      lookerVerb !== null &&
        lookerVerb.id === verbIdFor('spectate', pickerBodyName) &&
        clickVerbs.length === 1 &&
        clickVerbs[0].server === pickerBodyName &&
        clickLandings.length === 2 &&
        clickLandings.at(-1).body === pickSlug(pickerBodyName) &&
        clickRefusals.length === 0 &&
        // The client is in the body's world, on the body's entity, and its phase ended
        // once. Nothing a spectator needs is missing and nothing was left on the wire.
        pickerBot8.received.login !== null &&
        pickerBot8.received.login.entityId === pickerBot5.received.login?.entityId &&
        lookerPosition !== null &&
        lookerPosition.x === pickerBodySpawn.x &&
        lookerPosition.y === pickerBodySpawn.y &&
        lookerPosition.z === pickerBodySpawn.z &&
        lookerConfiguration.filter(name => name === 'finish_configuration').length === 1 &&
        // One body's own registries, and only those (#598). The 29 the recording
        // carries are not served, so this is the body's set and not the baseline's
        // plus the body's: 28, because the fake body's configuration is the
        // library's 26.2 codec, one registry short of a Paper's.
        lookerConfiguration.filter(name => name === 'registry_data').length === 28 &&
        pickerBot8.received.leftovers.length === 0 &&
        pickerBot8.received.blockChanges.some(change => change.location?.x === clickedBlock.x) &&
        // Told what it is, last. The replay carries the body's own game mode first,
        // reason `level_chunks_load_start` and the mode the driver plays in. The frame
        // after it is the one that makes the client a spectator. Abilities go with it,
        // at the protocol's two speeds.
        toldFrames.gameModes.length === 2 &&
        toldFrames.gameModes[0].gameMode === 0 &&
        toldFrames.gameModes.at(-1).reason === 'change_game_mode' &&
        toldFrames.gameModes.at(-1).gameMode === 3 &&
        toldFrames.abilities.length >= 1 &&
        toldFrames.abilities.at(-1).flags === 7 &&
        Math.abs(toldFrames.abilities.at(-1).flyingSpeed - 0.05) < 1e-6 &&
        Math.abs(toldFrames.abilities.at(-1).walkingSpeed - 0.1) < 1e-6 &&
        // A later frame from the body reached the driver and not the spectator.
        pickerBot5.received.names.some(frame => frame.state === 'play' && frame.name === 'game_state_change') &&
        toldAfterBodyMode === toldBeforeBodyMode &&
        pickerFront.metrics.spectatorModeWithheld >= withheldBefore + 2 &&
        // Nothing it sends reaches the backend: the fake counts the frames it received,
        // and not one of them moved.
        pickerFront.metrics.spectatorFramesDropped >= watchDroppedBefore + 4 &&
        pickerCore.metrics.serverboundForwarded === forwardedBeforeVerb &&
        backendReceivedAfter.positions === backendReceivedBefore.positions &&
        backendReceivedAfter.chats === backendReceivedBefore.chats &&
        backendReceivedAfter.commands === backendReceivedBefore.commands &&
        backendReceivedAfter.digs === backendReceivedBefore.digs &&
        backendReceivedAfter.places === backendReceivedBefore.places &&
        backendReceivedAfter.settings === backendReceivedBefore.settings &&
        backendReceivedAfter.logins === backendReceivedBefore.logins &&
        // The row says what a chooser needs: who drives it, and that two are watching.
        watchedRowButton !== null &&
        watchedRowButton.label === pickerBodyName + ' - claimed (Pilot), 2 watching' &&
        // The row of a body this lane does not serve says so, whatever a claim on it
        // still says: a body nobody can enter is down.
        unservedRow !== null &&
        unservedRow.label === pickerServerName + ' - down' &&
        // The other row is refused in words naming what this lane serves.
        unservedVerb !== null &&
        refusedSpectates.length === 1 &&
        refusedText.length === 1 &&
        refusedText[0].reason === 'body_not_served' &&
        /not serving/.test(String(refusedText[0].text ?? '')) &&
        String(refusedText[0].text ?? '').includes(pickerServerName) &&
        pickerBot11.received.ended !== null &&
        // Watching never becomes a claim, and a spectator leaving ends nothing.
        JSON.stringify(claimsAfterWatch) === JSON.stringify(claimsBeforeWatch) &&
        !claimsAfterWatch.some(claim => claim.name === 'Looker') &&
        channelsAfterLeaving.length === 2 &&
        channelsAfterLeaving.filter(channel => channel.role === 'driver').length === 1 &&
        channelsAfterLeaving.filter(channel => channel.role === 'spectator').length === 1 &&
        pickerBot5.received.ended === null &&
        pickerBot6.received.ended === null &&
        pickerCore.claimedBody === pickSlug(pickerBodyName) &&
        pickerCore.session.state === 'attached' &&
        pickerBodyFake.received.logins === 1,
      evidence.watch
    )

    // --- O70: the mode frames go to the spectator's channel, never to the driver (#633) ---
    // O62 reads what a spectator's socket is told. This is the other side of that one write:
    // a lane that wrote the pair on every channel would put the driver's own client in
    // spectator mode, and a driver is a player in the world. The front withholds a body's
    // own mode frames from a spectator (`bodyFrameWithheld`), so a broadcast pair reaches
    // the driver alone: the positive and the negative are two halves of one claim, and
    // neither assertion can stand for the other.
    //
    // The driver is O62's, still in play on the body. A fresh client lands beside it through
    // the front's own spectate seam, which is the call the Spectate verb makes, and both
    // sockets register their own listeners before that landing, because the bot records
    // frame names and not these packets.
    const driverMode = { gameModes: [], abilities: [] }
    pickerBot5.client.on('game_state_change', packet => driverMode.gameModes.push(packet))
    pickerBot5.client.on('abilities', packet => driverMode.abilities.push(packet))
    pickerBot21 = createBot({ port: picker.port, username: 'Onlooker', version: pickerVersion })
    await pickerBot21.waitFor(
      () => pickerBot21.received.dialogs.length === 1,
      'the picker at the client that reads the mode frames',
      15_000
    )
    const onlookerMode = { gameModes: [], abilities: [] }
    pickerBot21.client.on('game_state_change', packet => onlookerMode.gameModes.push(packet))
    pickerBot21.client.on('abilities', packet => onlookerMode.abilities.push(packet))
    const onlookerLanding = pickerFront.spectate({
      username: 'Onlooker',
      body: pickSlug(pickerBodyName),
      server: pickerBodyName
    })
    await pickerBot21.waitFor(
      () => onlookerMode.gameModes.some(packet => packet.gameMode === 3) && onlookerMode.abilities.length >= 1,
      'the two frames that make a client a spectator, at the client that just became one',
      30_000
    )
    const onlookerEnded = pickerBot21.received.ended
    await pickerBot21.close()
    // The barrier, rather than a sleep: the landing's writes are all out by the time its
    // channel is gone, so a broadcast pair would have reached the driver by now.
    await waitFor(
      () => (pickerFront.channels ?? []).length === 2,
      "the driver and O62's other spectator, once the client that read the mode frames has gone",
      15_000
    )
    const onlookerModeFrames = onlookerMode.gameModes.filter(packet => packet.gameMode === 3)
    const driverToldSpectator = driverMode.gameModes.filter(packet => packet.gameMode === 3)
    evidence.spectatorMode = {
      landing: onlookerLanding,
      spectator: {
        gameModes: onlookerMode.gameModes.map(packet => ({ reason: packet.reason, gameMode: packet.gameMode })),
        abilities: onlookerMode.abilities.map(packet => ({ flags: packet.flags, flyingSpeed: packet.flyingSpeed, walkingSpeed: packet.walkingSpeed }))
      },
      driver: {
        gameModes: driverMode.gameModes.map(packet => ({ reason: packet.reason, gameMode: packet.gameMode })),
        abilities: driverMode.abilities.map(packet => ({ flags: packet.flags, flyingSpeed: packet.flyingSpeed, walkingSpeed: packet.walkingSpeed }))
      },
      driverEnded: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 120),
      onlookerEnded: onlookerEnded === null ? null : String(onlookerEnded).slice(0, 120)
    }
    check(
      'O70',
      "a spectator is put in spectator game mode on its own channel: the mode change and the abilities reach its client, and the driver's socket carries neither",
      onlookerLanding.watching === true &&
        // One mode change, and it is this client's: the body's own copy arrives from the
        // replay carrying the body's mode. O62 holds the values these two frames carry;
        // what this assertion reads is which socket they went to.
        onlookerModeFrames.length === 1 &&
        onlookerMode.abilities.length >= 1 &&
        // The driver's own client is a player in the world: nothing on its socket says it
        // is a spectator in this window, and the landing that told the spectator reached it
        // not at all.
        driverToldSpectator.length === 0 &&
        driverMode.abilities.length === 0 &&
        // Both clients kept their connections: the pair is a state change, not an end.
        onlookerEnded === null &&
        pickerBot5.received.ended === null,
      evidence.spectatorMode
    )

    // --- O63: a body nobody drives stays up, and is still watchable (#259) ---
    // The claim is held by the connection that made it, so the driver leaving releases
    // the body and nothing else. Its backend session, its warm state and its spectator
    // all stay. O62's click lands a client where a driver is. This is the other half of
    // the rule #259 had to decide: a body with no driver is watchable, and a spectator
    // is never a driver.
    //
    // The join reads the picker rather than taking the empty driver seat. Before #259 it
    // was attached as that body's driver down the pre-picker path, with no claim
    // recorded, and the picker offered anything only while no body stood.
    await pickerBot5.close()
    await waitFor(
      () => pickerCore.session.state === 'detached' && pickerCore.attached === false,
      'the body detached and still up after its driver left',
      20_000
    )
    const loginsAfterDriverLeft = pickerBodyFake.received.logins
    const attachesBeforeJoin = pickerFront.metrics.attaches
    const coreAttachesBeforeJoin = pickerCore.metrics.attaches
    pickerBot12 = createBot({ port: picker.port, username: 'LateWatch', version: pickerVersion })
    await pickerBot12.waitFor(
      () => pickerBot12.received.dialogs.length === 1,
      'the picker at the client that joins a body nobody drives',
      15_000
    )
    const detachedRowRead = readServerDialog(pickerBot12.received.dialogs[0])
    const detachedRowButton = detachedRowRead.buttons.find(button => button.id === pickIdFor(pickerBodyName)) ?? null
    // The join took no driver seat: the picker answered it, and the core attached nobody.
    const attachedAtJoin = pickerCore.attached
    const detachJoinPick = chooseDialogAction(pickerBot12.received.dialogs[0], pickerBodyName)
    if (detachJoinPick !== null) pickerBot12.answerDialog(detachJoinPick.id, null, 'configuration')
    await pickerBot12.waitFor(
      () => pickerBot12.received.dialogs.length === 2,
      "the undriven body's own dialog at the late spectator",
      15_000
    )
    const detachVerb = chooseDialogAction(pickerBot12.received.dialogs[1], 'spectate')
    const lateMark = logs.length
    if (detachVerb !== null) pickerBot12.answerDialog(detachVerb.id, null, 'configuration')
    await pickerBot12.waitFor(
      () => pickerBot12.received.login !== null && pickerBot12.received.positions.length > 0,
      'the play state of the body nobody drives',
      30_000
    )
    await waitFor(
      () => (pickerFront.channels ?? []).length === 2,
      'two spectators and no driver on the body',
      15_000
    )
    const lateLandings = logs.slice(lateMark)
      .filter(entry => entry.event === 'spectateLanded')
      .map(entry => entry.fields)
    const lateRefusals = logs.slice(lateMark)
      .filter(entry => entry.event === 'spectateRefused')
      .map(entry => entry.fields)
    // The world of a body nobody drives still moves: one frame after the landing.
    const lateBlock = { x: 6, y: 64, z: -6 }
    pickerBodyFake.sendBlockChange(lateBlock)
    await pickerBot12.waitFor(
      () => pickerBot12.received.blockChanges.some(change => change.location?.x === lateBlock.x),
      'the live frame at the spectator of an undriven body',
      10_000
    )
    const latePosition = pickerBot12.received.positions[pickerBot12.received.positions.length - 1] ?? null
    const channelsUndriven = pickerFront.channels ?? []
    const claimsUndriven = pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name }))
    evidence.undriven = {
      body: pickerBodyName,
      driverLeft: pickerBot5.received.ended === null ? null : String(pickerBot5.received.ended).slice(0, 120),
      state: pickerCore.session.state,
      claimed: pickerCore.claimedBody,
      logins: { afterDriverLeft: loginsAfterDriverLeft, afterWatch: pickerBodyFake.received.logins },
      join: {
        attached: attachedAtJoin,
        attaches: { front: pickerFront.metrics.attaches - attachesBeforeJoin, core: pickerCore.metrics.attaches - coreAttachesBeforeJoin },
        label: detachedRowButton === null ? null : detachedRowButton.label,
        buttons: detachedRowRead.buttons.map(button => button.label)
      },
      verb: {
        clicked: detachVerb === null ? null : detachVerb.id,
        landings: lateLandings.map(entry => ({ body: entry.body, frames: entry.frames })),
        refusals: lateRefusals.map(entry => ({ reason: entry.reason }))
      },
      world: {
        position: latePosition === null ? null : { x: latePosition.x, y: latePosition.y, z: latePosition.z },
        blockChange: pickerBot12.received.blockChanges.some(change => change.location?.x === lateBlock.x),
        ended: pickerBot12.received.ended === null ? null : String(pickerBot12.received.ended).slice(0, 160)
      },
      claims: claimsUndriven,
      channels: channelsUndriven.map(channel => ({ role: channel.role, name: channel.name, body: channel.body })),
      // What the front holds now, which is what the picker's label counts. `views`
      // is the run's own total, which only grows, so it is reported beside it and read
      // as a count of landings rather than of people.
      spectators: channelsUndriven.filter(channel => channel.role === 'spectator').length,
      views: pickerCore.metrics.spectatorViews
    }
    check(
      'O63',
      'a body nobody drives stays up and stays watchable, and a join reads the picker instead of taking the empty driver seat',
      pickerBot5.received.ended !== null &&
        pickerCore.session.state === 'detached' &&
        pickerCore.attached === false &&
        pickerCore.claimedBody === pickSlug(pickerBodyName) &&
        // The body never left its server, and nobody dialled anything for a spectator.
        loginsAfterDriverLeft === 1 &&
        pickerBodyFake.received.logins === 1 &&
        // The join was served the picker, and the core attached nobody.
        attachedAtJoin === false &&
        pickerFront.metrics.attaches === attachesBeforeJoin &&
        pickerCore.metrics.attaches === coreAttachesBeforeJoin &&
        // The row is honest about a body with no driver: unclaimed, and still watched.
        detachedRowButton !== null &&
        detachedRowButton.label === pickerBodyName + ' - unclaimed, 1 watching' &&
        // The click lands it in that body, with nobody driving.
        detachVerb !== null &&
        detachVerb.id === verbIdFor('spectate', pickerBodyName) &&
        lateLandings.length === 1 &&
        lateLandings[0].body === pickSlug(pickerBodyName) &&
        lateRefusals.length === 0 &&
        pickerBot12.received.login !== null &&
        pickerBot12.received.login.entityId === pickerBot6.received.login?.entityId &&
        latePosition !== null &&
        latePosition.x === pickerBodySpawn.x &&
        latePosition.y === pickerBodySpawn.y &&
        latePosition.z === pickerBodySpawn.z &&
        pickerBot12.received.ended === null &&
        // A spectator of an undriven body still receives its world.
        pickerBot12.received.blockChanges.some(change => change.location?.x === lateBlock.x) &&
        pickerBot6.received.blockChanges.some(change => change.location?.x === lateBlock.x) &&
        // Two spectators, no driver, and neither holding a claim.
        channelsUndriven.length === 2 &&
        channelsUndriven.every(channel => channel.role === 'spectator') &&
        channelsUndriven.every(channel => channel.body === pickSlug(pickerBodyName)) &&
        !claimsUndriven.some(claim => claim.name === 'LateWatch') &&
        pickerCore.attached === false &&
        pickerCore.session.state === 'detached',
      evidence.undriven
    )

    // --- O69: a spectator is told the puppet as a body, over the socket (#635) ---
    // The owner's report, twice from the live lane: the entry arrives, the world is empty.
    // A client draws another player from a `player_info` entry *and an entity for that
    // UUID*, and a server never sends a client its own player entity, so the body's own
    // stream holds no spawn for the puppet and nothing invented one. #614 gave every
    // channel the entry (O62's click is the path that writes it); this is the body that
    // goes with it.
    //
    // What no frame count can see, and this reads over a socket: the *order*. An entry
    // before the spawn, a move only after it, and the driver's own world never handed a
    // second copy of itself. A move for an entity a client cannot place is dropped by the
    // client, so a stream of the right frames in the wrong order is the same empty world.
    //
    // The client that looks is a fresh one, because a spawn is written when a channel
    // lands and the spectators this rig already holds were landed before this row. It
    // lands on the body O63 left undriven, so this is also the answer to "does a body
    // nobody drives have a puppet in it": the world is the body's, whether or not a client
    // is playing it.
    //
    // The window between the landing and the move is real time: the module coalesces a
    // move into one frame per MOVE_INTERVAL_MS, and a rig's clock is the wall clock
    // (src/ladder/rig.js). So this waits one window before it moves the body, rather than
    // racing a bound it cannot see.
    pickerBot20 = createBot({ port: picker.port, username: 'Sightline', version: pickerVersion })
    await pickerBot20.waitFor(
      () => pickerBot20.received.dialogs.length === 1,
      'the picker at the client that will look at the puppet',
      15_000
    )
    const told = { spawns: [], teleports: [], destroys: [] }
    pickerBot20.client.on('spawn_entity', packet => told.spawns.push(packet))
    pickerBot20.client.on('entity_teleport', packet => told.teleports.push(packet))
    pickerBot20.client.on('entity_destroy', packet => told.destroys.push(packet))
    // The driver's own channel speaks for the puppet: a spawn there is a second copy of
    // the body the client already controls.
    const driverSpawns = []
    pickerBot5.client.on('spawn_entity', packet => driverSpawns.push(packet))
    const virtualBefore = {
      spawned: pickerCore.metrics.virtualPlayersSpawned,
      moved: pickerCore.metrics.virtualPlayersMoved,
      despawned: pickerCore.metrics.virtualPlayersDespawned
    }
    const toldLanding = pickerFront.spectate({
      username: 'Sightline',
      body: pickSlug(pickerBodyName),
      server: pickerBodyName
    })
    await pickerBot20.waitFor(
      () => told.spawns.length === 1 && pickerBot20.received.positions.length > 0,
      "the puppet's body at the client that landed to look at it",
      30_000
    )
    // Recorded, not asserted: the entry that names the puppet is #614's, and this rig's
    // fake backend never lists the puppet, so there is no skin for the proxy to write one
    // from. test/service/virtual-players.test.js is where the entry-then-spawn order is
    // read, with a skin the backend states.
    const entriesBeforeSpawn = pickerBot20.received.names
      .filter(frame => frame.state === 'play' && frame.name === 'player_info').length
    const spawn = told.spawns[0]
    await new Promise(resolve => setTimeout(resolve, MOVE_WINDOW_WAIT_MS))
    const poseBefore = { ...pickerCore.session.currentPose }
    pickerBodyFake.sendPosition({ x: poseBefore.x + 4, y: poseBefore.y, z: poseBefore.z + 4 })
    await pickerBot20.waitFor(
      () => told.teleports.length >= 1,
      'the body the client watches, moving after it appeared',
      15_000
    )
    const move = told.teleports[0]
    evidence.virtualPlayers = {
      landing: toldLanding,
      version: pickerVersion,
      spawn: { uuid: spawn.objectUUID, type: spawn.type, entityId: spawn.entityId, x: spawn.x, y: spawn.y, z: spawn.z },
      entriesBeforeSpawn,
      move: { entityId: move.entityId, x: move.x, y: move.y, z: move.z },
      destroys: told.destroys.length,
      driverSpawns: driverSpawns.length,
      bodyEntityId: pickerBot5.received.login?.entityId ?? null,
      poseBefore,
      counters: {
        spawned: pickerCore.metrics.virtualPlayersSpawned - virtualBefore.spawned,
        moved: pickerCore.metrics.virtualPlayersMoved - virtualBefore.moved,
        despawned: pickerCore.metrics.virtualPlayersDespawned - virtualBefore.despawned
      }
    }
    // The client that looked goes, and the rig is left as O63 left it: the two spectators
    // it landed, which is the count O64's own row reads.
    await pickerBot20.close()
    await waitFor(
      () => (pickerFront.channels ?? []).length === 2,
      'the two spectators O63 left, once the client that looked has gone',
      15_000
    )
    check(
      'O69',
      "a spectator is told the puppet as a body: an entity for its UUID with an id of the proxy's own, then a move that follows it, and the driver's own world is never handed a second copy of itself",
      toldLanding.watching === true &&
        told.spawns.length === 1 &&
        typeof spawn.objectUUID === 'string' &&
        spawn.objectUUID.replace(/-/g, '').toLowerCase() === String(puppetUuid).replace(/-/g, '').toLowerCase() &&
        // The type is read from the protocol data this rig's own version states, not from
        // the module that wrote the frame: an assertion comparing the wire to the constant
        // the writer used cannot catch a wrong constant. The rig runs 26.2, and the two
        // versions disagree about this number.
        spawn.type === minecraftData(pickerVersion).entitiesByName.player.id &&
        spawn.entityId >= FIRST_VIRTUAL_ENTITY_ID &&
        spawn.entityId !== (pickerBot5.received.login?.entityId ?? null) &&
        told.teleports.length >= 1 &&
        move.entityId === spawn.entityId &&
        (move.x !== spawn.x || move.z !== spawn.z) &&
        told.destroys.length === 0 &&
        driverSpawns.length === 0 &&
        pickerCore.metrics.virtualPlayersSpawned - virtualBefore.spawned >= 1 &&
        pickerCore.metrics.virtualPlayersMoved - virtualBefore.moved >= 1 &&
        pickerCore.metrics.virtualPlayersDespawned - virtualBefore.despawned === 0,
      evidence.virtualPlayers
    )

    // --- O64: a claim keeps a body alive, and a disconnect ends an unclaimed body (#261) ---
    // O63 left the body standing with nobody driving it and two spectators on it. #261
    // is the other half of what a claim means: a claim is the reason a body is kept
    // alive. So a client may end an unclaimed body, a claimed one refuses that request
    // in a sentence naming the driver, and a body that is ended stays down with no
    // retry armed behind it.
    //
    // Nothing here dials. The body's session outlived its driver, so claiming it again
    // is a landing on the cache it already has, and the fake counts the one login it
    // has had since O58.
    pickerBot13 = createBot({ port: picker.port, username: 'Owner', version: pickerVersion })
    await pickerBot13.waitFor(
      () => pickerBot13.received.dialogs.length === 1,
      'the picker at the client that claims the standing body',
      15_000
    )
    const ownerPick = chooseDialogAction(pickerBot13.received.dialogs[0], pickerBodyName)
    if (ownerPick !== null) pickerBot13.answerDialog(ownerPick.id, null, 'configuration')
    await pickerBot13.waitFor(
      () => pickerBot13.received.dialogs.length === 2,
      "the standing body's own dialog at the client that claims it",
      15_000
    )
    const ownerDialog = readServerDialog(pickerBot13.received.dialogs[1])
    const ownerClaim = chooseDialogAction(pickerBot13.received.dialogs[1], 'claim')
    const loginsBeforeOwner = pickerBodyFake.received.logins
    if (ownerClaim !== null) pickerBot13.answerDialog(ownerClaim.id, null, 'configuration')
    await pickerBot13.waitFor(
      () => pickerBot13.received.login !== null,
      'the claimed body at its new driver',
      30_000
    )
    await waitFor(
      () => pickerCore.attached === true && pickerCore.session.state === 'attached',
      'the body claimed and driven again',
      20_000
    )
    const ownerClaimLines = logs
      .filter(entry => entry.event === 'pickerClaim')
      .map(entry => entry.fields)
    // Read now, not at the check: by the end of this assertion the body has been
    // ended on purpose, and what the claim landed is a moment earlier in the run.
    const afterClaim = {
      state: pickerCore.session.state,
      attached: pickerCore.attached,
      claimed: pickerCore.claimedBody,
      logins: pickerBodyFake.received.logins,
      claims: pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name }))
    }

    // The claim ends with the driver's connection, so the body is standing and
    // unclaimed again, which is what makes it a body a client may end.
    await pickerBot13.close()
    // The claim on the body this row names, not on every body: the first client's
    // claim from O56 is still held on the row whose port answers nothing (#295).
    await waitFor(
      () => pickerFront.claims.every(claim => claim.body !== pickSlug(pickerBodyName)) &&
        pickerCore.attached === false,
      'the claim released when its driver left',
      20_000
    )
    await waitFor(
      () => pickerCore.session.state === 'detached',
      'the body standing with nobody driving it',
      20_000
    )

    pickerBot15 = createBot({ port: picker.port, username: 'Dropper', version: pickerVersion })
    await pickerBot15.waitFor(
      () => pickerBot15.received.dialogs.length === 1,
      'the picker at the client that ends the body',
      15_000
    )
    const dropperPick = chooseDialogAction(pickerBot15.received.dialogs[0], pickerBodyName)
    if (dropperPick !== null) pickerBot15.answerDialog(dropperPick.id, null, 'configuration')
    await pickerBot15.waitFor(
      () => pickerBot15.received.dialogs.length === 2,
      "the undriven body's own dialog at the client that ends it",
      15_000
    )
    const undrivenRow = readServerDialog(pickerBot15.received.dialogs[1])
    const dropperClick = chooseDialogAction(pickerBot15.received.dialogs[1], 'disconnect')
    const dropperDialogsBefore = pickerBot15.received.dialogs.length
    const loginsBeforeEnd = pickerBodyFake.received.logins
    const dialsBeforeEnd = pickerCore.metrics.claimDials
    const endMark = logs.length
    if (dropperClick !== null) pickerBot15.answerDialog(dropperClick.id, null, 'configuration')
    await pickerBot15.waitFor(
      () => pickerBot15.received.dialogs.length === dropperDialogsBefore + 1,
      'the list again after the body it named was ended',
      20_000
    )
    const afterEndList = readServerDialog(pickerBot15.received.dialogs[dropperDialogsBefore])
    // The core's own record of the end: it arrives as one JSON line inside a
    // `pickerCore` entry, because the rig hands it a logStream.
    const endLines = picker.events(endMark)
      .filter(entry => entry.event === 'bodyDisconnected')
    const endRefusals = picker.events(endMark)
      .filter(entry => entry.event === 'bodyDisconnectRefused')
    // A retry arming for a body nobody claims would show up as a second login at the
    // body's server. The run waits past the session's own one-second delay to look for
    // one rather than reading the state once and calling it settled.
    const retried = await settleUntil(() => pickerBodyFake.received.logins > loginsBeforeEnd, 1500)
    // The two spectators end with the body, and their channels leave when their
    // sockets do. A client that joins after that reads the row the ended body left:
    // it is the row's own word for a body that is not up, not a count taken during
    // the teardown.
    await waitFor(
      () => (pickerFront.channels ?? []).length === 0,
      'the channels the ended body took with it',
      15_000
    )
    pickerBot16 = createBot({ port: picker.port, username: 'After', version: pickerVersion })
    await pickerBot16.waitFor(
      () => pickerBot16.received.dialogs.length === 1,
      'the picker at a client that joins after the body ended',
      15_000
    )
    const afterEndRows = readServerDialog(pickerBot16.received.dialogs[0])
    // Read before the claim below, because that claim is a dial and it moves every
    // one of these.
    const afterEnd = {
      state: pickerCore.session.state,
      pendingReconnect: pickerCore.session.pendingReconnect,
      claimed: pickerCore.claimedBody,
      attached: pickerCore.attached,
      logins: pickerBodyFake.received.logins,
      legEnded: pickerBackend.ended
    }
    // A body that ended is a body a claim dials back. `down` is the third stage a
    // claim leaves, beside `boot` and `failed`, and it is the only way a body a
    // player ended ever returns. This is the assertion's one dial, and it is the
    // guard's proof rather than a retry's: the login moves because a client asked,
    // not because a timer fired.
    pickerBot17 = createBot({ port: picker.port, username: 'Back', version: pickerVersion })
    await pickerBot17.waitFor(
      () => pickerBot17.received.dialogs.length === 1,
      'the picker at the client that claims the ended body',
      15_000
    )
    const backPick = chooseDialogAction(pickerBot17.received.dialogs[0], pickerBodyName)
    if (backPick !== null) pickerBot17.answerDialog(backPick.id, null, 'configuration')
    await pickerBot17.waitFor(
      () => pickerBot17.received.dialogs.length === 2,
      "the ended body's own dialog at the client that claims it",
      15_000
    )
    const backRow = readServerDialog(pickerBot17.received.dialogs[1])
    const backClick = chooseDialogAction(pickerBot17.received.dialogs[1], 'claim')
    if (backClick !== null) pickerBot17.answerDialog(backClick.id, null, 'configuration')
    await pickerBot17.waitFor(
      () => pickerBot17.received.login !== null,
      'the body a claim dialled back',
      30_000
    )
    await waitFor(
      () => pickerCore.attached === true && pickerCore.session.state === 'attached',
      'the body down, dialled back and driven again',
      20_000
    )
    const afterBack = {
      state: pickerCore.session.state,
      attached: pickerCore.attached,
      claimed: pickerCore.claimedBody,
      logins: pickerBodyFake.received.logins,
      claims: pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name })),
      dials: pickerCore.metrics.claimDials,
      dialled: pickerCore.metrics.claimDials - dialsBeforeEnd
    }
    evidence.ended = {
      body: pickerBodyName,
      claim: {
        dialogs: ownerDialog.buttons.map(button => button.label),
        title: ownerDialog.title,
        clicked: ownerClaim === null ? null : ownerClaim.id,
        granted: ownerClaimLines.at(-1) ?? null,
        after: afterClaim,
        logins: { before: loginsBeforeOwner, after: pickerBodyFake.received.logins }
      },
      ended: {
        row: undrivenRow.title,
        clicked: dropperClick === null ? null : dropperClick.id,
        lines: endLines,
        refusals: endRefusals,
        state: afterEnd.state,
        claimed: afterEnd.claimed,
        pendingReconnect: afterEnd.pendingReconnect,
        written: pickerFront.metrics.pickerDisconnects,
        legEnded: afterEnd.legEnded,
        logins: { before: loginsBeforeEnd, after: afterEnd.logins },
        retried,
        rows: {
          resent: afterEndList.buttons.map(button => button.label),
          after: afterEndRows.buttons.map(button => button.label)
        },
        clients: {
          dropper: pickerBot15.received.ended === null ? null : String(pickerBot15.received.ended).slice(0, 140),
          after: pickerBot16.received.ended === null ? null : String(pickerBot16.received.ended).slice(0, 140),
          watcher: pickerBot6.received.ended === null ? null : String(pickerBot6.received.ended).slice(0, 140),
          lateWatch: pickerBot12.received.ended === null ? null : String(pickerBot12.received.ended).slice(0, 140)
        }
      },
      back: {
        row: backRow.title,
        clicked: backClick === null ? null : backClick.id,
        logins: { before: loginsBeforeEnd, after: afterBack.logins },
        after: afterBack
      }
    }
    check(
      'O64',
      'a claim lands on a body that is already standing, and a disconnect ends an unclaimed one: the body that ends stays down until a claim dials it back',
      // The claim lands on the body that is already standing: no dial, no second login.
      ownerPick !== null &&
        ownerPick.id === pickIdFor(pickerBodyName) &&
        ownerClaim !== null &&
        ownerClaim.id === verbIdFor('claim', pickerBodyName) &&
        ownerDialog.title === pickerBodyName + ' - unclaimed, 2 watching' &&
        pickerBot13.received.login !== null &&
        afterClaim.attached === true &&
        afterClaim.state === 'attached' &&
        afterClaim.claims.filter(claim => claim.body === pickSlug(pickerBodyName)).length === 1 &&
        afterClaim.claims.some(claim => claim.body === pickSlug(pickerBodyName) && claim.name === 'Owner') &&
        afterClaim.logins === loginsBeforeOwner &&
        loginsBeforeOwner === 1 &&
        // The claim is the body's, and it is a landing on the state the body already
        // had: the driver before this one came and went without the body moving.
        afterClaim.claimed === pickSlug(pickerBodyName) &&
        // With the claim gone the body is a body a client may end, and the row says so.
        undrivenRow.title === pickerBodyName + ' - unclaimed, 2 watching' &&
        dropperClick !== null &&
        dropperClick.id === verbIdFor('disconnect', pickerBodyName) &&
        // The end: the session goes down, the socket closes, and the cache goes with it.
        endLines.length === 1 &&
        endLines[0].body === pickSlug(pickerBodyName) &&
        endLines[0].name === 'Dropper' &&
        pickerFront.metrics.pickerDisconnects === 1 &&
        afterEnd.state === 'down' &&
        afterEnd.pendingReconnect === false &&
        afterEnd.legEnded === true &&
        afterEnd.attached === false &&
        // A body that ends is not retried, and a body that is down stays down.
        retried === false &&
        afterEnd.logins === loginsBeforeEnd &&
        // The lane still serves that body, so the row is down rather than gone.
        afterEnd.claimed === pickSlug(pickerBodyName) &&
        afterEndList.buttons.some(button => button.label.startsWith(pickerBodyName + ' - down')) &&
        afterEndRows.buttons.length === 2 &&
        afterEndRows.buttons.some(button => button.label === pickerBodyName + ' - down') &&
        // The client that asked stayed, and the body that ended took its spectators.
        pickerBot15.received.ended === null &&
        pickerBot6.received.ended !== null &&
        pickerBot12.received.ended !== null &&
        // And a claim dials the ended body back: the client clicked Claim on the row
        // that says `down`, the body's server saw its second login, and the driver
        // is standing in it. Without this a body a player ended would be gone until
        // the lane restarted, and no rung would say so.
        backPick !== null &&
        backPick.id === pickIdFor(pickerBodyName) &&
        backRow.title === pickerBodyName + ' - down' &&
        backClick !== null &&
        backClick.id === verbIdFor('claim', pickerBodyName) &&
        afterBack.logins === loginsBeforeEnd + 1 &&
        afterBack.state === 'attached' &&
        afterBack.attached === true &&
        afterBack.claimed === pickSlug(pickerBodyName) &&
        afterBack.claims.some(claim => claim.body === pickSlug(pickerBodyName) && claim.name === 'Back') &&
        afterBack.dialled === 1,
      evidence.ended
    )

    // --- O65: a body dropped while nobody claims it stays down (#261) ---
    // O64 proved the body a player ended. This is the other way into `down`: the
    // body's own server goes away while no claim holds it. Nobody is waiting on it,
    // so nothing is worth a dial, and the row says so until a claim pays for one.
    // The claimed half of the pair is not here: a claim is held by a client who is
    // standing in the body, and keeping that client through the fault is #334. What
    // this rung can prove is that the fault lands the body in `down` with no retry
    // armed, and that a claim dials it back.
    await pickerBot17.close()
    await waitFor(
      () => pickerFront.claims.every(claim => claim.body !== pickSlug(pickerBodyName)) &&
        pickerCore.attached === false,
      'the claim released when its driver left, before the fault',
      20_000
    )
    await waitFor(
      () => pickerCore.session.state === 'detached',
      'the body standing with nobody driving it, before the fault',
      20_000
    )
    pickerBot18 = createBot({ port: picker.port, username: 'Fault', version: pickerVersion })
    await pickerBot18.waitFor(
      () => pickerBot18.received.dialogs.length === 1,
      'the picker at the client that watches the unclaimed body fault',
      15_000
    )
    const faultPick = chooseDialogAction(pickerBot18.received.dialogs[0], pickerBodyName)
    if (faultPick !== null) pickerBot18.answerDialog(faultPick.id, null, 'configuration')
    await pickerBot18.waitFor(
      () => pickerBot18.received.dialogs.length === 2,
      "the unclaimed body's own dialog, before its fault",
      15_000
    )
    const beforeFaultRow = readServerDialog(pickerBot18.received.dialogs[1])
    const loginsBeforeDrop = pickerBodyFake.received.logins
    const faultMark = logs.length
    // The same path a dropped Paper connection takes: the body's socket dies at the
    // server's end, and the core learns the session is gone from its own leg.
    for (const client of Object.values(pickerBodyFake.server.clients)) {
      try { client.socket?.destroy() } catch { /* already gone */ }
    }
    await waitFor(
      () => pickerCore.session.state === 'down',
      'the unclaimed body down after its fault',
      20_000
    )
    const faultDown = {
      state: pickerCore.session.state,
      pendingReconnect: pickerCore.session.pendingReconnect,
      claimed: pickerCore.claimedBody,
      attached: pickerCore.attached,
      logins: pickerBodyFake.received.logins,
      events: picker.events(faultMark).filter(entry => entry.event === 'backendDown')
    }
    // A retry for a body nobody claims would show up as a login here. The run waits
    // past the session's own one-second delay, so this is a look for a dial rather
    // than a read taken too early.
    const faultRetried = await settleUntil(() => pickerBodyFake.received.logins > loginsBeforeDrop, 1500)
    // The same client asks for the same row again: a pick re-reads the row where the
    // labels are written, so this is the row's word after the fault and not before it.
    if (faultPick !== null) pickerBot18.answerDialog(faultPick.id, null, 'configuration')
    await pickerBot18.waitFor(
      () => pickerBot18.received.dialogs.length === 3,
      "the unclaimed body's row after its fault",
      20_000
    )
    const afterFaultRow = readServerDialog(pickerBot18.received.dialogs[2])
    const faultClaim = chooseDialogAction(pickerBot18.received.dialogs[2], 'claim')
    if (faultClaim !== null) pickerBot18.answerDialog(faultClaim.id, null, 'configuration')
    await pickerBot18.waitFor(
      () => pickerBot18.received.login !== null,
      'the faulted body a claim dialled back',
      30_000
    )
    await waitFor(
      () => pickerCore.attached === true && pickerCore.session.state === 'attached',
      'the faulted body up and driven again',
      20_000
    )
    const afterFault = {
      state: pickerCore.session.state,
      attached: pickerCore.attached,
      claimed: pickerCore.claimedBody,
      logins: pickerBodyFake.received.logins,
      claims: pickerFront.claims.map(claim => ({ body: claim.body, name: claim.name })),
      dials: pickerCore.metrics.claimDials - dialsBeforeEnd
    }
    evidence.fault = {
      body: pickerBodyName,
      faulted: faultDown,
      retried: faultRetried,
      rows: {
        before: beforeFaultRow.title,
        after: afterFaultRow.title
      },
      clicked: faultClaim === null ? null : faultClaim.id,
      logins: { before: loginsBeforeDrop, after: afterFault.logins },
      after: afterFault
    }
    check(
      'O65',
      'a body dropped while nobody claims it stays down: the fault arms no retry, the row says down, and a claim dials it back',
      // The body was up and unclaimed before the fault, and the row said so.
      beforeFaultRow.title === pickerBodyName + ' - unclaimed' &&
        // The fault landed the body in `down` itself, with no retry behind it.
        faultDown.state === 'down' &&
        faultDown.pendingReconnect === false &&
        faultDown.attached === false &&
        faultDown.claimed === pickSlug(pickerBodyName) &&
        faultDown.events.length === 1 &&
        faultDown.events[0].outcome?.unclaimed === true &&
        // A body nobody claims is not dialled again, and the row says where it stands.
        faultRetried === false &&
        faultDown.logins === loginsBeforeDrop &&
        afterFaultRow.title === pickerBodyName + ' - down' &&
        // A claim is the one thing that pays for a dial, and it lands its client.
        faultClaim !== null &&
        faultClaim.id === verbIdFor('claim', pickerBodyName) &&
        afterFault.logins === loginsBeforeDrop + 1 &&
        afterFault.state === 'attached' &&
        afterFault.attached === true &&
        afterFault.claimed === pickSlug(pickerBodyName) &&
        afterFault.claims.some(claim => claim.body === pickSlug(pickerBodyName) && claim.name === 'Fault') &&
        afterFault.dials === 2,
      evidence.fault
    )

    // --- O66: a lane with no list refuses the join in a sentence about the lane (#315) ---
    // Every join from O55 read a list, and O61 proved the read falls back when the live
    // file cannot be parsed. This is the other answer: both files the lane names are
    // unparseable, so there is nothing to offer. The client that joins gets no dialog
    // and one sentence, and the sentence is about the lane because the client clicked
    // nothing. The offer's own line names the fact an operator can act on: the code the
    // parser refused with (#372), and the file to repair first, which is the live file
    // because its repair is the one that brings the list back.
    fs.writeFileSync(pickerLiveFile, '{"version":1,"servers":[' + '\n')
    fs.writeFileSync(pickerSeedFile, 'not json' + '\n')
    const emptyMark = logs.length
    pickerBot19 = createBot({ port: picker.port, username: 'Empty', version: pickerVersion })
    await pickerBot19.waitFor(
      () => pickerBot19.received.names.some(frame => frame.state === 'configuration' && frame.name === 'disconnect'),
      'the refusal a lane that offers nothing gives a joining client',
      15_000
    )
    // The frame is written before the socket ends, so the two are two waits: this
    // assertion is about a client that was told and then ended, not one left hanging.
    await pickerBot19.waitFor(
      () => pickerBot19.received.ended !== null,
      'the client ended after the refusal a lane with no list gives',
      10_000
    )
    const emptyOffers = logs
      .slice(emptyMark)
      .filter(entry => entry.event === 'pickerOffered')
      .map(entry => entry.fields)
    const emptyRefusals = logs
      .slice(emptyMark)
      .filter(entry => entry.event === 'pickerEmpty')
      .map(entry => entry.fields)
    // The sentence the client was actually given, off the disconnect frame it received,
    // not only the one the lane logged: a wrong write would still log the right text.
    const toldText = pickerBot19.received.disconnects.map(told => JSON.stringify(told.packet ?? null))
    evidence.empty = {
      offer: emptyOffers[0] ?? null,
      refusal: emptyRefusals[0] ?? null,
      dialogs: pickerBot19.received.dialogs.length,
      disconnects: pickerBot19.received.disconnects.map(told => told.state),
      told: toldText.map(text => text.slice(0, 240)),
      ended: pickerBot19.received.ended === null ? null : String(pickerBot19.received.ended).slice(0, 160)
    }
    check(
      'O66',
      'a lane with no list refuses the join in a sentence about the lane, and its offer names why the list is empty',
      // One offer, one line, and it says which empty state this is.
      emptyOffers.length === 1 &&
        emptyOffers[0].source === 'none' &&
        emptyOffers[0].servers === 0 &&
        // #372: the parser's own code, not one word for nine repairs, and the file the
        // operator edits first. Neither file holds an entry to name, so `at` is null.
        emptyOffers[0].reason === 'not_json' &&
        emptyOffers[0].file === pickerLiveFile &&
        emptyOffers[0].at === null &&
        // The refusal names the lane, never a server the client did not pick, and the
        // sentence the client was told is the one the lane said it chose.
        emptyRefusals.length === 1 &&
        emptyRefusals[0].reason === 'not_json' &&
        /this lane is not offering any server/.test(String(emptyRefusals[0].text ?? '')) &&
        toldText.length === 1 &&
        toldText[0].includes('this lane is not offering any server') &&
        !toldText[0].includes('that server') &&
        // No dialog with no buttons: the client is told, and ended.
        pickerBot19.received.dialogs.length === 0 &&
        pickerBot19.received.ended !== null,
      evidence.empty
    )

  } catch (error) {
    runError = error
    exitCode = phase === 'setup' ? 2 : 1
    process.stderr.write(`loopback: ${phase} failed: ${String(error?.message ?? error)}\n`)
  } finally {
    stopping = true
    // A lane owns its bots, its sockets and its timers, so it closes before the
    // list below: the list is what is left of the hand-written teardown (#594).
    for (const lane of lanes) {
      try { await lane.close() } catch { /* best effort */ }
    }
    for (const bot of [attachBot2, attachBot1, rivalBot, bot9, bot8, bot7, bot6, bot5, bot4, bot3, bot2, bot1, stranger, capBot, capRefusedBot, deadlineBot, deadlineStranger, controlBot2, controlBot1, pickerBot, pickerBot2, pickerBot3, pickerBot4, pickerBot5, pickerBot6, pickerBot7, pickerBot8, pickerBot9, pickerBot10, pickerBot11, pickerBot12, pickerBot13, pickerBot15, pickerBot16, pickerBot17, pickerBot18, pickerBot19, pickerBot20, pickerBot21]) {
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
      // The control directories hold the files O53 and O61 edited. A passing run
      // leaves nothing behind; a failing one keeps them for the report.
      try { if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true }) } catch { /* best effort */ }
      try { if (pickerControlDir) fs.rmSync(pickerControlDir, { recursive: true, force: true }) } catch { /* best effort */ }
      try { if (laneJournalDir) fs.rmSync(laneJournalDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }

    if (failed && exitCode === 0) exitCode = 1
    if (runError && exitCode === 0) exitCode = 1

    // A run that failed before its checks started has nothing to say about them.
    // A run that finished must have run every id the list declares, or a deleted
    // check would leave its bullet and its id behind and nothing would notice.
    if (!runError) {
      const unrun = declaredButNotRun(LOOPBACK_ASSERTION_IDS, ranIds)
      if (unrun.length > 0) {
        failed = true
        if (exitCode === 0) exitCode = 1
        process.stderr.write(
          `loopback: LOOPBACK_ASSERTION_IDS declares ${unrun.join(', ')}, which no check ran: ` +
          'add the check, or remove the id\n'
        )
      }
    }

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

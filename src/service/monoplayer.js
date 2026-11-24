// B1 monoplayer core: product-shaped composition root.
//
// The protocol spike (src/spike/proxy.js) is frozen; this module is where the product
// lives. Everything real-scoped is injected: the front-leg and backend-leg
// adapters (interface below, fakes in src/legs/fake-legs.js) and the
// clock. With no --start flag the CLI never opens a socket and no Microsoft
// auth is touched — B1 is the pure core plus fake integration only.
//
// Adapter interfaces (real legs, built in G1/M4, implement these):
//
//   backendLeg = {
//     connect(): Promise                          // starts the puppet session
//     setFrameHandler(({ state, name, buffer, data }): void)
//     setEndHandler(({ reason }): void)           // backend hangup/fault
//     setErrorHandler(({ error }): void)
//     write(name, packet)                         // serverbound, packet level
//     writeRaw(buffer, meta)                      // serverbound, frame level
//     chat(text): void                            // sign and send as the puppet
//     answerHeldGate({ state, name, data })        // optional: answer a configuration
//                                                 // gate its last client left (#73)
//     end(reason)                                 // deliberate close
//   }
//
// `chat` and `answerHeldGate` are optional: a leg without the first drops the
// human's chat and counts it, and a leg without the second leaves a
// configuration gate held when its last client detaches (#73).
// The leg owns the signing, because the signature needs the puppet's profile
// keys and the puppet connection's own last-seen window, and neither belongs to
// the core.
//
//   frontLeg = {                                  // one attaching client
//     setLoginStartHandler(({ uuid, name }): decision[])   // -> whitelist review
//     setServerboundHandler(({ state, name, buffer, data }): void)
//     setDetachHandler(({ reason }): void)
//     write(name, packet, { synth })              // clientbound, packet level
//     writeRaw(buffer, meta)                      // clientbound, frame level
//     end(reason)                                 // kick/deny the client
//     startReconfiguration({ reason }): { started, reason }  // optional (#22)
//                                                 // the sampling client re-enters
//                                                 // configuration on its own
//                                                 // connection
//     finishConfigurationFrame(): Buffer          // optional: the bytes that end
//                                                 // a configuration round, for a
//                                                 // restore with no cached finish
//   }
//
// A hand-built harness may omit the last two; the core degrades to a state
// replay at the target's login and logs reconfigurationRestoreNoFinish.

import { WARM_MARKER } from '../core/state-cache.js'
import { createBodyCaches } from '../core/body-caches.js'
import { pickSlug } from '../core/picker.js'
import {
  FABRIC_BRAND,
  brandFrame,
  capFromLogin,
  chunkBoundFor,
  mergeClientSettings,
  normalizeClientSettings
} from '../core/client-settings.js'
import { createFrontIdentity } from '../core/identity.js'
import { synthAttach } from '../core/join-synth.js'
import { replaySummary } from '../core/replay-summary.js'
import { noticeFrames, noticeId, systemChatFrame } from '../core/notice.js'
import { SKIN_FRAME, carriesTextures, skinPlayerInfoPacket, texturesPropertyOf } from '../core/skin.js'
import { classifyServerbound, capturePose, chatText } from '../core/relay.js'
import { CHAT_FRAMES, CHAT_MODES, chatRelayAllowed, clientboundPolicy, DECISION } from '../core/clientbound-policy.js'
import { createPendingDialog } from '../core/pending-dialog.js'
import { createPendingResourcePacks } from '../core/pending-resource-pack.js'
import { createSession, STATES } from '../core/session.js'
import { createTransfer, TRANSFER_KINDS } from '../core/transfer.js'
import { redact } from '../observability/redact.js'
import { DEFAULT_DEADLINE_MS, DEFAULT_MAX_CONNECTIONS, MAX_DEADLINE_MS } from '../core/preauth-window.js'
import { flag } from './cli.js'
import { pathToFileURL } from 'node:url'

// --- config ---

// The two `.secrets` paths below restate `DEFAULT_ACCOUNTS_DIR`
// (custody/accounts.js) and `DEFAULT_WHITELIST_FILE` (custody/store.js) on
// purpose. Both custody modules import `node:fs`, and this module is loaded by
// every test that builds a core config and by `--print-config`, so importing
// them here would drag file I/O into the pure path (#104).
export const DEFAULT_CONFIG = Object.freeze({
  version: '26.1',
  // 'read-only' (the default): relay clientbound chat to the attached client,
  // drop the client's own text.
  // 'commands' (#97): speak the client's commands as the puppet, so /profil,
  // /msg, and /tp reach the server while the account stays silent in open chat.
  // Clientbound chat relays exactly as 'read-only' does.
  // 'full' (#19): also speak the client's open chat on the backend leg as the
  // puppet, with the puppet's own profile keys and window, and relay the
  // server's signed player chat back. Not the default: the signed path needs a
  // live run on the deployed backend to prove it, because a leg without profile
  // keys sends an unsigned frame that a secure-profile server rejects by
  // closing the connection. `chatCapability` in the log answers that question.
  // 'off': drop clientbound chat as well.
  chat: 'read-only',
  front: Object.freeze({ host: '127.0.0.1', port: 25565 }),
  backend: Object.freeze({ host: '127.0.0.1', port: 25565 }),
  puppet: Object.freeze({
    // Assertions, not selectors: when set, the resolved account must match.
    username: null,
    uuid: null,
    // Account selector: UUID, alias, or profile name.
    account: null,
    // G1 token custody (field names only; tokens never appear in config):
    accountsDir: '.secrets/accounts',
    // Raw directory override (deprecated) and its legacy selector.
    cacheDir: null,
    cacheAccount: null
  }),
  // Configuration-phase gate answer: first, last, or a label substring (#21).
  // It never answers a play dialog, which belongs to the human (#20). Null
  // leaves the gate unanswered and a headless leg waits.
  dialogAction: null,
  // #201: the total connection cap on the pre-auth window, which runs from an
  // accepted socket to the attach whitelist's accept. It is the one limit that
  // still counts when a TCP tunnel presents its own address rather than the
  // client's, so it is on by default and a lane cannot be exposed without it.
  // A cap smaller than one cannot bound the window, and loadConfig refuses it
  // instead of starting misconfigured.
  //
  // #205: the deadline on the same window. The cap bounds how many connections
  // sit in it and nothing bounded how long one stayed, so a stranger could hold
  // the window closed with silent sockets. A connection still in the window when
  // its timer fires is destroyed. A deadline of zero cannot bound anything, and
  // loadConfig refuses it for the same reason it refuses a cap of zero.
  preAuth: Object.freeze({
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    deadlineMs: DEFAULT_DEADLINE_MS
  }),
  attachWhitelist: Object.freeze([]),
  attachWhitelistFile: '.secrets/attach-whitelist.json',
  // #257: the picker. Off, because a lane that turns it on promises the client a
  // list of servers it may enter, and no entry is delivered yet: the front serves
  // the configuration baseline, shows the dialog, records the pick, and records a
  // claim against the body it names (#267). Delivery of that body is #269's. With
  // this off, a join with no backend is refused at login with the reason it always
  // gave, `backend_not_ready`.
  //
  // The front leg's own baseline is the other half: `picker` with no
  // configurationBaseline refuses the join instead of inventing one, so a lane
  // cannot promise a picker it cannot show.
  picker: false,
  // #229: the runtime control document an operator edits between deploys.
  // `file` is the only switch. It names desired.json, the file that moves the
  // puppet's backend, and setting it also turns on the attach whitelist's reload
  // at each login (attachWhitelistFile). Null leaves every lane exactly as it
  // was: the whitelist is read once at startup and no control file is opened.
  // `allowBackendSwitch` gates only the move: with a desired.json present and
  // this off, the lane logs once, named, and stays on the configured backend.
  //
  // This module never reads either file. The core stays free of file I/O (#104),
  // and a bad control value is named and ignored at the point of use rather than
  // stopping the lane at boot. See src/service/control.js.
  control: Object.freeze({ file: null, allowBackendSwitch: false }),
  bounds: Object.freeze({
    maxPrefix: 8192,
    maxConfig: 1024,
    maxChunks: 1024,
    maxBlocks: 2048,
    maxEntities: 2048,
    // #213: the depth of one entity's keyed record: 43 metadata indexes, 8
    // whole-value frames, and one slot per effect id. Past 128 the whole entity
    // is dropped rather than truncated.
    maxEntitySlots: 128,
    // The slots the whole entity domain holds, so its memory is a number and not
    // maxEntities times maxEntitySlots.
    maxEntityFrames: 32768,
    maxInventories: 32,
    maxGeneric: 512
  }),
  reconnect: Object.freeze({ delayMs: 1000, attempts: 1, maxDelayMs: 60_000 }),
  // #96: the exact packet journal. Off unless `dir` names a directory.
  //
  // The journal writes one shard per hour and frame kind (#217).
  //
  // `maxBytes` is one shard's seal threshold; `maxTotalBytes` and `maxAgeMs`
  // bound the directory, and retention prunes on start, after every seal, and at
  // close. A seal alone deletes nothing: two days of play wrote ~393 MB in one
  // session, filled a 1 GiB custody volume, and the front CrashLooped on ENOSPC.
  // The budget numbers are repeated in src/observability/journal.js, which owns
  // the retention and the file names; this module stays free of file I/O (#104).
  journal: Object.freeze({
    dir: null,
    maxBytes: 67_108_864,
    maxTotalBytes: 268_435_456,
    // The horizon the budget buys once the entity stream is dropped: 48 hours,
    // or since the last restart, whichever is shorter.
    maxAgeMs: 48 * 60 * 60 * 1000
  }),
  // #99: the human's own player wears the puppet's skin. One `player_info`
  // entry for the human's UUID carrying the textures property the backend sent
  // for the puppet; an entry the client holds already wins over it.
  //
  // On, because a real 26.2 client accepted the property: with no entry for its
  // own UUID it drew a vanilla default skin, and with one it drew the puppet's.
  // The ticket's open question was whether a client accepts a property Mojang
  // signed for a different profile UUID; it does, and it accepts an unsigned copy
  // as well, because it asks for a secure property only for players other than
  // the one it controls. Measured through the dev lane: testdata/skin-verdict.md.
  skin: Object.freeze({ showPuppetSkin: true }),
  transfer: Object.freeze({
    // Follow a backend transfer on the puppet leg. With a client attached the
    // front serves a same-connection reconfiguration, so the client keeps its
    // socket and lands on the target's play state (#22). With nobody attached
    // the puppet moves alone.
    follow: true,
    // A chain deeper than this, or a repeated target, is refused.
    chainLimit: 8,
    // After this long on one server, the chain history resets, so a later
    // transfer to a previously visited server is allowed again.
    chainResetMs: 120_000,
    // Keep the attached client's connection through a followed transfer (or a
    // server reconfiguration): the client re-enters configuration on its own
    // socket and lands in the target's play state (#22). The transfer testbed
    // measured this with a real client on 2026-11-09: one socket, no kick,
    // `transfersSeamless 1`, `frontKicks 0`, the target's login on the same
    // connection. Setting it false is the pre-#22 behaviour: the client is
    // detached, the puppet moves, and the client rejoins.
    keepConnection: true,
    // A kept client's configuration round has a deadline: a target that
    // restarts the phase and then sends nothing must not freeze the human's
    // connection on a loading screen. On expiry the move is restored. 0
    // disables it. Only read while `keepConnection` is on.
    reconfigureTimeoutMs: 30_000
  })
})

export function loadConfig (doc = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...doc,
    bounds: { ...DEFAULT_CONFIG.bounds, ...(doc.bounds ?? {}) },
    reconnect: { ...DEFAULT_CONFIG.reconnect, ...(doc.reconnect ?? {}) },
    transfer: { ...DEFAULT_CONFIG.transfer, ...(doc.transfer ?? {}) },
    front: { ...DEFAULT_CONFIG.front, ...(doc.front ?? {}) },
    backend: { ...DEFAULT_CONFIG.backend, ...(doc.backend ?? {}) },
    puppet: { ...DEFAULT_CONFIG.puppet, ...(doc.puppet ?? {}) },
    control: { ...DEFAULT_CONFIG.control, ...(doc.control ?? {}) },
    preAuth: { ...DEFAULT_CONFIG.preAuth, ...(doc.preAuth ?? {}) },
    skin: { ...DEFAULT_CONFIG.skin, ...(doc.skin ?? {}) },
    journal: { ...DEFAULT_CONFIG.journal, ...(doc.journal ?? {}) }
  }
  if (!Array.isArray(merged.attachWhitelist)) {
    throw new TypeError('config.attachWhitelist must be an array of UUIDs')
  }
  // #229: the control document's path is a config key, resolved once, so a value
  // that cannot name a file is refused at boot. The file's contents are runtime
  // state and are read at the point of use, never here.
  if (merged.control.file !== null &&
      (typeof merged.control.file !== 'string' || merged.control.file.trim() === '')) {
    throw new TypeError('config.control.file must be a file path or null')
  }
  if (typeof merged.control.allowBackendSwitch !== 'boolean') {
    throw new TypeError('config.control.allowBackendSwitch must be a boolean')
  }
  if (!CHAT_MODES.has(merged.chat)) {
    throw new TypeError("config.chat must be 'full', 'commands', 'read-only', or 'off'")
  }
  if (typeof merged.picker !== 'boolean') {
    throw new TypeError('config.picker must be a boolean')
  }
  if (typeof merged.transfer.follow !== 'boolean') {
    throw new TypeError('config.transfer.follow must be a boolean')
  }
  if (!Number.isInteger(merged.transfer.chainLimit) || merged.transfer.chainLimit < 1) {
    throw new TypeError('config.transfer.chainLimit must be a positive integer')
  }
  if (!Number.isFinite(merged.transfer.chainResetMs) || merged.transfer.chainResetMs < 0) {
    throw new TypeError('config.transfer.chainResetMs must be a non-negative number')
  }
  if (typeof merged.transfer.keepConnection !== 'boolean') {
    throw new TypeError('config.transfer.keepConnection must be a boolean')
  }
  if (!Number.isFinite(merged.transfer.reconfigureTimeoutMs) || merged.transfer.reconfigureTimeoutMs < 0) {
    throw new TypeError('config.transfer.reconfigureTimeoutMs must be a non-negative number')
  }
  if (!Number.isInteger(merged.preAuth.maxConnections) || merged.preAuth.maxConnections < 1) {
    throw new TypeError('config.preAuth.maxConnections must be a positive integer')
  }
  // A deadline above MAX_DEADLINE_MS makes Node fire the timer at 1 ms, which
  // destroys every admitted connection at once. A document that sets one refuses
  // to start rather than taking the front down that way.
  if (!Number.isInteger(merged.preAuth.deadlineMs) || merged.preAuth.deadlineMs < 1 ||
      merged.preAuth.deadlineMs > MAX_DEADLINE_MS) {
    throw new TypeError('config.preAuth.deadlineMs must be an integer between 1 and ' + MAX_DEADLINE_MS)
  }
  if (typeof merged.skin.showPuppetSkin !== 'boolean') {
    throw new TypeError('config.skin.showPuppetSkin must be a boolean')
  }
  // #96: the journal's caps are the whole point of the ticket, so a value that
  // cannot bound anything is refused here rather than defaulted away.
  if (merged.journal.dir !== null &&
      (typeof merged.journal.dir !== 'string' || merged.journal.dir.trim() === '')) {
    throw new TypeError('config.journal.dir must be a directory path or null')
  }
  for (const key of ['maxBytes', 'maxTotalBytes']) {
    if (!Number.isInteger(merged.journal[key]) || merged.journal[key] < 1) {
      throw new TypeError('config.journal.' + key + ' must be a positive integer of bytes')
    }
  }
  if (!Number.isInteger(merged.journal.maxAgeMs) || merged.journal.maxAgeMs < 0) {
    throw new TypeError('config.journal.maxAgeMs must be a non-negative integer of milliseconds')
  }
  if (merged.journal.maxTotalBytes < merged.journal.maxBytes) {
    throw new TypeError('config.journal.maxTotalBytes must be at least config.journal.maxBytes, ' +
      'so one shard cannot outgrow the directory budget')
  }
  return merged
}

// --- core ---

// Telemetry and journal defaults: inert objects, so a core built without them
// behaves exactly as before (no timers, no sockets, no files).
const NOOP_TELEMETRY = Object.freeze({
  enabled: false,
  log () {},
  metric () {},
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
  stats: () => ({ enabled: false })
})
const NOOP_JOURNAL = Object.freeze({
  enabled: false,
  frame () {},
  event () {},
  close () {},
  stats: () => ({ enabled: false })
})

export function createMonoplayer ({
  config = loadConfig(),
  backendLeg,
  frontLeg,
  clock,
  logStream = null,
  telemetry = NOOP_TELEMETRY,
  journal = NOOP_JOURNAL,
  // #229: a function returning the attach whitelist now, called at each login.
  // The live orchestrator passes one when config.control.file is set, so a UUID
  // added to the file takes effect on the next login with no restart. Null is the
  // default, and config.attachWhitelist is then the whole whitelist, frozen here.
  whitelistSource = null
} = {}) {
  if (!backendLeg) throw new TypeError('backendLeg adapter is required')
  if (!frontLeg) throw new TypeError('frontLeg adapter is required')

  const cfg = config

  // #260: one state cache per body, owned here as a registry. A body's cache is
  // its world's state. It is shared by whoever is later delivered that body, and
  // by nobody else. The lane's own body — the configured backend, with no claim
  // behind it — is named the way a claim names a body. So a claim on that same
  // server lands on the cache the lane already warmed, not on a second one. A
  // body's session is still one per process: a leg per body is #261, and
  // per-channel delivery is #269.
  const bodies = createBodyCaches({ bounds: cfg.bounds })
  const configuredBody = pickSlug(cfg.backend.host + ':' + cfg.backend.port)
  let activeBody = configuredBody
  let cache = bodies.cacheFor(activeBody)
  const identity = createFrontIdentity({
    attachWhitelist: whitelistSource ?? cfg.attachWhitelist,
    puppetProfile: cfg.puppet
  })
  const session = createSession({
    clock,
    reconnectDelayMs: cfg.reconnect.delayMs,
    reconnectPolicy: {
      attempts: cfg.reconnect.attempts ?? 1,
      maxDelayMs: cfg.reconnect.maxDelayMs ?? 60_000
    },
    // The core announces the due reconnect; the adapter/orchestrator owns the
    // actual backend connect (the core never touches the backend leg here).
    onReconnect: ({ delayMs, attempt }) => {
      const target = pendingTransfer
      const moveTarget = pendingMove
      pendingTransfer = null
      pendingMove = null
      // The dial starts now: the ended leg's late end event, if any, arrives
      // before this and must not be read as the target faulting (#22).
      legHandover = false
      // #260: a move names another server, so it names another body, and the
      // frames it brings are that body's. Any other reconnect dials the body the
      // session already serves, so its cache stays. A restore has already put the
      // session back on the body it came from (failTransfer).
      const dialled = target ?? moveTarget
      if (dialled !== null) activateBody(pickSlug(dialled.host + ':' + dialled.port))
      // #22: after a restore the cache holds the snapshot the client was put
      // back on. The returning backend is a fresh session, and its frames must
      // not append to that snapshot: the client already has it, and a later
      // attach would replay a doubled login and configuration.
      if (move.claimRestore()) {
        cache.reset()
        // #98: the packs held under a failed target die with it. The base server
        // this reconnect dials never sent them, and answering it for their UUIDs
        // would be an invented status.
        pendingPacks.clear()
        log('cacheReset', { reason: 'transfer_restored' })
      }
      emit('reconnect_due', { delayMs, attempt, target, moveTarget })
    }
  })

  const metrics = {
    backendFrames: 0,
    configFrames: 0,
    framesCached: 0,
    framesReplayed: 0,
    positionsSynthesized: 0,
    serverboundForwarded: 0,
    serverboundDropped: 0,
    serverboundNotAttached: 0,
    serverboundByName: {},
    serverboundDroppedByName: {},
    chatBlocked: 0,
    chatRelayed: 0,
    chatSent: 0,
    clientboundBlocked: 0,
    clientboundBlockedByName: {},
    clientboundUnclassified: 0,
    transfersBlocked: 0,
    transfersFollowed: 0,
    transfersRefused: 0,
    claimDials: 0,
    claimDialsFailed: 0,
    claimBodies: 0,
    noticesSent: 0,
    noticeFallbacks: 0,
    // #99: one `player_info` frame per attach that gives the human's own UUID
    // the puppet's skin.
    skinFramesWritten: 0,
    skinFramesRefused: 0,
    // #22: same-connection reconfiguration.
    transfersSeamless: 0,
    reconfigurationsStarted: 0,
    reconfigurationsCompleted: 0,
    reconfigurationsRestored: 0,
    reconfigurationRefusals: 0,
    configFramesReconfigured: 0,
    lateFramesAfterHandover: 0,
    noticeGhosts: 0,
    bundleDelimitersDropped: 0,
    nonPlayFramesIgnored: 0,
    resourcePackAcks: 0,
    resourcePackAckFailures: 0,
    // #98: the pack a client answers, and the one a client has not answered.
    resourcePacksHeld: 0,
    resourcePacksRelayed: 0,
    resourcePacksResent: 0,
    resourcePacksAnswered: 0,
    resourcePacksRemoved: 0,
    resourcePacksAnsweredOnDetach: 0,
    resourcePacksWithheld: 0,
    brandAnnounced: 0,
    attachesConfiguring: 0,
    configFramesRelayed: 0,
    controlDialogsShown: 0,
    controlDialogsCleared: 0,
    controlDialogsRelayed: 0,
    controlDialogsHeld: 0,
    controlDialogsResent: 0,
    controlDialogsAnswered: 0,
    controlDialogsPuppetAnswered: 0,
    // #73: a configuration gate answered because its last client detached.
    controlDialogsAnsweredOnDetach: 0,
    clientSettingsSent: 0,
    clientSettingsRewritten: 0,
    clientSettingsFailed: 0,
    attaches: 0,
    denials: 0,
    frontKicks: 0
  }

  // Bounded per-name counters. Packet names are a fixed protocol vocabulary,
  // so the cap only guards against a client sending nonsense names.
  const MAX_NAMES = 128
  function bumpName (map, name) {
    const key = name ?? 'unknown'
    if (map[key] !== undefined) { map[key]++; return }
    if (Object.keys(map).length >= MAX_NAMES) { map.other = (map.other ?? 0) + 1; return }
    map[key] = 1
  }
  // Interactions are rare and are the ones that fail silently on a real
  // backend, so each one gets its own log line (name only, no payload).
  const ACTION_SERVERBOUND = new Set([
    'use_item', 'block_place', 'block_dig', 'use_entity', 'attack',
    'held_item_slot', 'window_click', 'close_window', 'set_creative_slot',
    'set_slot_state', 'select_bundle_item', 'pick_item_from_block',
    'pick_item_from_entity', 'arm_animation', 'player_loaded', 'player_input'
  ])

  // Connection-control frames that are worth one log line each. Chat stays
  // out: a blocked signed chat frame is counted, not logged per message.
  const LOGGED_BLOCKS = new Set([
    'start_configuration',
    'kick_disconnect',
    'cookie_request',
    'store_cookie',
    'disconnect'
  ])
  const TRANSFER_REFUSED_NOTICE =
    '[Monoplayer] The server asked to move this session elsewhere. ' +
    'The proxy could not follow it, so you stay on the current server.'
  const TRANSFER_FOLLOW_REASON =
    'This session is moving. Reconnect in a few seconds to continue.'
  // #22: the failed-target notice. The target address never appears here:
  // the notice is proxy speech about the human's own session.
  const TRANSFER_RESTORED_NOTICE =
    '[Monoplayer] The new server could not be reached. ' +
    'You are still on the previous server.'
  const RECONFIGURE_REASON =
    'The server reconfigured this session. Reconnect in a few seconds.'

  const logs = [] // redacted JSON lines, bounded
  const listeners = new Map() // type -> Set<fn>
  const unclassifiedLogged = new Set()
  let started = false
  let attached = false // a client holds the attach slot (configuring or attached)
  // #16: the pre-warm early attach. `backendConfiguring` is true from the
  // backend's first configuration frame until its play login. `earlyAttach`
  // holds the client that attached during that window; `pendingEarlyReplay`
  // holds the replay it still needs. `frontPlayReady` says the attached
  // client itself finished its configuration and can take play frames.
  let backendConfiguring = false
  let earlyAttach = null
  let pendingEarlyReplay = null
  let frontPlayReady = false
  let brandAnnounced = false // #17: one brand per backend connection
  let backendViewDistance = null // #18: the backend's advertised cap, this connection
  // #18: the last human's client information. It survives a detach, like a
  // real client's options survive a reconnect; only a fresh process starts from
  // the defaults.
  let humanClientSettings = null
  let frontTeleportSeq = 0 // proxy-owned teleport IDs
  let transferNoticeSent = false // one refusal notice per attach
  let noticeSeq = 0 // one advancing id per notice, so a removal names its own
  let pendingTransfer = null // target for the next reconnect_due
  // #258: the one body this session has dialled for a picker claim, or null. It is
  // a slot rather than a map because the session holds one backend connection:
  // #260 gave each body its own cache, so what still refuses a second body is the
  // session and not the cache. A leg per body is #261, and delivery is #269.
  let claimedBody = null
  // The body this session dialled for a claim, and the address it dialled. It is
  // what lets a second claim on the same body wait again instead of dialling a
  // second one, and it survives a wait that timed out: the body is still connected.
  let claimDial = null
  // #233: the target an operator move dials on the next reconnect_due. It is a
  // second slot rather than a flag on the first because the two dials differ in
  // dialect: a transfer asks for the transfer handshake and keeps its cookies, an
  // operator move is a fresh login on a server that never saw the puppet.
  let pendingMove = null
  // The default path: a backend start_configuration ends the leg, and the end
  // handler turns that into a kick with the reconfiguration reason.
  let reconfigureRequested = false
  // #22: the same-connection reconfiguration. `move` owns the pre-transfer
  // snapshot and the session transitions; `moveKind` names the move while it
  // is in flight. `clientReconfiguring` says the client is in its own
  // configuration phase on the connection it kept, `targetLoginReady` that the
  // new session's play login has landed, and `attachedName` the human the
  // replay is built for.
  let move = createTransfer({ session, cache })
  let moveKind = null
  // #260: the body a kept move started on. Its snapshot is that body's state, so a
  // target that fails leaves the snapshot there and the returning dial starts
  // another body's session.
  let moveBody = null
  let clientReconfiguring = false
  let targetLoginReady = false
  let restoreReplayPending = false
  // The client left play for this move at some point. It stays true after the
  // client finishes the target's configuration, so a failure after that still
  // restores a configuration round instead of a play state the client no
  // longer holds.
  let clientLeftPlay = false
  // The deadline for a client's configuration round: a server that restarts
  // configuration and sends nothing must not freeze the human forever.
  let reconfigurationTimer = null
  // #87: the move's completion is waiting for the target's first terrain frame,
  // so the wait is logged once and not once per play frame.
  let reconfigurationWaitingWorld = false
  let attachedName = null
  // #99: the human's UUID, which the front verified before it attached. It is
  // the profile the skin frame names, and the attach path is the only place it
  // is known.
  let attachedUuid = null
  // The skin the puppet wears, as the backend's own `player_info` frame states
  // it. Null until a relayed frame carries one; the proxy never invents a skin.
  let puppetSkinProperty = null
  // Set once, when a frame carried a skin the config could not attribute.
  let puppetSkinUnidentifiedLogged = false
  // Whether the client has received the skin frame since the last replay. A
  // client's entry for a UUID wins over a later add_player for it, so a second
  // frame for the same play state would be a write nobody sees.
  let skinSent = false
  // A backend frame arriving proves the leg has a live session again; the
  // serverbound pipeline refuses to write into a leg that is between
  // connections (a transfer or a restore).
  let backendSessionOpen = false
  // The leg the core ended on purpose for a handover. Its late end event is
  // not the moved-to target faulting, and must not restore the client.
  let legHandover = false
  // A play login counts once per backend connection. The state alone cannot
  // answer this: a restored or reconfiguring session is already `attached`.
  let awaitingBackendLogin = true
  // #16: the last control dialog the human has not answered. It survives a
  // detach and is re-sent on attach. A control dialog is neither cached nor
  // replayed, so this is the one copy and a replay cannot deliver a stale one.
  const pendingDialog = createPendingDialog()
  const pendingPacks = createPendingResourcePacks()
  // #16: the state of a dialog the puppet answered itself (the configuration
  // gate click, #21) on this connection. The leg answers the frame before the
  // core sees it, so the core consumes this marker instead of holding a
  // question that is already closed.
  let puppetAnsweredDialog = null
  const transferChain = { visited: new Set(), depth: 0, resetTimer: null }

  function log (event, fields = {}) {
    const line = redact(JSON.stringify({ t: clock?.now?.() ?? Date.now(), event, ...fields }))
    logs.push(line)
    if (logs.length > 4096) logs.shift()
    if (logStream) logStream.write(line + '\n')
    emit('log', { line })
    // Lifecycle records only: one OTLP log per core log call, never per frame.
    telemetry.log({ event, fields })
  }

  function emit (type, payload) {
    const set = listeners.get(type)
    if (set) for (const fn of set) fn(payload)
  }

  function on (type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
  }

  function isAttached () {
    // #22: a client following a move still holds the attach slot; it is not
    // attachable around, and its frames are the human's.
    return attached && (
      session.state === STATES.ATTACHED ||
      session.state === STATES.CONFIGURING ||
      session.state === STATES.TRANSFERRING
    )
  }

  // Live play frames only go to a front client that is in play. A pre-warm
  // early attach is still finishing its configuration; a play frame sent
  // before that would be parsed as a configuration frame by the client.
  function canRelayPlay () {
    return attached && session.state === STATES.ATTACHED && frontPlayReady
  }

  // --- front-leg login pipeline (pure decisions; adapter owns kick/close IO) ---

  // Whitelist review: Login Start. Denied here, i.e. strictly before
  // Login Success can ever be sent for that connection. The backend readiness
  // gate sits here too: a client that logs in while the puppet has no backend
  // session would be handed an incomplete configuration and crash in registry
  // loading, so deny early with a reason the front turns into a clear kick.
  function processLoginStart (payload = {}) {
    const decision = identity.reviewLoginStart(payload)
    if (!decision.allowed) {
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: decision.reason, phase: decision.phase })
      log('attachDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid })
      emit('attach_denied', decision)
      return decision
    }
    // Warm/WARM-or-DETACHED is the attach-ready set. A second login while
    // already attached still passes here so attachPlayer can answer
    // 'already_attached' with the reason the caller expects.
    // #16: a client may also attach while the backend connection is still in
    // its configuration phase. It follows the puppet's configuration stream
    // and lands in play when the backend logs in.
    const canAttachConfiguring = backendConfiguring && session.state === STATES.BOOT
    if (!session.isAttachReady() && session.state !== STATES.ATTACHED && !canAttachConfiguring) {
      // #257: the picker. A whitelisted client may join a lane with no backend
      // when the lane offers one, and it is not a denial: nothing is attached,
      // the session is untouched, and the front leg serves the configuration
      // baseline and the dialog. `picker: true` is the whole permission, and the
      // front serves nothing it was not given, so a core without the switch keeps
      // answering `backend_not_ready`.
      if (cfg.picker === true) {
        log('attachPicker', { uuid: payload.uuid, name: payload.name, state: session.state })
        emit('attach_picker', { uuid: payload.uuid, name: payload.name, phase: decision.phase })
        telemetry.metric('monoplayer.pickers', 1, { player: payload.name })
        return { ...decision, allowed: true, phase: 'picker', picker: true }
      }
      const denied = {
        allowed: false,
        reason: 'backend_not_ready',
        phase: decision.phase,
        uuid: payload.uuid,
        name: payload.name
      }
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: denied.reason, phase: denied.phase })
      log('attachDenied', { reason: denied.reason, phase: denied.phase, uuid: payload.uuid })
      emit('attach_denied', denied)
      return denied
    }
    return canAttachConfiguring ? { ...decision, phase: 'configuring' } : decision
  }

  // Session verification (only when a verifier was injected): hasJoined.
  async function processVerifySession (payload = {}) {
    const decision = await identity.verifySession(payload)
    if (!decision.allowed) {
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: decision.reason, phase: decision.phase })
      log('verifyDenied', { reason: decision.reason, phase: decision.phase, uuid: payload.uuid, name: payload.name })
      emit('verify_denied', decision)
      return decision
    }
    if (!session.isAttachReady() && session.state !== STATES.ATTACHED) {
      const denied = {
        allowed: false,
        reason: 'backend_not_ready',
        phase: decision.phase,
        uuid: decision.uuid ?? payload.uuid,
        name: decision.name ?? payload.name
      }
      metrics.denials++
      telemetry.metric('monoplayer.denials', 1, { reason: denied.reason, phase: denied.phase })
      log('verifyDenied', { reason: denied.reason, phase: denied.phase, uuid: denied.uuid, name: denied.name })
      emit('verify_denied', denied)
      return denied
    }
    return decision
  }

  // #98: the pack is the puppet's installation and the human's answer.
  //
  // The backend keeps a per-player pack status, and server logic that ships a
  // custom UI inside the pack reads it. The puppet never renders one, so two
  // cases, and only two:
  //
  //   a client can answer in this state — hold the frame and relay it. The
  //     human's own `resource_pack_receive` (accepted, downloaded, declined,
  //     failed) is forwarded to the backend as the puppet's, so the server hears
  //     the result the human's client actually produced. The puppet says nothing.
  //
  //   nothing can answer — hold the frame for the next client, and accept and
  //     load as the puppet (3 = accepted, 0 = successfully loaded), so a required
  //     pack never keeps a headless lane out.
  //
  // The held copy is what a later client receives. It lives outside the state
  // cache: as ordinary state a play-state pack sat in the 512-entry generic ring
  // and was evicted about 90 s into the live session, which is the reattach that
  // had no pack at all.
  function handleResourcePack ({ state, name, buffer, data = {} }) {
    const uuid = data.uuid ?? data.id ?? null
    if (name === 'remove_resource_pack') {
      // The UUID is optional on the wire: absent means every pack of this
      // connection, so an absent one clears the holder.
      const dropped = pendingPacks.remove({ uuid })
      metrics.resourcePacksRemoved++
      log('resourcePackRemoved', {
        state,
        uuid,
        all: dropped.all === true,
        held: dropped.dropped,
        attached: isAttached()
      })
      if (!canReceiveControl(state)) return { relayed: false, dropped: dropped.dropped }
      const relayed = frontLeg.writeRaw(buffer, { state, name }) !== false
      if (relayed) metrics.resourcePacksRelayed++
      return { relayed, dropped: dropped.dropped }
    }
    const added = pendingPacks.add({ state, name, buffer, data })
    metrics.resourcePacksHeld++
    log('resourcePackHeld', { state, uuid, attached: isAttached(), replaced: added.replaced })
    if (canReceiveControl(state)) {
      if (frontLeg.writeRaw(buffer, { state, name }) === false) {
        // The front refused the state it was written in. The pack stays held,
        // so the client's own configuration phase or its replay offers it
        // again; counting it as relayed here would say a client saw it.
        log('resourcePackRelayRefused', { state, uuid })
        return { relayed: false, answered: false }
      }
      metrics.resourcePacksRelayed++
      log('resourcePackRelayed', { state, uuid })
      emit('resource_pack', { state, uuid, attached: true })
      return { relayed: true, answered: false }
    }
    // A client is attached but cannot take the frame in this state yet: an
    // early-attach client still in its own configuration when a play-state pack
    // arrives. It is offered the pack at its replay, so the puppet says nothing:
    // a second, invented answer beside the human's is the whole defect.
    if (isAttached()) {
      metrics.resourcePacksWithheld++
      log('resourcePackWithheld', { state, uuid, reason: 'client_attached', attachedState: session.state })
      return { relayed: false, answered: false }
    }
    answerResourcePack(data)
    return { relayed: false, answered: true }
  }

  // The puppet's own answer, for a pack no client could take. The three stages
  // a real client sends are accepted, downloaded, successfully loaded; the
  // server acts on the last two, and a leg with no download to point at cannot
  // honestly claim stage 4, so this writes the two the product has always sent.
  function answerResourcePack (data = {}) {
    metrics.resourcePackAcks++
    const uuid = data.uuid ?? data.id
    try {
      backendLeg.write('resource_pack_receive', { uuid, result: 3 })
      backendLeg.write('resource_pack_receive', { uuid, result: 0 })
      pendingPacks.answered({ uuid, result: 0 })
      log('resourcePackAck', { uuid, result: 'accepted+loaded' })
    } catch (error) {
      metrics.resourcePackAckFailures++
      log('resourcePackAckFailed', { error: String(error?.message ?? error) })
    }
  }

  // A client that just arrived in `state` receives the packs of that state,
  // in the order the backend sent them. A pack of the other state waits: the
  // client would parse it in a phase where the name is a different packet id.
  //
  // Both callers state the client's phase, because the core's own attach has not
  // run at the configuration one: a warm attach is in play, not CONFIGURING, and
  // only the front knows the client is in its configuration round.
  function resendPendingPacks (state) {
    const frames = pendingPacks.list(state)
    if (frames.length === 0) return { sent: 0 }
    let sent = 0
    for (const frame of frames) {
      try {
        if (frontLeg.writeRaw(frame.buffer, { state: frame.state, name: frame.name }) !== false) sent++
      } catch (error) {
        log('resourcePackResendFailed', { error: String(error?.message ?? error).slice(0, 200) })
      }
    }
    metrics.resourcePacksResent += sent
    log('resourcePacksResent', { state, count: sent })
    return { sent }
  }

  // #98, #73's shape: a client that leaves without answering does not leave the
  // server without an answer. The pack it never answered becomes the puppet's,
  // because a required pack the server hears nothing about can end the session.
  // A pack the puppet can no longer write in its state (configuration, already
  // left) stays held for a client that can answer it.
  function answerPendingPacksOnDetach ({ reason = 'client_disconnect' } = {}) {
    const puppetState = backendConfiguring ? 'configuration' : 'play'
    for (const entry of pendingPacks.unanswered()) {
      if (!backendSessionOpen) {
        metrics.resourcePacksWithheld++
        log('resourcePackWithheld', { state: entry.state, uuid: entry.uuid, reason: 'no_backend_session', detach: reason })
        continue
      }
      // The packet id is state-scoped: a pack asked for in a phase the puppet
      // has left cannot be answered in this one.
      if (entry.state !== puppetState) {
        metrics.resourcePacksWithheld++
        log('resourcePackWithheld', {
          state: entry.state,
          uuid: entry.uuid,
          reason: 'puppet_state',
          detach: reason
        })
        continue
      }
      answerResourcePack(entry.data ?? {})
      metrics.resourcePacksAnsweredOnDetach++
      log('resourcePackAnsweredOnDetach', { state: entry.state, uuid: entry.uuid, detach: reason })
    }
  }

  // #17: servers record the client brand in the configuration phase, and a
  // missing brand is one of the tells that the connection is not a normal
  // client. Announce Fabric Loader on the first configuration frame of every
  // backend connection. The human's brand never replaces it: the front client's
  // brand belongs to a different connection and never crosses.
  function announceBrand () {
    if (brandAnnounced) return { announced: false, reason: 'already_announced' }
    brandAnnounced = true
    const frame = brandFrame()
    try {
      backendLeg.write(frame.name, frame.packet)
      metrics.brandAnnounced++
      log('brandAnnounced', { channel: frame.packet.channel, brand: FABRIC_BRAND })
      return { announced: true }
    } catch (error) {
      // A dead leg during teardown must not consume this connection's one
      // announcement: retry on the next configuration frame.
      brandAnnounced = false
      log('brandAnnounceFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { announced: false, reason: 'write_failed' }
    }
  }

  // #18: write the client's information with the backend's view distance. The
  // human's locale, skin parts, main hand, and chat settings pass through; the
  // view distance is always the cap, so the server never shrinks the chunk send
  // to the human's local render distance.
  function sendClientSettings (reason) {
    if (backendViewDistance === null) return { sent: false, reason: 'no_backend_view_distance' }
    // #22: a client re-entering configuration sends its settings while the move
    // is still dialing. There is no session to write into yet, and the target's
    // own login re-sends the merged packet.
    if (!backendSessionOpen) {
      log('clientSettingsDeferred', { reason })
      return { sent: false, reason: 'no_backend_session' }
    }
    const packet = mergeClientSettings(humanClientSettings, backendViewDistance)
    try {
      backendLeg.write('settings', packet)
      metrics.clientSettingsSent++
      log('clientSettingsSent', {
        reason,
        attached: isAttached(),
        viewDistance: packet.viewDistance,
        locale: packet.locale,
        skinParts: packet.skinParts,
        mainHand: packet.mainHand
      })
      return { sent: true, packet }
    } catch (error) {
      metrics.clientSettingsFailed++
      log('clientSettingsFailed', { reason, error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false, reason: 'write_failed' }
    }
  }

  // The backend's play login carries the view distance it will use. Raise the
  // cache to hold that view, then ask for it: a client that requests less makes
  // the server send less, so the human's local render distance must never be
  // the value the server sees.
  function applyBackendViewDistance (loginPacket) {
    const cap = capFromLogin(loginPacket)
    backendViewDistance = cap
    if (cap === null) {
      log('backendViewDistanceMissing', {})
      return null
    }
    const chunkBound = cache.raiseChunkBound(chunkBoundFor(cap))
    log('backendViewDistance', {
      viewDistance: cap,
      chunkBound,
      chunkBytes: cache.stats().chunkBytes
    })
    sendClientSettings('backend_login')
    return cap
  }

  // The front leg reports the human client's Client Information as it arrives
  // (configuration for a joining client, play for a later change). Record it,
  // and while a human is attached send it to the backend with the cap. Before
  // an attach it is only recorded; attachPlayer sends it once the human plays.
  function noteClientSettings (data = {}) {
    const normalized = normalizeClientSettings(data)
    if (normalized === null) {
      log('clientInformationIgnored', { reason: 'no_usable_fields' })
      return { noted: false, reason: 'no_usable_fields' }
    }
    humanClientSettings = normalized
    log('clientInformation', {
      attached: isAttached(),
      locale: normalized.locale,
      requestedViewDistance: normalized.viewDistance,
      skinParts: normalized.skinParts,
      mainHand: normalized.mainHand
    })
    if (!isAttached()) return { noted: true, sent: false, reason: 'not_attached' }
    return { noted: true, ...sendClientSettings('client_information') }
  }

  // Every clientbound frame that must not cross to the front goes through
  // here: count, log the rare ones. A transfer is handled separately because
  // it has a follow decision (and a refused transfer gets the local notice).
  // The cache and join-synth consult the same policy, so this is the visible
  // half of one decision, not a separate rule.
  function blockClientbound (state, name, policy = {}) {
    metrics.clientboundBlocked++
    bumpName(metrics.clientboundBlockedByName, name)
    if (policy.unknown) {
      metrics.clientboundUnclassified++
      if (!unclassifiedLogged.has(name)) {
        unclassifiedLogged.add(name)
        log('clientboundUnclassified', { state, name })
      }
      return
    }
    if (LOGGED_BLOCKS.has(name)) log('clientboundBlocked', { state, name })
  }

  // #16: the client that can take a control dialog of `state` right now. A play
  // dialog needs a client in play; a configuration gate needs the client that
  // is still following the puppet's configuration. Sent into the wrong phase,
  // the client parses the frame as the wrong packet.
  function canReceiveControl (state) {
    if (state === 'play') return canRelayPlay()
    // A client following a move is in the same configuration phase (#22), so a
    // gate the target asks reaches it there.
    if (state === 'configuration') {
      return attached && (session.state === STATES.CONFIGURING || clientReconfiguring)
    }
    return false
  }

  // #16: the backend leg answered a dialog itself with the configured action,
  // before the frame reached the core. The next show in that state is not a
  // question for the human.
  function notePuppetDialogAnswer ({ state = null } = {}) {
    if (state !== 'play' && state !== 'configuration') return { noted: false }
    puppetAnsweredDialog = state
    log('puppetDialogAnswer', { state })
    return { noted: true, state }
  }

  // One path for every control dialog, in play and in configuration: hold the
  // last unanswered one, relay it to the human who can answer it, and let the
  // serverbound forwarder carry the answer back as the puppet's own frame. No
  // timeout and no auto-click here: a dialog with no client waits. Which dialog
  // the human answers is decided by the leg's policy: a play dialog is always
  // the human's (#20), a configuration gate is #21's.
  function handleControlDialog ({ state, name, buffer, data = {} }) {
    // The puppet answered this one itself before the core heard about it, so
    // there is nothing to hold and no human to ask. The marker is spent here
    // either way: it belongs to exactly one show.
    const answeredByPuppet = name !== 'clear_dialog' && puppetAnsweredDialog === state
    puppetAnsweredDialog = null
    if (answeredByPuppet) {
      metrics.controlDialogsPuppetAnswered++
      log('controlDialogPuppetAnswered', { state, name })
      return { relayed: false }
    }
    if (name === 'clear_dialog') {
      // The server withdrew its question. The client showing it must see that
      // too, or the screen stays open on a dead dialog.
      const outcome = pendingDialog.clear()
      metrics.controlDialogsCleared++
      log('controlDialogCleared', { state, hadPending: outcome.dropped })
    } else {
      const outcome = pendingDialog.show({ state, name, buffer, data })
      metrics.controlDialogsShown++
      log('controlDialogShown', { state, name, attached: isAttached(), replaced: outcome.replaced })
    }

    if (!canReceiveControl(state)) {
      // Nothing to relay to. A shown dialog waits for a client that can answer
      // it; a withdrawal has nothing to withdraw on a client that is not there.
      if (name !== 'clear_dialog') metrics.controlDialogsHeld++
      log('controlDialogNotRelayed', { state, name, attached: isAttached() })
      return { relayed: false }
    }
    frontLeg.writeRaw(buffer, { state, name })
    metrics.controlDialogsRelayed++
    log('controlDialogRelayed', { state, name })
    emit('control_dialog', { state, name })
    return { relayed: true }
  }

  // #16: a client that just arrived in `state` receives the dialog it was not
  // there to answer. Nothing else re-delivers it, because a control dialog is
  // never cached and never replayed.
  function resendPendingDialog (state) {
    const frame = pendingDialog.forAttach(state)
    if (frame === null) {
      if (pendingDialog.held) {
        // A configuration gate and a play attach are not a delivery: the client
        // would parse the frame in its play phase. The dialog keeps waiting.
        log('controlDialogWithheld', { wanted: state, held: pendingDialog.peek()?.state ?? null })
      }
      return { sent: false }
    }
    if (!canReceiveControl(state)) {
      // The client is in the dialog's state but the puppet is not: a gate the
      // backend asked before it moved on is answered by the backend's own
      // session, not by the human (#21 owns that answer).
      log('controlDialogWithheld', {
        wanted: state,
        held: frame.state,
        reason: 'puppet_state',
        backendConfiguring
      })
      return { sent: false }
    }
    try {
      frontLeg.writeRaw(frame.buffer, { state: frame.state, name: frame.name })
    } catch (error) {
      log('controlDialogResendFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false }
    }
    metrics.controlDialogsResent++
    log('controlDialogResent', { state: frame.state, name: frame.name })
    return { sent: true }
  }

  // One accounting for every chat frame the backend never receives, whether it
  // was dropped by policy, carried no text, or the leg could not send it. Kept
  // in one place so the counters and the event cannot diverge.
  function dropChat (name, reason, fields = {}) {
    metrics.serverboundDropped++
    bumpName(metrics.serverboundDroppedByName, name)
    metrics.chatBlocked++
    log('chatBlocked', { name, reason, ...fields })
    emit('chat_blocked', { name, reason })
  }

  // A proxy notice is local proxy speech, not server speech: it never carries
  // the target address, and it is never cached, so no later attach replays it.
  //
  // The notice rides one synthetic advancement toast (#15), added and removed in
  // the same call: the add queues the toast, and the removal leaves the client's
  // advancement map as the server left it. A toast the front leg cannot write
  // falls back to a local system chat line, so a client in play always gets the
  // notice.
  //
  // The path runs in either state. With no client in play the front leg drops
  // the writes, so the call reports that it wrote nothing rather than claiming a
  // delivery nobody saw, and a caller (#22) can queue the notice for the next
  // attach.
  function sendProxyNotice (text, { reason = 'notice' } = {}) {
    // A notice with no text is a caller bug. Say so in the log instead of
    // throwing into a frame handler.
    if (typeof text !== 'string' || text.length === 0) {
      log('proxyNoticeRejected', { reason, error: 'text_required' })
      return { sent: false, kind: null, id: null }
    }
    const id = noticeId(++noticeSeq)
    if (!canRelayPlay()) {
      log('proxyNoticeUndelivered', { reason, id, error: 'no_client_in_play' })
      return { sent: false, kind: null, id }
    }
    const [add, removal] = noticeFrames({ text, id })
    let failed = null
    try {
      frontLeg.write(add.name, add.packet, { synth: true })
      frontLeg.write(removal.name, removal.packet, { synth: true })
    } catch (error) {
      failed = error
      metrics.noticeFallbacks++
      log('proxyNoticeFailed', { reason, id, error: String(error?.message ?? error) })
      // The add may have landed before the removal failed. A removal is
      // idempotent, because it deletes an id the client may never have held, so
      // a retry is the only way back to a clean advancement state.
      try {
        frontLeg.write(removal.name, removal.packet, { synth: true })
      } catch (cleanupError) {
        // Both writes failed after the add landed, so the client keeps this one
        // advancement until its state is rebuilt. The id is never reused, so no
        // later notice names it.
        metrics.noticeGhosts++
        log('proxyNoticeGhost', { reason, id, error: String(cleanupError?.message ?? cleanupError) })
      }
    }
    if (failed === null) {
      metrics.noticesSent++
      log('proxyNotice', { reason, kind: 'toast', id })
      return { sent: true, kind: 'toast', id }
    }
    try {
      const fallback = systemChatFrame(text)
      frontLeg.write(fallback.name, fallback.packet, { synth: true })
      metrics.noticesSent++
      log('proxyNotice', { reason, kind: 'chat', id })
      return { sent: true, kind: 'chat', id }
    } catch (error) {
      log('proxyNoticeLost', { reason, id, error: String(error?.message ?? error) })
      return { sent: false, kind: null, id }
    }
  }

  // The refusal notice is local proxy speech, not server speech. It never
  // carries the target address.
  function sendTransferNotice () {
    transferNoticeSent = true
    return sendProxyNotice(TRANSFER_REFUSED_NOTICE, { reason: 'transfer_refused' })
  }

  // Shared teardown for a session that cannot continue: a backend fault, a
  // server reconfiguration, or a followed transfer. The transfer branch calls
  // this synchronously before ending the leg, because a socket end event can
  // be skipped when the next connect replaces the client first.
  function teardownBackend ({ reason, kickReason = 'backend_disconnected', retainFront = false } = {}) {
    // Per-connection client identity (#17/#18): the next connection announces
    // its own brand and learns its own view distance. The human's client
    // information survives, because the human is still the one playing.
    brandAnnounced = false
    backendViewDistance = null
    backendConfiguring = false
    earlyAttach = null
    pendingEarlyReplay = null
    backendSessionOpen = false
    awaitingBackendLogin = true
    // A dialog belongs to the backend session that asked it; the next session
    // asks its own. A pack is the same: the next session pushes its own, and a
    // copy from the dead one would be offered beside it.
    pendingDialog.clear()
    pendingPacks.clear()
    puppetAnsweredDialog = null
    // A move that reaches an ordinary teardown has already lost its client:
    // the snapshot is no longer a state anyone holds. A retained teardown is
    // the move itself and keeps it.
    if (!retainFront && moveKind !== null) {
      log('moveAbandonedByTeardown', { kind: moveKind, reason })
      move.discard()
      moveKind = null
      clientReconfiguring = false
      clientLeftPlay = false
      targetLoginReady = false
      restoreReplayPending = false
      clearReconfigurationTimer()
    }
    if (session.state === STATES.RECONNECTING) {
      const outcome = session.backendDown({ reason })
      log('backendDown', { reason, frontEnded: false, outcome, repeated: true })
      return outcome
    }
    // #260: the cache of the body whose session ended, and no other body's.
    cache.reset()
    // #233: a reset under a move names the move, so an operator's reset is not
    // filed under a transfer nobody sent. A retained teardown with no move is
    // still the followed-transfer path it has always been.
    log('cacheReset', {
      reason: retainFront ? (moveKind ?? 'transfer') : 'backend_down',
      backendLogins: session.backendLogins
    })
    // #22: a client following a move keeps its connection and the session
    // stays attached to it. One reconnect is armed; the front is never kicked
    // and never told to rejoin.
    if (retainFront && (session.state === STATES.TRANSFERRING || session.state === STATES.ATTACHED)) {
      const retained = session.backendDown({ reason, retainFront: true })
      log('backendDown', { reason, frontEnded: false, retained: true, outcome: retained })
      return retained
    }
    if (isAttached()) {
      // Session invariant: the attaching client cannot survive the backend.
      detachedHandoff()
      session.detach({ reason: `backend_down:${reason}` })
      const outcome = session.backendDown({ reason })
      log('backendDown', { reason, frontEnded: true, outcome })
      frontLeg.end(kickReason)
      emit('backend_down', { reason, target: pendingTransfer ?? pendingMove })
      return outcome
    }
    const outcome = session.backendDown({ reason })
    log('backendDown', { reason, frontEnded: false, outcome })
    emit('backend_down', { reason, target: pendingTransfer ?? pendingMove })
    return outcome
  }

  function clearTransferChain (reason) {
    const had = transferChain.depth > 0
    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    transferChain.visited.clear()
    transferChain.depth = 0
    if (had) log('transferChainReset', { reason })
  }

  // A server we stay on for a while is no longer part of a redirect chain.
  // Without this, returning to a previously visited server later in the same
  // process would look like a loop.
  function scheduleTransferChainReset () {
    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    if (!clock?.setTimeout || !cfg.transfer.chainResetMs) return
    transferChain.resetTimer = clock.setTimeout(() => {
      transferChain.resetTimer = null
      clearTransferChain('dwell')
    }, cfg.transfer.chainResetMs)
    transferChain.resetTimer?.unref?.()
  }

  function refuseTransfer (reason, host, port, valid) {
    metrics.transfersRefused++
    log('transferRefused', {
      reason,
      host: valid ? host : null,
      port: valid ? port : null,
      depth: transferChain.depth
    })
    // Only a client in play can display a notice: a configuring client would
    // parse a play frame as configuration, and writing one would hand it a
    // frame it cannot read. A refusal in that window is dropped rather than
    // queued, because the queue belongs to the pending-notice work in #22.
    if (canRelayPlay() && !transferNoticeSent) sendTransferNotice()
    else if (isAttached() && !transferNoticeSent) {
      log('transferNoticeSkipped', { reason: 'client_not_in_play' })
    }
  }

  // A backend transfer. The frame never crosses to the front; the decision is
  // whether the puppet follows it. Following means: end this session, dial the
  // target on the next reconnect, reset the cache. With a client attached the
  // client keeps its connection and re-enters configuration when the target's
  // configuration begins (#22); with nobody attached the puppet moves alone.
  function handleTransfer (data = {}) {
    metrics.clientboundBlocked++
    metrics.transfersBlocked++
    bumpName(metrics.clientboundBlockedByName, 'transfer')

    const host = typeof data.host === 'string' ? data.host.trim() : ''
    const port = Number(data.port)
    const valid = host.length > 0 && Number.isInteger(port) && port > 0 && port <= 65535
    if (!cfg.transfer.follow) return refuseTransfer('disabled', host, port, valid)
    if (!valid) return refuseTransfer('invalid_target', host, port, valid)
    // One move at a time: a second transfer during a reconfiguration would
    // tear down the connection the first move is holding.
    if (moveKind !== null) return refuseTransfer('in_flight', host, port, true)
    // A client that is still finishing its own configuration cannot start a
    // second one, and the move would write play frames into it. The puppet
    // stays where it is instead.
    if (cfg.transfer.keepConnection && isAttached() && !frontPlayReady) {
      return refuseTransfer('client_not_in_play', host, port, true)
    }
    const key = `${host}:${port}`
    if (transferChain.visited.has(key)) return refuseTransfer('loop', host, port, true)
    if (transferChain.depth >= cfg.transfer.chainLimit) return refuseTransfer('chain_limit', host, port, true)

    if (transferChain.resetTimer) {
      clock?.clearTimeout?.(transferChain.resetTimer)
      transferChain.resetTimer = null
    }
    transferChain.visited.add(key)
    transferChain.depth++
    pendingTransfer = { host, port }
    metrics.transfersFollowed++
    log('transferFollow', { host, port, depth: transferChain.depth })

    // #22: with `transfer.keepConnection` on, the client keeps its connection
    // and the move holds the pre-transfer state so a target that never answers
    // can be rolled back onto the same socket. With the key off, the client is
    // detached and rejoins the proxy once the puppet is warm on the target.
    const begun = beginKeptMove({ target: { host, port }, kind: TRANSFER_KINDS.TRANSFER, reason: 'backend_transfer' })
    if (begun.began) {
      metrics.transfersSeamless++
      log('transferSeamless', { host, port, depth: transferChain.depth })
      emit('transfer_seamless', { host, port })
    }

    teardownBackend({
      reason: 'backend_transfer',
      retainFront: begun.began,
      kickReason: TRANSFER_FOLLOW_REASON
    })
    // A retained client keeps the session in `transferring`, so the ended
    // leg's own end event cannot be told apart from a fault by state alone.
    legHandover = begun.began
    try {
      backendLeg.end('backend_transfer')
    } catch (error) {
      log('transferFollowEndFailed', { error: String(error?.message ?? error) })
    }
  }

  // #22 and #233: start a move that keeps the client's connection, and hold the
  // pre-move state so a target that never answers can be rolled back onto the
  // same socket. One body, because the transfer frame and the operator's
  // document differ in where the intent comes from and not in what it does.
  //
  // Returns `began` false when the key is off or nobody is attached: the caller
  // then takes the ordinary backend-down path, which detaches the client and
  // lets it rejoin the warm target.
  function beginKeptMove ({ target, kind, reason }) {
    if (!cfg.transfer.keepConnection || !isAttached()) return { began: false }
    // #260: a move snapshots the body the session serves now. A transfer left
    // bound to a body an earlier move left behind would snapshot the wrong state,
    // so an idle transfer is bound to the active body's cache before it begins.
    if (move.phase === 'idle') move = createTransfer({ session, cache })
    const begun = move.begin({ target, kind, reason })
    if (begun.began !== true) return { began: false, reason: begun.reason }
    // #260: the snapshot the move now holds is this body's state.
    moveBody = activeBody
    moveKind = kind
    clientReconfiguring = false
    clientLeftPlay = false
    targetLoginReady = false
    restoreReplayPending = false
    frontPlayReady = false
    reconfigurationWaitingWorld = false
    // #87: the loading screen starts on the intent, not on the target's first
    // configuration frame. The client enters its own configuration phase now,
    // so it stops dropping serverbound frames into a play session that no
    // longer exists, and the human sees the move begin instead of a frozen
    // world for the length of the dial. A leg that cannot serve the round
    // reports it here; the first configuration frame tries again below.
    startClientReconfiguration()
    return { began: true, kind, target }
  }

  // #233: an operator moved the puppet from the control document. No packet is
  // behind the intent, so this is the only driver of the machine that is not the
  // server talking.
  //
  // Two cases, and the difference is whether there is a connection to keep:
  //
  //   a client is attached: the same-connection reconfiguration carries it, the
  //     pre-move state is held for a target that never answers, and the client
  //     ends on the target's configuration and play state without reconnecting;
  //
  //   nobody is attached: there is nothing to keep, and the puppet moves alone.
  //     The old session is torn down and one reconnect dials the target, which is
  //     the shape a followed transfer already takes with no client.
  //
  // The counters are the reconfiguration ones. `transfersFollowed`,
  // `transfersSeamless`, `transfersBlocked` and `transfersRefused` describe a
  // server-initiated transfer and do not move here (docs/telemetry.md).
  function startBackendMove ({ target = null, reason = 'operator' } = {}) {
    const host = typeof target?.host === 'string' ? target.host.trim() : ''
    const port = Number(target?.port)
    const valid = host.length > 0 && Number.isInteger(port) && port > 0 && port <= 65535
    const refuse = why => {
      log('backendMoveRefused', { reason: why, host: valid ? host : null, port: valid ? port : null })
      return { started: false, reason: why }
    }
    if (!valid) return refuse('invalid_target')
    // One move at a time, for the same reason a second transfer is refused: a
    // second one would tear down the connection the first is holding. A transfer
    // that is waiting for its dial owns that dial, so the next one carries one
    // target and the operator's would be the one dropped.
    if (moveKind !== null || pendingTransfer !== null) return refuse('in_flight')
    // A move needs a session to move from. `backendSessionOpen` is true only
    // between this session's first frame and the teardown that ends it, so this
    // refuses exactly when the puppet is between sessions: a restore's reconnect
    // is still in flight, or a dial is. Starting a move there would hold a
    // partial or empty snapshot for a client whose screen is not, and its own
    // dial would race the one already out.
    if (!backendSessionOpen) return refuse('backend_not_open')
    // A client still finishing its own configuration cannot start a second one,
    // and the move would write play frames into it. The operator's document is
    // not lost: the next heartbeat asks again.
    if (isAttached() && !frontPlayReady) return refuse('client_not_in_play')

    // The target is handed over once, like a transfer's: the dial reads it on the
    // next reconnect and the follow budget then owns the retries. A target fed
    // again on every retry would reset that budget forever.
    pendingMove = { host, port }
    // An operator's act starts a new chain: a transfer back to a server this
    // session visited before the move is not a redirect loop.
    clearTransferChain('backend_move')

    const attachable = isAttached()
    const begun = beginKeptMove({ target: { host, port }, kind: TRANSFER_KINDS.OPERATOR, reason })
    // With nobody attached the move is the dial itself, so the target stays
    // pending. With a client attached and no move begun, there is no dial to
    // hand a target to.
    if (attachable && begun.began !== true) pendingMove = null
    log('backendMove', {
      host,
      port,
      reason,
      kind: begun.began === true ? TRANSFER_KINDS.OPERATOR : null,
      frontKept: begun.began === true,
      backendLogins: session.backendLogins,
      state: session.state
    })
    emit('backend_move', { host, port, frontKept: begun.began === true })

    teardownBackend({
      reason: 'backend_move',
      retainFront: begun.began === true,
      kickReason: TRANSFER_FOLLOW_REASON
    })
    // The core ended this leg on purpose. Its late end event belongs to the
    // session being replaced, and a retained client keeps the session in
    // `transferring`, so neither can be told apart from a fault by state alone.
    legHandover = true
    try {
      backendLeg.end('backend_move')
    } catch (error) {
      log('backendMoveEndFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    return { started: true, target: { host, port }, kind: begun.began === true ? TRANSFER_KINDS.OPERATOR : null }
  }

  // The orchestrator calls this when a followed target cannot be reached; the
  // next reconnect must use the configured base backend.
  function abortTransfer (reason = 'aborted') {
    const abandoned = pendingTransfer
    pendingTransfer = null
    clearTransferChain(reason)
    log('transferAborted', {
      reason,
      host: abandoned?.host ?? null,
      port: abandoned?.port ?? null
    })
    // #22: an abandoned move with a client attached is restored, not left
    // waiting on a server that will never answer.
    const restored = failTransfer({ reason: `transfer_aborted:${reason}` })
    return { abandoned, ...restored }
  }

  // --- #22: same-connection reconfiguration ---

  // The target (or the restarted session) has sent its first configuration
  // frame. The client's loading screen starts here, on the connection it
  // already holds: before this point there is no configuration to serve, so a
  // target that never answers costs no reconfiguration at all and the client
  // never leaves play.
  function startClientReconfiguration () {
    if (moveKind === null || clientReconfiguring) return { started: false, reason: 'not_moving' }
    const started = typeof frontLeg.startReconfiguration === 'function'
      ? frontLeg.startReconfiguration({ reason: moveKind })
      : { started: false, reason: 'leg_unsupported' }
    if (started?.started !== true) {
      // The front cannot re-enter configuration. The move still runs: the
      // client keeps its play state and gets the target's replay at its login,
      // which is a world rebuild rather than a loading screen.
      metrics.reconfigurationRefusals++
      log('reconfigurationRefused', {
        reason: started?.reason ?? 'unknown',
        kind: moveKind,
        state: session.state
      })
      return { started: false, reason: started?.reason ?? 'unknown' }
    }
    clientReconfiguring = true
    clientLeftPlay = true
    frontPlayReady = false
    metrics.reconfigurationsStarted++
    armReconfigurationTimer()
    log('reconfigurationStarted', { kind: moveKind, target: move.target })
    emit('reconfiguration_started', { kind: moveKind, target: move.target })
    return { started: true, kind: moveKind }
  }

  // A configuration round has a deadline. A target that restarts configuration
  // and then sends nothing would otherwise hold the human's connection open on
  // a loading screen with no end.
  function armReconfigurationTimer () {
    clearReconfigurationTimer()
    const timeoutMs = cfg.transfer.reconfigureTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof clock?.setTimeout !== 'function') return
    reconfigurationTimer = clock.setTimeout(() => {
      reconfigurationTimer = null
      if (restoreReplayPending) {
        // The restore round never completed. The client is unrecoverable on
        // this connection, so it is detached rather than left frozen.
        log('reconfigurationRestoreTimeout', { timeoutMs })
        restoreReplayPending = false
        try { frontLeg.end('transfer_restore_timeout') } catch { /* already gone */ }
        detachPlayer({ reason: 'transfer_restore_timeout' })
        return
      }
      log('reconfigurationTimeout', { kind: moveKind, timeoutMs })
      failTransfer({ reason: 'reconfigure_timeout' })
    }, timeoutMs)
    reconfigurationTimer?.unref?.()
  }

  function clearReconfigurationTimer () {
    if (reconfigurationTimer === null) return false
    clock?.clearTimeout?.(reconfigurationTimer)
    reconfigurationTimer = null
    return true
  }

  // A failed target ends the client's aborted configuration round from the
  // pre-transfer snapshot: the previous server's configuration frames, the
  // finish, and then (when the client is back in play) its state. Nothing
  // dials the old server for this: the snapshot is the state the client had.
  function restoreClientReconfiguration ({ snapshot } = {}) {
    if (!clientReconfiguring || !snapshot) return { replayed: 0 }
    let replayed = 0
    let finish = null
    for (const frame of snapshot.config ?? []) {
      if (frame.name === 'finish_configuration') { finish = frame; continue }
      if (!Buffer.isBuffer(frame.buffer)) continue
      if (!clientboundPolicy('configuration', frame.name).relay) continue
      if (frontLeg.writeRaw(frame.buffer, { state: 'configuration', name: frame.name }) !== false) replayed++
    }
    metrics.configFramesReconfigured += replayed
    restoreReplayPending = true
    // The restore round is a configuration round too. If the client never
    // answers its finish, the deadline ends it.
    armReconfigurationTimer()
    try {
      if (finish && Buffer.isBuffer(finish.buffer)) {
        frontLeg.writeRaw(finish.buffer, { state: 'configuration', name: 'finish_configuration' })
      } else {
        // A session whose finish frame was never cached still has to end the
        // phase the client is in. The frame carries no fields, but it must go
        // out as the configuration packet: the leg builds the bytes because a
        // packet-object write is serialized against the client's current state,
        // and the play table's finish_configuration is a different packet
        // entirely (#87).
        const synthesized = typeof frontLeg.finishConfigurationFrame === 'function'
          ? frontLeg.finishConfigurationFrame()
          : null
        if (Buffer.isBuffer(synthesized)) {
          frontLeg.writeRaw(synthesized, { state: 'configuration', name: 'finish_configuration' })
        } else {
          log('reconfigurationRestoreNoFinish', {})
        }
      }
    } catch (error) {
      log('reconfigurationRestoreFinishFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    log('reconfigurationRestore', { frames: replayed, hadFinish: finish !== null })
    return { replayed }
  }

  // The client is back in play on the restored snapshot. Replay the state the
  // move rolled back to, then say why.
  function completeRestoreReplay () {
    if (!restoreReplayPending || !attached) return null
    restoreReplayPending = false
    frontPlayReady = true
    // Replay from the held snapshot, not the live cache: the cache is reset
    // when the restore's reconnect dials the configured backend, and the client
    // must still receive the state the move rolled back to.
    const outcome = replaySnapshot({
      name: attachedName ?? 'player',
      includeConfig: false,
      reason: 'transfer_restored',
      snapshot: move.snapshot
    })
    move.discard()
    clientLeftPlay = false
    log('reconfigurationRestored', { replayed: outcome.replayed, state: session.state })
    emit('reconfiguration_restored', { replayed: outcome.replayed })
    sendTransferRestoredNotice()
    return outcome
  }

  // Both halves are in: the client is back in play on its own connection and
  // the moved-to session sent its play login. The replay is the new session's
  // state, then the move is committed.
  function maybeCompleteReconfiguration ({ reason = null } = {}) {
    if (moveKind === null || targetLoginReady !== true || clientReconfiguring || !attached) return null
    // #87: the target's login can land before a single chunk frame does, and a
    // client released there is handed an empty world. The replay waits for the
    // first frame that carries terrain; the map_chunk branch of backendPlayFrame
    // retries this call for each one. The configuration deadline still bounds
    // the wait.
    if (cache.stats().chunkFrames === 0) {
      if (!reconfigurationWaitingWorld) {
        reconfigurationWaitingWorld = true
        log('reconfigurationWaitingWorld', { kind: moveKind, state: session.state })
      }
      return null
    }
    const kind = moveKind
    const name = attachedName ?? 'player'
    moveKind = null
    targetLoginReady = false
    clientLeftPlay = false
    reconfigurationWaitingWorld = false
    clearReconfigurationTimer()
    frontPlayReady = true
    const outcome = replaySnapshot({ name, includeConfig: false, reason: reason ?? kind })
    const committed = move.commit()
    metrics.reconfigurationsCompleted++
    log('reconfigurationComplete', {
      kind,
      name,
      replayed: outcome.replayed,
      committed: committed.committed === true,
      state: session.state
    })
    emit('reconfiguration', { kind, replayed: outcome.replayed })
    return outcome
  }

  // The front leg reports the client answered the reconfiguration's finish
  // frame and is in play again (#22).
  function frontReconfigured ({ name = null, uuid = null } = {}) {
    if (restoreReplayPending) {
      clientReconfiguring = false
      clearReconfigurationTimer()
      const outcome = completeRestoreReplay()
      return { reconfigured: true, restored: true, replayed: outcome?.replayed ?? 0 }
    }
    if (moveKind === null) {
      log('reconfigurationIgnored', { reason: 'no_move_in_flight', name, uuid })
      return { reconfigured: false }
    }
    clientReconfiguring = false
    // The deadline stays armed: it now covers the wait for the target's play
    // login, which is what a client parked in play cannot end by itself.
    const outcome = maybeCompleteReconfiguration()
    return {
      reconfigured: true,
      replayed: outcome?.replayed ?? null,
      waitingForLogin: outcome === null
    }
  }

  // The target failed. The client keeps its connection and the pre-transfer
  // state goes back into the cache and (when it is in configuration) onto the
  // client. The session returns to its client and one reconnect goes back to
  // the configured backend.
  function failTransfer ({ reason = 'transfer_failed' } = {}) {
    if (moveKind === null) return { restored: false, reason: 'no_move' }
    const kind = moveKind
    const outcome = move.fail({ reason })
    if (outcome.failed !== true) return { restored: false, state: session.state }
    moveKind = null
    // #260: the target's session ends here, so its body's cache goes with it. The
    // snapshot was restored into the body the move started on, and that state is
    // the client's again, so the session serves that body from now on. A
    // reconfiguration is one body, so nothing moves.
    if (activeBody !== moveBody) {
      cache.reset()
      activateBody(moveBody)
    }
    // #87: the move owns no backend session past this point. The target's leg is
    // ended here so the reconnect back to the configured backend can dial — a
    // leg keeps its client until it is ended, and a connected leg refuses a new
    // target. The handover flag keeps its own end event from reading as the
    // next session faulting.
    legHandover = true
    try {
      backendLeg.end(`transfer_restored:${kind}`)
    } catch (error) {
      log('transferRestoreEndFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
    targetLoginReady = false
    reconfigurationWaitingWorld = false
    clearReconfigurationTimer()
    // #98: a pack the failed target pushed is not the server the client is
    // restored onto. The snapshot the client is put back on is a different
    // server's state, and the held pack dies with the target that sent it.
    pendingPacks.clear()
    // The reconnect this restore armed is a new backend session: its play
    // login is a real login and must re-send the human's client information.
    awaitingBackendLogin = true
    if (clientReconfiguring) {
      // The client is in configuration: finish the aborted round from the
      // snapshot before a notice can reach it.
      restoreClientReconfiguration({ snapshot: outcome.snapshot })
    } else if (clientLeftPlay) {
      // The client already answered the target's finish and holds the target's
      // registries, so its play state is not the previous server's. Open one
      // more configuration round and serve the snapshot through it.
      const started = frontLeg.startReconfiguration?.({ reason: 'transfer_restored' })
      if (started?.started === true) {
        clientReconfiguring = true
        frontPlayReady = false
        restoreClientReconfiguration({ snapshot: outcome.snapshot })
      } else {
        // No leg support for a second round: rebuild the world with the state
        // replay alone and say so.
        log('reconfigurationRestoreRefused', { reason: started?.reason ?? 'unsupported' })
        clientLeftPlay = false
        frontPlayReady = true
        replaySnapshot({
          name: attachedName ?? 'player',
          includeConfig: false,
          reason: 'transfer_restored',
          snapshot: outcome.snapshot
        })
        move.discard()
        sendTransferRestoredNotice()
      }
    } else {
      // The client never left play: it still shows the previous state, which
      // transfer.fail() just put back in the cache.
      frontPlayReady = true
      restoreReplayPending = false
      sendTransferRestoredNotice()
    }
    metrics.reconfigurationsRestored++
    // #233: an operator move that failed says so by name, because the operator is
    // the one who has to act on it. The line below already carries `kind`; this
    // one is what a reader greps for.
    if (kind === TRANSFER_KINDS.OPERATOR) {
      log('backendMoveRestored', {
        reason,
        state: session.state,
        clientConfiguration: clientReconfiguring,
        scheduled: outcome.scheduled === true
      })
    }
    log('transferRestored', {
      kind,
      reason,
      state: session.state,
      clientConfiguration: clientReconfiguring,
      scheduled: outcome.scheduled === true
    })
    emit('transfer_restored', { kind, reason })
    return { restored: true, kind, snapshot: outcome.snapshot }
  }

  function sendTransferRestoredNotice () {
    const outcome = sendProxyNotice(TRANSFER_RESTORED_NOTICE, { reason: 'transfer_restored' })
    log('transferRestoredNotice', { sent: outcome.sent === true, kind: outcome.kind ?? null })
    return outcome
  }


  // Called by the front-leg adapter after gates 1+2 pass and Login Success
  // (forged puppet profile) has been sent. Replay via join-synth.
  // `includeConfig: false` omits the cached configuration replay prefix —
  // the live front leg owns the configuration phase and has already replayed
  // it (see docs/product-core.md); fakes keep the default (config included).
  // #16: the client attached while the backend connection was still in its
  // configuration phase. The front streams the puppet's configuration frames
  // to it; at the play login the session becomes attached; this is the
  // front's report that the client itself is in play and wants its replay.
  function attachConfiguringPlayer ({ name, uuid } = {}) {
    if (!backendConfiguring) {
      log('attachFailed', { reason: 'not_ready', uuid, name, configuring: true })
      emit('attach_failed', { username: name, reason: 'not_ready', phase: 'configuring' })
      return { attached: false, reason: 'not_ready' }
    }
    const attempt = session.attachAttempt({ uuid, name, configuring: true })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name, configuring: true })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    attachedName = name ?? null
    attachedUuid = uuid ?? null
    frontPlayReady = false
    earlyAttach = { name, uuid }
    transferNoticeSent = false
    metrics.attaches++
    metrics.attachesConfiguring++
    telemetry.metric('monoplayer.attaches', 1, { player: name, phase: 'configuring' })
    log('attachConfiguring', { name, backendLogins: session.backendLogins })
    emit('attach_configuring', { name })
    // The client arrived in the middle of the puppet's configuration: frames
    // the backend already sent (the registry, the known packs) are only in the
    // cache, so replay them first and let the live stream carry the rest. The
    // finish frame stays with the core: it is the front's signal that the
    // client may leave configuration.
    for (const frame of cache.snapshot().config) {
      if (frame.name === 'finish_configuration') continue
      if (!clientboundPolicy('configuration', frame.name).relay) continue
      // Count only what actually reached the client: the front refuses a frame
      // whose state is not the client's own.
      if (frontLeg.writeRaw(frame.buffer, { state: 'configuration', name: frame.name }) !== false) {
        metrics.configFramesRelayed++
      }
    }
    // #16: a held configuration gate is not sent here. This call-in runs during
    // the client's login phase, before the library writes Login Success, so a
    // configuration frame written now is read as a login packet. The front
    // reports the configuration phase through configuringReady, and the gate
    // goes out there.
    return { attached: true, configuring: true, replayed: metrics.configFramesRelayed }
  }

  // #99: the human's own body wears the puppet's skin.
  //
  // The front authenticates the client as the human, so the body it draws is the
  // human's own, while the relayed `player_info` lists the puppet and never the
  // human. A client resolves a player's skin from that player's `player_info`
  // entry and falls back to a vanilla default when it holds none, so the human's
  // own body renders steve, alex, or one of the 26.x defaults today.
  //
  // One `add_player` entry for the human's UUID carrying the puppet's textures
  // property is the whole fix, and it is the property the backend sent: the proxy
  // holds no skin of its own and invents none. The entry carries no
  // `update_listed` action, so the tab list does not gain a second line beside
  // the puppet's.
  //
  // #134: the property is the one the puppet's own entry carries, chosen by the
  // UUID the config resolved for the account. One frame can list the whole tab
  // list, so an entry chosen by position is whoever the backend listed first.
  //
  // The client needs no signature on this property: `PlayerInfo.createSkinLookup`
  // asks for a secure property only for players other than the one it controls,
  // which is why the human's own UUID accepts the puppet's signature as-is (and an
  // unsigned copy of it too). Measured on a real 26.2 client through the dev lane:
  // testdata/skin-verdict.md.
  //
  // Five refusals, each a state where the frame would be ignored or would claim a
  // skin the backend never sent: the switch is off, no client is in play, the
  // backend has sent no property, the front gave no identity, or this play state
  // already received one.
  function sendPuppetSkin ({ reason = 'attach' } = {}) {
    if (!cfg.skin.showPuppetSkin) return { sent: false, reason: 'disabled' }
    if (!isAttached() || !frontPlayReady) return { sent: false, reason: 'not_attached' }
    if (puppetSkinProperty === null) return { sent: false, reason: 'no_property' }
    if (attachedUuid === null || attachedName === null) return { sent: false, reason: 'no_identity' }
    if (skinSent) return { sent: false, reason: 'already_sent' }
    let packet
    try {
      packet = skinPlayerInfoPacket({ uuid: attachedUuid, name: attachedName, property: puppetSkinProperty })
    } catch (error) {
      metrics.skinFramesRefused++
      log('puppetSkinRefused', { reason: 'packet', error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false, reason: 'packet' }
    }
    try {
      frontLeg.write(SKIN_FRAME, packet, { synth: true })
    } catch (error) {
      metrics.skinFramesRefused++
      log('puppetSkinRefused', { reason: 'write_failed', error: String(error?.message ?? error).slice(0, 200) })
      return { sent: false, reason: 'write_failed' }
    }
    skinSent = true
    metrics.skinFramesWritten++
    telemetry.metric('monoplayer.skin.frames', 1, { player: attachedName })
    log('puppetSkinSent', {
      name: attachedName,
      reason,
      signed: typeof puppetSkinProperty.signature === 'string'
    })
    emit('puppet_skin', { name: attachedName, signed: typeof puppetSkinProperty.signature === 'string' })
    return { sent: true }
  }

  // #134: one refusal is worth a line. A front that gave no UUID cannot be named
  // by any later frame, and no other event reports it. A missing property arrives
  // a moment later on Paper, a packet or write failure logs `puppetSkinRefused`,
  // and a replay never finds the client out of play because it sets
  // `frontPlayReady` first.
  function logWithheldSkin (outcome, name) {
    if (outcome.sent === false && outcome.reason === 'no_identity') {
      log('puppetSkinWithheld', { name, reason: outcome.reason })
    }
  }

  // The next play state holds no `player_info` entry, so it is owed the skin
  // frame again. An attach is a fresh connection. A reconfiguration is a new
  // `ClientPacketListener`, whose entry map starts empty. Either way the entry
  // the last frame created is gone, and `putIfAbsent` will not restore it.
  function forgetPuppetSkin () {
    skinSent = false
  }

  // The replay half of an attach: the join prefix and the warm state as they
  // stand now. Shared by the warm attach and the early attach, which has
  // already followed the live stream into play.
  function replaySnapshot ({ name, includeConfig = true, reason = 'attach', snapshot = null } = {}) {
    // #218: the record this attach leaves behind says how long it took, which is
    // the one thing about an attach a count cannot show.
    const startedAt = clock?.now?.() ?? Date.now()
    // #134: Excalia moves the puppet mid-session, so a client that re-entered
    // play arrives here owed the frame again.
    forgetPuppetSkin()
    const source = snapshot ?? cache.snapshot()
    const synthesized = synthAttach({
      snapshot: source,
      pose: session.currentPose,
      teleportId: frontTeleportSeq,
      includeConfig
    })
    frontTeleportSeq = synthesized.teleportId

    for (const frame of synthesized.frames) {
      if (frame.synth === 'position') frontLeg.write(frame.name, frame.packet, { synth: true })
      else frontLeg.writeRaw(frame.buffer, { state: 'play', name: frame.name })
    }
    metrics.framesReplayed += synthesized.counts.replayed
    metrics.positionsSynthesized += synthesized.counts.synthesized
    telemetry.metric('monoplayer.replay.frames', synthesized.counts.replayed, { player: name })

    // #18: the human is now the one playing, so their client information goes
    // to the server with the backend cap this session already learned.
    sendClientSettings(reason === 'attach' ? 'attach' : 'early_attach')

    // #99: and the client now draws the human's own body, so the puppet's skin
    // goes on it. After the replay, because the frame is client state the replay
    // does not carry.
    // #134: the heartbeat counts no refusal for a frame that was never attempted,
    // which is how a played body lost its skin without a trace.
    logWithheldSkin(sendPuppetSkin({ reason }), name)

    // #218: what this attach offers, read before the two resends answer it, and
    // what they then write. `answered` and `relayed` would be 0 by construction
    // here, because the record is written before the client can answer anything.
    // The record carries the holder's size and the resend's own count instead.
    // A dialog holder keeps one dialog at a time, so its size is 0 or 1.
    const dialogHeld = pendingDialog.held ? 1 : 0
    const packHeld = pendingPacks.list('play').length

    // #16: a dialog that was waiting for a client goes after the replay, so the
    // client is in play when the screen opens.
    const dialogResent = resendPendingDialog('play').sent === true ? 1 : 0
    // #98: and the packs this connection holds go right beside it, so a
    // reattaching client gets the pack the backend sent once and never repeats.
    const packResent = resendPendingPacks('play').sent

    // #218: one record per attach, and this is the only place one is written.
    // `replaySummary` reads the same snapshot and the same `replayFrames` order
    // the replay above just used, after `synthAttach` accepted it, so a snapshot
    // that could not be replayed never reaches it. Nested values arrive flattened
    // as one string attribute on the OTLP path (docs/telemetry.md).
    log('attach', {
      name,
      reason,
      replayed: synthesized.counts.replayed,
      synthesizedPositions: synthesized.counts.synthesized,
      skippedLegOwned: synthesized.counts.skipped,
      includeConfig,
      backendLogins: session.backendLogins,
      pose: session.currentPose,
      tookMs: (clock?.now?.() ?? Date.now()) - startedAt,
      ...replaySummary(source, { includeConfig }),
      dialogs: { held: dialogHeld, resent: dialogResent },
      packs: { held: packHeld, resent: packResent }
    })
    emit('attach', { name, replayed: synthesized.counts.replayed })
    return { attached: true, replayed: synthesized.counts.replayed, frames: synthesized.frames }
  }

// --- #258: the landing, from the claim to the body ---

  // #260: the body this session serves, and so the cache it writes. Every frame
  // the backend leg delivers belongs to the body the session dialled. The binding
  // is made at the dial, the only place that knows which body the next frame
  // belongs to. The leg holds one connection, so one body is live at a time: a
  // frame can only be the body that connection serves. Two live bodies wait on a
  // leg per body (#261) and a channel to deliver through (#269). A body the
  // session already serves is the same binding: one body, one cache, whichever
  // path named it.
  function activateBody (body) {
    if (activeBody === body) return cache
    activeBody = body
    cache = bodies.cacheFor(body)
    // A move keeps the transfer it started, because that transfer holds the
    // snapshot a failed target is restored to (#22). That covers the move in
    // flight and the restore still waiting for its dial. Any other switch starts a
    // transfer on the cache it will snapshot.
    if (moveKind === null && move.phase === 'idle') move = createTransfer({ session, cache })
    log('bodyCache', { body, bodies: bodies.stats().count })
    return cache
  }

  // How long a claimed body has to reach the state a client can be released on:
  // its configuration and join prefix cached and its play login landed. Bounded
  // because the client is on a loading screen: a body that misses it gets the
  // picker back rather than a promise nobody keeps.
  const CLAIM_WARM_TIMEOUT_MS = 30_000

  // One wait on the injected clock. The core's default clock is inert, and an
  // inert clock cannot wait: the caller is told so instead of being held forever,
  // which is the difference between a refused landing and a hung one.
  function sleepOnClock (ms) {
    return new Promise(resolve => {
      if (typeof clock?.setTimeout !== 'function') return resolve(false)
      const handle = clock.setTimeout(() => resolve(true), ms)
      if (handle === null || handle === undefined) resolve(false)
    })
  }

  // The moment, on the injected clock. A core built without one cannot wait at
  // all, and the landing refuses rather than guessing at a wall clock it was not
  // given.
  function clockNow () {
    return typeof clock?.now === 'function' ? clock.now() : Date.now()
  }

  // The body is attach-ready when a warm attach would be accepted: its play login
  // has landed and its configuration and join prefix are in the cache. Those are
  // the conditions the warm attach gate reads, so a claim cannot release a client
  // that an ordinary attach would refuse. `marker` is the cache's own warm state,
  // reported rather than inferred, so a log line can tell "no marker yet" from
  // "marker seen, nothing to attach with".
  async function awaitBodyWarm ({ timeoutMs = CLAIM_WARM_TIMEOUT_MS, pollMs = 50 } = {}) {
    const deadline = clockNow() + timeoutMs
    for (;;) {
      const stats = cache.stats()
      const state = {
        state: session.state,
        marker: stats.warm === true,
        configFrames: stats.sizes.config,
        prefixFrames: stats.sizes.prefix
      }
      if (session.isAttachReady() && stats.sizes.config > 0 && stats.sizes.prefix > 0) {
        return { attachReady: true, reason: null, ...state }
      }
      if (clockNow() >= deadline) return { attachReady: false, reason: 'body_not_warm', ...state }
      const waited = await sleepOnClock(pollMs)
      if (!waited) return { attachReady: false, reason: 'no_wait', ...state }
    }
  }

  // A granted claim asks for the body the frame named, and this is the only place
  // the puppet dials on a claim: with nobody claiming, nothing is connected (Q6).
  // One body at a time, because the session holds one backend connection: the
  // cache is already the body's (#260), and a body per connection waits on #261
  // with #269's delivery. Losing the body afterwards is its lifecycle (#261), not
  // this path: a dial that never opened a session fails here, and a fault after
  // the landing is the reconnect machine's.
  async function connectClaimedBody ({ body = null, server = null, target = null, name = null } = {}) {
    if (cfg.picker !== true) return { connected: false, reason: 'picker_off', body }
    // One body at a time, and the same body is still one. A claim that returns to
    // the body this session already dialled waits on that body again. A different
    // body is refused because the session holds one backend connection, not
    // because the cache cannot tell two bodies apart: a leg per body is #261, and
    // a channel to deliver through is #269.
    const serving = claimDial?.body ?? claimedBody
    if (serving !== null && body !== serving) {
      log('claimDialRefused', { body, reason: 'one_body', claimed: serving })
      return { connected: false, reason: 'one_body', body: serving }
    }
    if (target === null || typeof target?.host !== 'string' || !Number.isInteger(target?.port)) {
      log('claimDialRefused', { body, reason: 'no_target' })
      return { connected: false, reason: 'no_target', body }
    }
    // A body this session already dialled and has not given up on: either the wait
    // failed last time or the dial is still in flight. The second claim waits on it
    // rather than dialling over a live socket or refusing a client the picker just
    // offered, and a double click on Claim is one landing.
    const waitingOnSameBody = claimDial !== null && claimDial.body === body
    if (waitingOnSameBody) {
      log('claimWaitAgain', {
        body,
        host: claimDial.target.host,
        port: claimDial.target.port,
        state: session.state,
        name
      })
      return finishClaimLanding({ body, server, dial: claimDial.target, bodyWarm: await awaitBodyWarm() })
    }
    if (session.state !== STATES.BOOT && session.state !== STATES.FAILED) {
      log('claimDialRefused', { body, reason: 'session_busy', state: session.state })
      return { connected: false, reason: 'session_busy', body }
    }
    const dial = { host: target.host, port: target.port }
    // A claim is a fresh login on a server that never saw the puppet: no transfer
    // handshake and no cookies from another body (#233's dialect split, the
    // operator arm).
    try {
      backendLeg.setTarget(dial, { keepCookies: false, transfer: false })
    } catch (error) {
      metrics.claimDialsFailed++
      log('claimDialRefused', {
        body,
        host: dial.host,
        port: dial.port,
        reason: 'target_refused',
        error: String(error?.message ?? error).slice(0, 200)
      })
      return { connected: false, reason: 'target_refused', body }
    }
    // #260: the body owns the cache, so the frames this dial brings land in this
    // body's cache and no other's. Bound before the socket opens, because the
    // body's first frame can arrive before connect() resolves.
    activateBody(body)
    metrics.claimDials++
    claimDial = { body, target: { ...dial } }
    log('claimDial', { body, server, host: dial.host, port: dial.port, name })
    // The body's own first dial. The session goes back to boot for it, so a claim
    // after a fault runs the same path as a claim on a lane that started cold.
    session.backendConnecting({ initial: true })
    try {
      await backendLeg.connect()
    } catch (error) {
      metrics.claimDialsFailed++
      // The socket never opened, so this session is serving no body: the next claim
      // dials its own rather than waiting on one that was never there.
      claimDial = null
      log('claimDialFailed', {
        body,
        host: dial.host,
        port: dial.port,
        reason: 'connect_failed',
        error: String(error?.message ?? error).slice(0, 200)
      })
      return { connected: false, reason: 'connect_failed', body }
    }
    return finishClaimLanding({ body, server, dial, bodyWarm: await awaitBodyWarm() })
  }

  // The wait's answer, turned into the front leg's answer. One place decides what a
  // warmed body means, so the first claim and a later wait on the same body cannot
  // disagree.
  function finishClaimLanding ({ body = null, server = null, dial = null, bodyWarm }) {
    if (!bodyWarm.attachReady) {
      metrics.claimDialsFailed++
      log('claimDialFailed', {
        body,
        host: dial?.host ?? null,
        port: dial?.port ?? null,
        reason: bodyWarm.reason,
        state: bodyWarm.state,
        marker: bodyWarm.marker,
        configFrames: bodyWarm.configFrames,
        prefixFrames: bodyWarm.prefixFrames
      })
      return { connected: false, reason: bodyWarm.reason, body, warm: bodyWarm }
    }
    claimedBody = body
    metrics.claimBodies++
    log('claimBodyWarm', {
      body,
      server,
      host: dial?.host ?? null,
      port: dial?.port ?? null,
      state: bodyWarm.state,
      marker: bodyWarm.marker,
      configFrames: bodyWarm.configFrames,
      prefixFrames: bodyWarm.prefixFrames
    })
    return { connected: true, reason: null, body, target: dial, warm: bodyWarm }
  }

  function attachPlayer ({ name, uuid, includeConfig = true } = {}) {
    // #16: the front reports play-ready for a client that attached during the
    // puppet's configuration. It is already attached, so it must not go
    // through the warm attach gate again.
    if (earlyAttach !== null) {
      earlyAttach = null
      if (session.warmReady) {
        frontPlayReady = true
        return replaySnapshot({ name, includeConfig, reason: 'early_attach' })
      }
      // The backend has not finished its own warm yet: hold the replay until
      // the join prefix is complete, so the client gets one coherent world.
      // Live play frames stay withheld until then, or the replay would arrive
      // after state the client already has.
      frontPlayReady = false
      pendingEarlyReplay = { name, includeConfig }
      log('earlyAttachWaitingWarm', { name, backendLogins: session.backendLogins })
      return { attached: true, pending: true, replayed: 0 }
    }
    const attempt = session.attachAttempt({ uuid, name })
    if (!attempt.accepted) {
      log('attachFailed', { reason: attempt.reason, uuid, name })
      emit('attach_failed', attempt)
      return { attached: false, reason: attempt.reason }
    }
    attached = true
    attachedName = name ?? null
    attachedUuid = uuid ?? null
    frontPlayReady = true
    transferNoticeSent = false
    metrics.attaches++
    telemetry.metric('monoplayer.attaches', 1, { player: name })
    return replaySnapshot({ name, includeConfig, reason: 'attach' })
  }

  function detachPlayer ({ reason = 'client_disconnect', answerGate = true } = {}) {
    if (!isAttached()) return { detached: false, state: session.state }
    // #22: the client left mid-move. There is nobody left to restore, so the
    // move becomes the ordinary puppet-only transfer and the held snapshot is
    // released.
    if (moveKind !== null || restoreReplayPending) {
      move.discard()
      moveKind = null
      clientReconfiguring = false
      clientLeftPlay = false
      targetLoginReady = false
      restoreReplayPending = false
      clearReconfigurationTimer()
      log('reconfigurationAbandoned', { reason })
    }
    detachedHandoff()
    // #73: nobody is attached now, which is the gate fallback's own condition,
    // so a configuration gate this client left unanswered is the puppet's. A
    // play dialog stays held: it is the human's (#20).
    answerHeldGateOnDetach({ reason, answerGate })
    // #98: a pack nobody answered is the same condition. A required pack the
    // server hears nothing about can end the session, so the puppet answers it
    // and the held copy stays for the next client.
    if (answerGate === true) answerPendingPacksOnDetach({ reason })
    const result = session.detach({ reason })
    log('detach', { reason, pose: result.pose })
    emit('detach', { reason, pose: result.pose })
    return result
  }

  // #73: a detach is a state change, not a clock. It makes "no client
  // attached" true, and that is the condition the gate fallback names (#21), so
  // the leg answers the gate as the puppet. The leg writes through the same
  // wrapper a headless session uses, so a client that attached in the meantime
  // keeps the gate as theirs.
  //
  // A play dialog is never the fallback's (#20), and a gate the puppet has left
  // configuration for cannot be answered: the packet id is state-scoped, so it
  // stays held for a client that can answer it.
  //
  // A detach a timer caused is still a detach, not a clock: the restore deadline
  // reaching detachPlayer answers the gate for the same reason, because that
  // client is not coming back on its connection.
  function answerHeldGateOnDetach ({ reason = 'client_disconnect', answerGate = true } = {}) {
    const held = pendingDialog.peek()
    if (held === null || held.state !== 'configuration') return
    if (answerGate !== true) return
    if (!backendConfiguring || !backendSessionOpen) {
      log('controlDialogWithheld', {
        name: held.name,
        reason: 'puppet_state',
        detach: reason,
        backendConfiguring,
        backendSessionOpen
      })
      return
    }
    const frame = pendingDialog.forAttach(held.state)
    let outcome = { answered: false, reason: 'leg_cannot_answer' }
    if (typeof backendLeg.answerHeldGate === 'function') {
      try {
        outcome = backendLeg.answerHeldGate({ state: held.state, name: held.name, data: frame?.data ?? null })
      } catch (error) {
        // This runs inside the front leg's socket event: a throw here would
        // escape into it, so a failing leg leaves the gate held instead.
        log('controlDialogWithheld', {
          name: held.name,
          reason: 'leg_error',
          detach: reason,
          error: String(error?.message ?? error).slice(0, 200)
        })
        return
      }
    }
    if (outcome?.answered !== true) {
      // Not answered is a real outcome: a client can attach between the detach
      // and the write, and then the gate is that client's. It stays held.
      log('controlDialogWithheld', { name: held.name, reason: outcome?.reason ?? 'not_answered', detach: reason })
      return
    }
    pendingDialog.clear()
    // The write reported the answer through the puppet-answered marker, and
    // that marker belongs to the gate just dropped: no show follows it to spend
    // it, and a later one is the next client's question.
    puppetAnsweredDialog = null
    metrics.controlDialogsAnsweredOnDetach++
    log('controlDialogAnsweredOnDetach', { name: held.name, state: held.state, detach: reason })
  }

  function detachedHandoff () {
    attached = false
    attachedName = null
    attachedUuid = null
    forgetPuppetSkin()
    frontPlayReady = false
    earlyAttach = null
    pendingEarlyReplay = null
  }

  // --- wiring ---

  function start () {
    if (started) return
    started = true

    backendLeg.setEndHandler(({ reason = 'backend_end' } = {}) => {
      // #258: a body that ended is not a body this session is waiting on. The
      // claim bookkeeping that survives is `claimedBody`, which is what refuses a
      // second body (#260).
      claimDial = null
      // #22: the leg the core ended for a handover reports its end late.
      if (legHandover) {
        legHandover = false
        log('backendEndHandedOver', { reason })
        return
      }
      // #22: the moved-to session faulted while the client follows it, at any
      // stage of the move: before its configuration, during it, or after its
      // play login. The client is restored from the pre-transfer snapshot on
      // the connection it kept; it is never kicked for a move it can survive.
      if (moveKind !== null) {
        // #87: a dial that never opened a session is not the target dying. The
        // target closed the socket before its first frame — the race a transfer
        // intent from the same account makes — so the move waits for the next
        // dial and the follow budget owns the give-up. Failing here restores a
        // client the target may still accept.
        if (!backendSessionOpen) {
          log('backendDialClosed', { reason, kind: moveKind, state: session.state })
          teardownBackend({ reason, retainFront: true })
          return
        }
        log('backendEndDuringMove', { reason, kind: moveKind, state: session.state })
        failTransfer({ reason: `target_lost:${reason}` })
        return
      }
      const reconfigured = reconfigureRequested
      reconfigureRequested = false
      // A transfer already tore the session down synchronously; the late
      // socket end is recorded, not replayed.
      if (session.state === STATES.RECONNECTING) {
        const outcome = session.backendDown({ reason })
        log('backendEndLate', { reason, outcome })
        return
      }
      // A normal fault resets the redirect chain; a followed transfer keeps it.
      if (pendingTransfer === null) clearTransferChain('backend_end')
      teardownBackend({
        reason,
        kickReason: reconfigured ? RECONFIGURE_REASON : 'backend_disconnected'
      })
    })

    backendLeg.setErrorHandler(({ error } = {}) => {
      log('backendError', { error: String(error?.message ?? error) })
    })

    backendLeg.setFrameHandler(frame => {
      const { state, name, buffer, data = {} } = frame
      // #22: a frame from the leg the core ended for a handover belongs to the
      // dead session. It must not enter the target's cache, and it must not
      // clear the handover flag: the old socket's end would then read as the
      // target faulting.
      if (legHandover) {
        metrics.lateFramesAfterHandover++
        return
      }
      backendSessionOpen = true
      // Exact packet journal + one frame counter per backend frame. Lifecycle
      // log records come only from the log() funnel, never one per frame.
      journal.frame({ dir: 's2c', state, name, buffer })
      const metricPolicy = state === 'play' || state === 'configuration'
        ? clientboundPolicy(state, name)
        : null
      telemetry.metric('monoplayer.frames', 1, {
        direction: 's2c',
        state,
        name,
        result: !metricPolicy
          ? 'ignored'
          : metricPolicy.decision === DECISION.BLOCK
            ? 'blocked'
            : metricPolicy.decision === DECISION.CONTROL ? 'control' : 'forwarded'
      })
      if (state === 'configuration') {
        metrics.configFrames++
        backendSessionOpen = true
        // #22: the first configuration frame of a followed move is where the
        // client's loading screen starts. The target has accepted the session,
        // so there is a configuration to serve.
        if (moveKind !== null && !clientReconfiguring) startClientReconfiguration()
        announceBrand()
        const policy = clientboundPolicy('configuration', name)
        if (name === 'ping') {
          // Per-leg latency ping: answer on the puppet leg, never replay.
          backendLeg.write('pong', { id: data.id })
          return
        }
        if (name === 'transfer') {
          // A configuration-phase transfer happens before the play login, when
          // the session has no warm state to move. v1 blocks it (counted) and
          // leaves the session where it is; the play-state follow path is the
          // product behavior.
          metrics.transfersBlocked++
          log('transferBlocked', {
            state: 'configuration',
            host: typeof data.host === 'string' ? data.host : null,
            port: Number.isInteger(data.port) ? data.port : null
          })
          return
        }
        // #16: the backend is in its configuration phase, whatever this frame
        // turns out to be. Record it first, so a client may attach now and
        // follow this stream live — a gate can be the first frame of the phase.
        if (!backendConfiguring) {
          backendConfiguring = true
          log('backendConfiguring', { state: session.state })
        }
        // #98: a configuration-phase pack is the human's to answer, like a gate,
        // and the held copy is what a client arriving later receives.
        if (name === 'add_resource_pack' || name === 'remove_resource_pack') {
          handleResourcePack({ state: 'configuration', name, buffer, data })
          return
        }
        if (policy.decision === DECISION.CONTROL) {
          // #16: a configuration gate is the human's to answer. The holder keeps
          // it while no client follows this stream.
          handleControlDialog({ state: 'configuration', name, buffer, data })
          return
        }
        if (policy.decision === DECISION.BLOCK) {
          blockClientbound('configuration', name, policy, data)
          return
        }
        if (!policy.cache) return
        const pushed = cache.push('configuration', name, buffer, data)
        const clientInConfiguration = session.state === STATES.CONFIGURING || clientReconfiguring
        if (pushed.cached && policy.relay && clientInConfiguration) {
          if (frontLeg.writeRaw(buffer, { state: 'configuration', name }) !== false) {
            metrics.configFramesRelayed++
            if (clientReconfiguring) metrics.configFramesReconfigured++
          }
        }
        // #87: the round now covers the dial as well, so a target that is
        // configuring is not a target that stalled. Each frame the target sends
        // re-arms the deadline; one that stops sending still ends the round.
        if (clientReconfiguring) armReconfigurationTimer()
        return
      }
      if (state !== 'play') {
        // Handshake/login frames (encryption_begin, compress, login success)
        // belong to the puppeted backend connection only. Replaying them in
        // the front's play state makes the client read packet id 0x01 as
        // add_entity and reject the joining client.
        metrics.nonPlayFramesIgnored++
        return
      }
      backendPlayFrame({ name, buffer, data })
    })

    frontLeg.setLoginStartHandler(payload => {
      const decision = processLoginStart(payload)
      // The core cannot send Login Success; it only decides. A denial
      // returning to the adapter happens before any Login Success packet.
      return decision
    })

    frontLeg.setServerboundHandler(serverbound => {
      const name = serverbound.name
      const state = serverbound.state ?? 'play'
      const attachedNow = isAttached()
      // Classify before recording so the frame counter carries the outcome.
      const decision = attachedNow
        ? classifyServerbound(name, serverbound.data, { mode: cfg.chat, state })
        : { action: 'drop', chat: false }
      journal.frame({ dir: 'c2s', state, name, buffer: serverbound.buffer })
      telemetry.metric('monoplayer.frames', 1, {
        direction: 'c2s',
        state,
        name,
        result: decision.action === 'forward' ? 'forwarded' : 'dropped'
      })
      if (!attachedNow) {
        metrics.serverboundNotAttached++
        log('serverboundIgnored', { name: serverbound.name, reason: 'not_attached' })
        return
      }
      // #22: a retained client outlives the backend leg for the length of a
      // move. The frame belongs to the connection being handed over and cannot
      // be written into the new one, so it is dropped and counted.
      if (!backendSessionOpen) {
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, name)
        log('serverboundDropped', { name, state, reason: 'backend_moving' })
        return
      }
      if (decision.action === 'rewrite') {
        // #18: the human's client information reaches the backend only in the
        // form the proxy owns. noteClientSettings records it and writes the
        // merged packet, so the client's own view distance never crosses.
        const outcome = noteClientSettings(serverbound.data ?? {})
        if (outcome.sent) {
          metrics.clientSettingsRewritten++
          metrics.serverboundForwarded++
          bumpName(metrics.serverboundByName, serverbound.name)
        } else {
          // No usable fields, no learned cap, or a failed write: the frame did
          // not reach the backend, so the ledger says dropped, not forwarded.
          metrics.serverboundDropped++
          bumpName(metrics.serverboundDroppedByName, serverbound.name)
        }
        log('serverboundRewrite', {
          name: serverbound.name,
          noted: outcome.noted === true,
          sent: outcome.sent === true,
          reason: outcome.reason ?? null
        })
        return
      }
      if (decision.action === 'speak') {
        // #19: the human's text is spoken by the puppet leg, never forwarded.
        // The frame carried the human's signature and offset, which the backend
        // cannot use; the leg signs the text again as the puppet.
        const spoken = chatText(name, serverbound.data)
        if (!spoken || typeof backendLeg.chat !== 'function') {
          dropChat(name, spoken ? 'leg_has_no_chat' : 'no_text')
          return
        }
        try {
          backendLeg.chat(spoken.text)
          metrics.chatSent++
          log('chatSent', { name, command: spoken.command, chars: spoken.text.length })
          emit('chat_sent', { name, command: spoken.command })
        } catch (error) {
          dropChat(name, 'send_failed', { error: String(error?.message ?? error).slice(0, 200) })
        }
        return
      }
      if (decision.action === 'drop') {
        if (decision.chat) {
          dropChat(name, decision.reason)
          return
        }
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, serverbound.name)
        return
      }
      // #16: the packet id is state-scoped, so the frame must be written into
      // the state it was sent in. A configuration answer that arrives after the
      // play login, or a play frame while the puppet is still configuring, is
      // the wrong packet id and would end the backend session.
      if ((state === 'configuration') !== backendConfiguring) {
        metrics.serverboundDropped++
        bumpName(metrics.serverboundDroppedByName, name)
        log('serverboundDropped', { name, state, reason: 'puppet_state_mismatch' })
        // #98: a client that replayed a configuration-phase pack after the
        // puppet left configuration can still load it; its answer has no packet
        // id to travel under, and the puppet already said accepted and loaded.
        if (name === 'resource_pack_receive') {
          log('resourcePackAnswerUnforwardable', { state, uuid: serverbound.data?.uuid ?? null })
        }
        return
      }
      if (state === 'play') {
        session.setPose(
          capturePose(session.currentPose, serverbound.name, serverbound.data)
        )
      }
      // #16: the frame carries its own state. A configuration answer reaches a
      // puppet that is still in configuration, where a play-state write would
      // be a different packet id.
      backendLeg.writeRaw(serverbound.buffer, { state, name: serverbound.name })
      // The human answered a control dialog: the held copy is no longer
      // pending, so a later attach is not shown a question already answered.
      const answered = pendingDialog.answer({ state, name: serverbound.name })
      if (answered.answered) {
        metrics.controlDialogsAnswered++
        log('controlDialogAnswered', { name: serverbound.name, state: answered.state, dialog: answered.name })
      }
      // #98: the human's own pack status reached the backend. The held copy is
      // not released: the pack stays installed for the next client.
      if (name === 'resource_pack_receive') {
        const packUuid = serverbound.data?.uuid ?? null
        const result = serverbound.data?.result ?? null
        const noted = pendingPacks.answered({ uuid: packUuid, result })
        metrics.resourcePacksAnswered++
        log('resourcePackAnswered', {
          state,
          uuid: packUuid,
          result,
          terminal: noted.terminal === true,
          held: pendingPacks.held
        })
        emit('resource_pack_answer', { state, uuid: packUuid, result })
      }
      metrics.serverboundForwarded++
      bumpName(metrics.serverboundByName, serverbound.name)
      if (ACTION_SERVERBOUND.has(serverbound.name)) {
        log('serverboundAction', { name: serverbound.name, attached: true })
      }
    })

    frontLeg.setDetachHandler(({ reason = 'player_quit' } = {}) => {
      detachPlayer({ reason })
    })

    // #16: the client entered its own configuration phase; a gate the backend
    // asked before the client arrived is delivered there.
    frontLeg.setConfiguringHandler(({ name } = {}) => {
      configuringReady({ name })
    })

    // #22: the client answered the reconfiguration's finish frame and is in
    // play again on its own connection. A leg without the call-in keeps the
    // play state and gets the target's replay at its login instead.
    if (typeof frontLeg.setReconfiguredHandler === 'function') {
      frontLeg.setReconfiguredHandler(({ name = null, uuid = null } = {}) => {
        frontReconfigured({ name, uuid })
      })
    }

    // #258: the landing. A granted claim is what dials a body, so the front asks
    // the core for one and the core owns the dial and the warm wait. A leg with no
    // picker wiring keeps refusing the claim it never receives, and a lane with
    // `picker` off refuses every landing (`picker_off`).
    if (typeof frontLeg.setConnectClaimedBody === 'function') {
      frontLeg.setConnectClaimedBody(payload => connectClaimedBody(payload))
    }

    log('start', { whitelist: identity.whoAmI().whitelist, puppet: cfg.puppet, started: true })
    emit('start')
  }

  // Backend play frame routing (per-leg keep-alive/pong answering, pose
  // teleports, cache, live forwarding).
  // #16: the front reports that the attached client entered its own
  // configuration phase. This is the first moment a configuration frame reaches
  // it in a state it parses, so a held configuration gate goes out here.
  function configuringReady ({ name = null } = {}) {
    // #98: the client is in its own configuration phase now, which is the one
    // moment a configuration-phase pack can reach it. The attach call-in runs
    // later, at play login, so a warm attach has nothing else to hang this on.
    const packs = resendPendingPacks('configuration')
    if (!attached || session.state !== STATES.CONFIGURING) {
      log('configuringReadyIgnored', { reason: 'not_configuring', state: session.state, packs: packs.sent })
      return { attached: false, sent: false, packs: packs.sent }
    }
    const outcome = resendPendingDialog('configuration')
    log('configuringReady', { name, sent: outcome.sent === true, packs: packs.sent })
    return { attached: true, sent: outcome.sent === true, packs: packs.sent }
  }

  // The replay a pre-warm client still owes: sent once, when the join prefix
  // is warm, whether the warm came from the marker or the readiness fallback.
  function replayPendingEarly () {
    if (pendingEarlyReplay === null || !cache.warm) return null
    const pending = pendingEarlyReplay
    pendingEarlyReplay = null
    frontPlayReady = true
    return replaySnapshot({ name: pending.name, includeConfig: pending.includeConfig, reason: 'early_attach' })
  }

  function backendPlayFrame ({ name, buffer, data }) {
    metrics.backendFrames++
    backendSessionOpen = true
    // #87: the round's deadline covers the wait for the target's state, and a
    // frame that arrives proves the target is alive: re-arm it, as the
    // configuration branch does. A target that stops sending still ends the
    // round.
    if (moveKind !== null) armReconfigurationTimer()

    // #16: an early-attach client gets its replay as soon as the join prefix is
    // warm. The live path warms on the readiness fallback as well as on the
    // marker, so this is checked per frame as well as at the marker below.
    replayPendingEarly()

    // #98: the resource pack is a control frame the human answers, so it never
    // reaches the cache: the pending holder keeps the one copy.
    if (name === 'add_resource_pack' || name === 'remove_resource_pack') {
      handleResourcePack({ state: 'play', name, buffer, data })
      return
    }

    if (name === 'bundle_delimiter') {
      // Bundle delimiters are a transport grouping, not state. Replaying them
      // alongside individually cached packets makes the client parse the
      // bundle's concatenated payload as one oversized packet. Drop the
      // delimiter and relay the enclosed packets individually.
      metrics.bundleDelimitersDropped++
      return
    }

    if (name === 'player_info') {
      // #99: the puppet's skin, as the server itself states it. A backend lists
      // the puppet with its own textures property, and that property is the only
      // skin the proxy will ever send. A later frame may carry a different skin
      // (a server-side skin change); the client keeps the entry it holds, so the
      // frame is recorded and the replay already served is left alone.
      //
      // #134: the property is the one the puppet's own entry carries, and no
      // other. See testdata/skin-verdict.md for what picking by position did on
      // the live lane.
      const puppetUuid = cfg.puppet.uuid ?? null
      const property = texturesPropertyOf(data, { uuid: puppetUuid })
      // #134: no UUID is no skin, and guessing by position is how a stranger's
      // skin reached the human's body. A config that names no puppet UUID takes
      // none, and says so once, on the first frame that did carry a skin.
      if (property === null && puppetUuid === null && cfg.skin.showPuppetSkin && !puppetSkinUnidentifiedLogged && carriesTextures(data)) {
        puppetSkinUnidentifiedLogged = true
        log('puppetSkinUnidentified', { reason: 'no_puppet_uuid' })
      }
      if (property !== null) {
        const changed = puppetSkinProperty === null || puppetSkinProperty.value !== property.value
        // #134: both values, once, when they differ. The ticket could not tell
        // whether a backend re-signs its property per login or whether the
        // comparison was comparing the wrong things. The next reader can.
        const was = puppetSkinProperty === null ? null : puppetSkinProperty.value
        puppetSkinProperty = property
        if (changed) {
          log('puppetSkinKnown', {
            uuid: puppetUuid,
            signed: typeof property.signature === 'string',
            was,
            value: property.value
          })
        }
        // A backend that lists the puppet after its play login is the ordinary
        // case on Paper, so the property often arrives after the attach replay
        // and this call is what reaches the client that is already in play.
        if (changed) logWithheldSkin(sendPuppetSkin({ reason: 'property_arrived' }), attachedName)
      }
    }

    if (name === 'login') {
      // Cache the login first: a move that completes on this frame builds its
      // replay from the cache, and the replay must carry the login.
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      // The real backend login event backendLogins counts. Attach/detach never
      // touches this, and a doubled replayed login frame during an already-warm
      // session is not a login: one real login per backend connection.
      if (awaitingBackendLogin) {
        awaitingBackendLogin = false
        const login = session.backendLogin({ entityId: data.entityId })
        backendConfiguring = false
        scheduleTransferChainReset()
        applyBackendViewDistance(data)
        log('backendLogin', {
          entityId: data.entityId,
          backendLogins: session.backendLogins,
          fromConfiguring: login.wasConfiguring === true,
          fromTransfer: login.fromTransfer === true,
          restored: login.restored === true
        })
        emit('backend_login', { entityId: data.entityId })
        // #22: the moved-to session's play login. The client's replay waits for
        // the client itself to be back in play on its own connection.
        if (login.fromTransfer === true || login.restored === true) {
          targetLoginReady = true
          maybeCompleteReconfiguration()
        }
      }
      // Cache-only: a login frame is replayed to an attach, never relayed
      // into an already-playing client's connection.
      return
    }

    if (name === 'keep_alive') {
      // Backend leg answers its own keep-alives; never relayed to the front.
      backendLeg.write('keep_alive', { keepAliveId: data.keepAliveId })
      return
    }
    if (name === 'ping') {
      backendLeg.write('pong', { id: data.id })
      return
    }
    if (name === WARM_MARKER) {
      // P1#2: every backend chunk batch finish is answered with
      // chunk_batch_received on the backend leg — warm or not. The first
      // (unwarm) batch also completes the warm pin; after warm the marker is
      // ordinary cacheable/relayed state.
      const wasWarm = cache.warm
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      backendLeg.write('chunk_batch_received', { chunksPerTick: 32 })
      if (!wasWarm) {
        session.warmComplete({ marker: name })
        replayPendingEarly()
      } else if (canRelayPlay()) {
        frontLeg.writeRaw(buffer, { state: 'play', name })
      }
      return
    }

    if (name === 'position') {
      // Position is per-leg owned: confirm on the backend leg, follow the
      // backend teleport in the session pose, and (only when someone is
      // attached) synthesize a fresh position with a proxy-owned teleportId.
      // Never cached, never replayed.
      session.setPose(capturePose(session.currentPose, 'position', data, { backend: true }))
      backendLeg.write('teleport_confirm', { teleportId: data.teleportId })
      if (canRelayPlay()) {
        frontTeleportSeq++
        frontLeg.write('position', {
          teleportId: frontTeleportSeq,
          x: data.x,
          y: data.y,
          z: data.z,
          yaw: data.yaw,
          pitch: data.pitch,
          dx: 0,
          dy: 0,
          dz: 0,
          flags: 0
        }, { synth: true })
        metrics.positionsSynthesized++
      }
      if (cache.push('play', name, buffer, data).cached) metrics.framesCached++
      return
    }
    if (name === 'transfer') {
      handleTransfer(data)
      return
    }

    if (name === 'start_configuration') {
      // #22: a reconfiguration cannot start under a move that is already
      // holding the client and the cache. It is recorded and left alone.
      if (moveKind !== null) {
        metrics.clientboundBlocked++
        bumpName(metrics.clientboundBlockedByName, name)
        log('backendReconfigureIgnored', { reason: 'move_in_flight', kind: moveKind })
        return
      }
      blockClientbound('play', name, clientboundPolicy('play', name), data)
      // With the key on, the front serves the restarted phase on the client's
      // own connection. With the key off the puppet leg is ended on purpose,
      // and the normal backend-down path kicks the client with a clear reason.
      if (!cfg.transfer.keepConnection) {
        log('backendReconfigure', { name, keepConnection: false })
        reconfigureRequested = true
        try {
          backendLeg.end('backend_reconfigure')
        } catch (error) {
          log('backendReconfigureFailed', { error: String(error?.message ?? error) })
        }
        return
      }
      // Kept connection: the puppet follows the restarted phase on its own
      // backend connection (the protocol library answers the finish and
      // re-enters configuration), and an attached client follows it on the
      // connection it holds. Neither is detached and no leg is ended.
      const begun = isAttached()
        ? move.begin({ kind: TRANSFER_KINDS.RECONFIGURE, reason: 'backend_reconfigure' })
        : { began: false }
      if (begun.began) {
        moveKind = TRANSFER_KINDS.RECONFIGURE
        clientReconfiguring = false
        targetLoginReady = false
        restoreReplayPending = false
        frontPlayReady = false
        reconfigurationWaitingWorld = false
        // #87: the same ordering as a followed transfer. The restarted phase is
        // a configuration round for the client, and it starts on the intent.
        startClientReconfiguration()
      }
      // The restarted phase is a new session state: the old configuration
      // replay and join prefix would otherwise sit beside it.
      cache.reset()
      pendingDialog.clear()
      pendingPacks.clear()
      awaitingBackendLogin = true
      backendConfiguring = false
      log('backendReconfigure', {
        keepConnection: true,
        followed: begun.began,
        state: session.state,
        cacheReset: true
      })
      return
    }

    const policy = clientboundPolicy('play', name)
    if (policy.decision === DECISION.CONTROL) {
      handleControlDialog({ state: 'play', name, buffer, data })
      return
    }
    if (policy.decision === DECISION.BLOCK) {
      blockClientbound('play', name, policy, data)
      return
    }
    if (policy.decision === DECISION.PER_LEG) return // handled above; defensive
    if (policy.decision === DECISION.LIVE_ONLY) {
      const chatFrame = CHAT_FRAMES.has(name)
      if (chatFrame && !chatRelayAllowed(name, cfg.chat)) return
      if (chatFrame) metrics.chatRelayed++
      if (canRelayPlay()) frontLeg.writeRaw(buffer, { state: 'play', name })
      return
    }
    if (policy.decision === DECISION.CACHE_ONLY) {
      const pushed = cache.push('play', name, buffer, data)
      if (pushed.cached) metrics.framesCached++
      return
    }

    const pushed = cache.push('play', name, buffer, data)
    if (pushed.cached) metrics.framesCached++
    // #87: the first terrain frame is what lets a held move release its client.
    if (name === 'map_chunk') maybeCompleteReconfiguration()
    if (canRelayPlay()) frontLeg.writeRaw(buffer, { state: 'play', name })
  }

  async function stop ({ reason = 'stopped' } = {}) {
    // No gate answer on the way out: the backend socket closes on the next
    // statement, so the answer would be a frame nobody receives.
    if (isAttached()) detachPlayer({ reason: `stopping:${reason}`, answerGate: false })
    try { backendLeg.end(reason) } catch {}
    log('stop', { reason })
  }

  const handle = {
    version: cfg.version,
    config: cfg,
    // The cache of the body this session is serving, read at the call because a
    // claim rebinds it (#260). A lane with no claim serves its configured body.
    get cache () { return cache },
    // The registry, so a rung or the panel can name every body the process holds
    // a cache for instead of assuming there is one.
    bodies,
    identity,
    session,
    metrics,
    on,
    log,
    logs: () => [...logs],
    // front pipeline call-ins (real front-leg adapter drives these):
    processLoginStart,
    attachConfiguringPlayer,
    configuringReady,
    notePuppetDialogAnswer,
    noteClientSettings,
    processVerifySession,
    attachPlayer,
    detachPlayer,
    abortTransfer,
    // #258: the landing. The front leg calls this when a claim is granted, and it
    // is the only place a claim dials a body.
    connectClaimedBody,
    // #233: the operator's move, driven from the control document rather than a
    // packet. The orchestrator calls it when its heartbeat sees a desired backend
    // that is not the one in use.
    startBackendMove,
    // #22: the front leg reports the client answered the reconfiguration's
    // finish frame and is back in play on its own connection.
    frontReconfigured,
    notice: sendProxyNotice,
    // lifecycle:
    start,
    stop,
    get started () { return started },
    get attached () { return isAttached() },
    get backendViewDistance () { return backendViewDistance },
    get backendConfiguring () { return backendConfiguring },
    get pendingDialog () { return pendingDialog },
    get pendingPacks () { return pendingPacks },
    get frontPlayReady () { return frontPlayReady },
    // #22: the move in flight, the client's own configuration phase, and the
    // target's play login. The rungs read these instead of inferring them.
    get move () { return move },
    get moveKind () { return moveKind },
    get reconfiguring () { return moveKind !== null },
    get clientReconfiguring () { return clientReconfiguring },
    get targetLoginReady () { return targetLoginReady },
    get restoring () { return restoreReplayPending },
    get backendSessionOpen () { return backendSessionOpen },
    // #258: the body a claim landed, or null. One body per session: a second
    // body's session is #261 and its delivery is #269.
    get claimedBody () { return claimedBody },
    get backendLeg () { return backendLeg },
    get frontLeg () { return frontLeg }
  }

  return handle
}

// --- CLI (no sockets; see docs/product-core.md for the --start plan) ---

export const USAGE = `monoplayer — one Minecraft account, one backend, many clients

Usage:
  node src/service/monoplayer.js --print-config     print the resolved config and exit
  node src/service/monoplayer.js --config <file>    load a JSON config
  node src/service/monoplayer.js --start            start the live legs (G1 + B1 lane)

Config (JSON via --config, then env, then defaults):
  MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind address
  MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
  MONOPLAYER_PUPPET_ACCOUNT                           account selector: uuid, alias, or name
  MONOPLAYER_PUPPET_ACCOUNTS_DIR                      account tree (default .secrets/accounts)
  MONOPLAYER_PUPPET_UUID                              assertion: resolved account uuid must match
  MONOPLAYER_PUPPET_USERNAME                          assertion: resolved profile name must match
  MONOPLAYER_PUPPET_CACHE_DIR                         raw custody dir override (deprecated)
  MONOPLAYER_PUPPET_CACHE_ACCOUNT                     legacy selector (deprecated; ignored)
  MONOPLAYER_DIALOG_ACTION                            configuration-gate answer: first|last|<label substring>
  MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path
  MONOPLAYER_CONTROL_FILE                             desired.json: the control
                                                      document that moves the
                                                      puppet's backend, and turns
                                                      on the whitelist's reload at
                                                      each login (default null)
  MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH             1 honours desired.json, on the
                                                      next connect and on every
                                                      heartbeat tick; 0 leaves the
                                                      configured backend (default 0)
  MONOPLAYER_VERSION                                  protocol pin (default 26.1)
  MONOPLAYER_CHAT                                     read-only (default), commands, full, or off
  MONOPLAYER_PICKER                                   1 serves a joining client the recorded configuration
                                                      baseline and the server picker when the lane has no
                                                      backend, and records the pick (default 0)
  MONOPLAYER_LOG                                      JSONL log file (default stdout)
  OTEL_EXPORTER_OTLP_ENDPOINT                         OTLP/HTTP collector base URL (telemetry off when unset)
  OTEL_SERVICE_NAME / OTEL_SERVICE_VERSION            telemetry service identity
  MONOPLAYER_JOURNAL_DIR                              exact packet journal directory (journal off when unset)
  MONOPLAYER_JOURNAL_MAX_BYTES                        one shard's seal threshold (default 67108864)
  MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES                  journal directory budget, pruned on start and
                                                      after every seal (default 268435456)
  MONOPLAYER_JOURNAL_MAX_AGE_MS                       journal age cap, pruned the same way; 0 keeps
                                                      the byte budget alone (default 172800000, 48 hours)

--start brings up the live backend leg (authenticated puppet via the G1 token
custody in .secrets/accounts/<uuid>/), waits until the state cache holds the
backend configuration frames + join prefix (warm marker preferred), then
starts the front leg for whitelisted attaching players. See
docs/product-core.md and docs/custody.md.`

const has = (argv, name) => argv.includes(name)

export async function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  if (has(argv, '--help') || (argv.length === 0)) {
    io.stdout.write(USAGE + '\n')
    return 0
  }
  if (has(argv, '--print-config')) {
    const docPath = flag(argv, '--config')
    const doc = docPath ? JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(docPath, 'utf8'))) : {}
    io.stdout.write(JSON.stringify(loadConfig(doc), null, 2) + '\n')
    return 0
  }
  if (has(argv, '--start')) {
    // Live legs live behind a dynamic import: with no --start the CLI keeps
    // the pure-core property (no sockets, no minecraft-protocol load).
    const { startLive } = await import('./start-live.js')
    return startLive({ argv })
  }
  io.stdout.write(USAGE + '\n')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}

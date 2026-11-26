// --start orchestration: bring the live B1 legs up with the simplest path.
//
//   node src/service/monoplayer.js --start [--config file.json]
//
// Config priority: --config JSON < env overlay < defaults
//
//   MONOPLAYER_FRONT_HOST / MONOPLAYER_FRONT_PORT       front leg bind
//   MONOPLAYER_BACKEND_HOST / MONOPLAYER_BACKEND_PORT   puppet session target
//   MONOPLAYER_PUPPET_ACCOUNT                           selector: uuid, alias, or name
//   MONOPLAYER_PUPPET_ACCOUNTS_DIR                      account tree (default .secrets/accounts)
//   MONOPLAYER_PUPPET_UUID                              assertion: resolved uuid must match
//   MONOPLAYER_PUPPET_USERNAME                          assertion: resolved name must match
//   MONOPLAYER_PUPPET_CACHE_DIR                         raw custody dir override (deprecated)
//   MONOPLAYER_PUPPET_CACHE_ACCOUNT                     legacy selector (deprecated; ignored)
//   MONOPLAYER_PREAUTH_MAX_CONNECTIONS                  total concurrent
//                                                       connections in the pre-auth
//                                                       window (default 16, #201)
//   MONOPLAYER_PREAUTH_DEADLINE_MS                      how long one connection may
//                                                       stay in that window before
//                                                       its socket is destroyed
//                                                       (default 30000, #205)
//   MONOPLAYER_ATTACH_WHITELIST                         attach whitelist file path.
//                                                       Naming it reloads the list at
//                                                       each login (#229), and it is
//                                                       what turns the control
//                                                       document on
//   MONOPLAYER_ALLOWED_SERVERS                          allowed-servers.json, the
//                                                       servers the picker offers
//                                                       (#262)
//   MONOPLAYER_ALLOWED_SERVERS_SEED                     the allowed-servers.json Git
//                                                       commits, which answers when the
//                                                       live file is absent or unreadable
//   MONOPLAYER_VERSION                                  protocol pin (default 26.1)
//   MONOPLAYER_CHAT                                     read-only (default),
//                                                       commands, full, or off
//   MONOPLAYER_OFFLINE_LEGS                             1 composes the offline front and
//                                                       backend legs, so the lane
//                                                       needs no account, no custody
//                                                       chain and no Microsoft auth.
//                                                       A test lane only. The live
//                                                       lane must never name it
//                                                       (default 0)
//   MONOPLAYER_PICKER                                   1 holds a joining client in
//                                                       configuration and shows it the
//                                                       server picker when the lane has
//                                                       no backend; a pick is recorded
//                                                       and refused until #267 (default 0)
//   MONOPLAYER_TRANSFER_KEEP_CONNECTION                 1 keeps the client's
//                                                       connection through a
//                                                       transfer (#22); off by default
//   MONOPLAYER_LOG                                      JSONL log file (default: stdout)
//   OTEL_EXPORTER_OTLP_ENDPOINT                         OTLP/HTTP collector base URL
//   OTEL_SERVICE_NAME / OTEL_SERVICE_VERSION            telemetry service identity
//   MONOPLAYER_JOURNAL_DIR                              exact packet journal directory
//   MONOPLAYER_JOURNAL_MAX_BYTES                        one shard's seal threshold
//                                                       (default 128 MiB)
//   MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES                  journal directory budget, pruned on
//                                                       start and after every seal (default 256 MiB)
//   MONOPLAYER_JOURNAL_MAX_AGE_MS                       journal age cap; 0 keeps the byte
//                                                       budget alone (default 48 hours)
//   MONOPLAYER_RECONNECT_ATTEMPTS                       backend reconnect attempts
//                                                       (0 = unlimited; unset keeps the
//                                                       config file's value, else unlimited)
//   MONOPLAYER_RECONNECT_MAX_DELAY_MS                   backoff cap (default 60000)
//
// Sequence (simplicity rules; one client, one backend leg, direct Paper):
//   1. resolve config (JSON + env), resolve the puppet account, load the
//      attach whitelist (UUIDs only)
//   2. build the core with the live legs, core.start()
//   3. backend leg connect (Microsoft auth through the G1 token custody; the
//      writer lock is taken by the leg, so auth CLI refreshes refuse meanwhile)
//   4. readiness: wait until the core cache has the backend configuration
//      frames AND the join prefix — the warm marker (chunk_batch_finished)
//      or a bounded grace window
//   5. front leg listen, readiness log (no secrets), process stays alive
import fs from 'node:fs'

import { createMonoplayer, loadConfig } from './monoplayer.js'
import { createControlDocument, dialIntent, revertAfterRestore } from './control.js'
import { candidateLines, flag, withTimeout } from './cli.js'
import { redact } from '../observability/redact.js'
import { resolveAccount } from '../custody/accounts.js'
import { accountTokenExpiry } from '../custody/status.js'
import { normalizeUuid } from '../custody/util.js'
import { MAX_PLAYER_NAME_LENGTH } from '../custody/store.js'
import { createLiveBackendLeg, createOfflineBackendLeg, OFFLINE_PUPPET_USERNAME } from '../legs/live-backend.js'
import { createLiveFrontLeg, createOfflineFrontLeg } from '../legs/live-front.js'
import { offlineUuid } from '../legs/offline-identity.js'
import { readConfigurationBaseline } from '../legs/configuration-baseline.js'
import { forceWarm, shouldForceWarm, waitForReady } from './readiness.js'
import { createWireChecker } from '../core/wire-check.js'
import { accountIdentifier, bodyKey, stampIdentity } from '../core/channels.js'
import { pickerOfferedRows } from '../core/picker.js'
import { createTelemetry } from '../observability/telemetry.js'
import { createJournal } from '../observability/journal.js'
import { createTransferFollowController } from '../core/transfer-follow.js'
import { MAX_DEADLINE_MS, PREAUTH_CLOSE_REASON } from '../core/preauth-window.js'

// #134: the skin frame names the puppet's own `player_info` entry, so a lane that
// cannot name the puppet's UUID writes no frame. The raw cacheDir override
// resolves no account and reaches this with no UUID unless the operator supplied
// one.
// #96: the fields of the journal_volume_full report, or null when the journal
// opened. A journal volume with no room is the journal's own failure, and it is
// named with its path here instead of letting the first unrelated write on that
// volume fail with ENOSPC under another stage. Apart from startLive so the
// report is observable without a live backend.
// #265: the rows a picker lane offers. The list is the allowed-server key (#262),
// read at each offer, so a panel edit shows at the next join. Each row is named for
// the address a claim dials (src/core/picker.js).
//
// #315: the answer is the offer itself, `{ source, reason, rows }`. A lane's picker
// hands it to the front, which draws the rows and names the reason when there are none.
export function createPickerServerReader ({ control, log = () => {} } = {}) {
  if (typeof control?.allowedServers !== 'function') {
    throw new TypeError('createPickerServerReader: control must offer allowedServers')
  }
  // The last answer this lane offered, as one string. A join reads the list more
  // than once, and an operator needs one line per answer, not one per read. The
  // names are compared as one JSON array, because a host can hold a separator a
  // joined string would read as another row. #315: the reason is part of the answer,
  // because a lane that stays empty for a second reason is a second fact to fix.
  let lastAnswer = null
  return function pickerOffer () {
    const offered = pickerOfferedRows(control.allowedServers)
    const answer = offered.source + '|' + String(offered.reason ?? '') + '|' +
      JSON.stringify(offered.rows.map(row => row.name))
    if (answer !== lastAnswer) {
      lastAnswer = answer
      log('pickerOffered', { source: offered.source, servers: offered.rows.length, reason: offered.reason })
    }
    // The offer, not only its rows: the front says why the lane offers nothing when it
    // has nothing to draw (#315).
    return offered
  }
}

export function journalVolumeFull ({ disabledReason = null, dir = null, freeBytes = null, requiredBytes = null } = {}) {
  if (disabledReason !== 'journal_volume_full') return null
  return { reason: 'journal_volume_full', dir, freeBytes, requiredBytes }
}

export function unidentifiedSkinWarning ({ skin, puppet } = {}) {
  if (skin?.showPuppetSkin !== true) return null
  if ((puppet?.uuid ?? null) !== null) return null
  return 'skin.showPuppetSkin is on and no puppet UUID is known, so no skin frame is written ' +
    'and the human keeps a default skin. Prefer selecting the account with ' +
    'MONOPLAYER_PUPPET_ACCOUNT, which resolves the UUID. On the raw cacheDir override there is ' +
    'no account to check against, and MONOPLAYER_PUPPET_UUID is taken as given.'
}

// #415: the per-body and per-channel groups the heartbeat carries.
//
// `docs/telemetry.md`, under "The per-body and per-channel groups", defines every
// field below and names the measurements this does not take, with the file each one
// needs. That page is their home: a list repeated here would drift from it.
//
// Purity: no sockets, no timers, no I/O. The moment is the caller's, and a caller
// that gives none gets the wall clock. It reads the handles the composition root
// already holds: the body registry and each body's cache on the core, and the
// channel and claim snapshots on the front leg.
export function sampleHeartbeatGroups ({ core = null, front = null, now = Date.now() } = {}) {
  // One read of the claim board for both groups, so a claim recorded between the
  // two rows cannot age differently in each.
  const claims = claimsByBody(front)
  return {
    bodies: sampleBodies({ core, claims, now }),
    channels: sampleChannels({ front, claims, now })
  }
}

// The claims the front holds, by body. A lane with no picker holds none: a claim is
// what the picker records, so an empty map is the lane that never offered one.
function claimsByBody (front) {
  const claims = new Map()
  for (const claim of Array.isArray(front?.claims) ? front.claims : []) {
    if (typeof claim?.body === 'string') claims.set(claim.body, claim)
  }
  return claims
}

// How long a claim has been held, or null when there is none to measure. A claim
// the front did not stamp is not an age of zero.
function claimAgeMs (claim, now) {
  if (claim === null || claim === undefined || !Number.isFinite(claim.at)) return null
  return Math.max(0, now - claim.at)
}

// An entry count for one body's cache, the same sum `monoplayer.cache.frames`
// carries for the served body.
function cachedFrames (stats) {
  if (stats === null || typeof stats.sizes !== 'object' || stats.sizes === null) return 0
  return Object.values(stats.sizes).reduce((sum, count) => sum + count, 0)
}

// One row per body the registry holds a cache for (#260). The registry holds
// caches, not stages: a body can say what its cache holds and whether it is the one
// the session serves, and a stage per body would need a session per body
// (src/core/body-caches.js).
function sampleBodies ({ core = null, claims = new Map(), now = Date.now() } = {}) {
  const registry = core?.bodies ?? null
  if (registry === null || typeof registry.stats !== 'function') return []
  const serving = core?.cache ?? null
  return (registry.stats().bodies ?? []).map(body => {
    const cache = registry.get(body)
    const stats = typeof cache?.stats === 'function' ? cache.stats() : null
    const claim = claims.get(body) ?? null
    const row = {
      body,
      active: cache !== null && cache === serving,
      warm: stats?.warm === true,
      frames: cachedFrames(stats),
      chunkBytes: stats?.chunkBytes ?? 0,
      // The cache's own counters (#216 counts the same two process-wide). They
      // start at 0 with the cache, which lives as long as the body does.
      framesCached: stats?.metrics?.framesCached ?? 0,
      framesDropped: stats?.metrics?.framesDropped ?? 0
    }
    // Absent, never null, when no claim stands: a body nobody claimed has no claim
    // age, and a `null` would make "every body with a claim age" a query that
    // returns the ones without (#263 D2).
    const claimMs = claimAgeMs(claim, now)
    if (claimMs !== null) row.claimMs = claimMs
    return row
  })
}

// One row per channel the front holds open (src/core/channels.js). The counts are
// the channel's own, so a spectator that arrived mid-stream is never reported as
// having seen what the driver saw.
function sampleChannels ({ front = null, claims = new Map(), now = Date.now() } = {}) {
  const records = Array.isArray(front?.channels) ? front.channels : []
  const spectators = new Map()
  for (const record of records) {
    if (record?.role !== 'spectator') continue
    const key = bodyKey(record.body)
    spectators.set(key, (spectators.get(key) ?? 0) + 1)
  }
  return records.map(record => {
    const sent = record.delivered ?? {}
    // A key is written only where the thing it names exists (#263 D2): a connection
    // the lane admitted with no claim names no body, and a leg that stamped no open
    // has no age. `null` would make a query for either return the rows without one.
    const body = typeof record.body === 'string' && record.body.length > 0 ? record.body : null
    const ageMs = Number.isFinite(record.at) ? Math.max(0, now - record.at) : null
    // A driver's claim, held since the pick. A spectator holds none, so its row
    // carries no claim age rather than a zero.
    const claimMs = claimAgeMs(record.role === 'driver' ? claims.get(record.body) : null, now)
    return {
      channel: record.id ?? null,
      ...(body === null ? {} : { body }),
      role: record.role ?? null,
      ...(ageMs === null ? {} : { ageMs }),
      frames: sent.frames ?? 0,
      play: sent.play ?? 0,
      configuration: sent.configuration ?? 0,
      // #417: the bytes those frames took, as the leg measured them at the write.
      // A channel the leg counted no length for is 0, the same way a channel it
      // wrote no frame to is 0: the count is what was measured.
      bytes: sent.bytes ?? 0,
      replays: sent.replays ?? 0,
      // The spectator channels on this body, this one included. A body's audience
      // is what the cap decides, and one number per row keeps a reader from having
      // to regroup the array.
      spectators: spectators.get(bodyKey(record.body)) ?? 0,
      ...(claimMs === null ? {} : { claimMs })
    }
  })
}

// The bounded half of the two groups, as OTLP gauges. The body is the only
// attribute and it is bounded by the allowed-server list; a channel attribute would
// be one series per connection, which is the cardinality bomb #415 and #263 D1
// forbid. `monoplayer.cache.frames` is the same sum for the served body, kept
// beside these because it was documented and charted before they existed.
export function emitBodyGauges (telemetry, bodies = []) {
  if (typeof telemetry?.metric !== 'function') return
  for (const row of bodies) {
    telemetry.metric('monoplayer.body.frames', row.frames, { body: row.body }, 'gauge')
    telemetry.metric('monoplayer.body.chunkBytes', row.chunkBytes, { body: row.body }, 'gauge')
    telemetry.metric('monoplayer.body.warm', row.warm ? 1 : 0, { body: row.body }, 'gauge')
  }
}

export function envOverlay (doc, env = process.env, warn = () => {}) {
  const out = { ...doc }
  const front = { ...doc.front }
  if (env.MONOPLAYER_FRONT_HOST) front.host = env.MONOPLAYER_FRONT_HOST
  if (env.MONOPLAYER_FRONT_PORT) front.port = Number(env.MONOPLAYER_FRONT_PORT)
  if (Object.keys(front).length) out.front = front
  const backend = { ...doc.backend }
  if (env.MONOPLAYER_BACKEND_HOST) backend.host = env.MONOPLAYER_BACKEND_HOST
  if (env.MONOPLAYER_BACKEND_PORT) backend.port = Number(env.MONOPLAYER_BACKEND_PORT)
  out.backend = backend
  const puppet = { ...doc.puppet }
  if (env.MONOPLAYER_PUPPET_ACCOUNT) puppet.account = env.MONOPLAYER_PUPPET_ACCOUNT
  if (env.MONOPLAYER_PUPPET_ACCOUNTS_DIR) puppet.accountsDir = env.MONOPLAYER_PUPPET_ACCOUNTS_DIR
  if (env.MONOPLAYER_PUPPET_UUID) puppet.uuid = env.MONOPLAYER_PUPPET_UUID
  if (env.MONOPLAYER_PUPPET_USERNAME) puppet.username = env.MONOPLAYER_PUPPET_USERNAME
  if (env.MONOPLAYER_PUPPET_CACHE_DIR) puppet.cacheDir = env.MONOPLAYER_PUPPET_CACHE_DIR
  if (env.MONOPLAYER_PUPPET_CACHE_ACCOUNT) {
    warn('MONOPLAYER_PUPPET_CACHE_ACCOUNT is deprecated and ignored; use MONOPLAYER_PUPPET_ACCOUNT')
  }
  out.puppet = puppet
  if (env.MONOPLAYER_ATTACH_WHITELIST) out.attachWhitelistFile = env.MONOPLAYER_ATTACH_WHITELIST
  // #262: the allowed-server list, and the copy Git commits. Two paths, because the
  // fallback names a file: a fallback nobody named is a fallback nobody can check.
  // These are the control document's only environment switches since #264 retired
  // the desired-backend key; the whitelist's own is MONOPLAYER_ATTACH_WHITELIST.
  const control = { ...doc.control }
  if (env.MONOPLAYER_ALLOWED_SERVERS) control.allowedServers = env.MONOPLAYER_ALLOWED_SERVERS
  if (env.MONOPLAYER_ALLOWED_SERVERS_SEED) control.allowedServersSeed = env.MONOPLAYER_ALLOWED_SERVERS_SEED
  if (Object.keys(control).length) out.control = control
  if (env.MONOPLAYER_DIALOG_ACTION) out.dialogAction = env.MONOPLAYER_DIALOG_ACTION
  // #257: the picker. Only "1" and "0" are read, so a typo leaves the lane
  // refusing a backendless join the way it always did.
  const pickerRaw = env.MONOPLAYER_PICKER
  if (pickerRaw === '1' || pickerRaw === '0') {
    out.picker = pickerRaw === '1'
  } else if (pickerRaw !== undefined && pickerRaw !== '') {
    warn('MONOPLAYER_PICKER must be 1 or 0; ignoring ' + pickerRaw)
  }
  // #391: the offline legs. Only "1" and "0" are read, so a typo leaves the lane
  // on the live legs, which is the only safe thing for it to be: the mode that
  // asks no server who a client is must never be reached by accident.
  const offlineRaw = env.MONOPLAYER_OFFLINE_LEGS
  if (offlineRaw === '1' || offlineRaw === '0') {
    out.offlineLegs = offlineRaw === '1'
  } else if (offlineRaw !== undefined && offlineRaw !== '') {
    warn('MONOPLAYER_OFFLINE_LEGS must be 1 or 0; ignoring ' + offlineRaw)
  }
  if (env.MONOPLAYER_VERSION) out.version = env.MONOPLAYER_VERSION
  if (env.MONOPLAYER_CHAT) out.chat = env.MONOPLAYER_CHAT
  // The kept connection (#22) is on in the defaults; this switch lets a lane
  // turn it off without moving that default. Only "1" and "0" are read, so a
  // typo cannot silently change what a deployed lane does with a transfer.
  const keepRaw = env.MONOPLAYER_TRANSFER_KEEP_CONNECTION
  if (keepRaw === '1' || keepRaw === '0') {
    out.transfer = { ...doc.transfer, keepConnection: keepRaw === '1' }
  } else if (keepRaw !== undefined && keepRaw !== '') {
    warn('MONOPLAYER_TRANSFER_KEEP_CONNECTION must be 1 or 0; ignoring ' + keepRaw)
  }
  // #99: the human's own player wears the puppet's skin. On in the defaults;
  // this switch turns it off for a lane without moving that default. Only "1" and
  // "0" are read, so a typo cannot silently change what a lane shows the human.
  const skinRaw = env.MONOPLAYER_SKIN_SHOW_PUPPET
  if (skinRaw === '1' || skinRaw === '0') {
    out.skin = { ...doc.skin, showPuppetSkin: skinRaw === '1' }
  } else if (skinRaw !== undefined && skinRaw !== '') {
    warn('MONOPLAYER_SKIN_SHOW_PUPPET must be 1 or 0; ignoring ' + skinRaw)
  }
  // A deployed puppet keeps reconnecting by default: the backend can restart,
  // and giving up after one attempt leaves the front alive with no session. A
  // config document may set a budget, and this env var may override it. Either
  // way, 0 or unset means unlimited, and the delay caps at
  // MONOPLAYER_RECONNECT_MAX_DELAY_MS.
  const reconnect = { ...doc.reconnect, attempts: doc.reconnect?.attempts ?? Infinity }
  const attemptsRaw = env.MONOPLAYER_RECONNECT_ATTEMPTS
  if (attemptsRaw !== undefined && attemptsRaw !== '') {
    const parsed = Number(attemptsRaw)
    reconnect.attempts = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity
  }
  if (env.MONOPLAYER_RECONNECT_MAX_DELAY_MS) {
    const parsed = Number(env.MONOPLAYER_RECONNECT_MAX_DELAY_MS)
    if (Number.isFinite(parsed) && parsed > 0) reconnect.maxDelayMs = Math.floor(parsed)
  }
  out.reconnect = reconnect
  // A number an operator can set: read once, and a value that cannot mean
  // anything is named rather than silently clamped. The defaults are bounded, so
  // a typo costs the operator the value they meant, not the bound.
  // A bounded number, read once. Named for what it does rather than "cap", which
  // this repo uses for preAuth.maxConnections.
  const boundedNumber = (raw, variable, floor, ceiling = Infinity) => {
    if (raw === undefined || raw === '') return undefined
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= floor && parsed <= ceiling) return Math.floor(parsed)
    warn(variable + ' must be a number of at least ' + floor +
      (ceiling === Infinity ? '' : ' and at most ' + ceiling) + '; ignoring ' + raw)
    return undefined
  }
  // #201: the total connection cap on the pre-auth window. The window runs from
  // an accepted socket to the attach whitelist's accept, so the cap holds while a
  // tunnel hides the client's address. A value below 1 cannot bound the window:
  // loadConfig refuses it. Here it is named and ignored like every other number,
  // which leaves the document's cap in force when it sets one, and the compiled
  // cap when it does not.
  // One accumulator for both keys of this section, so a key written below cannot
  // silently drop one written above it.
  const preAuth = { ...doc.preAuth }
  const preAuthMax = boundedNumber(env.MONOPLAYER_PREAUTH_MAX_CONNECTIONS, 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS', 1)
  if (preAuthMax !== undefined) preAuth.maxConnections = preAuthMax
  // #205: the deadline on the same window, read the same way. A silent socket
  // that never leaves the window is what closes it against every real join, so
  // the bound is a validated number and never an off switch. A delay above
  // MAX_DEADLINE_MS is named and ignored like any other number the overlay cannot
  // use: Node would fire it at 1 ms and destroy every connection at once.
  const preAuthDeadline = boundedNumber(env.MONOPLAYER_PREAUTH_DEADLINE_MS,
    'MONOPLAYER_PREAUTH_DEADLINE_MS', 1, MAX_DEADLINE_MS)
  if (preAuthDeadline !== undefined) preAuth.deadlineMs = preAuthDeadline
  if (Object.keys(preAuth).length) out.preAuth = preAuth

  // #96: the packet journal's directory and its retention budget. A rotation
  // size alone deletes nothing, so the directory has a byte budget and an age
  // cap. A cap the overlay cannot read is named in a warning and left at the
  // default, the same as every other number in this function: the defaults are
  // bounded, so a typo costs the operator the value they meant, not the bound.
  const journal = { ...doc.journal }
  if (env.MONOPLAYER_JOURNAL_DIR) journal.dir = env.MONOPLAYER_JOURNAL_DIR
  for (const [variable, key, floor] of [
    ['MONOPLAYER_JOURNAL_MAX_BYTES', 'maxBytes', 1],
    ['MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES', 'maxTotalBytes', 1],
    // 0 turns the age rule off; the byte budget still bounds the directory.
    ['MONOPLAYER_JOURNAL_MAX_AGE_MS', 'maxAgeMs', 0]
  ]) {
    const value = boundedNumber(env[variable], variable, floor)
    if (value !== undefined) journal[key] = value
  }
  if (Object.keys(journal).length) out.journal = journal
  return out
}

function accountHint () {
  return [
    '  bootstrap a new account: node src/custody/cli.js device-code',
    '  migrate the single-account layout: node src/custody/cli.js migrate --apply',
    '  list accounts: node src/custody/cli.js accounts'
  ].join('\n')
}



// #391: the identity an offline body speaks as, derived from its name the way an
// offline server derives it for every client (src/legs/offline-identity.js).
// The name is the lane's: `username`, else the `account` selector, else the
// leg's own default. The UUID always follows from it.
//
// A configured UUID can only agree with that derivation or be wrong. The backend
// derives the UUID from the name on its side, so a lane that carried the other
// one would name a player the server does not have: in the skin frame, and in the
// start record. A disagreement is refused, never overridden.
export function offlinePuppet ({ account = null, username = null, uuid = null } = {}) {
  // The name an offline body joins as. `username` is the key that says what the
  // puppet is called, and `account` is the selector a lane like the dev lane
  // already sets (`MONOPLAYER_PUPPET_ACCOUNT=devpuppet`). An offline lane has no
  // account to resolve, so the selector string is read as the name, whatever form
  // it was written in: a lane joined as the live puppet's name is at best
  // confusing and at worst a live identity on a test Paper. `MONOPLAYER_PUPPET_UUID`
  // is still checked against the name, so a lane that pairs a name with the wrong
  // UUID is refused rather than renamed.
  const name = username ?? account ?? OFFLINE_PUPPET_USERNAME
  // A lane that sets the selector to a UUID or an alias has named a body no
  // server accepts, and the offline leg would dial it and be kicked. Refusing
  // here names the key instead of leaving a kick to explain it. The limit is the
  // game's, read from where a name is resolved.
  if (name.length > MAX_PLAYER_NAME_LENGTH) {
    throw new TypeError(
      'offline_puppet_name_too_long: ' + JSON.stringify(name) + ' is ' + name.length +
      ' characters, and a Minecraft name is at most ' + MAX_PLAYER_NAME_LENGTH +
      '. Set MONOPLAYER_PUPPET_USERNAME, or a shorter MONOPLAYER_PUPPET_ACCOUNT.')
  }
  const derived = offlineUuid(name)
  if (uuid !== null && normalizeUuid(uuid) !== derived) {
    throw new TypeError(
      'offline_puppet_uuid_mismatch: config asserts ' + uuid + ', and the offline UUID of ' +
      name + ' is ' + derived)
  }
  return { username: name, uuid: derived }
}

// #391: the two legs this process builds, and the only place the offline branch
// is decided. It opens no socket and resolves no account, so a unit test hands it
// four recording constructors and reads the decision it made
// (test/service/offline-legs.test.js).
//
// Both branches wire the same product: the dialog answerer (#16), the snapshot
// the front replays, and the picker's offer. A lane with the switch on is this
// product with two adapters swapped, not a second product.
const SERVICE_LEG_CONSTRUCTORS = Object.freeze({
  liveBackend: createLiveBackendLeg,
  liveFront: createLiveFrontLeg,
  offlineBackend: createOfflineBackendLeg,
  offlineFront: createOfflineFrontLeg
})

export function createServiceLegs ({
  cfg,
  resolved = null,
  control = null,
  configurationBaseline = null,
  telemetry = { metric () {} },
  getSnapshotConfig = () => [],
  isHumanAttached = () => false,
  onDialogAnswered = null,
  log = () => {},
  dumpRaw = null,
  dumpFramed = null,
  legs = SERVICE_LEG_CONSTRUCTORS
} = {}) {
  // Strict frame check on every client-facing raw replay/relay. Both lanes run
  // it in warn mode: a checker bug must not kick a real player, and a test lane
  // has a real client too.
  const wire = createWireChecker({ version: cfg.version })
  // #257: the picker's configuration phase, and the list it offers. The
  // recording is committed protocol data (src/legs/configuration-baseline.js).
  // A lane with no fixture on disk refuses a picker join rather than inventing
  // one. #265: the list is the allowed-server key (#262), read at each offer. A
  // panel edit is therefore what the next join sees. A broken live file falls back
  // to the seed Git commits rather than offering nothing. A lane with no key offers
  // nothing, because the list is what a picker lane offers and not the backend it
  // dials. The row says `down`, because with no session there is no body standing.
  const pickerOffered = {
    configurationBaseline,
    pickerServers: cfg.picker === true ? createPickerServerReader({ control, log }) : null,
    onPickerPick: pick => {
      log('pickerPickRecorded', {
        server: pick.server?.name ?? null,
        slug: pick.slug,
        id: pick.id,
        uuid: pick.uuid,
        username: pick.name
      })
      telemetry.metric('monoplayer.picker_picks', 1, { server: pick.server?.name ?? null })
    },
    // #266: the answer to a chosen server's own dialog. Recorded, not acted on.
    // The verb names a body this lane does not connect from the configuration
    // phase. #267 is the ticket that changes that.
    onPickerVerb: verb => {
      log('pickerVerbRecorded', {
        verb: verb.verb,
        server: verb.server?.name ?? null,
        slug: verb.slug,
        id: verb.id,
        uuid: verb.uuid,
        username: verb.name
      })
      telemetry.metric('monoplayer.picker_verbs', 1, { verb: verb.verb, server: verb.server?.name ?? null })
    }
  }

  // The front options both lanes run: one product, two pairs of adapters.
  const sharedFront = {
    // #201: the total cap on the sockets inside the pre-auth window.
    preAuth: cfg.preAuth,
    getSnapshotConfig,
    ...pickerOffered,
    wireCheck: payload => wire.check(payload),
    wireMode: 'warn',
    chat: cfg.chat,
    log,
    dumpRaw,
    dumpFramed
  }

  if (cfg.offlineLegs === true) {
    // #391: an offline body dials the lane's backend with auth 'offline' and a
    // fixed username, and the front asks no session server who a client is. No
    // custody directory, no account selector, no token: the two legs a rung
    // already builds, composed for a lane.
    //
    // The whitelist is the source the live front reads: the control document's
    // store when the lane names a file, else the startup array. An offline
    // client's UUID is derived from the name it claims, so that list holds
    // offline UUIDs (docs/deployment.md).
    const puppet = offlinePuppet(cfg.puppet)
    return {
      backend: legs.offlineBackend({
        host: cfg.backend.host,
        port: cfg.backend.port,
        version: cfg.version,
        username: puppet.username,
        dialogAction: cfg.dialogAction,
        // #16/#20: the same answerer split as the live branch. Without these the
        // puppet would answer a gate a human is looking at, and the core would
        // hold a gate the server already closed.
        isHumanAttached,
        onDialogAnswered,
        // #391: the option that lifts this leg's loopback fence, as the front
        // below lifts its own. A deployed lane binds a pod address and dials a
        // Paper in another pod, and only this composition root sets it.
        allowNonLoopback: true,
        log
      }),
      front: legs.offlineFront({
        host: cfg.front.host,
        port: cfg.front.port,
        version: cfg.version,
        whitelistStore: control?.whitelistStore ?? null,
        offlineWhitelist: control?.whitelistStore ? null : cfg.attachWhitelist,
        allowNonLoopback: true,
        ...sharedFront
      })
    }
  }

  const backend = resolved
    ? legs.liveBackend({
      host: cfg.backend.host,
      port: cfg.backend.port,
      version: cfg.version,
      accountDir: resolved.account.dir,
      account: resolved.account.alias ?? resolved.account.name ?? resolved.account.uuid,
      uuid: resolved.account.uuid,
      authTitle: resolved.account.profile?.authTitle ?? null,
      deviceType: resolved.account.profile?.deviceType ?? null,
      dialogAction: cfg.dialogAction,
      // #16/#20: the auto-click covers a configuration gate only, and it stands
      // down as soon as a player can answer. A play dialog is never the
      // puppet's, attached or not.
      isHumanAttached,
      // #16: an auto-answered dialog is not the next client's question.
      onDialogAnswered,
      log
    })
    : legs.liveBackend({
      host: cfg.backend.host,
      port: cfg.backend.port,
      version: cfg.version,
      cacheDir: cfg.puppet.cacheDir,
      cacheAccount: cfg.puppet.cacheAccount,
      // #16/#21: the same answerer split as the account branch. Without these,
      // this branch fails open: the puppet would answer a gate a human is
      // looking at, and the core would hold a gate the server already closed.
      isHumanAttached,
      onDialogAnswered,
      log
    })
  const front = legs.liveFront({
    host: cfg.front.host,
    port: cfg.front.port,
    version: cfg.version,
    attachWhitelistFile: cfg.attachWhitelistFile,
    // #229: the control document's store, so the leg's own whitelist check reads
    // the same file the core gate does, at each login. Null keeps the leg's one
    // startup read, which is every lane that names no whitelist file.
    whitelistStore: control?.whitelistStore ?? null,
    ...sharedFront
  })
  return { backend, front }
}

// What the service does with the configured backend before the front listens.
// A picker lane dials nothing, because a claim is the only thing that dials a
// body (#258), and a body dialled at boot is the session that claim then finds
// busy.
//
// Nothing here reports a failure: the caller owns the process's exit code, and
// its catch is where a failed dial is already named.
//
// The readiness wait stays with the caller, because a lane that dialled nothing
// has no cache to warm.
export async function dialBodyAtBoot ({ cfg, backend, log = () => {}, connectTimeoutMs = 240_000 } = {}) {
  if (cfg.picker === true) {
    log('backendBootSkipped', { reason: 'picker' })
    return { dialled: false, reason: 'picker' }
  }
  await withTimeout(backend.connect(), connectTimeoutMs, 'backend_leg_connect')
  return { dialled: true, reason: null }
}

// #416: the JSONL log every record of the service and both legs passes through.
// The account is the lane's, so it is stamped here, once, rather than at each of
// the call sites that would otherwise repeat it. A lane with no account writes no
// account key, never a null (#263 D2).
export function createJsonlLog ({ sink, account = null }) {
  return (event, fields = {}) => {
    try {
      sink.write(redact(JSON.stringify({
        t: new Date().toISOString(),
        event,
        ...stampIdentity(fields, { account })
      })) + '\n')
    } catch { /* never let logging kill the legs */ }
  }
}

export async function startLive ({ argv = [], io = process } = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  // Guardrail: --start opens sockets and touches token custody — it must be
  // an explicit act. Refuse a purely-default invocation (no backend host and
  // no config document) so `main(['--start'])` stays inert.
  const explicitBackend = process.env.MONOPLAYER_BACKEND_HOST ||
    flag(argv, '--config')
  if (!explicitBackend) {
    stderr.write(
      'monoplayer --start: refusing the default config. Set MONOPLAYER_BACKEND_HOST ' +
      '(and friends) or pass a --config JSON file describing the live legs. ' +
      'See docs/product-core.md.\n'
    )
    return 2
  }

  // --- 1. config ---
  let doc = {}
  const docPath = flag(argv, '--config')
  if (docPath) {
    doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  }
  const cfg = loadConfig(envOverlay(
    doc,
    process.env,
    message => stderr.write(`monoplayer --start: warning: ${message}\n`)
  ))

  // --- 1b. puppet account (before any leg exists) ---
  // #391: an offline lane has no account to resolve. Its puppet is a name, and
  // the UUID follows from it, so the custody tree is never opened and a lane
  // boots on a pod with no account volume at all.
  if (cfg.offlineLegs === true) {
    // The same refusal the live branch gives a mismatched puppet UUID, with the
    // name an offline lane can act on: there is no account to resolve, so the
    // name is the identity and the UUID follows from it.
    let puppet
    try {
      puppet = offlinePuppet(cfg.puppet)
    } catch (error) {
      stderr.write('monoplayer --start: ' + error.message + '\n')
      return 2
    }
    cfg.puppet.username = puppet.username
    cfg.puppet.uuid = puppet.uuid
  }
  // Raw cacheDir override: use the directory as given. It cannot be combined
  // with an account selector, because the selector would have nothing to
  // resolve against.
  let resolved = null
  if (cfg.offlineLegs !== true) {
    if (cfg.puppet.cacheDir) {
      if (cfg.puppet.account) {
        stderr.write(
          'monoplayer --start: config_conflict: puppet.cacheDir (raw dir override) ' +
          'cannot be combined with puppet.account\n')
        return 2
      }
    } else {
      resolved = resolveAccount({
        accountsDir: cfg.puppet.accountsDir,
        selector: cfg.puppet.account ?? cfg.puppet.uuid
      })
      if (!resolved.ok) {
        stderr.write(
          `monoplayer --start: cannot resolve a puppet account in ${cfg.puppet.accountsDir}: ${resolved.reason}\n` +
          `${candidateLines(resolved.candidates)}\n${accountHint()}\n`)
        return 2
      }
      const account = resolved.account
      if (cfg.puppet.uuid) {
        const asserted = normalizeUuid(cfg.puppet.uuid)
        if (asserted === null || asserted !== account.uuid) {
          stderr.write(
            `monoplayer --start: puppet_uuid_mismatch: config asserts ${cfg.puppet.uuid}, ` +
            `resolved account is ${account.uuid}\n`)
          return 2
        }
      }
      if (cfg.puppet.username) {
        const profileName = account.profile?.name ?? null
        if (typeof profileName !== 'string' ||
            profileName.toLowerCase() !== String(cfg.puppet.username).toLowerCase()) {
          stderr.write(
            `monoplayer --start: puppet_name_mismatch: config asserts ${cfg.puppet.username}, ` +
            `resolved profile name is ${profileName ?? '(none)'}\n`)
          return 2
        }
      }
      cfg.puppet.uuid = account.uuid
      cfg.puppet.username = account.profile?.name ?? cfg.puppet.username ?? null
    }
  }

  const skinWarning = unidentifiedSkinWarning(cfg)
  if (skinWarning !== null) stderr.write(`monoplayer --start: warning: ${skinWarning}\n`)

  // #264: the whitelist file is the control document's one switch, so there is no
  // static lane left to read it early. Every lane reads it through the control
  // document below, which needs the log sink a file it could not read is named in.
  // An empty list is a lane that refuses every login by name, and the live front
  // leg requires the file anyway.

  // --- logging sink (JSONL; every line redacted) ---
  let sink = stdout
  if (process.env.MONOPLAYER_LOG) {
    sink = fs.createWriteStream(process.env.MONOPLAYER_LOG, { flags: 'a' })
  }
  // #416: the account every record names, resolved before any leg exists: the
  // alias custody knows, else its UUID, else the name an offline lane joins as.
  const accountId = accountIdentifier({
    alias: resolved?.account.alias ?? null,
    uuid: cfg.puppet.uuid ?? null,
    name: cfg.puppet.username ?? null
  })
  const log = createJsonlLog({ sink, account: accountId })

  // Attach-time raw byte dump (diagnostic; off by default).
  let dumpRaw = null
  if (process.env.MONOPLAYER_DEBUG_REPLAY) {
    const dumpFile = process.env.MONOPLAYER_DEBUG_REPLAY
    const fd = fs.openSync(dumpFile, 'w')
    let index = 0
    dumpRaw = ({ kind, buffer }) => {
      try {
        fs.writeSync(fd, JSON.stringify({ i: index++, kind, b64: buffer.toString('base64') }) + '\n')
      } catch { /* diagnostic sink is best effort */ }
    }
    log('debugReplayDump', { file: dumpFile })
  }
  // Framed-byte dump (config + play): the client.framer output is framed and
  // possibly compressed, not plaintext. This is the client-facing truth for
  // decode-desync forensics (off by default).
  let dumpFramed = null
  if (process.env.MONOPLAYER_DEBUG_FRAMED) {
    const framedFile = process.env.MONOPLAYER_DEBUG_FRAMED
    const fd = fs.openSync(framedFile, 'w')
    let index = 0
    dumpFramed = buffer => {
      try {
        fs.writeSync(fd, JSON.stringify({ i: index++, b64: buffer.toString('base64') }) + '\n')
      } catch { /* diagnostic sink is best effort */ }
    }
    log('debugFramedDump', { file: framedFile })
  }

  // --- 1c. the control document, and the attach whitelist it drives (#229) ---
  // With the whitelist file named, the attach whitelist is a file an operator edits:
  // it is read at each login, so a UUID added through the panel is allowed on the
  // next attempt with no restart. With no path, the whitelist is the startup
  // snapshot it has always been and no control file is opened.
  const control = createControlDocument({
    whitelistFile: cfg.attachWhitelistFile,
    // #262: the allowed-server list and the file Git commits behind it. Read here
    // for the start record below. #265 is the picker, which reads the same key again
    // at each offer.
    allowedServersFile: cfg.control.allowedServers ?? null,
    allowedServersSeedFile: cfg.control.allowedServersSeed ?? null,
    log
  })
  const whitelistSource = control.whitelistStore === null ? null : control.attachWhitelist
  if (whitelistSource !== null) {
    cfg.attachWhitelist = whitelistSource()
    if (cfg.attachWhitelist.length === 0) {
      // A control lane may start empty: the operator adds the first UUID through
      // the panel. Exiting here would crash-loop the pod on the same file, which
      // is the one thing the reload exists to avoid.
      log('whitelistEmpty', { file: cfg.attachWhitelistFile })
    }
  }

  // #262: the allowed-server list, read once. The start record says which file
  // answered and how many servers it holds, so an operator can see a seed standing
  // in for an unedited list without opening a file. The picker reads the list again
  // at each offer (#265). This read is the lane's own report, and it is the same
  // call.
  const allowedServersAtStart = control.allowedServers()

  // The target the process dials first, and treats as its base: the one the
  // deployment configured. #229 let a control document override it before the first
  // dial; #264 retired that key with the backend move, so the first dial is now the
  // configured one and every later target comes from a transfer. #331: that makes
  // "the target at startup" and "the configured target" one fact, so the code and
  // the start record carry one name for it.
  const configuredTarget = { host: cfg.backend.host, port: cfg.backend.port }

  // --- telemetry + journal (both inert unless their env is set) ---
  // Telemetry carries the puppet alias as a resource attribute; the alias and
  // account UUID are not secrets.
  const accountAlias = resolved?.account.alias ?? null
  const telemetryEnv = { ...process.env }
  if (accountAlias) telemetryEnv.MONOPLAYER_ACCOUNT_ALIAS = accountAlias
  const telemetry = createTelemetry({ env: telemetryEnv, log })
  // #416: the account reaches every journal record from here, and the body a frame
  // crossed is passed by the core that serves it.
  const journal = createJournal({ ...cfg.journal, account: accountId })
  // #96: a journal volume with no room for its budget is reported here, with
  // the path, before any leg opens. The journal stays off; a diagnostic
  // artifact does not take the front down with it.
  const journalFull = journalVolumeFull(journal.stats())
  if (journalFull !== null) log('journalVolumeFull', journalFull)

  // --- 2. legs + core ---
  // #391: which legs this process runs is the composition function's decision.
  // `core` is read through the callbacks below, and every one of them fires
  // after core.start(), so the legs exist before the core does.
  let core = null // assigned before any configured usage below
  // #257: the configuration phase this lane can serve when no backend is
  // connected. Read once, and only when the picker is on: a lane that never serves
  // a picker pays nothing for the recording, and a corrupt one cannot stop a lane
  // that would never have used it.
  const baseline = cfg.picker === true ? readConfigurationBaseline() : null
  const { backend, front } = createServiceLegs({
    cfg,
    resolved,
    control,
    configurationBaseline: baseline,
    telemetry,
    getSnapshotConfig: () => core.cache.snapshot().config,
    isHumanAttached: () => core.attached === true,
    onDialogAnswered: ({ state }) => core.notePuppetDialogAnswer({ state }),
    log,
    dumpRaw,
    dumpFramed
  })

  // Real timers for the session's reconnect delay. The core stays pure: it
  // announces reconnect_due, this orchestrator performs the backend connect.
  const clock = {
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout
  }

  core = createMonoplayer({
    config: cfg,
    backendLeg: backend,
    frontLeg: front,
    clock,
    // #416: the same identifier the log sink stamps, so a core record and the line
    // the sink writes name one account.
    account: accountId,
    logStream: { write: line => log('core', { line }) },
    telemetry,
    journal,
    // #229: the attach whitelist read at each login, when a control document
    // drives it. Null means cfg.attachWhitelist, frozen at startup.
    whitelistSource
  })

  front.setCoreAttach(({ name, uuid }) =>
    core.attachPlayer({ name, uuid, includeConfig: false })
  )
  // #16: a client may attach while the puppet is still configuring, and a
  // configuration gate the backend asked before it arrived is delivered when
  // the client enters its own configuration phase.
  front.setCoreAttachConfiguring(({ name, uuid }) => core.attachConfiguringPlayer({ name, uuid }))
  front.setConfiguringHandler(({ name }) => core.configuringReady({ name }))
  // #22: the reconfiguration call-in is wired by the core's start(), which owns
  // the front-leg handler set; the front leg reports the client's return to
  // play there.
  // #18: the human's client information is the source of the fields the
  // server sees; the core merges it with the backend's view distance cap.
  front.setClientSettingsHandler(settings => core.noteClientSettings(settings))
  core.start()

  // Readiness after a connect: the backend configuration and join prefix must
  // be in the cache, and a backend that streams chunks unbatched needs the
  // same bounded warm fallback the first connect uses. Without this a
  // reconnect (or a followed transfer) sits attach-denied forever.
  async function settleWarm ({ stage, maxWarmMs }) {
    const readiness = await waitForReady({ core, log, maxWarmMs })
    if (!readiness.hasConfig || !readiness.hasPrefix) return readiness
    if (!readiness.warm) {
      // #87: the transfer stage's fallback releases a client onto this cache, so
      // a target that has sent no chunk frame yet is not warm, however many join
      // frames it queued. Startup and reconnect release nobody and keep the old
      // behaviour. A refusal is a failed dial for the caller below: the follow
      // budget retries it and then reverts.
      if (!shouldForceWarm(readiness, { requireChunks: stage === 'transfer' })) {
        log('warmFallbackRefused', {
          stage,
          // #399: the refusal is terrain that is gone, not chunks that never came.
          // The arrival count travels beside it, so "sent and unloaded" reads apart
          // from "never sent".
          reason: 'no_terrain',
          chunkFrames: readiness.chunkFrames,
          deliverableChunks: readiness.deliverableChunks,
          prefixFrames: readiness.prefixFrames,
          configFrames: readiness.configFrames
        })
        return { ...readiness, warmRefused: true }
      }
      const forced = forceWarm({ cache: core.cache, session: core.session })
      log('warmFallback', {
        stage,
        forced: forced.forced,
        prefixFrames: readiness.prefixFrames,
        configFrames: readiness.configFrames,
        chunkFrames: readiness.chunkFrames,
        deliverableChunks: readiness.deliverableChunks
      })
    }
    log('readiness', { stage, ...readiness })
    return readiness
  }

  const baseTarget = { ...configuredTarget }
  const follow = createTransferFollowController()
  // The server the puppet is on now. A plain backend fault reconnects here,
  // not always to the configured base.
  let currentTarget = { ...baseTarget }
  // Why it is off the base, when it is: a followed transfer keeps the transfer
  // handshake on the next fault, and a reconnect to the server the session is
  // already on does not.
  let currentIsTransfer = false
  // The server the session last warmed on, which is the one whose state a
  // restored client holds. A given-up target reverts here, not to the base: on a
  // chain A->B->C a failed C restores the client into B's world (#87).
  let settledTarget = { ...baseTarget }
  // Whether the settled server got there by a followed transfer. It decides the
  // dialect of a revert dial, exactly as `currentIsTransfer` decides a reconnect.
  let settledIsTransfer = false
  const isBase = target =>
    target.host === baseTarget.host && target.port === baseTarget.port

  // Point the next dial at the settled server and drop any followed target that
  // is still in the controller.
  function revertToSettled (reason) {
    const abandoned = follow.abort(reason).abandoned ?? null
    currentTarget = { ...settledTarget }
    currentIsTransfer = settledIsTransfer
    try {
      backend.setTarget(settledTarget, { keepCookies: settledIsTransfer && !isBase(settledTarget) })
    } catch (error) {
      log('transferFollowTargetRejected', { error: String(error?.message ?? error).slice(0, 200) })
    }
    return { abandoned }
  }

  // One backend.connect() per reconnect_due: the guard refuses a second
  // attempt while one is in flight, so the reconnect can never loop.
  let reconnecting = false
  core.on('reconnect_due', async ({ delayMs, attempt, target } = {}) => {
    if (reconnecting) return
    reconnecting = true
    core.session.backendConnecting({ initial: false })

    // A followed target is handed over once, through the controller, so one budget
    // owns the retries and the give-up. A target fed again on every retry would
    // reset that budget, and the controller remembers it across the hops that
    // carry none.
    const due = follow.onDue({ target })
    // Two sources, and #264 removed the other two: a target the controller is
    // following, or the server the session is already on. There is nothing left to
    // rank, so the dial is the first that exists.
    const dialTarget = due.target ?? currentTarget
    try {
      // A transfer dial, and the return to the server a transfer moved the session
      // to, ask the target for the transfer handshake and keep the cookies: the
      // behaviour every lane had before this ticket. Anything else is a fresh login
      // on the server the session is already on.
      const transferDial = due.target !== null || currentIsTransfer
      backend.setTarget(dialTarget, dialIntent({ transfer: transferDial, target: dialTarget, base: baseTarget }))
      if (due.target !== null) {
        currentTarget = { ...dialTarget }
        currentIsTransfer = true
      }
      if (due.target) {
        log('transferFollowConnect', {
          host: due.target.host,
          port: due.target.port,
          kind: due.kind,
          attempt,
          failures: due.failures
        })
      }
    } catch (error) {
      log('transferFollowTargetRejected', { error: String(error?.message ?? error).slice(0, 200) })
      core.abortTransfer('invalid_target')
      revertToSettled('invalid_target')
    }

    try {
      await backend.connect()
      const readiness = await settleWarm({
        stage: due.target ? 'transfer' : 'reconnect',
        maxWarmMs: 5000
      })
      if (!readiness.hasConfig || !readiness.hasPrefix || readiness.warmRefused === true) {
        throw new Error(readiness.warmRefused === true
          ? 'backend reconnect produced no chunk frame, so no client can be released on it'
          : 'backend reconnect did not produce configuration and join frames')
      }
      const outcome = follow.onSuccess()
      settledTarget = { ...dialTarget }
      settledIsTransfer = transferDial
      log('backendReconnect', {
        delayMs,
        attempt,
        target: `${dialTarget.host}:${dialTarget.port}`,
        followed: outcome.followed,
        warm: readiness.warm,
        backendLogins: core.session.backendLogins,
        state: core.session.state
      })
    } catch (error) {
      const failure = follow.onFailure()
      log('backendReconnectFailed', {
        delayMs,
        attempt,
        target: `${dialTarget.host}:${dialTarget.port}`,
        error: String(error?.message ?? error).slice(0, 300),
        failures: failure.failures,
        state: core.session.state
      })
      if (failure.reverted) {
        // The followed target is unreachable; the next reconnect goes back to
        // the server the client was restored onto so the puppet is never
        // stranded and never lands where the client is not.
        core.abortTransfer('target_unreachable')
        revertToSettled('target_unreachable')
        log('transferFollowReverted', {
          host: failure.abandoned?.host ?? null,
          port: failure.abandoned?.port ?? null,
          kind: due.kind
        })
      }
      const outcome = core.session.fail()
      log('backendReconnectFailedRetry', {
        scheduled: outcome?.scheduled === true,
        nextDelayMs: outcome?.scheduled === true ? outcome.delayMs : null
      })
    } finally {
      reconnecting = false
    }
  })

  // #87: a restored move sends the puppet back to the server the client was
  // restored onto. Without this the follow controller keeps a target the core
  // has already given up on, and the next dial lands the puppet on the server
  // the human was just moved off.
  core.on('transfer_restored', ({ reason = null, kind = null } = {}) => {
    // The decision is `control.js`'s, so the one case that must not revert is
    // asserted in a unit test rather than read here: #233 read this as "not a
    // transfer, keep the target" and re-dialled the server that never answered,
    // with the client attached, for as long as the process lived.
    if (!revertAfterRestore({ kind })) {
      log('transferRestoreKeptTarget', { reason, kind })
      return
    }
    const { abandoned } = revertToSettled('restored')
    log('transferFollowAbandoned', {
      reason,
      host: abandoned?.host ?? null,
      port: abandoned?.port ?? null
    })
  })

  // Every failure after this point owns a live backend client and (online) the
  // token-custody writer lock. Release both before returning, or the process
  // hangs with the lock held.
  async function stopAfterFailure (stage, fields = {}) {
    log('startLiveFailed', { stage, ...fields })
    journal.event('startLiveFailed', { stage, ...fields })
    try { await core.stop({ reason: `startup_failed:${stage}` }) } catch { /* best effort */ }
    try { await front.close() } catch { /* best effort */ }
    try { await backend.close() } catch { /* best effort */ }
    try { await telemetry.flush() } catch { /* best effort */ }
    journal.close()
    if (sink !== stdout) sink.end?.()
  }

  const accountLogFields = resolved
    ? {
        accountUuid: resolved.account.uuid,
        accountName: resolved.account.profile?.name ?? null,
        accountAlias: resolved.account.alias ?? null,
        accountDir: resolved.account.dir
      }
    : {
        accountUuid: cfg.puppet.uuid,
        accountName: cfg.puppet.username,
        accountAlias: null,
        accountDir: cfg.puppet.cacheDir
      }
  // #331: one address, written to both records, so the log line and the journal
  // event cannot name different backends.
  const backendAddress = `${configuredTarget.host}:${configuredTarget.port}`
  log('startLive', {
    version: cfg.version,
    chat: cfg.chat,
    transferFollow: cfg.transfer.follow,
    // #391: a lane that asks no session server who a client is says so in its
    // own start record, and in the journal beside it.
    offlineLegs: cfg.offlineLegs === true,
    // #257: whether a join with no backend is served a picker, and whether this
    // process found a recording to serve it with. The second is the difference
    // between a picker and a refusal, and it is a file that ships with the image.
    picker: cfg.picker,
    pickerBaseline: baseline === null ? null : baseline.version,
    front: `${cfg.front.host}:${cfg.front.port}`,
    // #331: one label. The lane starts on the configured backend, and every later
    // target comes from a transfer. So this is both the target it dials first and
    // the one the config document asks for. A reader that wants the configured
    // target after a transfer reads this record, not a second field beside it.
    backend: backendAddress,
    control: {
      whitelistReload: whitelistSource !== null,
      // #262: the two paths, which file answered, and how many servers it offers.
      // #265: the picker reads this key at each offer, so these numbers are the read
      // at start. A lane with no list says `none` here rather than looking wired.
      allowedServers: {
        file: cfg.control.allowedServers ?? null,
        seed: cfg.control.allowedServersSeed ?? null,
        source: allowedServersAtStart.source,
        count: allowedServersAtStart.servers.length
      }
    },
    ...accountLogFields,
    attachWhitelist: cfg.attachWhitelistFile,
    whitelistCount: cfg.attachWhitelist.length
  })
  journal.event('startLive', {
    version: cfg.version,
    chat: cfg.chat,
    transferFollow: cfg.transfer.follow,
    offlineLegs: cfg.offlineLegs === true,
    front: `${cfg.front.host}:${cfg.front.port}`,
    backend: backendAddress,
    ...accountLogFields,
    whitelistCount: cfg.attachWhitelist.length,
    reconnect: {
      // A config document's 0 is how an operator writes "unlimited", so the
      // record says what the lane will do, not what the document wrote. The
      // predicate is the session's own (src/core/session.js:74).
      attempts: Number.isFinite(cfg.reconnect.attempts) && cfg.reconnect.attempts > 0
        ? Math.floor(cfg.reconnect.attempts)
        : 'unlimited',
      maxDelayMs: cfg.reconnect.maxDelayMs
    }
  })

  // --- 3. backend connect ---
  // A picker lane dials nothing here, and `dialBodyAtBoot` is what decides it.
  // The dev lane is what happens otherwise: its own granted claim was restored
  // with `session_busy` because the body it asked for was already connected.
  let boot
  try {
    boot = await dialBodyAtBoot({ cfg, backend, log })
  } catch (error) {
    await stopAfterFailure('backend_connect', { error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }

  // --- 4. readiness: cached config + join prefix (warm preferred) ---
  // Warm fallback for unbatched backends: after the grace window the marker
  // never arrived, so the join prefix is declared pinned at its current edge
  // (counted, logged; the marker path stays untouched for backends that do
  // batch). Attach readiness without this would never clear and the growing
  // prefix would eventually evict the login frame.
  //
  // Only a body that was dialled has anything to warm. A picker lane fills
  // its cache when a claim dials, and the front serves the picker until then.
  const readiness = boot.dialled
    ? await settleWarm({ stage: 'startup', maxWarmMs: 20_000 })
    : null
  if (readiness !== null && (!readiness.hasConfig || !readiness.hasPrefix)) {
    await stopAfterFailure('cache_readiness', readiness)
    return 1
  }

  // --- 5. front listen + readiness log ---
  let bound = null
  try {
    bound = await front.listen()
  } catch (error) {
    await stopAfterFailure('front_listen', { error: String(error?.message ?? error).slice(0, 300) })
    return 1
  }
  // The readiness numbers describe a body. A lane that dialled none says
  // `null` rather than `0`, and the boot row says which answer this is.
  log('liveReady', {
    front: `${bound.host}:${bound.port}`,
    ...accountLogFields,
    boot: boot.dialled ? 'dialled' : 'skipped',
    // Null, not false: a lane that dialled nothing has no connection to report
    // on, and false would name a fault that did not happen.
    backendConnected: boot.dialled ? !backend.ended : null,
    configFrames: readiness?.configFrames ?? null,
    prefixFrames: readiness?.prefixFrames ?? null,
    warm: readiness?.warm ?? null,
    wire: front.wireStats
  })
  journal.event('liveReady', {
    front: `${bound.host}:${bound.port}`,
    ...accountLogFields,
    boot: boot.dialled ? 'dialled' : 'skipped',
    configFrames: readiness?.configFrames ?? null,
    prefixFrames: readiness?.prefixFrames ?? null,
    warm: readiness?.warm ?? null
  })

  // #229: when the puppet's Minecraft token expires, the one "info" fact the
  // panel cannot reach any other way. Read at each heartbeat, because a token
  // refresh moves it. Unknown is null, never a guess.
  const account = {
    alias: resolved?.account.alias ?? null,
    expiresAt: () => {
      // #391: an offline lane holds no token, so nothing expires. It says so
      // rather than reading a custody directory the lane was built without.
      if (cfg.offlineLegs === true) return null
      return resolved
        ? accountTokenExpiry({
          dir: resolved.account.dir,
          account: resolved.account.alias ?? resolved.account.name ?? resolved.account.uuid
        })
        : accountTokenExpiry({ dir: cfg.puppet.cacheDir, account: cfg.puppet.cacheAccount ?? null })
    }
  }
  await runForever({
    core,
    backend,
    front,
    log,
    sink,
    telemetry,
    journal,
    account
  })
  return 0
}

async function runForever ({
  core,
  backend,
  front,
  log,
  sink,
  telemetry,
  journal,
  account = { alias: null, expiresAt: () => null },
}) {
  let stopping = false
  let lastRejected = front.wireStats.rejected
  let lastPreAuthRefused = front.metrics.preAuthRefused
  let lastPreAuthExpired = front.metrics.preAuthExpired

  // Heartbeat gauges: the same values the JSONL heartbeat logs, as OTLP gauges.
  // `bodies` is the sample the tick already took, so a gauge and the record beside
  // it are one reading rather than two instants. A caller with none takes its own.
  function emitGauges (bodies = null) {
    const stats = core.cache.stats()
    telemetry.metric('monoplayer.attached', core.attached ? 1 : 0, {}, 'gauge')
    telemetry.metric('monoplayer.warm', stats.warm ? 1 : 0, {}, 'gauge')
    telemetry.metric('monoplayer.backend.logins', core.session.backendLogins, {}, 'gauge')
    telemetry.metric('monoplayer.cache.frames', cachedFrames(stats), {}, 'gauge')
    // #415: one point per body the lane holds, and never a channel.
    emitBodyGauges(telemetry, bodies ?? sampleBodies({ core }))
    const rejected = front.wireStats.rejected
    if (rejected > lastRejected) {
      telemetry.metric('monoplayer.wire.rejected', rejected - lastRejected, {})
      lastRejected = rejected
    }
    // #201: a refused pre-auth connection, sampled at each heartbeat like the
    // wire rejections: the front leg owns the socket, so the core never sees the
    // connection that was turned away. The leg counts one reason today, so the
    // attribute repeats the constant. #204's per-source reasons will turn the
    // leg's count into a map, and this sampling will read it.
    const preAuthRefused = front.metrics.preAuthRefused
    if (preAuthRefused > lastPreAuthRefused) {
      telemetry.metric('monoplayer.preauth.refused', preAuthRefused - lastPreAuthRefused,
        { reason: PREAUTH_CLOSE_REASON.CONNECTION_CAP })
      lastPreAuthRefused = preAuthRefused
    }
    // #205: a connection the deadline destroyed. It was admitted, so this is not
    // a full window: a socket sat in it and never left. Kept apart from the
    // refusal sum because the two ask different questions of an operator.
    const preAuthExpired = front.metrics.preAuthExpired
    if (preAuthExpired > lastPreAuthExpired) {
      telemetry.metric('monoplayer.preauth.expired', preAuthExpired - lastPreAuthExpired,
        { reason: PREAUTH_CLOSE_REASON.DEADLINE })
      lastPreAuthExpired = preAuthExpired
    }
  }

  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    log('shutdown', { signal })
    journal.event('shutdown', { signal })
    try { await core.stop({ reason: `signal:${signal}` }) } catch { /* ignore */ }
    front.close()
    backend.close()
    try { await telemetry.flush() } catch { /* telemetry never blocks shutdown */ }
    journal.close()
    sink.end?.()
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.off(signal, stop)
    process.on(signal, () => { stop(signal).catch(() => {}) })
  }
  emitGauges()
  const heartbeat = setInterval(() => {
    const stats = core.cache.stats()
    const forwarder = backend.forwarderStats()
    // #415: the per-body and the per-channel group, one sample for both the gauges
    // and the record.
    const groups = sampleHeartbeatGroups({ core, front })
    emitGauges(groups.bodies)
    log('heartbeat', {
      attached: core.attached,
      backendLogins: core.session.backendLogins,
      warm: stats.warm,
      metrics: { ...core.metrics },
      // #216: what the cache holds at this instant, beside the cumulative
      // counters above. chunkBytes is written only at backend login today, and
      // it is 0 there by construction, so this is the one place an operator can
      // read the byte figure from the pod log.
      sizes: stats.sizes,
      chunkBytes: stats.chunkBytes,
      // #415: what each body holds, and what each open channel was sent. The
      // channels are here and in the journal, and never as an OTLP attribute: a
      // channel is one connection, so a series per channel is unbounded.
      ...groups,
      // #201: the front leg's own counters, which the core cannot hold: the
      // accepted sockets, the logins allowed and denied, and the pre-auth
      // refusals this heartbeat is the place to watch.
      front: front.metrics,
      wire: front.wireStats,
      backendFrames: forwarder ? { ...forwarder.counters, names: forwarder.names } : null,
      // #229: the account the lane speaks for, and when its Minecraft token
      // expires. A gauge of a timestamp in epoch milliseconds; null when the
      // custody cache does not say, which is not the same as "no expiry".
      account: { alias: account.alias, expiresAt: account.expiresAt() },
      // Export health: a silent OTLP or journal failure must be visible from
      // the pod log alone, without querying the collector.
      telemetry: telemetry.stats(),
      journal: journal.stats()
    })
    // #415: the per-channel half of that record goes to the journal too, so the one
    // artifact built for a diagnosis holds the third group the ticket names. An
    // event per heartbeat, because a channel's numbers are its own and no frame
    // record names one.
    journal.event('channels', { open: groups.channels.length, channels: groups.channels })
  }, 30_000)
  heartbeat.unref?.()
  // The process stays up: the backend leg's end handler routes through the core.
  return new Promise(() => { /* outlive the event loop on purpose */ })
}

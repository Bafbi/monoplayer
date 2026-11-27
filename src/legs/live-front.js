// The Monoplayer front leg: one authenticated player attaches through a
// minecraft-protocol server while the puppet holds the backend session.
//
// Two constructors share one body, and the offline path is a separate
// constructor, never a config flag:
//   createLiveFrontLeg    online-mode=true, real sessionserver hasJoined,
//                         UUID-keyed attach whitelist file (.secrets).
//   createOfflineFrontLeg online-mode=false, loopback only unless allowNonLoopback,
//                         local offline identities (#391)
//                         UUID whitelist, no .secrets read.
//
// Flow per connection:
//   0. #201 the pre-auth window. A socket is counted from the moment it is
//      accepted until the whitelist accepts its resolved UUID. Over the cap the
//      socket is closed here, before any of the steps below: no login review, no
//      interceptor, no channel. An accepted, authenticated session has left
//      the window, so the cap can never refuse one. #205: the same window has a
//      deadline. A connection still in it when its timer fires is destroyed, so
//      a socket that never speaks cannot hold a slot until its peer closes.
//   1. library login. Online: encryption + real sessionserver hasJoined (real
//      client.uuid / client.username / client.profile are set by the library
//      BEFORE our synchronous beforeLogin hook runs). Offline: the library
//      sets client.uuid to the vanilla offline UUID (MD5 of
//      "OfflinePlayer:<name>").
//   1b. #722: a session the sessionserver refuses never reaches beforeLogin. The
//      library ends that connection itself, with the one sentence it has, so the
//      socket's end reason is the whole record of the refusal: the leg counts it and
//      writes it there, and nothing else on this path does.
//   2. beforeLogin (synchronous; createServer option): run the core login decision
//      (fail closed) and the mode's check. No attach slot refuses a second client
//      here: a lane that offers a picker sends it to the picker, where the claim
//      refuses it (#259), and a lane with no picker is refused by the core's own
//      login decision, before Login Success and before any configuration frame
//      (#312). Deny = client.end(text ?? 'attach denied (...)'): the Server.end
//      override writes the login-state disconnect then ends the serializer chain,
//      so the library's follow-up compress/success writes in loginClient are
//      mechanically dropped (client.write no-ops on an ended serializer).
//   2b. #257/#267: a login the core allowed with no backend to attach to
//      (`picker: true`) is served the recorded configuration baseline and the
//      picker dialog. The click that claims a body is recorded here (#267), at that
//      click and not at login; the claim is held by the connection and released when
//      the connection ends.
//   2c. #269: delivery is a channel's, not a slot's. A channel is one
//      connection's delivery of one body: its role, what it has been sent, and its
//      own client information (src/core/channels.js). A body's driver and its
//      spectators are channels on that body, and every frame this leg writes goes to
//      all of them. A second claim on a driven body is refused by the claim, and a
//      spectator's frames never reach the core.
//
//   2d. #258: a granted claim is the one thing that lands a client. The leg asks
//      the caller for the body the frame named, and only after the click. A body
//      that answers continues the client's open configuration phase with its own
//      frames and ends it with one finish frame. The picker's phase carried no
//      registry data (#598), so the set the body it lands the client in sends is
//      the one the client loads at that finish. The client then reaches
//      playerJoin, where the core replays that body's play state on the socket the
//      client already holds. A body that refuses the dial offers the list again,
//      instead of leaving the client in a dialog nobody will read.
//   3. allow — cached configuration replay path: the library's automatic
//      configuration (segmented registry_data from its own built-in codec,
//      then finish_configuration) is intercepted via beforeLogin write
//      wrapping: registry_data is suppressed, the library's
//      finish_configuration write is deferred, and the deferred write instead
//      replays the core's cached backend configuration frames (writeRaw,
//      state configuration, excluding finish_configuration) before letting
//      the library-authored finish_configuration through. With no cached
//      configuration frames (backend not warm when the client arrives), the
//      stashed library registry_data is re-emitted instead (fallback path —
//      recorded limitation, see docs/product-core.md).
//   4. server event 'playerJoin' (client finished configuration): call the
//      core attachPlayer({ name, uuid, includeConfig:false }) — the core
//      replays the play join prefix + warm state; the configuration phase
//      belongs to the front leg (omitted via the join-synth option).
//   5. serverbound play frames (raw buffer + decoded data) go to the core's
//      setServerboundHandler pipeline; client end/error go to the core detach.
//   6. a client's Client Information (`settings`) is recorded on its own channel as
//      it arrives (#269). Only the driver's is reported to the core, and only outside
//      play (#18): a play-state change travels the serverbound pipeline, and a
//      spectator's settings reach nothing. The core owns what the backend sees: the
//      driver's fields with the backend's view distance cap.
//   7. #22: the core may ask the attached client to re-enter configuration on
//      the same connection (`startReconfiguration`). The leg writes the
//      play-state `start_configuration` and holds the core's configuration
//      frames until the client answers with the play-state
//      `configuration_acknowledged` (the packet id exists in play only). It
//      then flips its own client to the configuration state, flushes the held
//      frames, and reports the client's `finish_configuration` back as
//      `reconfigured` once the client is in play again. The client is never
//      told to reconnect.
//
// Identity: the attaching client is whitelisted as itself (real hasJoined
// profile online, vanilla offline UUID offline). The replayed play stream
// still describes the puppet's session (backend entity id and state).
import mc from 'minecraft-protocol'

import { createAttachCheck, DENY_REASONS } from '../custody/attach.js'
import { createWhitelistStore } from '../custody/store.js'
import { normalizeUuid } from '../custody/util.js'
import { pickTextures } from '../core/skin.js'
import { isLoopbackHost } from './offline-identity.js'
import { bumpBounded } from '../core/bounded-counter.js'
import { CLAIM_REFUSAL, createClaims } from '../core/claims.js'
import { CHANNEL_ROLES, channelIdentity, createChannels, stampIdentity } from '../core/channels.js'
import { CHAT_MODES, clientboundPolicy, mayCrossToFront } from '../core/clientbound-policy.js'
import { isPoseFrame } from '../core/relay.js'
import { createPreAuthWindow } from '../core/preauth-window.js'
import {
  PICK_VERBS,
  claimRestoreTitle,
  createPickerBoard,
  pickTarget,
  pickerDialogParams,
  serverDialogParams,
  verbIdFor
} from '../core/picker.js'
import { baselineFramesFor } from './configuration-baseline.js'

const WIRE_MODES = new Set(['throw', 'warn', 'off'])
// The configuration prefix the cache holds is bounded at 1024 frames, so a
// reconfiguration cannot need more. The bound exists only so a client that
// never acknowledges cannot grow the leg's memory without limit.
const MAX_PENDING_RECONFIGURATION_FRAMES = 1024
// #722/#742: the sentences `minecraft-protocol` ends a connection with, before this
// leg reviews the login. Its login handler refuses for reasons of its own, and its
// handshake refuses a client of another protocol version. It refuses for reasons of its
// own — a profile key that is missing, expired, or does not verify, an encryption
// answer it cannot decrypt, a client that never sent a login start, and the
// sessionserver's own answer — and every one of them is one fixed string. That string
// is the whole of what reaches this leg: no hook of this leg ran for the client, so
// there is no code to read instead of it.
//
// The word on the right is what this leg counts the refusal under. It is a word and
// not the sentence, because a count keyed by a client-facing sentence is a chart keyed
// by punctuation; the record carries the sentence itself as `text`.
//
// The table is read back out of the installed library by
// test/legs/library-login-refusals.test.js, which fails when a fork bump adds, renames
// or drops a sentence. A sentence missing here is a refusal the lane does not record.
// `'socketClosed'` is absent on purpose: it is the library's word for a peer that went
// away, and it refused nothing.
export const LIBRARY_LOGIN_REFUSALS = new Map([
  // The sessionserver's answer. The word is #722's, and the attach check's own word for
  // a failed `hasJoined`, kept because `monoplayer.session.refused` charts this one
  // sentence under it.
  ['Failed to verify username!', DENY_REASONS.HASJOINED_FAILED],
  // The handshake's own answer, and the one a client on another protocol version gets:
  // the leg pins a version, so such a client is refused here, before it can send a login
  // start at all. The library builds this sentence around the two numbers it compared,
  // so it is matched by its prefix and not as a whole.
  ['Wrong protocol version, expected: ', 'protocol_version_mismatch'],
  // A login-start with no profile key, and an encryption answer whose key the client
  // already has: the two sites that ask for one.
  ['multiplayer.disconnect.missing_public_key', 'missing_public_key'],
  // A profile key that is not a key this server can read.
  ['multiplayer.disconnect.invalid_public_key', 'invalid_public_key'],
  // A key whose signature is expired, or does not verify under Mojang's.
  ['multiplayer.disconnect.invalid_public_key_signature', 'invalid_public_key_signature'],
  // The encryption answer does not decrypt, or carries the wrong verify token.
  ['DidNotEncryptVerifyTokenProperly', 'did_not_encrypt_verify_token_properly'],
  // No login start arrived inside the library's own kick timeout. A client that never
  // spoke, refused in its own words rather than by this leg's pre-auth deadline.
  ['LoginTimeout', 'login_timeout'],
  // The handshake's other sentence, for a lane that lets a client choose its version
  // (`version: false`). It cannot reach the leg's own server, and it is here so the table
  // is the library's set rather than the lane's reachable subset.
  ['Protocol version ', 'protocol_version_unsupported']
])

// Two of those entries are not whole sentences: the library builds them around the
// protocol numbers it compared, so a text match needs a prefix. They are listed here by
// word rather than marked in the table, because the table is read as sentences by the
// doc and by test/legs/library-login-refusals.test.js. The whole sentences are asked
// first, so an entry that is a prefix of a longer one is still spelled as the library
// spells it.
const COMPOSED_REFUSAL_WORDS = new Set(['protocol_version_mismatch', 'protocol_version_unsupported'])

// #435's rule, for this map: the cap is headroom over the closed set. It is this map's
// own fact, and not `MAX_REFUSAL_REASONS`, because that one bounds the picker's set
// above: each closed vocabulary owns its bound, and a reader of either number finds the
// set it belongs to beside it.
const MAX_LIBRARY_REFUSAL_REASONS = LIBRARY_LOGIN_REFUSALS.size + 3

// The word this leg counts one of the library's sentences under, or undefined for text
// the library did not refuse a login with.
export function libraryRefusalWord (text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const exact = LIBRARY_LOGIN_REFUSALS.get(text)
  if (exact !== undefined) return exact
  for (const [sentence, word] of LIBRARY_LOGIN_REFUSALS) {
    if (COMPOSED_REFUSAL_WORDS.has(word) && text.startsWith(sentence)) return word
  }
  return undefined
}

// Pure configuration-phase interceptor (unit-testable without sockets):
// wraps a client write so the library's generated configuration resolves to
// the cached-replay contract. `isConfigurationState` reports the client's
// protocol state at write time; `cachedConfigFrames` are { name, buffer }
// frames captured from the backend (core cache snapshot `.config`).
export function createConfigPathInterceptor ({
  write: originalWrite,
  writeRaw,
  isConfigurationState,
  cachedConfigFrames,
  finishName = 'finish_configuration',
  // #257: the configuration phase to serve when there is no backend at all,
  // which is the picker. `baselineConfigFrames` is a recording of a real server's phase
  // (src/legs/configuration-baseline.js), and it is served instead of the cached
  // one, in the state that has no backend to replay: the picker's. The phase is
  // deliberately left open: `onBaselineFrames` runs once the frames are on the
  // wire, and the caller sends the dialog there. No finish frame goes out,
  // because the dialog is the phase. Its frames carry no registry data either
  // (#598): `baselineFramesFor` withholds that set, so the body a claim lands the
  // client in is the one the client loads. A registry frame here would be a second
  // copy of one id in one phase, which a client answers by disconnecting.
  baselineConfigFrames = [],
  onBaselineFrames = null,
  // The library's generated registry_data is a fallback for fakes and the
  // offline rung. The live path must never serve it: it carries no registry
  // tags, so a 26.2 client fails registry loading and crashes. Set false to
  // let onUnavailable close the client with a clear message instead.
  allowLibraryFallback = true,
  // #16: the puppet is still in its own configuration phase, so there is
  // nothing cached to replay. Hold the library's finish_configuration and let
  // the core stream the puppet's frames; finishFromCore() ends the phase when
  // the backend's own finish arrives.
  live = false,
  onUnavailable = null,
  // #16: fired once, when the library hands the client to its configuration
  // phase. This is the first moment a configuration frame can reach the client
  // in a state it parses; the attach call-in runs during login, before the
  // library writes Login Success.
  onConfiguring = null,
  // #541: a configuration frame written after the phase's finish, which is
  // dropped. The leg counts it and records it; the interceptor owns no log.
  onSuppressed = null
}) {
  if (typeof originalWrite !== 'function') throw new TypeError('write is required')
  if (typeof writeRaw !== 'function') throw new TypeError('writeRaw is required')
  if (typeof isConfigurationState !== 'function') throw new TypeError('isConfigurationState is required')
  if (!Array.isArray(cachedConfigFrames)) throw new TypeError('cachedConfigFrames must be an array')
  if (!Array.isArray(baselineConfigFrames)) throw new TypeError('baselineConfigFrames must be an array')
  if (onBaselineFrames !== null && typeof onBaselineFrames !== 'function') {
    throw new TypeError('onBaselineFrames must be null or a function')
  }

  let resolved = false
  let notified = false
  const stashed = [] // library-authored registry_data params (fallback only)
  // #541: the phase's finish is the last configuration frame a client can parse.
  // The client answers it and is in play from that moment; this leg learns the
  // answer only when the client's finish arrives, so a frame written in between
  // carries a configuration packet id into a connection reading the play table.
  // The library's own keep-alive does exactly that, on the interval the vendored
  // copy of it runs.
  // A round opens the phase again through reopenConfiguration.
  let finishSent = false
  const stats = { suppressedRegistryData: 0, replayedConfigFrames: 0, baselineFrames: 0, unavailable: 0, finishedByCore: 0 }

  // #16: the client is in its configuration phase now. One notification per
  // connection, whichever path resolves first.
  function notifyConfiguring () {
    if (notified) return
    notified = true
    onConfiguring?.()
  }

  function resolveConfigPath () {
    if (resolved) return
    notifyConfiguring()
    // Live: the core owns every configuration frame, including the finish, so
    // the library's finish write is dropped and the phase stays open.
    if (live) return
    resolved = true
    if (baselineConfigFrames.length > 0) {
      // #257: the picker. The recording is the phase, in its recorded order and
      // as recorded bytes. The finish stays unwritten, so the client remains in
      // configuration with the dialog on screen.
      for (const frame of baselineConfigFrames) {
        // The recording carries the server's finish. The picker never sends one.
        if (frame.name === finishName) continue
        // #602: `writeRaw` is the leg's funnel now, and it answers false for a frame it
        // refuses. The hold is the other way it answers true without writing, and it cannot
        // reach this loop: a frame is held only for a client in play with a reconfiguration
        // pending, and this replay runs in the client's configuration phase.
        if (writeRaw(frame.buffer, { state: 'configuration', name: frame.name }) !== false) {
          stats.baselineFrames++
        }
      }
      onBaselineFrames?.()
      return
    }
    if (cachedConfigFrames.length > 0) {
      for (const frame of cachedConfigFrames) {
        if (frame.name === finishName) continue // finish goes out exactly once, from the call site below
        if (writeRaw(frame.buffer, { state: 'configuration', name: frame.name }) !== false) {
          stats.replayedConfigFrames++
        }
      }
    } else if (allowLibraryFallback) {
      for (const entry of stashed) {
        originalWrite('registry_data', entry.params)
        stats.replayedConfigFrames++
      }
    } else {
      // No backend configuration to replay and the library fallback is off:
      // close instead of handing the client an incomplete registry set.
      stats.unavailable++
      if (onUnavailable) onUnavailable()
      return
    }
    originalWrite('finish_configuration', {}) // the library call, now ordered after the replay
    finishSent = true
  }

  // #599: one rule, two write paths. A configuration frame offered after this phase's
  // finish is one the client reads in play (#541), and the flag that says so is this
  // interceptor's. The leg's raw funnel asks this, because the rule the interceptor keeps
  // for the library's own writer has to hold for every other writer too. A second
  // statement of the condition is a second answer, waiting to disagree.
  function refusesAfterFinish ({ state = null } = {}) {
    return finishSent === true && state === 'configuration'
  }

  function wrappedWrite (name, params) {
    if (!isConfigurationState()) {
      return originalWrite(name, params)
    }
    // The frame this writer carries is the state the library serializes it in, and the
    // gate above has already said that state is configuration.
    if (refusesAfterFinish({ state: 'configuration' })) {
      // #541: past this phase's finish, a configuration frame is one the client
      // reads in play. Nothing is written, and the caller is told so it does not
      // count the frame as delivered.
      onSuppressed?.({ name })
      return false
    }
    if (name === 'registry_data' && !resolved) {
      stashed.push({ name, params })
      stats.suppressedRegistryData++
      return
    }
    if (name === finishName && !resolved) {
      resolveConfigPath()
      return
    }
    // #602: the phase's finish closes the phase whichever writer sends it. A landing
    // writes it through this function on a client whose path is already resolved (the
    // picker's baseline, and the cached replay), and a configuration frame after it is
    // one the client reads in play (#541). `finishSent` was set only where this leg's
    // own resolve wrote the finish, so those two clients were the gap.
    //
    // Set after the write, because a throw is the only failure this library reports: its
    // `write` answers undefined whether or not the serializer could write. A finish that
    // threw is a phase still open, which is what lets the refusal's own `disconnect`
    // through the guard above. A serializer that could not write delivers that disconnect
    // no better than it delivered the finish, so the flag is right for that case too.
    if (name === finishName) {
      const sent = originalWrite(name, params)
      finishSent = true
      return sent
    }
    return originalWrite(name, params)
  }

  // The core relayed the backend's finish_configuration to the client. The
  // client already has that frame on the wire, so the library's deferred write
  // must never follow it.
  function finishFromCore () {
    // #541: every round on the connection closes here, not only the first. A
    // login-phase replay already resolved the interceptor, and a later followed
    // move still ends its phase on the core's finish frame.
    finishSent = true
    if (resolved) return false
    resolved = true
    stats.finishedByCore++
    return true
  }

  // #541: a round on the connection the client already holds opens the phase
  // again. The leg calls this where it decides the round starts, because the
  // frame that starts it is written in play and is not a configuration write.
  function reopenConfiguration () {
    finishSent = false
  }

  return {
    write: wrappedWrite,
    finishFromCore,
    reopenConfiguration,
    get live () { return live },
    get resolved () { return resolved },
    // #599: exported so the leg's raw funnel asks the rule instead of restating it. The
    // comment above the function is the rule's one home.
    refusesAfterFinish,
    get replayMode () {
      if (live) return 'live_stream'
      if (!resolved) return 'pending'
      if (baselineConfigFrames.length > 0) return 'baseline'
      if (cachedConfigFrames.length > 0) return 'cached_replay'
      return 'library_fallback'
    },
    stats
  }
}

// #87: the front client's error policy. minecraft-protocol's default handler
// ends the connection with the Error object itself, and in play that writes
// `kick_disconnect`, whose reason is an NBT string: the serializer fails
// ("SizeOf error for undefined ... Received an instance of Error"), its failure
// becomes the end reason, and the socket is destroyed 30 s later
// (`closeTimeout`) with that TypeError. The connection still ends — an error on
// the attaching client's connection is not survivable — but with one line of
// text, so nothing carries an Error into a packet field.
export function frontErrorKickReason (error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? error)
  return `front_error: ${message}`.slice(0, 200)
}

export function createFrontErrorHandler ({ log = () => {} } = {}) {
  return function frontErrorHandler (client, error) {
    const reason = frontErrorKickReason(error)
    log('frontError', {
      reason,
      username: client?.username ?? null,
      state: client?.state ?? null
    })
    try { client.end(reason) } catch { /* the client is already gone */ }
  }
}

// #87: the configuration round's end frame, as the wire carries it. A restore
// with no cached finish_configuration still has to end the phase the client is
// in. Written as a packet object it would be serialized against whatever state
// the client holds at that moment — play, before it answers the round's
// acknowledgement, where finish_configuration has no packet id at all — so the
// leg builds the bytes and the core writes them through writeRaw with the
// configuration state, like every other configuration frame.
export function configurationFinishFrame ({ version = '26.1' } = {}) {
  const serializer = mc.createSerializer({ state: 'configuration', isServer: true, version })
  return serializer.createPacketBuffer({ name: 'finish_configuration', params: {} })
}

// One client-facing raw frame, with the optional strict wire check applied.
// `wireCheck` is ({ state, name, buffer }) => { ok, code, ... }. Returns true
// when the frame reached writeRaw, false when mode 'throw' suppressed it.
// `stats` is the front leg's wireStats body: checked/rejected/lastFailure.
export function emitCheckedRaw ({
  client,
  buffer,
  meta = null,
  wireCheck = null,
  wireMode = 'warn',
  stats = { checked: 0, rejected: 0, lastFailure: null, byState: {} },
  log = () => {}
} = {}) {
  const state = meta?.state ?? null
  const name = meta?.name ?? null

  if (wireCheck && wireMode !== 'off') {
    stats.checked++
    if (!stats.byState) stats.byState = {}
    // #554: the one name map in the legs that takes no cap. Its key is the wire state,
    // which this leg and the core write as literals and the library's own state machine
    // writes from its five, so the map is bounded by that vocabulary rather than by a
    // number. A cap could only fold a state nobody here has seen into a bucket that is
    // not a state name, and the map's whole fact is which state a frame was refused in.
    const stateKey = state ?? 'unknown'
    stats.byState[stateKey] = (stats.byState[stateKey] ?? 0) + 1
    let result
    try {
      result = wireCheck({ state, name, buffer })
    } catch {
      result = { ok: false, code: 'wire_check_error' }
    }
    if (!result || result.ok !== true) {
      stats.rejected++
      const failure = {
        state,
        name,
        code: result?.code ?? 'wire_check_failed',
        parsedName: result?.parsedName ?? null,
        consumed: result?.consumed ?? null,
        total: result?.total ?? null,
        leftover: result?.leftover ?? null
      }
      stats.lastFailure = failure
      // Never log frame bytes; the failure report is metadata only.
      log('wireReject', failure)
      if (wireMode === 'throw') {
        try { client?.end('wire_reject') } catch { /* client already gone */ }
        return false
      }
    }
  }

  client?.writeRaw(buffer)
  return true
}

// #269: which channel's client information the core hears about. Two rules, and
// they are the whole decision:
//   - only the driver's, because the fields the puppet sends are the driving
//     client's. A spectator's information is its own and is recorded on its own
//     channel, so one client can never overwrite another's;
//   - only outside play, because a play-state change travels the normal
//     serverbound pipeline, where the core rewrites it with the view distance
//     cap. Reporting it here too would write the packet to the backend twice.
export function reportsClientInformation ({ role = null, state = null } = {}) {
  if (role !== CHANNEL_ROLES.DRIVER) return false
  return state !== 'play'
}

// #417: the picker's numbers, measured where only this leg can. The helpers below
// are exported because the leg itself is reached through a listening socket, and a
// number that only a listening socket can be asked about is a number no test reads.

// #671: the closed set the refusal map is keyed by. The reasons are still decided where they
// are decided, in four modules and at this leg's own counted sites, and docs/telemetry.md
// states the same set for an operator. This is the one list of them, and
// test/observability/telemetry-doc.test.js holds the three equal in both directions, so a
// reason added to one side and not the other fails the gate and the failure names the row to
// edit. #670 and #708 each moved the set inside four hours, which is what nothing catching
// that looked like.
//
// A list and not a module-by-module map: which module decides a reason is that module's fact,
// and this file has no business stating it.
export const PICKER_REFUSAL_REASONS = Object.freeze([
  // A click the board could not read, and a click naming a server the offer does not carry.
  'unknown_id',
  'malformed',
  'unknown_verb',
  'unknown_server',
  // `CLAIM_REFUSAL` (src/core/claims.js): the body is another connection's, or this one
  // already holds a claim.
  'body_claimed',
  'claim_held',
  // The Spectate answer, before the body is handed over.
  'picker_off',
  'no_body',
  'body_not_served',
  'body_down',
  'body_not_warm',
  // This leg: a dialog it could not write, a lane with no row, the Disconnect verb, and every
  // refusal of the Spectate landing.
  'empty_offer',
  'picker_unavailable',
  'disconnect_claimed',
  'no_spectator_sink',
  'unwatchable',
  'channel_refused',
  'no_cached_configuration',
  'finish_failed'
])

// #438: the rule is src/core/bounded-counter.js, the same one the composition root
// counts its packet names with, so the two sides cannot drift apart again. The cap
// below is this leg's own fact.
// #435: the cap is headroom over the closed set, never the set's size. A named
// reason that reaches the cap is a reason an operator's chart shows as `other`,
// which reads as a reason nobody named.
// #670: raised from 20, because `empty_offer` joined the set and the two buckets the
// rule adds past it, `unknown` and `other`, are keys of the same map.
// #671: the set is `PICKER_REFUSAL_REASONS` above, which is docs/telemetry.md's list,
// so this number stays one clear of the set and those two buckets, and
// test/observability/telemetry-doc.test.js is what reads it.
export const MAX_REFUSAL_REASONS = 22
export function bumpReason (map, reason) {
  return bumpBounded(map, reason, MAX_REFUSAL_REASONS)
}

// How long ago a moment the leg stamped was, or null when it stamped none. A clock
// that stepped backwards gives an age of 0, never a negative one: the moment was
// real, and the difference between two clocks is not a duration a reader can use.
export function elapsedSince (at, now = Date.now()) {
  if (!Number.isFinite(at)) return null
  return Math.max(0, now - at)
}

// A frame the leg authors, as the bytes it hands the socket (#417). Framing and
// compression happen after this, in the library's own stream, so this is the frame
// and not the wire's length for it. The encode is the connection's own serializer
// in the state the frame is written in, so the number and the write are one encode
// of one frame and cannot disagree about what was sent.
//
// `ok: false` when there is nothing to measure: no serializer, or one that cannot
// build this frame in this state. The reason comes back with it, because a codec
// that refuses a frame is the one failure an operator cannot guess at.
export function encodeFrame ({ serializer = null, name, params = {} } = {}) {
  if (typeof serializer?.createPacketBuffer !== 'function') {
    return { ok: false, buffer: null, error: 'no serializer for this connection' }
  }
  try {
    const buffer = serializer.createPacketBuffer({ name, params })
    if (!Buffer.isBuffer(buffer)) return { ok: false, buffer: null, error: 'the codec returned no bytes' }
    return { ok: true, buffer, error: null }
  } catch (error) {
    return { ok: false, buffer: null, error: String(error?.message ?? error).slice(0, 200) }
  }
}

// Core loginStart decisions fail closed: an exception, a missing decision from
// a handler that ran, or any decision that is not allowed === true denies.
//
// `answered` says whether there was a decision to read at all. A lane whose core wired no
// `setLoginStartHandler` was asked nothing, and the allow this returns for it is not an
// answer: the caller's own check decides (#756).
function evaluateCoreDecision (coreDecision) {
  if (coreDecision === null || coreDecision === undefined) return { ok: true, reason: null, answered: false }

  let decision = coreDecision
  if (typeof coreDecision === 'function') {
    try {
      decision = coreDecision()
    } catch (error) {
      return { ok: false, reason: 'core_decision_error', detail: String(error?.message ?? error).slice(0, 200) }
    }
  }
  if (decision === null || decision === undefined) {
    return { ok: false, reason: 'core_decision_invalid' }
  }
  if (decision.allowed !== true) {
    // #312: a denial may carry the words the client reads. The kick is the one
    // message a refused client gets, so the sentence travels with it rather than
    // a slug the player cannot act on.
    return { ok: false, reason: decision.reason ?? 'core_denied', text: decision.text ?? null }
  }
  // #257: the core may allow a login that has no backend to attach to, and say so
  // with `picker: true`. The flag is carried, not inferred: the front serves the
  // picker only where the core decided it may.
  //
  // #756: the account the core reviewed travels with the answer, so the leg names
  // the uuid and the name that were compared rather than reading them a second time.
  return {
    ok: true,
    reason: null,
    answered: true,
    picker: decision.picker === true,
    phase: decision.phase ?? null,
    uuid: decision.uuid ?? null,
    username: decision.name ?? decision.username ?? null
  }
}

// #756: one login, one review of the attach whitelist.
//
// The comparison is the core's identity gate's. `identity.reviewLoginStart` reads the
// document through `whitelistSource`, the per-login reload the control document turns on
// (#229), and its refusal is the one `monoplayer.denials` counts and `attach_denied`
// names. The core's login call-in reaches `identity.reviewLoginStart` before anything
// else, so an answer from it has already compared the whitelist, and this leg does not
// hold the same uuid to the same document again. Two comparisons can disagree, and a torn
// read between them refused a login the core had just allowed under a second reason.
// Whichever ran first was the sentence an operator read. One login also parsed that
// document twice for one answer.
//
// This leg trusts that call-in. A lane that wires `setLoginStartHandler` by hand stands in
// for the core's, and the row `FRONT_LEG_CALL_INS` declares (reaches `processLoginStart`)
// is what holds a real lane to it.
//
// `check` stays the gate for a lane whose core wired no `setLoginStartHandler`: the
// socket-free rigs, and test/legs/session-verification-refused.test.js, which builds the
// deployed leg with no core. There the leg's own check is the only review there is, so
// the fallback is a gate and not a copy of one.
function decideViaCheck ({ client, store = null, check, coreDecision = null } = {}) {
  const core = evaluateCoreDecision(coreDecision)
  if (!core.ok) return core
  if (core.answered === true) return core
  if (!check || typeof check.checkVerified !== 'function') {
    return { ok: false, reason: 'check_unavailable' }
  }

  let decision
  try {
    decision = check.checkVerified({ client, store })
  } catch (error) {
    return { ok: false, reason: 'check_error', detail: String(error?.message ?? error).slice(0, 200) }
  }
  if (!decision || decision.ok !== true) {
    return { ok: false, reason: decision?.reason ?? 'check_denied' }
  }
  return {
    ok: true,
    reason: null,
    uuid: decision.uuid ?? null,
    username: decision.username ?? null,
    picker: core.picker === true
  }
}

// Pure online attach decision: the core's loginStart review, which fails closed, and
// the leg's own hasJoined-backed check for a lane whose core answered nothing. Exported
// for socket-free tests.
export function decideOnlineAttach (input = {}) {
  return decideViaCheck(input)
}

// Offline check: username and uuid must be strings; the normalized uuid must be
// on the offline whitelist. No name matching, no wildcard.
//
// #229: a leg handed a whitelist store reads the store instead. The store is
// what reloads a control document at each login, and this keeps the offline
// rung on the same whitelist code the deployed lane runs.
function createOfflineAttachCheck ({ whitelist = null }) {
  return {
    checkVerified ({ client, store = null } = {}) {
      const username = typeof client?.username === 'string' && client.username.length > 0
        ? client.username
        : null
      if (!username) {
        return { ok: false, reason: DENY_REASONS.MISSING_USERNAME, stage: 'login', username: null, uuid: null }
      }
      if (typeof client?.uuid !== 'string') {
        return { ok: false, reason: DENY_REASONS.PROFILE_INVALID, stage: 'login', username, uuid: null }
      }
      const uuid = normalizeUuid(client.uuid)
      if (!uuid) {
        return { ok: false, reason: DENY_REASONS.PROFILE_INVALID, stage: 'login', username, uuid: null }
      }
      const listed = store !== null && typeof store.has === 'function'
        ? store.has(uuid)
        : (whitelist ?? []).includes(uuid)
      if (!listed) {
        return { ok: false, reason: DENY_REASONS.NOT_WHITELISTED, stage: 'login', username, uuid }
      }
      return { ok: true, reason: null, stage: 'login', username, uuid }
    }
  }
}

// #200: the status answer, written by the leg and never inherited from
// minecraft-protocol, so an upgrade cannot change what a stranger reads. The
// decision behind the empty fields is docs/adr/the-status-ping-says-only-the-
// server-is-up.md.
//
// Pure: takes the library's own answer and returns the reply that replaces it.
export function statusPingAnswer (libraryResponse) {
  return {
    version: { name: '', protocol: libraryResponse?.version?.protocol },
    players: { max: 0, online: 0 },
    description: { text: '' }
  }
}

// Shared body. The constructors below own the mode-specific pieces (check,
// store, loopback checks); this body never decides the mode itself.
function createFrontLeg ({
  kind,
  onlineMode,
  verifier,
  host,
  port,
  version,
  check,
  store,
  // #618: the properties an account's hasJoined answered with, by name, for a lane
  // that has no sessionserver. Offline mode invents a player's UUID and name, and a
  // client's own skin is the one thing it cannot invent: this is what a lane with no
  // Mojang in front of it supplies instead. A deployed lane reads the same value off
  // the body the library sets on the connection (profileTextures below).
  profiles = null,
  getSnapshotConfig,
  // #257: the picker. `configurationBaseline` is a parsed recording of a real
  // server's configuration phase (src/legs/configuration-baseline.js), and
  // `pickerServers` is the allowed list this leg offers when the core says there
  // is no backend to attach to. Both absent means the lane behaves exactly as it
  // did: a join with no backend is refused. `onPickerPick` reports a pick, and
  // `onPickerVerb` reports the answer to the chosen server's dialog (#266), and a
  // claim on that server's body is recorded here (#267), and a granted claim is
  // what dials that body and lands the client in it (#258).
  configurationBaseline = null,
  pickerServers = null,
  onPickerPick = null,
  // #266: the answer to a chosen server's own dialog, which is claim, spectate or
  // disconnect, with the server it names.
  onPickerVerb = null,
  // #201: the total connection cap on the pre-auth window.
  preAuth: preAuthOptions = {},
  log,
  wireCheck,
  wireMode,
  chat = 'read-only',
  dumpRaw,
  dumpFramed
}) {
  const chatMode = chat
  if (!CHAT_MODES.has(chatMode)) {
    throw new TypeError(`chat must be one of ${[...CHAT_MODES].join(', ')}, got ${JSON.stringify(chatMode)}`)
  }
  if (!WIRE_MODES.has(wireMode)) {
    throw new TypeError(`wireMode must be one of ${[...WIRE_MODES].join(', ')}, got ${JSON.stringify(wireMode)}`)
  }
  if (wireMode !== 'off' && typeof wireCheck !== 'function') {
    throw new TypeError('wireCheck is required unless wireMode is off')
  }
  if (dumpRaw !== null && typeof dumpRaw !== 'function') throw new TypeError('dumpRaw must be null or a function')
  if (dumpFramed !== null && typeof dumpFramed !== 'function') throw new TypeError('dumpFramed must be null or a function')
  if (pickerServers !== null && typeof pickerServers !== 'function') {
    throw new TypeError('pickerServers must be null or a function returning an offer: { source, reason, rows }')
  }
  if (onPickerPick !== null && typeof onPickerPick !== 'function') {
    throw new TypeError('onPickerPick must be null or a function')
  }
  if (profiles !== null && (typeof profiles !== 'object' || Array.isArray(profiles))) {
    throw new TypeError('profiles must be null or an object of name -> properties array')
  }
  // #618: matched without case, because a name is not a key: the client sends the
  // name it logged in with, and the lane's list spells it as its account does.
  const profilesByName = new Map()
  for (const [name, properties] of Object.entries(profiles ?? {})) {
    if (!Array.isArray(properties)) {
      throw new TypeError('profiles[' + JSON.stringify(name) + '] must be an array of profile properties')
    }
    profilesByName.set(name.toLowerCase(), properties)
  }
  // #257: the frames this leg can serve a picker with, resolved once, because the
  // recording and this leg's protocol version are both fixed at construction. A
  // null here is not an error: it is a lane that has no picker, and its joins are
  // refused exactly as they were before. #598: every frame the recording carries
  // but its registry set, which is the body's to send.
  const pickerFrames = configurationBaseline === null
    ? null
    : baselineFramesFor(configurationBaseline, { version })
  // #266: `onPickerVerb` reports the answer to a chosen server's own dialog, the
  // way `onPickerPick` reports the pick. Neither connects anything: the dialog
  // layer reads the choice, and #267 records a claim from it.
  if (onPickerVerb !== null && typeof onPickerVerb !== 'function') {
    throw new TypeError('onPickerVerb must be null or a function')
  }

  let loginStartHandler = null // core check 1 call-in (processLoginStart)
  let serverboundHandler = null // core serverbound pipeline
  let detachHandler = null // core detach
  let clientSettingsHandler = null // core client-information capture (#18)
  let configuringHandler = null // core call-in: the client entered configuration (#16)
  let reconfiguredHandler = null // core call-in: the client re-entered play (#22)
  let errorHandler = null
  // #269: a spectator's two call-ins. `spectateBody` answers whether a row names a
  // body this lane can watch, and `spectatorAttach` hands that body's play state to
  // the spectator's own channel. Both absent is a lane with no spectator, and its
  // Spectate verb is refused in words.
  let spectateBodyHandler = null
  let spectatorAttachHandler = null
  // #636: where a spectator's own client says it is. The core draws it for the body's
  // other channels, and this leg is the only place the frame exists.
  let spectatorPoseHandler = null
  // #259: the body this lane serves, and whether it has one up, so a row can say
  // `unclaimed` rather than `down` about a body a spectator could join. Absent is a
  // leg with no core, and every row then reads what the list says.
  let bodyServedHandler = null
  let spectatorLeftHandler = null
  // #261: the Disconnect verb's answer. It is asked only for a body no claim holds,
  // because a claim is what keeps a body alive; the core ends the session and
  // answers whether the body it serves is the one the frame named. Absent is a leg
  // with no core, and its Disconnect verb leaves the client and ends no body.
  let disconnectBodyHandler = null

  const wireStats = { checked: 0, rejected: 0, lastFailure: null }

  let server = null
  let listenPromise = null
  let closePromise = null
  let lastInterceptor = null

  // #417: `pickerRefusals` is the total and `pickerRefusalsByReason` the split. Both
  // are written by bumpPickerRefusal and by nothing else, so the total and the map
  // cannot disagree about how many refusals there were. #616: the disconnect's own
  // number is written by that same helper, so a refusing branch has one place to
  // count and not two numbers it must remember.
  const metrics = { denied: 0, libraryLoginRefused: 0, libraryLoginRefusedByReason: {}, sessionVerificationRefused: 0, allowed: 0, attaches: 0, pickers: 0, pickerPicks: 0, pickerServerDialogs: 0, pickerVerbs: 0, pickerClaims: 0, pickerRefusals: 0, pickerRefusalsByReason: {}, pickerDisconnects: 0, pickerDisconnectsRefused: 0, claimLandings: 0, claimLanded: 0, claimRestored: 0, policyRefused: 0, stateRefused: 0, configFramesAfterFinish: 0, reconfigurations: 0, reconfigured: 0, reconfigurationFramesFlushed: 0, reconfigurationFramesDropped: 0, preAuthRefused: 0, channelRefused: 0, spectateLandings: 0, spectatorJoins: 0, spectatorFramesDropped: 0, spectatorSettings: 0, spectatorModeWithheld: 0 }
  const clients = new Map() // Client -> { interceptor, channel, picker, loginAt, endRequested, ended }
  // #269: the channels this leg delivers through (src/core/channels.js). A channel
  // is one connection's delivery of one body: its role, what it has been sent, and
  // its own client information. The claim decides who may drive a body
  // (src/core/claims.js); a channel is what each connection is handed, and the
  // attach slot is gone with the one pointer that used to be all three.
  const channels = createChannels()
  const clientByChannel = new Map() // channel id -> the socket that holds it

  // #417: one refused picker request, counted twice on purpose: a total an operator
  // charts, and a map by reason a reader greps. The reason is the word the site's
  // own record already carries, so the map cannot say something the log does not.
  // Both counters are written here and only here.
  function bumpPickerRefusal (reason) {
    metrics.pickerRefusals++
    bumpReason(metrics.pickerRefusalsByReason, reason)
    // #261's own number for the one refusal that has one. Counted here, where every
    // refusal is counted, so no branch moves it beside the map and #616 cannot happen
    // again: a refusal that reaches the map reaches this.
    if (reason === 'disconnect_claimed') metrics.pickerDisconnectsRefused++
  }

  // #616: refuse one picker request and count it: the sentence the client is told and
  // the count the map keeps, in one call, because they are one fact. The board composes
  // that sentence, so this is the only place a counted refusal is composed. #435 found
  // the Spectate landing composing a sentence and leaving the map short; #616 found the
  // Disconnect verb doing the same; #708 found the claim landing composing its own and
  // counting nothing at all. A branch that composes one without this call is that defect
  // again, and the guards in test/legs/picker-numbers.test.js name every sentence that is
  // not counted here, including the sentence argument of every `endConfiguration` call.
  //
  // #670: the record is written here too, because a count with no line saying why is the
  // same defect read backwards. A caller hands over the reason, the sentence's own facts
  // and the record to write; the helper composes the sentence, counts the reason and
  // writes that record with both on it, so the word the map is keyed by and the word an
  // operator greps are one word. A site that writes its refusal record by hand beside a
  // count can make them differ, and #670 found the mirror of #435 and #616: a dialog the
  // leg could not write counted with only an `error` on its line, so the word the map is
  // keyed by was on no refusal record at all.
  function refuseAndCount ({ reason, record: write, ...request }) {
    bumpPickerRefusal(reason)
    const text = pickerBoard.refuse({ reason, ...request })
    // The record is the site's, and it is handed the pair this call just counted and
    // composed, so it cannot say a word the map does not hold. The event name stays at
    // the site, because #416 keeps every written name a literal there.
    write({ reason, text })
    return text
  }

  // #267: the claims this leg holds, one per body. A claim is recorded where a
  // client answers a body's own dialog, and released when its connection ends. The
  // holder is an id this leg gives a connection, so the board holds no socket and
  // two connections from one account are two holders.
  const claims = createClaims()
  // #595: what a row reads as, what a click means and which sentence a refusal gets
  // are src/core/picker.js's, and every frame, record and count stays here.
  const pickerBoard = createPickerBoard({ claims, channels })
  const holderIds = new WeakMap()
  let holderSeq = 0
  function holderFor (client) {
    let id = holderIds.get(client)
    if (id === undefined) {
      holderSeq += 1
      id = 'holder-' + holderSeq
      holderIds.set(client, id)
    }
    return id
  }

  // #201: the total connection cap, and #205: the deadline on the same window.
  // The window is the one the spec bounds: from the accepted socket to the attach
  // whitelist's accept. The count and the timer are the leg's, because the leg is
  // the only place a socket exists.
  const preAuthWindow = createPreAuthWindow({
    maxConnections: preAuthOptions.maxConnections,
    deadlineMs: preAuthOptions.deadlineMs
  })
  const preAuthOpen = new WeakSet()
  // #722/#742: whether this leg reviewed the login. Every refusal the library makes in
  // its login handler happens before `beforeLogin`, so a connection it refuses was
  // never reviewed, and that is the condition the refusal record is written on. The
  // sentence the library ends with is the other half: the table names which of its
  // refusals this was. Read together they cannot count a denial of this leg's, which
  // carries a text of its own and always has a reviewed login behind it.
  const loginReviewed = new WeakSet()
  // #742: this connection's refusal is already on its record. The library ends a
  // connection through the same call more than once — a refusal, and then the kick for a
  // peer that never finished closing — and only the first call is the refusal.
  const libraryRefusalRecorded = new WeakSet()
  // The window validated the deadline and owns it; the leg reads the effective
  // value back rather than resolving the default a second time.
  const preAuthDeadlineMs = preAuthWindow.stats().deadlineMs
  // One timer per admitted connection. minecraft-protocol sets no idle timeout on
  // its client and closeTimeout starts only after end(), so this is the only bound
  // a socket that never speaks ever meets. Every entry leaves the map either in
  // closePreAuthWindow or in the timer itself, so it cannot outgrow the window.
  const preAuthTimers = new Map()

  // Leave the window, at most once per connection. Two ways out: the whitelist
  // accepted it, or its socket ended. A denial is not a way out, because a denied
  // connection never reached the accept the window is defined by. Its socket
  // stays open until the library's close timeout, and counting it keeps the cap
  // honest about the sockets the process is holding. #205: leaving the window
  // also disarms the deadline, so a slow but real login that reached the
  // whitelist is never cut after its window ended.
  function closePreAuthWindow (client) {
    clearPreAuthDeadline(client)
    if (!preAuthOpen.delete(client)) return
    preAuthWindow.release()
  }

  // #722/#742: a login the library refused. It performs every one of those checks
  // inside its own handlers and ends the connection before `beforeLogin`, so this
  // leg never reviews the client: `metrics.denied`, the `attachDenied` line and the
  // service's `monoplayer.denials` sum are all written further down this path, and
  // none of them is reached. The end reason is the whole of what the refusal leaves, so
  // the count and the line are written here, together, where that reason is still in
  // hand (#670). One helper, because one seam: the table decides which refusals exist,
  // and a sentence it does not carry writes nothing.
  //
  // The reason is the table's word for the sentence, and the sentence rides beside it: a
  // reader needs both, because the word is what the count is keyed by and the sentence is
  // the only thing that client was ever told. Neither is a secret: every sentence is a
  // fixed string in the library's own source, written for the client to read, and the
  // translate payload the library passes beside it never reaches this event.
  //
  // The window's own `refused` is a different number and must not move here: that is
  // the connection cap, which turned nothing away, and its `expired` is the deadline,
  // which destroyed nothing. These connections were admitted, sat in the window, and
  // left it when the library ended them.
  function recordLibraryLoginRefusal (client, sentence) {
    const reason = libraryRefusalWord(sentence)
    if (reason === undefined) return false
    // #742: the window still holds this connection, or the refusal is not the library's
    // to record. A login the library refuses never reached the attach whitelist, so it
    // has not left the window; one this window already ended or refused has, and a
    // sentence arriving for it afterwards is the library answering a socket this leg
    // closed. Two records for one close is how an operator learns to trust neither.
    if (!preAuthOpen.has(client)) return false
    metrics.libraryLoginRefused++
    bumpBounded(metrics.libraryLoginRefusedByReason, reason, MAX_LIBRARY_REFUSAL_REASONS)
    // #722: the sessionserver's sentence keeps its own counter. `monoplayer.session.refused`
    // samples that one under the single word its series carries, so it stays the subset it
    // always was, and this helper is the only place either number moves.
    if (reason === DENY_REASONS.HASJOINED_FAILED) metrics.sessionVerificationRefused++
    record(client, 'libraryLoginRefused', {
      username: client?.username ?? null,
      uuid: client?.uuid ?? null,
      reason,
      text: sentence,
      // The running total, as the window's two lines carry theirs: a reader greps one
      // line and has the count, without reading the heartbeat beside it.
      refused: metrics.libraryLoginRefused
    })
    return true
  }

  function armPreAuthDeadline (client) {
    const timer = setTimeout(() => {
      preAuthTimers.delete(client)
      expirePreAuthWindow(client)
    }, preAuthDeadlineMs)
    // A pending deadline must never hold the process open: a shutdown with a
    // silent socket in the window would otherwise wait for the timer.
    timer.unref?.()
    preAuthTimers.set(client, timer)
  }

  function clearPreAuthDeadline (client) {
    const timer = preAuthTimers.get(client)
    if (timer === undefined) return
    preAuthTimers.delete(client)
    clearTimeout(timer)
  }

  // Drop a socket this leg is done with. The library emits 'error' on a client
  // whose socket dies and an unlistened 'error' ends the process, so every
  // listener is replaced with one that knows nothing is coming: a connection on
  // its way out has nothing left to say. Destroyed rather than ended, because
  // ending waits on the library's 30 s close timeout and would hold the socket
  // for another 30 s.
  function destroyQuietly (client) {
    client.removeAllListeners('error')
    client.on('error', () => {})
    try { client.socket?.destroy() } catch { /* already gone */ }
  }

  // #205: the deadline fired. The connection did not reach the whitelist's accept
  // in the time a real login needs, so its socket goes. Its 'end' listener still
  // runs and releases the slot.
  //
  // #742: unless the library already refused it with a sentence of its own. Both bounds
  // are 30 s and the library's is armed first, so a silent socket is the library's to
  // name: its kick half-closes, and this timer is due in the same millisecond. The
  // socket still goes and the slot still frees; only the count is the refusal's, because
  // one close that two numbers claim is a chart nobody can add up.
  function expirePreAuthWindow (client) {
    if (libraryRefusalRecorded.has(client)) {
      destroyQuietly(client)
      closePreAuthWindow(client)
      return
    }
    const expiry = preAuthWindow.expire()
    // One line per expiry. The window admits at most maxConnections connections
    // at once, so a deadline period cannot write more lines than that, and a
    // sustained attack is exactly the case where a reader needs to see them.
    log('preAuthExpired', {
      reason: expiry.reason,
      deadlineMs: preAuthDeadlineMs,
      expired: expiry.expired
    })
    destroyQuietly(client)
    closePreAuthWindow(client)
  }

  // A connection arrived. Over the cap it is refused with its own reason, and
  // the refusal is counted every time but logged once per saturated window. An
  // admitted connection starts its deadline here, so the slot and the timer are
  // armed and disarmed in the same two places.
  function admitPreAuthWindow (client) {
    const admission = preAuthWindow.admit()
    if (admission.admitted) {
      preAuthOpen.add(client)
      armPreAuthDeadline(client)
      return admission
    }
    metrics.preAuthRefused++
    if (admission.shouldLog) {
      log('preAuthRefused', {
        reason: admission.reason,
        maxConnections: admission.maxConnections,
        inWindow: admission.inWindow,
        refused: admission.refused
      })
    }
    return admission
  }

  function actualPort () {
    return server?.socketServer?.address()?.port ?? null
  }

  // Start listening. Handlers must be set first. Safe to call once: repeat
  // calls return the same promise.
  function listen () {
    if (closePromise) return Promise.reject(new Error('front leg is closed'))
    if (listenPromise) return listenPromise

    listenPromise = new Promise((resolve, reject) => {
      let settled = false

      server = mc.createServer({
        host,
        port,
        version,
        'online-mode': onlineMode,
        // #200: nothing the status answer says comes from a library default.
        // `beforePing` replaces the modern answer whole. The pre-1.7 legacy
        // ping is answered from `motd` and `maxPlayers`, and the login
        // `server_data` from `motd`; none of the three has a hook.
        motd: '',
        maxPlayers: 0,
        beforePing: statusPingAnswer,
        keepAlive: true, // the library answers per-connection keep-alives for the client
        hideErrors: true, // errors surface through our own server/client error log lines
        versionChecking: false,
        // #87: without this the library kicks the client with the Error object
        // and the kick fails to serialize. The leg's own handler puts a string
        // in that field.
        errorHandler: createFrontErrorHandler({ log }),
        beforeLogin: client => { handleBeforeLogin(client) }
      })

      server.on('error', err => {
        log('frontServerError', { error: String(err?.message ?? err).slice(0, 200) })
        errorHandler?.({ error: err })
        if (!settled) { settled = true; reject(err) }
      })
      server.on('listening', () => {
        log('frontListening', { host, port: actualPort() })
        if (!settled) { settled = true; resolve({ host, port: actualPort() }) }
      })

      server.on('connection', client => {
        // #201: the cap is checked first. A refused connection never reaches the
        // login review below, so nothing of this leg is allocated for it: no
        // interceptor, no channel, no serverbound pipeline. The socket is
        // destroyed rather than ended, because ending it waits on the library's
        // 30 s close timeout and a flood would sit in that wait.
        const admission = admitPreAuthWindow(client)
        if (!admission.admitted) {
          destroyQuietly(client)
          return
        }
        // A socket that ends inside the window leaves it here, which covers every
        // denial before the accept. The library emits this from the socket's own
        // close, so a destroyed socket arrives here too. It carries the reason the
        // connection left the window (#722). The refusal itself is not read here: it was
        // read at the call, three lines down.
        // #742: one seam, every sentence. The 'end' event would not do: the library keeps
        // the last reason it was handed and the event reports that one, so a refusal whose
        // peer never closed its half is overwritten by the library's own kick -- and that
        // kick is a sentence this table carries, so the event would record the wrong
        // refusal rather than none. The reason is read where the library gives it, and the
        // first one wins. A close the library did not refuse (`'socketClosed'`,
        // `'ServerShutdown'`, this leg's own `front_error: ...`) is on no record at all,
        // because the table does not carry it.
        const libraryEnd = client.end
        client.end = function (reason, ...rest) {
          try {
            if (!libraryRefusalRecorded.has(client) && !loginReviewed.has(client)) {
              if (recordLibraryLoginRefusal(client, reason) === true) libraryRefusalRecorded.add(client)
            }
          } catch {
            // The record is this leg's; ending the client is the caller's. A sink that
            // threw must not leave a refused connection open, which is the one thing this
            // wrapper could break.
          }
          return libraryEnd.call(this, reason, ...rest)
        }
        client.on('end', () => { closePreAuthWindow(client) })
        wireClient(client)
        if (dumpFramed) {
          // Diagnostic: framer output is framed (and compressed) bytes.
          client.framer.on('data', buf => { try { dumpFramed(buf) } catch { /* best effort */ } })
        }
      })

      // configuration done: resolve the per-client interceptor + hand the
      // attach to the core (playerJoin is a server-level event in
      // minecraft-protocol; per-client state lives in the ctx map).
      server.on('playerJoin', client => {
        const ctx = clients.get(client)
        if (ctx) {
          record(client, 'configResolved', { mode: ctx.interceptor.replayMode, ...ctx.interceptor.stats })
        }
        onClientJoined(client)
      })
    })

    return listenPromise
  }

  function coreDecisionFor (client) {
    if (typeof loginStartHandler !== 'function') return null
    const claimed = { uuid: client.uuid, name: client.username, username: client.username }
    return () => {
      const decision = loginStartHandler(claimed)
      // A handler that ran but produced no decision is not an allow.
      return decision == null ? { allowed: false, reason: 'core_decision_invalid' } : decision
    }
  }

  // beforeLogin: synchronous, called by loginClient AFTER the library's
  // hasJoined (online) or offline UUID assignment (offline) and BEFORE
  // compress + success writes.
  function handleBeforeLogin (client) {
    loginReviewed.add(client)
    const username = client.username
    const uuid = client.uuid
    // #618: before anything reads the profile, so a lane with properties supplied
    // looks to the rest of this leg exactly like a lane whose sessionserver answered.
    const supplied = profilesByName.get(String(username).toLowerCase())
    if (supplied !== undefined) client.profile = { id: uuid, name: username, properties: supplied }
    log('frontLoginReview', { username, uuid: uuid ?? null, onlineMode, verifier })

    const decision = decideViaCheck({
      client,
      store,
      check,
      coreDecision: coreDecisionFor(client)
    })
    if (!decision.ok) {
      metrics.denied++
      log('attachDenied', { username, uuid: uuid ?? null, reason: decision.reason, text: decision.text ?? null })
      denyConnection(client, decision.reason, decision.text)
      return
    }

    metrics.allowed++
    // #201: the window ends here, at the reason the ticket names: the UUID is
    // resolved and the whitelist accepted it. Everything after this is a
    // session, and a session is never refused by the cap.
    closePreAuthWindow(client)
    log('attachAllowed', {
      username: decision.username ?? username,
      uuid: decision.uuid ?? uuid,
      verifier,
      whitelist: store?.file ?? null,
      // #618: the measurement the ticket asks for, on every join: did the body this
      // lane verified carry a textures property? A lane with no sessionserver answers
      // for itself, and the field is the same one either way.
      textures: profileTextures(client.profile) !== null
    })

    // #257: the core's decision said this join has no backend to attach to, and
    // this leg holds the picker. The picker is not an attach: it takes no slot,
    // so two clients may read it at once, and it never reaches the core's
    // session. Its interceptor is installed here, inside the synchronous
    // beforeLogin window and before any of the library's configuration writes.
    if (decision.picker === true) {
      servePicker(client)
      return
    }

    // Install the cached-config interceptor BEFORE loginClient's subsequent
    // writes/completion (we are inside the synchronous beforeLogin window).
    const interceptor = installConfigInterceptor(client)

    // #269: own the channel first, because the core's early attach streams the
    // cached configuration frames straight back through writeRaw and this client's
    // configuration information is reported on the channel it holds. A client that
    // reaches here has already passed the login decision, so a driver holding the
    // body is a channel refusal here and nowhere else: this shape of lane is
    // refused at its login when it has no picker (#312).
    openChannel(client, { role: CHANNEL_ROLES.DRIVER })

    // #16: no cached configuration means the puppet is still configuring. The
    // client attaches early and follows the live stream; the core refuses when
    // no backend configuration is open, and a refusal denies the client.
    if (interceptor.live) {
      const outcome = coreAttachConfiguring({ name: client.username, uuid: client.uuid })
      if (!outcome || outcome.attached !== true) {
        metrics.denied++
        record(client, 'attachConfiguringFailed', {
          username: client.username ?? null,
          reason: outcome?.reason ?? 'backend_not_ready'
        })
        denyConnection(client, outcome?.reason ?? 'backend_not_ready')
        return
      }
      record(client, 'attachConfiguring', { username: client.username, uuid: client.uuid })
    }
  }

  // `text`, when the core sent one, is the sentence the client reads: the
  // server's own end() writes it into the login-state disconnect before the
  // serializer ends, so the player sees words (#312). Without it the kick keeps
  // the reason the operator greps for.
  function denyConnection (client, reason, text = null) {
    // #201: a denial before the whitelist accepted — a second attach, or a UUID
    // that is not on the list — stays counted until its socket ends, which the
    // library's close timeout bounds. A denial after the accept, such as a
    // backend that is not ready, lands on a connection that has already left the
    // window, so there is nothing to release.
    //
    // #205: the deadline is disarmed here. The denial is this connection's
    // decision, and the close timeout bounds the socket from the end() below. A
    // deadline left armed would fire first for a peer that ignores the disconnect,
    // and the expiry line would report a refused stranger as a stuck socket.
    clearPreAuthDeadline(client)
    const originalWrite = typeof client.write === 'function' ? client.write.bind(client) : null
    if (originalWrite) {
      client.write = (name, ...args) =>
        (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
    }
    try {
      client.end(text ?? `attach denied (${reason})`)
    } catch {
      // The library's end failed, so its close timeout was never armed and no
      // close would ever take this connection out of the window. The socket has
      // to go.
      destroyQuietly(client)
    }
  }

  // --- #269: the channels, and the sockets they belong to ---

  // Open a channel for a connection. The claim has already refused a rival, so a
  // second driver here is a programming error rather than a second authority: it is
  // counted and refused with the channel that holds the body.
  function openChannel (client, { role, body = null, name = null } = {}) {
    const outcome = channels.open({
      id: holderFor(client),
      body,
      role,
      name: name ?? client.username ?? null,
      at: Date.now()
    })
    if (!outcome.ok) {
      metrics.channelRefused++
      log('channelRefused', {
        username: client.username ?? null,
        uuid: client.uuid ?? null,
        role,
        body,
        reason: outcome.reason,
        heldBy: outcome.channel?.name ?? null
      })
      return null
    }
    clientByChannel.set(outcome.channel.id, client)
    const ctx = clients.get(client)
    if (ctx) ctx.channel = outcome.channel.id
    record(client, 'channelOpen', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      role: outcome.channel.role
    })
    return outcome.channel
  }

  // The channel a connection holds, or null. Read from the holder id, so a channel
  // that closed is a connection holding nothing.
  function channelFor (client) {
    const id = holderIds.get(client)
    return id === undefined ? null : channels.of(id)
  }

  // #416: one record about a connection, carrying the body and the channel it holds
  // at the moment of the call, read from the registry rather than copied. The account
  // is the lane's, and the sink that writes the line stamps it (src/core/channels.js).
  function record (client, event, fields = {}) {
    return log(event, stampIdentity(fields, channelIdentity(channelFor(client))))
  }

  // The same record about a channel that has just closed. `closeChannel` returns the
  // view, and the registry no longer holds it.
  function recordOfChannel (channel, event, fields = {}) {
    return log(event, stampIdentity(fields, channelIdentity(channel)))
  }

  // A log function bound to one connection, for the helpers that write their own
  // records and hold a socket rather than the leg's registry (the wire checker).
  function recordFor (client) {
    return (event, fields = {}) => record(client, event, fields)
  }

  function closeChannel (client) {
    const id = holderIds.get(client)
    if (id === undefined) return null
    const closed = channels.close(id)
    if (closed === null) return null
    clientByChannel.delete(id)
    recordOfChannel(closed, 'channelClosed', {
      username: client.username ?? null,
      role: closed.role,
      frames: closed.delivered.frames
    })
    return closed
  }

  function clientOfChannel (id) {
    return typeof id === 'string' ? clientByChannel.get(id) ?? null : null
  }

  // One clientbound write, to every channel on the body or to one of them. The two
  // callers differ only in what they hand a client, so the addressing and the count of
  // deliveries live here (#269).
  //
  // #259: the body's stream goes to its driver and its spectators, with one
  // exception. `game_state_change` and `abilities` say what the *body* is doing: its
  // game mode, and the flags that go with it. A spectator already carries the body's
  // own copies from its replay, and what its client should hold is the spectator mode
  // the core wrote to that channel when it landed. So a later body frame must not be
  // broadcast over it. A write that names one channel is the lane deciding for that
  // client, and it always passes: that is how the core tells a spectator what it is.
  function deliverEach (channel, deliver, { name = null } = {}) {
    if (channel !== null) return deliver(clientOfChannel(channel)) ? 1 : 0
    let sent = 0
    for (const target of deliveryTargets()) {
      if (bodyFrameWithheld({ role: target.channel.role, name })) continue
      if (deliver(target.client)) sent++
    }
    return sent
  }

  // The body's own player-mode frames, which belong to whoever is driving it.
  const DRIVER_ONLY_FRAMES = new Set(['game_state_change', 'abilities'])

  function bodyFrameWithheld ({ role = null, name = null } = {}) {
    if (role !== CHANNEL_ROLES.SPECTATOR) return false
    if (typeof name !== 'string' || !DRIVER_ONLY_FRAMES.has(name)) return false
    metrics.spectatorModeWithheld++
    return true
  }

  // The socket that drives the body this leg serves. A reconfiguration and the
  // wire's one-start-per-round are the driver's; a spectator is handed the result
  // like any other body stream.
  function driverClient () {
    const driver = channels.driverChannel()
    return driver === null ? null : clientOfChannel(driver.id)
  }

  // The body a spectator names, for a body nobody drives: one body at a time is this
  // leg's limit, so the first channel that names one names it (#259).
  function watchedBody () {
    for (const channel of channels.snapshot()) {
      if (channel.body !== null) return channel.body
    }
    return null
  }

  // The sockets one clientbound frame goes to: the body's driver, and every
  // spectator watching that body. The driver's channel names the body; a driver
  // channel that names none is a client this lane admitted without a claim, and
  // `null` is then the lane's own body rather than no body at all. With no driver,
  // a spectator's channel names the body, which is the ordinary state of a body whose
  // player left (#259). A leg per body is #261.
  function deliveryTargets () {
    const driver = channels.driverChannel()
    const body = driver !== null ? driver.body : watchedBody()
    if (driver === null && body === null) return []
    const targets = []
    for (const channel of channels.on(body)) {
      const client = clientByChannel.get(channel.id)
      if (client !== undefined) targets.push({ client, channel })
    }
    return targets
  }

  // One frame reached one channel. The counter is the channel's, so a spectator
  // that arrived mid-stream is never reported as having seen what the driver saw.
  // #417: the frame's length rides beside the count, passed by the caller that holds
  // the buffer. A caller writing a packet object holds none, and passes none.
  function noteDelivered (client, meta, { replay = false, bytes = null } = {}) {
    const channel = channelFor(client)
    if (channel === null) return
    channels.noteDelivery({
      id: channel.id,
      state: meta?.state === 'configuration' ? 'configuration' : 'play',
      name: typeof meta?.name === 'string' ? meta.name : null,
      bytes
    })
    if (replay) channels.markReplay(channel.id)
  }

  // The body's configuration frames as this leg may send them: the cache's own
  // configuration snapshot, minus anything that is not a frame and minus anything the
  // clientbound policy does not replay. Both the cached replay at login and the landing
  // after a claim (#258) read it, so the two phases a client can receive carry the same
  // set.
  //
  // #602: `replay` is the policy's own answer to this question, and it is the only one
  // that fits. `decision !== 'block'` is not the same predicate. It admits the frames a
  // connection owns (`keep_alive`, `ping`) and the dialog the human answers
  // (`code_of_conduct`), and a second client may be handed neither as part of its phase.
  // `configuration-baseline.js` asks the table this same question about the picker's
  // recording, so a landing and the phase it continues answer alike.
  function replayableConfigFrames () {
    return getSnapshotConfig().filter(
      frame => typeof frame?.name === 'string' &&
        Buffer.isBuffer(frame.buffer) &&
        clientboundPolicy('configuration', frame.name).replay
    )
  }

  function installConfigInterceptor (client, { picker = null } = {}) {
    // Read the snapshot per connection: a backend cache reset must never be
    // masked by a stale per-listen memo. Connection-control frames (a config
    // transfer, a cookie, a dialog, the code of conduct) never replay.
    //
    // #257: a picker client gets the baseline and nothing else. Its cached
    // frames, if the cache holds any, belong to a body nobody claimed, and
    // serving them would put the client in that body's world without a claim.
    const cachedConfigFrames = picker !== null ? [] : replayableConfigFrames()

    const live = picker === null && cachedConfigFrames.length === 0
    const interceptor = createConfigPathInterceptor({
      live,
      baselineConfigFrames: picker ?? [],
      onBaselineFrames: picker === null ? null : () => sendPickerDialog(client),
      write: client.write.bind(client),
      // Every clientbound raw byte we push to the attaching client, in order. Through the
      // funnel (#602): the picker's baseline frames and this connection's cached replay
      // are configuration frames written to a client mid-phase, and writeRawTo is where
      // the per-socket checks for that live.
      writeRaw: (buffer, meta) => writeRawTo(client, buffer, meta),
      isConfigurationState: () => client.state === 'configuration',
      cachedConfigFrames,
      // #16: the client can parse a configuration frame from here on. The core
      // delivers a held configuration gate at this moment, not at the attach
      // call-in, which runs before Login Success.
      onConfiguring: () => {
        try {
          configuringHandler?.({ name: client.username ?? null, uuid: client.uuid ?? null })
        } catch (error) {
          record(client, 'configuringHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
        }
      },
      // Live only: an empty snapshot means the puppet has no backend session
      // right now. Serving the library's registry_data would crash a 26.2
      // client on missing registry tags, so deny and let the player retry.
      allowLibraryFallback: false,
      onUnavailable: () => {
        record(client, 'configUnavailable', { username: client.username ?? null, reason: 'no_cached_backend_config' })
        denyConnection(client, 'backend_not_ready')
      },
      // #541 and #599: the library's own writer dropped a frame, and the client it was
      // aimed at has left the phase, so this never reaches the wire. One line and one
      // count, in the function the raw funnel calls for the same refusal.
      onSuppressed: ({ name: dropped = null } = {}) => {
        recordAfterFinishDrop(client, { name: dropped, state: 'configuration' })
      }
    })
    client.write = interceptor.write
    // #417: the moment this connection logged in, on the connection's own entry.
    // This runs inside the synchronous beforeLogin window, so it is the login and
    // not the landing: the picker's dialog is written from this same phase. The
    // picker's duration is this stamp subtracted at the pick, so it is one
    // connection's time and never one player name's.
    clients.set(client, {
      interceptor,
      picker: picker !== null,
      loginAt: Date.now(),
      // #749: whether an end has been asked for on this connection. It is not `ended`,
      // which the library's `'end'` event sets when the socket is already gone: this is
      // the earlier fact, and the one `endConfiguration` needs, because the library arms
      // a close timer at every `end()` and keeps only the newest handle. A second end on
      // one client therefore leaves the first timer armed with nothing to clear it, and it
      // holds the process for its 30 s. The funnel marks it, and so does `endConfiguration`
      // before the end it takes itself, so a second end from either one is a no-op.
      endRequested: false,
      ended: false
    })
    lastInterceptor = interceptor
    return interceptor
  }

  // #257: the picker's own rows, from the caller's offer. A throw there is a bug
  // in the lane's configuration, not a reason to leave a client in the dark: the
  // leg reports an empty offer, and an empty picker closes the connection with a
  // reason instead of showing a dialog with no buttons.
  //
  // #315: the answer is the offer, `{ source, reason, rows }`, so a join that finds
  // nothing can say which fact emptied the list without reading the files again. It
  // is named for what it returns, not for the rows inside it. A reader that throws is
  // named by its own line, and its reason is null.
  function pickerOffer () {
    let offered = { source: 'none', reason: null, rows: [] }
    try {
      const read = pickerServers() ?? null
      offered = {
        source: typeof read?.source === 'string' ? read.source : 'none',
        reason: typeof read?.reason === 'string' ? read.reason : null,
        rows: read?.rows ?? []
      }
    } catch (error) {
      log('pickerServersError', { error: String(error?.message ?? error).slice(0, 200) })
      return offered
    }
    // #316: what each body on a row is doing, decided where the rows are handed out,
    // so every dialog a client reads is as old as the click that asked for it. The
    // claim names the driver, the channels name the watchers, and whether the body is
    // up is the session's answer (src/core/picker.js, `offer`).
    const served = bodyServedHandler === null ? null : bodyServedHandler()
    return { ...offered, rows: pickerBoard.offer({ rows: offered.rows, served }) }
  }

  // #257: a join with no backend, on a leg that holds a baseline. The client is
  // held in configuration and shown the picker; nothing is attached, so the
  // body stays with its driver: a picker client holds no channel and the core's
  // session is untouched.
  function servePicker (client) {
    if (pickerFrames === null || pickerServers === null) {
      metrics.denied++
      log('attachDenied', { username: client.username ?? null, reason: 'picker_unavailable' })
      denyConnection(client, 'picker_unavailable')
      return
    }
    // Installed before any of the library's configuration writes, and before the
    // dialog: the frames go out from the library's finish hook, and the dialog
    // goes out right after them.
    installConfigInterceptor(client, { picker: pickerFrames })
    metrics.pickers++
    log('pickerServed', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      frames: pickerFrames.length,
      servers: pickerOffer().rows.length
    })
  }

  // #417 and #600: one configuration dialog, encoded once for the connection it goes to.
  // Both dialogs this leg authors are its own params, so their bytes are the leg's and the
  // wire check can read them. The params build is inside the guard as well as the encode: a
  // throw here would otherwise leave the caller for the library's own finish hook, and the
  // one client this leg can answer would be lost instead of told why.
  function encodeDialogFrame (client, params) {
    try {
      return encodeFrame({ serializer: client.serializer ?? null, name: 'show_dialog', params })
    } catch (error) {
      return { ok: false, buffer: null, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  // The frames are on the wire and the client can parse a dialog now. The dialog
  // is the phase: no finish_configuration follows it.
  function sendPickerDialog (client, { title = 'Choose a server' } = {}) {
    const offer = pickerOffer()
    const rows = offer.rows
    if (rows.length === 0) {
      // #315: the lane offers nothing, and the client hears that. It never picked a
      // server, so a sentence about one names a choice nobody made.
      //
      // #670: and this client is one the picker ended, so it counts where the other
      // sentences count and its record carries the word the map is keyed by. The map
      // already holds the clients the lane could not deliver, not only the clicks it
      // turned down: `finish_failed` and `no_cached_configuration` are a Spectate the
      // answer allowed and the landing then lost. A lane with no rows is that same
      // family. The reason a reader acts on is the offer's own, `not_json` or
      // `unreadable`, which names the file to repair (#372); it rides `offerReason`,
      // because `reason` is the word this map is keyed by.
      const text = refuseAndCount({
        reason: 'empty_offer',
        record: refusal => log('pickerEmpty', {
          username: client.username ?? null,
          offerReason: offer.reason,
          ...refusal
        })
      })
      endConfiguration(client, 'picker_empty', text)
      return
    }
    // #417: the dialog goes out as the bytes it is. A configuration-phase
    // show_dialog carries the dialog inline (CONTEXT_FREE_STREAM_CODEC in the 26.2
    // client), so no registry entry is involved and this leg can author one. The
    // encode is the connection's own serializer, in the state the dialog is written
    // in, which is the codec `client.write` would have used: one encode, so the
    // size written to the record is the size of the frame that was sent.
    // The params build is inside the guard as well as the encode: a throw here would
    // otherwise leave this function for the library's own finish hook, and the one
    // client this leg can answer would be lost instead of told why.
    const encoded = encodeDialogFrame(client, pickerDialogParams({ rows, title }))
    let written = false
    let error = null
    if (!encoded.ok) {
      error = encoded.error
    } else {
      // #602: the dialog is a configuration frame this leg authored, and the funnel is
      // where a clientbound raw frame is written. It answers whether the frame went
      // (the wire check, the state check) instead of throwing at the socket.
      try {
        written = writeRawTo(client, encoded.buffer, { state: 'configuration', name: 'show_dialog' })
      } catch (thrown) {
        error = String(thrown?.message ?? thrown).slice(0, 200)
      }
    }
    // #670: a dialog the leg could not write is a refusal it counts (#616), so the call
    // that counts it writes the record as well, and `pickerDialogFailed` is the line that
    // carries why: the reason the map is keyed by and the sentence the client was told.
    // Before this, the reason was only on `configurationEnded`, the line every ended
    // client gets, so grepping the dialog's own record answered nothing.
    const text = written
      ? null
      : refuseAndCount({
        reason: 'picker_unavailable',
        // #263 D2: a frame the funnel refused with no error to report leaves the key out,
        // because a null would read as a failure with nothing to say.
        record: refusal => log('pickerDialogFailed', {
          username: client.username ?? null,
          ...(error === null ? {} : { error }),
          ...refusal
        })
      })
    log('pickerDialog', {
      username: client.username ?? null,
      servers: rows.length,
      title,
      actions: rows.map(row => row.id),
      // #417: how large the dialog this join was shown is, the one number that says
      // what the picker costs a client. Absent unless the frame was written, because
      // a size for a dialog that never went out would read as one that did.
      ...(written ? { bytes: encoded.buffer.length } : {})
    })
    if (!written) endConfiguration(client, 'picker_unavailable', text)
  }

  // #266: one click on a dialog this leg authored, at either level. The level is
  // the id's namespace, not a connection's memory. A pick names a server, and a verb
  // names a verb and a server, so the frame alone says which dialog it answers.
  // Nothing has to be kept in step, which is what lets two clients hold the picker
  // at once (O55b).
  function handlePickerClick (client, buffer) {
    // #595: which dialog this answers, and what the answer means, is
    // src/core/picker.js's. The leg routes on the level the click came from.
    const answer = pickerBoard.click({ buffer, rows: pickerOffer().rows })
    if (answer.kind === 'ignore') {
      log('pickerPickIgnored', { username: client.username ?? null, reason: 'not_a_pick' })
      return
    }
    if (answer.level === 'pick') {
      handlePickerPick(client, answer)
      return
    }
    if (answer.level === 'verb') {
      handlePickerVerb(client, answer)
      return
    }
    // Ours to read and it did not read. The click is refused with the sentence
    // that says what was wrong, and the client is answered. A client left in a
    // dialog nobody will read is worse off than one that is told why.
    const text = refuseAndCount({
      reason: answer.reason,
      verb: answer.verb,
      id: answer.id,
      record: refusal => log('pickerVerbRefused', {
        username: client.username ?? null,
        uuid: client.uuid ?? null,
        id: answer.id,
        verb: answer.verb,
        slug: answer.slug,
        ...refusal
      })
    })
    endConfiguration(client, 'picker_refused', text)
  }

  // The client picked a server. The pick is reported to the caller, and the same
  // client gets that server's own dialog. A pick is the first half of a choice, not
  // the end of the connection (#266).
  //
  // A configuration frame this leg authored from its own params, which is what makes its
  // bytes the leg's to encode. So it is written as a raw frame through the funnel, as the
  // picker's dialog is, rather than as a packet object the wire check cannot see (#600).
  // The params are the leg's own, so there is nothing here for the check to disagree with.
  // The state and the policy are the two rules it takes.
  //
  // It leaves the library's own writer, so the interceptor's guard is not what refuses it:
  // the funnel's is, and that is where the count and the line for a refused frame live.
  function sendServerDialog (client, server) {
    let written = false
    let error = null
    const encoded = encodeDialogFrame(client, serverDialogParams({ server }))
    if (!encoded.ok) {
      error = encoded.error
    } else {
      try {
        written = writeRawTo(client, encoded.buffer, { state: 'configuration', name: 'show_dialog' })
      } catch (thrown) {
        error = String(thrown?.message ?? thrown).slice(0, 200)
      }
    }
    // #670: as in sendPickerDialog, the counted refusal writes the record that says why,
    // so `pickerServerDialogFailed` carries the reason and the sentence itself.
    const text = written
      ? null
      : refuseAndCount({
        reason: 'picker_unavailable',
        server: server.name,
        record: refusal => log('pickerServerDialogFailed', {
          username: client.username ?? null,
          server: server.name,
          slug: server.slug,
          ...(error === null ? {} : { error }),
          ...refusal
        })
      })
    if (written) metrics.pickerServerDialogs++
    log('pickerServerDialog', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      server: server.name,
      slug: server.slug,
      verbs: PICK_VERBS.map(verb => verbIdFor(verb, server.name))
    })
    if (!written) endConfiguration(client, 'picker_unavailable', text)
  }

  // #266: the answer to a server's own dialog. The verb and the server both ride in
  // the frame. This is therefore the server the client clicked, not one the leg
  // remembered.
  function handlePickerVerb (client, answer) {
    const server = answer.row
    const fields = {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      id: answer.id,
      verb: answer.verb,
      slug: answer.slug,
      server: server === null ? null : server.name
    }
    if (answer.kind === 'refuse') {
      // A verb answer this lane cannot act on: the frame named a server the offer
      // does not carry. The sentence is the board's (#595) and the count rides it,
      // because the one helper every counted refusal goes through composes both.
      const text = refuseAndCount({
        reason: answer.reason,
        verb: answer.verb,
        id: answer.id,
        record: refusal => log('pickerVerbRefused', { ...fields, ...refusal })
      })
      endConfiguration(client, 'verb_refused', text)
      return
    }
    metrics.pickerVerbs++
    log('pickerVerb', fields)
    // #267: the claim is recorded here, where the client answers a body's own
    // dialog, and not at login. The frame names the body, so the contention is over
    // that body and not over who logged in first.
    const claimed = answer.verb === 'claim' ? recordClaim(client, server) : null
    try {
      onPickerVerb?.({
        id: answer.id,
        verb: answer.verb,
        slug: answer.slug,
        server: { ...server },
        uuid: client.uuid ?? null,
        name: client.username ?? null,
        claim: claimed === null ? null : claimReport(claimed)
      })
    } catch (error) {
      log('pickerVerbHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    if (answer.verb === 'disconnect') {
      // #261: this verb names a body, not a seat. A claim is what keeps a body
      // alive, so a claimed body is refused in a sentence naming the player who
      // holds it. An unclaimed body ends: the session goes down and arms no retry
      // (src/core/session.js), and a claim is what dials it back. The client leaves
      // in both cases, and the frame that ends its configuration says which server
      // it left.
      //
      // #595: the board read the claim and put it on the answer, so the rule that
      // refuses this click is beside the rule that composes the row that showed it.
      // It is answered here, after the verb is recorded, because a refused
      // disconnect is still a verb the lane was asked for.
      if (answer.held !== null) {
        // #616: refused by the claim, through the one helper that counts a refusal, so
        // this click reaches the map #417 and #435 made the complete count. That helper
        // also moves this refusal's own number (#261), so this branch moves one thing
        // and not two counters it must remember.
        const text = refuseAndCount({
          reason: 'disconnect_claimed',
          verb: 'disconnect',
          server: server.name,
          driver: answer.held.name,
          record: refusal => log('pickerDisconnectRefused', {
            ...fields,
            driver: answer.held.name,
            holder: answer.held.holder,
            ...refusal
          })
        })
        endConfiguration(client, 'disconnect_refused', text)
        return
      }
      let asked = { ended: false, reason: 'no_body_sink' }
      try {
        const answer = disconnectBodyHandler === null
          ? null
          : disconnectBodyHandler({ body: server.slug, server: server.name, name: client.username ?? null })
        if (answer !== null && answer !== undefined) asked = answer
      } catch (error) {
        log('pickerDisconnectHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
      }
      if (asked.ended === true) metrics.pickerDisconnects++
      log('pickerDisconnect', {
        ...fields,
        ended: asked.ended === true,
        reason: asked.reason ?? null,
        state: asked.state ?? null
      })
      // The verb acted on the body, so this client stays where it was and is shown
      // the list again: the row it just ended reads `down`, and the next choice is
      // its own. A client ended here would be paying for the lane's act, and the
      // row is the proof it was carried out.
      sendPickerDialog(client)
      return
    }
    if (claimed !== null) {
      // #258: a granted claim is the landing. The body the frame named is dialled
      // now and the client is put into it; a refused one is answered with the
      // sentence naming what stands in the way.
      if (claimed.ok) {
        // The claim as recorded, not the outcome that carries it: the landing
        // names the body and the server the view holds.
        landClaimedBody(client, server, claimed.claim)
        return
      }
      endConfiguration(client, 'claim_refused', claimed.text)
      return
    }
    if (answer.verb === 'spectate') {
      // #259: the click is the landing. A spectator enters the body the way a driver
      // does: that body's configuration continues this client's phase, and then its
      // own play state arrives on the connection it already holds. A refusal is
      // answered in the sentence that names its reason, because a client left in a
      // dialog nobody will read is worse off than one that is told why.
      const landing = landSpectator(client, { body: server.slug, server: server.name })
      if (landing.watching === true) return
      endConfiguration(client, 'spectate_refused', landing.text)
      return
    }
    // Any other verb is one no lane offers yet. The board refuses a verb it does
    // not carry, so this is a guard rather than a path.
    //
    // #670: it counts nothing, and the reason is that no client reaches it: the board
    // answers `unknown_verb` for a verb it does not carry before this branch can run, so
    // the sentence here guards `PICK_VERBS` growing a verb with no branch above it.
    endConfiguration(client, 'verb_' + answer.verb + '_unbuilt', pickerBoard.refuse({ verb: answer.verb, server: server.name }))
  }

// --- #258: the claim lands the client ---

  // A granted claim is the one thing that dials a body. The click closed the
  // client's dialog and left the phase open, so the client is parked while the
  // address the row named is dialled. Nothing else is on screen. Nothing was
  // connected before this click either, which is why the picker serves its own
  // configuration phase rather than warming a body eagerly (Q6).
  function landClaimedBody (client, server, claim) {
    const target = pickTarget(server.name)
    metrics.claimLandings++
    log('pickerClaimLanding', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: claim.body,
      server: claim.server,
      target: target === null ? null : target.host + ':' + target.port
    })
    if (target === null) {
      // A row this lane offers but cannot read as an address.
      restoreClaimedPicker(client, claim, 'no_address')
      return
    }
    let pending = null
    try {
      pending = connectClaimedBody === null
        ? { connected: false, reason: 'no_lander' }
        : connectClaimedBody({
          body: claim.body,
          server: claim.server,
          target,
          name: client.username ?? null
        })
    } catch (error) {
      pending = { connected: false, reason: 'landing_threw', detail: String(error?.message ?? error).slice(0, 200) }
    }
    Promise.resolve(pending).then(
      outcome => settleClaimedBody(client, claim, outcome ?? { connected: false, reason: 'no_answer' }),
      error => settleClaimedBody(client, claim, {
        connected: false,
        reason: 'landing_rejected',
        detail: String(error?.message ?? error).slice(0, 200)
      })
    )
  }

  // The body did not let the client in, in any of the three ways that happens: an
  // address its row cannot give, a dial refused or never warmed, and a warm body
  // with nothing cached. One place answers all three, so the count, the log line
  // and the sentence cannot drift apart. The client reads the list again, titled
  // with the body that did not answer, and its claim stands (#267), so it may click
  // Claim again.
  function restoreClaimedPicker (client, claim, reason, detail = null) {
    metrics.claimRestored++
    log('pickerClaimRestored', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: claim.body,
      server: claim.server,
      reason,
      detail
    })
    sendPickerDialog(client, { title: claimRestoreTitle({ server: claim.server }) })
  }

  // The dial answered. A body that is up continues the client's own phase; one
  // that is not offers the list again. A client that left while the body dialled
  // holds nothing, and its claim went with the connection, so there is nothing to
  // answer.
  function settleClaimedBody (client, claim, outcome) {
    if (clients.get(client)?.ended === true) {
      log('pickerClaimAbandoned', {
        username: client.username ?? null,
        body: claim.body,
        server: claim.server,
        reason: outcome?.reason ?? null
      })
      return
    }
    if (outcome.connected !== true) {
      restoreClaimedPicker(client, claim, outcome.reason ?? 'body_unreachable', outcome.detail ?? null)
      return
    }
    landClaimedClient(client, claim, outcome)
  }

  // The body is up and its configuration is cached. The client's phase, which the
  // baseline opened and the dialog held, continues with that body's own frames and
  // ends with the one finish frame a client reads once. The client's answer to it
  // is what reaches playerJoin, where the core replays this body's play state on
  // the connection the client already holds.
  function landClaimedClient (client, claim, outcome) {
    // The channel opens before the body's frames go out, so every one of them is
    // counted on the channel that received it: a landing that fails half way must
    // leave a record of what the client was sent (#269).
    const channel = openChannel(client, { role: CHANNEL_ROLES.DRIVER, body: claim.body })
    const sent = sendBodyConfiguration(client)
    // #602: `written`, not `frames`. The funnel can refuse every frame a body offers, and a
    // client landed with no registry set is the outcome the empty cache was already refused
    // for. docs/telemetry.md says the reason is "the body's configuration replay wrote no
    // frame", which is this number.
    if (sent.written === 0) {
      // A body the core reports warm with nothing cached is a body no client can
      // be put into, and it is answered like an unreachable one.
      if (channel !== null) closeChannel(client)
      restoreClaimedPicker(client, claim, 'no_cached_configuration')
      return
    }
    const written = sent.written
    leavePicker(client)
    // The landing's finish stays on the library's writer, and the checks it does not take
    // are the ones that cannot apply: it is not a relayed frame, so there is no policy
    // question (the table replays a `finish_configuration`), and the interceptor's
    // `finishSent` machinery is what sends it once and drops the library's own copy.
    try {
      client.write('finish_configuration', {})
    } catch (error) {
      // #708: the claim was granted and the write ending its phase threw, which is the
      // one way a granted claim ends a client. The Spectate twin refuses this same
      // failure through the one helper (`landSpectator`'s `finish_failed`), so this arm
      // does too: the word the map is keyed by and the sentence the client is told arrive
      // in one call, and the record that says which frame failed carries both.
      //
      // The map's word is `finish_failed` and the end line's reason stays `claim_failed`,
      // which is the pair the Spectate landing already has (`spectate_refused` on the line,
      // `finish_failed` in the map). The failure is the same write, so it is the same key:
      // a verb-shaped word for it would be a second key for one number. The sentence is
      // the claim family's own and is unchanged, byte for byte (`src/core/picker.js`).
      const text = refuseAndCount({
        reason: 'finish_failed',
        verb: 'claim',
        server: claim.server,
        record: refusal => record(client, 'pickerClaimFinishFailed', {
          server: claim.server,
          error: String(error?.message ?? error).slice(0, 200),
          ...refusal
        })
      })
      endConfiguration(client, 'claim_failed', text)
      return
    }
    // #435's rule, which this landing broke the same way until #708: the landing is
    // counted after the write that ends the client's phase, because a phase the leg
    // could not end is a client this lane refused. Counted before the write, one claim
    // read as a landing and a refusal at once.
    metrics.claimLanded++
    record(client, 'pickerClaimLanded', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      server: claim.server,
      target: outcome.target ?? null,
      frames: written,
      warm: outcome.warm ?? null
    })
  }

  // #269: the dialog is over. Once a client is landed in a body it is a channel on
  // that body and not a picker client, so its frames take the serverbound path: the
  // driver's to the core, a spectator's dropped as a spectator's. A picker client's
  // frames are dialog clicks and nothing else, which is why a landing that kept the
  // flag would leave its driver unable to drive.
  function leavePicker (client) {
    const ctx = clients.get(client)
    if (ctx) ctx.picker = false
  }

  // #269: land a client this leg holds in a body as that body's spectator. The core
  // owns the body, so it answers whether the body this call names is the one it
  // serves; the leg then opens the client's spectator channel and continues its own
  // configuration phase with that body's frames, exactly as a landing does. Nothing
  // is asked of the client and nothing is sent to it on a refusal: the call answers
  // with the sentence to give it, and the caller that asked (the picker's Spectate,
  // #259) decides how to say it. Three reasons have three sentences, because "claim
  // it first", "wait" and "this lane is not serving it" ask for different things.
  function landSpectator (client, { body = null, server = null } = {}) {
    const named = server ?? body
    const answer = spectateBodyHandler === null
      ? { watching: false, reason: 'no_spectator_sink' }
      : spectateBodyHandler({ body, server: named, name: client.username ?? null })
    // #435: every branch below refuses through here, so the reason the client is
    // told is the reason the record carries and the reason the map counts. Before
    // this, only the core's refusal was counted: a Spectate refused after the
    // answer said yes — the channel that would not open, the body that replayed no
    // frame, the phase-end write that threw — reached no record and no count, so
    // `front.pickerRefusalsByReason` read as a complete count and was not one.
    // The record goes through `record`, which stamps the channel a refusing client
    // still holds when the phase-end write is the thing that failed.
    const refused = reason => {
      // #616: the sentence and the count are the one helper's, so a branch here cannot
      // refuse without counting. #670: and the record is the helper's too, so the reason
      // the map is keyed by is the reason on the line a reader greps.
      const text = refuseAndCount({
        reason,
        verb: 'spectate',
        server: named,
        record: refusal => record(client, 'spectateRefused', {
          username: client.username ?? null,
          body,
          server: named,
          ...refusal
        })
      })
      return { watching: false, reason, text }
    }
    if (answer?.watching !== true) return refused(answer?.reason ?? 'unwatchable')
    const channel = openChannel(client, {
      role: CHANNEL_ROLES.SPECTATOR,
      body: typeof answer.body === 'string' ? answer.body : body
    })
    if (channel === null) return refused('channel_refused')
    const sent = sendBodyConfiguration(client)
    // As in landClaimedClient: the answer is what the funnel wrote, not what the body offered.
    if (sent.written === 0) {
      closeChannel(client)
      return refused('no_cached_configuration')
    }
    leavePicker(client)
    // The library's writer, for the reason landClaimedClient gives at its own finish: it is
    // not a relayed frame, and the interceptor sends it once.
    try {
      client.write('finish_configuration', {})
    } catch (error) {
      record(client, 'spectateFinishFailed', {
        server: named,
        error: String(error?.message ?? error).slice(0, 200)
      })
      return refused('finish_failed')
    }
    // #435: the landing is counted once the client's phase has ended, because a
    // phase the leg could not end is a client this lane refused. Counted before the
    // write, one Spectate read as a landing and a refusal at once.
    metrics.spectateLandings++
    record(client, 'spectateLanded', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      server: named,
      frames: sent.written
    })
    return { watching: true, reason: null, text: null, channel: channel.id, body: channel.body, frames: sent.written }
  }

  // #269: a body's own configuration frames, in the phase the baseline opened and
  // the dialog held. The cache holds the body's finish frame and the phase ends
  // with exactly one, so it is dropped here: a second finish arrives after the
  // client is in play, where its id is another packet's, and the client reads it
  // as one. A claim and a spectator both enter a body this way, which is why it is
  // one function: a client's configuration must not depend on its role. Its play
  // state differs in one way only, and the core writes that: the two frames that
  // tell a spectator what it is (#259).
  //
  // #602: every frame goes through the funnel, which is where the policy backstop, the
  // reconfiguration hold, the state check and the wire check live. A landing is the one
  // moment a body's configuration is written into a client that is mid-phase, so a
  // writer that skipped them was a frame the policy refuses reaching a client.
  function sendBodyConfiguration (client) {
    const frames = replayableConfigFrames().filter(frame => frame.name !== 'finish_configuration')
    let written = 0
    for (const frame of frames) {
      if (writeRawTo(client, frame.buffer, { state: 'configuration', name: frame.name })) written++
    }
    return { frames: frames.length, written }
  }

  // #267: the claim as the callback and the log both read it. One mapper, so the
  // report a caller receives and the line an operator reads cannot drift apart.
  function claimReport (outcome) {
    return {
      granted: outcome.ok,
      repeated: outcome.repeated === true,
      reason: outcome.reason,
      claimedBy: outcome.claim?.name ?? null
    }
  }

  // #267: one claim, recorded where the client answers. The refusal carries the
  // claim that stands in the way, and the sentence for it, so the caller answers
  // the client and this stays the one place a claim is recorded.
  function recordClaim (client, server) {
    const outcome = claims.claim({
      body: server.slug,
      server: server.name,
      holder: holderFor(client),
      name: client.username ?? null,
      at: Date.now()
    })
    const fields = {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      body: server.slug,
      server: server.name,
      ...claimReport(outcome)
    }
    if (outcome.ok) {
      if (outcome.repeated !== true) metrics.pickerClaims++
      log('pickerClaim', fields)
      return { ...outcome, text: null }
    }
    const text = refuseAndCount({
      reason: outcome.reason,
      verb: 'claim',
      server: server.name,
      holder: outcome.claim?.name ?? null,
      claimed: outcome.reason === CLAIM_REFUSAL.HELD ? outcome.claim?.server ?? null : null,
      record: refusal => log('pickerClaimRefused', { ...fields, ...refusal })
    })
    return { ...outcome, text }
  }

  function handlePickerPick (client, answer) {
    // #595: the board found the row, or found none. What is left here is the
    // report a pick owes the caller and the count a pick owes the map.
    const picked = answer.row
    metrics.pickerPicks++
    // #417: the pick is one connection's, timed from that connection's own login.
    // Both moments are this leg's, so nothing joins two picker connections of one
    // account by name: a second connection reading the picker cannot be charged
    // with the first one's time. Absent when the leg stamped no login for this
    // socket, because an age of 0 would read as a pick in the same millisecond.
    const loginToPickMs = elapsedSince(clients.get(client)?.loginAt, Date.now())
    log('pickerPick', {
      username: client.username ?? null,
      uuid: client.uuid ?? null,
      id: answer.id,
      slug: answer.slug,
      server: picked === null ? null : picked.name,
      known: picked !== null,
      ...(loginToPickMs === null ? {} : { loginToPickMs })
    })
    try {
      onPickerPick?.({
        id: answer.id,
        slug: answer.slug,
        server: picked === null ? null : { ...picked },
        uuid: client.uuid ?? null,
        name: client.username ?? null
      })
    } catch (error) {
      log('pickerPickHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    if (picked === null) {
      // The dialog on screen is older than the list it came from, which is the same
      // refusal a verb on an unknown server gets: the frame named a server this lane
      // does not offer.
      const text = refuseAndCount({
        reason: answer.reason,
        id: answer.id,
        record: refusal => log('pickerPickRefused', {
          username: client.username ?? null,
          id: answer.id,
          slug: answer.slug,
          ...refusal
        })
      })
      endConfiguration(client, 'pick_refused', text)
      return
    }
    sendServerDialog(client, picked)
  }

  // Leave configuration with a message. The library's own end() writes nothing in
  // this state (its override covers login and play only), so the frame is
  // written here and the socket is ended after it — unless the connection is already
  // on its way out, where the frame is a no-op and the end is somebody else's (see
  // #749 below). A client that is told why it is leaving is the whole difference
  // between a refusal and a hang.
  //
  // This write cannot go through writeRawTo, and the checks it does not take are the
  // reason: the policy blocks a configuration `disconnect` and a `transfer` because they
  // are the puppet's connection control, and this one is the lane saying why it is ending
  // the client. A funnel that refused it would leave the client with nothing.
  function endConfiguration (client, reason, text) {
    try {
      client.write('disconnect', { reason: { type: 'string', value: text } })
    } catch (error) {
      record(client, 'configurationDisconnectFailed', { reason, error: String(error?.message ?? error).slice(0, 200) })
    }
    record(client, 'configurationEnded', { reason, username: client.username ?? null })
    // #749: one end per client. The record is written either way, because the record is
    // what tells a reader why this client left; the end is not, when an end has already
    // been asked for. A frame the funnel refused in `wireMode: 'throw'` ended it
    // (emitCheckedRaw's own rule, and the funnel marks the connection's record), so a
    // second end here would arm a close timer the library can no longer clear and hold the
    // process for the whole of its 30 s close timeout, which is how long this lane's tests
    // paid after #710. Both dialog failures end here — a picker dialog the leg could not
    // write, and a server's — so one guard covers both, and the mark below is what makes a
    // second end from this function a no-op as well.
    const ctx = clients.get(client)
    if (ctx?.endRequested === true) return
    if (ctx) ctx.endRequested = true
    try {
      client.end('picker: ' + reason)
    } catch {
      destroyQuietly(client)
    }
  }

  // The client reached play. Hand the attach to the core: replay the join
  // prefix + warm state (configuration frames are omitted — the front leg
  // owns the configuration phase).
  function onClientJoined (client) {
    const channel = channelFor(client)
    // #269: a spectator is not an attach. The body is already delivered to its
    // driver, so the client is handed that body's play state on its own channel and
    // the session is not touched: watching is not driving, and a second attach would
    // make it one.
    if (channel !== null && channel.role === CHANNEL_ROLES.SPECTATOR) {
      // #618: the spectator's own skin, which is the account's and never the body's.
      // The front verified this client, so the body it holds is the profile the
      // sessionserver answered, and the textures on it are that account's own.
      const skin = profileTextures(client.profile)
      const watched = spectatorAttachHandler === null
        ? { watching: false, reason: 'no_spectator_sink' }
        : spectatorAttachHandler({
          name: client.username ?? null,
          uuid: client.uuid ?? null,
          channel: channel.id,
          skin
        })
      if (watched?.watching !== true) {
        record(client, 'spectateFailed', {
          username: client.username ?? null,
          uuid: client.uuid ?? null,
          reason: watched?.reason ?? 'no_answer'
        })
        try { client.end(`spectate refused (${watched?.reason ?? 'no_answer'})`) } catch { /* already gone */ }
        return
      }
      channels.markReplay(channel.id)
      metrics.spectatorJoins++
      record(client, 'spectated', {
        username: client.username ?? null,
        uuid: client.uuid ?? null,
        frames: watched.frames ?? null,
        replayed: watched.replayed ?? null,
        // #618: whether this landing was handed a skin at all, which is the front's fact
        // and not the core's. `spectateView`'s `ownSkin` is the other one — the entry was
        // written — and the two differ while the switch is off.
        skinSupplied: skin !== null
      })
      return
    }
    // The driver, and a client this lane admitted without one. The core's session is
    // the authority here, and it answers `already_attached` when a driver already
    // holds the body. A rival on a lane with no picker never reaches this point,
    // because its login was refused (#312). One on a lane with a picker is refused by
    // the claim (#269). The session's answer covers the case neither of those can: a
    // login admitted while another connection still held the body.
    // The channel has to exist before the core replays: the replay is written
    // synchronously, and it goes to the channels this leg holds. A client the session
    // accepts without one — its login was admitted while another connection still held
    // the body, and that connection failed before the core answered this one — gets its
    // channel here, or its replay would be written to no socket at all.
    const held = channelFor(client) ?? openChannel(client, { role: CHANNEL_ROLES.DRIVER })
    const outcome = coreAttach({ name: client.username, uuid: client.uuid })

    if (!outcome.attached) {
      record(client, 'attachFailed', { username: client.username, uuid: client.uuid, reason: outcome.reason })
      client.end(`attach denied (${outcome.reason})`)
      return
    }
    // The core just replayed the body's play state on this socket, so this channel has
    // been handed its one replay.
    if (held !== null) channels.markReplay(held.id)
    metrics.attaches++
    record(client, 'attached', { username: client.username, uuid: client.uuid, replayed: outcome.replayed })
  }

  // #258: the body a claim dials. Set by the core when the lane can serve a
  // picker, so a role that never wired it refuses the landing in words rather than
  // waiting for an answer nobody sends.
  let connectClaimedBody = null

  let coreAttach = ({ name, uuid, includeConfig = false } = {}) => ({ attached: false, reason: 'no_core_attached' })
  // The orchestrator injects the core attach calls (keeps this module free of
  // core imports; the core drives the pipeline through the handlers).
  // \`coreAttach\` runs at playerJoin: the client is in play and wants its
  // replay. \`coreAttachConfiguring\` runs at beforeLogin, for a client that
  // attaches while the puppet is still in configuration (#16).
  let coreAttachConfiguring = () => ({ attached: false, reason: 'no_core_attached' })
  function setCoreAttach (fn) { coreAttach = fn }
  function setCoreAttachConfiguring (fn) { coreAttachConfiguring = fn }

  function wireServerbound (client) {
    const decoded = { state: null, byName: {} }
    client.on('packet', (data, meta) => {
      decoded.byName[meta.name] = data
      decoded.state = meta.state
    })
    client.on('raw', (buffer, meta) => {
      // #257: a picker client has no backend. Nothing it says can be relayed, and
      // the one frame this leg wants from it is the click on the dialog.
      if (clients.get(client)?.picker === true) {
        if (meta.state === 'configuration' && meta.name === 'custom_click_action') {
          handlePickerClick(client, buffer)
        }
        return
      }
      // #269: a spectator changes nothing. Its frames never reach the core's
      // pipeline, so nothing it sends can drive the body, speak as the puppet, or
      // answer a dialog on the body's behalf. Counted, because a client whose input
      // is refused should be able to say so.
      const channel = channelFor(client)
      if (channel !== null && channel.role === CHANNEL_ROLES.SPECTATOR) {
        metrics.spectatorFramesDropped++
        // #636: where its client is, read before the frame goes nowhere. A spectator is not
        // a player the server knows, so nothing it sends can be relayed — and the proxy draws
        // it for the body's other channels, which is why the position is the one thing this
        // leg keeps. The frame itself still reaches no core pipeline: the call-in carries a
        // pose and nothing else, and a pose is never written to the backend.
        const same = decoded.state === meta.state && decoded.byName[meta.name] !== undefined
        const moved = isPoseFrame(meta.name) && same
        if (moved) {
          spectatorPoseHandler?.({ channel: channel.id, name: meta.name, data: decoded.byName[meta.name] })
          // Consumed, like the driver's own frames below: a decode left standing is one a
          // later frame of the same name can be confused for.
          decoded.byName[meta.name] = undefined
        }
        record(client, 'spectatorFrameDropped', {
          username: client.username ?? null,
          state: meta.state,
          name: meta.name,
          moved
        })
        return
      }
      // #16: a configuration-phase frame reaches the core as well. The human's
      // dialog answers belong to the puppet's session, and the core's own drop
      // rules (classifyServerbound) keep this connection's handshake per-leg.
      if (meta.state !== 'play' && meta.state !== 'configuration') return
      const same = decoded.state === meta.state && decoded.byName[meta.name] !== undefined
      const data = same ? decoded.byName[meta.name] : {}
      decoded.byName[meta.name] = undefined
      // #22: the client's own finish_configuration ends a reconfiguration it
      // was asked to enter. The frame is still offered to the core, which
      // drops it like every other front handshake frame; the state flip and
      // the play-ready call-in happen after that.
      // #22: the client answered the play-state start_configuration; only now
      // can its connection parse configuration frames.
      const acknowledgesReconfiguration = meta.state === 'play' && meta.name === 'configuration_acknowledged' &&
        clients.get(client)?.pendingReconfiguration !== undefined &&
        clients.get(client)?.pendingReconfiguration !== null
      const finishesReconfiguration = clients.get(client)?.reconfiguring === true &&
        meta.state === 'configuration' && meta.name === 'finish_configuration'
      serverboundHandler?.({ state: meta.state, name: meta.name, buffer, data })
      if (acknowledgesReconfiguration) acknowledgeReconfiguration(client)
      if (finishesReconfiguration) finishReconfiguration(client)
    })
  }

  // #22: the client answered the reconfiguration's finish frame, so it is in
  // play again on the same connection. Flip the leg's own state back and tell
  // the core, which replays the target's play login and join state.
  function finishReconfiguration (client) {
    const ctx = clients.get(client)
    if (!ctx?.reconfiguring) return { reconfigured: false }
    ctx.reconfiguring = false
    try {
      client.state = 'play'
    } catch (error) {
      record(client, 'frontReconfigureStateFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { reconfigured: false }
    }
    metrics.reconfigured++
    record(client, 'frontReconfigured', { username: client.username ?? null, uuid: client.uuid ?? null })
    try {
      reconfiguredHandler?.({ name: client.username ?? null, uuid: client.uuid ?? null })
    } catch (error) {
      record(client, 'reconfiguredHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
    }
    return { reconfigured: true }
  }

  function wireClient (client) {
    // #16: the serverbound pipeline is wired at connection time, not at
    // playerJoin: a client that attaches during the puppet's configuration has
    // configuration answers to send before it ever reaches play.
    wireServerbound(client)
    // #22: the library's keep-alive plugin starts a new interval on every
    // 'play' state transition and holds only the newest handle, so a
    // same-connection reconfiguration would leak one interval per move. One
    // interval per connection is all this leg needs: it keeps running through
    // the configuration phase (where keep_alive exists too), and the library
    // clears it on 'end'. Drop the listener after the first play transition.
    client.on('state', state => {
      if (state !== 'play') return
      client.removeAllListeners('state')
    })
    // Detach bookkeeping from connection time: an attached client that ends
    // clears the slot and notifies the core; a pre-attach client (denied or
    // failed during configuration) just clears its claim.
    client.on('end', reason => {
      const ctx = clients.get(client)
      if (ctx) {
        ctx.pendingReconfiguration = null
        ctx.reconfiguring = false
        // #258: a landing that is still dialling when the client leaves writes to
        // nothing. The claim ends with the connection (#267), so the mark is all
        // the answer a late dial needs.
        ctx.ended = true
      }
      // #267: the claim is held by the connection that made it, so it ends with the
      // connection. A client that never claimed releases nothing.
      const released = claims.release(holderIds.get(client))
      if (released !== null) {
        record(client, 'pickerClaimReleased', {
          username: client.username ?? null,
          uuid: client.uuid ?? null,
          body: released.body,
          server: released.server,
          claimedBy: released.name,
          reason: String(reason).slice(0, 160)
        })
      }
      // #269: the channel ends with its connection. The driver's channel closing is a
      // detach, because the body outlives the player. A spectator's channel closing
      // ends a spectator and nothing else, because the body was never theirs.
      const closed = closeChannel(client)
      if (closed !== null && closed.role === CHANNEL_ROLES.DRIVER) {
        recordOfChannel(closed, 'frontDetach', { reason: String(reason).slice(0, 160), attached: true, channels: channels.size })
        detachHandler?.({ reason: String(reason) })
      } else if (closed !== null && closed.role === CHANNEL_ROLES.SPECTATOR) {
        // #259: a spectator leaving is the end of a spectator and nothing else. The
        // body was never theirs, so the core is told only so it can stop relaying
        // when nobody is left to receive.
        recordOfChannel(closed, 'frontClientEnd', {
          reason: String(reason).slice(0, 160),
          attached: false,
          role: closed.role,
          channels: channels.size
        })
        spectatorLeftHandler?.({ channel: closed.id, name: closed.name })
      } else if (closed !== null || clients.has(client)) {
        recordOfChannel(closed, 'frontClientEnd', {
          reason: String(reason).slice(0, 160),
          attached: false,
          role: closed === null ? null : closed.role,
          channels: channels.size
        })
      }
    })
    client.on('error', err => {
      record(client, 'frontClientError', { error: String(err.message).slice(0, 200) })
      errorHandler?.({ error: err })
    })
    // #18: the human's Client Information, as it arrives. A joining client
    // sends it in the configuration phase; a later settings change sends it in
    // play. This is a read-only observation: the configuration handshake, the
    // replay interceptor, and the raw serverbound filter are untouched. The
    // core decides what the backend sees.
    client.on('settings', (data, meta) => {
      const state = meta?.state ?? client.state ?? null
      const channel = channelFor(client)
      // #269: every channel records its own information, so two clients on one body
      // hold two records and neither can overwrite the other. Only the driver's
      // reaches the core, and only outside play (#18): a play-state change travels
      // the serverbound pipeline, where the core rewrites it with the backend's cap.
      if (channel === null) {
        log('clientInformationNoChannel', { username: client.username ?? null, state })
        return
      }
      channels.settings(channel.id, data, { at: Date.now() })
      if (channel.role !== CHANNEL_ROLES.DRIVER) {
        metrics.spectatorSettings++
        record(client, 'spectatorClientInformation', {
          username: client.username ?? null,
          state,
          locale: data?.locale ?? null
        })
        return
      }
      if (!reportsClientInformation({ role: channel.role, state })) {
        record(client, 'clientInformationNotReported', { username: client.username ?? null, state })
        return
      }
      try {
        clientSettingsHandler?.({ ...data })
      } catch (error) {
        record(client, 'clientSettingsHandlerError', { error: String(error?.message ?? error).slice(0, 200) })
      }
    })
  }

  // #22: ask the attached client to re-enter configuration on the connection
  // it already holds. The proxy writes its own start_configuration (the backend
  // frame of the same name never crosses: it would move the human as their own
  // account).
  //
  // The client answers with `configuration_acknowledged`, which exists in the
  // play packet table only (26.1 play toServer 0x10). The leg therefore holds
  // the configuration frames it is given until that answer arrives, then flips
  // its client to the configuration state and flushes them in order. Flipping
  // first would read the answer through the configuration table as an unknown
  // packet.
  function startReconfiguration ({ reason = 'transfer' } = {}) {
    // A reconfiguration is the driver's: it is the body's own connection, and a
    // spectator is handed the restored state like any other body stream (#269).
    const driver = driverClient()
    if (!driver) return { started: false, reason: 'no_client' }
    const ctx = clients.get(driver)
    if (ctx?.pendingReconfiguration) {
      record(driver, 'frontReconfigureRefused', { reason: 'already_reconfiguring' })
      return { started: false, reason: 'already_reconfiguring' }
    }
    if (driver.state !== 'play') {
      record(driver, 'frontReconfigureRefused', { reason: 'client_not_in_play', state: driver.state })
      return { started: false, reason: 'client_not_in_play', state: driver.state }
    }
    // #541: the round opens the phase again, before the frame that starts it.
    // The start_configuration is written in play, so it is not a configuration
    // write and the interceptor cannot see the round begin.
    ctx?.interceptor?.reopenConfiguration?.()
    try {
      driver.write('start_configuration', {})
    } catch (error) {
      record(driver, 'frontReconfigureWriteFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { started: false, reason: 'write_failed' }
    }
    if (ctx) {
      ctx.pendingReconfiguration = { frames: [], dropped: 0 }
      ctx.reconfiguring = false
    }
    metrics.reconfigurations++
    record(driver, 'frontReconfiguration', { reason, username: driver.username ?? null })
    return { started: true, reason }
  }

  // The client acknowledged the play-state start_configuration, so the
  // configuration table is the one its connection now speaks.
  function acknowledgeReconfiguration (client) {
    const ctx = clients.get(client)
    if (!ctx?.pendingReconfiguration) return { acknowledged: false }
    const pending = ctx.pendingReconfiguration
    ctx.pendingReconfiguration = null
    try {
      client.state = 'configuration'
    } catch (error) {
      record(client, 'frontReconfigureStateFailed', { error: String(error?.message ?? error).slice(0, 200) })
      return { acknowledged: false }
    }
    ctx.reconfiguring = true
    // #602: the flush is the same write the hold took, so it is the same funnel. A held
    // finish closes the phase where it is written, which is #541's fact and not this
    // function's to restate.
    for (const frame of pending.frames) {
      writeRawTo(client, frame.buffer, frame.meta)
    }
    metrics.reconfigurationFramesFlushed += pending.frames.length
    record(client, 'frontReconfigurationAcknowledged', {
      username: client.username ?? null,
      flushedFrames: pending.frames.length,
      droppedFrames: pending.dropped
    })
    return { acknowledged: true, flushed: pending.frames.length }
  }

  // --- #269: delivery, one channel at a time ---

  // #600: the only state a packet object reaches a client in here. A configuration frame is
  // a raw frame (sendServerDialog), so this is not a default a caller can weaken.
  const PACKET_PATH_STATE = 'play'

  // #599: one drop, one count, one line. Both write paths that can refuse a configuration
  // frame after its phase's finish come here, so the count cannot be true on one path and
  // false on the other, which is the pair of numbers #602 found for the policy.
  function recordAfterFinishDrop (client, { name = null, state = null } = {}) {
    metrics.configFramesAfterFinish++
    record(client, 'configFrameAfterFinish', { name, state })
  }

  // #16 and #600: one frame must reach the client in a state it can parse. A frame written
  // in another state is read as a different packet's id, with the rest of its bytes left
  // over: #541 is that measurement, and writeRawTo names it.
  // Both writers ask this: the raw funnel has the frame's bytes and its declared state,
  // and a packet object has the state its caller declares, because the library serializes
  // one with whatever state the client holds.
  function refuseStateMismatch (client, { name = null, state = null } = {}) {
    if (!state || !client?.state || state === client.state) return false
    metrics.stateRefused++
    record(client, 'clientboundStateMismatch', { name, frameState: state, clientState: client.state })
    return true
  }

  // The library-serialized packet path (the synthesized position, the skin, a notice). A
  // packet object has no bytes for the wire check to read, so the check it can take is the
  // one about state.
  //
  // #600: "a packet object cannot carry trailing bytes" is true of the bytes and false of
  // the failure class. A frame serialized with the configuration table while the client
  // reads play is a configuration id the client decodes as another packet, with the rest
  // of the frame left over. So the frame's state is not a caller's declaration to forget or
  // to get wrong: every packet object this path may carry is a play frame, and a frame that
  // belongs to a configuration phase is encoded and written through writeRawTo, where the
  // wire check sees it (sendServerDialog, and sendPickerDialog before it).
  function writePacketTo (client, name, packet) {
    if (!client || typeof client.write !== 'function') return false
    // The state the client would read this frame in, before the library picks a table for
    // it. A refusal here is a frame that never reaches the wire, counted and named.
    if (refuseStateMismatch(client, { state: PACKET_PATH_STATE, name })) return false
    // #541: the interceptor answers false for a frame it dropped, and a frame
    // that never reached the wire is not a frame the channel was delivered.
    if (client.write(name, packet) === false) return false
    // #417: no length, because this path holds a packet object and the library
    // serializes it. The frames it carries are the synthesized position, the skin
    // and a notice: a fixed handful per connection, and the one gap in a channel's
    // byte count, which docs/telemetry.md names.
    noteDelivered(client, { state: PACKET_PATH_STATE, name })
    return true
  }

  // One frame, to one client. Everything on this path is per socket: the clientbound
  // policy backstop, the reconfiguration hold, the state check, the rule against a frame
  // after its phase's finish, and the wire check. A body with two channels does the work
  // twice, so neither client can be handed a frame in a state it cannot parse.
  //
  // #602: this is the leg's only raw writer. The config interceptor's replay, a claim
  // landing, a spectator landing, the reconfiguration flush and both of the leg's own
  // dialogs come here, so a check added below is a check every clientbound raw frame
  // takes. A writer that called emitCheckedRaw directly would have the wire check and
  // none of the rest, which is the hole #602 found three of. #600 moved the picker's
  // server dialog off the packet path and onto this one, because its bytes are the
  // leg's own and the wire check can read them.
  function writeRawTo (client, buffer, meta = null) {
    if (!client) return false
    // Last-write check: even if the core router regresses, a frame the
    // clientbound policy blocks never reaches the client. The cache and
    // router already drop these; this is the independent backstop. It takes
    // the chat mode so it refuses what the router refuses (#19).
    if (meta && (meta.state === 'play' || meta.state === 'configuration')) {
      if (!mayCrossToFront(meta.state, meta.name, { chat: chatMode })) {
        const policy = clientboundPolicy(meta.state, meta.name)
        metrics.policyRefused++
        record(client, 'clientboundRefused', {
          state: meta.state,
          name: meta.name,
          unknown: policy.unknown === true
        })
        return false
      }
    }
    // #22: the reconfiguration is waiting for the client's play-state
    // configuration_acknowledged. The client cannot parse a configuration
    // frame before that, so hold them in order and flush them on the ack.
    const pending = clients.get(client)?.pendingReconfiguration
    if (pending && client.state === 'play' && meta?.state === 'configuration') {
      pending.frames.push({ buffer, meta })
      while (pending.frames.length > MAX_PENDING_RECONFIGURATION_FRAMES) {
        // Drop the newest: the earliest frames carry the registries the rest
        // of the round depends on. A queue this deep means the client never
        // acknowledged, and the core's configuration deadline ends the round.
        pending.frames.pop()
        pending.dropped++
        metrics.reconfigurationFramesDropped++
      }
      if (pending.dropped > 0 && !pending.overflowLogged) {
        pending.overflowLogged = true
        record(client, 'frontReconfigurationOverflow', { dropped: pending.dropped })
      }
      return true
    }
    // #16: a relayed frame must reach the client in a state it can parse. A
    // configuration frame written while the client is still in login is read
    // as a login packet, which kills the connection. Refuse and log instead.
    if (refuseStateMismatch(client, meta ?? {})) return false
    // #599: this phase's finish is on the wire, so the client reads play from here and
    // a configuration frame arriving now is another packet's id with the rest of its
    // bytes left over (#541 read 9 bytes as `acknowledge_player_digging`). The leg's own
    // state has not caught up until the client answers, which is why the state check
    // above passes in exactly this window. The interceptor refuses the library's writer
    // this way; this is the same rule for every writer that comes here.
    if (clients.get(client)?.interceptor?.refusesAfterFinish?.({ state: meta?.state ?? null }) === true) {
      recordAfterFinishDrop(client, { name: meta?.name ?? null, state: meta?.state ?? null })
      return false
    }
    if (dumpRaw) {
      dumpRaw({ kind: 'raw', buffer, state: meta?.state ?? null, name: meta?.name ?? null })
    }
    // #16: the core's own finish_configuration ends the client's
    // configuration phase. The interceptor must drop the library's deferred
    // finish so the client never sees two of them.
    if (meta?.state === 'configuration' && meta?.name === 'finish_configuration') {
      const ctx = clients.get(client)
      if (ctx?.interceptor?.finishFromCore()) {
        record(client, 'configFinishedByCore', { username: client.username ?? null })
      }
    }
    const sent = emitCheckedRaw({ client, buffer, meta, wireCheck, wireMode, stats: wireStats, log: recordFor(client) })
    if (sent) {
      noteDelivered(client, meta, { bytes: buffer.length })
    } else {
      // #749: the check's own rule ended this client, with `wire_reject` and before
      // anything else on this path could speak. That end goes on the connection's own
      // record, because the caller that wrote the frame is about to end the same client
      // for its own reason and has no other way to know. `endConfiguration` is that
      // caller, and it is where the second end was.
      const ctx = clients.get(client)
      if (ctx) ctx.endRequested = true
    }
    return sent
  }

  return {
    kind,
    listen,

    // --- frontLeg interface (docs/product-core.md) ---
    setLoginStartHandler (fn) { loginStartHandler = fn },
    setServerboundHandler (fn) { serverboundHandler = fn },
    setDetachHandler (fn) { detachHandler = fn },
    setErrorHandler (fn) { errorHandler = fn },
    setClientSettingsHandler (fn) { clientSettingsHandler = fn },
    setConfiguringHandler (fn) { configuringHandler = fn },
    setReconfiguredHandler (fn) { reconfiguredHandler = fn },
    startReconfiguration,
    // #87: the frame bytes that end a configuration round, for a restore whose
    // snapshot carries no cached finish frame.
    finishConfigurationFrame () { return configurationFinishFrame({ version }) },
    setCoreAttach,
    setCoreAttachConfiguring,
    // #258: the body a claim dials. The core wires this when it starts, so a leg
    // built without a core refuses every landing instead of waiting for an answer
    // nobody sends.
    setConnectClaimedBody (fn) { connectClaimedBody = typeof fn === 'function' ? fn : null },
    // #269: the spectator's two call-ins. The core wires them in its own start(), so
    // a leg built without a core refuses the Spectate verb in words instead of
    // waiting for an answer nobody sends.
    setSpectateBody (fn) { spectateBodyHandler = typeof fn === 'function' ? fn : null },
    setSpectatorAttach (fn) { spectatorAttachHandler = typeof fn === 'function' ? fn : null },
    setSpectatorPose (fn) { spectatorPoseHandler = typeof fn === 'function' ? fn : null },
    // #259: the body this lane serves and whether it is up, for the picker's rows.
    setBodyServed (fn) { bodyServedHandler = typeof fn === 'function' ? fn : null },
    // #261: the Disconnect verb's answer. The core ends the session, and a lane
    // with no core records the click and ends no body.
    setDisconnectBody (fn) { disconnectBodyHandler = typeof fn === 'function' ? fn : null },
    // #259: a spectator's channel ended, so the core can stop relaying a body that
    // nobody is in play on.
    setSpectatorLeft (fn) { spectatorLeftHandler = typeof fn === 'function' ? fn : null },
    // #269: land one of this leg's connections in a body as its spectator, and answer
    // with what happened. The player is named rather than the socket because the
    // caller is the lane's, not the socket's: #259 wires the picker's Spectate to
    // this, and a rung stands in for it until then. A refusal carries the sentence for
    // the client, so the surface that shows it stays the caller's to decide.
    spectate ({ username = null, body = null, server = null } = {}) {
      const client = typeof username === 'string'
        ? [...clients.keys()].find(entry => entry.username === username) ?? null
        : null
      if (client === null) {
        // #670: this refusal counts nothing, because its sentence reaches no client: the
        // lookup above found none to give it to. A caller decides how to show it, and a
        // count here would tell an operator a client was refused by a lane it never
        // reached.
        return {
          watching: false,
          reason: 'no_client',
          text: pickerBoard.refuse({ verb: 'spectate', reason: 'no_client', server: server ?? body })
        }
      }
      return landSpectator(client, { body, server })
    },
    // #269: a clientbound write goes to the body's channels: its driver, and every
    // spectator watching that body. `channel` addresses one of them, which is what a
    // spectator's own replay uses so the driver is never handed it twice.
    write (name, packet, { channel = null } = {}) {
      return deliverEach(channel, client => writePacketTo(client, name, packet), { name }) > 0
    },
    writeRaw (buffer, meta = null, { channel = null } = {}) {
      return deliverEach(channel, client => writeRawTo(client, buffer, meta), { name: meta?.name ?? null }) > 0
    },
    end (reason) {
      // A body that ends ends every channel watching it: the driver and its
      // spectators hold connections to a body that is gone.
      for (const channel of channels.snapshot()) {
        const client = clientOfChannel(channel.id)
        try { client?.end(reason) } catch { /* client already gone */ }
      }
    },
    get listening () { return Boolean(server) },
    // #269: the channels this leg holds, one record per connection delivered a
    // body: its role, what it has been sent, and its own client information. A lane
    // that never lands a client keeps this empty.
    get channels () { return channels.snapshot() },
    // The socket the body is delivered to. A caller that needs the connection rather
    // than its delivery record reads this; it is the driver's channel's client, and
    // null when nobody holds the body.
    get driver () { return driverClient() },
    // #267: the claims this leg holds, one per body. A lane that never serves a
    // picker never records one, so this stays empty there.
    get claims () { return claims.snapshot() },
    // #261: the claim on one body, or null. The core asks this at the moment it
    // would arm a retry, so a body nobody holds stays down and a body somebody holds
    // is kept, and neither answer is a copy of the board that could drift.
    claimOn (body) { return claims.claimOn(body) },
    // #627: the window's own numbers, which the lane snapshot carries. The leg holds
    // the policy, so the core reads them here instead of keeping a copy.
    preAuthStats () { return preAuthWindow.stats() },
    // The window's own numbers are read live, so the leg keeps no copy of a count
    // the policy already holds.
    get metrics () {
      const window = preAuthWindow.stats()
      return { ...metrics, preAuthInWindow: window.inWindow, preAuthExpired: window.expired }
    },
    get checkStoreFile () { return store?.file ?? null },
    get port () { return actualPort() },
    get wireStats () {
      return {
        checked: wireStats.checked,
        rejected: wireStats.rejected,
        byState: { ...wireStats.byState },
        lastFailure: wireStats.lastFailure ? { ...wireStats.lastFailure } : null
      }
    },
    get lastConfigMode () { return lastInterceptor?.replayMode ?? 'pending' },
    close () {
      if (closePromise) return closePromise
      closePromise = new Promise(resolve => {
        const current = server
        for (const timer of preAuthTimers.values()) clearTimeout(timer)
        preAuthTimers.clear()
        if (!current) { resolve(); return }
        for (const client of Object.values(current.clients ?? {})) {
          try { client.socket?.destroy() } catch { /* already gone */ }
        }
        const socketServer = current.socketServer
        if (!socketServer) { server = null; resolve(); return }
        try {
          socketServer.closeAllConnections?.()
          socketServer.close(() => { server = null; resolve() })
        } catch {
          server = null
          resolve()
        }
      })
      return closePromise
    }
  }
}

// #618: the textures property on the profile an account's hasJoined answered with,
// as a client's own skin. The front verifies a client against Mojang, and the body
// Mojang hands back for a verified session is where that account's skin already is:
// this leg holds no skin of its own and invents none, so a profile with no property
// is a spectator this lane has no skin for.
//
// A lane with no sessionserver supplies the properties itself (the offline leg's
// `profiles` option), and the read is the same one either way. Measured: whether the
// body a deployed front is handed carries textures at all is in testdata/skin-verdict.md.
export function profileTextures (profile) {
  return pickTextures(profile?.properties)
}

export function createLiveFrontLeg (options = {}) {
  const {
    host = '127.0.0.1',
    port = 25565,
    version = '26.1',
    attachWhitelistFile,
    // #229: the control document's store. One instance for the process, so this
    // leg's whitelist check and the core's gate read the same file at each
    // login. Null keeps the one startup read every other lane has always done.
    whitelistStore = null,
    getSnapshotConfig,
    // #257: the picker's configuration baseline and its allowed list. Neither is
    // defaulted here: a lane that sets no baseline keeps refusing a join that has
    // no backend, exactly as before. #266: `onPickerVerb` reports the answer to a
    // chosen server's own dialog.
    configurationBaseline = null,
    pickerServers = null,
    onPickerPick = null,
    onPickerVerb = null,
    // #201: the total connection cap on the pre-auth window.
    preAuth = {},
    log = () => {},
    wireCheck = null,
    wireMode = 'off',
    chat = 'read-only',
    dumpRaw = null,
    dumpFramed = null
  } = options

  if (options.offlineWhitelist !== undefined) {
    throw new TypeError('createLiveFrontLeg does not accept offlineWhitelist; use createOfflineFrontLeg')
  }
  if (options.profiles !== undefined) {
    throw new TypeError('createLiveFrontLeg does not accept profiles; its sessionserver answers with the account')
  }
  if (!attachWhitelistFile) throw new TypeError('attachWhitelistFile is required')
  if (whitelistStore !== null && typeof whitelistStore.has !== 'function') {
    throw new TypeError('whitelistStore must expose has(uuid)')
  }
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')

  return createFrontLeg({
    kind: 'live-front-leg',
    onlineMode: true,
    verifier: 'online-mode_hasjoined',
    host,
    port,
    version,
    check: createAttachCheck({ log: () => {} }),
    store: whitelistStore ?? createWhitelistStore({ file: attachWhitelistFile }),
    getSnapshotConfig,
    configurationBaseline,
    pickerServers,
    onPickerPick,
    onPickerVerb,
    preAuth,
    log,
    wireCheck,
    wireMode,
    chat,
    dumpRaw,
    dumpFramed
  })
}

export function createOfflineFrontLeg (options = {}) {
  const {
    host = '127.0.0.1',
    port = 0,
    version = '26.1',
    offlineWhitelist = null,
    // #618: what the sessionserver would have answered this name with, so a lane with
    // no Mojang in front of it can hand a client its own account's skin. The UUID and
    // the name stay the offline identity's, because those are what an offline lane has.
    profiles = null,
    // #229: the same store option the live leg takes. A store wins over the
    // array, because it is the file that reloads at each login.
    whitelistStore = null,
    getSnapshotConfig,
    // #257: the picker's configuration baseline and its allowed list, forwarded
    // like every other option so the offline rig proves the same code the lane
    // runs. #266: `onPickerVerb` is forwarded with them.
    configurationBaseline = null,
    pickerServers = null,
    onPickerPick = null,
    onPickerVerb = null,
    // #201: the total connection cap on the pre-auth window.
    preAuth = {},
    log = () => {},
    wireCheck = null,
    wireMode = 'throw',
    chat = 'read-only',
    dumpRaw = null,
    dumpFramed = null,
    // #391: the same fence-lift the offline backend leg takes, for the same
    // reason. A deployed test lane binds a pod address, and only the composition
    // root lifts it (docs/adr/the-product-may-be-a-test-double.md).
    allowNonLoopback = false
  } = options

  if (options.attachWhitelistFile !== undefined) {
    throw new TypeError('createOfflineFrontLeg does not accept attachWhitelistFile; use createLiveFrontLeg')
  }
  // A truthy string would lift the fence as surely as true, so the option is a
  // boolean or it is refused.
  if (typeof allowNonLoopback !== 'boolean') {
    throw new TypeError('allowNonLoopback must be a boolean')
  }
  if (!allowNonLoopback && !isLoopbackHost(host)) {
    throw new TypeError(`offline front leg host must be 127.0.0.1 or ::1, got ${JSON.stringify(host)}`)
  }
  if (whitelistStore !== null && typeof whitelistStore.has !== 'function') {
    throw new TypeError('whitelistStore must expose has(uuid)')
  }
  if (whitelistStore === null && (!Array.isArray(offlineWhitelist) || offlineWhitelist.length === 0)) {
    throw new TypeError('offlineWhitelist must be a non-empty array of UUID strings')
  }

  const whitelist = []
  for (const entry of offlineWhitelist ?? []) {
    if (typeof entry !== 'string') {
      throw new TypeError('offlineWhitelist entries must be UUID strings')
    }
    const uuid = normalizeUuid(entry)
    if (!uuid) {
      throw new TypeError(`offlineWhitelist entry is not a UUID: ${JSON.stringify(entry)}`)
    }
    whitelist.push(uuid)
  }
  if (typeof getSnapshotConfig !== 'function') throw new TypeError('getSnapshotConfig is required')

  return createFrontLeg({
    kind: 'offline-front-leg',
    onlineMode: false,
    verifier: 'offline_uuid',
    host,
    port,
    version,
    profiles,
    check: createOfflineAttachCheck({ whitelist }),
    store: whitelistStore,
    getSnapshotConfig,
    configurationBaseline,
    pickerServers,
    onPickerPick,
    onPickerVerb,
    preAuth,
    log,
    wireCheck,
    wireMode,
    dumpRaw,
    dumpFramed
  })
}

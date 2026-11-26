// The loopback lane (#594): one factory builds the fake backend, the two real
// legs, the core between them, the clock that core runs on, the parts a lane is
// configured with, the bots that speak to it, and the close that ends all of them.
// An assertion that needs a lane of its own states the two or three things it
// changes; it stops knowing that a lane is a fake backend plus a front leg, a
// backend leg, a core, the registrations the core makes in its own start(), and
// one teardown line per object in each of three shapes.
//
// This is createRig with an owner (#223). A rig ends at "warm and listening" and
// closes the three sockets it opened; it holds no client, no temp resource, and
// no report of what it left behind. A lane adds the three things an assertion
// otherwise repeats by hand:
//
//   bot(options)   a real protocol client, closed by the lane, so the rung's
//                  teardown list stops growing one name per client. O55's picker
//                  assertions record their picks and verbs by hand today; they read
//                  `lane.picks` and `lane.verbs` instead once they convert.
//   close()        bots, then the core, then the rig, then the end of the socket
//                  the rig ended, then a dial at every port the lane held, then
//                  the timers. It reports what it closed,
//                  because "nothing is left" is a claim, not a comment: the ports
//                  are the kernel's answer, the client's end is the client's, and
//                  the timers are the lane's own clock.
//
// Every option createRig takes is here, forwarded as it stands, plus the parts a
// lane is configured with: a lane is a rig, and a conversion states the document
// and the overrides a rig site already states (#223 took those options first).
//
// Two of those parts carry the name the repo already uses for the same thing,
// where the ticket that proposed this factory wrote another. The ticket said
// `body` for the fake backend's options and `gate` for the wire checker. `body` is
// a session of the account on one game server (GLOSSARY.md) and `gate` is a
// configuration gate, a control dialog or a gate lane there; the fake backend and
// the wire check are the glossary's words, and createRig already names those two
// options `fake` and `wire`. So they are named that here, and this is the one
// place the ticket's signature is not followed verbatim.
//
// A whitelist array or a control document is required in practice: the front leg
// refuses to build with neither (src/legs/live-front.js:2529), so a lane that
// states neither throws there rather than starting a front that can let nobody in.
//
// A lane closes only what it opened. The journal, the control document and the
// picker reader are handed in and belong to the caller: a journal closed by one
// lane is a journal the next lane writes into and nobody reads
// (src/observability/journal.js drops a write after close without an error).
//
// No call-in is registered by hand here, and wireLegToCore is not called: the
// core applies its own tables in start() (#592, #605), so a lane inherits every
// row of FRONT_LEG_CALL_INS and BACKEND_LEG_CALL_INS
// (src/service/wire-leg-to-core.js) from the rig. A helper that registers one
// itself is a helper that has bypassed createRig.
import net from 'node:net'

import { createBot } from './bot.js'
import { createRig } from './rig.js'
import { loadConfig } from '../service/monoplayer.js'
import { offlineUuid } from '../legs/offline-identity.js'

const HOST = '127.0.0.1'
const PUPPET = 'GlowSquidye'
const PUPPET_UUID = offlineUuid(PUPPET)

// How long a close waits for the backend leg's socket to end. A close ends that
// socket with a call, and the event comes back from the kernel, so a turn of the
// event loop is a bet on having been read, not a wait for it. O68 reported the
// lane's own reconnect as left running at 893ecb3, on a public runner whose only
// difference from this machine was how late that read came back (#661). The bound
// is the bot's close (src/ladder/bot.js:238), and it is unref'd for the bot's
// reason: a wedged peer must not hold the rung, and a timer this file arms is not
// one the ledger can see.
const LEG_END_MS = 2000

// How many turns a close spends draining what a socket armed behind it. A turn is
// one 0 ms timer, so the whole drain costs microseconds and waits for nothing. A
// lane that arms a timer on every turn is reported in the last reading instead of
// kept spinning.
const DRAIN_TURNS = 8

// One turn of the event loop: enough for a handler the legs' close queued to run,
// and the unit the drain counts in.
const oneTurn = () => new Promise(resolve => setTimeout(resolve, 0))

// The clock a lane's core runs on, with a ledger beside it. rig.js states the
// same clock and every core call site passes two arguments (#223), so a wrapper
// that records the handle instead of returning it is a wrapper nothing can tell
// apart: the core stores what setTimeout returned, and hands the same value back
// to clearTimeout.
//
// The ledger is what makes "no live timer" measurable. The core arms three:
// a transfer-chain reset, a configuration deadline, and a reconnect backoff
// (src/service/monoplayer.js:1509, :1691, src/core/session.js:232). The
// reconnect one is armed while the lane is already closing: ending the backend
// leg is a fault, and a fault schedules a reconnect nobody will answer.
//
// Exported for the drain's own cases (test/ladder/loopback-lane.test.js): what a
// close does to a timer armed after its first reading is arithmetic over this
// ledger, and a socket-level case for it would cost the rung a fake backend, a
// client and a journal to answer a question about an object.
export function laneClock () {
  const armed = new Map()
  let next = 1
  const clearOne = id => {
    const entry = armed.get(id)
    if (entry === undefined) return
    armed.delete(id)
    clearTimeout(entry.handle)
  }
  return {
    clock: {
      now: Date.now,
      setTimeout (fn, ms) {
        const id = next++
        const handle = setTimeout(() => {
          armed.delete(id)
          fn()
        }, ms)
        armed.set(id, { ms, handle })
        return id
      },
      clearTimeout: clearOne
    },
    // Every timer still armed, oldest first. This is the reading a check takes.
    pending () {
      return [...armed.entries()].map(([id, entry]) => ({ id, ms: entry.ms }))
    },
    // Nothing will answer a timer a closing lane armed, so the lane ends it and
    // says how many it ended. A timer that fires into a closed core is a handle
    // the process keeps until it does.
    drop () {
      const dropped = [...armed.entries()].map(([id, entry]) => ({ id, ms: entry.ms }))
      for (const id of dropped) clearOne(id.id)
      return dropped
    }
  }
}

// A dial at a port the lane no longer holds. The refusal is the kernel's answer,
// not the lane's: a socket that is still listening accepts, and no bookkeeping in
// this file can pretend otherwise.
function dial (port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', error => resolve(error.code ?? 'error'))
  })
}

// The end of the socket a close ended, as a promise that always settles. The leg's
// own close() resolves without this event once the leg is ended
// (src/legs/live-backend.js:679), and the handler that arms the reconnect the
// record reports runs on it (src/legs/live-backend.js:502, then
// src/service/monoplayer.js:3093, then src/core/session.js:232). This is the wait
// the leg cannot make on the lane's behalf.
//
// Three answers, and the caller continues on all of them. 'none' is no socket left
// to end, which is a lane with no fake backend or one whose leg faulted earlier.
// 'end' is the socket's own end, and the arm that follows it has landed by then.
// 'bound' is a socket that never ended: the close still dials and still drains, so
// what a wedged socket leaves is a reading the drain could not outrun, never a throw.
//
// `ms` is the case's (test/ladder/loopback-lane.test.js), which shortens the bound
// rather than wait it out.
export function endOfLeg (leg, { ms = LEG_END_MS } = {}) {
  const client = leg?.client ?? null
  // The client's own flag: a socket whose 'end' has already fired has nothing left
  // to wait for, and a listener added now would wait for the bound instead.
  if (client === null || client.ended === true) return Promise.resolve('none')
  return new Promise(resolve => {
    const settle = answer => {
      clearTimeout(bound)
      client.removeListener('end', ended)
      resolve(answer)
    }
    const ended = () => settle('end')
    const bound = setTimeout(() => settle('bound'), ms)
    bound.unref?.()
    client.once('end', ended)
  })
}

// Drop what the ledger holds and read it again, a turn at a time, until a turn arms
// nothing or the bound runs out. The reading that comes back is the last one taken,
// so a timer a turn armed is dropped and counted, and a timer the bound catches is
// named in the record instead of dropped out of it. The assertion that reads it is
// only worth having while it can still be non-empty (#661).
//
// `turns` and `turn` are the case's (test/ladder/loopback-lane.test.js). One
// shortens the bound, and the other arms a timer between two passes, which is the
// ordering this exists to end and the one no test can reach from outside.
export async function drainTimers (ledger, { turns = DRAIN_TURNS, turn = oneTurn } = {}) {
  const dropped = []
  let reading = ledger.pending()
  for (let pass = 0; pass < turns && reading.length > 0; pass += 1) {
    dropped.push(...ledger.drop())
    await turn()
    reading = ledger.pending()
  }
  return { dropped, reading }
}

// #663: the one timer a lane's close is evidence for. Two can sit in the ledger
// when a close begins, and they are not the same claim. The transfer-chain reset
// is armed by every backend play login (src/service/monoplayer.js:3645) and
// cleared by the teardown on the backend leg's own end (:3268), so a close that
// drops it dropped a timer the close had already cancelled. The reconnect backoff
// is the one the close arms: ending the backend leg is a fault, and a fault arms a
// reconnect nobody will answer (src/core/session.js:232), at the first delay of its
// backoff. `ms` is the caller's: O68 reads it from the lane's own document
// (core.config.reconnect.delayMs), and the case in test/ladder/loopback-lane.test.js
// passes it a literal. A record that swept the chain timer alone therefore fails,
// rather than passing on the wrong evidence.
export function droppedReconnect (record, { ms } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return false
  return (record?.timersDropped ?? []).some(timer => timer.ms === ms)
}

export async function createLoopbackLane ({
  name,
  log = () => {},
  logs = [],
  version = null,
  // A document, or a function of { base }, exactly as createRig takes one. The
  // lane derives a plain loopback document from the parts below when this is
  // absent, and a caller that changes a key states the whole document, because a
  // key an assertion cannot read is a key it cannot assert on.
  config = null,
  // The fake backend behind the lane: createFakeBackend's options. `null` builds
  // none, which is a lane whose property is that nothing is dialled (O55).
  fake = {},
  // The front leg's offline whitelist, as an array. A lane that reads a file
  // passes `control` instead, and the file is what decides.
  whitelist = null,
  // The control document (src/service/control.js): its store is the front's
  // login gate and its reader is the core's, so an assertion that edits the file
  // mid-run states the document and nothing else.
  control = null,
  // The picker's server reader (createPickerServerReader). A lane that names one
  // offers a picker; the picks and verbs it serves are recorded on the lane.
  picker = null,
  // The journal this lane's core writes to. Borrowed: the caller created it and
  // the caller closes it.
  journal = null,
  // The wire check every frame passes (createWireChecker). A lane with one throws
  // on a rejected frame, which is what the rung's assertions read; a lane with none
  // inspects nothing.
  wire = null,
  front: frontOptions = {},
  backend: backendOptions = {},
  core: coreOptions = {},
  attach = null,
  reconnect = null,
  order = ['connect', 'ready', 'listen'],
  onStep = null
} = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('createLoopbackLane needs a name: the log tag its core writes')
  }
  if (config === null && typeof version !== 'string') {
    throw new TypeError('createLoopbackLane needs version, or the config document to derive it from')
  }

  // The document a lane runs on when the caller states no other. Everything the
  // live lane takes from a deployment this takes from the loopback: both ends on
  // 127.0.0.1, an ephemeral front port, and the fake backend's own port as the
  // dialled address.
  const document = config ?? (({ base }) => loadConfig({
    version,
    attachWhitelist: whitelist ?? [],
    front: { host: HOST, port: 0 },
    backend: { host: HOST, port: base.port },
    puppet: { username: PUPPET, uuid: PUPPET_UUID }
  }))

  const clock = laneClock()
  const picks = []
  const verbs = []
  // One entry per client this lane opened, with the name it joined as: the close
  // record names a client that did not end, and a bare "a bot" cannot be acted on.
  const clients = []

  const rig = await createRig({
    name,
    log,
    logs,
    config: document,
    fake,
    whitelist,
    wire,
    front: {
      ...(control === null ? {} : { whitelistStore: control.whitelistStore }),
      ...(picker === null
        ? {}
        : {
            pickerServers: picker,
            onPickerPick: pick => picks.push(pick),
            onPickerVerb: verb => verbs.push(verb)
          }),
      ...frontOptions
    },
    backend: backendOptions,
    core: {
      clock: clock.clock,
      ...(journal === null ? {} : { journal }),
      ...(control === null ? {} : { whitelistSource: control.attachWhitelist }),
      ...coreOptions
    },
    attach,
    reconnect,
    order,
    onStep
  })

  // The ports this lane held, kept before the close: a port number is only
  // meaningful while it is the one a dial can be refused at.
  const ports = [
    { kind: 'front', port: rig.port },
    ...(rig.base === null || rig.base === undefined ? [] : [{ kind: 'fake', port: rig.base.port }])
  ]

  let closed = null

  // The rig's own keys first, and by spread: a conversion that moves a rig onto
  // this factory deletes its alias block and changes no assertion body, because
  // `base`, `front`, `backend`, `core`, `port`, `readiness` and `events` are
  // here under the names the rung already reads (#594).
  const lane = {
    ...rig,
    name,
    picks,
    verbs,

    // A protocol client at this lane's front, closed by the lane's own close.
    bot (options = {}) {
      const client = createBot({ port: rig.port, ...options })
      clients.push({ username: options.username ?? null, client })
      return client
    },

    close () {
      if (closed !== null) return closed
      closed = (async () => {
        const record = {
          closed: true,
          bots: [],
          timersDropped: [],
          timersLeft: [],
          sockets: []
        }
        for (const { username, client } of clients) {
          try { await client.close() } catch { /* best effort */ }
          record.bots.push({ username, ended: client.received.ended !== null })
        }
        // The core before the legs, which is the live lane's order
        // (src/service/start-live.js:1197): the stop is what detaches the client
        // and ends the backend leg, so the legs close behind a core that has
        // already said what it was doing.
        //
        // The socket is taken before the stop, because the stop is what ends it:
        // ending the backend leg is a backend fault, and a fault arms a retry
        // nobody will answer (src/core/session.js:232). Reading the ledger before
        // that arm has landed would report no leftover and leave one, and the arm
        // sits behind the socket's own end, which comes back from the kernel. A
        // turn of the event loop is not enough to know it has landed: that is the
        // reading O68 got wrong at 893ecb3 (#661).
        const ending = endOfLeg(rig.backend)
        try { await rig.core.stop({ reason: 'lane_close' }) } catch { /* best effort */ }
        await rig.close()
        await ending
        for (const entry of ports) {
          record.sockets.push({ ...entry, code: await dial(entry.port) })
        }
        // Then the timers, drained rather than read once: the dials are turns of
        // their own, and a timer armed in them is a timer this lane left running
        // only if nothing ever drops it. A timer the drain cannot outrun is in
        // timersLeft, which is the reading O68 fails on.
        const drained = await drainTimers(clock)
        record.timersDropped = drained.dropped
        record.timersLeft = drained.reading
        return record
      })()
      return closed
    }
  }

  return lane
}

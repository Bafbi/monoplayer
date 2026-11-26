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
//   close()        bots, then the core, then the rig, then the timers, then a
//                  dial at every port the lane held. It reports what it closed,
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
// core applies its own table in start() (#592), so a lane inherits every row of
// LEG_CALL_INS (src/service/wire-leg-to-core.js) from the rig. A helper that
// registers one itself is a helper that has bypassed createRig.
import net from 'node:net'

import { createBot } from './bot.js'
import { createRig } from './rig.js'
import { loadConfig } from '../service/monoplayer.js'
import { offlineUuid } from '../legs/offline-identity.js'

const HOST = '127.0.0.1'
const PUPPET = 'GlowSquidye'
const PUPPET_UUID = offlineUuid(PUPPET)

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
// leg is a fault, and a fault schedules a retry nobody will answer.
function laneClock () {
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
        try { await rig.core.stop({ reason: 'lane_close' }) } catch { /* best effort */ }
        await rig.close()
        // One turn, so an end handler the legs' close queued has run: ending the
        // backend leg is a backend fault, and a fault arms a retry nobody will
        // answer (src/core/session.js:232). Reading the ledger before it is armed
        // would report no leftover and leave one.
        await new Promise(resolve => setTimeout(resolve, 0))
        record.timersDropped = clock.drop()
        for (const entry of ports) {
          record.sockets.push({ ...entry, code: await dial(entry.port) })
        }
        // The last reading, taken after everything above: a timer armed while the
        // ports were being dialled is still a timer this lane left running.
        record.timersLeft = clock.pending()
        return record
      })()
      return closed
    }
  }

  return lane
}

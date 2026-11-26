// #223: one factory builds a loopback rig. A rig is the fake backend a rung
// dials, the two real legs, the core between them, the clock that core runs on,
// and the registrations that hand the front leg's login decisions to it. A check
// sends what its assertion needs; the rig supplies the rest.
//
// Seven rigs copied this by hand and drifted: one clock literal bound its timer
// functions bare and six wrapped them, and the main and entity rigs both logged
// their core as `core`, a tag nothing read. `events` reads every line this rig
// wrote, so a caller names its own stream instead of passing a second argument.
// Two rigs that share a tag are still two streams of entries, and `events` cannot
// tell them apart: give a rig whose lines are read a tag of its own.
//
// A caller states the one thing it changes and inherits the rest, which is the
// contract test/support/harness.js:makeCore states for the fake legs (#104).
// Every hook is called with one object, and the rig is `rig` in it.
//
// A rig that has no core is not a rig this builds: the two pre-auth rigs (O48,
// O49) want a front leg that answers every login with a literal, and the body
// cache rig (O60) wants two backend legs and no client. They keep their own
// wiring, because a core in the middle is what this factory is.
import { createFakeBackend } from '../legs/fake-backend.js'
import { createOfflineBackendLeg } from '../legs/live-backend.js'
import { createOfflineFrontLeg } from '../legs/live-front.js'
import { createMonoplayer } from '../service/monoplayer.js'
import { waitForReady } from '../service/readiness.js'

// The clock a rig's core runs on: one literal for every rig. The seven copies
// this replaced had already drifted, the picker's binding the timer functions
// bare, and the two forms are one clock only while no core call site reads
// `this` or passes a third argument. Every one passes two: src/core/session.js:199,
// :231, :232, :325, and src/service/monoplayer.js:1419, :1601, :2120.
function rigClock () {
  return {
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout
  }
}

// One rig, wired, dialled, warm and listening.
//
// `name` is the log tag this rig's core writes, and the tag `events` reads.
// `logs` is the array behind `log`, because a rig's own lines are read hardest
// by the assertion that built it.
//
// `front` and `backend` options override what this function derives, and they
// are spread last on purpose: the picker rig records every wire check, so its own
// `wireCheck` wins over the one a `wire` argument would build.
//
// The steps are the ones a rig needs, in the order it passes them:
//   connect  dial the backend leg
//   ready    wait for the warm marker, then hold it in `rig.readiness`
//   listen   bind the front leg, then hold the port in `rig.port`
// A rig that dials nothing states `['listen']`: the picker rig's whole property
// is a lane with no body behind the dialog (O55), and a property that lives in a
// missing line is one a refactor deletes without noticing.
export async function createRig ({
  name,
  log = () => {},
  logs = [],
  config,
  fake = {},
  whitelist = null,
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
    throw new TypeError('createRig needs a name: the log tag its core writes')
  }
  if (config === undefined || config === null) {
    throw new TypeError('createRig needs a config: the resolved document')
  }
  if (typeof config !== 'function' && typeof config !== 'object') {
    throw new TypeError('createRig config must be a document or a function of { base }')
  }

  // The fake the backend leg dials. `null` builds none, and the call supplies the
  // address, which is how the picker rig reaches a port nothing listens on.
  const base = fake === null ? null : await createFakeBackend({ port: 0, logStream: null, ...fake })
  const document = typeof config === 'function' ? config({ base }) : config

  // Assigned before the front is used, never before it is built: the snapshot
  // getter and the gate policy both close over the core created below. Neither
  // can run earlier, because a front leg answers no login before it listens.
  let core = null
  const front = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: document.version,
    ...(whitelist === null ? {} : { offlineWhitelist: whitelist }),
    getSnapshotConfig: () => core.cache.snapshot().config,
    // A checker, or the mode that needs none: the leg refuses 'throw' without
    // one, and a rig that checks nothing should say so.
    ...(wire === null
      ? { wireMode: 'off' }
      : { wireCheck: payload => wire.check(payload), wireMode: 'throw' }),
    log,
    ...frontOptions
  })
  const backend = createOfflineBackendLeg({
    host: '127.0.0.1',
    port: base === null ? undefined : base.port,
    version: document.version,
    username: 'GlowSquidye',
    // A gate is the human's while they are attached, and the puppet's own accept
    // is reported to the core so nothing waits for a client (#21). Every rig gets
    // this pair; the two rigs added to it in #223 (the attach record and the
    // control document) run fakes that send no dialog, so neither consults it.
    isHumanAttached: () => core?.attached === true,
    onDialogAnswered: ({ state }) => core?.notePuppetDialogAnswer({ state }),
    log,
    ...backendOptions
  })
  core = createMonoplayer({
    config: document,
    backendLeg: backend,
    frontLeg: front,
    clock: rigClock(),
    logStream: { write: line => log(name, { line }) },
    ...coreOptions
  })

  // #592: start() wires the attach and configuration call-ins, so a rig registers
  // nothing by hand except the one thing its call supplies. `attach` wraps the
  // core's own attach call-in, and it is registered after start() because start()
  // is what sets the default it wraps. The hook a call supplies carries the record
  // its assertion reads and returns the attach outcome, so a rig that names no
  // `attach` gets the plain call-in.
  core.start()
  if (attach !== null) front.setCoreAttach(player => attach({ rig, player }))

  // Registered after start(), as every rig did before this factory: start() emits
  // only 'start', so a due reconnect comes from a later fault, never from start.
  if (reconnect !== null) core.on('reconnect_due', event => reconnect({ ...event, rig }))

  const events = (from = 0) => logs.slice(from)
    .filter(entry => entry.event === name)
    .map(entry => {
      try { return JSON.parse(entry.fields?.line ?? '') } catch { return null }
    })
    .filter(entry => entry !== null)

  const close = async () => {
    try { await front.close() } catch { /* best effort */ }
    try { await backend.close() } catch { /* best effort */ }
    if (base !== null) {
      try { await base.close() } catch { /* best effort */ }
    }
  }

  const rig = { name, base, front, backend, core, port: null, readiness: null, events, close }

  for (const step of order) {
    if (onStep !== null) onStep({ step, rig })
    if (step === 'connect') {
      await backend.connect()
    } else if (step === 'ready') {
      rig.readiness = await waitForReady({ core, log, maxWarmMs: 5000, maxTotalMs: 15_000 })
    } else if (step === 'listen') {
      const bound = await front.listen()
      rig.port = bound.port ?? front.port
    } else {
      throw new TypeError(`createRig: unknown step ${JSON.stringify(step)}`)
    }
  }

  return rig
}

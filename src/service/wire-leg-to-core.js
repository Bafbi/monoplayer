// The core-to-leg wiring (#592, #605): the one home of what each leg interface
// carries.
//
// One table per interface, one row per call-in, each with the method it reaches
// and its payload shape. A row is either one the core registers on the leg
// (`kind: 'register'`, with the function it hands over), or one the core calls
// on a leg that carries it (`kind: 'call'`). Either kind is one the core cannot
// work without, or one it uses when the leg carries it.
//
// The lanes used to register the front ones by hand. The live lane and the rig
// copied all four (src/service/start-live.js, src/ladder/rig.js, where the
// loopback rungs reached it), and the parity lane copied three. The rest sat
// behind `typeof` guards in the core's own start(), and so did the backend
// leg's three registrations until #605. A lane that lacked one of the four got
// no error: src/legs/live-front.js answers every attach from its own default, so
// it would refuse every client and say nothing.
//
// The core applies both tables once, in its start(), so no lane can forget a
// call-in on the leg it hands the core, and the payload shapes live in one file. A
// lane that wires a leg it built for something else — src/ladder/loopback.js's two
// body legs (O59) — says so at the line. #607: a lane that wants a different
// registration wraps one call-in after start(), and calls the handler this file
// built, reported as `handlers`, so it writes no payload shape a second time.
// #683: no lane wraps one today, and the report site says what reads the handlers
// now.
//
// A leg that carries none of them is a leg with no core in front of it, which the
// two pre-auth rungs build on purpose. They never come here.
//
// The report is what a reader checks. `missing` names every declared call-in the
// leg does not carry, and `requiredMissing` names the subset the leg's own
// default hides. The core puts the missing names on its start line, one list per
// interface, and a test holds the real legs to an empty list. A missing one is not
// thrown on: src/legs/fake-legs.js carries neither setCoreAttach nor
// setCoreAttachConfiguring, and the tests that build a core on it attach through
// the core instead.
// test/service/wire-leg-to-core.test.js reads the report, and
// test/legs/adapters.test.js holds the real legs to these tables, `reaches` and
// all.
// A row is frozen too, so a reader cannot rewrite a payload shape at run time: the
// shape is the fact this file is the home of.
export const FRONT_LEG_CALL_INS = Object.freeze([
  // The rows a leg cannot serve a client without. Each has a default inside the
  // leg, so an absent one is silent rather than fatal: the leg refuses the attach
  // and records a reason the lane never reads.
  {
    kind: 'register',
    name: 'setCoreAttach',
    required: true,
    reaches: 'attachPlayer',
    // The leg calls this at the client's play login. includeConfig is false
    // because a lane's attach never re-sends the configuration phase: the client
    // has already been sent it, and a second copy ends its connection.
    handler: core => ({ name, uuid } = {}) => core.attachPlayer({ name, uuid, includeConfig: false })
  },
  {
    kind: 'register',
    name: 'setCoreAttachConfiguring',
    required: true,
    reaches: 'attachConfiguringPlayer',
    // #16: the client reached its login while the puppet was still configuring,
    // so the attach happens before the configuration phase is cached.
    handler: core => ({ name, uuid } = {}) => core.attachConfiguringPlayer({ name, uuid })
  },
  {
    kind: 'register',
    name: 'setConfiguringHandler',
    required: true,
    reaches: 'configuringReady',
    // #16: the client entered its own configuration phase, which is the one
    // moment a configuration gate the backend asked can reach it.
    handler: core => ({ name } = {}) => core.configuringReady({ name })
  },
  {
    kind: 'register',
    name: 'setClientSettingsHandler',
    required: true,
    reaches: 'noteClientSettings',
    // #18: the human's client information is the source of the fields the server
    // sees, and the core merges it with the backend's view distance cap.
    handler: core => settings => core.noteClientSettings(settings)
  },

  // The session pipeline (#605), which start() registered by hand until the
  // table owned it. A leg without these serves no client either: no login is
  // reviewed, no frame the client sends reaches the backend, and a client that
  // leaves is never noticed.
  {
    kind: 'register',
    name: 'setLoginStartHandler',
    required: true,
    reaches: 'processLoginStart',
    // The core decides and the leg acts: the core cannot send Login Success, so
    // a denial returns to the adapter before any Login Success packet.
    handler: core => payload => core.processLoginStart(payload)
  },
  {
    kind: 'register',
    name: 'setServerboundHandler',
    required: true,
    reaches: 'frontServerbound',
    // The client's own frames, in the state they were sent in: the chat speech,
    // the client information rewrite, the configuration answers, and the relay
    // into the backend.
    handler: core => payload => core.frontServerbound(payload)
  },
  {
    kind: 'register',
    name: 'setDetachHandler',
    required: true,
    reaches: 'detachPlayer',
    // A client going away. The reason is the leg's to name, and player_quit is
    // the one it names when it names none.
    handler: core => ({ reason = 'player_quit' } = {}) => core.detachPlayer({ reason })
  },

  // The rows a lane uses when its leg carries them. A leg without one keeps its
  // own fallback, and the core counts the difference.
  {
    kind: 'register',
    name: 'setReconfiguredHandler',
    required: false,
    reaches: 'frontReconfigured',
    // #22: the client answered the reconfiguration's finish frame and is in play
    // again on its own connection.
    handler: core => ({ name = null, uuid = null } = {}) => core.frontReconfigured({ name, uuid })
  },
  {
    kind: 'register',
    name: 'setConnectClaimedBody',
    required: false,
    reaches: 'connectClaimedBody',
    // #258: a granted claim is what dials a body, so the front asks the core for
    // one and the core owns the dial and the warm wait.
    handler: core => payload => core.connectClaimedBody(payload)
  },
  {
    kind: 'register',
    name: 'setSpectateBody',
    required: false,
    reaches: 'spectateBody',
    // #269: whether a row names the body this session serves.
    handler: core => payload => core.spectateBody(payload)
  },
  {
    kind: 'register',
    name: 'setSpectatorAttach',
    required: false,
    reaches: 'spectateView',
    // #269: replay that body to the one channel that asked.
    handler: core => payload => core.spectateView(payload)
  },
  {
    kind: 'register',
    name: 'setDisconnectBody',
    required: false,
    reaches: 'disconnectBody',
    // #261: the picker's Disconnect verb. The core ends the session, and a lane
    // with no core records the click and ends no body.
    handler: core => payload => core.disconnectBody(payload)
  },
  {
    kind: 'register',
    name: 'setBodyServed',
    required: false,
    reaches: 'bodyServed',
    // #259: what a picker row says about a body. The leg's fallback is a null
    // reading, so a row written by a lane that never wired this says down.
    handler: core => () => core.bodyServed()
  },
  {
    kind: 'register',
    name: 'setSpectatorLeft',
    required: false,
    reaches: 'spectatorLeft',
    // #269: a spectator's channel ended, so the core can stop relaying a body
    // nobody is in play on.
    handler: core => payload => core.spectatorLeft(payload)
  },
  {
    kind: 'register',
    name: 'setSpectatorPose',
    required: false,
    reaches: 'spectatorPose',
    // #636: where a spectator's own client says it is. The frame itself is dropped, as
    // #269 drops every spectator frame: this carries a pose and nothing else, so nothing a
    // spectator sends can reach the backend. The core draws it for the body's other
    // channels, which is the only thing it is for.
    handler: core => payload => core.spectatorPose(payload)
  },

  // #627: a read the core makes on this leg, in the backend table's form. The
  // pre-auth window is created inside the leg, so `laneState` asks for its numbers
  // rather than a copy. A leg without this row is named in `missing`, and its
  // snapshot reports `preAuth` as null.
  {
    kind: 'call',
    name: 'preAuthStats',
    required: false
  }
].map(Object.freeze))

// The backend leg's interface (#605). It was the copy start() registered by hand
// beside the front's table, which is the same defect one leg further along: two
// homes for one shape of fact, and a hand-built leg learned which call-ins exist
// from the core's body.
export const BACKEND_LEG_CALL_INS = Object.freeze([
  // The session's inbound pipeline. A leg that cannot deliver a frame serves no
  // client: every cached frame and every live relay arrives through this one.
  {
    kind: 'register',
    name: 'setFrameHandler',
    required: true,
    reaches: 'backendFrame',
    handler: core => frame => core.backendFrame(frame)
  },
  {
    kind: 'register',
    name: 'setEndHandler',
    required: true,
    reaches: 'backendEnd',
    // #22: the session ended, one way or another. A leg that keeps that to itself
    // leaves the core attached to a session that is gone.
    handler: core => ({ reason = 'backend_end' } = {}) => core.backendEnd({ reason })
  },
  {
    kind: 'register',
    name: 'setErrorHandler',
    required: false,
    reaches: 'backendError',
    // The leg's own socket errors, which the core records and nothing else. A leg
    // that reports none still serves every client; what is lost is the log line.
    handler: core => ({ error } = {}) => core.backendError({ error })
  },

  // The calls the core makes on the leg, so a leg that does not carry one is named
  // in the same report as a missing registration.
  {
    kind: 'call',
    name: 'answerHeldGate',
    required: false,
    // #73: answerHeldGateOnDetach asks the leg for the answer a configuration gate
    // its last client left would have had from a headless session; without this the
    // gate stays held and the core logs leg_cannot_answer.
  },
  {
    kind: 'call',
    name: 'chat',
    required: false,
    // #19: frontServerbound has this leg speak the human's text as the puppet,
    // because the signature needs the puppet's profile keys. Without it the core
    // drops the text as leg_has_no_chat and counts it.
  }
].map(Object.freeze))

// Hand every declared registration to the leg that carries it, measure every call
// it answers, and report the rows it lacks either way. The core is required: every
// handler reaches a method of it, and a table applied to the wrong object would
// register every call-in against nothing. The table is required too, so a leg is
// never measured against the other interface's rows.
//
// #607: the report carries every registration's handler, so a caller that wraps one
// after start() calls the handler the leg was handed and adds its record around it,
// rather than writing the payload a second time. The core puts the whole report on
// `legWiring`, one per interface, which is where a caller reads it from.
//
// #683: no lane wraps one today. The two that did took the attach cut, and the core
// publishes that cut itself now, so `handlers` is what each leg was handed, read by
// the tests that hold the wiring to it (test/service/wire-leg-to-core.test.js) and by
// no lane.
export function wireLegToCore ({ core, leg, table } = {}) {
  if (core === null || typeof core !== 'object') {
    throw new TypeError('wireLegToCore needs the core its call-ins reach: wireLegToCore({ core, leg, table })')
  }
  if (!Array.isArray(table)) {
    throw new TypeError('wireLegToCore needs the table of the interface it wires: FRONT_LEG_CALL_INS or BACKEND_LEG_CALL_INS')
  }
  const wired = []
  const called = []
  const missing = []
  const requiredMissing = []
  const handlers = {}
  for (const entry of table) {
    const method = leg === null || leg === undefined ? undefined : leg[entry.name]
    if (typeof method !== 'function') {
      missing.push(entry.name)
      if (entry.required === true) requiredMissing.push(entry.name)
      continue
    }
    // A call-in the core calls needs nothing registered; its presence is the whole
    // contract, and the report is where a reader learns it.
    if (entry.kind === 'call') {
      called.push(entry.name)
      continue
    }
    // #607: the handler is built once, here, and reported, so a caller that wraps
    // this row after start() calls the function the leg was handed rather than
    // writing the payload a second time. A row this leg does not carry has no
    // handler: nothing installed it, and `wired` says so.
    handlers[entry.name] = entry.handler(core)
    method.call(leg, handlers[entry.name])
    wired.push(entry.name)
  }
  // #607: the handlers ride the report so a caller reaches one off the started core
  // without importing a table. The object is frozen for the reason the rows are: a
  // handler a reader can replace at run time is a payload shape with two authors.
  return { wired, called, missing, requiredMissing, handlers: Object.freeze(handlers) }
}

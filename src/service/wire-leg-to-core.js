// The core-to-leg wiring (#592, #605, #726): the one home of what each leg
// interface carries.
//
// One table per interface, one row per member: a call-in the core registers on the
// leg (`kind: 'register'`, with the method it reaches and the function it hands
// over), or a member the core calls on the leg itself (`kind: 'call'`: the delivery
// a frame goes through, the dial a body opens with, and the reads the core makes).
// What a leg without a row costs is in the comment above it, or above the block it sits in.
// A leg keeps a default behind every call-in, and the rows a client cannot be served
// without answer a refusal: the leg takes every client and serves none of them, without
// saying so.
//
// A row names a member and states no shape. What the core hands over belongs to the
// call site in src/service/monoplayer.js, and what it reads back belongs where the
// read is (test/legs/adapters.test.js). What a row cannot state at all — which channel
// a write reaches, what the claim board is, that end() returns while close() resolves —
// is the page's: "Interface for the live legs" in docs/product-core.md.
//
// A `call` row carries the call's name and no answer shape, and #672 decided that on
// purpose. A list of names here would be a second home, and a row cannot say which of
// its answer's fields the core reads. `wireLegToCore` may not call a leg to find out
// either, because `answerHeldGate` and `chat` are calls with effects. So the fields live
// where the read is: test/legs/adapters.test.js holds every answering leg to the fields
// the core reads off its answer, and `preAuthStats` — the one answer a lane snapshot
// publishes whole (#627) — to `createPreAuthWindow().stats()` in
// src/core/preauth-window.js.
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
// call-in on the leg it hands the core, and the payload shapes live in one file.
//
// #824: a leg's call-in holds one handler, and the second registration is refused
// (src/legs/call-in-handler.js). Three registrations can reach one call-in, and this is
// what each one gets:
//   1. the core's, made by these tables in start(). It is the only registration a leg
//      handed to a core needs.
//   2. a lane's, made before that start(). The core's registration is then the second one,
//      so start() refuses it and the run fails on the call-in's name. This is the case
//      nobody could see. A report measures the leg's shape at the call, so a name present
//      was a name carried whether or not the handler there was the core's. The lane read
//      `missing: []` while its own handler ran nothing.
//   3. a lane's, made after that start(). It refuses at the lane's line, so the report
//      keeps meaning what it says: the handler behind a carried name is the core's.
//
// A lane that wires a leg it built for something else — src/ladder/loopback.js's two body
// legs (O59), and #666's raw funnel — registers on a leg no core is handed. That
// registration is the only one the call-in ever takes. A lane with a core registers
// nothing there: the same setter would refuse it, and the run would say so.
//
// The report carries no handler: #607 published them for a lane that wrapped a call-in
// after start(), #683 deleted the last such lane, #718 removed the field, and #824 is why
// a replacement after start() is refused rather than performed.
//
// A leg that carries none of them is a leg with no core in front of it, which the
// two pre-auth rungs build on purpose. They never come here.
//
// The report is what a reader checks: two lists of names, and the reader of each one
// is named here. `missing` names every declared call-in the leg does not carry,
// and the core puts those names on its start line, one list per interface.
// `called` names every row the core calls on the leg rather than registers: the
// delivery, the dial and the reads alike. The backend's two optional calls are read from
// that list rather than a `typeof` guard in the core's body (backendCarries,
// src/service/monoplayer.js); the front's three are still tested by `typeof` where they
// are used, so for those the row's work is the name on the report.
// #757: `wired` and `requiredMissing` are gone, each for the reason #718 removed
// `handlers`: no module read them, and a field whose only reader is a test describes a
// caller the tests build for themselves. `wired` named the rows the leg installed, which
// is the table minus `called` minus `missing`, so it carried no fact of its own; what a
// reader asked it — that every row reached the leg — is a claim about the table, and
// test/service/wire-leg-to-core.test.js makes it where it builds a leg row by row.
// `requiredMissing` named the subset of the holes the leg's own default hides, and the
// `required` flag on each row had no reader but it. The flag went with it: the comments
// above the rows already say what a leg without one costs.
//
// The two fields that remain are read in src/service/monoplayer.js, and the case
// "#757 every field of the report has a production reader" holds this list to them.
// A missing row is not thrown on: src/legs/fake-legs.js carries neither setCoreAttach
// nor setCoreAttachConfiguring, and the tests that build a core on it attach through
// the core instead.
// test/service/wire-leg-to-core.test.js reads the report, and
// test/legs/adapters.test.js holds the real legs to these tables, `reaches` and
// all, plus the members a table cannot name: #672 walks each leg's whole call surface,
// and every member outside these rows is declared there with the reason it is outside.
// A row is frozen too, so a reader cannot rewrite a payload shape at run time: the
// shape is the fact this file is the home of.
export const FRONT_LEG_CALL_INS = Object.freeze([
  // The rows a leg cannot serve a client without. Each has a default inside the
  // leg, so an absent one is silent rather than fatal: the leg refuses the attach
  // and records a reason the lane never reads.
  {
    kind: 'register',
    name: 'setCoreAttach',
    reaches: 'attachPlayer',
    // The leg calls this at the client's play login. includeConfig is false
    // because a lane's attach never re-sends the configuration phase: the client
    // has already been sent it, and a second copy ends its connection.
    handler: core => ({ name, uuid } = {}) => core.attachPlayer({ name, uuid, includeConfig: false })
  },
  {
    kind: 'register',
    name: 'setCoreAttachConfiguring',
    reaches: 'attachConfiguringPlayer',
    // #16: the client reached its login while the puppet was still configuring,
    // so the attach happens before the configuration phase is cached.
    handler: core => ({ name, uuid } = {}) => core.attachConfiguringPlayer({ name, uuid })
  },
  {
    kind: 'register',
    name: 'setConfiguringHandler',
    reaches: 'configuringReady',
    // #16: the client entered its own configuration phase, which is the one
    // moment a configuration gate the backend asked can reach it.
    handler: core => ({ name } = {}) => core.configuringReady({ name })
  },
  {
    kind: 'register',
    name: 'setClientSettingsHandler',
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
    reaches: 'processLoginStart',
    // The core decides and the leg acts: the core cannot send Login Success, so
    // a denial returns to the adapter before any Login Success packet.
    handler: core => payload => core.processLoginStart(payload)
  },
  {
    kind: 'register',
    name: 'setServerboundHandler',
    reaches: 'frontServerbound',
    // The client's own frames, in the state they were sent in: the chat speech,
    // the client information rewrite, the configuration answers, and the relay
    // into the backend.
    handler: core => payload => core.frontServerbound(payload)
  },
  {
    kind: 'register',
    name: 'setDetachHandler',
    reaches: 'detachPlayer',
    // A client going away. The reason is the leg's to name, and player_quit is
    // the one it names when it names none.
    handler: core => ({ reason = 'player_quit' } = {}) => core.detachPlayer({ reason })
  },

  // The delivery half (#726): the methods the core calls on the leg rather than
  // registering through it. No leg default stands behind one of these, so a leg that
  // omits one throws on the member the next time the core sends a frame, which is why
  // each of the three is required. The shape of a call is its call site's, and the rule
  // a shape cannot state — which channel a write reaches — is the page's.
  {
    // #269: clientbound delivery at packet level. A leg that cannot send one serves a
    // client nothing. Which channels a write reaches, and what a caller reads off its
    // answer, are the page's rule and the answer's own declaration, not a row's.
    kind: 'call',
    name: 'write',
  },
  {
    // The frame-level half of the same delivery: a cached or relayed frame, sent as the
    // bytes that arrived rather than re-encoded.
    kind: 'call',
    name: 'writeRaw',
  },
  {
    // How the core ends every channel of the body: a denial, a kick, or a body that went
    // away. Without it a refusal reaches no client, and the session it refused stays.
    kind: 'call',
    name: 'end',
  },

  // The rows a lane uses when its leg carries them. A leg without one keeps its
  // own fallback, and the core counts the difference.
  {
    kind: 'register',
    name: 'setReconfiguredHandler',
    reaches: 'frontReconfigured',
    // #22: the client answered the reconfiguration's finish frame and is in play
    // again on its own connection.
    handler: core => ({ name = null, uuid = null } = {}) => core.frontReconfigured({ name, uuid })
  },
  {
    kind: 'register',
    name: 'setConnectClaimedBody',
    reaches: 'connectClaimedBody',
    // #258: a granted claim is what dials a body, so the front asks the core for
    // one and the core owns the dial and the warm wait.
    handler: core => payload => core.connectClaimedBody(payload)
  },
  {
    kind: 'register',
    name: 'setSpectateBody',
    reaches: 'spectateBody',
    // #269: whether a row names the body this session serves.
    handler: core => payload => core.spectateBody(payload)
  },
  {
    kind: 'register',
    name: 'setSpectatorAttach',
    reaches: 'spectateView',
    // #269: replay that body to the one channel that asked.
    handler: core => payload => core.spectateView(payload)
  },
  {
    kind: 'register',
    name: 'setDisconnectBody',
    reaches: 'disconnectBody',
    // #261: the picker's Disconnect verb. The core ends the session, and a lane
    // with no core records the click and ends no body.
    handler: core => payload => core.disconnectBody(payload)
  },
  {
    kind: 'register',
    name: 'setBodyServed',
    reaches: 'bodyServed',
    // #259: what a picker row says about a body. The leg's fallback is a null
    // reading, so a row written by a lane that never wired this says down.
    handler: core => () => core.bodyServed()
  },
  {
    kind: 'register',
    name: 'setSpectatorLeft',
    reaches: 'spectatorLeft',
    // #269: a spectator's channel ended, so the core can stop relaying a body
    // nobody is in play on.
    handler: core => payload => core.spectatorLeft(payload)
  },
  {
    kind: 'register',
    name: 'setSpectatorPose',
    reaches: 'spectatorPose',
    // #636: where a spectator's own client says it is. The frame itself is dropped, as
    // #269 drops every spectator frame: this carries a pose and nothing else, so nothing a
    // spectator sends can reach the backend. The core draws it for the body's other
    // channels, which is the only thing it is for.
    handler: core => payload => core.spectatorPose(payload)
  },

  // The calls the core makes on this leg when it carries one (#726). Each is a member
  // the core reads the presence of rather than a registration, and a leg without one
  // keeps a fallback the core's own code names.
  {
    // #261, #631: the claim on one body, or null. The leg owns the claims, so the
    // snapshot passes the record on whole instead of keeping a copy, and the session's
    // oracle answers a body with no claim as held. A leg without it refuses every claim
    // and says nothing.
    kind: 'call',
    name: 'claimOn',
  },
  {
    // #22: ask the sampling client to re-enter configuration on its own connection, and
    // answer { started, reason }. A leg without it keeps the client in play and the move
    // rebuilds the world from the state replay instead of a loading screen.
    kind: 'call',
    name: 'startReconfiguration',
  },
  {
    // #87: the bytes that end a configuration round, for a restore that has no cached
    // finish. A leg without it falls back to the finish frame it cached.
    kind: 'call',
    name: 'finishConfigurationFrame',
  },

  // #627: a read the core makes on this leg, in the backend table's form. The
  // pre-auth window is created inside the leg, so `laneState` asks for its numbers
  // rather than a copy. A leg without this row is named in `missing`, and its
  // snapshot reports `preAuth` as null. The names it answers are the window's own
  // (`stats()`, src/core/preauth-window.js) and this row carries none of them, for the
  // reason the header gives: test/legs/adapters.test.js compares each answering leg to
  // that module, so a leg that leaves one name out fails a case rather than a snapshot.
  {
    kind: 'call',
    name: 'preAuthStats',
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
    reaches: 'backendFrame',
    handler: core => frame => core.backendFrame(frame)
  },
  {
    kind: 'register',
    name: 'setEndHandler',
    reaches: 'backendEnd',
    // #22: the session ended, one way or another. A leg that keeps that to itself
    // leaves the core attached to a session that is gone.
    handler: core => ({ reason = 'backend_end' } = {}) => core.backendEnd({ reason })
  },
  {
    kind: 'register',
    name: 'setErrorHandler',
    reaches: 'backendError',
    // The leg's own socket errors, which the core records and nothing else. A leg
    // that reports none still serves every client; what is lost is the log line.
    handler: core => ({ error } = {}) => core.backendError({ error })
  },

  // The delivery half (#726), in the front table's form: the methods the core calls
  // on the backend leg rather than registering through it. Each is required, because a
  // leg without one throws at the next frame, or opens no session at all.
  {
    // The dial. The core calls it once a target is set, and the session a claim opens
    // begins here; a leg without it serves no client.
    kind: 'call',
    name: 'connect',
  },
  {
    // A decoded packet the core sends the backend: teleport_confirm, keep_alive, pong,
    // the batch-received ack, settings, and the resource-pack answers.
    kind: 'call',
    name: 'write',
  },
  {
    // A serverbound frame, play or configuration, relayed to the backend as it arrived.
    kind: 'call',
    name: 'writeRaw',
  },
  {
    // The session's own ending, which the core calls before a redial or a stop.
    kind: 'call',
    name: 'end',
  },

  // The calls the core makes on the leg, so a leg that does not carry one is named
  // in the same report as a missing registration.
  {
    // #258: a dial and not a registration. The core hands the leg the body to dial, once
    // the caller has ended the current connection, and a claim dials with neither the
    // cookie nor the transfer intent of a followed move. The core catches a refusal and
    // logs target_refused, so a leg without this one refuses every claim.
    kind: 'call',
    name: 'setTarget',
  },
  {
    kind: 'call',
    name: 'answerHeldGate',
    // #73: answerHeldGateOnDetach asks the leg for the answer a configuration gate
    // its last client left would have had from a headless session; without this the
    // gate stays held and the core logs leg_cannot_answer.
  },
  {
    kind: 'call',
    name: 'chat',
    // #19: frontServerbound has this leg speak the human's text as the puppet,
    // because the signature needs the puppet's profile keys. Without it the core
    // drops the text as leg_has_no_chat and counts it.
  }
].map(Object.freeze))

// Hand every declared registration to the leg that carries it, measure every call
// it answers, and report the rows it lacks either way.
//
// #824: a leg refuses a second registration on a call-in it already filled, so a lane's
// earlier registration is what this call throws on, naming the call-in. That throw is the
// report of the middle case the header names: the leg's wiring was the lane's, and no list
// of names could have said so.
//
// The core is required: every
// handler reaches a method of it, and a table applied to the wrong object would
// register every call-in against nothing. The table is required too, so a leg is
// never measured against the other interface's rows.
//
// The core keeps the report in `legWiring`, one per interface, in start(): the start
// record carries each interface's `missing`, and `backendCarries` reads the backend's
// `called`. The core publishes no report on its handle, because every reader of one was a
// test (#817).
//
// #718: no field carries a handler. #607 reported every one it installed, so a lane
// wrapping a call-in after start() could call the function the leg was handed instead
// of writing the payload a second time. #683 deleted the two lanes that did, because
// the attach cut is the core's own event now, and a handler in this report is a fact
// about a caller no module writes. The tests were the only reader, so the field went
// with them: a lane that needs a different registration writes it at its line.
export function wireLegToCore ({ core, leg, table } = {}) {
  if (core === null || typeof core !== 'object') {
    throw new TypeError('wireLegToCore needs the core its call-ins reach: wireLegToCore({ core, leg, table })')
  }
  if (!Array.isArray(table)) {
    throw new TypeError('wireLegToCore needs the table of the interface it wires: FRONT_LEG_CALL_INS or BACKEND_LEG_CALL_INS')
  }
  const called = []
  const missing = []
  for (const entry of table) {
    const method = leg === null || leg === undefined ? undefined : leg[entry.name]
    if (typeof method !== 'function') {
      missing.push(entry.name)
      continue
    }
    // A call-in the core calls needs nothing registered; its presence is the whole
    // contract, and the report is where a reader learns it.
    if (entry.kind === 'call') {
      called.push(entry.name)
      continue
    }
    // #718: built here and handed over, not kept. The doc comment on the function
    // says why no field carries one.
    method.call(leg, entry.handler(core))
  }
  return { called, missing }
}

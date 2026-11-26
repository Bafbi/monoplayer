// The core-to-leg wiring (#592): the one home of the call-ins the core registers
// on the front leg it is handed, apart from the three it still wires inline
// (#605).
//
// One table, one row per call-in, each with the method it reaches and its payload
// shape. A row is either one the core cannot serve a client without, or one it
// uses when the leg carries it. The lanes used to register four of them by hand.
// The live lane and the rig copied all four (src/service/start-live.js,
// src/ladder/rig.js, where the loopback rungs reached it), and the parity lane
// copied three. The rest sat behind `typeof` guards in the core's own start(). A
// lane that lacked one of the four got no error: src/legs/live-front.js answers
// every attach from its own default, so it would refuse every client and say
// nothing.
//
// The core applies this table once, in its start(), so no lane can forget a
// call-in and the payload shapes live in one file. A lane that wants a different
// registration wraps one call-in after start(), and both lanes that do say so at
// the line: the rig reads the attach record, and the online rung cuts its
// evidence. A wrapper that rebuilds its call-in's payload repeats that one shape,
// which #607 is about. A leg that carries none of them is a leg with no core in front of it,
// which the two pre-auth rungs build on purpose. They never come here.
//
// The report is what a reader checks. `missing` names every declared call-in the
// leg does not carry, and `requiredMissing` names the subset the leg's own default
// hides. The core puts the missing names on its start line, and a test holds the
// real legs to an empty list. A missing one is not thrown on:
// src/legs/fake-legs.js carries neither setCoreAttach nor setCoreAttachConfiguring,
// and the tests that build a core on it attach through the core instead.
// test/service/wire-leg-to-core.test.js reads the report, and
// test/legs/adapters.test.js holds the real legs to this table, `reaches` and all.
export const LEG_CALL_INS = Object.freeze([
  // The rows a leg cannot serve a client without. Each has a default inside the
  // leg, so an absent one is silent rather than fatal: the leg refuses the attach
  // and records a reason the lane never reads.
  {
    name: 'setCoreAttach',
    required: true,
    reaches: 'attachPlayer',
    // The leg calls this at the client's play login. includeConfig is false
    // because a lane's attach never re-sends the configuration phase: the client
    // has already been sent it, and a second copy ends its connection.
    handler: core => ({ name, uuid } = {}) => core.attachPlayer({ name, uuid, includeConfig: false })
  },
  {
    name: 'setCoreAttachConfiguring',
    required: true,
    reaches: 'attachConfiguringPlayer',
    // #16: the client reached its login while the puppet was still configuring,
    // so the attach happens before the configuration phase is cached.
    handler: core => ({ name, uuid } = {}) => core.attachConfiguringPlayer({ name, uuid })
  },
  {
    name: 'setConfiguringHandler',
    required: true,
    reaches: 'configuringReady',
    // #16: the client entered its own configuration phase, which is the one
    // moment a configuration gate the backend asked can reach it.
    handler: core => ({ name } = {}) => core.configuringReady({ name })
  },
  {
    name: 'setClientSettingsHandler',
    required: true,
    reaches: 'noteClientSettings',
    // #18: the human's client information is the source of the fields the server
    // sees, and the core merges it with the backend's view distance cap.
    handler: core => settings => core.noteClientSettings(settings)
  },

  // The rows a lane uses when its leg carries them. A leg without one keeps its
  // own fallback, and the core counts the difference.
  {
    name: 'setReconfiguredHandler',
    required: false,
    reaches: 'frontReconfigured',
    // #22: the client answered the reconfiguration's finish frame and is in play
    // again on its own connection.
    handler: core => ({ name = null, uuid = null } = {}) => core.frontReconfigured({ name, uuid })
  },
  {
    name: 'setConnectClaimedBody',
    required: false,
    reaches: 'connectClaimedBody',
    // #258: a granted claim is what dials a body, so the front asks the core for
    // one and the core owns the dial and the warm wait.
    handler: core => payload => core.connectClaimedBody(payload)
  },
  {
    name: 'setSpectateBody',
    required: false,
    reaches: 'spectateBody',
    // #269: whether a row names the body this session serves.
    handler: core => payload => core.spectateBody(payload)
  },
  {
    name: 'setSpectatorAttach',
    required: false,
    reaches: 'spectateView',
    // #269: replay that body to the one channel that asked.
    handler: core => payload => core.spectateView(payload)
  },
  {
    name: 'setDisconnectBody',
    required: false,
    reaches: 'disconnectBody',
    // #261: the picker's Disconnect verb. The core ends the session, and a lane
    // with no core records the click and ends no body.
    handler: core => payload => core.disconnectBody(payload)
  },
  {
    name: 'setBodyServed',
    required: false,
    reaches: 'bodyServed',
    // #259: what a picker row says about a body. The leg's fallback is a null
    // reading, so a row written by a lane that never wired this says down.
    handler: core => () => core.bodyServed()
  },
  {
    name: 'setSpectatorLeft',
    required: false,
    reaches: 'spectatorLeft',
    // #269: a spectator's channel ended, so the core can stop relaying a body
    // nobody is in play on.
    handler: core => payload => core.spectatorLeft(payload)
  }
])

// Hand every declared call-in to the leg that carries it, and report the ones it
// does not. The core is required: every handler reaches a method of it, and a
// table applied to the wrong object would register every call-in against nothing.
export function wireLegToCore ({ core, leg } = {}) {
  if (core === null || typeof core !== 'object') {
    throw new TypeError('wireLegToCore needs the core its call-ins reach: wireLegToCore({ core, leg })')
  }
  const wired = []
  const missing = []
  const requiredMissing = []
  for (const entry of LEG_CALL_INS) {
    const register = leg === null || leg === undefined ? undefined : leg[entry.name]
    if (typeof register !== 'function') {
      missing.push(entry.name)
      if (entry.required === true) requiredMissing.push(entry.name)
      continue
    }
    register.call(leg, entry.handler(core))
    wired.push(entry.name)
  }
  return { wired, missing, requiredMissing }
}

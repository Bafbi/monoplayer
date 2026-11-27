// #824: a leg's call-in holds one handler, and the second registration is refused.
//
// A real leg kept each call-in in a closure variable with a plain setter, so a second
// registration replaced the first with nothing said. src/service/wire-leg-to-core.js says
// which registrations reach one call-in and what each one costs. The worst of them was the
// core's own, registered in its start() over a lane's. No report could show that: a report
// measures a leg's shape, and a name present is a name carried.
//
// So each leg keeps one handler per call-in, and every setter goes through this. The first
// registration stands. A second is refused in the call-in's own name, which is what makes a
// lane's early registration fail the core's start() instead of vanishing.
//
// A repeat of the same function is refused too. A registration is a write, not a call, and
// a leg that answers the second write with silence is the leg this ticket found. A value
// that is not a function is refused as well. Seven of the front leg's setters used to take
// `null` and clear the call-in, and a clear is one more way to move a handler the core
// owns.
//
// #918: the refusal above is inside the setter, so it holds for a caller that calls the
// setter and for nobody else. `leg.setCoreAttach = fn` never reaches it: the assignment
// replaces the setter itself. Made before the core's start(), the lane's function answers
// the core's registration, and `wireLegToCore` had already reported the member as carried.
// Made after it, the core's handler is gone and the report still reads whole. A guard over
// the call was a guard over one route into the call-in, and a lane needs no route: #683
// deleted the last lane that wrapped a call-in after start(), and #718 removed the report
// field that carried a handler. The only registration a correct lane makes is on a leg it
// built for itself, before anything else holds it.
//
// So the property carries the rule, and `sealCallIns` below is where a leg hands it out.
export function createCallInHandlers () {
  const filled = new Set()
  return function fillCallIn (name, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(name + ' takes the function this call-in answers with (#824)')
    }
    if (filled.has(name)) {
      throw new TypeError(name + ' already holds a handler, and a call-in holds one (#824): ' +
        'the core registers every call-in its table declares in its start(), so the first ' +
        'registration stands and the second is refused')
    }
    filled.add(name)
    return handler
  }
}

// The name shape a call-in setter has, which is the rule `sealCallIns` seals by. The register
// rows of src/service/wire-leg-to-core.js name most of these members and not all of them, so a
// list of names here would be a second home for a set those tables and test/legs/adapters.test.js
// already keep. The rule is the name: a member of a leg named `set` and a capital is where a
// caller writes into it.
//
// Three members that rule reaches are not what a reader expects, and all three are deliberate. The
// front leg's `setErrorHandler` is a setter no table declares, because the row of that name is the
// backend leg's (#667). `setTarget` is a call row rather than a register one. A double's
// `setClient` is a script hook a test calls, and no row names it at all. A seal that read the
// tables would leave all three writable, which is a leg a caller can still write over.
export const CALL_IN_SETTER = /^set[A-Z]/

// #918: a leg is built as one object literal and sealed at the return that hands it out. Every
// member `CALL_IN_SETTER` names is non-writable and non-configurable, so a write over it throws,
// every file here being a module and strict mode being every module's, and `defineProperty` and
// `delete` throw for the same reason: the descriptor is not the caller's to change. The field
// behind a setter is a closure variable, so the setter is the only name on the leg that reaches
// the call-in at all.
//
// A frozen leg was the other way to say this and is refused: the leg is not the whole fact. A
// test plants a member on a leg to drive an answer the core reads, and freezing the object
// would refuse that too (test/legs/adapters.test.js replaces `preAuthStats` on a real leg, and
// test/service/lane-state.test.js adds one to a double). What this seals is the setter, and the
// rest of the leg stays the surface it was. A record of setters the leg exposes instead of these
// members is refused for the tables' reason: the core and both tables name `leg.setX`, so a
// second name for the same call-in is a second home.
export function sealCallIns (leg) {
  for (const name of Object.keys(leg)) {
    if (!CALL_IN_SETTER.test(name)) continue
    Object.defineProperty(leg, name, {
      value: leg[name],
      writable: false,
      configurable: false,
      // The member stays readable and listed, because the walks that read it are
      // `Object.keys` (`test/legs/call-in-slots.test.js`, `test/legs/adapters.test.js`), and a
      // call-in a reader cannot list is one a lane cannot see.
      enumerable: true
    })
  }
  return leg
}

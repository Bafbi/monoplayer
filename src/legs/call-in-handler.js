// #824: a leg's call-in holds one handler, and the second registration is refused.
//
// A real leg kept each call-in in a closure variable with a plain setter, so a second
// registration replaced the first with nothing said. Three registrations can reach one
// call-in: the core's, made in its start(); a lane's, made before that start; and a lane's,
// made after it. src/service/wire-leg-to-core.js says which is which. The first and the
// third are a lane writing where the core writes, and the middle one was worse: the core's
// own registration replaced the lane's and no report could show it.
//
// So each leg keeps one handler per call-in, and every setter goes through this. The first
// registration stands. A second is refused in the call-in's own name, which is what makes a
// lane's early registration fail the core's start() instead of vanishing.
//
// A repeat of the same function is refused too. A registration is a write, not a call, and
// a leg that answers the second write with silence is the leg this ticket found.
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

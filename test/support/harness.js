// The fake-integration rig: a core wired to both fake legs, a clock the test
// drives, and the events the core emits. A test states the one thing it changes
// and inherits the rest (#104).
//
// Not a test file. `mise run test` runs `test/*/*.test.js`, so nothing here
// runs on its own. `test/support/` is in the mise glob only because
// test/tooling/mise-tasks.test.js requires every directory under test/ to be
// listed; a `test()` in this file would not run either.
//
// The two documented exceptions stay local: `test/driver/parity.test.js` and
// `test/driver/skin.test.js` name their `fakeClock` after a step counter, which
// is not this clock.
import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

// The account the fakes treat as the puppet unless the test names another.
const PUPPET = Object.freeze({ username: 'GlowSquidye', uuid: null })

// The player the rig puts on the attach whitelist unless the test adds one.
const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// A clock the test drives: no timer fires until tick() moves time, and `pending`
// counts the ones still armed, so a test can assert the core scheduled exactly
// one reconnect and nothing else.
export function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) {
      const timer = { fn, fires: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimeout (timer) { timers = timers.filter(t => t !== timer) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

// One core, started, on the fake legs. `config` is the document the test
// overrides, resolved by loadConfig the way production resolves it, so a nested
// section the test names keeps the defaults beside it.
//
// `logLines`, when given an array, collects the log the core writes. The sink
// parses each line, because the assertions read fields off it.
//
// The reconnect_due listener is registered before start(): start() emits only
// 'start', so a due reconnect is only ever raised by a later fault.
export function makeCore ({ config = {}, clock = fakeClock(), logLines = null } = {}) {
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: PUPPET, ...config }),
    backendLeg,
    frontLeg,
    clock,
    logStream: logLines === null ? null : { write: line => logLines.push(JSON.parse(line)) }
  })
  const events = []
  core.on('reconnect_due', event => events.push(event))
  core.start()
  return { clock, backendLeg, frontLeg, core, events }
}

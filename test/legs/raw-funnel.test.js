// The leg's clientbound write paths, counted off the source.
//
// #602: one funnel for a clientbound raw frame. "Every path that writes a clientbound
// configuration frame to a front client is one function" is not a claim a call can make: it
// is about the call sites that are not there yet. The unit tests beside this file drive the
// funnel; this one reads the leg and fails when a fourth writer appears, which is the
// failure that ticket was.
//
// #599 and #600: the rules those paths ask, stated once each. A source read is the only
// guard a claim about "no other writer" can have, and the same read holds "one predicate,
// one counter, one state rule" where a call would only show the paths that already exist.
//
// The idiom is the repo's own: read the file, count the literal, assert the count
// (test/ladder/rig.test.js, test/service/wire-leg-to-core.test.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEG = path.join(ROOT, 'src', 'legs', 'live-front.js')
const count = (source, literal) => source.split(literal).length - 1

test('#602 the leg has one raw funnel, and no second writer beside it', () => {
  const source = fs.readFileSync(LEG, 'utf8')

  assert.equal(count(source, 'function writeRawTo ('), 1,
    'the funnel is still one function in src/legs/live-front.js')

  // Every checked raw write is the funnel's own. A path that calls this directly takes
  // the wire check and none of the other per-socket checks writeRawTo makes (#602 named
  // three paths that did exactly that).
  assert.equal(count(source, 'emitCheckedRaw('), 1,
    'emitCheckedRaw is called once, inside writeRawTo: every other writer goes through the funnel')

  // And the funnel is the only thing that reaches the socket's own writer. Counted
  // with the member access, so the funnel's one call is the whole set: a second
  // client.writeRaw is a raw frame the leg wrote for itself, unchecked.
  assert.equal(count(source, '.writeRaw('), 1,
    'the socket writer is called once, inside emitCheckedRaw')

  // The landing is the path #602 was about, so it is read on its own rather than inferred
  // from the counts above: a landing that wrote a body's frame itself, as
  // `client.write('registry_data', …)` or through a writer of its own, would leave every
  // count above unchanged.
  const landing = source.slice(
    source.indexOf('function sendBodyConfiguration'),
    source.indexOf('function claimReport')
  )
  assert.ok(landing.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(landing, 'writeRawTo('), 1, 'the landing writes its frames through the funnel')
  assert.equal(count(landing, 'emitCheckedRaw('), 0, 'and calls nothing beside it')
})

// #599 and #600: the two write paths take the same two rules, and each rule is stated
// once. A predicate is what a count can hold: a second statement of a condition is a
// second answer, and the pair agrees only until somebody edits one of them.
test('#599 one predicate for the phase finish, and the raw path asks it', () => {
  const source = fs.readFileSync(LEG, 'utf8')

  assert.equal(count(source, 'function refusesAfterFinish ('), 1,
    'the rule against a configuration frame after the phase finish is stated once, in the interceptor')

  // The funnel's own slice: from its signature to the one call that reaches the socket.
  const funnel = source.slice(
    source.indexOf('function writeRawTo ('),
    source.indexOf('const sent = emitCheckedRaw')
  )
  assert.ok(funnel.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(funnel, 'finishSent'), 0,
    'the funnel does not read the interceptor\'s flag itself (#599: that was the second statement)')
  assert.equal(count(funnel, 'refusesAfterFinish'), 1, 'it asks the one predicate instead')

  // #599's criterion: the drop is counted as well as recorded. One counter, one writer.
  assert.equal(count(source, 'metrics.configFramesAfterFinish++'), 1,
    'the count is bumped in one function, so the count and the line cannot disagree')
  assert.equal(count(source, 'function recordAfterFinishDrop ('), 1,
    'and that function is the one both paths call')
})

// #969: the same shape for the round's other half. #541's rule refuses a
// configuration frame after the phase's finish; this one refuses a play frame while
// the round is opening. One predicate, both write paths, one counter.
test('#969 the round-opening rule is one predicate, and the raw path asks it', () => {
  const source = fs.readFileSync(LEG, 'utf8')

  assert.equal(count(source, 'function refusesWhileRoundOpening ('), 1,
    'the rule against a play frame written while the round opens is stated once, in the interceptor')

  const funnel = source.slice(
    source.indexOf('function writeRawTo ('),
    source.indexOf('const sent = emitCheckedRaw')
  )
  assert.ok(funnel.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(funnel, 'refusesWhileRoundOpening'), 1, 'the funnel asks the one predicate')
  assert.equal(count(funnel, 'roundOpen'), 0, 'and reads no flag of its own (#599: that was the second statement)')

  // The wiring is a one-line predicate over the leg's own flag, so a typo in it would
  // leave every interceptor-level case green while the rule never fired on a connection.
  assert.equal(count(source, 'isRoundOpen: () => clients.get(client)?.pendingReconfiguration != null'), 1,
    'the leg arms the rule from the window the funnel already holds configuration frames in')

  assert.equal(count(source, 'metrics.playFramesDuringRoundOpening++'), 1,
    'the count is bumped in one function, so the count and the line cannot disagree')
  assert.equal(count(source, 'function recordRoundOpeningDrop ('), 1, 'and that function is the one both paths call')
})

// #600: the packet path takes the rule a packet object can take, and the one
// configuration frame the leg authored as a packet object stops being one.
test('#600 the packet-object path is refused by state, and the server dialog is a raw frame', () => {
  const source = fs.readFileSync(LEG, 'utf8')

  assert.equal(count(source, 'function refuseStateMismatch ('), 1, 'one state rule, two write paths')
  assert.equal(count(source, 'metrics.stateRefused++'), 1, 'and one count for it')

  const packetPath = source.slice(
    source.indexOf('function writePacketTo ('),
    source.indexOf('function writeRawTo (')
  )
  assert.ok(packetPath.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(packetPath, 'refuseStateMismatch('), 1,
    'a packet object is refused in a state the client cannot parse, before the library writes it')

  const dialog = source.slice(
    source.indexOf('function sendServerDialog ('),
    source.indexOf('function handlePickerVerb (')
  )
  assert.ok(dialog.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(dialog, 'writeRawTo('), 1, 'the server dialog is a raw frame the wire check sees')
  assert.equal(count(dialog, '.write('), 0, 'and no packet-object write is left beside it')
})

// #820: one predicate, one count, one line, on both of the leg's write paths. The rows above
// pin that shape for the state rule and the phase-finish rule; this one pins it for the
// socket's own answer, because deleting either call site is otherwise a silent regression:
// the predicate's own cases stay green and nothing else fails.
test('#820 the closed-socket refusal is one predicate, one count and one line on both write paths', () => {
  const source = fs.readFileSync(LEG, 'utf8')

  assert.equal(count(source, 'function closedSocketReason ('), 1,
    'the socket question is asked in one function')
  assert.equal(count(source, 'export const CLOSED_SOCKET_REASONS'), 1,
    'and its reasons are one closed set')
  assert.equal(count(source, 'function refuseClosedSocket ('), 1,
    'one function counts a refused frame and writes the line about it')
  assert.equal(count(source, 'metrics.clientboundSocketClosed++'), 1,
    'the count is bumped in one function, so the count and the line cannot disagree')
  assert.equal(count(source, "record(client, 'clientboundSocketClosed'"), 1,
    'and the line is written there too')
  assert.equal(count(source, 'refuseClosedSocket(client'), 2,
    "both of the leg's write paths ask it: the packet path and the raw funnel")

  // The raw half on the funnel's own slice, so a call moved out of the funnel into a helper
  // nobody calls is read as the regression it is.
  const funnel = source.slice(
    source.indexOf('function writeRawTo ('),
    source.indexOf('const sent = emitCheckedRaw')
  )
  assert.ok(funnel.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(funnel, 'refuseClosedSocket(client'), 1,
    'the raw funnel asks it before it hands the frame to the socket')

  const packetPath = source.slice(
    source.indexOf('function writePacketTo ('),
    source.indexOf('function writeRawTo (')
  )
  assert.ok(packetPath.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal(count(packetPath, 'refuseClosedSocket(client'), 1,
    'and the packet path asks it before the library writes the packet object')
})


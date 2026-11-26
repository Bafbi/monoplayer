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

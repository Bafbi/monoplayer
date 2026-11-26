// #602: one funnel for a clientbound raw frame, counted off the source.
//
// "Every path that writes a clientbound configuration frame to a front client is one
// function" is not a claim a call can make: it is about the call sites that are not
// there yet. The unit tests beside this file drive the funnel; this one reads the leg
// and fails when a fourth writer appears, which is the failure this ticket was.
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

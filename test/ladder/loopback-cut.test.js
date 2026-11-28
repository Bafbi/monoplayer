// The cut O27 and O28 read: the first attach's replay, and never the reattach's.
//
// #683 made the core publish every replay as an `attach` event, and O27 compares the
// frames of one against what a real client decoded. #954 is the half no case held: the
// rung kept every event in an array and read `attachCuts[0]`, and both reads run before
// the main rig's second attach (src/ladder/loopback.js), so a reader that took the last
// element would pass every case and every rung. The rule now lives in
// `recordAttachCut` (#934, src/ladder/online.js), and the loopback rung reads through
// it: one reader, two lanes.
//
// Two cases, because they hold two things. The first drives two attaches on a lane's own
// core and holds the second out of the cut. The second holds src/ladder/loopback.js to
// the reader, because the first drives the reader and not the rung: a rung that went back
// to an index would leave it green.
//
// The first case builds a lane, which opens sockets, and attaches no client. A lane is
// the harness for a reason: its core is the one O27 and O28 read, on the real legs, and
// #934's case already drives the reader over the fake legs (test/support/harness.js). The
// core's `attachPlayer` is the entry the front leg's login call-in reaches
// (src/service/wire-leg-to-core.js), so a case needs no bot: the replay still carries the
// frames the warm cache gave it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLoopbackLane } from '../../src/ladder/loopback-lane.js'
import { recordAttachCut } from '../../src/ladder/online.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { callSpans } from '../support/source-scan.js'

const VERSION = '26.1'
const FIRST = { name: 'Bafbi', uuid: offlineUuid('Bafbi') }
// The reattach's client, so a cut that moved names a different player.
const SECOND = { name: 'Second', uuid: offlineUuid('Second') }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNG = 'src/ladder/loopback.js'
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// A comment is not a read: a module that explains why it reads no index wires nothing.
const code = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('#954 a later attach does not replace the cut O27 and O28 read', async (t) => {
  const lane = await createLoopbackLane({
    name: 'attachCut',
    version: VERSION,
    whitelist: [FIRST.uuid, SECOND.uuid]
  })
  t.after(async () => { await lane.close() })

  assert.equal(lane.core.cache.warm, true,
    'the lane warmed before a client attached, which is what gives O27 frames to compare')

  const events = []
  lane.core.on('attach', event => events.push(event))
  const cut = recordAttachCut(lane.core)
  assert.equal(cut(), null, 'no attach yet is no cut, not an empty one')

  assert.equal(lane.core.attachPlayer(FIRST).attached, true,
    'the first client attached, so the core published a cut to keep')
  const first = cut()
  assert.equal(first?.name, FIRST.name, 'the first attach is the cut')
  assert.ok(first.frames.length > 0,
    'the warm cache gave the first replay frames, so a cut that moved is a different answer')

  lane.core.detachPlayer({ reason: 'client_disconnect' })
  assert.equal(lane.core.attachPlayer(SECOND).attached, true,
    'the second client attached where the first detached, so a second cut landed')

  assert.equal(events.length, 2,
    'a reattach the lane core permits publishes a cut of its own, so the rule has an event to keep out')
  assert.equal(cut(), first,
    'the first attach is the cut: a later attach must not replace the frames O27 compares')
  assert.notDeepEqual(events[1].frames, first.frames,
    'the second replay is different frames, so a reader that took the last element is a different answer')
})

test('#954 the loopback rung reads its cut through recordAttachCut', () => {
  const calls = callSpans(code(read(RUNG)), 'recordAttachCut')
  assert.equal(calls.length, 1,
    RUNG + ' reads its cut through recordAttachCut ' + calls.length + ' times, and once is the ' +
    'number: the reader is the home of the first-wins rule, so a rung that read an index instead ' +
    'puts the rule back where no case reaches it (#954). A scan cannot see a second read kept ' +
    'beside this call, and this count does not claim to: that rung subscribes twice, and the ' +
    'ATTACH_SUBSCRIBERS row in test/service/wire-leg-to-core.test.js allows this file one attach ' +
    "listener, the entity rig's")
})

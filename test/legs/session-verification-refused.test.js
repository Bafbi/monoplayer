// #722: the one refusal this lane could not see.
//
// The sessionserver check is the protocol library's. `minecraft-protocol`'s login
// handler calls its own `hasJoined` and, on any error, ends the connection with
// `client.end('Failed to verify username!')` — before `options.beforeLogin`, so
// this leg never reviews the client, `metrics.denied` never moves and no
// `attachDenied` line is written. A 204 from the sessionserver is that error, and
// so is a transport failure: `yggdrasil` turns all of them into one sentence.
//
// This file drives that path through the real library, because the subject is the
// library's own path: calling the leg's end handler by hand would prove nothing
// about who calls it, or when. The fake stands where `yggdrasil`'s `hasJoined`
// stands — the module object `minecraft-protocol`'s login handler holds — and it
// answers the way a 204 does.
//
// The three checks are told apart here: a session the sessionserver refused, a
// login the whitelist refused, and a client that walked away before either.
//
// #742 grew the one sentence into the library's whole set, so the line this file
// reads is `libraryLoginRefused`: the record names the refusal, and the sessionserver's
// sentence keeps its own word and its own counter, `sessionVerificationRefused`, which
// `monoplayer.session.refused` samples. test/legs/library-login-refusals.test.js holds
// the rest of the set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import mc from 'minecraft-protocol'

import { DENY_REASONS } from '../../src/custody/attach.js'
import { createLiveFrontLeg } from '../../src/legs/live-front.js'
import {
  acceptsAsASession,
  refusesAsA204Does,
  withSessionserver
} from '../support/sessionserver.js'

const VERSION = '26.1'
// The sentence the library ends this client with, written here as the library writes
// it. It is the expected evidence, so a fork bump that changes the text fails this
// file rather than quietly emptying the lane's record.
const SESSION_REFUSAL_TEXT = 'Failed to verify username!'
const NAME = 'Mistyped'
const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

// The sessionserver this file drives, and the profile it answers a joined session with.
// Both are test/support/sessionserver.js's, because #756's test needs the same fake.
const sessionFor = acceptsAsASession({ id: PLAYER.replace(/-/g, ''), name: NAME })

// The live leg a deployed lane builds, on a port the kernel picks, with an attach
// whitelist file that does not exist: every login is a stranger, and this file's
// subjects are both reachable. Nothing is driven by hand — the leg is wired to the
// real library and the test's only input is the connection.
async function openLane () {
  const lines = []
  const leg = createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-722-nobody.json'),
    getSnapshotConfig: () => [],
    wireMode: 'off',
    log: (event, fields) => lines.push({ event, fields })
  })
  const { port } = await leg.listen()
  return { leg, lines, port }
}

// A real client, whose encryption round trip the library performs itself and whose
// session nobody joins: offline auth sends the encryption answer and skips the
// Mojang join, which is what a 204 then refuses on.
function joinLane (port) {
  const bot = mc.createClient({
    host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
  })
  // A lane that ends the connection from its side is the point of this file, so the
  // client's own error event is collected rather than raised into the run.
  bot.on('error', () => {})
  return bot
}

async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function recordsOf (lines, event) {
  return lines.filter(line => line.event === event).map(line => line.fields)
}

test('#722 a session the sessionserver refuses is counted and recorded, and is not a denial', async () => {
  await withSessionserver(refusesAsA204Does, async () => {
    const { leg, lines, port } = await openLane()
    const bot = joinLane(port)
    try {
      await settleUntil(() => leg.metrics.sessionVerificationRefused === 1, 'the count of a refused session')
      const refused = recordsOf(lines, 'libraryLoginRefused')
      assert.equal(refused.length, 1, 'one refused login, one line')
      assert.equal(leg.metrics.libraryLoginRefused, 1, 'and the library-wide count moved with it')
      assert.equal(leg.metrics.libraryLoginRefusedByReason[DENY_REASONS.HASJOINED_FAILED], 1,
        'the map is keyed by the word the line carries')
      assert.equal(refused[0].username, NAME, 'the line names the account that was refused')
      assert.equal(refused[0].uuid, null, 'the library never set a uuid: the profile never arrived')
      assert.equal(refused[0].reason, DENY_REASONS.HASJOINED_FAILED,
        'the reason is the custody check\'s own word for a failed hasJoined, not a new one')
      assert.equal(refused[0].text, SESSION_REFUSAL_TEXT,
        'and the sentence the client was told is on the line, because it is the only evidence there is')
      assert.equal(refused[0].refused, 1, 'the line states its own running count, as the window\'s two lines do')

      // The three refusals are told apart: this one is the sessionserver's, so the
      // whitelist never reviewed the client and the cap never refused it.
      assert.equal(leg.metrics.denied, 0, 'no denial: beforeLogin never ran')
      assert.deepEqual(recordsOf(lines, 'attachDenied'), [])
      assert.deepEqual(recordsOf(lines, 'frontLoginReview'), [], 'the login review was never reached')
      // #722: the pre-auth window's refusal count is a different number. Its cap
      // refused nothing here, and its deadline destroyed nothing: the socket was
      // admitted, sat in the window, and left it when the library ended it.
      assert.equal(leg.preAuthStats().refused, 0, 'the connection cap refused nothing')
      assert.equal(leg.preAuthStats().expired, 0, 'the deadline destroyed nothing')
      // #742: the line is written at the library's own end call, which is before the
      // socket closes, so the window still holds the connection when the record lands.
      // The slot is released on the close, and the wait is that close.
      await settleUntil(() => leg.preAuthStats().inWindow === 0, 'the slot the socket released')
      assert.equal(leg.preAuthStats().inWindow, 0, 'and the connection left the window')
    } finally {
      bot.socket?.destroy()
      await leg.close()
    }
  })
})

test('#722 a session the sessionserver accepts, on a name the whitelist refuses, is a denial and not this count', async () => {
  await withSessionserver(sessionFor, async () => {
    const { leg, lines, port } = await openLane()
    const bot = joinLane(port)
    try {
      await settleUntil(() => leg.metrics.denied === 1, 'the whitelist review\'s denial')
      const denied = recordsOf(lines, 'attachDenied')
      assert.equal(denied.length, 1)
      assert.equal(denied[0].reason, DENY_REASONS.NOT_WHITELISTED,
        'the whitelist refused it, and the line says so')
      assert.ok(recordsOf(lines, 'frontLoginReview').length === 1, 'the login review ran')
      assert.equal(leg.metrics.sessionVerificationRefused, 0,
        'a session the sessionserver accepted is never counted as refused by it')
      assert.equal(leg.metrics.libraryLoginRefused, 0, 'and the library refused nothing here either')
      assert.deepEqual(recordsOf(lines, 'libraryLoginRefused'), [])
    } finally {
      bot.socket?.destroy()
      await leg.close()
    }
  })
})

test('#722 a client that walks away before login writes no record', async () => {
  await withSessionserver(refusesAsA204Does, async () => {
    const { leg, lines, port } = await openLane()
    // A socket that connects and goes, without a login start: the library ends it
    // with no reason of its own, and no check has refused anything.
    const socket = net.connect(port, '127.0.0.1')
    try {
      await settleUntil(() => leg.metrics.preAuthInWindow === 1, 'the socket inside the window')
      socket.destroy()
      await settleUntil(() => leg.metrics.preAuthInWindow === 0, 'the slot the socket freed')
      assert.equal(leg.metrics.sessionVerificationRefused, 0, 'a client that left was not refused')
      assert.equal(leg.metrics.libraryLoginRefused, 0,
        'the library calls a plain close `socketClosed`, which is no refusal of its login handler')
      assert.deepEqual(recordsOf(lines, 'libraryLoginRefused'), [])
    } finally {
      socket.destroy()
      await leg.close()
    }
  })
})

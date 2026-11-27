// #756: one login, one whitelist review.
//
// With the attach whitelist file named, a live login compares the same UUID to the same
// document twice: `identity.reviewLoginStart` through the core's login call-in, then
// `checkVerified` over the leg's own store. Both fail closed, so the second is not a
// hole. Two decisions on one login can still disagree, and the operator's log then names
// whichever ran first. One login also parses the file twice.
//
// The subject of this file is the count, not the outcome. A test that only asserts an
// allowed login is allowed, and a stranger denied, passes on the code #756 describes.
// So the identity module's reviews are counted, and the store's reads are counted.
//
// Two seams, because the claim is about a real login:
//
//   1. `decideOnlineAttach`, socket-free: the leg's attach check is not called at all
//      once the core has reviewed the login.
//   2. a real connection through the real library and the real leg, with the identity
//      review wired where the core's login call-in reaches it. One login is one review and
//      one read of the document, allowed or refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import mc from 'minecraft-protocol'

import { DENY_REASONS, createFrontIdentity } from '../../src/core/identity.js'
import { createWhitelistStore } from '../../src/custody/store.js'
import { createLiveFrontLeg, decideOnlineAttach } from '../../src/legs/live-front.js'
import { acceptsAsASession, withSessionserver } from '../support/sessionserver.js'
// The removal this file's roots need (#558): importing the seam is what registers it.
import { tempRoot } from '../support/temp.js'

const VERSION = '26.1'
const NAME = 'Attach'
const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const STRANGER = '7d1c4f2e-6a51-4a1e-9a0e-2b8f3c5d7e91'
// The sessionserver's answer, and the profile the login handler stamps onto the client.
// Every name is answered with the one account this file whitelists, so the outcome is the
// whitelist's answer and never the sessionserver's.
const sessionFor = acceptsAsASession({ id: PLAYER.replace(/-/g, ''), name: NAME })

// One lane with a fake sessionserver answer, the document it holds, and the counts one
// login produced.
async function withLane (whitelist, run) {
  const dir = tempRoot('monoplayer-756-')
  const file = path.join(dir, 'attach-whitelist.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: whitelist.map(uuid => ({ uuid, name: null, addedAt: new Date().toISOString() }))
  }, null, 2) + '\n')

  // The document's reads, counted at the file. The store a control document hands the
  // core and the leg is one store that re-reads at each use (#229), so this number is
  // what one login costs the file.
  const counts = { reads: 0, reviews: 0 }
  const store = createWhitelistStore({
    file,
    reloadEachUse: true,
    readFile: (...args) => {
      counts.reads += 1
      return fs.readFileSync(...args)
    }
  })
  // The core's provider, exactly as src/service/control.js builds it: the same store,
  // read through its list.
  const identity = createFrontIdentity({
    attachWhitelist: () => store.list().map(player => player.uuid)
  })
  // The subject: a spy on the identity module that fails the count when one login is
  // reviewed twice. This stands in for the review the core's login call-in reaches first,
  // which is the one identity.js owns.
  const reviewLoginStart = payload => {
    counts.reviews += 1
    return identity.reviewLoginStart(payload)
  }

  const lines = []
  const leg = createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    attachWhitelistFile: file,
    whitelistStore: store,
    getSnapshotConfig: () => [],
    wireMode: 'off',
    log: (event, fields) => lines.push({ event, fields })
  })
  try {
    leg.setLoginStartHandler(reviewLoginStart)
    // The attach that follows the review is not this file's subject: an allowed login
    // lands here, and a lane with no backend answers as one that attached.
    leg.setCoreAttachConfiguring(() => ({ attached: true }))
    const { port } = await leg.listen()
    return await run({ leg, lines, counts, port })
  } finally {
    await leg.close()
  }
}

// A real client, whose encryption round trip the library performs itself. A lane that ends
// the connection from its side is one of this file's outcomes, so the client's own error
// event is collected rather than raised into the run.
function joinLane (port) {
  const bot = mc.createClient({
    host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
  })
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

test('#756 the leg attach check does not run when the core reviewed the login', () => {
  const check = {
    checkVerified () { throw new Error('the leg compared the whitelist a second time') }
  }
  const identity = createFrontIdentity({ attachWhitelist: [PLAYER] })
  const client = { username: NAME, uuid: PLAYER }

  const allowed = decideOnlineAttach({
    client,
    check,
    coreDecision: () => identity.reviewLoginStart({ uuid: client.uuid, name: client.username })
  })
  assert.equal(allowed.ok, true, 'the login the core allowed is allowed')
  assert.equal(allowed.uuid, PLAYER, 'and the decision still names the account the leg logs')
  assert.equal(allowed.username, NAME, 'by the name the core reviewed, not a second reading')

  const denied = decideOnlineAttach({
    client: { username: 'Stranger', uuid: STRANGER },
    check,
    coreDecision: () => identity.reviewLoginStart({ uuid: STRANGER, name: 'Stranger' })
  })
  assert.equal(denied.ok, false, 'a stranger is refused')
  assert.equal(denied.reason, DENY_REASONS.NOT_WHITELISTED, 'with the core word for it')
})

test('#756 a real login the whitelist holds is one review and one read of the document', async () => {
  await withSessionserver(sessionFor, async () => {
    await withLane([PLAYER], async ({ leg, lines, counts, port }) => {
      const bot = joinLane(port)
      try {
        await settleUntil(() => leg.metrics.allowed === 1, 'the allowed login')
        assert.equal(counts.reviews, 1, 'one login, one whitelist review')
        assert.equal(counts.reads, 1, 'and one read of the document the review compared')
        assert.equal(leg.metrics.denied, 0, 'nothing was refused')
        assert.equal(recordsOf(lines, 'attachAllowed').length, 1, 'one allowed line')
        assert.deepEqual(recordsOf(lines, 'attachDenied'), [], 'and no denial line')
      } finally {
        bot.socket?.destroy()
      }
    })
  })
})

test('#756 a real login the whitelist does not hold is one review, one read and one refusal', async () => {
  // A document that holds some other account. The fake sessionserver answers every name
  // with PLAYER's profile, so this login is one the review refuses and the outcome is not
  // the sessionserver's.
  await withSessionserver(sessionFor, async () => {
    await withLane([STRANGER], async ({ leg, lines, counts, port }) => {
      const bot = joinLane(port)
      try {
        await settleUntil(() => leg.metrics.denied === 1, 'the refused login')
        assert.equal(counts.reviews, 1, 'one login, one whitelist review')
        assert.equal(counts.reads, 1, 'and one read of the document it compared')
        const denied = recordsOf(lines, 'attachDenied')
        assert.equal(denied.length, 1, 'one refusal, one line')
        assert.equal(denied[0].reason, DENY_REASONS.NOT_WHITELISTED, 'and one reason')
        assert.equal(leg.metrics.allowed, 0, 'nothing was allowed')
      } finally {
        bot.socket?.destroy()
      }
    })
  })
})

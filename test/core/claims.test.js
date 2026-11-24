// #267: the claim. One attaching player's exclusive control of a body, held by
// the connection that made it and released when that connection ends. The picker
// records it where the client answers a body's dialog, not at login, so two
// clients may read the picker at once and only the claim contends. Nothing here
// reads a clock or touches a socket: the holder is the id the leg gives a
// connection, and the caller passes the time.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAIM_REFUSAL,
  claimRefusalText,
  createClaims
} from '../../src/core/claims.js'

const BODY = { body: 'gate-paper_25565', server: 'gate-paper:25565' }

test('#267 a claim on an unclaimed body is granted and names the driver', () => {
  const claims = createClaims()
  const outcome = claims.claim({ ...BODY, holder: 'c1', name: 'Attach', at: 1000 })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.repeated, false)
  assert.deepEqual(outcome.claim, {
    body: 'gate-paper_25565',
    server: 'gate-paper:25565',
    holder: 'c1',
    name: 'Attach',
    at: 1000
  })
  assert.deepEqual(claims.claimOn('gate-paper_25565'), outcome.claim)
  assert.deepEqual(claims.claimOf('c1'), outcome.claim)
  assert.equal(claims.isClaimed('gate-paper_25565'), true)
  assert.equal(claims.size, 1)
  assert.deepEqual(claims.snapshot(), [outcome.claim], 'the snapshot is the board, and the claim is a copy')
})

test('#267 a second claim on one body is refused, and the refusal names who drives it', () => {
  const claims = createClaims()
  claims.claim({ ...BODY, holder: 'c1', name: 'Attach', at: 1000 })

  const refused = claims.claim({ ...BODY, holder: 'c2', name: 'Second', at: 2000 })

  assert.equal(refused.ok, false)
  assert.equal(refused.reason, CLAIM_REFUSAL.TAKEN)
  assert.equal(refused.claim.holder, 'c1', 'the refusal carries the claim that stands in the way')
  assert.equal(refused.claim.name, 'Attach', 'so the client can be told who is driving it')
  assert.equal(claims.claimOn('gate-paper_25565').holder, 'c1', 'the first claim is untouched')
  assert.equal(claims.claimOf('c2'), null, 'a refused claim is not held')
  assert.equal(claims.size, 1)
})

test('#267 the holder may claim the body again: one click is not a second driver', () => {
  const claims = createClaims()
  const first = claims.claim({ ...BODY, holder: 'c1', name: 'Attach', at: 1000 })
  const again = claims.claim({ ...BODY, holder: 'c1', name: 'Attach', at: 2000 })

  assert.equal(again.ok, true, 'a repeated click from the holder is not a contention')
  assert.equal(again.repeated, true)
  assert.deepEqual(again.claim, first.claim, 'the claim keeps the moment it was taken')
  assert.equal(claims.size, 1)
})

test('#267 one connection holds one claim: claiming a second body is refused', () => {
  const claims = createClaims()
  claims.claim({ body: 'gate-paper_25565', server: 'gate-paper:25565', holder: 'c1', name: 'Attach', at: 1000 })

  const refused = claims.claim({ body: 'sky', server: 'sky:25565', holder: 'c1', name: 'Attach', at: 2000 })

  assert.equal(refused.ok, false)
  assert.equal(refused.reason, CLAIM_REFUSAL.HELD)
  assert.equal(refused.claim.body, 'gate-paper_25565', 'the refusal names the body this connection already drives')
  assert.equal(claims.isClaimed('sky'), false)
  assert.equal(claims.size, 1)
})

test('#267 a claim is released when the connection that made it ends, and only that one', () => {
  const claims = createClaims()
  claims.claim({ body: 'gate-paper_25565', server: 'gate-paper:25565', holder: 'c1', name: 'Attach', at: 1000 })
  claims.claim({ body: 'sky', server: 'sky:25565', holder: 'c2', name: 'Second', at: 1000 })

  assert.equal(claims.release('c1').body, 'gate-paper_25565')
  assert.equal(claims.isClaimed('gate-paper_25565'), false)
  assert.equal(claims.isClaimed('sky'), true, 'another connection\'s claim is not a release')
  assert.equal(claims.release('c1'), null, 'a connection that holds nothing releases nothing')
  assert.equal(claims.size, 1)

  // The body is free, so the next player takes it: that is a detach, not a move.
  const next = claims.claim({ ...BODY, holder: 'c3', name: 'Third', at: 3000 })
  assert.equal(next.ok, true)
  assert.equal(claims.claimOn('gate-paper_25565').name, 'Third')
})

test('#267 the refusal sentence names the body, the server and the driver', () => {
  assert.equal(
    claimRefusalText({
      reason: CLAIM_REFUSAL.TAKEN,
      server: 'gate-paper:25565',
      holder: 'Attach'
    }),
    'Monoplayer: gate-paper:25565 is already driven by Attach. A body has one driver.'
  )
  assert.equal(
    claimRefusalText({ reason: CLAIM_REFUSAL.HELD, server: 'sky:25565', driving: 'gate-paper:25565' }),
    'Monoplayer: you are already driving gate-paper:25565. Leave it before you claim sky:25565.'
  )
})

test('#267 a claim with no body or no holder is a programming error, not a refusal', () => {
  const claims = createClaims()
  assert.throws(() => claims.claim({ body: '', holder: 'c1' }), TypeError)
  assert.throws(() => claims.claim({ body: 'sky' }), TypeError)
  assert.throws(() => claims.claim({ body: 'sky', holder: '' }), TypeError)
})

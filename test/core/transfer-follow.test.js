// Transfer-follow controller: target memory and the failure fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTransferFollowController, DEFAULT_MAX_TARGET_FAILURES } from '../../src/core/transfer-follow.js'

const target = { host: 'sky-2.excalia.fr', port: 25565 }

test('a target from the due event is remembered across retries', () => {
  const c = createTransferFollowController()
  assert.deepEqual(c.onDue({ target }).target, target)
  assert.deepEqual(c.onDue({ target: null }).target, target, 'retry without a target keeps it')
  assert.equal(c.failures, 0)
})

test('the base target stays null when no transfer is pending', () => {
  const c = createTransferFollowController()
  assert.deepEqual(c.onDue({ target: null }), { target: null, kind: null, failures: 0 })
  assert.equal(c.target, null)
})

test(`after ${DEFAULT_MAX_TARGET_FAILURES} failures the controller reverts to the base`, () => {
  const c = createTransferFollowController()
  c.onDue({ target })
  assert.deepEqual(c.onFailure(), { target, failures: 1, reverted: false, abandoned: null })
  assert.deepEqual(c.onFailure(), { target, failures: 2, reverted: false, abandoned: null })
  const last = c.onFailure()
  assert.equal(last.reverted, true)
  assert.deepEqual(last.abandoned, target)
  assert.equal(c.target, null)
  assert.equal(c.reverts, 1)
  assert.deepEqual(c.onDue({ target: null }), { target: null, kind: null, failures: 0 })
})

test('a successful connect clears the target', () => {
  const c = createTransferFollowController()
  c.onDue({ target })
  assert.deepEqual(c.onSuccess(), { followed: true })
  assert.equal(c.target, null)
  assert.equal(c.kind, null, 'the dialect goes with the target it described')
  assert.deepEqual(c.onDue({}), { target: null, kind: null, failures: 0 })
})

test('#264 every followed hop dials as a transfer, whatever kind the event names', () => {
  const c = createTransferFollowController()
  assert.deepEqual(c.onDue({ target, kind: 'operator' }), { target, kind: 'transfer', failures: 0 },
    'the operator move is gone, so no event ranks the dialect')
  assert.equal(c.kind, 'transfer')
  assert.deepEqual(c.onDue({ target: null, kind: 'nonsense' }), { target, kind: 'transfer', failures: 0 },
    'a retry carries no target, so it keeps the hop it remembered, and that hop was a transfer')
  assert.equal(c.kind, 'transfer')
})

test('invalid targets are ignored', () => {
  const c = createTransferFollowController()
  for (const bad of [{ host: '', port: 1 }, { host: 'x', port: 0 }, { host: 'x', port: 70000 }, { host: 1, port: 1 }, null]) {
    assert.deepEqual(c.onDue({ target: bad }).target, null)
  }
})

test('abort gives up immediately', () => {
  const c = createTransferFollowController()
  c.onDue({ target })
  assert.deepEqual(c.abort('unreachable'), { expected: false, abandoned: target, reason: 'unreachable' })
  assert.equal(c.target, null)
  assert.equal(c.failures, 0)
})

test('the failure budget is configurable and validated', () => {
  assert.throws(() => createTransferFollowController({ maxTargetFailures: 0 }), /positive integer/)
  const c = createTransferFollowController({ maxTargetFailures: 2 })
  c.onDue({ target })
  c.onFailure()
  assert.equal(c.onFailure().reverted, true)
})

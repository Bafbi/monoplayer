// #16: the pending control dialog.
//
// One dialog is outstanding at a time. A newer show replaces it, a clear drops
// it, the human's answer releases it, and a client that attaches later gets the
// held frame re-sent. Nothing here answers, times out, or clicks: that is the
// policy #20 and #21 own.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CONTROL_ANSWERS, createPendingDialog } from '../../src/core/pending-dialog.js'

const SHOW = { state: 'play', name: 'show_dialog', buffer: Buffer.from('d1') }
const SHOW2 = { state: 'play', name: 'show_dialog', buffer: Buffer.from('d2') }
const GATE = { state: 'configuration', name: 'code_of_conduct', buffer: Buffer.from('coc') }

test('#16 a shown dialog is held', () => {
  const pending = createPendingDialog()
  assert.equal(pending.held, false)
  assert.equal(pending.peek(), null)

  const outcome = pending.show(SHOW)
  assert.equal(outcome.replaced, false)
  assert.equal(pending.held, true)
  assert.deepEqual(pending.peek(), { state: 'play', name: 'show_dialog' })
})

test('#16 a newer dialog replaces the held one', () => {
  const pending = createPendingDialog()
  pending.show(SHOW)
  const outcome = pending.show(SHOW2)
  assert.equal(outcome.replaced, true)
  assert.deepEqual(pending.forAttach('play').buffer, SHOW2.buffer, 'the newer frame is the only one held')
})

test('#16 clear_dialog drops the held dialog', () => {
  const pending = createPendingDialog()
  pending.show(SHOW)
  assert.equal(pending.clear().dropped, true)
  assert.equal(pending.held, false)
  assert.equal(pending.clear().dropped, false, 'clearing an empty holder drops nothing')
})

test('#16 the human answer releases the dialog it answers', () => {
  const pending = createPendingDialog()
  pending.show(SHOW)
  assert.equal(CONTROL_ANSWERS.has('custom_click_action'), true)
  assert.deepEqual(pending.answer({ name: 'position' }), { answered: false }, 'an ordinary frame answers nothing')
  assert.equal(pending.held, true)

  const outcome = pending.answer({ name: 'custom_click_action' })
  assert.equal(outcome.answered, true)
  assert.equal(outcome.state, 'play')
  assert.equal(pending.held, false)
})

test('#16 an answer with nothing held is recorded, not invented', () => {
  const pending = createPendingDialog()
  assert.deepEqual(pending.answer({ name: 'accept_code_of_conduct' }), { answered: false })
})

test('#16 a held dialog is re-sent only into its own state, and is not consumed', () => {
  const pending = createPendingDialog()
  pending.show(GATE)
  assert.equal(pending.forAttach('play'), null, 'a configuration gate never reaches a client in play')
  assert.equal(pending.held, true, 'a withheld dialog is still waiting for its client')

  const frame = pending.forAttach('configuration')
  assert.equal(frame.name, 'code_of_conduct')
  assert.equal(frame.state, 'configuration')
  assert.equal(frame.buffer, GATE.buffer, 'the frame crosses byte for byte')
  assert.equal(pending.held, true, 're-sending is not answering')
  assert.deepEqual(pending.forAttach('configuration').name, 'code_of_conduct', 'a second attach gets it again')
})

test('#16 the holder rejects a malformed show', () => {
  const pending = createPendingDialog()
  assert.throws(() => pending.show({ name: 'show_dialog' }), TypeError)
  assert.throws(() => pending.show({ buffer: Buffer.from('x') }), TypeError)
  assert.throws(() => pending.show({ state: 'handshake', name: 'show_dialog', buffer: Buffer.from('x') }), TypeError)
  assert.equal(pending.held, false)
})

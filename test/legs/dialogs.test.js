// Configuration gates: who answers, and when the puppet clicks nothing.
//
// This is the leg's own policy, so the tests live beside it. Which action is
// clicked, and the frame that answers it, is src/core/dialog-codec.js's and is
// tested in test/core/dialog-codec.test.js.
//
// The fixture mirrors the decoded `show_dialog` shape: every NBT node is a
// { type, value } wrapper, and `actions` is a list of compounds. The real
// Excalia dialog uses the same shape with two season buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  answerBackendDialog,
  answerHeldGate
} from '../../src/legs/live-backend.js'

function action (label, id, buttonId) {
  return {
    action: {
      type: 'compound',
      value: {
        type: { type: 'string', value: 'minecraft:dynamic/custom' },
        id: { type: 'string', value: id },
        additions: {
          type: 'compound',
          value: {
            id: { type: 'intArray', value: buttonId }
          }
        }
      }
    },
    label: {
      type: 'compound',
      value: { text: { type: 'string', value: label } }
    }
  }
}

function dialog (actions) {
  return {
    dialog: {
      type: 'compound',
      value: {
        type: { type: 'string', value: 'minecraft:multi_action' },
        actions: {
          type: 'list',
          value: { type: 'compound', value: actions }
        }
      }
    }
  }
}

const TWO_SEASONS = dialog([
  action('Saison 2', 'paper:dialog_click_callback', [1, 2, 3, 4]),
  action('Saison 3', 'paper:dialog_click_callback', [5, 6, 7, 8])
])

// One handler call with its IO recorded: what it wrote, what it logged, and
// what it reported to the core.
function runAnswer (options) {
  const written = []
  const logs = []
  const answers = []
  const outcome = answerBackendDialog({
    data: TWO_SEASONS,
    dialogAction: 'last',
    humanAttached: false,
    writeRaw: body => written.push(body),
    onAnswered: payload => answers.push(payload),
    log: (event, fields) => logs.push({ event, fields }),
    ...options
  })
  return { outcome, written, logs, answers }
}

test('#20 the show_dialog handler writes nothing for a play dialog', () => {
  const { outcome, written, logs, answers } = runAnswer({ state: 'play' })

  assert.deepEqual(outcome, { answered: false, reason: 'play_dialog_waits', responses: 0 })
  assert.equal(written.length, 0, 'a play dialog is never clicked')
  assert.equal(answers.length, 0, 'and the core is never told it was answered')
  assert.deepEqual(logs.map(entry => entry.event), ['dialogUnhandled'])
  assert.equal(logs[0].fields.reason, 'play_dialog_waits')
  assert.equal(logs[0].fields.state, 'play')
})

test('#20 a headless configuration gate is still answered with the configured action', () => {
  const { outcome, written, logs, answers } = runAnswer({ state: 'configuration' })

  assert.equal(outcome.answered, true)
  assert.equal(outcome.responses, 1)
  assert.equal(written.length, 1)
  assert.equal(written[0][0], 0x08, 'a configuration click uses the configuration packet id')
  assert.deepEqual(answers, [{ state: 'configuration', name: 'show_dialog' }],
    'the core spends its marker, so the gate is never offered to the next client')
  assert.equal(logs[0].event, 'dialogClicked')
  assert.equal(logs[0].fields.state, 'configuration')
})

test('#20 an attached client answers the configuration gate, not the puppet', () => {
  const { outcome, written, answers } = runAnswer({ state: 'configuration', humanAttached: true })
  assert.deepEqual(outcome, { answered: false, reason: 'human_attached', responses: 0 })
  assert.equal(written.length, 0)
  assert.equal(answers.length, 0)
})

test('#20 a server that keeps asking is capped, not looped', () => {
  const { outcome, written } = runAnswer({ state: 'configuration', responses: 5 })
  assert.deepEqual(outcome, { answered: false, reason: 'too_many', responses: 5 })
  assert.equal(written.length, 0)
})

// #73: a detach answers the gate the last player left, with the same policy the
// headless fallback uses. Covered here because the button gate is this file's
// subject; the code-of-conduct half is in code-of-conduct-gate.test.js.
function runHeldGate (options) {
  const written = []
  const logs = []
  const answers = []
  const outcome = answerHeldGate({
    state: 'configuration',
    name: 'show_dialog',
    data: TWO_SEASONS,
    connectionState: 'configuration',
    dialogAction: 'last',
    write: () => { throw new Error('a button gate is a raw write') },
    writeRaw: body => written.push(body),
    onAnswered: payload => answers.push(payload),
    log: (event, fields) => logs.push({ event, fields }),
    ...options
  })
  return { outcome, written, logs, answers }
}

test('#73 a held button gate is clicked on detach with the configured action', () => {
  const { outcome, written, logs, answers } = runHeldGate()

  assert.deepEqual(outcome, { answered: true, reason: null, name: 'show_dialog', responses: 1 })
  assert.equal(written.length, 1)
  assert.equal(written[0][0], 0x08, 'the click carries the configuration packet id')
  assert.deepEqual(answers, [{ state: 'configuration', name: 'show_dialog' }])
  assert.equal(logs[0].event, 'dialogClicked')
})

test('#73 the detach click counts against the same cap as a live one', () => {
  // A server that keeps asking is a loop, not a gate: the per-connection cap
  // must not restart because the last player left.
  const { outcome, written } = runHeldGate({ responses: 5 })

  assert.deepEqual(outcome, { answered: false, reason: 'too_many', name: 'show_dialog', responses: 5 })
  assert.equal(written.length, 0)
})

test('#73 without a policy a held button gate is not clicked on detach', () => {
  const { outcome, written, logs } = runHeldGate({ dialogAction: null })

  assert.deepEqual(outcome, { answered: false, reason: 'no_policy', name: 'show_dialog', responses: 0 })
  assert.equal(written.length, 0, 'a gate nobody configured an answer for waits')
  assert.deepEqual(logs.map(entry => entry.event), ['dialogUnhandled'])
})

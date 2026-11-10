// Configuration gates: which action the puppet clicks, and when it clicks
// nothing.
//
// The fixture mirrors the decoded `show_dialog` shape: every NBT node is a
// { type, value } wrapper, and `actions` is a list of compounds. The real
// Excalia dialog uses the same shape with two season buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  answerBackendDialog,
  answerHeldGate,
  chooseDialogAction,
  buildCustomClickAction,
  decideDialogAutoAnswer
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

test('last picks the current season button', () => {
  const choice = chooseDialogAction(TWO_SEASONS, 'last')
  assert.equal(choice.index, 1)
  assert.equal(choice.total, 2)
  assert.equal(choice.label, 'Saison 3')
  assert.equal(choice.id, 'paper:dialog_click_callback')
  assert.equal(choice.dialogType, 'minecraft:multi_action')
  assert.deepEqual(choice.additions.value.id.value, [5, 6, 7, 8])
})

test('first picks the first action', () => {
  assert.equal(chooseDialogAction(TWO_SEASONS, 'first').label, 'Saison 2')
})

test('a label substring selects the matching action', () => {
  assert.equal(chooseDialogAction(TWO_SEASONS, 'saison 2').index, 0)
  assert.equal(chooseDialogAction(TWO_SEASONS, 'SAISON 3').index, 1)
})

test('an unmatched label falls back to the last action', () => {
  assert.equal(chooseDialogAction(TWO_SEASONS, 'no-such-button').index, 1)
})

test('no actions or a missing callback id yields null', () => {
  assert.equal(chooseDialogAction(dialog([]), 'last'), null)
  const noId = dialog([{ action: { type: 'compound', value: {} }, label: { type: 'compound', value: {} } }])
  assert.equal(chooseDialogAction(noId, 'last'), null)
})

test('the click body includes the identifier and the length-prefixed optional NBT', () => {
  const choice = chooseDialogAction(TWO_SEASONS, 'last')
  const body = buildCustomClickAction({
    state: 'configuration',
    id: choice.id,
    additions: choice.additions
  })

  assert.equal(body[0], 0x08)
  assert.equal(body[1], choice.id.length)
  assert.equal(body.subarray(2, 2 + choice.id.length).toString('utf8'), choice.id)

  let offset = 2 + choice.id.length
  const payloadLength = body[offset++]
  assert.equal(payloadLength, body.length - offset)
  assert.equal(body[offset], 1) // optional NBT present
  assert.equal(body[offset + 1], 0x0a) // compound root
  assert.equal(body[offset + 2], 0x00) // empty root name length
  assert.equal(body[offset + 3], 0x00)
})

test('#16 no auto-answer while a human is attached', () => {
  // A headless configuration gate is answered with the configured action; the
  // same policy with a human attached answers nothing, so the two answerers
  // cannot both fire.
  assert.deepEqual(
    decideDialogAutoAnswer({ dialogAction: 'last', humanAttached: false, state: 'configuration' }),
    { auto: true, reason: null }
  )
  assert.deepEqual(
    decideDialogAutoAnswer({ dialogAction: 'last', humanAttached: true, state: 'configuration' }),
    { auto: false, reason: 'human_attached' }
  )
  // No policy, no click, human or not.
  assert.deepEqual(
    decideDialogAutoAnswer({ dialogAction: null, humanAttached: false, state: 'configuration' }),
    { auto: false, reason: 'no_policy' }
  )
})

test('#20 a play dialog is never answered by the puppet', () => {
  // The human owns every play dialog: the attached client answers it or it
  // waits. The configured action covers configuration-phase gates only, so no
  // combination of attachment and policy makes the puppet click a play dialog.
  const cases = [
    ['play', false, 'last', { auto: false, reason: 'play_dialog_waits' }],
    ['play', true, 'last', { auto: false, reason: 'play_dialog_waits' }],
    ['play', false, 'Saison 3', { auto: false, reason: 'play_dialog_waits' }],
    // The phase is checked before the policy, so a play dialog reports the same
    // reason whether or not one is configured.
    ['play', false, null, { auto: false, reason: 'play_dialog_waits' }],
    // A phase nobody named fails closed: waiting is always safe, clicking is not.
    [undefined, false, 'last', { auto: false, reason: 'unsupported_state' }],
    ['login', false, 'last', { auto: false, reason: 'unsupported_state' }]
  ]
  for (const [state, humanAttached, dialogAction, expected] of cases) {
    assert.deepEqual(
      decideDialogAutoAnswer({ state, humanAttached, dialogAction }),
      expected,
      `state=${state} attached=${humanAttached} action=${dialogAction}`
    )
  }
})

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

test('play uses the play packet id and a missing NBT is optional-absent', () => {
  const play = buildCustomClickAction({ state: 'play', id: 'paper:dialog', additions: null })
  assert.equal(play[0], 0x44)
  const offset = 2 + 'paper:dialog'.length
  assert.equal(play[offset], 1) // payload length
  assert.equal(play[offset + 1], 0) // optional absent

  assert.equal(buildCustomClickAction({ state: 'login', id: 'x' }), null)
  assert.equal(buildCustomClickAction({ state: 'configuration', id: '' }), null)
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

test('#73 without a policy a held button gate is not clicked on detach', () => {
  const { outcome, written, logs } = runHeldGate({ dialogAction: null })

  assert.deepEqual(outcome, { answered: false, reason: 'no_policy', name: 'show_dialog', responses: 0 })
  assert.equal(written.length, 0, 'a gate nobody configured an answer for waits')
  assert.deepEqual(logs.map(entry => entry.event), ['dialogUnhandled'])
})

// Backend onboarding dialogs: choose the action a headless puppet clicks.
//
// The fixture mirrors the decoded `show_dialog` shape: every NBT node is a
// { type, value } wrapper, and `actions` is a list of compounds. The real
// Excalia dialog uses the same shape with two season buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chooseDialogAction, buildCustomClickAction } from '../src/legs/live-backend.js'

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

test('play uses the play packet id and a missing NBT is optional-absent', () => {
  const play = buildCustomClickAction({ state: 'play', id: 'paper:dialog', additions: null })
  assert.equal(play[0], 0x44)
  const offset = 2 + 'paper:dialog'.length
  assert.equal(play[offset], 1) // payload length
  assert.equal(play[offset + 1], 0) // optional absent

  assert.equal(buildCustomClickAction({ state: 'login', id: 'x' }), null)
  assert.equal(buildCustomClickAction({ state: 'configuration', id: '' }), null)
})

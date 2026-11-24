// #257: the picker's dialog and its answer. The dialog is Minecraft's own
// multi_action shape, and the answer is the vanilla frame layout, which
// minecraft-data does not describe: the library's writer omits the payload's
// length prefix, so a test that feeds the codec a pre-decoded object proves
// nothing about the wire.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PICK_ACTION_TYPE,
  PICK_NAMESPACE,
  buildPickAnswer,
  pickIdFor,
  pickRefusalText,
  pickSlug,
  pickerDialog,
  pickerDialogParams,
  pickerLabel,
  pickerRows,
  readPickAction
} from '../../src/core/picker.js'

const rows = [
  { name: 'gate-paper:25565', state: 'down' },
  { name: 'sky', state: 'claimed', driver: 'Bafbi' }
]

test('#257 a host and port become a legal resource location', () => {
  assert.equal(pickSlug('gate-paper:25565'), 'gate-paper_25565')
  assert.equal(pickSlug('Paper.Excalia.FR'), 'paper.excalia.fr')
  assert.equal(pickSlug(''), 'server')
  assert.equal(pickIdFor('sky'), PICK_NAMESPACE + '/sky')
  assert.match(pickIdFor('a b:c'), /^monoplayer:pick\/[a-z0-9/._-]+$/)
})

test('#257 the dialog is a multi_action with one custom action per server', () => {
  const dialog = pickerDialog({ rows, title: 'Choose a server' })
  assert.equal(dialog.type, 'compound')
  const value = dialog.value
  assert.equal(value.type.value, 'minecraft:multi_action')
  assert.equal(value.title.value, 'Choose a server')
  // A picker that Esc closes leaves the client in configuration with nothing on
  // screen, so the dialog is not dismissible.
  assert.deepEqual(value.can_close_with_escape, { type: 'byte', value: 0 })
  const buttons = value.actions.value.value
  assert.equal(buttons.length, 2)
  // A list of compounds carries each element as its own key map: a { type, value }
  // wrapper here is written as an empty compound, and the client reads a dialog
  // with no buttons.
  assert.equal(buttons[0].label.value, 'gate-paper:25565 - down')
  assert.equal(buttons[0].width.value, 200)
  assert.equal(buttons[0].action.value.type.value, PICK_ACTION_TYPE)
  assert.equal(buttons[0].action.value.id.value, 'monoplayer:pick/gate-paper_25565')
  assert.equal(buttons[1].label.value, 'sky - claimed (Bafbi)')
  // The configuration phase carries the dialog inline, so the compound is the
  // field's own value; the play state wraps it in a holder's data branch.
  assert.equal(pickerDialogParams({ rows }).dialog.type, 'compound')
})

test('#257 the label names the state, and the driver when there is one', () => {
  assert.equal(pickerLabel({ name: 'sky', state: 'unclaimed' }), 'sky - unclaimed')
  assert.equal(pickerLabel({ name: 'sky', state: 'claimed', driver: 'Bafbi' }), 'sky - claimed (Bafbi)')
  assert.equal(pickerLabel({}), 'server - down')
})

test('#257 a pick answer is the vanilla layout, and it reads back', () => {
  const answer = buildPickAnswer({ name: 'sky' })
  // Identifier id, VarInt length of the payload, then the payload: an END tag for
  // "no additions". The library's own writer omits the length prefix.
  assert.equal(answer[0], 0x08, 'configuration custom_click_action')
  assert.equal(answer[1], 'monoplayer:pick/sky'.length)
  assert.equal(answer.at(-2), 0x01, 'payload length 1')
  assert.equal(answer.at(-1), 0x00, 'an END tag, which is an absent payload')
  assert.deepEqual(readPickAction(answer), { id: 'monoplayer:pick/sky', slug: 'sky' })
})

test('#257 the reader takes the id and nothing else', () => {
  // Another dialog's action is not a pick.
  const other = buildPickAnswer({ name: 'sky' })
  other.write('other:pick/sky', 1)
  assert.equal(readPickAction(other), null)
  // The play-state packet id is not a pick either.
  const play = buildPickAnswer({ name: 'sky' })
  play[0] = 0x44
  assert.equal(readPickAction(play), null)
  // A truncated frame is refused rather than half-read.
  assert.equal(readPickAction(buildPickAnswer({ name: 'sky' }).subarray(0, 5)), null)
  assert.equal(readPickAction(Buffer.alloc(0)), null)
  assert.equal(readPickAction('not a buffer'), null)
  // A frame with no namespace is not ours.
  const bare = Buffer.from([0x08, 0x04, 0x73, 0x6b, 0x79, 0x01, 0x00])
  assert.equal(readPickAction(bare), null)
})

test('#257 a library-shaped click is not read as a pick', () => {
  // The library's schema has no length prefix: id bytes then a 0x00 "option
  // absent" byte. Its first id byte is read as the length, so the frame cannot be
  // a pick, and the reader says so instead of guessing.
  const id = Buffer.from('monoplayer:pick/sky', 'utf8')
  const library = Buffer.concat([Buffer.from([0x08, id.length]), id.subarray(1), Buffer.from([0x00])])
  assert.equal(readPickAction(library), null)
})

test('#257 the refusal says what happened, and names the server', () => {
  assert.match(pickRefusalText({ server: 'sky' }), /sky/)
  assert.match(pickRefusalText({ server: null }), /that server/)
  assert.match(pickRefusalText({}), /cannot connect a body yet/)
})

test('#257 rows keep the name the config gave and the slug the wire takes', () => {
  assert.deepEqual(pickerRows([{ name: 'gate-paper:25565', state: 'down' }]), [{
    name: 'gate-paper:25565',
    state: 'down',
    driver: null,
    slug: 'gate-paper_25565',
    id: 'monoplayer:pick/gate-paper_25565'
  }])
  assert.deepEqual(pickerRows([]), [])
})

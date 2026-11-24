// #257: the picker's dialog and its answer. The dialog is Minecraft's own
// multi_action shape, and the answer is the vanilla frame layout, which
// minecraft-data does not describe: the library's writer omits the payload's
// length prefix, so a test that feeds the codec a pre-decoded object proves
// nothing about the wire.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PICK_ACTION_TYPE,
  PICK_DIALOG_TYPE,
  PICK_NAMESPACE,
  PICK_VERBS,
  buildPickAnswer,
  claimFailureText,
  claimRestoreTitle,
  pickIdFor,
  pickRefusalText,
  pickTarget,
  pickSlug,
  pickerDialog,
  pickerDialogParams,
  pickerLabel,
  pickerRows,
  readPickAction,
  readServerAction,
  serverActionProblemText,
  serverDialog,
  serverDialogParams,
  verbIdFor,
  verbRefusalText
} from '../../src/core/picker.js'
import { buildCustomClickAction } from '../../src/core/dialog-codec.js'

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
  // field's own value. The play state wraps it in a holder's data branch.
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

// ---- #266: the second level, the server's own dialog ----

const server = { name: 'gate-paper:25565', state: 'down', driver: null }

// The frame a client sends for one verb. The writer is the one the protocol bot
// uses (src/core/dialog-codec.js). The reader is therefore proven against the bytes
// a client-like sender really puts on the wire, and not against a fixture this test
// chose.
const clickFor = (id, state = 'configuration') => buildCustomClickAction({ state, id })

test('#258 a picker row names the address a claim lands the client on', () => {
  assert.deepEqual(pickTarget('gate-paper:25565'), { host: 'gate-paper', port: 25565 })
  assert.deepEqual(pickTarget('127.0.0.1:25566'), { host: '127.0.0.1', port: 25566 })
  // A bracketed IPv6 address keeps its colons and loses its brackets: the socket
  // layer takes the address, not the URL form.
  assert.deepEqual(pickTarget('[::1]:25565'), { host: '::1', port: 25565 })
  // Everything that is not an address is refused rather than guessed at. A row
  // that dialled a host called "paper" would hide a bad config behind a hang.
  assert.equal(pickTarget('paper'), null)
  assert.equal(pickTarget('paper:'), null)
  assert.equal(pickTarget(':25565'), null)
  assert.equal(pickTarget('paper:not-a-port'), null)
  assert.equal(pickTarget('paper:0'), null)
  assert.equal(pickTarget('paper:70000'), null)
  assert.equal(pickTarget(''), null)
  assert.equal(pickTarget(null), null)
})

test('#258 the picker a refused landing returns to names the body that did not answer', () => {
  assert.equal(claimRestoreTitle({ server: 'paper:25565' }), 'Choose a server - paper:25565 did not answer')
  assert.equal(claimRestoreTitle({}), 'Choose a server - that server did not answer')
  // The one case a client is ended rather than offered the list again says what
  // happened without repeating the title's words.
  assert.equal(claimFailureText({ server: 'paper:25565' }),
    'Monoplayer: paper:25565 accepted the connection and could not be entered.')
  assert.equal(claimFailureText({}), 'Monoplayer: that server accepted the connection and could not be entered.')
})

test('#258 a row with no address is offered and cannot be landed', () => {
  const [row] = pickerRows([{ name: 'sky', state: 'down' }])
  assert.equal(pickTarget(row.name), null)
  // The label and the id still work: a lane that offers a row it cannot dial
  // refuses the claim, and the picker still shows it.
  assert.equal(row.id, PICK_NAMESPACE + '/sky')
})

test('#266 the server dialog offers claim, spectate and disconnect', () => {
  const dialog = serverDialog({ server })
  const value = dialog.value
  assert.equal(value.type.value, PICK_DIALOG_TYPE)
  // The title names the server and its state, the same words the picker's button
  // carried, so the client knows which server it is answering for.
  assert.equal(value.title.value, 'gate-paper:25565 - down')
  assert.deepEqual(value.can_close_with_escape, { type: 'byte', value: 0 })
  const buttons = value.actions.value.value
  assert.equal(buttons.length, 3)
  assert.deepEqual(buttons.map(button => button.label.value), ['Claim', 'Spectate', 'Disconnect'])
  assert.deepEqual(buttons.map(button => button.action.value.id.value), [
    'monoplayer:claim/gate-paper_25565',
    'monoplayer:spectate/gate-paper_25565',
    'monoplayer:disconnect/gate-paper_25565'
  ])
  // Same action type as the picker's buttons: a custom action is clickable in the
  // configuration phase, and a command action is inert there.
  for (const button of buttons) assert.equal(button.action.value.type.value, PICK_ACTION_TYPE)
  // A claimed server's dialog says who holds it.
  const claimed = serverDialog({ server: { name: 'sky', state: 'claimed', driver: 'Bafbi' } })
  assert.equal(claimed.value.title.value, 'sky - claimed (Bafbi)')
  assert.equal(serverDialogParams({ server }).dialog.type, 'compound')
})

test('#266 a verb answer carries the verb and the server, and reads back', () => {
  for (const verb of PICK_VERBS) {
    const action = readServerAction(clickFor(verbIdFor(verb, 'gate-paper:25565')))
    assert.equal(action.ok, true, verb)
    assert.equal(action.verb, verb)
    assert.equal(action.slug, 'gate-paper_25565')
    assert.equal(action.id, 'monoplayer:' + verb + '/gate-paper_25565')
  }
  // The play-state packet id is not this conversation.
  assert.equal(readServerAction(clickFor(verbIdFor('claim', 'sky'), 'play')).reason, 'not_a_click')
  assert.equal(readServerAction(Buffer.alloc(0)).reason, 'not_a_click')
  assert.equal(readServerAction('not a buffer').reason, 'not_a_click')
  // A truncated frame is refused rather than half-read.
  assert.equal(readServerAction(clickFor(verbIdFor('claim', 'sky')).subarray(0, 6)).reason, 'not_a_click')
})

test('#266 an unknown verb is refused, and the sentence names it', () => {
  const action = readServerAction(clickFor('monoplayer:teleport/gate-paper_25565'))
  assert.equal(action.ok, false)
  assert.equal(action.reason, 'unknown_verb')
  assert.equal(action.verb, 'teleport')
  assert.equal(action.slug, 'gate-paper_25565')
  const text = serverActionProblemText(action)
  assert.match(text, /teleport/)
  assert.match(text, /claim, spectate and disconnect/)
})

test('#266 a malformed verb id is refused, and the sentence names what is wrong', () => {
  const noServer = readServerAction(clickFor('monoplayer:claim'))
  assert.equal(noServer.ok, false)
  assert.equal(noServer.reason, 'malformed')
  assert.match(serverActionProblemText(noServer), /names no server/)

  const emptySlug = readServerAction(clickFor('monoplayer:claim/'))
  assert.equal(emptySlug.reason, 'malformed')
  assert.match(serverActionProblemText(emptySlug), /names no server/)

  // A click from another dialog is not one this lane can act on, and it is not
  // guessed at either.
  const foreign = readServerAction(clickFor('other:dialog/exit'))
  assert.equal(foreign.ok, false)
  assert.equal(foreign.reason, 'unknown_id')
  assert.match(serverActionProblemText(foreign), /other:dialog\/exit/)
})

test('#266 a pick is not a verb click, so the caller must read the pick first', () => {
  // The pick namespace is not a verb namespace: read in the wrong order, a level-one
  // answer would be refused as an unknown verb. The leg reads the pick first, and
  // this test pins the reason that order is load bearing.
  const action = readServerAction(buildPickAnswer({ name: 'sky' }))
  assert.equal(action.ok, false)
  assert.equal(action.reason, 'unknown_verb')
  assert.equal(action.verb, 'pick')
})

test('#266 a verb this lane cannot carry is refused in words that name it', () => {
  assert.match(verbRefusalText({ verb: 'claim', server: 'gate-paper:25565' }), /claim/)
  assert.match(verbRefusalText({ verb: 'claim', server: 'gate-paper:25565' }), /gate-paper:25565/)
  assert.match(verbRefusalText({ verb: 'spectate', server: 'sky' }), /spectate/)
  // Every refusal says it is the lane, not the client, that cannot go further.
  assert.match(verbRefusalText({ verb: 'claim', server: 'sky' }), /cannot/)
})

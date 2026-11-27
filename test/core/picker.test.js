// #257: the picker's dialog and its answer. The dialog is Minecraft's own
// multi_action shape, and the answer is the vanilla frame layout, which
// minecraft-data does not describe: the library's writer omits the payload's
// length prefix, so a test that feeds the codec a pre-decoded object proves
// nothing about the wire.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createChannels, CHANNEL_ROLES } from '../../src/core/channels.js'
import { createClaims } from '../../src/core/claims.js'
import {
  PICK_ACTION_TYPE,
  PICK_DIALOG_TYPE,
  PICK_NAMESPACE,
  PICK_VERBS,
  buildPickAnswer,
  claimFailureText,
  claimRestoreTitle,
  createPickerBoard,
  disconnectRefusalText,
  pickEmptyText,
  pickIdFor,
  pickRefusalText,
  pickTarget,
  pickSlug,
  pickerDialog,
  pickerDialogParams,
  pickerLabel,
  pickerOfferedRows,
  pickerRowForBody,
  pickerRows,
  readPickAction,
  readServerAction,
  serverActionProblemText,
  spectateRefusalText,
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

// #259: a player choosing a body wants two facts beyond its name: who they would
// sit beside, and whether they would sit alone. The driver rides in brackets after
// the state, and the spectators after that, so the three read in the order a player
// asks them. A row nobody watches says so by saying nothing.
test('#259 the label names the spectators, and only when somebody is watching', () => {
  assert.equal(pickerLabel({ name: 'sky', state: 'claimed', driver: 'Bafbi', spectators: 1 }),
    'sky - claimed (Bafbi), 1 watching')
  assert.equal(pickerLabel({ name: 'sky', state: 'claimed', driver: 'Bafbi', spectators: 3 }),
    'sky - claimed (Bafbi), 3 watching')
  assert.equal(pickerLabel({ name: 'sky', state: 'unclaimed', spectators: 2 }), 'sky - unclaimed, 2 watching')
  assert.equal(pickerLabel({ name: 'sky', state: 'down', spectators: 0 }), 'sky - down')
  assert.equal(pickerLabel({ name: 'sky', state: 'down', spectators: null }), 'sky - down')
  // A count that is not a count is not written into a dialog a player reads.
  assert.equal(pickerLabel({ name: 'sky', state: 'down', spectators: 'two' }), 'sky - down')
})

// #259: a row is composed from what the lane knows about the body it names. The
// state answers the question a player asks first, can I get in, so a claim on a
// body that is not up does not make the row read claimed.
test('#259 a row reads the body it names, and a claim on a down body names nobody', () => {
  const row = {
    name: 'sky:25565',
    state: 'down',
    driver: null,
    spectators: 0,
    slug: 'sky_25565',
    id: 'monoplayer:pick/sky_25565'
  }
  assert.deepEqual(pickerRowForBody(row, { up: true, driver: 'Bafbi', spectators: 2 }), {
    ...row, state: 'claimed', driver: 'Bafbi', spectators: 2
  })
  assert.equal(pickerLabel(pickerRowForBody(row, { up: true, driver: 'Bafbi', spectators: 2 })),
    'sky:25565 - claimed (Bafbi), 2 watching')
  assert.deepEqual(pickerRowForBody(row, { up: true }), { ...row, state: 'unclaimed', driver: null })
  // A claim outlives a dial that failed (#295): the body is down, so the row says
  // so and names no driver.
  assert.deepEqual(pickerRowForBody(row, { up: false, driver: 'Bafbi', spectators: 3 }), {
    ...row, state: 'down', driver: null, spectators: 3
  })
  // A count that is not a count is not written into a dialog a player reads, and a
  // name that is not a name names nobody.
  assert.equal(pickerRowForBody(row, { up: true, spectators: 'two' }).spectators, 0)
  assert.equal(pickerRowForBody(row, { up: true, driver: '' }).driver, null)
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
  assert.equal(pickRefusalText({ server: 'sky' }), 'Monoplayer: sky could not be offered on this lane.')
})

// #315: a lane that offers nothing tells the client about the lane. The client
// clicked nothing, so a sentence about a server names a choice nobody made, and one
// it cannot make again. The operator's half of the same fact is the offer's log line,
// which carries the reason the list is empty (src/service/start-live.js).
test('#315 a lane with no list refuses the join in a sentence about the lane', () => {
  assert.equal(pickEmptyText(), 'Monoplayer: this lane is not offering any server to join.')
  assert.doesNotMatch(pickEmptyText(), /that server/)

  // A dialog this leg could not write is the lane's too: the servers exist and none of
  // them reached the client. It is a different fact from an empty list, so it keeps a
  // sentence of its own.
  assert.equal(pickRefusalText({ server: null }), 'Monoplayer: this lane could not show its server list.')
  assert.equal(pickRefusalText({}), 'Monoplayer: this lane could not show its server list.')
})

// #265: the name a row is offered under is the address its claim dials, so a
// name that is already canonical is left alone.
test('#257 rows keep the name the config gave and the slug the wire takes', () => {
  assert.deepEqual(pickerRows([{ name: 'gate-paper:25565', state: 'down' }]), [{
    name: 'gate-paper:25565',
    state: 'down',
    driver: null,
    spectators: 0,
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

// #259: the sentence a spectator is refused with. Each reason asks the player for
// something different, so each has its own sentence, and a body nobody drives is
// no longer among them: a body with no driver is watchable.
test('#259 every reason a spectator is refused with says what to do about it', () => {
  assert.match(spectateRefusalText({ reason: 'no_body', server: 'sky' }), /nobody is on sky/)
  assert.match(spectateRefusalText({ reason: 'no_body', server: 'sky' }), /Claim it/)
  assert.match(spectateRefusalText({ reason: 'body_not_served', server: 'sky' }), /not serving sky/)
  assert.match(spectateRefusalText({ reason: 'body_not_warm', server: 'sky' }), /still connecting/)
  assert.match(spectateRefusalText({ reason: 'body_down', server: 'sky' }), /sky is down/)
  assert.match(spectateRefusalText({ reason: 'body_down', server: 'sky' }), /Claim it/)
  assert.match(spectateRefusalText({ reason: 'picker_off', server: 'sky' }), /cannot be watched on this lane/)
  assert.match(spectateRefusalText({ reason: null }), /cannot be watched right now/)
  // A spectator is never told the body has no driver, because that is not a refusal.
  assert.equal(spectateRefusalText({ reason: 'no_claim', server: 'sky' }),
    'Monoplayer: sky cannot be watched right now.', 'no reason claims a body must be driven first')
})

// #261: the sentence a claimed body refuses a disconnect with. The driver is the
// one fact the client needs: the body is theirs until their connection ends, so
// the client can ask them or wait.
test('#261 a disconnect on a claimed body is refused in a sentence naming the driver', () => {
  const text = disconnectRefusalText({ server: 'sky', driver: 'Bafbi' })
  assert.match(text, /sky is claimed by Bafbi/)
  assert.match(text, /cannot be disconnected/)
  assert.match(text, /while nobody claims it/)
  // A claim recorded without a name is still named as a player, because a
  // sentence with a hole in it reads as a bug in the lane.
  assert.match(disconnectRefusalText({ server: 'sky', driver: null }), /claimed by another player/)
  assert.match(disconnectRefusalText({ server: null, driver: 'Bafbi' }), /that server is claimed by Bafbi/)
})

// ---- #265: the allowed-server list, and a row's canonical name ----

test('#265 a row is offered under the canonical address its claim dials', () => {
  // #260 keys a body's cache by pickSlug(host + ':' + port) of the dial. A claim
  // labels its body by pickSlug(row.name). A row whose name spells the same address
  // another way would give one server two body ids. So the row is normalised where
  // it is read: one cache, one claim, one server.
  const [port] = pickerRows([{ name: 'paper:025565', state: 'down' }])
  assert.equal(port.name, 'paper:25565')
  assert.deepEqual(pickTarget(port.name), { host: 'paper', port: 25565 })
  assert.equal(port.slug, pickSlug('paper:25565'))
  assert.equal(port.id, pickIdFor('paper:25565'))

  // The name reads back to the address a socket takes, so a bracketed IPv6 row
  // stays bracketed and its slug does not carry a second colon.
  const [six] = pickerRows([{ name: '[::1]:025565', state: 'down' }])
  assert.equal(six.name, '[::1]:25565')
  assert.deepEqual(pickTarget(six.name), { host: '::1', port: 25565 })
  assert.equal(six.slug, pickSlug('[::1]:25565'))

  // A host keeps the case the operator wrote: pickSlug lowercases, so two cases
  // are already one body id.
  const [dns] = pickerRows([{ name: 'Paper.Excalia.FR:25565', state: 'down' }])
  assert.equal(dns.name, 'Paper.Excalia.FR:25565')
  assert.equal(dns.slug, pickSlug('paper.excalia.fr:25565'))

  // A name that names no address is offered as it was written. It is refused at
  // the claim, in words, rather than rewritten into a guess.
  const [notAddress] = pickerRows([{ name: 'sky', state: 'down' }])
  assert.equal(notAddress.name, 'sky')
  assert.equal(pickTarget(notAddress.name), null)
})

test('#265 the picker offers the allowed-server list, and says which file answered', () => {
  // The shape src/service/control.js answers with: the servers, and the file that
  // answered. The rows are the picker's own vocabulary. Their names are addresses,
  // because a claim dials the row it names.
  const control = pickerOfferedRows(() => ({
    servers: [{ host: 'paper', port: 25565 }, { host: '127.0.0.1', port: 25566 }],
    source: 'control'
  }))
  assert.deepEqual(control, {
    source: 'control',
    reason: null,
    rows: [
      { name: 'paper:25565', state: 'down', driver: null, spectators: 0 },
      { name: '127.0.0.1:25566', state: 'down', driver: null, spectators: 0 }
    ]
  })

  // The seed answers when the live file cannot, and the source says so.
  assert.deepEqual(pickerOfferedRows(() => ({ servers: [{ host: 'sky', port: 25565 }], source: 'seed' })), {
    source: 'seed',
    reason: null,
    rows: [{ name: 'sky:25565', state: 'down', driver: null, spectators: 0 }]
  })

  // A lane with no allowed-server key offers nothing, and says that too rather
  // than inventing the configured backend.
  assert.deepEqual(pickerOfferedRows(null), { source: 'none', reason: null, rows: [] })
  // #315: the reason an empty list is empty travels with the offer, so the log line
  // that says "nothing offered" also says what to edit. The picker does not invent
  // one: a reader that reports no reason leaves it null.
  assert.deepEqual(pickerOfferedRows(() => ({ servers: [], source: 'none', reason: 'no_key' })),
    { source: 'none', reason: 'no_key', rows: [] })
  assert.deepEqual(pickerOfferedRows(() => ({ servers: [], source: 'none' })), { source: 'none', reason: null, rows: [] })
  // A reader that answers with no list is the broken-file case: the picker has
  // nothing to offer, and no throw reaches the join.
  assert.deepEqual(pickerOfferedRows(() => ({ servers: null, source: 'none', reason: 'unreadable' })),
    { source: 'none', reason: 'unreadable', rows: [] })
})

// ---- #595: the picker's decisions leave the socket adapter ----
//
// Seam: `offer`. The decision it owns is whether a row reads as the body this lane
// is serving, and a shipped bug got it wrong (#316: a row read `down` while a body
// on it was driven). Until now it was reachable only over a socket. O55 to O65 could
// not have caught it without a driver, a claim and a body at once, and a unit test
// could not reach it at all.
test('#595 an offer reads each row as the body this lane is serving (#316)', () => {
  const claims = createClaims()
  const channels = createChannels()
  claims.claim({ body: 'sky_25565', server: 'sky:25565', holder: 'conn-1', name: 'Bafbi', at: 1 })
  channels.open({ id: 'watch-1', body: 'sky_25565', role: CHANNEL_ROLES.SPECTATOR, at: 2 })
  channels.open({ id: 'watch-2', body: 'sky_25565', role: CHANNEL_ROLES.SPECTATOR, at: 3 })
  channels.open({ id: 'drive-1', body: 'nether_25565', role: CHANNEL_ROLES.DRIVER, at: 4 })

  const rows = createPickerBoard({ claims, channels }).offer({
    rows: [{ name: 'sky:25565' }, { name: 'nether:25565' }],
    served: { body: 'sky_25565', up: true }
  })

  assert.deepEqual(rows.map(({ name, state, driver, spectators }) => [name, state, driver, spectators]), [
    ['sky:25565', 'claimed', 'Bafbi', 2],
    ['nether:25565', 'down', null, 0]
  ])
  // The name is normalised here, where every row a lane offers is read, so the slug
  // and the id a click carries come from the address the claim dials (#265).
  assert.equal(rows[0].slug, 'sky_25565')
  assert.equal(rows[0].id, PICK_NAMESPACE + '/sky_25565')
})

test('#595 an offer names nobody on a body that is not up, and counts only watchers (#295, #259)', () => {
  const claims = createClaims()
  const channels = createChannels()
  claims.claim({ body: 'sky_25565', server: 'sky:25565', holder: 'conn-1', name: 'Bafbi', at: 1 })
  channels.open({ id: 'watch-1', body: 'sky_25565', role: CHANNEL_ROLES.SPECTATOR, at: 2 })
  channels.open({ id: 'drive-1', body: 'sky_25565', role: CHANNEL_ROLES.DRIVER, at: 3 })

  const [down] = createPickerBoard({ claims, channels }).offer({
    rows: [{ name: 'sky:25565' }],
    served: { body: 'sky_25565', up: false }
  })
  // A claim outlives a dial that failed, and a row is what a client can enter.
  assert.equal(down.state, 'down')
  assert.equal(down.driver, null, 'a claim on a down body names nobody')
  assert.equal(down.spectators, 1, 'a driver channel on the body is not a watcher')

  const [up] = createPickerBoard().offer({
    rows: [{ name: 'sky:25565' }],
    served: { body: 'sky_25565', up: true }
  })
  assert.equal(up.state, 'unclaimed')

  // A lane whose session serves nothing has every row down, and an offer of no rows
  // is no rows rather than a row invented to fill the dialog.
  const [nothing] = createPickerBoard().offer({ rows: [{ name: 'sky:25565' }] })
  assert.equal(nothing.state, 'down')
  assert.deepEqual(createPickerBoard().offer({ rows: [] }), [])
})

test('#595 a click reads as what it means, or as why it cannot be acted on (#266)', () => {
  const board = createPickerBoard()
  const rows = board.offer({ rows: [{ name: 'sky:25565' }], served: { body: 'sky_25565', up: true } })

  // The pick is read before the verb, because the two namespaces are told apart by
  // the id and a pick read as a verb is an unknown verb.
  const pick = board.click({ buffer: buildPickAnswer({ name: 'sky:25565' }), rows })
  assert.equal(pick.kind, 'pick')
  assert.equal(pick.slug, 'sky_25565')
  assert.equal(pick.row.name, 'sky:25565')

  const verb = board.click({ buffer: clickFor(verbIdFor('spectate', 'sky:25565')), rows })
  assert.equal(verb.kind, 'verb')
  assert.equal(verb.verb, 'spectate')
  assert.equal(verb.slug, 'sky_25565')

  // A dialog older than the list it came from names a server this lane does not
  // offer, at either level.
  const stalePick = board.click({ buffer: buildPickAnswer({ name: 'nether:25565' }), rows })
  assert.equal(stalePick.kind, 'refuse')
  assert.equal(stalePick.reason, 'unknown_server')
  assert.equal(stalePick.row, null)
  const staleVerb = board.click({ buffer: clickFor(verbIdFor('claim', 'nether:25565')), rows })
  assert.equal(staleVerb.reason, 'unknown_server')
  // The sentence is the stale server's, whatever verb the frame named: the dialog is
  // older than the list, so no claim or disconnect on that body happened. A verb
  // left in the answer must not pull the sentence into the verb's family.
  for (const verb of ['claim', 'spectate', 'disconnect']) {
    assert.equal(
      board.refuse({ reason: 'unknown_server', verb, id: 'monoplayer:' + verb + '/nether_25565' }),
      'Monoplayer: "monoplayer:' + verb + '/nether_25565" names no server this lane offers.',
      verb
    )
  }

  // Not a click this lane can read at all is not a refusal: the dialog stays up.
  assert.equal(board.click({ buffer: Buffer.alloc(0), rows }).kind, 'ignore')
  assert.equal(board.click({ buffer: null, rows }).kind, 'ignore')

  // A verb id that does not read is refused with the reason its sentence names.
  assert.equal(board.click({ buffer: clickFor('monoplayer:claim'), rows }).reason, 'malformed')
  assert.equal(board.click({ buffer: clickFor('monoplayer:teleport/sky_25565'), rows }).reason, 'unknown_verb')
  assert.equal(board.click({ buffer: clickFor('other:dialog/exit'), rows }).reason, 'unknown_id')
})

test('#595 a disconnect on a held body is refused where the order is decided (#261)', () => {
  const claims = createClaims()
  claims.claim({ body: 'sky_25565', server: 'sky:25565', holder: 'conn-1', name: 'Bafbi', at: 1 })
  const board = createPickerBoard({ claims })
  const rows = board.offer({ rows: [{ name: 'sky:25565' }], served: { body: 'sky_25565', up: true } })

  const held = board.click({ buffer: clickFor(verbIdFor('disconnect', 'sky:25565')), rows })
  // The click stays a verb the lane was asked for, and the claim that refuses it
  // rides with the answer: the leg records the verb before it answers it (#261).
  assert.equal(held.kind, 'verb')
  assert.equal(held.verb, 'disconnect')
  assert.equal(held.held.name, 'Bafbi', 'the answer names the player who holds the body')
  assert.equal(held.held.holder, 'conn-1')
  assert.equal(
    board.refuse({ verb: 'disconnect', reason: 'disconnect_claimed', server: held.row.name, driver: held.held.name }),
    'Monoplayer: sky:25565 is claimed by Bafbi, so it cannot be disconnected. ' +
      'A body can only be disconnected while nobody claims it.'
  )

  // The same click on a body nobody holds is the act, and a claim is recorded by
  // the leg: the board decides, and it does not write.
  const free = createPickerBoard().click({ buffer: clickFor(verbIdFor('disconnect', 'sky:25565')), rows })
  assert.equal(free.kind, 'verb')
  assert.equal(free.verb, 'disconnect')
  assert.equal(free.row.slug, 'sky_25565')
  assert.equal(free.held, null, 'a body nobody holds carries no claim to refuse it')
})

test('#595 every refusal reason reaches one sentence, chosen in one place (#542)', () => {
  const board = createPickerBoard()

  // A click this lane cannot read names the id and the part that did not read.
  assert.match(board.refuse({ reason: 'unknown_verb', id: 'monoplayer:teleport/sky_25565', verb: 'teleport' }), /teleport/)
  assert.match(board.refuse({ reason: 'unknown_verb', id: 'monoplayer:teleport/sky_25565', verb: 'teleport' }),
    /claim, spectate and disconnect/)
  assert.match(board.refuse({ reason: 'malformed', id: 'monoplayer:claim' }), /names no server/)
  assert.match(board.refuse({ reason: 'unknown_id', id: 'other:dialog/exit' }), /other:dialog\/exit/)

  // The lane's own two sentences: it has no list, and it could not show the one it
  // has. A client clicked nothing in the first case, so the sentence is about the
  // lane (#315).
  assert.equal(board.refuse({ reason: 'empty_offer' }), pickEmptyText())
  assert.equal(board.refuse({ reason: 'picker_unavailable' }), pickRefusalText({ server: null }))
  assert.equal(board.refuse({ reason: 'picker_unavailable', server: 'sky' }), pickRefusalText({ server: 'sky' }))
  assert.equal(board.refuse({ reason: 'unknown_server', id: 'monoplayer:pick/sky_25565' }),
    'Monoplayer: "monoplayer:pick/sky_25565" names no server this lane offers.')

  // Each verb's refusals are the verb's family, and the reason picks the sentence
  // inside it. A claim names the holder, a disconnect names the driver, a Spectate
  // names what to do about the body.
  assert.match(board.refuse({ verb: 'claim', reason: 'body_claimed', server: 'sky', holder: 'Bafbi' }),
    /sky is already claimed by Bafbi/)
  assert.match(board.refuse({ verb: 'claim', reason: 'claim_held', server: 'sky', claimed: 'nether' }),
    /already hold a claim on nether/)
  // #708: a claim the lane granted and whose landing lost the phase-end write is the
  // claim family's, and its sentence is the one the claim landing used to compose —
  // `claimFailureText` — character for character, because the client is told it (#258).
  for (const server of ['sky:25565', null]) {
    assert.equal(board.refuse({ verb: 'claim', reason: 'finish_failed', server }),
      claimFailureText({ server }),
      'the claim family answers a lost landing with the landing\'s own sentence')
  }
  assert.match(board.refuse({ verb: 'disconnect', reason: 'disconnect_claimed', server: 'sky', driver: 'Bafbi' }),
    /sky is claimed by Bafbi, so it cannot be disconnected/)
  assert.match(board.refuse({ verb: 'spectate', reason: 'no_body', server: 'sky' }), /nobody is on sky/)
  assert.match(board.refuse({ verb: 'spectate', reason: 'body_down', server: 'sky' }), /Claim it to bring it back/)

  // #435: the three reasons a Spectate is refused with after the body's answer
  // allowed it are refused in the Spectate family, one sentence each, and none of
  // them falls into another family's words.
  // #542 is open: none of the three has a sentence of its own yet, so each gets the
  // family's default today. The words are pinned here, so the ticket that gives them
  // their own sentences changes this assertion and nothing else.
  for (const reason of ['channel_refused', 'no_cached_configuration', 'finish_failed']) {
    const text = board.refuse({ verb: 'spectate', reason, server: 'sky' })
    assert.equal(text, 'Monoplayer: sky cannot be watched right now.', reason)
    assert.doesNotMatch(text, /claim|disconnect/, reason)
  }

  // A verb no lane carries is refused in words that name the verb, whatever the
  // reason the caller had.
  assert.match(board.refuse({ verb: 'teleport', server: 'sky' }), /asked for teleport/)
  assert.match(board.refuse({ verb: 'teleport', server: 'sky' }), /cannot carry a teleport yet/)
})

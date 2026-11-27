// #720: one client held in the picker, its screen read, its row pressed, its Spectate pressed.
//
// #678 settled the class tree from the 26.2 client's own code (test/driver/picker-click.test.js)
// and #720 is the run that puts a client in front of it. The run cannot be a gate rung: the
// client lives on the display host. What this file holds is the half a machine can hold without
// a client — that the runner asks the client screen for what src/core/picker.js composed, and
// reads the front's log for what the front writes.
//
// The four defects it exists to catch, each of which reads as "no button matched" or as a green
// run with nothing in it:
//
//   - a needle of '' matches the first button, because every label contains the empty string
//     (DriverServer.clickButton, tools/driver/src/main/java/eu/monoplayer/driver/DriverServer.java)
//   - the click's own `screen` field is read before the next dialog is drawn, so it names the
//     successor of the dialog pressed and not the screen the run must read next (#720, comment 2),
//     which is why no row here is judged from it
//   - the front's log is read over a window, so a second attempt inside that window answers with the
//     first attempt's pick unless the read is floored at the moment this run started
//   - a screen payload that is not a dialog is a finding about the client, not a crash in the
//     runner, so the row records the class it read
//   - three payloads cannot tell "no frame arrived" from "a frame arrived that was not a pick".
//     The front's log is the third read, and `pickerPickIgnored` is the difference
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickerDialog, serverDialog, pickSlug } from '../../src/core/picker.js'
import {
  PICKER_SCREEN,
  nameOfLabel,
  stateOfLabel,
  rowIn,
  VERB_LABELS,
  judgeHeld,
  judgeLevelOne,
  judgeLevelTwo,
  judgePress,
  judgeAfterSpectate,
  frontReading,
  judgeFront,
  judgeFrontVerb
} from '../../tools/driver/picker-read.mjs'

const ROW = { name: 'paper.monoplayer-dev.svc.cluster.local:25565', state: 'down' }

// A dialog as NBT, read the way the client reads it: the button labels are what the mod's
// `widgetRows` reports as `label`, so a fixture built here is the payload the run gets.
const labelsOf = dialog => dialog.value.actions.value.value.map(button => button.label.value)
const titleOf = dialog => dialog.value.title.value

// The `screen` payload the mod answers, from the dialog the front wrote. Every field the runner
// reads is here: the class, the title, and one row per button.
function screenOf (dialog) {
  return {
    screen: PICKER_SCREEN,
    title: titleOf(dialog),
    narration: titleOf(dialog),
    buttons: labelsOf(dialog).map((label, index) => ({
      label, active: true, visible: true, x: 100, y: 100 + index * 30, width: 200, height: 20
    }))
  }
}

test('the picker\'s own dialog is what the client draws, and its buttons are the row labels', () => {
  const dialog = pickerDialog({ rows: [ROW] })
  const screen = screenOf(dialog)
  assert.deepEqual(screen.buttons.map(button => button.label), labelsOf(dialog))
  const row = judgeLevelOne(screen, { needle: 'paper.monoplayer-dev', state: 'down' })
  assert.equal(row.ok, true, row.because ?? row.read)
  // The label the run presses is the one the screen reported, whole, and not a needle: a
  // substring is what the mod matches, and the report has to say which button it meant.
  assert.equal(rowIn(screen, 'paper.monoplayer-dev'), labelsOf(dialog)[0])
  assert.match(titleOf(dialog), /^Choose a server$/)
  assert.equal(nameOfLabel(labelsOf(dialog)[0]), ROW.name)
  assert.equal(stateOfLabel(labelsOf(dialog)[0]), 'down')
  assert.equal(pickSlug(nameOfLabel(labelsOf(dialog)[0])), 'paper.monoplayer-dev.svc.cluster.local_25565')
})

test('an empty needle is refused, because the empty string matches the first button', () => {
  // driver-client.mjs joins its arguments into `label`, so `click` with none sends `label: ""`
  // (#720, comment 2). A runner that did the same would press whatever came first and record it
  // as the row it meant.
  const screen = screenOf(pickerDialog({ rows: [ROW, { name: 'other:25565', state: 'down' }] }))
  assert.equal(rowIn(screen, ''), null)
  const row = judgeLevelOne(screen, { needle: '', state: 'down' })
  assert.equal(row.ok, false)
  assert.match(row.because, /labels?/)
})

test('a needle that matches no row is a finding, and the row names what the screen held', () => {
  const screen = screenOf(pickerDialog({ rows: [ROW] }))
  const row = judgeLevelOne(screen, { needle: 'paper.other-lane', state: 'down' })
  assert.equal(row.ok, false)
  assert.match(row.read, /paper\.monoplayer-dev\.svc\.cluster\.local:25565 - down/)
})

test('the level-two screen is that server\'s own dialog, titled with the row it came from', () => {
  const second = serverDialog({ server: { ...ROW, state: 'unclaimed' } })
  const screen = screenOf(second)
  const row = judgeLevelTwo(screen, { label: titleOf(second) })
  assert.equal(row.ok, true, row.because ?? row.read)
  // The labels are src/core/picker.js's, read out of the dialog the front writes, so this file does
  // not hold a second copy that drifts when a verb is renamed.
  assert.deepEqual(screen.buttons.map(button => button.label), VERB_LABELS)
  const withoutSpectate = { ...screen, buttons: screen.buttons.filter(button => button.label !== 'Spectate') }
  assert.equal(judgeLevelTwo(withoutSpectate, { label: titleOf(second) }).ok, false)
  // The level one title is not the level two title: a run that read the first dialog twice
  // would pass a check that only asked for a dialog.
  assert.equal(judgeLevelTwo(screenOf(pickerDialog({ rows: [ROW] })), { label: titleOf(second) }).ok, false)
})

test('a screen that is not the dialog is a row that records the class it read', () => {
  const title = screenOf(pickerDialog({ rows: [ROW] }))
  const row = judgeLevelOne({ screen: 'net.minecraft.client.gui.screens.TitleScreen', title: title.title, buttons: [] },
    { needle: 'paper.monoplayer-dev', state: 'down' })
  assert.equal(row.ok, false)
  assert.match(row.read, /TitleScreen/)
  assert.match(row.because, new RegExp(PICKER_SCREEN.split('.').pop()))
})

test('the press reports itself, and the press after a refusal is a screen that is no longer the dialog', () => {
  const click = { ok: true, data: { labels: ['Claim', 'Spectate', 'Disconnect'], clicked: true, label: 'Spectate' } }
  assert.equal(judgePress(click, { label: 'Spectate', id: 'spectate-press' }).ok, true)
  // A press that landed on another button is a finding: a needle that matched more than one
  // label would press whichever came first in the children list.
  assert.equal(judgePress(click, { label: 'Claim', id: 'spectate-press' }).ok, false)
  // The mod reads `screen` inside the press, so it names the successor and not the next dialog.
  // What the run needs is that the dialog is gone, and the sentence the client was told.
  const after = judgeAfterSpectate({
    screen: 'net.minecraft.client.gui.screens.DisconnectedScreen',
    title: 'Disconnected',
    narration: 'Monoplayer: nobody is on ' + ROW.name + ' yet, so there is nothing to watch. Claim it to drive it.'
  }, { name: ROW.name, reason: 'no_body' })
  assert.equal(after.ok, true, after.because ?? after.read)
  assert.match(after.read, /nobody is on/)
  assert.equal(judgeAfterSpectate({ screen: PICKER_SCREEN, title: 'Choose a server', buttons: [] },
    { name: ROW.name, reason: 'no_body' }).ok, false)
})

test('the click\'s own screen field is never what a row is judged from', () => {
  // The mod reads `screen` inside the press, so it names the successor of the dialog pressed. A
  // runner that judged the second dialog from this field would read a dialog that has already gone.
  const data = { labels: ['Claim', 'Spectate', 'Disconnect'], clicked: true, label: 'Spectate' }
  const plain = judgePress({ ok: true, data })
  const withScreen = judgePress({ ok: true, data: { ...data, screen: 'net.minecraft.client.gui.screens.TitleScreen' } })
  assert.deepEqual(withScreen, plain)
  assert.doesNotMatch(withScreen.read, /TitleScreen/)
})

test('a second attempt in the same window does not answer with the first attempt\'s pick', () => {
  // --since is a window, and a window has no idea which run is asking. The floor is the run's own
  // moment, so a record written before it is not this run's (#720, comment 3).
  const first = { t: '2026-11-27T06:00:00.000Z', event: 'pickerPick', slug: 'x', server: ROW.name, known: true }
  const second = { t: '2026-11-27T07:00:00.000Z', event: 'pickerPick', slug: 'x', server: ROW.name, known: true }
  const floor = Date.parse('2026-11-27T06:30:00.000Z')
  assert.equal(frontReading([first, second]).pickerPick, second)
  assert.equal(frontReading([first], { since: floor }).pickerPick, null)
  assert.equal(frontReading([first, second], { since: floor }).pickerPick, second)
  // A record with no moment is kept: no line is dropped for being older than a clock it does not carry.
  assert.equal(frontReading([{ event: 'pickerPick', slug: 'x' }], { since: floor }).pickerPick.slug, 'x')
})

test('the front\'s log answers which frame arrived, and the three payloads cannot', () => {
  const pick = { t: '2026-11-27T06:40:00.000Z', event: 'pickerPick', slug: 'x', server: ROW.name, known: true, id: 'monoplayer:pick/x' }
  const ignored = { t: '2026-11-27T06:40:00.000Z', event: 'pickerPickIgnored', reason: 'not_a_pick' }
  const read = frontReading([pick])
  assert.equal(judgeFront(read, { slug: 'x' }).ok, true)
  // A frame that came and did not parse is not a frame that never came. Only the log says which.
  const ignoredOnly = frontReading([ignored])
  assert.equal(judgeFront(ignoredOnly, { slug: 'x' }).ok, false)
  assert.match(judgeFront(ignoredOnly, { slug: 'x' }).because, /pickerPickIgnored/)
  const nothing = judgeFront(frontReading([]), { slug: 'x' })
  assert.equal(nothing.ok, false)
  assert.match(nothing.because, /no pickerPick/)
})

test('the Spectate press is in the log too, with the house reason for a body nobody claimed', () => {
  const records = [
    { t: '2026-11-27T06:40:00.000Z', event: 'pickerPick', slug: 'x', server: ROW.name, known: true },
    { t: '2026-11-27T06:40:01.000Z', event: 'pickerServerDialog', slug: 'x', server: ROW.name, verbs: [] },
    { t: '2026-11-27T06:40:02.000Z', event: 'pickerVerb', verb: 'spectate', slug: 'x', server: ROW.name },
    { t: '2026-11-27T06:40:02.000Z', event: 'spectateRefused', reason: 'no_body', server: ROW.name }
  ]
  const read = frontReading(records)
  assert.equal(judgeFront(read, { slug: 'x' }).ok, true)
  assert.equal(read.pickerVerb?.verb, 'spectate')
  assert.equal(read.spectateRefused?.reason, 'no_body')
  // A run whose Spectate never reached the front has the click and no line, which is the case
  // this row exists to tell apart from a refusal.
  assert.equal(judgeFrontVerb(frontReading(records.slice(0, 2)), { slug: 'x' }).ok, false)
  assert.equal(judgeFrontVerb(read, { slug: 'x' }).ok, true)
})

test('a client in the picker has no level and no player, and a client in a world is not the run', () => {
  const held = judgeHeld({ connected: true, screen: PICKER_SCREEN, screenTitle: 'Choose a server', level: false, player: false })
  assert.equal(held.ok, true, held.because ?? held.read)
  const inWorld = judgeHeld({ connected: true, screen: 'none', level: true, player: true })
  assert.equal(inWorld.ok, false)
  assert.match(inWorld.read, /level=true/)
})

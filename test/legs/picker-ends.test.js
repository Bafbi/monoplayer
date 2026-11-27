// #710: the three picker ends a source scan held and nothing ran.
//
// test/legs/picker-numbers.test.js reads src/legs/live-front.js and holds that each of
// these three counts through the one helper and writes its own record: the picker dialog
// the leg could not write, a server's own dialog the leg could not write (#670), and a
// lane with no rows to offer (#315, #670). That guard proves each branch is mentioned. It
// cannot prove one runs, so a record that stopped being written, or a count that stopped
// moving, leaves it green. This file is the three, driven, and every case reads the record
// and the count off one run: a complete count made of a record nobody wrote is #435's and
// #616's defect read backwards.
//
// Seam: a real protocol client at a listening offline front leg, as
// test/legs/picker-click-routing.test.js and test/legs/spectate-refusal.test.js drive it.
// Nothing here stands in for the leg. Every assertion reads a record the leg wrote, a
// number the leg counted, or a frame the client decoded.
//
// The two dialogs are refused by the leg's own wire check, which is the seam that decides
// whether a configuration frame this leg authored reaches the socket: in `wireMode:
// 'throw'` a frame the check refuses is withheld and emitCheckedRaw answers false, so
// `writeRawTo` answers false and the dialog's own branch runs. What the check stands in
// for is the fact that branch is about: bytes a client would not parse. The check is a
// lane's input, and the deployed lane runs 'warn' (src/service/start-live.js), where a
// refused frame is written and counted; this file claims the refusal path, not
// production's mode. A refused frame also ends the client with `wire_reject`, by the
// check's own rule and before the leg writes its sentence, so the sentence a reader gets
// is the record's `text`. The empty offer is the case no check touches, and there the
// client is told: the disconnect it decoded is read back.
//
// What is not driven here, and why (#710's third criterion): the arm where the write
// itself throws, `try { writeRawTo } catch` in sendPickerDialog and sendServerDialog,
// which is what puts `error` on the record. The only object that throws there is
// minecraft-protocol's own server-side client for the connection, and replacing it means
// reaching into the library's socket. A fake that threw in its place would stand in for
// the socket, which is the substitution test/legs/spectate-refusal.test.js refuses in so
// many words. Both arms answer the same `written === false`, so the record and the count
// this file proves are the same ones; what it does not prove is the `error` field.
//
// What this file costs, and why (#749): the two dialog cases take under a second and the
// file takes thirty. A refused dialog is ended twice — once by the wire check's own rule
// and once by `endConfiguration` — and the second end overwrites the library's close
// timer, so one timer of 30 s is left armed with nothing to clear it and the process
// cannot exit until it fires. Refusing a baseline frame instead, which is one end, exits in
// 0 ms; so does the empty offer, which is `endConfiguration` alone. #749 is that defect
// and carries the duration assertion this file cannot make while it stands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { readConfigurationBaseline } from '../../src/legs/configuration-baseline.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { buildCustomClickAction } from '../../src/core/dialog-codec.js'
import { pickIdFor, pickSlug } from '../../src/core/picker.js'

const VERSION = '26.2'
const NAME = 'Probe'
const SERVER = 'sky:25565'
const SLUG = pickSlug(SERVER)
const BASELINE = readConfigurationBaseline()

// Ten seconds fails a hang well inside one gate cycle: this file runs in about five, and a
// box running several agents gets the headroom.
async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function records (lines, event) {
  return lines.filter(line => line.event === event).map(line => line.fields)
}

// The ids a dialog carries, read off the frame the client decoded: what the client was
// offered, not a constant this file chose.
function dialogIds (dialog) {
  return (dialog?.dialog?.value?.actions?.value?.value ?? [])
    .map(entry => entry?.action?.value?.id?.value ?? null)
}

// The sentence the leg wrote into a configuration disconnect, as the client decoded it.
function refusalText (disconnects) {
  const reason = disconnects[0]?.reason ?? null
  return typeof reason === 'string' ? reason : reason?.value ?? null
}

// One picker lane, one real client, and the records the leg wrote.
//
// `rows` is the list the lane offers, so the empty offer is this same rig with nothing in
// it. `control.refuse` is read at each write, so a test can let the picker's dialog
// through and shut the door behind it: the second dialog is the one a click opens, and a
// check that refused both would never reach it.
async function withPickerLane (run, { rows = [{ name: SERVER }], offerReason = null } = {}) {
  // The reader answers null for a missing file, and the leg then denies every join
  // `picker_unavailable`: the timeouts would name the dialog rather than the recording.
  assert.notEqual(BASELINE, null, 'src/legs/configuration-baseline/26.2.json is committed')
  const lines = []
  const control = { refuse: false }
  const asked = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: BASELINE,
    pickerServers: () => ({
      source: rows.length === 0 ? 'none' : 'allowed',
      reason: rows.length === 0 ? offerReason : null,
      rows
    }),
    getSnapshotConfig: () => BASELINE.replayFrames,
    // A check that refuses the dialogs this leg authors and passes every other frame of
    // the phase, so the recording the picker is served still reaches the client: refusing
    // the whole phase would be refusing the lane, which is O61's case and not this one.
    wireCheck: payload => {
      asked.push({ state: payload.state, name: payload.name })
      if (control.refuse !== true) return { ok: true }
      if (payload.state !== 'configuration' || payload.name !== 'show_dialog') return { ok: true }
      return { ok: false, code: 'leftover_bytes', parsedName: 'login', consumed: 3, total: 5, leftover: 2 }
    },
    // The offline leg's default, named here because this file's two dialog cases are about
    // the mode that withholds a frame rather than the one that writes it anyway.
    wireMode: 'throw',
    log: (event, fields) => lines.push({ event, fields })
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    // The core's answer: this login joins the picker. A picker client holds no channel, so
    // nothing else needs wiring for the three ends: each of them ends the connection.
    leg.setLoginStartHandler(() => ({ allowed: true, picker: true }))
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    const dialogs = []
    const disconnects = []
    const clientErrors = []
    bot.on('show_dialog', packet => dialogs.push(packet))
    bot.on('disconnect', packet => disconnects.push(packet))
    // A connection the lane ends from its side would otherwise fail the run as an
    // unhandled error event, which names no test. Collected, so a case that expects none
    // can say so.
    bot.on('error', error => clientErrors.push(String(error?.message ?? error)))
    return await run({
      leg,
      lines,
      control,
      asked,
      dialogs,
      disconnects,
      clientErrors,
      // One id in the phase the picker holds the client in, which is how a real client
      // answers a dialog.
      click: id => bot.writeRaw(buildCustomClickAction({ state: 'configuration', id }))
    })
  } finally {
    // The socket goes first, for the reason test/legs/spectate-refusal.test.js gives: the
    // library's own end() waits out its close timeout for an answer.
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

test('#710 a picker dialog the leg could not write is recorded and counted', async () => {
  await withPickerLane(async ({ leg, lines, control, asked, dialogs, disconnects, clientErrors }) => {
    control.refuse = true
    await settleUntil(() => records(lines, 'pickerDialogFailed').length === 1,
      'the record for a dialog the leg could not write')

    // The check is what refused the dialog, so asking it is the fact the branch ran.
    assert.deepEqual(asked.filter(entry => entry.name === 'show_dialog'),
      [{ state: 'configuration', name: 'show_dialog' }],
      'the leg asked its wire check about the dialog it authored, in the state it wrote it in')

    const [failed] = records(lines, 'pickerDialogFailed')
    assert.equal(failed.reason, 'picker_unavailable',
      'the record carries the word the refusal map is keyed by')
    assert.match(String(failed.text), /could not show its server list/,
      'beside the sentence the leg composed, because a count with no words is half the fact')
    assert.equal(failed.username, NAME)
    assert.equal('error' in failed, false,
      'the funnel answered false with no error to report, so the key is left out rather than sent as null')

    // The count, off the same run. One refusal, and the map split by the same word.
    assert.equal(leg.metrics.pickerRefusals, 1, 'the refusal is counted')
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { picker_unavailable: 1 },
      'and the map the cap is decided from says why')
    assert.equal(leg.metrics.pickers, 1, 'the lane did serve the picker; it was the dialog that failed')

    // The lane's other record still says what the join asked for, and carries no size: a
    // size for a dialog that never went out would read as one that did.
    const [dialog] = records(lines, 'pickerDialog')
    assert.equal(dialog.servers, 1, 'the lane had a row to offer')
    assert.deepEqual(dialog.actions, [pickIdFor(SERVER)], 'and the dialog it built names that row')
    assert.equal('bytes' in dialog, false, 'a dialog that was refused has no size on the wire')

    // The client read no dialog, and the end the leg chose is the refusal's own.
    assert.deepEqual(dialogs, [], 'no dialog reached the client')
    assert.deepEqual(clientErrors, [])
    const [ended] = records(lines, 'configurationEnded')
    assert.equal(ended.reason, 'picker_unavailable', 'the client was ended for the reason the record names')
    // The check's own rule ended the connection before the leg wrote its sentence, and it
    // ends it with no configuration disconnect at all, so the sentence reached no client.
    // Asserted rather than glossed: in this mode what the leg owes is the record, and the
    // connection was ended by the frame's own refusal.
    assert.deepEqual(disconnects, [],
      'the wire check ended the connection without a disconnect frame, so the sentence the record carries reached no client')
  })
})

test('#710 a server dialog the leg could not write is recorded and counted', async () => {
  await withPickerLane(async ({ leg, lines, control, dialogs, disconnects, clientErrors, click }) => {
    // The picker's own dialog is written, so the client has a list to click. Then the door
    // shuts, which is the moment after it: a click's dialog is the second one this lane
    // writes for one connection.
    await settleUntil(() => dialogs.length === 1, 'the picker dialog at the client')
    const offered = dialogIds(dialogs[0])
    assert.deepEqual(offered, [pickIdFor(SERVER)], 'the client was offered the row the lane serves')

    control.refuse = true
    click(offered[0])
    await settleUntil(() => records(lines, 'pickerServerDialogFailed').length === 1,
      "the record for a server's dialog the leg could not write")

    const [failed] = records(lines, 'pickerServerDialogFailed')
    assert.equal(failed.reason, 'picker_unavailable', 'the record carries the word the map is keyed by')
    assert.equal(failed.server, SERVER, 'and names the server whose dialog it could not write')
    assert.equal(failed.slug, SLUG)
    assert.match(String(failed.text), /could not be offered on this lane/,
      'beside the sentence the leg composed')
    assert.equal('error' in failed, false, 'the funnel refused with no error, so the key is left out')

    // The record and the count, off one run. The click is not a refusal: what is counted is
    // the dialog, and only the dialog.
    const [pick] = records(lines, 'pickerPick')
    assert.equal(pick.server, SERVER, 'the click reached the row it named, which is what opened the dialog')
    assert.equal(pick.known, true)
    assert.equal(leg.metrics.pickerRefusals, 1, 'one refusal, and it is the dialog')
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { picker_unavailable: 1 })
    assert.equal(leg.metrics.pickerServerDialogs, 0,
      'and the dialog is not counted as served, which is the number that would have read as a served one')
    // The picker's dialog is still the only one the client read, and the leg keeps the
    // record of the one that did not arrive, so a reader sees both halves.
    assert.equal(dialogs.length, 1, "one dialog at the client, and it is the picker's")
    assert.deepEqual(records(lines, 'pickerServerDialog').map(fields => fields.server), [SERVER],
      "the server dialog's own line is written whether or not it was delivered")
    assert.deepEqual(clientErrors, [])
    assert.deepEqual(disconnects, [],
      'the wire check ended the connection without a disconnect frame, so the sentence the record carries reached no client')
  })
})

test('#710 a lane with no rows to offer is recorded, counted, and the client is told', async () => {
  await withPickerLane(async ({ leg, lines, dialogs, disconnects, clientErrors }) => {
    // The two files the lane reads are unparseable, in the word its parser answers with
    // (#372): the lane has nothing to offer, and its offer says which repair brings the
    // list back.
    await settleUntil(() => disconnects.length === 1, 'the sentence a lane that offers nothing gives')
    await settleUntil(() => lines.some(line => line.event === 'frontClientEnd'), 'the client ended')

    const [empty] = records(lines, 'pickerEmpty')
    assert.equal(empty.reason, 'empty_offer', 'the record carries the word the refusal map is keyed by')
    assert.equal(empty.offerReason, 'not_json',
      "and the parser's own code beside it, which is what an operator repairs a file from")
    assert.match(String(empty.text), /this lane is not offering any server/,
      'the sentence is about the lane, because the client clicked nothing')

    // The count, off the same run: the half that would silently stop moving.
    assert.equal(leg.metrics.pickerRefusals, 1, 'the refusal is counted')
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { empty_offer: 1 },
      'and the map the cap is decided from says why')
    assert.equal(leg.metrics.pickers, 1, 'the lane served the picker; it was the list that had nothing')

    // A dialog with no buttons is a phase with nothing on screen, so nothing was written,
    // and the client read the sentence instead.
    assert.deepEqual(dialogs, [], 'no dialog with no buttons reached the client')
    assert.equal(refusalText(disconnects), empty.text,
      'the sentence the client decoded is the one the record carries, so the two cannot disagree')
    assert.deepEqual(clientErrors, [])
  }, { rows: [], offerReason: 'not_json' })
})

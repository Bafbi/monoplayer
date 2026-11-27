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
// number the leg counted, a frame the client decoded, or — in #749's two cases only — the
// timer handle the leg's own end armed. That last one is not a copy of the leg's state: it
// is the object the process holds, read at the functions that arm and clear it, because a
// leaked handle is exactly what no record can show.
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
// What is not driven here, and why (#710's third criterion). Three things answer
// `written === false`, and two of them are the record's `error` key:
//
//   - `writeRawTo` throwing, caught by `try { writeRawTo } catch` in sendPickerDialog and
//     sendServerDialog. The only object that throws there is minecraft-protocol's own
//     server-side client for the connection, and replacing it means reaching into the
//     library's socket. A fake that threw in its place would stand in for the socket, which
//     is the substitution test/legs/spectate-refusal.test.js refuses in so many words.
//   - the encode answering not-ok (`encodeDialogFrame`), which is a connection with no
//     serializer or a params build that threw. A listening leg always has the serializer the
//     library gave its client, so this one is unreachable from a real client too, and no fake
//     short of a hand-built client object reaches it either.
//   - the funnel answering false, which is this file's two dialog cases. It sets no `error`.
//
// So the record and the count these cases read are the ones all three write, and the key
// left unproved is `error`, from either of the first two.
//
// What this file cost, and what #749 was: the assertions took under a second and the file
// took about thirty on the box it was written on, and the cost was the leg's. A refused
// dialog was ended twice, once by the wire check's own rule and once by
// `endConfiguration`, and the second end overwrote the library's close timer. One timer of
// 30 s was then left armed with nothing to clear it, and the process could not exit until it
// fired. Refusing a baseline frame instead was one end and exited in 0 ms, and so was the
// empty offer, which is `endConfiguration` alone. The two cases below assert the timer
// count each refused dialog leaves, so the second end cannot come back, and the file is back
// to the under-a-second the rest of this directory runs in.
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

// Ten seconds fails a hang well inside one gate cycle: the work in each case takes about a
// second, and a box running several agents gets the headroom.
async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// #749: the close timer a leg's ends arm. minecraft-protocol arms one on every
// `client.end()` — `this.closeTimer = setTimeout(socket.destroy.bind(socket), closeTimeout)`,
// its `src/client.js`, resolved with `node -p "require.resolve('minecraft-protocol')"` — and
// keeps only the newest handle on the client, while the socket's close clears only the handle
// the field holds at that moment. So one end on a connection arms one timer and the socket's
// close clears it, and a second end on the same connection arms a second timer whose handle
// overwrites the first, leaving the first armed with nothing left to clear it. `closeTimeout`
// is 30 000 ms, and it is a close timeout: the wait, after `end()`, for the peer to close
// before the library destroys the socket. An armed one is a handle in this process and
// holds its event loop open for that whole wait, which is what made this file read as 31 s
// in `node --test` while its assertions took under a second.
//
// The count below is the timer itself, not a copy of it: an armed handle no end cleared is
// the second end that overwrote the first, and no record can show it, because no record is
// a handle. It is read at the two functions that arm and clear timers — the same read
// test/service/cli.test.js:80 makes of a handle — rather than counted in the process's
// active resources, which are process-wide: a count carries every timer in flight, so an
// unrelated one armed or cleared in the same window moves it.
//
// The stack is what makes it the end's timer, and both frames are needed: the arm sits under
// the library's own `Client.end`, and the frame under that is this leg's. 30 s is not a
// private length — the library arms two more (its login timeout, src/server/login.js:44) and
// this leg arms a third (its pre-auth deadline, src/core/preauth-window.js
// DEFAULT_DEADLINE_MS) — and none of those is this timer.
const CLOSE_TIMEOUT_MS = 30_000
const LEG_END = stack => stack.includes('Client.end') && stack.includes('live-front.js')

async function watchCloseTimers (run) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const armed = []
  const cleared = new Set()
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest)
    if (ms === CLOSE_TIMEOUT_MS && LEG_END(String(new Error().stack))) armed.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle, ...rest) => {
    if (armed.includes(handle)) cleared.add(handle)
    return realClearTimeout(handle, ...rest)
  }
  const watch = { armed, cleared }
  try {
    watch.result = await run(watch)
    return watch
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// Every close timer the leg armed and nothing cleared: the ones that hold this process open.
function stillArmed (watch) {
  return watch.armed.filter(handle => watch.cleared.has(handle) === false).length
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

// #749: the same refused dialog, read for what the end costs the process rather than what
// it records. The refusal is the funnel's, and the funnel's own rule ends the client with
// `wire_reject`; the dialog's branch then ends it again through `endConfiguration`,
// because that call had no way to know the connection was already gone. This case is that
// second end: one end arms one close timer and the socket's close clears it, and two ends
// arm two and clear one, so the timers left are the ends over one.
test('#749 a refused picker dialog ends the client once and leaves no timer armed', async () => {
  const watch = await watchCloseTimers(() => withPickerLane(async ({ lines, control, clientErrors }) => {
    control.refuse = true
    await settleUntil(() => lines.some(line => line.event === 'frontClientEnd'),
      'the refused client to end, and its socket to close after it')

    assert.deepEqual(records(lines, 'pickerDialogFailed').map(fields => fields.reason), ['picker_unavailable'],
      'the refusal the funnel made is still recorded and counted, and the end does not lose it')
    // One end line per connection, and the sentence it carries: the end is skipped, not
    // the record. A reader who asks why this client left still gets the answer.
    const [ended] = records(lines, 'configurationEnded')
    assert.equal(records(lines, 'configurationEnded').length, 1, 'one end record on a connection the funnel ended')
    assert.equal(ended.reason, 'picker_unavailable')
    assert.deepEqual(clientErrors, [])
  }))
  assert.equal(watch.armed.length, 1,
    'one end on this connection, and one end arms one close timer of 30 s')
  assert.equal(stillArmed(watch), 0,
    'and the socket close cleared it, so no 30 s close timeout is left holding this process')
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

// #749: the twin. A refused server dialog is the same shape as a refused picker dialog
// one click later — the funnel ends the client and the dialog's branch ends it again — so
// the family is read here rather than assumed from the case above. Two endings in this
// file's rig that both lose their timer are two endings in the lane.
test('#749 a refused server dialog ends the client once and leaves no timer armed', async () => {
  const watch = await watchCloseTimers(() => withPickerLane(async ({ lines, control, dialogs, clientErrors, click }) => {
    await settleUntil(() => dialogs.length === 1, 'the picker dialog at the client')
    control.refuse = true
    click(dialogIds(dialogs[0])[0])
    await settleUntil(() => lines.some(line => line.event === 'frontClientEnd'),
      'the refused client to end, and its socket to close after it')

    assert.deepEqual(records(lines, 'pickerServerDialogFailed').map(fields => fields.reason), ['picker_unavailable'],
      "the server dialog's own refusal is still recorded and counted")
    assert.equal(records(lines, 'configurationEnded').length, 1, 'one end record on a connection the funnel ended')
    assert.deepEqual(clientErrors, [])
  }))
  assert.equal(watch.armed.length, 1,
    'one end on this connection, and one end arms one close timer of 30 s')
  assert.equal(stillArmed(watch), 0,
    'and the socket close cleared it, so no 30 s close timeout is left holding this process')
})

test('#710 a lane with no rows to offer is recorded, counted, and the client is told', async () => {
  await withPickerLane(async ({ leg, lines, dialogs, disconnects, clientErrors }) => {
    // The offer this rig hands over holds no rows and carries the parser's own code (#372)
    // as its reason, which is the cause that rides beside the word the map is keyed by. The
    // lane that reads two unparseable files and answers with this same offer is O66's, in
    // the loopback: here the offer is the rig's, because the refusal is the leg's.
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

#!/usr/bin/env node
// #720: one client held in the picker - its screen read, its row pressed, its Spectate pressed.
//
// #678 settled the class tree from the 26.2 client's own code (test/driver/picker-click.test.js)
// and could not take the run: the client lives on the display host. This is that run, as one
// command, so the answer is a file and not a transcript.
//
// Why here and not src/driver/. Nothing in 'mise run check' may reach a client, and
// 'mise run driver:scenario' refuses this path by design: it waits for level: true
// (src/driver/checks.js) and a client in the picker has no level. A run that
// needs a person at a machine belongs beside driver-client.mjs, which is what it drives.
//
// The three reads, in the order the run makes them, and why each is a read of its own:
//
//   1. 'screen' on a client the front holds in the configuration phase. show_dialog reaches
//      Gui.setScreen in configuration as well as in play, so the client draws a
//      MultiButtonDialogScreen before any world exists.
//   2. 'screen' again after the row is pressed. The click's own answer carries a screen read
//      inside the press, before the front's second dialog is drawn, so it names the dialog's
//      successor and not the next dialog: the press answers before the front has written the
//      next one, so a runner that judged from it would read a dialog already gone.
//   3. the front's log. Three payloads cannot tell 'no frame arrived' from 'a frame arrived that
//      readPickAction could not parse'. pickerPick is the frame arriving and
//      being read, pickerPickIgnored is the second case, and silence is the first.
//
// The label it presses is the one the screen reported, whole. clickButton matches a label
// substring, and driver-client.mjs joins its arguments, so a click with no argument sends
// label: "" - which every label contains, so it presses the first button on the screen and
// records it as the row meant. This refuses an empty needle instead.
//
// What it does not say. A press that reaches the front and is refused is a press: on a body
// nobody claimed the answer is no_body (spectateRefusalText, src/core/picker.js), and that is the
// proof, not a Spectate landing. This records the reason the front wrote and never calls it a
// landing.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { pickSlug, pickerDialog, serverDialog, spectateRefusalText } from '../../src/core/picker.js'
import { createDriverClient, DriverError } from '../../src/driver/client-driver.js'
import { parseRecords } from '../../src/driver/dev-proof.js'

export const PICKER_SCREEN = 'net.minecraft.client.gui.screens.dialog.MultiButtonDialogScreen'
// The dialog's title and the second level's labels, read out of the two composers the front
// writes with, so a change there reaches this run instead of a sentence typed here.
export const PICKER_TITLE = pickerDialog({}).value.title.value
export const VERB_LABELS = dialogLabels(serverDialog({ server: {} }))
export const DEFAULT_REPORT = '.reports/picker-read.json'
export const FRONT_DEPLOYMENT = 'deploy/monoplayer'

const simple = name => String(name ?? '').split('.').pop()
const labelsOf = screen => (Array.isArray(screen?.buttons) ? screen.buttons : [])
  .map(button => String(button?.label ?? ''))
const buttonsOf = screen => (Array.isArray(screen?.buttons) ? screen.buttons : [])
  .filter(button => button !== null && typeof button === 'object' && button.visible !== false)

// The labels a dialog carries, read from the NBT the client parses. The tree is the composer's
// own shape: a list of compounds, each a bare key map with label and action.
export function dialogLabels (dialog) {
  const actions = dialog?.value?.actions?.value?.value
  return Array.isArray(actions) ? actions.map(button => String(button?.label?.value ?? '')) : []
}

// The row's address out of the label the client draws. pickerLabel composes
// <host>:<port> - <state>, then the driver and the watcher count, so the port is the anchor a
// host with dots cannot move.
export function nameOfLabel (label) {
  const match = String(label ?? '').match(/^(.+?):(\d+) - /)
  return match === null ? null : match[1] + ':' + match[2]
}

export function stateOfLabel (label) {
  const match = String(label ?? '').match(/^(.+?):(\d+) - (unclaimed|claimed|down)\b/)
  return match === null ? null : match[3]
}

// The label to press: the first button the mod would match, by the same rule it uses
// (a case-insensitive substring, visible only), optionally narrowed to one state word. An empty
// needle is refused here rather than pressed, because it matches the first button on the screen.
export function rowIn (screen, needle, { state = null } = {}) {
  const wants = String(needle ?? '').trim()
  if (wants === '') return null
  const lowered = wants.toLowerCase()
  for (const button of buttonsOf(screen)) {
    const label = String(button.label ?? '')
    if (!label.toLowerCase().includes(lowered)) continue
    if (state !== null && stateOfLabel(label) !== state) continue
    return label
  }
  return null
}

const reportRow = (id, ok, { expect, read, because = null, data = null }) => ({
  id, ok, expect, read, because, ...(data === null ? {} : { data })
})

// The client is held in the configuration phase, which is what the run needs and what
// driver:scenario refuses. A client with a level has joined a body and is not this run.
export function judgeHeld (status) {
  const read = 'screen=' + (status?.screen ?? 'none') + ' level=' + status?.level +
    ' player=' + status?.player + ' connected=' + status?.connected
  const configuration = status?.connected === true && status?.level === false && status?.player === false
  const expect = 'connected, in the configuration phase (no level, no player), on ' + simple(PICKER_SCREEN)
  if (!configuration) {
    return reportRow('held', false, {
      expect,
      read,
      because: 'the picker is a configuration-phase dialog, so level and player are both false there ' +
        '(tools/driver/README.md). A client with a level is in a world: it joined a body rather than ' +
        'landing in the picker, and the screen it holds is not the dialog this run reads'
    })
  }
  if (status.screen !== PICKER_SCREEN) {
    return reportRow('held', false, {
      expect,
      read,
      because: 'the client is in the configuration phase and holds ' + (status.screen ?? 'no screen') +
        ' rather than the picker dialog: the join never reached the front, or the front refused it'
    })
  }
  return reportRow('held', true, { expect, read })
}

// The first dialog: the front's offer, one button per row (pickerDialog, src/core/picker.js).
export function judgeLevelOne (screen, { needle = '', state = 'down' } = {}) {
  const labels = labelsOf(screen)
  const expect = simple(PICKER_SCREEN) + ' titled ' + JSON.stringify(PICKER_TITLE) +
    ', one button per offered row, and a row ending " - ' + state + '"'
  const read = 'screen=' + (screen?.screen ?? 'none') + ' title=' + JSON.stringify(screen?.title ?? null) +
    ' buttons: ' + (labels.join('; ') || 'none')
  if (screen?.screen !== PICKER_SCREEN) {
    return reportRow('screen', false, {
      expect,
      read,
      because: 'the client draws a ' + PICKER_SCREEN + ' for a minecraft:multi_action dialog ' +
        '(DialogScreens, held by test/driver/picker-click.test.js). ' + (screen?.screen ?? 'no screen') +
        ' is another screen: nothing on it is the picker, and a press there answers a different question'
    })
  }
  if (screen.title !== PICKER_TITLE) {
    return reportRow('screen', false, {
      expect,
      read,
      because: 'the dialog the front writes is titled ' + JSON.stringify(PICKER_TITLE) +
        ' (sendPickerDialog, src/legs/live-front.js), and this one is titled ' +
        JSON.stringify(screen.title ?? null)
    })
  }
  if (String(needle ?? '').trim() === '') {
    return reportRow('screen', false, {
      expect,
      read,
      because: 'no label was named, and an empty label matches the first button on the screen: name ' +
        'the row with --row, because a press must not be the first button by accident'
    })
  }
  const label = rowIn(screen, needle, { state })
  if (label === null) {
    return reportRow('screen', false, {
      expect,
      read,
      because: 'no button label holds ' + JSON.stringify(needle) + ' with the state ' + JSON.stringify(state) +
        '. The labels above are what the client draws; a row that reads another state is the lane ' +
        'saying something about that body'
    })
  }
  return reportRow('screen', true, { expect, read, data: { label, name: nameOfLabel(label), state: stateOfLabel(label) } })
}

// The second dialog: the row's own verbs (serverDialog, src/core/picker.js). Its title is
// pickerLabel of the row as the lane reads it at click time, so the state word can have moved
// since the first dialog drew its button. The address is the part that cannot.
export function judgeLevelTwo (screen, { label } = {}) {
  const labels = labelsOf(screen)
  const wanted = VERB_LABELS.join(', ')
  const expect = simple(PICKER_SCREEN) + ' titled with the row ' + JSON.stringify(label ?? null) +
    ' and holding ' + wanted
  const read = 'screen=' + (screen?.screen ?? 'none') + ' title=' + JSON.stringify(screen?.title ?? null) +
    ' buttons: ' + (labels.join('; ') || 'none')
  if (screen?.screen !== PICKER_SCREEN) {
    return reportRow('row-click', false, {
      expect,
      read,
      because: 'the row press answered with ' + (screen?.screen ?? 'no screen') + ' rather than the row\'s ' +
        'own dialog: the press reached something that is not a pick'
    })
  }
  if (label && nameOfLabel(screen.title) !== nameOfLabel(label)) {
    return reportRow('row-click', false, {
      expect,
      read,
      because: 'the dialog on screen is about ' + JSON.stringify(nameOfLabel(screen.title) ?? screen.title ?? null) +
        ', not ' + JSON.stringify(nameOfLabel(label)) + ': the press answered a row other than the one read'
    })
  }
  const missing = VERB_LABELS.filter(want => !labels.some(held => held.toLowerCase() === want.toLowerCase()))
  if (missing.length > 0) {
    return reportRow('row-click', false, {
      expect,
      read,
      because: 'the row\'s dialog holds no ' + missing.join(', ') + ' button. The three verbs are ' +
        'PICK_VERBS (src/core/picker.js), and a run cannot press what the client did not draw'
    })
  }
  return reportRow('row-click', true, { expect, read, data: { title: screen.title, labels, name: nameOfLabel(screen.title) } })
}

// A press. clicked is the mod's own answer and label is the button it pressed, so the report says
// which button it meant rather than which needle it typed.
export function judgePress (click, { label = null, id = 'row-press' } = {}) {
  const data = click?.data ?? {}
  const expect = 'the mod presses ' + (label === null ? 'the reported button' : JSON.stringify(label)) +
    ' and answers clicked=true'
  const read = 'clicked=' + data.clicked + ' label=' + JSON.stringify(data.label ?? null) +
    ' labels: ' + ((data.labels ?? []).join('; ') || 'none')
  if (click?.ok !== true) {
    return reportRow(id, false, { expect, read, because: 'the driver refused the press: ' + JSON.stringify(click?.error ?? null) })
  }
  if (data.clicked !== true) {
    return reportRow(id, false, {
      expect,
      read,
      because: 'no visible button matched. The labels above are what the client held at the press, ' +
        'and clickButton matches a case-insensitive substring of one of them'
    })
  }
  if (label !== null && data.label !== label) {
    return reportRow(id, false, {
      expect,
      read,
      because: 'the press landed on ' + JSON.stringify(data.label ?? null) + ' rather than ' +
        JSON.stringify(label) + ': the label matched more than one button'
    })
  }
  return reportRow(id, true, { expect, read })
}

// After Spectate. The dialog closes on a click (after_action defaults to close), so the client
// lands on whatever the front answered with: the sentence for a refusal, or a world. What this row
// holds is that the dialog is gone and, when the front refused with a reason, that the client was
// shown that reason in the core's own words.
export function judgeAfterSpectate (screen, { name = null, reason = null } = {}) {
  const gone = (screen?.screen ?? 'none') !== PICKER_SCREEN
  const text = [screen?.reason, screen?.narration, screen?.title]
    .filter(value => typeof value === 'string' && value !== '')
    .join(' ')
  const sentence = reason === null || name === null ? null : spectateRefusalText({ server: name, reason })
  const matched = sentence !== null && text.includes(sentence)
  const expect = 'a screen that is no longer the picker dialog' +
    (sentence === null ? '' : ', holding ' + JSON.stringify(sentence))
  const read = 'screen=' + (screen?.screen ?? 'none') + ' title=' + JSON.stringify(screen?.title ?? null) +
    (text === '' ? '' : ' text=' + JSON.stringify(text))
  if (!gone) {
    return reportRow('after-spectate', false, {
      expect,
      read,
      because: 'the dialog is still on screen after the press, so the press answered nothing: a ' +
        'multi_action dialog closes on a click, and the front ends the phase on a refusal'
    })
  }
  if (reason !== null && !matched) {
    return reportRow('after-spectate', false, {
      expect,
      read,
      because: 'the front refused with ' + JSON.stringify(reason) + ' and the client was not shown the ' +
        'sentence for it: a client told nothing reads as a hang, which is the bug endConfiguration ' +
        '(src/legs/live-front.js) exists to prevent'
    })
  }
  return reportRow('after-spectate', true, { expect, read, data: { screen: screen?.screen ?? 'none', text } })
}

// One event out of the front's own log, the last one written. A saved stream and a live read are
// the same text, so neither can see a run the other cannot (parseRecords, src/driver/dev-proof.js).
function lastOf (records, event) {
  return records.filter(record => record?.event === event).at(-1) ?? null
}

// The front's own log, read from this run's own moment. The floor is what makes a re-run a run: a
// window alone answers with the last attempt's pick, and a report that quotes an earlier press as
// its own is the false green the third read exists to prevent.
export function frontReading (input, { since = null } = {}) {
  // Text from a saved stream or a kubectl read, or the records themselves: the two readers below
  // ask the same questions, so neither shape can answer a different run.
  const all = Array.isArray(input) ? input : parseRecords(input)
  const records = since === null ? all : all.filter(record => {
    const moment = record?.t === undefined ? null : (Number.isFinite(record.t) ? record.t : Date.parse(record.t))
    return moment === null || Number.isNaN(moment) || moment >= since
  })
  return {
    records,
    pickerDialog: lastOf(records, 'pickerDialog'),
    pickerPick: lastOf(records, 'pickerPick'),
    pickerPickIgnored: lastOf(records, 'pickerPickIgnored'),
    pickerServerDialog: lastOf(records, 'pickerServerDialog'),
    pickerVerb: lastOf(records, 'pickerVerb'),
    spectateRefused: lastOf(records, 'spectateRefused'),
    spectateLanded: lastOf(records, 'spectateLanded')
  }
}

// The pick arriving and being read. A frame that came and did not parse is the other case, and
// silence is the third: three payloads alone cannot tell them apart (#720, comment 3).
export function judgeFront (reading, { slug }) {
  const expect = 'a pickerPick record with slug ' + JSON.stringify(slug)
  const read = reading.pickerPick === null
    ? (reading.pickerPickIgnored === null
        ? 'no pickerPick and no pickerPickIgnored'
        : 'pickerPickIgnored: ' + JSON.stringify(reading.pickerPickIgnored.reason ?? null))
    : 'pickerPick: slug=' + JSON.stringify(reading.pickerPick.slug ?? null) +
      ' server=' + JSON.stringify(reading.pickerPick.server ?? null) +
      ' known=' + reading.pickerPick.known
  if (reading.pickerPick === null) {
    return reportRow('front-pick', false, {
      expect,
      read,
      because: reading.pickerPickIgnored === null
        ? 'no pickerPick record at all: no pick from this client reached the front, so the row press ' +
          'wrote no frame, which is a press the connection lost rather than a refusal'
        : 'a frame arrived and readPickAction could not parse it (pickerPickIgnored): the client sent a ' +
          'click the front does not read as a pick, so the id it carries is not this lane\'s'
    })
  }
  if (reading.pickerPick.slug !== slug) {
    return reportRow('front-pick', false, {
      expect,
      read,
      because: 'the frame that arrived names ' + JSON.stringify(reading.pickerPick.slug ?? null) +
        ', and the row the client drew is ' + JSON.stringify(slug) + ': the dialog on screen and the ' +
        'list the lane offers disagree, which is #265 with a client holding the stale one'
    })
  }
  return reportRow('front-pick', true, { expect, read, data: reading.pickerPick })
}

// The Spectate press reaching the front. A refusal is the press: on a body nobody claimed the
// answer is no_body, and the reason is the core's own word.
export function judgeFrontVerb (reading, { slug }) {
  const verb = reading.pickerVerb
  const expect = 'a pickerVerb record with verb spectate and slug ' + JSON.stringify(slug)
  const read = verb === null
    ? 'no pickerVerb record'
    : 'pickerVerb: verb=' + JSON.stringify(verb.verb ?? null) + ' slug=' + JSON.stringify(verb.slug ?? null) +
      (reading.spectateRefused === null
        ? (reading.spectateLanded === null ? '' : ' spectateLanded=' + JSON.stringify(reading.spectateLanded.server ?? null))
        : ' spectateRefused: ' + JSON.stringify(reading.spectateRefused.reason ?? null))
  if (verb === null) {
    return reportRow('front-spectate', false, {
      expect,
      read,
      because: 'no verb reached the front. The click was made, so what is missing is the frame: a ' +
        'button whose action is not a custom_click_action sends nothing (src/core/picker.js, ' +
        'verbIdFor), and that is the op this run would then need'
    })
  }
  if (verb.verb !== 'spectate' || verb.slug !== slug) {
    return reportRow('front-spectate', false, {
      expect,
      read,
      because: 'the verb that arrived is ' + JSON.stringify(verb.verb ?? null) + ' on ' +
        JSON.stringify(verb.slug ?? null) + ', not spectate on ' + JSON.stringify(slug)
    })
  }
  return reportRow('front-spectate', true, {
    expect,
    read,
    data: { verb, refused: reading.spectateRefused, landed: reading.spectateLanded }
  })
}

// The three payloads and the log lines, as one document. Everything the run read is kept whole,
// because the payload is the deliverable and a summary cannot be compared against a later run.
export function documentOf ({ takenAt, client, rows, front = null, request, waits = null }) {
  const failed = rows.filter(entry => entry.ok !== true)
  return {
    issue: 720,
    takenAt,
    what: 'one Minecraft 26.2 client held in the picker: its screen, its row press, its Spectate press, and the front log',
    request,
    waits,
    client,
    front: {
      source: front?.source ?? null,
      // A run that stopped before the third read did not read it: ok:true there would make a report
      // of a client that never answered look like one whose frames arrived.
      read: front === null
        ? { ok: false, reason: 'the run stopped before the third read' }
        : (front.ok === false ? { ok: false, reason: front.reason } : { ok: true }),
      pickerDialog: front?.reading?.pickerDialog ?? null,
      pickerPick: front?.reading?.pickerPick ?? null,
      pickerPickIgnored: front?.reading?.pickerPickIgnored ?? null,
      pickerServerDialog: front?.reading?.pickerServerDialog ?? null,
      pickerVerb: front?.reading?.pickerVerb ?? null,
      spectateRefused: front?.reading?.spectateRefused ?? null,
      spectateLanded: front?.reading?.spectateLanded ?? null
    },
    rows,
    passed: failed.length === 0,
    failed: failed.map(entry => entry.id)
  }
}

export function formatDocument (document) {
  const lines = ['#720 picker read - taken ' + document.takenAt]
  lines.push('  request: row ' + JSON.stringify(document.request.row) + ', state ' + JSON.stringify(document.request.state))
  lines.push('')
  for (const entry of document.rows) {
    lines.push('  ' + (entry.ok ? 'YES  ' : 'NO   ') + entry.id)
    lines.push('            read:   ' + entry.read)
    lines.push('            expect: ' + entry.expect)
    if (entry.because) lines.push('            because: ' + entry.because)
  }
  lines.push('')
  lines.push(document.passed
    ? 'the client held the picker, pressed the row, and pressed Spectate, and the front read both.'
    : 'the run stopped at ' + document.failed.join(', ') + '.')
  return lines.join('\n')
}

const USAGE = [
  'usage: node tools/driver/picker-read.mjs [--row LABEL] [--state down] [--report FILE] [--json]',
  '       node tools/driver/picker-read.mjs --log FILE [--row LABEL]',
  '',
  'Holds one client in the picker and takes #720\'s reading: the screen of a client the',
  'front is holding, the screen after the row is pressed, the Spectate press, and the',
  'front\'s own log lines for the frames it read. Writes a report under .reports/ and',
  'prints it.',
  '',
  'The client is on the display host and answers on 127.0.0.1:25599, so forward it first',
  '(tools/driver/README.md) in another shell:',
  '',
  '  ssh -N -L 25599:127.0.0.1:25599 bafbi@nath.tail41e568.ts.net',
  '',
  '  --row LABEL     the substring of the row to press (default paper.monoplayer-dev)',
  '  --state WORD    the state word that row must read (default down: nobody claimed it)',
  '  --log FILE      read a saved front log instead of running kubectl',
  '  --namespace NS  the lane whose front is read (default monoplayer-dev)',
  '  --since WINDOW  how much of that log to read (default 30m)',
  '  --report FILE   where the report goes (default ' + DEFAULT_REPORT + ')',
  '  --wait MS       how long a screen or a log line may take to arrive (default 10000)',
  '  --json          print the report instead of the summary',
  '  --help          this text',
  '',
  'The report is written whatever happened, including a client that never answered. Exit 0',
  'when every row holds. Exit 1 when one does not: that is the finding, and the report',
  'names it. Exit 2 when the front\'s log could not be read, because the third read is what',
  'tells a press from a frame that never arrived.',
  '',
  'The live lane serves a picker too since #579, and this refuses it: no automated run',
  'points a client at the servers real players stand in (AGENTS.md).'
].join('\n') + '\n'

function readFront ({ log, namespace, since }) {
  if (typeof log === 'string') {
    try {
      return { ok: true, text: readFileSync(log, 'utf8'), source: log, reason: null }
    } catch (error) {
      return { ok: false, text: '', source: log, reason: 'could not read ' + log + ': ' + String(error?.message ?? error) }
    }
  }
  const args = ['-n', namespace, 'logs', FRONT_DEPLOYMENT, '--since', since]
  const run = spawnSync('kubectl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) {
    return { ok: false, text: '', source: 'kubectl ' + args.join(' '), reason: 'kubectl did not run: ' + run.error.message }
  }
  if (run.status !== 0) {
    const why = String(run.stderr ?? '').trim().split('\n').filter(line => line !== '').at(-1) ?? 'no message'
    return { ok: false, text: '', source: 'kubectl ' + args.join(' '), reason: 'kubectl exited ' + run.status + ': ' + why }
  }
  return { ok: true, text: run.stdout ?? '', source: 'kubectl ' + args.join(' '), reason: null }
}

function parseArgs (argv) {
  const options = {
    row: 'paper.monoplayer-dev',
    state: 'down',
    log: null,
    namespace: 'monoplayer-dev',
    since: '30m',
    report: DEFAULT_REPORT,
    wait: 10000,
    json: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--json') { options.json = true; continue }
    if (['--row', '--state', '--log', '--namespace', '--since', '--report', '--wait'].includes(arg)) {
      const value = argv[index + 1] ?? null
      if (value === null) return { error: arg + ' needs a value' }
      options[arg.slice(2)] = arg === '--wait' ? Number(value) : value
      if (arg === '--wait' && (!Number.isFinite(options.wait) || options.wait < 0)) {
        return { error: '--wait needs a whole number of milliseconds' }
      }
      index += 1
      continue
    }
    return { error: 'unknown argument: ' + arg }
  }
  return options
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

// A client's screen and a pod's log both trail the click that causes them: the front writes the
// next dialog over the socket, the client draws it on its render thread, and the pod's log reaches
// kubectl after that. So each read is asked again until it answers or the wait runs out, and the
// last answer is what the row judges. A read taken a moment too early is not a finding.
async function until (attempt, { done, waitMs, everyMs = 250 }) {
  const started = Date.now()
  let value = await attempt()
  while (!done(value) && Date.now() - started < waitMs) {
    await sleep(everyMs)
    value = await attempt()
  }
  return { value, waitedMs: Date.now() - started }
}

function finish ({ takenAt, rows, payloads, client, options, request, waits = null, front = null, missingFront = false }) {
  const document = documentOf({
    takenAt,
    request,
    client: { host: client.host, port: client.port, payloads },
    rows,
    waits,
    front
  })
  // The report is written whatever happened, including a client that never answered: the failure
  // of a run is the run's answer, and a transcript on stderr is not a file anybody compares.
  try {
    mkdirSync(path.dirname(options.report), { recursive: true })
    writeFileSync(options.report, JSON.stringify(document, null, 2) + '\n')
  } catch (error) {
    process.stderr.write('the report could not be written to ' + options.report + ': ' + String(error?.message ?? error) + '\n')
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(document, null, 2) + '\n')
  } else {
    process.stdout.write(formatDocument(document) + '\n')
    process.stdout.write('\nthe payloads are in ' + options.report + '\n')
  }
  if (missingFront) return 2
  return document.passed ? 0 : 1
}

async function main (argv) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(USAGE); return 0 }
  if (options.error) { process.stderr.write(options.error + '\n\n' + USAGE); return 1 }
  // The live lane serves a picker too since #579, and no automated run points a client at it
  // (AGENTS.md): a claim there moves the puppet in a world real players stand in.
  if (options.namespace === 'monoplayer') {
    process.stderr.write('the live lane serves a picker, and no automated run points a client at it ' +
      '(AGENTS.md): a claim there moves the puppet in a world real players stand in. Run this against ' +
      'the dev lane, which is --namespace monoplayer-dev.\n')
    return 1
  }

  const client = createDriverClient({})
  const takenAt = new Date().toISOString()
  const startedAt = Date.now()
  const rows = []
  const waits = { serverScreenMs: null, afterSpectateMs: null, frontMs: null }
  const payloads = { status: null, screen: null, pick: null, serverScreen: null, spectate: null, afterSpectate: null }
  let request = {
    row: options.row,
    state: options.state,
    namespace: options.namespace,
    host: client.host,
    port: client.port,
    label: null,
    name: null
  }

  // Every read, in the order the run makes them. A press is made only after the screen it presses on
  // was read and judged: a needle that matched nothing would otherwise press the first button on the
  // screen and record it as the row.
  try {
    payloads.status = await client.request('status')
    const held = judgeHeld(payloads.status?.data ?? null)
    rows.push(held)
    if (!held.ok) return finish({ takenAt, rows, payloads, client, options, request, waits })

    payloads.screen = await client.request('screen')
    const levelOne = judgeLevelOne(payloads.screen?.data ?? null, { needle: options.row, state: options.state })
    rows.push(levelOne)
    if (!levelOne.ok) return finish({ takenAt, rows, payloads, client, options, request, waits })

    request = { ...request, label: levelOne.data.label, name: levelOne.data.name }
    payloads.pick = await client.request('click', { label: levelOne.data.label })
    const pressed = judgePress(payloads.pick, { label: levelOne.data.label, id: 'row-press' })
    rows.push(pressed)
    if (!pressed.ok) return finish({ takenAt, rows, payloads, client, options, request, waits })

    // The second read waits for the row's own dialog: the press answers before the front has written
    // it, and the click's own screen field names the dialog's successor rather than this one.
    const second = await until(() => client.request('screen'), {
      waitMs: options.wait,
      done: payload => payload?.data?.screen === PICKER_SCREEN &&
        nameOfLabel(payload?.data?.title) === nameOfLabel(levelOne.data.label)
    })
    payloads.serverScreen = second.value
    waits.serverScreenMs = second.waitedMs
    const levelTwo = judgeLevelTwo(payloads.serverScreen?.data ?? null, { label: levelOne.data.label })
    rows.push(levelTwo)
    if (!levelTwo.ok) return finish({ takenAt, rows, payloads, client, options, request, waits })

    const spectateLabel = (levelTwo.data?.labels ?? [])
      .find(label => String(label).toLowerCase() === 'spectate') ?? null
    if (spectateLabel === null) {
      // Never reached after a passing row-click, and the reason a press is not made anyway: a click
      // with no label presses the first button on the screen, and a run must not answer a question
      // nobody asked with whichever button came first.
      rows.push(reportRow('spectate-press', false, {
        expect: 'a button labelled Spectate to press',
        read: 'labels: ' + (labelsOf(levelTwo.data).join('; ') || 'none'),
        because: 'the row dialog holds no Spectate button, so there is nothing to press'
      }))
      return finish({ takenAt, rows, payloads, client, options, request, waits })
    }
    payloads.spectate = await client.request('click', { label: spectateLabel })
    rows.push(judgePress(payloads.spectate, { label: spectateLabel, id: 'spectate-press' }))

    // The third read, bounded by the moment this run started: a window alone would answer with the
    // last attempt's press. It is asked again until the pick and the verb are both there, because
    // the front writes them after the frame the click sent.
    const slug = pickSlug(levelOne.data.name ?? '')
    const frontRead = await until(() => {
      const front = readFront(options)
      return { front, reading: frontReading(front.ok ? front.text : '', { since: startedAt }) }
    }, {
      waitMs: options.wait,
      done: ({ front, reading }) => !front.ok || (reading.pickerPick !== null && reading.pickerVerb !== null)
    })
    waits.frontMs = frontRead.waitedMs
    const { front, reading } = frontRead.value

    // The after-screen waits for the dialog to go, for the same reason the second read waited for it
    // to arrive: the refusal sentence is written after the press, not inside it.
    const after = await until(() => client.request('screen'), {
      waitMs: options.wait,
      done: payload => (payload?.data?.screen ?? 'none') !== PICKER_SCREEN
    })
    payloads.afterSpectate = after.value
    waits.afterSpectateMs = after.waitedMs
    const refused = reading.spectateRefused?.reason ?? null
    rows.push(judgeAfterSpectate(payloads.afterSpectate?.data ?? null, {
      name: levelOne.data.name,
      reason: typeof refused === 'string' ? refused : null
    }))

    if (!front.ok) {
      rows.push(reportRow('front-pick', false, {
        expect: 'the front\'s log, read from ' + options.namespace,
        read: 'unreadable',
        because: front.reason + ' - the third read is what tells a press from a frame that never ' +
          'arrived, so pass --log FILE with a saved stream (kubectl -n ' + options.namespace +
          ' logs ' + FRONT_DEPLOYMENT + ')'
      }))
      rows.push(reportRow('front-spectate', false, {
        expect: 'the front\'s log, read from ' + options.namespace,
        read: 'unreadable',
        because: front.reason
      }))
      return finish({ takenAt, rows, payloads, client, options, request, waits, front: { ...front, reading }, missingFront: true })
    }
    rows.push(judgeFront(reading, { slug }))
    rows.push(judgeFrontVerb(reading, { slug }))
    return finish({ takenAt, rows, payloads, client, options, request, waits, front: { ...front, reading } })
  } catch (error) {
    const connect = error instanceof DriverError && (error.code === 'connect' || error.code === 'timeout')
    // The likeliest failure of this run is the one no client can answer: the display host is offline
    // or the tunnel is down. That is a row and a report, not a transcript.
    rows.push(reportRow('driver', false, {
      expect: 'a driver answering on ' + client.host + ':' + client.port,
      read: String(error?.message ?? error),
      because: connect
        ? 'no client answered: the display host is offline, or the tunnel is not up (ssh -N -L ' +
          client.port + ':127.0.0.1:' + client.port + ' bafbi@nath.tail41e568.ts.net). Nothing about ' +
          'the picker is measured by a run that never reached a client'
        : 'the run stopped on this error, and no row after it was taken'
    }))
    if (connect) process.stderr.write('the driver answered nothing on ' + client.host + ':' + client.port + '\n')
    return finish({ takenAt, rows, payloads, client, options, request, waits })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}

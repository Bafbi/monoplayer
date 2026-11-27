// #615: a click reaches the act it names, at a real front leg.
//
// The picker's decisions are pure (src/core/picker.js). The loopback rung drives the
// same leg constructor this file does, through the service, with a protocol bot: it
// writes real click bytes (src/ladder/bot.js, `answerDialog`) and asserts the pick,
// the claim and the refusal sentence at the client. What no test reached is that leg
// on its own, in the rung that runs in seconds: the refusal for a server the offer
// does not carry (`unknown_server`, at either level), the picker's own
// `buildPickAnswer` frame, and the end reason that says which level the click came
// from (`pick_refused`, `verb_refused`, `picker_refused`). That routing is
// `handlePickerClick` -> `handlePickerPick` / `handlePickerVerb`, and this file is
// its test.
//
// Seam: a real protocol client writes a real click frame at a listening offline front
// leg, and every assertion reads a fact the leg recorded or reported — a `log` line
// such as `pickerPick`, `pickerVerb` or `pickerVerbRefused`, its `metrics`, its claims
// and channels, or `onPickerPick` / `onPickerVerb` — or a frame the client decoded. The bytes come from the modules that document why they are what they are:
// `buildCustomClickAction` builds one id in the phase the client is in, and
// `buildPickAnswer` builds the picker's own answer.
//
// The baseline is the committed 26.2 recording. An empty replay serves no dialog at
// all: the leg reads a baseline with no frames as a lane with no configuration to
// show and denies the client with `backend_not_ready`. So the picker cannot be driven
// against a phase this file made up.
//
// What a granted claim lands through is `setConnectClaimedBody`, the call-in the core
// wires. A leg with no core refuses the landing with `no_lander`, so the dial behind a
// claim is O56's to prove and not this file's: what is proved here is that the click
// reaches the landing.
//
// #618: one test reads what the leg hands the core rather than what a click did — the
// textures property a spectator's landing carries, and the login record that says whether the
// account's answer had one. It is the same seam: a real click, a real frame, and a fact the leg
// recorded or handed over.
//
// #616: one click refuses instead of acting — Disconnect on a body a claim holds — and
// its sentence, its record and its count are read here, because a refusal that reached
// the log and not `front.pickerRefusalsByReason` makes a complete count read as a
// partial one (#435 found the same shape for Spectate).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { readConfigurationBaseline } from '../../src/legs/configuration-baseline.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { buildCustomClickAction } from '../../src/core/dialog-codec.js'
import { buildPickAnswer, pickIdFor, pickSlug, verbIdFor } from '../../src/core/picker.js'
import { CHANNEL_ROLES } from '../../src/core/channels.js'

const VERSION = '26.2'
const NAME = 'Probe'
const SERVER = 'sky:25565'
const SLUG = pickSlug(SERVER)
// A row the offer never names: what a click answers when the dialog on screen is older
// than the list it came from.
const DROPPED = 'nether:25565'
const BASELINE = readConfigurationBaseline()

// Ten seconds fails a hang well inside one gate cycle: this file runs in under two
// seconds, and a box running several agents gets the headroom.
async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// The ids a dialog carries, read off the frame the client decoded: what the client
// was offered, not a constant this file chose.
function dialogIds (dialog) {
  return (dialog?.dialog?.value?.actions?.value?.value ?? [])
    .map(entry => entry?.action?.value?.id?.value ?? null)
}

function dialogLabels (dialog) {
  return (dialog?.dialog?.value?.actions?.value?.value ?? [])
    .map(entry => entry?.label?.value ?? null)
}

function dialogTitle (dialog) {
  const title = dialog?.dialog?.value?.title?.value ?? null
  return typeof title === 'string' ? title : title?.text?.value ?? null
}

// The sentence the leg wrote into a configuration disconnect, as the client decoded
// it. A refusal that reaches the record and not the client leaves a player in a dialog
// nobody will read, so the two are read off one run.
function refusalText (disconnects) {
  const reason = disconnects[0]?.reason ?? null
  return typeof reason === 'string' ? reason : reason?.value ?? null
}

function records (lines, event) {
  return lines.filter(line => line.event === event).map(line => line.fields)
}

// One lane, one real client held in its configuration phase by the picker, and the
// records the leg wrote. A refusal ends the client's connection, so every test that
// expects one gets its own lane.
//
// `rows` is the list the lane offers, handed over as it is, so a test can change it
// while a dialog is open on the client.
async function withPickerLane (run, { rows = [{ name: SERVER }], callIns = {}, ...legOptions } = {}) {
  // The reader answers null for a missing file, and the leg then denies every join
  // `picker_unavailable`: the timeouts would name the dialog rather than the recording.
  assert.notEqual(BASELINE, null,
    'src/legs/configuration-baseline/26.2.json is committed')
  const lines = []
  const picks = []
  const verbs = []
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [offlineUuid(NAME)],
    configurationBaseline: BASELINE,
    pickerServers: () => ({ source: 'allowed', reason: null, rows }),
    // The body a granted claim dials and a Spectate lands in: the recording's own
    // replay, which is the phase this lane already serves.
    getSnapshotConfig: () => BASELINE.replayFrames,
    onPickerPick: pick => picks.push(pick),
    onPickerVerb: verb => verbs.push(verb),
    // The wire check is not this file's subject, and a failure in it would read as a
    // routing failure.
    wireMode: 'off',
    log: (event, fields) => lines.push({ event, fields }),
    // #618: what a test hands the lane in place of a sessionserver's answer, spread last
    // so a test states the one option it changes and inherits the rest.
    ...legOptions
  })
  let bot = null
  try {
    const { port } = await leg.listen()
    // The core's answers, one per call-in: this login joins the picker, the body its row
    // names is up, and the landing is the lane's own.
    //
    // A test that needs a different answer for one of them states it in `callIns` rather
    // than registering a second time: a call-in on the leg holds one handler, and the
    // setter refuses the second registration (#824), so one answer per call-in is the rule
    // this harness keeps for the leg it builds.
    const answers = {
      setLoginStartHandler: () => ({ allowed: true, picker: true }),
      // The body is the one the request names, which is the row's body: a core answers
      // with the body it serves, and the leg opens the channel on that.
      setSpectateBody: ({ body }) => ({ watching: true, body }),
      setSpectatorAttach: () => ({ watching: true, frames: 0 }),
      setConnectClaimedBody: () => ({ connected: true, warm: true }),
      // A leg with no core kicks the client the moment it lands, and a kick is the
      // lane's refusal rather than this file's subject.
      setCoreAttach: () => ({ attached: true, replayed: 0 }),
      ...callIns
    }
    for (const [name, answer] of Object.entries(answers)) {
      assert.equal(typeof leg[name], 'function',
        name + ' is a call-in of the front leg this harness drives, so a mistyped answer fails here and not at the join')
      leg[name](answer)
    }
    bot = mc.createClient({
      host: '127.0.0.1', port, username: NAME, version: VERSION, auth: 'offline', keepAlive: false
    })
    const dialogs = []
    const disconnects = []
    const states = []
    const clientErrors = []
    bot.on('show_dialog', packet => dialogs.push(packet))
    bot.on('disconnect', packet => disconnects.push(packet))
    bot.on('state', state => states.push(state))
    // A connection the lane ends from its side would otherwise fail the run as an
    // unhandled error event, which names no test. Collected, so a test that expects
    // none can say so.
    bot.on('error', error => clientErrors.push(String(error?.message ?? error)))
    await settleUntil(() => dialogs.length === 1, 'the picker dialog at the client')
    return await run({
      leg,
      lines,
      picks,
      verbs,
      dialogs,
      disconnects,
      states,
      clientErrors,
      // The two ways a client writes a click: one id in the phase the picker holds it
      // in, and the picker's own answer frame.
      click: id => bot.writeRaw(buildCustomClickAction({ state: 'configuration', id })),
      send: buffer => bot.writeRaw(buffer)
    })
  } finally {
    // The socket goes first, for the reason test/legs/spectate-refusal.test.js gives:
    // the library's own end() waits out its close timeout for an answer.
    try { bot?.socket?.destroy() } catch { /* the client was already gone */ }
    await leg.close()
  }
}

test('#615 a pick reaches the leg and opens the dialog the row names', async () => {
  await withPickerLane(async ({ leg, lines, picks, dialogs, disconnects, clientErrors, click }) => {
    const offered = dialogIds(dialogs[0])
    assert.deepEqual(offered, [pickIdFor(SERVER)],
      'the list offers the row the lane serves, under the id the picker builds for it')
    assert.match(String(dialogLabels(dialogs[0])[0]), /sky:25565/,
      'the button carries the address, because the id is only its slug')

    // The click answers the dialog the client read, not an id this file composed.
    click(offered[0])
    await settleUntil(() => dialogs.length === 2, "the chosen server's own dialog")

    const [pick] = records(lines, 'pickerPick')
    assert.equal(pick.id, pickIdFor(SERVER))
    assert.equal(pick.slug, SLUG)
    assert.equal(pick.server, SERVER)
    assert.equal(pick.known, true, 'the row was found, and that is what opens the dialog')

    assert.deepEqual(
      picks.map(report => ({ id: report.id, slug: report.slug, server: report.server?.name, name: report.name })),
      [{ id: pickIdFor(SERVER), slug: SLUG, server: SERVER, name: NAME }],
      'the pick the caller is handed names the row, not the click'
    )
    const [serverDialog] = records(lines, 'pickerServerDialog')
    assert.equal(serverDialog.server, SERVER, 'the leg recorded the dialog it wrote, for the row the pick named')
    assert.deepEqual(dialogIds(dialogs[1]), serverDialog.verbs,
      'and the frame the client decoded offers exactly the ids the leg recorded, in that order')
    assert.match(String(dialogTitle(dialogs[1])), /sky:25565/,
      'and it is titled for the body the click named')
    assert.equal(leg.metrics.pickerPicks, 1)
    assert.equal(leg.metrics.pickerServerDialogs, 1)
    assert.deepEqual(disconnects, [], 'a pick is the first half of a choice: the client stays in the phase')
    assert.deepEqual(clientErrors, [])
  })
})

test("#615 a claim on the server's own dialog lands the client in the body the frame names", async () => {
  await withPickerLane(async ({ leg, lines, verbs, states, clientErrors, click }) => {
    click(verbIdFor('claim', SERVER))
    await settleUntil(() => leg.metrics.claimLanded === 1, 'the claim to land the client')
    await settleUntil(() => states.includes('play'), 'the client in the body it claimed')

    const [verb] = records(lines, 'pickerVerb')
    assert.equal(verb.id, verbIdFor('claim', SERVER))
    assert.equal(verb.verb, 'claim')
    assert.equal(verb.slug, SLUG)
    assert.equal(verb.server, SERVER, 'the frame names the body, so nothing was remembered between clicks')

    const [claim] = records(lines, 'pickerClaim')
    assert.equal(claim.body, SLUG, 'the claim is recorded against the body the frame named')
    assert.equal(claim.server, SERVER)
    assert.equal(claim.granted, true)
    assert.equal(claim.claimedBy, NAME)
    assert.deepEqual(
      leg.claims.map(held => ({ body: held.body, server: held.server, name: held.name })),
      [{ body: SLUG, server: SERVER, name: NAME }],
      'and the board the picker reads its rows from holds it'
    )

    assert.equal(verbs.length, 1)
    assert.deepEqual(verbs[0].claim, { granted: true, repeated: false, reason: null, claimedBy: NAME },
      'the caller is told the claim, which is what the service records')
    assert.equal(records(lines, 'pickerClaimLanding').length, 1)
    assert.equal(records(lines, 'pickerClaimLanded').length, 1, 'the landing is a record of its own')
    assert.equal(leg.metrics.pickerClaims, 1)
    assert.equal(leg.metrics.pickerVerbs, 1)
    assert.equal(leg.metrics.pickerRefusals, 0)
    assert.deepEqual(clientErrors, [])
  })
})

test("#615 a Spectate on the server's own dialog lands the client as a spectator of that body", async () => {
  await withPickerLane(async ({ leg, lines, verbs, states, clientErrors, click }) => {
    click(verbIdFor('spectate', SERVER))
    await settleUntil(() => leg.metrics.spectateLandings === 1, 'the Spectate to land the client')
    await settleUntil(() => leg.metrics.spectatorJoins === 1, 'the spectator to join the body')
    await settleUntil(() => states.includes('play'), 'the client in the body it watches')

    const [verb] = records(lines, 'pickerVerb')
    assert.equal(verb.verb, 'spectate')
    assert.equal(verb.server, SERVER)
    assert.equal(records(lines, 'spectateLanded')[0].server, SERVER)
    assert.equal(verbs.length, 1)
    assert.equal(verbs[0].claim, null, 'watching is not claiming')
    assert.deepEqual(leg.claims, [], 'and it records none')
    assert.deepEqual(
      leg.channels.map(channel => ({ body: channel.body, role: channel.role })),
      [{ body: SLUG, role: CHANNEL_ROLES.SPECTATOR }],
      'the client holds a spectator channel on the body the frame named'
    )
    assert.equal(leg.metrics.pickerVerbs, 1, 'a Spectate the lane carries is a verb, not a refusal')
    assert.equal(leg.metrics.pickerRefusals, 0)
    assert.deepEqual(clientErrors, [])
  })
})

// #618: a spectator's own player wears the skin its account's hasJoined answer
// carried, and the front is where that property is. This file reads the hand-over: what
// the landing call-in is handed, on a lane that was given an account's properties and on
// one that was given none. Whether the core writes the frame, and what it carries, is
// test/service/spectate.test.js's; what a real socket receives is O73's.
test("#618 a landing is handed the textures the client's account sent, and nothing when it sent none", async () => {
  // The property an account's hasJoined answer carries, as the account's own.
  const OWN_SKIN = { name: 'textures', value: 'd2F0Y2hlciBza2lu', signature: 'd2F0Y2hlciBzaWc=' }
  const handovers = []
  // The core's answer is this test's, stated once: a call-in on the leg holds one handler, so a
  // second registration would be refused rather than replace the harness's (#824). What
  // this test reads is the argument that answer is handed.
  const attach = payload => {
    handovers.push(payload)
    return { watching: true, frames: 0 }
  }
  await withPickerLane(async ({ lines, click }) => {
    click(verbIdFor('spectate', SERVER))
    await settleUntil(() => handovers.length === 1, 'the spectator landing the leg reported')
    assert.deepEqual(handovers[0].skin, { value: OWN_SKIN.value, signature: OWN_SKIN.signature },
      "the landing is handed the account's own property, as it arrived")
    assert.equal(handovers[0].name, NAME)
    assert.equal(handovers[0].uuid, offlineUuid(NAME), 'the uuid is the one the front verified, not a second copy')
    assert.equal(typeof handovers[0].channel, 'string', 'and the channel is the one the landing opened')
    // #618's measurement, on the same join: the leg's own record says whether the answer
    // carried the property, which is what a deployed lane is read for.
    assert.equal(records(lines, 'attachAllowed')[0].textures, true,
      'the login record says the body it verified carried textures')
    assert.equal(records(lines, 'spectated')[0].skinSupplied, true, 'and the landing records the skin it was handed')
  }, { profiles: { [NAME]: [OWN_SKIN] }, callIns: { setSpectatorAttach: attach } })

  // The same lane with nothing supplied is a lane whose sessionserver answered with no
  // property, and the landing is handed null rather than a skin this leg invented.
  const bare = []
  const bareAttach = payload => {
    bare.push(payload)
    return { watching: true, frames: 0 }
  }
  await withPickerLane(async ({ lines, click }) => {
    click(verbIdFor('spectate', SERVER))
    await settleUntil(() => bare.length === 1, 'the second spectator landing')
    assert.equal(bare[0].skin, null, 'no property supplied is no skin, never a default this leg made up')
    assert.equal(records(lines, 'attachAllowed')[0].textures, false)
    assert.equal(records(lines, 'spectated')[0].skinSupplied, false)
  }, { callIns: { setSpectatorAttach: bareAttach } })
})

test("#615 a pick naming a server the offer dropped is refused in the pick's words", async () => {
  await withPickerLane(async ({ leg, lines, dialogs, disconnects, clientErrors, send }) => {
    // The picker's own answer frame, for a row this lane does not serve.
    send(buildPickAnswer({ name: DROPPED }))
    await settleUntil(() => records(lines, 'pickerPickRefused').length === 1, 'the refused pick')
    await settleUntil(() => disconnects.length === 1, 'the sentence at the client')

    const [refused] = records(lines, 'pickerPickRefused')
    assert.equal(refused.id, pickIdFor(DROPPED))
    assert.equal(refused.slug, pickSlug(DROPPED))
    assert.equal(refused.reason, 'unknown_server', 'the dialog is older than the list, and that is the reason')
    // The wording is src/core/picker.js's to prove. What this file owns is that the
    // sentence reaches the client, unchanged, and names the id the click carried.
    assert.ok(refused.text.includes(pickIdFor(DROPPED)), 'the sentence names the id that did not match')
    assert.equal(refusalText(disconnects), refused.text,
      'the record and the sentence the client reads are one string')

    assert.equal(records(lines, 'pickerPick')[0].known, false, 'the pick is still reported, with no row')
    assert.equal(dialogs.length, 1, 'no dialog opens for a server the lane does not offer')
    assert.equal(leg.metrics.pickerServerDialogs, 0)
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { unknown_server: 1 })
    assert.equal(records(lines, 'configurationEnded')[0].reason, 'pick_refused')
    assert.deepEqual(clientErrors, [])
  })
})

test('#615 an offer that drops a row under an open dialog refuses that row\'s verb', async () => {
  const rows = [{ name: SERVER }]
  await withPickerLane(async ({ leg, lines, verbs, dialogs, disconnects, clientErrors, click }) => {
    // The server's own dialog is on screen, read off the frame the client decoded.
    click(dialogIds(dialogs[0])[0])
    await settleUntil(() => dialogs.length === 2, "the server's own dialog")

    // The list changes while that dialog is open. The click the player then makes
    // names a dialog the lane no longer offers a row for.
    rows.length = 0
    click(verbIdFor('claim', SERVER))
    await settleUntil(() => records(lines, 'pickerVerbRefused').length === 1, 'the refused verb')
    await settleUntil(() => disconnects.length === 1, 'the sentence at the client')

    const [refused] = records(lines, 'pickerVerbRefused')
    assert.equal(refused.id, verbIdFor('claim', SERVER))
    assert.equal(refused.verb, 'claim')
    assert.equal(refused.slug, SLUG)
    assert.equal(refused.server, null, 'the row was not found, so there is no server name to record')
    assert.equal(refused.reason, 'unknown_server',
      'a click on a dialog the list has moved past is refused as a stale server, and never acted on')
    assert.ok(refused.text.includes(verbIdFor('claim', SERVER)),
      'the sentence names the id the frame carried, which is the click the player made')
    assert.equal(refusalText(disconnects), refused.text,
      'and the player reads the sentence the record carries')

    assert.equal(leg.metrics.pickerVerbs, 0, 'a refused verb is not a verb the lane was asked to act on')
    assert.deepEqual(verbs, [], 'and the caller is told nothing was acted on')
    assert.deepEqual(leg.claims, [], 'the refused claim records nothing')
    assert.equal(leg.metrics.pickerClaims, 0)
    assert.equal(records(lines, 'configurationEnded')[0].reason, 'verb_refused')
    assert.deepEqual(clientErrors, [])
  }, { rows })
})

// #616: the refused disconnect is the second instance of #435's defect — a refusal that
// reached the record and not the map — so the two numbers are read off one run here.
// The claim is granted and its landing fails, which is the state #267 leaves: the client
// reads the list again and its claim stands, so the Disconnect it clicks is refused by
// its own claim and by nothing else.
test('#616 a disconnect refused by a claim is counted in the refusal map', async () => {
  // A body that is not up: the claim is recorded all the same, and the client is handed
  // the list again titled with the body that did not answer. The answer the claim dials
  // with is this test's, stated once at the harness (#824).
  const dialNothing = () => ({ connected: false, reason: 'body_unreachable' })
  await withPickerLane(async ({ leg, lines, disconnects, clientErrors, click }) => {
    click(verbIdFor('claim', SERVER))
    await settleUntil(() => records(lines, 'pickerClaimRestored').length === 1, 'the claim to stand at the picker')
    assert.equal(leg.metrics.pickerRefusals, 0, 'a claim the lane granted is not a refusal')

    click(verbIdFor('disconnect', SERVER))
    await settleUntil(() => records(lines, 'pickerDisconnectRefused').length === 1, 'the refused disconnect')
    await settleUntil(() => disconnects.length === 1, 'the sentence at the client')

    // The map #417 and #435 made the complete count, and the disconnect's own number
    // (#261). Both are read off this run, so neither can be right while the other is
    // wrong: the refusal is the whole total, because this run made no other.
    assert.deepEqual(leg.metrics.pickerRefusalsByReason, { disconnect_claimed: 1 })
    assert.equal(leg.metrics.pickerRefusals, 1)
    assert.equal(leg.metrics.pickerDisconnectsRefused, 1)
    assert.equal(leg.metrics.pickerDisconnects, 0, 'nothing ended: the claim still holds the body')

    const [refused] = records(lines, 'pickerDisconnectRefused')
    assert.equal(refused.reason, 'disconnect_claimed', 'the record carries the word the map is keyed by')
    assert.equal(refused.driver, NAME, 'and the claim that refused it')
    assert.equal(refusalText(disconnects), refused.text,
      'the record and the sentence the client reads are one string')
    assert.deepEqual(clientErrors, [])
  }, { callIns: { setConnectClaimedBody: dialNothing } })
})

test('#615 a verb this dialog does not offer is refused in words that name it', async () => {
  await withPickerLane(async ({ leg, lines, disconnects, clientErrors, click }) => {
    // The one click this file composes by hand: `verbIdFor` throws for a verb the
    // dialog does not offer, so no builder reaches this id. `monoplayer:` is the verb
    // namespace src/core/picker.js keeps to itself: if it moves, this case fails as an
    // unknown id rather than an unknown verb, which is the failure that should be read.
    click('monoplayer:teleport/' + SLUG)
    await settleUntil(() => records(lines, 'pickerVerbRefused').length === 1, 'the refused verb')
    await settleUntil(() => disconnects.length === 1, 'the sentence at the client')

    const [refused] = records(lines, 'pickerVerbRefused')
    assert.equal(refused.slug, SLUG)
    assert.equal(refused.verb, 'teleport')
    assert.equal(refused.reason, 'unknown_verb', 'the id read as a verb, and the verb is not one the dialog offers')
    assert.equal(refusalText(disconnects), refused.text)
    assert.equal(leg.metrics.pickerVerbs, 0)
    assert.equal(records(lines, 'configurationEnded')[0].reason, 'picker_refused')
    assert.deepEqual(clientErrors, [])
  })
})


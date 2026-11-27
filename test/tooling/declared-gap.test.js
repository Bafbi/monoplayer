// #940: a declared expected-absent operator step outlives its ticket unless a guard reads the code
// it excuses.
//
// `openUntil` names the tickets that close a step a run taken today cannot see:
// `OPERATOR_STEPS` in src/driver/dev-proof.js, and `UNMODDED_STEPS` in
// src/driver/checks.js. Either witness may record that step `not-seen`, and only that step
// (`gapSplit` in src/driver/checks.js). The declaration is true on the day it is written,
// and nothing makes it false later: the ticket closes, the code changes, and the declaration keeps
// excusing a step nobody is working on. That is the moment a known gap becomes a permanent one.
//
// #963 gave a run's verdict room to print a stale declaration as a line. This file gives the gate
// the power to fail on it. A warning a human reads is a decision; a refusal is a mechanism.
//
// Why it reads code and not GitHub. `mise run check` runs offline, and a network call
// inside the gate is a flake with a latency: it would fail a branch for a reason the branch did not
// cause. A step declared absent because "the spectator has no body" is stale the day that feature
// lands, and that is a fact about `src/`, not about GitHub. So every row below drives the
// code the ticket is about and asks whether the gap is still there.
//
// The rows. One per ticket an `openUntil` may name, so a declaration cannot name a ticket
// this file has no read for: the walk refuses that, and names the row to add.
// `observe` runs the code the declaration is about; `gap` says whether what it
// saw is still the gap; `landed` is what the same read reports on the day the ticket
// lands, so the judgement can be asked the other way without a network and without a patched tree;
// `where` is the seam, so a failure names the file to extend when a fix lands beside it
// rather than in it.
//
// The walk is over both lists, so the first declaration on either one is born guarded instead of
// discovered later. A step that declares nothing needs no row here: the judgements are keyed by
// ticket, and a declaration is what reaches them.
//
// What it does not do: refuse a witness. A fix landing must not turn an honest record red (#920), so
// a witness that recorded a declared step seen still verifies, and #963's
// `stale declaration:` line is what says so at run time. This file is the other half, and
// it fails the change that leaves the declaration behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OPERATOR_LIST_NAME, OPERATOR_STEPS } from '../../src/driver/dev-proof.js'
import { UNMODDED_LIST_NAME, UNMODDED_STEPS } from '../../src/driver/checks.js'
import { pickSlug } from '../../src/core/picker.js'
// The fake-integration rig, and the only seam that covers all three places a fix can land: this
// core is the real `createMonoplayer` (src/service/monoplayer.js) on fake legs, so the
// entry #647 writes and the replay #645 filters are both read where they are written.
import { makeCore } from '../support/harness.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// This file as the page that tells an operator to drop the field names it, so the mechanism is
// reachable from the document that states the rule.
const THIS_FILE = 'test/tooling/declared-gap.test.js'
const PAGE = 'docs/driver-lane.md'

// The lists a declaration can live in, with the name each prints in a stale-declaration line, so a
// refusal says which constant to edit. Read from the modules that own them, never copied: a step
// added to either list reaches this walk.
const LISTS = Object.freeze([
  { name: OPERATOR_LIST_NAME, steps: OPERATOR_STEPS },
  { name: UNMODDED_LIST_NAME, steps: UNMODDED_STEPS }
])

// ---------------------------------------------------------------------------
// The fixture the two reads drive
// ---------------------------------------------------------------------------
//
// Local copies of test/service/spectate.test.js's fixture helpers: a guard that shares a helper with
// the test it watches fails when that test is edited, and a false red costs more than these lines.
// The rig below is the shared one on purpose, because driving the real core is what makes a row
// cover a fix wherever in it the fix lands.

const TARGET = { host: '127.0.0.1', port: 25566 }
const CLAIMED = { body: pickSlug(TARGET.host + ':' + TARGET.port), target: TARGET }
const PLAYER = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const WATCHER = '11111111-2222-3333-4444-555555555555'
const PUPPET = 'ea45ba2e-f47d-43ee-9604-b20af90be1f1'
const TEXTURES = { name: 'textures', value: 'dGV4dHVyZXM=', signature: 'c2lnbmF0dXJl' }
const SKIN_CONFIG = { picker: true, skin: { showPuppetSkin: true }, puppet: { username: 'Wiriaw', uuid: PUPPET } }

// The two frames #645's gap is made of: ordinary cached state that says what the body is doing, and
// that src/legs/live-front.js refuses a spectator live (`DRIVER_ONLY_FRAMES`).
const MODE_FRAMES = new Set(['game_state_change', 'abilities'])

function warmABody (backendLeg) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', buffer: Buffer.from('config:registry_data') })
  backendLeg.deliver({ state: 'play', name: 'login', buffer: Buffer.from('play:login'), data: { entityId: 42 } })
  backendLeg.deliver({ state: 'play', name: 'position', buffer: Buffer.from('play:position'), data: { x: 1, y: 2, z: 3 } })
  backendLeg.deliver({ state: 'play', name: 'chunk_batch_finished', buffer: Buffer.from('marker'), data: {} })
}

async function landABody (rig) {
  const dial = rig.core.connectClaimedBody(CLAIMED)
  await Promise.resolve()
  warmABody(rig.backendLeg)
  rig.clock.tick(50)
  const landed = await dial
  assert.equal(landed.connected, true, 'the fixture body lands')
}

// The backend's own frame for the puppet, as Paper sends it: the one skin the proxy will ever send,
// and the moment it has one.
function deliverPlayerInfo ({ backendLeg }) {
  backendLeg.deliver({
    state: 'play',
    name: 'player_info',
    buffer: Buffer.from('play:player_info:' + TEXTURES.value),
    data: {
      action: { _value: 14, add_player: true, update_listed: true },
      data: [{ uuid: PUPPET, player: { name: 'Wiriaw', properties: [TEXTURES] } }]
    }
  })
}

// The proxy's own entries. The relayed player_info is a raw frame and belongs to the backend, so
// only the synthesized kind is the proxy's.
const skinFrames = frontLeg =>
  frontLeg.frames().filter(frame => frame.name === 'player_info' && frame.kind === 'synth')

// ---------------------------------------------------------------------------
// One read per ticket an openUntil may name
// ---------------------------------------------------------------------------

const READS = Object.freeze({
  // #647: a spectator's client is in spectator game mode and is not a spectator by the client's own
  // test, because `isSpectator()` reads the player-list entry for the local UUID. The fix
  // is one entry naming the spectator, with game mode 3 and no texture property, on its own
  // channel. Handed no skin today, a landing writes no entry naming it: that absence is this read.
  647: {
    file: 'src/service/monoplayer.js',
    where: 'its spectateView, on the fake legs test/support/harness.js builds',
    observe: async () => {
      const rig = makeCore({ config: SKIN_CONFIG })
      await landABody(rig)
      deliverPlayerInfo(rig)
      rig.core.attachPlayer({ name: 'Pilot', uuid: PLAYER })
      // No skin: the account's hasJoined answer carried no textures property, which is the case
      // #614 pins and the one a fix has to cover, because a spectator with no account skin is still
      // a spectator.
      const before = skinFrames(rig.frontLeg).length
      rig.core.spectateView({ name: 'Watcher', uuid: WATCHER, channel: 'spectator-channel' })
      const landing = skinFrames(rig.frontLeg).slice(before)
      return { landing: landing.flatMap(frame => frame.packet.data.map(entry => entry.uuid)) }
    },
    // The gap: no entry the landing wrote names the spectator.
    gap: seen => !seen.landing.includes(WATCHER),
    landed: { landing: [PUPPET, WATCHER] },
    saw: seen => 'the landing writes ' + seen.landing.length + ' player-list ' +
      (seen.landing.length === 1 ? 'entry' : 'entries') + ', and one of them names the spectator'
  },

  // #645: a spectator's replay still carries the body's own game_state_change and abilities, and the
  // live path does not, so the two paths disagree about whose mode a socket is told. The fix drops
  // the body's copy from the replay, leaving the spectator's own pair as the only mode frames on
  // that socket. Until then the replay carries them, and that is this read.
  645: {
    file: 'src/service/monoplayer.js',
    where: 'its spectateView replay, which synthAttach in src/core/join-synth.js builds',
    observe: async () => {
      const rig = makeCore({ config: { picker: true } })
      await landABody(rig)
      rig.core.attachPlayer({ name: 'Pilot', uuid: null })
      // The body's own mode, cached: the replay is what hands it to a spectator that lands after.
      rig.backendLeg.deliver({
        state: 'play',
        name: 'abilities',
        buffer: Buffer.from('play:abilities'),
        data: { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }
      })
      rig.backendLeg.deliver({
        state: 'play',
        name: 'game_state_change',
        buffer: Buffer.from('play:game_state_change'),
        data: { reason: 3, gameMode: 0 }
      })
      const mark = rig.frontLeg.frames().length
      rig.core.spectateView({ name: 'Watcher', channel: 'spectator-channel' })
      const landed = rig.frontLeg.frames().slice(mark)
      // A replayed frame is the cache's (kind 'raw'). The spectator's own pair is the proxy's (kind
      // 'packet'), and that one is what an honest fix leaves behind.
      return { replayed: landed.filter(frame => frame.kind === 'raw' && MODE_FRAMES.has(frame.name)).map(frame => frame.name) }
    },
    // The gap: the replay carries at least one of the body's mode frames.
    gap: seen => seen.replayed.length > 0,
    landed: { replayed: [] },
    saw: seen => 'the replay carries ' + seen.replayed.length + " of the body's own mode frames"
  }
})

// One drive per row per run: two cases read the same observation, and a second makeCore would make
// them read two runs.
const observations = new WeakMap()
async function observation (read) {
  if (!observations.has(read)) observations.set(read, await read.observe())
  return observations.get(read)
}

// Every step either list declares expected absent, as a row: the list's name, the step, and the
// tickets that close it.
function declared (lists) {
  const rows = []
  for (const list of lists) {
    for (const step of list.steps) {
      if ((step.openUntil ?? null) === null) continue
      rows.push({ list: list.name, id: step.id, openUntil: step.openUntil })
    }
  }
  return rows
}

// The lists a refusal names, with the conjunction that reads as a sentence for one or two.
function namesOf (lists) {
  const names = lists.map(list => list.name)
  return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' or ' + names.at(-1)
}

// What is wrong with the tree: one sentence per declared step whose ticket has landed, one per
// ticket no row can read, and one per row nothing declares any more.
//
// lists and reads are parameters because a case has to ask the walk about a world that is not
// today's: a declaration whose ticket closed, and a read whose code landed. Every caller in the
// tree passes neither.
async function refusals ({ lists = LISTS, reads = READS } = {}) {
  const found = []
  const rows = declared(lists)
  for (const row of rows) {
    for (const ticket of row.openUntil) {
      const read = reads[ticket]
      // A ticket the guard cannot read is refused, not excused: a declaration naming one would pass
      // every check here and excuse its step forever.
      if (read === undefined) {
        found.push('`' + row.id + '` in ' + row.list + ' declares #' + ticket + ' expected absent, and ' +
          'this guard has no read for #' + ticket + ': add the row that shows the gap to ' +
          'test/tooling/declared-gap.test.js, in the change that adds the declaration')
        continue
      }
      const seen = await observation(read)
      if (read.gap(seen)) continue
      // The reason this file exists: the ticket landed and the declaration stayed.
      found.push('`' + row.id + '` in ' + row.list + ' declares #' + ticket + ' expected absent, and ' +
        "the code no longer shows that gap: " + read.saw(seen) + ". Drop the step's `openUntil` in the " +
        'change that closes #' + ticket + ', and drop this row with it. The read drives ' +
        read.file + ' through ' + read.where + ', so a fix that landed elsewhere needs the row ' +
        'extended rather than the ' +
        'declaration kept')
    }
  }
  // A row nothing declares is the same lie one step later: the declaration went, and the guard still
  // claims a gap to watch. It is also what a broken walk looks like from here, because a walk that
  // reads no list reads no declaration.
  const named = new Set(rows.flatMap(row => row.openUntil))
  const names = namesOf(lists)
  for (const ticket of Object.keys(reads)) {
    if (named.has(Number(ticket))) continue
    found.push('this guard holds a read for #' + ticket + ' and no step of ' + names +
      ' declares it any more: drop the row in the change that dropped the last openUntil naming #' + ticket)
  }
  return found
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

test('every declared expected-absent step is still a gap in the code this tree has', async () => {
  // The case the gate runs. A declaration whose ticket landed fails here, and the sentence names
  // the step, the ticket, and the field to drop.
  assert.deepEqual(await refusals(), [],
    'a declared gap that the code no longer shows is a known gap turned permanent:')
})

test('a declaration whose ticket has landed is refused, naming the step and the ticket', async () => {
  // The real case, and the one this file exists for: #647 lands, the operator records the step
  // seen, and the declaration stays. Each row is asked the other way through its own landed
  // observation, so this needs neither a network nor a patched tree, and it reads the judgement the
  // gate runs rather than a copy of it.
  for (const [ticket, read] of Object.entries(READS)) {
    const lists = [{ name: OPERATOR_LIST_NAME, steps: [{ id: 'a-declared-step', openUntil: [Number(ticket)] }] }]
    const landed = { ...read, observe: async () => read.landed }
    // The row under test alone: a second row would be dead in this fixture and refuse for that
    // reason instead, which is the case below.
    const found = await refusals({ lists, reads: { [ticket]: landed } })
    assert.equal(found.length, 1, 'one refusal for one landed ticket: ' + found.join(' | '))
    assert.match(found[0], /a-declared-step/, 'the refusal names the step')
    assert.match(found[0], new RegExp('#' + ticket), 'and the ticket that closed it')
    assert.match(found[0], /Drop the step's `openUntil`/, 'and asks for the declaration to go')
  }
})

test('a ticket that closed without the code changing is left alone, because this file reads code', async () => {
  // The blind spot, written down so it is a decision and not an accident. Nothing offline can read a
  // ticket's state: the gate runs with no network, and a guard that asked GitHub would fail a branch
  // for a reason the branch did not cause. So a ticket closed as not-planned, superseded, or a
  // duplicate leaves its declaration standing until somebody changes the code or the row. A human
  // learns of it from #963's `stale declaration:` line when a witness records the step seen,
  // and from this row's absence when the code lands.
  const lists = [{ name: OPERATOR_LIST_NAME, steps: [{ id: 'spectator-own-body', openUntil: [647] }] }]
  assert.deepEqual(await refusals({ lists, reads: { 647: READS[647] } }), [],
    'a declaration whose gap the code still shows is true whether or not its ticket is open')
})

test('a declaration naming a ticket no row reads is refused, so a step cannot excuse itself unread', async () => {
  const lists = [{ name: UNMODDED_LIST_NAME, steps: [{ id: 'join', openUntil: [649] }] }]
  const found = await refusals({ lists })
  assert.equal(found.length, 1 + Object.keys(READS).length, 'the unknown ticket, and the two rows it leaves unread')
  assert.match(found[0], /in UNMODDED_STEPS declares #649/)
  assert.match(found[0], /this guard has no read for #649/)
})

test('a read no declaration names is refused, so a row cannot outlive the gap it watched', async () => {
  const found = await refusals({ lists: [{ name: OPERATOR_LIST_NAME, steps: [{ id: 'puppet-walks' }] }] })
  assert.equal(found.length, Object.keys(READS).length, 'one refusal per dead row: ' + found.join(' | '))
  for (const sentence of found) {
    assert.match(sentence, /no step of OPERATOR_STEPS declares it any more/)
  }
})

test('the walk reads both step lists, and the steps it finds are the modules own', () => {
  // A walk over one list, or over a copy of it, reports no offenders and looks like a clean tree.
  assert.equal(LISTS.length, 2, 'two lists declare a gap')
  assert.equal(LISTS[0].steps, OPERATOR_STEPS, 'the dev lane reads the module list')
  assert.equal(LISTS[1].steps, UNMODDED_STEPS, 'and the G0 lane reads its own')
  assert.deepEqual(LISTS.map(list => list.name), [OPERATOR_LIST_NAME, UNMODDED_LIST_NAME],
    'and each is walked under the name its stale-declaration line prints')
})

test('the page that tells an operator to drop the field names the guard that fails without it', () => {
  // A rule stated on a page and enforced by a file is two homes, and the page's reader is the one
  // who has to find the second. `env-overlay-surface.test.js` holds its own page this way.
  const page = fs.readFileSync(path.join(ROOT, PAGE), 'utf8')
  assert.ok(page.includes(THIS_FILE), PAGE + ' names ' + THIS_FILE + ', the guard a stale declaration fails')
})

test('every row is keyed by the ticket it reads, and tells a landed world from the tree', async () => {
  // A key that is not a ticket number is a row no declaration can reach: the walk looks a ticket up
  // by its number, and the dead-row check compares numbers too.
  for (const ticket of Object.keys(READS)) {
    assert.match(ticket, /^[0-9]+$/, 'DECLARED_GAPS is keyed by ticket number, and ' + ticket + ' is not one')
  }
  // The landed example is hand-written, so this is what holds it to the judgement: it has to flip
  // the row's answer, and the row has to name a seam that exists.
  for (const [ticket, read] of Object.entries(READS)) {
    const seen = await observation(read)
    assert.equal(read.gap(seen), true, '#' + ticket + ': the tree still shows the gap the declaration names')
    assert.equal(read.gap(read.landed), false, '#' + ticket + ': the landed example is a world with no gap')
    assert.ok(fs.existsSync(path.join(ROOT, read.file)), '#' + ticket + ' names the file its read drives: ' + read.file)
    assert.ok(read.saw(read.landed).length > 20, '#' + ticket + ' says what it saw when the gap is gone')
  }
})

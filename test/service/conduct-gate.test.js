// #21: the configuration gate as the core sees it.
//
// The relay, the hold and the answer write are #16's (test/service/control-dialog.test.js).
// What this ticket adds is the decision on the other side of the wire: the
// puppet leg answers a gate itself only while no client is attached, and it
// tells the core before the gate frame arrives, so the holder never offers a
// closed gate to the next client.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeClock, makeCore } from '../support/harness.js'
import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

function attachConfiguring (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  const decision = rig.frontLeg.loginStart({ name, uuid })
  assert.equal(decision.phase, 'configuring')
  return rig.core.attachConfiguringPlayer({ name, uuid })
}

const gate = () => ({ state: 'configuration', name: 'code_of_conduct', buffer: Buffer.from('conduct') })

// The warm join prefix, so a test can put the puppet in play with a dialog
// still held from its configuration phase.
function joinPrefix (rig) {
  for (const frame of [
    { name: 'login', data: { entityId: 42, viewDistance: 10 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) rig.backendLeg.deliver({ state: 'play', ...frame })
}

function attach (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  rig.frontLeg.loginStart({ name, uuid })
  return rig.core.attachPlayer({ name, uuid, includeConfig: false })
}

test('#21 a gate the puppet accepted itself is not held for a later client', () => {
  const rig = makeCore()
  // The leg's write wrapper accepted the gate on the puppet connection before
  // this frame reached the core, and said so.
  rig.core.notePuppetDialogAnswer({ state: 'configuration' })
  rig.backendLeg.deliver(gate())

  assert.equal(rig.core.metrics.controlDialogsPuppetAnswered, 1,
    'the gate is answered, so the proxy does not ask the human')
  assert.equal(rig.core.pendingDialog.held, false, 'and nothing waits for a client')

  // A client that arrives afterwards in its own configuration phase is not
  // shown a gate the server already considers closed.
  attachConfiguring(rig)
  rig.frontLeg.clientConfiguring({})
  const relayed = rig.frontLeg.frames().filter(frame => frame.name === 'code_of_conduct')
  assert.equal(relayed.length, 0)
  assert.equal(rig.core.metrics.controlDialogsResent, 0)
})

test('#21 another configuration dialog follows the gate path', () => {
  // The code of conduct is not a special case in the router: any configuration
  // dialog is the human's, crosses to the client in its own state, and comes
  // back as the puppet's own frame.
  const rig = makeCore()
  attachConfiguring(rig)
  rig.backendLeg.deliver({
    state: 'configuration',
    name: 'show_dialog',
    buffer: Buffer.from('config-dialog'),
    data: { dialog: {} }
  })
  const relayed = rig.frontLeg.frames().filter(frame => frame.name === 'show_dialog' && frame.kind === 'raw')
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].meta.state, 'configuration')
  assert.equal(rig.core.pendingDialog.peek()?.state, 'configuration')

  const answer = Buffer.from('client-click')
  rig.frontLeg.serverbound({
    name: 'custom_click_action',
    state: 'configuration',
    buffer: answer,
    data: { id: 'paper:accept' }
  })
  const writes = rig.backendLeg.rawWrites()
  assert.equal(writes.at(-1).buffer, answer, 'the client frame is the one the backend receives')
  assert.deepEqual(writes.at(-1).meta, { state: 'configuration', name: 'custom_click_action' })
  assert.equal(rig.core.pendingDialog.held, false)
  assert.equal(rig.core.metrics.controlDialogsAnswered, 1)
})

test('#21 a gate held for the human is not re-sent after the human answered it', () => {
  const rig = makeCore()
  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())
  assert.equal(rig.core.pendingDialog.held, true)
  assert.equal(rig.frontLeg.frames().filter(frame => frame.name === 'code_of_conduct').length, 1,
    'the attached client receives the gate')

  rig.frontLeg.serverbound({
    name: 'accept_code_of_conduct',
    state: 'configuration',
    buffer: Buffer.from('client-accept')
  })
  assert.equal(rig.core.pendingDialog.held, false)
  assert.equal(rig.core.metrics.controlDialogsAnswered, 1)
  const writes = rig.backendLeg.rawWrites()
  assert.deepEqual(writes.at(-1).meta, { state: 'configuration', name: 'accept_code_of_conduct' },
    'the human answer is the frame the backend receives')

  // The human leaves: a gate they already accepted is not a question that
  // waits for the next client, so there is nothing left to re-send.
  rig.core.detachPlayer({ reason: 'player_quit' })
  assert.equal(rig.core.pendingDialog.held, false)
  assert.equal(rig.core.metrics.controlDialogsResent, 0)
  assert.equal(rig.frontLeg.frames().filter(frame => frame.name === 'code_of_conduct').length, 1)
})

test('#73 a configuration gate held when the last client detaches is answered as the puppet', () => {
  const rig = makeCore()
  // The real leg reports a written accept through `onDialogAnswered` (#21), the
  // same way it does at connect. The fake leg only records the ask, so the test
  // supplies that report: the marker it arms is the one the core must spend.
  const asked = rig.backendLeg.answerHeldGate
  rig.backendLeg.answerHeldGate = request => {
    const outcome = asked(request)
    if (outcome.answered === true) rig.core.notePuppetDialogAnswer({ state: 'configuration' })
    return outcome
  }

  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())
  assert.equal(rig.core.pendingDialog.held, true, 'the human has the gate, unanswered')

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.equal(rig.core.attached, false)
  assert.deepEqual(rig.backendLeg.heldGateAnswers(), [{ state: 'configuration', name: 'code_of_conduct' }],
    'the leg answers the gate the client left, as the puppet')
  assert.equal(rig.core.pendingDialog.held, false, 'and it is no longer a question for the next client')
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 1)
  assert.equal(rig.core.logs().filter(line => line.includes('"event":"controlDialogAnsweredOnDetach"')).length, 1,
    'the answer is logged, not silent')

  // The next gate is a real question: the answer the leg reported belongs to
  // the gate it just dropped, not to the next show.
  rig.backendLeg.deliver({
    state: 'configuration',
    name: 'show_dialog',
    buffer: Buffer.from('config-dialog'),
    data: { dialog: {} }
  })
  assert.equal(rig.core.pendingDialog.peek()?.name, 'show_dialog', 'the next gate is held, not swallowed as answered')
  assert.equal(rig.core.metrics.controlDialogsHeld, 1, 'it is a question with no client, so it is held')
  assert.equal(rig.core.metrics.controlDialogsPuppetAnswered, 0, 'and it is not counted as answered by the puppet')
})

test('#73 a gate the puppet is no longer in configuration for is left held', () => {
  // The backend asked the gate before the play login and never withdrew it, so
  // the holder still has it while the puppet is in play. Answering it there
  // would write a configuration frame into a play connection.
  const rig = makeCore()
  rig.backendLeg.deliver(gate())
  joinPrefix(rig)
  attach(rig)
  assert.equal(rig.core.pendingDialog.peek()?.state, 'configuration')

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.deepEqual(rig.backendLeg.heldGateAnswers(), [], 'nothing is answered in the wrong phase')
  assert.equal(rig.core.pendingDialog.held, true, 'it waits for a client that can answer it')
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 0)
  assert.equal(rig.core.logs().filter(line => line.includes('"reason":"puppet_state"')).length, 1,
    'the withholding is logged with the phase it failed')
})

test('#73 a shutdown detaches without answering the held gate', async () => {
  // The backend socket closes on the next statement, so the answer would be a
  // frame nobody receives.
  const rig = makeCore()
  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())
  assert.equal(rig.core.pendingDialog.held, true)

  await rig.core.stop({ reason: 'test_stop' })

  assert.deepEqual(rig.backendLeg.heldGateAnswers(), [])
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 0)
})

test('#73 a leg that cannot answer leaves the gate held, and says so', () => {
  // The leg that cannot answer is the one that never carried the call-in: the core
  // learns that from BACKEND_LEG_CALL_INS when it wires the leg (#605), so the hole
  // is made before the core is built and the start record names it. A leg that
  // carried it and then throws is the case below.
  const backendLeg = createFakeBackendLeg()
  delete backendLeg.answerHeldGate
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: null } }),
    backendLeg,
    frontLeg,
    clock: fakeClock()
  })
  core.start()
  assert.deepEqual(core.legWiring.backend.missing, ['answerHeldGate'],
    'the leg that cannot answer is named at start, before a gate is ever held')
  const rig = { backendLeg, frontLeg, core }
  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.equal(rig.core.pendingDialog.held, true, 'it waits for a client that can answer it')
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 0)
  const withheld = rig.core.logs().filter(line => line.includes('leg_cannot_answer'))
  assert.equal(withheld.length, 1, 'and the refusal is logged, not silent')
})

test('#73 a leg that throws leaves the gate held instead of escaping the detach', () => {
  // detachPlayer runs inside the front leg's socket event, so a throw here
  // would leave the core half detached rather than refuse.
  const rig = makeCore()
  rig.backendLeg.answerHeldGate = () => { throw new Error('socket closed') }
  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.equal(rig.core.attached, false, 'the detach still completes')
  assert.equal(rig.core.pendingDialog.held, true, 'the gate waits for a client that can answer it')
  const refused = rig.core.logs().filter(line => line.includes('"reason":"leg_error"'))
  assert.equal(refused.length, 1, 'and the failure is logged with its reason')
})

test('#73 a leg that refuses leaves the gate held, and logs the reason it gave', () => {
  // The wrapper answers false when a client attached in the meantime and when
  // the accept could not be written: the gate is still open either way.
  const rig = makeCore()
  rig.backendLeg.answerHeldGate = () => ({ answered: false, reason: 'not_written' })
  attachConfiguring(rig)
  rig.backendLeg.deliver(gate())

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.equal(rig.core.pendingDialog.held, true, 'a refused answer is not an answer')
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 0)
  const refused = rig.core.logs().filter(line => line.includes('"reason":"not_written"'))
  assert.equal(refused.length, 1, 'the leg\'s own reason reaches the log')
})

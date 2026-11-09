// #21: the configuration gate as the core sees it.
//
// The relay, the hold and the answer write are #16's (test/service/control-dialog.test.js).
// What this ticket adds is the decision on the other side of the wire: the
// puppet leg answers a gate itself only while no client is attached, and it
// tells the core before the gate frame arrives, so the holder never offers a
// closed gate to the next client.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMonoplayer, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

function makeCore () {
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER]
    },
    backendLeg,
    frontLeg,
    clock: { now: () => 0, setTimeout: () => null, clearTimeout: () => {} },
    logStream: null
  })
  core.start()
  return { backendLeg, frontLeg, core }
}

function attachConfiguring (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  const decision = rig.frontLeg.loginStart({ name, uuid })
  assert.equal(decision.phase, 'configuring')
  return rig.core.attachConfiguringPlayer({ name, uuid })
}

const gate = () => ({ state: 'configuration', name: 'code_of_conduct', buffer: Buffer.from('conduct') })

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

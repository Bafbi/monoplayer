// #16: the human-answer path for control dialogs.
//
// A control dialog is the server asking the human a question: `show_dialog` in
// play or in configuration, and `code_of_conduct` in configuration. The proxy
// relays it to the attached client, forwards the client's answer to the backend
// as the puppet's own frame, and holds the last unanswered dialog so a client
// that attaches later still receives it.
//
// The policy on top of this seam is #20 (play dialogs) and #21 (configuration
// gates), so nothing here asserts an answer the proxy invents.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'

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

// A backend in play with the join prefix warm, no client attached.
function warmBackend () {
  const rig = makeCore()
  joinPrefix(rig)
  assert.equal(rig.core.session.warmReady, true)
  return rig
}

function attach (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  rig.frontLeg.loginStart({ name, uuid })
  return rig.core.attachPlayer({ name, uuid, includeConfig: false })
}

// The client's own configuration phase begins (the front reports it).
function clientConfiguring (rig, args = {}) {
  return rig.frontLeg.clientConfiguring(args)
}

// An early attach: the client follows the puppet's configuration stream.
function attachConfiguring (rig, { name = 'Bafbi', uuid = PLAYER } = {}) {
  rig.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  assert.equal(rig.core.backendConfiguring, true)
  const decision = rig.frontLeg.loginStart({ name, uuid })
  assert.equal(decision.phase, 'configuring')
  return rig.core.attachConfiguringPlayer({ name, uuid })
}

function relayedNames (rig, name) {
  return rig.frontLeg.frames().filter(frame => frame.name === name && frame.kind === 'raw')
}

test('#16 a play dialog reaches the attached client', () => {
  const rig = warmBackend()
  attach(rig)
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })

  const relayed = relayedNames(rig, 'show_dialog')
  assert.equal(relayed.length, 1, 'the dialog crosses once')
  assert.equal(relayed[0].buffer.toString(), 'play-dialog', 'the frame crosses byte for byte')
  assert.equal(relayed[0].meta.state, 'play')
  assert.equal(rig.core.metrics.controlDialogsRelayed, 1)
  assert.equal(rig.core.pendingDialog.peek().name, 'show_dialog', 'and it stays pending until answered')
})

test('#16 the client answer reaches the backend as the puppet frame, in its own state', () => {
  const rig = warmBackend()
  attach(rig)
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })

  const answer = Buffer.from('client-click')
  rig.frontLeg.serverbound({ name: 'custom_click_action', buffer: answer, data: { id: 'paper:go' } })

  const writes = rig.backendLeg.rawWrites()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].buffer, answer, 'the human answer is the frame the backend receives')
  assert.deepEqual(writes[0].meta, { state: 'play', name: 'custom_click_action' })
  assert.equal(rig.core.metrics.controlDialogsAnswered, 1)
  assert.equal(rig.core.pendingDialog.held, false, 'an answered dialog is no longer pending')
})

test('#16 a configuration gate reaches the configuring client and its answer carries the state', () => {
  const rig = makeCore()
  attachConfiguring(rig)

  rig.backendLeg.deliver({
    state: 'configuration',
    name: 'code_of_conduct',
    buffer: Buffer.from('conduct')
  })
  const relayed = relayedNames(rig, 'code_of_conduct')
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].meta.state, 'configuration', 'the client parses it in its own phase')

  const answer = Buffer.from('client-accept')
  rig.frontLeg.serverbound({ name: 'accept_code_of_conduct', state: 'configuration', buffer: answer })
  const writes = rig.backendLeg.rawWrites()
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].meta, { state: 'configuration', name: 'accept_code_of_conduct' },
    'the configuration answer reaches the puppet in configuration state, not play')
  assert.equal(rig.core.pendingDialog.held, false)
})

test('#16 a dialog with no client attached is held and re-sent on attach', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({
    state: 'configuration',
    name: 'code_of_conduct',
    buffer: Buffer.from('conduct')
  })
  assert.equal(relayedNames(rig, 'code_of_conduct').length, 0, 'nothing is relayed with no client')
  assert.equal(rig.core.metrics.controlDialogsHeld, 1)
  assert.equal(rig.core.pendingDialog.peek().name, 'code_of_conduct')

  // The client arrives in configuration and follows the puppet's stream.
  const rig2 = makeCore()
  rig2.backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  rig2.backendLeg.deliver({ state: 'configuration', name: 'code_of_conduct', buffer: Buffer.from('conduct') })
  attachConfiguring(rig2)

  assert.equal(rig2.frontLeg.frames().filter(frame => frame.name === 'code_of_conduct').length, 0,
    'nothing is written during the client login phase: it would parse the gate as a login packet')

  clientConfiguring(rig2)
  const resent = rig2.frontLeg.frames().filter(frame => frame.name === 'code_of_conduct')
  assert.equal(resent.length, 1, 'the held gate is sent to the client that can answer it')
  assert.equal(resent[0].meta.state, 'configuration')
  assert.equal(rig2.core.metrics.controlDialogsResent, 1)
})

test('#16 a held dialog survives a detach and is re-sent on reattach', () => {
  const rig = warmBackend()
  attach(rig)
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })
  assert.equal(relayedNames(rig, 'show_dialog').length, 1)

  rig.core.detachPlayer({ reason: 'player_quit' })
  assert.equal(rig.core.attached, false)
  assert.equal(rig.core.pendingDialog.held, true, 'a detach does not drop the question')

  const before = relayedNames(rig, 'show_dialog').length
  attach(rig, { name: 'Bafbi', uuid: PLAYER })
  const after = relayedNames(rig, 'show_dialog')
  assert.equal(after.length, before + 1, 'the reattach gets the dialog again')
  assert.equal(after.at(-1).buffer.toString(), 'play-dialog')
  assert.equal(rig.core.metrics.controlDialogsResent, 1)
})

test('#16 clear_dialog withdraws the held dialog', () => {
  const rig = warmBackend()
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })
  rig.backendLeg.deliver({ state: 'play', name: 'clear_dialog', buffer: Buffer.from('clear') })

  assert.equal(rig.core.pendingDialog.held, false)
  assert.equal(rig.core.metrics.controlDialogsCleared, 1)

  attach(rig)
  assert.equal(relayedNames(rig, 'show_dialog').length, 0, 'a withdrawn dialog is never re-sent')
})

test('#16 a held configuration gate never reaches a client that arrives in play', () => {
  const rig = makeCore()
  rig.backendLeg.deliver({
    state: 'configuration',
    name: 'code_of_conduct',
    buffer: Buffer.from('conduct')
  })
  // The backend finishes its configuration and warms with no client attached.
  joinPrefix(rig)
  attach(rig)

  assert.equal(relayedNames(rig, 'code_of_conduct').length, 0,
    'a configuration frame in a play connection would be parsed as a play frame')
  assert.equal(rig.core.pendingDialog.held, true, 'it waits for a client that can answer it')
  const withheld = rig.core.logs().filter(line => line.includes('controlDialogWithheld'))
  assert.equal(withheld.length, 1, 'and the withholding is logged, not silent')
})

test('#16 an answer in the wrong state leaves the gate pending', () => {
  const rig = makeCore()
  attachConfiguring(rig)
  rig.backendLeg.deliver({ state: 'configuration', name: 'code_of_conduct', buffer: Buffer.from('conduct') })

  // A play click is not an answer to a configuration gate: the human never saw
  // that gate on a play connection, so the gate must still wait.
  rig.frontLeg.serverbound({ name: 'custom_click_action', state: 'play', buffer: Buffer.from('click') })
  assert.equal(rig.core.pendingDialog.held, true)
  assert.equal(rig.core.metrics.controlDialogsAnswered, 0)

  rig.frontLeg.serverbound({ name: 'accept_code_of_conduct', state: 'configuration', buffer: Buffer.from('ok') })
  assert.equal(rig.core.pendingDialog.held, false)
  assert.equal(rig.core.metrics.controlDialogsAnswered, 1)
})

test('#16 a dialog the puppet answered itself is not offered to the next client', () => {
  const rig = warmBackend()
  // The backend leg answers a configuration gate with MONOPLAYER_DIALOG_ACTION
  // before the core sees the frame, and reports it through onDialogAnswered. A
  // play dialog can never be reported that way (#20), so the marker is set
  // directly here to prove the core still spends it.
  rig.core.notePuppetDialogAnswer({ state: 'play' })
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('answered') })

  assert.equal(rig.core.pendingDialog.held, false, 'an answered dialog is never held')
  assert.equal(rig.core.metrics.controlDialogsPuppetAnswered, 1)
  attach(rig)
  assert.equal(relayedNames(rig, 'show_dialog').length, 0, 'and never re-sent on attach')
})

test('#16 the puppet-answered marker belongs to one show, in its own state', () => {
  const rig = warmBackend()
  rig.core.notePuppetDialogAnswer({ state: 'configuration' })
  // The marker is consumed by the first show, in any state, so a later play
  // dialog is held normally.
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('for-the-human') })
  assert.equal(rig.core.pendingDialog.held, true)
  assert.equal(rig.core.metrics.controlDialogsPuppetAnswered, 0)
})

test('#16 a backend teardown drops the held dialog', () => {
  const rig = warmBackend()
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })
  assert.equal(rig.core.pendingDialog.held, true)

  rig.backendLeg.deliverEnd({ reason: 'backend_restart' })
  assert.equal(rig.core.pendingDialog.held, false, 'a dialog from a dead session is not the next session\'s question')
})

// --- #20: the human owns every play dialog ---------------------------------

test('#20 a play dialog with no client attached waits and is delivered on attach', () => {
  const rig = warmBackend()
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })

  assert.equal(relayedNames(rig, 'show_dialog').length, 0, 'nothing is relayed with no client')
  assert.equal(rig.core.metrics.controlDialogsHeld, 1)
  assert.equal(rig.core.pendingDialog.peek().name, 'show_dialog')

  attach(rig)
  const relayed = relayedNames(rig, 'show_dialog')
  assert.equal(relayed.length, 1, 'the human receives it when they attach')
  assert.equal(relayed[0].meta.state, 'play')
  assert.equal(rig.core.metrics.controlDialogsResent, 1)
  assert.equal(rig.core.metrics.controlDialogsRelayed, 0, 'a re-send is not a live relay')
  assert.equal(rig.core.pendingDialog.held, true, 'it stays held until the human answers it')
})

test('#20 a newer play dialog replaces the held one', () => {
  const rig = warmBackend()
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('first') })
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('second') })

  assert.equal(rig.core.metrics.controlDialogsShown, 2)
  assert.equal(rig.core.pendingDialog.held, true, 'one dialog is outstanding at a time')

  attach(rig)
  const relayed = relayedNames(rig, 'show_dialog')
  assert.equal(relayed.length, 1, 'only the newer dialog is delivered')
  assert.equal(relayed[0].buffer.toString(), 'second')
})

test('#20 a play dialog that arrives before the cache is warm is delivered through the early attach', () => {
  // The client attaches while the puppet is still configuring, then the puppet
  // logs in and the server asks a play dialog before the join prefix is warm.
  // Nothing can be written to the client yet, so the holder keeps the dialog
  // and the early attach's replay delivers it.
  const rig = makeCore()
  attachConfiguring(rig)
  rig.core.attachPlayer({ name: 'Bafbi', uuid: PLAYER, includeConfig: false })
  assert.equal(rig.core.frontPlayReady, false)

  rig.backendLeg.deliver({ state: 'play', name: 'login', data: { entityId: 42 } })
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('pre-warm') })
  assert.equal(relayedNames(rig, 'show_dialog').length, 0, 'a pre-warm client cannot take a play frame')
  assert.equal(rig.core.pendingDialog.held, true)
  assert.equal(rig.core.metrics.controlDialogsHeld, 1)

  for (const frame of [
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'chunk_batch_start', data: {} },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) rig.backendLeg.deliver({ state: 'play', ...frame })

  assert.equal(rig.core.cache.warm, true)
  assert.equal(rig.core.frontPlayReady, true, 'the early attach is now play-ready')
  const relayed = relayedNames(rig, 'show_dialog')
  assert.equal(relayed.length, 1, 'the early attach delivers the dialog it arrived too soon for')
  assert.equal(relayed[0].buffer.toString(), 'pre-warm')
  assert.equal(rig.core.metrics.controlDialogsResent, 1)
  assert.equal(rig.frontLeg.frames().at(-1).name, 'show_dialog',
    'and it arrives after the replay, with the client in play')
})

test('#73 a play dialog held when the last client detaches stays held and unanswered', () => {
  const rig = warmBackend()
  attach(rig)
  rig.backendLeg.deliver({ state: 'play', name: 'show_dialog', buffer: Buffer.from('play-dialog') })
  assert.equal(relayedNames(rig, 'show_dialog').length, 1)

  rig.core.detachPlayer({ reason: 'player_quit' })

  assert.equal(rig.core.pendingDialog.held, true, 'a play dialog is the human\'s, so a detach does not answer it')
  assert.deepEqual(rig.backendLeg.heldGateAnswers(), [], 'the puppet answered nothing')
  assert.equal(rig.core.metrics.controlDialogsAnsweredOnDetach, 0)

  const before = relayedNames(rig, 'show_dialog').length
  attach(rig, { name: 'Bafbi', uuid: PLAYER })
  const after = relayedNames(rig, 'show_dialog')
  assert.equal(after.length, before + 1, 'the reattach gets the dialog again')
  assert.equal(after.at(-1).buffer.toString(), 'play-dialog')
})

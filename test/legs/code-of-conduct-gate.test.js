// #21: the code-of-conduct gate, at the write seam.
//
// The protocol library answers the gate itself: `client.once('code_of_conduct',
// () => client.write('accept_code_of_conduct', {}))` inside its configuration
// handler (minecraft-protocol client/play.js), which runs before the frame
// reaches the core. The leg's write wrapper is the one place that decides who
// answers it, so these tests drive the wrapper with a scripted write.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withCodeOfConductGate, withTransferIntent } from '../../src/legs/live-backend.js'

function rig ({ attached = false, writeThrows = false } = {}) {
  const writes = []
  const logs = []
  const markers = []
  let human = attached
  const write = withCodeOfConductGate(
    (name, params) => {
      writes.push({ name, params })
      if (writeThrows) throw new Error('socket closed')
      return true
    },
    {
      isHumanAttached: () => human,
      log: (event, fields = {}) => logs.push({ event, fields }),
      onDialogAnswered: marker => markers.push(marker)
    }
  )
  return {
    write,
    writes,
    logs,
    markers,
    attach: () => { human = true },
    detach: () => { human = false }
  }
}

const ACCEPT = ['accept_code_of_conduct', {}]

test('#21 an attached client keeps the gate: the library accept is swallowed', () => {
  const r = rig({ attached: true })
  assert.equal(r.write(...ACCEPT), false, 'the frame never reaches the wire')
  assert.equal(r.writes.length, 0)
  assert.deepEqual(r.logs, [{ event: 'codeOfConductHeld', fields: { reason: 'human_attached' } }])
  assert.deepEqual(r.markers, [], 'the gate is still the human\'s question')
})

test('#21 with no client attached the accept goes out, is logged, and is reported to the core', () => {
  const r = rig({ attached: false })
  assert.equal(r.write(...ACCEPT), true)
  assert.deepEqual(r.writes, [{ name: 'accept_code_of_conduct', params: {} }])
  assert.deepEqual(r.logs, [{ event: 'codeOfConductAccepted', fields: { reason: 'no_client' } }])
  assert.deepEqual(r.markers, [{ state: 'configuration', name: 'code_of_conduct' }],
    'the core must not hold a gate the server already considers closed')
})

test('#21 the decision is read at write time, so a detach changes it without rebuilding the leg', () => {
  const r = rig({ attached: true })
  r.write(...ACCEPT)
  assert.equal(r.writes.length, 0)

  r.detach()
  r.write(...ACCEPT)
  assert.equal(r.writes.length, 1, 'the same wrapper accepts once nobody is attached')

  r.attach()
  r.write(...ACCEPT)
  assert.equal(r.writes.length, 1, 'and holds again once a client is back')
})

test('#21 every other frame passes through untouched', () => {
  const r = rig({ attached: true })
  r.write('settings', { locale: 'en_us' })
  r.write('custom_click_action', { id: 'paper:dialog' })
  r.write('finish_configuration', {})
  assert.deepEqual(r.writes.map(entry => entry.name),
    ['settings', 'custom_click_action', 'finish_configuration'])
  assert.deepEqual(r.logs, [], 'a gate decision is the only thing this wrapper logs')
  assert.deepEqual(r.markers, [])
})

test('#21 an accept that fails to send is not reported as answered', () => {
  const r = rig({ attached: false, writeThrows: true })
  assert.equal(r.write(...ACCEPT), false)
  assert.deepEqual(r.markers, [], 'a failed accept leaves the gate open for a human')
  assert.equal(r.logs.filter(entry => entry.event === 'codeOfConductAccepted').length, 0)
  assert.equal(r.logs.filter(entry => entry.event === 'codeOfConductAcceptFailed').length, 1)
})

test('#21 the gate wrapper composes with the transfer-intent wrapper', () => {
  const writes = []
  const transfer = withTransferIntent((name, params) => { writes.push({ name, params }) })
  const gated = withCodeOfConductGate(transfer, { isHumanAttached: () => true })

  gated('set_protocol', { protocolVersion: 775, nextState: 2 })
  assert.deepEqual(writes, [{ name: 'set_protocol', params: { protocolVersion: 775, nextState: 3 } }],
    'the transfer intent still rewrites the handshake')
  gated('accept_code_of_conduct', {})
  assert.equal(writes.length, 1, 'and the gate still holds the accept')
})

test('#21 the wrapper rejects a caller that cannot answer', () => {
  assert.throws(() => withCodeOfConductGate(null), TypeError)
  assert.throws(() => withCodeOfConductGate(() => {}, { isHumanAttached: 'yes' }), TypeError)
})

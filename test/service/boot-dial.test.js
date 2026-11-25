// What the service does with the configured backend before the front listens.
// A picker lane dials nothing: the claim is the only thing that dials a body
// (#258), so a lane nobody claims opens no backend connection.
//
// The dev lane found this, not this file. It ran with MONOPLAYER_PICKER=1,
// connected at boot, and then refused its own granted claim:
//   claimDialRefused body=paper.monoplayer-dev.svc.cluster.local_25565
//                    reason=session_busy state=warm
// A unit test over the legs could not see it, because the legs were right: the
// orchestrator dialled a body the claim was about to ask for.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dialBodyAtBoot } from '../../src/service/start-live.js'
import { loadConfig } from '../../src/service/monoplayer.js'

const lane = overrides => loadConfig({
  front: { host: '127.0.0.1', port: 0 },
  backend: { host: 'paper.monoplayer-dev.svc.cluster.local', port: 25565 },
  ...overrides
})

const countingBackend = () => {
  const calls = []
  return {
    calls,
    ended: false,
    async connect () { calls.push('connect') },
    setTarget () { calls.push('setTarget') }
  }
}

test('a picker lane dials no body at boot, so its claim can', async () => {
  const backend = countingBackend()
  const events = []
  const boot = await dialBodyAtBoot({
    cfg: lane({ picker: true }),
    backend,
    log: (event, fields) => events.push({ event, fields })
  })

  assert.deepEqual(backend.calls, [], 'the claim is the only thing that dials a body')
  assert.deepEqual(boot, { dialled: false, reason: 'picker' })
  assert.deepEqual(events, [{ event: 'backendBootSkipped', fields: { reason: 'picker' } }],
    'the start record says why nothing dialled, so an operator is not left guessing')
})

test('an offline picker lane dials nothing either', async () => {
  // The deployed shape: offline legs and the picker, both on.
  const backend = countingBackend()
  const boot = await dialBodyAtBoot({ cfg: lane({ picker: true, offlineLegs: true }), backend })
  assert.deepEqual(backend.calls, [])
  assert.equal(boot.dialled, false)
})

test('a lane with no picker still dials the configured backend at boot', async () => {
  const backend = countingBackend()
  const boot = await dialBodyAtBoot({ cfg: lane({}), backend })
  assert.deepEqual(backend.calls, ['connect'], 'the live lane starts on its configured target, as it always has')
  assert.deepEqual(boot, { dialled: true, reason: null })
})

test('a boot dial that fails is thrown to the caller, which owns the exit code', async () => {
  const backend = {
    async connect () { throw new Error('ECONNREFUSED 127.0.0.1:25565') }
  }
  await assert.rejects(dialBodyAtBoot({ cfg: lane({}), backend }), /ECONNREFUSED/)
})

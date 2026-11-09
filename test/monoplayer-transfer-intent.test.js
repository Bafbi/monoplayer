// The transfer handshake intent: intent 3, not the library's hardcoded 2.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTransferIntent } from '../src/legs/live-backend.js'

const handshake = () => ({
  protocolVersion: 776,
  serverHost: 'sky-2.excalia.fr',
  serverPort: 25565,
  nextState: 2
})

test('a followed transfer writes handshake intent 3', () => {
  const calls = []
  const write = withTransferIntent((name, params, ...rest) => { calls.push({ name, params, rest }) }, true)
  write('set_protocol', handshake())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'set_protocol')
  assert.equal(calls[0].params.nextState, 3)
  assert.equal(calls[0].params.serverHost, 'sky-2.excalia.fr')
})

test('a normal login keeps intent 2', () => {
  const calls = []
  const write = withTransferIntent((name, params) => calls.push({ name, params }), false)
  write('set_protocol', handshake())
  assert.equal(calls[0].params.nextState, 2)
})

test('other packets and extra arguments are untouched', () => {
  const calls = []
  const write = withTransferIntent((name, params, ...rest) => calls.push({ name, params, rest }), true)
  write('login_start', { username: 'Bafbi' }, 'extra')
  assert.deepEqual(calls[0], { name: 'login_start', params: { username: 'Bafbi' }, rest: ['extra'] })
})

test('a missing or invalid write is rejected', () => {
  assert.throws(() => withTransferIntent(null), /write is required/)
})

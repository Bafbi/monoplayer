// #18: which client information frames the front leg reports to the core.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shouldReportClientSettings } from '../../src/legs/live-front.js'

const client = { username: 'Bafbi' }

test('the joining client reports its configuration-phase information', () => {
  assert.equal(shouldReportClientSettings({ attached: client, client, state: 'configuration' }), true)
})

test('a play-state change is left to the serverbound rewrite', () => {
  assert.equal(shouldReportClientSettings({ attached: client, client, state: 'play' }), false)
})

test('no client in the attach slot reports nothing', () => {
  assert.equal(shouldReportClientSettings({ attached: null, client, state: 'configuration' }), false)
})

test('a second connection never reports over the attached client', () => {
  const other = { username: 'Second' }
  assert.equal(shouldReportClientSettings({ attached: client, client: other, state: 'configuration' }), false)
})

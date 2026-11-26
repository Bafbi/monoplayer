// #416: the identity every record carries — the account the lane speaks for, the
// body it serves, and the channel a connection holds.
//
// The account is stamped where the line is written (src/service/start-live.js,
// src/service/monoplayer.js) and the channel where a connection holds one
// (src/legs/live-front.js). So these are the fields the funnels write, not the
// fields each call site passes: a caller that stops naming an identifier still
// gets it on the record.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createJsonlLog } from '../../src/service/start-live.js'
import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { pickSlug } from '../../src/core/picker.js'
import { makeCore } from '../support/harness.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const STRANGER = '11111111-2222-3333-4444-555555555555'
const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function sinkLog (account) {
  const out = []
  const log = createJsonlLog({ sink: { write: line => out.push(JSON.parse(line)) }, account })
  return { log, out }
}

test('#416 every line the service and both legs write names the account', () => {
  const { log, out } = sinkLog('sky')
  log('pickerServed', { username: 'Bafbi', servers: 3 })

  assert.deepEqual(out[0], {
    t: out[0].t,
    event: 'pickerServed',
    account: 'sky',
    username: 'Bafbi',
    servers: 3
  }, 'a picker join was served before any body exists, and it still names the account')
})

test('#416 a record written before a body exists names the account and no body key', () => {
  const { log, out } = sinkLog('sky')
  log('liveReady', { front: '0.0.0.0:25565', body: null })

  assert.equal('body' in out[0], false,
    'a body that does not exist is absent, never null (#263 D2)')
  assert.equal('channel' in out[0], false)
})

test('#416 a lane with no account writes no account key', () => {
  const { log, out } = sinkLog(null)
  log('liveReady', { front: '0.0.0.0:25565' })
  assert.equal('account' in out[0], false, 'a lane that resolved no account names none')
})

test('#416 a core record names the account it serves and the body it holds', () => {
  const logLines = []
  const { core, frontLeg } = makeCore({
    logLines,
    config: { puppet: { username: 'GlowSquidye', uuid: ACCOUNT } }
  })
  const body = pickSlug(core.config.backend.host + ':' + core.config.backend.port)

  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })

  const denied = logLines.find(line => line.event === 'attachDenied')
  assert.ok(denied, 'the denial record was written')
  assert.equal(denied.account, ACCOUNT, 'the account the core serves')
  assert.equal(denied.body, body, 'the body it serves, named the way a claim names one')
  assert.equal('channel' in denied, false, 'the core holds no channel, so a core record names none')
})

test('#416 a denial names the player it refused, and the account is not that player', () => {
  const logLines = []
  const { frontLeg } = makeCore({
    logLines,
    config: { puppet: { username: 'GlowSquidye', uuid: ACCOUNT } }
  })

  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  frontLeg.loginStart({ name: 'Stranger', uuid: STRANGER })

  const denied = logLines.filter(line => line.event === 'attachDenied').at(-1)
  assert.ok(denied, 'the denial was written')
  assert.equal(denied.uuid, STRANGER, 'the record names the connection the refusal is about')
  assert.equal(denied.account, ACCOUNT, 'and the lane account beside it, which is not the player')
})

test('#416 no metric carries a channel, however much it carries beside it', () => {
  const metrics = []
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: loadConfig({ attachWhitelist: [PLAYER], puppet: { username: 'GlowSquidye', uuid: ACCOUNT } }),
    backendLeg,
    frontLeg,
    account: ACCOUNT,
    telemetry: {
      log () {},
      metric: (name, value, attributes = {}) => metrics.push({ name, attributes })
    }
  })
  core.start()
  frontLeg.loginStart({ name: 'Stranger', uuid: STRANGER })

  assert.ok(metrics.length > 0, 'the core emitted metrics to check')
  const named = metrics.filter(metric => 'channel' in metric.attributes).map(metric => metric.name)
  assert.deepEqual(named, [],
    'a body is bounded by the allowed-server list and a channel is one connection, ' +
    'so a channel attribute is one series per socket (#415, #263 D1)')
})

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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJsonlLog } from '../../src/service/start-live.js'
import { createMonoplayer, loadConfig } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { pickSlug } from '../../src/core/picker.js'
import { makeCore } from '../support/harness.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
  const { core, frontLeg, backendLeg } = makeCore({
    logLines,
    config: { puppet: { username: 'GlowSquidye', uuid: ACCOUNT } }
  })
  const body = pickSlug(core.config.backend.host + ':' + core.config.backend.port)

  // The first frame of a session is what tells the core which body it holds; a
  // picker lane sends none until a claim dials one.
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  frontLeg.loginStart({ name: 'Stranger', uuid: STRANGER })

  const denied = logLines.find(line => line.event === 'attachDenied')
  assert.ok(denied, 'the denial record was written')
  assert.equal(denied.account, ACCOUNT, 'the account the core serves')
  assert.equal(denied.body, body, 'the body it holds, named the way a claim names one')
  assert.equal('channel' in denied, false, 'the core holds no channel, so a core record names none')
})

test('#416 a lane that holds no body yet names the account and no body key', () => {
  const logLines = []
  const { frontLeg } = makeCore({
    logLines,
    config: {
      picker: true,
      puppet: { username: 'GlowSquidye', uuid: ACCOUNT }
    }
  })

  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })

  const picker = logLines.find(line => line.event === 'attachPicker')
  assert.ok(picker, 'a picker join writes its own record')
  assert.equal(picker.account, ACCOUNT)
  assert.equal('body' in picker, false,
    'the configured address is a body this lane would serve, not one it holds (#263 D2)')
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

// #416: a record about a connection that holds a channel goes through the seam that
// names the channel. The leg's own source is the record of which call sites those
// are, so a new per-connection record that reaches for the raw log() fails here
// rather than shipping a record no query can attribute to a connection.
//
// Every name below is a record written before a channel can exist, or one about
// something other than the connection's own channel.
const PRE_CHANNEL_RECORDS = new Set([
  // The process and its sockets, before any login.
  'frontError', 'frontServerError', 'frontListening', 'wireReject',
  'preAuthRefused', 'preAuthExpired',
  // A login under review, and a connection refused or ended before it held a channel.
  'frontLoginReview', 'attachDenied', 'attachAllowed', 'channelRefused', 'configUnavailable',
  // A picker client holds no channel: it watches no body until its claim or its
  // Spectate lands, so its records name the account and the connection's own facts.
  'pickerServed', 'pickerEmpty', 'pickerDialog', 'pickerDialogFailed', 'pickerPick',
  'pickerPickIgnored', 'pickerPickRefused', 'pickerPickHandlerError', 'pickerServersError',
  'pickerVerb', 'pickerVerbRefused', 'pickerVerbHandlerError', 'pickerServerDialog',
  'pickerServerDialogFailed', 'pickerDisconnect', 'pickerDisconnectRefused',
  'pickerDisconnectHandlerError', 'pickerClaim', 'pickerClaimRefused', 'pickerClaimLanding',
  'pickerClaimRestored', 'pickerClaimAbandoned',
  // A claim being released names the claim's body, which need not be the body this
  // connection's channel is on.
  'pickerClaimReleased',
  // A Spectate the core refused: the client is still a picker client.
  'spectateRefused',
  // A settings frame from a connection the lane admitted with no channel.
  'clientInformationNoChannel'
])

test('#416 a record about a connection goes through the seam that names its channel', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'legs', 'live-front.js'), 'utf8')
  const raw = [...new Set([...source.matchAll(/log\('([A-Za-z0-9_]+)'/g)].map(match => match[1]))]
  const stray = raw.filter(name => !PRE_CHANNEL_RECORDS.has(name))

  assert.ok(source.includes('function record (client, event, fields = {})'),
    'the seam this guard reads is still the leg\'s own')
  assert.deepEqual(stray, [],
    'a record written on a channel must use record() or recordOfChannel(): ' + stray.join(', '))
})

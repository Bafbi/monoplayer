// Socket-free tests for the online rung's pure pieces: the bot client-option
// builder, account resolution, and the N1-N14 assertion contract.
//
// No sockets, no auth, no .secrets read. Fixture accounts live in a temp tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

import { buildClientOptions } from '../../src/ladder/bot.js'
import {
  ONLINE_ASSERTION_IDS,
  RUNG_CLIENT_SETTINGS,
  buildOnlineBotOptions,
  evaluateOnlineAssertions,
  resolveOnlineAccounts,
  summarizeAssertions
} from '../../src/ladder/online.js'

const PUPPET_UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH_UUID = '6eb73524-ff88-4a62-a8d0-c63905e7afba'

function tempAccounts () {
  const dir = tempRoot('monoplayer-online-')

  function write (uuid, profile) {
    const accountDir = path.join(dir, uuid)
    fs.mkdirSync(accountDir, { recursive: true })
    fs.writeFileSync(
      path.join(accountDir, 'profile.json'),
      JSON.stringify({ version: 1, uuid, ...profile })
    )
    return accountDir
  }

  return { dir, write }
}

// The gate Paper's view distance, as the backend's play login advertises it. A
// number the bot never asks for, so a merge that let the client's own render
// distance cross is a difference on this evidence.
const BACKEND_CAP = 10

function allPassEvidence () {
  return {
    accounts: {
      puppet: { uuid: PUPPET_UUID, name: 'GlowSquidye', alias: 'glowsquidye' },
      attach: { uuid: ATTACH_UUID, name: 'Bafbi', alias: 'bafbi' }
    },
    front: {
      kind: 'live-front-leg',
      verifier: 'online-mode_hasjoined',
      allowed: 1,
      denied: 0,
      attaches: 1,
      configReplayMode: 'cached_replay',
      wire: { checked: 42, rejected: 0, byState: { configuration: 12, play: 30 } }
    },
    core: {
      attached: true,
      attaches: 1,
      backendLoginsFirst: 1,
      serverboundForwarded: 3,
      serverboundDropped: 0,
      sessionState: 'attached'
    },
    bot: {
      ready: true,
      uuid: ATTACH_UUID,
      name: 'Bafbi',
      playPrefix: [
        'login',
        'game_state_change',
        'position',
        'chunk_batch_start',
        'map_chunk',
        'chunk_batch_finished'
      ],
      joinShape: { loginIndex: 0, positionIndex: 2, chunkIndex: 4 },
      loginStateLeaks: [],
      playFrameCount: 30,
      leftovers: 0,
      errors: 0
    },
    serverbound: {
      forwarded: 3,
      backendObserved: true,
      backendNames: ['position', 'block_dig', 'block_place']
    },
    reattach: { attaches: 2, backendLogins: 1 },
    denial: { observed: false, reason: 'no stranger account' },
    parity: {
      ok: true,
      settled: true,
      capturedFrames: 30,
      domains: {
        inventory: { ok: true },
        heldItemSlot: { ok: true },
        pose: { ok: true },
        chunks: { ok: true }
      }
    },
    custody: { puppetLockReleased: true },
    // #610: the core's record of the join's client information, and the two
    // settings packets the backend leg was handed. Edge and Gate fill these with
    // the behaviour each case is about.
    clientInformation: {
      reported: { ...RUNG_CLIENT_SETTINGS, requestedViewDistance: RUNG_CLIENT_SETTINGS.viewDistance },
      loginSettings: { locale: 'en_us', viewDistance: BACKEND_CAP, skinParts: 127, mainHand: 1 },
      attachSettings: { ...RUNG_CLIENT_SETTINGS, viewDistance: BACKEND_CAP },
      cap: BACKEND_CAP
    }
  }
}

// #71: the puppet join failed N8 on a 26.2 front because the bots were built
// without a version and fell back to bot.js's 26.1 default, so a 26.2 login
// success decoded one field short (sessionId, 16 bytes). The options builder is
// exported so this can be proved without sockets.
const buildRungBotOptions = () => buildOnlineBotOptions({
  frontPort: 25566,
  attach: { uuid: ATTACH_UUID, profile: { authTitle: null, deviceType: null } },
  attachCustody: { cacheFactory: () => ({}) }
})

test('the rung builds its bots at the version it runs at', () => {
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { buildOnlineBotOptions } from './src/ladder/online.js'
    console.log(buildOnlineBotOptions({
      frontPort: 25566,
      attach: { uuid: '${ATTACH_UUID}', profile: {} },
      attachCustody: { cacheFactory: () => ({}) }
    }).version)
  `], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, MONOPLAYER_VERSION: '26.2' }
  })
  assert.equal(output.status, 0, output.stderr)
  assert.equal(output.stdout.trim(), '26.2', 'the bot must speak the version the front and backend run at')
})

// The rung's module-level VERSION is read at import, so a child process is the
// only honest way to prove what an environment yields.
function rungBotVersion (env) {
  const childEnv = { ...process.env }
  delete childEnv.MONOPLAYER_VERSION
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { buildOnlineBotOptions } from './src/ladder/online.js'
    console.log(buildOnlineBotOptions({
      frontPort: 25566,
      attach: { uuid: '${ATTACH_UUID}', profile: {} },
      attachCustody: { cacheFactory: () => ({}) }
    }).version)
  `], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    encoding: 'utf8',
    env: { ...childEnv, ...env }
  })
  assert.equal(output.status, 0, output.stderr)
  return output.stdout.trim()
}

test('an empty MONOPLAYER_VERSION is unset, never a version of its own', () => {
  // minecraft-protocol treats an empty version as "use my defaultVersion", which
  // is a version choice this rung must make itself: online-cluster.sh forwards
  // an empty MONOPLAYER_VERSION when the operator names none.
  assert.equal(rungBotVersion({ MONOPLAYER_VERSION: '' }), '26.2')
  assert.equal(rungBotVersion({}), '26.2')
  assert.equal(rungBotVersion({ MONOPLAYER_VERSION: '26.1' }), '26.1')
})

// #610: the bot the rung joins with carries the client information N14 compares
// against. Without it the frames on both sides are the library's defaults, and
// the assertion cannot tell a wired join from a declined one.
test('#610 the rung builds its bot with its own client information', () => {
  const options = buildRungBotOptions()
  assert.deepEqual(options.clientSettings, RUNG_CLIENT_SETTINGS,
    'the rung passes the constant N14 reads, so a test and the rung cannot disagree')
  for (const [field, dflt] of [['locale', 'en_us'], ['viewDistance', 10], ['skinParts', 127], ['mainHand', 1]]) {
    assert.notEqual(RUNG_CLIENT_SETTINGS[field], dflt,
      'the rung bot\'s ' + field + ' is not the protocol library default: ' + dflt +
      ', or N14 would pass with the client-information call-in declined')
  }
})

test('a bot option set carries the version it was given', () => {
  assert.equal(buildOnlineBotOptions({
    frontPort: 25566,
    attach: { uuid: ATTACH_UUID, profile: {} },
    attachCustody: { cacheFactory: () => ({}) },
    version: '26.2'
  }).version, '26.2')
})

test('buildClientOptions defaults to offline and adds no auth material', () => {
  const options = buildClientOptions({ port: 25565, username: 'Attach' })
  assert.deepEqual(options, {
    host: '127.0.0.1',
    port: 25565,
    username: 'Attach',
    version: '26.1',
    auth: 'offline',
    keepAlive: true
  })
  assert.equal('profilesFolder' in options, false)
  assert.equal('authTitle' in options, false)
  assert.equal('deviceType' in options, false)
})

test('buildClientOptions passes Microsoft auth material only when set', () => {
  const cacheFactory = () => ({})
  const options = buildClientOptions({
    port: 25566,
    username: ATTACH_UUID,
    auth: 'microsoft',
    profilesFolder: cacheFactory,
    authTitle: '00000000441cc96b',
    deviceType: 'Nintendo'
  })
  assert.equal(options.auth, 'microsoft')
  assert.equal(options.profilesFolder, cacheFactory)
  assert.equal(options.authTitle, '00000000441cc96b')
  assert.equal(options.deviceType, 'Nintendo')

  const bare = buildClientOptions({
    port: 25566,
    username: ATTACH_UUID,
    auth: 'microsoft',
    profilesFolder: null,
    authTitle: null,
    deviceType: null
  })
  assert.equal('profilesFolder' in bare, false)
  assert.equal('authTitle' in bare, false)
  assert.equal('deviceType' in bare, false)
})

test('buildClientOptions refuses a plain cache path', () => {
  assert.throws(
    () => buildClientOptions({
      port: 25566,
      username: ATTACH_UUID,
      auth: 'microsoft',
      profilesFolder: '.secrets/accounts/' + ATTACH_UUID
    }),
    TypeError
  )
})

test('resolveOnlineAccounts resolves the puppet and attach aliases', () => {
  const fixture = tempAccounts()
  fixture.write(PUPPET_UUID, { name: 'GlowSquidye', alias: 'glowsquidye', authTitle: '00000000441cc96b', deviceType: 'Nintendo' })
  fixture.write(ATTACH_UUID, { name: 'Bafbi', alias: 'bafbi', authTitle: '00000000441cc96b', deviceType: 'Nintendo' })

  const resolved = resolveOnlineAccounts({ accountsDir: fixture.dir })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.reason, null)
  assert.equal(resolved.puppet.uuid, PUPPET_UUID)
  assert.equal(resolved.puppet.alias, 'glowsquidye')
  assert.equal(resolved.attach.uuid, ATTACH_UUID)
  assert.equal(resolved.attach.alias, 'bafbi')
})

test('resolveOnlineAccounts reports a missing puppet as a setup error', () => {
  const fixture = tempAccounts()
  fixture.write(ATTACH_UUID, { name: 'Bafbi', alias: 'bafbi' })

  const resolved = resolveOnlineAccounts({ accountsDir: fixture.dir })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.puppet, null)
  assert.equal(resolved.attach, null)
  assert.deepEqual(resolved.missing.map(entry => entry.role), ['puppet'])
  assert.equal(resolved.missing[0].selector, 'glowsquidye')
  assert.match(resolved.reason, /puppet:/)
})

test('resolveOnlineAccounts reports a missing attach account as a setup error', () => {
  const fixture = tempAccounts()
  fixture.write(PUPPET_UUID, { name: 'GlowSquidye', alias: 'glowsquidye' })

  const resolved = resolveOnlineAccounts({ accountsDir: fixture.dir })
  assert.equal(resolved.ok, false)
  assert.deepEqual(resolved.missing.map(entry => entry.role), ['attach'])
  assert.equal(resolved.missing[0].selector, 'bafbi')
  assert.match(resolved.reason, /attach:/)
})

test('resolveOnlineAccounts reports both missing accounts from an empty tree', () => {
  const fixture = tempAccounts()
  const resolved = resolveOnlineAccounts({ accountsDir: fixture.dir })
  assert.equal(resolved.ok, false)
  assert.deepEqual(resolved.missing.map(entry => entry.role), ['puppet', 'attach'])
  assert.match(resolved.reason, /puppet:no_accounts/)
  assert.match(resolved.reason, /attach:no_accounts/)
})

test('evaluateOnlineAssertions returns every id exactly once', () => {
  const assertions = evaluateOnlineAssertions(allPassEvidence())
  assert.deepEqual(assertions.map(assertion => assertion.id), [...ONLINE_ASSERTION_IDS])
  assert.equal(new Set(assertions.map(assertion => assertion.id)).size, ONLINE_ASSERTION_IDS.length)
})

test('a clean run passes N1-N10 and N12 and skips N11 honestly', () => {
  const assertions = evaluateOnlineAssertions(allPassEvidence())
  const byId = Object.fromEntries(assertions.map(assertion => [assertion.id, assertion]))

  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N12', 'N13', 'N14']) {
    assert.equal(byId[id].status, 'pass', `${id}: ${JSON.stringify(byId[id].detail)}`)
    assert.equal(byId[id].ok, true)
  }
  assert.equal(byId.N11.status, 'not_observed')
  assert.equal(byId.N11.ok, null)

  const summary = summarizeAssertions(assertions)
  assert.deepEqual(
    { pass: summary.pass, fail: summary.fail, not_observed: summary.not_observed, total: summary.total },
    { pass: 13, fail: 0, not_observed: 1, total: 14 }
  )
})

test('N9 passes on the core counter alone when the backend exposes no observation', () => {
  const evidence = allPassEvidence()
  evidence.serverbound = { forwarded: 3, backendObserved: false, backendNames: [] }

  const n9 = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N9')
  assert.equal(n9.status, 'pass')
  assert.equal(n9.detail.backendObservation, 'not_observed')
  assert.match(n9.detail.reason, /core counter only/)
})

test('N11 passes only when a real denial was observed', () => {
  const evidence = allPassEvidence()
  evidence.denial = { observed: true, denied: 1, playFrames: 0, errors: 0 }

  const n11 = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N11')
  assert.equal(n11.status, 'pass')

  evidence.denial = { observed: true, denied: 1, playFrames: 2, errors: 0 }
  const failed = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N11')
  assert.equal(failed.status, 'fail')
})

// #610: what the backend saw for this join, not what the core meant to send.
// The attach frame is the backend leg's own write, so the fields are the ones a
// real Paper received; the reported side is the core's clientInformation record.
test('#610 N14 passes when the bot\'s own fields reach the backend at the cap', () => {
  const n14 = evaluateOnlineAssertions(allPassEvidence()).find(assertion => assertion.id === 'N14')
  assert.equal(n14.status, 'pass', JSON.stringify(n14.detail))
  assert.equal(n14.detail.attachSettings.locale, 'fr_fr')
  assert.equal(n14.detail.attachSettings.viewDistance, BACKEND_CAP)
})

test('#610 N14 fails when the attach frame carries the defaults, which is the cut wiring', () => {
  const evidence = allPassEvidence()
  // The core recorded the bot's fields, and the leg was handed the defaults the
  // merge produces with no human: exactly what a rung that declines the
  // client-information call-in sends.
  evidence.clientInformation.attachSettings = { locale: 'en_us', viewDistance: BACKEND_CAP, skinParts: 127, mainHand: 1 }

  const n14 = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N14')
  assert.equal(n14.status, 'fail')
  assert.equal(n14.detail.reported.locale, 'fr_fr')
  assert.equal(n14.detail.attachSettings.locale, 'en_us')
})

test('#610 N14 fails when the client\'s own view distance crosses instead of the cap', () => {
  const evidence = allPassEvidence()
  evidence.clientInformation.attachSettings = { ...RUNG_CLIENT_SETTINGS, viewDistance: RUNG_CLIENT_SETTINGS.viewDistance }

  const n14 = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N14')
  assert.equal(n14.status, 'fail')
  assert.equal(n14.detail.attachSettings.viewDistance, 2)
  assert.equal(n14.detail.cap, BACKEND_CAP)
})

test('#610 N14 fails closed when the core recorded no client information', () => {
  for (const empty of [
    { reported: null, loginSettings: null, attachSettings: null, cap: null },
    { reported: null, loginSettings: { viewDistance: BACKEND_CAP }, attachSettings: { ...RUNG_CLIENT_SETTINGS, viewDistance: BACKEND_CAP }, cap: BACKEND_CAP },
    { reported: { ...RUNG_CLIENT_SETTINGS, requestedViewDistance: 2 }, loginSettings: null, attachSettings: null, cap: BACKEND_CAP }
  ]) {
    const evidence = allPassEvidence()
    evidence.clientInformation = empty

    const n14 = evaluateOnlineAssertions(evidence).find(assertion => assertion.id === 'N14')
    assert.equal(n14.status, 'fail', JSON.stringify(empty))
  }
})

test('a broken run fails the matching assertions', () => {
  const evidence = allPassEvidence()
  evidence.front.wire = { checked: 10, rejected: 1 }
  evidence.bot.leftovers = 1
  evidence.bot.loginStateLeaks = ['success']
  evidence.reattach = { attaches: 2, backendLogins: 2 }
  evidence.custody.puppetLockReleased = false

  const assertions = evaluateOnlineAssertions(evidence)
  const byId = Object.fromEntries(assertions.map(assertion => [assertion.id, assertion]))

  assert.equal(byId.N5.status, 'fail')
  assert.equal(byId.N7.status, 'fail')
  assert.equal(byId.N8.status, 'fail')
  assert.equal(byId.N10.status, 'fail')
  assert.equal(byId.N12.status, 'fail')

  const summary = summarizeAssertions(assertions)
  assert.equal(summary.fail, 5)
  assert.equal(summary.not_observed, 1)
})

test('empty evidence fails closed instead of throwing', () => {
  const assertions = evaluateOnlineAssertions({})
  assert.equal(assertions.length, ONLINE_ASSERTION_IDS.length)
  assert.equal(assertions.find(assertion => assertion.id === 'N11').status, 'not_observed')
  for (const assertion of assertions) {
    if (assertion.id === 'N11') continue
    assert.equal(assertion.status, 'fail', assertion.id)
  }
})

// Socket-free tests for the online rung's pure pieces: the bot client-option
// builder, account resolution, and the N1-N12 assertion contract.
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
    custody: { puppetLockReleased: true }
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

  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N12', 'N13']) {
    assert.equal(byId[id].status, 'pass', `${id}: ${JSON.stringify(byId[id].detail)}`)
    assert.equal(byId[id].ok, true)
  }
  assert.equal(byId.N11.status, 'not_observed')
  assert.equal(byId.N11.ok, null)

  const summary = summarizeAssertions(assertions)
  assert.deepEqual(
    { pass: summary.pass, fail: summary.fail, not_observed: summary.not_observed, total: summary.total },
    { pass: 12, fail: 0, not_observed: 1, total: 13 }
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

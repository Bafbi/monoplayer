// #229: the runtime control document's reader and the dial policy.
//
// Both halves are file-shaped, so every case here reads a real temporary file
// through the injected readFile: a fixture that fakes the reader would prove
// nothing about the files an operator edits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ALLOWED_SERVERS_VERSION,
  DESIRED_VERSION,
  createBackendMoveTick,
  createControlDocument,
  dialIntent,
  dialTargetFor,
  moveDue,
  parseAllowedServers,
  parseDesiredTarget,
  revertAfterRestore
} from '../../src/service/control.js'

const PLAYER = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'
const OTHER = '3f7f2c60-5fd1-4b3c-94b7-000000000042'

function controlDir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `monoplayer-control-${label}-`))
}

function writeWhitelist (file, uuids) {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    players: uuids.map(uuid => ({ uuid, name: null, addedAt: '2026-11-17T00:00:00.000Z' }))
  }, null, 2) + '\n')
}

function writeDesired (file, backend) {
  fs.writeFileSync(file, JSON.stringify({
    version: DESIRED_VERSION,
    backend,
    changedAt: '2026-11-17T00:00:00.000Z',
    changedBy: 'panel'
  }, null, 2) + '\n')
}

test('#229 desired.json parses to one host and port, and every refusal is named', () => {
  assert.deepEqual(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: '10.0.0.9', port: 25566 } })),
    { target: { host: '10.0.0.9', port: 25566, changedAt: null }, reason: null })
  assert.equal(
    parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: 'a', port: 1 }, changedAt: '2026-11-18T00:00:00.000Z' }))
      .target.changedAt,
    '2026-11-18T00:00:00.000Z',
    '#233: the operator intent\'s stamp rides along, so a rewrite of the same address is a new intent')
  assert.deepEqual(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: ' 10.0.0.9 ', port: 25566 } })).target,
    { host: '10.0.0.9', port: 25566, changedAt: null }, 'a host is trimmed, because a configmap edit leaves whitespace')

  assert.equal(parseDesiredTarget('{').reason, 'not_json')
  assert.equal(parseDesiredTarget('null').reason, 'not_an_object')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 2, backend: { host: 'a', port: 1 } })).reason, 'version')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 1 })).reason, 'host')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: '   ', port: 1 } })).reason, 'host')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: 'a', port: 0 } })).reason, 'port')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: 'a', port: 65536 } })).reason, 'port')
  assert.equal(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: 'a', port: '25565' } })).reason, 'port')
})

test('#229 without control.file nothing is read and nothing is enabled', () => {
  const lines = []
  const document = createControlDocument({ log: (event, fields) => lines.push({ event, fields }) })
  assert.equal(document.enabled, false)
  assert.equal(document.whitelistStore, null)
  assert.deepEqual(document.attachWhitelist(), [])
  assert.equal(document.desiredTarget(), null)
  assert.deepEqual(lines, [], 'a lane that never set the switch logs nothing')
})

test('#229 the desired backend is read per connect, so a rewrite takes effect on the next one', () => {
  const dir = controlDir('desired')
  const file = path.join(dir, 'desired.json')
  writeDesired(file, { host: '127.0.0.1', port: 25566 })
  const document = createControlDocument({ file, allowBackendSwitch: true })
  assert.deepEqual(document.desiredTarget(),
    { host: '127.0.0.1', port: 25566, changedAt: '2026-11-17T00:00:00.000Z' })

  writeDesired(file, { host: '127.0.0.1', port: 25567 })
  assert.deepEqual(document.desiredTarget(),
    { host: '127.0.0.1', port: 25567, changedAt: '2026-11-17T00:00:00.000Z' },
    'the file is the authority, not a value cached at startup')
})

test('#229 a desired backend with the switch off is named once and ignored', () => {
  const dir = controlDir('switch-off')
  const file = path.join(dir, 'desired.json')
  writeDesired(file, { host: '127.0.0.1', port: 25566 })
  const lines = []
  const document = createControlDocument({ file, allowBackendSwitch: false, log: (event, fields) => lines.push({ event, fields }) })

  assert.equal(document.desiredTarget(), null, 'the lane continues on the configured backend')
  assert.equal(document.desiredTarget(), null)
  const refusals = lines.filter(line => line.event === 'controlSwitchRefused')
  assert.equal(refusals.length, 1, 'a reconnect loop must not write one line per connect')
  assert.equal(refusals[0].fields.file, file, 'the line names the file an operator has to change')
})

test('#229 a malformed or missing desired.json is named and ignored, never fatal', () => {
  const dir = controlDir('malformed')
  const file = path.join(dir, 'desired.json')
  const lines = []
  const document = createControlDocument({ file, allowBackendSwitch: true, log: (event, fields) => lines.push({ event, fields }) })

  assert.equal(document.desiredTarget(), null, 'a file the operator has not written yet is not an error')
  assert.deepEqual(lines, [], 'ENOENT is the normal state of a control document before the panel writes it')

  fs.writeFileSync(file, '{ not json\n')
  assert.equal(document.desiredTarget(), null)
  const rejected = lines.filter(line => line.event === 'controlRejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].fields.reason, 'not_json')

  assert.equal(document.desiredTarget(), null)
  assert.equal(lines.filter(line => line.event === 'controlRejected').length, 1,
    'the same broken file is one named line, not one per connect')
})

test('#229 the attach whitelist reloads at each read, so a UUID added on disk is allowed next', () => {
  const dir = controlDir('whitelist')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  writeWhitelist(whitelistFile, [PLAYER])
  const document = createControlDocument({ file: path.join(dir, 'desired.json'), whitelistFile })

  assert.deepEqual(document.attachWhitelist(), [PLAYER])
  assert.equal(document.whitelistStore.has(OTHER), false)

  writeWhitelist(whitelistFile, [PLAYER, OTHER])
  assert.deepEqual(document.attachWhitelist(), [PLAYER, OTHER].map(uuid => uuid.toLowerCase()),
    'the core gate re-reads the file, so the next login sees the new UUID')
  assert.equal(document.whitelistStore.has(OTHER), true,
    'the front leg store agrees without a restart')
})

test('#229 a followed transfer wins, a desired backend never moves an attached client, and the current target is the floor', () => {
  const displayed = { host: '127.0.0.1', port: 25566 }
  const current = { host: '127.0.0.1', port: 25565 }

  assert.deepEqual(dialTargetFor({ transfer: { host: '127.0.0.1', port: 1 }, desired: displayed, current }),
    { target: { host: '127.0.0.1', port: 1 }, source: 'transfer' })
  assert.deepEqual(dialTargetFor({ desired: displayed, current }), { target: displayed, source: 'desired' })
  assert.deepEqual(dialTargetFor({ desired: displayed, current, attached: true }),
    { target: current, source: 'current' },
    'a reconnect is not an operator act, so it never moves an attached client')
  assert.deepEqual(dialTargetFor({ current }), { target: current, source: 'current' })
})

test('#233 an operator move is the one path that takes a desired backend onto an attached client', () => {
  const current = { host: '127.0.0.1', port: 25565 }
  const move = { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:00:00.000Z' }

  assert.deepEqual(dialTargetFor({ operator: move, desired: move, current, attached: true }),
    { target: { host: '127.0.0.1', port: 25566 }, source: 'operator' },
    'the core started this one, so it dials it even with a client attached')
  assert.deepEqual(dialTargetFor({ operator: move, current }), { target: { host: '127.0.0.1', port: 25566 }, source: 'operator' },
    'and with nobody attached it is still the move, not the desired backend')
  assert.deepEqual(dialTargetFor({ transfer: { host: '127.0.0.1', port: 1 }, operator: move, current }),
    { target: { host: '127.0.0.1', port: 1 }, source: 'transfer' },
    'a transfer still wins: it is the server talking')
})

test('#233 the heartbeat starts a move for a new document, and never twice for the same one', () => {
  const current = { host: '127.0.0.1', port: 25565 }
  const first = { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:00:00.000Z' }

  assert.deepEqual(moveDue({ current }), { move: null, reason: 'no_desired' },
    'no document is not a move, and the switch being off reaches here the same way')
  assert.deepEqual(moveDue({ desired: { ...current, changedAt: null }, current }), { move: null, reason: 'in_use' },
    'a document naming the backend in use is not a move')
  assert.deepEqual(moveDue({ desired: first, current }),
    { move: { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:00:00.000Z' }, reason: null })
  assert.deepEqual(moveDue({ desired: first, current, attempted: first }), { move: null, reason: 'already_attempted' },
    'a failed move is not started again on the next tick: each attempt costs a configuration round')
  assert.deepEqual(moveDue({
    desired: { ...first, changedAt: '2026-11-18T00:05:00.000Z' },
    current,
    attempted: first
  }), {
    move: { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:05:00.000Z' },
    reason: null
  }, 'a rewrite is a new operator intent, so the retry stays available')
})

test('#229 a control whitelist that cannot be parsed is named, and denies instead of crashing', () => {
  const dir = controlDir('broken')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  fs.writeFileSync(whitelistFile, '{ "version": 1, "players": [')
  const lines = []
  const document = createControlDocument({
    file: path.join(dir, 'desired.json'),
    whitelistFile,
    log: (event, fields) => lines.push({ event, fields })
  })

  assert.deepEqual(document.attachWhitelist(), [], 'a broken file is an empty whitelist, which denies')
  assert.deepEqual(document.attachWhitelist(), [])
  const unreadable = lines.filter(line => line.event === 'controlUnreadable')
  assert.equal(unreadable.length, 1, 'one named line, not one per login')
  assert.equal(unreadable[0].fields.file, whitelistFile)
  assert.equal(unreadable[0].fields.code, 'invalid_json')

  // Valid JSON of the wrong shape is the same failure with a different name.
  fs.writeFileSync(whitelistFile, JSON.stringify({ version: 1, players: 'everyone' }))
  assert.deepEqual(document.attachWhitelist(), [])
  assert.deepEqual(lines.filter(line => line.event === 'controlUnreadable').map(line => line.fields.code),
    ['invalid_json', 'invalid_shape'])
})

test('#229 a dial is a transfer only when the server was reached by one', () => {
  const base = { host: '127.0.0.1', port: 25565 }
  const other = { host: '127.0.0.1', port: 25566 }

  // Every lane before #229: off the base, and reached by a followed transfer,
  // either the move itself or the return to the server it moved the session to.
  assert.deepEqual(dialIntent({ transfer: true, target: other, base }), { keepCookies: true, transfer: true })
  // A desired backend is a fresh login on a server that never saw the puppet,
  // on the dial itself and on every fault after it.
  assert.deepEqual(dialIntent({ transfer: false, target: other, base }), { keepCookies: false, transfer: false })
  // A base target is never a transfer, whatever reached it.
  assert.deepEqual(dialIntent({ transfer: true, target: base, base }), { keepCookies: false, transfer: false })
  assert.deepEqual(dialIntent({ target: base, base }), { keepCookies: false, transfer: false })
})

test('#229 two control files that fail the same way are two named lines', () => {
  const dir = controlDir('two-files')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  const file = path.join(dir, 'desired.json')
  fs.writeFileSync(whitelistFile, 'not json')
  fs.writeFileSync(file, '{"version":1,"backend":{"host":"","port":1}}')
  const lines = []
  const document = createControlDocument({
    file,
    whitelistFile,
    allowBackendSwitch: true,
    log: (event, fields) => lines.push({ event, fields })
  })
  assert.deepEqual(document.attachWhitelist(), [])
  assert.equal(document.desiredTarget(), null)
  assert.deepEqual(lines.filter(line => line.event === 'controlUnreadable').map(line => line.fields.file),
    [whitelistFile], 'the whitelist is named')
  assert.deepEqual(lines.filter(line => line.event === 'controlRejected').map(line => line.fields.file),
    [file], 'and the desired file is named with it')
})

test('#233 the heartbeat tick starts one move per document, and never the one that failed', () => {
  const current = { host: '127.0.0.1', port: 25565 }
  let desired = { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:00:00.000Z' }
  const calls = []
  const lines = []
  let refusal = null
  const core = {
    startBackendMove ({ target, reason }) {
      calls.push({ target, reason })
      if (refusal !== null) return { started: false, reason: refusal }
      return { started: true, target, kind: 'operator' }
    }
  }
  const tick = createBackendMoveTick({
    core,
    control: { desiredTarget: () => desired },
    log: (event, fields) => lines.push({ event, fields }),
    current: () => current
  })

  tick.tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].target, { host: '127.0.0.1', port: 25566, changedAt: '2026-11-18T00:00:00.000Z' })
  assert.equal(calls[0].reason, 'heartbeat')

  tick.tick()
  tick.tick()
  assert.equal(calls.length, 1, 'the same document is not a second move')
  assert.equal(lines.filter(line => line.event === 'backendMoveNotRetried').length, 1,
    'and the silence is a named line, once')

  // The operator rewrites the same address: a new intent, so it is attempted.
  desired = { ...desired, changedAt: '2026-11-18T00:10:00.000Z' }
  tick.tick()
  assert.equal(calls.length, 2, 'a rewrite is a new document')

  // A refusal spent nothing, so the next tick asks again.
  refusal = 'client_not_in_play'
  desired = { host: '127.0.0.1', port: 25567, changedAt: '2026-11-18T00:20:00.000Z' }
  tick.tick()
  assert.equal(lines.filter(line => line.event === 'backendMoveDeferred').length, 1)
  refusal = null
  tick.tick()
  assert.equal(calls.length, 4, 'the deferred document is tried again on the next tick')
})

test('#233 a document that names the backend in use is not a move, and an unchanged one is not either', () => {
  const current = { host: '127.0.0.1', port: 25565 }
  const calls = []
  let desired = { host: '127.0.0.1', port: 25565, changedAt: '2026-11-18T00:00:00.000Z' }
  const tick = createBackendMoveTick({
    core: { startBackendMove: options => { calls.push(options); return { started: true } } },
    control: { desiredTarget: () => desired },
    current: () => current
  })

  tick.tick()
  assert.equal(calls.length, 0, 'the puppet is already where the document points')

  // The switch off reads the same way: desiredTarget() returns null, once named.
  desired = null
  tick.tick()
  assert.equal(calls.length, 0)
  assert.equal(tick.attempted, null)
})


test('#233 a restored move reverts the dial for every kind that moved the session', () => {
  // The one case that must not revert is a reconfigure: the same connection
  // restarting its configuration phase never left the server. Reading anything
  // else as "keep the target" re-dials the server that never answered, with the
  // client attached, for as long as the process lives.
  assert.equal(revertAfterRestore({ kind: 'transfer' }), true)
  assert.equal(revertAfterRestore({ kind: 'operator' }), true, 'an operator move is one of them')
  assert.equal(revertAfterRestore({ kind: 'reconfigure' }), false)
  assert.equal(revertAfterRestore({ kind: null }), true, 'an unknown kind is not a reason to keep a dead target')
  assert.equal(revertAfterRestore(), true)
})

// --- #262: the allowed-server list ---

// The third key of the control document: the servers the picker offers (#265).
// It is its own file with its own path because that is what the control document
// is: one key, one file, one reader. It also has a fallback the other two do not,
// because a list with nothing in it offers a client nothing, and the list Git
// commits is the copy an operator reviewed.

function writeAllowed (file, entries) {
  fs.writeFileSync(file, JSON.stringify({ version: ALLOWED_SERVERS_VERSION, servers: entries }, null, 2) + '\n')
}

test('#262 allowed-servers.json parses to host and port, and every refusal is named', () => {
  assert.deepEqual(
    parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: '10.0.0.9', port: 25566 }] })),
    { servers: [{ host: '10.0.0.9', port: 25566 }], reason: null })
  assert.deepEqual(
    parseAllowedServers(JSON.stringify({
      version: 1,
      servers: [{ host: ' 10.0.0.9 ', port: 25566, addedAt: '2026-11-23T00:00:00.000Z' }]
    })).servers,
    [{ host: '10.0.0.9', port: 25566, addedAt: '2026-11-23T00:00:00.000Z' }],
    'a host is trimmed, because a configmap edit leaves whitespace')
  assert.deepEqual(parseAllowedServers(JSON.stringify({ version: 1, servers: [] })), { servers: [], reason: null },
    'an empty list is a document: it refuses every pick, and it is not the same fact as a broken one')
  // A field this reader has no use for is not carried into the list the picker
  // builds. There is no document older than this key, so nothing is preserved for
  // a writer that is not in this repository.
  assert.deepEqual(
    parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: 'a.example.net', port: 1, label: 'A' }] })).servers,
    [{ host: 'a.example.net', port: 1 }])

  assert.equal(parseAllowedServers('{').reason, 'not_json')
  assert.equal(parseAllowedServers('null').reason, 'not_an_object')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 2, servers: [] })).reason, 'version')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1 })).reason, 'servers')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: {} })).reason, 'servers')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: ['paper'] })).reason, 'server')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: '', port: 1 }] })).reason, 'host')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: '   ', port: 1 }] })).reason, 'host')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ port: 1 }] })).reason, 'host')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: 'a', port: 0 }] })).reason, 'port')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: 'a', port: 65536 }] })).reason, 'port')
  assert.equal(parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: 'a', port: '25565' }] })).reason, 'port')
  assert.equal(
    parseAllowedServers(JSON.stringify({
      version: 1,
      servers: [{ host: 'a.example.net', port: 25565 }, { host: 'A.example.net', port: 25565 }]
    })).reason,
    'duplicate',
    'two rows for one address are two buttons that dial the same server')
})

test('#262 the allowed-server list is read from its own file, and the committed seed answers when it cannot be', () => {
  const dir = controlDir('allowed')
  const live = path.join(dir, 'allowed-servers.json')
  const seedFile = path.join(dir, 'seed', 'allowed-servers.json')
  fs.mkdirSync(path.dirname(seedFile))
  writeAllowed(seedFile, [{ host: 'play2.excalia.fr', port: 25565 }])

  // Absent live key: the seed is the list. That is the state the deployed lane is
  // in until an operator edits the list, and it is why the seed exists.
  const document = createControlDocument({ allowedServersFile: live, allowedServersSeedFile: seedFile })
  assert.deepEqual(document.allowedServers(),
    { servers: [{ host: 'play2.excalia.fr', port: 25565 }], source: 'seed' })

  // The live key wins, and it is re-read at each read: a panel write takes effect
  // without a restart, the way the attach whitelist's does.
  writeAllowed(live, [{ host: 'paper.example.net', port: 25565 }])
  assert.deepEqual(document.allowedServers(),
    { servers: [{ host: 'paper.example.net', port: 25565 }], source: 'control' })
  writeAllowed(live, [{ host: 'paper.example.net', port: 25565 }, { host: 'sky.example.net', port: 25565 }])
  assert.equal(document.allowedServers().servers.length, 2, 'the file is the only authority')

  // Unreadable is the same answer as absent, and it is named once.
  const lines = []
  fs.writeFileSync(live, 'not json')
  const named = createControlDocument({
    allowedServersFile: live,
    allowedServersSeedFile: seedFile,
    log: (event, fields) => lines.push({ event, fields })
  })
  assert.deepEqual(named.allowedServers().servers, [{ host: 'play2.excalia.fr', port: 25565 }])
  assert.equal(named.allowedServers().source, 'seed')
  assert.deepEqual(lines.filter(line => line.event === 'controlRejected').map(line => line.fields),
    [{ file: live, reason: 'not_json' }], 'a broken live key is named once, and the seed still answers')
  assert.equal(named.allowedServers().source, 'seed')
  assert.equal(lines.length, 1, 'one line per distinct refusal, however often the list is read')
})

test('#262 a list nobody named is off, and two files that both fail are named by their own paths', () => {
  const off = createControlDocument({ log: () => { throw new Error('an unset switch logs nothing') } })
  assert.deepEqual(off.allowedServers(), { servers: [], source: 'none' })

  // Its own file is its own switch: a picker lane offers a list with no desired
  // document at all.
  const dir = controlDir('allowed-alone')
  const live = path.join(dir, 'allowed-servers.json')
  writeAllowed(live, [{ host: 'paper.example.net', port: 25565 }])
  assert.equal(createControlDocument({ allowedServersFile: live }).allowedServers().source, 'control',
    'the third key is read without control.file being set')

  const broken = path.join(controlDir('allowed-broken'), 'allowed-servers.json')
  const seedFile = path.join(controlDir('seed-broken'), 'allowed-servers.json')
  fs.writeFileSync(broken, JSON.stringify({ version: 9, servers: [] }))
  fs.writeFileSync(seedFile, JSON.stringify({ version: 1, servers: [{ host: 'a', port: 1 }, { host: 'a', port: 1 }] }))
  const lines = []
  const document = createControlDocument({
    allowedServersFile: broken,
    allowedServersSeedFile: seedFile,
    log: (event, fields) => lines.push({ event, fields })
  })
  assert.deepEqual(document.allowedServers(), { servers: [], source: 'none' })
  assert.deepEqual(lines.map(line => [line.event, line.fields.file, line.fields.reason]),
    [['controlRejected', broken, 'version'], ['controlRejected', seedFile, 'duplicate']],
    'both files are named, and each with its own reason')
})


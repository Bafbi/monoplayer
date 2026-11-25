// #229/#262/#264: the runtime control document's reader and the dial policy.
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
  createControlDocument,
  dialIntent,
  parseAllowedServers,
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

test('#229 with no file named nothing is read and nothing is enabled', () => {
  const lines = []
  const document = createControlDocument({ log: (event, fields) => lines.push({ event, fields }) })
  assert.equal(document.enabled, false)
  assert.equal(document.whitelistStore, null)
  assert.deepEqual(document.attachWhitelist(), [])
  assert.deepEqual(lines, [], 'a lane that never set the switch logs nothing')
})

// #264: the backend move is gone, and the attach whitelist was the key that had to
// survive it. MONOPLAYER_ATTACH_WHITELIST is now the switch that turns the control
// document on, so a lane that names one file still loads the list it names. The
// defect this catches is silent: a whitelist that does not load is a front that
// refuses every login with no error.
test('#264 the attach whitelist file is the control document\'s one switch', () => {
  const dir = controlDir('whitelist-switch')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  writeWhitelist(whitelistFile, [PLAYER])

  const document = createControlDocument({ whitelistFile })
  assert.equal(document.enabled, true, 'naming the whitelist file turns the document on')
  assert.deepEqual(document.attachWhitelist(), [PLAYER], 'and the UUID in it is allowed')
})

// #264: the static lane read the whitelist once at boot and exited 2 when it was
// empty. Every lane is now a control lane, because naming the whitelist file is
// what turns the document on, so an empty file is a lane that starts and refuses
// every login by name. The exit is gone on purpose: on the file the panel manages
// it would crash-loop the pod on the file the operator is about to fill.
test('#264 an empty whitelist file loads as an empty list, and the document stays on', () => {
  const dir = controlDir('whitelist-empty')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  writeWhitelist(whitelistFile, [])

  const document = createControlDocument({ whitelistFile })
  assert.equal(document.enabled, true)
  assert.deepEqual(document.attachWhitelist(), [], 'an empty file denies every login rather than throwing')
  assert.equal(document.whitelistStore.has(PLAYER), false)
})

test('#229 the attach whitelist reloads at each read, so a UUID added on disk is allowed next', () => {
  const dir = controlDir('whitelist')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  writeWhitelist(whitelistFile, [PLAYER])
  const document = createControlDocument({ whitelistFile })

  assert.deepEqual(document.attachWhitelist(), [PLAYER])
  assert.equal(document.whitelistStore.has(OTHER), false)

  writeWhitelist(whitelistFile, [PLAYER, OTHER])
  assert.deepEqual(document.attachWhitelist(), [PLAYER, OTHER].map(uuid => uuid.toLowerCase()),
    'the core gate re-reads the file, so the next login sees the new UUID')
  assert.equal(document.whitelistStore.has(OTHER), true,
    'the front leg store agrees without a restart')
})

test('#229 a control whitelist that cannot be parsed is named, and denies instead of crashing', () => {
  const dir = controlDir('broken')
  const whitelistFile = path.join(dir, 'attach-whitelist.json')
  fs.writeFileSync(whitelistFile, '{ "version": 1, "players": [')
  const lines = []
  const document = createControlDocument({
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
  // A server that did not send a transfer is a fresh login, on the dial itself and
  // on every fault after it.
  assert.deepEqual(dialIntent({ transfer: false, target: other, base }), { keepCookies: false, transfer: false })
  // A base target is never a transfer, whatever reached it.
  assert.deepEqual(dialIntent({ transfer: true, target: base, base }), { keepCookies: false, transfer: false })
  assert.deepEqual(dialIntent({ target: base, base }), { keepCookies: false, transfer: false })
})

test('#233 a restored move reverts the dial for every kind that moved the session', () => {
  // The one case that must not revert is a reconfigure: the same connection
  // restarting its configuration phase never left the server. Reading anything
  // else as "keep the target" re-dials the server that never answered, with the
  // client attached, for as long as the process lives.
  assert.equal(revertAfterRestore({ kind: 'transfer' }), true)
  assert.equal(revertAfterRestore({ kind: 'reconfigure' }), false)
  assert.equal(revertAfterRestore({ kind: null }), true, 'an unknown kind is not a reason to keep a dead target')
  assert.equal(revertAfterRestore(), true)
})

// --- #262: the allowed-server list ---

// The other key of the control document: the servers the picker offers (#265).
// It is its own file with its own path because that is what the control document
// is: one key, one file, one reader. It also has a fallback the whitelist does
// not, because a list with nothing in it offers a client nothing, and the list Git
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
  // A document is not re-validated against the dial rule on its way to the picker.
  // The route that writes it refuses a host no dial reaches, so a bad one is there
  // only by hand; the lane reads what the operator wrote, and the panel lists it so
  // that entry can be removed rather than refusing a document it could not repair.
  // Only the document's shape is refused on a read.
  assert.deepEqual(
    parseAllowedServers(JSON.stringify({ version: 1, servers: [{ host: '999.999.999.999', port: 25565 }] })).servers,
    [{ host: '999.999.999.999', port: 25565 }])
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

// #314: DNS reads `paper.` and `paper` as one name. The root label is a full stop,
// not a second label. So a list that spells one server both ways offers two picker
// buttons for it, and each button's body gets its own cache (#260, #265). The case
// check could not see it, and the split is the same one.
test('#314 two rows that name one server with a trailing dot are refused, and the entry is named', () => {
  const list = (...servers) => parseAllowedServers(JSON.stringify({ version: 1, servers }))

  assert.deepEqual(list({ host: 'paper', port: 25565 }, { host: 'paper.', port: 25565 }),
    { servers: null, reason: 'duplicate', at: 'servers[1]' },
    'the root label makes the second row the same server as the first')
  assert.deepEqual(list({ host: 'paper.', port: 25565 }, { host: 'paper', port: 25565 }),
    { servers: null, reason: 'duplicate', at: 'servers[1]' },
    'and a dot on the earlier entry is the same collision, not a different one')
  assert.deepEqual(list({ host: 'PAPER.', port: 25565 }, { host: 'paper', port: 25565 }),
    { servers: null, reason: 'duplicate', at: 'servers[1]' },
    'case and the dot at once')

  assert.deepEqual(list({ host: 'paper', port: 25565 }, { host: 'paper.', port: 25566 }).servers,
    [{ host: 'paper', port: 25565 }, { host: 'paper.', port: 25566 }],
    'one host on two ports is two servers, so the dot changes nothing there')
  assert.deepEqual(list({ host: 'paper.', port: 25565 }).servers, [{ host: 'paper.', port: 25565 }],
    'the list is refused for naming one server twice, not for a dotted host: the entry keeps what the operator wrote')
  assert.deepEqual(list({ host: 'paper', port: 25565 }, { host: 'paper2', port: 25565 }).servers,
    [{ host: 'paper', port: 25565 }, { host: 'paper2', port: 25565 }],
    'a longer name is another server')
})

// #314: the lane refuses the list once, and the refusal names the entry. An operator
// reading `controlRejected` has a document with two rows, and needs to know which one
// to fix.
test('#314 the refusal names the entry that collided, not only the file', () => {
  const file = path.join(controlDir('trailing-dot'), 'allowed-servers.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    servers: [{ host: 'paper', port: 25565 }, { host: 'paper.', port: 25565 }]
  }))
  const lines = []
  const document = createControlDocument({ allowedServersFile: file, log: (event, fields) => lines.push({ event, fields }) })
  assert.deepEqual(document.allowedServers(), { servers: [], source: 'none', reason: 'unreadable' },
    'a list that names one server twice offers nothing, rather than two buttons')
  assert.deepEqual(lines, [{ event: 'controlRejected', fields: { file, reason: 'duplicate', at: 'servers[1]' } }])

  // The refusal is said once, and "once" is per entry. The operator fixes row 1 and
  // the collision moves to row 2. That is a second refusal with a second row to fix,
  // not the same warning arriving twice.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    servers: [{ host: 'paper', port: 25565 }, { host: 'sky', port: 25565 }, { host: 'paper.', port: 25565 }]
  }))
  assert.deepEqual(document.allowedServers(), { servers: [], source: 'none', reason: 'unreadable' })
  assert.deepEqual(lines.map(line => line.fields.at), ['servers[1]', 'servers[2]'],
    'a collision that moved is a new refusal, naming the row to fix now')
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
    { servers: [{ host: 'play2.excalia.fr', port: 25565 }], source: 'seed', reason: null })

  // The live key wins, and it is re-read at each read: a panel write takes effect
  // without a restart, the way the attach whitelist's does.
  writeAllowed(live, [{ host: 'paper.example.net', port: 25565 }])
  assert.deepEqual(document.allowedServers(),
    { servers: [{ host: 'paper.example.net', port: 25565 }], source: 'control', reason: null })
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
  assert.deepEqual(off.allowedServers(), { servers: [], source: 'none', reason: 'no_key' })

  // Its own file is its own switch: a picker lane offers a list with no whitelist
  // file named at all.
  const dir = controlDir('allowed-alone')
  const live = path.join(dir, 'allowed-servers.json')
  writeAllowed(live, [{ host: 'paper.example.net', port: 25565 }])
  assert.equal(createControlDocument({ allowedServersFile: live }).allowedServers().source, 'control',
    'the list is read with no whitelist file named at all')

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
  assert.deepEqual(document.allowedServers(), { servers: [], source: 'none', reason: 'unreadable' })
  assert.deepEqual(lines.map(line => [line.event, line.fields.file, line.fields.reason]),
    [['controlRejected', broken, 'version'], ['controlRejected', seedFile, 'duplicate']],
    'both files are named, and each with its own reason')

  // A seed the lane named and the mount did not deliver is not the normal state: the
  // live key's absence is, because the operator has not written it yet.
  const absentLines = []
  const absentSeed = path.join(controlDir('seed-missing'), 'allowed-servers.json')
  const absent = createControlDocument({
    allowedServersFile: path.join(controlDir('allowed-missing'), 'allowed-servers.json'),
    allowedServersSeedFile: absentSeed,
    log: (event, fields) => absentLines.push({ event, fields })
  })
  assert.deepEqual(absent.allowedServers(), { servers: [], source: 'none', reason: 'seed_missing' })
  assert.deepEqual(absentLines.map(line => [line.event, line.fields.code]),
    [['controlUnreadable', 'ENOENT']],
    'a seed that is not mounted is one named line, not silence')
  assert.equal(absentLines[0].fields.file, absentSeed, 'the line names the seed')
  absent.allowedServers()
  assert.equal(absentLines.length, 1, 'and one line is enough, however often the list is asked for')
})

// #315: a lane that offers nothing says why, in the answer the picker logs. "The list
// is empty" is a fact the operator already has; the reason is the thing to edit. Each
// of these is a different edit, so each is its own word.
test('#315 an empty list carries the reason it is empty', () => {
  const fileIn = (label, name = 'allowed-servers.json') => path.join(controlDir('empty-reason-' + label), name)

  // No key: nothing names a list. The live key is the switch, so a seed on its own has
  // no list to fall back from.
  assert.deepEqual(createControlDocument({}).allowedServers(),
    { servers: [], source: 'none', reason: 'no_key' })
  assert.deepEqual(createControlDocument({ allowedServersSeedFile: fileIn('seed-only') }).allowedServers(),
    { servers: [], source: 'none', reason: 'no_key' })

  // The key names a file nobody has written, and no seed answers behind it. That is the
  // normal state before the first panel edit, and it is not a broken file.
  assert.deepEqual(createControlDocument({ allowedServersFile: fileIn('unwritten') }).allowedServers(),
    { servers: [], source: 'none', reason: 'live_missing' })

  // The file is there, it parses, and the list holds nothing: an operator removed the
  // last server. The answer is still the live file's.
  const emptied = fileIn('emptied')
  writeAllowed(emptied, [])
  assert.deepEqual(createControlDocument({ allowedServersFile: emptied }).allowedServers(),
    { servers: [], source: 'control', reason: 'empty_list' })

  // A seed the lane names and the mount did not deliver: a mount to fix, not an edit.
  assert.deepEqual(createControlDocument({
    allowedServersFile: fileIn('unwritten-seed-live'),
    allowedServersSeedFile: fileIn('unwritten-seed')
  }).allowedServers(), { servers: [], source: 'none', reason: 'seed_missing' })

  // Both files are there and neither parses, so nothing answered: the live file is the
  // one to fix, and the seed is the one to repair behind it.
  const brokenLive = fileIn('broken')
  const brokenSeed = fileIn('broken-seed')
  fs.writeFileSync(brokenLive, 'not json')
  fs.writeFileSync(brokenSeed, JSON.stringify({ version: 9 }))
  assert.deepEqual(createControlDocument({
    allowedServersFile: brokenLive,
    allowedServersSeedFile: brokenSeed
  }).allowedServers(), { servers: [], source: 'none', reason: 'unreadable' })

  // A file that is there and cannot be read is not a file nobody wrote. An operator with
  // a permissions problem must not be told to write a list that is already there.
  const deny = () => {
    const error = new Error('EACCES: permission denied')
    error.code = 'EACCES'
    throw error
  }
  assert.deepEqual(createControlDocument({
    allowedServersFile: fileIn('denied'),
    readFile: deny
  }).allowedServers(), { servers: [], source: 'none', reason: 'unreadable' },
  'a live file that cannot be read is not a missing one')

  const deniedLines = []
  assert.deepEqual(createControlDocument({
    allowedServersFile: fileIn('denied-live'),
    allowedServersSeedFile: fileIn('denied-seed'),
    readFile: deny,
    log: (event, fields) => deniedLines.push({ event, fields })
  }).allowedServers(), { servers: [], source: 'none', reason: 'unreadable' })
  assert.deepEqual(deniedLines.map(line => [line.event, line.fields.code]),
    [['controlUnreadable', 'EACCES'], ['controlUnreadable', 'EACCES']],
    'both files are named with the code that stopped the read')

  // A list that answers carries no reason, so a reader can tell an empty answer from a
  // filled one by the servers alone.
  const answered = fileIn('answered')
  writeAllowed(answered, [{ host: 'paper', port: 25565 }])
  assert.deepEqual(createControlDocument({ allowedServersFile: answered }).allowedServers(),
    { servers: [{ host: 'paper', port: 25565 }], source: 'control', reason: null })
})


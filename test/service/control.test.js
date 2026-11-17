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
  DESIRED_VERSION,
  createControlDocument,
  dialIntent,
  dialTargetFor,
  parseDesiredTarget
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
    { target: { host: '10.0.0.9', port: 25566 }, reason: null })
  assert.deepEqual(parseDesiredTarget(JSON.stringify({ version: 1, backend: { host: ' 10.0.0.9 ', port: 25566 } })).target,
    { host: '10.0.0.9', port: 25566 }, 'a host is trimmed, because a configmap edit leaves whitespace')

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
  assert.deepEqual(document.desiredTarget(), { host: '127.0.0.1', port: 25566 })

  writeDesired(file, { host: '127.0.0.1', port: 25567 })
  assert.deepEqual(document.desiredTarget(), { host: '127.0.0.1', port: 25567 },
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
    'moving a live session is the last ticket in the epic, not this one')
  assert.deepEqual(dialTargetFor({ current }), { target: current, source: 'current' })
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

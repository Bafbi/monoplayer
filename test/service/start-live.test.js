// Unit target: src/service/start-live.js, the parts a test can reach without a
// process — the env-to-config mapping a deployed lane reads, the picker's offer, the
// journal's volume answer, the skin warning, the reconnect handler the lane registers
// (#540), and the shutdown a signal runs (#773). The kept connection (#22) is the
// overlay's case that matters: its default is off, and a lane turns it on through
// this overlay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { blockAfter } from '../support/source-scan.js'
import { tempRoot } from '../support/temp.js'

import {
  addressName,
  allowedServerAddresses,
  attachWhitelistEntries,
  startControlRecord,
  createPickerServerReader,
  createReconnectHandler,
  createShutdownHandler,
  envOverlay,
  journalVolumeFull,
  unidentifiedSkinWarning
} from '../../src/service/start-live.js'
import { createTransferFollowController } from '../../src/core/transfer-follow.js'
import { makeCore } from '../support/harness.js'
import { DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { createControlDocument } from '../../src/service/control.js'
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_TOTAL_BYTES
} from '../../src/observability/journal.js'
import { DEFAULT_DEADLINE_MS, DEFAULT_MAX_CONNECTIONS, MAX_DEADLINE_MS } from '../../src/core/preauth-window.js'

const base = () => ({ transfer: { follow: true, chainLimit: 8 } })

test('#22 MONOPLAYER_TRANSFER_KEEP_CONNECTION=1 turns the kept connection on', () => {
  const out = envOverlay(base(), { MONOPLAYER_TRANSFER_KEEP_CONNECTION: '1' })
  assert.equal(out.transfer.keepConnection, true)
})

test('#22 MONOPLAYER_TRANSFER_KEEP_CONNECTION=0 turns it off', () => {
  const out = envOverlay({ transfer: { keepConnection: true } }, { MONOPLAYER_TRANSFER_KEEP_CONNECTION: '0' })
  assert.equal(out.transfer.keepConnection, false)
})

test('#22 the overlay leaves the other transfer keys alone', () => {
  const out = envOverlay(base(), { MONOPLAYER_TRANSFER_KEEP_CONNECTION: '1' })
  assert.equal(out.transfer.follow, true)
  assert.equal(out.transfer.chainLimit, 8)
})

test('#22 an unset variable leaves the config untouched', () => {
  const doc = base()
  const out = envOverlay(doc, {})
  assert.deepEqual(out.transfer, doc.transfer)
})

test('#22 a value that is neither 1 nor 0 is refused and named', () => {
  const warnings = []
  const doc = base()
  const out = envOverlay(doc, { MONOPLAYER_TRANSFER_KEEP_CONNECTION: 'yes' }, w => warnings.push(w))
  assert.deepEqual(out.transfer, doc.transfer)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /must be 1 or 0/)
})

// #134: the skin frame names the puppet's own entry, so a lane with no resolved
// UUID writes none. The raw cacheDir override is the path that gets here, and it
// is silent otherwise.
test('#134 a lane with no puppet UUID is told its skin frame will not be written', () => {
  const warning = unidentifiedSkinWarning({ skin: { showPuppetSkin: true }, puppet: { uuid: null } })
  assert.match(warning, /no puppet UUID is known/)
  assert.match(warning, /MONOPLAYER_PUPPET_ACCOUNT/, 'the warning names the fix')
})

test('#134 a resolved puppet UUID says nothing, and so does the switch being off', () => {
  assert.equal(unidentifiedSkinWarning({ skin: { showPuppetSkin: true }, puppet: { uuid: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed' } }), null)
  assert.equal(unidentifiedSkinWarning({ skin: { showPuppetSkin: false }, puppet: { uuid: null } }), null)
})

// #108: a config document's reconnect budget must survive the overlay, and the
// env var's 0 or absence must reach loadConfig as unlimited.
test('#108 a config document\'s reconnect attempts reach loadConfig', () => {
  const out = envOverlay({ reconnect: { attempts: 2, maxDelayMs: 5000 } }, {})
  assert.equal(out.reconnect.attempts, 2)
  assert.equal(out.reconnect.maxDelayMs, 5000)
  const cfg = loadConfig(out)
  assert.equal(cfg.reconnect.attempts, 2)
  assert.equal(cfg.reconnect.maxDelayMs, 5000)
})

// #96: the journal's directory and its retention budget are config, because a
// directory with only a rotation size grows without bound and took the live
// front down on ENOSPC. The byte budget, the age cap, and the directory all
// arrive through the overlay, and loadConfig refuses a value that cannot bound
// anything.
// The defaults are stated twice: in the config document, which stays free of
// file I/O, and in the journal module, which owns the retention. Neither can
// import the other, so this is the guard that keeps them equal.
test('#96 the journal config defaults match the journal module', () => {
  assert.deepEqual(DEFAULT_CONFIG.journal, {
    dir: null,
    maxBytes: DEFAULT_MAX_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: DEFAULT_MAX_AGE_MS
  })
})

test('#96 a full journal volume is reported with the token and the path', () => {
  const report = journalVolumeFull({
    disabledReason: 'journal_volume_full',
    dir: '/tmp/journal',
    freeBytes: 0,
    requiredBytes: 1024
  })
  assert.deepEqual(report, {
    reason: 'journal_volume_full',
    dir: '/tmp/journal',
    freeBytes: 0,
    requiredBytes: 1024
  })
  assert.equal(journalVolumeFull({ disabledReason: 'no_dir', dir: null }), null)
  assert.equal(journalVolumeFull({ disabledReason: null }), null)
})

test('#96 the overlay carries the journal directory and its retention budget', () => {
  const out = envOverlay({}, {
    MONOPLAYER_JOURNAL_DIR: '/tmp/journal',
    MONOPLAYER_JOURNAL_MAX_BYTES: '1024',
    MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES: '4096',
    MONOPLAYER_JOURNAL_MAX_AGE_MS: '60000'
  })
  const cfg = loadConfig(out)
  assert.deepEqual(cfg.journal, {
    dir: '/tmp/journal',
    maxBytes: 1024,
    maxTotalBytes: 4096,
    maxAgeMs: 60000
  })
})

test('#96 an unset variable leaves the journal config, and the journal, alone', () => {
  const out = envOverlay({}, {})
  assert.equal(out.journal, undefined)
  const cfg = loadConfig(out)
  assert.equal(cfg.journal.dir, null, 'no directory means the journal is off')
  assert.ok(cfg.journal.maxTotalBytes > 0, 'the directory still has a budget')
  assert.ok(cfg.journal.maxAgeMs > 0, 'and an age cap')
})

test('#96 a cap that cannot be read is named and left at the default', () => {
  const warnings = []
  const out = envOverlay({}, { MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES: '256MiB' }, w => warnings.push(w))
  assert.equal(out.journal, undefined, 'the document is untouched')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES/)
})

test('#96 loadConfig refuses a journal budget that does not bound the rotation', () => {
  assert.equal(loadConfig({ journal: { maxBytes: 1024, maxTotalBytes: 4096, maxAgeMs: 1 } }).journal.maxTotalBytes, 4096)
  assert.throws(() => loadConfig({ journal: { maxBytes: 4096, maxTotalBytes: 1024 } }), /maxTotalBytes/)
  assert.throws(() => loadConfig({ journal: { maxBytes: 0 } }), /maxBytes/)
  assert.throws(() => loadConfig({ journal: { maxAgeMs: -1 } }), /maxAgeMs/)
  assert.throws(() => loadConfig({ journal: { dir: '  ' } }), /journal\.dir/)
})

test('#108 the env var overrides the document, and 0 or unset means unlimited', () => {
  assert.equal(
    envOverlay({ reconnect: { attempts: 2 } }, { MONOPLAYER_RECONNECT_ATTEMPTS: '3' }).reconnect.attempts,
    3
  )
  assert.equal(
    envOverlay({ reconnect: { attempts: 2 } }, { MONOPLAYER_RECONNECT_ATTEMPTS: '0' }).reconnect.attempts,
    Infinity
  )
  assert.equal(envOverlay({}, {}).reconnect.attempts, Infinity)
  // A document's own 0 survives the overlay too. The session reads a
  // non-positive attempts as unlimited (src/core/session.js:74), which is how
  // the file's 0 means the same as the env var's 0.
  assert.equal(envOverlay({ reconnect: { attempts: 0 } }, {}).reconnect.attempts, 0)
})

// #201: the pre-auth window's total connection cap. The window runs from an
// accepted socket to the attach whitelist's accept. The cap is on by default,
// and a value that cannot bound the window is refused rather than defaulted away.
test('#201 the cap is on by default and is the number the window module owns', () => {
  assert.equal(DEFAULT_CONFIG.preAuth.maxConnections, DEFAULT_MAX_CONNECTIONS)
  assert.equal(loadConfig().preAuth.maxConnections, DEFAULT_MAX_CONNECTIONS)
  assert.ok(DEFAULT_MAX_CONNECTIONS > 1, 'the default bounds the window without refusing a lone player')
})

test('#201 MONOPLAYER_PREAUTH_MAX_CONNECTIONS sets the cap', () => {
  const out = envOverlay({ preAuth: { maxConnections: DEFAULT_MAX_CONNECTIONS } },
    { MONOPLAYER_PREAUTH_MAX_CONNECTIONS: '4' })
  assert.equal(loadConfig(out).preAuth.maxConnections, 4)
})

test('#201 an unset variable leaves the cap at its default', () => {
  assert.equal(envOverlay({}, {}).preAuth, undefined, 'the document is untouched')
  assert.equal(loadConfig(envOverlay({}, {})).preAuth.maxConnections, DEFAULT_MAX_CONNECTIONS)
})

test('#201 a cap the overlay cannot read is named and left at the default', () => {
  const warnings = []
  const out = envOverlay({}, { MONOPLAYER_PREAUTH_MAX_CONNECTIONS: '0' }, w => warnings.push(w))
  assert.equal(out.preAuth, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /MONOPLAYER_PREAUTH_MAX_CONNECTIONS/)
})

test('#201 loadConfig refuses a cap that cannot bound the window', () => {
  for (const bad of [0, -2, 1.5, '8', null]) {
    assert.throws(() => loadConfig({ preAuth: { maxConnections: bad } }),
      /config\.preAuth\.maxConnections/, JSON.stringify(bad))
  }
  assert.equal(loadConfig({ preAuth: { maxConnections: 8 } }).preAuth.maxConnections, 8)
})

// #205: the deadline on the pre-auth window. It bounds how long one connection
// may hold a slot, so it is on by default too, and a value that cannot bound
// anything is refused rather than defaulted away.
test('#205 the deadline is on by default and is the number the window module owns', () => {
  assert.equal(DEFAULT_CONFIG.preAuth.deadlineMs, DEFAULT_DEADLINE_MS)
  assert.equal(loadConfig().preAuth.deadlineMs, DEFAULT_DEADLINE_MS)
  assert.ok(DEFAULT_DEADLINE_MS >= 10_000, 'a slow but real login must never be cut')
})

test('#205 MONOPLAYER_PREAUTH_DEADLINE_MS sets the deadline', () => {
  const out = envOverlay({ preAuth: { deadlineMs: DEFAULT_DEADLINE_MS } },
    { MONOPLAYER_PREAUTH_DEADLINE_MS: '5000' })
  assert.equal(loadConfig(out).preAuth.deadlineMs, 5000)
})

test('#205 an unset variable leaves the deadline at its default', () => {
  assert.equal(envOverlay({}, {}).preAuth, undefined, 'the document is untouched')
  assert.equal(loadConfig(envOverlay({}, {})).preAuth.deadlineMs, DEFAULT_DEADLINE_MS)
})

test('#205 a deadline the overlay cannot read is named and left at the default', () => {
  const warnings = []
  const out = envOverlay({}, { MONOPLAYER_PREAUTH_DEADLINE_MS: '0' }, w => warnings.push(w))
  assert.equal(out.preAuth, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /MONOPLAYER_PREAUTH_DEADLINE_MS/)
})

test('#205 loadConfig refuses a deadline that cannot bound anything', () => {
  for (const bad of [0, -2, 1.5, '8', null]) {
    assert.throws(() => loadConfig({ preAuth: { deadlineMs: bad } }),
      /config\.preAuth\.deadlineMs/, JSON.stringify(bad))
  }
  assert.equal(loadConfig({ preAuth: { deadlineMs: 5000 } }).preAuth.deadlineMs, 5000)
})

test('#205 loadConfig refuses a deadline past what a timer can hold', () => {
  // Node fires a longer delay at 1 ms, which would destroy every connection the
  // moment it arrived. A document that sets one refuses to start instead.
  for (const bad of [MAX_DEADLINE_MS + 1, 3_000_000_000]) {
    assert.throws(() => loadConfig({ preAuth: { deadlineMs: bad } }),
      /config\.preAuth\.deadlineMs/, JSON.stringify(bad))
  }
  assert.equal(loadConfig({ preAuth: { deadlineMs: MAX_DEADLINE_MS } }).preAuth.deadlineMs, MAX_DEADLINE_MS)
})

test('#205 a deadline past what a timer can hold is named and ignored, so a typo cannot fire it', () => {
  const warnings = []
  const out = envOverlay({}, { MONOPLAYER_PREAUTH_DEADLINE_MS: String(MAX_DEADLINE_MS + 1) },
    w => warnings.push(w))
  assert.equal(out.preAuth, undefined, 'the document is untouched')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /MONOPLAYER_PREAUTH_DEADLINE_MS/)
  assert.match(warnings[0], new RegExp(String(MAX_DEADLINE_MS)), 'the warning names the ceiling')
  assert.equal(loadConfig(out).preAuth.deadlineMs, DEFAULT_DEADLINE_MS)
})

// #891: the two addresses a deployed lane is set by. The overlay is where the operator
// writes, so it names the variable they wrote when it refuses one: a config key sends
// them to the Deployment's args line instead of its env block. The refusal is a throw
// rather than the named-and-ignored warning every other number gets here, because a
// number has a bounded default to fall back on and an address has none: the compiled
// front is loopback, and a front left on loopback serves nobody outside the pod.
test('#891 MONOPLAYER_FRONT_HOST and MONOPLAYER_BACKEND_HOST refuse a value that is not a host', () => {
  for (const variable of ['MONOPLAYER_FRONT_HOST', 'MONOPLAYER_BACKEND_HOST']) {
    const blank = variable === 'MONOPLAYER_FRONT_HOST' ? 'front' : 'backend'
    assert.equal(envOverlay({}, { [variable]: ' ' })[blank]?.host, undefined, variable + ' blank sets no host')
    for (const bad of ['play2.excalia.fr:25565', '[::1]', 'play2.excalia.fr:', ' 127.0.0.1']) {
      assert.throws(() => envOverlay({}, { [variable]: bad }), error => {
        assert.match(error.message, new RegExp(variable + ' must be a host'))
        assert.ok(error.message.includes(bad), 'the message carries what was typed: ' + error.message)
        return error instanceof TypeError
      }, variable + ' ' + JSON.stringify(bad))
    }
    const good = envOverlay({}, { [variable]: '2001:db8::1' })
    const section = variable === 'MONOPLAYER_FRONT_HOST' ? good.front : good.backend
    assert.equal(section.host, '2001:db8::1', 'an IPv6 host is written bare and read bare')
  }
})

test('#891 MONOPLAYER_FRONT_PORT and MONOPLAYER_BACKEND_PORT refuse a port no socket can use', () => {
  for (const variable of ['MONOPLAYER_FRONT_PORT', 'MONOPLAYER_BACKEND_PORT']) {
    const floor = variable === 'MONOPLAYER_FRONT_PORT' ? 0 : 1
    for (const bad of ['2556O', '70000', '-1', '25565.5', '']) {
      if (bad === '') {
        // An empty variable is an unset one here, as it is for every other name, and so
        // is one holding only space: a template that interpolates nothing and a paste
        // that catches a blank are the same fact.
        const key = variable === 'MONOPLAYER_FRONT_PORT' ? 'front' : 'backend'
        assert.equal(envOverlay({}, { [variable]: '' })[key]?.port, undefined, variable + ' empty sets no port')
        assert.equal(envOverlay({}, { [variable]: ' ' })[key]?.port, undefined, variable + ' blank sets no port')
        continue
      }
      assert.throws(() => envOverlay({}, { [variable]: bad }), error => {
        assert.match(error.message,
          new RegExp(variable + ' must be an integer from ' + floor + ' to 65535, got "' + bad + '"'))
        return error instanceof TypeError
      }, variable + ' ' + bad)
    }
    const key = variable === 'MONOPLAYER_FRONT_PORT' ? 'front' : 'backend'
    assert.equal(envOverlay({}, { [variable]: '25565' })[key].port, 25565,
      'a port the socket can take is the number beside its host')
  }
  assert.equal(envOverlay({}, { MONOPLAYER_FRONT_PORT: '0' }).front.port, 0,
    'the front may still ask the OS for one')
})

test('#891 an IPv6 front on an ephemeral port is still spelled where a reader can split it', () => {
  // #891 was filed on the start record writing `2001:db8::1:0`. The config accepts a
  // front port of 0, because that is a bind asking the OS for one, so the spelling is
  // where the defect is closed.
  assert.equal(addressName('2001:db8::1', 0), '[2001:db8::1]:0',
    'the host keeps its brackets beside a port the picker declines to dial')
})

// #229/#264: the control document's compiled switches. Two paths are left, and the
// compiled document names neither: an unset variable leaves the lane reading the
// snapshot it always read.
test('#229 no control path is set by default', () => {
  assert.deepEqual(DEFAULT_CONFIG.control, { allowedServers: null, allowedServersSeed: null })
  assert.deepEqual(loadConfig().control, { allowedServers: null, allowedServersSeed: null })
})

test('#229 an unset control variable leaves the config document alone', () => {
  const doc = { control: { allowedServers: '/control/allowed-servers.json' } }
  const out = envOverlay(doc, {})
  assert.deepEqual(out.control, doc.control)
})

// #264: the desired-backend key and its switch are retired with the backend move.
// A lane that still set either one would be a lane reading a document nothing
// writes, and the overlay is where that would have been wired.
test('#264 the retired control variables wire nothing', () => {
  const out = envOverlay({}, {
    MONOPLAYER_CONTROL_FILE: '/control/desired.json',
    MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH: '1'
  })
  assert.equal(out.control, undefined, 'neither variable is a control key')
  assert.deepEqual(loadConfig(out).control, { allowedServers: null, allowedServersSeed: null })
})

test('#229 loadConfig refuses a control path that cannot name a file', () => {
  assert.throws(() => loadConfig({ control: { allowedServers: '   ' } }), /control\.allowedServers/)
  assert.throws(() => loadConfig({ control: { allowedServersSeed: 42 } }), /control\.allowedServersSeed/)
  assert.equal(loadConfig({ control: { allowedServers: '/control/allowed-servers.json' } }).control.allowedServers,
    '/control/allowed-servers.json')
})

// #262: the allowed-server list. Its own file, its own two paths, and its own
// switch: a picker lane offers a list with no whitelist file named at all.
test('#262 MONOPLAYER_ALLOWED_SERVERS names the list, and its seed names the copy Git holds', () => {
  const out = envOverlay({}, {
    MONOPLAYER_ALLOWED_SERVERS: '/control/allowed-servers.json',
    MONOPLAYER_ALLOWED_SERVERS_SEED: '/config/allowed-servers.json'
  })
  assert.equal(out.control.allowedServers, '/control/allowed-servers.json')
  assert.equal(out.control.allowedServersSeed, '/config/allowed-servers.json')
  assert.equal(loadConfig(out).control.allowedServers, '/control/allowed-servers.json',
    'the resolved document carries the path the lane reads')
})

test('#262 the list is read without the whitelist file, and one unset path leaves the file it names alone', () => {
  const out = envOverlay({}, { MONOPLAYER_ALLOWED_SERVERS: '/control/allowed-servers.json' })
  assert.equal(out.control.allowedServersSeed, undefined, 'one control path does not require the other')

  const doc = { control: { allowedServers: '/control/allowed-servers.json' } }
  assert.deepEqual(envOverlay(doc, {}).control, doc.control, 'an unset variable is not a removal')
})


// #265: the picker's list. The key is the allowed-server list (#262), read at each
// offer, so a panel edit shows at the next join. The row a lane offers names the
// address a claim dials.
test('#265 the picker reader offers the allowed-server list, and names the source once per answer', () => {
  let answer = {
    servers: [{ host: 'paper', port: 25565 }],
    source: 'seed',
    file: '/control/seed/allowed-servers.json',
    reason: null,
    at: null
  }
  const said = []
  const offered = createPickerServerReader({
    control: { allowedServers: () => answer },
    log: (event, fields) => said.push({ event, ...fields })
  })

  // #259: the reader names servers; what a body on one is doing is the leg's answer
  // at the offer, so a row leaves this function with nobody driving and nobody
  // watching it. #315: the answer is the whole offer, so the leg that draws it can say
  // why there is nothing to draw.
  assert.deepEqual(offered(), {
    source: 'seed',
    reason: null,
    rows: [{ name: 'paper:25565', state: 'down', driver: null, spectators: 0 }]
  })
  // The list is read at each offer, so an edit made from the panel is what the next
  // join sees. The picker is not a snapshot taken at start.
  answer = {
    servers: [{ host: 'paper', port: 25565 }, { host: 'sky', port: 25566 }],
    source: 'control',
    file: '/control/allowed-servers.json',
    reason: null,
    at: null
  }
  assert.deepEqual(offered().rows.map(row => row.name), ['paper:25565', 'sky:25566'])

  // One line per answer, not one per read. A join reads the list more than once, and
  // an operator does not need the same fact three times.
  offered()
  assert.deepEqual(said, [
    { event: 'pickerOffered', source: 'seed', servers: 1, reason: null, file: '/control/seed/allowed-servers.json', at: null },
    { event: 'pickerOffered', source: 'control', servers: 2, reason: null, file: '/control/allowed-servers.json', at: null }
  ])

  // A lane with no list offers nothing, and says so. It does not fall back to the
  // configured backend: the list is what a picker lane offers.
  answer = { servers: [], source: 'none', file: null, reason: 'no_key', at: null }
  assert.deepEqual(offered().rows, [])
  assert.equal(said.length, 3)
  assert.deepEqual(said[2],
    { event: 'pickerOffered', source: 'none', servers: 0, reason: 'no_key', file: null, at: null })

  // #315: the reason is part of the answer, so a reason that changes is a new line. An
  // operator fixes the mount only to find the file it exposes is broken, and the second
  // fact is the one they need now.
  answer = { servers: [], source: 'none', file: '/control/allowed-servers.json', reason: 'live_missing', at: null }
  assert.deepEqual(offered().rows, [])
  answer = { servers: [], source: 'none', file: '/control/allowed-servers.json', reason: 'unreadable', at: null }
  assert.deepEqual(offered().rows, [])
  assert.deepEqual(said.slice(-2), [
    { event: 'pickerOffered', source: 'none', servers: 0, reason: 'live_missing', file: '/control/allowed-servers.json', at: null },
    { event: 'pickerOffered', source: 'none', servers: 0, reason: 'unreadable', file: '/control/allowed-servers.json', at: null }
  ])

  // #372: the entry the refusal names is part of the answer too, so the line names the
  // row to fix. A second row to fix is a second line: the operator repairs row 1, the
  // collision moves to row 2, and the first line would be silent about row 2.
  answer = { servers: [], source: 'none', file: '/control/allowed-servers.json', reason: 'duplicate', at: 'servers[1]' }
  assert.deepEqual(offered().rows, [])
  answer = { servers: [], source: 'none', file: '/control/allowed-servers.json', reason: 'duplicate', at: 'servers[2]' }
  assert.deepEqual(offered().rows, [])
  assert.deepEqual(said.slice(-2).map(line => [line.reason, line.at]), [
    ['duplicate', 'servers[1]'],
    ['duplicate', 'servers[2]']
  ], 'one row to fix is one line, and the next row is the next line')

  // Composed where a lane can see the mistake at start, not at a join.
  assert.throws(() => createPickerServerReader({ control: {} }), /allowedServers/)
})

// #356: the offer a lane makes when it names only the seed. This reader is the
// product's own, composed over the product's own control document. A fix that stopped
// at the answer control.js returns would leave the picker empty, and this fails.
test('#356 a lane that names only the seed offers the seed to the picker', () => {
  const dir = tempRoot('monoplayer-picker-seed-')
  const seedFile = path.join(dir, 'allowed-servers.json')
  fs.writeFileSync(seedFile, JSON.stringify({ version: 1, servers: [{ host: 'paper', port: 25565 }] }), 'utf8')
  const said = []
  const offer = createPickerServerReader({
    control: createControlDocument({ allowedServersSeedFile: seedFile }),
    log: (event, fields) => said.push({ event, ...fields })
  })

  assert.deepEqual(offer().rows.map(row => row.name), ['paper:25565'],
    'the row the seed holds is the row the picker draws')
  assert.deepEqual(said, [{ event: 'pickerOffered', source: 'seed', servers: 1, reason: null, file: seedFile, at: null }],
    'and the line says the seed answered, and which file that was')
})

// #540: the reconnect handler runs only inside a started process, so no test had
// ever executed it. #536's `ReferenceError` sat on its success path for a day:
// every reconnect that connected was recorded as one that did not, the settled
// target never advanced, and #229's revert had nothing to revert to. The handler
// is now a function this file calls, and these are the only places it runs.
const TRANSFER = Object.freeze({ host: 'sky-2.excalia.fr', port: 25565 })
const OTHER = Object.freeze({ host: 'sky-9.excalia.fr', port: 25565 })

function reconnectRig ({ warm = { hasConfig: true, hasPrefix: true, warm: true } } = {}) {
  const { core } = makeCore()
  const calls = []
  const stages = []
  let rejects = 0
  const backend = {
    calls,
    async connect () { calls.push({ call: 'connect' }) },
    setTarget (target, intent = {}) {
      if (rejects > 0) {
        rejects--
        throw new Error('transport not connected')
      }
      calls.push({ call: 'setTarget', target: { ...target }, intent: { ...intent } })
    }
  }
  const log = []
  const { onReconnectDue } = createReconnectHandler({
    core,
    backend,
    follow: createTransferFollowController(),
    baseTarget: { host: '127.0.0.1', port: 25565 },
    settleWarm: async ({ stage }) => {
      stages.push(stage)
      return warm
    },
    log: (event, fields = {}) => log.push({ event, fields })
  })
  return {
    handler: onReconnectDue,
    log,
    calls,
    stages,
    core,
    setWarm: next => { warm = next },
    // The next setTarget refuses, as the leg does for a dial it cannot make.
    rejectNextTarget: () => { rejects = 1 }
  }
}

const events = rig => rig.log.map(line => line.event)

test('#540 a followed reconnect that connects is recorded as a reconnect, not a failure', async () => {
  const rig = reconnectRig()
  await rig.handler({ delayMs: 250, attempt: 1, target: TRANSFER })

  assert.deepEqual(events(rig), ['transferFollowConnect', 'backendReconnect'],
    'the success path records the reconnect it made, and nothing calls it a failure')
  const success = rig.log.at(-1).fields
  assert.equal(success.followed, true, 'the record says the dial followed a transfer')
  assert.equal(success.target, 'sky-2.excalia.fr:25565', 'and which body it landed on')
  assert.equal(rig.calls[0].intent.transfer, true, 'a followed dial asks for the transfer handshake')
  assert.deepEqual(rig.stages, ['transfer'], 'and warms as a transfer, not as a plain reconnect')
})

test('#540 a reconnect after a followed transfer keeps the dialect and the server', async () => {
  const rig = reconnectRig()
  await rig.handler({ delayMs: 250, attempt: 1, target: TRANSFER })
  const settled = rig.calls.length
  await rig.handler({ delayMs: 500, attempt: 2 })

  assert.deepEqual(rig.calls[settled].target, { ...TRANSFER },
    'a plain fault dials the server the session is on, not the configured base')
  assert.equal(rig.calls[settled].intent.transfer, true,
    'and keeps the transfer handshake, because that server is off the base')
  assert.deepEqual(rig.stages.slice(1), ['reconnect'], 'a retry of the same server is a reconnect')
})

// #705: a whitelist count names nothing an operator can act on. A lane with two
// usable entries and a lane with one usable entry and one name-derived uuid both read
// as "2", and #677 found the second state in a live document. So the start record
// carries the entries beside the count, each with the verdict #703 put in one home, and
// the count is that list's length so the two cannot disagree.
//
// The startup list is an array of uuids: `attachWhitelist` in src/service/control.js
// maps the document to its uuids and drops the names. So this record asks
// the version half of the rule, which is the half that refuses a name-derived uuid
// (md5("OfflinePlayer:<name>") carries version 3). The panel holds the names, and its
// answer is the whole rule.
const WHITELIST_V4 = '6EB73524-FF88-4A62-A8D0-C63905E7AFBA'
const WHITELIST_DERIVED = '62e2a85673423096b19f938454443a11'

test('#705 the start record names each attach whitelist entry, and whether its shape stops a login', () => {
  const entries = attachWhitelistEntries([WHITELIST_V4, WHITELIST_DERIVED])
  assert.deepEqual(entries, [
    { uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', refusalReason: null },
    {
      uuid: '62e2a856-7342-3096-b19f-938454443a11',
      refusalReason: 'a version-3 uuid is not one Mojang issues, so no Mojang session answers for it'
    }
  ], 'one entry per uuid, both spellings normalised, and the verdict beside each')
  assert.equal(attachWhitelistEntries([]).length, 0, 'a lane with no list has no entries, not a missing field')
  assert.deepEqual(attachWhitelistEntries(['not-a-uuid'])[0],
    { uuid: null, refusalReason: 'it is not a uuid, so no login can match it' },
    'a value that is not a uuid is answered as one, not printed as if it were')
})

test('#705 the journal record carries the entries beside the count, and does not count alone', () => {
  // The log half of the pair is already pinned, and behaviourally: docs/telemetry.md
  // names `whitelistEntries`, and test/observability/telemetry-doc.test.js fails when the
  // table names a label `log('startLive', …)` does not write. The journal event has no
  // such guard, and #331 is the shape this pair already got wrong once, naming two
  // different backends. The call is read by brace matching, the way that guard reads it,
  // because no test drives startLive() itself: it opens sockets and a custody volume.
  const source = fs.readFileSync(new URL('../../src/service/start-live.js', import.meta.url), 'utf8')
  const body = objectBody(source, "journal.event('startLive', {")
  assert.match(body, /whitelistEntries: entriesAtStart/, 'the event carries the entry list')
  assert.match(body, /whitelistCount: entriesAtStart\.length/, 'and counts the list it carries')
  assert.doesNotMatch(body, /whitelistCount: cfg\.attachWhitelist\.length/,
    'it counts a list it does not carry, which is the defect #705 is about')
})

// --- #746: the start record names the allowed servers it offers ---
//
// The same defect #601, #677 and #705 fixed one field over in this record: a count
// names nothing an operator can hold against the file, and two servers offered read
// exactly like one server and a host that resolves to nothing.
//
// An entry is the `host:port` a picker row is named for (src/core/picker.js). No name
// of its own is available: `parseAllowedServers` keeps a host, a port and a stamp, and
// drops every field it has no use for. The address is also the fact a reader wants. It
// is the target a claim dials, and not whoever holds it.
const ALLOWED_SERVERS = [
  { host: 'play2.excalia.fr', port: 25565 },
  { host: 'sky.excalia.fr', port: 25566 }
]

function allowedServersFile (servers) {
  const file = path.join(tempRoot('monoplayer-start-allowed-'), 'allowed-servers.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers }) + '\n')
  return file
}

test('#746 the start record names each allowed server it offers, not only how many', () => {
  const read = createControlDocument({ allowedServersFile: allowedServersFile(ALLOWED_SERVERS) }).allowedServers()
  assert.equal(read.source, 'control', 'the case reads the file an operator edits')

  // The block the record writes, over a real file. `count` is the list's own length, so no
  // reader can hold a count and a list that disagree.
  assert.deepEqual(
    startControlRecord({ file: '/control/allowed-servers.json', whitelistReload: true, read }),
    {
      whitelistReload: true,
      allowedServers: {
        file: '/control/allowed-servers.json',
        seed: null,
        source: 'control',
        count: 2,
        servers: ['play2.excalia.fr:25565', 'sky.excalia.fr:25566']
      }
    },
    'one address per server, in the order the file holds them, as the address a claim dials')

  // A host holding a colon is the case that tells "the address the dialog draws" from
  // "the host and port joined with a colon": one server offered under two names is one
  // body with two caches (src/core/picker.js, canonicalPickName).
  assert.deepEqual(
    allowedServerAddresses({ servers: [{ host: '2001:db8::1', port: 25565 }], source: 'control', file: null, reason: null, at: null }),
    ['[2001:db8::1]:25565'],
    'and an address reads here exactly as the picker draws it')

  assert.deepEqual(allowedServerAddresses({ servers: [], source: 'none', file: null, reason: 'no_key', at: null }), [],
    'a lane that offers nothing has an empty list, not a missing field')
  assert.deepEqual(allowedServerAddresses(null), [], 'and a read that answered nothing is the same fact')
})

// The object literal opened after `marker`, by brace matching. No case drives
// startLive(): it opens sockets and a custody volume, so what the record carries is read
// off the source, the way #705's journal half is (#705 is the pair this one copies).
function objectBody (source, marker) {
  return blockAfter(source, marker, marker + ' in src/service/start-live.js').body
}

// One row of docs/telemetry.md's start and dial table, by the fields it names. #746's case
// reads one row and #815's reads another, so the lookup is one rule too.
function startLiveRow (doc, ...fields) {
  return doc.split('\n').find(line => line.startsWith('| `startLive`') &&
    fields.every(field => line.includes('`' + field + '`')))
}

test('#746 both start records carry the addresses beside the count, and the page names the list', () => {
  // Both records carry one literal between them, so a journal reader learns the servers
  // the log line names. That is what #331 made true for `backend` after it named two.
  const source = fs.readFileSync(new URL('../../src/service/start-live.js', import.meta.url), 'utf8')
  for (const marker of ["log('startLive', {", "journal.event('startLive', {"]) {
    assert.match(objectBody(source, marker), /control: controlRecord,/,
      marker + ' carries the one block the other record carries')
  }

  // The doc guard in test/observability/ reads a dotted field's first segment, so it
  // cannot see this key: it would pass with the row naming a list the record stopped
  // writing. This is the case that reads the two together.
  const doc = fs.readFileSync(new URL('../../docs/telemetry.md', import.meta.url), 'utf8')
  const row = startLiveRow(doc, 'control.allowedServers.servers')
  assert.ok(row, 'docs/telemetry.md\'s startLive table names control.allowedServers.servers')
  assert.ok(row.includes('`host:port`'), 'and says an entry is the address: ' + row)
})

// --- #815: one spelling for an address in this record ---
//
// #746 made `control.allowedServers.servers` print the address a picker row is named for,
// so a host holding a colon keeps its brackets (src/core/picker.js, canonicalPickName). The
// addresses beside it in the same record were template strings, so one record wrote one
// IPv6 address two ways, and the unbracketed spelling cannot be split back: the host and
// the port run together.
//
// An IPv4 address cannot see this, because it has one colon. These cases are IPv6 for that
// reason. The record carries two addresses, one for the front and one for the backend. The
// target a reconnect dialled is the same shape through the same rule, and the scan below
// holds that.
const IPV6_FRONT = { host: '2001:db8::1', port: 25565 }
const IPV6_BACKEND = { host: '2001:db8::2', port: 25566 }

test('#815 an IPv6 front and an IPv6 backend read as the picker writes a row', () => {
  assert.equal(addressName(IPV6_FRONT.host, IPV6_FRONT.port), '[2001:db8::1]:25565',
    'the front keeps its brackets, so a reader can split the host from the port')
  assert.equal(addressName(IPV6_BACKEND.host, IPV6_BACKEND.port), '[2001:db8::2]:25566',
    'and the backend beside it is the same spelling, not a second one')

  // The defect is two fields of one document disagreeing, so the case reads the two
  // together: the address the picker offers and the address the front prints.
  const offered = allowedServerAddresses({
    servers: [IPV6_FRONT], source: 'control', file: null, reason: null, at: null
  })
  assert.deepEqual(offered, [addressName(IPV6_FRONT.host, IPV6_FRONT.port)],
    'the offered address and the front are one spelling in one record')
})

test('#815 an address that needs no bracket is written as it always was', () => {
  assert.equal(addressName('10.0.0.1', 25565), '10.0.0.1:25565', 'an IPv4 host has one colon')
  assert.equal(addressName('play2.excalia.fr', 25565), 'play2.excalia.fr:25565', 'and so does a name')
  assert.equal(addressName('[2001:db8::1]', 25565), '[2001:db8::1]:25565',
    'the rule is idempotent, so a caller that brackets a host itself is not bracketed twice')
})

test('#815 every address a record joins is spelled by the one rule', () => {
  // The helper is only half the claim: a site that joins a host and a port itself is the
  // re-spelling this ticket is about, and it reads green in the cases above. So the record
  // literals are read, the way #705 reads the journal half.
  const source = fs.readFileSync(new URL('../../src/service/start-live.js', import.meta.url), 'utf8')
  const records = [
    "log('startLive', {",
    "journal.event('startLive', {",
    "log('liveReady', {",
    "journal.event('liveReady', {",
    "log('backendReconnect', {",
    "log('backendReconnectFailed', {"
  ]
  for (const marker of records) {
    const body = objectBody(source, marker)
    assert.match(body, /addressName\(/, marker + ' spells its address with the one rule')
    assert.doesNotMatch(body, /`\$\{[^`]*\.host\}:\$\{[^`]*\.port\}`/,
      marker + ' joins a host and a port itself, which is the second spelling')
  }
  // A seventh record that joined an address itself must fail here too, so the scan runs over
  // the file with the rule's own body taken out, not over the six markers above.
  const rule = blockAfter(source, 'export function addressName', 'the address rule in src/service/start-live.js')
  const outside = source.slice(0, rule.open) + source.slice(rule.close + 1)
  assert.doesNotMatch(outside, /\$\{[^`}]*\.host\}:\$\{[^`}]*\.port\}|\.host \+ ':' \+ /,
    'something outside the rule joins a host and a port itself, in either spelling')

  // `backendAddress` is the one address two records share (#331), so it is where the rule
  // is called once for both.
  assert.match(source, /const backendAddress = addressName\(/, 'the shared backend address is the one rule')

  // The page states the spelling, so a reader with no second address to compare against
  // knows it. #746's list row said it for its own field, and these are the rows beside it. A
  // record that prints a host and a port as two fields is not here: a reader already has
  // those apart.
  const doc = fs.readFileSync(new URL('../../docs/telemetry.md', import.meta.url), 'utf8')
  const start = startLiveRow(doc, 'front', 'backend')
  assert.ok(start, 'docs/telemetry.md\'s start and dial table names the start record\'s front and backend')
  assert.match(start, /keeps its brackets, `\[2001:db8::1\]:25565`/,
    'and prints the bracketed address it means, not only the word brackets: ' + start)
  const reconnect = doc.split('\n').find(line => line.startsWith('| `backendReconnect`') && line.includes('| `target` |'))
  assert.ok(reconnect, 'the table names the address a reconnect dialled')
  assert.match(reconnect, /keeps its brackets/, 'and spells it the way the start record does: ' + reconnect)
})

test('#540 a followed target the leg rejects reverts to the server the session settled on', async () => {
  const rig = reconnectRig()
  await rig.handler({ delayMs: 250, attempt: 1, target: TRANSFER })
  const settled = rig.calls.length
  rig.rejectNextTarget()
  await rig.handler({ delayMs: 500, attempt: 2, target: OTHER })

  assert.deepEqual(rig.calls[settled].target, { ...TRANSFER },
    'the revert dials the server the session settled on, not the one that was refused')
  assert.equal(rig.calls[settled].intent.keepCookies, true,
    'and keeps the cookies, because the settled server was reached by a transfer')
  assert.ok(events(rig).includes('transferFollowTargetRejected'), 'the refusal is on the record')
})

// --- #773: the signal shutdown ---
//
// The handler lives in createShutdownHandler so a case can drive it, the way #540
// moved the reconnect handler out. exit is a parameter and not process.exit, so what
// a SIGTERM does to a process is a value a test reads rather than a process it kills.
// The wait itself is #662's: close() resolves once the socket the leg ended has
// reported its own end, bounded by the leg. A case here uses a close that resolves
// late, because an exit that ran first would look identical with a close that
// resolved at once.

const late = ms => new Promise(resolve => setTimeout(resolve, ms))

function shutdownRig (overrides = {}) {
  const order = []
  const lines = []
  const records = []
  const exits = []
  const stoppedWith = []
  const handler = createShutdownHandler({
    core: { stop: async ({ reason } = {}) => { order.push('core'); stoppedWith.push(reason) } },
    front: { close: async () => { await late(20); order.push('front') } },
    backend: { close: async () => { await late(20); order.push('backend') } },
    telemetry: { flush: async () => { order.push('telemetry') } },
    journal: {
      event: (name, fields) => records.push({ name, ...fields }),
      close: () => { order.push('journal') }
    },
    sink: { end: () => { order.push('sink') } },
    stdout: { write: () => {} },
    log: (name, fields) => lines.push({ name, ...fields }),
    exit: code => { order.push('exit:' + code); exits.push(code) },
    ...overrides
  })
  return { handler, order, lines, records, exits, stoppedWith }
}

test('#773 a signal shutdown has not exited while a leg is still closing', async () => {
  const { handler, order } = shutdownRig()
  const running = handler.stop('SIGTERM')
  await late(5)
  assert.deepEqual(order, ['core'],
    'the core stopped and nothing else has run: an exit taken here would cut the wait #662 gave close()')
  await running
})

test('#773 a signal shutdown awaits both closes, then its records, then exits 0', async () => {
  const { handler, order } = shutdownRig()
  await handler.stop('SIGTERM')
  assert.deepEqual(order, ['core', 'front', 'backend', 'telemetry', 'journal', 'sink', 'exit:0'],
    'both closes resolve before anything is flushed, closed, or exited')
})

test('#773 a leg whose close throws is named on the record and the other leg still closes', async () => {
  const closedLegs = []
  const { handler, lines, records, exits, stoppedWith } = shutdownRig({
    front: { close: async () => { throw new Error('front wedged') } },
    backend: { close: async () => { closedLegs.push('backend') } }
  })
  await handler.stop('SIGINT')
  assert.deepEqual(closedLegs, ['backend'], 'the leg that did not throw still closed, because one throw is not a reason to skip the other')
  assert.deepEqual(exits, [0], 'a leg that failed to close does not fail the stop: the pod is going either way')
  assert.deepEqual(stoppedWith, ['signal:SIGINT'], 'the core was stopped with the signal that arrived')
  for (const record of [lines, records]) {
    const closed = record.find(entry => entry.name === 'legsClosed')
    assert.ok(closed, 'the teardown records what the closes reported, before the process goes')
    assert.equal(closed.reason, 'signal:SIGINT', 'the record repeats the reason the core was stopped with')
    assert.equal(closed.frontCloseError, 'front wedged', 'the leg that threw is named')
    assert.equal(closed.backendCloseError, null, 'and the leg that closed cleanly is not blamed')
    assert.equal(typeof closed.closeMs, 'number', 'with how long the closes took, which is what a slow rollout is read for')
  }
})

test('#773 a second signal during a shutdown does not run the shutdown again', async () => {
  let closes = 0
  const exits = []
  const { handler } = shutdownRig({
    front: { close: async () => { closes += 1 } },
    backend: { close: async () => { closes += 1 } },
    exit: code => { exits.push(code) }
  })
  await Promise.all([handler.stop('SIGTERM'), handler.stop('SIGTERM')])
  assert.equal(closes, 2, 'one close per leg: the second signal found a shutdown already in flight')
  assert.deepEqual(exits, [0], 'and it exited once')
})

test('#773 a teardown never ends the stream the process was handed', async () => {
  // Both shutdown paths read this rule, and the failure path had it before #773: a
  // sink that is stdout is the process's own stream, so ending it is not the lane's.
  const ends = []
  const stdout = { end: () => { ends.push('stdout') } }
  const { handler } = shutdownRig({ sink: stdout, stdout })
  await handler.stop('SIGTERM')
  assert.deepEqual(ends, [], 'a teardown never ends the stream the process was handed')
  const opened = { end: () => { ends.push('file') } }
  const second = shutdownRig({ sink: opened, stdout })
  await second.handler.stop('SIGTERM')
  assert.deepEqual(ends, ['file'], 'and it does end the file the lane opened')
})

// Unit target: envOverlay in src/service/start-live.js, the env-to-config
// mapping a deployed lane reads. The kept connection (#22) is the case that
// matters: its default is off, and a lane turns it on through this overlay.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { envOverlay, journalVolumeFull, unidentifiedSkinWarning } from '../../src/service/start-live.js'
import { DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_TOTAL_BYTES
} from '../../src/observability/journal.js'

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

// Unit target: envOverlay in src/service/start-live.js, the env-to-config
// mapping a deployed lane reads. The kept connection (#22) is the case that
// matters: its default is off, and a lane turns it on through this overlay.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { envOverlay, unidentifiedSkinWarning } from '../../src/service/start-live.js'
import { loadConfig } from '../../src/service/monoplayer.js'

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

// #108: a config document's reconnect budget must survive the overlay. The
// deployed default stays unlimited, so only an explicit file value, or an
// explicit env value, may set a bound.
// #134: the skin frame names the puppet's own `player_info` entry, so a lane with
// no resolved UUID writes none. The raw cacheDir override is the path that gets
// here, and it is silent otherwise.
test('#134 a lane with no puppet UUID is told its skin frame will not be written', () => {
  const warning = unidentifiedSkinWarning({ skin: { showPuppetSkin: true }, puppet: { uuid: null } })
  assert.match(warning, /no puppet UUID is known/)
  assert.match(warning, /MONOPLAYER_PUPPET_ACCOUNT/, 'the warning names the fix')
})

test('#134 a resolved puppet UUID says nothing, and so does the switch being off', () => {
  assert.equal(unidentifiedSkinWarning({ skin: { showPuppetSkin: true }, puppet: { uuid: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed' } }), null)
  assert.equal(unidentifiedSkinWarning({ skin: { showPuppetSkin: false }, puppet: { uuid: null } }), null)
})

test('#108 a config document\'s reconnect attempts reach loadConfig', () => {
  const out = envOverlay({ reconnect: { attempts: 2, maxDelayMs: 5000 } }, {})
  assert.equal(out.reconnect.attempts, 2)
  assert.equal(out.reconnect.maxDelayMs, 5000)
  const cfg = loadConfig(out)
  assert.equal(cfg.reconnect.attempts, 2)
  assert.equal(cfg.reconnect.maxDelayMs, 5000)
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

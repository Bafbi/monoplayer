// The one home for "is this a UUID Mojang issues" (#703, and #704's interim home while
// that ticket is open). The rule the panel's write route and the dev lane's report both
// need: Mojang issues version 4, and a version-3 uuid is Java's nameUUIDFromBytes over
// `OfflinePlayer:<name>`.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeUuid, uuidRefusal, uuidVersion } from '../../src/custody/util.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'

// A uuid Mojang issued, the value the loopback rig calls Pilot's owner.
const REAL = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
// md5("OfflinePlayer:Pilot") with Java's version-3 nibble, the value the dev lane's
// ConfigMap carried until #677 removed it.
const DERIVED = '62e2a856-7342-3096-b19f-938454443a11'
const V1 = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
const V5 = '886313e1-3b8a-5372-9b90-0c9aee199e5d'
const V7 = '0190d6c3-1f3f-7a0f-9b1a-2b3c4d5e6f70'

test('the version is the thirteenth hex digit, read from either spelling', () => {
  assert.equal(uuidVersion(REAL), 4)
  assert.equal(uuidVersion(REAL.toUpperCase()), 4)
  assert.equal(uuidVersion(REAL.replace(/-/g, '')), 4, 'an undashed uuid carries its version in the same place')
  assert.equal(uuidVersion(DERIVED), 3)
  assert.equal(uuidVersion(V7), 7)
  for (const notAUuid of ['', 'nope', '6eb73524-ff88-4a62-a8d0', null, 42, {}]) {
    assert.equal(uuidVersion(notAUuid), null, JSON.stringify(notAUuid))
  }
})

test('a uuid Mojang issued is admitted, and every version it does not issue is refused', () => {
  assert.equal(uuidRefusal(REAL), null, 'a version-4 uuid is one Mojang issues')
  for (const [uuid, version] of [[DERIVED, 3], [V1, 1], [V5, 5], [V7, 7]]) {
    const refusal = uuidRefusal(uuid)
    assert.ok(refusal, 'refused: ' + uuid)
    assert.match(refusal, new RegExp('version-' + version + ' uuid'))
    assert.match(refusal, /no Mojang session answers for it/)
  }
})

test('the undashed spelling of a derived uuid is refused the same way', () => {
  assert.equal(uuidRefusal(DERIVED.replace(/-/g, '')), uuidRefusal(DERIVED))
  assert.equal(normalizeUuid(DERIVED.replace(/-/g, '')), normalizeUuid(DERIVED),
    'the two spellings are one value, so one rule answers both')
})

test('a name that hashes to its own uuid is refused by the string that was hashed', () => {
  assert.equal(offlineUuid('Pilot'), DERIVED, 'the fixture is what Java derives from the name')
  const refusal = uuidRefusal(DERIVED, 'Pilot')
  assert.match(refusal, /OfflinePlayer:Pilot/, 'the answer names the string, not only the version')
  // The version is refused too, so an entry whose name was edited after it was made is
  // still refused: the two rules are separate and both apply.
  assert.match(uuidRefusal(DERIVED, 'Someone else'), /version-3/)
  // A name is optional, and an empty one is no name at all.
  assert.equal(uuidRefusal(REAL, ''), null)
  assert.equal(uuidRefusal(REAL, 'Bafbi'), null)
})

test('a string that is not a uuid is refused rather than answered as usable', () => {
  for (const notAUuid of ['', 'nope', '6eb73524-ff88-4a62-a8d0', null, undefined, 42]) {
    assert.match(uuidRefusal(notAUuid), /not a uuid/, JSON.stringify(notAUuid))
  }
})

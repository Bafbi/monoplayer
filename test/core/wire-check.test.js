// Strict wire-frame checker: fixture evidence and stats accounting.
//
// The fixture is committed evidence. Its expectations are hand-written from a
// direct probe with minecraft-protocol's serializer + parsePacketBuffer (the
// raw frame sizes and consumed counts), never from the checker under test.
// Regenerate the base64 with the probe if the protocol data changes; keep the
// expected numbers as the independent check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createWireChecker, WIRE_CODES } from '../../src/core/wire-check.js'

const FIXTURE_URL = new URL('../../testdata/wire/cases-26.1.json', import.meta.url)
const RESULT_FIELDS = ['ok', 'code', 'parsedName', 'consumed', 'total', 'leftover']

async function loadFixture () {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8'))
}

function frameFor (testCase) {
  return { state: testCase.state, name: testCase.name, buffer: Buffer.from(testCase.b64, 'base64') }
}

test('fixture declares version 26.1 / protocol 775 and only declared codes', async () => {
  const fixture = await loadFixture()
  assert.equal(fixture.version, '26.1')
  assert.equal(fixture.protocol, 775)
  assert.equal(Object.isFrozen(WIRE_CODES), true)
  const codes = new Set(Object.values(WIRE_CODES))
  assert.equal(fixture.cases.length >= 7, true)
  for (const testCase of fixture.cases) {
    assert.equal(typeof testCase.id, 'string')
    assert.equal(codes.has(testCase.expect.code), true, `${testCase.id}: ${testCase.expect.code}`)
  }
})

test('fixture cases match the probe expectations exactly', async () => {
  const fixture = await loadFixture()
  const checker = createWireChecker({ version: fixture.version })
  for (const testCase of fixture.cases) {
    const result = checker.check(frameFor(testCase))
    assert.equal(Buffer.from(testCase.b64, 'base64').length, testCase.expect.total, `${testCase.id}: frame size`)
    for (const field of RESULT_FIELDS) {
      if (field in testCase.expect) {
        assert.equal(result[field], testCase.expect[field], `${testCase.id}: ${field}`)
      }
    }
  }
})

test('stats count each outcome and a second checker has independent state', async () => {
  const fixture = await loadFixture()
  const byId = new Map(fixture.cases.map((testCase) => [testCase.id, testCase]))
  const checker = createWireChecker({ version: fixture.version })
  const check = (id) => checker.check(frameFor(byId.get(id)))

  assert.deepEqual(checker.stats, {
    checked: 0, failures: 0, tooLarge: 0, unsupportedState: 0, leftover: 0, nameMismatch: 0, parseErrors: 0
  })

  check('valid-play-login')
  assert.equal(checker.stats.checked, 1)
  assert.equal(checker.stats.failures, 0)

  check('play-login-plus-114-bytes')
  assert.equal(checker.stats.failures, 1)
  assert.equal(checker.stats.leftover, 1)

  check('play-login-labeled-position')
  assert.equal(checker.stats.failures, 2)
  assert.equal(checker.stats.nameMismatch, 1)

  check('truncated-play-login')
  assert.equal(checker.stats.failures, 3)
  assert.equal(checker.stats.parseErrors, 1)

  check('login-frame-as-login')
  assert.equal(checker.stats.failures, 4)
  assert.equal(checker.stats.unsupportedState, 1)

  checker.check({ state: 'play', name: 'login', buffer: 'not a buffer' })
  assert.equal(checker.stats.failures, 5)

  const tiny = createWireChecker({ version: fixture.version, maxFrameBytes: 112 })
  const tooLarge = tiny.check(frameFor(byId.get('valid-play-login')))
  assert.equal(tooLarge.code, WIRE_CODES.TOO_LARGE)
  assert.equal(tiny.stats.tooLarge, 1)
  assert.equal(tiny.stats.failures, 1)

  // A second checker must not inherit or share the first one's counters.
  const other = createWireChecker({ version: fixture.version })
  assert.deepEqual(other.stats, {
    checked: 0, failures: 0, tooLarge: 0, unsupportedState: 0, leftover: 0, nameMismatch: 0, parseErrors: 0
  })
  assert.equal(other.check(frameFor(byId.get('valid-config-finish'))).ok, true)
  assert.equal(other.stats.checked, 1)
  assert.equal(other.stats.failures, 0)
  assert.equal(checker.stats.checked, 6)
  assert.equal(checker.stats.failures, 5)
})

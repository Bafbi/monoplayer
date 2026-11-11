// The status claims this repo makes about its own work (#120). A page that
// calls a shipped capability unbuilt sends a reader to work that already
// merged, and src/driver/scenario.js writes its limitation list into every new
// report, so a stale string there reaches evidence as well as readers.
//
// Nothing here reaches a network or a cluster: every case reads a file, or
// calls the start guard, which returns before it opens a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIMITATIONS } from '../../src/driver/scenario.js'
import { startLive } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PRODUCT_CORE = read('docs/product-core.md')
const TRANSPARENCY = read('docs/transparency.md')
const TESTBED = read('docs/testbed-transfer.md')
const DRIVER_LANE = read('docs/driver-lane.md')
const README = read('README.md')

// A claim is read where it applies. A bullet is one claim, and a blank-line
// block is one claim in prose, so a stale sentence cannot hide behind a true
// one on the next line.
const bullets = text => text.split(/(?=^- )/m).filter(block => block.startsWith('- '))

function claims (text, needle) {
  const found = bullets(text).filter(block => block.includes(needle))
  assert.ok(found.length > 0, 'the page still has a claim that names ' + needle)
  return found
}

test('the driver report does not call the unmodded witness pending', () => {
  const pending = LIMITATIONS.filter(line => /still[- ]pending/i.test(line))
  assert.deepEqual(pending, [], 'the emitted limitations still call the witness pending: ' + pending.join(' | '))
  const stale = LIMITATIONS.filter(line => /anti-masking evidence yet/i.test(line))
  assert.deepEqual(stale, [], 'the emitted limitations still end on "no anti-masking evidence yet": ' + stale.join(' | '))
  assert.ok(
    LIMITATIONS.some(line => line.includes('unmodded')),
    'the emitted limitations still name the unmodded witness, and test/driver/scenario.test.js pins that word'
  )
})

test('docs/driver-lane.md does not call the unmodded witness pending', () => {
  const pending = claims(DRIVER_LANE, 'unmodded').filter(block => /pending/i.test(block))
  assert.deepEqual(pending, [], 'the runbook still calls the witness pending: ' + pending.join(' | '))
})

test('docs/transparency.md does not call #62 unbuilt, or still to be confirmed', () => {
  for (const claim of claims(TRANSPARENCY, '#62')) {
    assert.doesNotMatch(claim, /not built/i, '#62 shipped, so no claim may call it not built: ' + claim)
    assert.doesNotMatch(claim, /confirms it/i, '#62 is closed, so no claim may send a reader there for confirmation: ' + claim)
  }
})

test('docs/testbed-transfer.md does not call the clientbound comparison unwritten', () => {
  for (const claim of claims(TESTBED, 'parity')) {
    assert.doesNotMatch(claim, /not built|not written/i, 'both comparisons run, so no claim may call one unwritten: ' + claim)
  }
})

test('README names no row from the historical driver plan', () => {
  assert.doesNotMatch(
    README,
    /next are B\d/,
    'the B rows live in the bannered docs/driver-lane-plan.md; name what the current runbooks leave open'
  )
})

test('docs/product-core.md describes --start as the Service and its guard', () => {
  assert.match(
    PRODUCT_CORE,
    /`--start` runs the Service/,
    'the deployed service starts with --start (Dockerfile CMD), so the page says what it is'
  )
  const para = PRODUCT_CORE.split(/\n\s*\n/).filter(block => block.includes('`--start` runs the Service'))
  assert.equal(para.length, 1, 'one paragraph says what --start is')
  assert.match(para[0], /MONOPLAYER_BACKEND_HOST/, 'the guard the page describes is the one src/service/start-live.js implements')
  assert.match(para[0], /--config/, 'the guard also accepts a config document, and the page says so')
  assert.doesNotMatch(PRODUCT_CORE, /explicitly refuses/, 'the page no longer calls --start a refusal')
  assert.doesNotMatch(PRODUCT_CORE, /refuse[s]? .?`--start`/, 'the page no longer lists --start as something to refuse')
})

test('the guard docs/product-core.md describes is the one startLive implements', async () => {
  const previous = process.env.MONOPLAYER_BACKEND_HOST
  delete process.env.MONOPLAYER_BACKEND_HOST
  let stderr = ''
  let code
  try {
    code = await startLive({
      argv: ['--start'],
      io: { stdout: { write () {} }, stderr: { write (chunk) { stderr += chunk } } }
    })
  } finally {
    if (previous !== undefined) process.env.MONOPLAYER_BACKEND_HOST = previous
  }
  assert.equal(code, 2, 'a default invocation exits 2')
  assert.match(stderr, /refusing the default config/, 'and refuses with the message the page quotes')
  assert.match(PRODUCT_CORE, /refusing the default config/, 'the page quotes that message')
})

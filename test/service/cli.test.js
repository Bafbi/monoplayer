// The plumbing every rung CLI shares: read a flag, format a detail, list the
// account candidates a selector matched, and bound a promise with a deadline.
//
// These four helpers were copied into eight files and drifted (#104). One home,
// one contract: a rung that writes its report with them writes the same shape as
// every other rung.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { candidateLines, detail, flag, waitFor, withTimeout } from '../../src/service/cli.js'

test('flag reads the value that follows its name', () => {
  assert.equal(flag(['--report', 'out.json', '--verbose'], '--report'), 'out.json')
  assert.equal(flag(['--verbose'], '--verbose'), undefined, 'a bare flag has no value')
  assert.equal(flag([], '--report'), undefined)
})

test('flag reads the first match when a name repeats', () => {
  assert.equal(flag(['--report', 'a.json', '--report', 'b.json'], '--report'), 'a.json')
})

test('detail is compact JSON, so a report line is one line', () => {
  assert.equal(detail({ a: 1, b: 'x' }), '{"a":1,"b":"x"}')
  assert.equal(detail([]), '[]')
})

test('detail writes a bigint as its digits, which JSON cannot', () => {
  assert.equal(detail({ entityId: 42n }), '{"entityId":"42"}')
})

test('detail of an undefined value is an empty string, not the word undefined', () => {
  assert.equal(detail(undefined), '', 'a caller that passes no detail appends nothing')
})

test('detail falls back to String when JSON has no answer', () => {
  const json = JSON.stringify(undefined)
  assert.equal(json, undefined, 'the fallback exists because JSON.stringify returns undefined')
  assert.equal(detail(() => {}).startsWith('() =>'), true)
})

test('candidateLines names the fields a selector matched, or says none', () => {
  assert.equal(candidateLines(), '  candidates: (none)')
  assert.equal(candidateLines([]), '  candidates: (none)')
  assert.equal(
    candidateLines([{ uuid: 'u-1', name: 'GlowSquidye', alias: 'puppet', dir: '/a' }]),
    '  uuid=u-1 name=GlowSquidye alias=puppet dir=/a'
  )
})

test('candidateLines marks a missing name and a missing alias', () => {
  assert.equal(
    candidateLines([{ uuid: 'u-1', dir: '/a' }]),
    '  uuid=u-1 name=? alias=- dir=/a'
  )
})

test('candidateLines puts one candidate on each line', () => {
  const lines = candidateLines([{ uuid: 'u-1', dir: '/a' }, { uuid: 'u-2', dir: '/b' }])
  assert.equal(lines.split('\n').length, 2)
})

test('withTimeout resolves with the value when the promise settles first', async () => {
  assert.equal(await withTimeout(Promise.resolve('done'), 1000, 'resolve'), 'done')
})

test('withTimeout passes a rejection through unchanged', async () => {
  const failure = new Error('backend refused')
  await assert.rejects(withTimeout(Promise.reject(failure), 1000, 'reject'), error => {
    assert.equal(error, failure, 'the caller sees the error it would have seen without the deadline')
    return true
  })
})

test('withTimeout rejects with the label and the budget when the deadline wins', async () => {
  const never = new Promise(() => {})
  await assert.rejects(withTimeout(never, 20, 'backend_leg_connect'), {
    message: 'backend_leg_connect timed out after 20 ms'
  })
})

test('withTimeout arms a timer that does not hold the process open', async () => {
  // The drift #104 folded: one copy omitted the unref, so a pending deadline
  // kept a lane's process alive after every other handle had gone.
  const real = globalThis.setTimeout
  let armed = null
  globalThis.setTimeout = (fn, ms, ...rest) => {
    armed = real(fn, ms, ...rest)
    return armed
  }
  try {
    await withTimeout(Promise.resolve(1), 60_000, 'unref')
  } finally {
    globalThis.setTimeout = real
  }
  assert.ok(armed, 'a deadline timer was armed')
  assert.equal(armed.hasRef(), false, 'and it does not keep the event loop alive')
  real(() => {}, 0)
})

test('waitFor resolves at once when the predicate already holds', async () => {
  await waitFor(() => true, 'already there')
})

test('waitFor polls until the predicate holds', async () => {
  let calls = 0
  await waitFor(() => ++calls >= 3, 'the third poll')
  assert.equal(calls, 3)
})

test('waitFor treats a throwing predicate as not ready, and keeps waiting', async () => {
  let calls = 0
  await waitFor(() => {
    calls++
    if (calls < 3) throw new Error('the leg is still closing')
    return true
  }, 'a predicate that settles down')
  assert.equal(calls, 3, 'the throw is a wait, never a rejection')
})

test('waitFor rejects with the label and the budget when the deadline passes', async () => {
  await assert.rejects(waitFor(() => false, 'the dialog held', 20), {
    message: 'timed out after 20 ms waiting for the dialog held'
  })
})

// M4 slice: backend log parsing. Pure text in, pure counts out — the canned
// log text below mirrors real kubectl logs shapes from the G0 Paper backend
// (timestamps are in the Paper console format; the 2026- prefix variant is the
// multi-node log format).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBackendLogins, loginsPerPhase } from '../src/gate-b/logins.js'

const G0_STYLE = [
  '[12:00:00 INFO]: Starting minecraft server version 26.1.2',
  '[12:00:04 INFO]: Done (12.345s)! For help, type "help"',
  '[12:04:12 INFO]: GlowSquidye[/10.42.0.5:54321] logged in with entity id 1 at ([world] 0.5, -60.0, 0.5)',
  '[12:04:12 INFO]: GlowSquidye joined the game',
  '[12:05:02 INFO]: GlowSquidye left the game',
]

const TIMESTAMPED_STYLE = [
  '2026-11-06 12:04:12 [12:04:12 INFO]: GlowSquidye[/10.42.0.5:54321] logged in with entity id 1 at ([world] 0.5, -60.0, 0.5)',
  '2026-11-06 12:04:12 [12:04:12 INFO]: GlowSquidye joined the game',
]

test('a join produces exactly one login and one join line with names', () => {
  const { events } = parseBackendLogins(G0_STYLE.join('\n'))
  assert.equal(events.filter(e => e.kind === 'login').length, 1)
  assert.equal(events.filter(e => e.kind === 'joined').length, 1)
  assert.equal(events.filter(e => e.kind === 'left').length, 1)
  const login = events.find(e => e.kind === 'login')
  assert.equal(login.name, 'GlowSquidye')
  assert.equal(events.find(e => e.kind === 'joined').name, 'GlowSquidye')
  assert.equal(events.find(e => e.kind === 'left').name, 'GlowSquidye')
})

test('timestamped line prefixes do not break name extraction', () => {
  const { events } = parseBackendLogins(TIMESTAMPED_STYLE)
  const login = events.find(e => e.kind === 'login')
  assert.equal(login.name, 'GlowSquidye')
  assert.equal(events.find(e => e.kind === 'joined').name, 'GlowSquidye')
})

test('counts stay honest across a rejoin cycle', () => {
  const text = [
    ...G0_STYLE,
    '[12:26:20 INFO]: GlowSquidye[/10.42.0.5:54444] logged in with entity id 1 at ([world] 0.5, -60.0, 0.5)',
    '[12:26:20 INFO]: GlowSquidye joined the game',
  ].join('\n')
  const { events } = parseBackendLogins(text)
  assert.equal(events.filter(e => e.kind === 'login').length, 2,
    'two backend logins is exactly the duplicate-login anomaly on a no-fault lane')
})

test('players filter keeps unknown names out of the tracked events', () => {
  const text = G0_STYLE.join('\n') + '\n[12:06:00 INFO]: Bafbi[/10.42.0.9:6000] logged in with entity id 2 at ([world] 3.0, -60.0, 3.0)'
  const { events } = parseBackendLogins(text, { players: ['GlowSquidye'] })
  assert.ok(events.every(e => e.name === 'GlowSquidye'))
  const unfiltered = parseBackendLogins(text)
  assert.equal(unfiltered.events.filter(e => e.kind === 'login').length, 2)
})

test('marshalled component lines still count, with the name recovered when plain', () => {
  const { events } = parseBackendLogins('[12:04:12 INFO]: {"text":"GlowSquidye joined the game"}')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'joined')
  assert.equal(events[0].name, 'GlowSquidye')
})

test('nameless announcements and command lines are never join evidence', () => {
  const text = [
    '[12:00:00 INFO]: joined the game',
    '[12:00:00 INFO]: ShangriLa joined the gamer clan',
    '[12:00:00 INFO]: setblock 0 -60 0 stone',
    '',
  ].join('\n')
  const { events } = parseBackendLogins(text)
  assert.equal(events.length, 0)
})

test('a login line always counts even when the name cannot be extracted', () => {
  const { events } = parseBackendLogins('[12:04:12 INFO]: logged in with entity id 1')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'login')
  assert.equal(events[0].name, null)
})

test('loginsPerPhase slices the same log into inclusive per-phase counts', () => {
  const text = [
    ...G0_STYLE, // lines 0..4: login+join at 2, left at 4
    '[12:09:00 INFO]: GlowSquidye[/10.42.0.5:55000] logged in with entity id 1 at ([world] 5.0, -60.0, 5.0)', // 5
    '[12:09:00 INFO]: GlowSquidye joined the game', // 6
    '[12:15:00 INFO]: GlowSquidye left the game', // 7
  ].join('\n')
  const result = loginsPerPhase(text, [
    { id: 'setup-join', from: 0, to: 3 },
    { id: 'detach-tail', from: 4, to: 4 },
    { id: 'reattach', from: 5, to: 7 },
    { id: 'whole-run' },
  ], { players: ['GlowSquidye'] })
  const byId = Object.fromEntries(result.phases.map(phase => [phase.id, phase]))
  assert.deepEqual(byId['setup-join'], { id: 'setup-join', logins: 1, joins: 1, leaves: 0 })
  assert.deepEqual(byId['detach-tail'], { id: 'detach-tail', logins: 0, joins: 0, leaves: 1 })
  assert.deepEqual(byId['reattach'], { id: 'reattach', logins: 1, joins: 1, leaves: 1 })
  assert.deepEqual(byId['whole-run'], { id: 'whole-run', logins: 2, joins: 2, leaves: 2 })
  assert.equal(result.phases.length, 4)
})

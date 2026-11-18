// The page's shape: the live region, the actions outside it, and the assets it
// loads (#248).
//
// The three assertions that carry the weight here are structural, not cosmetic:
//
//   1. the live region is the element the stream replaces, and the forms are not
//      inside it, so a tick cannot overwrite a half-typed host;
//   2. the write is a JSON write, and the page says so where an implementor reads
//      it, because the route refuses anything else;
//   3. a write the page cannot make is rendered as a refusal that names why, never
//      as a form that posts nowhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activity } from '../../src/panel/activity.js'
import { renderCard } from '../../src/panel/views/card.js'
import { renderLive } from '../../src/panel/views/live.js'
import { renderPage } from '../../src/panel/views/page.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: true
}

const HEARTBEAT_AT = '2026-11-18T10:37:12.906Z'
const NOW = Date.parse(HEARTBEAT_AT) + 12_000

const heartbeat = {
  t: HEARTBEAT_AT,
  event: 'heartbeat',
  attached: false,
  warm: true,
  backendLogins: 1,
  front: { allowed: 1 },
  journal: { enabled: true, sealed: 3 },
  wire: { checked: 0, rejected: 0 },
  telemetry: { enabled: true, logs: { queued: 0 }, metrics: { queued: 0 } },
  account: { alias: 'GlowSquidye', expiresAt: null }
}

const pod = {
  metadata: { name: 'monoplayer-84855d7f8b-5h5bd', creationTimestamp: '2026-11-18T09:00:00.000Z' },
  status: {
    phase: 'Running',
    startTime: '2026-11-18T09:00:00.000Z',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ restartCount: 0 }]
  }
}

const facts = (overrides = {}) => activity({
  puppet,
  pod,
  log: { text: JSON.stringify(heartbeat) + '\n' },
  now: NOW,
  ...overrides
})

test('the live region is the element the stream swaps, and no form is inside it', () => {
  const live = renderLive(facts())
  assert.doesNotMatch(live, /<form/i, 'a form inside the swapped region loses what the operator typed')
  assert.doesNotMatch(live, /<article|<html/i, 'the fragment is the card body, not a card')

  const card = renderCard(puppet, facts())
  assert.match(card, /<div class="live" hx-ext="sse"/)
  assert.match(card, /sse-connect="\/api\/puppets\/glowsquidye\/stream"/)
  assert.match(card, /sse-swap="message"/)
  // The actions come after the live region closes, in the document's own order.
  const liveEnd = card.indexOf('</div>', card.indexOf('<div class="live"'))
  assert.ok(liveEnd > 0)
  assert.ok(card.indexOf('<section class="actions">') > liveEnd, 'the actions sit outside the live region')
  assert.match(card, /<form class="write" method="post" action="\/api\/puppets\/glowsquidye\/backend"/)
  assert.match(card, /data-write="backend"/)
  // The write is JSON, and the route demands it: the page says which content type
  // it sends so an implementor does not reach for a form-encoded post.
  assert.match(card, /application\/json|panel\.js|sends exactly what the route demands/)
})

test('a puppet the registry refuses renders the refusal, and no move form', () => {
  const refused = { ...puppet, allowBackendSwitch: false }
  const card = renderCard(refused, facts())
  assert.doesNotMatch(card, /data-write="backend"/, 'no move form when the registry refuses the move')
  assert.match(card, /move: refused by the registry/)
  assert.match(card, /allowBackendSwitch: false/)
  assert.match(card, /control\.allowBackendSwitch/, 'the second fence is named too')
  // The whitelist is a different fence and stays: the registry's switch is about the
  // move, and a lane that refuses to be repointed can still admit a player.
  assert.match(card, /data-write="add"/)
})

const attachList = {
  observedAt: '2026-11-18T10:37:24.906Z',
  resourceVersion: '41221',
  document: {
    version: 1,
    players: [
      { uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi', addedAt: '2026-11-17T09:12:00.000Z' },
      { uuid: '424ac88b-7531-3224-8934-922380568a46', name: null, addedAt: null }
    ]
  }
}

test('the whitelist block renders the entries, their added time, and the two writes', () => {
  const card = renderCard(puppet, facts(), attachList)
  assert.match(card, /Who may attach/)
  // The entries, with the uuid the removal addresses and the added-at the document
  // recorded. A missing name and a missing addedAt say so instead of printing nothing.
  assert.match(card, /6eb73524-ff88-4a62-a8d0-c63905e7afba/)
  assert.match(card, /Bafbi/)
  assert.match(card, /added 2026-11-17T09:12:00\.000Z/)
  assert.match(card, /added no added-at recorded/)
  assert.match(card, /no name recorded/)
  // The read instant and the ConfigMap's version, in the card's footer, and the version
  // is called a version. Not in the list: the list is redrawn on change, so a clock
  // printed there would be the time of the last change.
  assert.match(card, /and the attach whitelist read at 2026-11-18T10:37:24\.906Z at ConfigMap resourceVersion 41221 \(a version, not a time\)/)
  assert.doesNotMatch(card, /<div class="attach"[^>]*>[^<]*<p class="note">read at/, 'the list carries no clock')
  // The add form, JSON, and a removal that names its uuid in the path the route takes.
  assert.match(card, /<form class="write" method="post" data-write="add" action="\/api\/puppets\/glowsquidye\/whitelist">/)
  assert.match(card, /add to the attach whitelist/, 'the glossary names it, and the button uses the name')
  // One answer area for the block, outside the list the tick replaces.
  assert.match(card, /<output class="result block-result"/)
  const rows = [...card.matchAll(/<li class="entry">([\s\S]*?)<\/li>/g)].map(match => match[1])
  assert.equal(rows.length, 2, 'one row per entry')
  for (const row of rows) assert.doesNotMatch(row, /<output/, 'no answer is printed inside a row')
  // The uuid is the key the page holds its armed confirmation under, so a tick that
  // replaces the button can paint it back, and the name is what the confirmation reads.
  assert.match(card, /data-write="remove" data-uuid="6eb73524-ff88-4a62-a8d0-c63905e7afba" data-who="Bafbi" action="\/api\/puppets\/glowsquidye\/whitelist\/6eb73524-ff88-4a62-a8d0-c63905e7afba"/,
    'the confirm step names the entry it would remove, by the key the page holds it under')
  assert.match(card, /data-armed="false"/, 'a removal starts unarmed')
})

test('the whitelist block tells an empty list apart from a list it could not read', () => {
  const empty = renderCard(puppet, facts(), { observedAt: '2026-11-18T10:37:24.906Z', resourceVersion: '7', document: { version: 1, players: [] } })
  assert.match(empty, /no entries: only the puppet's own account may attach/)

  const failed = renderCard(puppet, facts(), { observedAt: '2026-11-18T10:37:24.906Z', failure: 'read ConfigMap monoplayer/monoplayer-control: the API server answered 403 Forbidden' })
  assert.match(failed, /the attach whitelist could not be read: read ConfigMap/)
  assert.doesNotMatch(failed, /no entries/, 'a read that failed is never drawn as an empty allow-list')

  const unread = renderCard(puppet, facts())
  assert.match(unread, /the panel did not read the attach whitelist for this page/)
})

test('the scene is decoration: no number, no word, nothing a colour would have to say', () => {
  const live = renderLive(facts())
  const stage = live.slice(live.indexOf('<div class="stage"'), live.indexOf('<p class="state-line"'))
  assert.match(stage, /class="cube cube--puppet cube--grass"/, 'a serving puppet has a grass top face')
  assert.match(stage, /aria-hidden="true"/, 'the scene is hidden from a screen reader')
  assert.doesNotMatch(stage, /[0-9]/, 'the scene carries no number without a record behind it')
  assert.doesNotMatch(stage, /<p>|<span>[A-Za-z]/, 'the scene carries no caption to go stale')
  // The tone is the state, and a stale puppet is not the live colour.
  const stale = renderLive(facts({ now: Date.parse(HEARTBEAT_AT) + 10 * 60_000 }))
  assert.match(stale, /cube--puppet cube--sand/)
})

test('every asset the page names is one the panel serves', () => {
  const page = renderPage({ version: 1, puppets: [puppet] }, [facts()])
  const urls = [...page.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(urls, [
    '/static/app.css',
    '/static/vendor/htmx.min.js',
    '/static/vendor/htmx-ext-sse.min.js',
    '/static/panel.js'
  ])
  // No CDN, no Google font, no icon set: a tailnet control plane must not fetch
  // its assets from the public internet.
  for (const url of urls) assert.match(url, /^\/static\//)
  assert.doesNotMatch(page, /https?:\/\//, 'nothing in the page is an absolute URL')
})

test('the page escapes the name it puts in a URL', () => {
  const hostile = { ...puppet, name: 'a"b<x>' }
  const card = renderCard(hostile, facts({ puppet: hostile }))
  assert.match(card, /sse-connect="\/api\/puppets\/a%22b%3Cx%3E\/stream"/)
  assert.doesNotMatch(card, /<x>/)
})

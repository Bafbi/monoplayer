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
import { targetOf } from '../../src/panel/routes/allowed.js'

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
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
  // #264: the backend move is retired, so the card offers the whitelist writes and
  // nothing that names another server. The move's form, its route and its client
  // handler all went; an action that came back is an action the panel cannot keep.
  assert.doesNotMatch(card, /data-write="backend"/)
  assert.doesNotMatch(card, /move the puppet/)
  assert.doesNotMatch(card, /<h3>Move it<\/h3>/)
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
  assert.match(card, /data-write="remove" data-key="6eb73524-ff88-4a62-a8d0-c63905e7afba" data-name="Bafbi" action="\/api\/puppets\/glowsquidye\/whitelist\/6eb73524-ff88-4a62-a8d0-c63905e7afba"/,
    'the confirm step names the entry it would remove, by the key the page holds it under')
  assert.match(card, /data-armed="false"/, 'a removal starts unarmed')
})

// #705: the block says who may attach. A list of two entries where one is a uuid no
// Mojang session can answer for reads as healthy unless the block says so, and that is
// the state #677 found in the dev lane's own document: three entries, one human. The
// ratio is the sentence `mise run dev:status` settled, so an operator reads one
// vocabulary in both places, and the reason is the one src/custody/util.js wrote.
const V4 = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const DERIVED = '62e2a856-7342-3096-b19f-938454443a11'
const listOf = players => ({
  observedAt: '2026-11-18T10:37:24.906Z',
  resourceVersion: '41221',
  document: { version: 1, players }
})

test('the whitelist block says which entries a login can use, and which it cannot', () => {
  const healthy = renderCard(puppet, facts(), listOf([
    { uuid: V4, name: 'Bafbi', addedAt: '2026-11-17T09:12:00.000Z' }
  ]))
  assert.match(healthy, /<span class="uuid-decision">can authenticate<\/span>/,
    'an entry a session can answer for says so, and carries no fault class')
  assert.doesNotMatch(healthy, /cannot authenticate/, 'and a usable entry is never marked unusable')
  assert.doesNotMatch(healthy, /attach whitelist names/, 'a lane where every entry can authenticate carries no warning')

  const mixed = renderCard(puppet, facts(), listOf([
    { uuid: V4, name: 'Bafbi', addedAt: '2026-11-17T09:12:00.000Z' },
    { uuid: DERIVED, name: 'Pilot', addedAt: null }
  ]))
  assert.match(mixed, /attach whitelist names 2 entries, 1 of which can authenticate/,
    'a lane with one unusable entry does not read as healthy')
  assert.match(mixed, /<span class="uuid-decision unusable">cannot authenticate: its uuid is md5\(&quot;OfflinePlayer:Pilot&quot;\), so no Mojang session answers for it<\/span>/,
    'the reason is the sentence the one home wrote, in the class the stylesheet draws a fault with')
  assert.match(mixed, /can authenticate/, 'the usable entry is still named as one')

  const none = renderCard(puppet, facts(), listOf([
    { uuid: DERIVED, name: 'Pilot', addedAt: null },
    { uuid: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', name: 'Watcher', addedAt: null }
  ]))
  assert.match(none, /attach whitelist names 2 entries, and none of them can authenticate/)

  // One entry is the case the plural sentence reads wrong for, so it says "it".
  const alone = renderCard(puppet, facts(), listOf([{ uuid: DERIVED, name: 'Pilot', addedAt: null }]))
  assert.match(alone, /attach whitelist names 1 entry, and it cannot authenticate/)
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

// The allowed-server list: the same block idiom, over the other control key (#309).
// The route names a server by its `host:port` address, so the row, the removal's path
// and the add field all use that one name.
const allowedList = {
  observedAt: '2026-11-18T10:37:24.906Z',
  resourceVersion: '41222',
  source: 'control',
  document: {
    version: 1,
    servers: [
      { host: 'paper.example.net', port: 25565, addedAt: '2026-11-23T12:00:00.000Z' },
      { host: 'sky.example.net', port: 25566, addedAt: null }
    ]
  }
}

test('the allowed servers render beside the attach whitelist, with the two writes', () => {
  const card = renderCard(puppet, facts(), attachList, allowedList)
  assert.match(card, /<h3>Allowed servers<\/h3>/)
  // The address, which is the name the route uses for a server and the path its
  // removal takes. A missing addedAt says so instead of printing nothing.
  assert.match(card, /paper\.example\.net:25565/)
  assert.match(card, /added 2026-11-23T12:00:00\.000Z/)
  assert.match(card, /added no added-at recorded/)
  // The read instant and the ConfigMap's version in the card's footer, called a
  // version: the list itself carries no clock, because a tick redraws it on change.
  assert.match(card, /and the allowed servers read at 2026-11-18T10:37:24\.906Z at ConfigMap resourceVersion 41222 \(a version, not a time\)/)
  // One field, because the route names a server by host:port and a phone operator
  // pastes one thing. The page splits it into the route's two fields.
  assert.match(card, /<form class="write" method="post" data-write="add-server" action="\/api\/puppets\/glowsquidye\/allowed-servers">/)
  assert.match(card, /<input name="server"/)
  assert.doesNotMatch(card, /name="port"/, 'the route takes two fields, and the page asks for one name')
  assert.match(card, /add an allowed server/, 'the glossary names it, and the button uses the name')
  // One answer area for the block, outside the list the tick replaces, and no clock inside
  // the block: the read instant and the version are in the card's footer, which is
  // rewritten every tick, and a clock in a list redrawn on change would be the time of the
  // last change.
  const block = card.slice(card.indexOf('<section class="allowed-block'), card.indexOf('</section>', card.indexOf('<section class="allowed-block')))
  assert.equal([...block.matchAll(/<output/g)].length, 1, 'one answer area for the block')
  assert.doesNotMatch(block, /2026-11-18T10:37:24\.906Z/, 'the list carries no clock')
  const rows = [...block.matchAll(/<li class="entry">([\s\S]*?)<\/li>/g)].map(match => match[1])
  assert.equal(rows.length, 2, 'one row per server')
  for (const row of rows) assert.doesNotMatch(row, /<output/, 'no answer is printed inside a row')
  // The removal names the address in the path the route takes, and the address is the
  // key the page holds its armed confirmation under, because a tick replaces the button.
  assert.match(card, /data-write="remove-server" data-key="paper\.example\.net:25565" data-name="paper\.example\.net:25565" action="\/api\/puppets\/glowsquidye\/allowed-servers\/paper\.example\.net%3A25565"/)
  assert.match(card, /data-armed="false"/, 'a removal starts unarmed')
  // Beside the whitelist block, after the live region closes: a tick must not reach
  // either form.
  const liveEnd = card.indexOf('</div>', card.indexOf('<div class="live"'))
  assert.ok(card.indexOf('<section class="allowed-block') > liveEnd, 'the block sits outside the live region')
  assert.ok(card.indexOf('<section class="allowed-block') > card.indexOf('<section class="attach-block'),
    'the allowed servers sit beside the attach whitelist')
})

// #890: the row's address is the removal's path, so a row printed unbracketed is a row whose
// removal the route refuses. An IPv4 host has one colon and splits either way, which is why
// this survived three passes over #815; an IPv6 host has several.
test('an IPv6 allowed server prints the address its own removal takes', () => {
  const ipv6 = { host: '2001:db8::1', port: 25565 }
  const written = '[2001:db8::1]:25565'
  const card = renderCard(puppet, facts(), attachList, {
    observedAt: '2026-11-18T10:37:24.906Z',
    resourceVersion: '41222',
    source: 'control',
    document: { version: 1, servers: [{ host: ipv6.host, port: ipv6.port, addedAt: null }] }
  })
  assert.match(card, /<span class="server">\[2001:db8::1\]:25565<\/span>/,
    'the row prints the bracketed address, which is the one the picker writes')

  const row = /data-write="remove-server" data-key="([^"]+)" data-name="([^"]+)" action="([^"]+)"/.exec(card)
  assert.ok(row, 'the removal is in the row')
  assert.equal(row[1], written, 'the armed confirmation is keyed by the printed address')
  assert.equal(row[2], written, 'and reads it back to the operator')
  const path = decodeURIComponent(row[3].slice(row[3].lastIndexOf('/') + 1))
  assert.equal(path, written, 'the removal path is the printed address')
  assert.deepEqual(targetOf(path), { target: ipv6 },
    'and the route reads the address the page printed back as the server it names')
})

test('the allowed servers tell an empty list, an unread one, and the committed copy apart', () => {
  const empty = renderCard(puppet, facts(), attachList, {
    observedAt: '2026-11-18T10:37:24.906Z', resourceVersion: '7', source: 'control', document: { version: 1, servers: [] }
  })
  assert.match(empty, /no allowed servers: the picker offers a joining player nothing/)

  // The live key is absent, so the lane offers the copy Git commits. That is a fact
  // about which file answered, and an operator editing the list has to see it: the
  // first write is built on that copy.
  const seed = renderCard(puppet, facts(), attachList, {
    observedAt: '2026-11-18T10:37:24.906Z', resourceVersion: '7', source: 'seed', document: allowedList.document
  })
  assert.match(seed, /<code>monoplayer-config<\/code>/, 'the seed ConfigMap is named')
  assert.match(seed, /Git commits/)

  const failed = renderCard(puppet, facts(), attachList, {
    observedAt: '2026-11-18T10:37:24.906Z', failure: 'read ConfigMap monoplayer/monoplayer-control: the API server answered 403 Forbidden'
  })
  assert.match(failed, /the allowed servers could not be read: read ConfigMap/)
  assert.doesNotMatch(failed, /no allowed servers/, 'a read that failed is never drawn as an empty list')

  const unread = renderCard(puppet, facts(), attachList)
  assert.match(unread, /the panel did not read the allowed servers for this page/)
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

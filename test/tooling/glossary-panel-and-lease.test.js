// #244, #300: two glossary entries, pinned to the code that owns their facts.
//
// Neither fact had a home outside prose, so both entries drifted:
//
//   #244  the Panel entry described the panel before the activity view (#231) and
//         before the live region (#248): one JSON route, and a page that lists the
//         targets a puppet may be sent to. The page has served one card per puppet
//         since, and a stream that rewrites each card's live region every 5 s.
//   #300  the account lease (#280) had no entry at all, and "lease" was listed under
//         Claim as a word to avoid, so a reader who grepped the glossary for it found
//         a ban and no definition of the object a run takes.
//
// Four facts have a home in code, and this guard reads all four:
//
//   the panel's routes   createPanelHandler in src/panel/server.js, driven here
//   the lease's name     the defaults at the top of scripts/online-cluster.sh
//   the entry's shape    GLOSSARY.md's own entries: a heading, one line, _Avoid_
//   the word "card"      src/panel/views/card.js, the module that renders one
//
// What is compared is names, and one word read out of a sentence: "card". No other
// part of a sentence is parsed, because a guard that read English would be a guard
// that lies about what it checked. What the panel shows, and when, is driven through
// the routes by test/panel/, and the runbook is docs/panel.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPanelHandler } from '../../src/panel/server.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const GLOSSARY = read('GLOSSARY.md')
const ONLINE = read('scripts/online-cluster.sh')

// The puppet the page is built for, and the one name the registry answers. A path in
// the entry carries <name> where a real request carries a puppet's.
const PUPPET = 'glowsquidye'

// What a cluster with no pod answers: the registry facts are on the page, and the
// card says why there are no others. The lease and the panel entries are about the
// surface, not about the facts a card shows, which test/panel/info.test.js drives.
const kubernetes = {
  deployment: async () => ({ spec: { selector: { matchLabels: { app: 'monoplayer' } } } }),
  pods: async () => ({ items: [] }),
  podLog: async () => ''
}

const registry = () => ({
  version: 1,
  puppets: [{
    name: PUPPET,
    namespace: 'monoplayer',
    deployment: 'monoplayer',
    controlConfigMap: 'monoplayer-control',
    seedConfigMap: 'monoplayer-config',
    frontHostname: 'glowsquidye.tail41e568.ts.net',
    backend: 'play2.excalia.fr:25565'
  }]
})

async function panel () {
  const server = http.createServer(createPanelHandler({ registry, kubernetes }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

// The answer for one route the entry names. A stream never ends, so its answer is its
// head: the status and the content type, read before the client hangs up. A write
// route refuses the request body this sends, and refuses it after answering the
// method, which is the fact the guard is after.
async function answer (url, request, method = 'GET') {
  const controller = new AbortController()
  try {
    const response = await fetch(url + request, { method, signal: controller.signal })
    return { status: response.status, type: response.headers.get('content-type') ?? '' }
  } finally {
    controller.abort()
  }
}

// An entry: one heading, one line of definition, one _Avoid_ list. It ends at the
// _Avoid_ line, so another entry's prose cannot satisfy a claim about this one.
function entry (term) {
  const lines = GLOSSARY.split('\n')
  const heading = lines.findIndex(line => line.startsWith('**' + term + '**:'))
  if (heading === -1) return null
  return { line: heading + 1, body: lines[heading + 1] ?? '', avoid: lines[heading + 2] ?? '' }
}

// Every backticked name in a line. A name wears backticks in this glossary, which is
// its style for a key, a switch, a file, or a path.
const names = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

// A route this glossary entry claims the panel serves, with the method the entry
// gives it. A name without a method is a file or a term, and this guard has no claim
// about it. The method is carried, not assumed: a write route answers a GET with a
// 405, and a guard that sent one anyway would fail a correct entry.
const ROUTE = /^(GET|POST|DELETE) (\/\S*)$/

// The path a real request carries, with the entry's <name> made a puppet's.
const requestPath = route => route.replace(/<[a-z]+>/g, PUPPET)

// The words an _Avoid_ line bans, one per comma. They are plain words, not backticked
// names, so they are read the way the list is written.
const avoidWords = line => line.replace(/^_Avoid_:\s*/, '').split(/[,.]/)
  .map(word => word.trim().toLowerCase()).filter(word => word !== '')

const message = {
  noAnswer: (where, route, method, status) => where + ' names ' + method + ' ' + route + ', and ' +
    'the panel answers it ' + status + '. createPanelHandler in src/panel/server.js dispatches the ' +
    'panel, and its routes are the panel\'s: a path it does not serve is a 404, and a verb a route ' +
    'does not take is a 405. An entry that names a route the panel dropped sends a reader to a ' +
    'page that is not there.',
  noStream: where => where + ' names no live region. The page holds one open: ' +
    'GET /api/puppets/<name>/stream answers text/event-stream and rewrites the card on its tick ' +
    '(src/panel/routes/stream.js, #248). An entry that describes the panel without the stream ' +
    'describes a page that reloads, which is the page #248 replaced.',
  noCard: where => where + ' does not call the unit the page renders a card. src/panel/views/card.js ' +
    'renders one, docs/panel.md says "Per puppet, one card", and "card" is the one word the three ' +
    'share. A second name for it is a second concept for a reader.',
  noEntry: term => 'GLOSSARY.md defines ' + term + '. It has no entry, so the object a run takes ' +
    'is named only by the pages that use it.',
  shape: (where, term) => where + ' is not an entry: the ' + term + ' heading, one line, and its ' +
    '_Avoid_ list. GLOSSARY.md holds one shape for every term, and a term that reads differently ' +
    'is one a reader cannot scan.',
  noObject: (where, name) => where + ' names no lease object. scripts/online-cluster.sh takes a ' +
    'Kubernetes Lease named ' + name + ' (MONOPLAYER_LEASE_NAME), and a glossary that does not ' +
    'name it leaves a reader to find the name in a script.',
  noNamespace: (where, ns) => where + ' names no namespace. ' + ns + ' is where the custody is ' +
    'and where scripts/online-cluster.sh takes the lease (MONOPLAYER_CLUSTER_NAMESPACE), and it is ' +
    'never a gate lane: a lane belongs to one worktree, so a lease there is invisible to the next ' +
    'one.',
  banned: where => where + ' lists "lease" under Claim as a word to avoid. That word names the ' +
    'account lease, a Kubernetes object one run takes, and it is the term this glossary stands ' +
    'behind. The ban belongs to a claim, a hold on a body, and to nothing the word now means: ' +
    'the Account lease entry carries it.'
}

// The default a shell variable carries, read the way test/tooling/live-manifests.test.js
// reads the same script: one line, one regex, and the script is the authority. That
// test already pairs LEASE_NAME and NAMESPACE with the Role that grants the verbs, so
// the two readers agree by construction rather than by a list here.
function shellDefault (name) {
  const found = new RegExp('^' + name + '=\\$\\{[A-Z_]+:-(\\S+)\\}$', 'm').exec(ONLINE)
  assert.ok(found, 'scripts/online-cluster.sh names its ' + name + ' default, and this test reads it')
  return found[1]
}

test('the panel the entry is compared against serves the routes it is asked for', async () => {
  // A comparison over an empty surface passes every case below. The three reads the
  // page is made of answer here, and the stream answers with its head.
  const { url, close } = await panel()
  try {
    assert.equal((await answer(url, '/api/puppets')).status, 200, 'the registry answers')
    assert.equal((await answer(url, '/api/puppets/' + PUPPET)).status, 200, 'a card answers')
    const stream = await answer(url, '/api/puppets/' + PUPPET + '/stream')
    assert.equal(stream.status, 200, 'the live region answers')
    assert.match(stream.type, /^text\/event-stream/, 'the live region is a stream, which is what ' +
      'the entry is asked to name')
  } finally {
    await close()
  }
})

test('the Panel entry names routes the panel serves, and the live region', async () => {
  const found = entry('Panel')
  assert.notEqual(found, null, message.noEntry('Panel'))
  assert.ok(found.avoid.startsWith('_Avoid_:'), message.shape('GLOSSARY.md:' + found.line, 'Panel'))
  const where = 'GLOSSARY.md:' + found.line
  const routes = names(found.body).map(name => name.match(ROUTE)).filter(Boolean)
    .map(([, method, path]) => ({ method, path }))
  assert.ok(routes.length > 0, where + ' names no route, so nothing here is compared with the panel')

  const { url, close } = await panel()
  try {
    for (const route of routes) {
      const { status } = await answer(url, requestPath(route.path), route.method)
      // Not merely "not a 404": a 500 is a route that exists and is broken, while a write
      // route answers a request it cannot read with a 400, which is the panel serving it.
      if (status >= 400 && status !== 400) assert.fail(message.noAnswer(where, route.path, route.method, status))
    }
  } finally {
    await close()
  }

  assert.ok(routes.some(route => /\/stream$/.test(route.path)), message.noStream(where))
  assert.match(found.body, /\bcard\b/, message.noCard(where))
})

test('the account lease entry names the object and the namespace a run takes', () => {
  const name = shellDefault('LEASE_NAME')
  const namespace = shellDefault('NAMESPACE')
  const found = entry('Account lease')
  assert.notEqual(found, null, message.noEntry('Account lease'))
  assert.ok(found.avoid.startsWith('_Avoid_:'), message.shape('GLOSSARY.md:' + found.line, 'Account lease'))
  const where = 'GLOSSARY.md:' + found.line
  assert.ok(found.body.includes(name), message.noObject(where, name))
  assert.ok(found.body.includes(namespace), message.noNamespace(where, namespace))
})

test('no _Avoid_ line bans the word that now names an object', () => {
  // Claim's list is about a player's hold on a body, and every word on it stays: lock,
  // slot, seat, take. "Lease" left it in #300, because the same word is the name of a
  // Kubernetes Lease one run takes, and a glossary bans no word it defines.
  const claim = entry('Claim')
  assert.notEqual(claim, null, message.noEntry('Claim'))
  assert.ok(claim.avoid.startsWith('_Avoid_:'), message.shape('GLOSSARY.md:' + claim.line, 'Claim'))
  assert.deepEqual(avoidWords(claim.avoid).filter(word => word === 'lease'), [],
    message.banned('GLOSSARY.md:' + claim.line))
})

test('the module that renders a card is still named for one', () => {
  // The one word this guard reads out of a sentence, checked at its home: a module
  // renamed away from "card" would leave this guard asking the glossary for a word
  // the page no longer has a file for.
  assert.ok(fs.existsSync(path.join(ROOT, 'src/panel/views/card.js')),
    'src/panel/views/card.js renders one card, which is the word the entry is asked to use')
})

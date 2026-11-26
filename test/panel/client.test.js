// The page's write script, run as code (#353).
//
// `src/panel/public/panel.js` is the only file in this repository a browser runs, and
// nothing executed it: `page.test.js` read it as text and checked the one selector a
// regex could reach. #309's defect — `paintArmed` naming one block's removals and not the
// other's — went unseen for exactly that reason. This file is the half that check could
// not carry, and it replaced it:
//
//   the first press shows the confirmation, for every removal the page renders
//   the second press sends, and the answer lands in the block that asked
//   the `host:port` split the allowed servers' add form sends
//   the ten-second arm, which is the one nobody watches
//
// Two decisions make it a join rather than a second description of the page.
//
// The tree is `renderCard`'s own output, parsed. A test that hand-built its forms would
// keep passing after a view renamed `data-write` or `data-key`; a test that parses the
// card breaks, which is what an operator would see.
//
// The script is imported once per case, through a query string. Node caches a module by
// its URL, so the query is what gives a case its own copy of the script's `armed` value
// instead of the previous case's.
//
// The sentences a 200 prints are repeated in the cases below, and that is a tripwire, not
// a second home for them: a change to `written`'s wording that no case notices is a change
// an operator meets first.
//
// Node has no document and this repository has no dependency that brings one, so the
// double below is the smallest tree the script touches. It lives here rather than in
// `src/` because nothing else can use it. The only thing it adds to the rendered page is
// what the operator typed, because a rendered input is empty and the script reads it
// through `FormData`.
//
// Every case runs on a mocked clock, including the ones that never touch it: arming a
// removal schedules a ten-second timer, so a real one would hold the gate open until it
// fired.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activity } from '../../src/panel/activity.js'
import { renderCard } from '../../src/panel/views/card.js'

const SCRIPT = new URL('../../src/panel/public/panel.js', import.meta.url)

const UUID = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const ADDRESS = 'paper.example.net:25565'
const WHITELIST = '/api/puppets/glowsquidye/whitelist'
const ALLOWED = '/api/puppets/glowsquidye/allowed-servers'
const VERSION = '41221'
const REDRAWS = '. The list redraws on the next change, within 5 s.'

// The version sentence `written` appends to a 200: the route answers a ConfigMap version
// and the page says it is one, because every other number on this page carries a time.
const at = version => ' at ConfigMap resourceVersion ' + version + ', which is a version and not a time'

// The allowed servers' route answer to a host or a port it cannot dial
// (src/panel/routes/allowed.js). Three cases read it, so it is written once.
const NOT_AN_ADDRESS = 'host must be a hostname or an IPv4 address with no scheme and no port, ' +
  'and port must be an integer between 1 and 65535'

// --- the page the test drives ------------------------------------------------

const PUPPET = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565'
}

const OBSERVED_AT = '2026-11-18T10:37:24.906Z'

// The card, and both control lists, as `renderCard` renders them. One entry each, so a
// row is there to arm and a list is there to add to. No heartbeat: the write blocks are
// outside the live region, and this file never reads it.
const CARD = renderCard(PUPPET, activity({
  puppet: PUPPET,
  pod: {
    metadata: { name: 'monoplayer-84855d7f8b-5h5bd', creationTimestamp: '2026-11-18T09:00:00.000Z' },
    status: {
      phase: 'Running',
      startTime: '2026-11-18T09:00:00.000Z',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ restartCount: 0 }]
    }
  },
  log: { text: '' },
  now: Date.parse(OBSERVED_AT)
}), {
  observedAt: OBSERVED_AT,
  resourceVersion: '41221',
  document: { version: 1, players: [{ uuid: UUID, name: 'Bafbi', addedAt: null }] }
}, {
  observedAt: OBSERVED_AT,
  resourceVersion: '41222',
  source: 'control',
  document: { version: 1, servers: [{ host: 'paper.example.net', port: 25565, addedAt: null }] }
})

// --- the double ---------------------------------------------------------------
//
// One selector syntax: a tag, classes, and one attribute, optionally with a value, and a
// comma-separated list of them. That is every selector the script uses, and matching it
// for real is the point: `paintArmed` filters on `data-write`, so a fake that returned
// every form regardless would hide the defect this file exists for.

function parse (selector) {
  const tag = /^([a-z0-9]*)/.exec(selector)[1]
  const classes = [...selector.matchAll(/\.([a-z0-9-]+)/g)].map(match => match[1])
  const attributes = [...selector.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)]
  if (attributes.length > 1) throw new Error('the double reads one attribute per selector: ' + selector)
  // Nothing outside the three patterns above may survive, because a selector this cannot
  // read would match nothing and look like a page with no forms. That is #309's defect
  // wearing a different coat: silent agreement between the double and a page that no
  // longer holds what the test believes.
  const rest = selector
    .replace(/^[a-z0-9]*/, '')
    .replace(/\[[a-z-]+(?:="[^"]*")?\]/g, '')
    .replace(/\.[a-z0-9-]+/g, '')
  // A space is a descendant combinator, and this reads one element at a time.
  if (/\s/.test(selector) || rest !== '') throw new Error('the double cannot read this selector: ' + selector)
  const attribute = attributes[0]
  return {
    tag,
    classes,
    attribute: attribute === undefined ? null : { name: attribute[1], value: attribute[2] }
  }
}

function matches (node, selector) {
  for (const part of selector.split(',')) {
    const { tag, classes, attribute } = parse(part.trim())
    if (tag !== '' && node.tagName !== tag) continue
    if (!classes.every(name => node.classes.has(name))) continue
    if (attribute !== null) {
      if (!node.attributes.has(attribute.name)) continue
      if (attribute.value !== undefined && node.attributes.get(attribute.name) !== attribute.value) continue
    }
    return true
  }
  return false
}

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)])

class FakeElement {
  constructor (tag, attrs = {}) {
    this.tagName = tag
    this.attributes = new Map(Object.entries(attrs).map(([name, value]) => [name, String(value)]))
    this.classes = new Set(String(this.attributes.get('class') ?? '').split(' ').filter(name => name !== ''))
    // The DOM exposes data-* as camelCase properties. The script writes `dataset.armed`
    // and `dataset.outcome` as well as reading the page's own data-key and data-name.
    this.dataset = {}
    for (const [name, value] of this.attributes) {
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    }
    this.classList = {
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name) }
    }
    this.children = []
    this.parent = null
    this.ownText = ''
    this.disabled = false
    this.fields = {}
    this.resets = 0
  }

  get id () { return this.attributes.get('id') ?? '' }

  get textContent () {
    return this.children.length === 0
      ? this.ownText
      : this.ownText + this.children.map(child => child.textContent).join('')
  }

  // Setting textContent replaces what an element holds, and clears its children, which
  // is what the button paint relies on when it renames a button.
  set textContent (value) {
    this.children = []
    this.ownText = String(value)
  }

  append (...children) {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
    return this
  }

  appendText (text) { this.ownText += text }

  getAttribute (name) { return this.attributes.get(name) ?? null }
  setAttribute (name, value) { this.attributes.set(name, String(value)) }
  removeAttribute (name) { this.attributes.delete(name) }

  // A write that lands resets the form. A refusal does not, which is why the case for a
  // 400 asserts the draw kept what the operator typed.
  reset () {
    this.resets += 1
    this.fields = {}
  }

  querySelectorAll (selector) { return descendants(this).filter(node => matches(node, selector)) }
  querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null }

  closest (selector) {
    for (let node = this; node !== null; node = node.parent) if (matches(node, selector)) return node
    return null
  }
}

// The card's markup as the tree above. The tags this page renders and nothing more: an
// element, a self-closing element, text, and a close tag that pops to its own match.
const VOID = new Set(['input', 'br', 'hr', 'img', 'link', 'meta'])

function tree (html) {
  const root = new FakeElement('document')
  const open = [root]
  for (const found of html.matchAll(/<(\/?)([a-z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/gi)) {
    const [, closing, tag, source, text] = found
    if (text !== undefined) {
      open[open.length - 1].appendText(text)
      continue
    }
    if (closing === '/') {
      for (let depth = open.length - 1; depth > 0; depth -= 1) {
        if (open[depth].tagName === tag.toLowerCase()) {
          open.length = depth
          break
        }
      }
      continue
    }
    const attrs = {}
    for (const attribute of source.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attrs[attribute[1]] = attribute[2] ?? ''
    const node = new FakeElement(tag.toLowerCase(), attrs)
    open[open.length - 1].append(node)
    if (!VOID.has(node.tagName)) open.push(node)
  }
  return root
}

// Node's FormData refuses a form it did not build, and this is not a form. The double
// carries the one method the script calls, over the fields a case set, and inherits the
// browser's answer for a field that is not there: null.
class FakeFormData {
  constructor (form) { this.entries = new Map(Object.entries(form.fields ?? {})) }
  get (name) { return this.entries.get(name) ?? null }
}

// --- the rig -----------------------------------------------------------------

let loads = 0
// A case that opens more than one page — the four writes, the two ports — shares the
// clock its test already enabled. Mocking it twice throws, and a second clock would only
// be a second way to read the same zero.
const clocked = new WeakSet()

// One page: the parsed card, the replies the case will get back, and the requests the
// script made. The script is imported once per page, so a case starts with no armed
// removal and the previous case's listeners are on a document nobody kept.
async function open (t, { replies = [] } = {}) {
  if (!clocked.has(t)) {
    clocked.add(t)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  }

  const body = tree(CARD)
  const listeners = new Map()
  const page = {
    body,
    calls: [],
    replies: [...replies],
    document: {
      addEventListener (type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      querySelectorAll: selector => body.querySelectorAll(selector)
    },
    // The one form the page renders with this data-write. A name that matches nothing is
    // a broken case, not an empty answer.
    form (kind) {
      const found = body.querySelectorAll('form[data-write]').filter(form => form.dataset.write === kind)
      assert.equal(found.length, 1, 'the card renders one ' + kind + ' form')
      return found[0]
    },
    // The one answer area of the block a form sits in. It is the block's, not the row's,
    // because a tick replaces the row and would take the sentence with it.
    answer (form) { return form.closest('.control-block').querySelector('.block-result') },
    // The answer area of the block beside it, which a write must not reach.
    otherAnswer (form) {
      const other = form.closest('.attach-block') === null ? '.attach-block' : '.allowed-block'
      return body.querySelector(other).querySelector('.block-result')
    },
    button (form) { return form.querySelector('button') },
    // htmx's two events, for the repaint a tick causes.
    swap (type) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
    // A submit as the browser raises it: the form is the target, and whoever handles it
    // cancels the default.
    async press (target) {
      let prevented = false
      for (const listener of listeners.get('submit') ?? []) {
        await listener({ target, preventDefault: () => { prevented = true } })
      }
      return prevented
    }
  }

  globalThis.Element = FakeElement
  globalThis.document = page.document
  globalThis.FormData = FakeFormData
  globalThis.fetch = async (url, init) => {
    page.calls.push({ url, init, body: init.body === undefined ? null : JSON.parse(init.body) })
    const reply = page.replies.shift()
    if (reply === undefined) throw new Error('the script sent a request the case did not answer: ' + url)
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => reply.body }
  }

  loads += 1
  await import(SCRIPT.href + '?case=' + loads)
  return page
}

const json = value => ({ status: 200, body: JSON.stringify(value, null, 2) + '\n' })
const plain = (status, body) => ({ status, body })

// --- the first press ----------------------------------------------------------

test('every removal the page renders shows the confirmation on the first press, and sends nothing', async t => {
  const page = await open(t)
  const removals = page.body.querySelectorAll('form[data-write]')
    .filter(form => form.dataset.write.startsWith('remove'))

  // Both blocks, named from the page rather than from a list here: a third block that
  // rendered a removal and was not painted would be a button saying "remove" beside a
  // press that deletes.
  assert.deepEqual(removals.map(form => form.dataset.write).sort(), ['remove', 'remove-server'])

  for (const form of removals) {
    const button = page.button(form)
    assert.equal(button.textContent, 'remove', form.dataset.write + ' starts unarmed')

    assert.equal(await page.press(form), true, 'the press is the script\'s, so the form does not post')
    assert.equal(button.textContent, 'confirm: remove ' + form.dataset.name,
      form.dataset.write + ' names what the second press would remove')
    assert.equal(button.dataset.armed, 'true', form.dataset.write + ' says it is armed')
    assert.ok(button.classes.has('armed'), 'and the stylesheet keyed on the class sees it')
    assert.equal(page.calls.length, 0, 'nothing was sent on the first press, for ' + form.dataset.write)
  }
})

test('arming one removal disarms the other, because one press confirms one entry', async t => {
  const page = await open(t)

  await page.press(page.form('remove'))
  await page.press(page.form('remove-server'))

  assert.equal(page.button(page.form('remove')).textContent, 'remove', 'the attach whitelist\'s button went back')
  assert.equal(page.button(page.form('remove-server')).textContent, 'confirm: remove ' + ADDRESS)
  assert.equal(page.calls.length, 0)
})

test('a submit that is not one of the page\'s forms is left to the browser', async t => {
  const page = await open(t)

  assert.equal(await page.press(new FakeElement('form', { action: '/search' })), false,
    'the script did not take the event')
  assert.equal(page.calls.length, 0)
})

// --- the second press ---------------------------------------------------------

test('the second press of a removal sends the delete the row names, and prints the answer', async t => {
  const page = await open(t, {
    replies: [json({ changed: true, uuid: UUID, name: 'Bafbi', resourceVersion: VERSION })]
  })
  const form = page.form('remove')

  await page.press(form)
  await page.press(form)

  assert.equal(page.calls.length, 1)
  assert.equal(page.calls[0].url, WHITELIST + '/' + UUID, 'the request goes to the path the row names')
  assert.equal(page.calls[0].init.method, 'DELETE')
  assert.equal(page.calls[0].init.headers['content-type'], 'application/json', 'the route takes JSON and nothing else')
  assert.equal(page.calls[0].body, null, 'a delete carries no body')

  assert.equal(page.answer(form).textContent, 'removed Bafbi' + at(VERSION) + REDRAWS)
  assert.equal(page.answer(form).dataset.outcome, 'done')
  assert.equal(page.answer(page.form('remove-server')).textContent, '', 'the other block\'s answer area stays empty')
  assert.equal(page.button(form).textContent, 'remove', 'the button is back to its own name')
  assert.equal(page.button(form).disabled, false, 'and the form is usable again')
  assert.equal(form.getAttribute('aria-busy'), null, 'the busy state is cleared, not left on')
})

test('the arm survives a tick that replaced the button, so the second press still confirms', async t => {
  const page = await open(t, {
    replies: [json({ changed: true, server: ADDRESS, resourceVersion: VERSION })]
  })
  const form = page.form('remove-server')

  await page.press(form)
  // The stream replaces the list on every change, which throws away the button the
  // operator armed. The state is held by the script, so the swap paints it back. htmx
  // raises the out-of-band event for the list and the general one for anything else it
  // swaps, and either can replace the button.
  for (const event of ['htmx:oobAfterSwap', 'htmx:afterSettle']) {
    page.swap(event)
    assert.equal(page.button(form).textContent, 'confirm: remove ' + ADDRESS,
      event + ' repaints the confirmation onto the row it replaced')
  }

  await page.press(form)
  assert.equal(page.calls[0].init.method, 'DELETE')
  assert.equal(page.calls[0].url, ALLOWED + '/' + encodeURIComponent(ADDRESS))
})

// --- the ten-second arm -------------------------------------------------------

test('an arm nobody uses disarms itself after ten seconds, and not before', async t => {
  const page = await open(t)
  const form = page.form('remove')

  await page.press(form)
  assert.equal(page.button(form).textContent, 'confirm: remove Bafbi')

  // Nine seconds is still the operator's window. A press there must confirm rather than
  // arm again, or a slow reader would send the deletion on a third press they never made.
  t.mock.timers.tick(9_999)
  assert.equal(page.button(form).textContent, 'confirm: remove Bafbi')
  assert.equal(page.button(form).dataset.armed, 'true')

  t.mock.timers.tick(1)
  assert.equal(page.button(form).textContent, 'remove', 'the ten seconds are over')
  assert.equal(page.button(form).dataset.armed, 'false')
  assert.equal(page.calls.length, 0, 'an expired arm sends nothing on its own')

  // And an expired arm is not a confirmation: the next press arms again.
  await page.press(form)
  assert.equal(page.calls.length, 0, 'the press after an expiry arms rather than deletes')
})

test('an arm taken again after a confirmed removal keeps its own ten seconds', async t => {
  const page = await open(t, {
    replies: [json({ changed: true, uuid: UUID, name: 'Bafbi', resourceVersion: VERSION })]
  })
  const form = page.form('remove')

  // Arm, confirm, and arm the same row again inside the first arm's ten seconds. The
  // first press's timer is still scheduled, and it must not clear the later arm: the
  // operator took a fresh ten seconds, and a timer set for the first one would disarm
  // the button at a moment they never chose.
  await page.press(form)
  await page.press(form)
  assert.equal(page.calls.length, 1, 'the second press sent the delete')

  t.mock.timers.tick(1_000)
  await page.press(form)
  assert.equal(page.button(form).textContent, 'confirm: remove Bafbi', 'the row is armed again')

  t.mock.timers.tick(9_000)
  assert.equal(page.button(form).dataset.armed, 'true',
    'the first arm\'s timer did not take the second arm with it')
  assert.equal(page.button(form).textContent, 'confirm: remove Bafbi')

  t.mock.timers.tick(1_000)
  assert.equal(page.button(form).dataset.armed, 'false', 'the second arm\'s own ten seconds ended it')
  assert.equal(page.calls.length, 1, 'neither timer sent anything')
})

// --- the host:port split ------------------------------------------------------

test('the allowed servers\' add form splits host:port into the route\'s two fields', async t => {
  const page = await open(t, { replies: [json({ changed: true, server: ADDRESS, resourceVersion: VERSION })] })
  const form = page.form('add-server')

  form.fields = { server: 'paper.example.net:25565' }
  await page.press(form)

  assert.equal(page.calls[0].init.method, 'POST')
  assert.deepEqual(page.calls[0].body, { host: 'paper.example.net', port: 25565 },
    'the route takes a host and an integer port, and the one field the operator pasted is split on its last colon')
  assert.equal(form.resets, 1, 'a written form is cleared')
})

test('an address with no port is sent as a null port, and the refused form keeps what was typed', async t => {
  const page = await open(t, { replies: [plain(400, NOT_AN_ADDRESS + '\n')] })
  const form = page.form('add-server')

  form.fields = { server: '  paper.example.net  ' }
  await page.press(form)

  assert.deepEqual(page.calls[0].body, { host: 'paper.example.net', port: null },
    'the page does not invent a port for an address that has none')
  assert.equal(form.resets, 0, 'a refused form keeps what the operator typed')
})

test('a port that is not a number is sent as a null port, not as text', async t => {
  for (const typed of ['paper.example.net:minecraft', 'paper.example.net:']) {
    const page = await open(t, { replies: [plain(400, NOT_AN_ADDRESS + '\n')] })
    const form = page.form('add-server')

    form.fields = { server: typed }
    await page.press(form)

    assert.deepEqual(page.calls[0].body, { host: 'paper.example.net', port: null },
      JSON.stringify(typed) + ' does not split into a numeric port, and the route answers port: null in its own words')
  }
})

// --- the answer, per block ----------------------------------------------------

test('each block prints its own 200, in its own block\'s vocabulary', async t => {
  const cases = [
    ['an attach whitelist add', 'add', false, { player: 'Bafbi' }, { changed: true, uuid: UUID, name: 'Bafbi', resourceVersion: '41000' }, 'added Bafbi'],
    ['an attach whitelist removal', 'remove', true, {}, { changed: true, uuid: UUID, name: 'Bafbi', resourceVersion: '41001' }, 'removed Bafbi'],
    ['an allowed server add', 'add-server', false, { server: ADDRESS }, { changed: true, server: ADDRESS, resourceVersion: '41002' }, 'added ' + ADDRESS],
    ['an allowed server removal', 'remove-server', true, {}, { changed: true, server: ADDRESS, resourceVersion: '41003' }, 'removed ' + ADDRESS]
  ]

  for (const [label, kind, twice, fields, answer, sentence] of cases) {
    const page = await open(t, { replies: [json(answer)] })
    const form = page.form(kind)
    const other = page.otherAnswer(form)
    form.fields = fields

    // A removal asks twice, so the case presses twice and lets the second press send.
    if (twice) await page.press(form)
    await page.press(form)

    assert.equal(page.answer(form).textContent, sentence + at(answer.resourceVersion) + REDRAWS, label)
    assert.equal(page.answer(form).dataset.outcome, 'done', label + ' is a write, not a refusal')
    assert.equal(other.textContent, '', label + ' does not answer in the other block')
    assert.equal(page.calls.length, 1, label + ' sent one request')
  }
})

test('an add of a server the list already holds says so instead of claiming a write', async t => {
  const page = await open(t, { replies: [json({ changed: false, server: ADDRESS, resourceVersion: VERSION })] })
  const form = page.form('add-server')

  form.fields = { server: ADDRESS }
  await page.press(form)

  assert.equal(page.answer(form).textContent,
    'already there, so nothing was rewritten: added ' + ADDRESS + at(VERSION) + REDRAWS)
  assert.equal(page.answer(form).dataset.outcome, 'done')
})

test('the attach whitelist\'s 400 is an instruction, printed as the route wrote it', async t => {
  // The route's 400 asks for the uuid when a name did not resolve. It names the account
  // it refused, and there is no value in front of it: the sentence is the whole answer.
  const instruction = 'the name could not be resolved from the panel namespace, so send the uuid instead'
  const page = await open(t, { replies: [plain(400, instruction + '\n')] })
  const form = page.form('add')

  form.fields = { player: 'nobody' }
  await page.press(form)

  assert.equal(page.answer(form).textContent, instruction, 'the instruction is not dressed as a failure')
  assert.equal(page.answer(form).dataset.outcome, 'instruction', 'and it is drawn as something to do')
  assert.equal(form.resets, 0, 'the field keeps the name the operator typed')
  assert.equal(page.calls[0].body.name, 'nobody', 'the name went to the resolver, because it is not a uuid')
})

test('a 400 is an instruction, and the allowed servers\' block says which address it refused', async t => {
  const page = await open(t, { replies: [plain(400, NOT_AN_ADDRESS + '\n')] })
  const form = page.form('add-server')

  // The route cannot name an address it could not parse, so the value the operator sent
  // goes in front and the route's sentence stays whole behind it.
  form.fields = { server: 'http://paper.example.net:25565/' }
  await page.press(form)

  assert.equal(page.answer(form).textContent, '"http://paper.example.net:25565/" was refused: ' + NOT_AN_ADDRESS)
  assert.equal(page.answer(form).dataset.outcome, 'instruction', 'an instruction is not drawn as a failure')
  assert.equal(page.button(form).disabled, false)
})

test('a 503 is a refusal in the route\'s own words, kept whole', async t => {
  const refused = 'the attach whitelist was not written: the cluster refused the patch: ' +
    'connect ECONNREFUSED 127.0.0.1:6443'
  const page = await open(t, { replies: [plain(503, refused + '\n')] })
  const form = page.form('remove')

  await page.press(form)
  await page.press(form)

  assert.equal(page.answer(form).textContent, refused, 'the sentence an operator acts on is not rewritten here')
  assert.equal(page.answer(form).dataset.outcome, 'refused')
})

test('a refusal with no words names the status, and a fetch that never answered names that', async t => {
  const empty = await open(t, { replies: [plain(500, '\n')] })
  await empty.press(empty.form('remove'))
  await empty.press(empty.form('remove'))
  assert.equal(empty.answer(empty.form('remove')).textContent, 'refused with 500')
  assert.equal(empty.answer(empty.form('remove')).dataset.outcome, 'refused')

  const unreachable = await open(t, { replies: [] })
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  const form = unreachable.form('remove')
  await unreachable.press(form)
  await unreachable.press(form)
  assert.equal(unreachable.answer(form).textContent, 'the panel could not be reached: Failed to fetch')
  assert.equal(unreachable.answer(form).dataset.outcome, 'refused')
})

// --- the double ---------------------------------------------------------------

test('the double refuses a selector it cannot read, instead of matching nothing', async t => {
  const page = await open(t)

  // A selector this cannot read would match nothing, and a case would then read like a
  // page that renders no forms rather than like a broken double.
  assert.throws(() => page.body.querySelectorAll('.entry .who'), /the double cannot read this selector/)
  assert.throws(() => page.body.querySelectorAll('form[data-write][data-key]'), /one attribute per selector/)
})

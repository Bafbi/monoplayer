// The page's writes: the attach whitelist's two changes, and the allowed servers'.
//
// The write routes require Content-Type: application/json, and that is the guard
// rather than a convention: it is not a CORS-safelisted content type, so a browser
// will not send it from a cross-origin HTML form without a preflight the panel never
// grants. A fetch sets it in one line and can print the route's answer as the route
// wrote it (#248).
//
// The reading is htmx's job (src/panel/views/card.js holds sse-connect). This file is
// only the writing. Each form names what it is in data-write, and the shape of the
// request is that name's business:
//
//   add            POST {uuid} or {name}, one of the two, never both
//   remove         DELETE, with the uuid already in the form's action
//   add-server     POST {host, port}, split out of the one host:port field
//   remove-server  DELETE, with the host:port already in the form's action
//
// Three answers, three renderings (#232's refusals, #248's block):
//
//   200          what was written, and when the list redraws
//   400          an instruction: the route asks for the uuid when a name did not
//                resolve, and "send the uuid instead" is something to do, not a
//                failure to read past
//   anything else  a refusal, in the route's own words
//
// A refusal is kept whole. "the attach whitelist was not written: ..." is the sentence
// an operator acts on, and rewriting it here would be a second, worse copy of it.
//
// Two pieces of state live here rather than in the DOM, and the reason is the same for
// both: the stream replaces the list whenever it changes, so anything held in a row
// would be thrown away under the operator.
//
//   the armed removal   keyed by the entry's uuid or the server's host:port, and
//                       re-painted onto the button the tick replaced, so the
//                       confirmation survives a redraw between the two presses
//   the last answer     there is one answer area per block, outside the list, so a
//                       refusal is not taken away with the row it was about

// The two shapes a uuid arrives in: dashed, or the same 32 hex digits undashed.
// Nothing else is sent as a uuid, so a name that happens to look odd goes to the
// resolver instead of being refused as a malformed uuid.
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

// Removing an account from an allow-list asks twice. The first press arms the button,
// the second sends, and an arm that is not used within ten seconds disarms itself: a
// control that deletes on a stray tap is not one to put on a page a phone opens.
const ARM_MS = 10_000
let armed = null

const resultOf = (form) => form.closest('.control-block')?.querySelector('.block-result') ?? null

const outcome = (form, text, kind) => {
  const out = resultOf(form)
  if (out === null) return
  out.textContent = text
  if (kind === null) delete out.dataset.outcome
  else out.dataset.outcome = kind
}

// Every remove button in the document, painted from the one armed value. Called after
// a swap as well as after a press, which is what makes the confirmation survive the
// tick that replaced the button. Both blocks' buttons are here: `remove` for an
// attach whitelist entry and `remove-server` for an allowed server, and a selector
// that named one would leave the other's second press invisible.
function paintArmed () {
  for (const form of document.querySelectorAll('form[data-write="remove"], form[data-write="remove-server"]')) {
    const button = form.querySelector('button')
    if (button === null) continue
    const on = armed !== null && form.dataset.key === armed.key && armed.until > Date.now()
    button.dataset.armed = on ? 'true' : 'false'
    button.classList.toggle('armed', on)
    button.textContent = on ? 'confirm: remove ' + armed.name : 'remove'
  }
}

// What a 200 means, in the terms the route answered in. The route returns the document
// it wrote. The page says what was written and when, never "moved" or "added", because
// the write is the panel's act and the effect is the lane's, at the next login.
//
// No count appears here. A count is a number, and every number on this page carries the
// time of the record it came from; the route's answer has a version and no clock, so the
// page prints the version and says what it is.
function written (form, text) {
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    return text.trim()
  }
  const kind = form.dataset.write
  // One answer area, two vocabularies: the attach whitelist writes about an account,
  // the allowed servers about an address. Each says what its route answered in.
  const account = kind === 'add' || kind === 'remove'
  const server = kind === 'add-server' || kind === 'remove-server'
  if (account || server) {
    const what = account
      ? answer?.name ?? answer?.uuid ?? 'the account'
      : answer?.server ?? 'the server'
    const already = answer?.changed === false ? 'already there, so nothing was rewritten: ' : ''
    const version = answer?.resourceVersion === null || answer?.resourceVersion === undefined
      ? ' the route named no ConfigMap version'
      : ' at ConfigMap resourceVersion ' + answer.resourceVersion + ', which is a version and not a time'
    return already + (kind === 'add' || kind === 'add-server' ? 'added ' : 'removed ') + what + version +
      '. The list redraws on the next change, within 5 s.'
  }
  return text.trim()
}

// The request body, or null for a verb that carries none.
function body (form, data) {
  const kind = form.dataset.write
  if (kind === 'add') {
    const value = String(data.get('player') ?? '').trim()
    // One field, two shapes: the route takes a uuid or a name and refuses both at
    // once, so the page decides from what the operator typed.
    return UUID.test(value) ? { uuid: value } : { name: value }
  }
  if (kind === 'add-server') {
    // One field, two fields: the list, the removal path and a picker row all name a
    // server by host:port, so that is what the page asks for, and the route's host and
    // port are split out of it here. The split is the route's own rule, and a value
    // that does not split is sent as a host the route refuses in its own words rather
    // than as a sentence invented on this side.
    const value = String(data.get('server') ?? '').trim()
    const colon = value.lastIndexOf(':')
    if (colon <= 0) return { host: value, port: null }
    const port = value.slice(colon + 1)
    return { host: value.slice(0, colon), port: /^[0-9]+$/.test(port) ? Number(port) : null }
  }
  return null
}

document.addEventListener('submit', async (event) => {
  const form = event.target instanceof Element ? event.target.closest('form[data-write]') : null
  if (form === null) return
  event.preventDefault()

  const button = form.querySelector('button')
  const kind = form.dataset.write
  if (kind === 'remove' || kind === 'remove-server') {
    const key = form.dataset.key
    // Already armed for this row: this press is the confirmation.
    if (armed !== null && armed.key === key && armed.until > Date.now()) {
      armed = null
      paintArmed()
    } else {
      armed = { key, name: form.dataset.name ?? 'this entry', until: Date.now() + ARM_MS }
      paintArmed()
      setTimeout(() => {
        if (armed === null || armed.key !== key) return
        armed = null
        paintArmed()
      }, ARM_MS)
      return
    }
  }

  const payload = body(form, new FormData(form))
  const method = kind === 'remove' || kind === 'remove-server' ? 'DELETE' : 'POST'

  form.setAttribute('aria-busy', 'true')
  if (button !== null) button.disabled = true
  outcome(form, method === 'DELETE' ? 'removing\u2026' : 'sending\u2026', null)
  try {
    const response = await fetch(form.getAttribute('action'), {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload)
    })
    const text = await response.text()
    if (response.ok) {
      outcome(form, written(form, text), 'done')
      form.reset()
    } else if (response.status === 400) {
      // The route's 400 is an instruction, not a failure: it asks for the uuid when a
      // name did not resolve. It is rendered as one, in its own words.
      outcome(form, text.trim(), 'instruction')
    } else {
      outcome(form, text.trim() === '' ? 'refused with ' + response.status : text.trim(), 'refused')
    }
  } catch (error) {
    // The fetch itself failed: no answer, so there is no status to name.
    outcome(form, 'the panel could not be reached: ' + String(error?.message ?? error), 'refused')
  } finally {
    form.removeAttribute('aria-busy')
    if (button !== null) button.disabled = false
  }
})

// A tick that changes the list replaces every remove button, so the armed one is
// painted again from the state above. Two events, because htmx raises the out-of-band
// one for the list and the general one for anything else it swaps.
document.addEventListener('htmx:oobAfterSwap', paintArmed)
document.addEventListener('htmx:afterSettle', paintArmed)

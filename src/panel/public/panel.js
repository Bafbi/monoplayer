// The page's write: one form, one JSON body, one sentence back.
//
// The write routes require Content-Type: application/json, and that is the guard
// rather than a convention: it is not a CORS-safelisted content type, so a browser
// will not send it from a cross-origin HTML form without a preflight the panel
// never grants. An htmx form post would need an extension to set it; a fetch sets
// it in one line and can print the route's answer as the route wrote it (#248).
//
// The reading is htmx's job (src/panel/views/card.js holds sse-connect). This file
// is only the writing, and it holds no knowledge of what the fields mean: a route
// that grows a form gets one by adding data-write and its inputs.
//
// A refusal is the route's own words, kept whole. "the control document was not
// written: ..." is the sentence an operator acts on, and rewriting it here would
// be a second, worse copy of it.

const outcome = (form, text, refused) => {
  const out = form.querySelector('output')
  if (out === null) return
  out.textContent = text
  if (refused) out.dataset.outcome = 'refused'
  else delete out.dataset.outcome
}

// What a 200 means, in the terms the route answered in. The route returns the
// document it wrote; the page says what was written and when, not "moved", because
// the write is the panel's act and the move is the puppet's, up to 30 s later.
function written (text) {
  try {
    const answer = JSON.parse(text)
    const host = answer?.document?.backend?.host ?? '?'
    const port = answer?.document?.backend?.port ?? '?'
    const at = answer?.document?.changedAt ?? 'no timestamp'
    const key = answer?.key ?? 'the control document'
    return 'wrote ' + key + ': ' + host + ':' + port + ', changedAt ' + at +
      '. The puppet reads it on its next heartbeat.'
  } catch {
    return text.trim()
  }
}

document.addEventListener('submit', async (event) => {
  const form = event.target instanceof Element ? event.target.closest('form[data-write]') : null
  if (form === null) return
  event.preventDefault()

  const button = form.querySelector('button')
  const body = {}
  for (const [name, value] of new FormData(form)) {
    // The route takes an integer port and refuses one sent as text, so the page
    // sends the type the route's own document carries.
    body[name] = name === 'port' ? Number(value) : value
  }

  form.setAttribute('aria-busy', 'true')
  if (button !== null) button.disabled = true
  outcome(form, 'sending…', false)
  try {
    const response = await fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    if (response.ok) outcome(form, written(text), false)
    else outcome(form, text.trim() === '' ? 'refused with ' + response.status : text.trim(), true)
  } catch (error) {
    // The fetch itself failed: no answer, so there is no status to name.
    outcome(form, 'the panel could not be reached: ' + String(error?.message ?? error), true)
  } finally {
    form.removeAttribute('aria-busy')
    if (button !== null) button.disabled = false
  }
})

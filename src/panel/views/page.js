// The document: one head, one card per puppet (#248 split it out of the one
// renderer in src/panel/page.js).
//
// The page loads four files and all four come from the panel itself, under
// /static/ (src/panel/assets.js). No CDN: a tailnet-only control plane must not
// fetch its assets from the public internet, and a page that breaks when a CDN is
// down is a page nobody can debug (#248).
//
// htmx does the reading: the SSE extension connects to a puppet's stream and swaps
// the fragment that arrives into the live region. The writing is one small script
// of the page's own (src/panel/public/panel.js), because the write routes answer
// JSON and a JSON body is what they require.
//
// It is read on a phone, which is how the operator opens it: the layout is one
// column, the scene scales with the viewport, and the facts switch to one column
// below 30 rem.
import { escape } from './html.js'
import { renderCard } from './card.js'

// The page's own files. Named here and served by src/panel/assets.js, so the one
// list a reader checks against the image is this list.
export const ASSETS = [
  ['stylesheet', '/static/app.css'],
  ['script', '/static/vendor/htmx.min.js'],
  ['script', '/static/vendor/htmx-ext-sse.min.js'],
  ['script', '/static/panel.js']
]

// `lists` is each puppet's attach whitelist, keyed by name (#248). A caller that
// omits it gets the block's "not read" sentence rather than an empty list, because
// the two are different facts: one says the panel did not look, the other says nobody
// may attach.
// `banner` is the sentence a recording is announced with, or null. A fixture must be
// visible as one on the page itself, not only in the start line and in a refusal after a
// write: a screenshot of a recording that reads like a live lane is the failure this
// whole ticket exists to prevent (#248).
export function renderPage ({ version, puppets }, activities, lists = new Map(), banner = null) {
  const byName = new Map(activities.map(facts => [facts.name, facts]))
  const cards = puppets.map(puppet => {
    const facts = byName.get(puppet.name)
    return facts === undefined ? '' : renderCard(puppet, facts, lists.get(puppet.name) ?? null)
  }).filter(card => card !== '')
  const total = puppets.length === 1 ? '1 puppet' : puppets.length + ' puppets'
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Monoplayer panel</title>',
    '  <link rel="stylesheet" href="/static/app.css">',
    '  <script src="/static/vendor/htmx.min.js" defer></script>',
    '  <script src="/static/vendor/htmx-ext-sse.min.js" defer></script>',
    '  <script src="/static/panel.js" defer></script>',
    '</head>',
    '<body>',
    '  <header class="top">',
    ...(banner === null ? [] : ['    <p class="recording">' + escape(banner) + '</p>']),
    '    <h1>Monoplayer panel</h1>',
    '    <p class="count">' + escape(total) + ' in the registry (document version ' + escape(version) +
      '). Every number carries the timestamp of the record it came from, and the stream writes the same',
    '    fragment every 5 s; nothing is rendered as "now".</p>',
    '  </header>',
    cards.join('\n'),
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

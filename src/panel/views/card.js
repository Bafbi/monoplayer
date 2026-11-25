// One puppet's card: what never changes, what the stream replaces, and what the
// operator can do (#248).
//
// Three parts, in this order, and the order is the contract:
//
//   the head    the name, and the registry rows: the namespace, the Deployment,
//               the front hostname, the control ConfigMap. None of it changes
//               while the page is open, so no tick touches it.
//   the live    an element whose innerHTML is replaced by every SSE tick. It
//    region     carries the state sentence, the scene, and every number with the
//               timestamp of the record behind it (src/panel/views/live.js).
//   the actions  the attach whitelist's block and the allowed servers' block, outside
//               the live region so a tick cannot overwrite a half-typed name or an
//               armed remove button (src/panel/views/whitelist.js,
//               src/panel/views/allowed.js). Both blocks' lists are outside too, and
//               the stream refreshes each with an out-of-band swap.
import { escape, heading, list, row } from './html.js'
import { renderAllowedBlock } from './allowed.js'
import { renderLive } from './live.js'
import { renderWhitelistBlock } from './whitelist.js'

// `attach` is the attach whitelist, and `allowed` is the allowed servers, both read by
// the caller. They are separate reads from the facts because they come from the control
// ConfigMap and not from the puppet's log, and because a failure to read one is that
// block's fact, not the card's.
export function renderCard (puppet, facts, attach = null, allowed = null) {
  const name = facts.name
  return [
    '<article class="card" id="puppet-' + escape(name) + '">',
    '  <h2 class="name">' + escape(name) + '</h2>',
    heading('Registry', null, 'this panel\'s own document, no timestamp'),
    list([
      row('namespace', facts.namespace),
      row('deployment', facts.deployment),
      row('front', facts.frontHostname),
      row('control ConfigMap', facts.controlConfigMap)
    ]),
    // hx-ext and sse-connect sit on the element that is NOT replaced: the stream
    // swaps its innerHTML, so the extension stays attached across every tick.
    '  <div class="live" hx-ext="sse" sse-connect="/api/puppets/' + escape(encodeURIComponent(name)) +
      '/stream" sse-swap="message">',
    renderLive(facts, attach, allowed),
    '  </div>',
    '  <section class="actions">',
    renderWhitelistBlock({ puppet, list: attach }),
    renderAllowedBlock({ puppet, list: allowed }),
    '  </section>',
    '</article>',
    ''
  ].join('\n')
}

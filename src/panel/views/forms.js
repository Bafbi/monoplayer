// The card's actions: the one write the panel can make for a puppet, and the one
// block that is not wired yet (#248).
//
// Both forms live outside the live region on purpose. The stream replaces the
// innerHTML of the element beside this one every five seconds, and a tick that
// landed on a half-typed host would lose what the operator was writing.
//
// The write is a plain fetch with a JSON body (src/panel/public/panel.js), not a
// form post. POST /api/puppets/<name>/backend requires
// Content-Type: application/json, and a browser will not send that from an HTML
// form: it is not a safelisted content type, so a cross-origin form post cannot
// produce one without a CORS preflight the panel never grants (#248, #233). The
// page therefore sends exactly what the route demands, and the route is not
// relaxed to accept a form body.
//
// The whitelist block is not here: it is src/panel/views/whitelist.js, which renders
// the entries #232 reads and the two writes that change them.
import { escape } from './html.js'

// The move, in the two fields the route takes. The port is a number in the route's
// contract, and src/panel/public/panel.js sends it as one: the route refuses a
// port that arrives as text rather than coercing it.
export function renderMoveForm (puppet) {
  if (puppet.allowBackendSwitch !== true) {
    return [
      '      <p class="refused">',
      '        move: refused by the registry. <code>' + escape(puppet.name) + '</code> has',
      '        <code>allowBackendSwitch: false</code> in <code>deploy/panel/registry.yaml</code>,',
      '        so the panel will not write a move at all. The lane has a second fence of its own,',
      '        <code>control.allowBackendSwitch</code>, and it decides whether the puppet obeys a',
      '        document that reaches it another way.',
      '      </p>',
      ''
    ].join('\n')
  }
  return [
    '      <form class="write" method="post" action="/api/puppets/' + escape(encodeURIComponent(puppet.name)) + '/backend"',
    '            data-write="backend">',
    '        <label>host <input name="host" autocomplete="off" spellcheck="false" required placeholder="play.example.net"></label>',
    '        <label>port <input name="port" type="number" inputmode="numeric" min="1" max="65535" step="1" required placeholder="25565"></label>',
    '        <button type="submit">move the puppet</button>',
    '        <output class="result" role="status" aria-live="polite"></output>',
    '        <p class="note">Writes <code>desired.json</code> into <code>' +
      escape(puppet.controlConfigMap) + '</code> in <code>' + escape(puppet.namespace) +
      '</code>. The puppet reads it on its next heartbeat, so the move lands within 30 s.',
    '        The body is sent as <code>application/json</code>, which is what the route requires and what',
    '        a cross-origin form post cannot send. The answer below is the write, not the move: it says',
    '        what the API server did.</p>',
    '      </form>',
    ''
  ].join('\n')
}

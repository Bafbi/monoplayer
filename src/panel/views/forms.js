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
// The whitelist block is rendered and refuses. Its route is #232, which is not on
// main, so this page shows what it knows (the count the lane resolved at start,
// from the start record) and names the reason the form is absent. A form that
// posted nowhere would be the alternative, and it would look wired.
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

export function renderWhitelistBlock (puppet, facts) {
  const whitelist = facts.whitelist
  const who = whitelist === null
    ? 'unknown: no start record is in the tail, so the panel cannot say how many entries the lane resolved'
    : whitelist.count + (whitelist.count === 1 ? ' entry' : ' entries') + ' at start (' + whitelist.source +
      (whitelist.at === null || whitelist.at === undefined ? '' : ', ' + whitelist.at) + ')'
  return [
    '      <h3>Who may attach</h3>',
    '      <p class="refused">',
    '        add and remove are unavailable. The write route is issue #232, and it is not on',
    '        <code>main</code> in this branch, so this page renders the block and says so rather than',
    '        showing a form that posts nowhere. When #232 lands, its two routes are what this block',
    '        calls: one JSON POST to add a UUID, one JSON DELETE to remove it, both against the',
    '        ConfigMap named above.',
    '      </p>',
    '      <p class="note">What the page does know: ' + escape(who) + '.',
    '      The list itself is not in the tail, so the panel does not print it.</p>',
    ''
  ].join('\n')
}

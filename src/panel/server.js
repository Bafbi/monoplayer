// The panel's HTTP surface: three routes, and no cluster knowledge.
//
// Nothing here knows about namespaces, tokens, or the API server. The registry
// arrives as a function, so a test hands in a document and a pod hands in the
// mounted ConfigMap, and the routes cannot tell the difference. That is the seam
// the next tickets widen: the first route that reads a pod or patches a ConfigMap
// takes its API client as another injected function, and its test hands in a fake.
//
// `GET /healthz` never touches the registry. It is the probe, so it has to answer
// while the registry is broken; a panel that fails its probe when the document
// cannot be read is a pod that restarts forever instead of showing the operator
// what is wrong. `GET /` and `GET /api/puppets` read it on every request, which is
// why a registry edit needs no restart: the kubelet rewrites the mounted file
// within a minute, and the next request reads the new document.

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

export function createPanelHandler ({ registry, log = () => {} } = {}) {
  if (typeof registry !== 'function') {
    throw new TypeError('createPanelHandler: registry must be a function returning the registry document')
  }

  // The registry read is one place, so a document that fails to parse is a 500
  // that names the reason, on both routes, instead of a stack trace in one and a
  // blank page in the other.
  const read = () => {
    try {
      return { document: registry() }
    } catch (error) {
      const reason = String(error?.message ?? error)
      log('registryUnreadable', { reason })
      return { failure: reason }
    }
  }

  return function handle (req, res) {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]

    // Read today, write later: a write method is refused before the route is
    // looked at, so a future route cannot be reached by the wrong verb by
    // accident.
    if (method !== 'GET') {
      return send(res, 405, TEXT, 'the panel answers GET only\n', { allow: 'GET' })
    }
    if (path === '/healthz') return send(res, 200, JSON_TYPE, '{"ok":true}\n')

    if (path === '/' || path === '/api/puppets') {
      const { document, failure } = read()
      if (failure) return send(res, 500, TEXT, failure + '\n')
      return path === '/'
        ? send(res, 200, HTML, renderPage(document))
        : send(res, 200, JSON_TYPE, JSON.stringify({ version: document.version, puppets: document.puppets }, null, 2) + '\n')
    }

    return send(res, 404, TEXT, 'no such route\n')
  }
}

function send (res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  })
  res.end(body)
}

const escape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

// One page, no asset the browser has to fetch: nothing but this service answers
// on the tailnet name, so a stylesheet or a script would be a request that fails.
export function renderPage ({ version, puppets }) {
  const rows = puppets.map(puppet => [
    '      <tr>',
    '        <th scope="row">' + escape(puppet.name) + '</th>',
    '        <td>' + escape(puppet.namespace) + '</td>',
    '        <td>' + escape(puppet.frontHostname) + '</td>',
    '        <td>' + escape(puppet.backend) + '</td>',
    '        <td>' + escape(puppet.deployment) + '</td>',
    '        <td>' + escape(puppet.controlConfigMap) + '</td>',
    '      </tr>'
  ].join('\n')).join('\n')

  const count = puppets.length === 1 ? '1 puppet' : puppets.length + ' puppets'
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Monoplayer panel</title>',
    '  <style>',
    '    :root { color-scheme: light dark }',
    '    body { margin: 2rem auto; max-width: 60rem; padding: 0 1rem;',
    '      font: 16px/1.5 system-ui, sans-serif }',
    '    h1 { font-size: 1.5rem; margin-bottom: 0.25rem }',
    '    p.count { margin-top: 0; opacity: 0.7 }',
    '    table { border-collapse: collapse; width: 100% }',
    '    th, td { text-align: left; padding: 0.4rem 0.6rem;',
    '      border-bottom: 1px solid currentColor; font-variant-numeric: tabular-nums }',
    '    thead th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;',
    '      opacity: 0.7; border-bottom-width: 2px }',
    '    td, tbody th { font-family: ui-monospace, monospace; font-weight: normal }',
    '    p.note { margin-top: 1.5rem; opacity: 0.7; font-size: 0.9rem }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>Monoplayer panel</h1>',
    '  <p class="count">' + escape(count) + ' in the registry (document version ' + escape(version) + ')</p>',
    '  <table>',
    '    <thead>',
    '      <tr><th scope="col">puppet</th><th scope="col">namespace</th>',
    '        <th scope="col">front</th><th scope="col">backend</th>',
    '        <th scope="col">deployment</th><th scope="col">control</th></tr>',
    '    </thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
    '  <p class="note">This list is the registry: the puppets the panel may touch, and the one',
    '    control ConfigMap it may write per puppet. Nothing else is in reach.</p>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

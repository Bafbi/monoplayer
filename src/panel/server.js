// The panel's HTTP surface: the probe, the registry list, one dispatch line into
// the puppet cards, and one into the write route.
//
// Nothing here knows about namespaces, tokens, or the API server. The registry
// arrives as a function, so a test hands in a document and a pod hands in the
// mounted ConfigMap, and the routes cannot tell the difference. The API client
// arrives the same way, and so do the cards: src/panel/routes/info.js owns every
// route that reads a pod, src/panel/routes/backend.js owns the one that patches a
// move, and src/panel/routes/whitelist.js owns the three that read and write the
// attach whitelist, so this file does not grow a branch per feature (#231, #232,
// #233).
//
// `GET /healthz` never touches the registry. It is the probe, so it has to answer
// while the registry is broken; a panel that fails its probe when the document
// cannot be read is a pod that restarts forever instead of showing the operator
// what is wrong. `GET /`, `GET /api/puppets` and `GET /api/puppets/<name>` read it
// on every request, which is why a registry edit needs no restart: the kubelet
// rewrites the mounted file within a minute, and the next request reads the new
// document.

import { createBackendRoute } from './routes/backend.js'
import { createInfoRoutes } from './routes/info.js'
import { createWhitelistRoute } from './routes/whitelist.js'

const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

export function createPanelHandler ({ registry, kubernetes = null, log = () => {}, now = () => Date.now(), lookup = null } = {}) {
  if (typeof registry !== 'function') {
    throw new TypeError('createPanelHandler: registry must be a function returning the registry document')
  }

  // The registry read is one place, so a document that fails to parse is a 500
  // that names the reason, on every route, instead of a stack trace in one and a
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

  // #231: the puppet cards, as one module and one dispatch line. A route that
  // reads a pod or patches a ConfigMap arrives beside this file, not inside it.
  const info = createInfoRoutes({ read, kubernetes, log, send, now })
  // #233: the one write the panel makes, the same way.
  const backend = createBackendRoute({ read, kubernetes, log, now })
  // #232: the attach whitelist, the same way again.
  const whitelist = createWhitelistRoute({ read, kubernetes, log, now, lookup })

  return async function handle (req, res) {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]

    // #233: the write route dispatches before the read guard and owns its own
    // method check, so the verb it takes is not refused here and the guard still
    // refuses every other write method.
    if (backend.match(path) !== null) return backend.handle(req, res, { method, send })
    if (whitelist.match(path) !== null) return whitelist.handle(req, res, { method, send })

    if (method !== 'GET') {
      return send(res, 405, TEXT, 'the panel answers GET only\n', { allow: 'GET' })
    }
    if (path === '/healthz') return send(res, 200, JSON_TYPE, '{"ok":true}\n')

    if (await info(req, res)) return

    if (path === '/api/puppets') {
      const { document, failure } = read()
      if (failure) return send(res, 500, TEXT, failure + '\n')
      return send(res, 200, JSON_TYPE, JSON.stringify({ version: document.version, puppets: document.puppets }, null, 2) + '\n')
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

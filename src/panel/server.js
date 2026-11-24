// The panel's HTTP surface: the probe, the registry list, its own files, one
// dispatch line into the puppet cards, one into the stream they hold open, and one
// into the write route.
//
// Nothing here knows about namespaces, tokens, or the API server. The registry
// arrives as a function, so a test hands in a document and a pod hands in the
// mounted ConfigMap, and the routes cannot tell the difference. The API client
// arrives the same way, and so do the cards: src/panel/routes/info.js owns every
// route that reads a pod, src/panel/routes/stream.js owns the live region's
// stream, src/panel/assets.js owns the files this page loads,
// src/panel/routes/backend.js owns the one that patches a ConfigMap,
// src/panel/routes/whitelist.js owns the three that read and write the attach
// whitelist, and src/panel/routes/allowed.js owns the three that read and write the
// allowed-server list, so this file does not grow a branch per feature (#231, #232,
// #233, #248, #262).
//
// `GET /healthz` never touches the registry. It is the probe, so it has to answer
// while the registry is broken; a panel that fails its probe when the document
// cannot be read is a pod that restarts forever instead of showing the operator
// what is wrong. `GET /`, `GET /api/puppets` and `GET /api/puppets/<name>` read it
// on every request, which is why a registry edit needs no restart: the kubelet
// rewrites the mounted file within a minute, and the next request reads the new
// document.
//
// The order below is the contract:
//
//   the write route first, because it owns a verb this guard refuses
//   the GET guard, which refuses every other write method
//   the panel's own files, then the stream, then the probes and the reads

import { createAllowedRoute } from './routes/allowed.js'
import { createAssetRoute } from './assets.js'
import { createBackendRoute } from './routes/backend.js'
import { createInfoRoutes } from './routes/info.js'
import { createStreamRoute, HEARTBEAT_MS, TICK_MS } from './routes/stream.js'
import { createWhitelistRoute } from './routes/whitelist.js'

const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

export function createPanelHandler ({
  registry,
  kubernetes = null,
  lookup = null,
  // #248: a recorded document per puppet, or null to read the cluster. The
  // entrypoint sets it only in fixture mode, and only with no ServiceAccount token
  // mounted.
  recorded = null,
  log = () => {},
  now = () => Date.now(),
  // The stream's cadence, in milliseconds. A test shortens it; a pod takes the
  // default, because the page's sentence says five seconds.
  tickMs = TICK_MS,
  heartbeatMs = HEARTBEAT_MS
} = {}) {
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
  const info = createInfoRoutes({ read, kubernetes, recorded, log, send, now })
  // #233: the one write the panel makes, the same way.
  const backend = createBackendRoute({ read, kubernetes, log, now })
  // #232: the attach whitelist, the same way again.
  const whitelist = createWhitelistRoute({ read, kubernetes, log, now, lookup })
  // #262: the allowed-server list, the third control key.
  const allowed = createAllowedRoute({ read, kubernetes, log, now })
  // #248: the live region's stream.
  const stream = createStreamRoute({ read, kubernetes, recorded, log, now, tickMs, heartbeatMs })
  // #248: the page's own files. The tailnet Service is the only thing answering
  // on that name, so the stylesheet, the scripts and the font are served here.
  const assets = createAssetRoute({ log })

  return async function handle (req, res) {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]

    // #233: the write route dispatches before the read guard and owns its own
    // method check, so the verb it takes is not refused here and the guard still
    // refuses every other write method.
    if (backend.match(path) !== null) return backend.handle(req, res, { method, send })
    if (whitelist.match(path) !== null) return whitelist.handle(req, res, { method, send })
    if (allowed.match(path) !== null) return allowed.handle(req, res, { method, send })

    if (method !== 'GET') {
      return send(res, 405, TEXT, 'the panel answers GET only\n', { allow: 'GET' })
    }
    if (path === '/healthz') return send(res, 200, JSON_TYPE, '{"ok":true}\n')

    // A browser asks for an icon on every load, whether or not the page declares
    // one. The panel has none, because no Mojang icon is copied into this repo, so
    // it answers with an empty 204 instead of a 404 that turns up in the console as
    // an error and hides the ones that matter.
    if (path === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      return res.end()
    }

    // Before the router's own 404, and after the guard: an asset is a GET or it is
    // not answered here at all.
    if (assets.match(path) !== null) return assets.handle(req, res, { send })
    if (stream.match(path) !== null) return stream.handle(req, res, { method, send })

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

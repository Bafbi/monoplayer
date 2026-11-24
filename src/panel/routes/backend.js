// POST /api/puppets/:name/backend: the panel's move, and the only write it makes
// today (#233).
//
// The body is `{ host, port }`. What it writes is `desired.json` into the
// puppet's control ConfigMap: the version, the backend, `changedAt` and
// `changedBy`, which is the document the puppet reads on its heartbeat and turns
// into a move that keeps an attached player's connection
// (docs/product-core.md).
//
// Every answer names what a caller has to fix:
//
//   405  a verb this route does not take
//   400  a puppet name that is not valid percent-encoding, a body that is not
//        JSON or does not declare itself JSON, or a host and port a dial cannot
//        target
//   404  no puppet by that name in the registry
//   409  the registry does not let this puppet switch backends
//   413  a body too large to be this request
//   500  the registry itself could not be read
//   503  there is no cluster client, or the cluster refused the patch
//
// This module holds no cluster knowledge. The client arrives injected, the same
// one `src/panel/routes/info.js` reads pods through, so a test hands in a recorder
// and the route cannot tell it from the cluster (#231, #233). It also does not
// decide whether the move is allowed: the registry's `allowBackendSwitch` decides
// whether the panel *asks*, and the puppet's own `control.allowBackendSwitch`
// decides whether it obeys (docs/panel.md).
import { isTargetHost } from '../registry.js'
import { readBody } from './body.js'

// The control document's shape is `src/service/control.js`'s, and this is its
// version. test/panel/backend-route.test.js reads what this route writes back
// through `parseDesiredTarget`, so the two cannot drift apart silently.
export const DESIRED_VERSION = 1
export const DESIRED_KEY = 'desired.json'
// A request body is two small fields. Four kilobytes is generous and still
// refuses a body that is not this request at all.
export const MAX_BODY_BYTES = 4096
const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

const PATTERN = /^\/api\/puppets\/([^/]+)\/backend$/

export function createBackendRoute ({
  read,
  kubernetes = null,
  log = () => {},
  changedBy = 'panel',
  now = () => Date.now()
} = {}) {
  if (typeof read !== 'function') throw new TypeError('createBackendRoute: read must be the registry reader')

  // A path segment that is not valid percent-encoding names no puppet. It is also
  // the one thing here that can throw, and a throw from a request listener ends
  // the process, so the decode is caught and becomes a refusal.
  function match (path) {
    const found = PATTERN.exec(path)
    if (found === null) return null
    try {
      return { name: decodeURIComponent(found[1]), invalid: false }
    } catch {
      return { name: found[1], invalid: true }
    }
  }

  // The handler never rejects: the server calls it from a request event, and a
  // rejection there is an unhandled one that ends the process on a newer Node.
  async function handle (req, res, context) {
    try {
      return await route(req, res, context)
    } catch (error) {
      log('panelRouteFailed', { route: 'backend', error: String(error?.message ?? error).slice(0, 300) })
      try {
        return context.send(res, 500, TEXT, 'the panel failed to answer\n')
      } catch { /* the socket is already gone */ }
    }
  }

  async function route (req, res, { method, send }) {
    if (method !== 'POST') {
      return send(res, 405, TEXT, 'this route answers POST only\n', { allow: 'POST' })
    }
    const found = match((req.url ?? '/').split('?')[0])
    if (found.invalid === true) {
      log('panelBackendInvalidName', { segment: found.name.slice(0, 100) })
      return send(res, 400, TEXT, 'the puppet name in the path is not valid percent-encoding\n')
    }
    // The registry is read on the request, like the read routes: an operator's
    // edit of the puppet list reaches the write path without a restart.
    const { document, failure } = read()
    if (failure) return send(res, 500, TEXT, failure + '\n')
    const puppet = document.puppets.find(entry => entry.name === found.name) ?? null
    if (puppet === null) {
      log('panelBackendUnknownPuppet', { name: found.name })
      return send(res, 404, TEXT, 'no puppet named ' + JSON.stringify(found.name) + ' in the registry\n')
    }
    if (puppet.allowBackendSwitch !== true) {
      // The registry said no, so the panel never writes the document that would
      // ask. The puppet would refuse it too, one heartbeat later, and this is the
      // answer the operator can act on now.
      log('panelBackendRefused', { puppet: puppet.name, reason: 'not_allowed' })
      return send(res, 409, JSON_TYPE, JSON.stringify({
        puppet: puppet.name,
        reason: 'not_allowed',
        detail: 'the registry sets allowBackendSwitch false for this puppet, so the panel will not write a move'
      }, null, 2) + '\n')
    }
    if (kubernetes === null || typeof kubernetes.patchConfigMapKey !== 'function') {
      log('panelBackendNoClient', { puppet: puppet.name })
      return send(res, 503, TEXT, 'the panel has no cluster client, so no document was written\n')
    }
    // A cross-site write is the one attack the tailnet does not stop: the browser
    // is inside it, and the ACL names the user, not the page. A JSON content type
    // is not CORS-safelisted, so a browser sends a preflight first, and this route
    // answers no preflight (405, no allow-origin header), which is what blocks the
    // request. A `text/plain` body would be safelisted and sent with no preflight
    // at all, so it is refused here rather than parsed.
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      log('panelBackendContentType', { contentType: contentType.slice(0, 100) })
      return send(res, 400, TEXT, 'the request body must be sent as application/json\n')
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      log('panelBackendBodyFailed', { puppet: puppet.name, error: String(error?.message ?? error).slice(0, 200) })
      return send(res, 400, TEXT, 'the request body could not be read\n')
    }
    if (body.tooLarge === true) {
      return send(res, 413, TEXT, 'the request body must be at most ' + MAX_BODY_BYTES + ' bytes\n')
    }

    let wanted
    try {
      wanted = JSON.parse(body.text)
    } catch {
      return send(res, 400, TEXT, 'the request body must be JSON: {"host": "...", "port": 25565}\n')
    }
    // The types the document carries, not a coercion of them: a client that sends
    // `"25566"` gets the refusal that says so, and the file the puppet reads never
    // holds a port as text.
    const host = typeof wanted?.host === 'string' ? wanted.host.trim() : ''
    const port = wanted?.port
    if (!isTargetHost(host) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      log('panelBackendInvalid', { puppet: puppet.name, host: host === '' ? null : host, port: Number.isInteger(port) ? port : null })
      return send(res, 400, TEXT,
        'host must be a hostname or an IPv4 address with no scheme and no port, and port must be an integer ' +
        'between 1 and 65535\n')
    }

    const documentToWrite = {
      version: DESIRED_VERSION,
      backend: { host, port },
      changedAt: new Date(now()).toISOString(),
      changedBy
    }
    const text = JSON.stringify(documentToWrite, null, 2) + '\n'
    try {
      await kubernetes.patchConfigMapKey({
        namespace: puppet.namespace,
        name: puppet.controlConfigMap,
        key: DESIRED_KEY,
        text
      })
    } catch (error) {
      const reason = String(error?.message ?? error).slice(0, 300)
      log('panelBackendWriteFailed', { puppet: puppet.name, namespace: puppet.namespace, reason })
      return send(res, 503, TEXT, 'the control document was not written: ' + reason + '\n')
    }
    // The address is the tailnet peer, which is all the panel knows about who
    // asked: the tailnet ACL is the authorization (docs/panel.md).
    log('panelBackendMove', {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      backend: host + ':' + port,
      address: req.socket?.remoteAddress ?? null
    })
    return send(res, 200, JSON_TYPE, JSON.stringify({
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      key: DESIRED_KEY,
      document: documentToWrite
    }, null, 2) + '\n')
  }

  return { match, handle }
}

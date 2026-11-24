// GET, POST and DELETE /api/puppets/:name/allowed-servers: the servers the picker
// offers, written without a restart and without a deploy (#262).
//
// The document is one key of the puppet's control ConfigMap,
// `allowed-servers.json`, in the shape `src/service/control.js` reads:
// `{ "version": 1, "servers": [ { "host", "port", "addedAt" } ] }`. The parser is
// that module's own, not a second copy: the lane reads this file with one rule for
// "cannot parse", and the panel refuses to rewrite what that rule rejects.
//
// **This key has a fallback the other two do not.** A missing or unreadable
// attach whitelist denies a login, which is safe and loud. A missing or unreadable
// server list offers a joining player nothing, so **the lane** offers the copy Git
// commits instead.
//
// This module falls back on an absent key and refuses on a broken one, and the two
// are different facts. A live key that exists and does not parse is a 500 naming the
// file: a panel that listed the seed there would hide the file that needs fixing
// behind an answer that looks normal, and every write would refuse anyway, because a
// rewrite of that document is the one thing this module will not do. An absent key is
// the normal state before the first edit, so a write starts from the seed: an add
// built on an empty document would silently stop offering every committed server.
//
// Every answer names what a caller has to fix:
//
//   405  a verb this route does not take
//   400  a path segment that is not valid percent-decoding, a body that is not JSON
//        or does not declare itself JSON, a host or port a dial cannot target, or a
//        path segment that is not an address
//   404  no puppet by that name in the registry, or no such address in the list
//   409  the patch lost three races
//   413  a body too large to be this request
//   500  the registry could not be read, or the live or seed document could not be
//        parsed
//   503  there is no cluster client, the cluster refused a read or the patch, so
//        either the control ConfigMap or the seed it falls back to is unreachable
//
// Three rules decide the write, and each is a refusal rather than a repair:
//
//   - **a document that does not parse is never rewritten.** The live key and the
//     seed are both parsed before a patch is composed, so a panel cannot shorten a
//     list it did not author.
//   - **a lost race is re-read, not clobbered.** The patch carries the
//     `resourceVersion` it read, and up to MAX_ATTEMPTS patches are tried, each over
//     a fresh read, before the conflict is reported by name.
//   - **a removed server changes nothing that is running.** This route writes one
//     document. Nothing here stops a session on a server that is no longer offered.
//
// This module holds no cluster knowledge. The client arrives injected, the same one
// `routes/whitelist.js` patches a ConfigMap through and `routes/info.js` reads pods
// through, so a test hands in a fake and the route cannot tell it from the cluster.
import { ALLOWED_SERVERS_VERSION, parseAllowedServers } from '../../service/control.js'
import { isTargetHost } from '../registry.js'
import { readBody } from './body.js'
import { configMapYaml } from './whitelist.js'

export const ALLOWED_KEY = 'allowed-servers.json'
// A request body is two small fields.
export const MAX_BODY_BYTES = 4096
// One write that lost a race is retried. Three patches in a row is contention the
// caller should see rather than have the panel keep spinning against.
export const MAX_ATTEMPTS = 3
// Where a human makes the change permanent. The seed key lives in the ConfigMap Git
// owns, so the answer carries the block to paste into the file that holds it.
export const PASTE_INTO = 'deploy/manifests/configmap.yaml'
// Both halves of this are true and neither is obvious: the document is stored, and
// nothing offers it yet. The lane reads the file for its own start record, and the
// picker that puts a row on a client's screen is #265, so the answer says which of
// the two it is rather than letting a 200 read as "offered".
export const WRITTEN_ONLY = 'the document is written. The lane reads this key for its own start record, ' +
  'and nothing offers the list to a client yet: the picker that does is #265. Nothing here stops a running ' +
  'session either: this route writes one key of one ConfigMap. A lane whose MONOPLAYER_ALLOWED_SERVERS names ' +
  'another file does not read this key at all.'

const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

const COLLECTION = /^\/api\/puppets\/([^/]+)\/allowed-servers$/
const ENTRY = /^\/api\/puppets\/([^/]+)\/allowed-servers\/([^/]+)$/

const reason = error => String(error?.message ?? error).slice(0, 300)

// The refusal a parse code stands for, in words an operator can act on. The parser
// answers a code because the lane's log field is a word, not a sentence; the route
// owes the caller the sentence, and `at` names the entry when there is one.
export function refusalText ({ reason: code, at = null }) {
  const where = at === null ? 'the document' : at
  if (code === 'not_json') return 'the document is not JSON'
  if (code === 'not_an_object') return 'the document is not an object'
  if (code === 'version') return 'the document is not version ' + ALLOWED_SERVERS_VERSION
  if (code === 'servers') return 'the document has no servers list'
  if (code === 'server') return where + ' is not an object'
  if (code === 'host') return where + '.host must be a hostname or an IPv4 address'
  if (code === 'port') return where + '.port must be an integer between 1 and 65535'
  if (code === 'duplicate') return where + ' names an address an earlier entry already names'
  return where + ' cannot be read: ' + String(code)
}

// A host and port as one address, which is what a picker row is called (#258).
export function addressOf (server) {
  return server.host + ':' + server.port
}

// `host:port` as a dial target, or null. One rule for the two places an address
// arrives from: a request body and a path segment.
export function targetOf (raw) {
  const text = String(raw ?? '')
  const colon = text.lastIndexOf(':')
  if (colon <= 0 || colon === text.length - 1) return null
  const host = text.slice(0, colon)
  const port = Number(text.slice(colon + 1))
  if (!isTargetHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

const versionOf = configMap => {
  const version = configMap?.metadata?.resourceVersion
  return typeof version === 'string' && version !== '' ? version : null
}

// The list as the document it is, with the version to patch against and the file
// that answered. Two sources, one answer:
//
//   the live key in the control ConfigMap   source: 'control'
//   the seed ConfigMap, when that key is absent   source: 'seed'
//   neither key is written yet   source: 'none', an empty list
//
// It throws for a transport failure and returns `{ failure }` for a document it
// cannot act on. Those are different facts and every caller says which.
export async function readAllowedDocument ({ kubernetes, puppet }) {
  const control = await kubernetes.configMap(puppet.namespace, puppet.controlConfigMap)
  const resourceVersion = versionOf(control)
  const live = control?.data?.[ALLOWED_KEY]
  if (live !== undefined && live !== null) {
    if (typeof live !== 'string') {
      return { failure: 'the ConfigMap key ' + ALLOWED_KEY + ' in ' + puppet.controlConfigMap + ' is not text', resourceVersion }
    }
    const parsed = parseAllowedServers(live)
    if (parsed.reason !== null) return { failure: refusalText(parsed), resourceVersion }
    return { document: { version: ALLOWED_SERVERS_VERSION, servers: parsed.servers }, text: live, resourceVersion, source: 'control' }
  }

  // No live key: the list an unedited lane offers is the one Git commits, and a
  // write must be built on it rather than on nothing.
  const seed = await kubernetes.configMap(puppet.namespace, puppet.seedConfigMap)
  const committed = seed?.data?.[ALLOWED_KEY]
  if (committed === undefined || committed === null) {
    return { document: { version: ALLOWED_SERVERS_VERSION, servers: [] }, text: null, resourceVersion, source: 'none' }
  }
  if (typeof committed !== 'string') {
    return {
      failure: 'the ConfigMap key ' + ALLOWED_KEY + ' in ' + puppet.seedConfigMap + ' is not text',
      resourceVersion
    }
  }
  const parsed = parseAllowedServers(committed)
  if (parsed.reason !== null) {
    return {
      failure: 'the live key is absent and the seed ' + puppet.seedConfigMap + ' cannot be used: ' + refusalText(parsed),
      resourceVersion
    }
  }
  return {
    document: { version: ALLOWED_SERVERS_VERSION, servers: parsed.servers },
    text: committed,
    resourceVersion,
    source: 'seed'
  }
}

// The document as the file the lane reads: two-space JSON and one trailing newline,
// the same bytes `src/service/control.js` is handed everywhere else.
export function allowedText (document) {
  return JSON.stringify(document, null, 2) + '\n'
}

export function createAllowedRoute ({
  read,
  kubernetes = null,
  log = () => {},
  now = () => Date.now()
} = {}) {
  if (typeof read !== 'function') throw new TypeError('createAllowedRoute: read must be the registry reader')

  // A path segment that is not valid percent-encoding names no puppet. The decode is
  // the one thing here that can throw, and a throw from a request listener ends the
  // process, so it is caught and becomes a refusal.
  function match (path) {
    const entry = ENTRY.exec(path)
    if (entry !== null) return segment(entry, true)
    const collection = COLLECTION.exec(path)
    if (collection !== null) return segment(collection, false)
    return null
  }

  function segment (found, entry) {
    try {
      return { name: decodeURIComponent(found[1]), address: entry ? decodeURIComponent(found[2]) : null, invalid: false }
    } catch {
      return { name: found[1], address: null, invalid: true }
    }
  }

  // The handler never rejects. The server calls it from a request event, and a
  // rejection there is an unhandled one that ends the process on a newer Node.
  async function handle (req, res, context) {
    try {
      return await route(req, res, context)
    } catch (error) {
      log('panelRouteFailed', { route: 'allowed', error: reason(error) })
      try {
        return context.send(res, 500, TEXT, 'the panel failed to answer\n')
      } catch { /* the socket is already gone */ }
    }
  }

  async function route (req, res, { method, send }) {
    const found = match((req.url ?? '/').split('?')[0])
    if (found === null) return send(res, 404, TEXT, 'no such route\n')
    if (found.invalid === true) {
      log('panelAllowedInvalidPath', { segment: String(found.name).slice(0, 100) })
      return send(res, 400, TEXT, 'the segment in the path is not valid percent-encoding\n')
    }

    const allowed = found.address === null ? ['GET', 'POST'] : ['DELETE']
    if (!allowed.includes(method)) {
      return send(res, 405, TEXT, 'this route answers ' + allowed.join(' and ') + ' only\n',
        { allow: allowed.join(', ') })
    }

    // The registry is read on the request, like the read routes: an operator's edit
    // of the puppet list reaches the write path without a restart.
    const { document, failure } = read()
    if (failure) return send(res, 500, TEXT, failure + '\n')
    const puppet = document.puppets.find(entry => entry.name === found.name) ?? null
    if (puppet === null) {
      log('panelAllowedUnknownPuppet', { name: found.name })
      return send(res, 404, TEXT, 'no puppet named ' + JSON.stringify(found.name) + ' in the registry\n')
    }

    if (kubernetes === null || typeof kubernetes.configMap !== 'function' ||
        typeof kubernetes.patchConfigMapKey !== 'function') {
      log('panelAllowedNoClient', { puppet: puppet.name })
      return send(res, 503, TEXT, 'the panel has no cluster client, so the allowed-server list was neither read nor written\n')
    }

    if (method === 'GET') return list(req, res, { send }, puppet)
    if (method === 'DELETE') return remove(req, res, { send }, puppet, found.address)
    return add(req, res, { send }, puppet)
  }

  function unreadable (res, send, puppet, failure) {
    log('panelAllowedUnreadable', {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      seedConfigMap: puppet.seedConfigMap,
      reason: failure
    })
    return send(res, 500, TEXT, 'the allowed-server list was not touched: ' + failure + '\n')
  }

  async function readDocument (puppet) {
    return readAllowedDocument({ kubernetes, puppet })
  }

  async function list (req, res, { send }, puppet) {
    let current
    try {
      current = await readDocument(puppet)
    } catch (error) {
      log('panelAllowedReadFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
      return send(res, 503, TEXT, 'the allowed-server list could not be read: ' + reason(error) + '\n')
    }
    if (current.failure) return unreadable(res, send, puppet, current.failure)
    return send(res, 200, JSON_TYPE, JSON.stringify(summary(puppet, current), null, 2) + '\n')
  }

  async function add (req, res, { send }, puppet) {
    // A cross-site write is the one attack the tailnet does not stop: the browser is
    // inside it, and the ACL names the user, not the page. A JSON content type is not
    // CORS-safelisted, so a browser sends a preflight first and this route answers no
    // preflight. A `text/plain` body would be safelisted and arrive unannounced, so
    // it is refused here rather than parsed.
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      log('panelAllowedContentType', { puppet: puppet.name, contentType: contentType.slice(0, 100) })
      return send(res, 400, TEXT, 'the request body must be sent as application/json\n')
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      log('panelAllowedBodyFailed', { puppet: puppet.name, error: reason(error) })
      return send(res, 400, TEXT, 'the request body could not be read\n')
    }
    if (body.tooLarge === true) {
      return send(res, 413, TEXT, 'the request body must be at most ' + MAX_BODY_BYTES + ' bytes\n')
    }

    let wanted
    try {
      wanted = JSON.parse(body.text)
    } catch {
      return send(res, 400, TEXT, 'the request body must be JSON: {"host": "paper.example.net", "port": 25565}\n')
    }
    // The types the document carries, not a coercion of them: a client that sends
    // `"25565"` gets the refusal that says so, and the file the lane reads never
    // holds a port as text.
    const host = typeof wanted?.host === 'string' ? wanted.host.trim() : ''
    const port = wanted?.port
    if (!isTargetHost(host) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      log('panelAllowedInvalid', { puppet: puppet.name, host: host === '' ? null : host, port: Number.isInteger(port) ? port : null })
      return send(res, 400, TEXT,
        'host must be a hostname or an IPv4 address with no scheme and no port, and port must be an integer ' +
        'between 1 and 65535\n')
    }

    return write(req, res, { send }, puppet, { action: 'add', target: { host, port } })
  }

  async function remove (req, res, { send }, puppet, rawAddress) {
    const target = targetOf(rawAddress)
    if (target === null) {
      return send(res, 400, TEXT, 'the address in the path must be host:port, with a host a dial can target ' +
        'and a port between 1 and 65535\n')
    }
    return write(req, res, { send }, puppet, { action: 'remove', target })
  }

  // The read-modify-write, and the only place a document is replaced. Each attempt
  // starts from a fresh read, so a retry applies this change to the document the
  // other writer left rather than to the one this attempt started from.
  async function write (req, res, { send }, puppet, { action, target }) {
    const event = action === 'add' ? 'panelAllowedServerAdd' : 'panelAllowedServerRemove'
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let current
      try {
        current = await readDocument(puppet)
      } catch (error) {
        log('panelAllowedReadFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
        return send(res, 503, TEXT, 'the allowed-server list could not be read: ' + reason(error) + '\n')
      }
      if (current.failure) return unreadable(res, send, puppet, current.failure)

      const change = mutate(current, { action, target, addedAt: new Date(now()).toISOString() })
      if (change.absent === true) {
        log('panelAllowedAbsent', { puppet: puppet.name, server: addressOf(target) })
        return send(res, 404, TEXT, 'no entry for ' + addressOf(target) + ' in the allowed-server list of ' +
          JSON.stringify(puppet.name) + ', so nothing was removed\n')
      }
      if (change.changed === false) {
        return answer(req, res, send, puppet, event, current, {
          changed: false, target, attempt, action, record: change.record ?? null
        })
      }

      const document = { version: ALLOWED_SERVERS_VERSION, servers: change.servers }
      const text = allowedText(document)
      try {
        const patched = await kubernetes.patchConfigMapKey({
          namespace: puppet.namespace,
          name: puppet.controlConfigMap,
          key: ALLOWED_KEY,
          text,
          resourceVersion: current.resourceVersion
        })
        return answer(req, res, send, puppet, event, {
          ...current,
          document,
          source: 'control',
          resourceVersion: patched?.resourceVersion ?? current.resourceVersion
        }, { changed: true, target, attempt, action, record: change.record ?? null })
      } catch (error) {
        const status = error?.status ?? 0
        if (status === 409 && attempt < MAX_ATTEMPTS) {
          // Somebody else's write landed between this attempt's read and its patch.
          log('panelAllowedRace', { puppet: puppet.name, server: addressOf(target), attempt })
          continue
        }
        if (status === 409) {
          log('panelAllowedConflict', { puppet: puppet.name, server: addressOf(target), attempts: attempt })
          return send(res, 409, JSON_TYPE, JSON.stringify({
            puppet: puppet.name,
            server: addressOf(target),
            reason: 'conflict',
            attempts: attempt,
            detail: 'somebody else wrote this allowed-server list ' + attempt + ' times while the panel was writing it: ' +
              reason(error)
          }, null, 2) + '\n')
        }
        log('panelAllowedWriteFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
        return send(res, 503, TEXT, 'the allowed-server list was not written: ' + reason(error) + '\n')
      }
    }
    // MAX_ATTEMPTS is above one, so the loop always returns.
    return send(res, 409, TEXT, 'the allowed-server list changed under the panel on every attempt\n')
  }

  // One server added, or one removed, over a document that is otherwise untouched.
  // An add of an address that is already there rewrites nothing, which makes a
  // retried request and a double click the same request.
  function mutate (current, { action, target, addedAt }) {
    const servers = Array.isArray(current.document.servers) ? current.document.servers : []
    const wanted = target.host.toLowerCase() + ':' + target.port
    const index = servers.findIndex(entry => entry.host.toLowerCase() + ':' + entry.port === wanted)
    if (action === 'remove') {
      if (index === -1) return { absent: true }
      return { changed: true, servers: servers.filter((_, at) => at !== index), record: servers[index] }
    }
    if (index !== -1) return { changed: false, servers, record: servers[index] }
    const record = { host: target.host, port: target.port, addedAt }
    return { changed: true, servers: [...servers, record], record }
  }

  function summary (puppet, current) {
    return {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      seedConfigMap: puppet.seedConfigMap,
      key: ALLOWED_KEY,
      source: current.source,
      resourceVersion: current.resourceVersion ?? null,
      count: current.document.servers.length,
      servers: current.document.servers,
      document: current.document
    }
  }

  function answer (req, res, send, puppet, event, current, { changed, target, attempt, action, record }) {
    const body = {
      ...summary(puppet, current),
      changed,
      server: addressOf(target),
      // A removal answers with the entry it dropped, so a caller can put it back.
      ...(action === 'remove' ? { removed: record } : {}),
      attempts: attempt,
      takesEffect: WRITTEN_ONLY,
      pasteInto: PASTE_INTO,
      yaml: configMapYaml(allowedText(current.document), ALLOWED_KEY)
    }
    // The audit line, which is the record the ConfigMap cannot keep because it holds
    // no history. The address is the tailnet peer, the only actor the panel can name
    // (the ACL is the authorization, docs/panel.md).
    log(event, {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      key: ALLOWED_KEY,
      server: addressOf(target),
      source: current.source,
      count: current.document.servers.length,
      changed,
      attempts: attempt,
      address: req.socket?.remoteAddress ?? null
    })
    return send(res, 200, JSON_TYPE, JSON.stringify(body, null, 2) + '\n')
  }

  return { match, handle }
}

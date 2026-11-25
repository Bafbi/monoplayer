// GET, POST and DELETE /api/puppets/:name/whitelist: the entries the front leg
// admits, written without a restart and without a deploy (#232).
//
// The document is the one the puppet already reads: `attach-whitelist.json`, one
// key of the control ConfigMap the registry names, in the shape
// `src/custody/store.js` writes, which is
// `{ "version": 1, "players": [ { "uuid", "name", "addedAt" } ] }`. No second
// shape and no second key, so the puppet needs nothing new to read what the panel
// writes.
//
// Every answer names what a caller has to fix:
//
//   405  a verb this route does not take
//   400  a path segment that is not valid percent-encoding, a body that is not
//        JSON or does not declare itself JSON, neither a uuid nor a name, both of
//        them, a uuid that is not a Minecraft one, or a name the resolver could
//        not turn into one, because the panel asks for the uuid rather than
//        failing on a name it could not resolve
//   404  no puppet by that name in the registry, or no such uuid in its attach
//        whitelist
//   409  the uuid is the puppet's own account, or the patch lost three races
//   413  a body too large to be this request
//   500  the registry could not be read, or the document could not be parsed
//   503  there is no cluster client, the cluster refused a read or the patch, or
//        the puppet's Deployment names no uuid to check the document against
//
// Three rules decide the write, and each is a refusal rather than a repair:
//
//   - **a document that does not parse is never rewritten.** This module parses
//     strictly where `src/custody/store.js` parses leniently. That reader drops an
//     entry it cannot use and keeps going, which is right for a login and wrong
//     for a rewrite: a panel that dropped an entry would delete a player from the
//     attach whitelist on its next patch.
//   - **a lost race is re-read, not clobbered.** The patch carries the
//     `resourceVersion` that was read, so the API server answers 409 for a write
//     based on a document somebody else already replaced. Up to MAX_ATTEMPTS
//     patches are tried, each over a fresh read, and then the conflict is
//     reported by name.
//   - **the puppet's own uuid never enters the list.** The uuid is the one the
//     puppet's own Deployment sets in MONOPLAYER_PUPPET_UUID, which is the object
//     that already asserts the account, and it appears in neither an answer nor a
//     log line. The caller sent a uuid, and that is the one worth printing.
//
// This module holds no cluster knowledge. The client arrives injected, the same one
// `src/panel/routes/info.js` reads pods through and `routes/allowed.js` patches a
// ConfigMap through, so a test hands in a fake and the route cannot tell it from the
// cluster (#231, #233, #262).
import { createNameLookup, WHITELIST_VERSION } from '../../custody/store.js'
import { normalizeUuid } from '../../custody/util.js'
import { containerEnv } from '../kube.js'
import { readBody } from './body.js'

export const WHITELIST_KEY = 'attach-whitelist.json'
// The variable the puppet's Deployment sets to its own account's uuid. It is the
// rule's source, not a second copy of the constant: the value lives in
// `deploy/manifests/deployment.yaml` and nowhere in this module.
export const PUPPET_UUID_VARIABLE = 'MONOPLAYER_PUPPET_UUID'
// A request body is one uuid or one name. Four kilobytes is generous and still
// refuses a body that is not this request at all.
export const MAX_BODY_BYTES = 4096
// One write that lost a race is retried. Three patches in a row is contention the
// caller should see rather than have the panel keep spinning against.
export const MAX_ATTEMPTS = 3
// Where a human makes the change permanent. The control ConfigMap is not in Git by
// design (deploy/panel/registry.yaml), so the answer carries the block to paste into
// the file that is.
export const PASTE_INTO = 'deploy/manifests/configmap.yaml'
// The puppet re-reads the file at each login (#229), so no restart and no deploy sit
// between a write and its effect. Both halves of that sentence are true and neither
// is obvious, so the answer says them. So does the condition underneath: a lane that
// names another file reads none of this.
export const TAKES_EFFECT = 'the puppet re-reads this file at each login, so the change takes effect on the ' +
  'next login with no restart and no deploy. A client that is mid-login now may be picked up on the following ' +
  'attempt. A lane whose MONOPLAYER_ATTACH_WHITELIST names another file does not read this key at all.'

const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

const COLLECTION = /^\/api\/puppets\/([^/]+)\/whitelist$/
const ENTRY = /^\/api\/puppets\/([^/]+)\/whitelist\/([^/]+)$/

const reason = error => String(error?.message ?? error).slice(0, 300)

// The document as a document, or the reason it cannot be acted on. Strict on
// purpose: see the header. Unknown keys are kept, because the panel rewrites one
// entry of a file it did not author. Dropping a field it does not recognise would be
// the clobber this whole module refuses to do.
export function parseWhitelist (text) {
  let doc
  try {
    doc = JSON.parse(String(text))
  } catch (error) {
    return { failure: 'the document is not JSON: ' + reason(error) }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { failure: 'the document is not an object' }
  }
  if (doc.version !== WHITELIST_VERSION) {
    return { failure: 'the document is version ' + JSON.stringify(doc.version ?? null) +
      ', and this panel writes version ' + WHITELIST_VERSION }
  }
  if (!Array.isArray(doc.players)) return { failure: 'the document has no players list' }
  for (const [index, entry] of doc.players.entries()) {
    const where = 'players[' + index + ']'
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { failure: where + ' is not an object' }
    }
    if (normalizeUuid(entry.uuid) === null) return { failure: where + '.uuid is not a Minecraft uuid' }
    if (entry.name !== undefined && entry.name !== null && typeof entry.name !== 'string') {
      return { failure: where + '.name is not a string' }
    }
    if (entry.addedAt !== undefined && entry.addedAt !== null && typeof entry.addedAt !== 'string') {
      return { failure: where + '.addedAt is not a string' }
    }
  }
  return { document: doc }
}

// The document as the file the puppet reads: two-space JSON and one trailing
// newline, which is what `src/custody/store.js` persists and what the ConfigMap
// ships today.
export function whitelistText (document) {
  return JSON.stringify(document, null, 2) + '\n'
}

// The `data:` block of `deploy/manifests/configmap.yaml`, holding this document.
// The object's name is the Git file's business. The registry names the control
// ConfigMap, and printing that name here would have a human paste a second object
// into Git.
export function configMapYaml (text, key = WHITELIST_KEY) {
  const body = String(text).replace(/\n$/, '').split('\n').map(line => '    ' + line).join('\n')
  return 'data:\n  ' + key + ': |\n' + body + '\n'
}

// The attach whitelist as the document it is, with the version it was read at. One
// reader, two callers: the routes above rewrite it, and the page's stream renders the
// list from it (#248). A second copy of "no key means an empty list" is a second
// copy to keep true, and this is the rule that decides whether an absent key is an
// error or an empty allow-list.
//
// It throws for a transport failure and returns `{ failure }` for a document it
// cannot act on. The two are different facts, and every caller says which.
export async function readWhitelistDocument ({ kubernetes, puppet }) {
  const configMap = await kubernetes.configMap(puppet.namespace, puppet.controlConfigMap)
  const resourceVersion = typeof configMap?.metadata?.resourceVersion === 'string' &&
    configMap.metadata.resourceVersion !== '' ? configMap.metadata.resourceVersion : null
  const text = configMap?.data?.[WHITELIST_KEY]
  if (text === undefined || text === null) {
    // `kubectl create configmap --from-file` may have created the object with only
    // the key another reader uses. No key is an empty attach whitelist, and the next
    // patch creates it. A merge patch of one key never disturbs the others.
    return { document: { version: WHITELIST_VERSION, players: [] }, text: null, resourceVersion }
  }
  if (typeof text !== 'string') {
    return { failure: 'the ConfigMap key ' + WHITELIST_KEY + ' is not text', resourceVersion }
  }
  const parsed = parseWhitelist(text)
  if (parsed.failure) return { failure: parsed.failure, resourceVersion }
  return { ...parsed, text, resourceVersion }
}

// The same read, as the fact the page renders: a document, or the sentence that says
// why there is none, with the instant it was read at. It never throws, so a stream tick
// or a page render can carry a failed read without losing the rest of the card (#248).
export async function readAttachList ({ kubernetes, puppet, now = Date.now(), log = () => {} }) {
  const observedAt = new Date(now).toISOString()
  if (kubernetes === null || kubernetes === undefined || typeof kubernetes.configMap !== 'function') {
    return { failure: 'the panel has no cluster client, so the attach whitelist was not read', observedAt }
  }
  try {
    const read = await readWhitelistDocument({ kubernetes, puppet })
    return { ...read, observedAt }
  } catch (error) {
    log('attachListReadFailed', {
      puppet: puppet.name,
      controlConfigMap: puppet.controlConfigMap,
      reason: String(error?.message ?? error).slice(0, 200)
    })
    return { failure: String(error?.message ?? error).slice(0, 300), observedAt }
  }
}

export function createWhitelistRoute ({
  read,
  kubernetes = null,
  log = () => {},
  now = () => Date.now(),
  lookup = null
} = {}) {
  if (typeof read !== 'function') throw new TypeError('createWhitelistRoute: read must be the registry reader')
  // The resolver the custody store uses (#232): Minecraft services, then the legacy
  // Mojang API. Tests inject one. The real one needs egress from the panel namespace,
  // which is why a failed lookup asks for a uuid instead of guessing.
  const resolveName = typeof lookup === 'function' ? lookup : createNameLookup()

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
      return {
        name: decodeURIComponent(found[1]),
        uuid: entry ? decodeURIComponent(found[2]) : null,
        invalid: false
      }
    } catch {
      return { name: found[1], uuid: null, invalid: true }
    }
  }

  // The handler never rejects. The server calls it from a request event, and a
  // rejection there is an unhandled one that ends the process on a newer Node.
  async function handle (req, res, context) {
    try {
      return await route(req, res, context)
    } catch (error) {
      log('panelRouteFailed', { route: 'whitelist', error: reason(error) })
      try {
        return context.send(res, 500, TEXT, 'the panel failed to answer\n')
      } catch { /* the socket is already gone */ }
    }
  }

  async function route (req, res, { method, send }) {
    const found = match((req.url ?? '/').split('?')[0])
    if (found === null) return send(res, 404, TEXT, 'no such route\n')
    if (found.invalid === true) {
      log('panelWhitelistInvalidPath', { segment: String(found.name).slice(0, 100) })
      return send(res, 400, TEXT, 'the segment in the path is not valid percent-encoding\n')
    }

    const allowed = found.uuid === null ? ['GET', 'POST'] : ['DELETE']
    if (!allowed.includes(method)) {
      // A DELETE arrives with no body, and a browser cannot send one from a form, so
      // the verb is its own guard there. The verbs this shape does take are named so
      // a caller can fix the request.
      return send(res, 405, TEXT, 'this route answers ' + allowed.join(' and ') + ' only\n',
        { allow: allowed.join(', ') })
    }

    // The registry is read on the request, like the read routes: an operator's edit
    // of the puppet list reaches the write path without a restart.
    const { document, failure } = read()
    if (failure) return send(res, 500, TEXT, failure + '\n')
    const puppet = document.puppets.find(entry => entry.name === found.name) ?? null
    if (puppet === null) {
      log('panelWhitelistUnknownPuppet', { name: found.name })
      return send(res, 404, TEXT, 'no puppet named ' + JSON.stringify(found.name) + ' in the registry\n')
    }

    if (kubernetes === null || typeof kubernetes.configMap !== 'function' ||
        typeof kubernetes.patchConfigMapKey !== 'function') {
      log('panelWhitelistNoClient', { puppet: puppet.name })
      return send(res, 503, TEXT, 'the panel has no cluster client, so the attach whitelist was neither read nor written\n')
    }

    if (method === 'GET') return list(req, res, { send }, puppet)
    if (method === 'DELETE') return remove(req, res, { send }, puppet, found.uuid)
    return add(req, res, { send }, puppet)
  }

  // The ConfigMap's attach whitelist key, parsed. The whole object is read because
  // the patch needs its resourceVersion, and no other key is touched at any point.
  async function readDocument (puppet) {
    return readWhitelistDocument({ kubernetes, puppet })
  }

  function readable (res, send, puppet, failure) {
    log('panelWhitelistUnreadable', {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      reason: failure
    })
    return send(res, 500, TEXT, 'the attach whitelist document was not touched: ' + failure + '\n')
  }

  async function list (req, res, { send }, puppet) {
    let current
    try {
      current = await readDocument(puppet)
    } catch (error) {
      log('panelWhitelistReadFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
      return send(res, 503, TEXT, 'the attach whitelist could not be read: ' + reason(error) + '\n')
    }
    if (current.failure) return readable(res, send, puppet, current.failure)
    return send(res, 200, JSON_TYPE, JSON.stringify(summary(puppet, current, current.document.players), null, 2) + '\n')
  }

  // The uuid the puppet's own account holds, out of the Deployment that asserts it.
  async function ownUuid (puppet) {
    const deployment = await kubernetes.deployment(puppet.namespace, puppet.deployment)
    return normalizeUuid(containerEnv(deployment).get(PUPPET_UUID_VARIABLE))
  }

  async function add (req, res, { send }, puppet) {
    // A cross-site write is the one attack the tailnet does not stop: the browser is
    // inside it, and the ACL names the user, not the page. A JSON content type is not
    // CORS-safelisted, so a browser sends a preflight first and this route answers no
    // preflight, which is what blocks the request. A `text/plain` body would be
    // safelisted and arrive unannounced, so it is refused here rather than parsed.
    // This requirement is the whole CSRF guard, and there is no header check behind it.
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      log('panelWhitelistContentType', { puppet: puppet.name, contentType: contentType.slice(0, 100) })
      return send(res, 400, TEXT, 'the request body must be sent as application/json\n')
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      log('panelWhitelistBodyFailed', { puppet: puppet.name, error: reason(error) })
      return send(res, 400, TEXT, 'the request body could not be read\n')
    }
    if (body.tooLarge === true) {
      return send(res, 413, TEXT, 'the request body must be at most ' + MAX_BODY_BYTES + ' bytes\n')
    }

    let wanted
    try {
      wanted = JSON.parse(body.text)
    } catch {
      return send(res, 400, TEXT, 'the request body must be JSON: {"uuid": "..."} or {"name": "..."}\n')
    }
    const rawUuid = typeof wanted?.uuid === 'string' ? wanted.uuid.trim() : null
    const rawName = typeof wanted?.name === 'string' ? wanted.name.trim() : null
    if (rawUuid !== null && rawName !== null) {
      return send(res, 400, TEXT, 'send a uuid or a name, not both\n')
    }
    if (rawUuid === null && rawName === null) {
      return send(res, 400, TEXT, 'the request body must carry a uuid or a name: {"uuid": "..."} or {"name": "..."}\n')
    }

    let uuid = rawUuid === null ? null : normalizeUuid(rawUuid)
    let name = rawUuid === null ? null : rawName
    if (rawUuid !== null && uuid === null) {
      return send(res, 400, TEXT, 'uuid must be a Minecraft account uuid, dashed or undashed\n')
    }
    if (uuid === null) {
      let resolved
      try {
        resolved = await resolveName(rawName)
      } catch (error) {
        log('panelWhitelistLookupFailed', { puppet: puppet.name, name: rawName, reason: reason(error) })
        return send(res, 400, TEXT, 'the name could not be resolved from the panel namespace, so send the uuid instead\n')
      }
      if (resolved === null) {
        log('panelWhitelistUnknownName', { puppet: puppet.name, name: rawName })
        return send(res, 400, TEXT, 'no Minecraft account is named ' + JSON.stringify(rawName) +
          ', so send the uuid instead\n')
      }
      if (resolved?.failed) {
        log('panelWhitelistLookupFailed', { puppet: puppet.name, name: rawName, reason: String(resolved.reason ?? '').slice(0, 120) })
        return send(res, 400, TEXT, 'the name could not be resolved: the Mojang endpoints answered nothing from the ' +
          'panel namespace, so send the uuid instead\n')
      }
      uuid = normalizeUuid(resolved?.uuid)
      if (uuid === null) {
        log('panelWhitelistLookupInvalid', { puppet: puppet.name, name: rawName })
        return send(res, 400, TEXT, 'the resolver answered something that is not a uuid, so send the uuid instead\n')
      }
      name = typeof resolved?.name === 'string' && resolved.name.trim() !== '' ? resolved.name.trim() : rawName
    }

    let own
    try {
      own = await ownUuid(puppet)
    } catch (error) {
      // The rule cannot be applied without it, and a panel that skipped a rule
      // silently is worse than one that refuses.
      log('panelWhitelistOwnUuidUnreadable', { puppet: puppet.name, deployment: puppet.deployment, reason: reason(error) })
      return send(res, 503, TEXT, 'the attach whitelist was not written: the puppet\'s own uuid could not be read from ' +
        'Deployment ' + puppet.namespace + '/' + puppet.deployment + ': ' + reason(error) + '\n')
    }
    if (own === null) {
      // start-live resolves the account from custody when the variable is unset, so
      // the panel cannot compare against anything. Refusing keeps the rule total, and
      // the fix is one line of the puppet's own Deployment.
      log('panelWhitelistOwnUuidUnknown', { puppet: puppet.name, deployment: puppet.deployment, reason: 'no_puppet_uuid' })
      return send(res, 503, TEXT, 'the attach whitelist was not written: Deployment ' +
        puppet.namespace + '/' + puppet.deployment + ' names no ' + PUPPET_UUID_VARIABLE +
        ', so the panel cannot check that this is not the puppet\'s own uuid. Set it, then send this again\n')
    }
    if (own === uuid) {
      // The uuid is not printed here. It is the puppet's account identifier, and the
      // rule this refusal enforces is that it appears nowhere the panel writes. The
      // caller already knows what it sent.
      log('panelWhitelistOwnUuid', { puppet: puppet.name, reason: 'puppet_uuid' })
      return send(res, 409, TEXT, 'that uuid is the puppet\'s own account, and the attach whitelist it gates ' +
        'must never admit the puppet itself\n')
    }

    return write(req, res, { send }, puppet, { action: 'add', uuid, name })
  }

  async function remove (req, res, { send }, puppet, rawUuid) {
    const uuid = normalizeUuid(rawUuid)
    if (uuid === null) {
      return send(res, 400, TEXT, 'the uuid in the path is not a Minecraft account uuid, dashed or undashed\n')
    }
    return write(req, res, { send }, puppet, { action: 'remove', uuid, name: null })
  }

  // The read-modify-write, and the only place a document is replaced. Each attempt
  // starts from a fresh read, so a retry applies the change to the document the other
  // writer left rather than to the one this attempt started from.
  async function write (req, res, { send }, puppet, { action, uuid, name }) {
    const event = action === 'add' ? 'panelWhitelistAdd' : 'panelWhitelistRemove'
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let current
      try {
        current = await readDocument(puppet)
      } catch (error) {
        log('panelWhitelistReadFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
        return send(res, 503, TEXT, 'the attach whitelist could not be read: ' + reason(error) + '\n')
      }
      if (current.failure) return readable(res, send, puppet, current.failure)

      const change = mutate(current, { action, uuid, name, addedAt: new Date(now()).toISOString() })
      if (change.absent === true) {
        log('panelWhitelistAbsent', { puppet: puppet.name, uuid })
        return send(res, 404, TEXT, 'no entry for ' + uuid + ' in the attach whitelist of ' +
          JSON.stringify(puppet.name) + ', so nothing was removed\n')
      }
      if (change.changed === false) {
        return answer(req, res, send, puppet, event, current, current.document.players, {
          changed: false, uuid, name: change.record?.name ?? name, attempt, action
        })
      }

      const document = { ...current.document, version: WHITELIST_VERSION, players: change.players }
      const text = whitelistText(document)
      try {
        const patched = await kubernetes.patchConfigMapKey({
          namespace: puppet.namespace,
          name: puppet.controlConfigMap,
          key: WHITELIST_KEY,
          text,
          resourceVersion: current.resourceVersion
        })
        return answer(req, res, send, puppet, event, {
          ...current,
          document,
          resourceVersion: patched?.resourceVersion ?? current.resourceVersion
        }, change.players, { changed: true, uuid, name: change.record?.name ?? name, attempt, action, record: change.record })
      } catch (error) {
        const status = error?.status ?? 0
        if (status === 409 && attempt < MAX_ATTEMPTS) {
          // Somebody else's write landed between this attempt's read and its patch.
          // The next attempt reads what they left and applies this change on top.
          log('panelWhitelistRace', { puppet: puppet.name, uuid, attempt })
          continue
        }
        if (status === 409) {
          log('panelWhitelistConflict', { puppet: puppet.name, uuid, attempts: attempt })
          return send(res, 409, JSON_TYPE, JSON.stringify({
            puppet: puppet.name,
            uuid,
            reason: 'conflict',
            attempts: attempt,
            detail: 'somebody else wrote this attach whitelist ' + attempt + ' times while the panel was writing it: ' +
              reason(error)
          }, null, 2) + '\n')
        }
        log('panelWhitelistWriteFailed', { puppet: puppet.name, controlConfigMap: puppet.controlConfigMap, reason: reason(error) })
        return send(res, 503, TEXT, 'the attach whitelist was not written: ' + reason(error) + '\n')
      }
    }
    // MAX_ATTEMPTS is above one, so the loop always returns.
    return send(res, 409, TEXT, 'the attach whitelist changed under the panel on every attempt\n')
  }

  // One entry added, or one removed, over a document that is otherwise untouched. An
  // add of a uuid that is already there rewrites nothing, which makes a retried
  // request and a double click the same request.
  function mutate (current, { action, uuid, name, addedAt }) {
    const players = Array.isArray(current.document.players) ? current.document.players : []
    const index = players.findIndex(entry => normalizeUuid(entry?.uuid) === uuid)
    if (action === 'remove') {
      if (index === -1) return { absent: true }
      return { changed: true, players: players.filter((_, at) => at !== index), record: players[index] }
    }
    if (index !== -1) return { changed: false, players, record: players[index] }
    const record = { uuid, name: name ?? null, addedAt }
    return { changed: true, players: [...players, record], record }
  }

  function summary (puppet, current, players) {
    return {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      key: WHITELIST_KEY,
      resourceVersion: current.resourceVersion ?? null,
      count: players.length,
      document: { ...current.document, version: WHITELIST_VERSION, players }
    }
  }

  function answer (req, res, send, puppet, event, current, players, { changed, uuid, name, attempt, action, record = null }) {
    const body = {
      ...summary(puppet, current, players),
      changed,
      uuid,
      name: name ?? null,
      // A removal answers with the entry it dropped, so a caller can put it back.
      ...(action === 'remove' ? { removed: record } : {}),
      attempts: attempt,
      takesEffect: TAKES_EFFECT,
      pasteInto: PASTE_INTO,
      yaml: configMapYaml(whitelistText({ ...current.document, version: WHITELIST_VERSION, players }))
    }
    // The audit line, which is the record the ConfigMap cannot keep because it holds
    // no history. The address is the tailnet peer, the only actor the panel can name
    // (the ACL is the authorization, docs/panel.md).
    log(event, {
      puppet: puppet.name,
      namespace: puppet.namespace,
      controlConfigMap: puppet.controlConfigMap,
      key: WHITELIST_KEY,
      uuid,
      name: name ?? null,
      count: players.length,
      changed,
      attempts: attempt,
      address: req.socket?.remoteAddress ?? null
    })
    return send(res, 200, JSON_TYPE, JSON.stringify(body, null, 2) + '\n')
  }

  return { match, handle }
}

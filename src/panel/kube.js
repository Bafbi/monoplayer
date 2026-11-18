// The panel's path to the cluster: four reads, and one write.
//
// The panel reads what the puppet already says about itself, and it reaches that
// through the API server for one reason: the pod's log. The registry names a
// Deployment; the Deployment names its pods in `spec.selector.matchLabels`, so
// the reads are a Deployment, a pod list, and one pod's log. No discovery, no
// label the operator did not write.
//
// The fourth read is the control ConfigMap itself (#232). The attach whitelist
// route rewrites one key of it, so it reads the document and its `resourceVersion`
// first and patches with that version as a precondition. The object is the one the
// registry names, so a read and a write can never name two different ConfigMaps.
//
// Credentials are the pod's own ServiceAccount: the token file and the CA the
// kubelet mounts. Both are read per request, because the kubelet rotates the
// token, and a client that cached it would start failing an hour into a pod's
// life with a message about a cluster nobody changed.
//
// `request` is injected. The default is one `node:https` call; a test hands in a
// function that records the path and answers bytes, so the panel's tests need no
// cluster, no certificate, and no token. There is no Kubernetes client package
// in this repo and none is added: four requests are four requests.
//
// The one write is a JSON merge patch on one key of one ConfigMap (#233). It lives
// here because this module is where the token, the CA and the API base are read,
// and a second transport would be a second copy of all three. What it cannot touch
// is still decided elsewhere and unchanged: the registry names the one ConfigMap,
// and role.yaml grants `patch` on that name and no other object.

import fs from 'node:fs'
import https from 'node:https'

export const BASE_URL = 'https://kubernetes.default.svc'
export const TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token'
export const CA_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
// The container the proxy runs as, in the same image as the panel.
export const CONTAINER = 'monoplayer'
// The window the page reads. One heartbeat every 30 s, so this is more than an
// hour of a quiet lane and a few minutes of a busy one.
export const TAIL_LINES = 400
// A page that waits on a hung API server is a page that never shows why. The
// bottom of the panel's own stop grace is 5 s.
export const TIMEOUT_MS = 5_000

// A read the panel could not complete, with the status the API server answered
// when there was one. The route turns this into the sentence the card shows, so
// "refused" and "unreachable" stay different facts.
export class ReadRefused extends Error {
  constructor (message, { status = 0 } = {}) {
    super(message)
    this.name = 'ReadRefused'
    this.status = status
  }
}

// The same fact for the write, under its own name: a card says what it could not
// read, and a route says what it could not write. One class would put the word
// "read" in the failure of a request that wrote.
export class WriteRefused extends Error {
  constructor (message, { status = 0 } = {}) {
    super(message)
    this.name = 'WriteRefused'
    this.status = status
  }
}

// The patch body. `application/merge-patch+json` merges objects recursively
// (RFC 7386), so `data` keeps every key this patch does not name: the whitelist
// the operator created the ConfigMap with survives every backend move.
//
// `resourceVersion` is optional and is not part of the document. It is the
// optimistic-concurrency precondition: a merge patch that names the version it
// read is applied only while the object is still at that version, and the API
// server answers 409 Conflict otherwise. The check is the store's, after the patch
// is applied (staging/src/k8s.io/apiserver/pkg/registry/generic/registry/store.go,
// the `ObjectResourceVersion` comparison before the update), which is why this is a
// field of the patch and not a query parameter. A caller that does not read first
// sends what it always sent.
export function mergePatchBody ({ key, text, resourceVersion = null }) {
  const body = { data: { [key]: text } }
  if (resourceVersion !== null && resourceVersion !== undefined) {
    body.metadata = { resourceVersion }
  }
  return JSON.stringify(body)
}

const reason = error => String(error?.message ?? error)
const encode = value => encodeURIComponent(String(value))

// The caps the puppet's Deployment sets in its own environment. The panel already
// reads this object for its selector, and these five variables are the only
// cap-shaped facts it can reach: the config document that would carry the rest is
// not the panel's to read, and a value the Deployment omits falls back to a
// compiled default the panel cannot see. An unset variable is therefore unknown,
// never the default guessed.
export const CAP_VARIABLES = {
  preAuthMaxConnections: 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS',
  preAuthDeadlineMs: 'MONOPLAYER_PREAUTH_DEADLINE_MS',
  journalMaxBytes: 'MONOPLAYER_JOURNAL_MAX_BYTES',
  journalMaxTotalBytes: 'MONOPLAYER_JOURNAL_MAX_TOTAL_BYTES',
  journalMaxAgeMs: 'MONOPLAYER_JOURNAL_MAX_AGE_MS'
}

// The environment of one container in a Deployment's pod template, as a map. One
// rule, two readers: the caps the card shows (#231) and the puppet's own UUID
// (#232), which `deploy/manifests/deployment.yaml` sets as MONOPLAYER_PUPPET_UUID.
// A variable the Deployment omits is absent from the map, never a guessed default.
export function containerEnv (deployment, container = CONTAINER) {
  const containers = deployment?.spec?.template?.spec?.containers
  const list = Array.isArray(containers) ? containers : []
  const chosen = list.find(entry => entry?.name === container) ?? list[0] ?? null
  const entries = Array.isArray(chosen?.env) ? chosen.env : []
  const values = new Map()
  for (const entry of entries) {
    if (typeof entry?.name === 'string' && typeof entry.value === 'string') values.set(entry.name, entry.value)
  }
  return values
}

export function deploymentCaps (deployment, container = CONTAINER) {
  const values = containerEnv(deployment, container)
  const caps = {}
  for (const [key, variable] of Object.entries(CAP_VARIABLES)) {
    const text = values.get(variable)
    const value = text === undefined ? NaN : Number(text)
    caps[key] = Number.isFinite(value) ? value : null
  }
  return caps
}

// `spec.selector.matchLabels` as a label selector, sorted so the same Deployment
// always produces the same URL. Returns null when the Deployment does not say,
// which is a read the panel must not guess at: an empty selector would list every
// pod in the namespace.
export function labelSelector (deployment) {
  const labels = deployment?.spec?.selector?.matchLabels
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return null
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return null
  return keys.map(key => key + '=' + labels[key]).join(',')
}

export function createKubeClient ({
  baseUrl = BASE_URL,
  tokenFile = TOKEN_FILE,
  caFile = CA_FILE,
  container = CONTAINER,
  tailLines = TAIL_LINES,
  request = httpsRequest,
  readToken = () => {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim()
      if (token === '') throw new Error('the file is empty')
      return token
    } catch (error) {
      throw new ReadRefused('no service account token at ' + tokenFile + ': ' + reason(error))
    }
  },
  readCA = () => {
    try {
      return fs.readFileSync(caFile)
    } catch {
      return null
    }
  }
} = {}) {
  const json = (body, what) => {
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new ReadRefused(what + ': the API server sent something that is not JSON')
    }
  }

  async function get (path, what) {
    let answer
    try {
      answer = await request({ baseUrl, path, token: readToken(), ca: readCA() })
    } catch (error) {
      if (error instanceof ReadRefused) throw error
      throw new ReadRefused(what + ': ' + reason(error))
    }
    if (!(answer?.status >= 200 && answer?.status < 300)) {
      const status = answer?.status ?? 0
      throw new ReadRefused(what + ': the API server answered ' + (status === 0 ? 'nothing' : status +
        (answer.statusText ? ' ' + answer.statusText : '')), { status })
    }
    return answer.body
  }

  // One key of one ConfigMap, rewritten. Resolves with what the API server
  // answered and rejects with a reason the route turns into a 503. A `409` arrives
  // as a WriteRefused carrying that status, so a route that read the document first
  // can tell a lost race from a refusal and retry it.
  async function patchConfigMapKey ({ namespace, name, key, text, resourceVersion = null }) {
    const path = '/api/v1/namespaces/' + encode(namespace) + '/configmaps/' + encode(name)
    const what = 'write ' + key + ' in ConfigMap ' + namespace + '/' + name
    const body = mergePatchBody({ key, text, resourceVersion })
    const startedAt = Date.now()
    let answer
    try {
      answer = await request({
        baseUrl,
        path,
        token: readToken(),
        ca: readCA(),
        method: 'PATCH',
        body,
        contentType: 'application/merge-patch+json'
      })
    } catch (error) {
      if (error instanceof WriteRefused) throw error
      throw new WriteRefused(what + ': ' + reason(error))
    }
    if (!(answer?.status >= 200 && answer?.status < 300)) {
      const status = answer?.status ?? 0
      const said = messageFrom(answer?.body)
      throw new WriteRefused(what + ': the API server answered ' + (status === 0 ? 'nothing' : status) +
        (said === null ? '' : ': ' + said), { status })
    }
    // The answer to a patch is the object after the write, so its
    // `resourceVersion` is the version this write produced. A route that reports it
    // is reporting the cluster's fact, not a number it computed.
    return {
      namespace,
      name,
      key,
      status: answer.status,
      bytes: Buffer.byteLength(body),
      tookMs: Date.now() - startedAt,
      resourceVersion: resourceVersionOf(answer.body)
    }
  }

  return {
    patchConfigMapKey,
    // One ConfigMap, whole: every key it holds and the version it holds them at.
    // The attach whitelist route reads it and rewrites one key (#232). A caller that
    // only reads a key could too, and the version is the reason the whole object is
    // returned.
    async configMap (namespace, name) {
      const path = '/api/v1/namespaces/' + encode(namespace) + '/configmaps/' + encode(name)
      const what = 'read ConfigMap ' + namespace + '/' + name
      return json(await get(path, what), what)
    },
    async deployment (namespace, name) {
      const path = '/apis/apps/v1/namespaces/' + encode(namespace) + '/deployments/' + encode(name)
      const what = 'read Deployment ' + namespace + '/' + name
      return json(await get(path, what), what)
    },
    async pods (namespace, selector) {
      const path = '/api/v1/namespaces/' + encode(namespace) + '/pods?labelSelector=' + encodeURIComponent(selector)
      const what = 'list pods in ' + namespace
      return json(await get(path, what), what)
    },
    // The exact request the ticket names: the container and a tail, because the
    // page reads records and not a whole pod's life.
    async podLog (namespace, pod) {
      const path = '/api/v1/namespaces/' + encode(namespace) + '/pods/' + encode(pod) +
        '/log?container=' + encodeURIComponent(container) + '&tailLines=' + tailLines
      return get(path, 'read the log of ' + namespace + '/' + pod)
    }
  }
}

// `metadata.resourceVersion` from a response body, or null when the body is not an
// object with one. Never guessed: a route that shows a version it made up would be
// showing the operator something the next patch would then disagree with.
function resourceVersionOf (body) {
  try {
    const parsed = JSON.parse(String(body ?? ''))
    const version = parsed?.metadata?.resourceVersion
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

// What an error response says about itself, bounded: the API server's `message` is
// about the object, which is public configuration, but it reaches a browser and a
// log line.
function messageFrom (body) {
  try {
    const parsed = JSON.parse(String(body ?? ''))
    const heard = parsed?.message ?? parsed?.reason ?? null
    if (typeof heard === 'string' && heard.trim() !== '') return heard.slice(0, 300)
  } catch { /* not the API server's shape */ }
  return null
}

// The one real call: TLS with the pod's token and CA, and the body as text. A
// timeout is not optional here: the API server answers, or the panel says it could
// not, and neither of those may depend on a socket that never closes.
//
// `method` and `body` are the write's two additions (#233). A read passes neither,
// and the request it makes is the request it has always made.
export function httpsRequest ({ baseUrl, path, token, ca, method = 'GET', body = null, contentType = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path)
    const headers = {
      authorization: 'Bearer ' + token,
      accept: 'application/json, text/plain;q=0.9, */*;q=0.1'
    }
    if (contentType !== null) headers['content-type'] = contentType
    if (body !== null) headers['content-length'] = Buffer.byteLength(body)
    const options = {
      method,
      hostname: url.hostname,
      port: url.port === '' ? 443 : url.port,
      path: url.pathname + url.search,
      headers,
      timeout: TIMEOUT_MS
    }
    if (ca !== null && ca !== undefined) options.ca = ca

    const req = https.request(options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        body: Buffer.concat(chunks).toString('utf8')
      }))
      res.on('error', reject)
    })
    req.on('timeout', () => { req.destroy(new Error('no answer in ' + TIMEOUT_MS + ' ms')) })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

// The read-only spelling, kept because a caller that only reads should not have to
// know the transport can write.
export function httpsGet (options) {
  return httpsRequest({ ...options, method: 'GET' })
}

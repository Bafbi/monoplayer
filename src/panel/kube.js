// The panel's read path to the cluster: three GETs, and no other verb.
//
// The panel reads what the puppet already says about itself, and it reaches that
// through the API server for one reason: the pod's log. The registry names a
// Deployment; the Deployment names its pods in `spec.selector.matchLabels`, so
// the reads are a Deployment, a pod list, and one pod's log. No discovery, no
// label the operator did not write.
//
// Credentials are the pod's own ServiceAccount: the token file and the CA the
// kubelet mounts. Both are read per request, because the kubelet rotates the
// token, and a client that cached it would start failing an hour into a pod's
// life with a message about a cluster nobody changed.
//
// `request` is injected. The default is one `node:https` call; a test hands in a
// function that records the path and answers bytes, so the panel's tests need no
// cluster, no certificate, and no token. There is no Kubernetes client package
// in this repo and none is added: three GETs are three GETs.

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

export function deploymentCaps (deployment, container = CONTAINER) {
  const containers = deployment?.spec?.template?.spec?.containers
  const list = Array.isArray(containers) ? containers : []
  const chosen = list.find(entry => entry?.name === container) ?? list[0] ?? null
  const entries = Array.isArray(chosen?.env) ? chosen.env : []
  const values = new Map()
  for (const entry of entries) {
    if (typeof entry?.name === 'string' && typeof entry.value === 'string') values.set(entry.name, entry.value)
  }
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
  request = httpsGet,
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

  return {
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

// The one real call: GET over TLS with the pod's token and CA, and the body as
// text. A timeout is not optional here: the API server answers, or the page says
// it could not read, and neither of those may depend on a socket that never
// closes.
export function httpsGet ({ baseUrl, path, token, ca }) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path)
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port === '' ? 443 : url.port,
      path: url.pathname + url.search,
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/json, text/plain;q=0.9, */*;q=0.1'
      },
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
    req.end()
  })
}

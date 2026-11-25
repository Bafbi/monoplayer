// The puppet card routes: GET / for a human, GET /api/puppets/<name> for an agent.
//
// Both read the same facts, through the same function, so a number on the page and
// a number in the JSON cannot disagree. The facts come from src/panel/activity.js,
// which never touches a socket; this module does the reads, hands them over, and
// src/panel/views/page.js writes the page (#248 split the one renderer into views/,
// so the stream writes the same card body the page does).
//
// One card per puppet, from the records the puppet already writes. Every number
// carries the timestamp of the log line it came from, and a record older than three
// heartbeats gets its own state, so a stale lane is never coloured as a live one.
import { activity } from '../activity.js'
import { deploymentCaps, labelSelector } from '../kube.js'
import { renderPage } from '../views/page.js'
import { readAllowedList } from './allowed.js'
import { readAttachList } from './whitelist.js'

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

// The pod to read, out of the pods the Deployment's selector matched: a ready one
// first, then the newest. A Deployment with two replicas during a rollout has one
// pod worth showing, and showing the one that is serving is the choice an operator
// would make.
export function choosePod (items) {
  const pods = Array.isArray(items) ? items.filter(pod => typeof pod?.metadata?.name === 'string') : []
  if (pods.length === 0) return null
  const ready = pod => (Array.isArray(pod.status?.conditions) &&
    pod.status.conditions.some(condition => condition?.type === 'Ready' && condition.status === 'True') ? 1 : 0)
  const created = pod => Date.parse(pod.metadata?.creationTimestamp ?? '') || 0
  return pods.slice().sort((left, right) => (ready(right) - ready(left)) || (created(right) - created(left)))[0]
}

// One puppet's facts: its Deployment, its pods, and the log of the pod that is
// serving. A read that fails becomes a fact about the read, not an exception, so
// the card can say which one failed.
export async function readPuppet ({ kubernetes, puppet, recorded = null, now = Date.now(), log = () => {} }) {
  // Fixture mode's whole mechanism (#248): a function that answers with a document
  // recorded from GET /api/puppets/<name>, or null to read the cluster. It is the
  // same seam as the injected client, one level up, so the page and the stream
  // cannot tell a recording from a cluster. It is null in a pod: the entrypoint
  // refuses to start with --fixture when the ServiceAccount token is mounted.
  if (recorded !== null && typeof recorded === 'function') {
    const facts = recorded(puppet.name)
    if (facts !== null && facts !== undefined) return facts
  }
  if (kubernetes === null || kubernetes === undefined) {
    return activity({ puppet, failure: new Error('the panel was started without a Kubernetes client'), now })
  }
  let pods
  let caps = null
  try {
    const deployment = await kubernetes.deployment(puppet.namespace, puppet.deployment)
    const selector = labelSelector(deployment)
    if (selector === null) {
      throw new Error('Deployment ' + puppet.namespace + '/' + puppet.deployment + ' has no spec.selector.matchLabels')
    }
    // The same object answers both questions: which pods to read, and the caps the
    // Deployment sets in its own environment.
    caps = deploymentCaps(deployment)
    pods = await kubernetes.pods(puppet.namespace, selector)
  } catch (error) {
    log('puppetReadFailed', { puppet: puppet.name, reason: String(error?.message ?? error) })
    return activity({ puppet, failure: error, now })
  }

  const pod = choosePod(pods?.items)
  if (pod === null) return activity({ puppet, pod: null, caps, now })
  try {
    const text = await kubernetes.podLog(puppet.namespace, pod.metadata.name)
    return activity({ puppet, pod, log: { text }, caps, now })
  } catch (error) {
    log('puppetReadFailed', { puppet: puppet.name, pod: pod.metadata.name, reason: String(error?.message ?? error) })
    return activity({ puppet, pod, log: { error }, caps, now })
  }
}

// `read` is the panel's registry thunk, wrapped: it returns the document or the
// reason it could not be read, so a broken registry is the same 500 here as on
// /api/puppets. `send` is the panel's one response writer, injected so this module
// cannot disagree with the rest of the surface about headers.
export function createInfoRoutes ({ read, kubernetes = null, recorded = null, log = () => {}, send, now = () => Date.now() } = {}) {
  if (typeof read !== 'function') throw new TypeError('createInfoRoutes: read must be a function returning the registry or its failure')
  if (typeof send !== 'function') throw new TypeError('createInfoRoutes: send must be the panel response writer')

  return async function route (req, res) {
    try {
      const path = (req.url ?? '/').split('?')[0]

      if (path === '/') {
        const { document, failure } = read()
        if (failure) {
          send(res, 500, TEXT, failure + '\n')
          return true
        }
        const at = now()
        // The card's facts, its attach whitelist, and its allowed servers are reads of
        // different objects, so they run together: the page waits for the slower one,
        // not for all of them in turn (#248, #309).
        const [activities, lists, servers] = await Promise.all([
          Promise.all(document.puppets.map(puppet => readPuppet({ kubernetes, puppet, recorded, now: at, log }))),
          Promise.all(document.puppets.map(puppet => readAttachList({ kubernetes, puppet, now: at, log }))),
          Promise.all(document.puppets.map(puppet => readAllowedList({ kubernetes, puppet, now: at, log })))
        ])
        const byName = new Map(document.puppets.map((puppet, index) => [puppet.name, lists[index]]))
        const serversByName = new Map(document.puppets.map((puppet, index) => [puppet.name, servers[index]]))
        // A page served from a recording says so, in the page, where a screenshot can see
        // it. The start line says it too, and a write refuses by name, but neither of
        // those is on the page (#248).
        const banner = recorded === null
          ? null
          : 'this panel is serving a recording, not a cluster: every fact below was captured from ' +
            'GET /api/puppets/<name>, and every write is refused'
        send(res, 200, HTML, renderPage(document, activities, { attach: byName, allowed: serversByName, banner }))
        return true
      }

      const match = /^\/api\/puppets\/([^/]+)$/.exec(path)
      if (match === null) return false

      let name
      try {
        name = decodeURIComponent(match[1])
      } catch {
        send(res, 404, TEXT, 'no such puppet\n')
        return true
      }
      const { document, failure } = read()
      if (failure) {
        send(res, 500, TEXT, failure + '\n')
        return true
      }
      const puppet = document.puppets.find(entry => entry.name === name)
      if (puppet === undefined) {
        send(res, 404, TEXT, 'no such puppet: ' + name + '\n')
        return true
      }
      const facts = await readPuppet({ kubernetes, puppet, recorded, now: now(), log })
      send(res, 200, JSON_TYPE, JSON.stringify(facts, null, 2) + '\n')
      return true
    } catch (error) {
      const reason = String(error?.message ?? error)
      log('infoRouteFailed', { route: req.url ?? null, reason })
      send(res, 500, TEXT, reason + '\n')
      return true
    }
  }
}

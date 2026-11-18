// GET /api/puppets/<name>/stream: the page's live region, once every five seconds.
//
// Server-sent events, not polling (#248). Polling costs a request per tick and
// still shows a page that is as old as its last poll; a stream is one request that
// keeps answering, and the browser reconnects on its own when it drops.
//
// The contract, and each part of it is here for a reason:
//
//   content-type: text/event-stream   an event stream, so nothing buffers it as a
//                                     document that has not finished arriving
//   cache-control: no-store           a cached tick is a page that lies about when
//                                     it was read
//   x-accel-buffering: no             an nginx in front of this would hold the
//                                     frames until it had a buffer's worth
//   no content-length                 the answer has no end until the client goes
//   no compression                    a compressor's buffer is another place a tick
//                                     waits; this panel never compresses anything
//
// One fragment per tick, as text/event-stream data lines, which htmx swaps into
// the element that opened the stream (src/panel/views/card.js). A comment line
// every 15 s is the heartbeat: EventSource ignores it, and it keeps the socket
// alive through anything that would close a quiet connection.
//
// A tick that finds the previous read still pending is SKIPPED, not queued. Three
// sequential API reads can outlast five seconds on a slow API server (a
// Deployment, a pod list, and a pod log, each with a 5 s timeout), and overlapping
// reads would answer out of order: the older fragment would land after the newer
// one. A skipped tick costs one interval of freshness and says so in the log.
//
// The stream ends when the client closes. Nothing else ends it: a pod that stops
// writing still gets a fragment every five seconds that says so.
import { renderLive } from '../views/live.js'
import { renderWhitelistSwap } from '../views/whitelist.js'
import { readPuppet } from './info.js'
import { readAttachList } from './whitelist.js'

export const PATTERN = /^\/api\/puppets\/([^/]+)\/stream$/
// The ticket's cadence, and it is a constant rather than a setting: the page says
// "every 5 s" in words, and a deployment detail behind that sentence is a sentence
// that can be wrong.
export const TICK_MS = 5_000
export const HEARTBEAT_MS = 15_000
const TEXT = 'text/plain; charset=utf-8'

export function createStreamRoute ({
  read,
  kubernetes = null,
  recorded = null,
  log = () => {},
  now = () => Date.now(),
  tickMs = TICK_MS,
  heartbeatMs = HEARTBEAT_MS
} = {}) {
  if (typeof read !== 'function') throw new TypeError('createStreamRoute: read must be the registry reader')

  // The one place a path segment becomes a name, and the only call here that can
  // throw: a throw from a request listener ends the process.
  function match (path) {
    const found = PATTERN.exec(path)
    if (found === null) return null
    try {
      return { name: decodeURIComponent(found[1]), invalid: false }
    } catch {
      return { name: found[1], invalid: true }
    }
  }

  async function handle (req, res, context) {
    try {
      return await route(req, res, context)
    } catch (error) {
      log('panelRouteFailed', { route: 'stream', error: String(error?.message ?? error).slice(0, 300) })
      // A refusal before the headers are written is a normal answer. After them
      // it is a half-written stream, and all that is left is to end it.
      try {
        if (res.headersSent) res.end()
        else context.send(res, 500, TEXT, 'the panel failed to answer\n')
      } catch { /* the socket is already gone */ }
      return undefined
    }
  }

  async function route (req, res, { method, send }) {
    if (method !== 'GET') {
      return send(res, 405, TEXT, 'this route answers GET only\n', { allow: 'GET' })
    }
    const found = match((req.url ?? '/').split('?')[0])
    if (found.invalid === true) {
      log('panelStreamInvalidName', { segment: found.name.slice(0, 100) })
      return send(res, 400, TEXT, 'the puppet name in the path is not valid percent-encoding\n')
    }
    // The registry is read on the request, like every other route: a puppet added
    // to the document is streamable without a restart.
    const { document, failure } = read()
    if (failure) return send(res, 500, TEXT, failure + '\n')
    const puppet = document.puppets.find(entry => entry.name === found.name) ?? null
    if (puppet === null) return send(res, 404, TEXT, 'no such puppet: ' + found.name + '\n')

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff'
    })
    res.flushHeaders?.()

    let closed = false
    let pending = false
    let ticks = 0
    let beats = 0
    let ticker = null
    let beater = null

    function stop () {
      if (closed) return
      closed = true
      if (ticker !== null) clearInterval(ticker)
      if (beater !== null) clearInterval(beater)
      log('panelStreamEnd', { puppet: puppet.name, ticks, beats })
      try { res.end() } catch { /* the socket is already gone */ }
    }

    function write (text) {
      if (closed) return false
      try {
        res.write(text)
        return true
      } catch {
        stop()
        return false
      }
    }

    async function tick () {
      if (closed) return
      if (pending) {
        // The previous read has not answered. Answering now would send a fragment
        // older than the one beside it.
        log('panelStreamTickSkipped', { puppet: puppet.name })
        return
      }
      pending = true
      try {
        const at = now()
        // Two objects, one instant, read together: the card's facts from the pod's log
        // and the attach whitelist from the control ConfigMap. The page waits for the
        // slower read, not for both in turn.
        const [facts, list] = await Promise.all([
          readPuppet({ kubernetes, puppet, recorded, now: at, log }),
          readAttachList({ kubernetes, puppet, now: at, log })
        ])
        if (closed) return
        // An event stream carries text lines, so each line of the fragment is its
        // own data field. The browser joins them with a newline and htmx swaps the
        // result, which is why the fragment is written once and not escaped.
        // The live region, and the whitelist list beside it as an out-of-band swap. The
        // list sits outside the live region so a tick cannot disarm a remove button or
        // clear a half-typed name, and it still refreshes with the card (#248).
        const fragment = renderLive(facts, list) + renderWhitelistSwap({ puppet, list })
        if (write(fragment.split('\n').map(line => 'data: ' + line).join('\n') + '\n\n')) ticks += 1
      } catch (error) {
        log('panelStreamTickFailed', { puppet: puppet.name, reason: String(error?.message ?? error).slice(0, 200) })
      } finally {
        pending = false
      }
    }

    res.on('close', stop)
    res.on('error', stop)

    // The heartbeat starts before the first read, not after it. The first read is
    // three sequential API requests and can take fifteen seconds on a slow API
    // server; a comment timer started after it would leave the connection silent
    // for that whole window, which is what the comment exists to prevent.
    beater = setInterval(() => {
      if (write(': heartbeat ' + new Date(now()).toISOString() + '\n\n')) beats += 1
    }, heartbeatMs)

    // The first fragment now, not in five seconds: the page's server render is
    // already on screen, and a client that sees nothing for five seconds cannot
    // tell a working stream from a broken one.
    await tick()
    if (closed) return undefined
    ticker = setInterval(tick, tickMs)
    // A timer must not hold the process open on its own: the socket is what keeps
    // this alive, and the server's own stop closes it. The cost of that choice is
    // that a leaked interval is invisible in the handle table, so the test asserts
    // the reads a closed stream stops making instead of the timers it clears.
    ticker.unref?.()
    beater.unref?.()
    return undefined
  }

  return { match, handle }
}

// Minimal HTTP adapter for the Toxiproxy API (Shopify/toxiproxy, pinned
// 2.13.0 in deploy/driver/toxiproxy.yaml). Faults belong on the puppet leg
// (driver-lane plan): everything east of Monoplayer, never in front of it.
//
// Shape mirrors src/driver/rcon.js: a factory with an injected transport
// (fetch here instead of kubectl exec) returning records
//   { ok, status, body, kind, label, durationMs, ... }
// that never throw. Op classification (setup | assertion | probe) lives at the
// call sites below and is recorded by the scenario executor like RCON ops.
export const BASE_URL_DEFAULT = 'http://toxiproxy-api:8474'

// Prepare a generic Response-like with text() fallback because the API always
// speaks JSON, but failures may return text.
function parseBody (response) {
  return new Promise((resolve, reject) => {
    response.json().then(resolve, () => {
      response.text().then(text => {
        const trimmed = text.trim()
        if (trimmed !== '') {
          try { resolve(JSON.parse(trimmed)) } catch { resolve(trimmed) }
        }
        resolve(null)
      }, reject)
    })
  })
}

// Default transport: injected-free fetch callers, global fetch with an
// abort-based timeout so a hung API pod produces ok:false instead of hanging.
// setTimeout is registered per request and always cleared.
function defaultFetchHandler (url, init, timeoutMs) {
  if (typeof AbortSignal.timeout === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`toxiproxy request timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }
  return fetch(url, init)
}

export function createToxiproxy ({
  baseUrl = BASE_URL_DEFAULT,
  timeoutMs = 20000,
  fetchImpl = null,
} = {}) {
  const fetcher = fetchImpl ?? defaultFetchHandler
  const root = String(baseUrl).replace(/\/+$/, '')

  async function run (method, path, { body, kind = 'probe', label = path, contentType = 'application/json' } = {}) {
    const url = `${root}${path}`
    const startedAt = Date.now()
    try {
      const init = { method }
      if (body !== undefined) init.body = JSON.stringify(body)
      if (body !== undefined) init.headers = { 'content-type': contentType }
      const response = await fetcher(url, init, timeoutMs)
      let parsed = null
      try { parsed = await parseBody(response) } catch { parsed = null }
      const status = response.status
      return {
        ok: response.ok,
        status,
        body: parsed,
        kind, label,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        ok: false,
        status: null,
        body: null,
        error: error && error.message ? error.message : String(error),
        kind, label,
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // ---- probes (read-only reads) ----
  const version = () => run('GET', '/version', { kind: 'probe', label: 'version' })
  const listProxies = () => run('GET', '/proxies', { kind: 'probe', label: 'list-proxies' })
  const getProxy = name => run('GET', `/proxies/${encodeURIComponent(name)}`, { kind: 'probe', label: 'get-proxy' })
  const listToxics = proxy =>
    run('GET', `/proxies/${encodeURIComponent(proxy)}/toxics`, { kind: 'probe', label: 'list-toxics' })
  const getToxic = (proxy, toxic) =>
    run('GET', `/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxic)}`, { kind: 'probe', label: 'get-toxic' })

  // ---- setup (mutating proxy state: listeners, toxics, reset) ----
  const populate = defs => run('POST', '/populate', { body: defs, kind: 'setup', label: 'populate' })
  const setProxyEnabled = (name, enabled) =>
    run('POST', `/proxies/${encodeURIComponent(name)}`, { body: { enabled }, kind: 'setup', label: enabled ? 'enable-proxy' : 'disable-proxy' })
  const reset = () => run('POST', '/reset', { body: {}, kind: 'setup', label: 'reset' })

  async function addToxic (proxy, toxic, { kind = 'setup', label = 'add-toxic' } = {}) {
    return run('POST', `/proxies/${encodeURIComponent(proxy)}/toxics`, {
      body: toxic,
      kind,
      label,
    })
  }

  const removeToxic = (proxy, toxic) =>
    run('DELETE', `/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxic)}`, {
      kind: 'setup', label: 'remove-toxic',
    })

  // Remove every toxic on a proxy (F-fault teardown between repetitions).
  async function clearToxics (proxy) {
    const listing = await listToxics(proxy)
    if (!listing.ok || !listing.body) return { ok: false, status: listing.status, error: 'could not list toxics', kind: 'setup', label: 'clear-toxics' }
    const results = []
    for (const toxic of keys(listing.body)) {
      results.push(await removeToxic(proxy, toxic.name ? toxic.name : toxic))
    }
    return {
      ok: results.every(r => r.ok),
      status: results.length > 0 ? results[results.length - 1].status : null,
      results,
      kind: 'setup', label: 'clear-toxics',
    }
  }

  // ---- assertions (positive tests against observed proxy state) ----
  async function assertProxyEnabled (proxy, enabled = true) {
    const result = await getProxy(proxy)
    const observed = result.body && result.body.enabled
    return {
      ...result,
      ok: Boolean(result.ok && observed === enabled),
      kind: 'assertion',
      label: `proxy-${enabled ? 'enabled' : 'disabled'}`,
    }
  }

  async function assertToxicPresent (proxy, expectedType) {
    const result = await listToxics(proxy)
    const toxics = result.body
    const present = Array.isArray(toxics) &&
      toxics.some(t => (t.toxicType ?? t.type) === expectedType)
    return {
      ...result,
      ok: Boolean(result.ok && present),
      kind: 'assertion',
      label: `toxic-${expectedType}-present`,
    }
  }

  return {
    baseUrl: root, timeoutMs,
    run,
    version, listProxies, getProxy, listToxics, getToxic,
    populate, setProxyEnabled, reset,
    addToxic, removeToxic, clearToxics,
    assertProxyEnabled, assertToxicPresent,
  }
}

function keys (body) {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') return Object.values(body)
  return []
}

// ---------------------------------------------------------------------------
// Fault shapes (docs/driver-lane-plan.html, F1-F6). F1/F4/F5 are not toxiproxy
// shapes: detach is client-side, backend death is a deployment restart, kick
// is an RCON command. Only F2/F3/F6 are network toxics here; hold duration is
// the lane's timing and stays with the B-lane runner.
// ---------------------------------------------------------------------------

export const FAULT_SHAPES = Object.freeze({
  F2: Object.freeze({
    toxic: Object.freeze({ name: 'f2-attach-latency', type: 'latency', stream: 'both', toxicity: 1.0, attributes: { latency: 100, jitter: 30 } }),
    duration: 'held for the attach, then removed (3/3 reps)',
  }),
  F3: Object.freeze({
    toxic: Object.freeze({ name: 'f3-freeze', type: 'timeout', stream: 'both', toxicity: 1.0, attributes: { timeout: 0 } }),
    duration: 'hold 5s, then remove (3/3 reps)',
  }),
  F6: Object.freeze({
    toxic: Object.freeze({ name: 'f6-down', type: 'timeout', stream: 'both', toxicity: 1.0, attributes: { timeout: 0 } }),
    duration: 'hold 60s, then restore (3/3 reps)',
  }),
})

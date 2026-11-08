// OTLP/HTTP JSON telemetry: hand-written, no @opentelemetry packages.
//
// The module is inert unless an endpoint is configured. With no endpoint set
// (the default) `log`, `metric`, `flush`, and `close` are no-ops and the module
// opens no socket and starts no timer.
//
// Signals:
//   logs     POST <endpoint>/v1/logs, batched at 512 records or 5 s
//   metrics  POST <endpoint>/v1/metrics, batched at 30 s
//
// Export failures never reach the product: a failed request is retried once
// (5xx or network error) and then dropped, counted in stats(). Every string
// attribute is capped at 1024 chars, secret-shaped keys are dropped, and
// string values pass through the same redaction as the JSONL log sink.

import { redact } from './redact.js'

const LOG_BATCH = 512
const LOG_INTERVAL_MS = 5_000
const METRIC_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
const MAX_STRING = 1024
const SEVERITY_INFO = 9

const SECRET_KEY = /(token|secret|password|authorization|cookie|credential|device_code|user_code)/i

const clip = value => {
  const text = String(value)
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text
}

// Mask bearer values before redact(): the field-label rewrite can otherwise
// leave the token after "authorization=[REDACTED]".
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const cleanString = value => clip(redact(String(value).replace(BEARER, 'Bearer [REDACTED]')))

// Attributes are string, bool, or int (int as a decimal string). Nested objects
// are JSON-stringified into a stringValue; non-integer numbers are stringified
// so the attribute union stays as documented.
function attributeValue (value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return { stringValue: cleanString(value) }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    if (Number.isInteger(value)) return { intValue: BigInt(value).toString() }
    return { stringValue: cleanString(String(value)) }
  }
  if (typeof value === 'bigint') return { intValue: value.toString() }
  try {
    return { stringValue: cleanString(JSON.stringify(value)) }
  } catch {
    return { stringValue: cleanString(String(value)) }
  }
}

function attributesFrom (fields) {
  const out = []
  if (!fields || typeof fields !== 'object') return out
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (SECRET_KEY.test(key)) continue
    const encoded = attributeValue(value)
    if (encoded) out.push({ key: clip(key), value: encoded })
  }
  return out
}

function toNano (ms) {
  const value = Number(ms)
  return (BigInt(Math.trunc(Number.isFinite(value) ? value : 0)) * 1_000_000n).toString()
}

function resourceFrom (env) {
  const serviceName = env.OTEL_SERVICE_NAME || 'monoplayer'
  const serviceVersion = env.OTEL_SERVICE_VERSION || 'unknown'
  const instance = env.HOSTNAME || String(process.pid)
  const attributes = [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.version', value: { stringValue: serviceVersion } },
    { key: 'service.instance.id', value: { stringValue: instance } }
  ]
  const alias = env.MONOPLAYER_ACCOUNT_ALIAS
  if (alias) {
    attributes.push({ key: 'monoplayer.account.alias', value: { stringValue: cleanString(alias) } })
  }
  return {
    attributes,
    resource: { attributes },
    scope: { name: 'monoplayer', version: serviceVersion }
  }
}

function noopTelemetry () {
  return {
    enabled: false,
    log () {},
    metric () {},
    async flush () {},
    async close () {},
    stats: () => ({
      enabled: false,
      logs: { accepted: 0, sent: 0, dropped: 0, queued: 0, batches: 0 },
      metrics: { accepted: 0, sent: 0, dropped: 0, queued: 0, batches: 0 },
      requests: 0,
      retries: 0,
      failures: 0,
      lastError: null
    })
  }
}

export function createTelemetry ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  log
} = {}) {
  const rawEndpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.MONOPLAYER_OTEL_ENDPOINT || '').trim()
  let endpoint = null
  if (rawEndpoint) {
    try {
      const url = new URL(rawEndpoint)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        endpoint = rawEndpoint.replace(/\/+$/, '')
      }
    } catch { /* malformed endpoint stays disabled */ }
  }
  if (!endpoint || typeof fetchImpl !== 'function') return noopTelemetry()

  const resource = resourceFrom(env)
  const stats = {
    enabled: true,
    logs: { accepted: 0, sent: 0, dropped: 0, queued: 0, batches: 0 },
    metrics: { accepted: 0, sent: 0, dropped: 0, queued: 0, batches: 0 },
    requests: 0,
    retries: 0,
    failures: 0,
    lastError: null
  }

  let logs = []
  const pending = new Map()
  let closed = false
  let logTail = Promise.resolve()
  let metricTail = Promise.resolve()
  let logTimer = null
  let metricTimer = null

  function noteError (error) {
    stats.failures++
    stats.lastError = String(error?.message ?? error).slice(0, 300)
  }

  async function post (path, payload) {
    let body
    try {
      body = JSON.stringify(payload)
    } catch (error) {
      noteError(error)
      return false
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) stats.retries++
      stats.requests++
      try {
        const response = await fetchImpl(endpoint + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (response?.ok) {
          // Drain the small OTLP response so the connection can be reused.
          try { await response?.text?.() } catch { /* body is irrelevant */ }
          return true
        }
        const status = Number(response?.status ?? 0)
        noteError(`http_${status}`)
        try { await response?.text?.() } catch { /* response body is irrelevant */ }
        if (status < 500) return false
      } catch (error) {
        noteError(error)
      }
    }
    return false
  }

  function logsPayload (records) {
    return {
      resourceLogs: [{
        resource: resource.resource,
        scopeLogs: [{
          scope: resource.scope,
          logRecords: records.map(record => ({
            timeUnixNano: toNano(record.time),
            observedTimeUnixNano: toNano(record.time),
            severityNumber: record.severityNumber,
            severityText: record.severityText,
            body: { stringValue: cleanString(record.event) },
            attributes: record.attributes
          }))
        }]
      }]
    }
  }

  function metricsPayload (points) {
    const now = clock()
    return {
      resourceMetrics: [{
        resource: resource.resource,
        scopeMetrics: [{
          scope: resource.scope,
          metrics: points.map(point => {
            const encoded = Number.isInteger(point.value)
              ? { asInt: BigInt(point.value).toString() }
              : { asDouble: point.value }
            const dataPoint = {
              ...encoded,
              timeUnixNano: toNano(now),
              startTimeUnixNano: toNano(point.start),
              attributes: point.attributes
            }
            if (point.kind === 'gauge') {
              return { name: point.name, gauge: { dataPoints: [dataPoint] } }
            }
            return {
              name: point.name,
              sum: {
                dataPoints: [dataPoint],
                aggregationTemporality: 2,
                isMonotonic: true
              }
            }
          })
        }]
      }]
    }
  }

  function sendLogs (batch) {
    logTail = logTail.then(async () => {
      stats.logs.batches++
      const ok = await post('/v1/logs', logsPayload(batch))
      if (ok) stats.logs.sent += batch.length
      else stats.logs.dropped += batch.length
    }).catch(() => { stats.logs.dropped += batch.length })
    return logTail
  }

  function sendMetrics (batch) {
    metricTail = metricTail.then(async () => {
      stats.metrics.batches++
      const ok = await post('/v1/metrics', metricsPayload(batch))
      if (ok) stats.metrics.sent += batch.length
      else stats.metrics.dropped += batch.length
    }).catch(() => { stats.metrics.dropped += batch.length })
    return metricTail
  }

  function flushLogs () {
    if (logs.length === 0) return logTail
    const batch = logs
    logs = []
    stats.logs.queued = 0
    return sendLogs(batch)
  }

  function flushMetrics () {
    if (pending.size === 0) return metricTail
    const batch = [...pending.values()]
    pending.clear()
    stats.metrics.queued = 0
    return sendMetrics(batch)
  }

  function metricKey (name, kind, attributes) {
    return `${kind}|${name}|${JSON.stringify(attributes)}`
  }

  logTimer = setInterval(() => {
    if (logs.length > 0) flushLogs().catch(() => {})
  }, LOG_INTERVAL_MS)
  logTimer.unref?.()
  metricTimer = setInterval(() => {
    if (pending.size > 0) flushMetrics().catch(() => {})
  }, METRIC_INTERVAL_MS)
  metricTimer.unref?.()

  return {
    enabled: true,

    log (record = {}) {
      if (closed) return
      try {
        const event = record.event ?? record.body ?? 'event'
        const severityText = record.severityText ?? 'INFO'
        logs.push({
          time: record.time ?? clock(),
          event,
          severityNumber: record.severityNumber ?? SEVERITY_INFO,
          severityText,
          attributes: attributesFrom(record.fields ?? {})
        })
        stats.logs.accepted++
        stats.logs.queued = logs.length
        if (logs.length >= LOG_BATCH) flushLogs().catch(() => {})
      } catch (error) {
        noteError(error)
      }
    },

    metric (name, value, attrs = {}, kind = 'sum') {
      if (closed) return
      try {
        if (typeof value !== 'number' || !Number.isFinite(value)) return
        const metricKind = kind === 'gauge' ? 'gauge' : 'sum'
        const attributes = attributesFrom(attrs)
        const key = metricKey(name, metricKind, attributes)
        const existing = pending.get(key)
        if (existing) {
          if (metricKind === 'gauge') existing.value = value
          else existing.value += value
        } else {
          pending.set(key, { name, kind: metricKind, attributes, value, start: clock() })
        }
        stats.metrics.accepted++
        stats.metrics.queued = pending.size
      } catch (error) {
        noteError(error)
      }
    },

    async flush () {
      if (closed) return
      const jobs = [flushLogs(), flushMetrics()]
      await Promise.allSettled(jobs)
    },

    async close () {
      if (closed) return
      clearInterval(logTimer)
      clearInterval(metricTimer)
      const jobs = [flushLogs(), flushMetrics()]
      closed = true
      await Promise.allSettled(jobs)
    },

    stats () {
      return {
        enabled: true,
        logs: { ...stats.logs, queued: logs.length },
        metrics: { ...stats.metrics, queued: pending.size },
        requests: stats.requests,
        retries: stats.retries,
        failures: stats.failures,
        lastError: stats.lastError
      }
    }
  }
}

// #260: the state cache a body owns.
//
// The cache itself is already pure and bounded per instance
// (src/core/state-cache.js). This module adds ownership. The composition root
// used to create one cache and serve every body from it. Two bodies of one
// account then shared one replay, one set of bounds, and one capture counter. A
// fault on either emptied both.
//
// A body's cache belongs to the body (GLOSSARY.md). This registry creates one
// cache per body. It answers every read of that body with the same instance, so a
// driver and the body's spectators share one replay. Two bodies share nothing.
//
// There is no body cap. A lane offers one body per allowed server, so the allowed
// server list is the bound (docs/adr/one-account-many-bodies.md: caps wait for the
// per-body numbers and are configuration when they land).
//
// Purity: no sockets, no timers, no I/O. createStateCache copies the bounds it is
// given, so two bodies do not share a bound either.
import { createStateCache } from './state-cache.js'

function requiredString (value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(field + ' must be a non-empty string')
  }
  return value
}

// A body is named by its server's slug, which is the identity the front leg
// records a claim against (src/core/picker.js, src/core/claims.js). A body the
// registry has never seen is a body with no cache yet.
export function createBodyCaches ({ bounds = {} } = {}) {
  const caches = new Map() // body -> cache
  const metrics = { created: 0, reused: 0 }

  // The one entry point that creates. A second read of a body is the same cache,
  // which is what makes a replay per body rather than per reader.
  function cacheFor (body) {
    requiredString(body, 'body')
    const existing = caches.get(body)
    if (existing !== undefined) {
      metrics.reused++
      return existing
    }
    const cache = createStateCache(bounds)
    caches.set(body, cache)
    metrics.created++
    return cache
  }

  return {
    cacheFor,
    // A non-creating read, for a caller asking whether a body has state instead of
    // serving it. A body nothing has touched has no cache.
    get: body => (typeof body === 'string' ? caches.get(body) ?? null : null),
    stats: () => ({ count: caches.size, bodies: [...caches.keys()], metrics: { ...metrics } })
  }
}

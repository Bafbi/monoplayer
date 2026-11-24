// #260: the state cache a body owns.
//
// The cache itself is already pure and bounded per instance
// (src/core/state-cache.js), and that is not what this module adds. The
// composition root used to create one cache and serve every body from it, so two
// bodies of one account shared one replay, one set of bounds, and one capture
// counter, and a fault on either emptied both. A body's cache belongs to the body
// (GLOSSARY.md), so this registry creates one per body and answers every read of
// that body with the same instance: a driver and the body's spectators share one
// replay, and two bodies share nothing.
//
// Bounded like every other store. A lane offers one body per allowed server, so
// the bound is the allowed server list's own size; over it, the least recently
// touched body's cache goes. That is never the body a session is serving while
// one session serves one body (#261 gives a body its own lifetime, #269 gives a
// claim a channel to deliver through). A body whose cache was evicted keeps its
// session and re-warms from nothing on its next claim.
//
// Purity: no sockets, no timers, no I/O. createStateCache copies the bounds it is
// given, so two bodies do not share a bound either.
import { createStateCache } from './state-cache.js'

const DEFAULT_MAX_BODIES = 32

function requiredString (value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(field + ' must be a non-empty string')
  }
  return value
}

// A body is named by its server's slug, which is the identity the front leg
// records a claim against (src/core/picker.js, src/core/claims.js). The name is
// the caller's, so a body the registry has never seen is simply a body with no
// cache yet.
export function createBodyCaches ({ bounds = {}, maxBodies = DEFAULT_MAX_BODIES } = {}) {
  if (!Number.isInteger(maxBodies) || maxBodies < 1) {
    throw new TypeError('maxBodies must be a positive integer')
  }

  const caches = new Map() // body -> cache, least recently touched first
  const metrics = { created: 0, reused: 0, evicted: 0 }

  // The one entry point that creates. A second read of a body is the same cache,
  // which is what makes a replay per body rather than per reader.
  function cacheFor (body) {
    requiredString(body, 'body')
    const existing = caches.get(body)
    if (existing !== undefined) {
      // Re-insert, so the map's order stays least recently touched first.
      caches.delete(body)
      caches.set(body, existing)
      metrics.reused++
      return existing
    }
    const cache = createStateCache(bounds)
    caches.set(body, cache)
    metrics.created++
    while (caches.size > maxBodies) {
      caches.delete(caches.keys().next().value)
      metrics.evicted++
    }
    return cache
  }

  return {
    cacheFor,
    // A non-creating read, for a caller asking whether a body has state rather
    // than serving it. A body nothing has touched has no cache.
    get: body => (typeof body === 'string' ? caches.get(body) ?? null : null),
    stats: () => ({ count: caches.size, bodies: [...caches.keys()], metrics: { ...metrics } })
  }
}

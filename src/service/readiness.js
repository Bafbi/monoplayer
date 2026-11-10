// Small readiness helpers shared by the live CLI and the ladder runner.
export function cacheStatsLine (stats, elapsedMs) {
  return {
    elapsedMs,
    warm: stats.warm === true,
    sizes: stats.sizes,
    framesCached: stats.metrics.framesCached,
    framesDropped: stats.metrics.framesDropped
  }
}

// Wait until the core cache holds the backend configuration frames and the
// join prefix. Warm (chunk_batch_finished observed) is preferred but bounded:
// after maxWarmMs the prefix is declared settled at its current edge, because
// some backends never batch and a growing prefix would eventually evict the
// login frame. The caller owns the forceWarm fallback.
//
// #87: a followed transfer releases a client on this decision, and a cache with
// no chunk data cannot back one: the human would land in an empty world and
// fall. `shouldForceWarm` refuses the fallback on the transfer stage, and the
// live caller turns a refusal into a failed dial, so the follow budget (retry,
// then revert to the server the client was restored onto) owns the move.
// Startup and reconnect pass `requireChunks: false`: neither releases a client
// mid-move, and refusing them would leave a lane whose backend streams no
// chunks unattachable.
export function shouldForceWarm (readiness, { requireChunks = true } = {}) {
  if (readiness?.hasConfig !== true || readiness?.hasPrefix !== true) return false
  if (readiness.warm === true) return false
  if (!requireChunks) return true
  return Number(readiness.chunkFrames) > 0
}

export async function waitForReady ({ core, log, maxWarmMs = 60_000, maxTotalMs = 240_000 }) {
  const startedAt = Date.now()
  let warmMs = null
  for (;;) {
    const stats = core.cache.stats()
    const hasConfig = stats.sizes.config > 0
    const hasPrefix = stats.sizes.prefix > 0
    const elapsed = Date.now() - startedAt
    if (stats.warm && warmMs === null) {
      warmMs = elapsed
      log('warmComplete', { afterMs: warmMs, ...stats.sizes })
    }
    log('cacheStats', cacheStatsLine(stats, elapsed))
    const readyEnough = hasConfig && hasPrefix && ((warmMs !== null) || elapsed >= maxWarmMs)
    if (readyEnough || elapsed >= maxTotalMs) {
      return {
        hasConfig,
        hasPrefix,
        warm: warmMs !== null,
        warmMs,
        elapsedMs: elapsed,
        configFrames: stats.sizes.config,
        prefixFrames: stats.sizes.prefix,
        chunkFrames: stats.chunkFrames
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

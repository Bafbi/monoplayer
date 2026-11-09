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
        prefixFrames: stats.sizes.prefix
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

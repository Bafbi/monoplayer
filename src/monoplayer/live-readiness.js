// Small readiness-projection helper shared by the live CLI and tests.
export function cacheStatsLine (stats, elapsedMs) {
  return {
    elapsedMs,
    warm: stats.warm === true,
    sizes: stats.sizes,
    framesCached: stats.metrics.framesCached,
    framesDropped: stats.metrics.framesDropped
  }
}

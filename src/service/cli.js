// The argument and output plumbing every CLI entry point here shares: read a
// flag, format a detail, list the candidates a selector matched, bound a promise
// with a deadline. One home, so a rung's report line reads like every other
// rung's (#104).
//
// A leaf module: it imports nothing, so a caller in any tree can use it without
// dragging a dependency along. Two neighbours are deliberately absent.
// `waitFor` stays in `src/ladder/`: loopback and online swallow a throwing
// predicate, while `bot.js` rejects on one, so they are not the same helper.
// `accountHint` stays too: the service and custody wordings differ by design.
export function flag (argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// One line, whatever the detail holds. A bigint has no JSON form, so it goes out
// as its digits rather than ending the report line that carries it.
export function detail (value) {
  if (value === undefined) return ''
  const json = JSON.stringify(value, (key, inner) => typeof inner === 'bigint' ? String(inner) : inner)
  return json === undefined ? String(value) : json
}

// The accounts a selector matched, one per line, for a refusal message.
export function candidateLines (candidates = []) {
  if (candidates.length === 0) return '  candidates: (none)'
  return candidates
    .map(candidate =>
      `  uuid=${candidate.uuid} name=${candidate.name ?? '?'} alias=${candidate.alias ?? '-'} dir=${candidate.dir}`)
    .join('\n')
}

// A deadline that does not hold the process open: a lane whose last live handle
// is a pending timeout should end, not wait out a budget nothing is watching.
export function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

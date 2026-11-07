// Pure shared helpers for the Gate B auth/identity slice (src/auth/).
// No I/O, no env, no network — safe to unit test directly.

// Normalize a Mojang UUID to the canonical lowercase hyphenated form.
// Accepts both `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (undashed) and the already
// hyphenated form. Anything else (empty, wrong shape, not hex) is null —
// callers must fail closed on null.
export function normalizeUuid (raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '') return null
  let hex = value.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Strict UUID equality on normalized values; never compares display names.
export function sameUuid (a, b) {
  const left = normalizeUuid(a)
  const right = normalizeUuid(b)
  return left !== null && right !== null && left === right
}

// Plain display name check. Minecraft display names are already exact-form in
// sessionserver responses; we compare case-insensitively to survive a client
// sending a differently-cased username, which Mojang treats as the same name.
export function sameName (a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase()
}

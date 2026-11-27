// Pure shared helpers for the custody slice (src/custody/).
// No I/O, no env, no network — safe to unit test directly.

// The name-derived uuid Java mints, so "its own name hashes to it" is one function
// rather than a second md5 in this file. src/legs/offline-identity.js owns it and
// imports nothing but node:crypto, so custody takes no runtime edge from this.
import { offlineUuid } from '../legs/offline-identity.js'

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

// The version a UUID carries, read from either spelling, or null when the string is
// not a UUID at all.
//
// Mojang issues version 4, and nothing else: every uuid the profile endpoints answer
// carries a 4 in this position. Version 3 is Java's UUID.nameUUIDFromBytes over
// `OfflinePlayer:<name>`, which is what an offline server mints for a player, and no
// Mojang session can ever answer for the value it produces (#677, #703).
export function uuidVersion (raw) {
  const uuid = normalizeUuid(raw)
  if (uuid === null) return null
  // The dashed form, so the thirteenth hex digit is at index 14.
  return Number.parseInt(uuid.charAt(14), 16)
}

// Why no Mojang session can ever answer for this uuid, or null when nothing about its
// shape stops one. This is the rule the panel's write route and the dev lane's report
// both ask, in one place: the version is necessary and not sufficient, so a version-4
// uuid a caller mistyped is still admitted, and only a login tells the two apart.
//
// The name is optional and is only used when the caller has one. A uuid a request
// supplied arrives with no name, so the version is the whole check there; an entry in
// a document, or a pair a resolver answered, arrives with both, and then a name that
// hashes to its own uuid is refused first, because that names the string that was
// hashed instead of the version it happens to carry.
export function uuidRefusal (raw, name = null) {
  const uuid = normalizeUuid(raw)
  if (uuid === null) return 'it is not a uuid, so no login can match it'
  if (typeof name === 'string' && name !== '') {
    if (offlineUuid(name) === uuid) {
      return 'its uuid is md5("OfflinePlayer:' + name + '"), so no Mojang session answers for it'
    }
  }
  const version = uuidVersion(uuid)
  if (version !== 4) {
    return 'a version-' + version + ' uuid is not one Mojang issues, so no Mojang session answers for it'
  }
  return null
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

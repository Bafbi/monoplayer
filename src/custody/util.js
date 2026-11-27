// Pure shared helpers for the custody slice (src/custody/).
// No I/O, no env, no network — safe to unit test directly.

// The name-derived uuid Java mints, so "its own name hashes to it" reads one function
// instead of a second md5 here. `src/legs/offline-identity.js` owns that fact, and
// `src/legs/live-front.js` already takes this module, so the two trees are neighbours
// either way. Both files are pure. Neither opens a socket.
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
// shape stops one. It is the rule the panel's write route asks of every add. The dev
// lane's report and its guard spell the same rule by hand (`scripts/dev-lane.sh`,
// `test/tooling/dev-lane.test.js`), and #703 is where those come to call this.
//
// The version is necessary and not sufficient. Mojang issues version 4 and nothing
// else, and version 3 is Java's UUID.nameUUIDFromBytes over `OfflinePlayer:<name>`, so
// a derived uuid is refused here. A version-4 uuid a caller mistyped is still
// admitted, because nothing here asks Mojang. Only a login tells the two apart.
//
// The name is optional and is used only when the caller has one. A uuid a request
// supplied arrives with no name, so the version is the whole check there. An entry in
// a document, or a pair a resolver answered, arrives with both, and then a name that
// hashes to its own uuid is refused by the string that was hashed instead of by the
// version it happens to carry.
export function uuidRefusalReason (raw, name = null) {
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

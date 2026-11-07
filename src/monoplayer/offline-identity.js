// Pure offline identity helpers for the loopback product rung.
//
// No minecraft-protocol import, no I/O, no env. The offline UUID is Java's
// UUID.nameUUIDFromBytes for the string `OfflinePlayer:<name>`: MD5, then set
// the version to 3 and the variant to RFC 4122 before hyphenating. Case is
// significant — the name bytes go in exactly as given.
import { createHash } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])

export function offlineUuid (name) {
  if (typeof name !== 'string') throw new TypeError('offlineUuid name must be a string')
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30 // version 3
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isLoopbackHost (host) {
  return typeof host === 'string' && LOOPBACK_HOSTS.has(host)
}

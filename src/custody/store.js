// Attach whitelist (Monoplayer front leg, player only) and the backend
// whitelist adapter built on the existing driver RCON adapter (puppet only).
//
// File shape (research 03 §4, not a secret, but kept out of git because it
// contains account identifiers):
//   { "version": 1, "players": [ { "uuid", "name", "addedAt" } ] }
//
// Rules baked in here:
//   - normalized lowercase hyphenated UUID keys, never names,
//   - name→UUID resolution at add time through the injectable lookup,
//   - atomic writes (via ./cache.js atomicWriteFile, 0600),
//   - puppet UUID must never appear in the attach whitelist (guarded with a
//     labelled warning; the single-account fallback is not a pass).
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFile, CACHE_FILE_MODE } from './cache.js'
import { normalizeUuid, sameUuid } from './util.js'

export const WHITELIST_VERSION = 1
export const DEFAULT_WHITELIST_FILE = path.join('.secrets', 'attach-whitelist.json')

// Name → UUID resolution, injectable in tests. Minecraft services first
// (the launcher's own API), legacy api.mojang.com as fallback — both return
// `{ id, name }` with an undashed UUID. Respect the ~200 req/2min Mojang
// ceiling; callers should cache as the whitelist store does by persisting
// results at add time.
export function createNameLookup ({
  fetchImpl = globalThis.fetch,
  // Primary: Minecraft services; fallback: legacy Mojang API.
  bases = [
    { url: 'https://api.minecraftservices.com/minecraft/profile/lookup/name' },
    { url: 'https://api.mojang.com/users/profiles/minecraft' },
  ],
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createNameLookup needs an injectable fetch (fetchImpl)')
  }
  return async function lookup (name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return null
    for (const [index, base] of bases.entries()) {
      const isLast = index === bases.length - 1
      try {
        const response = await fetchImpl(`${base.url}/${encodeURIComponent(name)}`)
        if (response.status === 200) {
          const body = await response.json()
          const uuid = normalizeUuid(body?.id)
          if (uuid) return { uuid, name: body.name }
        } else if (response.status === 404) {
          // Name does not exist; no point trying the fallback base.
          return null
        }
      } catch (error) {
        if (isLast) return { failed: true, reason: String(error && error.message ? error.message : error).slice(0, 120) }
        // try the next base
      }
    }
    return { failed: true, reason: 'name_lookup_exhausted' }
  }
}

function parsePlayers (raw) {
  const doc = raw === null ? { version: WHITELIST_VERSION, players: [] } : raw
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.players)) return null
  const players = []
  for (const entry of doc.players) {
    if (!entry || typeof entry !== 'object') continue
    const uuid = normalizeUuid(entry.uuid)
    if (!uuid) continue
    players.push({
      uuid,
      name: typeof entry.name === 'string' ? entry.name : null,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
    })
  }
  return { version: typeof doc.version === 'number' ? doc.version : WHITELIST_VERSION, players }
}

export function createWhitelistStore ({
  file = DEFAULT_WHITELIST_FILE,
  lookup = null,
  now = () => new Date().toISOString(),
  readFile = fs.readFileSync,
  existsSync = fs.existsSync,
  beforeRename = null,
  role = 'attach',
  knownOtherRoleUuids = () => [],
} = {}) {
  let doc = null

  function load () {
    try {
      doc = parsePlayers(JSON.parse(String(readFile(String(file), 'utf8'))))
    } catch {
      doc = { version: WHITELIST_VERSION, players: [] }
    }
    return doc
  }

  function persist () {
    atomicWriteFile(String(file), JSON.stringify(doc, null, 2) + '\n', { beforeRename, mode: CACHE_FILE_MODE })
  }

  function list () {
    doc ??= load()
    return [...doc.players]
  }

  function find (identifier) {
    doc ??= load()
    const byUuid = normalizeUuid(identifier)
    if (byUuid) return doc.players.find(player => player.uuid === byUuid) ?? null
    if (typeof identifier === 'string') {
      const lowered = identifier.toLowerCase()
      return doc.players.find(player => player.name && player.name.toLowerCase() === lowered) ?? null
    }
    return null
  }

  function has (identifier) {
    return find(identifier) !== null
  }

  async function add (identifier, { playerName = null } = {}) {
    doc ??= load()
    const byUuid = normalizeUuid(identifier)
    let uuid = byUuid
    let name = playerName
    if (!uuid) {
      if (typeof lookup !== 'function') {
        return { ok: false, reason: 'resolver_unavailable' }
      }
      const resolved = await lookup(String(identifier))
      if (!resolved || resolved.failed) {
        return { ok: false, reason: 'name_resolution_failed' }
      }
      uuid = normalizeUuid(resolved.uuid)
      name = resolved.name
    }
    if (!uuid) return { ok: false, reason: 'invalid_identifier' }

    const existing = doc.players.find(player => player.uuid === uuid)
    const record = { uuid, name: name ?? existing?.name ?? null, addedAt: existing?.addedAt ?? now() }
    if (existing) Object.assign(existing, record)
    else doc.players.push(record)
    persist()

    const warnings = []
    if (role === 'attach') {
      for (const other of knownOtherRoleUuids()) {
        if (sameUuid(other, uuid)) {
          warnings.push('this uuid is also on the backend whitelist; the two whitelists must stay separate')
        }
      }
    }
    return { ok: true, record, warnings }
  }

  function remove (identifier) {
    doc ??= load()
    const indexed = doc.players.findIndex(player => {
      const byUuid = normalizeUuid(identifier)
      if (byUuid) return player.uuid === byUuid
      return player.name && String(identifier).toLowerCase() === player.name.toLowerCase()
    })
    if (indexed === -1) return { ok: false, reason: 'not_present' }
    const [dropped] = doc.players.splice(indexed, 1)
    persist()
    return { ok: true, record: dropped }
  }

  // Store-side adapter for the attach whitelist: has(uuid) only, UUID-keyed.
  const store = {
    file,
    role,
    list,
    find,
    has: has,
    add,
    remove,
    reload: () => { doc = null; return load() },
  }
  return store
}

// Backend whitelist driven through the existing driver RCON adapter
// (`src/driver/rcon.js`): the server resolves names itself and writes its own
// whitelist.json, which keeps us out of the server's file custody entirely.
export function createBackendWhitelist ({ rcon }) {
  if (!rcon || typeof rcon.run !== 'function') {
    throw new Error('createBackendWhitelist needs the driver rcon adapter')
  }
  return {
    role: 'backend',
    async add (name) {
      return {
        add: await rcon.run(`whitelist add ${name}`, { kind: 'setup', label: 'whitelist-add' }),
        reload: await rcon.run('whitelist reload', { kind: 'setup', label: 'whitelist-reload' }),
      }
    },
    async remove (name) {
      return {
        remove: await rcon.run(`whitelist remove ${name}`, { kind: 'setup', label: 'whitelist-remove' }),
        reload: await rcon.run('whitelist reload', { kind: 'setup', label: 'whitelist-reload' }),
      }
    },
    async list () {
      return rcon.run('whitelist list', { kind: 'probe', label: 'whitelist-list' })
    },
  }
}

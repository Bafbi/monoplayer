// The runtime control document (#229, #262): the files an operator edits between
// deploys, each re-read at the point of use.
//
//   attachWhitelistFile   attach-whitelist.json  {version:1, players:[{uuid,name,addedAt}]}
//   allowedServersFile    allowed-servers.json   {version:1, servers:[{host,port,addedAt}]}
//
// There is no single control document, and no watcher. Each key is its own file
// with its own environment variable and its own reader, and each read is one file
// read at the moment the value is needed: the whitelist at every login, the
// allowed-server list when the picker offers it (#265).
//
// Naming a file is the switch for its key. The whitelist file is the one whose
// presence turns this module on at all: it is the first key, and a lane that names
// it loads the list. #264 removed the desired-backend key, and this is the line
// that had to survive it. A whitelist that does not load is a front that refuses
// every login with no error.
//
// One key differs from the other: the allowed-server list has a fallback. A
// missing or broken whitelist denies a login, which is safe and loud; a missing or
// broken server list offers a joining client nothing. So the list Git commits
// answers when the live file cannot.
//
// A control file that cannot be read or parsed is named and ignored, never fatal.
// The value never reaches loadConfig, because a throw at boot would stop the lane
// for the one file the operator was about to fix.
import fs from 'node:fs'

import { createWhitelistStore } from '../custody/store.js'

export const ALLOWED_SERVERS_VERSION = 1

// allowed-servers.json -> { servers, reason }. Each entry is one game server the
// picker offers (#262), and the row it becomes is `host:port` (#258: a row's name
// is the address a claim dials).
//
// Strict, and the same function the panel parses with. The whitelist needs two
// parsers because the custody store reads leniently at a login and the panel must
// refuse a document it would otherwise shorten; here there is one consumer of a
// broken file, and it is the fallback. A field this reader has no use for is
// dropped: this key has no document older than itself, so there is nothing to
// preserve in a rewrite.
export function parseAllowedServers (raw) {
  let doc
  try {
    doc = JSON.parse(String(raw))
  } catch {
    return { servers: null, reason: 'not_json' }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { servers: null, reason: 'not_an_object' }
  if (doc.version !== ALLOWED_SERVERS_VERSION) return { servers: null, reason: 'version' }
  if (!Array.isArray(doc.servers)) return { servers: null, reason: 'servers' }
  const servers = []
  const seen = new Set()
  for (const [index, entry] of doc.servers.entries()) {
    // `at` is the entry the refusal is about, so a route can say which line of the
    // file to fix rather than "an entry". A success carries no such field.
    const at = 'servers[' + index + ']'
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { servers: null, reason: 'server', at }
    const host = typeof entry.host === 'string' ? entry.host.trim() : ''
    if (host === '') return { servers: null, reason: 'host', at }
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return { servers: null, reason: 'port', at }
    // Two rows for one address are two buttons that dial the same server, and a
    // claim would land on whichever the picker happened to render first. A DNS name
    // is case-insensitive, so the comparison is.
    const address = host.toLowerCase() + ':' + entry.port
    if (seen.has(address)) return { servers: null, reason: 'duplicate', at }
    seen.add(address)
    // An entry the seed wrote has no stamp, and a rewrite must not give it one: the
    // panel may only add a field it means.
    const addedAt = typeof entry.addedAt === 'string' && entry.addedAt.trim() !== '' ? entry.addedAt : null
    servers.push({ host, port: entry.port, ...(addedAt === null ? {} : { addedAt }) })
  }
  return { servers, reason: null }
}

// A path a lane named, or nothing. One rule, so a blank variable and an unset one
// are the same fact everywhere in this module.
const named = value => typeof value === 'string' && value.trim() !== ''

// One reader for every file. Each path is its own switch: with all of them unset
// nothing is read and the lane behaves exactly as it did before #229.
export function createControlDocument ({
  whitelistFile = null,
  allowedServersFile = null,
  allowedServersSeedFile = null,
  readFile = fs.readFileSync,
  log = () => {}
} = {}) {
  const enabled = named(whitelistFile)
  const said = new Set()

  // One line per distinct refusal. A reconnect loop re-reads the same file every
  // few seconds, and a heartbeat of identical warnings is not a diagnosis.
  function sayOnce (event, fields) {
    const key = [event, fields.file, fields.reason ?? fields.code].map(value => String(value ?? '')).join(':')
    if (said.has(key)) return
    said.add(key)
    log(event, fields)
  }

  // One store for the whole process: the core reads the list through
  // attachWhitelist() and the front legs read has(). Every read reloads, so the
  // file is the only authority and a broken one is named, not silently empty.
  const whitelistStore = enabled
    ? createWhitelistStore({
      file: whitelistFile,
      reloadEachUse: true,
      onLoadError: ({ file, code }) => sayOnce('controlUnreadable', { file, code })
    })
    : null

  function attachWhitelist () {
    if (whitelistStore === null) return []
    return whitelistStore.list().map(player => player.uuid)
  }

  // One allowed-server file, as the list or the reason there is none. An unwritten
  // live key is the normal state before the first panel edit, not a failure: the
  // seed is the answer. Anything else that stops a read is named.
  function readAllowedServers (path) {
    let raw
    try {
      raw = String(readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') sayOnce('controlUnreadable', { file: path, code: error?.code ?? null })
      return { servers: null, reason: 'missing' }
    }
    const parsed = parseAllowedServers(raw)
    if (parsed.reason !== null) sayOnce('controlRejected', { file: path, reason: parsed.reason })
    return parsed
  }

  // #262: the list the picker offers (#265). The live key, else the copy Git
  // commits, else nothing. It never throws, so a picker can ask on every offer and
  // a broken file is one named line instead of a refused join.
  //
  // `source` is which file answered, because "the seed is what you are offering"
  // and "your edit is what you are offering" are different facts to an operator
  // reading the start record.
  function allowedServers () {
    if (!named(allowedServersFile)) return { servers: [], source: 'none' }
    const live = readAllowedServers(allowedServersFile)
    if (live.reason === null) return { servers: live.servers, source: 'control' }
    if (!named(allowedServersSeedFile)) return { servers: [], source: 'none' }
    const seed = readAllowedServers(allowedServersSeedFile)
    // The live key's absence is the normal state. The seed's is not: it is a file
    // this repository commits and the Deployment mounts, so a seed that is not there
    // is a mount to fix, and it is named once.
    if (seed.reason === 'missing') sayOnce('controlUnreadable', { file: allowedServersSeedFile, code: 'ENOENT' })
    if (seed.reason === null) return { servers: seed.servers, source: 'seed' }
    return { servers: [], source: 'none' }
  }

  return { enabled, whitelistStore, attachWhitelist, allowedServers }
}

// #233: what a restored move does to the dial. A move that a target did not answer
// puts the client back on the backend it came from, and the puppet must dial that
// backend again: the session behind the restored client is a new one.
//
// A reconfigure is the exception, because it never left the server: it is the same
// connection restarting its configuration phase, so there is no target to abandon
// and the puppet stays where it is. Every other kind moved the session off this
// backend, and reading one of them as "not a transfer, keep the target" is the
// defect: the next dial then goes back to the server that never answered, with the
// client attached, for as long as the process lives.
export function revertAfterRestore ({ kind = null } = {}) {
  return kind !== 'reconfigure'
}

// The leg options for a dial. A transfer, and the return to a server a transfer
// moved the session to, ask for the transfer handshake and keep their cookies:
// that is the behaviour every lane had before this ticket. Anything else is a fresh
// login on the server the session is already on: intent 3 on a server that did not
// send a transfer is the rejection sky-2 answers with.
//
// `transfer` is the provenance of the target, not the source of the dial: the
// caller knows whether this server was reached by a followed transfer, and the
// rule only needs that one bit.
export function dialIntent ({ transfer = false, target, base }) {
  const onBase = target.host === base.host && target.port === base.port
  const follows = transfer === true && !onBase
  return { keepCookies: follows, transfer: follows }
}

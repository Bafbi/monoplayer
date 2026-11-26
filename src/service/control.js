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
// answers whenever the live file offers none, including a lane that never named the
// live file at all (#356).
//
// A control file that cannot be read or parsed is named and ignored, never fatal.
// The value never reaches loadConfig, because a throw at boot would stop the lane
// for the one file the operator was about to fix.
import fs from 'node:fs'

import { createWhitelistStore } from '../custody/store.js'

export const ALLOWED_SERVERS_VERSION = 1

// One address, as DNS reads it, for the question "is this the same server as that
// one?" A host name is case-insensitive. A trailing dot is the root label, not a
// second name. So two rows that spell one host both ways are one server offered
// twice: two picker buttons over one cache (#314, #260). The port is part of the
// address, so one host on two ports is two servers.
//
// This key is for comparison only. What a row keeps is the host the operator wrote,
// because a host is what the socket dials (#265).
//
// Exported as the one rule for "is this the same address as that one", over an allowed
// server, a picker row, and a dial target. The parser above, the panel's add and remove
// (#339), and the dial policy below all ask it here. A second spelling of this comparison
// is how one host became two servers twice.
export function addressKey (host, port) {
  const name = String(host ?? '').trim().toLowerCase()
  return (name.endsWith('.') ? name.slice(0, -1) : name) + ':' + port
}

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
    // claim would land on whichever the picker happened to render first. The
    // comparison is the one a resolver makes, not the one a string does (#314).
    const address = addressKey(host, entry.port)
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
  // few seconds, and a heartbeat of identical warnings is not a diagnosis. The entry
  // is part of the refusal. An operator fixes row 1, the collision moves to row 2,
  // and the second refusal has a second row to fix.
  function sayOnce (event, fields) {
    const key = [event, fields.file, fields.reason ?? fields.code, fields.at]
      .map(value => String(value ?? '')).join(':')
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

  // The two files this key has, in the order they are asked. Each row carries its own
  // word for an absence, and whether that absence is a fault to name. Writing the
  // order down once is the whole precedence (#356): the live key answers, else the
  // copy Git commits, else nothing. A lane names either one, so an unnamed live key
  // is not a lane without a list.
  const allowedServerSources = [
    { source: 'control', file: allowedServersFile, whenMissing: 'live_missing', absenceIsFault: false },
    { source: 'seed', file: allowedServersSeedFile, whenMissing: 'seed_missing', absenceIsFault: true }
  ]

  // One allowed-server file, as the list or the reason there is none. An unwritten
  // live key is the normal state before the first panel edit, not a failure: the
  // seed is the answer. Anything else that stops a read is named.
  function readAllowedServers (path) {
    let raw
    try {
      raw = String(readFile(path, 'utf8'))
    } catch (error) {
      // #315: an absent file and a file the process is not allowed to read are two
      // different repairs, so they are two reasons. Only ENOENT means nobody wrote it.
      if (error?.code === 'ENOENT') return { servers: null, reason: 'missing' }
      sayOnce('controlUnreadable', { file: path, code: error?.code ?? null })
      return { servers: null, reason: 'unreadable' }
    }
    const parsed = parseAllowedServers(raw)
    // `at` is the entry the refusal is about. A document with two rows that name one
    // server has one row to fix, and an operator reading this line is looking at both.
    if (parsed.reason !== null) {
      sayOnce('controlRejected', { file: path, reason: parsed.reason, ...(parsed.at ? { at: parsed.at } : {}) })
    }
    return parsed
  }

  // #262: the list the picker offers (#265). The live key, else the copy Git
  // commits, else nothing. It never throws, so a picker can ask on every offer and
  // a broken file is one named line instead of a refused join. #356: the order is
  // `allowedServerSources`, and this reads it in that order.
  //
  // `source` is which file answered, because "the seed is what you are offering"
  // and "your edit is what you are offering" are different facts to an operator
  // reading the start record.
  //
  // #315: `reason` is why there is no list when there is none, and null when one
  // answered. Each value is a different edit, which is the whole use of it: an
  // operator who reads "the list is empty" already knew that. `file` is the file that
  // answered, or the one to repair when none did.
  //
  //   no_key        nothing names a list: the lane set neither variable. Set
  //                 MONOPLAYER_ALLOWED_SERVERS, or MONOPLAYER_ALLOWED_SERVERS_SEED.
  //   live_missing  the live key names a file nobody has written. Write it, or let
  //                 the panel write it.
  //   empty_list    the file read and holds no servers. Add one back.
  //   seed_missing  the seed this lane names is not on its mount. Fix the mount.
  //   unreadable    the file is there and the read failed. Read the controlUnreadable
  //                 line, which carries the errno.
  //
  // #372: a document that does not parse keeps the code `parseAllowedServers` gave it
  // and the entry that code names (`at`), instead of collapsing into one word. That
  // list of codes lives in that function; this answer repeats none of them.
  //
  // A file that answered, as the picker's answer. A list a file answers with is the
  // list; a file that answers with no servers is the one empty state a read cannot
  // see, because the file is valid and the list is deliberately empty.
  function fileAnswer (servers, source, file) {
    return { servers, source, file, reason: servers.length === 0 ? 'empty_list' : null, at: null }
  }

  function allowedServers () {
    // The first source that answers is the list. A file nobody wrote and a file that
    // does not parse are two repairs, so each source carries its own word.
    // #372: two answers, and the fault wins. `last` is the last source asked, which is
    // the operator's edit when neither failure is a fault. `fault` is the first source
    // whose failure is one, and it is the file whose repair brings the list back: the
    // live key's absence is the normal state the seed exists for, but a file that does
    // not parse is a fault wherever it sits.
    let last = null
    let fault = null
    for (const { source, file, whenMissing, absenceIsFault } of allowedServerSources) {
      if (!named(file)) continue
      const read = readAllowedServers(file)
      if (read.reason === null) return fileAnswer(read.servers, source, file)
      // The seed's absence is a mount to fix, so it is named once. The live key's
      // absence is the normal state the seed exists for, so that one is not a line.
      if (absenceIsFault === true && read.reason === 'missing') {
        sayOnce('controlUnreadable', { file, code: 'ENOENT' })
      }
      last = {
        servers: [],
        source: 'none',
        file,
        reason: read.reason === 'missing' ? whenMissing : read.reason,
        at: read.at ?? null
      }
      if (fault === null && (absenceIsFault === true || read.reason !== 'missing')) fault = last
    }
    return fault ?? last ?? { servers: [], source: 'none', file: null, reason: 'no_key', at: null }
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
  // The base spelled another way is the base. Comparing the two hosts as strings reads
  // `Paper.Example.NET.` as a different server, so the dial asks the server the session is
  // already on for the transfer handshake (#339).
  const onBase = addressKey(target.host, target.port) === addressKey(base.host, base.port)
  const follows = transfer === true && !onBase
  return { keepCookies: follows, transfer: follows }
}

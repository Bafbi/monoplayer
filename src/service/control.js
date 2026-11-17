// The runtime control document (#229): the two files an operator edits between
// deploys, both re-read at the point of use.
//
//   control.file          desired.json           {version:1, backend:{host,port}, changedAt, changedBy}
//   attachWhitelistFile   attach-whitelist.json  {version:1, players:[{uuid,name,addedAt}]}
//
// There is no watcher. A login and a backend dial are both rare, so each read is
// one file read at the moment the value is needed: the whitelist at every login,
// the desired backend before every backend connect.
//
// A control file that cannot be read or parsed is named and ignored, never fatal.
// The value never reaches loadConfig, because a throw at boot would stop the lane
// for the one file the operator was about to fix.
import fs from 'node:fs'

import { createWhitelistStore } from '../custody/store.js'

export const DESIRED_VERSION = 1

// desired.json -> { target, reason }. The shape is the ticket's: a version, one
// backend, and the two fields a dial needs. A reason is a word an operator can
// find in the log, never a message that repeats the document.
export function parseDesiredTarget (raw) {
  let doc
  try {
    doc = JSON.parse(String(raw))
  } catch {
    return { target: null, reason: 'not_json' }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { target: null, reason: 'not_an_object' }
  }
  if (doc.version !== DESIRED_VERSION) return { target: null, reason: 'version' }
  const host = doc.backend?.host
  const port = doc.backend?.port
  if (typeof host !== 'string' || host.trim() === '') return { target: null, reason: 'host' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { target: null, reason: 'port' }
  return { target: { host: host.trim(), port }, reason: null }
}

// One reader for both files. `file` is the switch: with it unset nothing is read
// and the lane behaves exactly as it did before this ticket.
export function createControlDocument ({
  file = null,
  whitelistFile = null,
  allowBackendSwitch = false,
  readFile = fs.readFileSync,
  log = () => {}
} = {}) {
  const enabled = typeof file === 'string' && file.trim() !== ''
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
  const whitelistStore = enabled && typeof whitelistFile === 'string' && whitelistFile.trim() !== ''
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

  function desiredTarget () {
    if (!enabled) return null
    let raw
    try {
      raw = String(readFile(file, 'utf8'))
    } catch (error) {
      // A control document the operator has not written yet is the normal state,
      // not an error. Anything else is named: a directory path, a bad mount.
      if (error?.code !== 'ENOENT') sayOnce('controlUnreadable', { file, code: error?.code ?? null })
      return null
    }
    if (!allowBackendSwitch) {
      // Settled in #229: log once, named, and continue on the configured backend.
      sayOnce('controlSwitchRefused', { file })
      return null
    }
    const parsed = parseDesiredTarget(raw)
    if (parsed.target === null) {
      sayOnce('controlRejected', { file, reason: parsed.reason })
      return null
    }
    return parsed.target
  }

  return { enabled, file, whitelistStore, attachWhitelist, desiredTarget }
}

// The target the next backend connect dials. A followed transfer wins, because a
// transfer is the server moving the session. A desired backend applies only while
// no client is attached: moving a live session is the last ticket in the epic,
// and this one must never disturb an attached client. Everything else dials the
// target the session is already on.
export function dialTargetFor ({ transfer = null, desired = null, current = null, attached = false } = {}) {
  if (transfer !== null) return { target: transfer, source: 'transfer' }
  if (desired !== null && attached !== true) return { target: desired, source: 'desired' }
  return { target: current, source: 'current' }
}

// The leg options for a dial. A followed transfer, and the return to a server a
// transfer moved the session to, ask for the transfer handshake and keep their
// cookies: that is the behaviour every lane had before this ticket.
//
// `current` alone does not say which happened. A server off the base is one a
// transfer moved the session to (preserve, and ask for the handshake) or one a
// desired backend sent it to (a fresh login, no cookies). `currentIsTransfer`
// carries that one bit, and it is false on every lane without a control file.
export function dialIntent ({ source, target, base, currentIsTransfer = false }) {
  const onBase = target.host === base.host && target.port === base.port
  const follows = !onBase && (source === 'transfer' || (source === 'current' && currentIsTransfer))
  return { keepCookies: follows, transfer: follows }
}

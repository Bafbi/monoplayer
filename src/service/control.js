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
//
// `changedAt` rides along untouched. Nothing dials with it: it is how #233 tells
// a new operator intent from the one whose move already failed, so a rewrite of
// the same address retries once and an unchanged document never retries.
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
  const changedAt = typeof doc.changedAt === 'string' && doc.changedAt.trim() !== '' ? doc.changedAt : null
  return { target: { host: host.trim(), port, changedAt }, reason: null }
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
// transfer is the server moving the session. Then an operator move (#233), which
// is the one path that may carry a desired backend onto an attached session: the
// core started it, so the dial belongs to it and not to the next connect. A
// desired backend on its own still applies only while no client is attached,
// because a reconnect is not an operator's act. Everything else dials the target
// the session is already on.
export function dialTargetFor ({ transfer = null, operator = null, desired = null, current = null, attached = false } = {}) {
  if (transfer !== null) return { target: address(transfer), source: 'transfer' }
  if (operator !== null) return { target: address(operator), source: 'operator' }
  if (desired !== null && attached !== true) return { target: address(desired), source: 'desired' }
  return { target: current, source: 'current' }
}

// A dial target is host and port, nothing else. The control document's
// `changedAt` identifies an operator intent and must not travel into the state
// this orchestrator compares targets with.
function address (target) {
  return { host: target.host, port: target.port }
}

// #233: the heartbeat's one question, asked on the tick the service already runs.
//
// `desired` is what the control document names now, or null, which is the case
// both when no operator wrote one and when `allowBackendSwitch` refused it
// (desiredTarget() has named that refusal once already). `current` is the backend
// the puppet is on. `attempted` is the document whose move already failed: with
// the old backend restored, an unchanged document would otherwise start the same
// doomed move every tick, and each attempt costs the human a configuration round.
// A rewrite of the same address is a new document, because the panel stamps a new
// `changedAt`, so the operator's retry stays available.
export function moveDue ({ desired = null, current = null, attempted = null } = {}) {
  if (desired === null) return { move: null, reason: 'no_desired' }
  if (current !== null && desired.host === current.host && desired.port === current.port) {
    return { move: null, reason: 'in_use' }
  }
  if (attempted !== null && sameDocument(attempted, desired)) {
    return { move: null, reason: 'already_attempted' }
  }
  return { move: { host: desired.host, port: desired.port, changedAt: desired.changedAt ?? null }, reason: null }
}

function sameDocument (a, b) {
  return a.host === b.host && a.port === b.port && (a.changedAt ?? null) === (b.changedAt ?? null)
}

// #233: the tick. The service's heartbeat calls `tick`, and so does the loopback
// rung, which is why the memory this needs lives in a closure here rather than in
// `runForever` where no rung can reach it.
//
// It reads the control document at every tick, because that is the cadence the
// ticket recorded and a document is a small file. What it does not do is retry:
// a move that failed cost the human a configuration round, so the document that
// failed is skipped, once with a reason, until the operator writes a new one.
export function createBackendMoveTick ({ core, control, log = () => {}, current = () => null } = {}) {
  if (typeof core?.startBackendMove !== 'function') {
    throw new TypeError('createBackendMoveTick: core must offer startBackendMove')
  }
  if (typeof control?.desiredTarget !== 'function') {
    throw new TypeError('createBackendMoveTick: control must offer desiredTarget')
  }
  // The document whose move already started. Not cleared on success: a successful
  // move makes the target equal `current`, so the document stops being a move on
  // its own.
  let attempted = null
  // The deferred document this tick has already named, so a client parked in its
  // own configuration is one line and not one per tick. A different document, or a
  // move that started, clears it.
  let deferred = null

  function tick () {
    const desired = control.desiredTarget()
    const decision = moveDue({ desired, current: current(), attempted })
    if (decision.move === null) {
      if (decision.reason === 'already_attempted' && attempted.said !== true) {
        attempted.said = true
        log('backendMoveNotRetried', {
          host: desired.host,
          port: desired.port,
          changedAt: desired.changedAt ?? null,
          reason: 'previous_failure'
        })
      }
      return null
    }
    attempted = decision.move
    const outcome = core.startBackendMove({ target: decision.move, reason: 'heartbeat' })
    if (outcome.started !== true) {
      // Nothing was spent, so the next tick asks again. The core named the
      // refusal; a client still in its own configuration is the usual reason, and
      // one line per distinct refusal is enough to see it.
      attempted = null
      const key = `${outcome.reason}:${decision.move.host}:${decision.move.port}`
      if (deferred !== key) {
        deferred = key
        log('backendMoveDeferred', { reason: outcome.reason, host: decision.move.host, port: decision.move.port })
      }
    }
    return outcome
  }

  return { tick, get attempted () { return attempted } }
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
// that is the behaviour every lane had before this ticket. A desired backend, and
// the operator move #233 starts from one, is a fresh login on a server that never
// saw the puppet: intent 3 on a server that did not send a transfer is the
// rejection sky-2 answers with.
//
// `transfer` is the provenance of the target, not the source of the dial: the
// caller knows whether this server was reached by a followed transfer, and the
// rule only needs that one bit.
export function dialIntent ({ transfer = false, target, base }) {
  const onBase = target.host === base.host && target.port === base.port
  const follows = transfer === true && !onBase
  return { keepCookies: follows, transfer: follows }
}

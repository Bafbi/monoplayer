#!/usr/bin/env node
// Live G1 attach-gate fixture. Runs a minimal online-mode minecraft-protocol
// server, lets the library perform the real sessionserver hasJoined, then
// applies the synchronous UUID attach gate in beforeLogin. It is deliberately
// not the product front leg: it proves allow/deny before Login Success without
// needing Monoplayer.
//
// Usage:
//   node src/auth/fixture-cli.js [--port 25565] [--file .secrets/attach-whitelist.json]
//                               [--host 127.0.0.1] [--version 26.1]
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAttachGate, ATTACH_ALLOWED_EVENT, ATTACH_DENIED_EVENT } from './attach.js'
import { createAttachFixture } from './fixture.js'
import { createWhitelistStore } from './store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseArgs (argv) {
  const opts = {
    host: '127.0.0.1',
    port: 25565,
    version: '26.1',
    file: path.join(root, '.secrets', 'attach-whitelist.json'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host') opts.host = argv[++i]
    else if (arg === '--port') opts.port = Number(argv[++i])
    else if (arg === '--version') opts.version = argv[++i]
    else if (arg === '--file') opts.file = argv[++i]
    else if (arg === '--help' || arg === '-h') { console.log('usage: node src/auth/fixture-cli.js [--port 25565] [--file path] [--version 26.1]'); process.exit(0) }
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const store = createWhitelistStore({ file: opts.file })
const gate = createAttachGate({ log: line => console.error(line) })

gate.events.on(ATTACH_ALLOWED_EVENT, event => console.log(JSON.stringify({ event: 'attachAllowed', ...event })))
gate.events.on(ATTACH_DENIED_EVENT, event => console.log(JSON.stringify({ event: 'attachDenied', ...event })))

const fixture = createAttachFixture({
  host: opts.host,
  port: opts.port,
  version: opts.version,
  onlineMode: true, // real hasJoined before the synchronous whitelist gate
  store,
  gate,
})

fixture.server.on('listening', () => {
  console.log(`fixture listening on ${opts.host}:${fixture.port()} version=${opts.version} whitelist=${opts.file}`)
})
fixture.server.on('login', client => {
  if (client.monoplayerDenied) return // library emits this after a denied beforeLogin
  console.log(JSON.stringify({ event: 'login', username: client.username, uuid: client.uuid }))
  client.on('end', reason => console.log(JSON.stringify({ event: 'end', username: client.username, reason })))
})
fixture.server.on('error', error => console.error(`fixture error: ${error.message}`))

function shutdown () {
  try { fixture.server.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

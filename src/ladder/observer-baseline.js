// The direct baseline join for the observer report (#12).
//
//   node src/ladder/observer-baseline.js [--host <h>] [--port <n>]
//                                        [--accounts <dir>] [--account <selector>]
//
// The observer report compares what a server knows about the puppet with what it
// knows about a client that joined it directly. This is that direct client: the
// puppet account itself, connecting to the backend with no proxy in between, so
// the proxy is the only variable between the two joins. Using the same account is
// the point. A different account would put `player` and `uuid` in the report as
// differences and hide the ones being measured.
//
// It runs where the custody is, in a throwaway pod that holds a copy of it
// (scripts/observer-report.sh). It never runs against the live deployment, and it
// takes no writer lock, because the copy is the pod's own.
//
// Exit codes: 0 the join landed, 1 it did not, 2 setup failed.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { brandFrame, FABRIC_BRAND } from '../core/client-settings.js'
import { createTokenCustody } from '../custody/cache.js'
import { DEFAULT_ACCOUNTS_DIR, resolveAccount } from '../custody/accounts.js'
import { flag } from '../service/cli.js'
import { createBot } from './bot.js'

// `||` not `??`: an empty MONOPLAYER_VERSION means unset, and an empty version
// would let minecraft-protocol pick its own defaultVersion instead of the gate
// Paper's.
const VERSION = process.env.MONOPLAYER_VERSION || '26.2'
const DEFAULT_SELECTOR = 'glowsquidye'
const JOIN_TIMEOUT_MS = Number(process.env.MONOPLAYER_BASELINE_TIMEOUT_MS ?? 120_000)

// Resolve a bot identity from token custody. Two rungs join as the same account
// twice — the observer baseline once, the client-parity rung once directly and
// once through the proxy — so the resolution lives here, once.
export function resolveBotIdentity ({ accountsDir = DEFAULT_ACCOUNTS_DIR, selector = DEFAULT_SELECTOR } = {}) {
  const resolved = resolveAccount({ accountsDir, selector })
  if (!resolved.ok) {
    throw new Error(`cannot resolve the account '${selector}' in ${accountsDir}: ${resolved.reason}`)
  }
  const picked = resolved.account
  const custody = createTokenCustody({
    account: picked.alias ?? picked.name ?? picked.uuid,
    dir: path.resolve(picked.dir),
    uuid: picked.uuid,
    create: false,
    legacyAccount: picked.name ?? null
  })
  return {
    auth: 'microsoft',
    // What the log calls the account: the alias or uuid, never the raw
    // selector it was asked for.
    account: picked.alias ?? picked.uuid,
    username: picked.name ?? picked.alias ?? picked.uuid,
    profilesFolder: custody.cacheFactory,
    authTitle: picked.profile?.authTitle ?? null,
    deviceType: picked.profile?.deviceType ?? null
  }
}

// Which of the two failures it was. #79 asked the report to tell a start that did
// not happen from a join that was refused, and the rung's exit status is how the
// script tells: 2 for a setup this rung refused before it opened a socket, 1 for
// anything the server did. An untagged error is the second kind, because by then
// the socket exists.
const SETUP = 'setup'

function setupFailure (error) {
  if (error && typeof error === 'object') error.phase = SETUP
  return error
}

function createBotSafely (options) {
  try {
    return createBot(options)
  } catch (error) {
    throw setupFailure(error)
  }
}

// The phase of a failure, for a reader and for the caller's exit status.
export function phaseOf (error) {
  return error?.phase === SETUP ? SETUP : 'join'
}

// #78: the baseline client stands in for the human's Fabric client, which is the
// client #17 decided the server sees, so it announces the brand the proxy
// announces. Without it the report's brand row compares what the puppet says
// against nothing, and a bot that says nothing is a tell a real server can see.
// The frame goes out once per connection. The trigger is the server's
// `select_known_packs`: the proxy announces on its first configuration frame
// instead, and this client's first frames are the server's own brand and its
// feature list, which it does not need to answer.
export function announceBrand (client, { brand = FABRIC_BRAND, log = () => {} } = {}) {
  if (typeof client?.once !== 'function' || typeof client?.write !== 'function') {
    throw new TypeError('client must be a minecraft-protocol client')
  }
  client.once('select_known_packs', () => {
    const frame = brandFrame(brand)
    try {
      client.write(frame.name, frame.packet)
      log('baselineBrand', { channel: frame.packet.channel, brand })
    } catch (error) {
      log('baselineBrandFailed', { error: String(error?.message ?? error).slice(0, 200) })
    }
  })
  return client
}

// Join, confirm the play login arrived, leave. The observer on the server is what
// records the view; this only has to produce one join.
export async function runBaseline ({
  host,
  port,
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  account = DEFAULT_SELECTOR,
  version = VERSION,
  timeoutMs = JOIN_TIMEOUT_MS,
  log = () => {}
} = {}) {
  if (typeof host !== 'string' || host.length === 0) throw setupFailure(new TypeError('host is required'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw setupFailure(new TypeError('port must be an integer in 1..65535'))
  }

  let identity
  try {
    identity = resolveBotIdentity({ accountsDir, selector: account })
  } catch (error) {
    throw setupFailure(error)
  }
  log('baselineStart', { host, port, account: identity.account, name: identity.username })

  const bot = createBotSafely({
    host,
    port,
    version,
    username: identity.username,
    auth: identity.auth,
    profilesFolder: identity.profilesFolder,
    authTitle: identity.authTitle,
    deviceType: identity.deviceType,
    log
  })
  announceBrand(bot.client, { log })

  try {
    await bot.ready(timeoutMs)
    log('baselineJoined', { entityId: bot.received.login?.entityId ?? null })
    return { joined: true, name: identity.username }
  } finally {
    try { await bot.close?.() } catch { /* the join is what mattered */ }
  }
}

async function main (argv = process.argv.slice(2)) {
  const host = flag(argv, '--host') ?? process.env.MONOPLAYER_BACKEND_HOST ?? '127.0.0.1'
  const port = Number(flag(argv, '--port') ?? process.env.MONOPLAYER_BACKEND_PORT ?? 25565)
  const accountsDir = flag(argv, '--accounts') ?? process.env.MONOPLAYER_PUPPET_ACCOUNTS_DIR ?? DEFAULT_ACCOUNTS_DIR
  const account = flag(argv, '--account') ?? DEFAULT_SELECTOR
  const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n')
  try {
    const result = await runBaseline({ host, port, accountsDir, account, log })
    return result.joined ? 0 : 1
  } catch (error) {
    const phase = phaseOf(error)
    process.stderr.write(`observer-baseline: ${phase}: ${String(error?.message ?? error)}\n`)
    return phase === SETUP ? 2 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}

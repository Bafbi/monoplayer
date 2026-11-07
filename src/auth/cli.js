#!/usr/bin/env node
// Gate B G1 auth CLI (no mise task wiring here; the orchestrator owns
// mise.toml). Everything user-facing about codes goes to stderr; stdout
// carries only sanitized facts (name, UUID, entitlement names, privilege,
// custody facts). Token values are never printed, logged, or returned.
//
// Usage:
//   node src/auth/cli.js device-code [--account puppet] [--dir <cacheDir>]
//   node src/auth/cli.js status [--account puppet] [--dir <cacheDir>] [--json]
//   node src/auth/cli.js status --refresh ...
//   node src/auth/cli.js whitelist <attach|backend> add|remove <name-or-uuid>
//        [--file .secrets/attach-whitelist.json] [--namespace ... --deployment ...]
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenCustody } from './cache.js'
import { createMsaAuth, describeIdentity } from './msa.js'
import { createAuthStatus, stringifyForReport, redactForReport, scanForLeaks } from './status.js'
import { createWhitelistStore, createBackendWhitelist, createNameLookup } from './store.js'
import { createRcon } from '../gate-b/rcon.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function defaultDir (account) {
  return process.env.GATEB_AUTH_DIR ?? path.join(REPO_ROOT, '.secrets', account)
}

function parseArgs (argv) {
  const args = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { args.positional.push(arg); continue }
    switch (arg) {
      case '--account': case '--dir': case '--file': case '--namespace': case '--deployment':
        args[arg.slice(2)] = argv[++i]
        break
      case '--json':
        args.json = true
        break
      case '--refresh':
        args.refresh = true
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }
  return args
}

const USAGE = [
  'usage:',
  '  node src/auth/cli.js device-code [--account <name>] [--dir <dir>]',
  '  node src/auth/cli.js status [--account <name>] [--dir <dir>] [--json] [--refresh]',
  '  node src/auth/cli.js whitelist attach|backend add|remove <name-or-uuid> [--file <path>] [--namespace <ns>] [--deployment <dep>]',
].join('\n')

function fail (message, code = 1) {
  process.stderr.write(`error: ${message}\n${USAGE}\n`)
  process.exit(code)
}

function lockRefusal (message, holder) {
  // Exit code 2: refused, not failed — the caller should not retry blindly.
  process.stderr.write(`refused: ${message}${holder?.pid ? ` (holder pid ${holder.pid})` : ''}\n`)
  process.exit(2)
}

function emitReport (text) {
  const safe = redactForReport(String(text ?? ''))
  process.stdout.write(safe + '\n')
  const leaks = scanForLeaks(safe)
  if (leaks.length > 0) {
    process.stderr.write(`warning: ${leaks.length} secret-shaped string(s) were tagged in status output\n`)
  }
}

async function main () {
  const [command = '', ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const account = args.account ?? 'puppet'
  const dir = args.dir ?? defaultDir(account)
  const custody = createTokenCustody({ account, dir })

  switch (command) {
    case 'device-code': {
      // Codes/URLs to stderr; stdout gets the sanitized identity summary.
      const stdioCodeSink = line => process.stderr.write(`${line}\n`)
      const msa = createMsaAuth({ account, dir, custody })
      const attempts = []
      const result = await msa.bootstrapDeviceCode({
        codeSink: stdioCodeSink,
        onAttempt: attempt => attempts.push(attempt),
      })
      if (result.refused) lockRefusal(`cannot bootstrap while another writer holds the custody lock`, result.holder ?? undefined)
      if (!result.ok) {
        process.stderr.write(`device-code bootstrap failed: ${result.reason ?? 'unknown'}\n`)
        for (const attempt of attempts) process.stderr.write(`  - title ${attempt.authTitle ?? '?'}: [${attempt.failure}] ${attempt.message}\n`)
        process.exit(1)
      }
      process.stdout.write(`${describeIdentity(result.identity)}\n`)
      process.stdout.write(`cache: ${custody.cacheFile('live')} (0600, atomic, one-writer)\n`)
      return
    }

    case 'status': {
      const status = createAuthStatus({ account, dir, custody })
      if (args.refresh) {
        const result = await status.refresh()
        if (result.refused) lockRefusal(`status --refresh refuses while the writer lock is held (proxy running?)`, result.holder ?? undefined)
        emitReport(result.identityLine ?? `refresh: ${result.reason ?? 'unknown outcome'}`)
        if (result.ok && result.uuidStable === false) {
          process.stderr.write(`WARNING: uuid changed across refresh (was ${result.previousUuid}) — investigate before any Gate B run\n`)
          process.exit(1)
        }
        if (result.ok && result.uuidStable === null) {
          process.stderr.write('note: no prior identity to compare; this is the first bootstrap\n')
        }
        if (args.json) emitReport(stringifyForReport(result))
        if (!result.ok) process.exit(1)
        return
      }
      const report = await status.collect()
      emitReport(args.json ? stringifyForReport(report) : summarizeStatusLines(report))
      return
    }

    case 'whitelist': {
      const [scope = '', action = '', identifier = ''] = args.positional
      if (scope !== 'attach' && scope !== 'backend') fail(`whitelist scope must be attach or backend`)
      if (action !== 'add' && action !== 'remove') fail(`whitelist action must be add or remove`)
      if (!identifier) fail(`whitelist ${action} needs a name or UUID`)

      if (scope === 'attach') {
        const store = createWhitelistStore({
          file: args.file ?? path.join(REPO_ROOT, '.secrets', 'attach-whitelist.json'),
          lookup: createNameLookup(),
        })
        if (action === 'add') {
          const result = await store.add(identifier)
          if (!result.ok) fail(`whitelist add failed: ${result.reason}`)
          process.stdout.write(`added ${result.record.uuid}${result.record.name ? ` (${result.record.name})` : ''}\n`)
          for (const warning of result.warnings ?? []) process.stderr.write(`warning: ${warning}\n`)
        } else {
          const result = store.remove(identifier)
          if (!result.ok) fail(`whitelist remove failed: ${result.reason}`)
          process.stdout.write(`removed ${result.record.uuid}${result.record.name ? ` (${result.record.name})` : ''}\n`)
        }
        return
      }

      // backend scope: through the existing rcon adapter (server resolves
      // and persists its own whitelist.json).
      const whitelist = createBackendWhitelist({
        rcon: createRcon({ namespace: args.namespace, deployment: args.deployment }),
      })
      if (action === 'add') {
        const results = await whitelist.add(identifier)
        process.stdout.write(`add: ${(results.add.ok ? results.add.output : results.add.stderr) || '(no output)'}\n`)
        process.stdout.write(`reload: ${(results.reload.ok ? results.reload.output : results.reload.stderr) || '(no output)'}\n`)
        if (!results.add.ok || !results.reload.ok) process.exit(1)
      } else {
        const results = await whitelist.remove(identifier)
        process.stdout.write(`remove: ${(results.remove.ok ? results.remove.output : results.remove.stderr) || '(no output)'}\n`)
        process.stdout.write(`reload: ${(results.reload.ok ? results.reload.output : results.reload.stderr) || '(no output)'}\n`)
        if (!results.remove.ok || !results.reload.ok) process.exit(1)
      }
      return
    }

    default:
      fail(`unknown command '${command}'`)
  }
}

function summarizeStatusLines (report) {
  const lines = [
    `account=${report.account} dir=${report.cacheDir} mode=${report.cacheDirMode ?? '?'} files=${report.files.map(f => f.name).join(',') || '(none)'}`,
    `live-cache: refresh-token=${report.live.hasRefreshToken ? 'present' : 'absent'} access-token-expires=${report.live.accessTokenExpiresAt ?? 'n/a'}`,
    `mca-cache: access-token=${report.mca.hasAccessToken ? 'present' : 'absent'} expires=${report.mca.expiresAt ?? 'n/a'}`,
    `identity: ${report.identity ? `${report.identity.uuid}${report.identity.name ? ` (${report.identity.name})` : ''} asOf ${report.identity.updatedAt}` : 'not bootstrapped yet'}`,
    `writer-lock: ${report.writerLock.held ? `HELD (pid ${report.writerLock.holder?.pid ?? '?'})` : 'free'}`,
  ]
  return lines.join('\n')
}

main().catch(error => fail(String(error && error.message ? error.message : error)))

#!/usr/bin/env node
// Custody CLI for accounts, tokens, status, migration, and whitelists (no mise
// mise.toml). Everything user-facing about codes goes to stderr; stdout
// carries only sanitized facts (name, UUID, alias, entitlement names,
// privilege, custody facts). Token values are never printed, logged, or
// returned.
//
// Custody layout: one directory per Minecraft UUID under
// `.secrets/accounts/<uuid>/` (profile.json + <family>-cache.json +
// writer.lock). A selector is a UUID, alias, or profile name. `--dir` is the
// raw-directory escape hatch and must already hold a profile.json.
//
// `--secrets-dir <dir>` replaces `<repo>/.secrets` as the custody root: the
// account tree defaults to its `accounts/`, staging to its `staging/`, the
// retired quarantine to its `retired/`, and the attach whitelist to its
// `attach-whitelist.json`. `--accounts-dir` overrides only the account tree.
//
// Exit status: 0 done, 1 failed (an operation did not succeed), 2 refused (the
// request cannot be honoured: no such account, an ambiguous selector, a usage
// error, a held lock, a target that exists or sits on another filesystem).
// `migrate --dry-run` is the one command that always exits 0, because its
// report is the answer.
//
// Usage:
//   node src/custody/cli.js accounts [--accounts-dir <dir>] [--secrets-dir <dir>] [--json]
//   node src/custody/cli.js device-code [--account <uuid|alias|name>] [--alias <alias>] [--secrets-dir <dir>]
//   node src/custody/cli.js device-code --dir <accountDir>
//   node src/custody/cli.js status [--account ...] [--json] [--refresh] [--secrets-dir <dir>]
//   node src/custody/cli.js migrate [--apply] [--dry-run] [--from <name>] [--no-quarantine] [--secrets-dir <dir>]
//   node src/custody/cli.js whitelist <attach|backend> add|remove <name-or-uuid>
//        [--file <secretsDir>/attach-whitelist.json] [--secrets-dir <dir>] [--namespace ... --deployment ...]
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenCustody, readProfile } from './cache.js'
import { createMsaAuth, describeIdentity } from './msa.js'
import { createAuthStatus, stringifyForReport, redactForReport, scanForLeaks } from './status.js'
import {
  createStagingDir,
  detectLegacyLayout,
  finalizeStaging,
  isUuid,
  listAccounts,
  resolveAccount,
} from './accounts.js'
import { applyMigration, planMigration } from './migrate.js'
import { createWhitelistStore, createBackendWhitelist, createNameLookup } from './store.js'
import { candidateLines } from '../service/cli.js'
import { createRcon } from '../driver/rcon.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRETS_DIR = path.join(REPO_ROOT, '.secrets')
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

class UsageError extends Error {}

// Everything that lives under the custody root, named once so no two commands
// can disagree about where an account, a staging directory, or the whitelist is.
function custodyPaths (secretsDir) {
  const root = path.resolve(secretsDir)
  return {
    root,
    accounts: path.join(root, 'accounts'),
    staging: path.join(root, 'staging'),
    retired: path.join(root, 'retired'),
    attachWhitelist: path.join(root, 'attach-whitelist.json'),
  }
}

function custodyPathsFromArgs (args) {
  return custodyPaths(args['secrets-dir'] ?? SECRETS_DIR)
}

// --accounts-dir, or its environment twin, names the account tree explicitly;
// without either, the tree is the one under the custody root.
function accountsDirFromArgs (args, paths = custodyPathsFromArgs(args)) {
  return path.resolve(
    args['accounts-dir'] ??
    process.env.GATEB_ACCOUNTS_DIR ??
    paths.accounts
  )
}

function parseArgs (argv) {
  const args = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { args.positional.push(arg); continue }
    switch (arg) {
      case '--account': case '--accounts-dir': case '--secrets-dir': case '--dir':
      case '--alias': case '--file': case '--namespace': case '--deployment': case '--from': {
        const value = argv[++i]
        if (value === undefined) throw new UsageError(`${arg} needs a value`)
        args[arg.slice(2)] = value
        break
      }
      case '--json':
        args.json = true
        break
      case '--refresh':
        args.refresh = true
        break
      case '--apply':
        args.apply = true
        break
      case '--dry-run':
        args['dry-run'] = true
        break
      case '--no-quarantine':
        args['no-quarantine'] = true
        break
      default:
        throw new UsageError(`unknown option: ${arg}`)
    }
  }
  return args
}

const USAGE = [
  'usage:',
  '  node src/custody/cli.js accounts [--accounts-dir <dir>] [--secrets-dir <dir>] [--json]',
  '  node src/custody/cli.js device-code [--account <uuid|alias|name>] [--alias <alias>] [--secrets-dir <dir>]',
  '  node src/custody/cli.js device-code --dir <accountDir>',
  '  node src/custody/cli.js status [--account <uuid|alias|name>] [--dir <accountDir>] [--secrets-dir <dir>] [--json] [--refresh]',
  '  node src/custody/cli.js migrate [--apply] [--dry-run] [--from <name>] [--no-quarantine] [--secrets-dir <dir>]',
  '  node src/custody/cli.js whitelist attach|backend add|remove <name-or-uuid> [--file <path>] [--secrets-dir <dir>] [--namespace <ns>] [--deployment <dep>]',
].join('\n')

function fail (message, code = 1) {
  process.stderr.write(`error: ${message}\n${USAGE}\n`)
  process.exit(code)
}

// A usage error is a refusal, not a failed operation: the same "refused:"
// prefix as every other exit 2, with the usage text after it.
function usageFail (message) {
  process.stderr.write(`refused: ${message}\n${USAGE}\n`)
  process.exit(2)
}

function refuse (message, code = 2) {
  process.stderr.write(`refused: ${message}\n`)
  process.exit(code)
}

function lockRefusal (message, holder) {
  // Exit code 2: refused, not failed — the caller should not retry blindly.
  process.stderr.write(`refused: ${message}${holder?.pid ? ` (holder pid ${holder.pid})` : ''}\n`)
  process.exit(2)
}

function emitReport (text) {
  const raw = String(text ?? '')
  // Count what the report carried, not what is left of it: a sentinel is the
  // result of redacting, so a scan of the redacted text finds nothing at all
  // and the warning could never fire (#92).
  const leaks = scanForLeaks(raw)
  process.stdout.write(redactForReport(raw) + '\n')
  if (leaks.length > 0) {
    process.stderr.write(`warning: ${leaks.length} secret-shaped string(s) were tagged in status output\n`)
  }
}

function accountHint () {
  return [
    'hint: list accounts: node src/custody/cli.js accounts',
    '      bootstrap a new account: node src/custody/cli.js device-code',
    '      migrate the single-account layout: node src/custody/cli.js migrate --apply',
  ].join('\n')
}

function resolutionRefusal (reason, candidates) {
  process.stderr.write(
    `cannot resolve a puppet account: ${reason}\n${candidateLines(candidates)}\n${accountHint()}\n`)
  process.exit(2)
}

// Resolve --dir / --account / env to exactly one custody directory. Custody is
// constructed by the caller AFTER this returns; a resolution failure creates
// nothing on disk.
function resolveTarget (args, { accountsDir }) {
  if (args.dir && args.account) {
    refuse('--dir and --account are mutually exclusive')
  }
  const legacyDir = args.dir ?? (args.account ? null : process.env.GATEB_AUTH_DIR)
  if (legacyDir) {
    const profile = readProfile(legacyDir)
    if (!profile) {
      refuse(`--dir ${legacyDir} has no profile.json; it is not an account directory`)
    }
    return {
      dir: legacyDir,
      uuid: profile.uuid,
      account: profile.alias ?? profile.name ?? null,
      profile,
    }
  }

  const selector = args.account ?? process.env.GATEB_AUTH_ACCOUNT ?? null
  const resolved = resolveAccount({ accountsDir, selector })
  if (!resolved.ok) resolutionRefusal(resolved.reason, resolved.candidates)
  return {
    dir: resolved.account.dir,
    uuid: resolved.account.uuid,
    account: resolved.account.alias ?? resolved.account.name ?? null,
    profile: resolved.account.profile,
  }
}

function custodyFor (target, { create = false } = {}) {
  return createTokenCustody({
    account: target.account,
    uuid: target.uuid,
    dir: target.dir,
    create,
  })
}

function identityLines (identity, target) {
  const lines = []
  if (identity) lines.push(describeIdentity(identity))
  lines.push(
    `uuid=${target.uuid} ` +
    `name=${identity?.name ?? target.profile?.name ?? '?'} ` +
    `alias=${target.profile?.alias ?? target.account ?? '-'} ` +
    `dir=${target.dir}`
  )
  return lines.join('\n')
}

function deriveAlias (name) {
  if (typeof name !== 'string') return null
  const candidate = name.toLowerCase()
  if (!ALIAS_PATTERN.test(candidate) || isUuid(candidate)) return null
  return candidate
}

// Bootstrap a brand-new account in a staging directory, then rename it into
// the account tree. The staging lock is released before the rename so no lock
// file moves into the new account.
async function bootstrapNewAccount ({ args, paths, uuid = null, codeSink }) {
  if (args.alias !== undefined && !ALIAS_PATTERN.test(args.alias)) {
    refuse(`--alias ${JSON.stringify(args.alias)} does not match ${ALIAS_PATTERN}`)
  }
  const stagingDir = createStagingDir({ stagingDir: paths.staging })
  const custody = createTokenCustody({ account: null, uuid, dir: stagingDir, create: false })
  const msa = createMsaAuth({
    account: null,
    uuid,
    dir: stagingDir,
    custody,
  })
  const attempts = []
  const result = await msa.bootstrapDeviceCode({
    codeSink,
    onAttempt: attempt => attempts.push(attempt),
  })
  if (result.refused) lockRefusal('cannot bootstrap while another writer holds the custody lock', result.holder ?? undefined)
  if (!result.ok) {
    process.stderr.write(`device-code bootstrap failed: ${result.reason ?? 'unknown'}\n`)
    for (const attempt of attempts) {
      process.stderr.write(`  - title ${attempt.authTitle ?? '?'}: [${attempt.failure}] ${attempt.message}\n`)
    }
    process.stderr.write(`staging directory retained: ${stagingDir}\n`)
    process.exit(1)
  }

  const profile = custody.profile.read()
  const alias = args.alias ?? deriveAlias(profile?.name) ?? null

  // bootstrapDeviceCode releases its lock in finally. Release again
  // defensively: a lock file inside the staging directory would move with it
  // and poison the account.
  const release = custody.writerLock.release()
  if (!release.ok && release.reason !== 'lock_not_present') {
    process.stderr.write(`warning: staging writer lock not released: ${release.reason}\n`)
  }

  const finalized = finalizeStaging({
    stagingDir,
    accountsDir: accountsDirFromArgs(args, paths),
    secretsDir: paths.root,
    profile: {
      uuid: result.identity.uuid,
      name: result.identity.name,
      authTitle: result.identity.authTitle,
      deviceType: profile?.deviceType ?? null,
    },
    alias,
  })
  if (!finalized.ok) {
    process.stderr.write(`could not finalize the new account: ${finalized.reason}\n`)
    process.stderr.write(`staging directory retained: ${stagingDir}\n`)
    process.exit(finalized.reason === 'alias_taken' || finalized.reason === 'target_exists' || finalized.reason === 'invalid_alias' ? 2 : 1)
  }

  emitReport(identityLines(result.identity, {
    uuid: finalized.account.uuid,
    dir: finalized.account.dir,
    account: alias,
    profile: finalized.account.profile,
  }))
}

async function main () {
  const [command = '', ...rest] = process.argv.slice(2)
  let args
  try {
    args = parseArgs(rest)
  } catch (error) {
    if (error instanceof UsageError) usageFail(error.message)
    throw error
  }
  const paths = custodyPathsFromArgs(args)
  const accountsDir = accountsDirFromArgs(args, paths)
  const secretsDir = paths.root

  switch (command) {
    case 'accounts': {
      // Read-only: no custody object, no directory creation.
      const listing = listAccounts({ accountsDir })
      const legacy = detectLegacyLayout({ secretsDir, accountsDir, from: args.from ?? 'puppet' })
      if (args.json) {
        emitReport(stringifyForReport({
          accountsDir,
          accounts: listing.accounts,
          broken: listing.broken,
          pending: listing.pending,
          legacy,
        }))
        return
      }
      const lines = [`accounts: ${listing.accounts.length} in ${accountsDir}`]
      for (const account of listing.accounts) {
        lines.push(`uuid=${account.uuid} name=${account.name ?? '?'} alias=${account.alias ?? '-'} dir=${account.dir}`)
      }
      for (const entry of listing.broken) {
        lines.push(`broken: uuid=${entry.uuid} name=${entry.name ?? '?'} alias=${entry.alias ?? '-'} dir=${entry.dir} reason=${entry.reason}`)
      }
      for (const entry of listing.pending) {
        lines.push(`pending: name=${entry.name} dir=${entry.dir} reason=${entry.reason} caches=${entry.cacheFiles.join(',')}`)
      }
      if (legacy.found) {
        lines.push(
          `legacy: ${legacy.dir} uuid=${legacy.profile?.uuid ?? '?'} alias=${legacy.profile?.alias ?? '-'} ` +
          `target=${legacy.target ?? '(none)'} targetExists=${legacy.targetExists} ` +
          `hint="node src/custody/cli.js migrate --apply"`
        )
      } else {
        lines.push(`legacy: none (${legacy.dir}: ${legacy.reason})`)
      }
      emitReport(lines.join('\n'))
      return
    }

    case 'device-code': {
      // Codes/URLs to stderr; stdout gets the sanitized identity summary.
      const codeSink = line => process.stderr.write(`${line}\n`)

      if (args.dir && args.account) refuse('--dir and --account are mutually exclusive')

      const selector = args.account ?? (args.dir ? null : process.env.GATEB_AUTH_ACCOUNT) ?? null
      const rawDir = args.dir ?? (selector ? null : process.env.GATEB_AUTH_DIR)
      if (rawDir) {
        const profile = readProfile(rawDir)
        if (!profile) refuse(`--dir ${rawDir} has no profile.json; it is not an account directory`)
        const target = {
          dir: rawDir,
          uuid: profile.uuid,
          account: profile.alias ?? profile.name ?? null,
          profile,
        }
        const custody = custodyFor(target)
        const msa = createMsaAuth({ account: target.account, uuid: target.uuid, dir: target.dir, custody })
        const attempts = []
        const result = await msa.bootstrapDeviceCode({ codeSink, onAttempt: attempt => attempts.push(attempt) })
        if (result.refused) lockRefusal('cannot bootstrap while another writer holds the custody lock', result.holder ?? undefined)
        if (!result.ok) {
          process.stderr.write(`device-code bootstrap failed: ${result.reason ?? 'unknown'}\n`)
          for (const attempt of attempts) process.stderr.write(`  - title ${attempt.authTitle ?? '?'}: [${attempt.failure}] ${attempt.message}\n`)
          process.exit(1)
        }
        const refreshed = custody.profile.read()
        emitReport(identityLines(result.identity, { ...target, profile: refreshed }))
        return
      }

      // No selector at all: this is a fresh bootstrap.
      if (!selector) {
        await bootstrapNewAccount({ args, paths, codeSink })
        return
      }

      const resolved = resolveAccount({ accountsDir, selector })
      if (resolved.ok) {
        const target = {
          dir: resolved.account.dir,
          uuid: resolved.account.uuid,
          account: resolved.account.alias ?? resolved.account.name ?? null,
          profile: resolved.account.profile,
        }
        const custody = custodyFor(target)
        const msa = createMsaAuth({ account: target.account, uuid: target.uuid, dir: target.dir, custody })
        const attempts = []
        const result = await msa.bootstrapDeviceCode({ codeSink, onAttempt: attempt => attempts.push(attempt) })
        if (result.refused) lockRefusal('cannot bootstrap while another writer holds the custody lock', result.holder ?? undefined)
        if (!result.ok) {
          process.stderr.write(`device-code bootstrap failed: ${result.reason ?? 'unknown'}\n`)
          for (const attempt of attempts) process.stderr.write(`  - title ${attempt.authTitle ?? '?'}: [${attempt.failure}] ${attempt.message}\n`)
          process.exit(1)
        }
        const refreshed = custody.profile.read()
        emitReport(identityLines(result.identity, { ...target, profile: refreshed }))
        return
      }

      // An unknown UUID means "add this account": the finalize step asserts
      // the resulting profile uuid matches the requested one.
      if (isUuid(selector)) {
        await bootstrapNewAccount({ args, paths, uuid: selector, codeSink })
        return
      }

      // Text selectors never create a new account: that would turn a typo
      // into an accidental login.
      resolutionRefusal(resolved.reason, resolved.candidates)
      return
    }

    case 'status': {
      const target = resolveTarget(args, { accountsDir })
      const custody = custodyFor(target)
      const status = createAuthStatus({
        account: target.account,
        uuid: target.uuid,
        dir: target.dir,
        custody,
      })
      if (args.refresh) {
        const result = await status.refresh()
        if (result.refused) lockRefusal('status --refresh refuses while the writer lock is held (proxy running?)', result.holder ?? undefined)
        emitReport(result.identityLine ?? `refresh: ${result.reason ?? 'unknown outcome'}`)
        if (result.ok && result.uuidStable === false) {
          process.stderr.write(`WARNING: uuid changed across refresh (was ${result.previousUuid}) — investigate before any live run\n`)
          process.exit(1)
        }
        if (result.ok && result.uuidStable === null) {
          process.stderr.write('note: no prior identity to compare; this is the first bootstrap\n')
        }
        if (args.json) emitReport(stringifyForReport(result))
        if (!args.json) emitReport(summarizeStatusLines(await status.collect()))
        if (!result.ok) process.exit(1)
        return
      }
      const report = await status.collect()
      emitReport(args.json ? stringifyForReport(report) : summarizeStatusLines(report))
      return
    }

    case 'migrate': {
      const apply = Boolean(args.apply) && !args['dry-run']
      const options = {
        secretsDir,
        accountsDir,
        retiredDir: paths.retired,
        from: args.from ?? 'puppet',
      }
      const result = apply
        ? applyMigration({ ...options, apply: true, quarantineLegacy: !args['no-quarantine'] })
        : planMigration(options)
      emitReport(formatMigration(result, { apply }))
      if (result.warning) process.stderr.write(`warning: ${result.warning}\n`)
      if (!apply) return
      if (result.ok) return
      process.exit(result.reason === 'migration_failed' || result.reason === 'finalize_failed' ? 1 : 2)
      return
    }

    case 'whitelist': {
      const [scope = '', action = '', identifier = ''] = args.positional
      if (scope !== 'attach' && scope !== 'backend') usageFail('whitelist scope must be attach or backend')
      if (action !== 'add' && action !== 'remove') usageFail('whitelist action must be add or remove')
      if (!identifier) usageFail(`whitelist ${action} needs a name or UUID`)

      if (scope === 'attach') {
        const store = createWhitelistStore({
          file: args.file ?? paths.attachWhitelist,
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
      usageFail(`unknown command '${command}'`)
  }
}

function summarizeStatusLines (report) {
  const uuid = report.account?.uuid ?? '?'
  const name = report.account?.name ?? '?'
  const alias = report.account?.alias ?? '-'
  const lines = [
    `account=${uuid} name=${name} alias=${alias} dir=${report.dir} mode=${report.cacheDirMode ?? '?'} files=${report.files.map(f => f.name).join(',') || '(none)'}`,
    `live-cache: refresh-token-presence=${report.live.hasRefreshToken ? 'present' : 'absent'} access-token-expires=${report.live.accessTokenExpiresAt ?? 'n/a'}`,
    `mca-cache: access-token-presence=${report.mca.hasAccessToken ? 'present' : 'absent'} expires=${report.mca.expiresAt ?? 'n/a'}`,
    `identity: ${report.identity ? `${report.identity.uuid}${report.identity.name ? ` (${report.identity.name})` : ''} asOf ${report.identity.updatedAt}` : 'not bootstrapped yet'}`,
    `writer-lock: ${report.writerLock.held ? `HELD (pid ${report.writerLock.holder?.pid ?? '?'})` : 'free'}`,
  ]
  return lines.join('\n')
}

function formatMigration (result, { apply }) {
  const files = result.legacy?.files ?? result.files ?? []
  const lock = result.legacy?.writerLock ?? null
  const quarantine = result.quarantine ?? null
  const lines = [
    `migrate: ${apply ? 'apply' : 'dry-run'} (${result.ok ? 'ok' : `not ok: ${result.reason ?? 'unknown'}`})`,
    `legacy: ${result.legacy?.dir ?? result.from}`,
    `uuid: ${result.uuid ?? '?'}`,
    `target: ${result.target ?? '(none)'}`,
    files.length === 0 ? 'files: (none)' : 'files:',
  ]
  for (const file of files) {
    const target = file.target ? path.basename(file.target) : `${file.family}-cache.json`
    lines.push(`  ${file.family}: ${file.bytes ?? '?'} bytes -> ${target}`)
  }
  lines.push(
    `sameFilesystem: ${result.sameFilesystem ?? '?'}`,
    `targetExists: ${result.targetExists}`,
    `legacyLock: ${lock?.present ? `present pid=${lock.pid ?? '?'} alive=${lock.alive}` : 'free'}`,
    `quarantine: present=${quarantine?.present ?? false} dir=${quarantine?.dir ?? '(none)'} target=${quarantine?.target ?? '(none)'}`
  )
  if (result.alreadyMigrated) lines.push('alreadyMigrated: true')
  if (apply) lines.push(`applied: ${Boolean(result.applied)}`)
  if (result.error) lines.push(`error: ${result.error}`)
  for (const entry of result.recovery ?? []) lines.push(`recovery: ${entry}`)
  return lines.join('\n')
}

main().catch(error => fail(String(error && error.message ? error.message : error)))

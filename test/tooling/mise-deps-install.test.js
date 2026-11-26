// The install every gate rung depends on is a declared mise provider, not a
// second spelling of pnpm (#639).
//
// With no [deps.pnpm] table, `mise deps install` exits 0 installing nothing, and
// mise.toml carries the measurement. A task that delegates to it would therefore
// look wired and reach nothing. Declared, the same command installs.
//
// Each case below is one way that regression comes back, and what it costs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { MISE_TOML, readList, readMiseTable, readMiseTasks } from './mise-toml.js'

const install = readMiseTasks().get('install')
const provider = readMiseTable('deps.pnpm')
const settings = readMiseTable('settings')

test('the install task delegates to the declared provider, and names no package manager', () => {
  assert.ok(install, 'mise.toml defines the install task')
  assert.equal(install.run, 'mise deps install', 'install runs the command that reads the providers')
  // A task that re-spells pnpm is the drift #639 removes: two spellings of one
  // command, and the second one wins wherever a reader copies it.
  assert.doesNotMatch(install.body, /pnpm/, 'the provider owns the command, not the task')
})

test('the provider is declared, and runs before any mise run in a cold checkout', () => {
  // Deleting the table leaves the task above wired to a command that exits 0
  // installing nothing. On a warm machine that stays invisible until the
  // dependencies and the lockfile disagree.
  assert.ok(provider, 'mise.toml declares [deps.pnpm]: without the table, the task above delegates to a command that exits 0')
  // auto = true is the deliberate mode: the first mise run in a cold worktree
  // installs, whatever that run is, so no rung and no human has to remember the
  // install. Flipping it back to false silently drops that, and the first
  // command in a cold worktree then fails on a missing module instead.
  assert.match(provider, /^\s*auto\s*=\s*true\s*$/m, 'auto = true installs before a mise run that finds no node_modules')
})

test('the provider installs from the lockfile, and reads the local store first', () => {
  // The command, not the whole block: a comment that names a flag must not
  // satisfy an assertion about what the install runs.
  const command = provider.match(/^\s*run\s*=\s*"(.*)"\s*$/m)?.[1] ?? ''
  // Without --frozen-lockfile, a package.json edit rewrites the lockfile in CI
  // instead of failing the install.
  assert.match(command, /^pnpm install --frozen-lockfile(?:\s|$)/, 'the provider installs against the lockfile')
  assert.match(command, /--prefer-offline/, 'a warm store answers without the registry')
})

test('the provider hashes every input the install reads, and each input is present', () => {
  // mise's built-in pnpm sources are the lockfile and package.json. The workspace
  // file carries the build-script policy, so leaving it out makes an edited
  // policy a stale install that mise still calls fresh. And a declared source that
  // is missing makes the provider inactive: mise deps install then exits 0 having
  // installed nothing, which is the same defect one trigger over.
  const sources = readList(provider, 'sources')
  assert.deepEqual(
    sources,
    ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml'],
    'the provider hashes the lockfile, the manifest and the workspace policy'
  )
  for (const name of sources) {
    assert.ok(fs.existsSync(new URL('../../' + name, import.meta.url)), name + ' exists where the provider hashes it')
  }
})

test('the experimental switch the provider needs is committed, not left to each machine', () => {
  // deps is an experimental mise feature. With it off, mise deps install exits 1:
  // "deps is experimental. Enable it with mise settings experimental=true". CI
  // has no user config, so the repository owns the switch. This machine's own
  // config sets it too, so a local green gate cannot tell the two apart.
  assert.match(settings, /^\s*experimental\s*=\s*true\s*$/m, '[settings] enables the experimental surface deps lives in')
})

test('the manifest names the mise version the deps surface arrives with', () => {
  // An older mise has no [deps.*] surface at all, so without a floor the install
  // fails on a tool version rather than on a dependency. min_version makes mise
  // refuse at startup, with a message that says which version it needs.
  const manifest = fs.readFileSync(MISE_TOML, 'utf8')
  assert.match(
    manifest,
    /^min_version\s*=\s*"\d{4}\.\d{1,2}\.\d{1,2}"\s*$/m,
    'mise.toml pins the mise floor the deps surface arrives with'
  )
})

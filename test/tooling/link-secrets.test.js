// scripts/link-secrets.sh gives a worktree its .secrets by symlink, never by
// copy: one refresh token, one writer. Every case runs the script against a temp
// git repository and a temp secrets directory, so nothing here reads or writes a
// real custody tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'link-secrets.sh'
)

// A secrets tree with one account and a whitelist, plus an empty repository that
// stands in for a worktree. The sentinel makes a leak of file contents fail the
// test rather than ship quietly.
const SENTINEL = 'PROFILE-CONTENT-MUST-NOT-LEAK'

function fixture () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-secrets-'))
  const secrets = path.join(root, 'main', '.secrets')
  fs.mkdirSync(path.join(secrets, 'accounts', 'bafbi'), { recursive: true })
  fs.writeFileSync(path.join(secrets, 'accounts', 'bafbi', 'profile.json'), '{"' + SENTINEL + '":true}')
  fs.writeFileSync(path.join(secrets, 'attach-whitelist.json'), '{"version":1,"players":[]}')

  const tree = path.join(root, 'tree')
  fs.mkdirSync(tree, { recursive: true })
  const init = spawnSync('git', ['init', '--quiet', tree], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)

  return { root, secrets, tree }
}

function run (tree, env = {}) {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, MONOPLAYER_SECRETS_SOURCE: '', ...env }
  })
  return { ...result, output: result.stdout + result.stderr }
}

test('links the worktree to the one secrets directory', () => {
  const { secrets, tree } = fixture()
  const result = run(tree, { MONOPLAYER_SECRETS_SOURCE: secrets })

  assert.equal(result.status, 0, result.output)
  const target = path.join(tree, '.secrets')
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
  assert.equal(fs.realpathSync(target), fs.realpathSync(secrets))
  assert.equal(fs.existsSync(path.join(target, 'accounts', 'bafbi', 'profile.json')), true)
  assert.match(result.stdout, /1 account\(s\)/)
  assert.match(result.stdout, /attach whitelist present/)
  assert.equal(result.output.includes(SENTINEL), false, 'the script never prints file contents')
})

test('a second run says already linked and changes nothing', () => {
  const { secrets, tree } = fixture()
  run(tree, { MONOPLAYER_SECRETS_SOURCE: secrets })
  const target = path.join(tree, '.secrets')
  const first = fs.readlinkSync(target)

  const second = run(tree, { MONOPLAYER_SECRETS_SOURCE: secrets })
  assert.equal(second.status, 0, second.output)
  assert.match(second.stdout, /already linked/)
  assert.equal(fs.readlinkSync(target), first)
})

test('a symlink that points elsewhere is repointed', () => {
  const { root, secrets, tree } = fixture()
  const stale = path.join(root, 'stale-secrets')
  fs.mkdirSync(stale)
  fs.symlinkSync(stale, path.join(tree, '.secrets'))

  const result = run(tree, { MONOPLAYER_SECRETS_SOURCE: secrets })
  assert.equal(result.status, 0, result.output)
  assert.equal(fs.realpathSync(path.join(tree, '.secrets')), fs.realpathSync(secrets))
})

test('refuses to replace a real .secrets directory', () => {
  const { secrets, tree } = fixture()
  const target = path.join(tree, '.secrets')
  fs.mkdirSync(path.join(target, 'accounts'), { recursive: true })
  fs.writeFileSync(path.join(target, 'attach-whitelist.json'), '{"version":1,"players":[]}')

  const result = run(tree, { MONOPLAYER_SECRETS_SOURCE: secrets })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refusing to replace it/)
  assert.equal(fs.lstatSync(target).isDirectory(), true, 'the real directory is untouched')
  assert.equal(fs.existsSync(path.join(target, 'accounts')), true)
})

test('no source means nothing to link, and no failure', () => {
  const { root, tree } = fixture()
  const missing = path.join(root, 'nowhere', '.secrets')

  const result = run(tree, { MONOPLAYER_SECRETS_SOURCE: missing })
  assert.equal(result.status, 0, result.output)
  assert.match(result.stdout, /no secrets at/)
  assert.match(result.stdout, /live rungs will not run here/)
  assert.equal(fs.existsSync(path.join(tree, '.secrets')), false)
})

test('the ignore rules cover the directory and the symlink the task creates', () => {
  // A symlink named .secrets is not a directory, so a rule written as .secrets/
  // does not match it and the link shows up as untracked. Both forms must be
  // ignored, or a worktree setup step invites a commit of the token directory.
  // The rules are exercised in throwaway repositories, so the checkout is never
  // touched.
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const rules = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
  const ignored = (tree, candidate) =>
    spawnSync('git', ['-C', tree, 'check-ignore', '--no-index', '-q', candidate]).status === 0

  const directory = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-ignore-dir-'))
  spawnSync('git', ['init', '--quiet', directory])
  fs.writeFileSync(path.join(directory, '.gitignore'), rules)
  fs.mkdirSync(path.join(directory, '.secrets', 'accounts'), { recursive: true })
  assert.equal(ignored(directory, '.secrets'), true, 'the directory is ignored')
  assert.equal(ignored(directory, '.secrets/accounts'), true, 'its contents are ignored')

  const symlinked = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-ignore-link-'))
  spawnSync('git', ['init', '--quiet', symlinked])
  fs.writeFileSync(path.join(symlinked, '.gitignore'), rules)
  fs.symlinkSync(fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-elsewhere-')), path.join(symlinked, '.secrets'))
  assert.equal(ignored(symlinked, '.secrets'), true, 'the symlink is ignored')
})

test('outside a git work tree it fails instead of guessing a path', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-nogit-'))
  const result = run(root, { MONOPLAYER_SECRETS_SOURCE: '' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not inside a git work tree/)
})

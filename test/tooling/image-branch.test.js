// The branch image workflow (#43) builds a commit and publishes nothing else.
// These cases read the workflow file: the guarantees are the permissions and the
// absence of a push, not a guard that can be edited away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRANCH = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'image-branch.yaml'), 'utf8')
const MAIN = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'image.yaml'), 'utf8')

test('the branch workflow runs only when dispatched', () => {
  assert.match(BRANCH, /^on:\n  workflow_dispatch:/m, 'workflow_dispatch is the only trigger')
  assert.doesNotMatch(BRANCH, /^ {2}push:/m, 'no push trigger')
  assert.doesNotMatch(BRANCH, /^ {2}pull_request:/m, 'no pull request trigger')
  assert.doesNotMatch(BRANCH, /^ {2}schedule:/m, 'no schedule')
})

test('the branch workflow cannot push a branch', () => {
  // A permission is the guarantee. A guard is not.
  assert.match(BRANCH, /^permissions:\n  contents: read\n  packages: write$/m, 'contents is read-only')
  assert.doesNotMatch(BRANCH, /contents: write/, 'never contents write')
  assert.doesNotMatch(BRANCH, /git push/, 'never pushes')
  assert.doesNotMatch(BRANCH, /git checkout -B/, 'never rewrites a branch')
  assert.doesNotMatch(BRANCH, /CHECKOUT_TOKEN|secrets\.GITHUB_TOKEN.*contents/, 'no token with write access')
  assert.match(BRANCH, /persist-credentials: false/, 'checkout keeps no credentials')
})

test('the branch workflow cannot reach the deploy branch or the live lane', () => {
  assert.doesNotMatch(BRANCH, /git checkout deploy/, 'no deploy branch checkout')
  assert.doesNotMatch(BRANCH, /deploy\/manifests/, 'never writes the live manifests')
  assert.doesNotMatch(BRANCH, /argocd/i, 'never touches Argo')
  // No cluster call at all. The summary points the operator at the mise task,
  // which honours the dev namespace variable rather than hardcoding one.
  assert.doesNotMatch(BRANCH, /kubectl/, 'never talks to a cluster')
  assert.match(BRANCH, /echo "mise run dev:image \$TAG"/, 'the summary tells the operator what to run')
})

test('the branch workflow refuses main, which has its own producer', () => {
  assert.match(BRANCH, /if: github\.ref != 'refs\/heads\/main'/, 'main is refused')
  assert.match(MAIN, /if: github\.ref == 'refs\/heads\/main'/, 'main still has its own build')
})

test('the branch image is tagged with its commit and nothing else', () => {
  const tags = BRANCH.split('\n').find(line => line.trim().startsWith('tags:'))
  assert.ok(tags, 'the build sets tags')
  assert.match(tags, /steps\.names\.outputs\.image.*steps\.names\.outputs\.tag/, 'image plus commit tag')
  assert.doesNotMatch(tags, /main/, 'no :main tag, so a branch never becomes what the live lane pulls')
  assert.match(BRANCH, /tag=sha-\$\(git rev-parse --short=7 HEAD\)/, 'the tag is the commit')
})

test('the main publish path is unchanged', () => {
  assert.match(MAIN, /^permissions:\n  contents: write\n  packages: write$/m, 'main still publishes the deploy branch')
  assert.match(MAIN, /git push --force origin deploy/, 'main still rebuilds deploy')
  assert.match(MAIN, /uses: .\/\.github\/workflows\/ci\.yaml/, 'main still runs the gate first')
})

test('the dev lane can run the branch image', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'dev-lane.sh'), 'utf8')
  assert.match(script, /set image deploy\/monoplayer/, 'the lane sets the image')
  assert.match(script, /kubectl -n "\$DEV_NAMESPACE" set image/, 'on the dev namespace only')
  assert.match(script, /IMAGE_REPO=ghcr\.io\/bafbi\/monoplayer/, 'the same repository main publishes to')
  const toml = fs.readFileSync(path.join(ROOT, 'mise.toml'), 'utf8')
  assert.match(toml, /\[tasks\."dev:image"\]/, 'mise run dev:image')
})

test('both workflows run the gate before they build', () => {
  for (const [name, text] of [['image-branch', BRANCH], ['image', MAIN]]) {
    assert.match(text, /needs: check/, name + ' builds only after the gate')
    assert.match(text, /uses: .\/\.github\/workflows\/ci\.yaml/, name + ' runs the branch gate')
  }
})

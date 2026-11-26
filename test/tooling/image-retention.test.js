// Image tag retention (#118). The package holds one sha-* tag per merge and per
// branch build and nothing prunes them, so deletion has to be an allowlist:
// deleting a tag can garbage-collect a digest a lane is running.
//
// The cases read the planner directly, run the CLI against fixture files, and
// read the workflow and the doc as text, the way test/tooling/image-branch.test.js
// reads its workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

import {
  DEFAULT_KEEP_LAST,
  DEFAULT_MIN_AGE_DAYS,
  parsePins,
  readPins,
  plan,
  listVersions,
  deleteVersion
} from '../../tools/image-retention.mjs'
import { readMiseTasks } from './mise-toml.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOL = path.join(ROOT, 'tools', 'image-retention.mjs')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// An API version, as GET /users/{owner}/packages/container/{package}/versions returns it.
let nextId = 1
function version (tags, { digest = null, day = 1 } = {}) {
  const id = nextId++
  return {
    id,
    name: digest ?? 'sha256:' + String(id).padStart(64, '0'),
    created_at: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
    metadata: { container: { tags } }
  }
}

const digestOf = entry => entry.digest
const removedDigests = result => result.remove.map(digestOf).sort()

function workspace () {
  const dir = tempRoot('monoplayer-retention-')
  const write = (name, text) => {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  return {
    dir,
    write,
    run: (...args) => spawnSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '', GH_API: 'http://127.0.0.1:9' }
    })
  }
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test('the moving main tag is never a deletion candidate', () => {
  const versions = [
    version(['main', 'sha-aaaaaaa'], { day: 9 }),
    version(['sha-bbbbbbb'], { day: 1 })
  ]

  const result = plan({ versions, pins: { tags: new Set(), digests: new Set() }, keepLast: 1 })

  assert.deepEqual(result.keep.map(digestOf), [versions[0].name], 'main is kept')
  assert.deepEqual(removedDigests(result), [versions[1].name], 'only the old sha is removed')
})

test('the digest the deploy branch pins survives however old its sha tag is', () => {
  const pinned = version(['sha-0000001'], { day: 1 })
  const versions = [
    version(['sha-fffffff'], { day: 9 }),
    version(['sha-eeeeeee'], { day: 8 }),
    pinned
  ]

  const result = plan({
    versions,
    pins: { tags: new Set(), digests: new Set([pinned.name]) },
    keepLast: 1
  })

  assert.ok(result.keep.some(entry => entry.digest === pinned.name), 'the deploy digest is kept')
  assert.equal(result.keep.find(entry => entry.digest === pinned.name).reason, 'pinned by digest')
  assert.equal(removedDigests(result).includes(pinned.name), false, 'the deploy digest is never removed')
})

test('a digest or tag named by a manifest is kept', () => {
  const byDigest = version(['sha-0000002'], { day: 1 })
  const byTag = version(['lane-pin'], { day: 1 })
  const versions = [version(['sha-fffffff'], { day: 9 }), byDigest, byTag]

  const result = plan({
    versions,
    pins: { tags: new Set(['lane-pin']), digests: new Set([byDigest.name]) },
    keepLast: 1
  })

  assert.deepEqual(removedDigests(result), [], 'a registered pin is not a deletion candidate')
  assert.deepEqual(
    result.keep.map(entry => entry.reason).sort(),
    ['pinned by digest', 'pinned by tag: lane-pin', 'sha-* within the last 1'],
    'each keep states why'
  )
})

test('the newest N sha tags are kept for bisecting, and N is 20', () => {
  assert.equal(DEFAULT_KEEP_LAST, 20, 'the window is stated, not implied')
  assert.equal(DEFAULT_MIN_AGE_DAYS, 1, 'the grace period is one day, not a retention rule')

  const versions = Array.from({ length: 25 }, (_, index) =>
    version(['sha-' + String(index).padStart(7, '0')], { day: 25 - index }))

  const result = plan({ versions, pins: { tags: new Set(), digests: new Set() }, keepLast: DEFAULT_KEEP_LAST })

  assert.equal(result.keep.length, 20, 'twenty sha tags stay')
  assert.equal(result.remove.length, 5, 'five go')
  assert.deepEqual(
    result.remove.map(entry => entry.tags[0]),
    ['sha-0000020', 'sha-0000021', 'sha-0000022', 'sha-0000023', 'sha-0000024'],
    'the five oldest go, each named'
  )
})

test('a tag the allowlist does not model is kept, not deleted', () => {
  // Fail closed: a lane or a human may have pinned something this tool cannot
  // know about, and an allowlist that guesses deletes it.
  const versions = [version(['v1.2.3'], { day: 1 }), version(['sha-fffffff'], { day: 9 })]

  const result = plan({ versions, pins: { tags: new Set(), digests: new Set() }, keepLast: 1 })

  assert.equal(result.remove.length, 0, 'an unrecognised tag is left alone')
  assert.match(
    result.keep.find(entry => entry.tags.includes('v1.2.3')).reason,
    /not a sha-\* tag/
  )
})

test('an untagged version is left alone', () => {
  // build-push-action attaches provenance, so untagged versions exist and some
  // of them are children of a tagged index. Deleting one breaks the parent.
  const untagged = version([], { day: 2 })
  const versions = [version(['sha-fffffff'], { day: 9 }), untagged]

  const result = plan({ versions, pins: { tags: new Set(), digests: new Set() }, keepLast: 1 })

  assert.equal(result.remove.length, 0, 'untagged versions are not this job\'s business')
  assert.match(result.keep.find(entry => entry.digest === untagged.name).reason, /untagged/)
})

test('no removal is ever a pinned digest, whatever the fixture', () => {
  const versions = Array.from({ length: 30 }, (_, index) =>
    version(index % 3 === 0 ? ['main', 'sha-' + String(index).padStart(7, '0')] : ['sha-' + String(index).padStart(7, '0')],
      { day: 30 - index }))
  const pins = {
    tags: new Set(['main']),
    digests: new Set([versions[29].name, versions[28].name])
  }

  const result = plan({ versions, pins, keepLast: 20 })

  assert.equal(result.keep.length + result.remove.length, versions.length, 'every version is classified')
  for (const digest of pins.digests) {
    assert.equal(result.remove.some(entry => entry.digest === digest), false, 'never removes ' + digest)
  }
  assert.ok(result.keep.some(entry => entry.digest === versions[29].name), 'the pinned digest is in keep')
})

// ---------------------------------------------------------------------------
// Reading the pins out of the tree
// ---------------------------------------------------------------------------

test('parsePins reads a tag reference, a digest suffix, and a kustomize digest', () => {
  const pins = parsePins([
    'image: ghcr.io/bafbi/monoplayer:main',
    'image: ghcr.io/bafbi/monoplayer@sha256:' + 'a'.repeat(64),
    'images:',
    '  - name: ghcr.io/bafbi/monoplayer',
    '    digest: sha256:' + 'b'.repeat(64)
  ].join('\n'))

  assert.deepEqual([...pins.tags], ['main'], 'the tag is read')
  assert.deepEqual(
    [...pins.digests].sort(),
    ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)].sort(),
    'both digest forms are read'
  )
})

test('parsePins survives a trailing comment and reads kustomize newTag', () => {
  // A lane writes the comment that says which lane the pin belongs to, and
  // newTag is kustomize's own tag pin. Both must reach the allowlist, or a
  // registered pin is deleted anyway.
  const pins = parsePins([
    'image: ghcr.io/bafbi/monoplayer@sha256:' + 'e'.repeat(64) + '  # the dev lane',
    'images:',
    '  - name: ghcr.io/bafbi/monoplayer',
    '    newTag: sha-1a2b3c4',
    '  - name: ghcr.io/shopify/toxiproxy',
    '    newTag: 2.12.0',
    'digest: sha256:' + 'f'.repeat(64) + '  # pinned'
  ].join('\n'))

  assert.deepEqual([...pins.digests].sort(), ['sha256:' + 'e'.repeat(64), 'sha256:' + 'f'.repeat(64)].sort(),
    'a commented digest is still a digest')
  assert.deepEqual([...pins.tags], ['sha-1a2b3c4'], 'newTag is read, and only for this image')
})

test('a pin list line that is not a pin fails the job instead of protecting nothing', () => {
  // A full image reference is what kubectl and the branch workflow print, so it is
  // the likeliest paste. It matches no package tag, so accepting it would look
  // like a registered pin and delete the tag anyway.
  const s = scenario()
  const pins = s.space.write('bad-pins.txt', 'ghcr.io/bafbi/monoplayer:sha-1a2b3c4  # dev\n')

  const result = s.space.run('plan', '--versions', s.data, '--deploy', s.deploy, '--manifests', s.manifests, '--pins', pins)

  assert.equal(result.status, 2, 'a pin nobody can match is a refusal')
  assert.match(result.stderr, /is not a pin/, 'the message says what is wrong')
  assert.match(result.stderr, /sha-<7>/, 'and what to write instead')
  assert.equal(result.stdout.includes('would delete'), false, 'nothing is planned')
})

test('a missing manifest directory is a refusal, not an empty allowlist', () => {
  const s = scenario()

  const result = s.space.run('plan', '--versions', s.data, '--deploy', s.deploy,
    '--manifests', path.join(s.space.dir, 'no-such-dir'), '--pins', s.pins)

  assert.equal(result.status, 2, 'no manifests means no allowlist, so no plan')
  assert.match(result.stderr, /no-such-dir/, 'the message names the directory')
})

test('readPins walks the manifest tree and finds a lane pin', () => {
  const space = workspace()
  space.write('deploy/dev/monoplayer.yaml', 'image: ghcr.io/bafbi/monoplayer:main\n')
  space.write('deploy/gate/paper.yaml', 'image: ghcr.io/bafbi/monoplayer@sha256:' + 'c'.repeat(64) + '\n')
  space.write('deploy/dev/README.md', 'image: ghcr.io/bafbi/monoplayer:not-a-manifest\n')

  const pins = readPins([path.join(space.dir, 'deploy')])

  assert.deepEqual([...pins.tags], ['main'], 'a markdown file is not a manifest')
  assert.deepEqual([...pins.digests], ['sha256:' + 'c'.repeat(64)], 'the digest pin is found')
})

// ---------------------------------------------------------------------------
// The API call
// ---------------------------------------------------------------------------

const FIRST = 'https://api.github.com/users/Bafbi/packages/container/monoplayer/versions?per_page=100&page=1'

test('listVersions follows the Link header, which is the page contract GitHub documents', async () => {
  // per_page and page are not documented on the user-owned endpoint, so the loop
  // must follow the header rather than trust its own page arithmetic.
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['link', '<https://api.github.com/users/Bafbi/packages/container/monoplayer/versions?per_page=100&page=2>; rel="next"']]),
        json: async () => Array.from({ length: 100 }, () => version(['sha-0000000']))
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => [version(['main', 'sha-fffffff'])]
    }
  }

  // A Map stands in for Headers: get() is the only method the tool uses.
  const versions = await listVersions({ token: 'T', fetchImpl: (url, init) => fetchImpl(url, init) })

  assert.equal(versions.length, 101, 'every page is read')
  assert.equal(calls.length, 2, 'two requests')
  assert.equal(calls[0].url, FIRST)
  assert.equal(calls[1].url, 'https://api.github.com/users/Bafbi/packages/container/monoplayer/versions?per_page=100&page=2')
  assert.equal(calls[0].init.headers.authorization, 'Bearer T', 'the token is sent')
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github+json')
})

test('listVersions asks for the next page when a full page arrives without a Link', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const full = calls.length === 1
    return {
      ok: true,
      status: 200,
      headers: {},
      json: async () => (full ? Array.from({ length: 100 }, () => version(['sha-0000000'])) : [])
    }
  }

  const versions = await listVersions({ token: 'T', fetchImpl })

  assert.equal(versions.length, 100, 'the empty second page ends the loop')
  assert.equal(calls.length, 2, 'a full page is not the last page')
  assert.match(calls[1], /page=2$/, 'the page number advances')
})

test('a delete of an id that is already gone is not a failure', async () => {
  // The job runs on a schedule against a reviewed plan. A repeat run must not go
  // red over ids the first run removed.
  const fetchImpl = async () => ({ ok: false, status: 404, headers: {}, text: async () => '{"message":"Not Found"}' })

  assert.deepEqual(await deleteVersion({ id: 7, token: 'T', fetchImpl }), { gone: true })
})

test('listVersions fails loudly on a 403, which is what a missing read:packages looks like', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{"message":"read:packages"}' })

  await assert.rejects(
    () => listVersions({ token: 'T', fetchImpl }),
    err => /403/.test(err.message) && /list/.test(err.message)
  )
})

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

const DEPLOY_KUSTOMIZATION = [
  'images:',
  '  - name: ghcr.io/bafbi/monoplayer',
  '    digest: sha256:' + 'd'.repeat(64)
].join('\n') + '\n'

const PIN_LIST = '# the pin nobody carries in a manifest\n'

function scenario () {
  const space = workspace()
  const live = version(['sha-0000001'], { digest: 'sha256:' + 'd'.repeat(64), day: 1 })
  const older = version(['sha-0000002'], { day: 2 })
  const newest = version(['main', 'sha-0000003'], { day: 9 })
  const versions = [newest, older, live]

  const deploy = space.write('.deploy/deploy/manifests/kustomization.yaml', DEPLOY_KUSTOMIZATION)
  const manifests = space.write('deploy/manifests/deployment.yaml', 'image: ghcr.io/bafbi/monoplayer:main\n')
  const pins = space.write('deploy/pins.txt', PIN_LIST)
  const data = space.write('versions.json', JSON.stringify(versions))
  return { space, versions, live, older, newest, deploy, pins, manifests: path.dirname(manifests) + '/..', data }
}

test('plan lists what it would delete and deletes nothing', () => {
  const s = scenario()

  const result = s.space.run('plan', '--versions', s.data, '--deploy', s.deploy, '--manifests', s.manifests, '--keep', '1')

  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.split('\n')
  const listAt = lines.findIndex(line => line.includes('would delete 1:'))
  assert.notEqual(listAt, -1, 'the count is stated')
  assert.ok(
    lines.slice(listAt + 1).some(line => line.startsWith('  delete ') && line.includes(s.older.name)),
    'the deletion candidate is listed under the count'
  )
  assert.ok(
    lines.some(line => line.startsWith('  keep ') && line.includes(s.live.name) && line.includes('pinned by digest')),
    'the live digest is kept, with its reason'
  )
})

test('plan refuses to guess when the deploy pin cannot be read', () => {
  const s = scenario()

  const result = s.space.run('plan', '--versions', s.data, '--deploy', path.join(s.space.dir, 'missing.yaml'), '--manifests', s.manifests)

  assert.equal(result.status, 2, 'no pin means a refusal, not an empty plan')
  assert.match(result.stderr, /deploy/, 'the message names the missing pin')
  assert.equal(result.stdout.includes('would delete'), false, 'nothing is proposed')
})

test('a bare or wrong invocation exits 2 with the usage on stderr', () => {
  // The house precedent for tools/*.mjs (test/tooling/journal-cli.test.js): a
  // command line that cannot be right is a usage error, not an empty answer.
  const s = scenario()

  for (const args of [[], ['nope'], ['plan'], ['plan', '--deploy'], ['plan', '--deploy', 'x', '--wat'], ['apply', '--deploy', s.deploy]]) {
    const result = s.space.run(...args)
    assert.equal(result.status, 2, 'exit 2 for: ' + JSON.stringify(args))
    assert.match(result.stderr, /usage: node tools\/image-retention\.mjs/, 'the usage is on stderr')
  }
})

test('apply refuses a planning flag instead of ignoring it', () => {
  const s = scenario()
  const planFile = s.space.write('plan.json', JSON.stringify({ remove: [] }))

  const result = s.space.run('apply', '--plan', planFile, '--deploy', s.deploy, '--keep', '5')

  assert.equal(result.status, 2, 'a flag that cannot do anything here is refused')
  assert.match(result.stderr, /--keep belongs to plan/, 'the message names the flag and the command')
})

test('apply refuses a plan entry it cannot read, before any request', () => {
  // A hand-edited artifact is the one input apply cannot trust.
  const s = scenario()
  const planFile = s.space.write('plan.json', JSON.stringify({
    remove: [{ digest: s.older.name, tags: s.older.metadata.container.tags }]
  }))

  const result = s.space.run('apply', '--plan', planFile, '--deploy', s.deploy, '--manifests', s.manifests)

  assert.equal(result.status, 2, 'no id means no delete')
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed|EAI_AGAIN/, 'no request was made')
  assert.match(result.stderr, /no usable id/, 'the reason is the entry, not the network')
})

test('apply refuses a plan entry that carries main, even when no pin names it now', () => {
  // The plans in a plan file should never contain this. An edited one can, and
  // apply is the half of the design that has to fail closed.
  const s = scenario()
  const planFile = s.space.write('plan.json', JSON.stringify({
    remove: [{ id: s.newest.id, digest: s.newest.name, tags: ['main', 'sha-0000003'] }]
  }))
  const bare = s.space.write('deploy3/manifests/paper.yaml', 'image: ghcr.io/bafbi/monoplayer:sha-0000009\n')

  const result = s.space.run('apply', '--plan', planFile, '--deploy', s.deploy,
    '--manifests', path.dirname(bare) + '/..', '--pins', s.pins)

  assert.equal(result.status, 2, 'main is never deletable')
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed|EAI_AGAIN/, 'no request was made')
})

test('the dev lane tells the operator to register a pin it sets', () => {
  // Registration has to be a side effect of pinning, not a second act of memory:
  // no manifest records a kubectl set image, so retention cannot see it.
  const lane = fs.readFileSync(path.join(ROOT, 'scripts', 'dev-lane.sh'), 'utf8')

  assert.match(lane, /deploy\/pins\.txt/, 'the lane names the pin list')
  assert.match(lane, /register it/, 'and says to register it')
})

test('apply deletes the ids in a reviewed plan and nothing else', () => {
  const s = scenario()
  const planned = s.space.run('plan', '--versions', s.data, '--deploy', s.deploy, '--manifests', s.manifests, '--keep', '1', '--json')
  assert.equal(planned.status, 0, planned.stderr)
  const planFile = path.join(s.space.dir, 'plan.json')
  fs.writeFileSync(planFile, planned.stdout)

  const result = s.space.run('apply', '--plan', planFile, '--deploy', s.deploy, '--manifests', s.manifests, '--dry-run')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp('would delete ' + s.older.id), 'the id from the plan is what it acts on')
  assert.doesNotMatch(result.stdout, new RegExp(s.live.id), 'a kept version is not in the plan')
})

test('apply refuses a plan whose target became a pin, before any request', () => {
  const s = scenario()
  // The plan was reviewed, then someone pinned the version by digest.
  const planFile = path.join(s.space.dir, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify({
    keepLast: 1,
    remove: [{ id: s.older.id, digest: s.older.name, tags: s.older.metadata.container.tags }]
  }))
  const deploy = s.space.write('.deploy2/deploy/manifests/kustomization.yaml', DEPLOY_KUSTOMIZATION)
  const pinnedManifest = s.space.write('deploy2/manifests/deployment.yaml',
    'image: ghcr.io/bafbi/monoplayer@sha256:' + s.older.name.slice('sha256:'.length) + '\n')

  const result = s.space.run('apply', '--plan', planFile, '--deploy', deploy,
    '--manifests', path.dirname(pinnedManifest) + '/..')

  assert.equal(result.status, 2, 'a pinned target is a refusal, not a failure')
  // The fake API host is unroutable, so a connection error here would prove the
  // request went out before the check.
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed|EAI_AGAIN/, 'no request was made')
  assert.match(result.stderr, /pinned/, 'the reason is the pin')
})

// ---------------------------------------------------------------------------
// The workflow, the doc, and the task
// ---------------------------------------------------------------------------

const WORKFLOW = read('.github/workflows/image-retention.yaml')
const DEPLOYMENT_DOC = read('docs/deployment.md')

// A job's own text, from its two-space heading to the next one. A key in a
// comment or a dispatch input indents further, so the anchor is exact.
function job (name) {
  const start = WORKFLOW.search(new RegExp('^  ' + name + ':$', 'm'))
  assert.notEqual(start, -1, 'the workflow defines the ' + name + ' job')
  const rest = WORKFLOW.slice(start + 1)
  // Terminate on a known job name rather than on any two-space key, so a future
  // top-level env: or defaults: block cannot silently change what a case reads.
  const next = rest.search(/^ {2}(?:plan|apply):$/m)
  return next === -1 ? rest : rest.slice(0, next)
}

test('the retention workflow runs on a schedule and can be dispatched', () => {
  assert.match(WORKFLOW, /^on:\n  schedule:\n    - cron: '/m, 'a schedule is the trigger')
  assert.doesNotMatch(WORKFLOW, /^ {2}push:/m, 'a push never runs this: a build must not race retention')
  assert.match(WORKFLOW, /^ {2}workflow_dispatch:/m, 'a human can run it')
  assert.match(WORKFLOW, /apply:\n(?:.*\n)*?\s+default: false/, 'a dispatch defaults to a dry run')
})

test('the dry-run job cannot delete and the delete job needs it', () => {
  const planJob = job('plan')
  const applyJob = job('apply')

  assert.match(planJob, /packages: read/, 'the planning job holds read only')
  assert.doesNotMatch(planJob, /packages: write/, 'the planning job cannot delete')
  assert.match(applyJob, /packages: write/, 'only the delete job may delete')
  assert.match(applyJob, /needs: plan/, 'it acts on the reviewed plan')
  assert.match(applyJob, /vars\.IMAGE_RETENTION_APPLY == 'true'/, 'a repository variable enables it')
})

test('a failed plan or delete cannot hide behind the pipe', () => {
  // The steps pipe the tool into tee to reach the job summary. Without pipefail
  // the step's status is tee's, and a red plan would read as a green one.
  const runs = WORKFLOW.split(/^ {8}run: \|$/m).slice(1)
  const piped = runs.filter(block => block.includes('| tee'))

  assert.equal(piped.length, 2, 'both tool calls are piped into tee')
  for (const block of piped) {
    assert.match(block, /^\s+set -euo pipefail$/m, 'pipefail is on in that step')
  }
})

test('both jobs are bounded and run the node the repo pins', () => {
  // A hung registry call would hold the concurrency group and queue tomorrow's
  // run behind it, so the timeout is part of the design.
  for (const name of ['plan', 'apply']) {
    assert.match(job(name), /timeout-minutes: \d+/, name + ' is bounded')
  }
  assert.match(WORKFLOW, /jdx\/mise-action@v2/, 'the job uses the repo\'s pinned toolchain')
  assert.doesNotMatch(WORKFLOW, /setup-node/, 'not a second node version to drift from mise.toml')
})

test('the workflow reads the deploy pin from the deploy branch, not main', () => {
  assert.match(WORKFLOW, /ref: deploy/, 'the deploy branch is checked out')
  assert.match(WORKFLOW, /--deploy \.deploy\/deploy\/manifests\/kustomization\.yaml/, 'its pin is passed in')
})

test('the workflow states the allowlist, including N', () => {
  const header = WORKFLOW.slice(0, WORKFLOW.indexOf('\nname:'))
  // AC3 lives in this line: the pin file is where the next lane registers a pin,
  // and a header that stops naming it is a header that stops documenting it.
  assert.match(header, /deploy\/pins\.txt/, 'the header names the registration point')
  assert.match(header, /deploy branch/, 'the header names the deploy pin')
  assert.match(WORKFLOW, /KEEP_LAST: '?\d+'?/, 'N is an input, not a number buried in the script')
  assert.match(WORKFLOW, new RegExp('KEEP_LAST: .?' + DEFAULT_KEEP_LAST), 'the workflow states the same N as the tool')
  assert.match(WORKFLOW, new RegExp('MIN_AGE_DAYS: .?' + DEFAULT_MIN_AGE_DAYS), 'the grace period is stated too')
})

test('the deployment doc explains the allowlist and how to enable deletion', () => {
  assert.match(DEPLOYMENT_DOC, /## Image tag retention/, 'the section exists')
  assert.match(DEPLOYMENT_DOC, /IMAGE_RETENTION_APPLY/, 'it names the switch')
  assert.match(DEPLOYMENT_DOC, new RegExp('last ' + DEFAULT_KEEP_LAST), 'it states N')
  assert.match(DEPLOYMENT_DOC, /register/i, 'it says how a new lane registers its pin')
  assert.match(DEPLOYMENT_DOC, /grace/i, 'it says the young end is a grace day')
})

test('a human can run the dry run with one task', () => {
  const task = readMiseTasks().get('image:retention')

  assert.ok(task, 'mise.toml defines image:retention')
  assert.match(task.body, /tools\/image-retention\.mjs plan/, 'the task plans, it never applies')
  assert.match(task.body, /--deploy/, 'the task names the deploy pin')
  // The pin is the running image. A stale origin/deploy names the previous one,
  // so the list a human reviews would be wrong about the pin that matters most.
  assert.match(task.body, /git fetch[^\n]*origin deploy/, 'the task fetches the deploy branch first')
  assert.match(task.body, /set -euo pipefail/, 'a failed fetch stops the task')
})

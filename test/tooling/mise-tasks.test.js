// The gate's shape, pinned because a pull request that edits mise.toml also
// edits the gate it is judged by (#28).
//
// The ticket promises three things about mise.toml: check still runs every cheap
// rung, each verify:<area> task composes rungs instead of copying them, and a
// failing rung names the next one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { loadLadder } from '../../src/ladder/next-rung.js'
import { readMiseTasks } from './mise-toml.js'

const AREAS = ['relay', 'custody', 'driver', 'deploy']
const tasks = readMiseTasks()

test('the unit rung runs every test directory except the spike', () => {
  const unit = tasks.get('test')
  const dirs = fs.readdirSync(new URL('../', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)

  // The spike opens real sockets, so it stays out of the unit rung and runs as
  // its own rung. Every other directory must be listed, or a new test directory
  // would silently never run: one per src directory, plus support/ for the rig
  // the fake-integration tests share.
  const brace = unit.body.match(/test\/\{([^}]+)\}/)
  assert.ok(brace, 'the unit rung lists its test directories in one brace glob')
  const listed = brace[1].split(',').map(name => name.trim())

  assert.ok(dirs.includes('spike'), 'test/spike holds the socket spike')
  for (const dir of dirs.filter(name => name !== 'spike')) {
    assert.ok(listed.includes(dir), `the unit rung runs test/${dir}/`)
  }
  assert.ok(!listed.includes('spike'), 'the unit rung keeps the socket spike out')

  // package.json runs the same list for anyone who types npm test. A second
  // copy can drift, so the gate reads both.
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(
    [...pkg.scripts.test.matchAll(/test\/(\{([^}]+)\})/g)].map(m => m[2]),
    [brace[1].trim()],
    'npm test runs the same brace list as mise run test'
  )
})

test('the lint rung syntax-checks the tools as well as src and test', () => {
  const lint = tasks.get('lint')

  assert.match(lint.body, /find src test tools/, 'lint walks the tools directory')
  assert.match(lint.body, /-name '\*\.mjs'/, 'lint checks the .mjs tools')
})

test('check runs the three cheap rungs and nothing else', () => {
  const check = tasks.get('check')

  assert.ok(check, 'mise.toml defines check')
  assert.deepEqual(check.depends, ['lint', 'test', 'loopback'])
  assert.doesNotMatch(check.body, /^\s*run\s*=/m, 'check composes rungs instead of running a command')
})

test('every verify:<area> task composes tasks instead of copying a command', () => {
  for (const area of AREAS) {
    const task = tasks.get(`verify:${area}`)

    assert.ok(task, `mise.toml defines verify:${area}`)
    assert.doesNotMatch(task.body, /^\s*run\s*=/m, `verify:${area} has no run of its own`)
    assert.ok(task.depends.length > 1, `verify:${area} composes more than one task`)
    assert.ok(task.depends.includes('check'), `verify:${area} runs the gate first`)
    for (const dependency of task.depends) {
      assert.ok(tasks.has(dependency), `verify:${area} depends on a real task: ${dependency}`)
    }
  }
})

test('an expensive rung waits for the gate instead of racing it', () => {
  const expensive = new Map([
    ['verify:relay', 'spike'],
    ['verify:custody', 'online'],
    ['verify:driver', 'driver:scenario'],
    ['verify:deploy', 'image:build:no-push']
  ])

  // mise runs sibling depends concurrently, so the area task cannot order them.
  for (const [area, rung] of expensive) {
    assert.ok(tasks.get(area).depends.includes(rung), `${area} composes ${rung}`)
    assert.ok(tasks.get(rung).wait_for.includes('check'), `${rung} waits for check`)
  }
  assert.ok(
    tasks.get('driver:scenario').wait_for.includes('driver:build'),
    'driver:scenario waits for the driver build'
  )
})

test('verify:deploy builds the image without publishing it', () => {
  // The push is not part of what a Dockerfile change needs proven, and the
  // registry the script pushes to is one the manifests do not reference (#33).
  const noPush = tasks.get('image:build:no-push')
  const publish = tasks.get('image:build')
  const deploy = tasks.get('verify:deploy')

  assert.ok(noPush, 'mise.toml defines image:build:no-push')
  assert.match(noPush.body, /run = "PUSH=0 scripts\/build-image\.sh"/, 'the no-push task sets PUSH=0')
  assert.ok(noPush.wait_for.includes('check'), 'image:build:no-push waits for the gate')

  assert.match(publish.body, /run = "scripts\/build-image\.sh"/, 'the debug publish path is unchanged')
  assert.doesNotMatch(publish.body, /PUSH=0/, 'the publish path never sets PUSH=0')

  assert.ok(deploy.depends.includes('image:build:no-push'), 'verify:deploy composes the no-push build')
  assert.equal(deploy.depends.includes('image:build'), false, 'verify:deploy never publishes')
  assert.doesNotMatch(deploy.body, /publishes to the/, 'the description stops warning about a publish')
})

test('the secrets link stays out of the gate and off the network', () => {
  const link = tasks.get('secrets:link')

  assert.ok(link, 'mise.toml defines secrets:link')
  assert.match(link.body, /run = "scripts\/link-secrets\.sh"/, 'secrets:link runs the script')
  // CI checks out without secrets. A gate that linked them would either fail or,
  // worse, pass a rung that only works on one machine.
  assert.equal(link.depends.length, 0, 'secrets:link depends on nothing')
  for (const [name, task] of tasks) {
    assert.equal(
      (task.depends ?? []).includes('secrets:link'),
      false,
      `${name} must not depend on secrets:link`
    )
  }
})

// A task description is the promise a reader acts on (#123). Two of them
// overpromised: one said the testbed run always restores the live deployment,
// and one installed the driver into the pair the 26.2 client cannot join.
test('testbed:run names the restore it performs and the recovery it leaves to an operator', () => {
  const run = tasks.get('testbed:run')
  const down = tasks.get('testbed:down')

  assert.ok(run, 'mise.toml defines testbed:run')
  // The three halves the description has to carry: what the run restores, the
  // case the promise does not cover, and the command that recovers it. The old
  // text, "always restoring the live deployment", matched none of them.
  assert.match(run.description, /restores the live deployment/, 'the promise names what it restores')
  assert.match(run.description, /interrupt/, 'and the case the promise does not cover')
  assert.match(run.description, /mise run testbed:down/, 'with the command that recovers an interrupted run')
  assert.match(down.description, /restore the live deployment/, 'the recovery the run names is a real task')
})

// The driver install path is tools/driver/README.md, not a task (#123). The task
// that used to sit here ran install.sh with no environment, so it cloned the
// 26.1.2 record pair (docs/driver-lane.md): gate-b-player and
// gate-b-player-fabric, the client the 26.2 jar refuses to load. Retargeting it
// did not save it. gate-b-player-262-fabric already exists on the display host,
// install.sh exits 1 when the instance exists, and that host has no checkout for
// mise to run in, so no form of the task worked where the Prism root lives.
// Nothing referenced it, so it is gone. install.sh takes the pair from BASE and
// INSTANCE with no default (#190), so a task that installs the driver again
// names the 26.2 pair itself.
test('the driver install path is a script, not a mise task', () => {
  assert.equal(
    tasks.has('driver:install'),
    false,
    'tools/driver/README.md carries the install, and only it'
  )
  // A task that runs the installer with a jar, not the lint rung that
  // syntax-checks the script.
  for (const [name, task] of tasks) {
    if (!/tools\/driver\/install\.sh [^ ]*\.jar/.test(task.body)) continue
    assert.match(task.body, /BASE=gate-b-player-262(?![-\w])/, name + ' names the 26.2 base instance')
    assert.match(task.body, /INSTANCE=gate-b-player-262-fabric(?![-\w])/, name + ' names the 26.2 driver instance')
  }
})

test('every rung task names the next rung when it fails', () => {
  for (const rung of loadLadder()) {
    for (const name of rung.tasks) {
      const task = tasks.get(name)

      assert.ok(task, `mise.toml defines the rung task ${name}`)
      assert.ok(
        task.body.includes(`node src/ladder/next-rung.js ${name} $?`),
        `mise run ${name} prints the next rung on failure, with the exit status`
      )
    }
  }
})

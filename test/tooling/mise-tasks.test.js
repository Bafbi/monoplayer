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
  // its own rung. Every other directory is a src directory and must be listed,
  // or a new test directory would silently never run.
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
    ['verify:deploy', 'image:build']
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

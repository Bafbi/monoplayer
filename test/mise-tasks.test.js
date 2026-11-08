// The gate's shape, pinned because a pull request that edits mise.toml also
// edits the gate it is judged by (#28).
//
// The ticket promises three things about mise.toml: check still runs every cheap
// rung, each verify:<area> task composes rungs instead of copying them, and a
// failing rung names the next one.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadLadder } from '../src/ladder/next-rung.js'
import { readMiseTasks } from './mise-toml.js'

const AREAS = ['relay', 'auth', 'driver', 'deploy']
const tasks = readMiseTasks()

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
    ['verify:auth', 'online'],
    ['verify:driver', 'gate-b:scenario'],
    ['verify:deploy', 'image:build']
  ])

  // mise runs sibling depends concurrently, so the area task cannot order them.
  for (const [area, rung] of expensive) {
    assert.ok(tasks.get(area).depends.includes(rung), `${area} composes ${rung}`)
    assert.ok(tasks.get(rung).wait_for.includes('check'), `${rung} waits for check`)
  }
  assert.ok(
    tasks.get('gate-b:scenario').wait_for.includes('gate-b:driver:build'),
    'gate-b:scenario waits for the driver build'
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

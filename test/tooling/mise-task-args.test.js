// #320. `mise run TASK [ARGS...]` gives a task its arguments by appending them
// to the end of its run string. mise 2026.10.11 says so: "For an inline command,
// mise appends the arguments to the command" (tasks/running-tasks). Every rung
// used to be one inline command, joined to its hint with `||`:
//
//   node src/ladder/loopback.js || node src/ladder/next-rung.js loopback $?
//
// So `mise run loopback -- --verbose` put the flag after the hint, and the rung
// never saw it. A rung is a shell script now. mise calls a shebang script with
// the arguments as script arguments ("A shebang script or a file task receives
// them as script arguments, such as $1 and $@ in Bash"). The script passes them
// on with "$@" before the hint.
//
// The string check below is the shape. The bash run is the proof. A fake `node`
// first on PATH records the argv it is handed, so a forwarding that only looks
// right fails on the argv it delivers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempRoot } from '../support/temp.js'

import { loadLadder } from '../../src/ladder/next-rung.js'
import { readMiseTasks } from './mise-toml.js'

const tasks = readMiseTasks()
const RUNGS = loadLadder().flatMap(rung => rung.tasks)
const HINT = /node src\/ladder\/next-rung\.js (\S+) \$\?/

// Rung 0 checks a fixed list of files, and no stage in its chain reads an
// argument. There is nowhere to forward one. It refuses one instead, loudly: a
// silent drop is the defect this file exists to catch.
const REFUSES = new Set(['lint'])

// `online` reaches its command through scripts/online-cluster.sh. That script
// takes the account lease before it runs anything, so the argv run below would
// take a real lease on the cluster. Its forwarding is the string check.
const LEASED = new Set(['online'])

test('every rung task runs as a script, so mise hands it its arguments', () => {
  for (const name of RUNGS) {
    const run = tasks.get(name).run
    assert.match(run, /^#!/, `mise run ${name} is a script, not an inline command`)
  }
})

test('a rung hands its arguments to the command, not to the hint', () => {
  for (const name of RUNGS) {
    const run = tasks.get(name).run
    const hint = run.match(HINT)

    assert.ok(hint, `mise run ${name} keeps the next-rung hint`)
    assert.equal(hint[1], name, `mise run ${name} names itself in the hint`)

    const command = run.slice(0, hint.index).trimEnd()
    if (REFUSES.has(name)) {
      assert.match(command, /\[ "\$#" -eq 0 \]/, `mise run ${name} refuses an argument it cannot forward`)
      assert.doesNotMatch(command, /"\$@"/, `mise run ${name} forwards no argument, so it refuses every one`)
      continue
    }
    assert.match(
      command,
      /"\$@"\s*\|\|$/,
      `mise run ${name} forwards its arguments to the command, on the near side of ||`
    )
  }
})

// The proof. This runs the script mise would run, under bash, with a fake `node`
// that keeps its argv. `bash -c script rung ARGS...` is the shape mise uses for a
// shebang script: $0 is the name, and $@ holds the arguments.
function rig () {
  const dir = tempRoot('monoplayer-rung-args-')
  const bin = path.join(dir, 'bin')
  const log = path.join(dir, 'argv.log')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'node'),
    [
      '#!/usr/bin/env bash',
      'printf -- "---\\n" >> "$ARGV_LOG"',
      'printf "%s\\n" "$@" >> "$ARGV_LOG"',
      'exit "${FAKE_EXIT:-0}"',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )

  return (script, args, fakeExit) => {
    fs.writeFileSync(log, '')
    const result = spawnSync('bash', ['-c', script, 'rung', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, ARGV_LOG: log, FAKE_EXIT: fakeExit }
    })
    const invocations = fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean)
      .map(chunk => chunk.split('\n').filter(Boolean))
    return { ...result, invocations }
  }
}

test('the arguments reach the command, and the hint stays quiet when it succeeds', () => {
  const run = rig()

  for (const name of RUNGS.filter(rung => !REFUSES.has(rung) && !LEASED.has(rung))) {
    const script = tasks.get(name).run

    const success = run(script, ['--probe', 'a b'], '0')
    assert.equal(success.invocations.length, 1, `mise run ${name} does not print the hint when the rung succeeds`)
    assert.deepEqual(
      success.invocations[0].slice(-2),
      ['--probe', 'a b'],
      `mise run ${name} hands the command one argv entry per argument`
    )
    assert.equal(
      success.invocations[0].includes('src/ladder/next-rung.js'),
      false,
      `mise run ${name} hands its arguments to the rung, not to the hint`
    )

    const failure = run(script, ['--probe'], '1')
    assert.equal(failure.invocations.length, 2, `mise run ${name} still prints the hint when the rung fails`)
    assert.deepEqual(
      failure.invocations[1],
      ['src/ladder/next-rung.js', name, '1'],
      `mise run ${name} keeps the hint's task name and the exit status it reports`
    )
  }
})

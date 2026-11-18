// The panel's stylesheet: compile it, or prove the committed bundle is what the
// source says.
//
//   node tools/panel-css.mjs            # writes src/panel/public/app.css
//   node tools/panel-css.mjs --check    # recompiles to a temporary file and fails
//                                       # when the committed bundle differs
//
// The bundle is committed, so the image ships a stylesheet and no compiler (#248).
// That trade has one failure mode: a source edit, no rebuild, and a page that is
// not the one in the diff. The --check mode is the answer, and mise run lint runs
// it, so a stale bundle is a red gate instead of a silent drift.
//
// The comparison is byte for byte, not a hash of the source: Tailwind's output is
// deterministic for a given input, so any difference is a bundle compiled from a
// different tree.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INPUT = path.join(ROOT, 'src', 'panel', 'public', 'app.css.in')
export const OUTPUT = path.join(ROOT, 'src', 'panel', 'public', 'app.css')
// The compiler is a dev dependency, so a checkout that has not run mise run
// install cannot compile. Say that, rather than failing with ENOENT on a path.
const CLI = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss')

const USAGE = 'usage: node tools/panel-css.mjs [--check]'

// The compile itself. Minified, because the file is committed and read in a diff:
// the smaller it is, the less of the diff is whitespace.
export function compile (output) {
  if (fs.existsSync(CLI) === false) {
    throw new Error('the Tailwind compiler is not installed: run mise run install')
  }
  const run = spawnSync(CLI, ['-i', INPUT, '-o', output, '--minify'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (run.error) throw run.error
  if (run.status !== 0) {
    throw new Error('the Tailwind compiler failed: ' + String(run.stderr ?? '').trim())
  }
  return output
}

function main (argv) {
  const check = argv.includes('--check')
  const unknown = argv.filter(arg => arg !== '--check')
  if (unknown.length > 0) {
    process.stderr.write('unknown argument ' + JSON.stringify(unknown[0]) + '\n' + USAGE + '\n')
    return 2
  }

  if (!check) {
    compile(OUTPUT)
    const bytes = fs.statSync(OUTPUT).size
    process.stdout.write('panel:css wrote ' + path.relative(ROOT, OUTPUT) + ' (' + bytes + ' bytes)\n')
    return 0
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-css-'))
  const fresh = path.join(scratch, 'app.css')
  try {
    compile(fresh)
    const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT) : Buffer.alloc(0)
    const built = fs.readFileSync(fresh)
    if (committed.equals(built)) {
      process.stdout.write('panel:css is current (' + built.length + ' bytes)\n')
      return 0
    }
    // Say which file is stale and how far off it is, then stop. A check that only
    // prints "stale" makes the reader run the build to find out what changed.
    process.stderr.write(
      'the committed stylesheet is stale: ' + path.relative(ROOT, OUTPUT) +
      ' is ' + committed.length + ' bytes and the source compiles to ' + built.length + '.\n' +
      'run mise run panel:css and commit the result.\n')
    return 1
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

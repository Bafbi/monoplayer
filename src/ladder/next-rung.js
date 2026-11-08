// The rung that runs next, in the ladder's own words.
//
// A rung that fails prints the next rung to run, the class that rung catches,
// and what it needs. All three come from docs/testing-ladder.md, so the doc, the
// gate, and the hint cannot drift.
//
//   node src/ladder/next-rung.js <task> [<exit code>]
//
// Prints the hint on stderr for a rung that exited 1. Other codes (2 for a setup
// failure, 130/143 for an interrupt) pass through without a hint.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const DOC = new URL('../../docs/testing-ladder.md', import.meta.url)

// The rung number and its label share the first cell, as in "2b transfer
// testbed". Every other table in the doc is skipped: those rows have another
// width, or a first cell that is not a rung number.
function cells (line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function plain (cell) {
  return cell.replace(/`/g, '')
}

export function parseLadder (text) {
  const rungs = []
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const row = cells(line)
    if (row.length !== 6) continue
    const head = row[0].match(/^([0-9]+[a-z]?)\s+(.+)$/)
    if (!head) continue
    rungs.push({
      id: head[1],
      label: head[2],
      tasks: [...row[1].matchAll(/`mise run ([^`]+)`/g)].map(match => match[1].trim()),
      cost: plain(row[2]),
      prerequisites: plain(row[3]),
      catches: plain(row[4]),
      cannotCatch: plain(row[5])
    })
  }
  return rungs
}

export function loadLadder (file = DOC) {
  return parseLadder(fs.readFileSync(file, 'utf8'))
}

export function failureHint (task, rungs = loadLadder()) {
  const index = rungs.findIndex(rung => rung.tasks.includes(task))
  if (index < 0) {
    throw new Error(`no ladder rung runs "mise run ${task}" (docs/testing-ladder.md)`)
  }

  const failed = rungs[index]
  const lines = [`mise run ${task} failed (rung ${failed.id}, ${failed.label}).`]
  const next = rungs[index + 1]
  if (!next) {
    lines.push(`Rung ${failed.id} is the top of the ladder, so there is no rung above it to name.`)
    return lines.join('\n')
  }

  const command = next.tasks.map(name => `mise run ${name}`).join(' then ')
  lines.push(`Next rung: ${command} (rung ${next.id}, ${next.label}) — ${next.cost}`)
  lines.push(`  catches: ${next.catches}`)
  lines.push(`  needs: ${next.prerequisites}`)
  return lines.join('\n')
}

export function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [task, code = '1'] = argv
  if (!task) {
    io.stderr.write('usage: node src/ladder/next-rung.js <task> [<exit code>]\n')
    return 1
  }

  // A rung exits 2 when its setup failed before the run, and 130 or 143 when it
  // was interrupted. Neither is a ladder position, so neither gets a hint. Every
  // other status, including an empty argument, prints the hint and exits 1: a
  // wrong hint beats a task that reports success after a failure.
  const status = Number(code)
  if (status === 2 || status >= 128) return status

  try {
    io.stderr.write(failureHint(task) + '\n')
  } catch (error) {
    io.stderr.write(`next-rung: ${String(error?.message ?? error)}\n`)
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}

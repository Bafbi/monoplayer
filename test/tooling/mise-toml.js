// Reads the subset of mise.toml this repo's tasks use: one [tasks.<name>]
// block per task, with a single-line `description` string and single-line
// `depends` / `wait_for` keys. A test helper, not a TOML parser: a block is the
// text between two headers, so a multi-line `run` is still searchable inside it.
import fs from 'node:fs'

export const MISE_TOML = new URL('../../mise.toml', import.meta.url)

// A key that is absent and a key with an empty value read the same, so a case
// matches on a task's text without a null check at every site.
function one (body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`, 'm'))
  return match ? match[1] : ''
}

function list (body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*$`, 'm'))
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]) : []
}

export function readMiseTasks (file = MISE_TOML) {
  const blocks = new Map()
  let current
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const header = line.match(/^\[tasks\.(?:"([^"]+)"|([^\]\s]+))\]$/)
    if (header) {
      current = []
      blocks.set(header[1] ?? header[2], current)
      continue
    }
    if (line.startsWith('[')) {
      current = undefined
      continue
    }
    current?.push(line)
  }

  const tasks = new Map()
  for (const [name, lines] of blocks) {
    const body = lines.join('\n')
    tasks.set(name, {
      name,
      body,
      description: one(body, 'description'),
      depends: list(body, 'depends'),
      wait_for: list(body, 'wait_for')
    })
  }
  return tasks
}

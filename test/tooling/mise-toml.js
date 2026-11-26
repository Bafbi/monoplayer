// Reads the subset of mise.toml this repo's tasks use: one [tasks.<name>]
// block per task, with a single-line `description` string and single-line
// `depends` / `wait_for` keys, plus the body of any other table a guard needs
// ([deps.<name>], [settings]). A test helper, not a TOML parser: a block is the
// text between two headers, so a multi-line `run` is still searchable inside it.
import fs from 'node:fs'

export const MISE_TOML = new URL('../../mise.toml', import.meta.url)

// A table header ends a block, but a shell body's own test does not: a rung
// script's `[ "$#" -eq 0 ] || …` guard starts with the same character. A header
// has no space after the bracket (#320).
const ENDS_BLOCK = /^\[[^\]\s[]/

// A key that is absent and a key with an empty value read the same, so a case
// matches on a task's text without a null check at every site.
function one (body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`, 'm'))
  return match ? match[1] : ''
}

export function readList (body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*$`, 'm'))
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]) : []
}

// A TOML basic string's escapes, for the shapes mise.toml writes in one: a
// backslash, a quote, and a newline. A literal (`)'''`) string takes none.
function unescape (text) {
  return text.replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char === 't' ? '\t' : char))
}

// The `run` value as mise receives it: a one-line command, a basic multi-line
// script, or a literal multi-line script. A task's run decides how mise hands the
// task its arguments. The tests that read it need the value, not the block
// around it.
function run (body) {
  const inline = body.match(/^\s*run\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m)
  if (inline) return unescape(inline[1])
  const literal = body.match(/^\s*run\s*=\s*'''\r?\n([\s\S]*?)'''/m)
  if (literal) return literal[1]
  const basic = body.match(/^\s*run\s*=\s*"""\r?\n([\s\S]*?)"""/m)
  if (basic) return unescape(basic[1])
  return ''
}

// One table's body as written, for the tables that sit beside [tasks.*]:
// [deps.<name>] and [settings]. A header is the line that names the table, at
// column 0, and a table ends at the next header: the same two rules the task
// reader below applies.
export function readMiseTable (table, file = MISE_TOML) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const start = lines.indexOf(`[${table}]`)
  if (start === -1) return ''
  const body = lines.slice(start + 1)
  const end = body.findIndex(line => ENDS_BLOCK.test(line))
  return (end === -1 ? body : body.slice(0, end)).join('\n')
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
    if (ENDS_BLOCK.test(line)) {
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
      depends: readList(body, 'depends'),
      wait_for: readList(body, 'wait_for'),
      run: run(body)
    })
  }
  return tasks
}

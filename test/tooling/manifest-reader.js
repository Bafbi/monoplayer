// The manifest lines a guard reads, in the shapes this repository's files write them.
//
// There is no YAML library in this repo and no new dependency, so a guard reads the shapes
// these files use and throws on a line it cannot place: a guard that skips what it cannot
// parse is a guard that passes on the one manifest that matters. One copy, because two
// readers with two policies would disagree about the same manifest, which is the shape of
// bug these guards exist to prevent. mise.toml globs `*.test.js`, so this module is never
// run as a test.
//
// Nothing here counts its callers. A list in this header is a sentence that goes stale, and the
// files that import this module are the list.

// The one line policy both guards share: a blank line is nothing, and a comment is not
// data.
export const isData = line => line.trim() !== '' && !line.trimStart().startsWith('#')

// A document with its comments gone. A Service that says in prose "there is no tunnel here
// and there must never be one" is not a Service that publishes one, and a guard that cannot
// tell the two apart would make the comment the load-bearing part.
export const withoutComments = text => text.split('\n')
  .filter(line => !line.trimStart().startsWith('#'))
  .join('\n')

// The comment run above the line a guard names, as one text and with the source line each of its
// characters is on. `section` reads the lines under a key; this reads the prose above one, because
// a manifest restates a fact about a value in the comment beside it, and `isData` and
// `withoutComments` both drop those lines on purpose.
//
// The three rules a caller needs to predict what comes back:
//
// - The run ends at the first line above the marker that is neither blank nor a comment, so the
//   key or the blank line before it is the boundary, and a comment above that boundary is another
//   block's.
// - A blank line does not end the run, and a `#` at any indent continues it. A block a manifest
//   splits into paragraphs is one run, because a reader takes it for one block and a fact in any
//   of its paragraphs is the same fact.
// - Lines are joined with the newline they stood on, and the `#` marker is stripped. A word split
//   across two lines would read as two words; no manifest here splits one.
//
// The run is one text because a sentence wraps: the comment #723 emptied wrote "Mojang issues one
// version:" and "4." on consecutive lines, and a reader that tests one line at a time is green on
// it. A pattern that should not reach across two sentences therefore has to say so itself, by
// keeping its adjacency class off \n.
//
// This is not surface-pointers.test.js's rule for the same bytes. That guard ends a run at a
// `#`-only line, because a pointer's claim is the paragraph it is written in. This one keeps the
// block, because the claim is the value's and the block is what a reader reads for the value.
//
// What it does not handle: a block scalar whose content lines start with `#` and stands directly
// above the marker serves its body as prose. No manifest here does that today, and telling the two
// apart needs a YAML reader this repo does not have.
//
// The two throws are this function's own: `section` answers '' and `rules` answers [] for a line
// they cannot find, and a caller of this one cannot tell a moved block from a block that says
// something else. So a marker no line holds, and a marker with no comment above it, are failures.
export function commentAbove (text, marker, file) {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.trim() === marker)
  if (at === -1) throw new Error(file + ' writes no ' + JSON.stringify(marker) + ' line, and this guard reads the comment above it')
  let first = at
  while (first > 0 && (lines[first - 1].trim() === '' || lines[first - 1].trimStart().startsWith('#'))) first -= 1
  const run = []
  for (let index = first; index < at; index += 1) {
    if (lines[index].trim() !== '') run.push(index + 1)
  }
  if (run.length === 0) throw new Error(file + ':' + (at + 1) + ' writes no comment above ' + JSON.stringify(marker))
  const lineOf = []
  let joined = ''
  for (const line of run) {
    const body = lines[line - 1].replace(/^\s*#\s?/, '')
    if (joined !== '') { joined += '\n'; lineOf.push(line) }
    joined += body
    lineOf.push(...new Array(body.length).fill(line))
  }
  return { text: joined, lineOf, first: run[0], lines: run.length }
}

// The lines under a key, up to the next line indented no deeper than the key.
export function section (text, indent, key) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === ' '.repeat(indent) + key + ':')
  if (start === -1) return ''
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { body.push(line); continue }
    if (line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

const RULE_KEYS = ['apiGroups', 'resources', 'resourceNames', 'verbs']

// The rules of a Role. A key this reader does not know, or a line it cannot place,
// throws: the guard has to read every rule it is asked to judge.
export function rules (text) {
  const body = text.split(/^rules:\s*$/m)[1]
  if (body === undefined) return []
  const parsed = []
  let current = null
  for (const line of body.split('\n')) {
    if (!isData(line)) continue
    if (line.length - line.trimStart().length < 2) break
    const opening = line.match(/^ {2}- (\S.*)$/)
    if (opening) {
      current = {}
      parsed.push(current)
      entry(current, opening[1])
      continue
    }
    const value = line.match(/^ {4}(\S.*)$/)
    if (!value || current === null) {
      throw new Error('this guard cannot read the rule line: ' + JSON.stringify(line))
    }
    entry(current, value[1])
  }
  return parsed
}

function entry (rule, text) {
  const found = text.match(/^([A-Za-z]+):\s*(\[.*\]|\S+)$/)
  if (!found) throw new Error('this guard cannot read the rule value: ' + JSON.stringify(text))
  const [, key, value] = found
  if (!RULE_KEYS.includes(key)) throw new Error('this guard does not know the rule key ' + key)
  if (key in rule) throw new Error('the rule sets ' + key + ' twice')
  rule[key] = value.startsWith('[')
    ? [...value.matchAll(/"([^"]*)"/g)].map(match => match[1])
    : [value]
  if (value.startsWith('[') && !value.endsWith(']')) {
    throw new Error('this guard reads flow-style lists only: ' + key + ' ' + value)
  }
}

// The manifest lines a guard reads, in the shapes this repository's files write them.
//
// There is no YAML library in this repo and no new dependency, so a guard reads the shapes
// these files use and throws on a line it cannot place: a guard that skips what it cannot
// parse is a guard that passes on the one manifest that matters. One copy, because two
// readers with two policies would disagree about the same manifest, which is the shape of
// bug these guards exist to prevent. mise.toml globs `*.test.js`, so this module is never
// run as a test.
//
// Two callers today: the panel's guard (deploy/panel/, #230) and the account lease's
// (deploy/manifests/account-lease-*.yaml, #302).

// The one line policy both guards share: a blank line is nothing, and a comment is not
// data.
export const isData = line => line.trim() !== '' && !line.trimStart().startsWith('#')

// A document with its comments gone. A Service that says in prose "there is no tunnel here
// and there must never be one" is not a Service that publishes one, and a guard that cannot
// tell the two apart would make the comment the load-bearing part.
export const withoutComments = text => text.split('\n')
  .filter(line => !line.trimStart().startsWith('#'))
  .join('\n')

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

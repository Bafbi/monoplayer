// The loopback assertion contract (#49). `src/ladder/loopback.js` declares every
// assertion by id, and `docs/testing-ladder.md` documents each one. Nothing tied
// the two together, so a check added to the run and not to the doc went
// unnoticed. `test/ladder/next-rung.test.js` reads the same doc the same way.
//
// The guard reads the run's declaration, not `.reports/loopback-report.json`. The
// report is gitignored and written by the `loopback` task, which mise runs beside
// `test` inside `mise run check` (mise.toml), so the file is absent on a clean
// checkout and may be mid-write while this file runs. The ids in the report are
// the ids of these calls, and the calls are there before the run.
//
// Nothing here opens a socket: both cases read a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const RUN = read('src/ladder/loopback.js')
const LADDER = read('docs/testing-ladder.md')

// One section, from its heading to the next heading of the same or a higher
// level, so an id bullet elsewhere in the file cannot satisfy the contract.
function section (text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^#+\s/.test(line) && line.replace(/^#+\s+/, '').trim() === heading)
  assert.notEqual(start, -1, 'the doc has a "' + heading + '" section')
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const next = lines[i].match(/^(#+)\s/)
    if (next && next[1].length <= level) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

// The ids the run declares: the first argument of every `check(...)` call, which
// is the id the report carries. A call opens its own line, so a commented-out
// check does not count, and the pattern leaves `wire.check(payload)` alone.
function runIds (source) {
  return [...source.matchAll(/^[ \t]*check\(\s*'([^']+)'/gm)].map(match => match[1])
}

// The number of check() calls, id literal or not, so a call that computes its
// id cannot quietly drop out of the guard.
function callSites (source) {
  return [...source.matchAll(/^[ \t]*check\(/gm)].length
}

// The ids the doc documents: a bullet that opens with the id in code. An id
// mentioned mid-sentence is a cross-reference, not documentation.
function docIds (text) {
  return [...section(text, 'Loopback assertion contract').matchAll(/^- \`([^\`]+)\`/gm)]
    .map(match => match[1])
}

const unique = ids => new Set(ids).size === ids.length
const only = (ids, other) => ids.filter(id => !other.includes(id))

function drift (source, doc) {
  const declared = runIds(source)
  const documented = docIds(doc)
  return { declared, documented, undocumented: only(declared, documented), undeclared: only(documented, declared) }
}

test('every assertion the loopback declares is documented, and the reverse', () => {
  const { declared, documented, undocumented, undeclared } = drift(RUN, LADDER)

  // Both sides have to be read, or a reformat that matches nothing would pass.
  assert.ok(declared.length > 0, 'src/ladder/loopback.js declares its assertions with check()')
  assert.ok(documented.length > 0, 'docs/testing-ladder.md documents the contract as bullets')
  assert.equal(declared.length, callSites(RUN),
    'every check() call names its assertion id as a literal, so the guard can read it')
  assert.equal(unique(declared), true, 'no assertion id is declared twice: ' + declared.join(', '))
  assert.equal(unique(documented), true, 'no assertion id is documented twice: ' + documented.join(', '))

  assert.deepEqual(undocumented, [], 'docs/testing-ladder.md does not document ' +
    undocumented.join(', ') + ', which src/ladder/loopback.js declares: add a bullet for ' +
    (undocumented.length === 1 ? 'it' : 'each') + ' under "Loopback assertion contract"')
  assert.deepEqual(undeclared, [], 'src/ladder/loopback.js declares no ' +
    undeclared.join(', ') + ', which docs/testing-ladder.md documents: add the check, ' +
    'or remove the bullet under "Loopback assertion contract"')
})

test('the guard notices an id that only one side holds', () => {
  // Fixtures, not the tree: this case tests the comparison, so a real drift
  // cannot make the case about the drift instead.
  const source = [
    '    check(',
    "      'O1',",
    "      'the first check', true, null) }",
    '    check(',
    "      'O2',",
    "      'the second check', true, null) }",
    '      wireCheck: payload => wire.check(payload),',
    ''
  ].join('\n')
  const doc = [
    '### Loopback assertion contract',
    '',
    '- \`O1\` the first check.',
    '- \`O2\` the second check.',
    '',
    '## The next rung',
    '',
    '- \`O3\` a bullet outside the contract, which does not document it.',
    ''
  ].join('\n')

  assert.deepEqual(drift(source, doc), {
    declared: ['O1', 'O2'],
    documented: ['O1', 'O2'],
    undocumented: [],
    undeclared: []
  }, 'the guard reads the check() ids and the contract bullets, and nothing else')

  assert.deepEqual(drift(source.replace("'O1'", "'O1b'"), doc).undocumented, ['O1b'],
    'a check the doc does not document is reported')
  assert.deepEqual(drift(source.replace("'O1'", "'O1b'"), doc).undeclared, ['O1'],
    'and the id the doc documents but the run dropped is reported')
  assert.deepEqual(drift(source, doc.replace(/^- \`O2\`.*\n/m, '')).undocumented, ['O2'],
    'a bullet removed from the doc is reported')
  assert.deepEqual(drift(source, doc.replace('## The next rung', '- \`O99\` an assertion nobody runs.\n\n## The next rung')).undeclared, ['O99'],
    'a bullet the run does not declare is reported')
});

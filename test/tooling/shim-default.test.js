// No test double answers an argv it does not model with a success (#152). A shim that
// falls through to an exit 0 turns an unmodelled call into a passing case, which is how a
// script that dropped `-n "$LIVE_NAMESPACE"` stayed green while its report measured the
// dev namespace.
//
// The shims this ticket converted drive `test/support/kubectl-shim.js`, whose default
// fails and names the argv. This guard is what keeps a sixth one from being written by
// hand: a catch-all arm that answers with a success fails here, at the moment it is
// written, instead of passing a call nobody modelled.
//
// The scan reads every line of every `.js` under `test/`, quoted or inside a template
// literal, because both spellings exist in the tree. An arm that refuses is fine: the
// baseline is `test/tooling/nath.test.js`, whose `fake hyprctl` names the command it does
// not know and exits 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEST = path.join(ROOT, 'test')

// The shims this ticket converted. Each takes its answers from the shared harness, so a
// call nobody modelled fails in the shim and lands in the case's own assertion.
const CONVERTED = [
  'test/tooling/dev-lane.test.js',
  'test/tooling/dev-custody.test.js',
  'test/tooling/gate-lane.test.js',
  'test/tooling/observer-report.test.js',
  'test/tooling/online-cluster.test.js'
]

// The last case of a converted file, which reads the hits file: it proves nothing unless
// it runs after every case that could reach a rule.
const COVERAGE_CASE = 'every rule of the shim is reached by a case'

// A catch-all arm, in either spelling the tree uses: a quoted array line or a line inside
// a template literal.
const catchAll = line => /^\s*'?\s*\*\)/.test(line)

// An arm that refuses. Anything else, including an arm that answers from a fixture and
// leaves the status to a line after `esac`, is a success nobody decided on.
const refuses = line => /exit\s+("|')?(\$\{?\w+|1)/.test(line) && !/exit\s+("|')?0/.test(line)

// The rows that are not this ticket's work. Each says why the shape is right or what
// closes it, and a row with a ticket is the work that is left.
const EXEMPT = {
  'test/testbed/switch.test.js': {
    ticket: '#568',
    reason: 'the transfer testbed shim, outside test/tooling/; #568 moves it to the shared harness'
  },
  'test/tooling/nath.test.js': {
    reason: 'a recording double: its subject is the argv and stdin it records, so it answers from a fixture and the cases assert the log. One of its two catch-alls, the fake hyprctl, already refuses and exits 1'
  }
}

function sources () {
  const found = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) found.push(full)
    }
  }
  walk(TEST)
  return found
}

const relativeOf = file => path.relative(ROOT, file).split(path.sep).join('/')

// Every catch-all that answers with a success, in the files that are not exempt.
function offenders () {
  const found = []
  for (const file of sources()) {
    const relative = relativeOf(file)
    if (Object.hasOwn(EXEMPT, relative)) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (catchAll(line) && !refuses(line)) found.push(relative + ':' + (index + 1) + ': ' + line.trim())
    })
  }
  return found
}

test('no test double answers an argv it does not model with a success', () => {
  assert.deepEqual(offenders(), [],
    'a catch-all that answers with a success passes a call nobody modelled. Use the shared default, which fails and names the argv:')
})

test('every converted shim takes its answers from the shared harness', () => {
  // The case above reads a shape; this one reads the wiring. A rewrite that kept the
  // default but hand-rolled the dispatch would still pass it, and would put the argv
  // matching back where it was.
  for (const relative of CONVERTED) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(text, /import \{.*kubectlShim.*\} from '\.\.\/support\/kubectl-shim\.js'/, relative + ' imports the shared shim')
    assert.match(text, /kubectlShim\(SHIM_RULES/, relative + ' builds its shim from its own rules')
    assert.match(text, /deadRules\(/, relative + ' asks the harness which rules went unreached')
  }
})

test('the dead-rule case runs last, so it reads every case before it', () => {
  // The case reads a file the other cases wrote. Appended after it, a case that reaches a
  // new rule would leave that rule looking dead, and a case that reaches nothing leaves the
  // check passing on an empty file. Position is the whole guarantee, so position is pinned.
  for (const relative of CONVERTED) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    const names = [...text.matchAll(/^test\('([^']+)'/gm)].map(match => match[1])
    assert.equal(names[names.length - 1], COVERAGE_CASE, relative + ' ends with the dead-rule case')
    assert.equal(names.filter(name => name === COVERAGE_CASE).length, 1, relative + ' has one dead-rule case')
  }
})

test('the walk reads the tree it claims to guard', () => {
  // A walk that finds nothing reports no offenders, which is the same answer as a clean
  // tree. Naming the files it read is what separates the two.
  const files = sources().map(relativeOf)
  for (const relative of CONVERTED) assert.ok(files.includes(relative), relative + ' is walked')
  assert.ok(files.length > 100, 'the walk reaches the whole test tree, not one directory: ' + files.length)
})

test('an exemption that no longer offends is dropped, and one that names nothing is refused', () => {
  // The list is the work that is left, so a row the tree no longer needs is a lie about
  // the tree, and a row for a file that is not there is a row nobody can check.
  for (const [relative, row] of Object.entries(EXEMPT)) {
    const full = path.join(ROOT, relative)
    assert.ok(row && typeof row.reason === 'string' && row.reason.length > 40, relative + ' says why it is exempt')
    assert.ok(fs.existsSync(full), relative + ' is a file this guard reads')
    const text = fs.readFileSync(full, 'utf8')
    assert.ok(text.split('\n').some(line => catchAll(line) && !refuses(line)),
      relative + ' still offends, so its row still says something true')
    if (Object.hasOwn(row, 'ticket')) assert.match(row.ticket, /^#\d+$/, relative + ' names the ticket that closes it')
  }
})

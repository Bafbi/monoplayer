// The cases for test/tooling/manifest-reader.js (#961). Every guard that reads a manifest's prose
// imports this reader, and until this file the only documents it was ever handed were the ones the
// repo ships: its policy was asserted through whatever those files happen to say. A reader whose
// edge cases are the tree's current content has the edge cases the tree has today, which is how a
// rule the header states, that a blank line does not end a run, went unexercised by every run the
// manifests write.
//
// So each case below writes or shares a document written for it, and asserts the answer. The
// documents carry the shapes the tree does not: a hash inside a quoted value, a hash that starts a
// list item, a nested section, a block scalar whose body lines start with a hash, and two comment
// paragraphs one blank line apart. Each case registers the export it reads, and the last case holds
// what ran to the module's own export list, so a sixth export fails here instead of shipping
// uncased, and a case that stopped running fails too (#885).
//
// A row that pins a limit the header names, or a place where the header and the walk disagree, says
// so where it stands. The one that is a walk to fix rather than a shape the reader lacks is filed,
// not fixed here.
//
// What this file does not carry: the tree. A guard that reads deploy/ keeps its own cases, and this
// file reads no file at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as reader from './manifest-reader.js'

const { isData, withoutComments, commentRuns, section, rules } = reader

// Each export, beside the title of the case below that reads it. A list of names here would be a
// count of the exports, and a count is green with the wrong five: the coverage case at the end
// compares this table's names to the module's own.
const CASE = {
  isData: 'isData calls a line data unless it is blank or starts with a hash',
  withoutComments: 'withoutComments drops the comment lines and keeps a hash inside a value',
  commentRuns: 'commentRuns reads a run across a blank line, at any indent, and stops at a data line',
  section: 'section reads the lines under a key, and a line no deeper than the key ends them',
  rules: 'rules reads the rules of a Role, and refuses a line it cannot place'
}

// The exports whose case has run, in run order. node:test runs the cases at one level in the order
// they are declared, so the case at the end of this file reads every name the ones above it
// registered. A registration rather than a scan of this file's text, because a scan proves a case is
// mentioned and never that it runs (#710): a case commented out, or one wrapped in a branch the
// runner never collects, still matches its own name in the source.
const RAN = []

const cased = (name, body) => {
  assert.ok(CASE[name] !== undefined, 'the case table names ' + name)
  test(CASE[name], () => { RAN.push(name); body() })
}

// A document with the shapes a line has to this reader: a comment, a comment at an indent, a blank
// line, a whitespace-only line, a hash inside a quoted value, a hash that starts a list item, and a
// hash inside a value further in. The last three are data, and a reader that splits a line on a
// hash gets all three wrong.
const DOCUMENT = [
  '# a comment line',
  '  # a comment at an indent',
  '',
  '   ',
  'label: "#0a0a0a"',
  '- "#0a0a0a"',
  'motd: "<#09add3>Monoplayer Gate B"'
].join('\n')

cased('isData', () => {
  for (const line of ['label: "#0a0a0a"', '- "#0a0a0a"', 'motd: "<#09add3>Monoplayer Gate B"']) {
    assert.ok(DOCUMENT.includes(line),
      'the document writes a hash inside a value, which is the shape a reader that splits on a hash gets wrong: ' + line)
  }
  assert.deepEqual(DOCUMENT.split('\n').map(isData),
    [false, false, false, false, true, true, true],
    'a comment line and a blank line are not data, and a hash inside a value is data at any depth')
})

cased('withoutComments', () => {
  assert.deepEqual(withoutComments(DOCUMENT).split('\n'),
    ['', '   ', 'label: "#0a0a0a"', '- "#0a0a0a"', 'motd: "<#09add3>Monoplayer Gate B"'],
    'the comment lines are gone and the blank lines stay: a guard that reads a body needs the lines that separate it')
  // The limit the header names, pinned: a trailing comment is left in place, because no export here
  // reads past a line's first character. Pinned rather than dropped, because a guard that reads a
  // value it expects to be alone is wrong on the day a manifest writes one.
  assert.equal(withoutComments('replicas: 1 # one pod'), 'replicas: 1 # one pod',
    'a trailing comment stays in the document: this reader finds a comment only at a line start')
})

// One block of prose with a blank line inside it, then a data line, then a comment at an indent, then
// a data line whose value holds a hash, then a run on the far side of that line. The line numbers the
// assertions name are 1-based, which is what first, last and lineOf give.
const PROSE = [
  '# The account lease is one object for every worktree on the cluster (#302).',
  '# A rung takes it while it uses the real account, and releases it after.',
  '',
  '# A second paragraph of the same block, one blank line up.',
  'kind: Role',
  '  # A comment after a data line is another run, at any indent.',
  '    # A deeper indent continues that run, which is what makes the indent a reader skips.',
  '  replicas: 1',
  'label: "#0a0a0a"',
  '# A run on the other side of a line that holds a hash in its value.'
].join('\n')

// A key whose value is a block scalar, with the body's own comment lines. The header names this as
// the shape the reader cannot tell from prose, and #1002 carries the manifest that writes one.
const BLOCK = [
  'config: |',
  '  # Config version. Do not change this',
  '  bind = "0.0.0.0:25566"',
  'next: value'
].join('\n')

cased('commentRuns', () => {
  const runs = commentRuns(PROSE)
  assert.deepEqual(runs.map(run => run.text), [
    'The account lease is one object for every worktree on the cluster (#302).\n' +
      'A rung takes it while it uses the real account, and releases it after.\n' +
      'A second paragraph of the same block, one blank line up.',
    'A comment after a data line is another run, at any indent.\n' +
      'A deeper indent continues that run, which is what makes the indent a reader skips.',
    'A run on the other side of a line that holds a hash in its value.'
  ], 'the marker is stripped, a blank line does not end a run, and a data line does')
  assert.deepEqual(runs.map(run => [run.first, run.last]), [[1, 4], [6, 7], [10, 10]],
    'a blank line does not end a run, a comment at any indent continues it, and a data line ends it')

  const [block] = runs
  assert.equal(block.lineOf.length, block.text.length,
    'every character of a run has a source line, which is what a failure names the block with')
  assert.deepEqual([...new Set(block.lineOf)], [1, 2, 4],
    'no character maps to the blank line, which holds none, and none maps past the run')
  assert.equal(block.lineOf[block.text.indexOf('A second paragraph')], 4,
    'lineOf maps a character to the line it stands on, so a failure can name the paragraph')
  assert.equal(block.lineOf[block.text.indexOf('\n')], 2,
    'the newline that ends line 1 is marked as the line that follows it')

  // The limit the header names, pinned: a block scalar's body line that starts with a hash is a
  // comment to this reader, because telling a value from prose needs a YAML reader.
  assert.deepEqual(commentRuns(BLOCK).map(run => [run.text, run.first]), [
    ['Config version. Do not change this', 2]
  ], 'a hash at the start of a block scalar body line reads as a comment, so a document that writes one has prose it did not write')

  // The one place the header and the walk differ, pinned rather than fixed. The header says a run's
  // lines are joined with the newline they stood on; a leading bare hash line contributes none,
  // because the walk joins on the text being empty and an empty body leaves it empty. So first names
  // line 1 while the answer starts on line 2. No manifest under deploy/ writes a run that opens this
  // way, so no caller has had to notice, and which answer the reader should give back is a decision
  // this ticket did not ask for: #1003 carries it, and a fix edits this row.
  const [bare] = commentRuns('#\n# a')
  assert.deepEqual([bare.text, bare.lineOf, bare.first, bare.last], ['a', [2], 1, 2],
    'a leading bare hash line contributes no newline, so a run of two lines reads as one (#1003)')
})

test('a document with no comment answers no runs, which a caller has to notice', () => {
  assert.deepEqual(commentRuns('kind: Role\nrules:\n  - verbs: ["get"]'), [],
    'a document that writes no comment and one whose prose moved both answer empty, so a sweep asserts it found a run')
})

// A document whose section holds a deeper one, a comment at the body's own depth, a sibling key after
// it, and a key outside it. Two spaces are one level, as the manifests write them. `metadata` is
// written twice and at two depths, as a Deployment writes it, so the indent a caller passes is what
// decides which one it reads.
const SECTIONS = [
  'metadata:',
  '  name: monoplayer',
  'spec:',
  '  replicas: 1',
  '  template:',
  '    metadata:',
  '      labels:',
  '        app: monoplayer',
  "  # a comment at the body's own depth",
  '  selector:',
  '    app: monoplayer',
  'other: value'
].join('\n')

cased('section', () => {
  assert.deepEqual(section(SECTIONS, 0, 'spec').split('\n'), [
    '  replicas: 1',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: monoplayer',
    "  # a comment at the body's own depth",
    '  selector:',
    '    app: monoplayer'
  ], 'the body runs to the next line indented no deeper than the key, and a comment at that depth is part of it')
  assert.deepEqual(section(SECTIONS, 2, 'template').split('\n'),
    ['    metadata:', '      labels:', '        app: monoplayer'],
    'a nested key reads its own body, and a line at its own depth ends it')
  assert.deepEqual(section(SECTIONS, 4, 'metadata').split('\n'),
    ['      labels:', '        app: monoplayer'],
    'the same key at two depths is two sections, and the indent a caller gives is which one it reads')
  assert.deepEqual(section(SECTIONS, 0, 'metadata').split('\n'), ['  name: monoplayer'],
    'the outer key of that pair reads its own body, and the key at its own depth ends it')
  assert.equal(section(SECTIONS, 0, 'absent'), '',
    'a key the document does not write answers empty, which a caller cannot tell from a body that moved')
  // The other half of an empty answer, and the reason a caller cannot tell the two apart: this
  // reader finds a key only when its line is exactly the key and a colon, so an inline value is a
  // line it never locates rather than a body with nothing under it. Every key the tree passes is a
  // block key, so no caller reads the difference.
  assert.equal(section('replicas: 1', 0, 'replicas'), '',
    'a key whose line holds an inline value is not found at all, so it answers the empty string an absent key answers')
})

// A Role with two rules, a comment line inside the block, a flow list, and the key that follows the
// block: every shape the manifests write, and the comment the tree writes between two rules.
const ROLE = [
  'kind: Role',
  'rules:',
  '  - apiGroups: [""]',
  '    resources: ["secrets"]',
  '    resourceNames: ["monoplayer-control"]',
  '    verbs: ["get"]',
  '  # a comment inside the block is skipped, and a comment line is never a rule',
  '  - apiGroups: [""]',
  '    resources: ["pods"]',
  '    verbs: ["get", "list"]',
  'subjects: []'
].join('\n')

// The documents rules refuses, and why each is refused rather than guessed at: a guard that skips a
// line it cannot place passes on the one manifest that matters.
const REFUSALS = [
  ['rules:\n  - verbs:\n      - get\n', 'a block-style list is not a shape this reader places', /cannot read the rule value/],
  ['rules:\n  - nonResourceURLs: ["/healthz"]\n', 'a key outside the four a rule uses is refused', /does not know the rule key nonResourceURLs/],
  ['rules:\n  - verbs: ["get"]\n    verbs: ["list"]\n', 'a key set twice in one rule is refused', /sets verbs twice/],
  ['rules:\n  - resources: ["secrets",\n      "configmaps"]\n', 'a flow list that continues on the next line is refused, not read as one value', /flow-style lists only/],
  ['rules:\n  - verbs: ["get"]  # read only\n', 'a trailing comment is not a place this reader looks, so the whole line is refused', /cannot read the rule value/]
]

cased('rules', () => {
  assert.deepEqual(rules(ROLE), [
    { apiGroups: [''], resources: ['secrets'], resourceNames: ['monoplayer-control'], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }
  ], 'each dash opens a rule, a comment line between two rules is skipped, and a flow list is split into its values')
  assert.deepEqual(rules('kind: Role'), [],
    'a document that writes no rules key answers nothing, which a caller asserts rather than assumes')
  for (const [document, why, pattern] of REFUSALS) {
    assert.throws(() => rules(document), pattern, why)
  }
})

// Last, so it reads every case above it. A sixth export fails here until it has a case, and a case
// that is deleted, commented out, or never collected is a name that never arrived.
test('every export of the reader has a case, and that case ran', () => {
  assert.deepEqual(RAN.slice().sort(), Object.keys(reader).sort(),
    'the reader exports one name per case in this file, and a case that did not run fails here')
})

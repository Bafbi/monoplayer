// The README's verdict index (#409). `testdata/` holds the record of every run
// this repo kept, and one paragraph of README.md is the tour of them. A page the
// index leaves out is a page no reader is sent to, and a prose list fails no build.
//
// The guard reads the pages off disk and the links out of the index, and reports
// a disagreement in both directions: a page the index leaves out, and a link the
// directory does not hold. It reads names, never a number on a page: a record's
// numbers are its own, and `testdata-record.test.js` keeps them so.
//
// The index is the run of lines after the opening sentence that carry links and
// nothing else. README also cites pages above the index and says what a record is
// below it, so a link anywhere in the file would let a page fall out of the tour
// unnoticed. A page named in a sentence below the list does not count either,
// which is why the run ends at the first line of prose.
//
// Nothing here opens a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TESTDATA = path.join(ROOT, 'testdata')
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

// The sentence that opens the index.
const OPENING = 'Each verdict is one page in `testdata/`:'

// A page is a verdict page because it is markdown under testdata/: the wire cases
// beside them are a fixture a test reads, not a record of a run. A record filed in
// a subdirectory is in the index too, so the walk goes down.
const PAGES = fs.readdirSync(TESTDATA, { recursive: true })
  .filter(name => name.endsWith('.md'))
  .sort()

const pageOf = target => target.slice('testdata/'.length)

// The pages one line links, by name. An "#anchor" addresses a place inside a page
// rather than another page, so it is dropped before the comparison. A target
// outside testdata/ is a runbook beside the records, not one of them.
function targets (line) {
  return [...line.matchAll(/\]\(([^)\s]+)\)/g)]
    .map(match => match[1].split('#')[0].replace(/^\.\//, ''))
    .filter(target => target.startsWith('testdata/'))
    .map(pageOf)
}

// A line of the tour carries links and the punctuation that joins them, nothing
// else. A sentence that carries a link is prose, and it ends the tour.
const LINKS_ONLY = /^[\s,.]*(?:and[\s,.]*)?$/
const tourLine = line => LINKS_ONLY.test(line.replace(/\[[^\]]*\]\([^)]*\)/g, ''))

// The index: the tour lines that follow the opening sentence, in order. Null when
// the sentence is gone, so a missing index is one failure rather than every page
// unlinked.
function index (text) {
  const at = text.indexOf(OPENING)
  if (at === -1) return null
  const linked = []
  for (const line of text.slice(at + OPENING.length).split('\n')) {
    const pages = targets(line)
    if (pages.length === 0 || !tourLine(line)) break
    linked.push(...pages)
  }
  return linked
}

const missingFrom = (names, other) => names.filter(name => !other.includes(name))

// Both sides of the comparison from one read, so a case states its claim without
// repeating the walk.
function drift ({ pages, text }) {
  const linked = index(text) ?? []
  return {
    pages,
    linked,
    missing: missingFrom(pages, linked),
    extra: missingFrom(linked, pages)
  }
}

// Both directions in one message: a page added to testdata/ drifts once, a page
// renamed drifts twice, and only a report of both tells a reader what to fix on
// each side.
function disagreement ({ missing, extra }) {
  return [
    missing.length === 0
      ? null
      : 'README.md leaves ' + missing.join(', ') + ' out of the verdict index: ' +
        'add a link to ' + missing.map(page => 'testdata/' + page).join(', ') +
        ' to the index after "' + OPENING + '"',
    extra.length === 0
      ? null
      : 'README.md links ' + extra.join(', ') + ' under testdata/, and no such page is there: ' +
        'point the link at a page, or drop it'
  ].filter(Boolean)
}

test('testdata/ still holds the pages, and README still holds the index', () => {
  // A directory that moved would leave every case below comparing two empty
  // lists and passing. The names are not pinned: a list of them here would have
  // to be edited to add a page, which is the drift the scan avoids.
  assert.ok(PAGES.length > 0, 'testdata/ holds no verdict page: the guard reads ' + PAGES.length + ' pages')
  assert.notEqual(index(README), null,
    'README.md no longer opens a verdict index with "' + OPENING + '". The guard reads the ' +
    'lines of links after that sentence: restore it, or move the guard with the index')
  assert.ok(index(README).length > 0,
    'the index after "' + OPENING + '" links no page under testdata/. The guard reads a list ' +
    'of links, one line at a time, and stops at the first line of prose: restore that shape, ' +
    'or move the guard with the index')
})

test('the index names every page under testdata/, and no page it does not hold', () => {
  assert.deepEqual(disagreement(drift({ pages: PAGES, text: README })), [],
    'the README index and testdata/ disagree')
})

test('the comparison reports a page on one side only', () => {
  // Fixtures, not the tree: this case tests the comparison, so a real drift
  // cannot make the case about the drift instead.
  const pages = ['a-verdict.md', 'b-verdict.md']
  const text = [
    '# a page',
    '',
    'The first run is [the a verdict](testdata/a-verdict.md).',
    '',
    OPENING + ' [the a verdict](testdata/a-verdict.md),',
    '[the b verdict](testdata/b-verdict.md#the-verdict), and',
    '[docs/testing-ladder.md](docs/testing-ladder.md).',
    '',
    'Created in T3 Code.',
    ''
  ].join('\n')

  assert.deepEqual(drift({ pages, text }), {
    pages,
    linked: ['a-verdict.md', 'b-verdict.md'],
    missing: [],
    extra: []
  }, 'the guard reads the index, and drops an anchor from its links')

  const renamed = text.replace('[the b verdict](testdata/b-verdict.md#the-verdict), and',
    '[the x verdict](testdata/x-verdict.md), and')
  assert.deepEqual(drift({ pages, text: renamed }).extra, ['x-verdict.md'],
    'a link the directory does not hold is reported')

  const dropped = text.replace('[the b verdict](testdata/b-verdict.md#the-verdict), and', 'and')
  assert.deepEqual(drift({ pages, text: dropped }).missing, ['b-verdict.md'],
    'a page the index leaves out is reported, even while README links it above the index')
  assert.deepEqual(disagreement(drift({ pages, text: dropped })), [
    'README.md leaves b-verdict.md out of the verdict index: add a link to testdata/b-verdict.md ' +
      'to the index after "' + OPENING + '"'
  ], 'the failure names the page and the edit')

  const stray = text.replace(OPENING, 'A link outside the index: [the c verdict](testdata/c-verdict.md).\n\n' + OPENING)
  assert.deepEqual(drift({ pages, text: stray }).extra, [], 'a link before the opening sentence is not in the index')

  const below = text.replace('[docs/testing-ladder.md](docs/testing-ladder.md).',
    'A later sentence links [the c verdict](testdata/c-verdict.md).')
  assert.deepEqual(drift({ pages: [...pages, 'c-verdict.md'], text: below }).missing, ['c-verdict.md'],
    'a page named in a sentence below the list is not in the index')
})

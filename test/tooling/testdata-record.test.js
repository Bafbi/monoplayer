// A verdict page is a record, and it says so (#404). testdata/ holds the dated
// pages: evidence of the run that took them, with numbers that were true of that
// run. Nothing on a page stopped a reader treating one as current documentation,
// and the first edit a well-meaning reader makes is to "correct" a number to
// today's. So each page opens with a header naming it a record, and this file
// fails when a page loses that header.
//
// It reads the header, and nothing below it. A record's numbers are its own: a
// guard that compared them to a report, or to the clock, would send a reader to
// update history, which is the defect the header exists to prevent.
//
// Nothing here opens a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TESTDATA = path.join(ROOT, 'testdata')

// Every page under testdata/, in a subdirectory too, so a record filed one level
// down is covered rather than skipped. A page is markdown: the wire cases beside
// them are a fixture a test reads, not a record of a run.
const PAGES = fs.readdirSync(TESTDATA, { recursive: true })
  .filter(name => name.endsWith('.md'))
  .sort()

// The header: the blockquote the page opens with, taken as the run of quote lines
// that starts at the first line of prose. A page that buries its header under a
// summary has no header here, which is what "opens with" means.
function header (text) {
  const lines = text.split('\n')
  const title = lines.findIndex(line => /^#\s/.test(line))
  const banner = []
  for (const line of lines.slice(title + 1)) {
    if (line.trim() === '') continue
    if (!line.trimStart().startsWith('>')) break
    banner.push(line)
  }
  return banner.join('\n')
}

// The header as one line, so a claim may wrap. A sentence that says the page is a
// record reads the same wrapped or not.
const oneLine = text => header(text).replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ').trim()

// The three things the header says. The date is the page's own: the guard checks
// that one is written, never which one.
const RECORD = /Record, not documentation/
const TAKEN = /Taken \d{4}-\d{2}-\d{2}/
const BY = /Taken .+ by \S*[A-Za-z]/

const PREFIX = '> **Record, not documentation.** Taken 2026-11-07 by `mise run online`.'

// One page and its header, so a case states its claim without repeating the read.
const heads = () => PAGES.map(page => ({
  page,
  head: oneLine(fs.readFileSync(path.join(TESTDATA, page), 'utf8'))
}))

test('testdata/ still holds the pages this guard reads', () => {
  // A directory that moved would leave every case below reading an empty list and
  // passing. A page deleted, or renamed out of markdown, is not this case's claim:
  // a list of names here would have to be edited to add a page, which is the drift
  // the scan avoids.
  assert.ok(PAGES.length > 0, 'testdata/ holds no page: the guard reads ' + PAGES.length + ' pages')
})

test('every page under testdata/ names itself a record', () => {
  for (const { page, head } of heads()) {
    assert.match(head, RECORD,
      'testdata/' + page + ' does not say it is a record. Open the page with a header like:\n' + PREFIX)
  }
})

test('every record says when it was taken', () => {
  for (const { page, head } of heads()) {
    assert.match(head, TAKEN,
      'testdata/' + page + ' names no date for the run it records. Write the date the run was taken, ' +
      'as YYYY-MM-DD, in the header:\n' + PREFIX)
  }
})

test('every record says what took it', () => {
  for (const { page, head } of heads()) {
    assert.match(head, BY,
      'testdata/' + page + ' names no command, rung, or witness that took the run. Say what took it ' +
      'in the header:\n' + PREFIX)
  }
})

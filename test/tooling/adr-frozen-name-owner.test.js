// The ADR's table says which tree owns each external name (#361, #374). Both stale
// rows were one defect: a row naming a tree that does not hold the name.
//
// docs/adr/external-names-migrate-with-their-owner.md calls its table "the one place
// to look before touching a driver-lane area". A reader who follows a wrong row edits
// a tree that never spells the name, and the object behind it stays as it was.
//
// A name is frozen because a tree still spells it. deploy/testbed/ spells
// monoplayer-gate-b. deploy/driver/ renders monoplayer-gate-__instance__, the same
// name derived from a lane, which is not frozen. A row that calls a derived name
// frozen sends its reader to a tree without the string, and the next rename puts the
// row back (#374 did).
//
// An owner must hold the name as well as exist. src/driver/backends.js was named for a
// hostname it had stopped holding (#282). The file is still there, so a reader who
// follows the row finds a file and no name.
//
// Some names live only in the cluster, and no manifest spells them. RECORDED lists
// those, with the reason. It is checked before the derivation rule, because a
// hand-made name in one namespace can share its spelling with a name another tree
// derives: monoplayer-gate-b's Secrets are fixed, and every lane generates its own.
//
// Some owners are not in the repository: a display host, an operator's shell, a launch
// command, a Hyprland rule. BY_HAND lists those rows, with the reason no commit can
// carry the rename. Such a row still fails when the tree derives its name, because
// that half this file can decide.
//
// Nothing here opens a socket: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ADR = 'docs/adr/external-names-migrate-with-their-owner.md'
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// The table under its own heading, one entry per row: the frozen names, who reads
// them, and what must move with them. The heading and the rule under it are not rows.
function rows () {
  const text = read(ADR)
  const at = text.indexOf('| Frozen name |')
  assert.notEqual(at, -1, ADR + ' has no table headed "Frozen name", and this file reads that heading: ' +
    'restore it, or move the table and this file together')
  const found = []
  for (const line of text.slice(at).split('\n')) {
    if (!line.startsWith('|')) break
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.some(cell => /^-+$/.test(cell))) continue
    assert.equal(cells.length, 3, ADR + ' has a row that is not three cells: "' + line.trim() +
      '". A row is the frozen name, who reads it, and what must move with it')
    found.push({ names: cells[0], readers: cells[1], owners: cells[2] })
  }
  return found.slice(1)
}

// Every literal a cell writes in backticks. Prose outside them is the sentence around
// the claim, and no test reads a sentence.
const spans = cell => [...cell.matchAll(/`([^`]+)`/g)].map(([, span]) => span)

// A path is a span this tree's paths look like: a slash or a source extension, and no
// space and no colon, which a qualified name carries. A name, a flag and a JVM
// property are not paths.
const PATH = /\.(?:js|mjs|yaml|yml|md|sh|toml|json)$/
const isPath = span => !span.includes(' ') && !span.includes(':') && (span.includes('/') || PATH.test(span))

// A name written with a star is a prefix: no file holds the star, so the test asks for
// the part before it.
const stem = span => span.split('*')[0]

// The frozen names each row keeps with no tree behind them, by the row's first name,
// with the reason. Nothing in the tree creates either Secret, and nothing spells the
// second one.
const RECORDED = {
  'gate-b-velocity': 'a hand-made Secret in monoplayer-gate-b. Nothing under deploy/testbed/ reads the ' +
    'forwarding secret: the two Papers there read gate-b-rcon only, so a rename recreates it by hand ' +
    '(#283, #288)'
}

// The rows whose owner is host state: named by their first frozen name, with the
// reason no commit can carry the rename.
const BY_HAND = {
  'gate-b-player': 'a Prism instance on the display host, kept as the G0 record. Cloning it into a new ' +
    'id is the migration, and no commit reaches that host',
  'gate-b-player-262': 'the 26.2 Prism pair on the same display host. The clone happens in the same ' +
    'display-host step as the launch command that names it',
  GATEB_: 'the operator\'s shell. A variable is renamed where it is exported, and no file here exports one',
  'gateb.driver.port': 'a JVM property and a window title the launch command passes. The operator\'s ' +
    'launch flags are the only place they are set',
  'Monoplayer Gate B': 'the Hyprland rule on the display host, which no commit moves',
  'gate: "B"': 'a field the driver-lane runner writes. #7 prunes the old verdicts before it changes'
}

// What can hold a name: a manifest, a script, a tool, a source file. A page describes
// the name, and its prose is not what a rename has to reach, so a row whose only owner
// is a page is one BY_HAND has to explain.
const SPELLS = /\.(?:js|mjs|sh|yaml|yml|toml|json)$/

// A file's text, or null for a binary: a font names no file, and decoding one is a
// guess this guard has no reason to make.
function textOf (at) {
  if (!SPELLS.test(at)) return null
  const bytes = fs.readFileSync(at)
  return bytes.includes(0) ? null : bytes.toString('utf8')
}

function owned (cell) {
  const trees = []
  for (const span of spans(cell).filter(isPath)) {
    const at = path.join(ROOT, span)
    if (!fs.existsSync(at)) continue
    if (!fs.statSync(at).isDirectory()) {
      const text = textOf(at)
      if (text !== null) trees.push({ name: span, text })
      continue
    }
    // One tree, not one claim per manifest: a directory holds the name in one of its
    // files, and which one is the directory's business.
    const files = fs.readdirSync(at, { recursive: true })
      .map(name => path.join(at, name))
      .filter(full => fs.statSync(full).isFile())
      .map(textOf)
      .filter(text => text !== null)
    trees.push({ name: span, text: files.join('\n') })
  }
  return trees
}

// Where the tree renders a lane's names: a manifest, a script, a tool, a source file.
// Not docs, which describe, and not tests, whose fixtures spell placeholders.
const SURFACES = ['deploy', 'scripts', 'src', 'tools']
let live = null
function liveTree () {
  if (live !== null) return live
  live = []
  for (const surface of SURFACES) {
    for (const name of fs.readdirSync(path.join(ROOT, surface), { recursive: true })) {
      const at = path.join(ROOT, surface, name)
      if (!fs.statSync(at).isFile()) continue
      const text = textOf(at)
      if (text !== null) live.push({ name: path.posix.join(surface, name.split(path.sep).join('/')), text })
    }
  }
  return live
}

// The placeholder a lane's tree writes, owned by scripts/gate-lane.sh: it substitutes
// the instance for this string. No module exports it, so the guard carries a copy.
const PLACEHOLDER = 'gate-__instance__'
const derived = name => name.replace(/gate-[a-z0-9]+/, PLACEHOLDER)
const first = row => stem(spans(row.names).filter(span => !isPath(span))[0] ?? '')

test('every path the table names exists', () => {
  const missing = []
  for (const row of rows()) {
    for (const span of [...spans(row.names), ...spans(row.readers), ...spans(row.owners)].filter(isPath)) {
      if (!fs.existsSync(path.join(ROOT, span))) missing.push(span)
    }
  }
  assert.deepEqual([...new Set(missing)], [], ADR + ' names paths that are not in the tree: ' +
    missing.join(', ') + '. The table sends a reader there: name the path that exists, or move the ' +
    'table to where the work landed')
})

test('a name a row calls frozen is spelled by the tree it names', () => {
  const stale = []
  for (const row of rows()) {
    const held = owned(row.owners)
    for (const name of spans(row.names).filter(span => !isPath(span)).map(stem)) {
      if (held.some(file => file.text.includes(name))) continue
      // A name in the cluster needs no file. It is checked first because a lane
      // derives the same spelling in another namespace.
      if (name in RECORDED) continue
      // A name with no lane segment has no derived form.
      const renders = derived(name) === name
        ? undefined
        : liveTree().find(file => file.text.includes(derived(name)))
      if (renders !== undefined) {
        stale.push(name + ' is not frozen: ' + renders.name + ' renders ' + derived(name) +
          '. Name the tree that still spells this one fixed, or drop the row: what a lane derives moves ' +
          'with that tree, in the same edit as any other lane name')
      } else if (held.length > 0) {
        stale.push(name + ' migrates with ' + row.owners.trim() + ', and no file there spells it. Name ' +
          'the tree that holds the name, split the row if its names have different owners, or add it to ' +
          'RECORDED in this file with the reason it has none')
      }
    }
  }
  assert.deepEqual(stale, [], ADR + ' has rows that send a reader to a tree without the name:\n- ' +
    stale.join('\n- '))
})

// The other half of the same claim: a tree the row names is a tree a rename has to
// reach, so it spells at least one of the row's names.
test('every tree a row names spells one of the row\'s names', () => {
  const silent = []
  for (const row of rows()) {
    const names = spans(row.names).filter(span => !isPath(span)).map(stem)
    for (const file of owned(row.owners)) {
      if (!names.some(name => file.text.includes(name))) silent.push(file.name + ' for ' + row.names.trim())
    }
  }
  assert.deepEqual(silent, [], ADR + ' names trees that spell none of their row\'s names:\n- ' +
    silent.join('\n- ') + '\nA tree a rename must reach holds the name. Drop it from the row, or name ' +
    'the name it holds')
})

// A row whose owner is host state cannot be checked, so it is written down instead. A
// new row of that kind fails until it says why no commit can carry the rename.
test('a row whose owner is not a file is in BY_HAND, and every entry still has one', () => {
  // A row with no backticked name is the guard-on-guard case's to report, and it
  // would reach this one as a blank name.
  const unrecorded = rows()
    .filter(row => owned(row.owners).length === 0)
    .map(first)
    .filter(name => name !== '' && !(name in BY_HAND))
  assert.deepEqual(unrecorded, [], ADR + ' has rows whose owner is not in the tree and that BY_HAND does ' +
    'not explain: ' + unrecorded.join(', ') + '. Name a tree in the row, or add the row to BY_HAND in ' +
    'this file with the reason no commit can carry the rename')

  const orphaned = Object.keys(BY_HAND).filter(name => !rows().some(row =>
    owned(row.owners).length === 0 && first(row) === name))
  assert.deepEqual(orphaned, [], 'BY_HAND explains ' + orphaned.join(', ') + ', and no row with a ' +
    'prose owner names it. Drop the entry, or say which row kept it')
})

test('every name RECORDED keeps is one row\'s name, and that row is still there', () => {
  const orphans = []
  for (const name of Object.keys(RECORDED)) {
    const held = rows().filter(row => spans(row.names).some(span => stem(span) === name))
    if (held.length === 0) orphans.push(name + ', which no row calls frozen')
    else if (held.length > 1) orphans.push(name + ', which ' + held.length + ' rows name: a Secret in ' +
      'one namespace is one row\'s, so a second row calling it frozen is a row to split')
  }
  assert.deepEqual(orphans, [], 'RECORDED explains ' + orphans.join('; ') + '. Drop the entry, or say ' +
    'which row kept it')
})

// A table this file failed to read passes every case above without looking, so the
// guard proves it found the table, a row with an owner path, and a name the tree
// derives. That last one is the derivation rule's own proof: it is measured against
// files, not an empty list.
test('the guard reads the table, an owner path, and a name the tree derives', () => {
  const parsed = rows()
  assert.ok(parsed.length > 0, ADR + ' parsed no rows under its "Frozen name" heading, and every case in ' +
    'this file would pass without checking anything. Restore the table, or the three-cell rows it has')
  for (const row of parsed) {
    assert.ok(row.names !== '' && row.readers !== '' && row.owners !== '',
      ADR + ' has a row with an empty cell: "' + [row.names, row.readers, row.owners].join(' | ') + '"')
    // A name outside backticks is prose, and every case here reads code spans.
    assert.ok(spans(row.names).filter(span => !isPath(span)).length > 0,
      ADR + ' has a row whose "Frozen name" cell spells no name in backticks: "' + row.names +
      '". This file reads the code spans, so a name written as prose is a name nothing checks')
  }
  assert.ok(parsed.some(row => owned(row.owners).length > 0),
    'no row names a path in its "Migrates with" cell, so no name is checked against a tree. Name the ' +
    'tree that holds each name, or explain in BY_HAND why none does')
  const names = parsed.flatMap(row => spans(row.names).filter(span => !isPath(span)).map(stem))
  assert.ok(names.some(name => derived(name) !== name && liveTree().some(file => file.text.includes(derived(name)))),
    'no file under ' + SURFACES.join(', ') + ' renders ' + PLACEHOLDER + ' beside a name this table calls ' +
    'frozen, so the derivation rule reads nothing. scripts/gate-lane.sh owns that placeholder: check ' +
    'whether it changed shape, then this rule')
})

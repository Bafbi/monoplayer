// #340, #371: two cells of docs/product-core.md, each pinned to the module that owns
// the fact the cell states.
//
// The page is a map of where a decision lives. A cell that names half a list sends a
// reader who needs the other half somewhere else, and nothing failed when it did.
//
//   #340  the module map's row for `src/service/cli.js` lists the helpers that module
//         exports. The row named four of five, and `waitFor` was the one left out:
//         #104 folded it into this module and touched no page. The row's authority is
//         the module, so the guard imports it rather than keeping a list here.
//         `waitFor` is the deadline a rung waits with, and the map did not name it.
//
//   #371  the picker bullet answers why a lane offers no servers. #356 gave that list
//         two sources, `config.control.allowedServers` and the seed behind it. The
//         bullet kept the one-variable reading, and its repair for `no_key` named half
//         of the edit. The switches are read here by calling `envOverlay`, the function
//         that owns the config surface, so a rename fails on the page. A comment that
//         names a switch is not a read: the header of src/service/start-live.js is
//         itself a list of the switches.
//
// What is compared is names. No sentence is parsed, because a guard that read English
// would be a guard that lies about what it checked. Two things are left to review, and
// no test decides them: what "the copy Git commits answers" covers, and that a lane
// naming neither variable offers nothing. What the offer does with the two sources is
// driven through src/service/control.js by test/service/control.test.js, including
// "#356 the seed answers when the live key offers no list".
//
// Nothing here opens a socket or reaches a cluster: every case reads a file and calls
// one pure function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../../src/service/monoplayer.js'
import { envOverlay } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGE = read('docs/product-core.md')

const MODULE = 'src/service/cli.js'

// The two config keys that hold the one list the picker offers. A key's name is the
// page's name for it, so the guard resolves the switch from the key rather than keeping
// a switch name of its own.
const SERVER_KEYS = ['control.allowedServers', 'control.allowedServersSeed']

// A bullet is one claim, so a true sentence on the next line cannot cover for a stale
// one above it. The split is the one test/tooling/doc-status.test.js makes, and the
// blank-line paragraphs that belong to a bullet stay with it.
const bullets = text => text.split(/(?=^- )/m).filter(block => block.startsWith('- '))

// The names one cell of the module map carries in backticks. Every name in the role
// column wears them, so the column is its own list and needs no prose parsing.
const cellNames = cell => [...cell.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map(match => match[1])

// One row of the module map, as its cells. The module column names the module, so a
// row found this way is the row about that module and no other.
function row (module) {
  const line = PAGE.split('\n').find(text => text.startsWith('| `' + module + '` |'))
  assert.ok(line, 'docs/product-core.md has a module-map row for ' + module + ', which is where a reader looks for what it holds')
  return line.split('|').map(cell => cell.trim())
}

// The document a switch is probed against: the compiled default, so every control key
// the service holds resolves to a leaf and a probed value lands on that leaf's path.
const DOC = loadConfig({})

// Which switch sets each control key, from the function rather than from its text. The
// probe's environment is a proxy that records what it is asked for, so a switch the
// overlay stops reading stops answering here. What a switch sets is then the control key
// whose value the probe moved.
//
// Two guards already read this overlay: test/tooling/usage-env-vars.test.js with the same
// proxy, and test/tooling/glossary-control-document.test.js mapping switch to key with a
// deep diff of the whole document. This one compares the control branch alone, because
// one list is the whole of the page's claim.
function controlSwitch () {
  const reads = new Set()
  const env = new Proxy({}, {
    get (target, key) {
      if (typeof key === 'string') reads.add(key)
      return undefined
    }
  })
  envOverlay(DOC, env, () => {})
  const found = new Map()
  for (const name of reads) {
    const probed = envOverlay(DOC, { [name]: '1' }, () => {}).control ?? {}
    for (const [key, value] of Object.entries(probed)) {
      if (value !== DOC.control[key]) found.set('control.' + key, name)
    }
  }
  return found
}

// Each key the page names, paired with the switch behind it, so no case joins two lists by
// position.
const SWITCH = controlSwitch()
const SERVER_LIST = SERVER_KEYS.map(key => ({ key, name: SWITCH.get(key) }))

// The picker's own bullet: the one claim that names the `no_key` reason, which is the
// answer that says nothing names a list at all. Its paragraphs are part of the bullet,
// so the offer's reasons and the list's sources are read together, as one claim.
function pickerBullet () {
  const found = bullets(PAGE).filter(block => block.includes('`no_key`'))
  assert.equal(found.length, 1,
    'docs/product-core.md has one claim that answers `no_key`, which is the claim that says what an empty list is')
  return found[0]
}

test('the module-map row for src/service/cli.js names every helper that module exports', async () => {
  const names = Object.keys(await import('../../' + MODULE))
  assert.ok(names.length > 0, MODULE + ' exports its helpers, and that list is what the row carries')
  const listed = cellNames(row(MODULE)[2])
  const missing = names.filter(name => !listed.includes(name))
  const unknown = listed.filter(name => !names.includes(name))
  assert.deepEqual(missing, [],
    MODULE + ' exports ' + missing.join(', ') + ' and the module-map row does not name ' +
    (missing.length === 1 ? 'it' : 'them') + '. The row is the map a reader uses to find a helper, and a ' +
    'helper missing from it sends that reader to another file. Add ' + (missing.length === 1 ? 'it' : 'them') +
    ' beside its neighbours.')
  assert.deepEqual(unknown, [],
    'the module-map row names ' + unknown.join(', ') + ', which ' + MODULE + ' does not export. A name ' +
    'the module does not hold is a helper a reader looks for and cannot find there.')
})

test('the picker bullet is the whole list of what an operator can name', () => {
  for (const { key, name } of SERVER_LIST) {
    assert.ok(typeof name === 'string' && /^MONOPLAYER_[A-Z0-9_]+$/.test(name),
      'envOverlay in src/service/start-live.js sets config.' + key + ' from one switch, and this case read ' +
      'none. A key no switch sets leaves the claim below with nothing to compare.')
  }
  const bullet = pickerBullet()
  for (const { name } of SERVER_LIST) {
    assert.ok(bullet.includes(name),
      'the picker bullet never names ' + name + '. Since #356 the list has two sources, and only a lane that ' +
      'names neither offers nothing, so the repair the bullet gives for `no_key` has to name both switches. ' +
      'The order they are asked in is `allowedServerSources` in src/service/control.js.')
  }
})

test('the picker bullet does not say a lane with no allowed-server key offers nothing', () => {
  // The sentence #356 removed. `src/core/picker.js` `pickerOfferedRows` reads one answer
  // from `control.allowedServers()`, and that answer is the seed's whenever the live key
  // offers no list, including a live key that was never named.
  const bullet = pickerBullet()
  assert.doesNotMatch(bullet, /with no such key offers nothing/i,
    'the picker bullet still says a lane with no such key offers nothing. #356 rebuilt the precedence in ' +
    '`allowedServerSources` in src/service/control.js: the live file answers, else the copy Git commits, else ' +
    'nothing. Only a lane that names neither switch offers nothing.')
})

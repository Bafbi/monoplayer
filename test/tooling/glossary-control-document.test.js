// #344: the glossary's control-document entry is pinned to the module that
// implements it.
//
// The Control document entry defines one file per key. Each key has its own path
// field, its own environment switch, and its own reader. One key has a fallback.
// src/service/control.js says the same in the header it opens with. Nothing
// compared the two, and the entry had already drifted: #308 replaced a version that
// described two files and named no switch at all.
//
// Four facts have a home in code, and this guard reads all four:
//
//   which keys exist          the createControlDocument call in src/service/start-live.js,
//                             each key one DEFAULT_CONFIG in monoplayer.js holds
//   each key's switch         envOverlay in src/service/start-live.js, probed
//   each key's file           the header of src/service/control.js
//   which key has a fallback  allowedServerSources in src/service/control.js
//
// What is compared is names. One word is read out of a sentence, and it is the term
// this glossary uses for the fourth fact: fallback. No other part of a sentence is
// parsed, because a guard that read English would be a guard that lies about what
// it checked. The entry's behaviour, "each read goes back to the file" and "nothing
// watches either file", is driven through the module by test/service/control.test.js.
//
// #402's guard, test/tooling/env-var-pages.test.js, fails when a page names a
// switch no file reads. This one runs the other direction and the pairing: a key
// that appears without its switch, or with another key's file, fails here.
//
// Nothing here opens a socket or reaches a cluster: every case reads a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { envOverlay } from '../../src/service/start-live.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const GLOSSARY = read('GLOSSARY.md')
const CONTROL = read('src/service/control.js')
const LIVE = read('src/service/start-live.js')

// A source file as a reader meets it: the block of comment lines it opens with, and
// nothing after the first line that is not one. A table added to a module's body
// cannot answer a claim about its header. The reader stays local because no other
// test reads a source file's comments.
function header (text) {
  const lines = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (!line.startsWith('//')) break
    lines.push(line)
  }
  return lines.join('\n')
}

// The header's rows are "key  file.json", the only place in the tree that pairs a
// control key with the basename an operator edits.
const HEADER_ROW = /^\/\/\s+([A-Za-z][A-Za-z0-9]*)\s+([A-Za-z0-9._-]+\.json)\b/

function headerRows (text) {
  return header(text).split('\n')
    .map(line => line.match(HEADER_ROW))
    .filter(Boolean)
    .map(([, key, file]) => ({ key, file }))
}

// The config key each module option is passed as, from the one call that composes
// the document. That call is the control document's definition in this service.
// The header spells its first row by the config field and its second by the option
// name. Both are real names for the same key, so a row is matched through this
// bridge instead of guessing which column a name came from.
//
// The block is found by its braces, so a nested object inside the call stays inside
// it and no key falls out of the comparison.
function wire (text) {
  const start = text.indexOf('createControlDocument({')
  assert.notEqual(start, -1, 'src/service/start-live.js composes the control document')
  const open = text.indexOf('{', start)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    if (text[index] !== '}') continue
    depth -= 1
    if (depth > 0) continue
    return [...text.slice(open, index + 1)
      .matchAll(/^\s*([A-Za-z]+):\s*cfg\.([A-Za-z.]+)/gm)]
      .map(([, option, key]) => ({ option, key }))
  }
  assert.fail('the createControlDocument call in src/service/start-live.js has no closing brace')
}

// allowedServerSources is the order the module reads its two files in, and the row
// named seed is the fallback. A key with a second source is the key whose absence
// the seed answers. The header calls that "the one key [that] has a fallback".
function fallbackOption (text) {
  const rows = [...text.matchAll(/\{\s*source:\s*'([a-z]+)',\s*file:\s*([A-Za-z]+)/g)]
  const seed = rows.filter(([, source]) => source === 'seed')
  assert.equal(seed.length, 1,
    'allowedServerSources in src/service/control.js names one seed row, so the guard knows which key falls back')
  return seed[0][2]
}

// The leaf paths where two documents differ. One call per switch, diffed against the
// same document with no switch set, is what turns "envOverlay reads this name" into
// "this name sets this key".
function changed (was, is, at = '', found = []) {
  const container = value => value !== null && typeof value === 'object'
  if (!container(was) || !container(is)) {
    if (JSON.stringify(was) !== JSON.stringify(is)) found.push(at)
    return found
  }
  for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
    changed(was[key], is[key], at === '' ? key : at + '.' + key, found)
  }
  return found
}

// Which key each switch sets, from the function rather than from its text. The
// file's own comments name these switches, so a sweep over the source would need
// the comment filter env-var-pages.test.js carries. A probe needs neither, and it
// survives a rewrite of the overlay that keeps the behaviour.
function switchOfKey () {
  const doc = loadConfig({})
  const readNames = new Set()
  const recorder = new Proxy({}, {
    get: (_, name) => {
      if (typeof name === 'string') readNames.add(name)
      return undefined
    }
  })
  const base = envOverlay(doc, recorder, () => {})
  const found = new Map()
  for (const name of readNames) {
    const probed = envOverlay(doc, { [name]: '1' }, () => {})
    for (const key of changed(base, probed)) found.set(key, name)
  }
  return found
}

// The entry: one heading, one line of definition, one _Avoid_ list. It ends at the
// _Avoid_ line, so another entry's prose cannot satisfy a claim about this one.
function entry (glossary) {
  const lines = glossary.split('\n')
  const heading = lines.findIndex(line => line.startsWith('**Control document**'))
  assert.notEqual(heading, -1, 'GLOSSARY.md defines Control document')
  assert.ok(lines[heading + 2]?.startsWith('_Avoid_:'),
    'the Control document entry is a heading, one line, and its _Avoid_ list')
  return { line: heading + 2, body: lines[heading + 1] }
}

// Every backticked name in a line. A name wears backticks in this glossary, which is
// its style for a key, a switch, or a file. So a backticked word this guard cannot
// place is a name it cannot vouch for.
const names = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

const CONFIG = /^config\.[A-Za-z.]+$/
const SWITCH = /^MONOPLAYER_[A-Z0-9_]+$/
const FILE = /^[a-z0-9-]+\.json$/

// A config path, or a file name, wherever it appears: the prefix or the suffix is
// what makes it a name, so it is read with or without the backticks around it.
const PATH = /config\.[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*/g
const JSON_FILE = /[A-Za-z0-9._-]+\.json/g

// A config path resolved in a config document, so "the key exists" is a lookup
// rather than a list this file keeps.
const field = (doc, key) => key.split('.').reduce((value, step) => value?.[step], doc)

// The facts, read once and only when a case asks for them. A header that no longer
// parses must fail the case that reads it, with the message the helper wrote, not
// the module load.
let FACTS = null

function facts () {
  if (FACTS !== null) return FACTS
  const wired = wire(LIVE)
  const keys = wired.map(({ key }) => key)
  const rows = headerRows(CONTROL)
  const file = new Map(rows.map(row => {
    const matches = wired.filter(({ option, key }) =>
      row.key === option || row.key === key || row.key === key.split('.').pop())
    assert.equal(matches.length, 1,
      'the header row "' + row.key + '" names one key src/service/start-live.js wires')
    return [matches[0].key, row.file]
  }))
  FACTS = {
    wired,
    keys,
    switch: switchOfKey(),
    file,
    files: rows.map(row => row.file),
    fallback: wired.filter(({ option }) => option === fallbackOption(CONTROL))[0]?.key
  }
  return FACTS
}

const message = {
  foreign: (where, name) => where + ' names `' + name + '`, which is not a config key, a ' +
    'MONOPLAYER_* switch, or a file. A key is written `config.<path>` in this entry. A retired ' +
    'key reads exactly like a bare name, so a name the code does not hold is refused here rather ' +
    'than listed by hand.',
  missingKey: (where, key) => where + ' names no key for config.' + key + '. It is a control key: ' +
    'DEFAULT_CONFIG in src/service/monoplayer.js holds it, and src/service/start-live.js passes it ' +
    'to createControlDocument. A key the vocabulary never names is a file an operator cannot find.',
  unknownKey: (where, key) => where + ' names config.' + key + ', which is not a control key. The ' +
    'service composes ' + facts().keys.map(k => 'config.' + k).join(', ') + '. A key the service ' +
    'does not wire names a file no lane reads.',
  retiredPath: (where, name) => where + ' names ' + name + ', which is no key of the config ' +
    'document. DEFAULT_CONFIG in src/service/monoplayer.js holds ' + facts().keys.map(k => 'config.' + k)
      .join(', ') + '. A path that retired keeps a reader looking for a file nothing writes.',
  unwritten: (where, name) => where + ' names ' + name + ', and no file under src/, tools/, scripts/, ' +
    'or deploy/ names that file. A file name the code does not hold is a file nobody writes.',
  missingSwitch: (where, key, name) => where + ' names config.' + key + ' but not ' + name + ' beside ' +
    'it. envOverlay in src/service/start-live.js sets that key from that switch, and a key ' +
    'documented without its switch is a switch nobody sets.',
  unknownSwitch: (where, name) => where + ' names ' + name + ', which sets no control key. ' +
    'envOverlay in src/service/start-live.js sets only ' +
    [...new Set(facts().keys.map(key => facts().switch.get(key)))].join(', ') + ' into those keys.',
  missingFile: (where, key, file) => where + ' names config.' + key + ' but not ' + file + ' beside ' +
    'it. The header of src/service/control.js pairs that key with that file.',
  unknownFile: (where, file) => where + ' names ' + file + ', which the header of ' +
    'src/service/control.js does not name. The pairs it does name are ' + facts().files.join(', ') + '.',
  fileWithNoRow: (where, key, file) => where + ' names ' + file + ' beside config.' + key + ', and ' +
    'the header of src/service/control.js pairs no file with that key. A key that reads no file of ' +
    'its own is what the fallback is for.',
  wrongFile: (where, key, file, beside) => where + ' names ' + beside.join(', ') + ' beside config.' +
    key + '. The header of src/service/control.js pairs that key with ' + file + ', so a file named ' +
    'beside the wrong key sends an operator to a file the key does not read.',
  missingFallback: where => where + ' never says which key has a fallback. allowedServerSources in ' +
    'src/service/control.js gives config.' + facts().fallback + ' a second source, and the entry is ' +
    'where an operator learns which file answers when the live one does not. Say so with the term ' +
    'this glossary uses, "fallback".',
  wrongFallback: (where, key) => where + ' gives config.' + key + ' a fallback. allowedServerSources ' +
    'in src/service/control.js gives only config.' + facts().fallback + ' a second source, so the ' +
    'entry names the wrong fallback or a second one.'
}

// The entry's claims, one line per fact that does not hold. The wording is asserted
// on fixtures below, never on the tree: a real drift must not make those cases about
// the drift.
function drift (glossary) {
  const { line, body } = entry(glossary)
  const where = 'GLOSSARY.md:' + line
  const table = facts()
  const found = []
  const named = names(body)
  const keys = named.filter(name => CONFIG.test(name)).map(name => name.replace(/^config\./, ''))
  const switches = named.filter(name => SWITCH.test(name))
  const files = named.filter(name => FILE.test(name))

  for (const name of named) {
    if (CONFIG.test(name) || SWITCH.test(name) || FILE.test(name)) continue
    found.push(message.foreign(where, name))
  }

  for (const key of table.keys) {
    if (!keys.includes(key)) found.push(message.missingKey(where, key))
  }
  for (const key of keys) {
    if (!table.keys.includes(key)) found.push(message.unknownKey(where, key))
  }
  for (const name of switches) {
    if (!table.keys.some(key => table.switch.get(key) === name)) found.push(message.unknownSwitch(where, name))
  }
  for (const file of files) {
    if (!table.files.includes(file)) found.push(message.unknownFile(where, file))
  }

  // Each key's own clause: from the key to the next key named, so a switch or a file
  // in that span belongs to that key and to no other.
  for (const key of table.keys) {
    const start = body.indexOf('`config.' + key + '`')
    if (start === -1) continue
    const end = keys.reduce((stop, other) => {
      const index = body.indexOf('`config.' + other + '`', start + 1)
      return index === -1 ? stop : Math.min(stop, index)
    }, body.length)
    const near = body.slice(start, end)
    if (!near.includes('`' + table.switch.get(key) + '`')) {
      found.push(message.missingSwitch(where, key, table.switch.get(key)))
    }
    // The file beside a key, and the swap worth naming. A key whose span holds
    // another key's file has a name to move, not one to add. So "beside the wrong
    // key" is the message even though the right file is also absent here.
    const beside = [...near.matchAll(/`([a-z0-9-]+\.json)`/g)].map(match => match[1])
    const file = table.file.get(key)
    if (file === undefined) {
      if (beside.length) found.push(message.fileWithNoRow(where, key, beside[0]))
    } else if (beside.length === 0) {
      found.push(message.missingFile(where, key, file))
    } else if (beside.length > 1 || beside[0] !== file) {
      found.push(message.wrongFile(where, key, file, beside))
    }
  }

  // The fallback: the one word read out of a sentence, because this glossary uses it
  // as the term for the fact. Every clause that says it must not hand it to a key
  // with one source, and one of them has to say which key has the second.
  const claimed = body.split(/(?<=\.)\s+/).filter(clause => /\bfallback\b/i.test(clause))
  let toldFallback = false
  for (const clause of claimed) {
    for (const key of table.keys) {
      if (key === table.fallback) continue
      if (clause.includes('`config.' + key + '`')) found.push(message.wrongFallback(where, key))
    }
    if (clause.includes('`config.' + table.fallback + '`')) toldFallback = true
  }
  if (!toldFallback) found.push(message.missingFallback(where))

  return found
}

// The names this guard can resolve anywhere in the glossary, not only in this entry:
// a config path against DEFAULT_CONFIG, and a file name against every file under
// src/, tools/, scripts/, and deploy/. The ticket asks that no entry name a retired
// key, and these two kinds are what a retired control key looks like.
const CODE_DIRS = ['src', 'tools', 'scripts', 'deploy']

let WRITTEN = null

function writtenFiles () {
  if (WRITTEN !== null) return WRITTEN
  const found = new Set()
  for (const dir of CODE_DIRS) {
    for (const item of fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (!item.isFile()) continue
      const bytes = fs.readFileSync(path.join(item.parentPath, item.name))
      // A font or an archive names no file, and decoding one is a guess this guard
      // has no reason to make.
      if (bytes.includes(0)) continue
      for (const match of bytes.toString('utf8').matchAll(JSON_FILE)) found.add(match[0])
    }
  }
  WRITTEN = found
  return WRITTEN
}

function strayNames (glossary) {
  const written = writtenFiles()
  const found = []
  glossary.split('\n').forEach((text, index) => {
    const where = 'GLOSSARY.md:' + (index + 1)
    for (const match of text.matchAll(PATH)) {
      if (field(DEFAULT_CONFIG, match[0].replace(/^config\./, '')) !== undefined) continue
      found.push(message.retiredPath(where, match[0]))
    }
    for (const match of text.matchAll(JSON_FILE)) {
      if (written.has(match[0])) continue
      found.push(message.unwritten(where, match[0]))
    }
  })
  return found
}

// One entry that holds every fact the guard reads, so each case below changes one
// fact and no other. A fixture copied from the tree would make a case about whatever
// the tree drifted to.
const BASE = '**Control document**:\n' +
  'Two keys, each with its own switch and its own file: `config.attachWhitelistFile` ' +
  '(`MONOPLAYER_ATTACH_WHITELIST`, `attach-whitelist.json`) and ' +
  '`config.control.allowedServers` (`MONOPLAYER_ALLOWED_SERVERS`, `allowed-servers.json`). ' +
  'The server list is the one key with a fallback: `config.control.allowedServersSeed` ' +
  '(`MONOPLAYER_ALLOWED_SERVERS_SEED`).\n' +
  '_Avoid_: control file\n'

test('the guard found the keys, the switches, the files, and the entry it compares', () => {
  // A comparison over empty sets passes every case below. Both halves of the surface
  // are named here: the keys the service composes, and the switches the overlay sets
  // them from.
  for (const key of facts().keys) {
    assert.notEqual(field(DEFAULT_CONFIG, key), undefined,
      'config.' + key + ' is a key DEFAULT_CONFIG in src/service/monoplayer.js holds')
    assert.match(facts().switch.get(key) ?? '', SWITCH,
      'envOverlay sets config.' + key + ' from a switch this probe found')
  }
  for (const key of Object.keys(DEFAULT_CONFIG.control)) {
    assert.ok(facts().keys.includes('control.' + key),
      'config.control.' + key + ' is a control key, so the service wires it')
  }
  // One key, one switch: two switches onto one path would leave a map that keeps the
  // last and a comparison that reports the other as unknown.
  assert.equal(new Set(facts().keys.map(key => facts().switch.get(key))).size, facts().keys.length,
    'each control key is set by its own switch, which is the model the entry states')
  assert.ok(facts().files.length > 0, 'the header of src/service/control.js names the files an operator edits')
  assert.equal(facts().file.size, facts().files.length, 'each header row names one key')
  assert.ok(facts().keys.includes(facts().fallback),
    'allowedServerSources names the seed, so the key with a fallback is one the service wires')
  assert.match(GLOSSARY, /config\.[a-z]/, 'the glossary names a config path, so the sweep below has input')
})

test('the entry says what the code does', () => {
  const found = drift(GLOSSARY)
  assert.deepEqual(found, [],
    'GLOSSARY.md and the control document disagree:\n  ' + found.join('\n  '))
})

test('a config path or a file the glossary names anywhere is one the code holds', () => {
  const found = strayNames(GLOSSARY)
  assert.deepEqual(found, [],
    'the glossary names a path or a file nothing holds:\n  ' + found.join('\n  '))
  assert.deepEqual(strayNames('Set `config.control.file` to keep the old one.\n'),
    [message.retiredPath('GLOSSARY.md:1', 'config.control.file')],
    'a retired path is refused wherever it lands, not only in the control entry')
  assert.deepEqual(strayNames('Set config.control.file to keep the old one.\n'),
    [message.retiredPath('GLOSSARY.md:1', 'config.control.file')],
    'and a path written without backticks is still a path')
  assert.deepEqual(strayNames('A ticket that keeps `desired.json` alive.\n'),
    [message.unwritten('GLOSSARY.md:1', 'desired.json')],
    'a file name no code holds is refused too')
})

test('the comparison names the drift, one line per fact', () => {
  // The entry #308 replaced, copied from 164ed87^: two keys, their files, and no
  // switch at all. It is written here rather than read from history so this case
  // stays a case about the comparison. Its _Avoid_ line carries the words "control
  // file", which the token rule must not read as a name.
  const before = '**Control document**:\n' +
    'The files an operator edits between deploys, each named by its own path: ' +
    '`config.attachWhitelistFile` (`attach-whitelist.json`) and ' +
    '`config.control.allowedServers` (`allowed-servers.json`). Each is read at the point of use, ' +
    'the whitelist at each login and the server list at each offer, so an edit takes effect without ' +
    'a deploy and without a restart. Nothing watches either file, and a path left unset means no ' +
    'lane reads that key. The whitelist\'s path is also what turns the document on.\n' +
    '_Avoid_: control file, runtime config, feature flag, control dialog\n'
  const found = drift(before)
  const where = 'GLOSSARY.md:2'
  assert.deepEqual(found, [
    message.missingKey(where, 'control.allowedServersSeed'),
    message.missingSwitch(where, 'attachWhitelistFile', 'MONOPLAYER_ATTACH_WHITELIST'),
    message.missingSwitch(where, 'control.allowedServers', 'MONOPLAYER_ALLOWED_SERVERS'),
    message.missingFallback(where)
  ], 'the entry that predates #308 fails on its missing key, its two missing switches, and its fallback')
})

test('a name the code does not hold fails, including the three the ticket retires', () => {
  assert.deepEqual(drift(BASE), [], 'the fixture the cases below change drifts nothing itself')
  // The retired name lands before the first key, so the case is about that name and
  // not about which key's clause it fell into.
  const changed = name => BASE.replace('Two keys, each', 'A retired name, `' + name + '`, is gone. Two keys, each')
  assert.deepEqual(drift(changed('config.control.file')),
    [message.unknownKey('GLOSSARY.md:2', 'control.file')], 'a key that retired is not a key the service wires')
  assert.deepEqual(drift(changed('desired.json')),
    [message.unknownFile('GLOSSARY.md:2', 'desired.json')], 'a file that retired is not a file the header names')
  assert.deepEqual(drift(changed('allowBackendSwitch')),
    [message.foreign('GLOSSARY.md:2', 'allowBackendSwitch')], 'a panel key is no name this entry carries')
})

test('the fallback is the glossary term, and the entry has to use it', () => {
  // The one word this guard reads out of a sentence. The fact has no name-level
  // form: a key that answers a second time is "the key with a fallback" in this
  // glossary, and a rephrasing that drops the term leaves the reader to infer it.
  // The message says which word to write.
  const found = drift(BASE.replace(/fallback/g, 'second source'))
  assert.deepEqual(found, [message.missingFallback('GLOSSARY.md:2')], found.join(' | '))
  assert.match(message.missingFallback('GLOSSARY.md:2'), /"fallback"/,
    'the message names the word to write: ' + message.missingFallback('GLOSSARY.md:2'))
})

test('a switch or a file beside the wrong key fails', () => {
  const swapped = BASE
    .replace('(`MONOPLAYER_ALLOWED_SERVERS`, `allowed-servers.json`)',
      '(`MONOPLAYER_ALLOWED_SERVERS`, `attach-whitelist.json`)')
    .replace('(`MONOPLAYER_ATTACH_WHITELIST`, `attach-whitelist.json`)',
      '(`MONOPLAYER_ATTACH_WHITELIST`, `allowed-servers.json`)')
  assert.notEqual(swapped, BASE, 'the fixture swapped both files')
  assert.deepEqual(drift(swapped), [
    message.wrongFile('GLOSSARY.md:2', 'attachWhitelistFile', 'attach-whitelist.json',
      ['allowed-servers.json']),
    message.wrongFile('GLOSSARY.md:2', 'control.allowedServers', 'allowed-servers.json',
      ['attach-whitelist.json'])
  ], 'each key names the file of the other')
})

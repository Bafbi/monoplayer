// #890: the panel spells an address with the one rule, and this holds it there.
//
// #815 gave the product one spelling for a dialled address: a host holding a colon keeps its
// brackets, so the host and the port split back (addressName, src/core/picker.js). #889 moved
// the rule into core and made every record call it. The panel was the writer left out: its route
// printed 'host + ":" + port', its page printed the same join again, and its add route judged a
// host with a rule of its own, so an operator with an IPv6 server could not register one at all.
//
// An IPv4 host cannot see any of it: it holds one colon, so the join reads back and the old host
// rule accepted it. That is why three passes over this family left the panel alone.
//
// Two files in src/panel/ still split an address, and both are here by name:
//
//   src/panel/public/panel.js   the browser's split of the form's one field. It is a plain
//                               deferred script (src/panel/views/page.js), so it cannot import
//                               the rule, and the route re-reads the pair it sends.
//   src/panel/registry.js       the registry's own backend field, which is a different
//                               document: a name this cluster resolves, judged by isTargetHost,
//                               not a server an operator adds on a page.
//
// Every other file is read from one listing of the directory, so a view added tomorrow that joins
// an address itself fails here instead of in a log line nobody reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { addressOf, targetOf } from '../../src/panel/routes/allowed.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PANEL = path.join(ROOT, 'src', 'panel')
const BROWSER = 'src/panel/public/panel.js'
const REGISTRY = 'src/panel/registry.js'

// The join #815 removed, in the two spellings a file can write it.
const JOINS = [/\.host\)? \+ ':' \+/, /\$\{[^}]*\.host\}:\$\{[^}]*\.port\}/]
// The split, which is the rule's other half and belongs where the rule is.
const SPLIT = "lastIndexOf(':')"

// One listing call, not a walk of its own: test/panel/record-doc.test.js already reads this
// directory, and two ways to descend it disagree the day one learns a shape the other does not.
const modules = () => fs.readdirSync(PANEL, { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.js'))
  // What the browser loads is not a module this scan can judge.
  .filter(file => !file.startsWith('public' + path.sep))
  .map(file => ({
    name: path.join('src', 'panel', file),
    source: fs.readFileSync(path.join(PANEL, file), 'utf8')
  }))

test('#890 no panel module joins a host and a port into an address itself', () => {
  const found = modules()
  assert.ok(found.some(module => module.name === 'src/panel/views/allowed.js'),
    'the listing reached the view that draws a row, so this case is not vacuous')
  for (const { name, source } of found) {
    for (const join of JOINS) {
      assert.doesNotMatch(source, join,
        name + ' joins a host and a port itself, and the one rule is src/core/picker.js addressName')
    }
  }
})

test('#890 the two files that still split an address are the two that must', () => {
  const found = modules()
  assert.ok(found.some(module => module.name === REGISTRY), 'the listing reached the registry')
  for (const { name, source } of found) {
    if (name === REGISTRY) continue
    assert.equal(source.split(SPLIT).length - 1, 0,
      name + ' splits an address itself: the split belongs to src/core/picker.js pickTarget')
  }
  // And the browser keeps its split, because a deferred script cannot import the rule. A file
  // that lost it would have to have gained an import it cannot have.
  assert.match(fs.readFileSync(path.join(ROOT, BROWSER), 'utf8'), /lastIndexOf\(':'\)/,
    'the page still splits the one field it asks for')
})

test('#890 the route and the page spell an address by calling the rule', () => {
  const route = fs.readFileSync(path.join(PANEL, 'routes', 'allowed.js'), 'utf8')
  assert.match(route, /import \{[^}]*\baddressName\b[^}]*\} from '\.\.\/\.\.\/core\/picker\.js'/,
    'the route imports the one spelling (#889), rather than a second join')
  assert.match(route, /import \{[^}]*\bpickTarget\b[^}]*\} from '\.\.\/\.\.\/core\/picker\.js'/,
    'and its reader, which is what makes the printed address one its own removal path takes')
  // The answering spelling is the rule's, asked in the one function that names an address.
  const named = /export function addressOf \(server\) \{\s*return ([^\n]+)\n\}/.exec(route)
  assert.ok(named, 'the route still names an address in one function')
  assert.match(named[1], /addressName\(server\.host, server\.port\)/,
    "and the name it prints is the rule's")

  const view = fs.readFileSync(path.join(PANEL, 'views', 'allowed.js'), 'utf8')
  assert.match(view, /import \{[^}]*\baddressName\b[^}]*\} from '\.\.\/\.\.\/core\/picker\.js'/,
    'so does the page, which draws the row and the removal path it posts to')
})

// The half a text scan cannot prove: what the route prints, the route reads back as the address
// it names. This is the join the page depends on, because a row's address is the path its
// removal posts to.
test('#890 what the route prints is what its own removal path reads back', () => {
  for (const server of [
    { host: 'paper.example.net', port: 25565 },
    { host: '2001:db8::1', port: 25565 },
    { host: '127.0.0.1', port: 25565 }
  ]) {
    const written = addressOf(server)
    assert.deepEqual(targetOf(written), { target: server },
      written + ' is one address: the one a row prints and the one its removal takes')
  }
})

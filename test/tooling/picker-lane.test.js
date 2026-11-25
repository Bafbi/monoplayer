// #325 asks for a driver-lane scenario where one real client claims a body and a
// second real client watches it in spectator mode. No lane in this repo can serve
// that row. The reason is not in the driver: the claim and the Spectate verb are the
// product's (src/core/claims.js, src/core/picker.js), and no deployed lane serves a
// picker at all.
//
// So the row is not waiting to be written. It is waiting for a lane. These cases pin
// that to the files that decide it. The day a lane turns the picker on, the first case
// fails. That is the moment to revisit the note in deploy/driver/README.md and the O63
// tail in docs/testing-ladder.md, in the same change.
//
// Nothing here reaches a cluster: every case reads a file or the config default.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../../src/service/monoplayer.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const DRIVER_README = read('deploy/driver/README.md')
const LADDER = read('docs/testing-ladder.md')

// Every YAML file under deploy/, with the directory that holds it.
function manifests (dir = path.join(ROOT, 'deploy')) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...manifests(full))
    else if (entry.name.endsWith('.yaml')) found.push(full)
  }
  return found
}

// One section, from its heading to the next heading of the same or a higher level,
// so a claim about the lane cannot be satisfied by a stray line elsewhere.
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

// A bullet is one claim: a stale sentence cannot hide behind a true one beside it.
// The bullet is flattened, because a claim wraps across lines in the source.
function bullet (text, needle) {
  const flat = block => block.replace(/\s+/g, ' ')
  const found = text.split(/(?=^- )/m)
    .filter(block => block.startsWith('- ') && flat(block).includes(needle))
  assert.equal(found.length, 1, 'exactly one claim names ' + needle + ', found ' + found.length)
  return flat(found[0])
}

test('no deployed lane serves the picker, so no client can make a claim', () => {
  const serving = manifests()
    .filter(file => /^\s*-\s*name:\s*MONOPLAYER_PICKER\s*$/m.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(ROOT, file))
  assert.deepEqual(serving, [],
    'a lane sets MONOPLAYER_PICKER: ' + serving.join(', ') + '. A client can now make a claim and ' +
    'watch one outside the loopback rung, so #325 can be built: revisit the "No spectator row" section ' +
    'of deploy/driver/README.md and the O63 tail of docs/testing-ladder.md, then run the row.')

  // The default is the other half: a lane that names no switch still cannot serve one.
  assert.equal(DEFAULT_CONFIG.picker, false,
    'the picker default changed to true, so every lane serves a claim without naming the switch')
})

test('the O63 tail says which lane a real client has to watch a body on', () => {
  const tail = bullet(LADDER, 'vanilla client draws a body it does not drive')
  assert.match(tail, /#325/, 'the claim still names the ticket that would measure it')
  assert.match(tail, /picker is off/, 'it says the picker is off, which is why no client can watch a body')
  assert.match(tail, /deploy\/driver\/README\.md/, 'and it points at the runbook section that says why')
})

test('the gate runbook states what a spectator row would need', () => {
  // Flattened, because a sentence wraps across lines in the source.
  const note = section(DRIVER_README, 'No spectator row: this lane serves no body').replace(/\s+/g, ' ')

  // The four things this lane does not have, each named where it is decided.
  assert.match(note, /MONOPLAYER_PICKER/, 'the picker switch is named, because a lane with it off offers no claim')
  assert.match(note, /src\/service\/start-live\.js/, 'the leg the service builds is named')
  assert.match(note, /src\/legs\/live-backend\.js/, 'and the account directory the backend leg refuses without')
  assert.match(note, /DriverMod\.java/, 'the one drive socket the mod binds is named')
  assert.match(note, /src\/driver\/parity\.js/, 'and the one account two sessions cannot share')
  assert.match(note, /pickerFront\.claims/, 'the in-process read the loopback rung has')
  assert.match(note, /no panel route carries a claim/,
    'and that a deployed front has no route a rung can read the claims list through')

  // The half that is the driver's is named as unbuilt, so nobody reads the note as
  // "the client half is done".
  assert.match(note, /game mode/, 'the game mode reader the mod does not have is named')
  assert.match(note, /DriverServer\.java/, 'with the file it would be added to')
})

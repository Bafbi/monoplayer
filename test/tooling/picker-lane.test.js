// #392 turned the dev lane into an offline picker lane: the row it offers, the
// tailnet name a client reaches it by, and the Paper that accepts the bots which
// arrive. #325 asks for a driver-lane scenario where one real client claims a body and
// a second watches it in spectator mode. This lane makes the claim reachable from
// outside the loopback rung; it does not make the row runnable, because the service
// still builds live legs only (#391).
//
// #579 turned the picker on for the live lane, so two deployed lanes serve one. The
// first case below pins that pair: a third lane naming the switch fails it, and so does
// either of these two dropping it. A change to the pair leaves the O63 tail in
// docs/testing-ladder.md and deploy/driver/README.md saying where a claim is reachable.
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
const DEV_MONOPLAYER = 'deploy/dev/monoplayer.yaml'
const LIVE_MONOPLAYER = 'deploy/manifests/deployment.yaml'
const DEV_PAPER = 'deploy/dev/paper.yaml'

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

const relative = file => path.relative(ROOT, file)
const deployed = () => manifests().map(file => ({ file: relative(file), text: fs.readFileSync(file, 'utf8') }))

// The YAML documents in one file, split on the separator kustomize expects.
const documents = text => text.split(/^---$/m)

// One env entry's value, as a Deployment in this tree sets it.
function envValue (text, name) {
  const match = text.match(new RegExp('- name: ' + name + '\n\\s*value: ([^\\n]+)'))
  assert.ok(match, 'the manifest sets ' + name)
  return match[1].trim().replace(/^"|"$/g, '')
}

// The data a ConfigMap in one file carries, as parsed JSON, keyed by file name.
// The block is a YAML literal, so the value is indented under the key.
function configmapData (text, name, key) {
  const document = documents(text).find(block => /^kind: ConfigMap$/m.test(block) &&
    new RegExp('^  name: ' + name + '$', 'm').test(block))
  assert.ok(document, name + ' is a ConfigMap in this file')
  const lines = document.split('\n')
  const start = lines.findIndex(line => line === '  ' + key + ': |')
  assert.notEqual(start, -1, name + ' carries ' + key)
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] !== '' && !/^ {4}/.test(lines[i])) break
    body.push(lines[i].slice(4))
  }
  return JSON.parse(body.join('\n'))
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

test('two deployed lanes serve the picker: the live lane, and the dev lane', () => {
  const naming = deployed()
    .filter(({ text }) => /^\s*-\s*name:\s*MONOPLAYER_PICKER\s*$/m.test(text))
    .map(({ file }) => file)
    .sort()
  // Any value counts, not just "1": a lane writing "0" is still a decision about
  // who may make a claim, and it is the kind of line a reader takes as truth.
  assert.deepEqual(naming, [DEV_MONOPLAYER, LIVE_MONOPLAYER].sort(),
    'the lanes naming MONOPLAYER_PICKER are ' + (naming.join(', ') || 'none') + '. Since #579 two ' +
    'deployed lanes name it: the live lane, so a player who joins while no body is claimed meets ' +
    'the picker instead of a refusal, and the dev lane, whose job is validation and whose Paper is ' +
    'disposable. A third lane naming it is a third place a claim is offered or refused, and the ' +
    'lane table in AGENTS.md, the driver runbook and the O63 tail would each have to say which one ' +
    'a run means. A lane dropped from this list took the picker off the lane a page still names.')

  // The switch is on, not merely named: a lane that writes "0" says the opposite.
  for (const lane of [DEV_MONOPLAYER, LIVE_MONOPLAYER]) {
    assert.match(read(lane), /- name: MONOPLAYER_PICKER\n\s*value: "1"/,
      lane + ' sets MONOPLAYER_PICKER to 1')
  }

  // The default is the other half: a lane that names no switch still cannot serve one.
  assert.equal(DEFAULT_CONFIG.picker, false,
    'the picker default changed to true, so every lane serves a claim without naming the switch')
})

test('the dev lane offers the row its ConfigMap seeds, and nothing else', () => {
  const text = read(DEV_MONOPLAYER)
  assert.match(text, /- name: MONOPLAYER_ALLOWED_SERVERS_SEED\n\s*value: \/config\/allowed-servers\.json/,
    'the dev lane reads its allowed-server list from /config/allowed-servers.json')

  // The seed is a file Git commits (#356), so the row a client is offered is in the
  // manifest rather than in a cluster nobody can review.
  const seed = configmapData(text, 'monoplayer-dev-config', 'allowed-servers.json')
  assert.equal(seed.servers.length, 1,
    'the dev lane seeds exactly one row, the lane\'s own Paper, and the seed has ' + seed.servers.length)
  // The row and the dial are one address. Read the env the Deployment sets rather
  // than restating it: a backend host edit moves one and not the other, and the
  // picker would offer a server nothing dials.
  assert.deepEqual(
    { host: seed.servers[0].host, port: seed.servers[0].port },
    { host: envValue(text, 'MONOPLAYER_BACKEND_HOST'), port: Number(envValue(text, 'MONOPLAYER_BACKEND_PORT')) },
    'the seeded row is the address MONOPLAYER_BACKEND_HOST and MONOPLAYER_BACKEND_PORT name'
  )
})

test('the front is published on the tailnet by name, and the Paper is not', () => {
  const dev = fs.readdirSync(path.join(ROOT, 'deploy', 'dev'))
    .filter(name => name.endsWith('.yaml'))
    .map(name => ({ file: 'deploy/dev/' + name, text: read('deploy/dev/' + name) }))
    .filter(({ text }) => /^\s*loadBalancerClass: tailscale$/m.test(text))
    .map(({ file }) => file)
  // The dev lane publishes one object: its front. A Paper on the tailnet is a
  // backend anyone could join directly, which is the path a claim exists to replace.
  assert.deepEqual(dev, [DEV_MONOPLAYER],
    'the dev manifests publishing on the tailnet are ' + (dev.join(', ') || 'none') + '. The lane ' +
    'publishes its front and only its front: a Paper on the tailnet accepts a join that never ' +
    'reached a picker.')

  const text = read(DEV_MONOPLAYER)
  assert.match(text, /tailscale\.com\/hostname: monoplayer-dev/,
    'the front is reachable as monoplayer-dev, the name the runbook and the ladder quote')
  assert.match(text, /^ {2}type: LoadBalancer$/m, 'the publishing Service is a LoadBalancer')

  // The front's Service is the one that selects the proxy, and the Paper's own
  // Service stays inside the cluster.
  assert.match(read(DEV_PAPER), /^ {2}type: ClusterIP$/m, 'the dev Paper Service is cluster-internal')
})

test('the dev Paper accepts the bots the lane exists to run', () => {
  const paper = read(DEV_PAPER)
  // A front that forwards an offline login to a Paper in online mode is refused at
  // the backend, so the lane would take a claim and land nobody.
  assert.match(paper, /- name: ONLINE_MODE\n\s*value: "FALSE"/,
    'the dev Paper is offline-mode: a login Mojang never verified reaches the Paper instead of being refused there')
  assert.match(paper, /- name: ENFORCE_SECURE_PROFILE\n\s*value: "FALSE"/,
    'and it does not require a secure profile a bot does not have')
})

test('the O63 tail says which lanes serve a body, and what still needs a real client', () => {
  const tail = bullet(LADDER, 'vanilla client draws a body it does not drive')
  assert.match(tail, /#325/, 'the claim still names the ticket that would measure it')
  // Two lanes serve a picker since #579, so the sentence names both. A reader looking
  // for a lane to run a claim on has two answers, and this tail is where they are
  // written.
  assert.match(tail, /#579/, 'it names the ticket that turned the picker on for the live lane')
  assert.match(tail, /live lane/, 'it names the live lane as one that serves a picker')
  assert.match(tail, /dev lane/, 'and the dev lane, the one a claim reaches without the live servers')
  assert.match(tail, /#391/, 'and the ticket that has to land before two bots can join one')
  assert.match(tail, /deploy\/dev\/README\.md/, 'pointing at the runbook that says what the lane holds')
})

test('the gate runbook states what a spectator row would need', () => {
  // Flattened, because a sentence wraps across lines in the source.
  const note = section(DRIVER_README, 'No spectator row: no client can draw a body yet').replace(/\s+/g, ' ')

  // The lane that now serves a body, and the three things it still does not have.
  assert.match(note, /dev lane/, 'the dev lane is named as the lane a claim can reach without the live servers')
  assert.match(note, /MONOPLAYER_PICKER/, 'the picker switch is named, because a lane with it off offers no claim')
  assert.match(note, /#579/, 'it names the ticket that turned the picker on for the live lane')
  assert.match(note, /live lane/, 'and says the live lane serves the same picker')
  assert.match(note, /#391/, 'the missing offline legs are named as the ticket that owns them')
  assert.match(note, /src\/service\/start-live\.js/, 'the leg the service builds is named')
  assert.match(note, /src\/legs\/live-backend\.js/, 'and the account directory the backend leg refuses without')

  // The driver's own half is still unbuilt, so nobody reads the note as "the row is
  // just waiting for a lane now".
  assert.match(note, /DriverMod\.java/, 'the one drive socket the mod binds is named')
  assert.match(note, /src\/driver\/parity\.js/, 'and the one account two sessions cannot share')
  assert.match(note, /pickerFront\.claims/, 'the in-process read the loopback rung has')
  assert.match(note, /no panel route carries a claim/,
    'and that a deployed front has no route a rung can read the claims list through')
  assert.match(note, /game mode/, 'the game mode reader the mod does not have is named')
  assert.match(note, /DriverServer\.java/, 'with the file it would be added to')
})

// The launch command a driver operator copies names the gate lane (#327).
//
// A lane belongs to a worktree: it is the short commit and a short hash of the
// path (#279), and scripts/gate-lane.sh owns the name. The examples in
// tools/driver/ spelled monoplayer-gate-b-paper, a lane no rung renders since the
// tree became a template over gate-__instance__. The one command an operator
// copies failed to resolve, and the failure read as a broken cluster rather than
// as a stale example. Nothing reads a printed example, so this file does.
//
// Two halves. The static half keeps a literal from coming back. The behavioural
// half runs install.sh against a throwaway Prism root and reads the command it
// prints, so the printed lane is the resolver's answer and not a value that
// agreed with it on the day it was written.
//
// The installer needs python3 for its Prism edits, so this file does too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

import { GATE_LANE_SCRIPT, TAILNET, paperAddress } from '../../src/driver/lane.js'
// The one mirror of the derived lane every test asserts against (#279).
import { LANE } from '../support/lane.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

// The page that installs the driver, the two files an operator reads to launch
// it, and the lane page that used to admit the example was stale.
const FILES = [
  'tools/driver/README.md',
  'tools/driver/install.sh',
  'tools/driver/driver-client.mjs',
  'deploy/driver/README.md'
]

// What a lane's Paper address ends in, with the lane itself left out: the string
// a printed example has to end on, whatever names the lane before it.
const ADDRESS_TAIL = paperAddress('lane').slice('lane'.length)

test('no file under tools/driver spells a lane of its own', () => {
  for (const file of ['tools/driver/README.md', 'tools/driver/install.sh', 'tools/driver/driver-client.mjs']) {
    // A lane in these files is a placeholder (`monoplayer-gate-<instance>`) or the
    // output of the resolver (`$(scripts/gate-lane.sh name)`). A literal instance is
    // the defect: it resolves to nothing once the lane moves.
    const literal = read(file).match(/monoplayer-gate-[a-z0-9]/)
    assert.equal(literal, null,
      file + ' spells a gate lane (' + (literal?.[0] ?? '') +
      '). A lane is this worktree\'s: name it with scripts/gate-lane.sh name, or write monoplayer-gate-<instance>')
  }
})

test('every lane address a driver page prints is a lane\'s Paper', () => {
  // A stale example is an address that resolves to nothing, so the address and
  // the resolver have to agree on the workload, the tailnet and the port.
  for (const file of FILES) {
    for (const [address] of read(file).matchAll(/[^\s"`']*ts\.net:25565/g)) {
      assert.ok(address.endsWith(ADDRESS_TAIL),
        file + ' prints ' + address + ', and a lane\'s Paper is <lane>' + ADDRESS_TAIL +
        '. src/driver/lane.js builds that address')
    }
  }
})

test('every tailnet host a driver page prints is on this repo\'s tailnet', () => {
  for (const file of FILES) {
    for (const [host] of read(file).matchAll(/[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net/g)) {
      assert.ok(host.endsWith(TAILNET), file + ' prints a host outside ' + TAILNET + ': ' + host)
    }
  }
})

test('deploy/driver/README.md no longer calls the driver examples stale', () => {
  // The sentence was the honest description while the defect stood (#327). Now
  // that the examples ask the resolver, a page that still warns sends a reader
  // to pass -s for a lane it already joins.
  assert.doesNotMatch(read('deploy/driver/README.md'), /still print\s+the lane/,
    'the examples derive the lane, so the page does not warn that they do not')
})

test('the installer asks the resolver, and its printed command names the lane', () => {
  const printed = runInstall()
  const address = paperAddress(LANE)
  assert.equal(printed.status, 0, 'install.sh installs into a throwaway Prism root: ' + printed.stderr)
  assert.ok(printed.stdout.includes(address),
    'install.sh prints the lane this worktree derives, from ' + path.relative(ROOT, GATE_LANE_SCRIPT) +
    ' name: it must print ' + address + ' and printed:\n' + printed.stdout)
  assert.match(printed.stdout, /another lane/i, 'and says what a run against another lane passes')
})

test('the installer prints a placeholder and the way out when the lane cannot be derived', () => {
  // The installer can reach a host whose checkout is not a git worktree: the
  // resolver cannot answer, so the example has to look like a placeholder
  // instead of hosting a plausible one.
  const printed = runInstall({ env: { MONOPLAYER_GATE_WORKTREE: os.tmpdir() } })
  assert.equal(printed.status, 0, 'the install still succeeds: ' + printed.stderr)
  assert.match(printed.stdout, /monoplayer-gate-<instance>-paper\./,
    'install.sh prints the placeholder shape the tree renders. It printed:\n' + printed.stdout)
  assert.doesNotMatch(printed.stdout, /monoplayer-gate-[a-z0-9]/,
    'and nothing that looks like a lane')
  assert.match(printed.stdout, /scripts\/gate-lane\.sh name/,
    'and names the command that prints the lane')
})

// A Prism root with one base instance, installed into by the real script. Each
// run writes under its own temp directory, so no host Prism root is touched.
// test/support/temp.js removes it when this file's tests finish.
function runInstall ({ env = {} } = {}) {
  const scratch = tempRoot('driver-install-')
  const prism = path.join(scratch, 'PrismLauncher')
  const base = path.join(prism, 'instances', 'gate-b-player')
  fs.mkdirSync(path.join(base, 'minecraft'), { recursive: true })
  fs.writeFileSync(path.join(base, 'mmc-pack.json'), JSON.stringify({
    components: [
      { uid: 'net.minecraft', version: '26.2' },
      { uid: 'org.lwjgl3', version: '3.3.3' }
    ],
    formatVersion: 1
  }))
  fs.writeFileSync(path.join(base, 'instance.cfg'), '[General]\nname=gate-b-player\n')
  const jar = path.join(scratch, 'monoplayer-driver.jar')
  fs.writeFileSync(jar, '')
  // A lane named by hand belongs to the caller's run, not to this one's, so it is
  // not passed on: the installer has to derive the lane this case asserts.
  const inherited = { ...process.env }
  if (!Object.hasOwn(env, 'MONOPLAYER_GATE_NAMESPACE')) delete inherited.MONOPLAYER_GATE_NAMESPACE
  return spawnSync('bash', [path.join(ROOT, 'tools/driver/install.sh'), jar], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...inherited, PRISM_ROOT: prism, BASE: 'gate-b-player', INSTANCE: 'gate-b-player-test', ...env }
  })
}

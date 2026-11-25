// Three pages a driver operator follows printed a lane no worktree derives (#375).
//
// A lane belongs to a worktree: its short commit, then a short hash of its path
// (#279). scripts/gate-lane.sh owns the name, and #376 made the driver's own
// examples ask for it (#327). These three pages were outside that fence. A copied
// command joined a lane that had stopped existing when the lane moved.
//
// A page does two things with a lane, and only one of them is a defect.
//
// A command a reader copies has to resolve the lane, so it writes
// `$(scripts/gate-lane.sh name)` or the placeholder the tree renders,
// `monoplayer-gate-<instance>`. Anything else fails in every worktree but the one it
// was typed in. It fails as a hostname that does not answer, which reads as a broken
// cluster.
//
// A record of a past run may keep the lane it used. The value was true then, and a
// reader who reruns the run is on another lane anyway. What it must not do is read
// as an instruction. That is the sentence around it, not the string, so no test can
// decide it. RECORDED is where the judgement is written down. One entry per literal
// a page keeps, with the reason it is history and the number of times the page
// prints it. A page that prints one more than its entry explains fails here, and so
// does an entry whose literal has gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { paperAddress, tailnetHost } from '../../src/driver/lane.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGES = [
  'docs/driver-validation.md',
  'docs/paper-behind-velocity.md',
  'docs/driver-lane-plan.md'
]

// A lane as a page prints it: the namespace, the tailnet host the tree renders
// from it, or one of the lane's Secrets. A placeholder (`<instance>`) and the
// resolver (`$(scripts/gate-lane.sh name)`) both stop matching at their first
// character that is not a lane's, which is what keeps them out of this.
const LANE = /monoplayer-gate-[a-z0-9][A-Za-z0-9.-]*|(?<!monoplayer-)gate-[a-z0-9]+-(?:rcon|velocity)\b/g

// A trailing dot or hyphen belongs to the sentence, not to the lane.
const laneTokens = text => [...text.matchAll(LANE)].map(([token]) => token.replace(/[.-]+$/, ''))

// The literals these pages keep, and why each one is a record rather than a
// command. Adding a lane to a page means adding it here, or resolving it.
const RECORDED = {
  'docs/driver-validation.md': [
    { lane: 'monoplayer-gate-b', count: 1, because: 'the Environment table of the 2026-11-06 run' },
    { lane: 'monoplayer-gate-b-paper.tail41e568.ts.net', count: 1, because: 'the server that run joined, in the same table' }
  ],
  'docs/paper-behind-velocity.md': [
    { lane: 'monoplayer-gate-b-velocity.tail41e568.ts.net', count: 1, because: 'the Result section, dated 2026-11-07' }
  ],
  'docs/driver-lane-plan.md': [
    { lane: 'monoplayer-gate-b', count: 8, because: 'the G0 records and the topology of a plan whose banner calls it historical, dated 5 November 2026' },
    { lane: 'monoplayer-gate-b-paper.tail41e568.ts.net', count: 2, because: 'the two G0 evidence lines, "Proven now" under Live status · 6 November 2026 and the evidence bundle dated 6 November 2026' }
  ]
}

test('every lane a page prints is either resolved or recorded as history', () => {
  for (const page of PAGES) {
    const printed = new Map()
    for (const token of laneTokens(read(page))) printed.set(token, (printed.get(token) ?? 0) + 1)
    const recorded = new Map(RECORDED[page].map(entry => [entry.lane, entry.count]))

    for (const [token, count] of printed) {
      assert.ok(recorded.has(token),
        page + ' prints ' + token + ', which no worktree derives. A command a reader copies resolves ' +
        'the lane: write $(scripts/gate-lane.sh name), or monoplayer-gate-<instance> for the shape the ' +
        'tree renders. A record of a past run may keep it: add it to RECORDED in this file with its reason')
      assert.equal(count, recorded.get(token),
        page + ' prints ' + token + ' ' + count + ' times and RECORDED explains ' + recorded.get(token) +
        '. A new occurrence is a command that has to resolve the lane, unless it is another record, ' +
        'and then its entry counts it')
    }

    for (const [token, count] of recorded) {
      assert.ok(printed.has(token),
        'RECORDED keeps ' + count + ' of ' + token + ' in ' + page + ', and the page prints none. ' +
        'Drop the entry, or say where the record went')
    }
  }
})

// The namespace is the half a command carries in -n. It names the lane the command
// acts on, so a literal there administers another worktree's rows, or the transfer
// testbed's.
test('every kubectl in these pages resolves the lane it acts on', () => {
  for (const page of PAGES) {
    for (const [line] of read(page).matchAll(/^.*\bkubectl\b.*$/gm)) {
      const at = line.indexOf(' -n ')
      if (at === -1) continue
      const named = line.slice(at + ' -n '.length)
      assert.ok(named.startsWith('"$(scripts/gate-lane.sh name)"'),
        page + ' runs kubectl against ' + named.split(/\s+/)[0] + ': ' + line.trim() +
        '. A lane is this worktree\'s, so the namespace is "$(scripts/gate-lane.sh name)"')
    }
  }
})

// The address is the other half: a lane publishes its Paper and its Velocity, and
// nothing else answers at this tailnet. src/driver/lane.js builds both, so a page and
// a rung cannot disagree about where a lane's backend is. The host is the host alone in
// a server list ping, so a port is the game port or absent. The name before the
// workload is the resolver, the placeholder, or a lane the page recorded: a matching
// suffix alone would accept a hostname no lane ever published.
const LANE_HOSTS = ['paper', 'velocity'].map(workload => tailnetHost('lane', workload).slice('lane'.length))
const RESOLVER = 'the-lane'
const NAMES = [RESOLVER, '<lane>', '<instance>']

// A lane's name, out of the literal a page records: the part before the workload.
const laneOf = literal => {
  const tail = LANE_HOSTS.find(candidate => literal.endsWith(candidate)) ?? ''
  return literal.slice(0, literal.length - tail.length)
}

test('every lane address a page prints is a lane\'s Paper or its Velocity', () => {
  for (const page of PAGES) {
    // The resolver holds a space, so it takes one token's place before the read.
    const text = read(page).replaceAll('$(scripts/gate-lane.sh name)', RESOLVER)
    const named = new Set([...NAMES, ...RECORDED[page].map(entry => laneOf(entry.lane))])
    for (const [address] of text.matchAll(/[^\s"`']*\.ts\.net(?::\d+)?/g)) {
      const port = /:\d+$/.exec(address)?.[0] ?? ''
      const host = address.slice(0, address.length - port.length)
      const tail = LANE_HOSTS.find(candidate => host.endsWith(candidate))
      assert.ok(tail,
        page + ' prints ' + address + ', and a lane publishes <lane>' + LANE_HOSTS.join(' and <lane>') +
        '. src/driver/lane.js builds both')
      assert.ok(port === '' || port === ':25565',
        page + ' prints ' + address + ', and a lane serves the game port: 25565')
      const lane = host.slice(0, host.length - tail.length)
      assert.ok(named.has(lane),
        page + ' prints ' + address + ', and the lane before the workload is "' + lane + '": neither ' +
        'the resolver, the placeholder, nor a lane RECORDED keeps for this page')
    }
  }
})

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
//
// #397 is the sibling shape, one page over: docs/driver-lane.md printed the transfer
// testbed's namespace and then ran the gate tree's Deployment in it, which fails
// NotFound and reads as a broken cluster rather than as a stale name. So the page that
// gives the driver's RCON command is read here too, and two of the rules below have a
// second answer. A command may act outside this worktree's lane in a namespace a tree
// beside it declares (SHARED), and then only on a row that tree declares. An address
// may be one a manifest publishes, or the display host the run drives, because neither
// is a lane's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TAILNET, paperAddress, tailnetHost } from '../../src/driver/lane.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGES = [
  'docs/driver-validation.md',
  'docs/paper-behind-velocity.md',
  'docs/driver-lane-plan.md',
  'docs/driver-lane.md'
]

// A lane as a page prints it: the namespace, the tailnet host the tree renders
// from it, or one of the lane's Secrets. A placeholder (`<instance>`) and the
// resolver (`$(scripts/gate-lane.sh name)`) both stop matching at their first
// character that is not a lane's, which is what keeps them out of this.
const LANE = /monoplayer-gate-[a-z0-9][A-Za-z0-9.-]*|(?<!monoplayer-)gate-[a-z0-9]+-(?:rcon|velocity)\b/g

// A trailing dot or hyphen belongs to the sentence, not to the lane.
const laneTokens = text => [...text.matchAll(LANE)].map(([token]) => token.replace(/[.-]+$/, ''))

// The literals these pages keep, and why each one stays rather than resolving. Two
// reasons: a record of a past run, whose value was true then, or a name a tree beside this
// file owns (SHARED), which a page prints because it is not a lane at all. Either way the
// entry counts the prints, so a second copy that does read as a command has to be argued
// for here. Adding a lane to a page means adding it here, or resolving it.
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
  ],
  'docs/driver-lane.md': [
    { lane: 'monoplayer-gate-b', count: 2, because: 'the transfer testbed section, whose two Papers live in that fixed namespace (#318)' }
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

// A page also reaches two namespaces no worktree derives, and a command against one is
// right: the dev lane's (#42) and the transfer testbed's (#318). Each is declared by a
// kustomization, and that tree is what the entry points at. So the rule reads it: a
// command there may act on a row the tree declares, and no other. That is what tells the
// testbed's svc/paper-hub apart from the gate tree's deploy/paper typed in the testbed's
// namespace, which is the defect this page had (#397).
const SHARED = {
  'monoplayer-dev': 'deploy/dev/kustomization.yaml',
  'monoplayer-gate-b': 'deploy/testbed/kustomization.yaml'
}

// What a kustomization declares: each object's kind, name and namespace, and the tailnet
// hosts its files publish. It reads one document at a time, because an object's namespace is
// its own: the testbed's front Service is in `monoplayer`, so it is not a row of the testbed
// and a command in the testbed cannot act on it. A row renamed in one of these files moves
// this with it.
const tree = kustomization => {
  const dir = path.dirname(kustomization)
  const documents = [...read(kustomization).matchAll(/^ {2}- (\S+\.yaml)$/gm)]
    .flatMap(([, file]) => read(path.join(dir, file)).split(/^---$/m))
  return {
    objects: documents.flatMap(document => {
      const name = /^ {2}name: (\S+)$/m.exec(document)?.[1]
      const kind = /^kind: (\S+)$/m.exec(document)?.[1]
      // A Namespace object is named by itself, and one of these trees declares it.
      const namespace = /^ {2}namespace: (\S+)$/m.exec(document)?.[1] ?? (kind === 'Namespace' ? name : undefined)
      return name === undefined || namespace === undefined ? [] : [{ kind, name, namespace }]
    }),
    hosts: new Set([...documents.join('\n').matchAll(/tailscale\.com\/hostname:\s*(\S+)/g)].map(([, host]) => host))
  }
}

// The namespace is the half a command carries in -n. It names the lane the command
// acts on, so a literal there administers another worktree's rows, or the transfer
// testbed's — unless it is one of the two namespaces above, and the row is that tree's.
test('every kubectl in these pages resolves the lane it acts on, or a row a shared tree declares', () => {
  // A namespace is typed here because nothing exports it, so each entry is proved against
  // the tree that declares it: a rename that misses this file fails on this line.
  const trees = Object.entries(SHARED).map(([namespace, kustomization]) => [namespace, kustomization, tree(kustomization)])
  for (const [namespace, kustomization, declared] of trees) {
    assert.ok(declared.objects.some(object => object.kind === 'Namespace' && object.name === namespace),
      'SHARED names ' + namespace + ', and ' + kustomization + ' does not declare it. A shared namespace is the one its own tree spells')
  }
  for (const page of PAGES) {
    for (const [line] of read(page).matchAll(/^.*\bkubectl\b.*$/gm)) {
      const at = line.indexOf(' -n ')
      if (at === -1) continue
      const named = line.slice(at + ' -n '.length)
      if (named.startsWith('"$(scripts/gate-lane.sh name)"')) continue
      const namespace = named.split(/\s+/)[0]
      assert.ok(SHARED[namespace],
        page + ' runs kubectl against ' + namespace + ': ' + line.trim() +
        '. A lane is this worktree\'s, so the namespace is "$(scripts/gate-lane.sh name)". ' +
        'The other namespaces a page may name are the shared trees: ' + Object.keys(SHARED).join(', '))
      const row = /\b(?:svc|service|deploy|deployment|deployment\.apps|pod|job|secret|configmap)\/(\S+)/.exec(line)?.[1]
      const declared = trees.find(([named]) => named === namespace)[2]
      assert.ok(row !== undefined && declared.objects.some(object => object.namespace === namespace && object.name === row),
        page + ' runs kubectl in ' + namespace + ' for ' + (row ?? 'no row the line names') + ': ' + line.trim() +
        '. A shared namespace holds its own rows, and ' + SHARED[namespace] + ' declares what they are')
    }
  }
})

// The address is the other half: a lane publishes its Paper and its Velocity, and
// nothing else answers at this tailnet for a lane. src/driver/lane.js builds both, so a
// page and a rung cannot disagree about where a lane's backend is. The host is the host
// alone in a server list ping, so a port is the game port or absent. The name before the
// workload is the resolver, the placeholder, or a lane the page recorded: a matching
// suffix alone would accept a hostname no lane ever published.
const LANE_HOSTS = ['paper', 'velocity'].map(workload => tailnetHost('lane', workload).slice('lane'.length))
const RESOLVER = 'the-lane'
const NAMES = [RESOLVER, '<lane>', '<instance>']

// Two names on these pages are not a lane's, and a lane rule cannot hold them, so neither is
// excused by a list of exceptions. One is a host a shared tree publishes, read from the
// annotation that decides it. The other is the display host a run drives, which is no cluster
// object at all: tools/nath.sh names it, and test/tooling/nath.test.js holds that name to the
// driver's. A host the live lane publishes is neither, so it still fails the rule below.
const HOSTS = new Set(Object.values(SHARED).flatMap(kustomization => [...tree(kustomization).hosts]))
// A hostname is published bare, and a page prints it at this tailnet: the name in front.
const bare = host => host.endsWith('.' + TAILNET) ? host.slice(0, host.length - TAILNET.length - 1) : host
const display = () => {
  const found = /NATH_HOST:-\s*"?([^\s"}]+)/.exec(read('tools/nath.sh'))
  assert.ok(found, 'tools/nath.sh names the display host as a NATH_HOST default, and this test reads that name')
  return bare(found[1].replace(/^[^@]*@/, ''))
}

// A lane's name, out of the literal a page records: the part before the workload.
const laneOf = literal => {
  const tail = LANE_HOSTS.find(candidate => literal.endsWith(candidate)) ?? ''
  return literal.slice(0, literal.length - tail.length)
}

test('every lane address a page prints is a lane\'s Paper or its Velocity', () => {
  const displayHost = display()
  for (const page of PAGES) {
    // The resolver holds a space, so it takes one token's place before the read.
    const text = read(page).replaceAll('$(scripts/gate-lane.sh name)', RESOLVER)
    const named = new Set([...NAMES, ...RECORDED[page].map(entry => laneOf(entry.lane))])
    for (const [address] of text.matchAll(/[^\s"`']*\.ts\.net(?::\d+)?/g)) {
      const port = /:\d+$/.exec(address)?.[0] ?? ''
      // An ssh login in front of the host belongs to the caller, not to the name.
      const host = address.slice(0, address.length - port.length).replace(/^[^@]*@/, '')
      // Neither of these can be a lane's, so neither is pinned to one.
      const hostname = bare(host)
      if (hostname === displayHost || HOSTS.has(hostname)) continue
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

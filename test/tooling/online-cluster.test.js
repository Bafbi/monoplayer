// scripts/online-cluster.sh runs the online rung from a throwaway pod. These
// cases replace kubectl with a shim, so nothing here reaches a cluster, creates
// a pod, or reads a token. The shim records every argv, which is what the
// guarantees are made of: no scale, no patch, no rollout, always a delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMiseTasks } from './mise-toml.js'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'online-cluster.sh'
)

const PUPPET = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH = '6eb73524-ff88-4a62-a8d0-c63905e7afba'

// The shim answers the calls the script makes, records every argv, and lets a
// case choose the token state and the rung's exit status. The uuids arrive as
// environment so the shim needs no substitution.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'ATTACH="$KUBECTL_ATTACH"',
  'PUPPET="$KUBECTL_PUPPET"',
  'last="${@: -1}"',
  'case " $* " in',
  // The account lease (#280): the shim answers from a file, records every object the
  // script writes, and can answer one read as held and the next as absent, which is
  // the whole of "queue behind a holder, then take it".
  '  *" get lease "*) if [ -n "$KUBECTL_LEASE_READ_ERROR" ]; then printf \'Error from server (Forbidden): leases are forbidden\\n\' >&2; exit 1; fi',
    '    reads=$(cat "$KUBECTL_LEASE_READS" 2>/dev/null || printf 0); reads=$((reads + 1)); printf %s "$reads" > "$KUBECTL_LEASE_READS"' ,
  '    if [ -n "$KUBECTL_LEASE_FOREIGN_AFTER" ] && [ "$reads" -gt "$KUBECTL_LEASE_FOREIGN_AFTER" ] && [ -f "$KUBECTL_LEASE_FOREIGN" ]; then cat "$KUBECTL_LEASE_FOREIGN"; exit 0; fi',
  '    if [ -f "$KUBECTL_LEASE" ]; then cat "$KUBECTL_LEASE"; if [ "$KUBECTL_LEASE_ONCE" = 1 ]; then rm -f "$KUBECTL_LEASE"; fi; exit 0; fi',
  '    printf \'Error from server (NotFound): lease not found\\n\' >&2; exit 1 ;;',
  '  *" create -f "*|*" replace -f "*) staged="${@: -1}"; { printf \'%s\\n\' ---; cat "$staged"; } >> "$KUBECTL_LEASES"; cp "$staged" "$KUBECTL_LEASE"; printf \'lease configured\\n\'; exit 0 ;;',
  '  *" get deploy "*) printf \'{"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/bafbi/monoplayer@sha256:deadbeef","env":[{"name":"MONOPLAYER_PUPPET_UUID","value":"%s"},{"name":"MONOPLAYER_PUPPET_ACCOUNTS_DIR","value":"/data/accounts"}]}]}}}}\\n\' "$PUPPET"; exit 0 ;;',
  '  *" apply "*) cat > "$KUBECTL_MANIFEST"; printf \'pod/check created\\n\'; exit 0 ;;',
  '  *" wait "*" pod/"*) exit 0 ;;',
  '  *" cp ./src "*|*" cp ./package.json "*) exit 0 ;;',
  '  *" exec "*"mca-cache.json"*) printf \'%s\\n\' "${KUBECTL_TOKEN:-600 min left}"; exit 0 ;;',
  '  *" exec "*"online.js"*) [ -z "$KUBECTL_RUN_SLEEP" ] || sleep "$KUBECTL_RUN_SLEEP"; printf \'PASS N1 the Microsoft-authenticated attach succeeds\\n\'; exit "${KUBECTL_RUN_STATUS:-0}" ;;',
  '  *" exec -i "*) cat > /dev/null; exit 0 ;;',
  '  *" exec "*) exit 0 ;;',
  '  *" delete pod "*) exit 0 ;;',
  '  *" cp "*"online-report.json"*) printf \'{"summary":"ok"}\\n\' > "$last"; exit 0 ;;',
  '  *" cp "*"/accounts/$ATTACH"*) mkdir -p "$last/$ATTACH"; printf \'{}\' > "$last/$ATTACH/live-cache.json"; printf \'{}\' > "$last/$ATTACH/profile.json"; exit 0 ;;',
  '  *" cp "*"/accounts/$PUPPET"*) mkdir -p "$last/$PUPPET"; for f in live-cache.json mca-cache.json xbl-cache.json profile.json; do printf \'{}\' > "$last/$PUPPET/$f"; done; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-cluster-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })

  const attach = path.join(root, '.secrets', 'accounts', ATTACH)
  fs.mkdirSync(attach, { recursive: true })
  fs.writeFileSync(path.join(attach, 'profile.json'), JSON.stringify({ uuid: ATTACH, name: 'Bafbi', alias: 'bafbi' }))
  fs.writeFileSync(path.join(attach, 'live-cache.json'), '{"old":true}')

  return {
    root,
    bin,
    attach,
    log: path.join(root, 'kubectl.log'),
    manifest: path.join(root, 'manifest.yaml'),
    // The lease the shim answers from, and every object the script wrote, in order.
    lease: path.join(root, 'lease.json'),
    leases: path.join(root, 'leases.log'),
    reads: path.join(root, 'lease-reads'),
    foreign: path.join(root, 'lease-foreign.json')
  }
}

function podArgs (space) {
  return ['--report', path.join(space.root, 'report.json')]
}

function run (space, env = {}, args = null) {
  const result = spawnSync('bash', [SCRIPT, ...(args ?? podArgs(space))], {
    cwd: space.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_MANIFEST: space.manifest,
      KUBECTL_PUPPET: PUPPET,
      KUBECTL_ATTACH: ATTACH,
      MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
      KUBECTL_LEASE: space.lease,
      KUBECTL_LEASES: space.leases,
      KUBECTL_LEASE_READS: space.reads,
      KUBECTL_LEASE_FOREIGN: space.foreign,
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  return { status: result.status, output, calls, error: result.error ?? null }
}

test('the run never scales, patches, or restarts the deployment', () => {
  const space = workspace()
  const { status, calls, output, error } = run(space)

  assert.equal(status, 0, 'status ' + status + ' error ' + (error?.message ?? 'none') + ' calls: ' + calls.join(' | ') + ' output: ' + output)
  for (const verb of ['scale', 'rollout', 'patch', 'delete deploy']) {
    assert.equal(calls.some(line => line.includes(verb)), false, 'no ' + verb + ' in: ' + calls.join(' / '))
  }
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is deleted')
})

test('the custody volume is mounted read-only', () => {
  const space = workspace()
  run(space)
  const manifest = fs.readFileSync(space.manifest, 'utf8')

  assert.match(manifest, /claimName: monoplayer-custody[\s\S]*readOnly: true/, 'claim is read-only')
  assert.match(manifest, /mountPath: \/data\n\s+readOnly: true/, 'mount is read-only')
  assert.match(manifest, /automountServiceAccountToken: false/)
})

test('the pod is deleted even when the rung fails, and the exit status survives', () => {
  const space = workspace()
  const { status, calls } = run(space, { KUBECTL_RUN_STATUS: '1' })

  assert.equal(status, 1)
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is deleted on failure')
})

test('an expired puppet token stops the run before it can rotate the chain', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_TOKEN: 'expired' })

  assert.equal(status, 2)
  assert.match(output, /with --rotate/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran')
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is cleaned up')
})

test('the attach custody is copied back, so one live copy remains', () => {
  const space = workspace()
  const { status, output } = run(space)
  assert.equal(status, 0, output)

  const written = JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8'))
  assert.deepEqual(written, {}, 'the rotated copy replaced the local one')
})

// --- the backend a run defaults to is the gate lane it was told about (#277) ---

// Before #277 the gate lane was one namespace and the online rung's default backend
// was written out by hand: paper.monoplayer-gate-b.svc.cluster.local. A lane with an
// instance of its own needs that host to follow, or a renamed lane's rung dials the
// default lane while it reads custody from the deployment it was pointed at.

test("the default backend follows the gate lane, and today's value when none is named", () => {
  const space = workspace()
  const { calls } = run(space)
  assert.ok(
    calls.some(line => line.includes('MONOPLAYER_BACKEND_HOST=paper.monoplayer-gate-b.svc.cluster.local')),
    "the default is still today's host: " + calls.join(' | ')
  )
})

test('a renamed gate lane dials its own backend', () => {
  const space = workspace()
  const { calls, output } = run(space, { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  const dialled = calls.find(line => line.includes('MONOPLAYER_BACKEND_HOST='))
  assert.ok(dialled, 'the rung was given a backend: ' + calls.join(' | ') + ' output: ' + output)
  assert.match(dialled, /MONOPLAYER_BACKEND_HOST=paper\.monoplayer-gate-x\.svc\.cluster\.local/,
    'the lane named decides the backend, not the lane that shipped: ' + dialled)
  assert.doesNotMatch(dialled, /monoplayer-gate-b/, 'a renamed lane must not dial the default lane: ' + dialled)
})


// --- the lane named is never the live or dev lane (#277, AGENTS.md) ---

// The default backend is derived from MONOPLAYER_GATE_NAMESPACE now, so the variable
// decides which server this rung dials. AGENTS.md is absolute: no lane script may
// name the live namespace as a target. observer-report.sh already refuses it. This
// one derived a host from it and refused nothing, so a stray variable pointed the
// online rung at the product's own backend.

test('a gate lane naming the live or dev namespace is refused before anything runs', () => {
  for (const namespace of ['monoplayer', 'monoplayer-dev']) {
    const space = workspace()
    const { status, output, calls } = run(space, { MONOPLAYER_GATE_NAMESPACE: namespace })
    assert.equal(status, 2, output)
    assert.match(output, /refusing/)
    assert.equal(
      calls.some(line => line.includes('paper.' + namespace + '.svc.cluster.local')),
      false,
      'refusing "' + namespace + '" dialled it anyway: ' + calls.join(' | ')
    )
  }
})


// --- the account lease (#280) -------------------------------------------------
//
// One Minecraft identity is one refresh chain with one writer lock, so two runs that
// use it are unsafe. A run takes a Kubernetes Lease first, names its lane and branch in
// the holder, refuses while another holder has it, and lets an expired one be taken.
// Nothing here reaches a cluster: the shim answers `get lease` from a file and records
// every object the script writes.

const NOW = Date.now()

// A lease another run holds. renewTime in the future is a live holder; a stale one is a
// run that died without releasing it.
function held (spec = {}) {
  return JSON.stringify({
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name: 'monoplayer-online-account', namespace: 'monoplayer', resourceVersion: '7' },
    spec: {
      holderIdentity: 'monoplayer-gate-aaaaaaa-000000 on feat/another (pid 4242)',
      leaseDurationSeconds: 900,
      acquireTime: new Date(NOW - 60000).toISOString(),
      renewTime: new Date(NOW).toISOString(),
      leaseTransitions: 1,
      ...spec
    }
  }, null, 2)
}

// The lane this worktree's rung derives (#279), mirrored the way gate-lane.test.js
// mirrors it: a script that typed a name instead of deriving one could not match.
const WORKTREE = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const COMMIT = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const crc = text => Number(spawnSync('cksum', [], { input: text, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0])
const LANE = 'monoplayer-gate-' + COMMIT + '-' + (crc(WORKTREE) % 0x1000000).toString(16).padStart(6, '0')
const BRANCH = (() => {
  const name = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (name !== 'HEAD') return name
  const sha = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  return 'detached at ' + sha
})()

// The holder a refusal has to name, as a regex: the lane, the branch, and the pid.
const OTHER_HOLDER = /on feat\/another \(pid 4242\)/

// Every lease object the script wrote, in order: the shim appends each one.
function leasesWritten (space) {
  if (!fs.existsSync(space.leases)) return []
  return fs.readFileSync(space.leases, 'utf8').split(/^---$/m).filter(block => block.trim()).map(block => JSON.parse(block))
}

test('a held lease refuses the run, and names the holder and the expiry', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const { status, output, calls } = run(space)

  assert.equal(status, 2, output)
  assert.match(output, /held by "monoplayer-gate-aaaaaaa-000000 /)
  assert.match(output, OTHER_HOLDER)
  assert.match(output, /until \d{4}-\d{2}-\d{2}T[0-9:.]+Z/)
  assert.match(output, /\([0-9]+m left\)/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
  assert.equal(calls.some(line => line.includes(' apply ')), false, 'no pod was created: ' + calls.join(' | '))
  assert.deepEqual(leasesWritten(space), [], 'a refused run wrote nothing')
})

test('an expired lease is taken without asking', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held({ renewTime: new Date(NOW - 3600000).toISOString() }))
  const { status, output, calls } = run(space)

  assert.equal(status, 0, output)
  const written = leasesWritten(space)
  assert.equal(written.length, 2, 'taken and released: ' + JSON.stringify(written))
  // The branch may be `detached at <sha>`, which has spaces: CI checks out a merge.
  assert.match(written[0].spec.holderIdentity, /^monoplayer-gate-\S+ on .+ \(pid \d+\)$/)
  assert.equal(written[0].spec.leaseTransitions, 2, 'a takeover of a dead holder is a transition')
  assert.equal(written[1].spec.holderIdentity, '', 'released on the way out')
  assert.ok(calls.some(line => line.includes('online.js')), 'the rung ran: ' + calls.join(' | '))
})

test('a lease nobody holds is created, and released with a replace', () => {
  const space = workspace()
  const { status, calls } = run(space)

  assert.equal(status, 0)
  const first = calls.find(line => / (create|replace) -f /.test(line))
  assert.match(first ?? '', / create -f /, 'the first write created the lease: ' + calls.join(' | '))
  assert.equal(leasesWritten(space).length, 2, 'created, then released')
})

test("the holder names this worktree's lane and its branch", () => {
  const space = workspace()
  const { status, output } = run(space)

  assert.equal(status, 0, output)
  const taken = leasesWritten(space)[0]
  assert.ok(
    taken.spec.holderIdentity.startsWith(LANE + ' on ' + BRANCH + ' (pid '),
    'the holder is this run: ' + taken.spec.holderIdentity
  )
  assert.match(taken.spec.holderIdentity, /\(pid \d+\)$/)
})

test('the lease is released when the rung fails, and the exit status survives', () => {
  const space = workspace()
  const { status, calls } = run(space, { KUBECTL_RUN_STATUS: '1' })

  assert.equal(status, 1)
  const written = leasesWritten(space)
  assert.equal(written[written.length - 1].spec.holderIdentity, '', 'released on the failure path')
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is still deleted')
})

test('--lease-wait queues behind the holder, then takes the lease when it is free', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const { status, output } = run(space,
    { KUBECTL_LEASE_ONCE: '1', MONOPLAYER_LEASE_POLL: '0' },
    [...podArgs(space), '--lease-wait', '5'])

  assert.equal(status, 0, output)
  assert.match(output, /waiting for the account lease/)
  assert.ok(leasesWritten(space).length >= 2, 'taken after the wait and released')
})

test('a lease that cannot be read refuses the run instead of guessing', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_LEASE_READ_ERROR: '1' })

  assert.equal(status, 1, output)
  assert.match(output, /cannot read the lease/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
})

test('the lease is never held in a gate lane, which one worktree owns and the reaper deletes', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { MONOPLAYER_CLUSTER_NAMESPACE: 'monoplayer-gate-x' })

  assert.equal(status, 2, output)
  assert.match(output, /refusing to hold the account lease/)
  assert.deepEqual(calls, [], 'nothing reached the cluster')
})

test('hold takes the lease around a command, and gives the command its exit status', () => {
  const space = workspace()
  const { status, output } = run(space, {}, ['hold', 'sh', '-c', 'exit 7'])

  assert.equal(status, 7, output)
  const written = leasesWritten(space)
  assert.equal(written.length, 2, 'taken and released: ' + JSON.stringify(written))
  assert.equal(written[1].spec.holderIdentity, '')
  assert.equal(fs.existsSync(space.manifest), false, 'hold creates no pod: it runs on this machine')
})

test('hold refuses while another run holds the lease, and runs nothing', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const marker = path.join(space.root, 'ran')
  const { status, output } = run(space, {}, ['hold', 'sh', '-c', 'touch ' + marker])

  assert.equal(status, 2, output)
  assert.equal(fs.existsSync(marker), false, 'the command never ran')
  assert.match(output, OTHER_HOLDER)
})

test('a run longer than the lease renews it, so a live run keeps the account', () => {
  const space = workspace()
  // Three seconds of lease, an interval of one, and a rung that takes two: the
  // renewal has two chances, and the release still comes last.
  const { status, output } = run(space, {
    MONOPLAYER_LEASE_DURATION: '3',
    KUBECTL_RUN_SLEEP: '2'
  })

  assert.equal(status, 0, output)
  const written = leasesWritten(space)
  assert.ok(written.length >= 3, 'taken, renewed, released: ' + JSON.stringify(written))
  assert.equal(written[0].spec.holderIdentity, written[1].spec.holderIdentity, 'the same run renews its own lease')
  assert.ok(Date.parse(written[1].spec.renewTime) >= Date.parse(written[0].spec.renewTime), 'the renewal moves the clock forward')
  assert.equal(written[written.length - 1].spec.holderIdentity, '')
})

// The task is where the guarantee is delivered: `mise run online` is the bare rung, and
// it is the form that reads this machine's copy of the chain.
test('mise run online holds the lease, so both forms of the rung exclude each other', () => {
  const tasks = readMiseTasks()
  const online = tasks.get('online')
  assert.match(online.body, /scripts\/online-cluster\.sh hold/, 'the bare rung holds the lease: ' + online.body)
  assert.match(online.body, /node src\/ladder\/online\.js/, 'and still runs the rung: ' + online.body)
  assert.deepEqual(online.depends, ['install'])
  assert.deepEqual(online.wait_for, ['check'], 'a red gate still stops the expensive rung')
  assert.match(tasks.get('online:cluster').body, /^run = "scripts\/online-cluster\.sh"$/m)
})

// A run killed outright runs no EXIT handler. The renewal loop is the only thing left
// that can notice, and it must not keep renewing an account nobody is using.
test('a run killed with SIGKILL releases its lease instead of renewing for ever', async () => {
  const space = workspace()
  const child = spawn('bash', [SCRIPT, ...podArgs(space)], {
    cwd: space.root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_MANIFEST: space.manifest,
      KUBECTL_PUPPET: PUPPET,
      KUBECTL_ATTACH: ATTACH,
      KUBECTL_LEASE: space.lease,
      KUBECTL_LEASES: space.leases,
      MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
      // One second of lease and a rung that never ends on its own.
      MONOPLAYER_LEASE_DURATION: '3',
      KUBECTL_RUN_SLEEP: '30'
    }
  })

  const held = async () => {
    for (let i = 0; i < 120; i += 1) {
      const written = leasesWritten(space)
      if (written.length > 0 && written[written.length - 1].spec.holderIdentity === '' ) return written
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return leasesWritten(space)
  }
  // Wait for the renewal loop to tick, not merely for the lease to be written. The run
  // writes the lease and then starts the loop, so a kill in between leaves nothing to
  // release and the lease only expires: that is the product's fallback for a run killed
  // outright, and it is not what this case measures. One renewal stamps the same holder
  // with a new renewTime, which is proof the loop exists.
  for (let i = 0; i < 200 && leasesWritten(space).length < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(leasesWritten(space).length >= 2, 'the renewal loop ticked before the run was killed')
  child.kill('SIGKILL')

  const written = await held()
  assert.equal(
    written[written.length - 1].spec.holderIdentity,
    '',
    'the lease was released by the loop that outlived the run: ' + JSON.stringify(written)
  )
})

// The other half of exclusivity: a run that loses the lease must stop. If it carried
// on, it would write the refresh chain beside the run that now holds the lease.
test('a run whose lease is taken over stops instead of writing the chain twice', () => {
  const space = workspace()
  fs.writeFileSync(space.foreign, held({ holderIdentity: 'monoplayer-gate-zzzzzzz-111111 on feat/other (pid 7)' }))
  const { status, output } = run(space, {
    // One second of lease, a rung that would run for six, and a holder who takes the
    // lease after this run's own acquisition read.
    MONOPLAYER_LEASE_DURATION: '3',
    KUBECTL_RUN_SLEEP: '6',
    KUBECTL_LEASE_FOREIGN_AFTER: '1'
  })

  assert.notEqual(status, 0, output)
  assert.match(output, /is no longer this run's/)
  assert.match(output, /Stopping, because two runs must not write one refresh chain/)
})

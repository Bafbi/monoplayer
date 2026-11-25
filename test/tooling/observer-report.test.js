// scripts/observer-report.sh installs the observer, runs the direct baseline join
// and the puppet join, and compares what the server recorded (#12). These cases
// replace kubectl with a shim, so nothing here reaches a cluster, installs a
// plugin, or reads a token. The shim records every argv: the guarantees are made
// of that record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANE } from '../support/lane.js'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'observer-report.sh'
)

const PUPPET = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const POD = 'paper-abc123'

// LANE, the lane this worktree's rung derives (#279), is mirrored once in
// test/support/lane.js: a script that typed a name instead of deriving one could not
// match it.
//
// The label the lane's Paper deployment carries: the tree spells
// app.kubernetes.io/name: monoplayer-gate-__instance__-paper.
const PAPER_LABEL = LANE + '-paper'

// The shim answers the calls both scripts make, records every argv, and lets a
// case choose what the observer recorded.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'ATTACH="$KUBECTL_ATTACH"',
  'PUPPET="$KUBECTL_PUPPET"',
  'PAPER_LABEL="$KUBECTL_PAPER_LABEL"',
  'POD="$KUBECTL_POD"',
  'last="${@: -1}"',
  'case " $* " in',
  '  *" get pods "*) printf \'%s\' "$POD"; exit 0 ;;',
  // Three shapes of get deploy: the deployment's own selector label, its
  // container name, and the whole deployment for the puppet's env (matched last,
  // because a real kubectl resolves the jsonpath).
  '  *"matchLabels"*) printf \'%s\' "$PAPER_LABEL"; exit 0 ;;',
  '  *"containers[0].name"*) printf \'paper\'; exit 0 ;;',
  // The container restart count. It moves once per read unless the case models a
  // restart that never completes: that is how a slow start is reproduced without
  // waiting for one.
  '  *"restartCount"*) N=0; [ -f "$KUBECTL_STATE/restarts" ] && N=$(cat "$KUBECTL_STATE/restarts"); printf \'%s\' "$N"; [ "$KUBECTL_STUCK" = 1 ] || echo $((N+1)) > "$KUBECTL_STATE/restarts"; exit 0 ;;',
  '  *" get deploy "*) printf \'{"spec":{"selector":{"matchLabels":{"app.kubernetes.io/name":"%s"}},"template":{"spec":{"containers":[{"name":"paper","image":"ghcr.io/bafbi/monoplayer@sha256:deadbeef","env":[{"name":"MONOPLAYER_PUPPET_UUID","value":"%s"},{"name":"MONOPLAYER_PUPPET_ACCOUNTS_DIR","value":"/data/accounts"}]}]}}}}\\n\' "$PAPER_LABEL" "$PUPPET"; exit 0 ;;',
  '  *" logs "*) printf \'[Server] MonoplayerObserver wire listeners registered\\n\'; exit 0 ;;',
  '  *" apply "*) cat > /dev/null; printf \'pod/check created\\n\'; exit 0 ;;',
  '  *" wait "*) exit 0 ;;',
  // The gate Paper's own settings, which is where the absent reasons are read.
  '  *"server.properties"*) printf \'%s\\n\' "$KUBECTL_SERVER_PROPERTIES"; exit 0 ;;',
  // The account lease each join takes (#280). The joins are scripts/online-cluster.sh,
  // and the holder identity is where a run says which lane it holds the account for,
  // so that record is the assertion.
  '  *" create -f "*|*" replace -f "*) staged="\${@: -1}"; cp "$staged" "$KUBECTL_LEASE"; exit 0 ;;',
  // Two records per connection, as the plugin writes them: the join, then the
  // resource-pack status. The report has to merge each pair.
  '  *views.jsonl*) mkdir -p "$(dirname "$last")"; { printf \'%s\\n\' "$KUBECTL_BASELINE_VIEW"; printf \'%s\\n\' "$KUBECTL_BASELINE_LATE"; printf \'%s\\n\' "$KUBECTL_PUPPET_VIEW"; printf \'%s\\n\' "$KUBECTL_PUPPET_LATE"; } > "$last"; exit 0 ;;',
  // The attach account each join copies in and copies back (#370). The pod's copy holds
  // the profile, so the copy-back finds one. A shim that returned nothing would model a
  // pod whose attach directory vanished, and that is a failed run now.
  '  *" cp "*"/accounts/$ATTACH"*) case "$last" in',
  '    *:*) exit 0 ;;',
  '    *) mkdir -p "$last/$ATTACH"; printf \'{}\' > "$last/$ATTACH/live-cache.json"; printf \'{"uuid":"%s","name":"Bafbi","alias":"bafbi"}\' "$ATTACH" > "$last/$ATTACH/profile.json"; exit 0 ;;',
  '  esac ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-observer-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })

  const secrets = path.join(root, '.secrets', 'accounts', ATTACH)
  fs.mkdirSync(secrets, { recursive: true })
  fs.writeFileSync(path.join(secrets, 'profile.json'), JSON.stringify({ uuid: ATTACH, name: 'Bafbi', alias: 'bafbi' }))
  fs.writeFileSync(path.join(secrets, 'live-cache.json'), '{}')

  const jar = path.join(root, 'MonoplayerObserver-0.1.0.jar')
  fs.writeFileSync(jar, 'jar')
  const protocollib = path.join(root, 'ProtocolLib-9cb125f-plugin.jar')
  fs.writeFileSync(protocollib, 'jar')

  const state = path.join(root, 'kubectl-state')
  fs.mkdirSync(state, { recursive: true })

  return { root, bin, jar, protocollib, state, log: path.join(root, 'kubectl.log'), lease: path.join(root, 'lease.json') }
}

const view = (overrides = {}) => JSON.stringify({
  event: 'client_view',
  player: 'GlowSquidye',
  uuid: PUPPET,
  address: '203.0.113.7:52001',
  brand: 'fabric',
  locale: 'en_us',
  viewDistance: 10,
  mainHand: 'right',
  skinParts: 127,
  chatSession: true,
  transferred: false,
  resourcePack: 'accepted',
  ...overrides
})

function run (space, env = {}, args = []) {
  const childEnv = {
    ...process.env,
    PATH: space.bin + ':' + process.env.PATH,
    KUBECTL_LOG: space.log,
    KUBECTL_STATE: space.state,
    KUBECTL_STUCK: '0',
    KUBECTL_SERVER_PROPERTIES: [
      'enable-code-of-conduct=false',
      'resource-pack=',
      'online-mode=true'
    ].join('\n'),
    KUBECTL_PUPPET: PUPPET,
    KUBECTL_ATTACH: ATTACH,
    KUBECTL_POD: POD,
    KUBECTL_PAPER_LABEL: PAPER_LABEL,
    KUBECTL_BASELINE_VIEW: view({ address: '203.0.113.7:52001', resourcePack: null }),
    KUBECTL_BASELINE_LATE: view({ address: '203.0.113.7:52001', resourcePack: 'accepted' }),
    KUBECTL_PUPPET_VIEW: view({ address: '198.51.100.9:40000', resourcePack: null }),
    KUBECTL_PUPPET_LATE: view({ address: '198.51.100.9:40000', resourcePack: 'accepted' }),
    KUBECTL_LEASE: space.lease,
    MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
    MONOPLAYER_OBSERVER_JAR: space.jar,
    MONOPLAYER_PROTOCOLLIB_JAR: space.protocollib,
    ...env
  }
  // A lane in this machine's environment would make the mirror above and the
  // script's own derivation disagree, so the default case would measure the
  // environment instead of the derivation (#282).
  if (!Object.hasOwn(env, 'MONOPLAYER_GATE_NAMESPACE')) delete childEnv.MONOPLAYER_GATE_NAMESPACE
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: space.root,
    encoding: 'utf8',
    env: childEnv
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

test('one command installs the observer, runs both joins, and compares them', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.ok(calls.some(line => line.includes('MonoplayerObserver-0.1.0.jar')), 'the observer jar is installed')
  assert.ok(calls.some(line => line.includes('ProtocolLib')), 'the ProtocolLib it needs is installed')
  assert.ok(calls.some(line => line.includes('observer-baseline.js')), 'the direct baseline join ran')
  assert.ok(calls.some(line => line.includes('online.js')), 'the puppet join ran')
  assert.match(output, /PASS 13 fields/)
  const report = JSON.parse(fs.readFileSync(path.join(space.root, '.reports', 'observer-report.json'), 'utf8'))
  assert.equal(report.passed, true)
  assert.equal(report.fields.find(entry => entry.field === 'address').verdict, 'expected')
})

test('both joins speak the version the gate Paper serves', () => {
  const space = workspace()
  // An empty value forces the script's own default, which is the gate Paper's.
  const { status, output, calls } = run(space, { MONOPLAYER_VERSION: '' })
  assert.equal(status, 0, output)
  const manifest = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'driver', 'paper.yaml'),
    'utf8'
  )
  const version = manifest.match(/- name: VERSION\n\s+value: "?([^"\n]+)"?/)[1]
  const joins = calls.filter(line => line.includes(' /work && node '))
  assert.equal(joins.length, 2, 'both joins run: ' + calls.join(' / '))
  for (const join of joins) {
    assert.ok(join.includes('MONOPLAYER_VERSION=' + version),
      'the join speaks ' + version + ', the version the gate Paper serves: ' + join)
  }
})

test('the install finds the gate Paper by the label its deployment carries', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  const podLookup = calls.find(line => line.includes('get pods'))
  assert.ok(podLookup, 'the script looks the Paper pod up: ' + calls.join(' / '))
  assert.ok(podLookup.includes('app.kubernetes.io/name=' + PAPER_LABEL),
    'the pod lookup uses the selector the deployment carries: ' + podLookup)
})

test('the run measures the gate-serving Paper by default', () => {
  // #78: the observer's lane is `paper-conduct`, because the G0 Paper cannot serve
  // the code of conduct. Both the plugin install and the join backend have to name
  // it, or the report measures one server and installs into another.
  const space = workspace()
  const { status, output, calls } = run(space, { MONOPLAYER_OBSERVER_PAPER_DEPLOYMENT: '', MONOPLAYER_BACKEND_HOST: '' })
  assert.equal(status, 0, output)
  const deployment = calls.find(line => line.includes('matchLabels'))
  assert.ok(deployment.includes('get deploy paper-conduct'), 'the install targets the conduct lane: ' + deployment)
  const joins = calls.filter(line => line.includes(' /work && node '))
  assert.equal(joins.length, 2, 'both joins run: ' + calls.join(' / '))
  assert.equal(joins.every(line => line.includes('paper-conduct.' + LANE + '.svc.cluster.local')), true,
    "both joins speak to this worktree's lane: " + joins.join(' / '))
})

test('the run never changes the live deployment', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  // The joins reuse the throwaway-pod path in the live namespace, which is how
  // the custody is copied without being shared. What it may never do is change
  // the deployment itself.
  for (const verb of ['scale', 'patch', 'rollout', 'set env', 'delete deploy', 'delete pvc']) {
    assert.equal(calls.some(line => line.includes(verb)), false, 'no ' + verb + ': ' + calls.join(' / '))
  }
  const deletions = calls.filter(line => line.trim().split(/\s+/).includes('delete'))
  assert.ok(deletions.length > 0, 'the throwaway pods are deleted')
  assert.equal(deletions.every(line => /\bdelete pod\b/.test(line)), true, 'only pods are deleted: ' + deletions.join(' / '))
})

test('the readiness wait reads the new container, not the previous log', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  // #79: the marker line lives in the log of every container this pod has ever
  // run, so a grep over the whole log satisfies itself on the previous boot and
  // hands the joins a server that is still starting. Two facts make the wait
  // mean the new process: the restart count moved, and the log read starts at
  // the kill.
  const kill = calls.findIndex(line => line.includes('kill 1'))
  assert.ok(kill >= 0, 'the install restarts the container: ' + calls.join(' / '))
  const counted = calls.findIndex(line => line.includes('restartCount'))
  assert.ok(counted >= 0, 'the wait reads the container restart count: ' + calls.join(' / '))
  assert.ok(counted < kill, 'the count is read before the kill, so a count that did not move means no restart')
  const reads = calls.filter(line => line.includes(' logs '))
  assert.ok(reads.length > 0, 'the wait reads the log')
  assert.equal(reads.every(line => line.includes('--since-time=')), true,
    'every readiness read is scoped to the log written since the kill: ' + reads.join(' / '))
  assert.equal(reads.every(line => line.includes('-c paper')), true,
    'the log read names the container the deployment declares: ' + reads.join(' / '))
})

test('a gate Paper that never finishes starting is reported as a start, not a join', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_STUCK: '1' }, ['--timeout', '1'])
  assert.equal(status, 2, output)
  assert.match(output, /did not finish starting/)
  assert.match(output, /not a join failure/)
  assert.equal(calls.some(line => line.includes('observer-baseline.js')), false,
    'a server that never started never gets a join: ' + calls.join(' / '))
  assert.equal(calls.some(line => line.includes('online.js')), false,
    'neither join runs after a start that did not finish: ' + calls.join(' / '))
})

test('the install clears the previous run view log before the restart', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  // The gate Paper's /data survives a container restart, so the log of the last
  // run is still there. Reading it would compare the previous run's baseline with
  // this run's puppet, and that has already happened once (#78).
  const cleared = calls.findIndex(line => line.includes('views.jsonl') && line.includes('rm -f'))
  assert.ok(cleared >= 0, 'the install clears the view log: ' + calls.join(' / '))
  const kill = calls.findIndex(line => line.includes('kill 1'))
  assert.ok(cleared < kill, 'the log is cleared before the restart, so the new container starts a fresh one')
})

test('the plugin install only ever names the gate namespace', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  const installs = calls.filter(line => line.includes('/data/plugins') || line.includes('kill 1'))
  assert.ok(installs.length > 0, 'the install ran')
  assert.equal(installs.every(line => line.startsWith('-n ' + LANE + ' ')), true, installs.join(' / '))
})

// --- one lane per run (#282) ---------------------------------------------------
//
// The backend host was computed from MONOPLAYER_GATE_NAMESPACE before the argument
// parser that sets it ran, so --namespace moved the install and left the joins on
// the default lane. The run then reported a comparison of a backend nobody
// measured. The lane is decided once now, after the arguments, and both joins and
// both leases read that one value.

test('--namespace names the lane the run measures and the backend it dials', () => {
  const space = workspace()
  const { status, output, calls } = run(space, {}, ['--namespace', 'monoplayer-gate-x'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))

  const installs = calls.filter(line => line.includes('/data/plugins') || line.includes('kill 1'))
  assert.ok(installs.length > 0, 'the install ran')
  assert.equal(installs.every(line => line.startsWith('-n monoplayer-gate-x ')), true,
    'the install reads the lane the argument named: ' + installs.join(' / '))

  const joins = calls.filter(line => line.includes(' /work && node '))
  assert.equal(joins.length, 2, 'both joins run: ' + calls.join(' / '))
  assert.equal(joins.every(line => line.includes('MONOPLAYER_BACKEND_HOST=paper-conduct.monoplayer-gate-x.svc.cluster.local')), true,
    'both joins dial the lane the argument named: ' + joins.join(' / '))
  // The argument decides, so this worktree's lane must not appear at all. A lane
  // prefix would be too broad a needle: a derived lane starts with its own commit.
  assert.equal(calls.some(line => line.includes('paper-conduct.' + LANE + '.')), false,
    "nothing dials this worktree's lane while the argument names another: " + calls.join(' / '))
})

test('both joins hold the account for the lane the run measures', () => {
  // The joins are scripts/online-cluster.sh, and after #301 each one names its lane
  // in the account lease. A run whose install named one lane and whose lease named
  // another would be two lanes again, one level down.
  const space = workspace()
  const { status, output, calls } = run(space, {}, ['--namespace', 'monoplayer-gate-x'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const lease = JSON.parse(fs.readFileSync(space.lease, 'utf8'))
  assert.ok(lease.spec.holderIdentity.startsWith('monoplayer-gate-x on '),
    'the lease names the lane the backend dials: ' + lease.spec.holderIdentity)
})

test('a lane named two ways is refused rather than picked', () => {
  // Two names for one run is the defect this ticket closes, so the run stops
  // instead of choosing. Nothing is installed and no join starts.
  const space = workspace()
  const { status, output, calls } = run(space, { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-y' }, ['--namespace', 'monoplayer-gate-x'])
  assert.equal(status, 2, output)
  assert.match(output, /monoplayer-gate-x/, 'the refusal names the lane the argument gave: ' + output)
  assert.match(output, /monoplayer-gate-y/, 'and the lane the variable gave: ' + output)
  assert.deepEqual(calls, [], 'kubectl was never called: ' + calls.join(' / '))
})

test("a run that names no lane measures this worktree's", () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  const joins = calls.filter(line => line.includes(' /work && node '))
  assert.equal(joins.every(line => line.includes('MONOPLAYER_BACKEND_HOST=paper-conduct.' + LANE + '.svc.cluster.local')), true,
    "the default backend is this worktree's lane: " + joins.join(' / '))
  const lease = JSON.parse(fs.readFileSync(space.lease, 'utf8'))
  assert.ok(lease.spec.holderIdentity.startsWith(LANE + ' on '),
    'and the same lane holds the account: ' + lease.spec.holderIdentity)
})

test('a lane that cannot be derived refuses, and keeps the sentence that says how', () => {
  const space = workspace()
  const notGit = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-not-git-'))
  const { status, output, calls } = run(space, { MONOPLAYER_GATE_WORKTREE: notGit })
  assert.equal(status, 2, output)
  assert.match(output, /cannot derive this worktree's lane/)
  assert.match(output, /Set MONOPLAYER_GATE_NAMESPACE to name one by hand/)
  assert.equal(calls.some(line => line.includes('observer-baseline.js')), false, 'nothing dialled: ' + calls.join(' / '))
})

test('an asleep gate lane is named, with the task that wakes it', () => {
  // #115: the lane rests at 0 replicas, so "no pod" is the normal state of a cold
  // lane and not a broken deployment. The refusal sends a reader to gate:up.
  const space = workspace()
  const { status, output } = run(space, { KUBECTL_POD: '' })
  assert.equal(status, 2, output)
  assert.match(output, /the gate lane rests at 0 replicas/)
  assert.match(output, /mise run gate:up/)
})

test('measuring the live lane is refused before anything runs', () => {
  const space = workspace()
  const { status, output, calls } = run(space, {}, ['--namespace', 'monoplayer'])
  assert.equal(status, 2)
  assert.match(output, /never measures the live lane/)
  assert.deepEqual(calls, [], 'kubectl was never called')
})

test('the absent reasons are read from the gate Paper, not asserted', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  assert.ok(calls.some(line => line.includes('server.properties')), 'the run reads the server settings')
  const report = JSON.parse(fs.readFileSync(path.join(space.root, '.reports', 'observer-report.json'), 'utf8'))
  assert.match(report.fields.find(entry => entry.field === 'codeOfConduct').reason, /enable-code-of-conduct=false/)
  assert.match(output, /2 absent \(2 with a reason\)/)
})

test('a gate Paper that serves the gate stops excusing the field', () => {
  // The point of reading the facts: if someone turns the gate on for a run like
  // this one, an absent codeOfConduct means the listener, not the setting, and the
  // report must say so.
  const space = workspace()
  const { status, output } = run(space, {
    KUBECTL_SERVER_PROPERTIES: ['enable-code-of-conduct=true', 'resource-pack=https://example.invalid/pack.zip'].join('\n')
  })
  assert.equal(status, 0, output)
  const report = JSON.parse(fs.readFileSync(path.join(space.root, '.reports', 'observer-report.json'), 'utf8'))
  assert.equal(report.fields.find(entry => entry.field === 'codeOfConduct').reason, null)
  assert.match(output, /0 with a reason, 2 without: codeOfConduct, codeOfConductAccepted/)
})

test('an unexplained difference fails the run', () => {
  const space = workspace()
  const { status, output } = run(space, {
    KUBECTL_PUPPET_VIEW: view({ address: '198.51.100.9:40000', brand: 'vanilla', resourcePack: null }),
    KUBECTL_PUPPET_LATE: view({ address: '198.51.100.9:40000', brand: 'vanilla', resourcePack: 'accepted' })
  })
  assert.equal(status, 1, output)
  assert.match(output, /FAIL 1 unexplained: brand/)
})

test('a missing observer jar is refused with what to run', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { MONOPLAYER_OBSERVER_JAR: path.join(space.root, 'missing.jar') })
  assert.equal(status, 2)
  assert.match(output, /mise run observer:build/)
  assert.deepEqual(calls, [], 'nothing was installed')
})

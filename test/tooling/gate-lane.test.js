// The gate lane's lifecycle (#115). The lane is `monoplayer-gate-b`: real Papers,
// a Velocity, and a toxiproxy. It is not in Argo CD, no rung scales it, and the
// resting state used to be 6 GiB of servers nothing was driving.
//
// Nothing here reaches a cluster: the manifest cases read the files, and the
// script cases replace kubectl with a shim that records every argv.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const TOXIPROXY = read('deploy/driver/toxiproxy.yaml')

// The proxies the ConfigMap asks toxiproxy to serve: the listen port, the
// upstream, and whether it is on at pod start.
function proxies (text) {
  const block = text.match(/proxies\.json: \|\n([\s\S]*?)\n---/)
  assert.ok(block, 'the ConfigMap holds proxies.json')
  return [...block[1].matchAll(/\{([^}]*)\}/g)].map(match => {
    const field = key => match[1].match(new RegExp('"' + key + '":\\s*"?([^",\n]+)"?'))?.[1]
    return {
      name: field('name'),
      listen: Number(field('listen')?.split(':').pop()),
      upstream: field('upstream'),
      enabled: field('enabled') === 'true'
    }
  })
}

const NAMED_PORTS = text => [...text.matchAll(/- name: (px-[a-z0-9-]+)\n\s+containerPort: (\d+)/g)]
  .map(match => ({ name: match[1], port: Number(match[2]) }))

const SERVICE_PORTS = text => [...text.matchAll(/- name: (px-[a-z0-9-]+)\n\s+port: (\d+)\n\s+targetPort: (px-[a-z0-9-]+)/g)]
  .map(match => ({ name: match[1], port: Number(match[2]), targetPort: match[3] }))

test('toxiproxy serves only the listeners that have a backend in this tree', () => {
  // #115: puppet-vanilla and puppet-fabric pointed at vanilla:25565 and
  // fabric:25565. Neither Service exists anywhere in deploy/, both rows are
  // M1/M3 work that has not landed, and both proxies sat disabled, so the two
  // ports were published for nobody. They come back with their rows, not before.
  const names = proxies(TOXIPROXY).map(proxy => proxy.name)
  assert.deepEqual(names, ['puppet-velocity', 'puppet-paper-m4'], 'only the M4 listeners are configured')
  const ports = proxies(TOXIPROXY).map(proxy => proxy.listen)
  assert.deepEqual(ports, [25570, 25573], '25571 and 25572 are gone with their rows')
})

test('puppet-velocity still forwards the M4 row', () => {
  // The one listener a rung drills through (src/driver/backends.js: talking to
  // paper-m4 through Velocity is the M4/M5 route). Dropping the dead rows must
  // leave it byte-for-byte useful.
  const velocity = proxies(TOXIPROXY).find(proxy => proxy.name === 'puppet-velocity')
  assert.deepEqual(velocity, { name: 'puppet-velocity', listen: 25570, upstream: 'velocity:25566', enabled: true })
})

test('every toxiproxy Service port resolves to a container port it names', () => {
  // A Service whose targetPort names no container port forwards nothing, and a
  // container port no proxy listens on is a hole in the pod's network. The
  // three lists have to agree for the manifest to mean what it says.
  const listen = new Set(proxies(TOXIPROXY).map(proxy => proxy.listen))
  const container = NAMED_PORTS(TOXIPROXY)
  const service = SERVICE_PORTS(TOXIPROXY)

  assert.deepEqual(container.map(port => port.port).sort(), [...listen].sort(), 'container ports match the proxies')
  assert.deepEqual(service.map(port => port.port).sort(), [...listen].sort(), 'Service ports match the proxies')
  for (const port of service) {
    assert.equal(port.targetPort, port.name, 'Service port ' + port.name + ' targets its own container port')
    assert.ok(container.some(entry => entry.name === port.targetPort), port.name + ' names a real container port')
  }
  // The API port is not a listener: it is the one the fault rig talks to.
  assert.match(TOXIPROXY, /containerPort: 8474/, 'the HTTP API port stays')
})

// ---------------------------------------------------------------------------
// The lifecycle: two tasks, one script, and a lane whose resting state is off.

const DRIVER = path.join(ROOT, 'deploy', 'driver')
const SCRIPT = path.join(ROOT, 'scripts', 'gate-lane.sh')

const driverManifests = () => fs.readdirSync(DRIVER)
  .filter(name => name.endsWith('.yaml') && name !== 'kustomization.yaml')
  .map(name => ({ name, text: fs.readFileSync(path.join(DRIVER, name), 'utf8') }))

// The Deployments the tree declares: kind, then the metadata name.
const deployments = () => driverManifests()
  .flatMap(({ text }) => [...text.matchAll(/^kind: Deployment\nmetadata:\n  name: (\S+)\n  namespace: /gm)].map(match => match[1]))

const script = () => fs.readFileSync(SCRIPT, 'utf8')

// The lists the script carries: the gate's workloads, and the rows a rung drives.
const gateWorkloads = () => script().match(/^GATE_WORKLOADS="([^"]+)"/m)[1].split(' ')
const drivenWorkloads = () => script().match(/^DRIVEN_WORKLOADS="([^"]+)"/m)[1].split(' ')

// The shim answers every call the script makes and prints each argv to stdout,
// so a case can assert not only what was called but in what order it happened.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\n\' "$*" >> "$KUBECTL_LOG"',
  // The trace goes to stderr, which run() merges back in: a shim that wrote it
  // to stdout would land inside the script's own command substitutions.
  'printf \'shim %s\n\' "$*" >&2',
  'state="$KUBECTL_STATE"',
  'count () { n=0; [ -f "$state/$1" ] && n=$(cat "$state/$1"); echo $((n+1)) > "$state/$1"; printf \'%s\' "$n"; }',
  'case " $* " in',
  '  *" apply -k "*) cat > /dev/null; printf \'configured\n\'; exit 0 ;;',
  '  *" scale "*) printf \'scaled\n\'; exit 0 ;;',
  '  *" get secret "*) if [ "${KUBECTL_SECRET_MISSING:-0}" = 1 ]; then printf \'not found\n\' >&2; exit 1; fi; exit 0 ;;',
  // A readiness read answers empty until the case lets it answer 1. The counter
  // is per call, so "not ready yet" is a first read rather than a fixed answer.
  '  *"readyReplicas"*) if [ "$(count ready)" -lt "${KUBECTL_READY_AFTER:-0}" ]; then exit 0; fi; printf \'1\'; exit 0 ;;',
  // The pod listing a stop waits on: a pod on the first listing, none after.
  '  *" get pods "*) if [ "${KUBECTL_PODS_STUCK:-0}" = 1 ]; then printf \'pod/gate-stuck\n\'; exit 0; fi; if [ "$(count pods)" -lt 1 ]; then printf \'pod/gate-abc\n\'; fi; exit 0 ;;',
  '  *" get deploy "*) printf \'1\'; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function space () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-gate-lane-'))
  const bin = path.join(root, 'bin')
  const state = path.join(root, 'state')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  return { root, bin, state, log: path.join(root, 'kubectl.log') }
}

function run (where, args = [], env = {}) {
  // One pipe for both streams, so the trace and the script's own lines keep
  // their order: the wait is asserted to be announced before it starts.
  const result = spawnSync('bash', ['-c', 'exec bash "$0" "$@" 2>&1', SCRIPT, ...args], {
    cwd: where.root,
    encoding: 'utf8',
    // An empty stdin, so the shim's `cat > /dev/null` sees EOF instead of
    // waiting for a writer that never comes.
    input: '',
    env: {
      ...process.env,
      PATH: where.bin + ':' + process.env.PATH,
      KUBECTL_LOG: where.log,
      KUBECTL_STATE: where.state,
      // Nothing here should wait: the real interval is five seconds.
      MONOPLAYER_GATE_POLL: '0',
      ...env
    }
  })
  const calls = fs.existsSync(where.log)
    ? fs.readFileSync(where.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

// The deployments one scale call names, and the count it asks for.
function scaled (calls) {
  return calls
    .filter(line => /\bscale deploy\b/.test(line))
    .map(line => {
      const words = line.trim().split(/\s+/)
      const at = words.indexOf('deploy')
      return { names: words.slice(at + 1).filter(word => !word.startsWith('--')), replicas: Number(line.match(/--replicas=(\d+)/)[1]) }
    })
}

test('the lane rests at 0 replicas in the tree, so an apply cannot wake it', () => {
  // #115: every gate Deployment committed replicas: 1, so the one documented
  // bring-up (kubectl apply -k deploy/driver) started 6,214 MiB of servers for
  // runs that last minutes. The manifest is the resting state now: an apply is a
  // no-op on a lane that is off, and gate:up is what wakes it.
  assert.equal(deployments().length, 5, 'the tree declares five workloads')
  for (const { name, text } of driverManifests()) {
    for (const match of text.matchAll(/^  replicas: (\d+)$/gm)) {
      assert.equal(match[1], '0', name + ' rests at 0 replicas')
    }
  }
  assert.equal(driverManifests().flatMap(({ text }) => [...text.matchAll(/^  replicas: /gm)]).length, 5,
    'every workload declares its replica count, so the resting state is visible in the file')
})

test('gate:up wakes the rows a rung drives and says how long it will wait', () => {
  const where = space()
  const { status, output, calls } = run(where, ['up'])
  assert.equal(status, 0, output)
  assert.ok(calls.some(line => line.includes('apply -k ' + path.join(ROOT, 'deploy', 'driver'))),
    'the tree is applied: ' + calls.join(' | '))
  // A cold start is 90 s (#115, measured on the 26.2 gate Paper). A task that waits
  // in silence reads as a hang, so the budget and the cost both come first.
  assert.match(output, /waiting up to 900s/, 'the wait names its budget')
  assert.match(output, /cold start is 90 s from 0 to ready/, 'and the cost of a cold start')
  // The 240-310 s in the docs is a Paper restart loading the observer, which is a
  // different wait: saying so here stops a reader trusting the wrong number.
  assert.match(output, /240-310 s/, 'the longer restart figure is placed, not confused')
  const printed = output.indexOf('waiting up to')
  const firstRead = output.indexOf('readyReplicas')
  assert.ok(printed >= 0 && firstRead >= 0 && printed < firstRead,
    'the budget is printed before the first readiness read, not after it: ' + printed + ' vs ' + firstRead + '\n' + output)
})

test('gate:up wakes only what it was asked for, and never the testbed', () => {
  const where = space()
  const { status, output, calls } = run(where, ['up'])
  assert.equal(status, 0, output)
  assert.deepEqual(scaled(calls), [{ names: drivenWorkloads(), replicas: 1 }],
    'the default set is the rows a rung drives: ' + calls.join(' | '))
  assert.deepEqual(drivenWorkloads(), ['paper', 'paper-conduct'], 'and those are paper and paper-conduct')

  // The M4 rows cost 2.7 GiB and no rung drives them, so they wake by name.
  const m4 = run(space(), ['up', 'velocity', 'paper-m4', 'toxiproxy'])
  assert.equal(m4.status, 0, m4.output)
  assert.deepEqual(scaled(m4.calls), [{ names: ['velocity', 'paper-m4', 'toxiproxy'], replicas: 1 }],
    'the names given are the names woken: ' + m4.calls.join(' | '))
  for (const line of m4.calls) {
    assert.doesNotMatch(line, /paper-hub|paper-sky/, 'the transfer testbed is never scaled: ' + line)
  }
})

test('gate:up refuses a name the gate does not own before it scales anything', () => {
  const where = space()
  const { status, output, calls } = run(where, ['up', 'paper-hub'])
  assert.equal(status, 2, output)
  assert.match(output, /unknown gate deployment/)
  assert.deepEqual(calls, [], 'kubectl was never called')
})

test('the script knows exactly the deployments the tree declares', () => {
  // Two lists of one thing: the manifests, and what down scales. A sixth
  // workload that lands without joining the list would run forever again.
  assert.deepEqual(gateWorkloads().sort(), deployments().sort(), 'GATE_WORKLOADS matches deploy/driver')
})

test('gate:down takes the whole lane to 0 and waits for the pods to go', () => {
  const where = space()
  const { status, output, calls } = run(where, ['down'])
  assert.equal(status, 0, output)
  assert.deepEqual(scaled(calls), [{ names: gateWorkloads(), replicas: 0 }],
    'one scale call, every gate workload, 0: ' + calls.join(' | '))
  // Scaling returns before the pods do. A task that returns at the scale leaves
  // an operator reading "off" while Paper is still shutting down.
  const listings = calls.filter(line => /get pods/.test(line)).length
  assert.ok(listings > gateWorkloads().length, 'the pods are read more than once: ' + listings)
  assert.match(output, /waiting up to 180s for their pods to go/)
  // Nothing is deleted: the Secrets are hand-created (deploy/driver/README.md)
  // and the emptyDir worlds die with their pods either way.
  assert.equal(calls.some(line => /\bdelete\b/.test(line)), false, 'no delete: ' + calls.join(' | '))
  assert.match(output, /emptyDir/, 'the task says the world is gone, so a reader expects the cold start')
})

test('gate:down that cannot stop the lane fails instead of claiming it', () => {
  const { status, output } = run(space(), ['down'], { KUBECTL_PODS_STUCK: '1', MONOPLAYER_GATE_STOP_TIMEOUT: '0' })
  assert.equal(status, 1, output)
  assert.match(output, /pods still running after 0s/)
})

test('a lane that never gets ready is a start failure, not a silent success', () => {
  const { status, output } = run(space(), ['up'], { KUBECTL_READY_AFTER: '99', MONOPLAYER_GATE_READY_TIMEOUT: '0' })
  assert.equal(status, 1, output)
  assert.match(output, /still not ready after 0s/)
  assert.match(output, /cold start is 90 s from 0 to ready/, 'the failure repeats the cost, so it is not read as a join failure')
})

test('the live and dev namespaces are refused before kubectl runs', () => {
  for (const namespace of ['monoplayer', 'monoplayer-dev', '']) {
    const { status, output, calls } = run(space(), ['down'], { MONOPLAYER_GATE_NAMESPACE: namespace })
    assert.equal(status, 2, output)
    assert.match(output, /refusing/)
    assert.deepEqual(calls, [], 'refusing "' + namespace + '" called no kubectl')
  }
})

test('a missing hand-created Secret is named before the wait, not after it', () => {
  // gate-b-rcon and gate-b-velocity are made by an operator, never by the tree.
  // Without them the pods sit in CreateContainerConfigError and gate:up would
  // spend its whole budget on a lane that cannot start.
  const { status, output, calls } = run(space(), ['up'], { KUBECTL_SECRET_MISSING: '1' })
  assert.equal(status, 2, output)
  assert.match(output, /gate-b-rcon/)
  assert.match(output, /deploy\/driver\/README\.md/)
  assert.equal(calls.some(line => / scale /.test(line)), false, 'nothing is woken: ' + calls.join(' | '))
})

test('mise offers the lifecycle, and the lint rung sees the script', () => {
  const toml = read('mise.toml')
  assert.match(toml, /^\[tasks\."gate:up"\]$/m, 'gate:up')
  assert.match(toml, /^\[tasks\."gate:down"\]$/m, 'gate:down')
  assert.match(toml, /^\[tasks\."gate:status"\]$/m, 'gate:status')
  assert.match(toml, /run = "scripts\/gate-lane\.sh up"/, 'gate:up runs the script')
  assert.match(toml, /run = "scripts\/gate-lane\.sh down"/, 'gate:down runs the script')
  // The lint task lists the shell scripts by hand, so a new one is silently
  // skipped by the gate unless it is added there.
  const lint = toml.match(/^\[tasks\.lint\][\s\S]*?^run = "(.*)"$/m)
  assert.ok(lint, 'the lint task has a run')
  assert.match(lint[1], /scripts\/gate-lane\.sh/, 'lint syntax-checks the script')
})


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
  // The word after "secret" in an argv: every Secret call the script makes is
  // `-n <ns> <verb> secret <name>`, so this reads the script's intent without
  // parsing its output.
  'arg_after () { local n=$1 prev="" w; shift; for w in "$@"; do [ "$prev" = "$n" ] && { printf "%s" "$w"; return; }; prev=$w; done; }',
  // The Secrets a case says are absent are the ones up has to generate. A list of
  // names, or "all", keeps one switch for every Secret in the lane.
  'absent () { case " ${KUBECTL_SECRET_MISSING:-} " in *" all "*) return 0 ;; *" $1 "*) return 0 ;; esac; return 1; }',
  'case " $* " in',
  // An apply reconciles the tree, so a case's awake row only reads as awake before one.
  // Removing that marker makes the read-after-apply ordering fail, which is the point.
  '  *" apply -k "*) cat > /dev/null; touch "$state/applied"; printf \'configured\n\'; exit 0 ;;',
  '  *" scale "*) printf \'scaled\n\'; exit 0 ;;',
  // A Secret that exists is answered as it is: up must not touch it. A missing one
  // answers the way kubectl does, which is what sends up down the generate path.
  '  *" get secret "*) name=$(arg_after secret "$@"); if absent "$name"; then printf \'Error from server (NotFound): secrets "%s" not found\n\' "$name" >&2; exit 1; fi; exit 0 ;;',
  // A generated Secret reaches kubectl on stdin, so a case reads exactly what up
  // wrote without up ever printing a value.
  // `printf "%s\\n" ---`, not `printf ---`: bash reads a format that starts with a
  // dash as an option and prints nothing, so the marker would vanish.
  '  *" apply -f -"*) { printf "%s\\n" ---; cat; } >> "$state/secrets.yaml"; printf \'configured\n\'; exit 0 ;;',
  // A selector that matches nothing is what a lane with a hand-made Secret sees.
  '  *" delete secret "*) printf \'No resources found\n\' >&2; exit 0 ;;',
  // A readiness read answers empty until the case lets it answer 1. The counter
  // is per call, so "not ready yet" is a first read rather than a fixed answer.
  // The two replica reads, answered apart: spec.replicas is what the lane claims, and
  // KUBECTL_AWAKE names one row a case leaves running, so a second up can be shown to
  // keep it running.
  '  *".spec.replicas"*) awake="${KUBECTL_AWAKE:-none}"; if [ -f "$state/applied" ]; then printf \'0\'; exit 0; fi; case " $* " in *" $awake "*) printf \'1\' ;; *) printf \'0\' ;; esac; exit 0 ;;',
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

// The Secrets a run generated. The shim keeps the YAML each `apply -f -` was fed,
// so a case reads the value the run wrote without the run ever printing it.
function uploads (where) {
  const file = path.join(where.state, 'secrets.yaml')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/^---$/m).filter(block => block.trim()).map(block => ({
    name: block.match(/^  name: (\S+)$/m)[1],
    namespace: block.match(/^  namespace: (\S+)$/m)[1],
    managedBy: block.match(/app\.kubernetes\.io\/managed-by: (\S+)/)?.[1] ?? null,
    key: block.match(/^stringData:\n  (\S+): /m)[1],
    value: block.match(/^stringData:\n  \S+: (\S+)$/m)[1]
  }))
}

// A run in which no Secret exists, so up has to make every one it needs.
function generated (where, args, env = {}) {
  const result = run(where, args, { KUBECTL_SECRET_MISSING: 'all', ...env })
  return { ...result, made: uploads(where) }
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
  // The render of the tree is applied, not the tree itself: one substitution names
  // the lane everywhere the tree spells it (#277). The case below reads the render
  // back to prove it is not the directory in git.
  assert.ok(calls.some(line => line.includes('apply -k ')), 'the render of the tree is applied: ' + calls.join(' | '))
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
  // The one delete a stop makes is of the Secrets up generated, and it is by label
  // (#278). No workload, Service or ConfigMap goes: the emptyDir worlds die with
  // their pods either way.
  for (const line of calls.filter(call => /\bdelete\b/.test(call))) {
    assert.match(line, / delete secret -l app\.kubernetes\.io\/managed-by=gate-lane --ignore-not-found$/,
      'a stop deletes generated Secrets and nothing else: ' + line)
  }
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

test('a lane whose Secrets are absent makes random ones, and the value never leaves stdin', () => {
  // #278: a lane that has never run was blocked on an operator hand-making an RCON
  // password. paper-m4 reads both Secrets, so it is the one row that makes a run
  // create both.
  const where = space()
  const { status, output, calls, made } = generated(where, ['up', 'paper-m4'])
  assert.equal(status, 0, output)

  assert.deepEqual(made.map(secret => secret.name).sort(), ['gate-b-rcon', 'gate-b-velocity'])
  assert.deepEqual(made.map(secret => secret.key).sort(), ['forwarding-secret', 'password'])
  assert.deepEqual([...new Set(made.map(secret => secret.namespace))], ['monoplayer-gate-b'], 'both land in the lane')
  for (const secret of made) {
    assert.match(secret.value, /^[0-9a-f]{32}$/, secret.name + ' holds a 16-byte random value')
    // The rule that outranks the ticket: a value reaches neither a log line nor an
    // argv. `create secret --from-literal` would fail both.
    assert.equal(calls.some(line => line.includes(secret.value)), false, secret.name + ' value is in an argv')
    assert.equal(output.includes(secret.value), false, secret.name + ' value is on a printed line')
  }
  assert.notEqual(made[0].value, made[1].value, 'two Secrets, two values')
  assert.match(output, /created the random Secret gate-b-rcon \(password\)/)
  assert.match(output, /created the random Secret gate-b-velocity \(forwarding-secret\)/)
  // Created before the wake: a pod that starts without its Secret sits in
  // CreateContainerConfigError, which reads like a slow boot.
  const created = calls.findIndex(line => / apply -f -/.test(line))
  const woken = calls.findIndex(line => / scale /.test(line))
  assert.ok(created >= 0 && created < woken, 'the Secrets land before the scale: ' + calls.join(' | '))
})

test('a Secret that already exists is used as it is, and the run says so once', () => {
  // An operator's Secret outlives every up. Nothing here is created over it, and
  // the run says what it left alone in one line rather than one per Secret.
  const where = space()
  const { status, output, calls } = run(where, ['up', 'paper-m4'])
  assert.equal(status, 0, output)
  assert.equal(calls.some(line => / apply -f -/.test(line)), false, 'nothing is generated: ' + calls.join(' | '))

  const said = output.split('\n').filter(line => /this lane already has/.test(line))
  assert.equal(said.length, 1, 'said once, not once per Secret: ' + said.join(' | '))
  assert.match(said[0], /gate-b-rcon/)
  assert.match(said[0], /gate-b-velocity/)
})

test('the Secret a lane generates follows the Deployment that reads it', () => {
  // The map: the three Papers take the RCON password, and Velocity and the Paper
  // behind it take the forwarding secret. Generating one nothing reads is a value
  // nobody uses; skipping one a row reads is CreateContainerConfigError.
  const only = args => generated(space(), args).made.map(secret => secret.name).sort()
  assert.deepEqual(only(['up', 'paper']), ['gate-b-rcon'])
  assert.deepEqual(only(['up', 'paper-conduct']), ['gate-b-rcon'])
  assert.deepEqual(only(['up', 'velocity']), ['gate-b-velocity'])
  assert.deepEqual(only(['up', 'paper-m4']), ['gate-b-rcon', 'gate-b-velocity'])
})

test('the Secrets the lane generates are the two its Deployments mount', () => {
  // One list in two places: the secretKeyRef in the manifests, and the name and key
  // the script generates. A generated Secret nothing mounts is a value nobody reads.
  const mounted = [...new Set(driverManifests().flatMap(({ text }) =>
    [...text.matchAll(/secretKeyRef:\n\s+name: (gate-b-\S+)\n\s+key: (\S+)/g)].map(match => match[1] + ' ' + match[2])))]
  assert.deepEqual(mounted.sort(), ['gate-b-rcon password', 'gate-b-velocity forwarding-secret'], 'the tree mounts these two')
  const made = generated(space(), ['up', 'paper-m4']).made.map(secret => secret.name + ' ' + secret.key).sort()
  assert.deepEqual(made, mounted, 'the generated pair is exactly the mounted pair')
})

test('gate:down deletes the Secrets it generated, and a hand-made one is out of its reach', () => {
  // The label up writes is the selector down deletes by, so a Secret an operator
  // made carries no label, is never overwritten, and is never deleted. A lane that
  // was never up has nothing to select, and --ignore-not-found makes that a no-op.
  const where = space()
  const { made } = generated(where, ['up', 'paper-m4'])
  assert.ok(made.length > 0, 'the lane generated its Secrets')
  for (const secret of made) {
    assert.equal(secret.managedBy, 'gate-lane', secret.name + ' is marked as this script\'s')
  }

  const { status, output, calls } = run(where, ['down'])
  assert.equal(status, 0, output)
  assert.deepEqual(calls.filter(line => /\bdelete\b/.test(line)),
    ['-n monoplayer-gate-b delete secret -l app.kubernetes.io/managed-by=gate-lane --ignore-not-found'],
    'one delete, by the label up wrote: ' + calls.join(' | '))
  assert.match(output, /deleted every Secret this lane generated/)
  assert.match(output, /operator made has no app\.kubernetes\.io\/managed-by=gate-lane label/, 'and says why a hand-made one stayed')
})

test('a second up does not stop the row the first one woke', () => {
  // kubectl apply is a full reconcile: the tree says 0, so every apply stops a running
  // lane. The documented sequence is an observer run after an M4 fault row
  // (AGENTS.md), so waking paper-conduct must not take Velocity down underneath it.
  const { status, output, calls } = run(space(), ['up', 'paper-conduct'], { KUBECTL_AWAKE: 'velocity' })
  assert.equal(status, 0, output)
  assert.deepEqual(scaled(calls), [{ names: ['paper-conduct', 'velocity'], replicas: 1 }],
    'the woken rows are re-woken after the apply: ' + calls.join(' | '))
  assert.match(output, /woke velocity again after the apply/, 'and the task says it did that')
  // The read has to be before the apply: after it, the tree has the row at 0 and there
  // is nothing to notice. The shim stops answering 1 once it sees an apply.
  const applied = calls.findIndex(line => line.includes('apply -k '))
  const read = calls.findIndex(line => line.includes('velocity') && line.includes('.spec.replicas'))
  assert.ok(read >= 0 && read < applied, 'the awake rows are read before the apply: ' + calls.join(' | '))
  // The wait still covers only the rows this run asked for.
  assert.match(output, /ready after \d+s: paper-conduct$/m, 'only paper-conduct is waited on')

  // A row that is both awake and asked for is woken once, not twice.
  const both = run(space(), ['up', 'paper-conduct'], { KUBECTL_AWAKE: 'paper-conduct' })
  assert.equal(both.status, 0, both.output)
  assert.deepEqual(scaled(both.calls), [{ names: ['paper-conduct'], replicas: 1 }],
    'one scale call, one name: ' + both.calls.join(' | '))
})

test('status is read-only, and it is refused the live lane too', () => {
  // The header says the script never touches the live lane. status writes nothing, but
  // a read aimed at monoplayer is still a read of the product, so it is refused as well.
  const { status, output, calls } = run(space(), ['status'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer' })
  assert.equal(status, 2, output)
  assert.match(output, /refusing/)
  assert.deepEqual(calls, [], 'nothing was read')
})

// A namespace the tree does not spell used to be refused outright: the manifests
// pinned monoplayer-gate-b and an override would apply one lane and scale another.
// #277 replaces that guard with a better one. The tree is rendered from the
// instance now, so there is nothing left to disagree with; what a name has to
// satisfy is that the render can derive it at all, which the cases above and below
// pin. The old case asserted the limitation the ticket removes.

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


// ---------------------------------------------------------------------------
// The instance: one value, and the whole lane follows (#277)
//
// The tree spells the lane monoplayer-gate-b in the namespace, in every
// app.kubernetes.io/name label and selector, in the Secret and ConfigMap names,
// in the two tailnet hostnames, and in one path inside velocity.toml. A second
// validation lane needs its own spelling, derived from one value, or two lanes on
// one cluster are indistinguishable and status acts on the wrong pods.
//
// The render is what gets applied, so these cases read it rather than trusting
// that the substitution reached everything.

// The tree the script would apply for one instance, written to a directory the
// case owns. No kubectl: the render is text, and CI installs no cluster client.
function rendered (where, dir, env = {}) {
  const result = spawnSync('bash', [SCRIPT, 'render', dir], {
    cwd: where.root,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: where.bin + ':' + process.env.PATH,
      KUBECTL_LOG: where.log,
      KUBECTL_STATE: where.state,
      MONOPLAYER_GATE_POLL: '0',
      ...env
    }
  })
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()
    : []
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8')
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), files, read }
}

const TREE = path.join(ROOT, 'deploy', 'driver')

test('the render with no instance named reproduces the tree byte for byte', () => {
  // Today's lane is monoplayer-gate-b and no run may change behaviour, so the
  // default render is the tree itself. Anything else means an ordinary gate:up
  // applies something a reader of deploy/driver has never seen.
  const where = space()
  const dir = path.join(where.root, 'render-b')
  const { status, output, files } = rendered(where, dir)
  assert.equal(status, 0, output)

  const tree = fs.readdirSync(TREE).filter(name => name.endsWith('.yaml')).sort()
  assert.deepEqual(files, tree, 'the render holds the tree and nothing else')
  for (const name of tree) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), fs.readFileSync(path.join(TREE, name), 'utf8'),
      name + ' differs from the tree it claims to reproduce')
  }
})

test('an instance renames every place the lane spells its name', () => {
  // A field-path transform cannot reach these: the Secret names, the ConfigMap
  // names, the mount path, the toml value that names it, and the namespace's own
  // environment label. The substitution reaches all five.
  const where = space()
  const dir = path.join(where.root, 'render-x')
  const { status, output, files, read } = rendered(where, dir, { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  assert.equal(status, 0, output)
  assert.ok(files.length > 0, 'the render holds the tree')

  for (const name of files) {
    assert.doesNotMatch(read(name), /gate-b/, name + ' still names the default lane: ' + (read(name).match(/\S*gate-b\S*/g) ?? []).join(' '))
  }
  assert.match(read('namespace.yaml'), /^  name: monoplayer-gate-x$/m, 'the namespace object takes the instance')
  for (const thing of ['paper', 'paper-conduct', 'paper-m4', 'velocity', 'toxiproxy']) {
    assert.match(read('velocity.yaml') + read('paper.yaml') + read('paper-conduct.yaml') + read('paper-m4.yaml') + read('toxiproxy.yaml'),
      new RegExp('app\\.kubernetes\\.io/name: monoplayer-gate-x-' + thing), 'the label prefix of ' + thing + ' takes the instance')
  }
  assert.match(read('velocity.yaml'), /forwarding-secret-file = "\/run\/secrets\/gate-x-velocity\/forwarding-secret"/,
    'the toml value and the mount path move together, which is the pair no field path can split')
  assert.match(read('velocity.yaml'), /mountPath: \/run\/secrets\/gate-x-velocity/, 'the mount path the toml names')
  assert.match(read('namespace.yaml'), /monoplayer\.eu\/environment: gate-x/, 'the namespace environment label takes the instance')
  assert.match(read('paper.yaml'), /tailscale\.com\/hostname: monoplayer-gate-x-paper/, 'a published tailnet name takes the instance')
})

test('two instances do not address each other', () => {
  // The collision #276 exists to stop. Two lanes that share a label, a Secret
  // name or a tailnet hostname are one lane wearing two namespaces.
  const where = space()
  const x = rendered(where, path.join(where.root, 'render-x'), { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  const y = rendered(where, path.join(where.root, 'render-y'), { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-y' })
  assert.equal(x.status, 0, x.output)
  assert.equal(y.status, 0, y.output)

  const joined = (render, dir) => render.files.map(name => render.read(name)).join('\n')
  assert.doesNotMatch(joined(x), /monoplayer-gate-y|gate-y-/, 'instance x reaches into y')
  assert.doesNotMatch(joined(y), /monoplayer-gate-x|gate-x-/, 'instance y reaches into x')

  const host = render => [...joined(render).matchAll(/tailscale\.com\/hostname: (\S+)/g)].map(match => match[1])
  assert.deepEqual(host(x), ['monoplayer-gate-x-paper', 'monoplayer-gate-x-velocity'], 'x publishes its own tailnet names')
  assert.deepEqual(host(y), ['monoplayer-gate-y-paper', 'monoplayer-gate-y-velocity'], 'y publishes its own, and not the same two')
})

test('gate:up applies the render, and the lanes it applies and scales agree', () => {
  // The apply and the scale are two halves of one command. If the render lands in
  // one namespace and the scale names another, half a lane exists.
  const where = space()
  const { status, output, calls } = run(where, ['up'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  assert.equal(status, 0, output)

  const applied = calls.find(line => line.includes('apply -k '))
  assert.ok(applied, 'the tree was applied: ' + calls.join(' | '))
  const appliedDir = applied.split('apply -k ')[1].trim().split(' ')[0]
  assert.doesNotMatch(appliedDir, new RegExp('^' + TREE + '$'), 'the tree is rendered, not applied as it is in git')

  assert.match(output, /gate lane monoplayer-gate-x/, 'the run says which lane it woke')
  assert.match(output, /label prefix monoplayer-gate-x-/, 'and the prefix it will look pods up by')
  for (const line of calls.filter(call => / scale /.test(call))) {
    assert.match(line, /-n monoplayer-gate-x /, 'every scale names the lane it applied: ' + line)
  }
})

test("a stopped lane looks its own pods up, not a neighbour's", () => {
  // The label lookup was the literal monoplayer-gate-b-<thing>, so a second lane
  // waiting for its pods to go would read somebody else's and report the wrong
  // answer. down is the reader that owns that lookup.
  const where = space()
  const { status, output, calls } = run(where, ['down'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  assert.equal(status, 0, output)

  const lookups = calls.filter(line => /-l .*app.kubernetes.io\/name/.test(line))
  assert.ok(lookups.length > 0, 'status looked pods up: ' + calls.join(' | '))
  for (const line of lookups) {
    assert.doesNotMatch(line, /monoplayer-gate-b/, 'a renamed lane must not look itself up as gate-b: ' + line)
  }
})

test("a namespace outside the gate lane's prefix is refused", () => {
  // The render substitutes the instance into a tree that spells monoplayer-gate-b.
  // A name outside that prefix leaves the tree's spelling with nothing to
  // substitute, so the render would quietly apply the default lane.
  for (const namespace of ['monoplayer-gate-c-', 'gate-c', 'monoplayer-gateX', 'monoplayer-gate']) {
    const { status, output, calls } = run(space(), ['up'], { MONOPLAYER_GATE_NAMESPACE: namespace })
    assert.equal(status, 2, output)
    assert.match(output, /refusing/)
    assert.deepEqual(calls, [], 'refusing "' + namespace + '" called no kubectl')
  }
})


test('render refuses a directory that already holds something', () => {
  // The render target belongs to the caller: `render DIR` is user-facing, and a
  // copy that overwrote a full directory would take whatever else was in it.
  const where = space()
  const dir = path.join(where.root, 'busy')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine')

  const { status, output } = rendered(where, dir)
  assert.equal(status, 2, output)
  assert.match(output, /not empty/)
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine', 'the file the caller put there survived')
})


test('a renamed lane generates its own Secrets, and nothing it writes names gate-b', () => {
  // The render asks for gate-<instance>-rcon and gate-<instance>-velocity, so the
  // Secrets this lane makes have to carry the same instance, or the lane the render
  // describes starts in CreateContainerConfigError on a Secret it never reads.
  const where = space()
  const { made } = generated(where, ['up', 'paper-m4'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  assert.deepEqual(made.map(secret => secret.name).sort(), ['gate-x-rcon', 'gate-x-velocity'])
  assert.deepEqual([...new Set(made.map(secret => secret.namespace))], ['monoplayer-gate-x'])
  assert.doesNotMatch(fs.readFileSync(path.join(where.state, 'secrets.yaml'), 'utf8'), /gate-b/,
    'the write names this lane only')
})

test('two instances render different objects, not just non-referring ones', () => {
  // "Do not address each other" is half the claim. The other half is that a second
  // instance is a second lane at all: its namespace and every label value differ.
  const where = space()
  const x = rendered(where, path.join(where.root, 'render-x'), { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  const y = rendered(where, path.join(where.root, 'render-y'), { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-y' })
  assert.equal(x.status, 0, x.output)
  assert.equal(y.status, 0, y.output)

  assert.notEqual(x.read('namespace.yaml'), y.read('namespace.yaml'), 'the two namespaces are two objects')
  assert.notEqual(x.read('paper.yaml'), y.read('paper.yaml'), 'and the workloads differ')
})

test('an instance too long for a label value is refused before it renders', () => {
  // app.kubernetes.io/name: monoplayer-gate-<instance>-paper-conduct has to fit in
  // 63 characters. Refusing the name here names the name; letting it through names
  // a manifest line one apply later.
  const long = run(space(), ['up'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-' + 'a'.repeat(34) })
  assert.equal(long.status, 2, long.output)
  assert.match(long.output, /63-character label value/)

  const fits = run(space(), ['up'], { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-' + 'a'.repeat(33) })
  assert.equal(fits.status, 0, fits.output)
})


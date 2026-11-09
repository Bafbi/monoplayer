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

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'observer-report.sh'
)

const PUPPET = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const POD = 'paper-abc123'
const PAPER_LABEL = 'monoplayer-gate-b-paper'

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
  // Two shapes of get deploy: the deployment's own selector label (matched first,
  // because a real kubectl resolves the jsonpath), and the puppet's env.
  '  *"matchLabels"*) printf \'%s\' "$PAPER_LABEL"; exit 0 ;;',
  '  *" get deploy "*) printf \'{"spec":{"selector":{"matchLabels":{"app.kubernetes.io/name":"%s"}},"template":{"spec":{"containers":[{"image":"ghcr.io/bafbi/monoplayer@sha256:deadbeef","env":[{"name":"MONOPLAYER_PUPPET_UUID","value":"%s"},{"name":"MONOPLAYER_PUPPET_ACCOUNTS_DIR","value":"/data/accounts"}]}]}}}}\\n\' "$PAPER_LABEL" "$PUPPET"; exit 0 ;;',
  '  *" logs "*) printf \'[Server] MonoplayerObserver wire listeners registered\\n\'; exit 0 ;;',
  '  *" apply "*) cat > /dev/null; printf \'pod/check created\\n\'; exit 0 ;;',
  '  *" wait "*) exit 0 ;;',
  // Two records per connection, as the plugin writes them: the join, then the
  // resource-pack status. The report has to merge each pair.
  '  *views.jsonl*) mkdir -p "$(dirname "$last")"; { printf \'%s\\n\' "$KUBECTL_BASELINE_VIEW"; printf \'%s\\n\' "$KUBECTL_BASELINE_LATE"; printf \'%s\\n\' "$KUBECTL_PUPPET_VIEW"; printf \'%s\\n\' "$KUBECTL_PUPPET_LATE"; } > "$last"; exit 0 ;;',
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

  return { root, bin, jar, protocollib, log: path.join(root, 'kubectl.log') }
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
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: space.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_PUPPET: PUPPET,
      KUBECTL_ATTACH: ATTACH,
      KUBECTL_POD: POD,
      KUBECTL_PAPER_LABEL: PAPER_LABEL,
      KUBECTL_BASELINE_VIEW: view({ address: '203.0.113.7:52001', resourcePack: null }),
      KUBECTL_BASELINE_LATE: view({ address: '203.0.113.7:52001', resourcePack: 'accepted' }),
      KUBECTL_PUPPET_VIEW: view({ address: '198.51.100.9:40000', resourcePack: null }),
      KUBECTL_PUPPET_LATE: view({ address: '198.51.100.9:40000', resourcePack: 'accepted' }),
      MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
      MONOPLAYER_OBSERVER_JAR: space.jar,
      MONOPLAYER_PROTOCOLLIB_JAR: space.protocollib,
      ...env
    }
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

test('the plugin install only ever names the gate namespace', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)
  const installs = calls.filter(line => line.includes('/data/plugins') || line.includes('kill 1'))
  assert.ok(installs.length > 0, 'the install ran')
  assert.equal(installs.every(line => line.startsWith('-n monoplayer-gate-b ')), true, installs.join(' / '))
})

test('measuring the live lane is refused before anything runs', () => {
  const space = workspace()
  const { status, output, calls } = run(space, {}, ['--namespace', 'monoplayer'])
  assert.equal(status, 2)
  assert.match(output, /never measures the live lane/)
  assert.deepEqual(calls, [], 'kubectl was never called')
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

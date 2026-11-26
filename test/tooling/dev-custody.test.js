// The dev puppet account (#44) is one script plus the manifests it leans on.
// Nothing here reaches a cluster: the cases read the files, and the script cases
// replace kubectl with a shim that answers from fixture files and records every
// argv.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEV = path.join(ROOT, 'deploy', 'dev')
const SCRIPT = path.join(ROOT, 'scripts', 'dev-custody.sh')
const LIVE_NAMESPACE = 'monoplayer'
const DEV_NAMESPACE = 'monoplayer-dev'
const LIVE_UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'

const LIVE_SECRET = '{"type":"kubernetes.io/dockerconfigjson","data":{".dockerconfigjson":"e30="}}'
const DEPLOYMENT = JSON.stringify({
  metadata: { name: 'monoplayer', namespace: 'monoplayer' },
  spec: {
    selector: { matchLabels: { 'app.kubernetes.io/name': 'monoplayer' } },
    template: {
      spec: {
        containers: [{
          name: 'monoplayer',
          env: [
            { name: 'MONOPLAYER_PUPPET_UUID', value: LIVE_UUID },
            { name: 'MONOPLAYER_PUPPET_ACCOUNTS_DIR', value: '/data/accounts' }
          ]
        }]
      }
    }
  }
})
// What the CLI prints from inside the live pod: one digest per account file.
const DIGEST_FIRST = 'aa11  live-cache.json\nbb22  mca-cache.json\ncc33  profile.json\ndir=/data/accounts/' + LIVE_UUID
const DIGEST_SECOND = 'aa11  live-cache.json\nbb22  mca-cache.json\ncc33  profile.json\ndir=/data/accounts/' + LIVE_UUID
const ACCOUNTS_JSON = JSON.stringify({
  accountsDir: '/data/accounts',
  accounts: [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'DevPuppet', alias: 'devpuppet', dir: '/data/accounts/11111111-2222-3333-4444-555555555555' }],
  broken: [],
  pending: []
})

const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'fixtures="$KUBECTL_FIXTURES"',
  'case " $* " in',
  '  *" get namespace "*) exit 0 ;;',
  '  *" get secret "*"-o json"*) cat "$fixtures/live-secret.json"; exit 0 ;;',
  '  *" get secret "*) exit 1 ;;',
  // The live deployment, read once for its name, selector, and puppet env.
  '  *" get deploy "*"-o json"*) cat "$fixtures/deployment.json"; exit 0 ;;',
  '  *" get deploy "*) printf \'1\\n\'; exit 0 ;;',
  // The dev proxy's pod (empty when it holds nothing), then the live pod by
  // the deployment's own selector.
  '  *" -n monoplayer-dev get pods -l "*) printf \'%s\' "$KUBECTL_PROXY_POD"; exit 0 ;;',
  '  *" get pods -l "*) printf \'%s\' "$KUBECTL_LIVE_POD"; exit 0 ;;',
  '  *" get pods "*) printf \'paper-abc 1/1 Running 0 1m\\n\'; exit 0 ;;',
  '  *" get pod dev-custody "*"status.phase"*) printf \'%s\' "$KUBECTL_PHASE"; exit 0 ;;',
  '  *" get pod "*) exit 0 ;;',
  '  *" apply "*) cat > /dev/null; printf \'applied\\n\'; exit 0 ;;',
  '  *" wait --for=condition=Ready "*) exit 0 ;;',
  '  *" delete pod "*) exit 0 ;;',
  '  *" cp "*) exit 0 ;;',
  // exec: the device-code login, the account list, custody status, then the
  // live digest (a counter, because a proof reads it twice).
  '  *"device-code"*) printf \'%s\\n\' "$KUBECTL_DEVICE_CODE"; exit "$KUBECTL_DEVICE_CODE_EXIT" ;;',
  '  *" accounts "*"--json"*) printf \'%s\\n\' "$(cat "$fixtures/accounts.json")"; exit 0 ;;',
  '  *" accounts "*) printf \'accounts: 1\\n\'; exit 0 ;;',
  '  *" status "*) printf \'writer-lock: free\\n\'; exit 0 ;;',
  '  *"node -e"*)',
  '    count=0',
  '    [ -f "$KUBECTL_COUNTER" ] && count=$(cat "$KUBECTL_COUNTER")',
  '    count=$((count + 1))',
  '    printf \'%s\' "$count" > "$KUBECTL_COUNTER"',
  '    if [ "$count" -le 1 ]; then printf \'%s\\n\' "$(cat "$fixtures/digest-first.txt")"; else printf \'%s\\n\' "$(cat "$fixtures/digest-second.txt")"; fi',
  '    exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace (overrides = {}) {
  const dir = tempRoot('monoplayer-dev-custody-')
  const bin = path.join(dir, 'bin')
  const fixtures = path.join(dir, 'fixtures')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(fixtures, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  const files = {
    'live-secret.json': LIVE_SECRET,
    'deployment.json': DEPLOYMENT,
    'accounts.json': ACCOUNTS_JSON,
    'digest-first.txt': DIGEST_FIRST,
    'digest-second.txt': DIGEST_SECOND,
    ...overrides
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixtures, name), content + '\n')
  }
  return { dir, bin, fixtures, log: path.join(dir, 'kubectl.log'), counter: path.join(dir, 'digest.count') }
}

function run (space, args, env = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_FIXTURES: space.fixtures,
      KUBECTL_COUNTER: space.counter,
      KUBECTL_PHASE: 'Running',
      KUBECTL_PROXY_POD: '',
      KUBECTL_LIVE_POD: 'monoplayer-55b6bdccf9-gjqvg',
      KUBECTL_DEVICE_CODE: 'open https://www.microsoft.com/link and enter ABCD1234',
      KUBECTL_DEVICE_CODE_EXIT: '0',
      MONOPLAYER_CUSTODY_REPORT: path.join(space.dir, 'dev-custody.json'),
      MONOPLAYER_LIVE_DIGEST_REPORT: path.join(space.dir, 'live-custody-digest.json'),
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

test('the dev proxy waits for its own account instead of CrashLooping', () => {
  const monoplayer = fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8')
  const wait = monoplayer.slice(monoplayer.indexOf('initContainers:'))
  assert.match(wait, /- name: wait-custody/, 'the proxy waits for custody')
  assert.match(wait, /until ls \/data\/accounts\/\*\/profile\.json/, 'it waits for any account, not a pinned uuid')
  assert.match(wait, /- name: clear-stale-lock/, 'a stale writer lock is cleared')
  assert.match(monoplayer, /MONOPLAYER_PUPPET_ACCOUNT[\s\S]*?value: devpuppet/, 'the alias is the account selector')
})

test('the dev tree never selects the live account', () => {
  // Prose may name it ("never GlowSquidye"); a value must not.
  for (const name of fs.readdirSync(DEV).filter(entry => entry.endsWith('.yaml'))) {
    const text = fs.readFileSync(path.join(DEV, name), 'utf8')
    const values = [...text.matchAll(/^\s*value: (.+)$/gm)].map(match => match[1])
    for (const value of values) {
      assert.doesNotMatch(value, /glowsquidye/i, name + ' selects no live alias')
      assert.doesNotMatch(value, new RegExp(LIVE_UUID), name + ' pins no live uuid')
    }
    assert.doesNotMatch(text, /claimName: monoplayer-custody/, name + ' mounts no live claim')
  }
})

test('the alias the bootstrap claims is the alias the deployment selects', () => {
  const monoplayer = fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8')
  const selected = monoplayer.match(/MONOPLAYER_PUPPET_ACCOUNT\s*\n\s*value: (\S+)/)[1]
  const script = fs.readFileSync(SCRIPT, 'utf8')
  const claimed = script.match(/MONOPLAYER_DEV_ACCOUNT:-([a-z0-9._-]+)/)[1]
  assert.equal(claimed, selected, 'one alias, one name for it')
})

test('prove-live needs a command to wrap', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['prove-live'])
  assert.equal(status, 2, output)
  assert.match(output, /needs a command/)
  assert.deepEqual(calls, [], 'nothing was read or changed')
})

test('up refuses the live namespace as a dev namespace', () => {
  const space = workspace()
  for (const args of [['up'], ['down'], ['bootstrap'], ['status'], ['live-digest']]) {
    const { status, output, calls } = run(space, args, { MONOPLAYER_DEV_NAMESPACE: LIVE_NAMESPACE })
    assert.equal(status, 2, args.join(' ') + ': ' + output)
    assert.match(output, /live namespace/)
    assert.deepEqual(calls, [], args.join(' ') + ' never called kubectl')
  }
})

test('up refuses while the dev proxy holds the custody volume', () => {
  // ReadWriteOnce on a two-node cluster, and one account has one writer: the
  // handle pod cannot share the claim with the running proxy.
  const space = workspace()
  const { status, output, calls } = run(space, ['up'], { KUBECTL_PROXY_POD: 'monoplayer-6d9f-abcde' })
  assert.equal(status, 2, output)
  assert.match(output, /the dev proxy \(monoplayer-6d9f-abcde\) holds the dev custody volume/)
  assert.match(output, /delete deploy\/monoplayer/)
  assert.equal(calls.some(line => line.includes('apply')), false, 'nothing was applied')
})

test('up creates the claim, then a handle pod with the branch code on it', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const claim = calls.findIndex(line => line.includes('apply -f ') && line.includes('deploy/dev/custody.yaml'))
  const pod = calls.findIndex(line => line.includes('apply -n monoplayer-dev -f -'))
  const staging = calls.findIndex(line => line.includes('exec dev-custody') && line.includes('mkdir -p /data/.bootstrap'))
  const source = calls.findIndex(line => line.includes('cp ') && line.includes('/data/.bootstrap/src'))
  const manifest = calls.findIndex(line => line.includes('cp ') && line.includes('/data/.bootstrap/package.json'))
  const modules = calls.findIndex(line => line.includes('ln -sfn /app/node_modules /data/.bootstrap/node_modules'))
  assert.ok(claim >= 0, 'the dev claim is applied')
  assert.ok(pod > claim, 'the claim exists before the pod mounts it')
  assert.ok(staging > pod, 'the pod is running before its code is staged')
  assert.ok(source > staging, 'the branch source lands on the volume')
  assert.ok(manifest > source, 'the package manifest comes with it')
  assert.ok(modules > manifest, 'the image dependencies are linked in')
  assert.equal(calls.some(line => /excalia|play2\./i.test(line)), false, 'never the live backend')
})

test('bootstrap streams the device code and never writes it to a file', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['bootstrap'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const login = calls.find(line => line.includes('device-code'))
  assert.ok(login, 'the device code is requested: ' + calls.join(' | '))
  assert.match(login, /exec -i dev-custody/, 'an interactive stream, not a TTY')
  assert.doesNotMatch(login, / -t /, 'no TTY: a TTY mangles the streamed lines')
  assert.doesNotMatch(login, /[>|]/, 'the code is never redirected into a file')
  assert.match(login, /--alias devpuppet/, 'the alias the deployment selects')
  assert.match(login, /--accounts-dir \/data\/accounts/, 'onto the dev volume')
  assert.match(output, /ABCD1234/, 'the operator sees the code')

  const report = JSON.parse(fs.readFileSync(path.join(space.dir, 'dev-custody.json'), 'utf8'))
  assert.deepEqual(report, {
    namespace: DEV_NAMESPACE,
    accountsDir: '/data/accounts',
    accounts: [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'DevPuppet', alias: 'devpuppet' }]
  })
})

test('bootstrap fails loudly when the login does not finish', () => {
  const space = workspace()
  const { status, output } = run(space, ['bootstrap'], { KUBECTL_DEVICE_CODE_EXIT: '1' })
  assert.equal(status, 1, output)
  assert.match(output, /the device-code login did not finish \(exit 1\)/)
})

test('bootstrap refuses while the handle pod is missing', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['bootstrap'], { KUBECTL_PHASE: '' })
  assert.equal(status, 2, output)
  assert.match(output, /mise run dev:custody:up/)
  assert.equal(calls.some(line => line.includes('device-code')), false, 'no login was attempted')
})

test('status reads the dev account from the dev volume', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['status'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const read = calls.find(line => line.includes(' status '))
  assert.ok(read, 'status runs: ' + calls.join(' | '))
  assert.match(read, /--account devpuppet/)
  assert.match(read, /--accounts-dir \/data\/accounts/)
  assert.equal(calls.some(line => line.startsWith('-n monoplayer ')), false, 'the live namespace is not touched')
})

test('live-digest reads the live account through the live pod', () => {
  // A second mount of the live claim is the thing the dev lane exists to avoid,
  // so the digest goes through the pod that already holds it.
  const space = workspace()
  const { status, output, calls } = run(space, ['live-digest'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.ok(calls.some(line => line === '-n monoplayer get deploy monoplayer -o json'), 'it reads the deployment first')
  const digest = calls.find(line => line.includes('exec deploy/monoplayer -c monoplayer'))
  assert.ok(digest, 'the digest runs in the live pod: ' + calls.join(' | '))
  assert.doesNotMatch(calls.join('\n'), /scale|patch|rollout restart/, 'a read, never a write')
  assert.match(output, /aa11  live-cache\.json/)
  assert.match(output, /cc33  profile\.json/)
})

test('prove-live passes when the live token files are byte-identical', () => {
  const space = workspace()
  const { status, output } = run(space, ['prove-live', '--', 'sh', '-c', 'echo the dev run'])
  assert.equal(status, 0, output)
  assert.match(output, /the dev run/, "the wrapped command's output is inherited")
  assert.match(output, /byte-identical/)
  const report = JSON.parse(fs.readFileSync(path.join(space.dir, 'live-custody-digest.json'), 'utf8'))
  assert.equal(report.identical, true)
  assert.equal(report.namespace, LIVE_NAMESPACE)
  assert.equal(report.deployment, 'monoplayer')
  assert.equal(report.pod, 'monoplayer-55b6bdccf9-gjqvg')
  assert.equal(report.exitStatus, 0)
  assert.deepEqual(report.before, report.after)
})

test('prove-live fails when the run moved the live token files', () => {
  const space = workspace({
    'digest-second.txt': 'aa11  live-cache.json\ndd44  mca-cache.json\ncc33  profile.json'
  })
  const { status, output } = run(space, ['prove-live', '--', 'sh', '-c', 'exit 0'])
  assert.equal(status, 1, output)
  assert.match(output, /the live account token files changed during the run/)
  assert.match(output, /dd44  mca-cache\.json/, 'the difference is printed')
  const report = JSON.parse(fs.readFileSync(path.join(space.dir, 'live-custody-digest.json'), 'utf8'))
  assert.equal(report.identical, false)
})

test('prove-live keeps the wrapped exit status', () => {
  const space = workspace()
  const { status, output } = run(space, ['prove-live', '--', 'sh', '-c', 'exit 3'])
  assert.equal(status, 3, output)
  assert.match(output, /byte-identical/, 'the proof still ran and reported')
})

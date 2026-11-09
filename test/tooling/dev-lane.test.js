// The dev validation lane (#42) is manifests plus one script. Nothing here
// reaches a cluster: the manifest cases read the files, and the script cases
// replace kubectl with a shim that records every argv.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEV = path.join(ROOT, 'deploy', 'dev')
const SCRIPT = path.join(ROOT, 'scripts', 'dev-lane.sh')
const LIVE_NAMESPACE = 'monoplayer'
const DEV_NAMESPACE = 'monoplayer-dev'

const manifests = () => fs.readdirSync(DEV)
  .filter(name => name.endsWith('.yaml') && name !== 'kustomization.yaml')
  .map(name => ({ name, text: fs.readFileSync(path.join(DEV, name), 'utf8') }))

test('every dev resource is namespace-relative to the dev namespace', () => {
  for (const { name, text } of manifests()) {
    const kinds = [...text.matchAll(/^kind: (\w+)$/gm)].map(match => match[1])
    assert.ok(kinds.length > 0, name + ' declares a resource')
    const namespaces = [...text.matchAll(/^  namespace: (\S+)$/gm)].map(match => match[1])
    if (kinds.includes('Namespace')) {
      // A Namespace object carries its own name and no namespace field.
      assert.match(text, new RegExp('^  name: ' + DEV_NAMESPACE + '$', 'm'), name + ' declares the dev namespace')
    }
    for (const value of namespaces) {
      assert.equal(value, DEV_NAMESPACE, name + ' names only ' + DEV_NAMESPACE)
    }
    // Every non-Namespace resource must say it, not inherit it from a context.
    const resources = kinds.filter(kind => kind !== 'Namespace').length
    assert.equal(namespaces.length, resources, name + ' sets namespace on every resource')
  }
})

test('the dev manifests carry no secret values', () => {
  for (const { name, text } of manifests()) {
    assert.doesNotMatch(text, /^kind: Secret$/m, name + ' commits no Secret')
    assert.doesNotMatch(text, /^stringData:/m, name + ' has no inline string data')
    assert.doesNotMatch(text, /password:\s*[^\s]/m, name + ' writes no password')
  }
  const paper = fs.readFileSync(path.join(DEV, 'paper.yaml'), 'utf8')
  assert.match(paper, /name: RCON_PASSWORD[\s\S]*?secretKeyRef:[\s\S]*?name: dev-rcon/, 'the RCON password comes from a Secret')
})

test('the dev lane never mounts the live custody volume', () => {
  for (const { name, text } of manifests()) {
    assert.doesNotMatch(text, /claimName: monoplayer-custody/, name + ' does not mount the live claim')
  }
  const monoplayer = fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8')
  assert.match(monoplayer, /claimName: monoplayer-dev-custody/, 'the dev proxy mounts its own volume')
  assert.match(monoplayer, /replicas: 1/, 'one writer')
  assert.match(monoplayer, /strategy:\s*\n\s*type: Recreate/, 'Recreate, so two pods never overlap')
})

test('the kustomization lists every manifest in the directory', () => {
  const kustomization = fs.readFileSync(path.join(DEV, 'kustomization.yaml'), 'utf8')
  for (const { name } of manifests()) {
    assert.match(kustomization, new RegExp('^  - ' + name + '$', 'm'), name + ' is in the kustomization')
  }
})

test('the dev lane is not registered in Argo CD', () => {
  const application = fs.readFileSync(path.join(ROOT, 'deploy', 'argocd', 'application.yaml'), 'utf8')
  assert.match(application, /path: deploy\/manifests/, 'Argo tracks the live manifests')
  assert.match(application, /namespace: monoplayer$|namespace: monoplayer\s*$/m, 'Argo tracks the live namespace')
  for (const file of fs.readdirSync(path.join(ROOT, 'deploy', 'argocd'))) {
    const text = fs.readFileSync(path.join(ROOT, 'deploy', 'argocd', file), 'utf8')
    assert.doesNotMatch(text, /deploy\/dev|monoplayer-dev/, file + ' does not mention the dev lane')
  }
})

test('mise offers one command up and one down', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'mise.toml'), 'utf8')
  assert.match(toml, /\[tasks\."dev:up"\]/, 'dev:up')
  assert.match(toml, /\[tasks\."dev:down"\]/, 'dev:down')
})

const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'last="${@: -1}"',
  'case " $* " in',
  '  *" get secret "*) exit 1 ;;',
  '  *" create namespace "*) printf \'{"kind":"Namespace"}\\n\'; exit 0 ;;',
  '  *" create secret "*) printf \'{"kind":"Secret"}\\n\'; exit 0 ;;',
  '  *" apply -k "*) touch "$KUBECTL_MARKER"; cat > /dev/null; printf \'applied\\n\'; exit 0 ;;',
  '  *" apply "*) cat > /dev/null; printf \'applied\\n\'; exit 0 ;;',
  '  *" rollout status "*) exit 0 ;;',
  '  *" get pods "*) printf \'paper-abc 1/1 Running 0 1m\\n\'; exit 0 ;;',
  '  *" get configmap "*) printf \'{"version":1,"players":[]}\\n\'; exit 0 ;;',
  '  *" get deploy "*) if [ -f "$KUBECTL_MARKER" ]; then printf \'%s\\n\' "$KUBECTL_REPLICAS_AFTER"; else printf \'%s\\n\' "$KUBECTL_REPLICAS_BEFORE"; fi; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace () {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-dev-lane-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  return { dir, bin, log: path.join(dir, 'kubectl.log'), marker: path.join(dir, 'applied') }
}

function run (space, args, env = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_MARKER: space.marker,
      KUBECTL_REPLICAS_BEFORE: '1',
      KUBECTL_REPLICAS_AFTER: '1',
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

test('up creates the RCON Secret before it applies the lane', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const create = calls.findIndex(line => line.includes('create secret generic dev-rcon'))
  const apply = calls.findIndex(line => line.includes('apply -k'))
  assert.ok(create >= 0, 'the Secret is created')
  assert.ok(apply > create, 'the Secret exists before the lane is applied')
  assert.equal(fs.readFileSync(space.log, 'utf8').includes('create secret generic monoplayer'), false, 'never the live Secret')
})

test('no dev command changes the live deployment', () => {
  const space = workspace()
  for (const args of [['up'], ['status'], ['down']]) {
    const { status, output, calls } = run(space, args)
    assert.equal(status, 0, args.join(' ') + ': ' + output)
    for (const verb of ['scale', 'patch', 'rollout restart', 'set image deploy/monoplayer -n monoplayer']) {
      assert.equal(calls.some(line => line.includes(verb)), false, args.join(' ') + ' ran ' + verb)
    }
  }
})

test('down deletes the dev lane and nothing else', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['down'])
  assert.equal(status, 0, output)
  const deletions = calls.filter(line => line.includes('delete'))
  assert.ok(deletions.length >= 2, 'the lane and its namespace are deleted')
  assert.equal(deletions.every(line => line.includes('deploy/dev') || line.includes(DEV_NAMESPACE)), true, deletions.join(' / '))
})

test('status reports the live replica count without changing it', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /live monoplayer\/monoplayer available replicas: 1/)
  assert.equal(calls.some(line => line.includes(LIVE_NAMESPACE + ' delete')), false)
})

test('up records the live replica count and fails when it changes', () => {
  const space = workspace()
  const changed = run(space, ['up'], { KUBECTL_REPLICAS_AFTER: '0' })
  assert.equal(changed.status, 1, changed.output)
  assert.match(changed.output, /changed its replica count \(1 -> 0\)/)
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, '.reports', 'dev-lane.json'), 'utf8'))
  assert.deepEqual(report.live, { before: '1', after: '0' })
})

test('up with a steady live lane reports the same count twice', () => {
  const space = workspace()
  const { status, output } = run(space, ['up'], { MONOPLAYER_DEV_REPORT: path.join(space.dir, 'dev-lane.json') })
  assert.equal(status, 0, output)
  assert.match(output, /live replicas before monoplayer-dev came up: 1, after: 1/)
})

test('set-image puts the branch image on the dev proxy only', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['set-image', 'sha-abc1234'])
  assert.equal(status, 0, output)
  const set = calls.filter(line => line.includes('set image'))
  assert.equal(set.length, 1, 'one set image: ' + calls.join(' / '))
  assert.match(set[0], /^-n monoplayer-dev set image deploy\/monoplayer monoplayer=ghcr\.io\/bafbi\/monoplayer:sha-abc1234$/)
  assert.ok(calls.some(line => line.includes('rollout status deploy/monoplayer')), 'it waits for the rollout')
})

test('set-image without a tag is refused', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['set-image'])
  assert.equal(status, 2)
  assert.match(output, /needs a tag/)
  assert.deepEqual(calls, [], 'nothing was changed')
})

test('the live namespace is refused as a dev namespace', () => {
  const space = workspace()
  for (const args of [['up'], ['down']]) {
    const { status, output, calls } = run(space, args, { MONOPLAYER_DEV_NAMESPACE: LIVE_NAMESPACE })
    assert.equal(status, 2, args.join(' '))
    assert.match(output, /live namespace/)
    assert.deepEqual(calls, [], args.join(' ') + ' never called kubectl')
  }
})

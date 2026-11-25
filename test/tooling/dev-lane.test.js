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

test('the dev claim is its own object, outside the deployment manifest', () => {
  // A custody bootstrap has to create the volume without a proxy holding it, so
  // the claim cannot be welded to the Deployment (#44).
  const monoplayer = fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8')
  const custody = fs.readFileSync(path.join(DEV, 'custody.yaml'), 'utf8')

  assert.doesNotMatch(monoplayer, /^kind: PersistentVolumeClaim$/m, 'monoplayer.yaml declares no claim')
  assert.match(custody, /^kind: PersistentVolumeClaim$/m, 'custody.yaml declares the claim')
  assert.match(custody, /^  name: monoplayer-dev-custody$/m, 'the claim is the dev claim')
  assert.match(custody, /ReadWriteOnce/, 'one node, one writer')
})

test('the kustomization lists every manifest in the directory', () => {
  const kustomization = fs.readFileSync(path.join(DEV, 'kustomization.yaml'), 'utf8')
  for (const { name } of manifests()) {
    assert.match(kustomization, new RegExp('^  - ' + name + '$', 'm'), name + ' is in the kustomization')
  }
})

test('the dev lane is not registered in Argo CD', () => {
  const application = fs.readFileSync(path.join(ROOT, 'deploy', 'argocd', 'application.yaml'), 'utf8')
  assert.match(application, /^ {4}path: deploy$/m, 'Argo tracks the root tree, the live manifests among them')
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

// An empty whitelist in the shape the dev ConfigMap ships: pretty-printed, so a
// compact-only match would miss it.
const EMPTY_WHITELIST = '{\n  "version": 1,\n  "players": []\n}'
// The live ConfigMap: the human who may control the proxy.
const LIVE_WHITELIST = '{"version":1,"players":[{"uuid":"6eb73524-ff88-4a62-a8d0-c63905e7afba","name":"Bafbi"}]}'
// The pull Secret the private GHCR package needs, as the live namespace stores it.
const LIVE_SECRET = '{"type":"kubernetes.io/dockerconfigjson","data":{".dockerconfigjson":"e30="}}'
const PLAYER_LIST = 'There are 1 of a max of 8 players online: DevPuppet'

// The shim answers from fixture files, so a JSON answer never has to survive a
// shell quoting layer.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'fixtures="$KUBECTL_FIXTURES"',
  'case " $* " in',
  // No pull Secret in the dev namespace yet; the live one exists to copy.
  '  *" get secret "*"-o json"*) cat "$fixtures/live-secret.json"; exit 0 ;;',
  '  *" get secret "*) exit 1 ;;',
  '  *" create namespace "*) printf \'{"kind":"Namespace"}\\n\'; exit 0 ;;',
  '  *" create secret "*) printf \'{"kind":"Secret"}\\n\'; exit 0 ;;',
  '  *" apply -k "*) touch "$KUBECTL_MARKER"; cat > /dev/null; printf \'applied\\n\'; exit 0 ;;',
  '  *" apply "*) cat > /dev/null; printf \'applied\\n\'; exit 0 ;;',
  '  *" rollout status "*) exit 0 ;;',
  '  *" get pods "*) printf \'paper-abc 1/1 Running 0 1m\\n\'; exit 0 ;;',
  // The fixture is the cluster state: a read of an object no fixture holds answers
  // nothing and exits non-zero, the way kubectl fails a missing object. None of
  // the three arms overrides cat's status.
  '  *" -n monoplayer-dev get configmap "*) cat "$fixtures/dev-whitelist.json" ;;',
  '  *" -n monoplayer get configmap "*) cat "$fixtures/live-whitelist.json" ;;',
  '  *" get configmap "*) cat "$fixtures/dev-whitelist.json" ;;',
  // The dev proxy's account, read from its volume, and the dev Paper's player
  // list, read over RCON.
  '  *" exec "*"node -e"*) printf \'%s\' "$KUBECTL_ACCOUNT_NAME"; exit 0 ;;',
  '  *" rcon-cli list"*) printf \'%s\\n\' "$KUBECTL_RCON"; exit 0 ;;',
  '  *" get deploy "*) if [ -f "$KUBECTL_MARKER" ]; then printf \'%s\\n\' "$KUBECTL_REPLICAS_AFTER"; else printf \'%s\\n\' "$KUBECTL_REPLICAS_BEFORE"; fi; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace () {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-dev-lane-'))
  const bin = path.join(dir, 'bin')
  const fixtures = path.join(dir, 'fixtures')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(fixtures, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  fs.writeFileSync(path.join(fixtures, 'live-secret.json'), LIVE_SECRET + '\n')
  fs.writeFileSync(path.join(fixtures, 'dev-whitelist.json'), EMPTY_WHITELIST + '\n')
  fs.writeFileSync(path.join(fixtures, 'live-whitelist.json'), EMPTY_WHITELIST + '\n')
  return { dir, bin, fixtures, log: path.join(dir, 'kubectl.log'), marker: path.join(dir, 'applied') }
}

// The state after `down --purge` for the whitelist: no ConfigMap to read.
function withoutWhitelist () {
  const space = workspace()
  fs.unlinkSync(path.join(space.fixtures, 'dev-whitelist.json'))
  return space
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
      KUBECTL_FIXTURES: space.fixtures,
      KUBECTL_ACCOUNT_NAME: 'DevPuppet',
      KUBECTL_RCON: PLAYER_LIST,
      MONOPLAYER_DEV_JOIN_REPORT: path.join(space.dir, 'dev-join.json'),
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

// A call against the live namespace. The lookahead is required: the prefix test
// alone also matches monoplayer-dev.
const LIVE_CALL = /-n monoplayer(?![\w-])/
// The script reads the live namespace, for one Secret, one ConfigMap, and the
// replica count. Every live call it makes is a '-n monoplayer get'. Matching on
// the namespace rather than on a list of verbs is what makes a write this file has
// not thought of yet fail.
//
// What this cannot see: the script's writes go through 'apply -f -' with no -n
// flag, so a live read piped into a live apply would pass. Reading the manifests
// the apply carries is a different test.
const liveWrites = calls => calls.filter(line => LIVE_CALL.test(line) && !/^-n monoplayer get /.test(line))

test('up creates the RCON Secret before it applies the lane', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const create = calls.findIndex(line => line.includes('create secret generic dev-rcon'))
  const apply = calls.findIndex(line => line.includes('apply -k'))
  assert.ok(create >= 0, 'the Secret is created')
  assert.ok(apply > create, 'the Secret exists before the lane is applied')
  assert.deepEqual(liveWrites(calls), [], 'nothing is written to the live namespace')
})

test('no dev command changes the live deployment', () => {
  const space = workspace()
  for (const args of [['up'], ['status'], ['down'], ['down', '--purge'], ['join']]) {
    const { status, output, calls } = run(space, args)
    assert.equal(status, 0, args.join(' ') + ': ' + output)
    for (const verb of ['scale', 'patch', 'rollout restart']) {
      assert.equal(calls.some(line => line.includes(verb)), false, args.join(' ') + ' ran ' + verb)
    }
    // The verb list above cannot cover every write: a live 'set image' reads
    // '-n monoplayer set image', so a needle spelled the other way never matches.
    assert.deepEqual(liveWrites(calls), [], args.join(' ') + ' wrote to the live namespace')
  }
})

test('status names an empty whitelist, and claims no state when the read fails', () => {
  // The present half pins how status classifies an empty whitelist; the missing
  // half pins that a read which yielded nothing is not classified at all. Neither
  // half can tell a failed read from an empty one, because status discards the
  // status and the output is the same either way: what the pair fixes is the
  // classification, not the shim's exit status.
  const empty = run(workspace(), ['status'])
  assert.equal(empty.status, 0, empty.output)
  assert.match(empty.output, /attach whitelist is empty: nobody can attach yet/)

  const missing = run(withoutWhitelist(), ['status'])
  assert.equal(missing.status, 0, missing.output)
  assert.match(missing.output, /available replicas: 1/, 'the rest of the report still prints')
  assert.doesNotMatch(missing.output, /attach whitelist (is empty|has entries)/,
    'a read that yielded nothing is not a report about the whitelist')
})

test('down --purge exits 0 when the dev ConfigMap is missing', () => {
  // Reporting a lane that is already gone is not an error: `mise run dev:down --
  // --purge` must exit 0 when it has nothing left to report on.
  const { status, output } = run(withoutWhitelist(), ['down', '--purge'])
  assert.equal(status, 0, output)
  assert.match(output, /deleted monoplayer-dev/)
})

test('down stops the workload and keeps the dev account', () => {
  // The dev puppet took a human device-code approval, so its claim outlives the
  // workload: the same rule the live claim carries (deploy/manifests/pvc.yaml).
  const space = workspace()
  const { status, output, calls } = run(space, ['down'])
  assert.equal(status, 0, output)
  const deletions = calls.filter(line => line.includes('delete'))
  assert.ok(deletions.length >= 2, 'the workload and the handle pod are deleted')
  assert.equal(deletions.every(line => line.includes(DEV_NAMESPACE)), true, deletions.join(' / '))
  // The claim and the namespace stay, under either spelling kubectl accepts for
  // each: 'delete pvc monoplayer-dev-custody' and 'delete ns monoplayer-dev' both
  // take what a stop may not, and an allowlist of verbs would also reject
  // 'delete deploy', which is the workload and is allowed.
  assert.equal(deletions.some(line => /\bpvc\b|persistentvolumeclaim/.test(line)), false, 'the claim stays: ' + deletions.join(' / '))
  assert.equal(deletions.some(line => /\bns\b|\bnamespace\b/.test(line)), false, 'the namespace stays: ' + deletions.join(' / '))
  assert.match(output, /the dev account stay/)
})

test('down --purge removes the account as well', () => {
  const space = workspace()
  const { status, output, calls } = run(space, ['down', '--purge'])
  assert.equal(status, 0, output)
  assert.ok(calls.some(line => line === 'delete namespace monoplayer-dev --ignore-not-found'), 'the namespace goes')
  assert.match(output, /and with it the dev custody volume and the dev account/)
})

test('down never deletes anything outside the dev namespace', () => {
  const space = workspace()
  const { status, calls } = run(space, ['down', '--purge'])
  assert.equal(status, 0)
  for (const line of calls.filter(entry => entry.includes('delete'))) {
    assert.match(line, /^\s*-n monoplayer-dev |^delete namespace monoplayer-dev/, line + ' names a namespace it may not delete')
  }
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

test('up copies the pull Secret the private package needs, before it applies', () => {
  // The GHCR package is private (docs/deployment.md), so without this Secret the
  // dev proxy cannot pull. That is half of why #43 was reopened.
  const space = workspace()
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const copy = calls.findIndex(line => line.startsWith('-n monoplayer get secret ghcr-pull -o json'))
  const apply = calls.findIndex(line => line.includes('apply -k'))
  assert.ok(copy >= 0, 'the live pull Secret is read')
  assert.ok(apply > copy, 'the dev copy exists before the lane is applied')
})

test('up fills the empty dev attach whitelist from the live one', () => {
  // --start refuses an empty whitelist, so the shipped empty ConfigMap can never
  // serve: the lane needs a controller before a bot joins on it (#43 AC3).
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const seed = calls.findIndex(line => line.includes('patch configmap monoplayer-dev-config'))
  const apply = calls.findIndex(line => line.includes('apply -k'))
  assert.ok(seed >= 0, 'the dev whitelist is written')
  assert.ok(seed > apply, 'it happens after the ConfigMap exists')
  assert.match(calls[seed], /Bafbi/, 'the controller it writes is the live one')
  assert.match(output, /filled the dev attach whitelist from monoplayer/)
})

test('the attach whitelist seed rewrites one key and leaves its neighbours', () => {
  // A client-side apply deletes every data key the previous one wrote and this
  // one omits, so seeding through 'create configmap | apply' would strip the
  // lane's allowed-servers.json and leave the picker offering nothing (#392).
  // The seed is a merge patch of the one key it owns.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const patch = calls.filter(line => line.includes('patch configmap monoplayer-dev-config'))
  assert.equal(patch.length, 1, 'the seed writes the ConfigMap once: ' + calls.join(' | '))
  assert.match(patch[0], /^-n monoplayer-dev patch configmap monoplayer-dev-config --type merge -p /,
    'the seed is a merge patch, which sets a key and leaves the rest: ' + patch[0])
  assert.doesNotMatch(patch[0], /allowed-servers/,
    'the seed names only the key it owns, so it cannot drop the picker row: ' + patch[0])
  assert.equal(calls.some(line => line.includes('create configmap monoplayer-dev-config')), false,
    'no step recreates the ConfigMap from one key: an apply of it would clear allowed-servers.json')
})

test('up leaves an operator whitelist alone', () => {
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.equal(calls.some(line => line.includes('patch configmap')), false, 'no overwrite')
  assert.match(output, /the dev attach whitelist has entries/)
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

test('join reports the dev proxy own account on the dev Paper', () => {
  // AC3 of #43: the join is the standing deployment's own session, not a
  // throwaway pod that borrowed the live account.
  const space = workspace()
  const { status, output, calls } = run(space, ['join'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.ok(calls.some(line => line.includes('rollout status deploy/monoplayer')), 'it waits for the dev proxy')
  assert.ok(calls.some(line => line.includes('exec deploy/monoplayer -c monoplayer')), 'it reads the dev account from the proxy volume')
  assert.ok(calls.some(line => line.includes('exec deploy/paper -c paper -- rcon-cli list')), 'the backend is the dev Paper')
  assert.equal(calls.some(line => /excalia|play2\./i.test(line)), false, 'never the live backend')
  const report = JSON.parse(fs.readFileSync(path.join(space.dir, 'dev-join.json'), 'utf8'))
  assert.deepEqual(report, {
    namespace: DEV_NAMESPACE,
    account: 'DevPuppet',
    players: ['DevPuppet'],
    evidence: 'There are 1 of a max of 8 players online: DevPuppet',
    joined: true
  })
})

test('join fails when the dev Paper does not list the account', () => {
  const space = workspace()
  const { status, output } = run(space, ['join'], {
    KUBECTL_RCON: 'There are 0 of a max of 8 players online:',
    MONOPLAYER_DEV_JOIN_TIMEOUT: '0'
  })
  assert.equal(status, 1, output)
  assert.match(output, /DevPuppet is not on the dev Paper/)
})

test('the join no longer borrows the live account', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(script, /online-cluster\.sh/, 'no throwaway pod against the dev Paper')
  assert.doesNotMatch(script, /monoplayer-custody/, 'no reference to the live claim')
  assert.match(script, /rcon-cli list/, 'the backend evidence is the Paper player list')
  assert.match(script, /exec deploy\/paper -c paper/, 'it reads the dev Paper, not the gate Paper')

  const toml = fs.readFileSync(path.join(ROOT, 'mise.toml'), 'utf8')
  assert.match(toml, /\[tasks\."dev:join"\]/, 'mise run dev:join')
})

test('the live namespace is refused as a dev namespace', () => {
  const space = workspace()
  for (const args of [['up'], ['down'], ['join'], ['pull-secret']]) {
    const { status, output, calls } = run(space, args, { MONOPLAYER_DEV_NAMESPACE: LIVE_NAMESPACE })
    assert.equal(status, 2, args.join(' '))
    assert.match(output, /live namespace/)
    assert.deepEqual(calls, [], args.join(' ') + ' never called kubectl')
  }
})

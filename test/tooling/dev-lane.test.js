// The dev validation lane (#42) is manifests plus one script. Nothing here
// reaches a cluster: the manifest cases read the files, and the script cases
// replace kubectl with a shim that records every argv.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'
import { ANY, deadRules, kubectlShim, unmodelled } from '../support/kubectl-shim.js'
import { offlineUuid } from '../../src/legs/offline-identity.js'
import { uuidRefusalReason } from '../../src/custody/util.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEV = path.join(ROOT, 'deploy', 'dev')
const SCRIPT = path.join(ROOT, 'scripts', 'dev-lane.sh')
const LIVE_NAMESPACE = 'monoplayer'
const DEV_NAMESPACE = 'monoplayer-dev'

// Every rule that fired, in one file for the whole test file: the last case reads it
// to prove no arm is dead (#152).
const HITS = path.join(tempRoot('monoplayer-dev-lane-hits-'), 'hits')

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
// #677: the list a hand edit grows when somebody wants "two clients" on this lane. The
// two names are the loopback rig's bot names, and their uuids are what
// src/legs/offline-identity.js derives from a name: the dev front verifies every login
// against Mojang, so neither entry can ever attach. A whitelist that carries them reads
// as three controllers and admits one.
const RIG_WHITELIST = JSON.stringify({
  version: 1,
  players: [
    { uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi' },
    { uuid: offlineUuid('Pilot'), name: 'Pilot' },
    { uuid: offlineUuid('Watcher'), name: 'Watcher' }
  ]
})
// A controller an operator added on the dev lane themselves. No live list names
// them, so no seed can bring the entry back: only carrying it across can (#393).
const OPERATOR_WHITELIST = '{"version":1,"players":[{"uuid":"0b7f5a4c-9d21-4c6e-8c2e-3f1d2b9a7e55","name":"OperatorController"}]}'
// The pull Secret the private GHCR package needs, as the live namespace stores it.
const LIVE_SECRET = '{"type":"kubernetes.io/dockerconfigjson","data":{".dockerconfigjson":"e30="}}'
const PLAYER_LIST = 'There are 1 of a max of 8 players online: DevPuppet'

// #676: the proxy's own records, one JSON object per line, which is what the lane says
// about itself. A picker lane's `startLive` carries `picker: true` and it logs
// `backendBootSkipped` with reason `picker` at boot (dialBodyAtBoot,
// src/service/start-live.js); a claim writes `claimDial`, then `claimBodyWarm` when the
// body lands or `claimDialFailed` when it does not (src/service/monoplayer.js).
const BOOT = '{"t":"2026-01-01T00:00:00.000Z","event":"startLive","picker":true}'
const BOOT_SKIPPED = '{"t":"2026-01-01T00:00:00.001Z","event":"backendBootSkipped","reason":"picker"}'
const CLAIM_DIAL = '{"t":"2026-01-01T00:01:00.000Z","event":"claimDial","body":"paper_25565"}'
const CLAIM_WARM = '{"t":"2026-01-01T00:01:02.000Z","event":"claimBodyWarm","body":"paper_25565","state":"attachable"}'
const CLAIM_FAILED = '{"t":"2026-01-01T00:01:00.000Z","event":"claimDialFailed","body":"paper_25565","reason":"connect_failed","error":"ECONNREFUSED"}'
const CLAIM_REFUSED = '{"t":"2026-01-01T00:01:00.000Z","event":"claimDialRefused","body":"paper_25565","reason":"no_target"}'
const HEARTBEAT = '{"t":"2026-01-01T00:02:00.000Z","event":"heartbeat","backendLogins":0}'
// The default fixture: a claim that dialled and landed, which is the lane a successful
// `dev:join` is run against.
const LANDED_LOG = [BOOT, BOOT_SKIPPED, CLAIM_DIAL, CLAIM_WARM].join('\n') + '\n'
const IDLE_LOG = [BOOT, BOOT_SKIPPED].join('\n') + '\n'
// A claim that dialled and has not landed, which is the first seconds of every claim.
const CLAIMED_LOG = [BOOT, BOOT_SKIPPED, CLAIM_DIAL].join('\n') + '\n'
// A claim that failed writes both records, in this order: the state is read from the
// last of them.
const CLAIM_FAILED_LOG = [BOOT, BOOT_SKIPPED, CLAIM_DIAL, CLAIM_FAILED].join('\n') + '\n'
// A claim refused before it dialled: the row named no target, or the leg refused it.
const CLAIM_REFUSED_LOG = [BOOT, BOOT_SKIPPED, CLAIM_REFUSED].join('\n') + '\n'
// A lane with the picker off dials at boot, so its boot record carries no skip.
const BOOT_DIALLED_LOG = '{"t":"2026-01-01T00:00:00.000Z","event":"startLive","picker":false}\n'
// A log whose boot records have rotated away: records, but nothing about the boot.
const NO_BOOT_LOG = HEARTBEAT + '\n'

// The shim answers from fixture files, so a JSON answer never has to survive a
// shell quoting layer. It answers the calls `dev-lane.sh` makes, and nothing else (#152). A rule is
// one call: the words the script sends, in the order it sends them, and the count it
// sends, so a flag it stops passing matches no rule and the run fails. `ns` is part of
// the rule rather than part of its words, so a read that drops `-n "$LIVE_NAMESPACE"`
// stops answering as the live lane and starts failing instead of measuring the dev one.
const SHIM_RULES = [
  // `ensure_namespace` asks before it creates. A case that wants the create path
  // writes the marker, which is the first `up` on a cluster with no dev namespace.
  {
    cluster: 'a Namespace object is cluster-scoped, so the call carries no -n',
    match: ['get', 'namespace', DEV_NAMESPACE],
    body: `if [ -f "$fixtures/namespace-absent" ]; then
  echo 'Error from server (NotFound): namespaces "monoplayer-dev" not found' >&2
  exit 1
fi
exit 0`
  },
  {
    cluster: 'the Namespace object carries its own name',
    match: ['create', 'namespace', DEV_NAMESPACE, '--dry-run=client', '-o', 'yaml'],
    body: `echo '{"kind":"Namespace"}'
exit 0`
  },
  // Every `apply -f -` in this script applies a document that names its own
  // namespace on stdin, so it passes no -n and needs none.
  {
    cluster: 'the document on stdin names its own namespace',
    match: ['apply', '-f', '-'],
    body: `cat > /dev/null
echo applied
exit 0`
  },
  // No pull Secret in the dev namespace yet; the live one exists to copy.
  { ns: DEV_NAMESPACE, match: ['get', 'secret', 'dev-rcon'], body: 'exit 1' },
  {
    ns: DEV_NAMESPACE,
    match: ['create', 'secret', 'generic', 'dev-rcon', ANY, '--dry-run=client', '-o', 'yaml'],
    body: `echo '{"kind":"Secret"}'
exit 0`
  },
  { ns: DEV_NAMESPACE, match: ['get', 'secret', 'ghcr-pull'], body: 'exit 1' },
  {
    ns: LIVE_NAMESPACE,
    match: ['get', 'secret', 'ghcr-pull', '-o', 'json'],
    body: `cat "$fixtures/live-secret.json"
exit $?`
  },
  // An apply sets a key the manifest declares to the manifest's value, and leaves a
  // key it does not declare alone. That is the whole reset `up` has to survive, so
  // this arm writes the applied tree's document over the fixture, and writes nothing
  // when the tree declares no such key.
  {
    cluster: 'kustomize applies the namespaces the manifests declare',
    match: ['apply', '-k', ANY],
    body: `touch "$KUBECTL_MARKER"
cat > /dev/null
if [ -n "$KUBECTL_APPLIED_WHITELIST" ]; then echo "$KUBECTL_APPLIED_WHITELIST" > "$fixtures/dev-whitelist.json"; fi
echo applied
exit 0`
  },
  // The fixture is the cluster state: a read of an object no fixture holds answers
  // nothing and exits non-zero, the way kubectl fails a missing object.
  //
  // `dev-whitelist-error` is the other failure a read can have: the object is there
  // and the answer did not arrive. A script cannot tell it from an empty list by
  // looking at stdout alone, and that is what the case is about.
  {
    ns: DEV_NAMESPACE,
    match: ['get', 'configmap', 'monoplayer-dev-config', '-o', ANY],
    body: `if [ -f "$fixtures/dev-whitelist-error" ]; then
  echo 'Error from server (InternalError): the dev ConfigMap did not answer' >&2
  exit 1
fi
if [ ! -f "$fixtures/dev-whitelist.json" ]; then
  echo 'Error from server (NotFound): configmaps "monoplayer-dev-config" not found' >&2
  exit 1
fi
cat "$fixtures/dev-whitelist.json"
exit $?`
  },
  // The same read for the reason alone, which the script makes only after the first
  // one failed: stderr is the object's answer, so it carries no document.
  {
    ns: DEV_NAMESPACE,
    match: ['get', 'configmap', 'monoplayer-dev-config'],
    body: `if [ -f "$fixtures/dev-whitelist-error" ]; then
  echo 'Error from server (InternalError): the dev ConfigMap did not answer' >&2
  exit 1
fi
if [ ! -f "$fixtures/dev-whitelist.json" ]; then
  echo 'Error from server (NotFound): configmaps "monoplayer-dev-config" not found' >&2
  exit 1
fi
exit 0`
  },
  // The live list the seed copies from, and the reason read beside it.
  {
    ns: LIVE_NAMESPACE,
    match: ['get', 'configmap', 'monoplayer-config', '-o', ANY],
    body: `if [ -f "$fixtures/live-whitelist-error" ]; then
  echo 'Error from server (InternalError): the live ConfigMap did not answer' >&2
  exit 1
fi
cat "$fixtures/live-whitelist.json"
exit $?`
  },
  {
    ns: LIVE_NAMESPACE,
    match: ['get', 'configmap', 'monoplayer-config'],
    body: `if [ -f "$fixtures/live-whitelist-error" ]; then
  echo 'Error from server (InternalError): the live ConfigMap did not answer' >&2
  exit 1
fi
exit 0`
  },
  // A patch writes the one key it carries, so the fixture stays the cluster state.
  {
    ns: DEV_NAMESPACE,
    match: ['patch', 'configmap', 'monoplayer-dev-config', '--type', 'merge', '-p', ANY],
    body: `node "$KUBECTL_PATCH" "$@" > "$fixtures/dev-whitelist.json"
exit $?`
  },
  { ns: DEV_NAMESPACE, match: ['rollout', 'status', 'deploy/paper', ANY], body: 'exit 0' },
  // The live replica count, which `status` reports and `up` records twice.
  {
    ns: LIVE_NAMESPACE,
    match: ['get', 'deploy', 'monoplayer', '-o', ANY],
    body: `if [ -f "$KUBECTL_MARKER" ]; then echo "$KUBECTL_REPLICAS_AFTER"; else echo "$KUBECTL_REPLICAS_BEFORE"; fi
exit 0`
  },
  // The dev proxy, asked for after the apply so `up` can say it exists.
  { ns: DEV_NAMESPACE, match: ['get', 'deploy', 'monoplayer'], body: 'exit 0' },
  {
    ns: DEV_NAMESPACE,
    match: ['delete', 'deployment,service,configmap', '-l', 'app.kubernetes.io/part-of=monoplayer', '--ignore-not-found'],
    body: 'exit 0'
  },
  {
    ns: DEV_NAMESPACE,
    match: ['delete', 'pod', '-l', 'app.kubernetes.io/name=monoplayer-dev-custody', '--ignore-not-found'],
    body: 'exit 0'
  },
  {
    cluster: 'the Namespace object carries its own name, so --purge names it directly',
    match: ['delete', 'namespace', DEV_NAMESPACE, '--ignore-not-found'],
    body: 'exit 0'
  },
  {
    ns: DEV_NAMESPACE,
    match: ['get', 'pods', '--no-headers'],
    body: `echo 'paper-abc 1/1 Running 0 1m'
exit 0`
  },
  { ns: DEV_NAMESPACE, match: ['set', 'image', 'deploy/monoplayer', ANY], body: 'exit 0' },
  { ns: DEV_NAMESPACE, match: ['rollout', 'status', 'deploy/monoplayer', ANY], body: 'exit 0' },
  // The dev proxy's account, read from its volume, and the dev Paper's player list,
  // read over RCON.
  {
    ns: DEV_NAMESPACE,
    match: ['exec', 'deploy/monoplayer', '-c', 'monoplayer', '--', 'node', '-e', ANY],
    body: `printf '%s' "$KUBECTL_ACCOUNT_NAME"
exit 0`
  },
  {
    ns: DEV_NAMESPACE,
    match: ['exec', 'deploy/paper', '-c', 'paper', '--', 'rcon-cli', 'list'],
    body: `echo "$KUBECTL_RCON"
exit 0`
  },
  // The proxy's records, which is where the lane says whether it is a picker and
  // whether a claim has dialled (#676). The container is named, because the pod has
  // init containers too and a default would put kubectl's warning on stderr.
  {
    ns: DEV_NAMESPACE,
    match: ['logs', 'deploy/monoplayer', '-c', 'monoplayer'],
    body: `cat "$fixtures/proxy-log.jsonl"
exit $?`
  },
]

const { script: SHIM, ids: SHIM_IDS } = kubectlShim(SHIM_RULES, { prelude: ['fixtures="$KUBECTL_FIXTURES"'] })

// The merge patch `dev-lane.sh` sends: one key, one value. The shim applies it to
// the fixture, so the fixture keeps being the cluster's copy of the ConfigMap.
const PATCH = [
  'const args = process.argv.slice(2)',
  'const at = args.indexOf("-p")',
  'if (at < 0) { process.exit(1) }',
  'const body = JSON.parse(args[at + 1])',
  'process.stdout.write(String(body.data["attach-whitelist.json"]) + "\\n")',
  ''
].join('\n')

// What `apply -k deploy/dev` leaves in the whitelist key. Read from the manifest
// rather than restated here: the cases are about what the tree does to the key, and
// a hand-written copy would keep passing after the manifest changed.
function whitelistText (text) {
  const declared = text.match(/^ {2}attach-whitelist\.json: \|\n((?: {4}.*\n?)+)/m)
  return declared ? declared[1].replace(/^ {4}/gm, '').trimEnd() : ''
}

function appliedWhitelist () {
  return whitelistText(fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8'))
}

function workspace () {
  const dir = tempRoot('monoplayer-dev-lane-')
  const bin = path.join(dir, 'bin')
  const fixtures = path.join(dir, 'fixtures')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(fixtures, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'kubectl-patch.cjs'), PATCH)
  fs.writeFileSync(path.join(fixtures, 'live-secret.json'), LIVE_SECRET + '\n')
  fs.writeFileSync(path.join(fixtures, 'dev-whitelist.json'), EMPTY_WHITELIST + '\n')
  fs.writeFileSync(path.join(fixtures, 'live-whitelist.json'), EMPTY_WHITELIST + '\n')
  fs.writeFileSync(path.join(fixtures, 'proxy-log.jsonl'), LANDED_LOG)
  return {
    dir,
    bin,
    fixtures,
    patch: path.join(dir, 'kubectl-patch.cjs'),
    log: path.join(dir, 'kubectl.log'),
    marker: path.join(dir, 'applied')
  }
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
      KUBECTL_PATCH: space.patch,
      KUBECTL_APPLIED_WHITELIST: appliedWhitelist(),
      KUBECTL_ACCOUNT_NAME: 'DevPuppet',
      KUBECTL_RCON: PLAYER_LIST,
      KUBECTL_HITS: HITS,
      MONOPLAYER_DEV_JOIN_REPORT: path.join(space.dir, 'dev-join.json'),
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  // A call the shim does not model fails there and lands here, so a case reports it
  // even when the script swallowed the status.
  const refused = unmodelled(space.log)
  assert.deepEqual(refused, [], 'the shim modelled every call: ' + refused.join(' | '))
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

// The report `join` writes, read back. Its `state` is the lane's own word for what
// it saw, which is what a script reads: exit 0 covers an idle lane as well as a join
// (#676).
function reportOf (space) {
  return JSON.parse(fs.readFileSync(path.join(space.dir, 'dev-join.json'), 'utf8'))
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

test('status names each attach whitelist entry, and which of them can authenticate', () => {
  // #677: "attach whitelist has entries" is true and useless. Three entries read as
  // three controllers, and two of these are the loopback rig's names, which the Mojang
  // check can never answer for. The line has to name the entries and say which ones a
  // login can actually use.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), RIG_WHITELIST + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.doesNotMatch(output, /attach whitelist has entries/,
    'a count that names nobody is the defect this case is about: ' + output)
  assert.match(output, /attach whitelist names 3 entries, 1 of which can authenticate/)
  assert.match(output, /Bafbi 6eb73524-ff88-4a62-a8d0-c63905e7afba can authenticate/)
  assert.match(output, /Pilot 62e2a856-7342-3096-b19f-938454443a11 cannot authenticate/)
  assert.match(output, /Watcher e0314eaa-f0cf-36b0-ad18-d19b22fa52c8 cannot authenticate/)
  assert.match(output, /md5\("OfflinePlayer:Pilot"\)/,
    'the line says what makes the entry useless, so the reader knows which edit removes it: ' + output)
  assert.match(output, /Remove the entry/, 'and says what to do about it')
})

test('status says every entry can authenticate when every uuid is one Mojang issues', () => {
  // The other side of the verdict: a lane whose list is all real accounts is not a lane
  // with a warning on it, and the line has to be able to say so.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /attach whitelist names 1 entry, and it can authenticate/)
  assert.doesNotMatch(output, /cannot authenticate/, output)
})

test('status judges a uuid by its version, whichever spelling it is written in', () => {
  // The custody store takes a uuid without dashes (src/custody/util.js, normalizeUuid), so
  // a document can carry one. The version digit then sits at index 12 of the digits rather
  // than 14 of the string, and a reader that spells it one way reports an undashed rig
  // uuid as usable. Mojang issues version 4; every other version is a control document's
  // own invention, and this case holds one of each shape.
  const space = workspace()
  const document = JSON.stringify({
    version: 1,
    players: [
      { uuid: offlineUuid('Pilot').replace(/-/g, ''), name: 'Pilot' },
      { uuid: '06a81639-2178-568a-abb3-3f762836f9a4', name: 'VersionFive' },
      { uuid: 'not-a-uuid', name: 'Garbage' }
    ]
  })
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), document + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /attach whitelist names 3 entries, and none of them can authenticate/)
  assert.match(output, /Pilot [0-9a-f]{32} cannot authenticate: its uuid is md5\("OfflinePlayer:Pilot"\)/,
    'the undashed spelling is read for the version it carries: ' + output)
  assert.match(output, /VersionFive .* cannot authenticate: a version-5 uuid is not one Mojang issues/)
  assert.match(output, /Garbage not-a-uuid cannot authenticate: it is not a uuid, so no login can match it/)
})

test('status reads a padded uuid the way the custody store does', () => {
  // #703, and the one behaviour the old copy got wrong in the direction that loses an
  // entry: it lowercased and de-dashed the string without trimming it, so an entry a login
  // can use was dropped here and by `dev:up`'s prune. `normalizeUuid` trims
  // (src/custody/util.js), and the store (src/custody/store.js) and the panel
  // (src/panel/routes/whitelist.js) both parse entries through it, so a hand-edited
  // document now reads the same way in all three. deploy/dev/README.md tells the operator
  // to edit the ConfigMap, which is where a stray space comes from.
  const space = workspace()
  const document = JSON.stringify({
    version: 1,
    players: [{ uuid: ' 6eb73524-ff88-4a62-a8d0-c63905e7afba ', name: 'Bafbi' }]
  })
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), document + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /attach whitelist names 1 entry, and it can authenticate/, output)
})

test('status does not report a document it could not read as an empty list', () => {
  // The read answered, and the answer was not a document. Saying "names 0 entries" here is
  // the same defect as the count this ticket is about: a lane reported as fine because
  // nothing looked.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), '{"version":1,"players":[{"uuid":\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /attach whitelist could not be read as a document/)
  assert.doesNotMatch(output, /attach whitelist is empty/, output)
  assert.doesNotMatch(output, /attach whitelist names/, output)
})

test('status does not call an entry dead for carrying no name', () => {
  // The whitelist is keyed by uuid alone (src/custody/attach.js), so a name is a label and
  // not a condition: the judgement reads it to name the string it hashed, and an entry
  // without one still authenticates. The line says which field it is missing.
  const space = workspace()
  const nameless = '{"version":1,"players":[{"uuid":"6eb73524-ff88-4a62-a8d0-c63905e7afba"}]}'
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), nameless + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /\(no name\) 6eb73524-ff88-4a62-a8d0-c63905e7afba can authenticate/)
  assert.match(output, /attach whitelist names 1 entry, and it can authenticate/)
})

test('status says so when no entry can authenticate, which is a lane that admits nobody', () => {
  // A list of rig names is the shape this defect grows into: every entry is there, the
  // count is not zero, and not one of them can log in.
  const space = workspace()
  const rigs = JSON.stringify({
    version: 1,
    players: [{ uuid: offlineUuid('Pilot'), name: 'Pilot' }, { uuid: offlineUuid('Watcher'), name: 'Watcher' }]
  })
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), rigs + '\n')
  const { status, output } = run(space, ['status'])
  assert.equal(status, 0, output)
  assert.match(output, /attach whitelist names 2 entries, and none of them can authenticate/)
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
  // The whitelist does not stay, and a stop is where an entry is lost without a word.
  assert.match(output, /the dev attach whitelist went with its ConfigMap/)
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
  // An empty whitelist denies every login, so the shipped empty ConfigMap leaves the
  // lane with nothing to attach: the seed is what gives it a controller (#43 AC3).
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

test('up writes back only the attach whitelist entries a login can use', () => {
  // #677: `up` is what carries a list across its own apply, so it is the step that puts
  // a rig name into a live control document. An entry no Mojang session can answer for
  // is not a controller: it is left out of the list the lane ends up with, and named.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), RIG_WHITELIST + '\n')
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + run(space, ['status']).calls.join(' | '))
  const after = JSON.parse(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8'))
  assert.deepEqual(after.players.map(player => player.name), ['Bafbi'],
    'the account that can authenticate is the list that crosses the apply: ' + output)
  assert.match(output, /dropped Pilot 62e2a856-7342-3096-b19f-938454443a11 from the attach whitelist/)
  assert.match(output, /dropped Watcher e0314eaa-f0cf-36b0-ad18-d19b22fa52c8 from the attach whitelist/)
  assert.match(output, /md5\("OfflinePlayer:Pilot"\)/, 'the run says why the entry could never attach')
})

test('up drops a rig name from the list it copies from the live lane', () => {
  // A seed is a write, so it is judged like one: the live document is hand-edited too,
  // and copying it is how the same trap reaches a lane nothing edited.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), RIG_WHITELIST + '\n')
  const { status, output } = run(space, ['up'])
  assert.equal(status, 0, output)
  const after = JSON.parse(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8'))
  assert.deepEqual(after.players.map(player => player.name), ['Bafbi'],
    'the seed writes the entries that can authenticate and no others: ' + output)
  assert.match(output, /dropped Pilot .* from the attach whitelist/)
  assert.match(output, /filled the dev attach whitelist from monoplayer/)
})

test('up leaves a list that is all real accounts exactly as it found it', () => {
  // The prune is not a rewrite: a document whose entries can authenticate crosses the
  // apply byte for byte, addedAt stamps and all.
  const space = workspace()
  const kept = '{"version":1,"players":[{"uuid":"6eb73524-ff88-4a62-a8d0-c63905e7afba","name":"Bafbi","addedAt":"2026-11-07T13:04:51.092Z"}]}'
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), kept + '\n')
  const { status, output } = run(space, ['up'])
  assert.equal(status, 0, output)
  assert.doesNotMatch(output, /dropped/, 'nothing was dropped, so nothing is named: ' + output)
  assert.equal(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8').trim(), kept)
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

test('up carries an operator controller across the apply that resets it', () => {
  // The applied ConfigMap ships the empty document, so every apply sets the key to
  // it (#393). An entry the operator added is in no live list, so no seed can bring
  // it back: up reads the list before the apply and writes it back after.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), OPERATOR_WHITELIST + '\n')
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), LIVE_WHITELIST + '\n')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.match(appliedWhitelist(), /"players": \[\]/,
    'the applied tree ships the empty list, which is the reset this case is about')
  const after = JSON.parse(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8'))
  assert.deepEqual(after.players.map(player => player.name), ['OperatorController'],
    'the entry the lane held before up is the one it holds after: ' + output)
  assert.match(output, /the entries it held were written back/, 'the run says the list crossed the apply')
  assert.equal(calls.some(line => line.includes('Bafbi')), false,
    'the live list did not replace the operator: ' + calls.join(' | '))
})

test('up does not keep an applied entry a login can never use', () => {
  // The manifest is another way a rig name reaches the lane, and the committed-document
  // case is what keeps one from being committed. While one is there, the apply has already
  // written it, so the drop is a write of the one key and the run names it.
  const space = workspace()
  const applied = JSON.stringify({
    version: 1,
    players: [
      { uuid: '6eb73524-ff88-4a62-a8d0-c63905e7afba', name: 'Bafbi' },
      { uuid: offlineUuid('Pilot'), name: 'Pilot' }
    ]
  })
  const { status, output, calls } = run(space, ['up'], { KUBECTL_APPLIED_WHITELIST: applied })
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const after = JSON.parse(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8'))
  assert.deepEqual(after.players.map(player => player.name), ['Bafbi'],
    'the applied list is written back without the entry it can never verify: ' + output)
  assert.match(output, /dropped Pilot .* from the attach whitelist/)
  assert.match(output, /the applied attach whitelist names controllers/)
})

test('up keeps the list the manifest applies instead of the live one', () => {
  // The document in Git is the list the lane offers, the rule the picker row already
  // follows (#392): an edit there reaches the lane on the next up. The live list is
  // the answer for a document that names nobody, not an override of one that does.
  const space = workspace()
  // The lane holds an operator's controller, and the document the apply writes names
  // someone else. Nothing merges the two, so the run has to say what it dropped.
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), OPERATOR_WHITELIST + '\n')
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist.json'), LIVE_WHITELIST + '\n')
  const applied = '{"version":1,"players":[{"uuid":"7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f","name":"FromManifest"}]}'
  const { status, output, calls } = run(space, ['up'], { KUBECTL_APPLIED_WHITELIST: applied })
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const after = JSON.parse(fs.readFileSync(path.join(space.fixtures, 'dev-whitelist.json'), 'utf8'))
  assert.deepEqual(after.players.map(player => player.name), ['FromManifest'],
    'the applied document is the list the lane holds: ' + output)
  assert.equal(calls.some(line => line.includes('Bafbi')), false,
    'the live list did not replace a document that names someone: ' + calls.join(' | '))
  assert.match(output, /the applied attach whitelist names controllers/)
  assert.match(output, /the list it replaced is gone: OperatorController/,
    'the entry that did not cross is named, with the reason the applied list wins: ' + output)
})

test('up refuses to seed when it cannot read the dev whitelist', () => {
  // Answering "empty" to a failed read is the other way the entries go: the seed
  // would then let the live list replace a list nobody saw. An empty list and an
  // answer that did not arrive are two different states, and only one of them means
  // the lane has no controller to keep.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist.json'), OPERATOR_WHITELIST + '\n')
  fs.writeFileSync(path.join(space.fixtures, 'dev-whitelist-error'), '')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 1, output + '\ncalls: ' + calls.join(' | '))
  assert.match(output, /cannot read the attach whitelist from monoplayer-dev\/monoplayer-dev-config/)
  assert.equal(calls.some(line => line.includes('apply -k')), false, 'it stopped before the lane was applied')
  assert.equal(calls.some(line => line.includes('patch configmap')), false, 'it wrote nothing')
})

test('the dev whitelist comment states what up and down do to it', () => {
  // The comment and the runbook said an empty list makes `--start` refuse to run,
  // and that an operator's edit is never overwritten. Neither was true: the service
  // starts and logs `whitelistEmpty` (src/service/start-live.js), and the apply that
  // runs before the seed resets the key. Prose is pinned here because the two claims
  // are read by an operator deciding whether to add a controller.
  const docs = [
    ['deploy/dev/monoplayer.yaml', fs.readFileSync(path.join(DEV, 'monoplayer.yaml'), 'utf8')],
    ['deploy/dev/README.md', fs.readFileSync(path.join(DEV, 'README.md'), 'utf8')]
  ]
  for (const [name, text] of docs) {
    assert.doesNotMatch(text, /refuses an empty (attach )?whitelist|refuses an empty list/,
      name + ' claims a refusal that does not happen: an empty whitelist is a warning and the service starts')
    assert.match(text, /whitelistEmpty/, name + ' names the line an empty list produces, so the claim is checkable')
    // Both commands, so a reader learns what a stop takes as well as what up does.
    assert.match(text, /dev:up/, name + ' names the command that writes the list')
    assert.match(text, /dev:down/, name + ' names the command that deletes it')
  }
})

test('no committed attach whitelist names a uuid derived from its own name', () => {
  // #677: the trap is cheap to see and hard to see in a run. Every committed document
  // is read here, because the dev lane's is the one an edit reaches the lane through and
  // the live one is what the dev seed copies.
  //
  // The rule is `uuidRefusalReason` in src/custody/util.js: this front verifies each login
  // against Mojang (`online-mode` `hasJoined`, then the whitelist review the core runs at
  // Login Start, #756), so an entry no Mojang session answers for can never attach. The
  // offline legs are the lane
  // where a name-derived uuid belongs (GLOSSARY.md, "test-double lane"), and no manifest
  // here composes them. This case asks that function rather than spelling any part of the
  // rule a second time (#703).
  //
  // What this case does not carry: the dev document is empty, so the loop below reads one
  // entry in the tree today. The teeth are the fixture cases above, which run the script
  // against a document holding both shapes. This one is the trap that stops a rig name
  // from being committed in the first place, and it fails the moment one is.
  const files = ['deploy/dev/monoplayer.yaml', 'deploy/manifests/configmap.yaml']
  for (const file of files) {
    const document = JSON.parse(whitelistText(fs.readFileSync(path.join(ROOT, file), 'utf8')))
    assert.ok(Array.isArray(document.players), file + ' declares the player array')
    for (const player of document.players) {
      // One answer, from the module that owns it: the shape, the version the uuid carries,
      // and the md5 of the entry's own name are one refusal, not three checks. A reader
      // that spells one of them here is the second rule #677 paid for (#703).
      const name = typeof player.name === 'string' && player.name !== '' ? player.name : null
      const refused = uuidRefusalReason(player.uuid, name)
      assert.equal(refused, null,
        file + ' names ' + player.name + ' ' + player.uuid + ', and no Mojang session answers for it: ' + refused + ' (#677)')
    }
  }
  for (const { name, text } of manifests()) {
    assert.doesNotMatch(text, /MONOPLAYER_OFFLINE_LEGS/,
      name + ' composes the offline legs, which is the one lane a name-derived uuid belongs to: docs/deployment.md')
  }
})

test('the uuid predicate has one home, and every reader asks it', () => {
  // #703: three places decided whether an attach-whitelist uuid can be authenticated, and
  // each spelled the version itself. `scripts/dev-lane.sh` read the thirteenth digit of
  // the digits, this file read the same digit at a different index, and a reader that reads
  // one spelling lets an entry written in the other through. This case holds each of them
  // to the one home: a reader that spells the version again is the defect, and it is
  // cheaper to see here than in a run.
  //
  // A version check is one of three shapes (an index, a `charAt`, or a comparison against
  // the number), so all three are refused rather than the spelling the tree uses today.
  const script = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(script, /await import\([^\n]*\/src\/custody\/util\.js['"]?\)/,
    'dev-lane.sh imports the judgement from the custody module')
  assert.match(script, /uuidRefusalReason\(/, 'and calls it, rather than naming it in a comment')
  assert.doesNotMatch(script, /charAt\(|[!=]==\s*["']4["']|[!=]==\s*4\b/,
    'and reads no version of its own: the digit sits at a different index in each spelling, which is how one reader let an undashed uuid through')
  assert.doesNotMatch(script, /\^\[0-9a-f\]\{32\}\$/,
    'and checks no shape of its own: normalizeUuid is the reader that knows both spellings')
  assert.doesNotMatch(script, /offlineUuid\(/,
    'and hashes no name of its own: the name-derived case is part of the same answer, not a second rule')

  // This file is a reader too, and a guard is the easiest place to spell the rule again.
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(own, /uuidRefusalReason\(/, 'this file asks the same function')
  assert.doesNotMatch(own, /charAt\(|[!=]==\s*["']4["']|[!=]==\s*4\b/, 'and reads no version itself')

  // The panel route, which #704 already pointed at the function.
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'panel', 'routes', 'whitelist.js'), 'utf8')
  assert.match(panel, /uuidRefusalReason\(/, 'the panel route asks it too')
  assert.doesNotMatch(panel, /charAt\(|[!=]==\s*["']4["']|[!=]==\s*4\b/, 'and reads no version itself')

  // The runbook is a reader too, and it was one of the three places that stated the rule
  // in prose (#703). A pointer nothing checks is the copy that drifts, so the section that
  // carries the rule is held to the function the way the code is.
  const runbook = fs.readFileSync(path.join(DEV, 'README.md'), 'utf8')
  const start = runbook.indexOf('## The attach whitelist')
  assert.ok(start >= 0, 'deploy/dev/README.md keeps the section that carries the rule')
  const next = runbook.indexOf('\n## ', start + 1)
  const rules = runbook.slice(start, next === -1 ? runbook.length : next)
  assert.match(rules, /uuidRefusalReason/, 'the section names the function, so a reader checks the code rather than trusting the page')
  assert.match(rules, /src\/custody\/util\.js/, 'and the file it lives in')
  assert.doesNotMatch(rules, /nameUUIDFromBytes|version 4|version-4/,
    'and states no version of its own: the docstring is where the versions are written down')
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
    joined: true,
    state: 'landed'
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
  // The lane is a picker and a claim landed, so the failure names the claim rather than
  // the lane's boot: the boot dialled nothing on purpose (#676).
  assert.match(output, /a claim's body landed and has since disconnected/)
  assert.equal(reportOf(space).state, 'landed')
})

test('join says a claim has not landed yet while its dial is in flight', () => {
  // `claimDial` is written before the socket opens (src/service/monoplayer.js:2715), and
  // the connect budget is 240 s against a 60 s poll. So a claim a player just made is
  // not a failed login, and the sentence must not say it is.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), CLAIMED_LOG)
  const { status, output } = run(space, ['join'], {
    KUBECTL_RCON: 'There are 0 of a max of 8 players online:',
    MONOPLAYER_DEV_JOIN_TIMEOUT: '0'
  })
  assert.equal(status, 1, output)
  assert.match(output, /no landing followed/, 'it names what it did not see')
  assert.match(output, /no claimBodyWarm/, 'and the record it looked for')
  assert.match(output, /wait, then run this again/, 'and what to do about it')
  assert.doesNotMatch(output, /did not land/, 'a dial in flight is not a failed login')
  assert.equal(reportOf(space).state, 'claimed')
})

// #676. A picker lane dials no body at boot, so with nothing claimed the account is
// not on the Paper and the lane is working exactly as designed
// (dialBodyAtBoot, src/service/start-live.js). Reporting that as a failed login is a
// red line an operator reads as a broken lane, which is what these cases pin.
test('join says the lane is idle when nothing has claimed, and exits 0', () => {
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), IDLE_LOG)
  const { status, output, calls } = run(space, ['join'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  // Not a word of failure, and the record that proves the lane is a picker.
  assert.doesNotMatch(output, /did not land/, 'an idle picker lane is not a failed login')
  assert.match(output, /nothing has claimed/, 'the answer is that no claim has arrived yet')
  assert.match(output, /backendBootSkipped/, 'the record that proves it is named')
  assert.match(output, /DevPuppet/, 'and the account the report is about')
  assert.match(output, /claim a row/, 'and what to do about it')
  // The lane holds still until a claim, so there is nothing to wait for: a 60 s
  // poll would end at the same answer, later, and as a failure.
  assert.equal(calls.some(line => line.includes('rcon-cli list')), false,
    'it does not poll the Paper for a body no claim dialled: ' + calls.join(' | '))
  // No player list and no evidence: RCON never ran, and a read that did not run is not
  // a report about the Paper (see the same rule in `status`).
  assert.deepEqual(reportOf(space), {
    namespace: DEV_NAMESPACE,
    account: 'DevPuppet',
    joined: false,
    state: 'idle'
  })
})

test('join fails when a claim dialled no body', () => {
  // The other half of #676: the lane is a picker and a claim did arrive, and its body
  // did not land. Nothing is connected, so this is the lane's failure and not its rest.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), CLAIM_FAILED_LOG)
  const { status, output, calls } = run(space, ['join'])
  assert.equal(status, 1, output)
  assert.match(output, /claimDialFailed/, 'the record that proves the claim\'s body did not land is named')
  assert.doesNotMatch(output, /nothing has claimed/, 'a claim did arrive, so the lane is not idle')
  assert.match(output, /DevPuppet is not on the dev Paper/)
  assert.equal(calls.some(line => line.includes('rcon-cli list')), false,
    'it does not poll the Paper for a body that never opened: ' + calls.join(' | '))
  assert.equal(reportOf(space).state, 'claim-failed')
})

test('join fails when a claim was refused before it dialled', () => {
  // A row with no target, or a leg that refuses the target, refuses the claim before any
  // dial: `claimDialRefused` with `no_target` or `target_refused`
  // (src/service/monoplayer.js:2664, :2696). The lane did have a claim, so "nothing has
  // claimed, claim a row again" would be advice that cannot converge.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), CLAIM_REFUSED_LOG)
  const { status, output } = run(space, ['join'])
  assert.equal(status, 1, output)
  assert.match(output, /claimDialRefused/, 'the record that proves the refusal is named')
  assert.doesNotMatch(output, /nothing has claimed/, 'a claim arrived, so the lane is not idle')
  assert.equal(reportOf(space).state, 'claim-failed')
})

test('join does not call a rotated log a lane that dials at boot', () => {
  // A picker lane whose boot records have rotated away still holds heartbeats. Reading
  // that absence as "the picker is off" would print the sentence #676 exists to delete,
  // from a log that never said so.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), NO_BOOT_LOG)
  const { status, output } = run(space, ['join'], {
    KUBECTL_RCON: 'There are 0 of a max of 8 players online:',
    MONOPLAYER_DEV_JOIN_TIMEOUT: '0'
  })
  assert.equal(status, 1, output)
  assert.match(output, /says nothing about this lane's boot \(no-boot-record\)/, 'it names what it could not see')
  assert.doesNotMatch(output, /did not land\b(?! *\()/, 'a log that said nothing is not a failed login')
  assert.equal(reportOf(space).state, 'unknown')
})

test('join removes the last run report before it answers', () => {
  // The report is what a script reads, and a run that dies before writing one must not
  // leave the previous answer behind: a stale "joined": true is the one confidently
  // wrong yes this command could give.
  const space = workspace()
  fs.writeFileSync(path.join(space.dir, 'dev-join.json'), JSON.stringify({ joined: true }) + '\n')
  const { status } = run(space, ['join'], { KUBECTL_ACCOUNT_NAME: '' })
  assert.equal(status, 2, 'the profile read refused')
  assert.equal(fs.existsSync(path.join(space.dir, 'dev-join.json')), false, 'the stale report is gone')
})

test('the runbook lists every state the script can write', () => {
  // The report's `state` is the machine-readable half of `join` (#676): exit 0 covers an
  // idle lane as well as a join, so a script reads this word. The list is taken from the
  // docblock that declares the states rather than restated, so a state added to the code
  // and not to the runbook is a failure here, not a reader left looking.
  const script = fs.readFileSync(SCRIPT, 'utf8')
  const runbook = fs.readFileSync(path.join(ROOT, 'deploy', 'dev', 'README.md'), 'utf8')
  const states = [...script.matchAll(/^#   ([a-z][a-z-]*) {2,}\S/gm)].map(match => match[1])
  assert.ok(states.length > 1, 'the docblock declares the states it can write: ' + states.join(', '))
  for (const state of states) {
    assert.ok(script.includes('"' + state + '"'), 'dev-lane.sh can write the state ' + state)
    assert.ok(runbook.includes('`' + state + '`'), 'deploy/dev/README.md lists the state ' + state)
  }
})

test('the join sentences name records the service writes', () => {
  // #676: the idle sentence tells an operator which record proves the lane is a
  // picker, and the failure sentences name the records a claim leaves. A message that
  // names a record nothing writes is a reader with no way to check the claim, so the
  // names are held to the modules that write them.
  const sentences = fs.readFileSync(SCRIPT, 'utf8').split('\n')
  const said = line => line.trim().startsWith('say "') || line.trim().startsWith('die "')
  const idle = sentences.filter(line => said(line) && line.includes('nothing has claimed'))
  assert.equal(idle.length, 1, 'one sentence reports the idle lane, found ' + idle.length)
  assert.match(idle[0], /backendBootSkipped reason picker/, 'the idle sentence names the boot record')
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'service', 'start-live.js'), 'utf8'),
    /log\('backendBootSkipped', \{ reason: 'picker' \}\)/,
    'src/service/start-live.js writes backendBootSkipped with reason picker')
  const failed = sentences.filter(line => said(line) && line.includes('did not land ('))
  assert.equal(failed.length, 1, 'one sentence reports a claim whose body did not land')
  assert.match(failed[0], /logs deploy\/monoplayer/, 'and names the command that shows why')
  // Every record the states are read from, held to the module that writes it.
  const service = fs.readFileSync(path.join(ROOT, 'src', 'service', 'monoplayer.js'), 'utf8')
  for (const record of ['claimDial', 'claimDialFailed', 'claimDialRefused', 'claimBodyWarm']) {
    assert.ok(fs.readFileSync(SCRIPT, 'utf8').includes('"' + record + '"'), 'dev-lane.sh reads ' + record)
    assert.ok(service.includes("log('" + record + "'"), 'src/service/monoplayer.js writes ' + record)
  }
  // And the boot answer the picker state is read from, which is the start record's own
  // field rather than the absence of a skip record.
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'service', 'start-live.js'), 'utf8'),
    /picker: cfg\.picker,/, 'the startLive record carries the picker answer')
})

test('join keeps the login-failure sentence on a lane that dialled at boot', () => {
  // A lane with the picker off has the login at boot, so its failure is the one this
  // script has always reported, and the picker branch must not swallow it.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'proxy-log.jsonl'), BOOT_DIALLED_LOG)
  const { status, output } = run(space, ['join'], {
    KUBECTL_RCON: 'There are 0 of a max of 8 players online:',
    MONOPLAYER_DEV_JOIN_TIMEOUT: '0'
  })
  assert.equal(status, 1, output)
  assert.match(output, /the proxy is up but the backend login did not land/)
  assert.equal(reportOf(space).state, 'boot')
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
test('up creates the dev namespace when the cluster has none', () => {
  // `ensure_namespace` asks before it creates. Every other case answers that the
  // namespace is there, which is the lane's usual state, and an arm that answered
  // without being asked would leave the create path untested (#152).
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'namespace-absent'), '')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  const create = calls.findIndex(line => line === 'create namespace monoplayer-dev --dry-run=client -o yaml')
  assert.ok(create >= 0, 'the namespace is created: ' + calls.join(' | '))
  const apply = calls.findIndex((line, at) => at > create && line === 'apply -f -')
  assert.ok(apply > create, 'the created namespace is applied')
  assert.ok(calls.some(line => line.startsWith('apply -k ')), 'the lane is applied after its namespace exists')
})

test('up says so when the dev list is empty and the live list cannot be read', () => {
  // The other half of the seed rule: an empty lane whose live list did not answer is
  // not a lane to fill from nothing. The two reads fail together, because a kubectl
  // that cannot answer the document cannot answer the reason either.
  const space = workspace()
  fs.writeFileSync(path.join(space.fixtures, 'live-whitelist-error'), '')
  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.match(output, /the dev attach whitelist is empty and the live one could not be read/)
  assert.equal(calls.some(line => line.includes('patch configmap')), false, 'nothing was written from a read that failed')
})

test('every rule of the shim is reached by a case', () => {
  // An arm no case reaches is an arm nobody checks: it models a call the script no
  // longer makes, or a case is missing for a call it does make (#152).
  assert.deepEqual(deadRules(HITS, SHIM_IDS), [], 'no rule is dead: every one fired in some case')
})

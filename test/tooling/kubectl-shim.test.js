// The cases for test/support/kubectl-shim.js (#152): the properties every tooling
// shim now inherits, held here instead of five times.
//
// A fake kubectl that answers an argv it does not model is a test that cannot fail,
// so the three answers below are the whole point of the module: a call nobody
// modelled fails, a call missing the namespace its rule names fails, and a call whose
// words differ from the rule's fails. The last two are the arms that used to match a
// substring, which is how a script that dropped `-n "$LIVE_NAMESPACE"` stayed green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempRoot } from '../support/temp.js'
import { ANY, REST, endingWith, kubectlShim, unmodelled } from '../support/kubectl-shim.js'

// One shim in its own bin, and the log its cases read. The rule answers the live
// replica read, the call the namespace defect was found on.
function fake (rules, options) {
  const dir = tempRoot('monoplayer-kubectl-shim-')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const { script } = kubectlShim(rules, options)
  fs.writeFileSync(path.join(bin, 'kubectl'), script, { mode: 0o755 })
  const log = path.join(dir, 'kubectl.log')
  const hits = path.join(dir, 'kubectl.log.hits')
  const call = (...argv) => {
    const result = spawnSync(path.join(bin, 'kubectl'), argv, { encoding: 'utf8', env: { ...process.env, KUBECTL_LOG: log, KUBECTL_HITS: hits } })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, hits: reads(hits), refused: unmodelled(log) }
  }
  return { dir, call, log, hits }
}

const reads = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []

const REPLICAS = {
  why: 'the live replica read',
  ns: 'monoplayer',
  match: ['get', 'deploy', 'monoplayer', '-o', 'jsonpath={.status.availableReplicas}'],
  body: "printf '1\\n'; exit 0"
}

test('an argv no rule models fails, and names the argv it saw', () => {
  const space = fake([REPLICAS])
  const call = space.call('-n', 'monoplayer', 'get', 'configmap', 'monoplayer-config')
  assert.notEqual(call.status, 0, 'the call fails')
  assert.match(call.stderr, /unmodelled argv: -n monoplayer get configmap monoplayer-config/,
    'the message names the argv, so a red gate says which call nobody modelled')
  assert.deepEqual(call.refused, ['-n monoplayer get configmap monoplayer-config'],
    'the argv is on the record too, so a script that swallowed the status still fails')
  assert.deepEqual(call.hits, [], 'no rule answered it')
})

test('a rule answers only the namespace it names', () => {
  const space = fake([REPLICAS])
  assert.equal(space.call('-n', 'monoplayer', 'get', 'deploy', 'monoplayer', '-o', 'jsonpath={.status.availableReplicas}').status, 0,
    'the call the rule models is answered')
  // The defect: `-n "$LIVE_NAMESPACE"` dropped from live_replicas. The same words
  // against the dev lane must not match, or the report measures the dev namespace.
  const dropped = space.call('get', 'deploy', 'monoplayer', '-o', 'jsonpath={.status.availableReplicas}')
  assert.notEqual(dropped.status, 0, 'a call with no namespace is not the call the rule names')
  const dev = space.call('-n', 'monoplayer-dev', 'get', 'deploy', 'monoplayer', '-o', 'jsonpath={.status.availableReplicas}')
  assert.notEqual(dev.status, 0, 'another namespace is not the namespace the rule names')
  assert.equal(unmodelled(space.log).length, 2, 'both are on the record')
})

test('a rule matches its words exactly, and ANY stands for one word', () => {
  const space = fake([{ ns: 'monoplayer-dev', match: ['get', 'configmap', 'monoplayer-dev-config', '-o', ANY], body: "printf '{}' ; exit 0" }])
  assert.equal(space.call('-n', 'monoplayer-dev', 'get', 'configmap', 'monoplayer-dev-config', '-o', 'jsonpath={.data}').status, 0,
    'one word in the hole is answered')
  assert.notEqual(space.call('-n', 'monoplayer-dev', 'get', 'configmap', 'monoplayer-dev-config', '-o', 'jsonpath={.data}', '--raw').status, 0,
    'a word the rule does not name makes it a different call')
  assert.notEqual(space.call('-n', 'monoplayer-dev', 'get', 'configmap', 'monoplayer-dev-config').status, 0,
    'a call missing a word is not the call the rule names')
  assert.notEqual(space.call('-n', 'monoplayer-dev', 'get', 'configmaps', 'monoplayer-dev-config', '-o', 'x').status, 0,
    'a different resource is a different call')
})

test('a rule past its ninth word still reads the word it names', () => {
  // `$10` in shell is `${1}0`, so an unbraced positional made every rule of ten
  // words or more compare the wrong argv and never match.
  const space = fake([{
    ns: 'monoplayer-dev',
    match: ['create', 'secret', 'generic', 'dev-rcon', ANY, '--dry-run=client', '-o', 'yaml'],
    body: 'exit 0'
  }])
  const call = space.call('-n', 'monoplayer-dev', 'create', 'secret', 'generic', 'dev-rcon', '--from-literal=password=abc', '--dry-run=client', '-o', 'yaml')
  assert.equal(call.status, 0, 'the ten-word call is the one the rule names')
  assert.deepEqual(call.hits, ['r0'], 'the rule answered it')
})

test('a rule that names no namespace must say why it needs none', () => {
  // The cluster-scoped arms are real: a Namespace object carries no -n. Making the
  // reason a required field is what stops the next arm from leaving it out.
  assert.throws(() => kubectlShim([{ match: ['get', 'namespace', 'monoplayer-dev'], body: 'exit 0' }]),
    /names no ns and no cluster reason/)
  assert.throws(() => kubectlShim([{ match: ['get', 'namespace', 'monoplayer-dev'], cluster: '  ', body: 'exit 0' }]),
    /empty cluster reason/)
  assert.doesNotThrow(() => kubectlShim([{ match: ['get', 'namespace', 'monoplayer-dev'], cluster: 'a Namespace object is cluster-scoped', body: 'exit 0' }]))
})

test('a rule whose body does not exit is refused at build', () => {
  // Without one, the body falls through to the rule after it, and the arm answers a
  // call it was never written for.
  assert.throws(() => kubectlShim([{ ...REPLICAS, body: 'printf 1' }]), /does not end in exit/)
})
test('REST covers a trailing payload, and nothing else', () => {
  // The one hole a rule may leave at its end: the words it names are the call, and the
  // tail is what it does not read.
  const space = fake([{ ns: 'monoplayer', match: ['exec', ANY, '--', 'env', REST], body: 'exit 0' }])
  assert.equal(space.call('-n', 'monoplayer', 'exec', 'pod', '--', 'env', 'A=1', 'B=2', 'node', 'x.js').status, 0,
    'a longer tail is answered')
  assert.equal(space.call('-n', 'monoplayer', 'exec', 'pod', '--', 'env').status, 0,
    'an empty tail is answered: REST is zero or more words')
  assert.notEqual(space.call('-n', 'monoplayer', 'exec', 'pod', '--', 'sh', '-c', 'x').status, 0,
    'the words before REST are still the call')
  assert.throws(() => kubectlShim([{ ns: 'monoplayer', match: ['exec', REST, 'env'], body: 'exit 0' }]),
    /REST must be the last word/)
})

test('at moves -n after the verb, where kubectl accepts it', () => {
  const space = fake([{ ns: 'monoplayer', at: 1, match: ['apply', '-f', '-'], body: 'exit 0' }])
  assert.equal(space.call('apply', '-n', 'monoplayer', '-f', '-').status, 0, 'the call kubectl is given is answered')
  assert.notEqual(space.call('-n', 'monoplayer', 'apply', '-f', '-').status, 0,
    'the same words in another order are another call')
  assert.notEqual(space.call('apply', '-f', '-').status, 0, 'a call that loses -n matches nothing')
})

test('endingWith answers one word by its suffix, and a different suffix is another call', () => {
  const space = fake([{ cluster: 'cp names the pod path', match: ['cp', endingWith(':/work/report.json'), ANY], body: 'exit 0' }])
  assert.equal(space.call('cp', 'pod-abc:/work/report.json', '/tmp/out').status, 0, 'the pod name may be anything')
  assert.notEqual(space.call('cp', 'pod-abc:/work/other.json', '/tmp/out').status, 0, 'another path is another call')
  assert.notEqual(space.call('cp', 'pod-abc:/work/report.json.bak', '/tmp/out').status, 0, 'the suffix is the whole end of the word')
})

test('a rule that answers any namespace must say why', () => {
  assert.throws(() => kubectlShim([{ ns: ANY, match: ['get', 'pods'], body: 'exit 0' }]),
    /answers any namespace without a why/)
  const space = fake([{ ns: ANY, why: 'the reaper reads lanes a case names', match: ['get', 'pods'], body: 'exit 0' }])
  assert.equal(space.call('-n', 'monoplayer-gate-x', 'get', 'pods').status, 0, 'the namespace the call carries is answered')
  assert.notEqual(space.call('get', 'pods').status, 0, 'a call that loses -n still matches nothing')
})

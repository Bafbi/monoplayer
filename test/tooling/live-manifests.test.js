// The live lane's kustomization is load-bearing in a way nothing else checks:
// removing `playit-agent.yaml` from it is the durable rollback of the public
// route (#202), and a forgotten line is a manifest the lane silently never
// applies. deploy/dev has this assertion (dev-lane.test.js); deploy/manifests
// had none.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rules, section, withoutComments } from './manifest-reader.js'
import { parseAllowedServers } from '../../src/service/control.js'
import { DEFAULT_CONFIG } from '../../src/service/monoplayer.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANIFESTS = path.join(ROOT, 'deploy', 'manifests')
const read = name => fs.readFileSync(path.join(MANIFESTS, name), 'utf8')
const manifests = () => fs.readdirSync(MANIFESTS).filter(name => name.endsWith('.yaml') && name !== 'kustomization.yaml')

// Every manifest under deploy/manifests/, at any depth and under either suffix.
// The kustomization only lists the top level, but a guard about what the lane
// can apply must read what a future row could add.
function everyManifest (dir = MANIFESTS) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...everyManifest(full))
    else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) found.push(full)
  }
  return found
}

test('the live kustomization lists every manifest in the directory', () => {
  const listed = [...read('kustomization.yaml').matchAll(/^ {2}- (\S+\.yaml)$/gm)].map(match => match[1])
  const files = manifests()
  assert.deepEqual(files.filter(name => !listed.includes(name)), [],
    'deploy/manifests holds a manifest the kustomization does not apply')
  assert.deepEqual(listed.filter(name => !files.includes(name)), [],
    'the kustomization names a file deploy/manifests does not hold')
})

// #391: the service can compose the offline legs. They ask no session server who
// a client is, so anyone who types a name can play: exactly what a test lane
// needs, and exactly what the live lane must never become. This file already
// reads every manifest the live lane applies, so the prohibition is asserted here,
// beside the kustomization it protects. deploy/dev/ is the lane that sets it (#392).
test('no live manifest switches the service onto the offline legs', () => {
  // The whole file, not the env list, and both spellings of the switch. A
  // ConfigMap key imported through envFrom sets MONOPLAYER_OFFLINE_LEGS, and a
  // ConfigMap holding a JSON document that names `offlineLegs` is the same mode
  // reached through --config. Both are a manifest edit turning the live lane into
  // an anonymous one, which is the failure this test exists to catch.
  const setting = everyManifest()
    .filter(file => {
      const text = fs.readFileSync(file, 'utf8')
      return text.includes('MONOPLAYER_OFFLINE_LEGS') || text.includes('offlineLegs')
    })
    .map(file => path.relative(ROOT, file))
  assert.deepEqual(setting, [],
    'a live manifest carries the offline switch: ' + setting.join(', ') + '. That lane would ask no ' +
    'session server who a client is, so anyone who names themself could play the live server, with no ' +
    'account and no custody chain. The offline legs are for a lane whose job is a test double: set the ' +
    'key on the dev lane instead (deploy/dev/monoplayer.yaml, #392). If the live lane is really meant to ' +
    'serve anonymous clients, reopen docs/adr/the-product-may-be-a-test-double.md first, then delete this test.')

  // The default is the other half: a manifest that names no switch must not
  // arrive at the offline legs either.
  assert.equal(DEFAULT_CONFIG.offlineLegs, false,
    'the offline-legs default changed to true, so every lane serves anonymous clients without naming the key')
})

test('the public route reads its secret from the cluster Secret', () => {
  const agent = read('playit-agent.yaml')
  assert.match(agent, /secretKeyRef:\n\s+name: playit-agent\n\s+key: SECRET_KEY/,
    'the agent must take SECRET_KEY from the playit-agent Secret')
  // A long literal in an env value is the shape of a pasted credential. The
  // two values this file carries are a path and a path.
  assert.doesNotMatch(agent, /value: [A-Za-z0-9+/=_-]{32,}/, 'an env value looks like a credential')
})

test('the public route is pinned by digest and is not a member of the front Service', () => {
  const agent = read('playit-agent.yaml')
  const image = /image: (\S+)/.exec(agent)
  assert.ok(image, 'the agent names an image')
  assert.match(image[1], /@sha256:[0-9a-f]{64}$/, 'a moving tag in a lane that serves the public route')

  // The Service selects app.kubernetes.io/name: monoplayer. The agent labels
  // itself playit-agent, so a Service that load-balances it would be a backend
  // that speaks no Minecraft.
  const selector = /selector:\n\s+app\.kubernetes\.io\/name: (\S+)/.exec(read('service.yaml'))
  assert.equal(selector?.[1], 'monoplayer')
  assert.match(agent, /app\.kubernetes\.io\/name: playit-agent/)
})
// --- the runtime control document (#229, #232, #228) ---

// The panel writes `monoplayer-control`; the puppet reads it. Before this wiring
// the two halves existed and never met: the whitelist was the Git ConfigMap read
// once at boot, and no control file was mounted at all, so every panel write landed
// in an object the puppet never opened. These assertions are what keep the halves
// joined — and they fail loudly rather than letting the panel look wired.

test('the lane mounts the control ConfigMap read-only, and optionally', () => {
  const deployment = read('deployment.yaml')
  const mount = /- name: control\n\s+mountPath: (\S+)\n\s+readOnly: true/.exec(deployment)
  assert.ok(mount, 'the control volume is not mounted read-only, or not mounted at all')
  assert.equal(mount[1], '/control', 'the control volume moved; every path below follows it')

  const volume = /- name: control\n\s+configMap:\n\s+name: monoplayer-control\n\s+optional: true/.exec(deployment)
  assert.ok(volume, 'the control volume is not monoplayer-control with optional: true')

  // Read-only in the pod, writable only through the API server: a puppet that
  // could write its own control document would be a puppet that moves itself.
  assert.doesNotMatch(deployment, /mountPath: \/control\n\s+readOnly: false/,
    'the control volume is mounted writable')
})

const envOf = name => new Map([...read(name).matchAll(/- name: (MONOPLAYER_[A-Z_]+)\n\s+value: (.*)$/gm)]
  .map(match => [match[1], match[2].replace(/^"|"$/g, '')]))

// The text of one ConfigMap key, dedented. The same shape `src/panel/registry.js`
// reads out of the registry, which is where this file's own reader comes from.
function keyBlock (name, key) {
  const lines = read(name).split('\n')
  const start = lines.findIndex(line => line === '  ' + key + ': |')
  assert.notEqual(start, -1, name + ' holds the key ' + key)
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && line.length - line.trimStart().length <= 2) break
    body.push(line)
  }
  const content = body.filter(line => line.trim() !== '')
  const dedent = Math.min(...content.map(line => line.length - line.trimStart().length))
  return body.map(line => line.slice(dedent)).join('\n')
}

test('the lane reads its whitelist from the mounted volume, and nothing else does', () => {
  const env = envOf('deployment.yaml')

  assert.equal(env.get('MONOPLAYER_ATTACH_WHITELIST'), '/control/attach-whitelist.json',
    'the whitelist is not the file the panel patches, so a panel write is ignored at login')
  // #264 retired the desired-backend key and the operator move with it. The two
  // variables that turned it on are gone, and a lane that still set one would read a
  // document nothing writes.
  assert.equal(env.get('MONOPLAYER_CONTROL_FILE'), undefined,
    'the desired-backend key is retired, so no variable names its file')
  assert.equal(env.get('MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH'), undefined,
    'the switch that let the panel move a lane is retired with the key')
})

test('the lane names the allowed-server list and the seed behind it, and mounts both', () => {
  const deployment = read('deployment.yaml')
  const env = envOf('deployment.yaml')

  assert.equal(env.get('MONOPLAYER_ALLOWED_SERVERS'), '/control/allowed-servers.json',
    'the list is not the key the panel patches, so an operator edit reaches no lane')
  assert.equal(env.get('MONOPLAYER_ALLOWED_SERVERS_SEED'), '/config/allowed-servers.json',
    'no seed means a missing live key offers a joining player nothing')

  // Both paths have to be real mounts: a variable naming a file no volume projects is
  // a lane reading nothing, and the 200 that wrote it reads as wired.
  const control = /- name: control\n\s+mountPath: (\S+)\n\s+readOnly: true/.exec(deployment)
  assert.equal(control?.[1], '/control')
  const seed = /- name: config\n\s+mountPath: (\S+)\n\s+readOnly: true/.exec(deployment)
  assert.ok(seed, 'the committed seed ConfigMap is mounted read-only')
  assert.equal(seed[1], '/config', 'the seed path in the variable is the mount above it')
  const volume = /- name: config\n\s+configMap:\n\s+name: (\S+)/.exec(deployment)
  assert.equal(volume?.[1], 'monoplayer-config', 'the /config volume is the ConfigMap Git holds')
})

test('the committed seed is a list the lane can read, and it offers what the lane offers today', () => {
  const parsed = parseAllowedServers(keyBlock('configmap.yaml', 'allowed-servers.json'))
  assert.equal(parsed.reason, null, 'the seed this repository ships parses: ' + parsed.reason)
  assert.ok(parsed.servers.length > 0, 'the seed offers at least one server')

  // #265 reads this list in place of the one row start-live builds from the
  // configured backend, so the two have to name the same server: a seed that dropped
  // it would stop offering the lane's only backing server on the day the picker reads
  // the file.
  const env = envOf('deployment.yaml')
  const configured = env.get('MONOPLAYER_BACKEND_HOST') + ':' + env.get('MONOPLAYER_BACKEND_PORT')
  assert.ok(parsed.servers.some(server => server.host + ':' + server.port === configured),
    'the seed names the backend the lane is configured with, ' + configured)
  assert.equal(new Set(parsed.servers.map(server => server.host + ':' + server.port)).size, parsed.servers.length,
    'the seed offers no server twice')
})


// docs/custody.md sends an operator's backend-whitelist write to a Paper, and a Paper is
// the one thing this lane does not run (#378). `whitelist backend --namespace monoplayer`
// reaches a Deployment that either is not there or runs no rcon-cli, and the page says so
// in "The live backend's whitelist". This is the assertion that fails when a manifest
// makes that sentence untrue, which is the only form of the fact that can fail loudly.
test('the live lane declares no Paper for a backend whitelist to write', () => {
  // A Paper, by the image every Paper manifest in this repository runs.
  const PAPER = /^\s+image: itzg\/minecraft-server/m
  const papers = everyManifest()
    .map(file => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => /^kind: Deployment$/m.test(text) && PAPER.test(text))
    .map(({ file }) => file)
  assert.deepEqual(papers, [],
    'a live manifest declares a Paper: ' + papers.join(', ') + '. The live lane fronts an external ' +
    'backend (docs/deployment.md), so docs/custody.md tells an operator that no command here writes ' +
    'its whitelist. A Paper in this lane would make that page wrong, and rcon-cli reachable in ' +
    'monoplayer, which is not a lane an rcon write should find')
})

// --- the account lease's grant (#302) ---

// The online rung writes a Kubernetes Lease in this lane, and it is the one object here a
// permission outside the pod grants: the throwaway pod the same script applies and deletes
// needs `pods` verbs no manifest in this tree names yet. The Lease keeps one run at a time
// on the account's refresh chain (#280). Its three calls are `get lease`,
// `create -f` and `replace -f` (scripts/online-cluster.sh), made with whatever credential
// `kubectl` finds on the operator's machine. So the permission is the API server's answer,
// and no offline rung can run as a narrower credential to find out whether the grant is
// there. That is why the grant is pinned here instead: take a verb off the Role, or the
// subject off its binding, and this file is the red gate rather than a run that works for a
// cluster admin alone.
//
// The lines are read by `manifest-reader.js`, the one reader the panel's guard uses too, so
// the two cannot disagree about what a rule says.

const LEASE_ROLE = 'account-lease-role.yaml'
const LEASE_BINDING = 'account-lease-rolebinding.yaml'
const ONLINE_CLUSTER = 'scripts/online-cluster.sh'

// A default the rung falls back to, read from the script that ships it, so a rename in
// either place fails here rather than in a run that cannot take the account. A run that
// overrides MONOPLAYER_LEASE_NAME or MONOPLAYER_CLUSTER_NAMESPACE names a lease or a
// namespace this Role does not cover, which its header says and no guard can see.
function rungDefault (name) {
  const script = fs.readFileSync(path.join(ROOT, ONLINE_CLUSTER), 'utf8')
  const found = new RegExp('^' + name + '=\\$\\{[A-Z_]+:-(\\S+)\\}$', 'm').exec(script)
  assert.ok(found, ONLINE_CLUSTER + ' names its ' + name + ' default, and this test reads it')
  return found[1]
}

// Every way the grant can stop being what the rung needs, one message each. A rule line the
// reader cannot place throws before this runs, which is the other half of the guard.
function auditLease ({ role, binding, lease, namespace }) {
  const problems = []
  const report = message => problems.push(message)
  const flat = withoutComments

  if (!/^kind: Role$/m.test(flat(role))) report(LEASE_ROLE + ' does not declare a Role')
  if (!new RegExp('^ {2}namespace: ' + namespace + '$', 'm').test(flat(role))) {
    report(LEASE_ROLE + ' is not a Role in ' + namespace)
  }
  const roleName = (/^ {2}name: (\S+)$/m.exec(flat(role)) ?? [])[1]
  if (roleName === undefined) report(LEASE_ROLE + ' names no Role')

  const granted = rules(role)
  // `get` and `update` are requests for one object, so their rule can say which one.
  // Nothing else may ride along: a rule is granted as one set.
  const named = granted.filter(rule => (rule.resourceNames ?? []).length > 0)
  const unnamed = granted.filter(rule => (rule.resourceNames ?? []).length === 0)
  const sorted = list => [...(list ?? [])].sort()

  for (const rule of granted) {
    if (sorted(rule.apiGroups).join() !== 'coordination.k8s.io') {
      report('the Role grants ' + (rule.apiGroups ?? []).join(', ') + ', and the lease is coordination.k8s.io')
    }
    if (sorted(rule.resources).join() !== 'leases') {
      report('the Role grants ' + (rule.resources ?? []).join(', ') + ', and a run writes leases')
    }
  }

  if (named.length !== 1) report('the Role has ' + named.length + ' named rules, and one carries get and update')
  else {
    if ((named[0].resourceNames ?? []).join() !== lease) {
      report('the named rule scopes ' + (named[0].resourceNames ?? []).join(', ') + ', and the rung writes ' + lease)
    }
    if (sorted(named[0].verbs).join() !== ['get', 'update'].sort().join()) {
      report('the named rule grants ' + (named[0].verbs ?? []).join(', ') + ', and the rung gets and updates one lease')
    }
  }

  // `create` cannot be scoped by name, so it stands alone and unscoped. That is the honest
  // form: one rule that reads narrow, and one that does not pretend to.
  if (unnamed.length !== 1) report('the Role has ' + unnamed.length + ' unscoped rules, and one carries create')
  else if (sorted(unnamed[0].verbs).join() !== 'create') {
    report('the unscoped rule grants ' + (unnamed[0].verbs ?? []).join(', ') + ', and create is the only verb RBAC cannot name')
  }

  // The binding, or the Role is a grant nobody holds.
  const bound = flat(binding)
  if (!/^kind: RoleBinding$/m.test(bound)) report(LEASE_BINDING + ' does not declare a RoleBinding')
  if (!new RegExp('^ {2}namespace: ' + namespace + '$', 'm').test(bound)) {
    report(LEASE_BINDING + ' is not in ' + namespace)
  }
  const ref = section(bound, 0, 'roleRef')
  if (!/^ {2}kind: Role$/m.test(ref)) {
    report('the binding refers to ' + (ref.match(/^ {2}kind: (\S+)/m) ?? [])[1] + ', and this grant is a Role')
  }
  if (!ref.includes('  name: ' + roleName)) report('the binding refers to a Role other than ' + roleName)

  // The subject as one string of its kind and its name: each half matters, because a
  // ServiceAccount is a pod's identity and no pod here writes the lease.
  const subjects = [...section(bound, 0, 'subjects').matchAll(/^ {2}- kind: (\S+)\n {4}name: (\S+)$/gm)]
    .map(([, kind, name]) => kind + ' ' + name)
  if (subjects.length !== 1) report('the binding has ' + subjects.length + ' subjects, and the grant is one group\'s')
  else if (subjects[0] !== 'Group monoplayer-operators') {
    report('the binding hands the grant to ' + subjects[0] + ', and no workload in this tree takes a lease')
  }

  return problems
}

const leaseFiles = () => ({
  role: fs.readFileSync(path.join(MANIFESTS, LEASE_ROLE), 'utf8'),
  binding: fs.readFileSync(path.join(MANIFESTS, LEASE_BINDING), 'utf8'),
  lease: rungDefault('LEASE_NAME'),
  namespace: rungDefault('NAMESPACE')
})

test('the lane grants the account lease its three verbs, and one group holds them', () => {
  assert.deepEqual(auditLease(leaseFiles()), [])
})

test('the guard refuses a grant that stops being the three verbs on the one lease', () => {
  const tree = leaseFiles()
  const audit = change => auditLease({ ...tree, role: change(tree.role) })

  assert.deepEqual(audit(role => role.replace('verbs: ["create"]', 'verbs: ["create", "delete"]')), [
    'the unscoped rule grants create, delete, and create is the only verb RBAC cannot name'
  ], 'delete is a verb no run needs: a release writes an empty holder, and an unreleased lease expires')
  // `replace` is a kubectl subcommand and not an RBAC verb: a replace is a PUT, which the
  // authorizer scores as update. A rule carrying the word grants nothing the rung needs.
  assert.deepEqual(audit(role => role.replace('verbs: ["get", "update"]', 'verbs: ["get", "replace"]')), [
    'the named rule grants get, replace, and the rung gets and updates one lease'
  ], 'a rule that grants replace grants nothing: the authorizer scores a PUT as update')
  assert.deepEqual(audit(role => role.replace('verbs: ["get", "update"]', 'verbs: ["get", "update", "list"]')), [
    'the named rule grants get, update, list, and the rung gets and updates one lease'
  ], 'list reads every lease in the namespace, which the rung never does')
  assert.deepEqual(audit(role => role.replace('resourceNames: ["monoplayer-online-account"]', '')), [
    'the Role has 0 named rules, and one carries get and update',
    'the Role has 2 unscoped rules, and one carries create'
  ], 'a rule with no names reads and updates any lease in the namespace')
})

test('the guard refuses a binding that hands the grant to nobody, or to a workload', () => {
  const tree = leaseFiles()
  const audit = binding => auditLease({ ...tree, binding })

  assert.deepEqual(audit(tree.binding.replace('  - kind: Group\n    name: monoplayer-operators\n', '')), [
    'the binding has 0 subjects, and the grant is one group\'s'
  ], 'a Role with no subject is a grant nobody holds: it reads as wired and is not')
  assert.deepEqual(
    audit(tree.binding.replace('  - kind: Group\n    name: monoplayer-operators\n',
      '  - kind: ServiceAccount\n    name: monoplayer\n')),
    ['the binding hands the grant to ServiceAccount monoplayer, and no workload in this tree takes a lease'],
    'a ServiceAccount is a pod\'s identity, and no pod here writes the lease')
})

test('the bootstrap step names the group the binding hands the grant to', () => {
  // The subject is a group no manifest can create, so the one instruction that makes the
  // grant live is prose: issue a credential carrying that group, or map it from an identity
  // provider. A page naming another group is an operator adding the wrong one and reading a
  // 403 it was told to expect.
  const binding = fs.readFileSync(path.join(MANIFESTS, LEASE_BINDING), 'utf8')
  const group = [...binding.matchAll(/^ {2}- kind: Group\n {4}name: (\S+)$/gm)].map(match => match[1])
  assert.equal(group.length, 1, 'the binding names one group')
  const page = fs.readFileSync(path.join(ROOT, 'docs', 'deployment.md'), 'utf8')
  assert.ok(page.includes(group[0]),
    'docs/deployment.md no longer names ' + group[0] + ', so the bootstrap step that makes the grant live is missing')
})


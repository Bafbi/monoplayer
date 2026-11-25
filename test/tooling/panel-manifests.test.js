// The panel's whole promise is that it can only ever write the control
// ConfigMaps its registry names, and only ever read the seeds it names. That
// promise lives in four manifest facts, and nothing walked deploy/panel before this
// file: the Role's `resourceNames` is the registry's lists — write for the control
// ConfigMaps, `get` alone for the seed ConfigMaps (#262) — no rule grants a verb
// that escapes it, the Service is on the tailnet and nowhere else, and the Argo
// project whitelists exactly the kinds this tree holds. A panel that is scoped today
// is not a panel that is scoped tomorrow without an assertion.
//
// Styled after live-manifests.test.js, which exists because nothing walked
// deploy/manifests either. There is no YAML library in this repo and no new
// dependency, so the reader below understands the shapes these files use, and a
// rule line it cannot read is a failure rather than a silent pass: a guard that
// skips what it cannot parse is a guard that passes on the one manifest that
// matters.
//
// `audit` is the checks, and it runs twice: once over the tree, and once over
// fixtures that are broken on purpose, so a case that stops biting is a red gate
// instead of a quiet one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRegistry } from '../../src/panel/registry.js'
import { ALLOWED_KEY } from '../../src/panel/routes/allowed.js'
import { WHITELIST_KEY } from '../../src/panel/routes/whitelist.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PANEL = path.join(ROOT, 'deploy', 'panel')
const MANIFESTS = path.join(ROOT, 'deploy', 'manifests')
const ARGOCD = path.join(ROOT, 'deploy', 'argocd')

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8')

// --- the reader ---

// Every document in a directory, with the file it came from. kustomization.yaml
// is included: it is an object, and its resource list is one of the assertions.
// Comments are not data. A Service that says in prose "there is no tunnel here
// and there must never be one" is not a Service that publishes one, and a guard
// that cannot tell the two apart would make the comment the load-bearing part.
const withoutComments = text => text.split('\n')
  .filter(line => !line.trimStart().startsWith('#'))
  .join('\n')

function documentsIn (dir, files) {
  return files.flatMap(file => read(dir, file).split(/^---$/m)
    .map(text => ({ file, text: withoutComments(text) }))
    .filter(document => /^kind:\s*\S+\s*$/m.test(document.text))
    .map(document => ({ ...document, ...describe(document.text) })))
}

function describe (text) {
  const metadata = section(text, 0, 'metadata')
  return {
    apiVersion: scalar(text, 'apiVersion'),
    kind: scalar(text, 'kind'),
    name: (metadata.match(/^ {2}name:\s*(\S+)\s*$/m) ?? [])[1] ?? null,
    namespace: (metadata.match(/^ {2}namespace:\s*(\S+)\s*$/m) ?? [])[1] ?? null
  }
}

const scalar = (text, key) => (text.match(new RegExp('^' + key + ':\\s*(\\S+)\\s*$', 'm')) ?? [])[1] ?? null

// The lines under a key, up to the next line indented no deeper than the key.
function section (text, indent, key) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === ' '.repeat(indent) + key + ':')
  if (start === -1) return ''
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { body.push(line); continue }
    if (line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

// The one line policy every reader here shares: a blank line is nothing, and a
// comment is not data. Two readers with two policies would disagree about the
// same manifest, which is the shape of bug this file exists to prevent.
const isData = line => line.trim() !== '' && !line.trimStart().startsWith('#')

const RULE_KEYS = ['apiGroups', 'resources', 'resourceNames', 'verbs']

// The rules of a Role. A key this reader does not know, or a line it cannot
// place, throws: the guard has to read every rule it is asked to judge.
function rules (text) {
  const body = text.split(/^rules:\s*$/m)[1]
  if (body === undefined) return []
  const parsed = []
  let current = null
  for (const line of body.split('\n')) {
    if (!isData(line)) continue
    if (line.length - line.trimStart().length < 2) break
    const opening = line.match(/^ {2}- (\S.*)$/)
    if (opening) {
      current = {}
      parsed.push(current)
      assign(current, opening[1])
      continue
    }
    const entry = line.match(/^ {4}(\S.*)$/)
    if (!entry || current === null) {
      throw new Error('this guard cannot read the rule line: ' + JSON.stringify(line))
    }
    assign(current, entry[1])
  }
  return parsed
}

function assign (rule, text) {
  const entry = text.match(/^([A-Za-z]+):\s*(\[.*\]|\S+)$/)
  if (!entry) throw new Error('this guard cannot read the rule value: ' + JSON.stringify(text))
  const [, key, value] = entry
  if (!RULE_KEYS.includes(key)) throw new Error('this guard does not know the rule key ' + key)
  if (key in rule) throw new Error('the rule sets ' + key + ' twice')
  rule[key] = value.startsWith('[')
    ? [...value.matchAll(/"([^"]*)"/g)].map(match => match[1])
    : [value]
  if (value.startsWith('[') && !value.endsWith(']')) {
    throw new Error('this guard reads flow-style lists only: ' + key + ' ' + value)
  }
}

// --- the checks ---

// What the panel may never be given, whatever the registry says. `create` is the
// one that matters: RBAC cannot scope it by name, so a create grant is a grant to
// invent any ConfigMap in the namespace the Role lives in (#230).
const NEVER_VERBS = ['create', 'delete', 'deletecollection', 'escalate', 'bind', 'impersonate']
const NEVER_RESOURCES = ['secrets']
// A configmaps rule is a write rule or a read rule (#262). A write rule carries
// `patch` or `update`, and its names are the control ConfigMaps the registry names.
// A read rule carries `get` alone, and its names are the seed ConfigMaps: the copy
// Git commits, which the panel reads and never writes, because Argo would revert a
// write to an object it owns.
const WRITE_VERBS = ['patch', 'update']

// The verbs each resource is allowed, so a new one is a decision someone makes
// here rather than a line a reviewer has to notice.
const ALLOWED = new Map([
  ['configmaps', ['get', 'patch', 'update']],
  ['pods', ['get', 'list']],
  ['pods/log', ['get', 'list']],
  ['deployments', ['get', 'list']]
])

function audit ({ files, documents, registry }) {
  const problems = []
  const report = message => problems.push(message)

  const roles = documents.filter(document => document.kind === 'Role')
  const bindings = documents.filter(document => document.kind === 'RoleBinding')
  const services = documents.filter(document => document.kind === 'Service')
  // Read at audit time, not at load time: the fixtures below edit a document's
  // text, and a reader that ran once would judge the manifest it was given rather
  // than the one under test.
  const roleRules = new Map(roles.map(role => [role, rules(role.text)]))

  // 1. The kustomization applies every file in the directory, and names nothing
  //    it does not hold. A manifest nothing applies is a manifest nobody has.
  const kustomization = documents.find(document => document.kind === 'Kustomization')
  if (!kustomization) report('deploy/panel holds no Kustomization')
  else {
    const listed = [...section(kustomization.text, 0, 'resources').matchAll(/^ {2}- (\S+\.yaml)$/gm)]
      .map(match => match[1])
    const held = files.filter(file => file !== 'kustomization.yaml')
    for (const file of held) {
      if (!listed.includes(file)) report('deploy/panel/' + file + ' is not in the kustomization')
    }
    for (const file of listed) {
      if (!held.includes(file)) report('the kustomization names deploy/panel/' + file + ', which does not exist')
    }
  }

  // 2. One Role per namespace the registry reserves, and its `resourceNames` is
  //    exactly that namespace's control ConfigMaps. Both directions: a Role that
  //    names a ConfigMap the registry does not is a write target nobody approved,
  //    and a registry entry with no resourceNames is a write that will be refused
  //    at the worst possible moment.
  const writable = new Map()
  const seeds = new Map()
  for (const puppet of registry.puppets) {
    if (!writable.has(puppet.namespace)) {
      writable.set(puppet.namespace, new Set())
      seeds.set(puppet.namespace, new Set())
    }
    writable.get(puppet.namespace).add(puppet.controlConfigMap)
    seeds.get(puppet.namespace).add(puppet.seedConfigMap)
  }
  for (const [namespace, targets] of writable) {
    const hosted = roles.filter(role => role.namespace === namespace)
    if (hosted.length !== 1) {
      report('the registry names ' + namespace + ', which has ' + hosted.length + ' Roles; it needs exactly one')
      continue
    }
    const bound = bindings.filter(binding => binding.namespace === namespace)
    if (bound.length !== 1) report(namespace + ' has ' + bound.length + ' RoleBindings; it needs exactly one')

    const named = new Set()
    const readOnly = new Set()
    for (const rule of roleRules.get(hosted[0])) {
      if (!(rule.resources ?? []).includes('configmaps')) continue
      const verbs = rule.verbs ?? []
      const into = WRITE_VERBS.some(verb => verbs.includes(verb)) ? named : readOnly
      for (const name of rule.resourceNames ?? []) into.add(name)
    }
    for (const name of named) {
      if (!targets.has(name)) {
        report('Role ' + hosted[0].name + ' in ' + namespace + ' may write ' + name +
          ', which is not a controlConfigMap the registry names')
      }
    }
    for (const name of targets) {
      if (!named.has(name)) {
        report('the registry names ' + namespace + '/' + name + ' as a controlConfigMap, and the Role does not')
      }
    }
    // The seed is read and never written: a write rule that names it would be a
    // grant to replace the copy Git owns, which selfHeal would then revert under
    // the operator's feet.
    for (const name of readOnly) {
      if (!seeds.get(namespace).has(name)) {
        report('Role ' + hosted[0].name + ' in ' + namespace + ' reads ' + name +
          ', which is not a seedConfigMap the registry names')
      }
      if (named.has(name)) {
        report('Role ' + hosted[0].name + ' in ' + namespace + ' both reads and writes ' + name)
      }
    }
    for (const name of seeds.get(namespace)) {
      if (!readOnly.has(name)) {
        report('the registry names ' + namespace + '/' + name + ' as a seedConfigMap, and the Role does not read it')
      }
    }
  }

  // 3. No rule escapes the scope above.
  for (const role of roles) {
    for (const rule of roleRules.get(role)) {
      const where = 'Role ' + role.name + ' in ' + role.namespace
      const resources = rule.resources ?? []
      const verbs = rule.verbs ?? []
      if ((rule.apiGroups ?? []).includes('*')) report(where + ' grants every API group')
      if (resources.length === 0) report(where + ' has a rule with no resources')
      for (const resource of resources) {
        if (resource === '*') report(where + ' grants every resource')
        if (NEVER_RESOURCES.includes(resource)) report(where + ' grants ' + resource)
        if (!ALLOWED.has(resource)) report(where + ' grants ' + resource + ', which no route needs')
        if (resource !== 'configmaps' && (rule.resourceNames ?? []).length > 0) {
          report(where + ' scopes ' + resource + ' by name, which does not bound a read')
        }
      }
      for (const verb of verbs) {
        if (NEVER_VERBS.includes(verb)) report(where + ' grants ' + verb)
        if (verb === '*') report(where + ' grants every verb')
      }
      // The verbs a resource is allowed, checked per resource in the rule.
      for (const resource of resources) {
        if (!ALLOWED.has(resource)) continue
        for (const verb of verbs) {
          if (!ALLOWED.get(resource).includes(verb)) {
            report(where + ' grants ' + verb + ' on ' + resource + ', and the allowed verbs are ' +
              ALLOWED.get(resource).join(', '))
          }
        }
      }
      if (resources.includes('configmaps') && (rule.resourceNames ?? []).length === 0) {
        report(where + ' grants configmaps with no resourceNames, which is every ConfigMap in the namespace')
      }
    }
  }

  // 4. No cluster-scoped grant, and no binding that could hand one out.
  for (const document of documents) {
    if (document.kind === 'ClusterRole' || document.kind === 'ClusterRoleBinding') {
      report(document.file + ' holds a ' + document.kind + ', and the panel is scoped by namespace')
    }
  }
  for (const binding of bindings) {
    const ref = section(binding.text, 0, 'roleRef')
    const kind = (ref.match(/^ {2}kind:\s*(\S+)\s*$/m) ?? [])[1] ?? null
    const name = (ref.match(/^ {2}name:\s*(\S+)\s*$/m) ?? [])[1] ?? null
    if (kind !== 'Role') report('RoleBinding ' + binding.name + ' binds a ' + kind + ', not a Role')
    if (!roles.some(role => role.name === name && role.namespace === binding.namespace)) {
      report('RoleBinding ' + binding.name + ' in ' + binding.namespace + ' binds ' + name + ', which no file here defines')
    }
    // The subject is the panel. A binding to another ServiceAccount is authority
    // nobody reading the registry expects.
    const subjects = [...section(binding.text, 0, 'subjects').matchAll(/^ {4}name:\s*(\S+)\s*$/gm)]
      .map(match => match[1])
    if (subjects.length !== 1 || subjects[0] !== 'panel') {
      report('RoleBinding ' + binding.name + ' binds ' + subjects.join(', ') + ', not the panel ServiceAccount')
    }
  }

  // 5. The Service is the tailnet class, and the only way in.
  if (services.length !== 1) report('deploy/panel holds ' + services.length + ' Services, and the panel has one')
  for (const service of services) {
    const spec = section(service.text, 0, 'spec')
    if ((spec.match(/^ {2}type:\s*(\S+)\s*$/m) ?? [])[1] !== 'LoadBalancer') {
      report('Service ' + service.name + ' is not a LoadBalancer')
    }
    if ((spec.match(/^ {2}loadBalancerClass:\s*(\S+)\s*$/m) ?? [])[1] !== 'tailscale') {
      report('Service ' + service.name + ' is not the tailscale class, so it publishes somewhere else')
    }
    const hostname = (service.text.match(/^ {4}tailscale\.com\/hostname:\s*(\S+)\s*$/m) ?? [])[1]
    if (hostname !== 'monoplayer') {
      report('Service ' + service.name + ' is published as ' + hostname + ', and the panel is monoplayer')
    }
    if (!/^ {4}- name: http$/m.test(spec)) report('Service ' + service.name + ' has no http port')
    // Published on 80, so the URL carries no port, and targeted by the container
    // port's name: the pod runs non-root with every capability dropped, and a
    // privileged port inside the container would mean giving one back.
    if (!/^ {6}port: 80$/m.test(spec)) report('Service ' + service.name + ' does not publish port 80')
    if (!/^ {6}targetPort: http$/m.test(spec)) {
      report('Service ' + service.name + ' does not target the container port by name')
    }
  }
  for (const document of documents) {
    if (document.kind === 'Ingress') report(document.file + ' holds an Ingress, and the tailnet Service is the only way in')
  }
  for (const document of documents) {
    if (/playit/i.test(document.text)) {
      report(document.file + ' mentions the playit tunnel, and the panel is never published through it')
    }
  }

  // 6. The pod is the puppet's hardening, and its entrypoint is the panel's.
  const deployments = documents.filter(document => document.kind === 'Deployment')
  if (deployments.length !== 1) report('deploy/panel holds ' + deployments.length + ' Deployments, and the panel has one')
  for (const deployment of deployments) {
    const pod = section(deployment.text, 0, 'spec')
    // The booleans are read without their indentation: the guard is about what
    // the pod declares, and a reindented manifest is not a weaker pod.
    const required = [
      [/command: \["node", "src\/panel\/start\.js"\]/, 'the panel entrypoint'],
      // The tag this branch records. On `deploy` the image workflow replaces it
      // with a digest pin in this tree's kustomization (#234), exactly as it does
      // for the proxy, so the two always run one build.
      [/image: ghcr\.io\/bafbi\/monoplayer:main\n/, 'ghcr.io/bafbi/monoplayer:main'],
      [/\n\s+runAsNonRoot: true/, 'a non-root user'],
      [/\n\s+readOnlyRootFilesystem: true/, 'a read-only root filesystem'],
      [/\n\s+allowPrivilegeEscalation: false/, 'a refusal of privilege escalation'],
      [/\n\s+drop:\s*\n\s+- ALL/, 'every capability dropped'],
      [/\n\s+serviceAccountName: panel/, 'the panel ServiceAccount']
    ]
    for (const [pattern, what] of required) {
      if (!pattern.test(pod)) report('Deployment ' + deployment.name + ' does not declare ' + what)
    }
    for (const probe of ['readinessProbe', 'livenessProbe']) {
      const body = new RegExp(probe + ':\\s*\\n(?:\\s+\\S.*\\n)*?\\s+path: /healthz\\n')
      if (!body.test(pod)) report('Deployment ' + deployment.name + ' has no ' + probe + ' on /healthz')
    }
    if (/^\s+hostPath:/m.test(pod)) report('Deployment ' + deployment.name + ' mounts a hostPath')
    if (/containerPort: 80$/m.test(pod)) {
      report('Deployment ' + deployment.name + ' binds port 80 in the container, which needs a capability back')
    }
  }

  return problems
}

// The entries under a key, each a run of `key: value` pairs: a project's
// whitelists, and anything else shaped like `- group: ""` / `kind: Role`. A line
// this reader cannot place fails, for the same reason a rule line does.
function entriesUnder (text, key) {
  const entries = []
  let current = null
  for (const line of section(text, 2, key).split('\n')) {
    if (!isData(line)) continue
    const opening = line.match(/^ {4}- ([a-z]+): (".*"|\S+)$/)
    if (opening) {
      current = { [opening[1]]: opening[2].replace(/^"|"$/g, '') }
      entries.push(current)
      continue
    }
    const entry = line.match(/^ {6}([a-z]+): (".*"|\S+)$/)
    if (!entry || current === null) {
      throw new Error('this guard cannot read the ' + key + ' line: ' + JSON.stringify(line))
    }
    current[entry[1]] = entry[2].replace(/^"|"$/g, '')
  }
  return entries
}

// --- the tree ---

const files = fs.readdirSync(PANEL).filter(name => name.endsWith('.yaml')).sort()
const documents = documentsIn(PANEL, files)
// The proxy's tree too: one Application syncs both, and its project has to allow
// every kind either tree holds.
const manifestsDocuments = documentsIn(MANIFESTS,
  fs.readdirSync(MANIFESTS).filter(name => name.endsWith('.yaml')).sort())
const registry = parseRegistry(read(PANEL, 'registry.yaml'))

test('the panel manifests keep the write scope the registry names', () => {
  // The registry in the tree is the document the pod reads, so it has to parse
  // as the panel parses it: a manifest that only looks like a registry is a pod
  // that will not start.
  assert.ok(registry.puppets.length > 0, 'the registry names at least one puppet')
  assert.deepEqual(audit({ files, documents, registry }), [])
})

test('the guard refuses a resourceNames entry the registry does not name', () => {
  const broken = structuredClone(documents)
  const role = broken.find(document => document.kind === 'Role')
  role.text = role.text.replace(
    /resourceNames: \["monoplayer-control"\]/,
    'resourceNames: ["monoplayer-control", "kube-root-ca.crt"]'
  )
  assert.deepEqual(audit({ files, documents: broken, registry }), [
    'Role panel-control in monoplayer may write kube-root-ca.crt, which is not a controlConfigMap the registry names'
  ])
})

test('the guard refuses a seed the registry does not name, and a seed no rule reads', () => {
  // A `get`-only rule for an object no row names as a seed: a read target nobody
  // approved, which is the same failure as a write target nobody approved.
  const extra = structuredClone(documents)
  const extraRole = extra.find(document => document.kind === 'Role')
  extraRole.text = extraRole.text.replace(
    /resourceNames: \["monoplayer-config"\]\n    verbs: \["get"\]/,
    'resourceNames: ["monoplayer-config", "monoplayer-custody-tokens"]\n    verbs: ["get"]'
  )
  assert.deepEqual(audit({ files, documents: extra, registry }), [
    'Role panel-control in monoplayer reads monoplayer-custody-tokens, which is not a seedConfigMap the registry names'
  ])

  // The other direction: a registry row naming a seed the Role cannot read is a
  // fallback that answers 403 at the one moment it is needed.
  const unread = structuredClone(registry)
  unread.puppets[0] = { ...unread.puppets[0], seedConfigMap: 'monoplayer-seed' }
  assert.deepEqual(audit({ files, documents, registry: unread }).sort(), [
    'Role panel-control in monoplayer reads monoplayer-config, which is not a seedConfigMap the registry names',
    'the registry names monoplayer/monoplayer-seed as a seedConfigMap, and the Role does not read it'
  ].sort(), 'the row moved and the rule did not, and both halves are named')

  // A seed granted `patch` is a grant to rewrite the copy Argo owns, which the next
  // sync would revert under the operator's feet.
  const writable = structuredClone(documents)
  const writeRole = writable.find(document => document.kind === 'Role')
  writeRole.text = writeRole.text.replace(
    'resourceNames: ["monoplayer-config"]\n    verbs: ["get"]',
    'resourceNames: ["monoplayer-config"]\n    verbs: ["get", "patch"]'
  )
  assert.deepEqual(audit({ files, documents: writable, registry }).sort(), [
    'Role panel-control in monoplayer may write monoplayer-config, which is not a controlConfigMap the registry names',
    'the registry names monoplayer/monoplayer-config as a seedConfigMap, and the Role does not read it'
  ].sort())
})

test('the seed the panel reads is the ConfigMap the lane mounts, and its keys are the lane\'s files', () => {
  // Two trees, one fact: the panel's read target is a ConfigMap this repository
  // ships, and the object behind the lane's seed mount is the same one. A rename in
  // either tree is a red gate rather than a fallback that answers 404 at the moment
  // it is needed.
  const deployment = manifestsDocuments.find(document => document.kind === 'Deployment')
  const volume = /- name: config\n\s+configMap:\n\s+name: (\S+)/.exec(deployment.text)
  assert.ok(volume, 'the lane mounts the committed seed ConfigMap')
  const mounted = volume[1]
  const shipped = manifestsDocuments.filter(document => document.kind === 'ConfigMap').map(document => document.name)
  assert.ok(shipped.includes(mounted), 'the lane mounts a ConfigMap these manifests declare: ' + mounted)
  for (const puppet of registry.puppets) {
    assert.equal(puppet.seedConfigMap, mounted,
      'the panel reads ' + puppet.seedConfigMap + ' as the seed and the lane mounts ' + mounted)
  }

  // The panel writes one key of one ConfigMap, and each of those keys is the file
  // the lane's own variable points at. A key named one thing in the route and
  // another in the Deployment is a write that lands where nothing reads.
  const env = new Map([...deployment.text.matchAll(/- name: (MONOPLAYER_[A-Z_]+)\n\s+value: (.*)$/gm)]
    .map(match => [match[1], match[2].replace(/^"|"$/g, '')]))
  const pairs = [
    [WHITELIST_KEY, env.get('MONOPLAYER_ATTACH_WHITELIST')],
    [ALLOWED_KEY, env.get('MONOPLAYER_ALLOWED_SERVERS')],
    [ALLOWED_KEY, env.get('MONOPLAYER_ALLOWED_SERVERS_SEED')]
  ]
  for (const [key, path] of pairs) {
    assert.equal(String(path).split('/').pop(), key, key + ' is the file ' + path + ' names')
  }
})

test('the guard refuses a rule that escapes the scope', () => {
  const cases = [
    ['verbs: ["get", "patch", "update"]', 'verbs: ["get", "create"]', 'Role panel-control in monoplayer grants create'],
    ['verbs: ["get", "patch", "update"]', 'verbs: ["get", "delete"]', 'Role panel-control in monoplayer grants delete'],
    ['resources: ["configmaps"]', 'resources: ["secrets"]', 'Role panel-control in monoplayer grants secrets'],
    ['resources: ["pods"]', 'resources: ["*"]', 'Role panel-control in monoplayer grants every resource'],
    ['apiGroups: [""]', 'apiGroups: ["*"]', 'Role panel-control in monoplayer grants every API group']
  ]
  for (const [from, to, problem] of cases) {
    const broken = structuredClone(documents)
    const role = broken.find(document => document.kind === 'Role')
    assert.ok(role.text.includes(from), 'the fixture replaces a line the Role holds: ' + from)
    role.text = role.text.replace(from, to)
    assert.ok(audit({ files, documents: broken, registry }).includes(problem),
      to + ' is refused with: ' + problem)
  }
})

test('the guard refuses a Service that leaves the tailnet', () => {
  const cases = [
    ['    tailscale.com/hostname: monoplayer', '    tailscale.com/hostname: other',
      'Service panel is published as other, and the panel is monoplayer'],
    ['  loadBalancerClass: tailscale', '  loadBalancerClass: other',
      'Service panel is not the tailscale class, so it publishes somewhere else'],
    ['  type: LoadBalancer', '  type: NodePort',
      'Service panel is not a LoadBalancer']
  ]
  for (const [from, to, problem] of cases) {
    const broken = structuredClone(documents)
    const service = broken.find(document => document.kind === 'Service')
    assert.ok(service.text.includes(from), 'the fixture replaces a line the Service holds: ' + from)
    service.text = service.text.replace(from, to)
    assert.ok(audit({ files, documents: broken, registry }).includes(problem), to + ' is refused')
  }

  // An Ingress, and a tunnel, are the two ways back onto the public internet.
  const ingress = [...structuredClone(documents), { file: 'ingress.yaml', kind: 'Ingress', name: 'panel', namespace: null, text: 'kind: Ingress\n' }]
  assert.ok(audit({ files, documents: ingress, registry }).includes(
    'ingress.yaml holds an Ingress, and the tailnet Service is the only way in'))
  const tunnel = structuredClone(documents)
  tunnel[0].text += '\n    publish: playit\n'
  assert.ok(audit({ files, documents: tunnel, registry }).some(problem => problem.includes('playit')))
})

test('the guard refuses an image that is not the one the branch records', () => {
  const broken = structuredClone(documents)
  const deployment = broken.find(document => document.kind === 'Deployment')
  deployment.text = deployment.text.replace(
    'ghcr.io/bafbi/monoplayer:main',
    'ghcr.io/bafbi/monoplayer:sha-1a2b3c4'
  )
  assert.ok(audit({ files, documents: broken, registry }).includes(
    'Deployment panel does not declare ghcr.io/bafbi/monoplayer:main'),
  'a sha tag is a different image from the one the proxy runs on this branch')
})

test('the guard refuses a role or a binding that leaves the namespaces it names', () => {
  const star = [...structuredClone(documents), { file: 'clusterrole.yaml', kind: 'ClusterRole', name: 'wide', namespace: null, text: 'kind: ClusterRole\n' }]
  assert.ok(audit({ files, documents: star, registry }).includes(
    'clusterrole.yaml holds a ClusterRole, and the panel is scoped by namespace'))

  const moved = structuredClone(documents)
  const binding = moved.find(document => document.kind === 'RoleBinding')
  // The roleRef line, not the document's own kind: `kind: Role` also matches
  // `kind: RoleBinding`, and a fixture that mutates the wrong line tests nothing.
  binding.text = binding.text.replace('\n  kind: Role\n', '\n  kind: ClusterRole\n')
  assert.ok(audit({ files, documents: moved, registry }).includes(
    'RoleBinding panel-control binds a ClusterRole, not a Role'))

  const other = structuredClone(documents)
  const subject = other.find(document => document.kind === 'RoleBinding')
  // The subject line only: `name: panel` also matches inside the
  // `app.kubernetes.io/name: panel` label, and a fixture that edits a label tests
  // a line nothing reads.
  subject.text = subject.text.replace(
    '  - kind: ServiceAccount\n    name: panel\n',
    '  - kind: ServiceAccount\n    name: monoplayer\n'
  )
  assert.ok(audit({ files, documents: other, registry }).includes(
    'RoleBinding panel-control binds monoplayer, not the panel ServiceAccount'))
})

test('the guard refuses an unreadable rule line instead of skipping it', () => {
  const broken = structuredClone(documents)
  const role = broken.find(document => document.kind === 'Role')
  role.text = role.text.replace('    verbs: ["get", "list"]', '    verbs:\n      - get\n      - list')
  assert.throws(() => audit({ files, documents: broken, registry }),
    /this guard cannot read the rule (line|value)/,
    'a block-style list is a manifest this guard cannot judge, so it fails rather than passing silently')
})

// --- one Application, one project, two namespaces ---

// The panel does not get an Application of its own: one deploy means one
// Application over deploy/kustomization.yaml. These assertions are what keep it
// that way. A second Application, a source that stops being the root
// kustomization, a tree the root does not include, or a project that forgets the
// panel's namespace is a red gate, not a review comment.

test('one Application syncs the root tree, and its project allows both namespaces', () => {
  const argoFiles = fs.readdirSync(ARGOCD).filter(name => name.endsWith('.yaml')).sort()
  const applications = argoFiles
    .map(name => ({ name, text: read(ARGOCD, name) }))
    .filter(file => scalar(file.text, 'kind') === 'Application')
  assert.deepEqual(applications.map(file => file.name), ['application.yaml'],
    'deploy/argocd holds exactly one Application: the panel rides the proxy deploy')

  const application = applications[0].text
  const project = read(ARGOCD, 'project.yaml')
  assert.equal(scalar(project, 'kind'), 'AppProject')

  assert.match(section(application, 0, 'spec'), /^ {2}project: monoplayer$/m)
  const source = {
    repoURL: (application.match(/^ {4}repoURL: (\S+)$/m) ?? [])[1],
    targetRevision: (application.match(/^ {4}targetRevision: (\S+)$/m) ?? [])[1],
    path: (application.match(/^ {4}path: (\S+)$/m) ?? [])[1]
  }
  assert.equal(source.repoURL, (project.match(/^ {4}- (\S+)$/m) ?? [])[1],
    'the project allows exactly the repository the Application clones')
  assert.equal(source.path, 'deploy', 'the Application syncs the root kustomization')
  // One branch is the deploy truth: the image workflow rewrites `deploy`, and an
  // Application that tracked `main` would run a tree no digest commit describes.
  assert.equal(source.targetRevision, 'deploy')

  // The root tree has to reach both directories, or the panel is manifests nobody
  // applies while the Application still reads healthy.
  const rootKustomization = read(ROOT, 'deploy', 'kustomization.yaml')
  for (const directory of ['manifests', 'panel']) {
    assert.match(rootKustomization, new RegExp('^  - ' + directory + '$', 'm'),
      'deploy/kustomization.yaml does not include ' + directory)
  }

  // Prune and selfHeal, because a tree that is not synced is a deploy nobody can
  // reproduce.
  const sync = section(application, 2, 'syncPolicy')
  assert.match(sync, /^ {6}prune: true$/m)
  assert.match(sync, /^ {6}selfHeal: true$/m)

  // RBAC is namespaced, so the panel's Role lands in the puppet's namespace and
  // its Deployment in its own. Both have to be allowed, and nothing else.
  const destinations = [...section(project, 2, 'destinations').matchAll(/^ {6}namespace: (\S+)$/gm)]
    .map(match => match[1])
  const declared = new Set(documents.map(document => document.namespace).filter(Boolean))
  assert.deepEqual([...declared].sort(), ['monoplayer', 'monoplayer-panel'],
    'the panel tree names the two namespaces the project has to allow')
  for (const namespace of declared) {
    assert.ok(destinations.includes(namespace),
      'the project allows ' + namespace + ', which the panel tree creates an object in')
  }
  assert.equal(new Set(destinations).size, destinations.length, 'the project names a destination twice')

  // Nothing cluster-scoped beyond the Namespace each tree owns.
  const cluster = [...section(project, 2, 'clusterResourceWhitelist').matchAll(/^ {6}kind: (\S+)$/gm)]
    .map(match => match[1])
  assert.deepEqual(cluster, ['Namespace'],
    'the project may create a Namespace and no other cluster-scoped object')

  // Every namespaced kind either tree holds is whitelisted, and nothing else is.
  // Argo refuses a kind its project does not name, so a wildcard here would hand
  // the Application the reach the panel's Role exists to bound.
  const allowed = entriesUnder(project, 'namespaceResourceWhitelist')
  assert.ok(allowed.length > 0, 'the project whitelists the kinds the trees hold')
  for (const entry of allowed) {
    assert.notEqual(entry.group, '*', 'the project whitelists every API group')
    assert.notEqual(entry.kind, '*', 'the project whitelists every kind')
  }
  const held = new Map()
  for (const tree of [documents, manifestsDocuments]) {
    for (const document of tree) {
      // Two exemptions, both named. A Kustomization is the tree's own assembly,
      // not an object Argo creates. A Namespace is cluster-scoped and covered by
      // clusterResourceWhitelist above.
      if (document.kind === 'Kustomization' || document.kind === 'Namespace') continue
      const group = (document.apiVersion ?? '').includes('/') ? document.apiVersion.split('/')[0] : ''
      held.set(group + '/' + document.kind, { group, kind: document.kind })
    }
  }
  for (const [key, entry] of held) {
    assert.ok(
      allowed.some(allowing => allowing.group === entry.group && allowing.kind === entry.kind),
      'the project does not whitelist ' + key + ', which a tree creates'
    )
  }
  for (const entry of allowed) {
    assert.ok(held.has(entry.group + '/' + entry.kind),
      'the project whitelists ' + entry.group + '/' + entry.kind + ', which no tree creates')
  }

  // The ServiceAccount token is the one privilege boundary, so the namespace that
  // hands it out is restricted, like the puppet's.
  const namespace = documents.find(document => document.kind === 'Namespace')
  assert.equal(namespace.name, 'monoplayer-panel')
  assert.match(namespace.text, /pod-security\.kubernetes\.io\/enforce: restricted/)
})


// --- the pin that decides which build runs ---

// A tree the Application syncs that runs this repository's image and is not pinned
// on the deploy branch runs the moving `main` tag. #234 came from exactly that: the
// panel ran a build its commit did not contain, and its pod crashlooped on a module
// the image never shipped. The set to check is the root kustomization's, not every
// directory under deploy/: the dev, testbed and driver trees are not synced, and the
// dev lane is unpinned on purpose because a branch image is its whole point.

test('every tree the Application syncs is pinned on the deploy branch', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'image.yaml'), 'utf8')
  const rootKustomization = read(ROOT, 'deploy', 'kustomization.yaml')
  const synced = [...rootKustomization.matchAll(/^ {2}- (\S+)$/gm)].map(match => match[1])
  assert.deepEqual(synced.sort(), ['manifests', 'panel'],
    'the Application syncs a different set of trees, and the pin below has to follow')
  for (const tree of synced) {
    const dir = path.join(ROOT, 'deploy', tree)
    const runsImage = documentsIn(dir, fs.readdirSync(dir).filter(file => file.endsWith('.yaml')))
      .some(document => document.kind === 'Deployment' &&
        /image:\s*ghcr\.io\/bafbi\/monoplayer/.test(document.text))
    assert.ok(runsImage, 'deploy/' + tree + ' runs no image of this repository, so it needs no pin')
    assert.match(workflow, new RegExp('deploy/' + tree + '/kustomization\\.yaml'),
      'image.yaml does not pin deploy/' + tree + ' on the deploy branch, so it runs the moving main tag')
  }
})

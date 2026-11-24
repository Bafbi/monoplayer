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

import { parseAllowedServers } from '../../src/service/control.js'

const MANIFESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'manifests')
const read = name => fs.readFileSync(path.join(MANIFESTS, name), 'utf8')
const manifests = () => fs.readdirSync(MANIFESTS).filter(name => name.endsWith('.yaml') && name !== 'kustomization.yaml')

test('the live kustomization lists every manifest in the directory', () => {
  const listed = [...read('kustomization.yaml').matchAll(/^ {2}- (\S+\.yaml)$/gm)].map(match => match[1])
  const files = manifests()
  assert.deepEqual(files.filter(name => !listed.includes(name)), [],
    'deploy/manifests holds a manifest the kustomization does not apply')
  assert.deepEqual(listed.filter(name => !files.includes(name)), [],
    'the kustomization names a file deploy/manifests does not hold')
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

test('the lane reads its control document and its whitelist from the mounted volume', () => {
  const deployment = read('deployment.yaml')
  const env = envOf('deployment.yaml')

  assert.equal(env.get('MONOPLAYER_ATTACH_WHITELIST'), '/control/attach-whitelist.json',
    'the whitelist is not the file the panel patches, so a panel write is ignored at login')
  assert.equal(env.get('MONOPLAYER_CONTROL_FILE'), '/control/desired.json',
    'no desired.json means the panel can never move this puppet')
  // "1" enables the move, and the move keeps an attached player's connection
  // (#233). Only "1" and "0" are read, so a typo here is a refusal that names
  // itself rather than a silent behaviour change.
  assert.equal(env.get('MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH'), '1',
    'the backend switch is off; the panel answers 409 and the move route is dead')
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
// --- the two halves of the backend switch agree ---

// Two switches decide one action, and one comment used to be the only thing keeping
// them in step: the registry's `allowBackendSwitch` says whether the panel may ask,
// and the lane's `MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH` says whether the puppet
// obeys. They were shipped disagreeing — the lane said 1, the registry said false —
// and the visible result was a page with no move control and a 409 on the route.
// This reads both files so the next drift is a red gate.

test('the registry and the lane agree on the backend switch', () => {
  const registry = read(path.join('..', 'panel', 'registry.yaml'))
  const deployment = read('deployment.yaml')

  const document = /puppets\.json: \|\n([\s\S]*)$/.exec(registry)
  assert.ok(document, 'the registry does not carry a puppets.json block')
  const puppets = JSON.parse(document[1].replace(/^ {4}/gm, '')).puppets
  assert.ok(puppets.length > 0, 'the registry names no puppet')

  const env = new Map([...deployment.matchAll(/- name: (MONOPLAYER_[A-Z_]+)\n\s+value: (.*)$/gm)]
    .map(match => [match[1], match[2].replace(/^"|"$/g, '')]))
  const laneAsks = env.get('MONOPLAYER_CONTROL_FILE') !== undefined
  const laneObeys = env.get('MONOPLAYER_CONTROL_ALLOW_BACKEND_SWITCH') === '1'

  for (const puppet of puppets) {
    if (puppet.allowBackendSwitch !== true) continue
    assert.ok(laneAsks,
      puppet.name + ': the panel may ask for a move, and the lane mounts no control document')
    assert.ok(laneObeys,
      puppet.name + ': the panel may ask for a move, and the lane refuses to obey it')
  }
  // The other direction is not an error — a lane may obey a document the panel does
  // not write yet, which is how the wiring was landed — but it is worth saying in the
  // gate's own words rather than leaving it to a comment.
  if (laneObeys && puppets.every(puppet => puppet.allowBackendSwitch !== true)) {
    assert.ok(true, 'the lane obeys the control document and no registry row may ask it')
  }
})

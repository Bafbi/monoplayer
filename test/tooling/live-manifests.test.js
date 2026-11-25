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


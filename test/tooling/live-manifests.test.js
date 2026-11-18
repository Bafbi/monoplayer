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

test('the lane reads its control document and its whitelist from the mounted volume', () => {
  const deployment = read('deployment.yaml')
  const env = new Map([...deployment.matchAll(/- name: (MONOPLAYER_[A-Z_]+)\n\s+value: (.*)$/gm)]
    .map(match => [match[1], match[2].replace(/^"|"$/g, '')]))

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

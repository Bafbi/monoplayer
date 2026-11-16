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

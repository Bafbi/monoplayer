// The registry is the panel's whole permission model: a control ConfigMap it
// names is a control ConfigMap it may patch, and one it does not name is out of
// reach. So a document this module accepts is a document the panel will act on,
// and every rejection below is a case rather than a detail. A key spelled
// `controlConfigmap` would otherwise reach the write path as `undefined` and
// fail there, in the one place where the failure looks like the cluster's fault.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry, registryDocument } from '../../src/panel/registry.js'

const puppet = (overrides = {}) => ({
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
  allowBackendSwitch: true,
  ...overrides
})

const document = (puppets = [puppet()], version = 1) => JSON.stringify({ version, puppets })

test('a registry document names its puppets and their write targets', () => {
  const registry = parseRegistry(document())
  assert.deepEqual(registry.puppets, [puppet()])
  assert.equal(registry.version, 1)
})

test('a mounted ConfigMap document and a bare JSON file read the same', () => {
  // The pod mounts one file per ConfigMap key, so it reads JSON; a checkout has
  // the ConfigMap itself. Both reach parseRegistry, so a manifest edit and a pod
  // start cannot disagree about what the panel may touch.
  const json = document()
  const configMap = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: panel-registry',
    'data:',
    '  puppets.json: |',
    ...json.split('\n').map(line => '    ' + line),
    ''
  ].join('\n')

  assert.equal(registryDocument(configMap), json)
  assert.equal(registryDocument(json), json)
  assert.deepEqual(parseRegistry(configMap), parseRegistry(json))
})

test('a document the panel cannot act on is refused with the field that broke it', () => {
  const cases = [
    ['a misspelled key', document([puppet({ controlConfigmap: 'monoplayer-control' })]), /controlConfigmap/],
    ['a missing write target', document([{ ...puppet(), controlConfigMap: undefined }]), /controlConfigMap/],
    ['a write target that is not a name', document([puppet({ controlConfigMap: 'Monoplayer_Control' })]), /controlConfigMap/],
    ['a missing seed', document([{ ...puppet(), seedConfigMap: undefined }]), /seedConfigMap/],
    ['a seed that is not a name', document([puppet({ seedConfigMap: 'Monoplayer_Config' })]), /seedConfigMap/],
    // The seed is the copy Git owns. A row that names the object the panel writes
    // would read back the key it just found absent, and the fallback would answer
    // an empty list while looking wired.
    ['a seed that is the write target', document([puppet({ seedConfigMap: 'monoplayer-control' })]), /seedConfigMap/],
    ['a namespace that is not a name', document([puppet({ namespace: 'Monoplayer' })]), /namespace/],
    ['a backend with no port', document([puppet({ backend: 'play2.excalia.fr' })]), /backend/],
    ['a backend at an address no dial can reach', document([puppet({ backend: '999.999.999.999:25565' })]), /backend/],
    ['a backend port out of range', document([puppet({ backend: 'play2.excalia.fr:70000' })]), /backend/],
    ['a front with a scheme', document([puppet({ frontHostname: 'https://glowsquidye.tail41e568.ts.net' })]), /frontHostname/],
    ['a backend switch that is not a boolean', document([puppet({ allowBackendSwitch: 'yes' })]), /allowBackendSwitch/],
    ['a puppet with no backend switch', document([{ ...puppet(), allowBackendSwitch: undefined }]), /allowBackendSwitch/],
    ['the same puppet twice', document([puppet(), puppet({ controlConfigMap: 'monoplayer-control-two' })]), /name/],
    ['two puppets writing one ConfigMap', document([puppet(), puppet({ name: 'other' })]), /monoplayer-control/],
    ['an empty registry', document([]), /puppets/],
    ['an unknown version', document([puppet()], 2), /version/],
    ['a puppets field that is not a list', JSON.stringify({ version: 1, puppets: 'glowsquidye' }), /puppets/],
    ['a document that is not JSON', 'puppets: [', /JSON/]
  ]
  for (const [name, text, reason] of cases) {
    assert.throws(() => parseRegistry(text), reason, name + ' is refused')
  }
})

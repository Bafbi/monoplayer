// The panel's three reads, asserted on the request they make. The URL is the
// contract: the ticket names `pods/log?container=monoplayer&tailLines=400`, and a
// panel that asked for the whole log of a week-old pod would still pass a test
// that only checked the answer.
//
// No cluster, no certificate, no token: `request` is injected, and so are the two
// credential readers. The default transport is one node:https call and is not
// exercised here; every answer below comes from a fixture.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  containerEnv,
  createKubeClient,
  deploymentCaps,
  labelSelector,
  mergePatchBody,
  ReadRefused,
  WriteRefused
} from '../../src/panel/kube.js'

const answer = (body, status = 200, statusText = 'OK') => ({
  status,
  statusText,
  body: typeof body === 'string' ? body : JSON.stringify(body)
})

function client (responses, calls = []) {
  return {
    calls,
    kube: createKubeClient({
      readToken: () => 'test-token',
      readCA: () => 'test-ca',
      request: async ({ path, token, ca, baseUrl }) => {
        calls.push({ path, token, ca, baseUrl })
        const response = responses[path]
        if (response === undefined) throw new Error('the fixture has no answer for ' + path)
        return response
      }
    })
  }
}

const DEPLOYMENT = '/apis/apps/v1/namespaces/monoplayer/deployments/monoplayer'
const PODS = '/api/v1/namespaces/monoplayer/pods?labelSelector=app%3Dmonoplayer'
const LOG = '/api/v1/namespaces/monoplayer/pods/monoplayer-7d9f-abcde/log?container=monoplayer&tailLines=400'

test('the read of a Deployment asks for that Deployment and parses the answer', async () => {
  const { kube, calls } = client({ [DEPLOYMENT]: answer({ spec: { selector: { matchLabels: { app: 'monoplayer' } } } }) })
  const deployment = await kube.deployment('monoplayer', 'monoplayer')
  assert.deepEqual(deployment.spec.selector.matchLabels, { app: 'monoplayer' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, DEPLOYMENT)
  assert.equal(calls[0].token, 'test-token', 'the pod\'s own ServiceAccount token, and no other credential')
  assert.equal(calls[0].ca, 'test-ca')
  assert.equal(calls[0].baseUrl, 'https://kubernetes.default.svc')
})

test('the pod list is the Deployment\'s own selector, encoded', async () => {
  const { kube, calls } = client({ [PODS]: answer({ items: [] }) })
  await kube.pods('monoplayer', 'app=monoplayer')
  assert.equal(calls[0].path, PODS)
})

test('the log read is the exact request the ticket names', async () => {
  const { kube, calls } = client({ [LOG]: answer('{"event":"heartbeat"}\n', 200, 'OK') })
  const text = await kube.podLog('monoplayer', 'monoplayer-7d9f-abcde')
  assert.equal(text, '{"event":"heartbeat"}\n')
  assert.equal(calls[0].path, LOG)
})

test('a selector is sorted, and a Deployment that names none is null rather than every pod', () => {
  assert.equal(labelSelector({ spec: { selector: { matchLabels: { tier: 'proxy', app: 'monoplayer' } } } }),
    'app=monoplayer,tier=proxy')
  assert.equal(labelSelector({ spec: { selector: { matchLabels: {} } } }), null)
  assert.equal(labelSelector({ spec: { selector: { matchExpressions: [] } } }), null)
  assert.equal(labelSelector({}), null)
  assert.equal(labelSelector(null), null)
})

test('the caps come from the Deployment\'s own environment, and an unset one stays unknown', () => {
  const deployment = {
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'sidecar', env: [{ name: 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS', value: '99' }] },
            {
              name: 'monoplayer',
              env: [
                { name: 'MONOPLAYER_PREAUTH_MAX_CONNECTIONS', value: '3' },
                { name: 'MONOPLAYER_PREAUTH_DEADLINE_MS', value: '15000' },
                { name: 'MONOPLAYER_JOURNAL_MAX_BYTES', value: '67108864' },
                { name: 'OTHER_VARIABLE', value: '7' }
              ]
            }
          ]
        }
      }
    }
  }
  assert.deepEqual(deploymentCaps(deployment), {
    preAuthMaxConnections: 3,
    preAuthDeadlineMs: 15_000,
    journalMaxBytes: 67_108_864,
    journalMaxTotalBytes: null,
    journalMaxAgeMs: null
  })
  // A variable that is not a number is unknown, not zero.
  const broken = deploymentCaps({ spec: { template: { spec: { containers: [{ name: 'monoplayer', env: [{ name: 'MONOPLAYER_PREAUTH_DEADLINE_MS', value: 'soon' }] }] } } } })
  assert.equal(broken.preAuthDeadlineMs, null)
  assert.equal(deploymentCaps({}).preAuthMaxConnections, null)
})

test('a refusal keeps its status and names the read that failed', async () => {
  const { kube } = client({ [LOG]: answer('forbidden', 403, 'Forbidden') })
  await assert.rejects(kube.podLog('monoplayer', 'monoplayer-7d9f-abcde'), error => {
    assert.ok(error instanceof ReadRefused)
    assert.equal(error.status, 403)
    assert.match(error.message, /read the log of monoplayer\/monoplayer-7d9f-abcde/)
    assert.match(error.message, /answered 403 Forbidden/)
    return true
  })
})

test('an API server that cannot be reached is a refused read, not an exception that escapes the page', async () => {
  const { kube } = client({ [DEPLOYMENT]: answer('', 200, 'OK') })
  const broken = createKubeClient({
    readToken: () => 'test-token',
    readCA: () => null,
    request: async () => { throw new Error('connect ECONNREFUSED 10.96.0.1:443') }
  })
  await assert.rejects(broken.deployment('monoplayer', 'monoplayer'), error => {
    assert.ok(error instanceof ReadRefused)
    assert.equal(error.status, 0)
    assert.match(error.message, /ECONNREFUSED/)
    return true
  })
  // And a body that is not JSON is a refusal too, rather than a crash in a route.
  await assert.rejects(kube.deployment('monoplayer', 'monoplayer'), /not JSON/)
})

test('a pod with no token says so instead of sending an empty bearer', async () => {
  const kube = createKubeClient({ tokenFile: '/nonexistent/token', readCA: () => null, request: async () => answer({}) })
  await assert.rejects(kube.pods('monoplayer', 'app=monoplayer'), error => {
    assert.ok(error instanceof ReadRefused)
    assert.match(error.message, /no service account token at \/nonexistent\/token/)
    return true
  })
})

// --- #233: the one write -------------------------------------------------------
//
// The same client, the same injected `request`, and the same credentials: the
// write is a fourth request, not a second transport. What these cases assert is the
// request it makes, because the URL, the method and the merge patch are the whole
// contract with an API server no test here can reach.

function patcher (calls = [], responses = {}) {
  const kube = createKubeClient({
    readToken: () => 'test-token',
    readCA: () => 'test-ca',
    request: async call => {
      calls.push(call)
      const answerFor = responses[call.path]
      if (answerFor === undefined) return { status: 200, statusText: 'OK', body: JSON.stringify({ kind: 'ConfigMap' }) }
      if (answerFor instanceof Error) throw answerFor
      return answerFor
    }
  })
  return { kube, calls }
}

test('the merge patch keeps every key it does not name', () => {
  const body = JSON.parse(mergePatchBody({ key: 'desired.json', text: '{ "version": 1 }' }))
  assert.deepEqual(body, { data: { 'desired.json': '{ "version": 1 }' } },
    'RFC 7386 merges objects, so the whitelist beside this key survives the patch')
})

test('a patch is one authorized request on the object the registry names', async () => {
  const { kube, calls } = patcher()
  const outcome = await kube.patchConfigMapKey({
    namespace: 'monoplayer',
    name: 'monoplayer-control',
    key: 'desired.json',
    text: '{ "version": 1 }'
  })

  assert.equal(outcome.status, 200)
  assert.equal(outcome.key, 'desired.json')
  assert.equal(typeof outcome.bytes, 'number')
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, '/api/v1/namespaces/monoplayer/configmaps/monoplayer-control')
  assert.equal(call.token, 'test-token')
  assert.equal(call.ca, 'test-ca', 'the cluster CA is read from its mounted file')
  assert.equal(call.contentType, 'application/merge-patch+json')
  assert.equal(call.body, mergePatchBody({ key: 'desired.json', text: '{ "version": 1 }' }))
})

test('a write with no token says so, and sends nothing', async () => {
  const calls = []
  const kube = createKubeClient({
    tokenFile: '/nonexistent/token',
    readCA: () => null,
    request: async call => { calls.push(call); return { status: 200, statusText: 'OK', body: '{}' } }
  })
  await assert.rejects(
    kube.patchConfigMapKey({ namespace: 'monoplayer', name: 'monoplayer-control', key: 'desired.json', text: '{}' }),
    error => {
      assert.ok(error instanceof WriteRefused)
      assert.match(error.message, /no service account token at \/nonexistent\/token/)
      return true
    })
  assert.equal(calls.length, 0, 'nothing is sent without a token')
})

test('a write the API server refuses carries the reason it gave', async () => {
  const path = '/api/v1/namespaces/monoplayer/configmaps/monoplayer-control'
  const refused = patcher([], {
    [path]: {
      status: 403,
      statusText: 'Forbidden',
      body: JSON.stringify({ kind: 'Status', reason: 'Forbidden', message: 'configmaps "monoplayer-control" is forbidden' })
    }
  })
  await assert.rejects(
    refused.kube.patchConfigMapKey({ namespace: 'monoplayer', name: 'monoplayer-control', key: 'desired.json', text: '{}' }),
    error => {
      assert.ok(error instanceof WriteRefused)
      assert.equal(error.status, 403)
      assert.match(error.message, /answered 403: configmaps "monoplayer-control" is forbidden/)
      return true
    })

  const unreachable = patcher([], { [path]: new Error('connect ECONNREFUSED 10.96.0.1:443') })
  await assert.rejects(
    unreachable.kube.patchConfigMapKey({ namespace: 'monoplayer', name: 'monoplayer-control', key: 'desired.json', text: '{}' }),
    error => {
      assert.ok(error instanceof WriteRefused)
      assert.equal(error.status, 0)
      assert.match(error.message, /ECONNREFUSED/)
      return true
    })
})

test('a write that succeeded says what it wrote, and the token reaches nothing', async () => {
  const { kube } = patcher()
  const outcome = await kube.patchConfigMapKey({
    namespace: 'monoplayer',
    name: 'monoplayer-control',
    key: 'desired.json',
    text: '{}'
  })
  assert.ok(!JSON.stringify(outcome).includes('test-token'), 'the token is not in a return value')
})

// --- #232: the read-modify-write ----------------------------------------------
//
// The whitelist route reads one ConfigMap, patches one key, and has to lose a race
// as a 409 rather than as a silently overwritten document. Both halves are the
// client's: a read that does not exist yet, and a patch that carries the version
// it read as a precondition.

const CONFIG_MAP = '/api/v1/namespaces/monoplayer/configmaps/monoplayer-control'

test('the ConfigMap read asks for that object, by namespace and name', async () => {
  const { kube, calls } = patcher([], {
    [CONFIG_MAP]: {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({
        kind: 'ConfigMap',
        metadata: { name: 'monoplayer-control', namespace: 'monoplayer', resourceVersion: '412' },
        data: { 'attach-whitelist.json': '{ "version": 1, "players": [] }', 'desired.json': '{}' }
      })
    }
  })
  const answer = await kube.configMap('monoplayer', 'monoplayer-control')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, undefined, 'a read passes no method, so the transport defaults to GET')
  assert.equal(calls[0].path, CONFIG_MAP)
  assert.equal(answer.metadata.resourceVersion, '412')
  assert.equal(Object.keys(answer.data).length, 2, 'every key is returned, so the route can leave the others alone')
})

test('a ConfigMap the cluster will not give up is a ReadRefused that names the status', async () => {
  const { kube } = patcher([], {
    [CONFIG_MAP]: { status: 404, statusText: 'Not Found', body: JSON.stringify({ kind: 'Status', reason: 'NotFound', message: 'configmaps "monoplayer-control" not found' }) }
  })
  await assert.rejects(kube.configMap('monoplayer', 'monoplayer-control'), error => {
    assert.ok(error instanceof ReadRefused)
    assert.equal(error.status, 404)
    assert.match(error.message, /answered 404/)
    return true
  })
})

test('a merge patch can carry the resourceVersion it read, so a lost race is a 409', () => {
  assert.deepEqual(
    JSON.parse(mergePatchBody({ key: 'attach-whitelist.json', text: '{}', resourceVersion: '412' })),
    { data: { 'attach-whitelist.json': '{}' }, metadata: { resourceVersion: '412' } },
    'the version is a precondition on the object, not a second document'
  )
  assert.deepEqual(
    JSON.parse(mergePatchBody({ key: 'desired.json', text: '{}' })),
    { data: { 'desired.json': '{}' } },
    'a write that does not read first sends exactly what it always did'
  )
})

test('a patched write carries the precondition and reports the version it produced', async () => {
  const { kube, calls } = patcher([], {
    [CONFIG_MAP]: {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ metadata: { resourceVersion: '413' } })
    }
  })
  const outcome = await kube.patchConfigMapKey({
    namespace: 'monoplayer',
    name: 'monoplayer-control',
    key: 'attach-whitelist.json',
    text: '{}',
    resourceVersion: '412'
  })
  assert.deepEqual(JSON.parse(calls[0].body), {
    data: { 'attach-whitelist.json': '{}' },
    metadata: { resourceVersion: '412' }
  })
  assert.equal(outcome.resourceVersion, '413', 'the answer says which version the write produced')
  assert.equal(outcome.bytes, Buffer.byteLength(calls[0].body))
})

test('a patch that lost a race is a WriteRefused with the status, so the route can retry', async () => {
  const { kube } = patcher([], {
    [CONFIG_MAP]: {
      status: 409,
      statusText: 'Conflict',
      body: JSON.stringify({
        kind: 'Status',
        reason: 'Conflict',
        message: 'Operation cannot be fulfilled on configmaps "monoplayer-control": the object has been modified; please apply your changes to the latest version and try again'
      })
    }
  })
  await assert.rejects(
    kube.patchConfigMapKey({
      namespace: 'monoplayer',
      name: 'monoplayer-control',
      key: 'attach-whitelist.json',
      text: '{}',
      resourceVersion: '412'
    }),
    error => {
      assert.ok(error instanceof WriteRefused)
      assert.equal(error.status, 409)
      assert.match(error.message, /modified/)
      return true
    })
})

test('the container env is one rule, shared by the caps and the whitelist guard', () => {
  const deployment = {
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'sidecar', env: [{ name: 'MONOPLAYER_PUPPET_UUID', value: 'not-this-one' }] },
            { name: 'monoplayer', env: [{ name: 'MONOPLAYER_PUPPET_UUID', value: '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed' }] }
          ]
        }
      }
    }
  }
  assert.equal(containerEnv(deployment).get('MONOPLAYER_PUPPET_UUID'), '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed')
  assert.equal(containerEnv(deployment, 'sidecar').get('MONOPLAYER_PUPPET_UUID'), 'not-this-one')
  assert.equal(containerEnv(null).size, 0)
})

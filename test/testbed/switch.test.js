// src/testbed/switch.js is the one script that scales the live deployment to
// zero and disables Argo's auto-sync for the transfer run. `down` puts both back
// from a record in a state file (#107). A second `up` before a `down` used to
// overwrite that record with the empty one, so the policy was lost for good.
// These cases replace kubectl, and the registry probe the script shells out to,
// with shims: nothing here reaches a cluster, and the live deployment is never
// scaled. The assertions are made of the recorded argv.
//
// The front Service is what publishes the front, so `down` has to delete it:
// scaling the deployment to zero leaves that Service with no endpoints and its
// tailnet device registered (#116). And `up` has to record the digest it ran,
// because the manifest pulls a moving tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'src', 'testbed', 'switch.js')
const IMAGE = 'ghcr.io/bafbi/monoplayer'
const SHA = 'ab'.repeat(32)
const IMAGE_ID = IMAGE + '@sha256:' + SHA
const DIGEST = 'sha256:' + SHA
const TESTBED_POD = JSON.stringify({
  items: [{ metadata: { name: 'monoplayer-testbed-6d9f' }, status: { containerStatuses: [{ image: IMAGE + ':main', imageID: IMAGE_ID }] } }]
})

// The Argo Application's policy in the shape the API serves it. The record has
// to carry it back as JSON: a map printed by `jsonpath` is not a patch body.
const POLICY = { prune: true, selfHeal: true }
const APPLICATION = JSON.stringify({ spec: { syncPolicy: { automated: POLICY } } })
const RECORDED = { automated: JSON.stringify(POLICY), disabledByUs: true, imageID: IMAGE_ID, digest: DIGEST }
const FRONT_SERVICE = JSON.stringify({ status: { loadBalancer: { ingress: [{ hostname: 'monoplayer-testbed.example.invalid' }] } } })
// A policy an earlier run recorded. A later `up` that removes a different policy
// is the one `down` owes back.
const STALE = { prune: false, selfHeal: false }

// The shim answers every call the script makes, records every argv, and keeps
// the two facts that move: the Application's policy, which the first `up`
// removes, and the patch body `down` sends to put it back.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'state="$KUBECTL_STATE"',
  'last="${@: -1}"',
  'case " $* " in',
  // The live Application, read as JSON because a recorded policy has to
  // round-trip as JSON.
  '  *" get app "*"-o json"*) if [ -f "$state/policy-removed" ]; then printf \'{"spec":{"syncPolicy":{}}}\\n\'; else printf \'%s\\n\' "$KUBECTL_APPLICATION"; fi; exit 0 ;;',
  '  *" patch app "*) case "$*" in *"--type=json"*) touch "$state/policy-removed" ;; *"--type=merge"*) printf \'%s\\n\' "$last" >> "$state/merge-patches" ;; esac; printf \'app patched\\n\'; exit 0 ;;',
  '  *" scale deploy/monoplayer-testbed --replicas=1 "*) touch "$state/testbed-up"; echo ok; exit 0 ;;',
  '  *" scale deploy/monoplayer-testbed --replicas=0 "*) rm -f "$state/testbed-up"; echo ok; exit 0 ;;',
  '  *" get pods -l app.kubernetes.io/name=monoplayer-testbed "*) if [ -f "$state/testbed-up" ]; then echo "$KUBECTL_TESTBED_PODS"; else echo "$KUBECTL_NO_PODS"; fi; exit 0 ;;',
  '  *" delete svc "*) echo "service monoplayer-testbed deleted"; exit "$KUBECTL_DELETE_STATUS" ;;',
  '  *" get pods -l tailscale.com/parent-resource=monoplayer-testbed "*) echo "$KUBECTL_FRONT_PODS"; exit 0 ;;',
  '  *" get pods "*) printf \'{"items":[]}\\n\'; exit 0 ;;',
  '  *" exec "*) printf \'There are 1 of a max of 8 players online: GlowSquidye\\n\'; exit 0 ;;',
  '  *" logs "*) printf \'%s\\n\' \'{"event":"startLive","front":"monoplayer-testbed.example.invalid"}\' \'{"event":"liveReady","backend":"paper-hub"}\'; exit 0 ;;',
  '  *" get svc "*) if [ "$KUBECTL_SVC_MISSING" = "1" ]; then echo "service not found" >&2; exit 1; fi; echo "$KUBECTL_FRONT_SERVICE"; exit 0 ;;',
  '  *" get deploy "*) printf \'{"spec":{"replicas":1},"status":{"readyReplicas":1}}\\n\'; exit 0 ;;',
  '  *) printf \'ok\\n\'; exit 0 ;;',
  'esac',
  ''
].join('\n')

// `up` compares the registry of the two Papers through
// `node src/testbed/registry.js`, which opens real sockets to two port-forwards.
// The probe answers from the argv it is given: switch.js forwards the sky to
// 25765 and the hub to 25766, and the two hashes have to differ or the run would
// prove nothing.
const NODE_SHIM = [
  '#!/usr/bin/env bash',
  'if [ "$1" = "src/testbed/registry.js" ]; then',
  '  if [ "$4" = "25766" ]; then hash=hub; else hash=sky; fi',
  '  printf \'REGISTRIES [{"id":"minecraft:dimension_type","entries":5,"hash":"%s"}]\\n\' "$hash"',
  '  exit 0',
  'fi',
  'exec "$KUBECTL_NODE" "$@"',
  ''
].join('\n')

function workspace () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-switch-'))
  const bin = path.join(root, 'bin')
  const state = path.join(root, 'kubectl-state')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'node'), NODE_SHIM, { mode: 0o755 })
  return {
    root,
    bin,
    state,
    // The record the script reads and writes. Pointing it at the test space is
    // what keeps a live run's record, the only way its `down` restores Argo,
    // out of this file's reach.
    record: path.join(root, 'testbed-state.json'),
    digests: path.join(root, 'testbed-digests.jsonl'),
    runs: 0
  }
}

const record = space => JSON.parse(fs.readFileSync(space.record, 'utf8'))

function mergePatches (space) {
  const file = path.join(space.state, 'merge-patches')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
}

// One process per command, the way mise runs it, with the shims first on PATH.
// The script is spawned through `process.execPath`, so the `node` shim only
// catches the registry probe.
function run (space, args, env = {}) {
  const log = path.join(space.root, `kubectl-${++space.runs}.log`)
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${space.bin}:${process.env.PATH}`,
      KUBECTL_LOG: log,
      KUBECTL_STATE: space.state,
      KUBECTL_APPLICATION: APPLICATION,
      KUBECTL_NODE: process.execPath,
      MONOPLAYER_TESTBED_STATE: space.record,
      MONOPLAYER_TESTBED_DIGESTS: space.digests,
      // The registry probe is the shim, so the port-forward settle buys nothing.
      MONOPLAYER_TESTBED_REGISTRY_SETTLE_MS: '0',
      // The pod the testbed deployment reports while it is scaled up, and the
      // empty answer it gives once the run scales it back down.
      KUBECTL_TESTBED_PODS: TESTBED_POD,
      KUBECTL_NO_PODS: JSON.stringify({ items: [] }),
      KUBECTL_FRONT_PODS: JSON.stringify({ items: [] }),
      KUBECTL_FRONT_SERVICE: FRONT_SERVICE,
      KUBECTL_SVC_MISSING: '0',
      KUBECTL_DELETE_STATUS: '0',
      ...env
    }
  })
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? ''), calls }
}

test('two ups and one down keep the record and put the policy back', () => {
  const space = workspace()

  const first = run(space, ['up'])
  assert.equal(first.status, 0, first.output + '\ncalls: ' + first.calls.join(' | '))
  assert.deepEqual(record(space), RECORDED, 'the first up records the policy it removed')
  assert.match(
    first.calls.find(line => line.includes('--type=json')),
    /^-n argocd patch app monoplayer --type=json -p /,
    'the removal names the live Application: ' + first.calls.join(' | ')
  )
  assert.deepEqual(
    first.calls.filter(line => line.includes(' scale ')),
    [
      '-n monoplayer scale deploy/monoplayer --replicas=0',
      '-n monoplayer scale deploy/monoplayer-testbed --replicas=1'
    ],
    'up takes the live deployment down and starts the testbed: ' + first.calls.join(' | ')
  )

  // The block is gone now, so the second `up` finds nothing to remove and
  // reports nothing to restore. The record has to hold on to what the first one
  // saw, or `down` never restores auto-sync (#107).
  const second = run(space, ['up'])
  assert.equal(second.status, 0, second.output + '\ncalls: ' + second.calls.join(' | '))
  assert.deepEqual(record(space), RECORDED, 'the second up kept the record the first one wrote')
  assert.match(second.output, /kept the Argo record an earlier up wrote/)
  assert.equal(second.calls.some(line => line.includes('--type=json')), false,
    'the second up finds no policy to remove: ' + second.calls.join(' | '))

  const down = run(space, ['down'])
  assert.equal(down.status, 0, down.output + '\ncalls: ' + down.calls.join(' | '))
  assert.deepEqual(
    down.calls.filter(line => line.includes(' scale ')).map(line => line.replace(/^-n \S+ /, '')),
    [
      'scale deploy/monoplayer-testbed --replicas=0',
      'scale deploy/paper-hub --replicas=0',
      'scale deploy/paper-sky --replicas=0',
      'scale deploy/monoplayer --replicas=1'
    ],
    'down stops the testbed, then the Papers, then restores the live deployment'
  )

  // The policy comes back as one merge patch, and the body has to parse: a
  // record that cannot be patched back is not a way back.
  assert.match(
    down.calls.find(line => line.includes('--type=merge')),
    /^-n argocd patch app monoplayer --type=merge -p /,
    'the restore names the live Application: ' + down.calls.join(' | ')
  )
  const patches = mergePatches(space)
  assert.equal(patches.length, 1, 'down issues one merge patch: ' + patches.join(' | '))
  assert.deepEqual(JSON.parse(patches[0]), { spec: { syncPolicy: { automated: POLICY } } },
    'the patch carries the policy the first up removed')
  assert.match(down.output, /Argo auto-sync restored/)
  assert.equal(fs.existsSync(space.record), false, 'the record is cleared once the policy is back')
})

test('a record with nothing to restore yields to the policy this up removed', () => {
  // A first `up` run while auto-sync was already off records an empty record.
  // If auto-sync came back before the next `up`, that run removed the policy
  // itself, so `down` owes it back: keeping the empty record would leave Argo
  // syncing nothing until a human noticed.
  const space = workspace()
  fs.writeFileSync(space.record, JSON.stringify({ automated: null, disabledByUs: false }) + '\n')

  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.deepEqual(record(space), RECORDED, 'the record holds the policy this up removed')
  assert.equal(calls.some(line => line.includes('--type=json')), true, 'the policy was there to remove')
})

test('a later up replaces the policy an earlier run recorded', () => {
  // `down` puts back what is missing when it runs, not what was missing after
  // the first `up`. When auto-sync came back with another policy and this `up`
  // removed that one, the newer record is the one to restore.
  const space = workspace()
  fs.writeFileSync(space.record, JSON.stringify({ automated: JSON.stringify(STALE), disabledByUs: true }) + '\n')

  const { status, output, calls } = run(space, ['up'])
  assert.equal(status, 0, output + '\ncalls: ' + calls.join(' | '))
  assert.deepEqual(record(space), RECORDED, 'the record holds the policy this up removed')
  assert.equal(output.includes('kept the Argo record'), false, 'nothing was kept from the earlier run')
})

test('the record path is an override, and its default is the one the runbook names', () => {
  // The default is what AGENTS.md and docs/testing-ladder.md tell an operator to
  // find, and the override is what keeps this test off it.
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(source, /process\.env\.MONOPLAYER_TESTBED_STATE/, 'the record path is overridable')
  assert.match(source, /'\/tmp\/opencode\/monoplayer-testbed\.json'/, 'the default is /tmp/opencode/monoplayer-testbed.json')
})

test('down deletes the Service that published the front, after the live restore', () => {
  const space = workspace()

  const { status, output, calls } = run(space, ['down'])
  assert.equal(status, 0, output + ' calls: ' + calls.join(' | '))
  const scaledAt = calls.findIndex(line => line.includes('scale deploy/monoplayer-testbed --replicas=0'))
  const liveAt = calls.findIndex(line => line.includes('scale deploy/monoplayer --replicas=1'))
  const deleteAt = calls.findIndex(line => line.includes('delete svc monoplayer-testbed'))
  assert.ok(scaledAt >= 0, 'the testbed is scaled down: ' + calls.join(' | '))
  assert.ok(deleteAt > scaledAt, 'the Service goes after the pods, not before')
  // The delete can spend its whole timeout on the tailscale finalizer, so it
  // must never sit in front of the live deployment coming back.
  assert.ok(liveAt >= 0, 'the live deployment is scaled back up: ' + calls.join(' | '))
  assert.ok(deleteAt > liveAt, 'the Service goes after the live restore, never before')
  assert.ok(calls[deleteAt].includes('--ignore-not-found'), 'a delete of an absent Service still succeeds')

  // down restores the live deployment and must never be the thing that takes it
  // down, and it deletes nothing else from the tree.
  assert.equal(calls.some(line => line.includes('scale deploy/monoplayer --replicas=0')), false, 'down never scales live to zero')
  assert.equal(calls.some(line => line.includes('delete deploy')), false, 'the manifest tree survives')
})

test('a failed Service delete still restores the live deployment', () => {
  const space = workspace()

  const { status, output, calls } = run(space, ['down'], { KUBECTL_DELETE_STATUS: '1' })
  assert.notEqual(status, 0, 'a front that is still published is a failed command: ' + output)
  assert.ok(output.includes('delete svc monoplayer/monoplayer-testbed failed'), 'the failure is reported: ' + output)
  assert.ok(output.includes('the testbed front is still published'), 'the leftover is named: ' + output)
  assert.ok(calls.some(line => line.includes('scale deploy/monoplayer --replicas=1')), 'live came back anyway')
})

test('up records the digest it ran, in the output and in the record', () => {
  const space = workspace()

  const { status, output } = run(space, ['up'])
  assert.equal(status, 0, output)
  assert.match(output, /testbed image .*sha256:/, 'the run output has an image record: ' + output)
  assert.ok(output.includes(DIGEST), 'the run output names the digest: ' + output)
  const recorded = record(space)
  assert.equal(recorded.digest, DIGEST, 'the record names the digest')
  assert.equal(recorded.imageID, IMAGE_ID, 'the record names the image the digest belongs to')
  // The digest is written after the policy, so the later write has to merge:
  // down restores the policy from this same record.
  assert.equal(recorded.automated, JSON.stringify(POLICY), 'recording the image keeps the policy down restores')
  assert.equal(recorded.disabledByUs, true)

  // down clears the record, so the digest a finished run executed survives in
  // the digests file: that is what makes two runs comparable after the fact.
  const logged = JSON.parse(fs.readFileSync(space.digests, 'utf8'))
  assert.equal(logged.digest, DIGEST, 'the digests file names the digest')
  assert.equal(logged.imageID, IMAGE_ID)
  assert.equal(typeof logged.at, 'string', 'each line says when it ran')
})

test('up still records the digest when Argo had no policy to remove', () => {
  // disableAutoSync reports nothing to restore when Argo is already off, and
  // saveState then keeps whatever record is on disk (#107). The digest is not
  // part of that record, so it has to survive the write on its own.
  const space = workspace()

  const { status, output } = run(space, ['up'], { KUBECTL_APPLICATION: JSON.stringify({ spec: { syncPolicy: {} } }) })
  assert.equal(status, 0, output)
  const recorded = record(space)
  assert.equal(recorded.disabledByUs, false, 'there was no policy to remove')
  assert.equal(recorded.digest, DIGEST, 'the digest is recorded even with nothing to restore')
  assert.equal(recorded.imageID, IMAGE_ID)
})

test('up reads the digest from the pod that is not going away', () => {
  // A pod from the last run can still be terminating, and it is listed first.
  // Its image is not the one this run executed.
  const space = workspace()
  const previous = {
    metadata: { name: 'monoplayer-testbed-old', deletionTimestamp: '2026-01-01T00:00:00Z' },
    status: { containerStatuses: [{ imageID: IMAGE + '@sha256:' + 'cd'.repeat(32) }] }
  }
  const current = { metadata: { name: 'monoplayer-testbed-6d9f' }, status: { containerStatuses: [{ imageID: IMAGE_ID }] } }

  const { status, output } = run(space, ['up'], { KUBECTL_TESTBED_PODS: JSON.stringify({ items: [previous, current] }) })
  assert.equal(status, 0, output)
  assert.equal(record(space).digest, DIGEST, 'the run recorded the image it executed, not the one still terminating')
})

test('status reports the front, the tailnet proxy, and the recorded run', () => {
  // status is how the operator proves the front is gone after down, so its
  // lines are asserted here rather than in a transcript.
  const space = workspace()
  fs.writeFileSync(space.record, JSON.stringify(RECORDED))
  const proxies = JSON.stringify({ items: [{ metadata: { name: 'ts-monoplayer-testbed-hqb5v-0' } }] })

  const present = run(space, ['status'], { KUBECTL_FRONT_PODS: proxies })
  assert.equal(present.status, 0, present.output)
  assert.ok(present.output.includes('front monoplayer/monoplayer-testbed {"hostname":"monoplayer-testbed.example.invalid"}'), present.output)
  assert.ok(present.output.includes('tailnet devices {"count":1,"names":["ts-monoplayer-testbed-hqb5v-0"]}'), present.output)
  assert.ok(present.output.includes(DIGEST), 'the recorded digest is reported: ' + present.output)

  const gone = run(space, ['status'], { KUBECTL_SVC_MISSING: '1' })
  assert.equal(gone.status, 0, gone.output)
  assert.ok(gone.output.includes('front monoplayer/monoplayer-testbed {"missing":true}'), gone.output)
})

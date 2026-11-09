// scripts/online-cluster.sh runs the online rung from a throwaway pod. These
// cases replace kubectl with a shim, so nothing here reaches a cluster, creates
// a pod, or reads a token. The shim records every argv, which is what the
// guarantees are made of: no scale, no patch, no rollout, always a delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'online-cluster.sh'
)

const PUPPET = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH = '6eb73524-ff88-4a62-a8d0-c63905e7afba'

// The shim answers the calls the script makes, records every argv, and lets a
// case choose the token state and the rung's exit status. The uuids arrive as
// environment so the shim needs no substitution.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  'ATTACH="$KUBECTL_ATTACH"',
  'PUPPET="$KUBECTL_PUPPET"',
  'last="${@: -1}"',
  'case " $* " in',
  '  *" get deploy "*) printf \'{"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/bafbi/monoplayer@sha256:deadbeef","env":[{"name":"MONOPLAYER_PUPPET_UUID","value":"%s"},{"name":"MONOPLAYER_PUPPET_ACCOUNTS_DIR","value":"/data/accounts"}]}]}}}}\\n\' "$PUPPET"; exit 0 ;;',
  '  *" apply "*) cat > "$KUBECTL_MANIFEST"; printf \'pod/check created\\n\'; exit 0 ;;',
  '  *" wait "*" pod/"*) exit 0 ;;',
  '  *" cp ./src "*|*" cp ./package.json "*) exit 0 ;;',
  '  *" exec "*"mca-cache.json"*) printf \'%s\\n\' "${KUBECTL_TOKEN:-600 min left}"; exit 0 ;;',
  '  *" exec "*"online.js"*) printf \'PASS N1 the Microsoft-authenticated attach succeeds\\n\'; exit "${KUBECTL_RUN_STATUS:-0}" ;;',
  '  *" exec -i "*) cat > /dev/null; exit 0 ;;',
  '  *" exec "*) exit 0 ;;',
  '  *" delete pod "*) exit 0 ;;',
  '  *" cp "*"online-report.json"*) printf \'{"summary":"ok"}\\n\' > "$last"; exit 0 ;;',
  '  *" cp "*"/accounts/$ATTACH"*) mkdir -p "$last/$ATTACH"; printf \'{}\' > "$last/$ATTACH/live-cache.json"; printf \'{}\' > "$last/$ATTACH/profile.json"; exit 0 ;;',
  '  *" cp "*"/accounts/$PUPPET"*) mkdir -p "$last/$PUPPET"; for f in live-cache.json mca-cache.json xbl-cache.json profile.json; do printf \'{}\' > "$last/$PUPPET/$f"; done; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

function workspace () {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'monoplayer-cluster-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })

  const attach = path.join(root, '.secrets', 'accounts', ATTACH)
  fs.mkdirSync(attach, { recursive: true })
  fs.writeFileSync(path.join(attach, 'profile.json'), JSON.stringify({ uuid: ATTACH, name: 'Bafbi', alias: 'bafbi' }))
  fs.writeFileSync(path.join(attach, 'live-cache.json'), '{"old":true}')

  return { root, bin, attach, log: path.join(root, 'kubectl.log'), manifest: path.join(root, 'manifest.yaml') }
}

function run (space, env = {}) {
  const result = spawnSync('bash', [SCRIPT, '--report', path.join(space.root, 'report.json')], {
    cwd: space.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: space.bin + ':' + process.env.PATH,
      KUBECTL_LOG: space.log,
      KUBECTL_MANIFEST: space.manifest,
      KUBECTL_PUPPET: PUPPET,
      KUBECTL_ATTACH: ATTACH,
      MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
      ...env
    }
  })
  const calls = fs.existsSync(space.log)
    ? fs.readFileSync(space.log, 'utf8').trim().split('\n').filter(Boolean)
    : []
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  return { status: result.status, output, calls, error: result.error ?? null }
}

test('the run never scales, patches, or restarts the deployment', () => {
  const space = workspace()
  const { status, calls, output, error } = run(space)

  assert.equal(status, 0, 'status ' + status + ' error ' + (error?.message ?? 'none') + ' calls: ' + calls.join(' | ') + ' output: ' + output)
  for (const verb of ['scale', 'rollout', 'patch', 'delete deploy']) {
    assert.equal(calls.some(line => line.includes(verb)), false, 'no ' + verb + ' in: ' + calls.join(' / '))
  }
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is deleted')
})

test('the custody volume is mounted read-only', () => {
  const space = workspace()
  run(space)
  const manifest = fs.readFileSync(space.manifest, 'utf8')

  assert.match(manifest, /claimName: monoplayer-custody[\s\S]*readOnly: true/, 'claim is read-only')
  assert.match(manifest, /mountPath: \/data\n\s+readOnly: true/, 'mount is read-only')
  assert.match(manifest, /automountServiceAccountToken: false/)
})

test('the pod is deleted even when the rung fails, and the exit status survives', () => {
  const space = workspace()
  const { status, calls } = run(space, { KUBECTL_RUN_STATUS: '1' })

  assert.equal(status, 1)
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is deleted on failure')
})

test('an expired puppet token stops the run before it can rotate the chain', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_TOKEN: 'expired' })

  assert.equal(status, 2)
  assert.match(output, /with --rotate/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran')
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is cleaned up')
})

test('the attach custody is copied back, so one live copy remains', () => {
  const space = workspace()
  const { status, output } = run(space)
  assert.equal(status, 0, output)

  const written = JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8'))
  assert.deepEqual(written, {}, 'the rotated copy replaced the local one')
})

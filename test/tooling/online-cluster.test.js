// scripts/online-cluster.sh runs the online rung from a throwaway pod. These
// cases replace kubectl with a shim, so nothing here reaches a cluster, creates
// a pod, or reads a token. The shim records every argv, which is what the
// guarantees are made of: no scale, no patch, no rollout, always a delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'
import { readMiseTasks } from './mise-toml.js'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'online-cluster.sh'
)

const PUPPET = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'
const ATTACH = '6eb73524-ff88-4a62-a8d0-c63905e7afba'

// What the gate's reader answers, three fields: the verdict, the words, the expiry (#389).
// A case that wants a refusal or a pass names one of these instead of retyping the shape.
const VALID = 'ok|600 min left|2099-01-01T00:00:00.000Z'
const LAPSED = 'expired|expired|2026-01-02T03:04:05.000Z'

// The lane this worktree's rung derives (#279), mirrored the way gate-lane.test.js
// mirrors it: a script that typed a name instead of deriving one could not match.
const WORKTREE = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const COMMIT = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const crc = text => Number(spawnSync('cksum', [], { input: text, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0])
const LANE = 'monoplayer-gate-' + COMMIT + '-' + (crc(WORKTREE) % 0x1000000).toString(16).padStart(6, '0')
const BRANCH = (() => {
  const name = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (name !== 'HEAD') return name
  const sha = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  return 'detached at ' + sha
})()

// The shim answers the calls the script makes, records every argv, and lets a
// case choose the token state and the rung's exit status. The uuids arrive as
// environment so the shim needs no substitution.
const SHIM = [
  '#!/usr/bin/env bash',
  'printf \'%s\\n\' "$*" >> "$KUBECTL_LOG"',
  // One line per argv word, so a case can tell one argument that holds a space from
  // two arguments. `$*` cannot (#384).
  // A marker at the start of each call, so a case can read one call's words and stop.
  'printf \'<<call>>\\n\' >> "$KUBECTL_ARGV_LOG"',
  'printf \'<<%s>>\\n\' "$@" >> "$KUBECTL_ARGV_LOG"',
  'ATTACH="$KUBECTL_ATTACH"',
  'PUPPET="$KUBECTL_PUPPET"',
  'last="${@: -1}"',
  // Two writes can be in flight at once, and a case that holds one against the other needs
  // the log to name an order. So one lock covers the log entry and the object, and the log
  // reads in the order the writes landed.
  'record() { until mkdir "$KUBECTL_LEASES.lock" 2>/dev/null; do sleep 0.01; done; printf \'%s\\n\' --- >> "$KUBECTL_LEASES"; printf \'%s\\n\' "$1" >> "$KUBECTL_LEASES"; printf \'%s\\n\' "$1" > "$KUBECTL_LEASE"; rmdir "$KUBECTL_LEASES.lock"; }',
  'case " $* " in',
  // The account lease (#280): the shim answers from a file, records every object the
  // script writes, and can answer one read as held and the next as absent, which is
  // the whole of "queue behind a holder, then take it".
  '  *" get lease "*) if [ -n "$KUBECTL_LEASE_READ_ERROR" ]; then printf \'Error from server (Forbidden): leases are forbidden\\n\' >&2; exit 1; fi',
    '    reads=$(cat "$KUBECTL_LEASE_READS" 2>/dev/null || printf 0); reads=$((reads + 1)); printf %s "$reads" > "$KUBECTL_LEASE_READS"' ,
  '    if [ -n "$KUBECTL_LEASE_FOREIGN_AFTER" ] && [ "$reads" -gt "$KUBECTL_LEASE_FOREIGN_AFTER" ] && [ -f "$KUBECTL_LEASE_FOREIGN" ]; then cat "$KUBECTL_LEASE_FOREIGN"; exit 0; fi',
  '    if [ -f "$KUBECTL_LEASE" ]; then cat "$KUBECTL_LEASE"; if [ "$KUBECTL_LEASE_ONCE" = 1 ]; then rm -f "$KUBECTL_LEASE"; fi; exit 0; fi',
  '    printf \'Error from server (NotFound): lease not found\\n\' >&2; exit 1 ;;',
  // A release is the write with an empty holder identity (#355). Read the object here, as
  // kubectl reads it before it calls the API server. A write that is held up then lands
  // with what it was given, not with what is on disk by then.
  '  *" create -f "*|*" replace -f "*) body=$(cat "${@: -1}")',
  '    if printf \'%s\' "$body" | grep -q \'"holderIdentity": ""\'; then',
  '      record "$body"',
  '      [ -z "$KUBECTL_RENEW_GO" ] || : > "$KUBECTL_RENEW_GO"',
  '      printf \'lease released\\n\'; exit 0',
  '    fi',
  // The one window a kill cannot close: the write is this process, not the loop's, so it
  // lands after the loop is dead.
  '    if [ -n "$KUBECTL_RENEW_BLOCK" ] && [ -f "$KUBECTL_LEASE" ]; then',
  '      : > "$KUBECTL_RENEW_BLOCKED"',
  '      while [ ! -f "$KUBECTL_RENEW_GO" ]; do sleep 0.02; done',
  '      record "$body"',
  '      : > "$KUBECTL_RENEW_SETTLED"',
  '      printf \'renewal landed\\n\'; exit 0',
  '    fi',
  '    record "$body"; printf \'lease configured\\n\'; exit 0 ;;',
  '  *" get deploy "*) printf \'{"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/bafbi/monoplayer@sha256:deadbeef","env":[{"name":"MONOPLAYER_PUPPET_UUID","value":"%s"},{"name":"MONOPLAYER_PUPPET_ACCOUNTS_DIR","value":"/data/accounts"}]}]}}}}\\n\' "$PUPPET"; exit 0 ;;',
  '  *" apply "*) cat > "$KUBECTL_MANIFEST"; printf \'pod/check created\\n\'; exit 0 ;;',
  '  *" wait "*" pod/"*) exit 0 ;;',
  '  *" cp ./src "*|*" cp ./package.json "*) exit 0 ;;',
  // The expiry gate reads one account's cached mca token (#389). Two accounts are read
  // the same way, so the directory in the argv says which answer this is.
  // KUBECTL_ATTACH_SILENT models a read that answered nothing at all, which is what a pod
  // that died between the gate and the read looks like. The gate refuses it (#389).
  '  *" exec "*"mca-cache.json"*) case "$*" in',
  '    *"/accounts/$ATTACH"*) [ -z "${KUBECTL_ATTACH_SILENT:-}" ] || exit 0',
  '      printf \'%s\\n\' "${KUBECTL_ATTACH_TOKEN:-ok|600 min left|2099-01-01T00:00:00.000Z}" ;;',
  '    *) printf \'%s\\n\' "${KUBECTL_TOKEN:-ok|600 min left|2099-01-01T00:00:00.000Z}" ;;',
  '  esac; exit 0 ;;',
  '  *" exec "*"online.js"*) [ -z "$KUBECTL_RUN_SLEEP" ] || sleep "$KUBECTL_RUN_SLEEP"; printf \'PASS N1 the Microsoft-authenticated attach succeeds\\n\'; exit "${KUBECTL_RUN_STATUS:-0}" ;;',
  '  *" exec -i "*) cat > /dev/null; exit 0 ;;',
  '  *" exec "*) exit 0 ;;',
  '  *" delete pod "*) exit 0 ;;',
  '  *" cp "*"online-report.json"*) printf \'{"summary":"ok"}\\n\' > "$last"; exit 0 ;;',
  // The attach copy-in and the attach copy-back are one shape, so the destination says
  // which this is: a pod path ends in `:...`, and a copy-back lands on a local directory.
  // A case can make the copy-back bring nothing back, or fail. Both are what a rotation
  // that never landed looks like (#370).
  '  *" cp "*"/accounts/$ATTACH"*) case "$last" in',
  '    *:*) exit 0 ;;',
  '    *) if [ "${KUBECTL_ATTACH_BACK_FAIL:-}" = 1 ]; then printf \'Error from server (NotFound): pods "check" not found\\n\' >&2; exit 1; fi',
  '      [ "${KUBECTL_ATTACH_BACK_EMPTY:-}" != 1 ] || exit 0',
  // A run that rotated nothing hands back the directory it was given, so the default is a
  // byte-identical copy of the local one. KUBECTL_ATTACH_ROTATED writes a token cache the
  // local copy does not have, which is what a rotation inside the pod looks like.
  '      mkdir -p "$last/$ATTACH"; cp -a "$KUBECTL_ATTACH_SOURCE"/. "$last/$ATTACH"/; rm -f "$last/$ATTACH/writer.lock"',
  '      [ "${KUBECTL_ATTACH_ROTATED:-}" != 1 ] || printf \'{}\\n\' > "$last/$ATTACH/live-cache.json"; exit 0 ;;',
  '  esac ;;',
  '  *" cp "*"/accounts/$PUPPET"*) mkdir -p "$last/$PUPPET"; for f in live-cache.json mca-cache.json xbl-cache.json profile.json; do printf \'{}\' > "$last/$PUPPET/$f"; done; exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
  ''
].join('\n')

// BSD find, which macOS ships, has no -printf: it writes nothing to stdout, says so on
// stderr, and exits 1. Under this script's `set -euo pipefail` that exit status is the
// assignment's, so the copy-back aborted the whole run with a status and no sentence. The
// shim refuses the primaries BSD lacks, so a GNU-only read fails on this Linux checkout
// too (#370).
const REAL_FIND = spawnSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim()
assert.ok(REAL_FIND, 'a real find is on PATH for the shim to exec')
const FIND_SHIM = [
  '#!/usr/bin/env bash',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    -printf) printf \'find: %s: unknown primary or operator\\n\' "$arg" >&2; exit 1 ;;',
  '  esac',
  'done',
  'exec \'' + REAL_FIND + '\' "$@"',
  ''
].join('\n')

// `strictFind` puts the BSD-behaved find in PATH. It is on for every case, so no case
// can pass while the script reads a directory with a GNU-only primary. The two cases that
// are about an empty or a failed copy-back turn it off, so each fails for its own reason
// and not for the dialect (#370).
function workspace ({ strictFind = true } = {}) {
  const root = tempRoot('monoplayer-cluster-')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'kubectl'), SHIM, { mode: 0o755 })
  if (strictFind) fs.writeFileSync(path.join(bin, 'find'), FIND_SHIM, { mode: 0o755 })

  const attach = path.join(root, '.secrets', 'accounts', ATTACH)
  fs.mkdirSync(attach, { recursive: true })
  fs.writeFileSync(path.join(attach, 'profile.json'), JSON.stringify({ uuid: ATTACH, name: 'Bafbi', alias: 'bafbi' }))
  fs.writeFileSync(path.join(attach, 'live-cache.json'), '{"old":true}')

  return {
    root,
    bin,
    attach,
    log: path.join(root, 'kubectl.log'),
    // Every argv word of every kubectl call, one per line and bracketed (#384).
    argv: path.join(root, 'kubectl-argv.log'),
    // Every case gets its own TMPDIR, which is where the script keeps the state
    // directory its lease markers live in.
    tmp: (() => {
      const dir = path.join(root, 'tmp')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    })(),
    manifest: path.join(root, 'manifest.yaml'),
    // The lease the shim answers from, and every object the script wrote, in order.
    lease: path.join(root, 'lease.json'),
    leases: path.join(root, 'leases.log'),
    reads: path.join(root, 'lease-reads'),
    foreign: path.join(root, 'lease-foreign.json'),
    // The three files that order one renewal against one release.
    renewBlocked: path.join(root, 'renew-blocked'),
    renewGo: path.join(root, 'renew-go'),
    renewSettled: path.join(root, 'renew-settled')
  }
}

function podArgs (space) {
  return ['--report', path.join(space.root, 'report.json')]
}

// The environment every case hands the script: the shim on PATH, and the files the
// shim answers from.
function baseEnv (space, env = {}) {
  return {
    ...process.env,
    PATH: space.bin + ':' + process.env.PATH,
    TMPDIR: space.tmp,
    KUBECTL_LOG: space.log,
    KUBECTL_ARGV_LOG: space.argv,
    KUBECTL_MANIFEST: space.manifest,
    KUBECTL_PUPPET: PUPPET,
    KUBECTL_ATTACH: ATTACH,
    // The local copy the copy-back is compared against, and copied from when a case
    // wants the pod to hand back what it was given.
    KUBECTL_ATTACH_SOURCE: path.join(space.root, '.secrets', 'accounts', ATTACH),
    MONOPLAYER_SECRETS_SOURCE: path.join(space.root, '.secrets'),
    KUBECTL_LEASE: space.lease,
    KUBECTL_LEASES: space.leases,
    KUBECTL_LEASE_READS: space.reads,
    KUBECTL_LEASE_FOREIGN: space.foreign,
    ...env
  }
}

function run (space, env = {}, args = null) {
  const result = spawnSync('bash', [SCRIPT, ...(args ?? podArgs(space))], {
    cwd: space.root,
    encoding: 'utf8',
    env: baseEnv(space, env)
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
  const { status, output, calls } = run(space, { KUBECTL_TOKEN: LAPSED })

  assert.equal(status, 2)
  assert.match(output, /with --rotate/)
  assert.match(output, /it expired at 2026-01-02T03:04:05\.000Z/, 'it names the expiry: ' + output)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran')
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is cleaned up')
})

// --- the attach account gets the puppet's gate (#389) -------------------------
//
// A valid cached access token rotates nothing. Once it expires, the login inside the pod
// refreshes and rotates the chain: the copy that refreshed last is live, and every other
// copy is dead until a device-code bootstrap (docs/custody.md, "One live copy per
// account"). The attach account's live copy is this working copy, which the run copies
// into the pod. So an expired attach token rotated inside the pod kills the local copy,
// and the copy-back #370 repaired existed only to undo that after the fact.
//
// Both accounts now refuse in the same words, because both have a live copy outside the
// pod: the puppet's is the deployment's custody and the attach account's is this tree.
// hold mode has no gate and needs none. It runs against the one directory that stays
// live, so a refresh there rotates in place.

test('an expired attach token stops the run before it can rotate the chain', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_ATTACH_TOKEN: LAPSED })

  assert.equal(status, 2, output)
  assert.match(output, /attach account bafbi \(6eb73524-ff88-4a62-a8d0-c63905e7afba\)/, 'it names the account: ' + output)
  assert.match(output, /it expired at 2026-01-02T03:04:05\.000Z/, 'and when it expired: ' + output)
  assert.match(output, /status --account bafbi --refresh/, 'and the command that refreshes it here: ' + output)
  assert.match(output, /with --rotate/, 'and the flag that overrides it: ' + output)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is cleaned up')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    { old: true },
    'the local copy is the live one and was not touched'
  )
})

test('a run that rotated nothing leaves the local copy byte-identical, and says so', () => {
  const space = workspace()
  const before = fs.readFileSync(path.join(space.attach, 'live-cache.json'))
  const { status, output, calls } = run(space)

  assert.equal(status, 0, output)
  assert.match(output, /came back unchanged/, 'the run says what it checked: ' + output)
  assert.deepEqual(
    fs.readFileSync(path.join(space.attach, 'live-cache.json')),
    before,
    'nothing was written over the local copy'
  )
  // The fetch is still issued: the run reads the returned directory to compare it (#370).
  const fetched = calls.filter(line => new RegExp('^cp \\S+:\\S*/accounts/' + ATTACH + ' \\S+$').test(line))
  assert.equal(fetched.length, 1, 'the run fetched the attach directory out of the pod: ' + calls.join(' | '))
})

test('a returned attach directory that differs fails the run, and keeps the pod', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_ATTACH_ROTATED: '1' })

  assert.equal(status, 1, 'the rung ran, so this is a failed run and not a refused setup: ' + output)
  assert.match(output, /came back different/, 'the run says what it found: ' + output)
  assert.match(output, /live-cache\.json/, 'and which file differs: ' + output)
  assert.match(output, /with --rotate/, 'and the flag that accepts it: ' + output)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    { old: true },
    'the local copy is not replaced on the path that was meant to leave it alone'
  )
  assert.equal(
    calls.some(line => line.includes('delete pod')),
    false,
    'the pod is kept, because it holds the only live copy: ' + calls.join(' | ')
  )
})

// The gate fails closed, so an account whose cache says nothing about its expiry is refused
// too. The gate this replaced turned that case into a NaN and let the run go on.
test('a token nothing can read is refused rather than guessed at', () => {
  const cases = [
    { KUBECTL_ATTACH_TOKEN: 'unknown|no cached token|' },
    { KUBECTL_ATTACH_TOKEN: 'unknown|no readable expiry|' },
    // The read itself failed, so nothing at all came back.
    { KUBECTL_ATTACH_SILENT: '1' }
  ]
  for (const env of cases) {
    const space = workspace()
    const { status, output, calls } = run(space, env)
    assert.equal(status, 2, JSON.stringify(env) + ': ' + output)
    assert.match(output, /attach account bafbi /, 'it names the account: ' + output)
    assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
  }
})

test('--rotate accepts the rotation, so the refreshed directory comes back', () => {
  const space = workspace()
  const { status, output } = run(space, { KUBECTL_ATTACH_TOKEN: LAPSED, KUBECTL_ATTACH_ROTATED: '1' },
    [...podArgs(space), '--rotate'])

  assert.equal(status, 0, output)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    {},
    'the accepted rotation replaced the local copy, so one live copy remains'
  )
  assert.match(output, /wrote the attach account directory back to /)
})


// --- the reader both gates decide with (#389) --------------------------------
//
// The shim answers the gate's exec, so nothing above ever runs its JavaScript. That is the
// shape #389 is about: a decision nobody exercises. So read the reader out of the script and
// run it here, on fixtures, offline. It is where the margin is kept equal to the login's own.
const TOKEN_JS = (() => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  const block = text.match(/^TOKEN_LEFT_JS=\$\(cat <<'JS'\n([\s\S]*?)\nJS\n\)$/m)
  assert.ok(block, 'the script keeps its token reader in one heredoc named TOKEN_LEFT_JS')
  return block[1]
})()

// One account directory holding one cached token: obtainedOn, then how long it lasts.
function tokenDir ({ expiresIn = 600, leftMs = null } = {}) {
  const dir = tempRoot('monoplayer-token-')
  const obtainedOn = leftMs === null ? Date.now() - 60000 : Date.now() - (expiresIn * 1000 - leftMs)
  fs.writeFileSync(path.join(dir, 'mca-cache.json'), JSON.stringify({ mca: { obtainedOn, expires_in: expiresIn } }))
  return dir
}

const readToken = dir => spawnSync('node', ['-e', TOKEN_JS, dir], { encoding: 'utf8' }).stdout.trim()

test('the reader answers a verdict, the words, and the expiry', () => {
  const [verdict, display, expiry] = readToken(tokenDir({ expiresIn: 3600, leftMs: 3600000 })).split('|')
  assert.equal(verdict, 'ok')
  assert.match(display, /^60 min left$/)
  assert.match(expiry, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'the expiry is a moment a reader can act on: ' + expiry)
})

test('a token inside the login margin is expired, and one outside it is not', () => {
  // prismarine-auth reuses only while "remaining > 1000", so half a second left rotates.
  assert.match(readToken(tokenDir({ expiresIn: 600, leftMs: 500 })), /^expired\|/)
  assert.match(readToken(tokenDir({ expiresIn: 600, leftMs: 1500 })), /^ok\|1 min left\|/, 'and one second of margin reads as a minute, not as a zero')
})

test('a cache with no token and a cache with no expiry are both unknown, never ok', () => {
  const empty = tempRoot('monoplayer-token-')
  assert.equal(readToken(empty), 'unknown|no cached token|')
  const partial = tempRoot('monoplayer-token-')
  fs.writeFileSync(path.join(partial, 'mca-cache.json'), JSON.stringify({ mca: { access_token: 'x' } }))
  assert.equal(readToken(partial), 'unknown|no readable expiry|')
})

test('a stale writer.lock in the local copy is not read as a rotation', () => {
  const space = workspace()
  fs.writeFileSync(path.join(space.attach, 'writer.lock'), '{"pid":1}')
  const { status, output } = run(space)

  assert.equal(status, 0, output)
  assert.ok(fs.existsSync(path.join(space.attach, 'writer.lock')), 'the local lock belongs to this copy, not to the run')
})

test('hold needs no gate: it runs against the one copy that stays live', () => {
  const space = workspace()
  const marker = path.join(space.root, 'held')
  const { status, output } = run(space, { KUBECTL_ATTACH_TOKEN: LAPSED }, ['hold', 'sh', '-c', 'touch ' + marker])

  assert.equal(status, 0, output)
  assert.equal(fs.existsSync(marker), true, 'the command ran')
  assert.doesNotMatch(output, /attach account/, 'the local form asks no expiry question: ' + output)
})

// --- the attach copy-back is not GNU-only (#370) ---

// The copy-back read the returned directory out of `find ... -printf '%h\\n'`. -printf is a
// GNU primary, and BSD find has no such primary: it prints nothing, says so on stderr, and
// exits 1. `from` was then empty, so the copy-back copied nothing.
//
// On macOS the exit status was the assignment's, under this script's `set -euo pipefail`,
// so the run died there with no sentence of its own. The rotation was lost either way: the
// pod is deleted on every path, so the new attach key existed nowhere. A rotation that does
// not come back is a failed rotation, not a warning.
//
// Every workspace's find refuses -printf, so these cases measure both dialects rather than
// only the GNU one this checkout runs.

test('the attach rotation is copied back, and the copy-back is issued (#370)', () => {
  const space = workspace()
  // #370 is about the accepted rotation, which the run only takes with --rotate now (#389).
  const { status, output, calls } = run(space, { KUBECTL_ATTACH_ROTATED: '1' },
    [...podArgs(space), '--rotate'])

  assert.equal(status, 0, output)
  const fetched = calls.filter(line => new RegExp('^cp \\S+:\\S*/accounts/' + ATTACH + ' \\S+$').test(line))
  assert.equal(fetched.length, 1, 'the run fetched the attach directory out of the pod: ' + calls.join(' | '))
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    {},
    'and the rotated copy replaced the local one'
  )
  assert.match(output, /wrote the attach account directory back to /)
})

test('a copy-back that brings nothing back fails the run (#370)', () => {
  const space = workspace({ strictFind: false })
  const { status, output, calls } = run(space, { KUBECTL_ATTACH_BACK_EMPTY: '1' })

  assert.equal(status, 2, output)
  assert.match(output, /no profile\.json/)
  assert.match(output, /A rotation that does not come back is a failed run/)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    { old: true },
    'the local key is left alone rather than replaced from an empty source'
  )
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is still deleted')
})

test('a copy-back kubectl cannot fetch fails the run (#370)', () => {
  const space = workspace({ strictFind: false })
  const { status, output } = run(space, { KUBECTL_ATTACH_BACK_FAIL: '1' })

  assert.equal(status, 2, output)
  assert.match(output, /could not copy the attach account directory back/)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(space.attach, 'live-cache.json'), 'utf8')),
    { old: true },
    'nothing was written from a copy that never arrived'
  )
})

// --- a rung is handed the flags the operator gives it (#384) ------------------

// The pod command was `sh -c "cd /work && node $RUNG $rung_args"`, and rung_args held
// `--report /work/online-report.json` for the online rung and nothing for every other
// module. So a --rung received no flag from the operator. That was harmless until
// src/ladder/capture-config.js refused to run without --paper-build (#367): the recipe
// in its header then produced a refusal instead of a capture.
//
// These cases read the argv the pod is handed, one word per line. Two properties matter
// and `$*` shows neither: a flag and its value arrive as two words, and one word that
// holds a space and a comma arrives as one word.

// The flags of the recipe in the capture-config header, so the case that proves the
// forwarding is the case that proves the recipe. The lane is one a shim can name, and the
// note is this case's own: the header derives the lane and writes a note about the run.
const CAPTURE_ARGS = [
  '--rung', 'src/ladder/capture-config.js', '--keep-pod', '--',
  '--paper-build', '135',
  '--image', 'itzg/minecraft-server:2026.10.1-java25',
  '--lane', 'monoplayer-gate-x',
  // One argument holding a space and a comma. A pod command built by string
  // concatenation splits it, or loses the comma to the pod's shell.
  '--note', 'online-mode is off, the puppet token is lapsed'
]

function argvLog (space) {
  if (!fs.existsSync(space.argv)) return []
  return fs.readFileSync(space.argv, 'utf8').split('\n').filter(Boolean)
}

// The words the pod's own command line was handed, after the shell fragment. Anchored on
// that fragment, so a command line that stops forwarding its arguments fails these cases
// instead of passing them: the shim answers the exec without running the pod's shell, and
// this anchor is the closest the seam gets to the module's argv (#384).
const POD_COMMAND = '<<cd /work && node "$0" "$@">>'

function rungArgv (space, message) {
  const words = argvLog(space)
  const at = words.indexOf(POD_COMMAND)
  assert.notEqual(at, -1, 'the pod was handed the forwarding command line: ' + message)
  const rest = words.slice(at + 1)
  const end = rest.indexOf('<<call>>')
  return end === -1 ? rest : rest.slice(0, end)
}

test('a --rung is handed the flags the operator passes after --', () => {
  const space = workspace()
  const { status, calls, output } = run(space, {}, CAPTURE_ARGS)
  assert.equal(status, 0, 'status ' + status + ' calls: ' + calls.join(' | ') + ' output: ' + output)

  // The whole slice, in order: the module, then each flag as one word with its value as
  // the next. One deepEqual rather than a search, so a flag attached to another kubectl
  // call, a word split in two, or a reordered argv all fail.
  assert.deepEqual(rungArgv(space, calls.join(' | ')), [
    '<<src/ladder/capture-config.js>>',
    '<<--paper-build>>', '<<135>>',
    '<<--image>>', '<<itzg/minecraft-server:2026.10.1-java25>>',
    '<<--lane>>', '<<monoplayer-gate-x>>',
    '<<--note>>', '<<online-mode is off, the puppet token is lapsed>>'
  ])
})

test('an argument with a space and a comma reaches the rung as one word', () => {
  const space = workspace()
  const { calls } = run(space, {}, CAPTURE_ARGS)

  const argv = rungArgv(space, calls.join(' | '))
  assert.deepEqual(argv.slice(-2), ['<<--note>>', '<<online-mode is off, the puppet token is lapsed>>'],
    'a comma-bearing argument is one word, not several, and keeps its comma: ' + argv.join(' '))
})

test('the online rung still copies its report back', () => {
  const space = workspace()
  const { status, calls, output } = run(space)
  assert.equal(status, 0, output)
  assert.ok(
    calls.some(line => line.includes('cp') && line.includes('online-report.json')),
    'the report is copied out of the pod: ' + calls.join(' | ')
  )
  assert.match(output, /report written to/)
})

test('hold takes -- as the delimiter, the way the rung does', () => {
  const space = workspace()
  const { status, output } = run(space, {}, ['hold', '--', 'sh', '-c', 'exit 5'])
  assert.equal(status, 5, output)
})

test('a rung other than the online rung copies no report back', () => {
  const space = workspace()
  const { status, calls, output } = run(space, {}, [
    '--rung', 'src/ladder/capture-config.js', '--keep-pod', '--', '--paper-build', '135'
  ])
  assert.equal(status, 0, 'status ' + status + ' output: ' + output)
  assert.equal(
    calls.some(line => line.includes('cp') && line.includes('online-report.json')), false,
    'a capture writes no online-report.json, so no copy-back of one runs: ' + calls.join(' | ')
  )
})

// --- the backend a run defaults to is the gate lane it was told about (#277) ---

// Before #277 the gate lane was one namespace and the online rung's default backend
// was written out by hand: paper.monoplayer-gate-b.svc.cluster.local. A lane with an
// instance of its own needs that host to follow, or a renamed lane's rung dials the
// default lane while it reads custody from the deployment it was pointed at.

test("the default backend is this worktree's lane when none is named", () => {
  const space = workspace()
  const { calls } = run(space)
  assert.ok(
    calls.some(line => line.includes('MONOPLAYER_BACKEND_HOST=paper.' + LANE + '.svc.cluster.local')),
    "the default dials this worktree's lane: " + calls.join(' | ')
  )
})

test('a renamed gate lane dials its own backend', () => {
  const space = workspace()
  const { calls, output } = run(space, { MONOPLAYER_GATE_NAMESPACE: 'monoplayer-gate-x' })
  const dialled = calls.find(line => line.includes('MONOPLAYER_BACKEND_HOST='))
  assert.ok(dialled, 'the rung was given a backend: ' + calls.join(' | ') + ' output: ' + output)
  assert.match(dialled, /MONOPLAYER_BACKEND_HOST=paper\.monoplayer-gate-x\.svc\.cluster\.local/,
    'the lane named decides the backend, not the lane that shipped: ' + dialled)
  assert.doesNotMatch(dialled, /monoplayer-gate-b/, 'a renamed lane must not dial the default lane: ' + dialled)
  // A lane named by hand is still one lane: the lease a run takes for it says so too.
  assert.ok(leasesWritten(space)[0].spec.holderIdentity.startsWith('monoplayer-gate-x on '),
    'the lease names the lane the backend dials: ' + leasesWritten(space)[0].spec.holderIdentity)
})


// --- the lane named is never the live or dev lane (#277, AGENTS.md) ---

// The default backend is derived from MONOPLAYER_GATE_NAMESPACE now, so the variable
// decides which server this rung dials. AGENTS.md is absolute: no lane script may
// name the live namespace as a target. observer-report.sh already refuses it. This
// one derived a host from it and refused nothing, so a stray variable pointed the
// online rung at the product's own backend.

test('a gate lane naming the live or dev namespace is refused before anything runs', () => {
  for (const namespace of ['monoplayer', 'monoplayer-dev']) {
    const space = workspace()
    const { status, output, calls } = run(space, { MONOPLAYER_GATE_NAMESPACE: namespace })
    assert.equal(status, 2, output)
    assert.match(output, /refusing/)
    assert.equal(
      calls.some(line => line.includes('paper.' + namespace + '.svc.cluster.local')),
      false,
      'refusing "' + namespace + '" dialled it anyway: ' + calls.join(' | ')
    )
  }
})


// --- one lane per run (#301) ---

// The lease holder identity names the lane a run holds the account for (#279). The
// message says which lane the run measures. The default backend was still the lane that
// shipped, so one run named two. The holder said this worktree's lane, and the rung
// dialled `monoplayer-gate-b`, a lane `gate:up` never wakes. The failure then read as a
// dead backend rather than as a wrong name.

test('a default run names one lane in its lease and in the backend it dials', () => {
  const space = workspace()
  const { status, output, calls } = run(space)
  assert.equal(status, 0, output)

  const dialled = calls.find(line => line.includes('MONOPLAYER_BACKEND_HOST='))
  assert.ok(dialled, 'the rung was given a backend: ' + calls.join(' | '))
  assert.match(dialled, new RegExp('MONOPLAYER_BACKEND_HOST=paper\\.' + LANE + '\\.svc\\.cluster\\.local'),
    "the backend is this worktree's lane: " + dialled)

  const taken = leasesWritten(space)[0]
  assert.ok(taken, 'the run took the lease: ' + output)
  assert.ok(taken.spec.holderIdentity.startsWith(LANE + ' on '),
    'the same lane holds the account: ' + taken.spec.holderIdentity)
})

// gate-lane.sh names the lane. When it cannot, it exits non-zero with a sentence a
// reader can act on. This script passes that sentence through instead of swallowing it
// in a command substitution. The reason is what tells a reader how to name a lane by
// hand.
test('a lane that cannot be derived refuses, and keeps the sentence that says how', () => {
  const space = workspace()
  const notGit = tempRoot('monoplayer-not-git-')
  const { status, output, calls } = run(space, { MONOPLAYER_GATE_WORKTREE: notGit })

  assert.equal(status, 2, output)
  assert.match(output, /cannot derive this worktree's lane/)
  assert.match(output, /Set MONOPLAYER_GATE_NAMESPACE to name one by hand/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'nothing dialled: ' + calls.join(' | '))
  assert.deepEqual(leasesWritten(space), [], 'and no lease taken for a lane it could not name')
})

// --- the account lease (#280) -------------------------------------------------
//
// One Minecraft identity is one refresh chain with one writer lock, so two runs that
// use it are unsafe. A run takes a Kubernetes Lease first, names its lane and branch in
// the holder, refuses while another holder has it, and lets an expired one be taken.
// Nothing here reaches a cluster: the shim answers `get lease` from a file and records
// every object the script writes.

const NOW = Date.now()

// A lease another run holds. renewTime in the future is a live holder; a stale one is a
// run that died without releasing it.
function held (spec = {}) {
  return JSON.stringify({
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name: 'monoplayer-online-account', namespace: 'monoplayer', resourceVersion: '7' },
    spec: {
      holderIdentity: 'monoplayer-gate-aaaaaaa-000000 on feat/another (pid 4242)',
      leaseDurationSeconds: 900,
      acquireTime: new Date(NOW - 60000).toISOString(),
      renewTime: new Date(NOW).toISOString(),
      leaseTransitions: 1,
      ...spec
    }
  }, null, 2)
}

// The holder a refusal has to name, as a regex: the lane, the branch, and the pid.
const OTHER_HOLDER = /on feat\/another \(pid 4242\)/

// Every lease object the script wrote, in order: the shim appends each one.
function leasesWritten (space) {
  if (!fs.existsSync(space.leases)) return []
  return fs.readFileSync(space.leases, 'utf8').split(/^---$/m).filter(block => block.trim()).map(block => JSON.parse(block))
}

test('a held lease refuses the run, and names the holder and the expiry', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const { status, output, calls } = run(space)

  assert.equal(status, 2, output)
  assert.match(output, /held by "monoplayer-gate-aaaaaaa-000000 /)
  assert.match(output, OTHER_HOLDER)
  assert.match(output, /until \d{4}-\d{2}-\d{2}T[0-9:.]+Z/)
  assert.match(output, /\([0-9]+m left\)/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
  assert.equal(calls.some(line => line.includes(' apply ')), false, 'no pod was created: ' + calls.join(' | '))
  assert.deepEqual(leasesWritten(space), [], 'a refused run wrote nothing')
})

test('an expired lease is taken without asking', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held({ renewTime: new Date(NOW - 3600000).toISOString() }))
  const { status, output, calls } = run(space)

  assert.equal(status, 0, output)
  const written = leasesWritten(space)
  assert.equal(written.length, 2, 'taken and released: ' + JSON.stringify(written))
  // The branch may be `detached at <sha>`, which has spaces: CI checks out a merge.
  assert.match(written[0].spec.holderIdentity, /^monoplayer-gate-\S+ on .+ \(pid \d+\)$/)
  assert.equal(written[0].spec.leaseTransitions, 2, 'a takeover of a dead holder is a transition')
  assert.equal(written[1].spec.holderIdentity, '', 'released on the way out')
  assert.ok(calls.some(line => line.includes('online.js')), 'the rung ran: ' + calls.join(' | '))
})

test('a lease nobody holds is created, and released with a replace', () => {
  const space = workspace()
  const { status, calls } = run(space)

  assert.equal(status, 0)
  const first = calls.find(line => / (create|replace) -f /.test(line))
  assert.match(first ?? '', / create -f /, 'the first write created the lease: ' + calls.join(' | '))
  assert.equal(leasesWritten(space).length, 2, 'created, then released')
})

test("the holder names this worktree's lane and its branch", () => {
  const space = workspace()
  const { status, output } = run(space)

  assert.equal(status, 0, output)
  const taken = leasesWritten(space)[0]
  assert.ok(
    taken.spec.holderIdentity.startsWith(LANE + ' on ' + BRANCH + ' (pid '),
    'the holder is this run: ' + taken.spec.holderIdentity
  )
  assert.match(taken.spec.holderIdentity, /\(pid \d+\)$/)
})

test('the lease is released when the rung fails, and the exit status survives', () => {
  const space = workspace()
  const { status, calls } = run(space, { KUBECTL_RUN_STATUS: '1' })

  assert.equal(status, 1)
  const written = leasesWritten(space)
  assert.equal(written[written.length - 1].spec.holderIdentity, '', 'released on the failure path')
  assert.ok(calls.some(line => line.includes('delete pod')), 'the pod is still deleted')
})

test('--lease-wait queues behind the holder, then takes the lease when it is free', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const { status, output } = run(space,
    { KUBECTL_LEASE_ONCE: '1', MONOPLAYER_LEASE_POLL: '0' },
    [...podArgs(space), '--lease-wait', '5'])

  assert.equal(status, 0, output)
  assert.match(output, /waiting for the account lease/)
  assert.ok(leasesWritten(space).length >= 2, 'taken after the wait and released')
})

test('a lease that cannot be read refuses the run instead of guessing', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { KUBECTL_LEASE_READ_ERROR: '1' })

  assert.equal(status, 1, output)
  assert.match(output, /cannot read the lease/)
  assert.equal(calls.some(line => line.includes('online.js')), false, 'the rung never ran: ' + calls.join(' | '))
})

test('the lease is never held in a gate lane, which one worktree owns and the reaper deletes', () => {
  const space = workspace()
  const { status, output, calls } = run(space, { MONOPLAYER_CLUSTER_NAMESPACE: 'monoplayer-gate-x' })

  assert.equal(status, 2, output)
  assert.match(output, /refusing to hold the account lease/)
  assert.deepEqual(calls, [], 'nothing reached the cluster')
})

test('hold takes the lease around a command, and gives the command its exit status', () => {
  const space = workspace()
  const { status, output } = run(space, {}, ['hold', 'sh', '-c', 'exit 7'])

  assert.equal(status, 7, output)
  const written = leasesWritten(space)
  assert.equal(written.length, 2, 'taken and released: ' + JSON.stringify(written))
  assert.equal(written[1].spec.holderIdentity, '')
  assert.equal(fs.existsSync(space.manifest), false, 'hold creates no pod: it runs on this machine')
})

test('hold refuses while another run holds the lease, and runs nothing', () => {
  const space = workspace()
  fs.writeFileSync(space.lease, held())
  const marker = path.join(space.root, 'ran')
  const { status, output } = run(space, {}, ['hold', 'sh', '-c', 'touch ' + marker])

  assert.equal(status, 2, output)
  assert.equal(fs.existsSync(marker), false, 'the command never ran')
  assert.match(output, OTHER_HOLDER)
})

test('a run longer than the lease renews it, so a live run keeps the account', () => {
  const space = workspace()
  // Three seconds of lease, an interval of one, and a rung that takes two: the
  // renewal has two chances, and the release still comes last.
  const { status, output } = run(space, {
    MONOPLAYER_LEASE_DURATION: '3',
    KUBECTL_RUN_SLEEP: '2'
  })

  assert.equal(status, 0, output)
  const written = leasesWritten(space)
  assert.ok(written.length >= 3, 'taken, renewed, released: ' + JSON.stringify(written))
  assert.equal(written[0].spec.holderIdentity, written[1].spec.holderIdentity, 'the same run renews its own lease')
  assert.ok(Date.parse(written[1].spec.renewTime) >= Date.parse(written[0].spec.renewTime), 'the renewal moves the clock forward')
  assert.equal(written[written.length - 1].spec.holderIdentity, '')
})

// #355: the renewal loop outlives the run, so a tick that has already passed its `held`
// check can be inside its write when the run releases. A kill does not close that window.
// The write is the tick's own kubectl child, so it lands after the loop is dead. The
// release has to be the last write either way. A renewal that lands after it leaves the
// lease held by a run that has exited, and the next run is refused for the rest of the
// duration.
//
// The case orders the two writes itself, so a script that only hopes for the order fails
// here. The shim holds the renewal inside its write, and the release's own write is what
// lets it go. A script that orders the release instead marks its state directory before it
// waits, and that mark is the signal this case uses.
test('a renewal already inside its write cannot land after the release (#355)', async () => {
  const space = workspace()
  const child = spawn('bash', [SCRIPT, ...podArgs(space)], {
    cwd: space.root,
    stdio: 'ignore',
    env: baseEnv(space, {
      // Three seconds of lease and a renewal every one, with a rung that takes two: one
      // renewal reaches its write before the run ends.
      MONOPLAYER_LEASE_DURATION: '3',
      KUBECTL_RUN_SLEEP: '2',
      KUBECTL_RENEW_BLOCK: '1',
      KUBECTL_RENEW_GO: space.renewGo,
      KUBECTL_RENEW_BLOCKED: space.renewBlocked,
      KUBECTL_RENEW_SETTLED: space.renewSettled
    })
  })
  const closed = new Promise(resolve => child.on('close', resolve))
  const settle = async (file) => {
    for (let i = 0; i < 500; i += 1) {
      if (fs.existsSync(file)) return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return fs.existsSync(file)
  }
  // A marker in the state directory the script keeps beside the lease object, which this
  // case finds through TMPDIR.
  const marked = name => (fs.existsSync(space.tmp) ? fs.readdirSync(space.tmp) : [])
    .map(entry => path.join(space.tmp, entry, name))
    .find(file => fs.existsSync(file))

  assert.ok(await settle(space.renewBlocked), 'the renewal never reached its write: ' +
    JSON.stringify(leasesWritten(space).map(entry => entry.spec.holderIdentity)))

  // The release begins here. A script that orders the release against the renewal marks
  // the state directory before it waits, and that mark lets the held renewal go, so the
  // release follows it. The shim lets a script that does not order them go, by writing the
  // release first and then letting the renewal land.
  for (let i = 0; i < 500 && !fs.existsSync(space.renewGo); i += 1) {
    if (marked('releasing')) fs.writeFileSync(space.renewGo, '')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(fs.existsSync(space.renewGo), 'the release never began: the held renewal was never let go')
  assert.ok(await settle(space.renewSettled), 'the held renewal never wrote')
  let ceiling
  await Promise.race([closed, new Promise(resolve => { ceiling = setTimeout(resolve, 20000) })])
  clearTimeout(ceiling)

  const written = leasesWritten(space)
  const order = written.map((entry, index) => entry.spec.holderIdentity === '' ? index + ' released' : index + ' held')
  assert.equal(
    written[written.length - 1].spec.holderIdentity,
    '',
    'the release is the last lease write, and this run wrote ' + written.length + ': ' + order.join(', ')
  )
})

// The task is where the guarantee is delivered: `mise run online` is the bare rung, and
// it is the form that reads this machine's copy of the chain.
test('mise run online holds the lease, so both forms of the rung exclude each other', () => {
  const tasks = readMiseTasks()
  const online = tasks.get('online')
  assert.match(online.body, /scripts\/online-cluster\.sh hold/, 'the bare rung holds the lease: ' + online.body)
  assert.match(online.body, /node src\/ladder\/online\.js/, 'and still runs the rung: ' + online.body)
  assert.deepEqual(online.depends, ['install'])
  assert.deepEqual(online.wait_for, ['check'], 'a red gate still stops the expensive rung')
  assert.match(tasks.get('online:cluster').body, /^run = "scripts\/online-cluster\.sh"$/m)
  // #389: the description is where an operator learns that neither account rotates by
  // default, and which flag accepts one.
  const description = tasks.get('online:cluster').description
  assert.match(description, /refuses .*expired/, 'the description names the refusal: ' + description)
  assert.match(description, /--rotate/, 'and the flag that accepts the rotation: ' + description)
})

// A run killed outright runs no EXIT handler. The renewal loop is the only thing left
// that can notice, and it must not keep renewing an account nobody is using.
test('a run killed with SIGKILL releases its lease instead of renewing for ever', async () => {
  const space = workspace()
  const child = spawn('bash', [SCRIPT, ...podArgs(space)], {
    cwd: space.root,
    stdio: 'ignore',
    env: baseEnv(space, {
      // A lease of three seconds, renewed every one, and a rung that never ends on its
      // own.
      MONOPLAYER_LEASE_DURATION: '3',
      KUBECTL_RUN_SLEEP: '30'
    })
  })

  const held = async () => {
    for (let i = 0; i < 120; i += 1) {
      const written = leasesWritten(space)
      if (written.length > 0 && written[written.length - 1].spec.holderIdentity === '' ) return written
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return leasesWritten(space)
  }
  // Wait for the renewal loop to tick, not merely for the lease to be written. The run
  // writes the lease and then starts the loop, so a kill in between leaves nothing to
  // release and the lease only expires: that is the product's fallback for a run killed
  // outright, and it is not what this case measures. One renewal stamps the same holder
  // with a new renewTime, which is proof the loop exists.
  for (let i = 0; i < 200 && leasesWritten(space).length < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(leasesWritten(space).length >= 2, 'the renewal loop ticked before the run was killed')
  child.kill('SIGKILL')

  const written = await held()
  assert.equal(
    written[written.length - 1].spec.holderIdentity,
    '',
    'the lease was released by the loop that outlived the run: ' + JSON.stringify(written)
  )
})

// The other half of exclusivity: a run that loses the lease must stop. If it carried
// on, it would write the refresh chain beside the run that now holds the lease.
test('a run whose lease is taken over stops instead of writing the chain twice', () => {
  const space = workspace()
  fs.writeFileSync(space.foreign, held({ holderIdentity: 'monoplayer-gate-zzzzzzz-111111 on feat/other (pid 7)' }))
  const { status, output } = run(space, {
    // One second of lease, a rung that would run for six, and a holder who takes the
    // lease after this run's own acquisition read.
    MONOPLAYER_LEASE_DURATION: '3',
    KUBECTL_RUN_SLEEP: '6',
    KUBECTL_LEASE_FOREIGN_AFTER: '1'
  })

  assert.notEqual(status, 0, output)
  assert.match(output, /is no longer this run's/)
  assert.match(output, /Stopping, because two runs must not write one refresh chain/)
})

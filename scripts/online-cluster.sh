#!/usr/bin/env bash
# Run the online rung against a cluster backend from a throwaway pod, or run any
# command that needs the real account while holding the account lease.
#
#   scripts/online-cluster.sh [--backend-host H] [--backend-port P]
#                             [--rung FILE] [--report PATH] [--rotate] [--keep-pod]
#                             [--lease-wait SECONDS] [--lease-duration SECONDS]
#                             [-- ARG...]
#   scripts/online-cluster.sh hold [--lease-wait SECONDS] [--lease-duration SECONDS]
#                             [--] CMD [ARG...]
#
# `--rung` runs another ladder module in the same pod instead of the online
# rung, which is how the observer report gets its direct baseline join
# (scripts/observer-report.sh). The custody handling, the token expiry refusal,
# and the pod lifecycle are identical; only the module differs. A rung other
# than online.js writes no report, so the report copy-back is skipped.
#
# Everything after `--` is the rung's own argv, so a module that needs a flag gets one:
#
#   scripts/online-cluster.sh --rung <module> --keep-pod -- --some-flag <value>
#
# src/ladder/capture-config.js's header carries the worked recipe, with the build, the
# image and the lane that capture needs.
#
# Each argument reaches the module as one word, whatever it holds, because the pod runs
# the module from an argv and not from a string a shell splits again. The online rung's
# own `--report /work/online-report.json` comes first and this script copies that path
# back, so a `--report` of yours is ignored: the first one wins.
#
# `hold` is the same guarantee without the pod: it takes the account lease, runs
# the command on this machine, and releases the lease however that ends. That is
# how `mise run online` holds the account (mise.toml), so the two forms of one
# rung exclude each other.
#
# Why a pod: the puppet's live refresh token belongs to the copy the deployment
# holds (docs/custody.md#sessions-copies-and-refreshes). A laptop copy is stale,
# and a stale copy cannot refresh. So the rung runs where the token is, and the
# token never leaves the cluster.
#
# Why no downtime: the deployment keeps serving. This script never scales,
# patches, or restarts it. The pod mounts the custody volume read-only, copies
# the puppet's directory into its own empty directory, and runs from there. A
# second session on one account is fine, and so is a second server: sessions are
# not exclusive, only a *refresh* from two copies is.
#
# What it refuses: an access token that has expired, for either account. Reusing a
# valid cached Minecraft access token rotates nothing, which is why the default path
# cannot disturb a copy of an account that lives outside this pod. Once the token
# expires, a login in the pod refreshes it and rotates the chain: the copy that
# refreshed last is live and every other copy is dead (docs/custody.md). That is a
# decision, not a default, so the script stops and says what to do instead.
#
# Both accounts are gated, because both have a live copy outside the pod. The puppet's
# is the deployment's custody, and an expired one would rotate the chain away from the
# live proxy. The attach account (Bafbi) lives in the working copy: it is copied in for
# the run, and a rotation inside the pod would leave the local copy dead.
#
# `--rotate` accepts that trade for either account: it copies the refreshed directories
# back, and for the puppet that means writing the volume and restarting the deployment,
# which then reads them.
#
# Without `--rotate` the attach directory the pod hands back has to be the one it was
# given, byte for byte. A difference fails the run and keeps the pod, which holds the
# only live copy: copying it back unasked is the silent repair #389 removed.
#
# The account lease (#280): one Minecraft identity is one refresh chain with one
# writer lock, and no namespace gives you a second. So a run that uses the real
# account takes a Kubernetes Lease first and holds it until it exits, renewed
# while the run lasts. The holder names its lane and its branch, so a refusal
# reads as a person's run and not as a hash. A second run waits if it was told to
# wait, and otherwise stops and says who holds the account and until when. The
# lease expires, so a run that is killed outright cannot hold the account for
# ever, and an expired lease is taken without asking.
#
# The lease lives in the namespace that holds the custody, and never in a gate
# lane: a lane belongs to one worktree, so a lease there is invisible to the next
# worktree, and the reaper deletes an idle lane and the lease with it. The live
# namespace is where the account is and is never reaped. A Lease is not a
# workload, so nothing here scales, patches or restarts anything to hold one.
#
# Environment:
#   MONOPLAYER_CLUSTER_NAMESPACE   namespace            (default monoplayer)
#   MONOPLAYER_DEPLOYMENT          deployment to read    (default monoplayer)
#   MONOPLAYER_GATE_NAMESPACE      the gate lane        (default: this worktree's
#                                                        lane, from scripts/gate-lane.sh
#                                                        name), which the default backend
#                                                        host and the lease both name (#301)
#   MONOPLAYER_BACKEND_HOST        backend host         (default this lane's Paper)
#   MONOPLAYER_BACKEND_PORT        backend port         (default 25565)
#   MONOPLAYER_FRONT_HOST          proxy front host     (passed to the rung, empty by default)
#   MONOPLAYER_FRONT_PORT          proxy front port     (passed to the rung, empty by default)
#   MONOPLAYER_VERSION             protocol version     (passed to the rung, empty by default)
#   MONOPLAYER_SECRETS_SOURCE      local secrets        (default ./.secrets)
#   MONOPLAYER_LEASE_NAME          the account lease    (default monoplayer-online-account)
#   MONOPLAYER_LEASE_DURATION      seconds a held lease runs for before it expires,
#                                                        renewed while the run goes (default 900)
#   MONOPLAYER_LEASE_WAIT          seconds to queue behind a holder (default 0: refuse)
#   MONOPLAYER_LEASE_POLL          seconds between queue checks (default 5)
#
# Exit codes: 0 the rung passed or was honestly not_observed, 1 it failed,
# 2 setup refused or incomplete. The pod is deleted and the lease released on
# every path.
#
# Runs on a macOS checkout as well as on a Linux one. The one /proc read falls back to
# kill -0, and the script reads no directory with a GNU-only find primary.
set -euo pipefail

NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
DEPLOYMENT=${MONOPLAYER_DEPLOYMENT:-monoplayer}
# The gate lane this run measures, which is not where the pod runs: NAMESPACE above
# is the live lane holding the custody the rung reads. Both are filled in below, after
# ROOT is known, from the one lane the run names (#301).
GATE_NAMESPACE=''
BACKEND_HOST=${MONOPLAYER_BACKEND_HOST:-}
BACKEND_PORT=${MONOPLAYER_BACKEND_PORT:-25565}
SECRETS=${MONOPLAYER_SECRETS_SOURCE:-.secrets}
ATTACH_ALIAS=${MONOPLAYER_ATTACH_ACCOUNT:-bafbi}
RUNG=${MONOPLAYER_RUNG:-src/ladder/online.js}
ROTATE=0
KEEP_POD=0
REPORT=
# The account lease (#280). The duration is how long a run that is killed outright can
# keep the account, and it is renewed every third of it while the run lasts, so a slow
# kubectl is not a lost account.
LEASE_NAME=${MONOPLAYER_LEASE_NAME:-monoplayer-online-account}
LEASE_DURATION=${MONOPLAYER_LEASE_DURATION:-900}
LEASE_WAIT=${MONOPLAYER_LEASE_WAIT:-0}
LEASE_POLL=${MONOPLAYER_LEASE_POLL:-5}
LEASE_RENEW_INTERVAL=0
# How often the release re-reads the marker a renewal in flight clears. It is not a delay:
# the wait ends when that write lands, and it is bounded by one kubectl call.
LEASE_TICK_POLL=0.05
LEASE_HELD=''
LEASE_HOLDER=''
LEASE_JSON=''
LEASE_ACTION=''
LEASE_DETAIL=''
LEASE_OTHER=''
LEASE_EXPIRY=''
LEASE_LEFT=''
LEASE_RENEW_PID=''
LEASE_STATE=''
LEASE_WRITE=''
# hold: run a command here while holding the lease. Everything after the flags is
# that command, so the loop below stops at the first argument it does not know.
HOLD=0
HOLD_COMMAND=()
# The rung's own argv, from everything after `--` (#384). Kept as an array, because a
# flag is one word however it is spelled: a note with a space and a comma in it stays
# one argument all the way to the module.
RUNG_ARGS=()

die() { printf 'online-cluster: %s\n' "$1" >&2; exit "${2:-2}"; }
say() { printf 'online-cluster: %s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backend-host) BACKEND_HOST=${2:?--backend-host needs a value}; shift 2 ;;
    --backend-port) BACKEND_PORT=${2:?--backend-port needs a value}; shift 2 ;;
    --rung) RUNG=${2:?--rung needs a value}; shift 2 ;;
    --report) REPORT=${2:?--report needs a value}; shift 2 ;;
    --rotate) ROTATE=1; shift ;;
    --keep-pod) KEEP_POD=1; shift ;;
    --lease-wait) LEASE_WAIT=${2:?--lease-wait needs a value}; shift 2 ;;
    --lease-duration) LEASE_DURATION=${2:?--lease-duration needs a value}; shift 2 ;;
    --lease-poll) LEASE_POLL=${2:?--lease-poll needs a value}; shift 2 ;;
    hold) HOLD=1; shift ;;
    --)
      # Everything after this is the rung's, the way `mise run loopback -- --verbose`
      # reaches the rung it names (#320).
      shift
      # `hold -- CMD` says the same thing the other form does, so one file keeps one
      # rule for the token.
      if [ "$HOLD" = 1 ]; then HOLD_COMMAND=("$@"); break; fi
      RUNG_ARGS=("$@")
      break ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *)
      # In hold mode the first argument this loop does not know is the command, and
      # everything after it belongs to that command.
      if [ "$HOLD" = 1 ]; then HOLD_COMMAND=("$@"); break; fi
      die "unknown argument: $1" 2 ;;
  esac
done

command -v kubectl >/dev/null || die 'kubectl is not on PATH'
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# --- the one lane this run names (#301) ---------------------------------------
#
# The lane is the run's identity in the account lease. It is also the Paper the run
# dials. Both read the value below, so the two cannot disagree. They did once. The lease
# holder named this worktree's lane (#279). The backend defaulted to the lane that
# shipped, which `gate:up` never woke (#301).
#
# gate-lane.sh owns the name, so nothing here spells one. It derives the lane from this
# worktree: monoplayer-gate-<commit>-<path hash>. It honours MONOPLAYER_GATE_NAMESPACE
# when an operator names a lane by hand, and it refuses a name that is not a lane. Its
# refusal is this run's too. The sentence reaches the reader as it is written, because a
# command substitution captures stdout and that message is on stderr. A refusal here
# costs no cluster call.
#
# A validation run only ever measures a lane this repo deploys (AGENTS.md). The product
# and the dev lane are never a gate lane. That is checked before the derivation, so the
# refusal is this script's sentence and not gate-lane.sh's. gate-lane.sh's rule is about
# the lanes it scales and deletes.
NAMED_LANE=${MONOPLAYER_GATE_NAMESPACE:-}
if [ "$NAMED_LANE" = monoplayer ] || [ "$NAMED_LANE" = monoplayer-dev ] ||
  { [ -n "$NAMED_LANE" ] && [ "$NAMED_LANE" = "$NAMESPACE" ]; }; then
  die "refusing \"${NAMED_LANE}\" as the gate lane: a validation run only ever measures a lane this repo deploys, and that name is the live or the dev lane" 2
fi
GATE_NAMESPACE=$(bash "$ROOT/scripts/gate-lane.sh" name) ||
  die 'cannot name the lane this run measures and holds the account for: scripts/gate-lane.sh name failed above, and a run that cannot name its lane would dial a backend nobody can say is its own' 2
#
# MONOPLAYER_BACKEND_HOST and --backend-host are the caller's override, not a second
# lane. A run handed one dials where it was told. The lease still names the lane this
# worktree measures. scripts/observer-report.sh derives that host from its own lane.
[ -n "$BACKEND_HOST" ] || BACKEND_HOST=paper.$GATE_NAMESPACE.svc.cluster.local

# --- the account lease (#280) -------------------------------------------------
#
# One run uses the account at a time. The lease is a Kubernetes Lease, because the
# two forms of this rung run in places that cannot see each other's files: the pod
# copies its custody into its own directory and removes the copy's writer lock, so
# the custody's own lock says nothing about a second run, and two worktrees symlink
# the same .secrets as two lanes. The lease is the one record both can read, and the
# cluster is the one thing both already talk to.

lease_ns () { printf '%s' "$NAMESPACE"; }

# A lease inside a gate lane is invisible to the next worktree and dies with the
# lane, so the lease lives where the custody does: the namespace no run may scale,
# patch or delete, which is why a Lease object there is not a touch on the product.
guard_lease_namespace () {
  local ns=$1
  [ -n "$ns" ] || die 'no namespace for the account lease: MONOPLAYER_CLUSTER_NAMESPACE is empty, and the lease lives where the custody does' 2
  case "$ns" in
    *-gate-*)
      die "refusing to hold the account lease in \"$ns\": a gate lane belongs to one worktree, so the next worktree could not see the lease, and the reaper deletes an idle lane and the lease with it. The lease lives in \"$NAMESPACE\", where the custody is" 2 ;;
  esac
}

lease_check_numbers () {
  case "$LEASE_DURATION" in ''|*[!0-9]*) die "MONOPLAYER_LEASE_DURATION \"$LEASE_DURATION\" is not a whole number of seconds" 2 ;; esac
  case "$LEASE_WAIT" in ''|*[!0-9]*) die "MONOPLAYER_LEASE_WAIT \"$LEASE_WAIT\" is not a whole number of seconds" 2 ;; esac
  case "$LEASE_POLL" in ''|*[!0-9]*) die "MONOPLAYER_LEASE_POLL \"$LEASE_POLL\" is not a whole number of seconds" 2 ;; esac
  [ "$LEASE_DURATION" -ge 1 ] ||
    die 'MONOPLAYER_LEASE_DURATION is 0 seconds, and a lease that expires as it is taken holds nothing' 2
  LEASE_RENEW_INTERVAL=$((LEASE_DURATION / 3))
  [ "$LEASE_RENEW_INTERVAL" -ge 1 ] || LEASE_RENEW_INTERVAL=1
}

# Who holds the account, in words a person reads: the lane this run measures, the branch
# it is on, and the pid. The lane is this worktree's unless an operator named one (#279,
# #301). The pid keeps two runs in one worktree from reading each other's holder identity
# as their own. The lane tells the next reader whose run they are waiting for.
lease_holder () {
  local branch text
  branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) || branch=''
  if [ -z "$branch" ] || [ "$branch" = HEAD ]; then
    branch="detached at $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf 'an unknown commit')"
  fi
  # 128 is what a holder identity is read at; anything longer is a hash nobody reads.
  text=$(printf '%s on %s (pid %s)' "$GATE_NAMESPACE" "$branch" "$$")
  printf '%s' "${text:0:128}"
}

# The lease as it is, or nothing when there is none. A read that fails for any other
# reason is not an absence: a run that cannot tell whether the account is taken does
# not start (strict), and one that is already ending says so and leaves the lease to
# expire (lenient). That is the rule gate-lane.sh states for an unreadable lane, and
# it is why the error comes from one read rather than from a second call: a lease that
# changed between two calls would be read two ways.
lease_load () {
  local level=${1:-strict} out err
  LEASE_JSON=''
  if out=$(kubectl -n "$(lease_ns)" get lease "$LEASE_NAME" -o json 2>"$LEASE_STATE/read.err"); then
    LEASE_JSON=$out
    return 0
  fi
  err=$(cat "$LEASE_STATE/read.err")
  case "$err" in *NotFound*) return 0 ;; esac
  err=${err%%$'\n'*}
  if [ "$level" = lenient ]; then
    say "cannot read the lease $(lease_ns)/$LEASE_NAME: $err"
    return 1
  fi
  die "cannot read the lease $(lease_ns)/$LEASE_NAME, so this run cannot tell whether the account is taken: $err" 1
}
# The decision, and the object to write when there is one. node owns the clock: a
# Lease's times are RFC3339 and bash has no parser for them, so one clock decides
# expiry here and on every other machine.
LEASE_JS=$(cat <<'JS'
const fs = require('node:fs')

const [mode, holder, durationArg] = process.argv.slice(1)
const duration = Number(durationArg)
const name = process.env.LEASE_NAME
const namespace = process.env.LEASE_NAMESPACE
const raw = fs.readFileSync(0, 'utf8').trim()
const existing = raw ? JSON.parse(raw) : null
const now = Date.now()

// What a Lease holds: RFC3339 with six fractional digits. A millisecond ISO string
// parses the same way, so this only makes the object look like every other Lease.
const stamp = ms => new Date(ms).toISOString().slice(0, 19) + '.000000Z'
const at = value => {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : NaN
}

const spec = existing === null ? {} : existing.spec ?? {}
const current = spec.holderIdentity ?? ''
const span = Number(spec.leaseDurationSeconds ?? 0) || duration
const expiry = at(spec.renewTime ?? spec.acquireTime) + span * 1000
// A holder whose clock nothing can read counts as expired: the alternative is a lease
// that blocks the account for ever because one field is malformed.
const expired = !Number.isFinite(expiry) || expiry <= now
const mine = current === holder
const free = current === '' || mine || expired
const left = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 1000)) : 0
const when = Number.isFinite(expiry) ? new Date(expiry).toISOString() : 'an unreadable time'

const object = next => ({
  apiVersion: 'coordination.k8s.io/v1',
  kind: 'Lease',
  metadata: {
    name,
    namespace,
    ...(existing?.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {})
  },
  spec: next
})

// One line on stdout and no more: the action, then the three fields a refusal or a
// lost lease needs, pipe-separated. bash reads one line and never parses JSON, and a
// command substitution cannot eat a field the way it eats a trailing newline.
const write = (action, next) => {
  fs.writeFileSync(process.env.LEASE_WRITE_FILE, JSON.stringify(object(next), null, 2) + '\n')
  process.stdout.write([action, '', '', ''].join('|') + '\n')
  process.exit(0)
}
const verdict = (action, fields = ['', '', '']) => {
  process.stdout.write([action, ...fields].join('|') + '\n')
  process.exit(0)
}
const held = () => [current, when, String(left)]

if (mode === 'acquire') {
  if (existing === null) {
    write('create', {
      holderIdentity: holder,
      leaseDurationSeconds: duration,
      acquireTime: stamp(now),
      renewTime: stamp(now),
      leaseTransitions: 0
    })
  }
  if (free) {
    // A takeover of somebody else's lease is a transition; taking back an empty one
    // is not, and neither is renewing this holder's own.
    const takeover = current !== '' && !mine
    write('replace', {
      holderIdentity: holder,
      leaseDurationSeconds: duration,
      acquireTime: mine ? spec.acquireTime ?? stamp(now) : stamp(now),
      renewTime: stamp(now),
      leaseTransitions: Number(spec.leaseTransitions ?? 0) + (takeover ? 1 : 0)
    })
  }
  verdict('refuse', held())
}

if (mode === 'renew') {
  if (existing === null || !mine) verdict('lost', held())
  write('replace', {
    holderIdentity: holder,
    leaseDurationSeconds: duration,
    acquireTime: spec.acquireTime ?? stamp(now),
    renewTime: stamp(now),
    leaseTransitions: Number(spec.leaseTransitions ?? 0)
  })
}

if (mode === 'release') {
  if (existing === null) verdict('skip')
  if (!mine) verdict('skip', held())
  // An empty holder identity is a lease nobody holds, which is what a released lease
  // is. The object stays: it is the record of who used the account last.
  write('replace', {
    holderIdentity: '',
    leaseDurationSeconds: duration,
    leaseTransitions: Number(spec.leaseTransitions ?? 0)
  })
}

verdict('error')
JS
)

lease_decide () {   # $1 = acquire|renew|release
  local decision
  decision=$(printf '%s' "$LEASE_JSON" |
    LEASE_NAME="$LEASE_NAME" LEASE_NAMESPACE="$(lease_ns)" LEASE_WRITE_FILE="$LEASE_WRITE" \
      node -e "$LEASE_JS" "$1" "$LEASE_HOLDER" "$LEASE_DURATION") ||
    die "the lease decision for $(lease_ns)/$LEASE_NAME failed: node exited without answering, so nothing is assumed about who holds the account" 1
  LEASE_ACTION=''
  LEASE_OTHER=''
  LEASE_EXPIRY=''
  LEASE_LEFT=''
  IFS='|' read -r LEASE_ACTION LEASE_OTHER LEASE_EXPIRY LEASE_LEFT <<<"$decision"
}

human_left () {
  local seconds=${1:-0}
  case "$seconds" in ''|*[!0-9]*) printf 'an unknown time'; return 0 ;; esac
  if [ "$seconds" -lt 90 ]; then printf '%ds' "$seconds"
  elif [ "$seconds" -lt 5400 ]; then printf '%dm' $(((seconds + 59) / 60))
  else printf '%dh' $(((seconds + 3599) / 3600))
  fi
}

lease_refusal () {
  printf 'the account lease %s/%s is held by "%s" until %s (%s left). One run uses the refresh chain at a time, so this one does not start: wait for that lease to expire, or pass --lease-wait SECONDS to queue behind it' \
    "$(lease_ns)" "$LEASE_NAME" "$LEASE_OTHER" "$LEASE_EXPIRY" "$(human_left "$LEASE_LEFT")"
}

# create or replace, and a conflict is not a failure: another run reached the lease
# between this run's read and write, so the caller reads again. Anything else is a
# permission this run does not have, and the message names it and what it is for.
lease_write () {   # $1 = create|replace
  local err
  if kubectl -n "$(lease_ns)" "$1" -f "$LEASE_WRITE" >/dev/null 2>"$LEASE_STATE/write.err"; then
    return 0
  fi
  err=$(cat "$LEASE_STATE/write.err")
  case "$err" in
    *AlreadyExists*|*Conflict*|*"object has been modified"*) return 1 ;;
  esac
  die "cannot ${1} the lease $(lease_ns)/$LEASE_NAME: ${err%%$'\n'*}
That lease needs get, create and replace on coordination.k8s.io/leases in $(lease_ns). That is the same cluster and the same credential the pod and the custody are read with, so a refusal here is a role narrower than this rung needs. Without it the run cannot promise the account is its own, so it does not start." 1
}

lease_acquire () {
  local attempts=0 deadline=0
  lease_check_numbers
  guard_lease_namespace "$(lease_ns)"
  [ -n "$LEASE_HOLDER" ] || LEASE_HOLDER=$(lease_holder)
  [ "$LEASE_WAIT" = 0 ] || deadline=$(( $(date +%s) + LEASE_WAIT ))
  while : ; do
    lease_load strict
    lease_decide acquire
    case "$LEASE_ACTION" in
      create|replace)
        if lease_write "$LEASE_ACTION"; then
          LEASE_HELD=1
          : >"$LEASE_STATE/held"
          say "holding the account lease $(lease_ns)/$LEASE_NAME as \"$LEASE_HOLDER\" for ${LEASE_DURATION}s, renewed every ${LEASE_RENEW_INTERVAL}s until this run ends"
          # Its output goes to a file: the loop outlives a kill for as long as its
          # sleep runs, and a process holding this script's stdout would keep a
          # caller's pipe open after the run ended. on_exit prints the file.
          lease_renew_loop </dev/null >>"$LEASE_STATE/renew.log" 2>&1 &
          LEASE_RENEW_PID=$!
          return 0
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 5 ]; then
          die "the lease $(lease_ns)/$LEASE_NAME changed five times while this run tried to take it: another run is taking it at the same moment, and neither of them should go on guessing" 1
        fi ;;
      refuse)
        if [ "$LEASE_WAIT" != 0 ] && [ "$(date +%s)" -lt "$deadline" ]; then
          say "waiting for the account lease: \"$LEASE_OTHER\" holds it until $LEASE_EXPIRY ($(human_left "$LEASE_LEFT") left). This run queued for up to ${LEASE_WAIT}s"
          sleep "$LEASE_POLL"
          continue
        fi
        die "$(lease_refusal)" 2 ;;
      *) die "the lease decision answered \"$LEASE_ACTION\", which this script does not know, so nothing is assumed about who holds the account" 1 ;;
    esac
  done
}

# --- ordering the release after the renewal (#355) ----------------------------
#
# The renewal loop outlives the run, so a tick can be inside its write when the run
# releases. Killing the loop does not stop that write. The write is the tick's own kubectl
# child, so it lands after the loop is dead. Removing `held` stops the next tick and says
# nothing about the tick that is already writing. Two markers in the state directory say
# which is which:
#
#   releasing   the release has started: a tick that sees it writes nothing
#   tick        a renewal is inside its write: the release waits for that write
#
# The release marks, then waits, then writes. The tick marks, checks, writes, unmarks.
# Whichever of the two runs first, the release writes last. Either the tick saw `releasing`
# and wrote nothing, or the release saw `tick` and waited for that write to land.
lease_releasing () { [ -e "$LEASE_STATE/releasing" ]; }
lease_tick_begin () { : >"$LEASE_STATE/tick"; }
lease_tick_end () { rm -f "$LEASE_STATE/tick"; }

# A condition wait, not a delay. What it waits for is one read, one decision and one
# write, and the wait ends when that write lands. It assumes kubectl returns, as every
# other lease call here does. A lease that is never released expires instead.
lease_wait_tick () {
  [ -e "$LEASE_STATE/tick" ] || return 0
  while [ -e "$LEASE_STATE/tick" ]; do sleep "$LEASE_TICK_POLL"; done
  return 0
}

# One renewal, inside the marker the release waits on. The marker covers the write and
# nothing else. The tick creates it before the release-in-progress check and removes it
# after the write, so a release that finds the marker waits for that one write.
lease_renew_once () {
  local status=0
  lease_tick_begin
  lease_renew_tick || status=$?
  lease_tick_end
  return "$status"
}

# The renewal itself. A read or a write that failed is a tick to skip, not a lost lease:
# the account is only in danger once another run holds the lease.
lease_renew_tick () {
  lease_load lenient || return 0
  lease_decide renew
  case "$LEASE_ACTION" in
    replace)
      # The release sets this before it waits for the marker above. A tick that finds it
      # has nothing to add, because the release writes last.
      if lease_releasing; then
        say "the account lease $(lease_ns)/$LEASE_NAME is being released, so this renewal was dropped"
        return 0
      fi
      lease_write replace || return 0 ;;
    lost)
      # Another run has the account now. Two runs on one refresh chain is the thing the
      # lease exists to prevent, so this one stops instead of going on as a second writer.
      LEASE_HELD=''
      rm -f "$LEASE_STATE/held"
      say "the account lease $(lease_ns)/$LEASE_NAME is no longer this run's: \"${LEASE_OTHER:-nobody}\" holds it. Stopping, because two runs must not write one refresh chain"
      return 1 ;;
    *) say "the renewal decision answered \"$LEASE_ACTION\", so this tick was skipped"; return 0 ;;
  esac
}

# Whether the run this loop belongs to is gone. kill -0 is not enough on Linux: a
# process whose parent was killed with SIGKILL stays a zombie until something reaps
# it, and kill -0 still finds it. /proc reports the state. A machine without /proc
# falls back to kill -0, which is what macOS and a terminal's own shell need anyway.
parent_gone () {
  local pid=$1 state
  if [ -r "/proc/$pid/stat" ]; then
    state=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $1}') || state=''
    case "$state" in ''|Z) return 0 ;; esac
    return 1
  fi
  ! kill -0 "$pid" 2>/dev/null
}

# The loop outlives the run, because it must. Three ways out: the run released the
# lease, the run is gone without running its EXIT trap (SIGKILL), or another run has
# taken the lease, which ends the run.
lease_renew_loop () {
  local parent=$$
  # A tick's marker must not outlive this loop, or a release waits for a tick that has
  # already ended. This runs when the loop leaves for any reason of its own, including a
  # read that stops it.
  trap 'rm -f "$LEASE_STATE/tick"' EXIT
  while [ -f "$LEASE_STATE/held" ]; do
    sleep "$LEASE_RENEW_INTERVAL" || exit 0
    if parent_gone "$parent"; then
      LEASE_RENEW_PID=''
      lease_release
      exit 0
    fi
    [ -f "$LEASE_STATE/held" ] || exit 0
    if ! lease_renew_once; then
      # A run that carries on here is a second writer on one refresh chain.
      kill -TERM "$parent" 2>/dev/null || true
      exit 0
    fi
  done
}

# Released on every path, and only by the run that took it: a run whose lease expired
# and was taken by another leaves that one alone. The release is written after the last
# renewal, never before it.
lease_release () {
  [ -n "$LEASE_HELD" ] || return 0
  LEASE_HELD=''
  # The release is the last write. These five steps are the order (#355):
  #
  #   1. `releasing` stops a tick that has not written yet, so it drops its write.
  #   2. removing `held` stops the next tick from starting.
  #   3. the release waits for the tick that is already inside its write, so that write
  #      lands first. A kill at step 4 cannot close this window. The write belongs to the
  #      tick's kubectl, which outlives the loop.
  #   4. the release stops the loop, now that nothing is in flight and no tick can start.
  #   5. the release writes.
  #
  # The other order, kill then write, is the race this replaced. The kill reaches the loop,
  # and the loop's kubectl writes after the release. The lease then names a run that has
  # exited, and the next run is refused for the rest of the duration.
  [ -z "$LEASE_STATE" ] || : >"$LEASE_STATE/releasing"
  [ -z "$LEASE_STATE" ] || rm -f "$LEASE_STATE/held"
  [ -z "$LEASE_STATE" ] || lease_wait_tick
  [ -z "$LEASE_RENEW_PID" ] || kill "$LEASE_RENEW_PID" 2>/dev/null || true
  LEASE_RENEW_PID=''
  lease_load lenient || return 0
  lease_decide release
  case "$LEASE_ACTION" in
    replace)
      if lease_write replace; then
        say "released the account lease $(lease_ns)/$LEASE_NAME"
      else
        say "the account lease $(lease_ns)/$LEASE_NAME changed while this run released it, so it was not released: it expires on its own"
      fi ;;
    skip)
      [ -z "$LEASE_OTHER" ] || say "the account lease $(lease_ns)/$LEASE_NAME is no longer this run's, because \"$LEASE_OTHER\" holds it: nothing was released" ;;
    *) say "the release decision answered \"$LEASE_ACTION\", so the lease is left to expire" ;;
  esac
}

# --- the expiry gate, one rule for both accounts (#389) -----------------------
#
# A cached Minecraft access token is good for about a day. While it is valid, a login
# reuses it and rotates nothing, so a run cannot disturb a copy of an account that lives
# elsewhere. Once it has expired, the login refreshes it: the chain rotates, the copy that
# refreshed last is live, and every other copy is dead until a device-code bootstrap
# (docs/custody.md, "One live copy per account").
#
# One reader for both accounts, because two accounts with two gates is how they drift into
# two spellings of one refusal. The arithmetic is the projection src/custody/status.js
# carries for the heartbeat (#229). Reading it there instead would put a module import and
# its failure mode in front of the gate; see the backlog rather than a second copy here.
TOKEN_LEFT_JS=$(cat <<'JS'
const fs = require('node:fs')

const dir = process.argv[1]
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const token = read(dir + '/mca-cache.json')?.mca
const obtainedOn = typeof token?.obtainedOn === 'number' ? token.obtainedOn : null
const expiresIn = typeof token?.expires_in === 'number' ? token.expires_in * 1000 : null
const unknown = obtainedOn === null || expiresIn === null
const expiry = unknown ? '' : new Date(obtainedOn + expiresIn).toISOString()
// Three fields: the verdict the gate switches on, the words to show, and the moment the
// token expires. The verdict is separate so that rewording the display cannot turn a pass
// into a refusal. A token nothing can read has no verdict of its own: guessing that it is
// fine is how a rotation happens behind the gate.
//
// The second of margin is the margin the login itself applies: prismarine-auth's
// MinecraftJavaTokenManager reuses a cached token only while "remaining > 1000". A token
// inside that margin is refreshed, and a refresh is the rotation this gate decides.
// test/tooling/online-cluster.test.js is where the two margins are kept equal.
const out = (verdict, display) => console.log([verdict, display, expiry].join('|'))
if (token === undefined) out('unknown', 'no cached token')
else if (unknown) out('unknown', 'no readable expiry')
else if (obtainedOn + expiresIn - Date.now() <= 1000) out('expired', 'expired')
// Ceil, so a token with a second left reads as one minute rather than as the zero that
// reads like a refusal.
else out('ok', Math.ceil((obtainedOn + expiresIn - Date.now()) / 60000) + ' min left')
JS
)

# The token as the pod holds it, which is the copy the rung will log in with.
token_left_in_pod () {
  kubectl -n "$NAMESPACE" exec "$pod" -- node -e "$TOKEN_LEFT_JS" "$1"
}

# The gate: refuse an account that would rotate, and say which account, when it expired,
# and what to do here. $1 names the account, $2 is its directory in the pod, $3 is what to
# do instead of accepting the rotation.
gate_token () {
  local label=$1 dir=$2 instead=$3 verdict display expiry token
  IFS='|' read -r verdict display expiry <<<"$(token_left_in_pod "$dir")"
  token=${display:-unreadable}
  say "$label access token: $token${expiry:+ (expiry $expiry)}"
  # "ok" is the one verdict that rotates nothing. Everything else, including a read that
  # answered nothing at all, is a decision the operator has to make.
  case "$verdict" in
    ok) return 0 ;;
  esac
  if [ "$ROTATE" = 1 ]; then
    say "$label: --rotate accepts the rotation, so the refreshed directory is copied back"
    return 0
  fi
  die "the $label access token is $token${expiry:+ (it expired at $expiry)}. A login in pod $pod would rotate its chain away from the copy that is live now, so $instead, or re-run with --rotate to accept the rotation." 2
}

pod_cleanup () {
  [ -n "${pod:-}" ] || return 0
  if [ "$KEEP_POD" = 1 ]; then
    say "keeping pod $pod for inspection"
    return 0
  fi
  kubectl -n "$NAMESPACE" delete pod "$pod" --wait=false >/dev/null 2>&1 || true
}

# One trap, because a second `trap ... EXIT` replaces the first and would leave the pod
# or the lease behind. The run's own exit status survives it, so a failed rung is still
# a failed rung after the lease is released.
on_exit () {
  local status=$?
  trap - EXIT
  pod_cleanup
  lease_release
  # What the renewal loop said while the run went: a lease it lost, or a read it
  # could not make. It wrote to a file so it held no pipe of its own.
  if [ -n "$LEASE_STATE" ] && [ -s "$LEASE_STATE/renew.log" ]; then cat "$LEASE_STATE/renew.log" >&2; fi
  [ -z "$LEASE_STATE" ] || rm -rf "$LEASE_STATE"
  exit "$status"
}

# hold CMD: the same guarantee without the pod, which is how `mise run online` takes
# the account (mise.toml). The command is this machine's, so the custody it reads is
# this machine's too.
hold () {
  local status=0
  [ $# -gt 0 ] || die 'hold needs a command: scripts/online-cluster.sh hold [--lease-wait SECONDS] CMD [ARG...]' 2
  [ -d "$SECRETS/accounts" ] ||
    die "no accounts in $SECRETS/accounts. Run mise run secrets:link first, because the account this run holds the lease for lives there" 2
  LEASE_STATE=$(mktemp -d "${TMPDIR:-/tmp}/monoplayer-lease.XXXXXXXX")
  LEASE_WRITE=$LEASE_STATE/lease.json
  trap on_exit EXIT
  lease_acquire
  say "holding the lease, running: $*"
  set +e
  "$@"
  status=$?
  set -e
  exit "$status"
}

if [ "$HOLD" = 1 ]; then
  # Guarded for bash 3.2, where an empty array is an unbound variable under `set -u`:
  # `hold --` reaches here with no command and has to get the sentence below.
  hold ${HOLD_COMMAND[@]+"${HOLD_COMMAND[@]}"}
fi

[ -f "$ROOT/$RUNG" ] || die "no such rung: $RUNG"
# Only the online rung writes a report; another module's exit status is its
# whole result. The operator's flags follow, so the report path this script copies back
# is the first --report the module reads (`flag` takes the first one, service/cli.js).
#
# One home for "this module writes a report": the flag it is given and the copy-back that
# collects it read the same decision, so a rung cannot get one without the other.
WRITES_REPORT=0
rung_args=()
if [ "$RUNG" = src/ladder/online.js ]; then
  WRITES_REPORT=1
  rung_args=(--report /work/online-report.json)
fi
rung_args+=(${RUNG_ARGS[@]+"${RUNG_ARGS[@]}"})
[ -d "$SECRETS/accounts" ] || die "no accounts in $SECRETS/accounts; run mise run secrets:link first"

# The attach account, by alias, from the working copy.
attach_dir=$(node -e '
const fs = require("node:fs"), path = require("node:path")
const [root, alias] = process.argv.slice(1)
for (const entry of fs.readdirSync(root)) {
  const file = path.join(root, entry, "profile.json")
  if (!fs.existsSync(file)) continue
  const profile = JSON.parse(fs.readFileSync(file, "utf8"))
  if (profile.alias === alias || profile.name?.toLowerCase() === alias) { console.log(path.join(root, entry)); break }
}
' "$SECRETS/accounts" "$ATTACH_ALIAS")
[ -n "$attach_dir" ] || die "no account with alias $ATTACH_ALIAS in $SECRETS/accounts"

# Taken before the custody is read, so a run that is refused has touched no token.
LEASE_STATE=$(mktemp -d "${TMPDIR:-/tmp}/monoplayer-lease.XXXXXXXX")
LEASE_WRITE=$LEASE_STATE/lease.json
trap on_exit EXIT
lease_acquire

# What the deployment runs, and which account it uses: read, never assume.
deployment_json=$(kubectl -n "$NAMESPACE" get deploy "$DEPLOYMENT" -o json)
IFS='|' read -r image puppet_uuid accounts_dir <<<"$(node -e '
const deployment = JSON.parse(process.argv[1])
const container = deployment.spec.template.spec.containers[0]
const env = Object.fromEntries((container.env ?? []).map(entry => [entry.name, entry.value]))
console.log([
  container.image,
  env.MONOPLAYER_PUPPET_UUID ?? "",
  env.MONOPLAYER_PUPPET_ACCOUNTS_DIR ?? "/data/accounts"
].join("|"))
' "$deployment_json")"
[ -n "$image" ] || die "cannot read the image of $NAMESPACE/$DEPLOYMENT"
[ -n "$puppet_uuid" ] || die "$NAMESPACE/$DEPLOYMENT defines no MONOPLAYER_PUPPET_UUID"
accounts_dir=${accounts_dir:-/data/accounts}
say "deployment $image, puppet $puppet_uuid, custody $accounts_dir"

sha=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)
pod="monoplayer-online-check-$sha-$$"
[ -n "$REPORT" ] || REPORT=".reports/online-cluster-$sha.json"
mkdir -p "$(dirname "$REPORT")"

# The pod is deleted on every path, including a refusal after it was created.

kubectl apply -n "$NAMESPACE" -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: monoplayer-online-check
    app.kubernetes.io/component: live-gate
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  imagePullSecrets:
    - name: ghcr-pull
  containers:
    - name: check
      image: $image
      command: ["sh", "-c", "sleep 1800"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          memory: 1Gi
      volumeMounts:
        - name: custody
          mountPath: /data
          readOnly: true
        - name: config
          mountPath: /config
          readOnly: true
        - name: work
          mountPath: /work
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: custody
      persistentVolumeClaim:
        claimName: monoplayer-custody
        readOnly: true
    - name: config
      configMap:
        name: monoplayer-config
    - name: work
      emptyDir: {}
    - name: tmp
      emptyDir: {}
YAML

say "waiting for $pod"
kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/$pod" --timeout=180s >/dev/null \
  || die "the pod never became ready; kubectl -n $NAMESPACE describe pod $pod"

# The branch's code, next to the image's dependencies.
kubectl cp ./src "$NAMESPACE/$pod:/work/src" >/dev/null
kubectl cp ./package.json "$NAMESPACE/$pod:/work/package.json" >/dev/null
kubectl -n "$NAMESPACE" exec "$pod" -- sh -c "
  set -e
  ln -sfn /app/node_modules /work/node_modules
  mkdir -p /work/.secrets/accounts
  cp -a $accounts_dir/$puppet_uuid /work/.secrets/accounts/
  cp /config/attach-whitelist.json /work/.secrets/attach-whitelist.json
  rm -f /work/.secrets/accounts/*/writer.lock
" >/dev/null
kubectl cp "$attach_dir" "$NAMESPACE/$pod:/work/.secrets/accounts/$(basename "$attach_dir")" >/dev/null

# Both accounts, before the rung can log in as either. The puppet's copy is the
# deployment's, and the attach account's is the one this run copied in from the working
# copy, so a rotation in the pod would leave the local copy dead.
gate_token 'puppet' "/work/.secrets/accounts/$puppet_uuid" \
  'wait for the deployment to refresh it first'
gate_token "attach account $ATTACH_ALIAS ($(basename "$attach_dir"))" \
  "/work/.secrets/accounts/$(basename "$attach_dir")" \
  "refresh this working copy first with node src/custody/cli.js status --account $ATTACH_ALIAS --refresh"

say "running $RUNG: backend $BACKEND_HOST:$BACKEND_PORT"
set +e
kubectl -n "$NAMESPACE" exec "$pod" -- env \
  MONOPLAYER_BACKEND_HOST="$BACKEND_HOST" MONOPLAYER_BACKEND_PORT="$BACKEND_PORT" \
  MONOPLAYER_FRONT_HOST="${MONOPLAYER_FRONT_HOST:-}" MONOPLAYER_FRONT_PORT="${MONOPLAYER_FRONT_PORT:-}" \
  MONOPLAYER_VERSION="${MONOPLAYER_VERSION:-}" \
  sh -c 'cd /work && node "$0" "$@"' "$RUNG" ${rung_args[@]+"${rung_args[@]}"}
run_status=$?
set -e

# The module that writes the report decides this, not whether it was handed flags: a
# capture run with --paper-build writes no online-report.json (#384).
if [ "$WRITES_REPORT" = 1 ]; then
  kubectl cp "$NAMESPACE/$pod:/work/online-report.json" "$REPORT" >/dev/null 2>&1 \
    && say "report written to $REPORT"
fi

# The attach account was copied in. With --rotate its rotation is copied back here, so one
# live copy remains. Without --rotate the pod was refused every token that would rotate, so
# the directory it hands back has to be the one it was given: that is the invariant the
# copy-back used to repair after the fact, and it is compared rather than written (#389).
# The fetch below stays fatal either way (#370): a copy-back that brings nothing back is a
# failed run, and so is a comparison the run cannot make.
rotated_attach=$(mktemp -d)
fetch_status=0
kubectl cp "$NAMESPACE/$pod:/work/.secrets/accounts/$(basename "$attach_dir")" "$rotated_attach" >/dev/null 2>&1 ||
  fetch_status=$?
# kubectl cp lays the directory down one level either way, so the profile is in the
# destination itself or in one directory below it. A glob reads the same on GNU and on
# BSD. `find -printf` reads on GNU only: on macOS it exits 1, and under `set -euo pipefail`
# that status ends the run (#370).
from=''
for candidate in "$rotated_attach" "$rotated_attach"/*; do
  [ -f "$candidate/profile.json" ] || continue
  from=$candidate
  break
done
if [ "$fetch_status" != 0 ]; then
  rm -rf "$rotated_attach"
  die "kubectl could not copy the attach account directory back from pod $pod, so nothing says whether the rung rotated its token caches. $attach_dir was left as it was. A rotation that does not come back is a failed run" 2
fi
if [ -z "$from" ]; then
  rm -rf "$rotated_attach"
  die "the attach account directory came back from pod $pod with no profile.json in it, so $attach_dir was left as it was. A rotation that does not come back is a failed run" 2
fi
rm -f "$from/writer.lock"
if [ "$ROTATE" = 1 ]; then
  cp -a "$from"/. "$attach_dir"/ ||
    die "could not write the rotated attach account into $attach_dir, so that directory may hold part of the rotation and part of what was there before. The rung's copy is left in $rotated_attach, and the pod is deleted on the way out" 2
  chmod 600 "$attach_dir"/*.json 2>/dev/null || true
  say "wrote the attach account directory back to $attach_dir"
  rm -rf "$rotated_attach"
else
  # The whole directory, not the four custody files: a rotation this gate did not expect is
  # exactly the case where the file set itself is worth reading. -q because these files hold
  # refresh and access tokens, and a content diff would print them. -x because writer.lock
  # belongs to the local copy, which this run does not own.
  diff_status=0
  difference=$(diff -rq -x writer.lock "$attach_dir" "$from" 2>&1) || diff_status=$?
  rm -rf "$rotated_attach"
  case "$diff_status" in
    0) say "the attach account directory came back unchanged from $attach_dir" ;;
    1)
      say "the attach account directory came back different from $attach_dir"
      printf '%s\n' "$difference" >&2
      # The pod holds the only live copy if the chain rotated, so it outlives the run. The
      # sentence says what it saw and not why: the comparison covers every file, so a write
      # that is not a rotation would still leave this run unable to say the directory came
      # back untouched. It is a failed run and not a refused setup, because the rung ran.
      #
      # No margin can promise the token outlives the run: the gate reads it, and a minute
      # later the login reads it again. A token that lapses in between rotates, and lands
      # here. That is why this path reports instead of repairing.
      KEEP_POD=1
      die "something in pod $pod wrote to the attach account directory, which a valid cached token was meant to leave alone, and $attach_dir was left as it was. A token that lapses between the gate and the login does this too. The pod is kept because a rotation would leave it holding the only live copy: take it with kubectl cp $NAMESPACE/$pod:/work/.secrets/accounts/$(basename "$attach_dir") <dir>, or re-run with --rotate to accept the change and copy it back" 1 ;;
    *) die "cannot compare the attach account directory that came back from pod $pod with $attach_dir, so nothing says whether the rung rotated its token caches: $difference" 2 ;;
  esac
fi

# A rotated puppet chain has to go back, or the deployment dies on its next
# refresh. That is what --rotate agreed to. The volume is mounted read-only in
# this pod, so the write goes through the deployment's own writable mount.
if [ "$ROTATE" = 1 ]; then
  rotated_puppet=$(mktemp -d)
  kubectl cp "$NAMESPACE/$pod:/work/.secrets/accounts/$puppet_uuid" "$rotated_puppet" >/dev/null
  rm -f "$rotated_puppet/$puppet_uuid/writer.lock"
  say "writing the refreshed puppet chain back to $accounts_dir/$puppet_uuid"
  for file in live-cache.json mca-cache.json xbl-cache.json profile.json; do
    kubectl -n "$NAMESPACE" exec -i deploy/"$DEPLOYMENT" -- \
      sh -c "cat > $accounts_dir/$puppet_uuid/$file" <"$rotated_puppet/$puppet_uuid/$file" || \
      die "could not write $file back to the custody volume" 2
  done
  rm -rf "$rotated_puppet"
  say 'restart the deployment so it reads the new chain: kubectl -n '"$NAMESPACE"' rollout restart deploy/'"$DEPLOYMENT"
fi

exit "$run_status"

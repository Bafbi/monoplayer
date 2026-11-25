#!/usr/bin/env bash
# The gate lane's lifecycle (#115, #279): one lane per worktree, woken for a run,
# put back to sleep, listed across the cluster, and reaped when it has sat idle too
# long.
#
#   scripts/gate-lane.sh render DIR
#                                 write the tree this lane would apply into DIR
#   scripts/gate-lane.sh up [DEPLOYMENT...]
#                                 apply deploy/driver, wake the deployments
#                                 named (default: the two rows a rung drives),
#                                 and wait for them to report ready
#   scripts/gate-lane.sh down     scale this lane's workloads to 0 and wait for
#                                 their pods to go
#   scripts/gate-lane.sh status   what this lane runs, who owns it, and what is ready
#   scripts/gate-lane.sh name     the lane this worktree derives, and nothing else
#   scripts/gate-lane.sh lanes [--reap] [--window SECONDS]
#                                 every gate lane on the cluster: its age, its pods,
#                                 and the worktree that owns it. --reap deletes the
#                                 lanes idle past the window. The transfer testbed's
#                                 fixed namespace is listed here and never deleted
#
# Why: the lane used to run 24/7 for runs that last minutes — 6,214 MiB of Paper,
# Velocity and toxiproxy, two of which no rung drives. At rest the five
# deployments sit at 0, which is what the manifests commit. A bare
# `kubectl apply -k deploy/driver` wakes nothing, and it stops whatever was awake,
# because an apply reconciles every field in the tree. That is why only this
# script applies, and why up wakes the awake rows again after its own apply.
#
# A cold start pays Paper's download and a flat-world write into a fresh emptyDir,
# because every gate volume dies with its pod. Measured at 90 s on the 26.2 gate
# Paper (#115). up says how long it will wait before it waits, so a long silence is
# not read as a hang. down leaves the Deployments, the Services and the ConfigMaps
# in place, so the next up costs the same cold start and nothing else.
#
# The lane's name comes from the worktree (#279): its short commit, then a short
# hash of its path. Two checkouts at one commit are two lanes, and nobody types an
# instance. up, down and status act on this worktree's lane and no other, so two
# agents cannot stop each other's rows. A commit moves a worktree to a new lane.
# `lanes` finds the one it left, and `lanes --reap` deletes it once it has been
# idle past the window.
#
# The lane's two Secrets are its own (#278). up creates gate-<instance>-rcon and
# gate-<instance>-velocity with random values when they are absent. down deletes the
# ones up created. So a first run needs no operator, and a stopped lane leaves no Secret
# behind. An operator's Secret is used as it is and kept: this script never overwrites
# one and never deletes one. down tells the two apart by the label up writes.
#
# What it never does: touch the live lane (monoplayer) or the dev lane
# (monoplayer-dev). It never deletes a workload, a Service or a ConfigMap. It never
# scales paper-hub or paper-sky, which are the transfer testbed's and share a gate
# namespace. It never changes anything else in the testbed's namespace either: up and
# down both refuse that name (#360). And it never reaps a lane that still runs, or one
# that holds anything this script did not make, or one nobody dated. The testbed's
# namespace is never reaped either: that last name is fixed, shared by every worktree,
# and deletes with nothing to restore it (#318).
#
# The tree in deploy/driver is a template, not a lane. Everywhere it names one it
# spells gate-__instance__, and render() substitutes the instance into all of it, so
# the manifests and the label this script looks pods up by cannot disagree. A tree
# that spelled a lane would apply that lane whoever ran it, which is the collision
# #279 removes. It also means the tree cannot be applied as it is: a lane exists
# only through this script.
#
# Environment:
#   MONOPLAYER_GATE_NAMESPACE    this lane's namespace (default: monoplayer-gate-<instance>,
#                                the instance derived from MONOPLAYER_GATE_WORKTREE)
#   MONOPLAYER_GATE_WORKTREE     the worktree the lane is derived from (default: this
#                                checkout). Name another to ask for the lane it makes.
#   MONOPLAYER_GATE_IDLE_WINDOW  seconds a lane may sit with no pod before
#                                `lanes --reap` deletes it (default 21600, six hours)
#   MONOPLAYER_CLUSTER_NAMESPACE the live namespace          (default monoplayer)
#   MONOPLAYER_GATE_READY_TIMEOUT seconds up waits for ready (default 900)
#   MONOPLAYER_GATE_STOP_TIMEOUT  seconds down waits         (default 180)
#   MONOPLAYER_GATE_POLL          seconds between checks     (default 5)
#
# Exit codes: 0 the lane reached the state asked for, 1 it did not, 2 refused.
set -euo pipefail

# The physical path, so a worktree reached through a symlink still hashes to the lane
# it had before: a lane's name is a fact about the checkout, not about the way in.
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
# '-' and not ':-': an explicitly empty value is refused by the guard, not replaced
# by the default, so a half-written environment cannot look healthy.
WORKTREE=${MONOPLAYER_GATE_WORKTREE:-$ROOT}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
READY_TIMEOUT=${MONOPLAYER_GATE_READY_TIMEOUT:-900}
STOP_TIMEOUT=${MONOPLAYER_GATE_STOP_TIMEOUT:-180}
POLL=${MONOPLAYER_GATE_POLL:-5}
IDLE_WINDOW=${MONOPLAYER_GATE_IDLE_WINDOW:-21600}
# 63, the longest a label value may be, minus "monoplayer-gate-" (16) and
# "-paper-conduct" (14), the longest thing this lane labels.
INSTANCE_MAX=33
MANIFESTS=$ROOT/deploy/driver
# The one value every name in the lane comes from. The tree spells the placeholder
# gate-__instance__ wherever the lane's name goes, and render() substitutes what
# follows the prefix below.
GATE_PREFIX=monoplayer-gate-
# The label every lane's namespace carries, and the only selector the listing and the
# reaper use. The live and the dev namespace carry app.kubernetes.io/part-of alone, so
# neither can be listed as a gate lane, let alone deleted as one.
LANE_SELECTOR=app.kubernetes.io/component=gate-lane
# The transfer testbed's namespace is the one namespace this script lists and does
# not derive (#318). It is not a gate lane: a lane is a worktree's and disposable, and
# this is neither. deploy/testbed/namespace.yaml carries the selector above, so `lanes`
# shows it and the reaper reads it like a lane: the tenant rule below keeps it while
# `paper-hub` and `paper-sky` are in it, and this name keeps it if those rows ever go.
# It is not a worktree's lane, so `guard_lane_write` refuses it before up or down acts
# (#360). `status` still reads its rows. Its clock is the testbed's business: `lanes`
# prints "?" for an age it does not have.
TESTBED_NAMESPACE=monoplayer-gate-b
TESTBED_OWNER='transfer testbed'

# The one question two places ask about that name: which owner to print, and whether to
# refuse the delete. It is a function so the two cannot disagree about the spelling.
is_testbed_namespace () { [ "$1" = "$TESTBED_NAMESPACE" ]; }
# What up writes on the namespace: the two facts the listing needs, and the clock the
# reaper reads. A lane without them is a lane nobody can find, and one nobody dates is
# a lane no reap will touch.
ANNOTATION_WORKTREE=monoplayer.eu/lane-worktree
ANNOTATION_COMMIT=monoplayer.eu/lane-commit
ANNOTATION_TOUCHED=monoplayer.eu/lane-touched

# Every Deployment deploy/driver declares. down covers all five; up wakes the two
# a rung drives unless it is told which ones it needs.
#
#   paper         the G0 driver row (mise run driver:scenario, online:cluster)
#   paper-conduct the gate-serving Paper (mise run observer:run, #78)
#   paper-m4      behind Velocity; no rung drives it yet
#   velocity      in front of paper-m4; no rung drives it yet
#   toxiproxy     the puppet-leg fault rig; no rung drives it yet
GATE_WORKLOADS="paper paper-conduct paper-m4 velocity toxiproxy"
DRIVEN_WORKLOADS="paper paper-conduct"

# The two Secrets a lane reads, in the order up creates them.
SECRET_ROLES="rcon velocity"
# The label up stamps on a generated Secret, one literal split into the halves a write
# and a selector need. down deletes by this selector and by nothing else.
GENERATED_LABEL=app.kubernetes.io/managed-by=gate-lane
GENERATED_LABEL_KEY=${GENERATED_LABEL%%=*}
GENERATED_LABEL_VALUE=${GENERATED_LABEL#*=}

# Measured on the 26.2 gate Paper (#115), from a scale to 0 until the pod reports
# ready. The 240-310 s in the docs is a different wait: a Paper that is already up
# and restarts with the observer plugin, counted until the plugin logs that its
# packet listeners are live (scripts/observer-report.sh). Nothing here waits for that.
COLD_START="90 s from 0 to ready"

die () { printf 'gate-lane: %s\n' "$1" >&2; exit "${2:-2}"; }
say () { printf 'gate-lane: %s\n' "$1"; }

# The one function every lane name comes from (#279). It returns 1 rather than
# exiting, because the caller holds the sentence a reader needs.
lane_commit () {
  local commit
  commit=$(git -C "$WORKTREE" rev-parse --short=7 HEAD 2>/dev/null) || return 1
  [ -n "$commit" ] || return 1
  printf '%s' "$commit"
}

# A short hash of the path, so two checkouts at one commit differ. POSIX cksum keeps
# this script's dependencies to kubectl and openssl: no hashing tool to install, and
# six hex digits tell the handful of worktrees on one machine apart.
lane_path_hash () {
  printf '%s' "$WORKTREE" | cksum | awk '{ printf "%06x", $1 % 16777216 }'
}

lane_instance () {
  local commit
  commit=$(lane_commit) || return 1
  printf '%s-%s' "$commit" "$(lane_path_hash)"
}

if [ -n "${MONOPLAYER_GATE_NAMESPACE+set}" ]; then
  GATE_NAMESPACE=$MONOPLAYER_GATE_NAMESPACE
else
  DERIVED_INSTANCE=$(lane_instance) || die "cannot derive this worktree's lane: $WORKTREE is not a git checkout, so it has no commit to name a lane after. Set MONOPLAYER_GATE_NAMESPACE to name one by hand"
  GATE_NAMESPACE=$GATE_PREFIX$DERIVED_INSTANCE
fi

# The tree spells the lane two ways: monoplayer-gate-<instance>-<thing> for the
# namespace, the labels and the tailnet hostnames, and gate-<instance>-<name> for the
# Secrets and the ConfigMaps. Both derive here, once, so no caller can spell one and
# mean the other.
INSTANCE=${GATE_NAMESPACE#"$GATE_PREFIX"}
LANE_LABEL=$GATE_PREFIX$INSTANCE
LANE_NAME=gate-$INSTANCE

need_kubectl () { command -v kubectl >/dev/null || die 'kubectl is not on PATH'; }

# The gate namespace is the only one this script may scale, and the only class of
# namespace it may delete. monoplayer and monoplayer-dev are refused even when the
# live-namespace variable is overridden, so no environment can aim a scale, a delete
# or a read at the product or the dev lane. The reaper passes every namespace the
# cluster offers through this same guard, which is what makes the ban a rule rather
# than a default.
guard_namespace () {
  local name=$1 instance
  if [ -z "$name" ] || [ "$name" = "$LIVE_NAMESPACE" ] ||
    [ "$name" = monoplayer ] || [ "$name" = monoplayer-dev ]; then
    die "refusing \"${name}\" as a gate lane: this script scales and deletes, and the gate is the only disposable lane"
  fi
  # The render substitutes the instance into a tree that spells gate-__instance__, so
  # a name that does not follow the prefix leaves the tree's spelling with nothing to
  # substitute, and the render would quietly apply a lane nobody asked for.
  case "$name" in
    "$GATE_PREFIX"?*) : ;;
    *) die "refusing \"${name}\": the gate lane is ${GATE_PREFIX}<instance>, and that suffix is the one value every name in the lane is derived from" ;;
  esac
  instance=${name#"$GATE_PREFIX"}
  # The instance becomes part of a namespace and of an app.kubernetes.io/name value,
  # so it is a DNS-1123 label. That is also what makes the sed in render() safe: no
  # character it would read as syntax can reach it.
  case "$instance" in
    *[!a-z0-9-]*|-*|*-) die "refusing \"${name}\": the instance \"${instance}\" is not a DNS-1123 label, so it cannot name a namespace or a label value" ;;
  esac
  # A label value is at most 63 characters, and the longest one this lane writes is
  # app.kubernetes.io/name: monoplayer-gate-<instance>-paper-conduct. A longer
  # instance would render a tree that kubectl refuses, one apply later and with a
  # message about the manifest rather than about the name that caused it.
  if [ "${#instance}" -gt "$INSTANCE_MAX" ]; then
    die "refusing \"${name}\": the instance is ${#instance} characters and the limit is $INSTANCE_MAX, which keeps monoplayer-gate-<instance>-paper-conduct inside the 63-character label value"
  fi
}

guard () { guard_namespace "$GATE_NAMESPACE"; }

# The rule up and down answer to, and no other command does. The testbed's namespace
# follows the gate prefix but belongs to no worktree (#318), so it passes every rule
# above. Acting on it means acting on a namespace two worktrees share: down scales the
# rows a testbed run is using to 0, and up applies the gate tree over it. The name is
# fixed and its Papers are not disposable by derivation, so one function answers for
# both commands. status, name and render skip it. None of them acts on a lane: status
# reads one, name prints it, and render writes text. A reader debugging the testbed needs
# those rows (#360).
guard_lane_write () {
  guard
  if is_testbed_namespace "$GATE_NAMESPACE"; then
    die "refusing \"${GATE_NAMESPACE}\": it is the transfer testbed's namespace, which mise run testbed:up owns, not a worktree's lane. Every worktree shares it, its Papers are not disposable by derivation, and nothing here puts them back, so up and down leave it alone (#360)"
  fi
}

known () {
  local name
  for name in $GATE_WORKLOADS; do
    [ "$name" = "$1" ] && return 0
  done
  return 1
}

# A role's Secret in two parts, the key and the rows: the three Papers read
# RCON_PASSWORD out of gate-<instance>-rcon, and Velocity and paper-m4 read
# PAPER_VELOCITY_SECRET out of gate-<instance>-velocity. A row this run wakes without
# its Secret starts in CreateContainerConfigError, which reads like a slow boot.
secret_parts () {
  case "$1" in
    rcon) printf 'password:paper paper-conduct paper-m4' ;;
    velocity) printf 'forwarding-secret:velocity paper-m4' ;;
    *) return 1 ;;
  esac
}

# Whether this lane's Secret is there. A read that fails for any other reason stops the
# run: a Forbidden or a timeout is not an absence, and reading one as an absence would
# let the create below overwrite a Secret an operator made, which is the one thing this
# must never do.
secret_exists () {
  local found
  found=$(kubectl -n "$GATE_NAMESPACE" get secret "$1" --ignore-not-found -o name) ||
    die "cannot read the Secret $1 in $GATE_NAMESPACE: this run will not guess whether it exists, and a wrong guess overwrites it"
  [ -n "$found" ]
}

# A random value, written straight to kubectl's stdin. It is in no argv and on no
# printed line: 'create secret --from-literal' would put it in the process list of
# this machine, and no manifest may hold it at all.
create_secret () {
  local name=$1 key=$2 value
  command -v openssl >/dev/null ||
    die 'openssl is not on PATH, and a generated Secret value has to be random'
  value=$(openssl rand -hex 16)
  kubectl -n "$GATE_NAMESPACE" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $name
  namespace: $GATE_NAMESPACE
  labels:
    $GENERATED_LABEL_KEY: $GENERATED_LABEL_VALUE
type: Opaque
stringData:
  $key: $value
EOF
  say "created the random Secret $name ($key)"
}

# The Secrets the rows this run wakes read. A lane that cannot exist without a human is
# the reason a second lane cannot exist (#278). A Secret that is already there is used as
# it is, whatever made it, and one line names the ones this run found, because two lines
# read as two decisions where there was one.
ensure_secrets () {
  local waking=$1 role parts key readers reader name found=''
  for role in $SECRET_ROLES; do
    parts=$(secret_parts "$role") ||
      die "unknown gate Secret role \"$role\": the lane reads $SECRET_ROLES"
    key=${parts%%:*}
    readers=${parts#*:}
    for reader in $readers; do
      case " $waking " in
        *" $reader "*)
          name=$LANE_NAME-$role
          if secret_exists "$name"; then
            found="$found $name"
          else
            create_secret "$name" "$key"
          fi
          break ;;
      esac
    done
  done
  [ -z "$found" ] || say "using the Secret(s) this lane already has:$found. This script never overwrites one."
}

# kubectl's own error stays visible: "deploy/paper not found" is the answer a
# reader needs, and a silent wait would turn it into a mystery.
ready_replicas () {
  local value
  value=$(kubectl -n "$GATE_NAMESPACE" get deploy "$1" -o jsonpath='{.status.readyReplicas}') || value=''
  # No field yet is a deployment that has not started a pod, which is 0.
  case "$value" in ''|*[!0-9]*) value=0 ;; esac
  printf '%s' "$value"
}

# What a row runs now. kubectl apply resets every Deployment to the tree's 0,
# so up reads this before it applies and wakes those rows again afterwards.
current_replicas () {
  local value
  value=$(kubectl -n "$GATE_NAMESPACE" get deploy "$1" -o jsonpath='{.spec.replicas}' 2>/dev/null) || value=''
  case "$value" in ''|*[!0-9]*) value=0 ;; esac
  printf '%s' "$value"
}

pods_of () {
  kubectl -n "$GATE_NAMESPACE" get pods -l "app.kubernetes.io/name=$LANE_LABEL-$1" -o name 2>/dev/null || true
}

# Whether this worktree's lane exists on the cluster. A lane is named after a commit, so
# a commit makes a new one. The first command against it may be the one that creates it.
# One probe lets the commands that need a lane say so.
#
# A read that fails for any other reason stops the run. A Forbidden or a timeout is not an
# absence: reading one as an absence lets down report a lane as stopped while it still
# runs, which is #278's rule for a Secret and the same rule here.
lane_exists () {
  local found
  found=$(kubectl get namespace "$GATE_NAMESPACE" -o name --ignore-not-found) ||
    die "cannot read the namespace $GATE_NAMESPACE: this run will not guess whether the lane exists"
  [ -n "$found" ]
}

# One annotation of one namespace, or nothing. A dotted annotation key needs its dot
# escaped in jsonpath, which is the one backslash in this script. A lane whose
# annotation read fails is a lane the listing prints as unknown and the reaper leaves
# alone, so a failed read here is a kept lane rather than a deleted one.
lane_annotation () {
  local expr
  expr="{.metadata.annotations.${2/./\\.}}"
  kubectl get namespace "$1" -o jsonpath="$expr" 2>/dev/null || true
}

# A namespace the reaper has already asked for. Deletion is asynchronous: the call
# returns when the API has accepted it, and the objects take a few seconds to go. A
# listing that could not tell the two apart would report a reaped lane as awake.
lane_phase () {
  kubectl get namespace "$1" -o jsonpath='{.status.phase}' 2>/dev/null || true
}

# Every pod in a lane, counted. The count is what decides whether a lane is idle: one
# running row is a lane somebody may still be reading, however old its stamp.
pod_count () {
  local listed
  listed=$(kubectl -n "$1" get pods -o name) ||
    die "cannot read the pods in $1: an unreadable lane is not an idle one, so this run will not delete it" 1
  printf '%s' "$listed" | grep -c . || true
}

# The lane a rendered tree belongs to. It reads the render, not the tree, because
# the render is what gets applied. up compares the two rather than assuming they
# agree. awk with an exit reads one line and no more. A piped head would let sed
# take a SIGPIPE, and pipefail would turn that into a silent death.
rendered_namespace () {
  awk '/^  name: /{print $2; exit}' "$1/namespace.yaml"
}

# The tree is the template, and one substitution reaches the namespace object, every
# label and selector, the Secret and ConfigMap names, the tailnet hostnames and the
# path inside velocity.toml. That is why a rename cannot half-land.
render () {
  local dir=$1 file entries left
  # The target belongs to the caller, so anything already in it is theirs. The
  # listing and its status are read apart: a directory this cannot read must not
  # look empty, or the copy below would overwrite what it could not see.
  mkdir -p "$dir"
  entries=$(ls -A "$dir") ||
    die "refusing to render into $dir: it cannot be listed, so the render cannot tell what it would overwrite"
  [ -z "$entries" ] ||
    die "refusing to render into $dir: it is not empty, and the render would overwrite what is there"
  cp -R "$MANIFESTS"/. "$dir"/
  for file in "$dir"/*.yaml; do
    sed "s/__instance__/$INSTANCE/g" "$file" > "$file.new"
    mv "$file.new" "$file"
  done
  left=$(grep -l '__instance__' "$dir"/*.yaml || true)
  [ -z "$left" ] || die "the render left the placeholder in $left: a lane's name comes from the instance and nothing else"
}

# The three facts that make a lane findable, plus the clock the reaper reads. The stamp
# is an epoch, so the age needs no date parsing in the listing. A failed write returns
# 1, because up and down disagree about how bad that is.
stamp_lane () {
  local commit now
  local -a args
  commit=$(lane_commit) || commit=''
  now=$(date +%s)
  args=( "$ANNOTATION_WORKTREE=$WORKTREE" "$ANNOTATION_TOUCHED=$now" )
  [ -z "$commit" ] || args+=( "$ANNOTATION_COMMIT=$commit" )
  kubectl annotate namespace "$GATE_NAMESPACE" --overwrite "${args[@]}" >/dev/null 2>&1
}

up () {
  guard_lane_write
  need_kubectl
  local names="${*:-$DRIVEN_WORKLOADS}" name pending start deadline awake='' wake
  for name in $names; do
    known "$name" || die "unknown gate deployment \"$name\": the gate workloads are $GATE_WORKLOADS"
  done
  # The apply is a full reconcile to the tree, and the tree says 0, so it stops a
  # row another up woke. Those rows are woken again below: waking a row must never
  # stop the one beside it.
  for name in $GATE_WORKLOADS; do
    [ "$(current_replicas "$name")" -ge 1 ] && awake="$awake $name"
  done
  awake=${awake# }

  # The render is what gets applied, so the lane it renders and the lane this run
  # scales are read back from it. One value produced both, and this check is what
  # proves it did.
  RENDER=$(mktemp -d)
  trap 'rm -rf "$RENDER"' EXIT
  render "$RENDER"
  [ "$(rendered_namespace "$RENDER")" = "$GATE_NAMESPACE" ] ||
    die "the render spells $(rendered_namespace "$RENDER") and this run would scale $GATE_NAMESPACE: they are one lane, so name the same namespace"
  say "gate lane $GATE_NAMESPACE: instance $INSTANCE, label prefix $LANE_LABEL-"

  lane_exists || say "this worktree's lane $GATE_NAMESPACE does not exist yet: the apply below creates it"

  kubectl apply -k "$RENDER" >/dev/null
  say "applied the render of deploy/driver to $GATE_NAMESPACE"

  wake=$names
  for name in $awake; do
    case " $wake " in *" $name "*) : ;; *) wake="$wake $name" ;; esac
  done

  # Done after the apply, because the apply is what creates the namespace on a fresh
  # cluster, and before the scale, so no pod starts without the Secret it reads. The
  # rows are the ones this run wakes, and that list includes a row it re-wakes after
  # the apply.
  ensure_secrets "$wake"
  stamp_lane ||
    die "cannot annotate $GATE_NAMESPACE with $WORKTREE: a lane with no owner is a lane nobody can find, list or reap"
  say "stamped $GATE_NAMESPACE with $WORKTREE, its commit, and the clock the reaper reads"

  # shellcheck disable=SC2086
  kubectl -n "$GATE_NAMESPACE" scale deploy $wake --replicas=1 >/dev/null
  say "woke $names"
  if [ -n "$awake" ]; then
    say "woke $awake again after the apply, which puts every row back to the tree's 0"
  fi
  say "waiting up to ${READY_TIMEOUT}s for $names to report ready"
  say "cold start is $COLD_START (#115)"
  say "a Paper restart that loads the observer takes 240-310 s, and observer:run waits for that itself"

  # The budget is a deadline on the clock, not a sum of sleeps, so a poll interval
  # of 0 still reaches it instead of spinning for ever.
  start=$(date +%s)
  deadline=$((start + READY_TIMEOUT))
  while : ; do
    pending=''
    for name in $names; do
      [ "$(ready_replicas "$name")" -ge 1 ] || pending="$pending $name"
    done
    if [ -z "$pending" ]; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "still not ready after ${READY_TIMEOUT}s:$pending. A cold start is $COLD_START; read what the pod is doing: kubectl -n $GATE_NAMESPACE get pods -o wide" 1
    fi
    sleep "$POLL"
  done
  say "ready after $(( $(date +%s) - start ))s: $names"
  # The stamp is how long since this lane was last used, and the reaper's window starts
  # from it. A run longer than the window would leave the clock at the run's start, so a
  # lane that has just gone quiet would look ancient. The second stamp puts the clock at
  # the end of the run, when the lane was last used.
  stamp_lane || say "could not re-stamp $GATE_NAMESPACE after the wait: its clock stays at the start of this run"
  status
}

down () {
  guard_lane_write
  need_kubectl
  local name left start deadline
  # A commit makes a new lane, so a worktree can ask to stop one it never woke. That is
  # not a failure: there is nothing here to stop, and the next gate:up makes the lane.
  lane_exists || { say "gate lane $GATE_NAMESPACE does not exist: nothing to stop. This worktree makes one on its next gate:up"; return 0; }
  # By name, never by app.kubernetes.io/part-of: paper-hub and paper-sky carry
  # that label too, and they are the transfer testbed's.
  # shellcheck disable=SC2086
  kubectl -n "$GATE_NAMESPACE" scale deploy $GATE_WORKLOADS --replicas=0 >/dev/null
  say "scaled $GATE_WORKLOADS to 0"
  say "waiting up to ${STOP_TIMEOUT}s for their pods to go"

  start=$(date +%s)
  deadline=$((start + STOP_TIMEOUT))
  while : ; do
    left=''
    for name in $GATE_WORKLOADS; do
      [ -z "$(pods_of "$name")" ] || left="$left $name"
    done
    if [ -z "$left" ]; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "pods still running after ${STOP_TIMEOUT}s:$left. kubectl -n $GATE_NAMESPACE get pods" 1
    fi
    sleep "$POLL"
  done

  say "the lane is off after $(( $(date +%s) - start ))s: the Deployments, Services and ConfigMaps stay"
  # What up generated goes with the lane, so a stopped lane leaves no Secret behind
  # for the next run to trust. The selector is the label up wrote, and an operator's
  # Secret carries no label, so it survives this line. A lane that was never up has
  # nothing to select, which --ignore-not-found makes a no-op.
  kubectl -n "$GATE_NAMESPACE" delete secret -l "$GENERATED_LABEL" --ignore-not-found >/dev/null
  say "deleted every Secret this lane generated: an operator's Secret has no $GENERATED_LABEL label, so it stays"
  # The clock starts here: a lane that just went to sleep has been idle for no time at
  # all. A stamp that fails leaves the age unknown, and the reaper keeps a lane it
  # cannot date, so this is a warning rather than a failure.
  stamp_lane || say "could not stamp $GATE_NAMESPACE: its age stays unknown, and a lane nobody dated is never reaped"
  # The fact a reader needs before the next up. Every gate volume is an emptyDir.
  say "every gate world is emptyDir and went with its pod: the next up pays the full cold start ($COLD_START)"
}

status () {
  guard
  need_kubectl
  local name replicas ready worktree commit touched age now
  say "gate lane $GATE_NAMESPACE: instance $INSTANCE, label prefix $LANE_LABEL-"
  # A commit makes a new lane, so this worktree may have none yet. Saying that beats
  # reading five Deployments out of a namespace that does not exist.
  lane_exists || { say "  this lane does not exist on the cluster: the next gate:up creates it"; return 0; }
  worktree=$(lane_annotation "$GATE_NAMESPACE" "$ANNOTATION_WORKTREE")
  if [ -n "$worktree" ]; then
    commit=$(lane_annotation "$GATE_NAMESPACE" "$ANNOTATION_COMMIT")
    touched=$(lane_annotation "$GATE_NAMESPACE" "$ANNOTATION_TOUCHED")
    if [ -n "$touched" ]; then
      now=$(date +%s)
      age=$(human_age $((now - touched)))
      say "  owned by $worktree${commit:+ at $commit}, last up or down $age ago"
    else
      say "  owned by $worktree${commit:+ at $commit}"
    fi
  fi
  for name in $GATE_WORKLOADS; do
    replicas=$(kubectl -n "$GATE_NAMESPACE" get deploy "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || replicas=''
    ready=$(ready_replicas "$name")
    printf '  %-14s %s/%s ready\n' "$name" "$ready" "${replicas:-?}"
  done
  kubectl -n "$GATE_NAMESPACE" get pods --no-headers 2>/dev/null || say '  no pods'
  # A lane is named after a commit, so a commit moves this worktree to a new lane and
  # leaves the old one awake. The listing is where the old one shows up with its owner.
  say '  every lane: mise run lanes'
}

human_age () {
  local s=$1
  [ "$s" -ge 0 ] || s=0
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm' "$(( s / 60 ))"
  elif [ "$s" -lt 86400 ]; then printf '%dh%02dm' "$(( s / 3600 ))" "$(( (s % 3600) / 60 ))"
  else printf '%dd%02dh' "$(( s / 86400 ))" "$(( (s % 86400) / 3600 ))"
  fi
}

# One candidate lane, and the four reasons this script keeps it. Deletion is a
# namespace, which takes every object in it, so a lane is only deletable when this
# script made all of it and nobody is in it.
reap_lane () {
  local ns=$1 touched=$2 pods=$3 now=$4 age workloads entry held
  if [ "$pods" != 0 ]; then
    say "keeping $ns: $pods pod(s) running, and a lane with a pod is not idle"
    return 0
  fi
  # What is in the namespace outranks how old it is. The transfer testbed's paper-hub
  # and paper-sky are tenants of a gate namespace (#283), and a namespace holding a
  # Deployment the gate tree does not declare is not this script's lane to date or to
  # delete. This runs before the clock because a rule that only fires on a namespace
  # that is both old and dated is a rule a reader cannot count on: an undated one
  # reaches it too, and the reason printed is the one that decided. A read that fails
  # stops the run: unreadable is not absent, and this is the read that would otherwise
  # delete what it could not see.
  workloads=$(kubectl -n "$ns" get deploy -o name) ||
    die "cannot read the Deployments in $ns: an unreadable lane is not an idle one" 1
  for entry in $workloads; do
    entry=${entry#deployment.apps/}
    if ! known "$entry"; then
      say "keeping $ns: it runs $entry, which the gate tree does not declare"
      return 0
    fi
  done
  if [ -z "$touched" ]; then
    say "keeping $ns: no $ANNOTATION_TOUCHED annotation, so its age is unknown"
    return 0
  fi
  age=$(( now - touched ))
  if [ "$age" -lt "$IDLE_WINDOW" ]; then
    say "keeping $ns: touched ${age}s ago, and the window is ${IDLE_WINDOW}s"
    return 0
  fi
  # The evidence above is not a promise. The testbed's two rows are its tenants, so an
  # operator who deletes them would leave a namespace of Services and Secrets that this
  # script's own rules would then delete. Its name is fixed and every worktree shares
  # it, and nothing puts it back, so no lane command deletes it (#318).
  if is_testbed_namespace "$ns"; then
    say "keeping $ns: it is the transfer testbed, and no lane command deletes it"
    return 0
  fi
  # An operator's Secret has no managed-by label, and #278's rule is that this script
  # deletes only what it made. Deleting the namespace would take the Secret too.
  held=$(kubectl -n "$ns" get secrets -l "!$GENERATED_LABEL_KEY" -o name) ||
    die "cannot read the Secrets in $ns: an unreadable lane is not an idle one" 1
  if [ -n "$held" ]; then
    say "keeping $ns: it holds $(printf '%s' "$held" | tr '\n' ' '), which this script did not make"
    return 0
  fi
  kubectl delete namespace "$ns" --wait=false >/dev/null ||
    die "cannot delete $ns" 1
  say "reaped $ns: idle $(( age / 60 )) minutes past the ${IDLE_WINDOW}s window. The worktree that owns it makes a new lane on its next gate:up"
}

# Every gate lane, with the two facts that make a crashed run visible: how long since it
# was last up or down, and which worktree owns it. --reap walks the same list and deletes
# the ones reap_lane allows, so the listing and the reaper can never disagree about what
# a lane is.
lanes () {
  local reap=$1 names ns touched worktree pods age now total=0 awake=0 mode='listing only' going=''
  now=$(date +%s)
  [ "$reap" = 0 ] || mode='reaping'
  names=$(kubectl get namespaces -l "$LANE_SELECTOR" -o name) ||
    die 'cannot list the gate lanes: kubectl get namespaces failed, and a listing that guesses is worse than one that stops' 1
  if [ -z "$names" ]; then
    say "no gate lanes: nothing has run gate:up here. This worktree's lane would be $GATE_NAMESPACE"
    return 0
  fi
  say "gate lanes, $mode: the window is ${IDLE_WINDOW}s"
  printf '%-38s %-7s %-5s %s\n' LANE AGE PODS WORKTREE
  for ns in $names; do
    ns=${ns#namespace/}
    guard_namespace "$ns"
    touched=$(lane_annotation "$ns" "$ANNOTATION_TOUCHED")
    # The testbed is nobody's worktree: no up or down here stamps it, so reading its
    # owner off the annotation would print "unknown" and read as an orphan lane.
    if is_testbed_namespace "$ns"; then
      worktree=$TESTBED_OWNER
    else
      worktree=$(lane_annotation "$ns" "$ANNOTATION_WORKTREE")
    fi
    pods=$(pod_count "$ns")
    total=$((total + 1))
    [ "$pods" = 0 ] || awake=$((awake + 1))
    if [ -n "$touched" ]; then age=$(human_age $((now - touched))); else age='?'; fi
    if [ "$(lane_phase "$ns")" = Terminating ]; then
      # Already on its way out, from this run or an earlier one. Its age is moot, and a
      # second delete would answer with an error about an object already gone.
      going="$going $ns"
      printf '%-38s %-7s %-5s %s (deleting)\n' "$ns" '-' '-' "${worktree:-unknown}"
      continue
    fi
    printf '%-38s %-7s %-5s %s\n' "$ns" "$age" "$pods" "${worktree:-unknown}"
    [ "$reap" = 0 ] || reap_lane "$ns" "$touched" "$pods" "$now"
  done
  say "$total lane(s), $awake awake. AGE is how long since that lane last ran up or down, and a lane with a pod is never reaped"
  [ -z "$going" ] || say "already deleting, so nothing here would reap it again:$going"
}

lanes_args () {
  local reap=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --reap) reap=1; shift ;;
      --window)
        [ $# -ge 2 ] || die '--window needs a number of seconds' 2
        IDLE_WINDOW=$2
        shift 2 ;;
      --window=*) IDLE_WINDOW=${1#--window=}; shift ;;
      *) die "unknown lanes option \"$1\": lanes takes --reap and --window SECONDS" 2 ;;
    esac
  done
  case "$IDLE_WINDOW" in
    ''|*[!0-9]*) die "the idle window \"$IDLE_WINDOW\" is not a whole number of seconds" 2 ;;
  esac
  need_kubectl
  lanes "$reap"
}

case "${1:-}" in
  up) shift; up "$@" ;;
  down) down ;;
  status) status ;;
  # The lane's name alone, for a shell: every rung that reaches a lane reads it, so
  # naming a lane here is naming it for the whole run (#301, #282).
  name) guard; printf '%s\n' "$GATE_NAMESPACE" ;;
  lanes) shift; lanes_args "$@" ;;
  # What this lane would apply, without a cluster: a lane's objects exist nowhere in
  # git, so this is the way to read them back.
  render) [ -n "${2:-}" ] || die 'usage: scripts/gate-lane.sh render DIR' 2; guard; render "$2"; say "rendered gate lane $GATE_NAMESPACE (instance $INSTANCE) into $2" ;;
  # The whole comment block, whatever its length, so a new header line cannot
  # silently push the exit codes out of the help.
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  *) die 'usage: scripts/gate-lane.sh up [DEPLOYMENT...]|down|status|name|lanes [--reap] [--window SECONDS]|render DIR' ;;
esac

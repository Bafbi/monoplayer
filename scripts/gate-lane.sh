#!/usr/bin/env bash
# The gate lane's lifecycle (#115): wake it for a run, put it back to sleep, or
# report what it is doing.
#
#   scripts/gate-lane.sh render DIR
#                                 write the tree this lane would apply into DIR
#   scripts/gate-lane.sh up [DEPLOYMENT...]
#                                 apply deploy/driver, wake the deployments
#                                 named (default: the two rows a rung drives),
#                                 and wait for them to report ready
#   scripts/gate-lane.sh down     scale every gate workload to 0 and wait for
#                                 their pods to go
#   scripts/gate-lane.sh status   what the lane runs, and what is ready
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
# not read as a hang. down leaves the Deployments, the Services, the ConfigMaps and
# the Secrets in place, so the next up costs the same cold start and nothing else.
#
# What it never does: touch the live lane (monoplayer) or the dev lane
# (monoplayer-dev); delete anything; or scale paper-hub and paper-sky, which are
# the transfer testbed's and share this namespace. Secrets gate-b-rcon and
# gate-b-velocity are created by an operator, never by this tree, and a down that
# deleted them would leave the next up in CreateContainerConfigError.
#
# The lane's instance is one value (#277). The tree in deploy/driver names today's
# lane, monoplayer-gate-b, everywhere the lane is named, and render() substitutes
# the instance into all of it. So the manifests and the label this script looks
# pods up by cannot disagree: a renamed lane reads its own pods.
#
# Environment:
#   MONOPLAYER_GATE_NAMESPACE    the gate lane's namespace (default monoplayer-gate-b).
#                                The instance is what follows monoplayer-gate-.
#   MONOPLAYER_CLUSTER_NAMESPACE the live namespace          (default monoplayer)
#   MONOPLAYER_GATE_READY_TIMEOUT seconds up waits for ready (default 900)
#   MONOPLAYER_GATE_STOP_TIMEOUT  seconds down waits         (default 180)
#   MONOPLAYER_GATE_POLL          seconds between checks     (default 5)
#
# Exit codes: 0 the lane reached the state asked for, 1 it did not, 2 refused.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# `-` and not `:-`: an explicitly empty value is refused by guard(), not
# replaced by the default, so a half-written environment cannot look healthy.
GATE_NAMESPACE=${MONOPLAYER_GATE_NAMESPACE-monoplayer-gate-b}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
READY_TIMEOUT=${MONOPLAYER_GATE_READY_TIMEOUT:-900}
STOP_TIMEOUT=${MONOPLAYER_GATE_STOP_TIMEOUT:-180}
POLL=${MONOPLAYER_GATE_POLL:-5}
# 63, the longest a label value may be, minus "monoplayer-gate-" (16) and
# "-paper-conduct" (14), the longest thing this lane labels.
INSTANCE_MAX=33
MANIFESTS=$ROOT/deploy/driver
# The one value every name in the lane comes from. The tree spells today's
# instance, b, so the substitution below replaces `gate-b`.
GATE_PREFIX=monoplayer-gate-
INSTANCE=${GATE_NAMESPACE#"$GATE_PREFIX"}
# The tree spells the lane two ways: monoplayer-gate-b-<thing> for the namespace,
# the labels and the tailnet hostnames, and gate-b-<name> for the Secrets and the
# ConfigMaps. Both derive here, once, so no caller can spell one and mean the other.
LANE_LABEL=$GATE_PREFIX$INSTANCE
LANE_NAME=gate-$INSTANCE

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

# Measured on the 26.2 gate Paper (#115), from a scale to 0 until the pod reports
# ready. The 240-310 s in the docs is a different wait: a Paper that is already up
# and restarts with the observer plugin, counted until the plugin logs that its
# packet listeners are live (scripts/observer-report.sh). Nothing here waits for that.
COLD_START="90 s from 0 to ready"

die () { printf 'gate-lane: %s\n' "$1" >&2; exit "${2:-2}"; }
say () { printf 'gate-lane: %s\n' "$1"; }

command -v kubectl >/dev/null || die 'kubectl is not on PATH'

# The gate namespace is the only one this script may scale. monoplayer and
# monoplayer-dev are refused even when the live-namespace variable is overridden,
# so no environment can aim a scale at the product or the dev lane.
guard () {
  if [ -z "$GATE_NAMESPACE" ] || [ "$GATE_NAMESPACE" = "$LIVE_NAMESPACE" ] \
    || [ "$GATE_NAMESPACE" = monoplayer ] || [ "$GATE_NAMESPACE" = monoplayer-dev ]; then
    die "refusing \"${GATE_NAMESPACE}\" as the gate namespace: this script scales, and the gate is the only disposable lane"
  fi
  # The render substitutes the instance into a tree that spells monoplayer-gate-b,
  # so a name that does not follow the prefix leaves the tree's spelling with
  # nothing to substitute, and the render would quietly apply the default lane.
  case "$GATE_NAMESPACE" in
    "$GATE_PREFIX"?*) : ;;
    *) die "refusing \"${GATE_NAMESPACE}\": the gate lane is ${GATE_PREFIX}<instance>, and that suffix is the one value every name in the lane is derived from" ;;
  esac
  # The instance becomes part of a namespace and of an app.kubernetes.io/name
  # value, so it is a DNS-1123 label. That is also what makes the sed in render()
  # safe: no character it would read as syntax can reach it.
  case "$INSTANCE" in
    *[!a-z0-9-]*|-*|*-) die "refusing \"${GATE_NAMESPACE}\": the instance \"${INSTANCE}\" is not a DNS-1123 label, so it cannot name a namespace or a label value" ;;
  esac
  # A label value is at most 63 characters, and the longest one this lane writes is
  # app.kubernetes.io/name: monoplayer-gate-<instance>-paper-conduct. A longer
  # instance would render a tree that kubectl refuses, one apply later and with a
  # message about the manifest rather than about the name that caused it.
  if [ "${#INSTANCE}" -gt "$INSTANCE_MAX" ]; then
    die "refusing \"${GATE_NAMESPACE}\": the instance is ${#INSTANCE} characters and the limit is $INSTANCE_MAX, which keeps monoplayer-gate-<instance>-paper-conduct inside the 63-character label value"
  fi
}

known () {
  local name
  for name in $GATE_WORKLOADS; do
    [ "$name" = "$1" ] && return 0
  done
  return 1
}

# The two Secrets an operator creates by hand. A pod that lacks one sits in
# CreateContainerConfigError, which reads like a slow boot unless it is named.
require_secret () {
  kubectl -n "$GATE_NAMESPACE" get secret "$1" >/dev/null 2>&1 \
    || die "no $1 Secret in $GATE_NAMESPACE: create it once, in an operator run, as deploy/driver/README.md shows"
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
  value=$(kubectl -n "$GATE_NAMESPACE" get deploy "$1" -o jsonpath='{.spec.replicas}') || value=''
  case "$value" in ''|*[!0-9]*) value=0 ;; esac
  printf '%s' "$value"
}

pods_of () {
  kubectl -n "$GATE_NAMESPACE" get pods -l "app.kubernetes.io/name=$LANE_LABEL-$1" -o name || true
}

# The lane a rendered tree belongs to. It reads the render, not the tree, because
# the render is what gets applied. up compares the two rather than assuming they
# agree. awk with an exit reads one line and no more. A piped head would let sed
# take a SIGPIPE, and pipefail would turn that into a silent death.
rendered_namespace () {
  awk '/^  name: /{print $2; exit}' "$1/namespace.yaml"
}

# The tree is the template. One substitution reaches the namespace object, every
# label and selector, the Secret and ConfigMap names, the tailnet hostnames and the
# path inside velocity.toml. That is why a rename cannot half-land.
#
# Instance b is today's lane, and the substitution is then the empty one. An
# ordinary up applies exactly what deploy/driver holds.
render () {
  local dir=$1 file
  # The target belongs to the caller: an empty one, or none. Deleting a directory
  # this function did not create would take whatever else was in it.
  mkdir -p "$dir"
  [ -z "$(ls -A "$dir")" ] \
    || die "refusing to render into $dir: it is not empty, and the render would overwrite what is there"
  cp -R "$MANIFESTS"/. "$dir"/
  if [ "$INSTANCE" = b ]; then return 0; fi
  for file in "$dir"/*.yaml; do
    sed "s/gate-b/$LANE_NAME/g" "$file" > "$file.new"
    mv "$file.new" "$file"
  done
}

up () {
  guard
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
  [ "$(rendered_namespace "$RENDER")" = "$GATE_NAMESPACE" ] \
    || die "the render spells $(rendered_namespace "$RENDER") and this run would scale $GATE_NAMESPACE: they are one lane, so name the same namespace"
  say "gate lane $GATE_NAMESPACE: instance $INSTANCE, label prefix $LANE_LABEL-"

  kubectl apply -k "$RENDER" >/dev/null
  say "applied the render of deploy/driver to $GATE_NAMESPACE"

  wake=$names
  for name in $awake; do
    case " $wake " in *" $name "*) : ;; *) wake="$wake $name" ;; esac
  done

  # Checked after the apply, because the apply is what creates the namespace on a
  # fresh cluster, and before the scale, so a lane that cannot start fails now.
  # The Secret each Deployment reads: RCON on the three Papers, and the forwarding
  # secret on Velocity and on the Paper behind it (paper-m4).
  case " $names " in
    *" paper "*|*" paper-conduct "*|*" paper-m4 "*) require_secret "$LANE_NAME-rcon" ;;
  esac
  case " $names " in
    *" velocity "*|*" paper-m4 "*) require_secret "$LANE_NAME-velocity" ;;
  esac

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
  status
}

down () {
  guard
  local name left start deadline
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

  say "the lane is off after $(( $(date +%s) - start ))s: the Deployments, Services, ConfigMaps and Secrets stay"
  # The fact a reader needs before the next up. Every gate volume is an emptyDir.
  say "every gate world is emptyDir and went with its pod: the next up pays the full cold start ($COLD_START)"
}

status () {
  local name replicas ready
  say "gate lane $GATE_NAMESPACE: instance $INSTANCE, label prefix $LANE_LABEL-"
  for name in $GATE_WORKLOADS; do
    replicas=$(kubectl -n "$GATE_NAMESPACE" get deploy "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || replicas=''
    ready=$(ready_replicas "$name")
    printf '  %-14s %s/%s ready\n' "$name" "$ready" "${replicas:-?}"
  done
  kubectl -n "$GATE_NAMESPACE" get pods --no-headers 2>/dev/null || say '  no pods'
}

case "${1:-}" in
  up) shift; up "$@" ;;
  down) down ;;
  status) guard; status ;;
  # What this lane would apply, without a cluster: a renamed lane's objects exist
  # nowhere in git, so this is the way to read them back.
  render) [ -n "${2:-}" ] || die 'usage: scripts/gate-lane.sh render DIR' 2; guard; render "$2"; say "rendered gate lane $GATE_NAMESPACE (instance $INSTANCE) into $2" ;;
  # The whole comment block, whatever its length, so a new header line cannot
  # silently push the exit codes out of the help.
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  *) die 'usage: scripts/gate-lane.sh up [DEPLOYMENT...]|down|status|render DIR' ;;
esac

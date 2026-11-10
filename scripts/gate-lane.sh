#!/usr/bin/env bash
# The gate lane's lifecycle (#115): wake it for a run, put it back to sleep, or
# report what it is doing.
#
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
# deployments sit at 0, which is what the manifests commit, so a bare
# kubectl apply -k deploy/driver cannot wake the lane by accident.
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
# Environment:
#   MONOPLAYER_GATE_NAMESPACE    the gate namespace          (default monoplayer-gate-b)
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
MANIFESTS=$ROOT/deploy/driver

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

pods_of () {
  kubectl -n "$GATE_NAMESPACE" get pods -l "app.kubernetes.io/name=monoplayer-gate-b-$1" -o name || true
}

up () {
  guard
  local names="${*:-$DRIVEN_WORKLOADS}" name pending waited=0
  for name in $names; do
    known "$name" || die "unknown gate deployment \"$name\": the gate workloads are $GATE_WORKLOADS"
  done

  kubectl apply -k "$MANIFESTS" >/dev/null
  say "applied deploy/driver to $GATE_NAMESPACE"

  # Checked after the apply, because the apply is what creates the namespace on a
  # fresh cluster, and before the scale, so a lane that cannot start fails now.
  case " $names " in *" paper "*|*" paper-conduct "*|*" paper-m4 "*) require_secret gate-b-rcon ;; esac
  case " $names " in *" velocity "*) require_secret gate-b-velocity ;; esac

  # shellcheck disable=SC2086
  kubectl -n "$GATE_NAMESPACE" scale deploy $names --replicas=1 >/dev/null
  say "woke $names"
  say "waiting up to ${READY_TIMEOUT}s for $names to report ready"
  say "cold start is $COLD_START (#115)"
  say "a Paper restart that loads the observer takes 240-310 s, and observer:run waits for that itself"

  while : ; do
    pending=''
    for name in $names; do
      [ "$(ready_replicas "$name")" -ge 1 ] || pending="$pending $name"
    done
    [ -z "$pending" ] && break
    if [ "$waited" -ge "$READY_TIMEOUT" ]; then
      die "still not ready after ${waited}s:$pending. A cold start is $COLD_START, so this is not a slow boot; read what the pod is doing: kubectl -n $GATE_NAMESPACE get pods -o wide" 1
    fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done
  say "ready after ${waited}s: $names"
  status
}

down () {
  guard
  local name left waited=0
  # By name, never by app.kubernetes.io/part-of: paper-hub and paper-sky carry
  # that label too, and they are the transfer testbed's.
  # shellcheck disable=SC2086
  kubectl -n "$GATE_NAMESPACE" scale deploy $GATE_WORKLOADS --replicas=0 >/dev/null
  say "scaled $GATE_WORKLOADS to 0"
  say "waiting up to ${STOP_TIMEOUT}s for their pods to go"

  while : ; do
    left=''
    for name in $GATE_WORKLOADS; do
      [ -z "$(pods_of "$name")" ] || left="$left $name"
    done
    [ -z "$left" ] && break
    if [ "$waited" -ge "$STOP_TIMEOUT" ]; then
      die "pods still running after ${waited}s:$left. kubectl -n $GATE_NAMESPACE get pods" 1
    fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done

  say "the lane is off after ${waited}s: the Deployments, Services, ConfigMaps and Secrets stay"
  # The fact a reader needs before the next up. Every gate volume is an emptyDir.
  say "every gate world is emptyDir and went with its pod: the next up pays the full cold start ($COLD_START)"
}

status () {
  local name replicas ready
  say "gate namespace $GATE_NAMESPACE"
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
  status) status ;;
  # The whole comment block, whatever its length, so a new header line cannot
  # silently push the exit codes out of the help.
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  *) die 'usage: scripts/gate-lane.sh up [DEPLOYMENT...]|down|status' ;;
esac

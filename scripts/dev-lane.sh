#!/usr/bin/env bash
# The dev validation lane (#42): bring it up, take it down, report on it.
#
#   scripts/dev-lane.sh up        apply the dev lane and wait for the backends
#   scripts/dev-lane.sh down      delete the dev lane
#   scripts/dev-lane.sh status    what is running, and what the live lane runs
#   scripts/dev-lane.sh image TAG the image reference the dev lane should run
#   scripts/dev-lane.sh set-image TAG
#                                 put that image on the dev proxy (#43)
#   scripts/dev-lane.sh join [args]  run a throwaway proxy pod against the dev
#                                 Paper and report the join (see below)
#
# What this lane is for: validating a branch without taking the live front down.
# The live lane holds one writer and one replica of the puppet custody, so a test
# that mounted it would race the token chain. This lane has its own Paper, its own
# Monoplayer, its own custody volume, and its own account.
#
# What it never does: scale, patch, restart, or delete anything in the live
# namespace. `status` reads the live replica count so that claim is checkable
# rather than asserted. The lane is not registered in Argo CD, so nothing applied
# here can roll out to the live lane.
#
# Environment:
#   MONOPLAYER_DEV_NAMESPACE    the dev namespace        (default monoplayer-dev)
#   MONOPLAYER_CLUSTER_NAMESPACE live namespace          (default monoplayer)
#   MONOPLAYER_LIVE_DEPLOYMENT  live deployment to read  (default monoplayer)
#   MONOPLAYER_DEV_READY_TIMEOUT  wait for Paper         (default 600s)
#
# Exit codes: 0 done, 1 the lane did not come up, 2 setup refused.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV_NAMESPACE=${MONOPLAYER_DEV_NAMESPACE:-monoplayer-dev}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
LIVE_DEPLOYMENT=${MONOPLAYER_LIVE_DEPLOYMENT:-monoplayer}
READY_TIMEOUT=${MONOPLAYER_DEV_READY_TIMEOUT:-600s}
IMAGE_REPO=ghcr.io/bafbi/monoplayer
LIVE_REPORT=${MONOPLAYER_DEV_REPORT:-.reports/dev-lane.json}

die() { printf 'dev-lane: %s\n' "$1" >&2; exit "${2:-2}"; }
say() { printf 'dev-lane: %s\n' "$1"; }

command -v kubectl >/dev/null || die 'kubectl is not on PATH'

# The dev namespace is the only one this script may write to. A typo in an
# environment variable would otherwise aim a delete at the live lane.
guard() {
  # `monoplayer` is banned even when the live namespace variable is overridden,
  # so no environment can aim this script at the live lane.
  if [ -z "$DEV_NAMESPACE" ] || [ "$DEV_NAMESPACE" = "$LIVE_NAMESPACE" ] || [ "$DEV_NAMESPACE" = monoplayer ]; then
    die "refusing \"$DEV_NAMESPACE\" as the dev namespace: it is the live namespace ($LIVE_NAMESPACE)" 2
  fi
}

# Paper cannot start without the RCON Secret, and a Secret value never belongs in
# a manifest. Create it once, randomly, and leave it alone afterwards.
ensure_rcon_secret() {
  if kubectl -n "$DEV_NAMESPACE" get secret dev-rcon >/dev/null 2>&1; then
    say 'the dev-rcon Secret exists'
    return 0
  fi
  kubectl create namespace "$DEV_NAMESPACE" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
  kubectl -n "$DEV_NAMESPACE" create secret generic dev-rcon \
    --from-literal=password="$(openssl rand -hex 16)" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  say 'created the dev-rcon Secret'
}

up() {
  guard
  ensure_rcon_secret
  # The lane exists so the live deployment keeps serving. Reading its replica
  # count before and after is what makes that a measurement, not a claim.
  local before
  before=$(live_replicas)
  kubectl apply -k "$ROOT/deploy/dev" >/dev/null
  say "applied deploy/dev to $DEV_NAMESPACE"
  kubectl -n "$DEV_NAMESPACE" rollout status deploy/paper --timeout="$READY_TIMEOUT" >/dev/null \
    || die "Paper did not become ready; kubectl -n $DEV_NAMESPACE logs deploy/paper" 1
  say 'Paper is ready'
  # The proxy waits for the dev account (#44). Saying so beats a CrashLoop.
  kubectl -n "$DEV_NAMESPACE" get deploy monoplayer >/dev/null 2>&1 \
    && say 'the proxy is applied; it needs the dev account in monoplayer-dev-custody (#44)'
  local after
  after=$(live_replicas)
  mkdir -p "$(dirname "$LIVE_REPORT")"
  printf '{"devNamespace":"%s","live":{"before":"%s","after":"%s"}}\n' \
    "$DEV_NAMESPACE" "${before:-unknown}" "${after:-unknown}" >"$LIVE_REPORT"
  say "live replicas before $DEV_NAMESPACE came up: ${before:-unknown}, after: ${after:-unknown} ($LIVE_REPORT)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    die "the live deployment changed its replica count ($before -> $after) while the dev lane came up" 1
  fi
  status
}

down() {
  guard
  kubectl delete -k "$ROOT/deploy/dev" --ignore-not-found >/dev/null 2>&1 || true
  # The namespace carries the PVC, and -k does not own a namespace it did not
  # create in this call, so remove it explicitly.
  kubectl delete namespace "$DEV_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  say "deleted $DEV_NAMESPACE"
  status
}

# Reading, never writing: this is how the "the live lane kept serving" claim is
# checked after a dev run.
live_replicas() {
  kubectl -n "$LIVE_NAMESPACE" get deploy "$LIVE_DEPLOYMENT" \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true
}

status() {
  say "dev namespace $DEV_NAMESPACE"
  kubectl -n "$DEV_NAMESPACE" get pods --no-headers 2>/dev/null || say '  nothing running'
  local replicas
  replicas=$(live_replicas)
  say "live $LIVE_NAMESPACE/$LIVE_DEPLOYMENT available replicas: ${replicas:-unknown}"
  local players
  players=$(kubectl -n "$DEV_NAMESPACE" get configmap monoplayer-dev-config \
    -o jsonpath='{.data.attach-whitelist\.json}' 2>/dev/null | tr -d ' \n')
  case "$players" in
    *\"players\":\[\]*) say 'attach whitelist is empty: nobody can attach yet' ;;
    "") : ;;
    *) say 'attach whitelist has entries' ;;
  esac
}

# Point the lane at a branch image (#43). The image is tagged with the commit, so
# the lane runs exactly the tree under review.
set_image() {
  [ $# -ge 1 ] && [ -n "$1" ] || die 'set-image needs a tag or a commit sha' 2
  guard
  local ref="$IMAGE_REPO:$1"
  kubectl -n "$DEV_NAMESPACE" set image deploy/monoplayer "monoplayer=$ref" >/dev/null
  say "dev monoplayer now runs $ref"
  kubectl -n "$DEV_NAMESPACE" rollout status deploy/monoplayer --timeout="$READY_TIMEOUT" >/dev/null \
    || die "the dev proxy did not become ready on $ref" 1
}

# A short, supervised join. The throwaway pod copies the live account's custody,
# refuses to refresh it, and dies with the pod. Nothing about it can rotate the
# live deployment's chain.
join() {
  guard
  "$ROOT/scripts/online-cluster.sh" \
    --backend-host "paper.${DEV_NAMESPACE}.svc.cluster.local" \
    --backend-port 25565 \
    "$@"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  set-image) shift; set_image "$@" ;;
  join) shift; join "$@" ;;
  image)
    [ $# -ge 2 ] && [ -n "$2" ] || die 'image needs a tag or a commit sha' 2
    printf '%s:%s\n' "$IMAGE_REPO" "$2"
    exit 0 ;;
  -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "usage: $0 up|down|status|image <tag>" 2 ;;
esac

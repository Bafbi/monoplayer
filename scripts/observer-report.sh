#!/usr/bin/env bash
# The server-view report (#12): one command, two joins, one comparison.
#
#   scripts/observer-report.sh [--report PATH] [--views PATH]
#                              [--backend-host H] [--backend-port P]
#                              [--namespace NS] [--paper-deployment NAME]
#                              [--jar PATH] [--timeout SECONDS]
#
# The question: does a Paper server see the puppet as an ordinary client? The
# answer needs two records of the same server taking the same account, once
# directly and once through the proxy, so the proxy is the only variable. This
# command produces both and compares them field by field.
#
#   1. Install the observer plugin and the ProtocolLib it needs into the gate
#      Paper, and restart the server so Paper loads them.
#   2. Direct baseline: the puppet account joins the gate Paper with no proxy in
#      between (src/ladder/observer-baseline.js).
#   3. Puppet join: the same account joins through Monoplayer (the online rung).
#   4. Fetch the observer log, and compare its first view with its last.
#
# Both joins run from a throwaway pod through scripts/online-cluster.sh, so the
# custody is copied, never shared, and an expired token stops the run instead of
# rotating the live chain.
#
# This never touches the live namespace: it refuses to run against it, and it
# never scales, patches, or restarts a deployment. The gate Paper is disposable,
# which is why installing a plugin into it and restarting it is allowed here.
#
# Environment:
#   MONOPLAYER_GATE_NAMESPACE        the gate namespace        (default monoplayer-gate-b)
#   MONOPLAYER_CLUSTER_NAMESPACE     the live namespace        (default monoplayer)
#   MONOPLAYER_BACKEND_HOST          the Paper host            (default paper.<gate>.svc.cluster.local)
#   MONOPLAYER_BACKEND_PORT          the Paper port            (default 25565)
#   MONOPLAYER_OBSERVER_JAR          the built observer jar    (default tools/observer/build/libs)
#   MONOPLAYER_PROTOCOLLIB_JAR       the ProtocolLib plugin    (default .cache/protocollib)
#   MONOPLAYER_VERSION               game version both joins speak (default: the gate Paper's VERSION)
#
# Exit codes: 0 every field explained, 1 an unexplained difference or a failed
# join, 2 setup refused or incomplete.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GATE_NAMESPACE=${MONOPLAYER_GATE_NAMESPACE:-monoplayer-gate-b}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
PAPER_DEPLOYMENT=${MONOPLAYER_OBSERVER_PAPER_DEPLOYMENT:-paper}
BACKEND_HOST=${MONOPLAYER_BACKEND_HOST:-paper.$GATE_NAMESPACE.svc.cluster.local}
BACKEND_PORT=${MONOPLAYER_BACKEND_PORT:-25565}
REPORT=${MONOPLAYER_OBSERVER_REPORT:-.reports/observer-report.json}
VIEWS=${MONOPLAYER_OBSERVER_VIEWS:-.reports/observer-views.jsonl}
JAR=${MONOPLAYER_OBSERVER_JAR:-}
PROTOCOLLIB=${MONOPLAYER_PROTOCOLLIB_JAR:-}
TIMEOUT=${MONOPLAYER_OBSERVER_TIMEOUT:-300}
PLUGINS_DIR=/data/plugins

die() { printf 'observer-report: %s\n' "$1" >&2; exit "${2:-2}"; }
say() { printf 'observer-report: %s\n' "$1"; }

# Both joins, and the front the puppet join runs in its pod, speak the version the
# gate Paper serves. The manifest that deploys that server holds the value, so a
# version move is one edit and this rung cannot be left a version behind.
GATE_PAPER_MANIFEST=$ROOT/deploy/driver/paper.yaml
gate_paper_version() {
  local value
  value=$(sed -n '/- name: VERSION$/,+1p' "$GATE_PAPER_MANIFEST" \
    | sed -n 's/^[[:space:]]*value: "\(.*\)"$/\1/p' | head -1)
  [ -n "$value" ] || die "cannot read VERSION from $GATE_PAPER_MANIFEST" 2
  printf '%s' "$value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT=${2:?--report needs a value}; shift 2 ;;
    --views) VIEWS=${2:?--views needs a value}; shift 2 ;;
    --backend-host) BACKEND_HOST=${2:?--backend-host needs a value}; shift 2 ;;
    --backend-port) BACKEND_PORT=${2:?--backend-port needs a value}; shift 2 ;;
    --namespace) GATE_NAMESPACE=${2:?--namespace needs a value}; shift 2 ;;
    --paper-deployment) PAPER_DEPLOYMENT=${2:?--paper-deployment needs a value}; shift 2 ;;
    --jar) JAR=${2:?--jar needs a value}; shift 2 ;;
    --timeout) TIMEOUT=${2:?--timeout needs a value}; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

command -v kubectl >/dev/null || die 'kubectl is not on PATH'
# Measuring the live lane is not this command, and not a plugin install.
if [ "$GATE_NAMESPACE" = "$LIVE_NAMESPACE" ]; then
  die "the gate namespace is the live namespace ($LIVE_NAMESPACE); this command never measures the live lane" 2
fi

if [ -z "$JAR" ]; then
  JAR=$(find "$ROOT/tools/observer/build/libs" -name '*.jar' ! -name '*-sources.jar' ! -name '*-javadoc.jar' 2>/dev/null | head -1)
fi
[ -n "$JAR" ] && [ -f "$JAR" ] || die 'no observer jar; run mise run observer:build'
if [ -z "$PROTOCOLLIB" ]; then
  PROTOCOLLIB=$(find "$ROOT/.cache/protocollib" -name '*-plugin.jar' 2>/dev/null | head -1)
fi
[ -n "$PROTOCOLLIB" ] && [ -f "$PROTOCOLLIB" ] || die 'no ProtocolLib plugin jar; run mise run observer:protocollib'
say "observer $(basename "$JAR"), protocollib $(basename "$PROTOCOLLIB")"

MONOPLAYER_VERSION=${MONOPLAYER_VERSION:-$(gate_paper_version)}
export MONOPLAYER_VERSION
say "gate Paper version: $MONOPLAYER_VERSION"

mkdir -p "$(dirname "$VIEWS")" "$(dirname "$REPORT")"

# The deployment's own selector decides which pods are its Paper. The label value
# is not the deployment name: every gate workload is labelled
# app.kubernetes.io/name=monoplayer-gate-b-<thing>, so reading the selector keeps
# this step right for whichever workload name it is pointed at.
paper_pod() {
  local label pod
  label=$(kubectl -n "$GATE_NAMESPACE" get deploy "$PAPER_DEPLOYMENT" \
    -o jsonpath='{.spec.selector.matchLabels.app\.kubernetes\.io/name}') \
    || die "cannot read deploy/$PAPER_DEPLOYMENT in $GATE_NAMESPACE" 2
  [ -n "$label" ] || die "cannot read the app.kubernetes.io/name selector of deploy/$PAPER_DEPLOYMENT in $GATE_NAMESPACE" 2
  pod=$(kubectl -n "$GATE_NAMESPACE" get pods \
    -l "app.kubernetes.io/name=$label" \
    -o jsonpath='{.items[0].metadata.name}')
  printf '%s' "$pod"
}

# Wire the observer in, then restart the server so Paper loads it. A container
# restart keeps the pod and its volume. A new pod would lose the copied jars.
install_observer() {
  local pod
  pod=$(paper_pod)
  [ -n "$pod" ] || die "no $PAPER_DEPLOYMENT pod in $GATE_NAMESPACE" 2
  kubectl -n "$GATE_NAMESPACE" exec "$pod" -- sh -c "mkdir -p $PLUGINS_DIR" >/dev/null
  kubectl -n "$GATE_NAMESPACE" cp "$PROTOCOLLIB" "$pod:$PLUGINS_DIR/$(basename "$PROTOCOLLIB")" >/dev/null
  kubectl -n "$GATE_NAMESPACE" cp "$JAR" "$pod:$PLUGINS_DIR/$(basename "$JAR")" >/dev/null
  say "copied both jars into $pod:$PLUGINS_DIR"
  # Restart the server process in place. Killing PID 1 is what the kubelet acts
  # on; the volume survives, the world does not, and this Paper is disposable.
  kubectl -n "$GATE_NAMESPACE" exec "$pod" -- sh -c 'kill 1' >/dev/null 2>&1 || true
  # The plugin logs this when its packet listeners are live, so it is the
  # readiness signal rather than a guess about boot time.
  local waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if kubectl -n "$GATE_NAMESPACE" logs "$pod" --tail=400 2>/dev/null | grep -q 'wire listeners registered'; then
      say "the observer is live on $pod"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  die "the observer did not come up within ${TIMEOUT}s; kubectl -n $GATE_NAMESPACE logs $pod" 2
}

install_observer

say "baseline join: the account straight to $BACKEND_HOST:$BACKEND_PORT"
"$ROOT/scripts/online-cluster.sh" \
  --rung src/ladder/observer-baseline.js \
  --backend-host "$BACKEND_HOST" --backend-port "$BACKEND_PORT" \
  || die 'the direct baseline join failed' 1

say 'puppet join: the same account through Monoplayer'
"$ROOT/scripts/online-cluster.sh" \
  --backend-host "$BACKEND_HOST" --backend-port "$BACKEND_PORT" \
  --report "$(dirname "$REPORT")/online-from-observer.json" \
  || die 'the puppet join failed' 1

pod=$(paper_pod)
[ -n "$pod" ] || die "no $PAPER_DEPLOYMENT pod in $GATE_NAMESPACE" 2
if ! kubectl -n "$GATE_NAMESPACE" cp "$pod:$PLUGINS_DIR/MonoplayerObserver/views.jsonl" "$VIEWS" >/dev/null 2>&1; then
  die "no observer log on $pod; did the plugin load? kubectl -n $GATE_NAMESPACE logs $pod" 2
fi
say "observer log written to $VIEWS"

set +e
node "$ROOT/src/ladder/observer.js" --single "$VIEWS" --report "$REPORT"
status=$?
set -e

exit "$status"

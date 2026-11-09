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
#   MONOPLAYER_OBSERVER_START_TIMEOUT
#                                    seconds the gate Paper may take to finish a
#                                    restart before the joins start (default 600;
#                                    MONOPLAYER_OBSERVER_TIMEOUT is the old name)
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
# The gate Paper's restart is a start wait, not a join wait. Measured on the
# 26.2 gate Paper: 240 to 310 seconds from `kill 1` to the plugin's own "wire
# listeners registered" line, so the old 300 was already too tight.
START_TIMEOUT=${MONOPLAYER_OBSERVER_START_TIMEOUT:-${MONOPLAYER_OBSERVER_TIMEOUT:-600}}
WAIT_INTERVAL=5
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
    --timeout) START_TIMEOUT=${2:?--timeout needs a value}; shift 2 ;;
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

# The container the deployment declares, so the log read names it instead of
# assuming the only one.
paper_container() {
  local container
  container=$(kubectl -n "$GATE_NAMESPACE" get deploy "$PAPER_DEPLOYMENT" \
    -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)
  [ -n "$container" ] || die "cannot read the container name of deploy/$PAPER_DEPLOYMENT in $GATE_NAMESPACE" 2
  printf '%s' "$container"
}

# How often that container has restarted. The install asks the kubelet for a
# restart, so a count that has not moved means the new process is not there yet,
# whatever the previous process's log still says.
restart_count() {
  kubectl -n "$GATE_NAMESPACE" get pod "$1" \
    -o jsonpath="{.status.containerStatuses[?(@.name==\"$2\")].restartCount}" 2>/dev/null
}

# Wire the observer in, then restart the server so Paper loads it. A container
# restart keeps the pod and its volume. A new pod would lose the copied jars.
#
# The wait is a START wait, and it reports as one (#79). Two runs were lost to a
# restart longer than the old bound and both read as join failures. They read
# that way because the readiness grep matched the marker in the pod's log, and
# the log it matched was the previous container's, which still held the line from
# the install before it: the joins then ran against a server that was booting.
# So the wait follows the restart count and reads only the log written since the
# kill. A run that never gets there says the server did not start, and the joins
# never run.
install_observer() {
  local pod container before started now current waited=0
  pod=$(paper_pod)
  [ -n "$pod" ] || die "no $PAPER_DEPLOYMENT pod in $GATE_NAMESPACE" 2
  container=$(paper_container)
  kubectl -n "$GATE_NAMESPACE" exec "$pod" -- sh -c "mkdir -p $PLUGINS_DIR" >/dev/null
  kubectl -n "$GATE_NAMESPACE" cp "$PROTOCOLLIB" "$pod:$PLUGINS_DIR/$(basename "$PROTOCOLLIB")" >/dev/null
  kubectl -n "$GATE_NAMESPACE" cp "$JAR" "$pod:$PLUGINS_DIR/$(basename "$JAR")" >/dev/null
  say "copied both jars into $pod:$PLUGINS_DIR"
  # One run's log. The pod keeps /data across a container restart, so the last
  # run's views are still in this file, and a report that read them would compare
  # the previous run's baseline against this run's puppet.
  kubectl -n "$GATE_NAMESPACE" exec "$pod" -- sh -c "rm -f $PLUGINS_DIR/MonoplayerObserver/views.jsonl" >/dev/null 2>&1 || true
  before=$(restart_count "$pod" "$container")
  before=${before:-0}
  # Restart the server process in place. Killing PID 1 is what the kubelet acts
  # on; the volume survives, the world does not, and this Paper is disposable.
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  kubectl -n "$GATE_NAMESPACE" exec "$pod" -- sh -c 'kill 1' >/dev/null 2>&1 || true
  # The plugin logs this when its packet listeners are live, so it is the
  # readiness signal rather than a guess about boot time.
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    # A pod replaced mid-restart is followed by name: the old name writes no log.
    current=$(paper_pod 2>/dev/null || true)
    if [ -n "$current" ] && [ "$current" != "$pod" ]; then
      say "the gate Paper pod was replaced: $pod -> $current"
      pod=$current
      before=0
      started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    fi
    now=$(restart_count "$pod" "$container")
    if [ -n "$now" ] && [ "$now" -gt "$before" ] \
      && kubectl -n "$GATE_NAMESPACE" logs "$pod" -c "$container" --since-time="$started" --tail=2000 2>/dev/null \
        | grep -q 'wire listeners registered'; then
      say "the observer is live on $pod after ${waited}s"
      return 0
    fi
    sleep "$WAIT_INTERVAL"
    waited=$((waited + WAIT_INTERVAL))
  done
  die "the gate Paper did not finish starting within ${START_TIMEOUT}s (container $container on $pod): this is a slow start, not a join failure, and the joins never ran. kubectl -n $GATE_NAMESPACE logs $pod -c $container" 2
}

install_observer

say "baseline join: the account straight to $BACKEND_HOST:$BACKEND_PORT"
"$ROOT/scripts/online-cluster.sh" \
  --rung src/ladder/observer-baseline.js \
  --backend-host "$BACKEND_HOST" --backend-port "$BACKEND_PORT" \
  || die 'the direct baseline join failed (the gate Paper had started, so this is the join)' 1

say 'puppet join: the same account through Monoplayer'
"$ROOT/scripts/online-cluster.sh" \
  --backend-host "$BACKEND_HOST" --backend-port "$BACKEND_PORT" \
  --report "$(dirname "$REPORT")/online-from-observer.json" \
  || die 'the puppet join failed (the gate Paper had started, so this is the join)' 1

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

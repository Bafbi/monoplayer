#!/usr/bin/env bash
# Run the online rung against a cluster backend, from a throwaway pod.
#
#   scripts/online-cluster.sh [--backend-host H] [--backend-port P]
#                             [--rung FILE] [--report PATH] [--rotate] [--keep-pod]
#
# `--rung` runs another ladder module in the same pod instead of the online
# rung, which is how the observer report gets its direct baseline join
# (scripts/observer-report.sh). The custody handling, the token expiry refusal,
# and the pod lifecycle are identical; only the module differs. A rung other
# than online.js writes no report, so the report copy-back is skipped.
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
# What it refuses: a puppet token that has expired. Reusing a valid cached
# Minecraft access token rotates nothing, which is why the default path cannot
# disturb the live proxy. Once the token expires, a refresh in the pod would
# invalidate the deployment's chain, so the script stops instead and says what to
# do. `--rotate` accepts that trade: it copies the refreshed directory back onto
# the volume and asks you to restart the deployment, which then reads it.
#
# The attach account (Bafbi) lives in the working copy, so it is copied in for the
# run and copied back afterwards, keeping one live copy of it.
#
# Environment:
#   MONOPLAYER_CLUSTER_NAMESPACE   namespace            (default monoplayer)
#   MONOPLAYER_DEPLOYMENT          deployment to read    (default monoplayer)
#   MONOPLAYER_GATE_NAMESPACE      the gate lane        (default monoplayer-gate-b),
#                                                        which the default backend
#                                                        host is derived from (#277)
#   MONOPLAYER_BACKEND_HOST        backend host         (default the gate Paper)
#   MONOPLAYER_BACKEND_PORT        backend port         (default 25565)
#   MONOPLAYER_FRONT_HOST          proxy front host     (passed to the rung, empty by default)
#   MONOPLAYER_FRONT_PORT          proxy front port     (passed to the rung, empty by default)
#   MONOPLAYER_VERSION             protocol version     (passed to the rung, empty by default)
#   MONOPLAYER_SECRETS_SOURCE      local secrets        (default ./.secrets)
#
# Exit codes: 0 the rung passed or was honestly not_observed, 1 it failed,
# 2 setup refused or incomplete. The pod is deleted on every path.
set -euo pipefail

NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
DEPLOYMENT=${MONOPLAYER_DEPLOYMENT:-monoplayer}
# The gate lane this run measures, which is not where the pod runs: NAMESPACE above
# is the live lane holding the custody the rung reads. The default backend follows
# the lane, so naming another instance does not dial the one that shipped (#277).
GATE_NAMESPACE=${MONOPLAYER_GATE_NAMESPACE:-monoplayer-gate-b}
BACKEND_HOST=${MONOPLAYER_BACKEND_HOST:-paper.$GATE_NAMESPACE.svc.cluster.local}
BACKEND_PORT=${MONOPLAYER_BACKEND_PORT:-25565}
SECRETS=${MONOPLAYER_SECRETS_SOURCE:-.secrets}
ATTACH_ALIAS=${MONOPLAYER_ATTACH_ACCOUNT:-bafbi}
RUNG=${MONOPLAYER_RUNG:-src/ladder/online.js}
ROTATE=0
KEEP_POD=0
REPORT=

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
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

command -v kubectl >/dev/null || die 'kubectl is not on PATH'
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/$RUNG" ] || die "no such rung: $RUNG"
# Only the online rung writes a report; another module's exit status is its
# whole result.
rung_args=
if [ "$RUNG" = src/ladder/online.js ]; then
  rung_args='--report /work/online-report.json'
fi
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

cleanup() {
  if [ "$KEEP_POD" = 1 ]; then
    say "keeping pod $pod for inspection"
    return
  fi
  kubectl -n "$NAMESPACE" delete pod "$pod" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

# A valid cached access token rotates nothing. An expired one would rotate the
# chain away from the live proxy, so that is a decision, not a default.
expired=$(kubectl -n "$NAMESPACE" exec "$pod" -- node -e '
const fs = require("node:fs")
const dir = process.argv[1]
const cache = JSON.parse(fs.readFileSync(dir + "/mca-cache.json", "utf8")).mca
const left = Number(cache.obtainedOn) + Number(cache.expires_in) * 1000 - Date.now()
console.log(left <= 0 ? "expired" : Math.round(left / 60000) + " min left")
' "/work/.secrets/accounts/$puppet_uuid")
say "puppet access token: $expired"
if [ "$expired" = expired ] && [ "$ROTATE" != 1 ]; then
  die 'the puppet access token has expired. A refresh here would invalidate the live proxy chain; re-run with --rotate to accept that, or wait for the deployment to refresh first.' 2
fi

say "running $RUNG: backend $BACKEND_HOST:$BACKEND_PORT"
set +e
kubectl -n "$NAMESPACE" exec "$pod" -- env \
  MONOPLAYER_BACKEND_HOST="$BACKEND_HOST" MONOPLAYER_BACKEND_PORT="$BACKEND_PORT" \
  MONOPLAYER_FRONT_HOST="${MONOPLAYER_FRONT_HOST:-}" MONOPLAYER_FRONT_PORT="${MONOPLAYER_FRONT_PORT:-}" \
  MONOPLAYER_VERSION="${MONOPLAYER_VERSION:-}" \
  sh -c "cd /work && node $RUNG $rung_args"
run_status=$?
set -e

if [ -n "$rung_args" ]; then
  kubectl cp "$NAMESPACE/$pod:/work/online-report.json" "$REPORT" >/dev/null 2>&1 \
    && say "report written to $REPORT"
fi

# The attach account was copied in, so copy its rotation back: still one copy.
rotated_attach=$(mktemp -d)
if kubectl cp "$NAMESPACE/$pod:/work/.secrets/accounts/$(basename "$attach_dir")" "$rotated_attach" >/dev/null 2>&1; then
  # kubectl cp lays the directory down one level either way; find the profile.
  from=$(find "$rotated_attach" -maxdepth 2 -name profile.json -printf '%h\n' 2>/dev/null | head -1)
  if [ -n "$from" ]; then
    rm -f "$from/writer.lock"
    cp -a "$from"/. "$attach_dir"/ && chmod 600 "$attach_dir"/*.json 2>/dev/null || true
    say "attach custody written back to $attach_dir"
  else
    say "warning: no attach custody came back from the pod; the local copy may be stale"
  fi
fi
rm -rf "$rotated_attach"

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
